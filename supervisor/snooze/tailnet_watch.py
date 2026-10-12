"""Credential-free external health observer; never owns jobs or resumes agents."""
from __future__ import annotations
import argparse
import ipaddress
import json
import os
from pathlib import Path
import socket
import time
import urllib.error
import urllib.request

HOST = "jq-xubuntu1.bigeye-escalator.ts.net"
URL = f"https://{HOST}/token2oauth/healthz"
MAX_BODY = 16 * 1024
MAX_HISTORY = 256 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("redirect_denied")


def probe() -> dict:
    started = time.monotonic()
    result = {"observedAt": time.time(), "host": HOST, "healthy": False}
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(HOST, 443, type=socket.SOCK_STREAM)}
        networks = [ipaddress.ip_network("100.64.0.0/10"), ipaddress.ip_network("fd7a:115c:a1e0::/48")]
        if not addresses or not all(any(ipaddress.ip_address(a) in n for n in networks) for a in addresses):
            raise ValueError("tailnet_resolution_required")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(URL, timeout=8) as response:
            result["httpStatus"] = response.status
            raw = response.read(MAX_BODY + 1)
            if len(raw) > MAX_BODY:
                raise ValueError("response_too_large")
            data = json.loads(raw)
            result["healthy"] = response.status == 200 and data.get("ok") is True
            for key in ("accounts", "selectable"):
                value = data.get(key)
                if type(value) is int and 0 <= value <= 10000:
                    result[key] = value
    except urllib.error.HTTPError as error:
        result["httpStatus"] = error.code
        result["error"] = "http_failure"
    except (OSError, ValueError, TypeError, AttributeError):
        result["error"] = "probe_failed"
    result["latencyMs"] = round((time.monotonic() - started) * 1000)
    return result


def record(directory: Path, receipt: dict) -> None:
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    history = directory / "history.jsonl"
    if history.exists() and history.stat().st_size >= MAX_HISTORY:
        history.replace(directory / "history.previous.jsonl")
    payload = json.dumps(receipt, separators=(",", ":")) + "\n"
    with history.open("a") as output:
        output.write(payload)
    temporary = directory / "latest.tmp"
    temporary.write_text(payload)
    temporary.replace(directory / "latest.json")


def main() -> int:
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=Path.home() / ".local/state/token2oauth-tailnet-watch")
    args = parser.parse_args()
    receipt = probe()
    record(args.state_dir, receipt)
    print(json.dumps(receipt))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
