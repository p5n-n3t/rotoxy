import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer } from "node:http";
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SupervisorBridge,
  SupervisorBridgeError,
  isAllowedSupervisorRoute,
} from "../dist/supervisor-bridge.js";

test("project control routes permit exact IDs without traversal or queries", () => {
  for (const method of ["GET", "POST"]) {
    assert.equal(isAllowedSupervisorRoute(method, "/admin/api/v1/projects/project-a/control"), true);
    assert.equal(isAllowedSupervisorRoute(method, "/admin/api/v1/projects/project-a/control?global=true"), false);
    assert.equal(isAllowedSupervisorRoute(method, "/admin/api/v1/projects/../control"), false);
  }
});

async function fixture({ handler, httpClient, startupTimeoutMs = 300 } = {}) {
  const configDir = await mkdtemp(join(tmpdir(), "t2o-supervisor-"));
  const supervisorCwd = join(configDir, "supervisor");
  await mkdir(supervisorCwd, { mode: 0o700 });
  let child;
  let bearer = "";
  let requestSeen;
  const requestPromise = new Promise((resolve) => { requestSeen = resolve; });
  let server;
  const spawnChild = (command, args, options) => {
    assert.equal(command, "python3");
    assert.deepEqual(args.slice(0, 3), ["-m", "snooze.bridge", "--socket"]);
    assert.equal(args.at(-2), "--auth-fd");
    assert.equal(args.at(-1), "3");
    assert.equal(options.cwd, supervisorCwd);
    assert.deepEqual(options.stdio, ["ignore", "ignore", "pipe", "pipe"]);
    assert.equal(options.env.TOKEN2OAUTH_CONFIG_DIR, undefined);
    assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(options.env.OPENAI_API_KEY, undefined);

    child = new EventEmitter();
    const authPipe = new PassThrough();
    const stderr = new PassThrough();
    child.stdio = [null, null, stderr, authPipe];
    child.stderr = stderr;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => {
      child.killed = true;
      server?.close(() => {
        child.exitCode = 0;
        child.signalCode = signal;
        child.emit("exit", 0, signal);
        child.emit("close", 0, signal);
      });
      return true;
    };
    child.crash = () => server?.close(() => {
      child.exitCode = 17;
      child.emit("exit", 17, null);
      child.emit("close", 17, null);
    });

    authPipe.on("data", (chunk) => { bearer += chunk.toString("ascii"); });
    authPipe.on("end", () => {
      server = createServer((req, res) => {
        requestSeen({ method: req.method, url: req.url, authorization: req.headers.authorization, owner: req.headers["x-owner-principal"], client: req.headers["x-client-id"] });
        handler?.({ req, res, bearer, child });
        if (!handler) {
          req.resume();
          req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end('{"ok":true}');
          });
        }
      });
      const oldMask = process.umask(0o177);
      server.listen(args[args.indexOf("--socket") + 1], () => {
        process.umask(oldMask);
      });
    });
    return child;
  };

  const bridge = new SupervisorBridge({
    enabled: true,
    configDir,
    supervisorCwd,
    startupTimeoutMs,
    requestTimeoutMs: 3_000,
    maxResponseBytes: 1024,
    spawnChild,
    ...(httpClient ? { httpClient } : {}),
  });
  return {
    bridge,
    configDir,
    get child() { return child; },
    get bearer() { return bearer.trim(); },
    requestPromise,
    cleanup: async () => {
      await bridge.close().catch(() => undefined);
      if (server?.listening) await new Promise((resolve) => server.close(resolve));
      await rm(configDir, { recursive: true, force: true });
    },
  };
}

test("starts only explicitly, sends bearer on the Unix socket, and closes its owned socket", async () => {
  const f = await fixture();
  try {
    const disabled = new SupervisorBridge({ enabled: false, configDir: f.configDir, supervisorCwd: join(f.configDir, "supervisor") });
    await assert.rejects(disabled.start(), { code: "disabled" });
    assert.equal(disabled.status().state, "stopped");

    await f.bridge.start();
    assert.equal(f.bridge.status().state, "running");
    assert.equal((await lstat(f.bridge.stateDir)).mode & 0o777, 0o700);
    assert.equal((await lstat(f.bridge.socketPath)).mode & 0o777, 0o600);
    assert.equal(Buffer.from(f.bearer, "base64url").length, 32);

    const result = await f.bridge.request("GET", "/admin/api/v1/assignments?limit=1", undefined, { ownerPrincipalId: "oauth-client:client-a", clientId: "client-a" });
    assert.deepEqual(result, { ok: true });
    const observed = await f.requestPromise;
    assert.equal(observed.method, "GET");
    assert.equal(observed.authorization, `Bearer ${f.bearer}`);
    assert.equal(observed.owner, "oauth-client:client-a");
    assert.equal(observed.client, "client-a");
    assert.equal(f.child.killed, undefined);

    await f.bridge.close();
    assert.equal(f.bridge.status().state, "stopped");
    await assert.rejects(lstat(f.bridge.socketPath), { code: "ENOENT" });
    assert.equal(f.child.killed, true);
  } finally {
    await f.cleanup();
  }
});

test("rejects unlisted routes, path traversal, duplicate query keys, and unsupported methods", () => {
  assert.equal(isAllowedSupervisorRoute("POST", "/admin/api/v1/assignments"), true);
  assert.equal(isAllowedSupervisorRoute("GET", "/admin/api/v1/events?after=1&limit=200"), true);
  assert.equal(isAllowedSupervisorRoute("POST", "/v1/accounts"), true);
  assert.equal(isAllowedSupervisorRoute("GET", "/v1/assignments/job-1/results"), true);
  assert.equal(isAllowedSupervisorRoute("POST", "/v1/assignments/job-1/cancel"), true);
  assert.equal(isAllowedSupervisorRoute("GET", "/v1/inbox?projectId=project-a&after=opaque_cursor-A9&limit=100"), true);
  assert.equal(isAllowedSupervisorRoute("POST", "/v1/inbox/repo:123/ack"), true);
  assert.equal(isAllowedSupervisorRoute("POST", "/v1/inbox/job:123/ack?projectId=project-a"), false);
  assert.equal(isAllowedSupervisorRoute("POST", "/v1/inbox/repo:0/ack"), false);
  assert.equal(isAllowedSupervisorRoute("GET", `/v1/inbox?projectId=project-a&after=${"x".repeat(129)}&limit=10`), false);
  assert.equal(isAllowedSupervisorRoute("GET", "/v1/inbox?projectId=project-a&after=cursor&after=other&limit=10"), false);
  assert.equal(isAllowedSupervisorRoute("POST", "/v1/accounts/job-1"), false);
  assert.equal(isAllowedSupervisorRoute("DELETE", "/admin/api/v1/assignments/id"), false);
  assert.equal(isAllowedSupervisorRoute("GET", "/admin/api/v1/assignments/../events"), false);
  assert.equal(isAllowedSupervisorRoute("GET", "/admin/api/v1/events?limit=1&limit=2"), false);
  assert.equal(isAllowedSupervisorRoute("POST", "//outside.example/admin/api/v1/control"), false);
});

test("fails closed on an HTTP 401 without exposing the bearer", async () => {
  const f = await fixture({
    httpClient: async (request) => {
      assert.match(request.headers.authorization, /^Bearer [A-Za-z0-9_-]{43}$/);
      return { statusCode: 401, body: Buffer.from("private auth detail") };
    },
  });
  try {
    await f.bridge.start();
    await assert.rejects(f.bridge.request("GET", "/admin/api/v1/events"), { code: "authentication_failed" });
    assert.equal(f.bridge.status().state, "failed");
    assert.equal(f.bridge.status().failureCode, "authentication_failed");
    assert.equal(f.bridge.status().diagnostics.stderrContent, "redacted");
    assert.equal(f.child.killed, true);
  } finally {
    await f.cleanup();
  }
});

test("treats an oversized 401 body as authentication failure and rejects non-JSON request values", async () => {
  const f = await fixture({
    handler: ({ res }) => {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("x".repeat(4096));
    },
  });
  try {
    await f.bridge.start();
    await assert.rejects(f.bridge.request("POST", "/admin/api/v1/assignments", Symbol("invalid")), { code: "invalid_request_body" });
    await assert.rejects(f.bridge.request("GET", "/admin/api/v1/events"), { code: "authentication_failed" });
    assert.equal(f.bridge.status().state, "failed");
    assert.equal(f.child.killed, true);
  } finally {
    await f.cleanup();
  }
});

test("enforces request and response bounds and aborts timed out requests", async () => {
  let calls = 0;
  const f = await fixture({
    httpClient: async ({ signal }) => {
      calls++;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });
  try {
    await f.bridge.start();
    await assert.rejects(
      f.bridge.request("POST", "/admin/api/v1/assignments", { instructions: "x".repeat(300_000) }),
      { code: "request_too_large" },
    );
    assert.equal(calls, 0);
    await assert.rejects(f.bridge.request("GET", "/admin/api/v1/events", undefined, { timeoutMs: 30 }), { code: "request_timeout" });
    assert.equal(calls, 1);
  } finally {
    await f.cleanup();
  }

  const oversize = await fixture({
    httpClient: async () => ({ statusCode: 200, body: Buffer.alloc(1025) }),
  });
  try {
    await oversize.bridge.start();
    await assert.rejects(oversize.bridge.request("GET", "/admin/api/v1/events"), { code: "response_too_large" });
  } finally {
    await oversize.cleanup();
  }
});

test("does not touch a pre-existing socket path and reports child startup failure", async () => {
  const f = await fixture({ startupTimeoutMs: 60 });
  try {
    const { symlink } = await import("node:fs/promises");
    const target = join(f.configDir, "sentinel");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(target, "preserve"));
    await symlink(target, f.bridge.socketPath);
    await assert.rejects(f.bridge.start(), { code: "socket_path_exists" });
    assert.equal((await lstat(f.bridge.socketPath)).isSymbolicLink(), true);
    assert.equal(f.child, undefined);
  } finally {
    await f.cleanup();
  }

  const failed = await fixture({
    startupTimeoutMs: 60,
    handler: () => {},
  });
  // Simulate a child which exits before binding its socket.
  const spawnChild = () => {
    const child = new EventEmitter();
    child.stdio = [null, null, new PassThrough(), new PassThrough()];
    child.stderr = child.stdio[2];
    child.exitCode = 1;
    child.signalCode = null;
    child.kill = () => true;
    setImmediate(() => child.emit("exit", 1, null));
    return child;
  };
  const bridge = new SupervisorBridge({
    enabled: true,
    configDir: failed.configDir,
    supervisorCwd: join(failed.configDir, "supervisor"),
    startupTimeoutMs: 60,
    spawnChild,
  });
  try {
    await assert.rejects(bridge.start(), { code: "child_not_ready" });
    assert.equal(bridge.status().state, "failed");
  } finally {
    await bridge.close().catch(() => undefined);
    await failed.cleanup();
  }
});

test("marks an unexpected child crash failed and removes only its recorded socket", async () => {
  const f = await fixture();
  try {
    await f.bridge.start();
    const before = await lstat(f.bridge.socketPath);
    f.child.crash();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(f.bridge.status().state, "failed");
    assert.equal(f.bridge.status().failureCode, "child_exited");
    await assert.rejects(f.bridge.request("GET", "/admin/api/v1/events"), { code: "not_running" });
    await assert.rejects(lstat(f.bridge.socketPath), { code: "ENOENT" });
    assert.ok(before.ino > 0);
  } finally {
    await f.cleanup();
  }
});


test("credit admission diagnostics allow only the exact private read route", () => {
  assert.equal(isAllowedSupervisorRoute("GET", "/admin/api/v1/credit-admission"), true);
  assert.equal(isAllowedSupervisorRoute("POST", "/admin/api/v1/credit-admission"), false);
  assert.equal(isAllowedSupervisorRoute("GET", "/admin/api/v1/credit-admission?accountId=other"), false);
});

// Real child startup can exceed five seconds on a loaded desktop.
test("default bridge startup accepts delayed Python readiness and cleans up", {timeout:45000}, async (t) => {
  const configDir = await mkdtemp(join(tmpdir(), "t2o-delayed-bridge-"));
  const bridge = new SupervisorBridge({
    enabled: true, configDir, supervisorCwd: join(process.cwd(), "supervisor"),
    spawnChild: (command, args, options) => spawn(command, ["-c",
      "import os,time,runpy,sys; os.umask(0o177); time.sleep(6); sys.argv=['snooze.bridge',*sys.argv[1:]]; runpy.run_module('snooze.bridge',run_name='__main__')",
      ...args.slice(2)], options),
  });
  t.after(async () => {
    try { await bridge.close(); }
    finally { await rm(configDir, {recursive:true,force:true}); }
  });
  await bridge.start();
  assert.equal(bridge.status().state, "running");
  assert.equal(bridge.status().childRunning, true);
  await bridge.close();
  await assert.rejects(lstat(bridge.socketPath), {code:"ENOENT"});
});
