import assert from "node:assert/strict";
import test from "node:test";
import {
  WEB_TOOL_DEFINITIONS,
  WebToolError,
  WebTools,
  isToolName,
  requiredScope,
} from "../dist/web-tools.js";

const secret = "web-tools-test-secret-do-not-return";
const supported = Object.fromEntries(["exa", "firecrawl", "tavily"].map((provider) => [provider, {
  enabled: true,
  features: { search: "supported", extract: "supported" },
}]));

function makeTools({ fetch = async () => new Response("{}"), providers = supported, allowed = () => true, credentials = () => secret } = {}) {
  return new WebTools({
    config: { providers },
    fetch,
    isToolAllowed: allowed,
    resolveCredential: credentials,
  });
}

test("exports two closed local tools and distinct OAuth scopes", () => {
  assert.deepEqual(WEB_TOOL_DEFINITIONS.map((tool) => tool.name), ["web_search", "web_extract"]);
  assert.equal(isToolName("web_search"), true);
  assert.equal(isToolName("web_crawl"), false);
  assert.equal(requiredScope("web_search"), "web:search");
  assert.equal(requiredScope("web_extract"), "web:extract");
  assert.equal(WEB_TOOL_DEFINITIONS[0].inputSchema.additionalProperties, false);
});

test("checks caller permission and the exact configured provider feature before credentials or fetch", async (t) => {
  let fetches = 0;
  let credentialCalls = 0;
  const fetch = async () => { fetches += 1; return new Response(JSON.stringify({ results: [] })); };
  const allowedTools = makeTools({ fetch, allowed: (caller, name) => caller === "client-a" && name === "web_search", credentials: () => { credentialCalls += 1; return secret; } });
  await assert.rejects(allowedTools.call("web_search", { provider: "exa", query: "q" }, "client-b"), (error) => error.code === "tool_not_allowed");
  const unknownFeature = { ...supported, exa: { enabled: true, features: { search: "unknown", extract: "supported" } } };
  await assert.rejects(makeTools({ fetch, providers: unknownFeature }).call("web_search", { provider: "exa", query: "q" }, "client-a"), (error) => error.code === "provider_feature_unknown");
  const disabled = { ...supported, firecrawl: { enabled: false, features: { search: "supported", extract: "supported" } } };
  await assert.rejects(makeTools({ fetch, providers: disabled }).call("web_search", { provider: "firecrawl", query: "q" }, "client-a"), (error) => error.code === "provider_not_enabled");
  await assert.rejects(makeTools({ fetch }).call("web_extract", { provider: "tavily", url: "file:///etc/passwd" }, "client-a"), (error) => error.code === "invalid_arguments");
  assert.equal(fetches, 0);
  assert.equal(credentialCalls, 0);
});

test("routes the selected provider only and preserves Exa options and provider-reported usage", async () => {
  const calls = [];
  const tools = makeTools({
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ results: [{ url: "https://example.test", title: "Example", text: "Excerpt" }], creditsUsed: 3 }));
    },
    credentials: (provider, caller) => `${provider}-${caller}-secret`,
  });
  const result = await tools.call("web_search", {
    provider: "exa", query: "bounded query", maxResults: 2,
    providerOptions: { type: "neural", includeDomains: ["example.test"], highlights: true },
  }, "client-a");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.exa.ai/search");
  assert.equal(calls[0].init.headers["x-api-key"], "exa-client-a-secret");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    query: "bounded query", type: "neural", numResults: 2,
    contents: { highlights: true }, includeDomains: ["example.test"],
  });
  assert.deepEqual(result.providerUsage, { known: true, value: { credits: 3 }, source: "provider-response" });
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("preserves Firecrawl extract formats and leaves absent usage explicitly unknown", async () => {
  const calls = [];
  const tools = makeTools({ fetch: async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ success: true, data: { markdown: "page", html: "<p>page</p>" } }));
  } });
  const result = await tools.call("web_extract", {
    provider: "firecrawl", url: "https://example.test/page",
    providerOptions: { formats: ["markdown", "html"], onlyMainContent: true },
  }, "client-a");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.firecrawl.dev/v2/scrape");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    url: "https://example.test/page", formats: ["markdown", "html"], onlyMainContent: true,
  });
  assert.deepEqual(result.providerUsage, { known: false, reason: "provider response did not include usage" });
  assert.deepEqual(result.results[0].contentByFormat, { markdown: "page", html: "<p>page</p>" });
});

test("routes Tavily search, retains its specialized response and exact reported credits", async () => {
  const calls = [];
  const tools = makeTools({ fetch: async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ results: [], answer: "answer", response_time: 0.7, usage: { credits: 2 } }));
  } });
  const result = await tools.call("web_search", {
    provider: "tavily", query: "news", providerOptions: { searchDepth: "advanced", topic: "news", includeUsage: true },
  }, "client-a");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.tavily.com/search");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    query: "news", max_results: 10, search_depth: "advanced", topic: "news", include_usage: true,
  });
  assert.equal(result.answer, "answer");
  assert.equal(result.responseTime, 0.7);
  assert.deepEqual(result.providerUsage, { known: true, credits: 2, source: "provider-response" });
});

test("invalid provider-specific options fail before a paid request", async () => {
  let fetches = 0;
  const tools = makeTools({ fetch: async () => { fetches += 1; return new Response("{}"); } });
  await assert.rejects(tools.call("web_search", {
    provider: "exa", query: "q", providerOptions: { searchDepth: "advanced" },
  }, "client-a"), (error) => error instanceof WebToolError && error.code === "invalid_arguments");
  await assert.rejects(tools.call("web_search", { provider: "EXA", query: "q" }, "client-a"), (error) => error.code === "invalid_provider");
  assert.equal(fetches, 0);
});

test("redacts a credential echoed in provider-controlled result fields", async () => {
  const tools = makeTools({
    fetch: async () => new Response(JSON.stringify({ results: [{ url: "https://example.test", text: `echo ${secret}` }] })),
  });
  const result = await tools.call("web_search", { provider: "exa", query: "q" }, "client-a");
  assert.equal(result.results[0].snippet, "echo [REDACTED]");
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("ambiguous failure is sanitized and is never replayed through another provider", async () => {
  let calls = 0;
  const credentialCalls = [];
  const tools = makeTools({
    fetch: async () => { calls += 1; throw new Error(`transport echoed ${secret} and private query`); },
    credentials: (provider, caller) => { credentialCalls.push([provider, caller]); return secret; },
  });
  await assert.rejects(tools.call("web_search", { provider: "exa", query: "private query" }, "client-a"), (error) => {
    assert.equal(error.code, "provider_request_failed");
    assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), new RegExp(`${secret}|private query`));
    assert.equal(error.details.provider, "exa");
    assert.equal(error.details.requestOutcome, "unknown");
    return true;
  });
  assert.equal(calls, 1);
  assert.deepEqual(credentialCalls, [["exa", "client-a"]]);
});
