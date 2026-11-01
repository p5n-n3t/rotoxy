"""Private, bounded Oracle inference and URL extraction API.

All inference destinations are fixed private configuration. URL extraction uses
a one-hop HTTP/1.1 client with validated public DNS addresses, redirects off,
no browser/subresource fetches, and strict response caps.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import html
import http.client
import ipaddress
import json
import os
import re
import socket
import ssl
import time
import uuid
from collections import defaultdict
from html.parser import HTMLParser
from typing import Any
from urllib.parse import quote, urlsplit

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Security
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.responses import Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, field_validator


ORACLE_API_TOKEN = os.environ["ORACLE_API_TOKEN"]
MAX_FETCH_BYTES = 1_048_576
MAX_TEXT_BYTES = 24_000
MAX_REQUEST_BYTES = 48_000
RATE_LIMIT = 10
RATE_WINDOW = 60.0
MAX_CONTEXT = 4096
MAX_PREDICT = 512
UPSTREAM_TIMEOUT = 120.0
FETCH_TIMEOUT = 24.0
SEARCH_TIMEOUT = 20.0
SEARCH_MAX_RESPONSE_BYTES = 512_000
SEARXNG_URL = os.environ.get("SEARXNG_URL", "http://searxng:8080").rstrip("/")
_rate: dict[str, list[float]] = defaultdict(list)
_PRIVATE_NETWORKS = tuple(map(ipaddress.ip_network, (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
    "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/4",
    "::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8",
)))
_ALLOWED_MODELS = frozenset({"deepseek-r1:1.5b", "qwen3.5:2b", "qwen2.5-coder:3b", "tev1:0.8b", "gemma4:e2b"})
_NODE_IPS = {"ora1": "100.65.151.42", "ora3": "100.114.191.111", "ora5": "100.112.7.115", "ora6": "100.92.153.75", "ora7": "100.104.20.94", "ora8": "100.105.169.121"}
_DEFAULT_NODES = [
    {"id": "ora1", "ip": "100.65.151.42", "models": ["deepseek-r1:1.5b", "qwen3.5:2b"]},
    {"id": "ora3", "ip": "100.114.191.111", "models": ["deepseek-r1:1.5b", "qwen3.5:2b", "qwen2.5-coder:3b"]},
    {"id": "ora5", "ip": "100.112.7.115", "models": ["deepseek-r1:1.5b", "qwen3.5:2b", "qwen2.5-coder:3b"]},
    {"id": "ora6", "ip": "100.92.153.75", "models": ["deepseek-r1:1.5b", "qwen3.5:2b", "qwen2.5-coder:3b"]},
    {"id": "ora7", "ip": "100.104.20.94", "models": ["deepseek-r1:1.5b", "qwen3.5:2b", "qwen2.5-coder:3b"]},
    {"id": "ora8", "ip": "100.105.169.121", "models": ["deepseek-r1:1.5b", "qwen3.5:2b", "qwen2.5-coder:3b", "tev1:0.8b", "gemma4:e2b"]},
]


def _load_nodes() -> list[dict[str, Any]]:
    raw = json.loads(os.environ.get("ORACLE_NODES_JSON", json.dumps(_DEFAULT_NODES)))
    if type(raw) is not list or not 1 <= len(raw) <= 6:
        raise RuntimeError("invalid Oracle node configuration")
    result, seen = [], set()
    for node in raw:
        if type(node) is not dict or set(node) != {"id", "ip", "models"}:
            raise RuntimeError("invalid Oracle node configuration")
        node_id, ip, models = node["id"], node["ip"], node["models"]
        try:
            parsed = ipaddress.ip_address(ip)
        except (ValueError, TypeError):
            raise RuntimeError("invalid Oracle node address") from None
        if parsed.version != 4 or _NODE_IPS.get(node_id) != str(parsed):
            raise RuntimeError("invalid Oracle node address")
        if node_id not in _NODE_IPS or node_id in seen:
            raise RuntimeError("invalid Oracle node identity")
        if type(models) is not list or not models or any(m not in _ALLOWED_MODELS for m in models):
            raise RuntimeError("invalid Oracle node models")
        seen.add(node_id)
        result.append({"id": node_id, "ip": str(parsed), "models": tuple(dict.fromkeys(models))})
    return result


NODES = _load_nodes()
_node_locks = {node["id"]: asyncio.Semaphore(1) for node in NODES}
_extract_slots = asyncio.Semaphore(2)
_search_slots = asyncio.Semaphore(2)
_EXTRACTION_WORKER_PORT = 8878
_EXTRACTION_WORKER_IDS = tuple(sorted(_NODE_IPS))
_extraction_worker_slots = {node_id: asyncio.Semaphore(1) for node_id in _EXTRACTION_WORKER_IDS}
_extraction_worker_rr = 0
_extraction_worker_rr_lock = asyncio.Lock()
_round_robin = 0
_round_robin_lock = asyncio.Lock()


def _check_rate(token_hint: str) -> None:
    now = time.monotonic()
    window = _rate[token_hint]
    cutoff = now - RATE_WINDOW
    while window and window[0] < cutoff:
        window.pop(0)
    if len(window) >= RATE_LIMIT:
        raise HTTPException(status_code=429, detail="rate_limited")
    window.append(now)


security = HTTPBearer(auto_error=False)


def _require_auth(creds: HTTPAuthorizationCredentials | None = Security(security)) -> str:
    if creds is None or not hmac.compare_digest(creds.credentials, ORACLE_API_TOKEN):
        raise HTTPException(status_code=401, detail="unauthorized", headers={"WWW-Authenticate": "Bearer"})
    _check_rate(hashlib.sha256(creds.credentials.encode()).hexdigest()[:16])
    return creds.credentials


app = FastAPI(title="Oracle private API", version="2.0.0", docs_url=None, redoc_url=None)


@app.exception_handler(RequestValidationError)
async def safe_validation_error(_request: Request, _exc: RequestValidationError) -> JSONResponse:
    return JSONResponse({"detail": "invalid_request"}, status_code=422)


class BodySizeLimitMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        raw_length = headers.get(b"content-length")
        if raw_length:
            try:
                if int(raw_length) > MAX_REQUEST_BYTES:
                    await JSONResponse({"detail": "request_too_large"}, status_code=413)(scope, receive, send)
                    return
            except ValueError:
                await JSONResponse({"detail": "invalid_content_length"}, status_code=400)(scope, receive, send)
                return
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > MAX_REQUEST_BYTES:
                await JSONResponse({"detail": "request_too_large"}, status_code=413)(scope, receive, send)
                return
            if not message.get("more_body", False):
                break
        buffered = bytes(body)
        first = True

        async def bounded_receive():
            nonlocal first
            if first:
                first = False
                return {"type": "http.request", "body": buffered, "more_body": False}
            return await receive()

        await self.app(scope, bounded_receive, send)


app.add_middleware(BodySizeLimitMiddleware)


_MCP_PROTOCOL_VERSIONS = {"2025-03-26", "2025-06-18", "2025-11-25"}
_MCP_SEARCH_TOOLS = [
    {"name": "search_web", "description": "Search the configured private SearXNG service. Returns a bounded list of title, URL, excerpt, and engine fields.",
     "inputSchema": {"type": "object", "properties": {"query": {"type": "string", "minLength": 2, "maxLength": 200}, "limit": {"type": "integer", "minimum": 1, "maximum": 10, "default": 5}}, "required": ["query"], "additionalProperties": False},
     "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": True}},
    {"name": "extract_url", "description": "Fetch one public HTTP/HTTPS document using Oracle API's DNS, port, redirect, content-type, timeout, and byte limits.",
     "inputSchema": {"type": "object", "properties": {"url": {"type": "string", "minLength": 8, "maxLength": 2048}}, "required": ["url"], "additionalProperties": False},
     "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": True}},
]
_MCP_MODEL_TOOLS = [
    {"name": "oracle_chat", "description": "Run one bounded non-streaming chat completion on the fixed Oracle model/node allowlist.",
     "inputSchema": {"type": "object", "properties": {"model": {"type": "string", "enum": sorted(_ALLOWED_MODELS)}, "prompt": {"type": "string", "minLength": 1, "maxLength": 24000}, "max_tokens": {"type": "integer", "minimum": 1, "maximum": MAX_PREDICT, "default": 256}}, "required": ["model", "prompt"], "additionalProperties": False},
     "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": True}},
]


def _mcp_error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


async def _mcp_call_tool(name: Any, arguments: Any, kind: str, token: str) -> dict[str, Any]:
    if not isinstance(name, str) or not isinstance(arguments, dict):
        raise ValueError("invalid tool arguments")
    allowed_tools = {item["name"] for item in (_MCP_SEARCH_TOOLS if kind == "search" else _MCP_MODEL_TOOLS)}
    if name not in allowed_tools:
        raise LookupError("unknown tool")
    try:
        if kind == "search" and name == "search_web":
            body = SearchRequest.model_validate(arguments)
            response = await search(body, token)
            value = json.loads(response.body)
        elif kind == "search" and name == "extract_url":
            body = ExtractRequest.model_validate(arguments)
            response = await extract(body, token)
            value = json.loads(response.body)
        else:
            if set(arguments) - {"model", "prompt", "max_tokens"}:
                raise ValueError("unsupported_arguments")
            prompt = arguments.get("prompt")
            if not isinstance(prompt, str) or not prompt:
                raise ValueError("prompt_required")
            body = ChatRequest.model_validate({"model": arguments.get("model"), "messages": [{"role": "user", "content": prompt}], "max_tokens": arguments.get("max_tokens", 256)})
            response = await chat(body, token)
            completion = json.loads(response.body)
            choice = completion["choices"][0]
            value = {"model": completion["model"], "host": response.headers.get("x-oracle-host", "unknown"), "text": choice["message"]["content"], "finish_reason": choice.get("finish_reason"), "usage": completion.get("usage")}
        return {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}], "isError": False}
    except HTTPException as exc:
        return {"content": [{"type": "text", "text": str(exc.detail)}], "isError": True}
    except (ValueError, TypeError) as exc:
        return {"content": [{"type": "text", "text": "invalid_arguments"}], "isError": True}


async def _mcp_dispatch(payload: Any, kind: str, token: str) -> tuple[Any, bool]:
    if not isinstance(payload, dict) or payload.get("jsonrpc") != "2.0" or not isinstance(payload.get("method"), str):
        return _mcp_error(payload.get("id") if isinstance(payload, dict) else None, -32600, "Invalid Request"), False
    if "id" in payload and (isinstance(payload["id"], bool) or not isinstance(payload["id"], (str, int))):
        return _mcp_error(None, -32600, "Invalid Request"), False
    if "params" in payload and not isinstance(payload["params"], dict):
        return _mcp_error(payload.get("id"), -32600, "Invalid Request"), False
    method = payload["method"]
    params = payload.get("params", {})
    request_id = payload.get("id")
    notification = "id" not in payload
    if method == "notifications/initialized":
        if not notification:
            return _mcp_error(request_id, -32600, "Invalid Request"), False
        return None, True
    if method.startswith("notifications/"):
        if not notification:
            return _mcp_error(request_id, -32600, "Invalid Request"), False
        return None, True
    if notification:
        return _mcp_error(None, -32600, "Invalid Request"), False
    if method == "initialize":
        version = params.get("protocolVersion") if isinstance(params, dict) else None
        if not isinstance(version, str):
            version = "2025-11-25"
        if version not in _MCP_PROTOCOL_VERSIONS:
            version = "2025-11-25"
        return {"jsonrpc": "2.0", "id": request_id, "result": {"protocolVersion": version, "capabilities": {"tools": {"listChanged": False}}, "serverInfo": {"name": f"rotoxy-oracle-{kind}", "version": "1.0.0"}}}, False
    if method == "ping":
        return {"jsonrpc": "2.0", "id": request_id, "result": {}}, False
    if method == "tools/list":
        tools = _MCP_SEARCH_TOOLS if kind == "search" else _MCP_MODEL_TOOLS
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": tools}}, False
    if method == "tools/call":
        if not isinstance(params, dict):
            return _mcp_error(request_id, -32602, "Invalid params"), False
        try:
            result = await _mcp_call_tool(params.get("name"), params.get("arguments", {}), kind, token)
            return {"jsonrpc": "2.0", "id": request_id, "result": result}, False
        except LookupError:
            return _mcp_error(request_id, -32602, "Unknown tool"), False
        except (ValueError, TypeError):
            return _mcp_error(request_id, -32602, "Invalid params"), False
    return _mcp_error(request_id, -32601, "Method not found"), False


def _mcp_origin_error(request: Request) -> JSONResponse | None:
    # This service is a machine-to-machine API. Reject browser Origins rather than
    # reflecting arbitrary origins through the authenticated MCP transport.
    if request.headers.get("origin"):
        return JSONResponse({"detail": "origin_not_allowed"}, status_code=403)
    return None


def _mcp_protocol_error(request: Request) -> JSONResponse | None:
    version = request.headers.get("mcp-protocol-version")
    if version is not None and version not in _MCP_PROTOCOL_VERSIONS:
        return JSONResponse({"detail": "unsupported_protocol_version"}, status_code=400)
    return None


async def _mcp_endpoint(request: Request, kind: str, token: str) -> Response:
    origin_error = _mcp_origin_error(request)
    if origin_error is not None:
        return origin_error
    version_error = _mcp_protocol_error(request)
    if version_error is not None:
        return version_error
    accept = request.headers.get("accept", "")
    if "application/json" not in accept or "text/event-stream" not in accept:
        return JSONResponse({"detail": "invalid_accept"}, status_code=406)
    if "application/json" not in request.headers.get("content-type", ""):
        return JSONResponse({"detail": "invalid_content_type"}, status_code=415)
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse(_mcp_error(None, -32700, "Parse error"), status_code=400)
    if isinstance(payload, list):
        return JSONResponse(_mcp_error(None, -32600, "Invalid Request"), status_code=400)
    result, is_notification = await _mcp_dispatch(payload, kind, token)
    if is_notification and result is None:
        return Response(status_code=202)
    return JSONResponse(result)


@app.post("/search/mcp")
async def search_mcp(request: Request, token: str = Depends(_require_auth)) -> Response:
    return await _mcp_endpoint(request, "search", token)


@app.get("/search/mcp")
async def search_mcp_get(request: Request, _token: str = Depends(_require_auth)) -> Response:
    origin_error = _mcp_origin_error(request)
    if origin_error is not None:
        return origin_error
    version_error = _mcp_protocol_error(request)
    if version_error is not None:
        return version_error
    return Response(status_code=405, headers={"Allow": "POST"})


@app.post("/models/mcp")
async def models_mcp(request: Request, token: str = Depends(_require_auth)) -> Response:
    return await _mcp_endpoint(request, "models", token)


@app.get("/models/mcp")
async def models_mcp_get(request: Request, _token: str = Depends(_require_auth)) -> Response:
    origin_error = _mcp_origin_error(request)
    if origin_error is not None:
        return origin_error
    version_error = _mcp_protocol_error(request)
    if version_error is not None:
        return version_error
    return Response(status_code=405, headers={"Allow": "POST"})


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "oracle-api"}


@app.get("/v1/models")
async def list_models(_token: str = Depends(_require_auth)) -> dict[str, Any]:
    names = sorted({model for node in NODES for model in node["models"]})
    return {"object": "list", "data": [{"id": name, "object": "model", "owned_by": "oracle"} for name in names]}


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: str
    content: str

    @field_validator("role")
    @classmethod
    def valid_role(cls, value: str) -> str:
        if value not in {"system", "user", "assistant"}:
            raise ValueError("role_not_supported")
        return value

    @field_validator("content")
    @classmethod
    def bounded_content(cls, value: str) -> str:
        if len(value.encode("utf-8")) > MAX_TEXT_BYTES:
            raise ValueError("message_too_large")
        return value


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: str
    messages: list[ChatMessage] = Field(min_length=1, max_length=32)
    max_tokens: int = Field(default=256, ge=1, le=MAX_PREDICT)
    temperature: float = Field(default=0.2, ge=0, le=1.5)
    stream: bool = False

    @field_validator("model")
    @classmethod
    def valid_model(cls, value: str) -> str:
        if value not in _ALLOWED_MODELS:
            raise ValueError("model_not_supported")
        return value

    @field_validator("stream")
    @classmethod
    def no_stream(cls, value: bool) -> bool:
        if value:
            raise ValueError("streaming_not_supported")
        return value

    @field_validator("messages")
    @classmethod
    def bounded_messages(cls, value: list[ChatMessage]) -> list[ChatMessage]:
        if sum(len(item.content.encode("utf-8")) for item in value) > MAX_TEXT_BYTES:
            raise ValueError("request_too_large")
        return value


async def _reserve_node(model: str) -> dict[str, Any]:
    global _round_robin
    candidates = [node for node in NODES if model in node["models"]]
    if not candidates:
        raise HTTPException(status_code=404, detail="model_not_available")
    async with _round_robin_lock:
        start = _round_robin % len(candidates)
        _round_robin += 1
        for offset in range(len(candidates)):
            node = candidates[(start + offset) % len(candidates)]
            lock = _node_locks[node["id"]]
            if not lock.locked():
                await lock.acquire()
                return node
    raise HTTPException(status_code=503, detail="host_at_capacity")


@app.post("/v1/chat/completions")
async def chat(body: ChatRequest, _token: str = Depends(_require_auth)) -> JSONResponse:
    node = await _reserve_node(body.model)
    lock = _node_locks[node["id"]]
    try:
        async with httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT, trust_env=False) as client:
            async with client.stream("POST", f"http://{node['ip']}:11434/api/chat", json={
                "model": body.model,
                "messages": [message.model_dump() for message in body.messages],
                "think": False,
                "stream": False,
                "options": {"num_ctx": MAX_CONTEXT, "num_predict": body.max_tokens, "temperature": body.temperature},
            }) as response:
                if response.status_code != 200:
                    raise HTTPException(status_code=502, detail="inference_upstream_error")
                chunks, total = [], 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > MAX_FETCH_BYTES:
                        raise HTTPException(status_code=502, detail="inference_response_too_large")
                    chunks.append(chunk)
                data = json.loads(b"".join(chunks))
        content = data.get("message", {}).get("content")
        if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_FETCH_BYTES:
            raise HTTPException(status_code=502, detail="invalid_inference_response")
        result = {
            "id": "chatcmpl-" + uuid.uuid4().hex,
            "object": "chat.completion",
            "created": int(time.time()),
            "model": body.model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "length" if data.get("done_reason") == "length" else "stop"}],
            "usage": {"prompt_tokens": data.get("prompt_eval_count", 0), "completion_tokens": data.get("eval_count", 0), "total_tokens": int(data.get("prompt_eval_count", 0) or 0) + int(data.get("eval_count", 0) or 0)},
        }
        return JSONResponse(result, headers={"x-oracle-host": node["id"], "cache-control": "no-store"})
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="inference_timeout") from None
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="inference_unavailable") from None
    finally:
        lock.release()


class _TextExtractor(HTMLParser):
    _IGNORED = {"script", "style", "noscript", "svg", "iframe", "form", "nav", "header", "footer"}
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title_parts: list[str] = []
        self.ignored = 0
        self.in_title = False

    def handle_starttag(self, tag: str, _attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._IGNORED: self.ignored += 1
        if tag == "title": self.in_title = True
        if tag in {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "tr"}: self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self._IGNORED and self.ignored: self.ignored -= 1
        if tag == "title": self.in_title = False
        if tag in {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "tr"}: self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self.ignored: return
        text = " ".join(data.split())
        if text:
            self.parts.append(text + " ")
            if self.in_title: self.title_parts.append(text)


def _resolve_public(host: str, port: int) -> list[str]:
    try:
        try:
            ip = ipaddress.ip_address(host)
            values = [str(ip)]
        except ValueError:
            values = list(dict.fromkeys(item[4][0] for item in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)))
        if not values: raise ValueError("no addresses")
        for value in values:
            parsed = ipaddress.ip_address(value)
            if not parsed.is_global or any(parsed in net for net in _PRIVATE_NETWORKS):
                raise ValueError("non-public destination")
        return values
    except Exception:
        raise HTTPException(status_code=422, detail="url_destination_not_public") from None


def _safe_fetch(url: str) -> tuple[str, str, str]:
    deadline = time.monotonic() + FETCH_TIMEOUT
    try:
        parts = urlsplit(url)
        if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password or parts.fragment:
            raise ValueError("invalid URL")
        if any(ord(char) < 32 or ord(char) == 127 for char in parts.path + parts.query):
            raise ValueError("control character in URL")
        port = parts.port or (443 if parts.scheme == "https" else 80)
        if port != (443 if parts.scheme == "https" else 80):
            raise ValueError("nonstandard port")
        host = parts.hostname.encode("idna").decode("ascii").lower()
    except Exception:
        raise HTTPException(status_code=422, detail="url_not_allowed") from None
    addresses = _resolve_public(host, port)
    path = quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~")
    if parts.query:
        path += "?" + quote(parts.query, safe="/?%:@!$&'()*+,;=-._~")
    sock = None
    try:
        last_error = None
        for address in addresses:
            try:
                remaining = deadline - time.monotonic()
                if remaining <= 0: raise TimeoutError("fetch deadline exceeded")
                sock = socket.create_connection((address, port), timeout=min(3.0, remaining))
                break
            except OSError as exc:
                last_error = exc
        if sock is None: raise last_error or OSError("connect failed")
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise TimeoutError("fetch deadline exceeded")
        sock.settimeout(min(5.0, remaining))
        if parts.scheme == "https":
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
            remaining = deadline - time.monotonic()
            if remaining <= 0: raise TimeoutError("fetch deadline exceeded")
            sock.settimeout(min(5.0, remaining))
        request = (f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: oracle-extract/1.0\r\n"
                   "Accept: text/html,application/xhtml+xml,text/plain;q=0.9\r\nAccept-Encoding: identity\r\n"
                   "Connection: close\r\n\r\n").encode("ascii")
        sock.sendall(request)
        response = http.client.HTTPResponse(sock)
        response.begin()
        if 300 <= response.status < 400:
            raise HTTPException(status_code=422, detail="redirect_not_followed")
        if response.status < 200 or response.status >= 300:
            raise HTTPException(status_code=422, detail="source_http_error")
        content_type = response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type not in {"text/html", "application/xhtml+xml", "text/plain"}:
            raise HTTPException(status_code=415, detail="content_type_not_supported")
        length = response.getheader("Content-Length")
        if length and int(length) > MAX_FETCH_BYTES:
            raise HTTPException(status_code=413, detail="source_too_large")
        chunks, total = [], 0
        while total <= MAX_FETCH_BYTES:
            remaining = deadline - time.monotonic()
            if remaining <= 0: raise HTTPException(status_code=504, detail="source_fetch_timeout")
            sock.settimeout(remaining)
            chunk = response.read1(min(65536, MAX_FETCH_BYTES + 1 - total))
            if not chunk: break
            total += len(chunk); chunks.append(chunk)
        if total > MAX_FETCH_BYTES:
            raise HTTPException(status_code=413, detail="source_too_large")
        body = b"".join(chunks).decode("utf-8", "replace")
        if content_type == "text/plain":
            text, title = body, ""
        else:
            parser = _TextExtractor(); parser.feed(body); parser.close()
            text, title = "".join(parser.parts), " ".join(parser.title_parts)
            text = re.sub(r"[ \t]+", " ", text)
            text = re.sub(r" *\n *", "\n", text)
            text = re.sub(r"\n{3,}", "\n\n", text)
            text = html.unescape(text).strip()
        bounded_text = text.encode("utf-8")[:MAX_TEXT_BYTES].decode("utf-8", "ignore")
        return host, title[:300], bounded_text
    except HTTPException:
        raise
    except TimeoutError:
        raise HTTPException(status_code=504, detail="source_fetch_timeout") from None
    except (OSError, ssl.SSLError, http.client.HTTPException, ValueError):
        raise HTTPException(status_code=422, detail="source_fetch_failed") from None
    finally:
        if sock is not None:
            try: sock.close()
            except OSError: pass


class ExtractRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(min_length=8, max_length=2048)


class SearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(min_length=2, max_length=200)
    limit: int = Field(default=5, ge=1, le=10)

    @field_validator("query")
    @classmethod
    def validate_query(cls, value: str) -> str:
        if any(ord(char) < 32 for char in value):
            raise ValueError("invalid query")
        return value.strip()


@app.post("/search")
async def search(body: SearchRequest, _token: str = Depends(_require_auth)) -> JSONResponse:
    if _search_slots.locked():
        raise HTTPException(status_code=503, detail="search_at_capacity")
    await _search_slots.acquire()
    try:
        async with httpx.AsyncClient(timeout=SEARCH_TIMEOUT, follow_redirects=False) as client:
            async with client.stream("GET", f"{SEARXNG_URL}/search", params={"q": body.query, "format": "json", "language": "en"}) as response:
                if response.status_code != 200:
                    raise HTTPException(status_code=502, detail="search_upstream_unavailable")
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > SEARCH_MAX_RESPONSE_BYTES:
                        raise HTTPException(status_code=502, detail="search_response_too_large")
        payload = json.loads(data)
        results = payload.get("results") if isinstance(payload, dict) else None
        if not isinstance(results, list):
            raise HTTPException(status_code=502, detail="search_upstream_invalid")
        bounded = []
        for item in results[:body.limit]:
            if not isinstance(item, dict):
                continue
            bounded.append({
                "title": str(item.get("title") or "")[:300],
                "url": str(item.get("url") or "")[:2048],
                "content": str(item.get("content") or "")[:1200],
                "engine": str(item.get("engine") or "")[:80],
            })
        return JSONResponse({"query": body.query, "results": bounded}, headers={"cache-control": "no-store", "x-search-provider": "searxng"})
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="search_timeout") from None
    except httpx.HTTPError:
        raise HTTPException(status_code=503, detail="search_unavailable") from None
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(status_code=502, detail="search_upstream_invalid") from None
    finally:
        _search_slots.release()


@app.post("/extract")
@app.post("/scrape", include_in_schema=False)
async def extract(body: ExtractRequest, _token: str = Depends(_require_auth)) -> JSONResponse:
    if _extract_slots.locked():
        raise HTTPException(status_code=503, detail="extraction_at_capacity")
    await _extract_slots.acquire()
    release_here = True
    task = asyncio.create_task(_dispatch_extraction(body.url, _token))
    try:
        try:
            host, title, text, worker_id = await asyncio.wait_for(asyncio.shield(task), timeout=FETCH_TIMEOUT + 8)
        except asyncio.TimeoutError:
            release_here = False
            task.add_done_callback(lambda _task: _extract_slots.release())
            raise HTTPException(status_code=504, detail="source_fetch_timeout") from None
        except asyncio.CancelledError:
            release_here = False
            task.add_done_callback(lambda _task: _extract_slots.release())
            raise
    finally:
        if release_here:
            _extract_slots.release()
    final_url = body.url.split("#", 1)[0]
    return JSONResponse({"url": final_url, "source_host": host, "worker_id": worker_id, "title": title, "text": text, "word_count": len(text.split())}, headers={"x-extraction-host": host, "x-extraction-worker": worker_id, "cache-control": "no-store"})


async def _limited_json(response: httpx.Response, maximum: int) -> dict[str, Any] | None:
    chunks, total = [], 0
    async for chunk in response.aiter_bytes():
        total += len(chunk)
        if total > maximum:
            return None
        chunks.append(chunk)
    try:
        value = json.loads(b"".join(chunks))
        return value if isinstance(value, dict) else None
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


async def _probe_extraction_worker(node_id: str, token: str) -> bool:
    if node_id not in _NODE_IPS:
        return False
    try:
        timeout = httpx.Timeout(2.5, connect=1.2)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=False) as client:
            async with client.stream("GET", f"http://{_NODE_IPS[node_id]}:{_EXTRACTION_WORKER_PORT}/health", headers={"Authorization": f"Bearer {token}"}) as response:
                if response.status_code != 200:
                    return False
                payload = await _limited_json(response, 4096)
        return bool(payload and payload.get("status") == "ok" and payload.get("service") == "oracle-extraction-worker" and payload.get("available") is True)
    except (httpx.HTTPError, OSError):
        return False


async def _call_extraction_worker(node_id: str, url: str, token: str) -> tuple[str, str, str, str]:
    timeout = httpx.Timeout(FETCH_TIMEOUT + 3, connect=1.5)
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=False) as client:
            async with client.stream("POST", f"http://{_NODE_IPS[node_id]}:{_EXTRACTION_WORKER_PORT}/internal/extract", headers={"Authorization": f"Bearer {token}"}, json={"url": url}) as response:
                payload = await _limited_json(response, 256_000)
                if response.status_code != 200:
                    detail = payload.get("detail") if payload else None
                    known_errors = {"url_destination_not_public", "url_not_allowed", "redirect_not_followed", "source_http_error", "content_type_not_supported", "source_too_large", "source_fetch_timeout", "source_fetch_failed", "extraction_worker_at_capacity"}
                    status = response.status_code if response.status_code in {413, 415, 422, 503, 504} else 502
                    safe_detail = detail if isinstance(detail, str) and detail in known_errors else "extraction_worker_error"
                    raise HTTPException(status_code=status, detail=safe_detail)
                if not payload:
                    raise HTTPException(status_code=502, detail="invalid_extraction_worker_response")
        source_host, title, text = payload.get("source_host"), payload.get("title"), payload.get("text")
        if not isinstance(source_host, str) or not isinstance(title, str) or not isinstance(text, str):
            raise HTTPException(status_code=502, detail="invalid_extraction_worker_response")
        if len(source_host) > 253 or len(title) > 300 or len(text.encode("utf-8")) > MAX_TEXT_BYTES:
            raise HTTPException(status_code=502, detail="invalid_extraction_worker_response")
        return source_host, title, text, node_id
    except HTTPException:
        raise
    except (httpx.HTTPError, OSError):
        # The worker may have completed its GET before this API observed the
        # connection failure. Do not replay against another node or locally.
        raise HTTPException(status_code=502, detail="extraction_worker_unavailable") from None


async def _dispatch_extraction(url: str, token: str) -> tuple[str, str, str, str]:
    candidates = [node_id for node_id in _EXTRACTION_WORKER_IDS if not _extraction_worker_slots[node_id].locked()]
    probes = await asyncio.gather(*(_probe_extraction_worker(node_id, token) for node_id in candidates))
    healthy = {node_id for node_id, available in zip(candidates, probes) if available}
    global _extraction_worker_rr
    selected = None
    async with _extraction_worker_rr_lock:
        start = _extraction_worker_rr % len(_EXTRACTION_WORKER_IDS)
        _extraction_worker_rr += 1
        for offset in range(len(_EXTRACTION_WORKER_IDS)):
            node_id = _EXTRACTION_WORKER_IDS[(start + offset) % len(_EXTRACTION_WORKER_IDS)]
            slot = _extraction_worker_slots[node_id]
            if node_id in healthy and not slot.locked():
                await slot.acquire()
                selected = node_id
                _extraction_worker_rr = (start + offset + 1) % len(_EXTRACTION_WORKER_IDS)
                break
    if selected is None:
        source_host, title, text = await asyncio.to_thread(_safe_fetch, url)
        return source_host, title, text, "local"
    try:
        return await _call_extraction_worker(selected, url, token)
    finally:
        _extraction_worker_slots[selected].release()
