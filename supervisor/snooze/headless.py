"""Bounded Codex CLI resume adapter for explicitly allowlisted sessions."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import time

MAX_CONTEXT = 4096
MAX_OUTPUT = 64 * 1024
SESSION = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")


class HeadlessCodex:
    """Resume one trusted Codex session using read-only, noninteractive exec."""

    def __init__(self, *, executable, project_dir, codex_home, sessions, timeout_seconds=120,
                 popen=subprocess.Popen, clock=time.monotonic):
        self.executable = str(Path(executable))
        self.project_dir = str(Path(project_dir))
        self.codex_home = str(Path(codex_home))
        self.sessions = frozenset(tuple(x) for x in sessions)
        self.timeout_seconds = timeout_seconds
        self.popen = popen
        self.clock = clock

    def __call__(self, context, timeout_seconds):
        session = context.get("session")
        binding = (context.get("project"), context.get("owner"), session)
        if not isinstance(session, str) or not SESSION.fullmatch(session) or binding not in self.sessions:
            return {"state": "rejected", "definitely_not_started": True}
        try:
            limit = min(self.timeout_seconds, max(1, int(timeout_seconds)))
            metadata = {key: context.get(key) for key in ("project", "job", "kind", "severity")}
            encoded = json.dumps(metadata, separators=(",", ":"), ensure_ascii=True).encode()
            if len(encoded) > MAX_CONTEXT:
                return {"state": "rejected", "definitely_not_started": True}
            argv = [self.executable, "exec", "resume", session, "--json", "--sandbox", "read-only",
                    "--ask-for-approval", "never", "--ignore-user-config",
                    "Review the incident metadata from stdin. Provide concise guidance only; do not make changes."]
            env = {"HOME": self.codex_home, "CODEX_HOME": self.codex_home,
                   "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
            proc = self.popen(argv, cwd=self.project_dir, env=env, stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              start_new_session=True, close_fds=True)
        except Exception:
            return {"state": "rejected", "definitely_not_started": True}

        started = self.clock()
        deadline = started + limit
        output_bytes = 0
        completed = False
        overflow = False
        line_buffer = bytearray()
        selector = selectors.DefaultSelector()
        try:
            proc.stdin.write(encoded)
            proc.stdin.close()
            for stream in (proc.stdout, proc.stderr):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ)
            while selector.get_map() or proc.poll() is None:
                remaining = deadline - self.clock()
                if remaining <= 0:
                    break
                for key, _ in selector.select(min(remaining, 0.2)):
                    try:
                        chunk = os.read(key.fd, min(8192, MAX_OUTPUT + 1 - output_bytes))
                    except BlockingIOError:
                        continue
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    output_bytes += len(chunk)
                    if output_bytes > MAX_OUTPUT:
                        overflow = True
                        break
                    if key.fileobj is proc.stdout:
                        line_buffer.extend(chunk)
                        while b"\n" in line_buffer:
                            line, _, rest = line_buffer.partition(b"\n")
                            line_buffer[:] = rest
                            if len(line) <= 8192:
                                try:
                                    event = json.loads(line)
                                except (ValueError, UnicodeDecodeError):
                                    continue
                                completed |= isinstance(event, dict) and event.get("type") == "turn.completed"
                if overflow:
                    break
            timed_out = self.clock() >= deadline
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
            if not selector.get_map() and proc.returncode == 0 and completed and not overflow and not timed_out:
                return {"state": "accepted", "receipt": {"adapter": "codex-exec-resume",
                        "state": "turn-completed", "exit_code": 0, "bytes": output_bytes,
                        "elapsed_ms": int((self.clock() - started) * 1000)}}
            return {"state": "ambiguous", "receipt": {"adapter": "codex-exec-resume",
                    "state": "execution-ambiguous", "exit_code": proc.returncode if proc.returncode is not None else -1,
                    "bytes": min(output_bytes, MAX_OUTPUT), "elapsed_ms": int((self.clock() - started) * 1000)}}
        except Exception:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            return {"state": "ambiguous", "receipt": {"adapter": "codex-exec-resume", "state": "execution-ambiguous"}}
        finally:
            selector.close()
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                try:
                    stream.close()
                except Exception:
                    pass
