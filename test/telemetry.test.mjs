import test from "node:test";
import assert from "node:assert/strict";
import {
  RingBuffer,
  TimeBuckets,
  TelemetryRecorder,
  REDACTED,
  redact,
  redactString,
  isSecretKey,
  stripControlChars,
  escapeLogValue,
  aggregate,
  aggregateBy,
  deriveOutcome,
  normalizeProviderUsage,
  formatGatewayEvent,
  formatProviderUsage,
  formatSummary,
  OTHER_BUCKET,
} from "../dist/telemetry.js";

const T0 = Date.parse("2026-10-07T06:00:00.000Z");
const clock = (start = T0) => {
  let now = start;
  const fn = () => now;
  fn.set = (value) => {
    now = value;
  };
  return fn;
};

// --- ring buffer -----------------------------------------------------------

test("ring buffer keeps the newest items within capacity", () => {
  const ring = new RingBuffer(3);
  for (let i = 1; i <= 5; i += 1) ring.push(i);
  assert.deepEqual(ring.toArray(), [3, 4, 5]);
  assert.equal(ring.size, 3);
  assert.equal(ring.dropped, 2);
  ring.clear();
  assert.deepEqual(ring.toArray(), []);
  assert.throws(() => new RingBuffer(0), RangeError);
});

test("recorder memory stays bounded under heavy traffic", () => {
  const rec = new TelemetryRecorder({ capacity: 10, now: clock() });
  for (let i = 0; i < 10_000; i += 1) rec.recordGateway({ kind: "request", status: 200, accountId: `a${i}` });
  assert.deepEqual(rec.stats(), { recorded: 10_000, retained: 10, dropped: 9_990, providerRetained: 0 });
  assert.equal(rec.recent({ limit: 100 }).length, 10);
  assert.equal(rec.recent({ limit: 1 })[0].accountId, "a9999");
  assert.equal(rec.summary().window.droppedFromRing, 9_990);
});

test("gateway client attribution is a bounded optional dimension", () => {
  const rec = new TelemetryRecorder({ capacity: 2, now: clock() });
  const event = rec.recordGateway({ kind: "request", status: 200, clientId: ` ${"c".repeat(200)} ` });
  assert.equal(event.clientId.length, 128);
  assert.equal(rec.summary().by.clientId[event.clientId].count, 1);
  assert.equal("clientId" in rec.recordGateway({ kind: "request", status: 200 }), false);
});

// --- redaction -------------------------------------------------------------

test("secret keys are recognized without catching usage counters", () => {
  for (const key of [
    "Authorization",
    "proxy-authorization",
    "Cookie",
    "set-cookie",
    "password",
    "client_secret",
    "X-Api-Key",
    "apiKey",
    "access_token",
    "refreshToken",
    "token",
    "Mcp-Session-Id",
    "privateKey",
  ]) {
    assert.equal(isSecretKey(key), true, key);
  }
  for (const key of ["input_tokens", "max_tokens", "method", "tool", "status", "model"]) {
    assert.equal(isSecretKey(key), false, key);
  }
});

test("redact strips headers, cookies, passwords, tokens and API keys recursively", () => {
  const input = {
    method: "tools/call",
    headers: {
      authorization: "Bearer abc.def.ghi",
      Cookie: "sid=1",
      "x-api-key": "k-123",
      accept: "application/json",
    },
    body: {
      params: { password: "hunter2", nested: [{ access_token: "tok" }, { usage: { input_tokens: 12 } }] },
    },
  };
  const out = redact(input);
  assert.equal(out.headers.authorization, REDACTED);
  assert.equal(out.headers.Cookie, REDACTED);
  assert.equal(out.headers["x-api-key"], REDACTED);
  assert.equal(out.headers.accept, "application/json");
  assert.equal(out.body.params.password, REDACTED);
  assert.equal(out.body.params.nested[0].access_token, REDACTED);
  assert.equal(out.body.params.nested[1].usage.input_tokens, 12);
  const serialized = JSON.stringify(out);
  for (const secret of ["abc.def.ghi", "sid=1", "k-123", "hunter2", '"tok"']) {
    assert.ok(!serialized.includes(secret), secret);
  }
  // Input is not mutated.
  assert.equal(input.headers.authorization, "Bearer abc.def.ghi");
});

test("redactString scrubs secrets embedded in free text and bodies", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const cases = [
    ["upstream said Authorization: Bearer sk_live_9f8a7b6c5d", "sk_live_9f8a7b6c5d"],
    ["GET /mcp?access_token=abc123xyz&x=1", "abc123xyz"],
    ["form: grant_type=x&client_secret=s3cr3t&code=authcode1", "s3cr3t"],
    ["form: grant_type=x&client_secret=s3cr3t&code=authcode1", "authcode1"],
    [`id token ${jwt}`, jwt],
    ["key sk-proj-abcdefghijklmnop1234", "sk-proj-abcdefghijklmnop1234"],
    ["gh ghp_abcdefghijklmnopqrstuvwxyz0123", "ghp_abcdefghijklmnopqrstuvwxyz0123"],
    ['{"refresh_token":"r-111","api_key":"zzz"}', "r-111"],
    ['{"refresh_token":"r-111","api_key":"zzz"}', "zzz"],
    ["Cookie: session=1; password=pw-99", "pw-99"],
  ];
  for (const [text, secret] of cases) {
    const out = redactString(text);
    assert.ok(!out.includes(secret), `${secret} leaked in ${out}`);
    assert.ok(out.includes(REDACTED), out);
  }
  // Ordinary prose is left readable.
  assert.equal(redactString("basic usage of the token pool"), "basic usage of the token pool");
});

test("redact handles cycles, depth, size limits and odd values without throwing", () => {
  const cyclic = { name: "root", list: [] };
  cyclic.self = cyclic;
  cyclic.list.push(cyclic);
  const out = redact(cyclic);
  assert.equal(out.self, "[Circular]");
  assert.equal(out.list[0], "[Circular]");

  // Shared (non-cyclic) references are not mistaken for cycles.
  const shared = { v: 1 };
  assert.deepEqual(redact({ a: shared, b: shared }), { a: { v: 1 }, b: { v: 1 } });

  let deep = { leaf: true };
  for (let i = 0; i < 20; i += 1) deep = { next: deep };
  assert.ok(JSON.stringify(redact(deep, { maxDepth: 3 })).includes("[MaxDepth]"));

  const big = redact({ s: "x".repeat(5000), arr: Array.from({ length: 200 }, (_, i) => i) }, {
    maxStringLength: 10,
    maxArrayItems: 5,
  });
  assert.equal(big.s, "xxxxxxxxxx…[+4990 chars]");
  assert.equal(big.arr.length, 6);
  assert.equal(big.arr[5], "[+195 more]");

  const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
  assert.equal(Object.keys(redact(many, { maxKeys: 10 })).length, 11);

  const odd = redact({
    fn() {},
    big: 10n,
    nan: Number.NaN,
    date: new Date(T0),
    buf: Buffer.from("secret-bytes"),
    err: new Error("failed with Bearer abcdef123456"),
    map: new Map([["password", "x"], ["ok", 1]]),
    undef: undefined,
  });
  assert.equal(odd.fn, "[Function]");
  assert.equal(odd.big, "10");
  assert.equal(odd.nan, "NaN");
  assert.equal(odd.date, "2026-10-07T06:00:00.000Z");
  assert.equal(odd.buf, "[Binary 12 bytes]");
  assert.deepEqual(odd.err, { name: "Error", message: `failed with Bearer ${REDACTED}` });
  assert.deepEqual(odd.map, { password: REDACTED, ok: 1 });
  assert.equal(odd.undef, null);
});

test("control characters are stripped from stored values", () => {
  assert.equal(stripControlChars("a\nb\r\tc\u0000d\u001b[31me‮f"), "a b  cd[31mef");
  const out = redact({ "evil\nkey": "line1\nline2\u0007" });
  assert.deepEqual(out, { "evil key": "line1 line2" });
});

// --- recorder / events -----------------------------------------------------

test("payload logging is off by default and redacted when enabled", () => {
  const payload = { jsonrpc: "2.0", params: { arguments: { apiKey: "AKIA-very-secret", q: "hello" } } };
  const off = new TelemetryRecorder({ now: clock() });
  const offEvent = off.recordGateway({ kind: "request", status: 200, payload });
  assert.equal(off.capturePayloads, false);
  assert.equal("payload" in offEvent, false);

  const on = new TelemetryRecorder({ now: clock(), capturePayloads: true });
  const onEvent = on.recordGateway({ kind: "request", status: 200, payload });
  assert.equal(onEvent.payload.params.arguments.apiKey, REDACTED);
  assert.equal(onEvent.payload.params.arguments.q, "hello");
});

test("gateway events are normalized with dimensions, status, latency and retries", () => {
  const rec = new TelemetryRecorder({ now: clock() });
  const event = rec.recordGateway({
    kind: "attempt",
    method: "tools/call",
    tool: "search\n<script>",
    accountId: "acct-1",
    pool: "default",
    status: 429,
    latencyMs: 120.5,
    retries: 2,
    errorClass: "quota",
    message: "rate limited for Bearer abcdef123456",
  });
  assert.equal(event.scope, "gateway");
  assert.equal(event.at, T0);
  assert.equal(event.tool, "search <script>");
  assert.equal(event.outcome, "error");
  assert.equal(event.retries, 2);
  assert.equal(event.message, `rate limited for Bearer ${REDACTED}`);
  assert.throws(() => rec.recordGateway({ kind: "bogus" }), TypeError);

  const cleaned = rec.recordGateway({ kind: "probe", latencyMs: -5, retries: Number.NaN, status: 200 });
  assert.equal("latencyMs" in cleaned, false);
  assert.equal(cleaned.retries, 0);
  assert.equal(cleaned.outcome, "success");
});

test("outcome derivation", () => {
  assert.equal(deriveOutcome(200), "success");
  assert.equal(deriveOutcome(302), "success");
  assert.equal(deriveOutcome(401), "error");
  assert.equal(deriveOutcome(503), "error");
  assert.equal(deriveOutcome(undefined), "error");
  assert.equal(deriveOutcome(200, "network"), "error");
});

// --- aggregation -----------------------------------------------------------

test("aggregates success/error counts, retries, status classes and latency", () => {
  const rec = new TelemetryRecorder({ now: clock() });
  const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  latencies.forEach((latencyMs, i) =>
    rec.recordGateway({
      kind: i < 8 ? "request" : "probe",
      method: i % 2 ? "tools/call" : "initialize",
      tool: i % 2 ? "search" : undefined,
      accountId: i < 5 ? "a1" : "a2",
      pool: "main",
      status: i < 7 ? 200 : i === 7 ? 429 : 502,
      errorClass: i === 7 ? "quota" : undefined,
      latencyMs,
      retries: i === 9 ? 3 : 0,
    }),
  );
  const s = rec.summary();
  assert.equal(s.scope, "gateway");
  assert.equal(s.total.count, 10);
  assert.equal(s.total.success, 7);
  assert.equal(s.total.error, 3);
  assert.equal(s.total.errorRate, 0.3);
  assert.equal(s.total.retries, 3);
  assert.deepEqual(s.total.statusClasses, { "2xx": 7, "4xx": 1, "5xx": 2 });
  assert.deepEqual(s.total.errorClasses, { quota: 1, "http-502": 2 });
  assert.deepEqual(s.total.latency, { count: 10, min: 10, max: 100, mean: 55, p50: 50, p95: 100 });

  assert.equal(s.by.kind.request.count, 8);
  assert.equal(s.by.kind.probe.error, 2);
  assert.equal(s.by.accountId.a1.success, 5);
  assert.equal(s.by.accountId.a2.error, 3);
  assert.equal(s.by.method["tools/call"].count, 5);
  assert.equal(s.by.tool.search.count, 5);
  assert.equal(s.by.tool["(none)"].count, 5);
  assert.equal(s.by.pool.main.count, 10);

  assert.equal(rec.summary({ since: T0 + 1 }).total.count, 0);
  assert.deepEqual(aggregate([]).latency, { count: 0, min: null, max: null, mean: null, p50: null, p95: null });
});

test("per-dimension cardinality is capped with an (other) bucket", () => {
  const rec = new TelemetryRecorder({ now: clock(), maxDimensionValues: 3 });
  for (let i = 0; i < 20; i += 1) rec.recordGateway({ kind: "request", status: 200, tool: `t${i % 10}` });
  const byTool = rec.summary().by.tool;
  assert.equal(Object.keys(byTool).length, 4);
  assert.equal(byTool[OTHER_BUCKET].count, 14);
  const total = Object.values(byTool).reduce((n, stats) => n + stats.count, 0);
  assert.equal(total, 20);
  assert.equal(Object.keys(aggregateBy(rec.recent({ limit: 100 }), "tool", 100)).length, 10);
});

// --- time buckets ----------------------------------------------------------

test("time buckets roll a fixed window and ignore stale events", () => {
  const now = clock();
  const rec = new TelemetryRecorder({ now, bucketMs: 1000, bucketCount: 3 });
  rec.recordGateway({ kind: "request", status: 200, latencyMs: 10, at: T0 });
  rec.recordGateway({ kind: "attempt", status: 500, latencyMs: 30, retries: 1, at: T0 + 100 });
  rec.recordGateway({ kind: "probe", status: 200, at: T0 + 1000 });
  now.set(T0 + 1500);
  let series = rec.timeSeries();
  assert.equal(series.length, 3);
  assert.deepEqual(
    series.map((b) => b.count),
    [0, 2, 1],
  );
  const first = series[1];
  assert.equal(first.start, T0);
  assert.equal(first.success, 1);
  assert.equal(first.error, 1);
  assert.equal(first.retries, 1);
  assert.equal(first.latencySum, 40);
  assert.equal(first.latencyMax, 30);
  assert.deepEqual(first.byKind, { request: 1, attempt: 1, probe: 0 });

  // Advance past the window: old slots are recycled, not grown.
  rec.recordGateway({ kind: "request", status: 200, at: T0 + 3000 });
  now.set(T0 + 3500);
  series = rec.timeSeries();
  assert.deepEqual(
    series.map((b) => [b.start - T0, b.count]),
    [
      [1000, 1],
      [2000, 0],
      [3000, 1],
    ],
  );

  // An event older than the slot it maps to is dropped from buckets.
  const buckets = new TimeBuckets(1000, 3);
  const ev = (at) => ({ scope: "gateway", kind: "request", at, retries: 0, outcome: "success" });
  assert.equal(buckets.add(ev(T0 + 3000)), true);
  assert.equal(buckets.add(ev(T0)), false);
  assert.throws(() => new TimeBuckets(0, 3), RangeError);
});

// --- provider usage --------------------------------------------------------

test("provider usage is separate from gateway metrics and never inferred", () => {
  const rec = new TelemetryRecorder({ now: clock() });
  for (let i = 0; i < 50; i += 1) rec.recordGateway({ kind: "request", status: 200, accountId: "a1" });
  // Many successful requests produce zero provider usage records.
  assert.deepEqual(rec.providerUsage(), []);
  assert.deepEqual(rec.latestProviderUsage(), []);
  const summaryJson = JSON.stringify(rec.summary());
  assert.ok(!/credit|tokens/i.test(summaryJson));

  const reported = rec.recordProviderUsage({
    metric: "credits_remaining",
    value: 41.5,
    unit: "credits",
    source: "provider-usage-api",
    observedAt: "2026-10-07T05:59:00.000Z",
    accountId: "a1",
  });
  assert.equal(reported.scope, "provider");
  assert.equal(reported.availability, "reported");
  assert.equal(reported.observedAt, T0 - 60_000);
  assert.equal(reported.recordedAt, T0);

  const unavailable = rec.recordProviderUsage({
    metric: "credits_remaining",
    source: "provider-usage-api",
    observedAt: T0,
    accountId: "a2",
    reason: "provider publishes no usage endpoint",
  });
  assert.equal(unavailable.availability, "unavailable");
  assert.equal(unavailable.value, null);

  // Gateway aggregates are untouched by provider records.
  assert.equal(rec.summary().total.count, 50);
  assert.equal(rec.providerUsage().length, 2);
});

test("provider usage requires source, timestamp, metric and unit", () => {
  const base = { metric: "input_tokens", value: 10, unit: "tokens", source: "response-body:usage", observedAt: T0 };
  assert.equal(normalizeProviderUsage(base, T0).value, 10);
  assert.throws(() => normalizeProviderUsage({ ...base, source: "" }, T0), TypeError);
  assert.throws(() => normalizeProviderUsage({ ...base, source: undefined }, T0), TypeError);
  assert.throws(() => normalizeProviderUsage({ ...base, observedAt: "not a date" }, T0), TypeError);
  assert.throws(() => normalizeProviderUsage({ ...base, metric: " " }, T0), TypeError);
  assert.throws(() => normalizeProviderUsage({ ...base, unit: undefined }, T0), TypeError);
  assert.throws(() => normalizeProviderUsage({ ...base, value: Number.POSITIVE_INFINITY }, T0), TypeError);
  assert.throws(() => normalizeProviderUsage({ ...base, value: "10" }, T0), TypeError);
  // Unavailable values may omit a unit.
  assert.equal(normalizeProviderUsage({ ...base, value: null, unit: undefined }, T0).availability, "unavailable");
});

test("latest provider usage keeps the newest observation per account/model/metric", () => {
  const rec = new TelemetryRecorder({ now: clock(), providerCapacity: 3 });
  const usage = (value, observedAt, model = "m1") =>
    rec.recordProviderUsage({ metric: "total_tokens", value, unit: "tokens", source: "s", observedAt, model, accountId: "a" });
  usage(1, T0 + 2);
  usage(2, T0 + 1); // older observation arriving later
  usage(3, T0, "m2");
  const latest = rec.latestProviderUsage();
  assert.equal(latest.length, 2);
  assert.equal(latest.find((r) => r.model === "m1").value, 1);
  usage(4, T0 + 5);
  assert.equal(rec.providerUsage().length, 3);
});

// --- rendering -------------------------------------------------------------

test("escapeLogValue quotes and escapes user values", () => {
  assert.equal(escapeLogValue("tools/call"), "tools/call");
  assert.equal(escapeLogValue("a b"), '"a b"');
  assert.equal(escapeLogValue('x" injected=1'), '"x\\" injected=1"');
  assert.equal(escapeLogValue("line\nfake=1"), '"line\\nfake=1"');
  assert.equal(escapeLogValue("\u001b[31mred"), '"\\u001b[31mred"');
  assert.equal(escapeLogValue("rtl‮evil"), '"rtl\\u202eevil"');
  assert.equal(escapeLogValue("back\\slash"), '"back\\\\slash"');
  assert.equal(escapeLogValue(""), '""');
  assert.equal(escapeLogValue(42), "42");
});

test("formatGatewayEvent renders one readable, injection-safe line", () => {
  const rec = new TelemetryRecorder({ now: clock(), capturePayloads: true });
  const event = rec.recordGateway({
    kind: "request",
    method: "tools/call",
    tool: "search",
    accountId: "acct-1",
    pool: "main",
    status: 200,
    latencyMs: 123.4,
    retries: 1,
    payload: { q: "hi", token: "t-1" },
  });
  assert.equal(
    formatGatewayEvent(event),
    '2026-10-07T06:00:00.000Z request ok method=tools/call tool=search account=acct-1 pool=main status=200 latency=123ms retries=1 payload="{\\"q\\":\\"hi\\",\\"token\\":\\"[REDACTED]\\"}"',
  );

  // Hand-built events (bypassing the recorder) are still escaped and redacted at render time.
  const line = formatGatewayEvent({
    scope: "gateway",
    kind: "attempt",
    at: T0,
    tool: "x\nERROR fake=line",
    retries: 0,
    outcome: "error",
    errorClass: "auth-failed",
    message: "denied Bearer abcdef123456",
  });
  assert.ok(!line.includes("\n"));
  assert.ok(line.includes('tool="x\\nERROR fake=line"'));
  assert.ok(line.includes(`msg="denied Bearer ${REDACTED}"`));
  assert.ok(!line.includes("abcdef123456"));
});

test("formatProviderUsage shows source, unit and unavailable state", () => {
  const reported = normalizeProviderUsage(
    { metric: "credits_used", value: 2, unit: "credits", source: "provider-usage-api", observedAt: T0, model: "gpt x" },
    T0,
  );
  assert.equal(
    formatProviderUsage(reported),
    '2026-10-07T06:00:00.000Z provider-usage metric=credits_used value=2 unit=credits model="gpt x" source=provider-usage-api',
  );
  const unavailable = normalizeProviderUsage(
    { metric: "credits_remaining", source: "none", observedAt: T0, reason: "no usage API" },
    T0,
  );
  assert.equal(
    formatProviderUsage(unavailable),
    '2026-10-07T06:00:00.000Z provider-usage metric=credits_remaining value=unavailable source=none reason="no usage API"',
  );
});

test("formatSummary renders totals and dimension breakdowns", () => {
  const rec = new TelemetryRecorder({ now: clock() });
  rec.recordGateway({ kind: "request", status: 200, latencyMs: 10, accountId: "a1" });
  rec.recordGateway({ kind: "request", status: 500, latencyMs: 30, accountId: "evil\nname" });
  const text = formatSummary(rec.summary());
  assert.match(text, /^gateway telemetry \(2 events/);
  assert.match(text, /total count=2 ok=1 error=1 error_rate=50\.0% retries=0 p50=10ms p95=30ms max=30ms/);
  assert.match(text, /by accountId:/);
  assert.ok(text.includes('"evil name"'));
  assert.ok(!text.includes("by tool:"));
});
