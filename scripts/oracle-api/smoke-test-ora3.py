#!/usr/bin/env python3
"""Authenticated, bounded smoke test for the private ora3 Oracle API."""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8877"
TOKEN_FILE = Path("/etc/oracle-api/api-token")


def request(path: str, *, token: str | None = None, body: dict | None = None) -> tuple[int, dict, dict[str, str]]:
    data = None if body is None else json.dumps(body).encode()
    headers = {"Content-Type": "application/json"}
    if token is not None:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method="GET" if body is None else "POST")
    try:
        response = urllib.request.urlopen(req, timeout=135)
    except urllib.error.HTTPError as error:
        response = error
    payload = response.read(1_100_000)
    try:
        decoded = json.loads(payload) if payload else {}
    except json.JSONDecodeError:
        decoded = {}
    return response.status, decoded, dict(response.headers.items())


def main() -> int:
    token = TOKEN_FILE.read_text().strip()
    if not token:
        raise SystemExit("oracle API token file is empty")
    for label, candidate in (("missing", None), ("invalid", "invalid-smoke-token")):
        status, _, _ = request("/v1/models", token=candidate)
        print(f"auth_{label}={status}")
        if status != 401:
            raise SystemExit(f"auth_{label} check failed")

    status, catalog, _ = request("/v1/models", token=token)
    models = [item.get("id") for item in catalog.get("data", [])]
    print(f"models_status={status} model_count={len(models)} gpt_oss_20b_present={'gpt-oss:20b' in models}")
    if status != 200 or not {"qwen3.5:2b", "qwen2.5-coder:3b"}.issubset(models) or "gpt-oss:20b" in models:
        raise SystemExit("model catalog check failed")

    status, _, _ = request("/extract", token=token, body={"url": "http://127.0.0.1:8877/health"})
    print(f"private_url_status={status}")
    if status != 422:
        raise SystemExit("private URL was not blocked")

    status, extracted, _ = request("/extract", token=token, body={"url": "https://example.com/"})
    text = extracted.get("text", "")
    print(f"extract_status={status} title_present={bool(extracted.get('title'))} example_domain_present={'Example Domain' in text} bytes={len(text.encode())}")
    if status != 200 or "Example Domain" not in text:
        raise SystemExit("public URL extraction failed")

    status, search_result, _ = request("/search", token=token, body={"query": "python official documentation", "limit": 5})
    results = search_result.get("results", [])
    first = results[0] if results else {}
    print(f"search_status={status} result_count={len(results)} first_url={first.get('url', '')[:180]}")
    if status != 200 or not results or "python.org" not in first.get("url", ""):
        raise SystemExit("search query failed to return the expected Python documentation result")

    hosts = []
    for index in range(5):
        started = time.monotonic()
        status, result, headers = request("/v1/chat/completions", token=token, body={
            "model": "qwen3.5:2b",
            "messages": [{"role": "user", "content": "Reply exactly ORACLE_API_OK and nothing else."}],
            "max_tokens": 16,
            "temperature": 0,
        })
        choice = (result.get("choices") or [{}])[0]
        content = choice.get("message", {}).get("content", "")
        host = headers.get("x-oracle-host", "unknown")
        hosts.append(host)
        elapsed = round(time.monotonic() - started, 2)
        print(f"inference_{index + 1}=status:{status},host:{host},model:{result.get('model')},seconds:{elapsed},marker:{'ORACLE_API_OK' in content}")
        if status != 200 or result.get("model") != "qwen3.5:2b" or "ORACLE_API_OK" not in content:
            raise SystemExit("bounded inference check failed")
    print("distinct_hosts=" + ",".join(dict.fromkeys(hosts)))
    if len(set(hosts)) != 5:
        raise SystemExit("requests did not cover all five eligible hosts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
