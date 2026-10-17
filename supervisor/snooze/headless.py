"""Bounded Codex CLI resume adapter for explicitly allowlisted sessions.

The only Codex ``exec --json`` stdout records retained by this adapter are the
documented final-message shape used by the local fixtures::

    {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
    {"type":"turn.completed"}

All other JSONL records are execution telemetry and are deliberately discarded.
Only the last well-formed agent message is kept, after secret redaction and a
small display bound.  It is advisory text, never an instruction to execute.
"""
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
MAX_ADVISORY = 1200
REMOTE_SESSION = re.compile(r"[A-Za-z0-9_.:@/-]{1,160}\Z")
CODEX_SESSION = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z")


def _sanitize_advisory(value):
    """Return a redacted, bounded advisory and whether display was truncated."""
    if not isinstance(value, str):
        return None, False
    value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", value)
    value = re.sub(r"(?i)\bBearer\s+[^\s,;]+", "Bearer [REDACTED]", value)
    value = re.sub(r"(?i)(api[_-]?key|token|secret|password)(\s*[:=]\s*)[^\s,;]+", r"\1\2[REDACTED]", value)
    value = re.sub(r"(?i)\b(?:sk|ghp|gho|github_pat)_[A-Za-z0-9_]{12,}\b", "[REDACTED]", value)
    value = " ".join(value.split())
    if not value:
        return None, False
    if len(value) <= MAX_ADVISORY:
        return value, False
    return value[:MAX_ADVISORY - 1].rstrip() + "…", True


def _agent_message(event):
    """Read only the fixed agent-message payload from a Codex JSONL record.

    Returns ``(present, advisory, truncated)``.  A present message without a
    valid text field is an uncertain final advisory and must not be replayed.
    """
    if not isinstance(event, dict) or event.get("type") != "item.completed":
        return False, None, False
    item = event.get("item")
    if not isinstance(item, dict) or item.get("type") != "agent_message":
        return False, None, False
    advisory, truncated = _sanitize_advisory(item.get("text"))
    return True, advisory, truncated


class HeadlessCodex:
    """Resume one trusted Codex session using read-only, noninteractive exec."""

    def __init__(self, *, executable, project_dir, codex_home, sessions, timeout_seconds=120,
                 popen=subprocess.Popen, clock=time.monotonic):
        self.executable = str(Path(executable))
        self.project_dir = str(Path(project_dir))
        self.codex_home = str(Path(codex_home))
        self.sessions = dict(sessions)
        self.timeout_seconds = timeout_seconds
        self.popen = popen
        self.clock = clock

    def __call__(self, context, timeout_seconds):
        session = context.get("session")
        binding = (context.get("project"), context.get("owner"), session)
        codex_session = self.sessions.get(binding)
        if (not isinstance(session, str) or not REMOTE_SESSION.fullmatch(session) or
                not isinstance(codex_session, str) or not CODEX_SESSION.fullmatch(codex_session)):
            return {"state": "rejected", "definitely_not_started": True}
        try:
            limit = min(self.timeout_seconds, max(1, int(timeout_seconds)))
            metadata = {key: context.get(key) for key in ("event_id", "project", "job", "kind", "severity")}
            if any(not isinstance(value, str) for value in metadata.values()):
                return {"state": "rejected", "definitely_not_started": True}
            prompt = ("Review this incident and return concise advisory guidance only. Do not modify files, run shell commands, "
                      "call external services, invoke tools, or change the remote session's ownership.\nIncident metadata (JSON):\n" +
                      json.dumps(metadata, separators=(",", ":"), ensure_ascii=True))
            encoded = prompt.encode("utf-8")
            if len(encoded) > MAX_CONTEXT:
                return {"state": "rejected", "definitely_not_started": True}
            argv = [self.executable, "--ask-for-approval", "never", "exec", "--sandbox", "read-only",
                    "resume", codex_session, "--json", "--ignore-user-config", "-"]
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
        advisory = None
        advisory_truncated = False
        malformed_final_advisory = False
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
                                present, candidate, truncated = _agent_message(event)
                                if present:
                                    # A later valid agent message is the final advisory.  A
                                    # malformed final message leaves execution uncertain.
                                    advisory = candidate
                                    advisory_truncated = truncated
                                    malformed_final_advisory = candidate is None
                if overflow:
                    break
            timed_out = self.clock() >= deadline
            _kill_and_reap(proc, kill=overflow or timed_out)
            if (not selector.get_map() and proc.returncode == 0 and completed and not overflow and
                    not timed_out and not malformed_final_advisory):
                receipt = {"adapter": "codex-exec-resume", "state": "turn-completed", "exit_code": 0,
                           "bytes": output_bytes, "elapsed_ms": int((self.clock() - started) * 1000)}
                if advisory is not None:
                    receipt.update(advisory=advisory, advisoryOnly=True, advisoryTruncated=advisory_truncated)
                return {"state": "accepted", "receipt": receipt}
            return {"state": "ambiguous", "receipt": {"adapter": "codex-exec-resume",
                    "state": "execution-ambiguous", "exit_code": proc.returncode if proc.returncode is not None else -1,
                    "bytes": min(output_bytes, MAX_OUTPUT), "elapsed_ms": int((self.clock() - started) * 1000)}}
        except Exception:
            _kill_and_reap(proc, kill=True)
            return {"state": "ambiguous", "receipt": {"adapter": "codex-exec-resume", "state": "execution-ambiguous"}}
        finally:
            selector.close()
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                try:
                    stream.close()
                except Exception:
                    pass


def _kill_and_reap(proc, *, kill=False):
    """Kill the isolated process group when needed, and always reap its leader."""
    if kill:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except PermissionError:
            try:
                proc.kill()
            except OSError:
                pass
    try:
        proc.wait()
    except ChildProcessError:
        pass
