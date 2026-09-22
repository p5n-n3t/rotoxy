import type { Classification, PoolConfig, RotoxyConfig, RouteDecision, SmartTarget } from "./types.js";
import { getSecret } from "./config.js";

export const TASK_CATEGORIES = [
  ["general", "General conversation and uncategorized work"],
  ["coding", "Code generation, implementation, refactoring and software engineering"],
  ["debugging", "Debugging, testing, diagnosis and failure analysis"],
  ["reasoning", "Multi-step reasoning, planning, decision analysis and architecture"],
  ["research", "Research, search synthesis, source comparison and OSINT-style investigation"],
  ["data", "Data analysis, statistics, SQL, spreadsheets and quantitative interpretation"],
  ["math-science", "Mathematics, science, proofs, calculations and technical derivations"],
  ["extraction", "Information extraction, classification, tagging and structured output"],
  ["summarization", "Summaries, compression, meeting notes and document condensation"],
  ["writing", "Professional writing, rewriting, editing and communication"],
  ["creative", "Ideation, brainstorming, creative writing and concept generation"],
  ["translation", "Translation, localization and multilingual transformation"],
  ["vision", "Image, screenshot, chart, PDF and visual understanding"],
  ["long-context", "Long documents, retrieval, RAG and cross-document synthesis"],
  ["agentic", "Tool use, multi-step execution, autonomous agents and orchestration"],
  ["security", "Security review, threat modeling, code auditing and defensive analysis"],
  ["devops", "Infrastructure, shell, cloud, CI/CD, networking and systems operations"],
  ["documents", "Document generation, formatting and office-file workflows"]
] as const;

const poolCursor = new Map<string, number>();
const accountCursor = new Map<string, number>();
const cooldownUntil = new Map<string, number>();

function textFromBody(body: any): string {
  if (!body || typeof body !== "object") return "";
  const chunks: string[] = [];
  const add = (v: any) => {
    if (typeof v === "string") chunks.push(v);
    else if (Array.isArray(v)) for (const x of v) add(x?.text ?? x?.content ?? x);
    else if (v && typeof v === "object") add(v.text ?? v.content ?? v.input_text);
  };
  add(body.prompt);
  add(body.input);
  if (Array.isArray(body.messages)) for (const m of body.messages) add(m?.content);
  if (Array.isArray(body.contents)) for (const m of body.contents) add(m?.parts ?? m);
  return chunks.join("\n").slice(0, 200_000);
}

export function classifyRequest(body: any): Classification {
  const text = textFromBody(body).toLowerCase();
  const score: Record<string, number> = Object.fromEntries(TASK_CATEGORIES.map(([id]) => [id, 0]));
  const hit = (id: string, terms: RegExp, weight = 1) => {
    const matches = text.match(terms);
    if (matches) score[id] += matches.length * weight;
  };

  hit("coding", /\b(code|implement|function|class|typescript|javascript|python|rust|go\b|java\b|api|sdk|refactor|repository|git|frontend|backend)\b/g, 2);
  hit("debugging", /\b(debug|bug|error|exception|stack trace|failing|failure|test failure|diagnos|fix this)\b/g, 3);
  hit("reasoning", /\b(reason|plan|architecture|trade-?off|compare|evaluate|strategy|multi-step|design|derive|why)\b/g, 2);
  hit("research", /\b(research|sources?|citations?|investigate|osint|find evidence|web search|latest|verify)\b/g, 2);
  hit("data", /\b(data|dataset|csv|sql|statistics?|regression|chart|plot|spreadsheet|pandas|analytics?)\b/g, 2);
  hit("math-science", /\b(equation|calculate|proof|theorem|algebra|calculus|physics|chemistry|biology|scientific)\b/g, 2);
  hit("extraction", /\b(extract|classify|label|tag|schema|json|structured output|parse|entities)\b/g, 2);
  hit("summarization", /\b(summarize|summary|tl;dr|condense|meeting notes|key points)\b/g, 3);
  hit("writing", /\b(write|rewrite|edit|email|memo|proposal|copy|tone|grammar|resume|cv)\b/g, 1);
  hit("creative", /\b(brainstorm|creative|story|poem|concept|ideas?|slogan|name ideas?)\b/g, 2);
  hit("translation", /\b(translate|translation|localize|localization|in spanish|in french|in arabic)\b/g, 3);
  hit("vision", /\b(image|photo|screenshot|diagram|visual|ocr|chart image|look at this)\b/g, 2);
  hit("long-context", /\b(long document|entire document|across these files|rag|retrieval|knowledge base|many files|whole repo)\b/g, 2);
  hit("agentic", /\b(agent|delegate|orchestrat|tool call|autonomous|workflow|multi-agent|execute|take over)\b/g, 2);
  hit("security", /\b(security|vulnerabilit|threat model|audit|cve|exploit|hardening|secret scan)\b/g, 2);
  hit("devops", /\b(docker|kubernetes|terraform|ansible|cloudflare|aws|azure|gcp|ssh|linux|systemd|deploy|ci\/cd|network|tailscale)\b/g, 2);
  hit("documents", /\b(pdf|docx|pptx|powerpoint|slides|document formatting|report file)\b/g, 2);

  const ranked = Object.entries(score).sort((a,b) => b[1] - a[1]);
  const task = ranked[0]?.[1] > 0 ? ranked[0][0] : "general";

  let difficulty: "easy" | "medium" | "hard" = "easy";
  const hardMarkers = (text.match(/\b(architecture|multi-step|comprehensive|deep research|prove|optimize|debug|migration|orchestrat|distributed|concurrency|security audit|entire repo)\b/g) || []).length;
  const mediumMarkers = (text.match(/\b(compare|analyze|implement|explain|research|refactor|design|review|multiple|workflow)\b/g) || []).length;
  if (hardMarkers >= 2 || text.length > 8000) difficulty = "hard";
  else if (hardMarkers >= 1 || mediumMarkers >= 2 || text.length > 1800) difficulty = "medium";

  return {
    task,
    difficulty,
    reasons: [
      ranked[0]?.[1] ? `task score: ${task}=${ranked[0][1]}` : "no strong task signal; using general",
      `prompt size: ${text.length} characters`
    ]
  };
}

function nextIndex(key: string, size: number, random = false) {
  if (size <= 1) return 0;
  if (random) return Math.floor(Math.random() * size);
  const i = poolCursor.get(key) || 0;
  poolCursor.set(key, (i + 1) % size);
  return i % size;
}

function selectPoolTarget(pool: PoolConfig) {
  if (pool.type === "provider") return { provider: pool.provider!, model: pool.defaultModel };
  const targets = (pool.targets || []).filter(Boolean);
  if (!targets.length) throw new Error(`Pool "${pool.id}" has no targets`);
  if (pool.strategy === "failover") return targets[0];
  return targets[nextIndex(`pool:${pool.id}`, targets.length, pool.strategy === "random")];
}

function selectAccount(config: RotoxyConfig, providerId: string) {
  const provider = config.providers[providerId];
  if (!provider || provider.enabled === false) throw new Error(`Provider "${providerId}" is unavailable`);
  const now = Date.now();
  const enabled = provider.accounts.filter(a => a.enabled !== false);
  if (!enabled.length) throw new Error(`Provider "${providerId}" has no enabled accounts`);
  let candidates = enabled.filter(a => (cooldownUntil.get(`${providerId}:${a.id}`) || 0) <= now);
  if (!candidates.length) candidates = enabled;
  const key = `account:${providerId}`;
  const i = accountCursor.get(key) || 0;
  const account = candidates[i % candidates.length];
  accountCursor.set(key, (i + 1) % candidates.length);
  return { account, secret: getSecret(account.secret) };
}

function parseVirtualModel(model?: string) {
  if (!model?.startsWith("rotoxy/")) return null;
  const parts = model.split("/");
  if (parts[1] === "auto") return { kind: "auto", value: "auto" };
  if (parts[1] === "provider" && parts[2]) return { kind: "provider", value: parts.slice(2).join("/") };
  if (parts[1] === "pool" && parts[2]) return { kind: "pool", value: parts.slice(2).join("/") };
  if (parts[1] === "task" && parts[2]) return { kind: "task", value: parts.slice(2).join("/") };
  if (parts[1] === "difficulty" && parts[2]) return { kind: "difficulty", value: parts[2] };
  return null;
}

function targetFromSmart(config: RotoxyConfig, kind: "task" | "difficulty", value: string): SmartTarget | null {
  const router = config.routers[kind];
  return router.enabled ? (router.mappings[value] || null) : null;
}

function routeFromPath(rawPath: string) {
  const url = new URL(rawPath, "http://rotoxy.local");
  const parts = url.pathname.split("/").filter(Boolean);
  let selected: {kind:"provider"|"pool"|"task"|"difficulty"|"smart-task"|"smart-difficulty"|"smart-auto"; value:string} | null = null;
  let consumed = 0;
  if (parts[0] === "p" && parts[1]) { selected = {kind:"provider",value:decodeURIComponent(parts[1])}; consumed = 2; }
  else if (parts[0] === "pool" && parts[1]) { selected = {kind:"pool",value:decodeURIComponent(parts[1])}; consumed = 2; }
  else if (parts[0] === "task" && parts[1]) { selected = {kind:"task",value:decodeURIComponent(parts[1])}; consumed = 2; }
  else if (parts[0] === "difficulty" && parts[1]) { selected = {kind:"difficulty",value:decodeURIComponent(parts[1])}; consumed = 2; }
  else if (parts[0] === "smart" && parts[1] === "task") { selected = {kind:"smart-task",value:"auto"}; consumed = 2; }
  else if (parts[0] === "smart" && parts[1] === "difficulty") { selected = {kind:"smart-difficulty",value:"auto"}; consumed = 2; }
  else if (parts[0] === "smart" && parts[1] === "auto") { selected = {kind:"smart-auto",value:"auto"}; consumed = 2; }
  if (!selected) return { selected:null, path:rawPath };
  const stripped = "/" + parts.slice(consumed).join("/") + url.search;
  return { selected, path:stripped === "/" ? "/" : stripped };
}

export function resolveRoute(
  config: RotoxyConfig,
  rawPath: string,
  headers: Record<string, string | string[] | undefined>,
  body: any
): { decision: RouteDecision; classification: Classification } {
  const classification = classifyRequest(body);
  const incomingModel = typeof body?.model === "string" ? body.model : undefined;
  const virtual = parseVirtualModel(incomingModel);
  const pathChoice = routeFromPath(rawPath);
  let poolId = config.defaultPool;
  let modelOverride: string | undefined;
  let reason = `default pool: ${poolId}`;

  const header = (name:string) => {
    const v = headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };

  const providerHeader = header("x-rotoxy-provider");
  const poolHeader = header("x-rotoxy-pool");
  const taskHeader = header("x-rotoxy-task");
  const difficultyHeader = header("x-rotoxy-difficulty");

  const applyChoice = (kind:string,value:string) => {
    if (kind === "provider") {
      const synthetic = Object.values(config.pools).find(p => p.type === "provider" && p.provider === value);
      if (!synthetic) throw new Error(`No pool exists for provider "${value}"`);
      poolId = synthetic.id; reason = `provider route: ${value}`;
    } else if (kind === "pool") {
      if (!config.pools[value]) throw new Error(`Unknown pool "${value}"`);
      poolId = value; reason = `pool route: ${value}`;
    } else if (kind === "task") {
      const t = targetFromSmart(config,"task",value);
      if (t) { poolId=t.pool; modelOverride=t.model; reason=`task route: ${value}`; }
    } else if (kind === "difficulty") {
      const t = targetFromSmart(config,"difficulty",value);
      if (t) { poolId=t.pool; modelOverride=t.model; reason=`difficulty route: ${value}`; }
    } else if (kind === "smart-task") {
      const t = targetFromSmart(config,"task",classification.task);
      if (t) { poolId=t.pool; modelOverride=t.model; reason=`smart task route: ${classification.task}`; }
    } else if (kind === "smart-difficulty") {
      const t = targetFromSmart(config,"difficulty",classification.difficulty);
      if (t) { poolId=t.pool; modelOverride=t.model; reason=`smart difficulty route: ${classification.difficulty}`; }
    } else if (kind === "smart-auto") {
      const task = targetFromSmart(config,"task",classification.task);
      const difficulty = targetFromSmart(config,"difficulty",classification.difficulty);
      const t = config.routers.autoPolicy === "task" ? task : config.routers.autoPolicy === "difficulty" ? difficulty : (task || difficulty);
      if (t) { poolId=t.pool; modelOverride=t.model; reason=`smart auto route: ${classification.task}/${classification.difficulty}`; }
    }
  };

  if (pathChoice.selected) applyChoice(pathChoice.selected.kind,pathChoice.selected.value);
  if (providerHeader) applyChoice("provider",providerHeader);
  if (poolHeader) applyChoice("pool",poolHeader);
  if (taskHeader) applyChoice("task",taskHeader);
  if (difficultyHeader) applyChoice("difficulty",difficultyHeader);

  if (virtual) {
    if (virtual.kind === "auto") {
      const tryTask = () => targetFromSmart(config,"task",classification.task);
      const tryDifficulty = () => targetFromSmart(config,"difficulty",classification.difficulty);
      const target = config.routers.autoPolicy === "task" ? tryTask()
        : config.routers.autoPolicy === "difficulty" ? tryDifficulty()
        : (tryTask() || tryDifficulty());
      if (target) { poolId=target.pool; modelOverride=target.model; reason=`auto route: ${classification.task}/${classification.difficulty}`; }
    } else applyChoice(virtual.kind,virtual.value);
  }

  const pool = config.pools[poolId];
  if (!pool || pool.enabled === false) throw new Error(`Pool "${poolId}" is unavailable`);
  const target = selectPoolTarget(pool);
  const provider = config.providers[target.provider];
  if (!provider) throw new Error(`Provider "${target.provider}" does not exist`);
  const {account,secret} = selectAccount(config,target.provider);

  const realIncomingModel = incomingModel && !incomingModel.startsWith("rotoxy/") ? incomingModel : undefined;
  let upstreamModel = modelOverride || target.model || pool.defaultModel || realIncomingModel || provider.defaultModel;
  if (incomingModel?.startsWith("rotoxy/") && !upstreamModel) {
    throw new Error(`Route "${reason}" has no real model configured`);
  }

  if (provider.adapter === "openrouter" && provider.policy?.freeOnly) {
    upstreamModel ||= "openrouter/free";
    if (upstreamModel !== "openrouter/free" && !upstreamModel.endsWith(":free")) {
      throw new Error(`OpenRouter free-only policy blocked paid/non-free model "${upstreamModel}". Use openrouter/free or a :free model.`);
    }
  }

  return {
    classification,
    decision: {
      poolId,
      providerId: provider.id,
      accountId: account.id,
      accountName: account.name,
      accountSecret: secret,
      upstreamModel,
      requestedModel: incomingModel,
      routeReason: reason,
      path: pathChoice.path
    }
  };
}

export function markCooldown(providerId:string,accountId:string,seconds:number) {
  cooldownUntil.set(`${providerId}:${accountId}`,Date.now()+seconds*1000);
}
