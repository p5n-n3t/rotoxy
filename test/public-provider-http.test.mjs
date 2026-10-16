import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createPinnedPublicProviderFetch, isPublicProviderAddress } from "../dist/public-provider-http.js";

function fakeRequest(mode, capture) {
  return (options, callback) => {
    capture.options = options;
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.end = () => {
      if (mode === "abort") { capture.onStart?.(); return; }
      const response = new EventEmitter();
      response.statusCode = mode === "redirect" ? 302 : 200;
      response.headers = mode === "oversize" ? { "content-length": String(2 * 1024 * 1024 + 1) } : {};
      callback(response);
      if (mode === "oversize") return;
      queueMicrotask(() => { response.emit("data", Buffer.from("ok")); response.emit("end"); });
    };
    req.destroy = error => { if (error) queueMicrotask(() => req.emit("error", error)); return req; };
    return req;
  };
}

test("public address filter rejects reserved IPv4, mapped and non-global IPv6", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "100.64.0.1", "172.20.1.1", "192.0.2.1", "198.19.0.1", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:8.8.8.8", "2001:db8::1"]) assert.equal(isPublicProviderAddress(ip), false, ip);
  assert.equal(isPublicProviderAddress("8.8.8.8"), true);
  assert.equal(isPublicProviderAddress("2606:4700:4700::1111"), true);
});

test("DNS must return only public addresses and selected address is pinned with original TLS hostname", async () => {
  const capture = {};
  const transport = createPinnedPublicProviderFetch({ resolve: async () => [{ address: "8.8.8.8", family: 4 }], request: fakeRequest("ok", capture) });
  const response = await transport("https://api.vendor.example/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer synthetic", "content-type": "application/json", accept: "application/json" }, body: "{}" });
  assert.equal(await response.text(), "ok");
  assert.equal(capture.options.servername, "api.vendor.example");
  assert.equal(capture.options.rejectUnauthorized, true);
  await new Promise((resolve, reject) => capture.options.lookup("api.vendor.example", {}, (error, address, family) => error ? reject(error) : (assert.equal(address, "8.8.8.8"), assert.equal(family, 4), resolve())));
  let requested = false;
  const mixed = createPinnedPublicProviderFetch({ resolve: async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.2", family: 4 }], request: (...args) => { requested = true; return fakeRequest("ok", {})(...args); } });
  await assert.rejects(mixed("https://api.vendor.example/v1/chat/completions", { method: "POST", body: "{}" }), /not_public/);
  assert.equal(requested, false);
});

test("transport does not follow redirects and bounds response with abort cleanup", async () => {
  const resolve = async () => [{ address: "1.1.1.1", family: 4 }];
  const redirect = createPinnedPublicProviderFetch({ resolve, request: fakeRequest("redirect", {}) });
  assert.equal((await redirect("https://api.vendor.example/v1", { method: "POST", body: "{}" })).status, 302);
  const oversized = createPinnedPublicProviderFetch({ resolve, request: fakeRequest("oversize", {}) });
  await assert.rejects(oversized("https://api.vendor.example/v1", { method: "POST", body: "{}" }), /response_too_large/);
  const abort = new AbortController();
  let start;
  const started = new Promise(resolveStart => { start = resolveStart; });
  const pending = createPinnedPublicProviderFetch({ resolve, request: fakeRequest("abort", { onStart: start }) })("https://api.vendor.example/v1", { method: "POST", signal: abort.signal, body: "{}" });
  await started;
  abort.abort();
  await assert.rejects(pending);
});
