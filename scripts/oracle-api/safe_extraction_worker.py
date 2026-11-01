"""Single-slot HTTP-only Oracle extraction worker.

This worker deliberately reuses the Oracle API's pinned-address fetcher. It has
no browser, JavaScript runtime, redirect support, or subresource loader.
"""
from __future__ import annotations

import asyncio
import hmac
import os
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Security
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

_TOKEN_FILE = os.environ.get("ORACLE_API_TOKEN_FILE", "/run/secrets/oracle-api-token")
if not os.environ.get("ORACLE_API_TOKEN"):
    os.environ["ORACLE_API_TOKEN"] = Path(_TOKEN_FILE).read_text().strip()

# Import the exact resolver, numeric-address HTTP fetch and schemas used by REST.
from app import (  # noqa: E402
    BodySizeLimitMiddleware,
    FETCH_TIMEOUT,
    MAX_TEXT_BYTES,
    ORACLE_API_TOKEN,
    ExtractRequest,
    _require_auth,
    _safe_fetch,
)

_worker_slots = asyncio.Semaphore(1)
_auth_scheme = HTTPBearer(auto_error=False)
app = FastAPI(title="Oracle safe extraction worker", version="1.0.0", docs_url=None, redoc_url=None)
app.add_middleware(BodySizeLimitMiddleware)


def _worker_auth(credentials: HTTPAuthorizationCredentials | None = Security(_auth_scheme)) -> None:
    if credentials is None or not hmac.compare_digest(credentials.credentials, ORACLE_API_TOKEN):
        raise HTTPException(status_code=401, detail="unauthorized", headers={"WWW-Authenticate": "Bearer"})


@app.get("/health")
async def health(_authorized: None = Depends(_worker_auth)) -> dict[str, object]:
    return {"status": "ok", "service": "oracle-extraction-worker", "available": not _worker_slots.locked()}


@app.post("/internal/extract")
async def extract(body: ExtractRequest, _token: str = Depends(_require_auth)) -> JSONResponse:
    if _worker_slots.locked():
        raise HTTPException(status_code=503, detail="extraction_worker_at_capacity")
    await _worker_slots.acquire()
    release_here = True
    task = asyncio.create_task(asyncio.to_thread(_safe_fetch, body.url))
    try:
        try:
            source_host, title, text = await asyncio.wait_for(asyncio.shield(task), timeout=FETCH_TIMEOUT + 2)
        except asyncio.TimeoutError:
            release_here = False
            task.add_done_callback(lambda _task: _worker_slots.release())
            raise HTTPException(status_code=504, detail="source_fetch_timeout") from None
        except asyncio.CancelledError:
            release_here = False
            task.add_done_callback(lambda _task: _worker_slots.release())
            raise
    finally:
        if release_here:
            _worker_slots.release()

    if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise HTTPException(status_code=502, detail="invalid_worker_result")
    return JSONResponse(
        {"url": body.url.split("#", 1)[0], "source_host": source_host, "title": title[:300], "text": text,
         "word_count": len(text.split())},
        headers={"cache-control": "no-store"},
    )
