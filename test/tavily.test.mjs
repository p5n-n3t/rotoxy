import assert from "node:assert/strict";
import test from "node:test";
import {
  createTavilyAdapter,
  TAVILY_API_ORIGIN,
  TAVILY_CAPABILITIES,
  TavilyInputError,
  TavilyProviderError,
} from "../dist/providers/tavily.js";

const SECRET = "tvly-test-secret-must-not-leak";

function fixture(payload, { status = 200, headers = {}, fetch: customFetch, credential = SECRET } = {}) {
  const calls = [];
  let credentialCalls = 0;
  const adapter = createTavilyAdapter({
    fetch: customFetch ?? (async (url, init) => {
      calls.push({ url, init });
      return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status, headers });
    }),
    resolveCredential: () => { credentialCalls += 1; return credential; },
  });
  return { adapter, calls, credentialCalls: () => credentialCalls };
}

function visibleError(error) {
  return [error.name, error.message, error.category, error.requestOutcome, error.httpStatus].join(" ");
}

test("advertises documented REST capabilities without claiming unimplemented endpoints", () => {
  assert.equal(TAVILY_API_ORIGIN, "https://api.tavily.com");
  assert.deepEqual(TAVILY_CAPABILITIES, {
    search: "supported", extract: "supported", map: "unsupported", crawl: "unsupported",
    research: "unsupported", usage: "unsupported",
  });
});

test("search posts to the fixed HTTPS endpoint with resolver-only bearer auth and documented options", async () => {
  const { adapter, calls } = fixture({
    query: "climate policy", results: [{ title: "Source", url: "https://example.test/a", content: "excerpt", published_date: "2026-10-01", score: 0.91 }],
    answer: "A bounded answer", images: [{ url: "https://example.test/image.png", description: "chart" }],
    response_time: 1.5, usage: { credits: 2 },
  });
  const result = await adapter.search({
    query: "climate policy", maxResults: 4,
    providerOptions: {
      searchDepth: "advanced", chunksPerSource: 2, topic: "news", timeRange: "month",
      startDate: "2026-09-01", endDate: "2026-10-01", includeAnswer: "basic",
      includeDomains: ["example.test"], includeDomainsMode: "prefer", includeUsage: true,
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${TAVILY_API_ORIGIN}/search`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(calls[0].init.headers["x-api-key"], undefined);
  assert.equal(JSON.parse(calls[0].init.body).api_key, undefined);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    query: "climate policy", max_results: 4, search_depth: "advanced", chunks_per_source: 2,
    topic: "news", time_range: "month", start_date: "2026-09-01", end_date: "2026-10-01",
    include_answer: "basic", include_domains: ["example.test"], include_domains_mode: "prefer", include_usage: true,
  });
  assert.deepEqual(result.results, [{
    url: "https://example.test/a", title: "Source", snippet: "excerpt", publishedAt: "2026-10-01", score: 0.91,
  }]);
  assert.equal(result.answer, "A bounded answer");
  assert.deepEqual(result.images, [{ url: "https://example.test/image.png", description: "chart" }]);
  assert.deepEqual(result.usage, { known: true, credits: 2, source: "provider-response" });
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("extract uses a single documented URL batch and reports partial failure without raw provider errors", async () => {
  const { adapter, calls } = fixture({
    results: [{ url: "https://example.test/page", raw_content: "# Page text", images: ["https://example.test/pic.png"], favicon: "https://example.test/favicon.ico" }],
    failed_results: [{ url: "https://example.test/private", error: `provider echoed ${SECRET}` }],
    response_time: 0.3, usage: { credits: 1 },
  });
  const result = await adapter.extract({
    url: "https://example.test/page",
    providerOptions: { query: "focused question", chunksPerSource: 3, extractDepth: "advanced", includeImages: true, format: "text", timeoutSeconds: 20, includeUsage: true },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${TAVILY_API_ORIGIN}/extract`);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    urls: ["https://example.test/page"], query: "focused question", chunks_per_source: 3,
    extract_depth: "advanced", include_images: true, format: "text", timeout: 20, include_usage: true,
  });
  assert.deepEqual(result.results, [{
    url: "https://example.test/page", content: "# Page text", images: ["https://example.test/pic.png"], favicon: "https://example.test/favicon.ico",
  }]);
  assert.deepEqual(result.failedResults, [{ url: "https://example.test/private" }]);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("maps documented search filters and response controls to Tavily field names", async () => {
  const { adapter, calls } = fixture({ results: [], images: [] });
  await adapter.search({
    query: "filtered", providerOptions: {
      topic: "general", includePublishedDate: true, filterByPublishedDate: true,
      includeRawContent: "markdown", includeImages: true, includeImageDescriptions: true,
      includeFavicon: true, excludeDomains: ["blocked.test"], country: "United States",
      language: "en", filterByLanguage: true, autoParameters: true, exactMatch: true, safeSearch: true,
    },
  });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    query: "filtered", max_results: 10, topic: "general", include_published_date: true,
    filter_by_published_date: true, include_raw_content: "markdown", include_images: true,
    include_image_descriptions: true, include_favicon: true, exclude_domains: ["blocked.test"],
    country: "united states", language: "en", filter_by_language: true,
    auto_parameters: true, exact_match: true, safe_search: true,
  });
});

test("unknown options and documented cross-field conflicts fail before resolving a credential", async () => {
  const { adapter, calls, credentialCalls } = fixture({ results: [] });
  await assert.rejects(adapter.search({ query: "ok", providerOptions: { invented: true } }), TavilyInputError);
  await assert.rejects(adapter.search({ query: "ok", providerOptions: { searchDepth: "ultra-fast", chunksPerSource: 2 } }), TavilyInputError);
  await assert.rejects(adapter.search({ query: "ok", providerOptions: { searchDepth: "fast", safeSearch: true } }), TavilyInputError);
  await assert.rejects(adapter.search({ query: "ok", providerOptions: { searchDepth: "ultra-fast", safeSearch: false } }), TavilyInputError);
  await assert.rejects(adapter.search({ query: "ok", providerOptions: { includeDomainsMode: "prefer" } }), TavilyInputError);
  await assert.rejects(adapter.search({ query: "ok", providerOptions: { filterByLanguage: true } }), TavilyInputError);
  await assert.rejects(adapter.extract({ url: "https://example.test", providerOptions: { chunksPerSource: 2 } }), TavilyInputError);
  assert.equal(calls.length, 0);
  assert.equal(credentialCalls(), 0);
});

test("invalid URLs, input bounds, and oversized requests make no provider call", async () => {
  const { adapter, calls, credentialCalls } = fixture({ results: [] });
  await assert.rejects(adapter.search({ query: "\u0000unsafe" }), TavilyInputError);
  await assert.rejects(adapter.search({ query: "x".repeat(2_001) }), TavilyInputError);
  await assert.rejects(adapter.search({ query: "ok", maxResults: 21 }), TavilyInputError);
  await assert.rejects(adapter.extract({ url: "file:///etc/passwd" }), TavilyInputError);
  await assert.rejects(adapter.extract({ url: "https://user:pass@example.test/" }), TavilyInputError);
  await assert.rejects(adapter.search({ query: "ok", providerOptions: { includeDomains: Array.from({ length: 300 }, () => "x".repeat(253)) } }), TavilyInputError);
  assert.equal(calls.length, 0);
  assert.equal(credentialCalls(), 0);
});

test("Tavily HTTP auth, quota, rate-limit, and transient statuses are classified without body leakage", async (t) => {
  for (const [status, category, outcome] of [[401, "auth", "rejected"], [429, "rate_limit", "rejected"], [432, "quota", "rejected"], [433, "quota", "rejected"], [500, "transient", "unknown"]]) {
    await t.test(String(status), async () => {
      const { adapter, calls } = fixture(`secret body ${SECRET}`, { status, headers: status === 429 ? { "retry-after": "3" } : {} });
      await assert.rejects(adapter.search({ query: "private query" }), (error) => {
        assert.ok(error instanceof TavilyProviderError);
        assert.equal(error.category, category);
        assert.equal(error.requestOutcome, outcome);
        assert.equal(error.httpStatus, status);
        if (status === 429) assert.equal(error.retryAfterMs, 3_000);
        assert.doesNotMatch(visibleError(error), /secret|private query|body/);
        return true;
      });
      assert.equal(calls.length, 1);
    });
  }
});

test("transport ambiguity is reported once with no retry or cross-provider fallback", async () => {
  let calls = 0;
  const adapter = createTavilyAdapter({
    fetch: async () => { calls += 1; throw new Error(`query and ${SECRET}`); },
    resolveCredential: () => SECRET,
  });
  await assert.rejects(adapter.search({ query: "private query" }), (error) => {
    assert.equal(error.category, "transient");
    assert.equal(error.requestOutcome, "unknown");
    assert.doesNotMatch(visibleError(error), /private query|tvly-test-secret/);
    return true;
  });
  assert.equal(calls, 1);
});

test("pre-abort sends nothing; response bytes are bounded; malformed JSON is sanitized", async (t) => {
  await t.test("pre-abort", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const adapter = createTavilyAdapter({ fetch: async () => { calls += 1; return new Response("{}"); }, resolveCredential: () => SECRET });
    await assert.rejects(adapter.search({ query: "cancel", signal: controller.signal }), (error) => {
      assert.equal(error.requestOutcome, "not_sent");
      return true;
    });
    assert.equal(calls, 0);
  });
  await t.test("oversized response", async () => {
    const bounded = createTavilyAdapter({
      fetch: async () => new Response(JSON.stringify({ data: "x".repeat(200) })),
      resolveCredential: () => SECRET,
      maxResponseBytes: 20,
    });
    await assert.rejects(bounded.search({ query: "bounded" }), (error) => error instanceof TavilyProviderError && error.requestOutcome === "unknown");
  });
  await t.test("malformed JSON", async () => {
    const { adapter } = fixture(`not json ${SECRET}`);
    await assert.rejects(adapter.search({ query: "parse" }), (error) => {
      assert.ok(error instanceof TavilyProviderError);
      assert.match(error.message, /invalid JSON/);
      assert.doesNotMatch(visibleError(error), /tvly-test-secret|not json/);
      return true;
    });
  });
  await t.test("request deadline", async () => {
    let calls = 0;
    const bounded = createTavilyAdapter({
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        calls += 1;
        init.signal.addEventListener("abort", () => reject(new DOMException("secret payload", "AbortError")), { once: true });
      }),
      resolveCredential: () => SECRET,
      timeoutMs: 5,
    });
    await assert.rejects(bounded.search({ query: "deadline" }), (error) => {
      assert.equal(error.category, "transient");
      assert.equal(error.requestOutcome, "unknown");
      assert.match(error.message, /timed out/);
      assert.doesNotMatch(visibleError(error), /secret payload/);
      return true;
    });
    assert.equal(calls, 1);
  });
});

test("resolver failures are not sent or exposed", async () => {
  let calls = 0;
  const adapter = createTavilyAdapter({
    fetch: async () => { calls += 1; return new Response("{}"); },
    resolveCredential: () => { throw new Error(`credential storage said ${SECRET}`); },
  });
  await assert.rejects(adapter.search({ query: "credential failure" }), (error) => {
    assert.equal(error.category, "auth");
    assert.equal(error.requestOutcome, "not_sent");
    assert.doesNotMatch(visibleError(error), /credential storage|tvly-test-secret/);
    return true;
  });
  assert.equal(calls, 0);
});
