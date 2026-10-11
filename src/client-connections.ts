import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type LocalMcpClient = "claude-code" | "codex";
export type ClientCommandRunner = (command: string, args: string[]) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;

export interface ClientConnectionStatus {
  client: LocalMcpClient;
  label: string;
  executable: string;
  installed: boolean;
  version?: string;
  registration: "configured" | "not-configured" | "unknown";
  serverNames: string[];
  note: string;
}

export interface ClientConnectionsOptions {
  runner?: ClientCommandRunner;
  homeDir?: string;
  backupDir?: string;
  now?: () => number;
}

const CLIENTS: Record<LocalMcpClient, { label: string; executable: string; configPath: (home: string) => string }> = {
  "claude-code": { label: "Claude Code", executable: "claude", configPath: (home) => join(home, ".claude.json") },
  codex: { label: "Codex CLI", executable: "codex", configPath: (home) => join(home, ".codex", "config.toml") },
};

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function assertClient(client: string): asserts client is LocalMcpClient {
  if (client !== "claude-code" && client !== "codex") throw new Error(`Unsupported local MCP client "${client}"; choose claude-code or codex.`);
}

function defaultRunner(timeoutMs = 5_000): ClientCommandRunner {
  return (command, args) => new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      const err = error as NodeJS.ErrnoException & { code?: string } | null;
      const exitCode = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ exitCode, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

function knownNames(client: LocalMcpClient, text: string): string[] {
  if (client === "claude-code") {
    try {
      const parsed = JSON.parse(text) as { mcpServers?: unknown };
      const entries = parsed?.mcpServers;
      if (entries && typeof entries === "object" && !Array.isArray(entries)) {
        return Object.keys(entries as Record<string, unknown>).filter((name) => SERVER_NAME.test(name)).sort();
      }
    } catch { /* missing or invalid config is reported as unknown by the caller */ }
    return [];
  }

  // Read only section names from Codex's TOML. Never return or copy env,
  // headers, arguments, or any credential-bearing value.
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\]\s*(?:#.*)?$/.exec(line);
    const name = match?.[1] ?? match?.[2] ?? match?.[3];
    if (name && SERVER_NAME.test(name)) names.add(name);
  }
  return [...names].sort();
}

async function readMcpConfig(client: LocalMcpClient, homeDir: string): Promise<{ exists: boolean; readable: boolean; text: string; names: string[] }> {
  try {
    const text = await readFile(CLIENTS[client].configPath(homeDir), "utf8");
    if (client === "claude-code") {
      try {
        const parsed = JSON.parse(text);
        return { exists: true, readable: Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed)), text, names: knownNames(client, text) };
      } catch { return { exists: true, readable: false, text: "", names: [] }; }
    }
    return { exists: true, readable: true, text, names: knownNames(client, text) };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { exists: false, readable: true, text: "", names: [] };
    throw new Error(`Cannot inspect ${CLIENTS[client].label} MCP configuration (${error?.code || "read error"}).`);
  }
}

function safeEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return undefined;
    return url.origin;
  } catch { return undefined; }
}

function safeSnapshot(client: LocalMcpClient, configText: string, names: string[]): object {
  const servers = names.map((name) => {
    let transport = "unknown";
    let endpoint: string | undefined;
    if (client === "claude-code") {
      try {
        const config = JSON.parse(configText) as { mcpServers?: Record<string, any> };
        const server = config.mcpServers?.[name];
        if (server && typeof server === "object") {
          transport = ["http", "sse", "stdio"].includes(server.type) ? server.type : (typeof server.command === "string" ? "stdio" : "unknown");
          endpoint = safeEndpoint(server.url);
        }
      } catch { /* names already parsed; leave endpoint unknown */ }
    } else {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const section = new RegExp(`^\\s*\\[mcp_servers\\.(?:"${escaped}"|'${escaped}'|${escaped})\\]\\s*(?:#.*)?$([\\s\\S]*?)(?=^\\s*\\[|$(?![\\s\\S]))`, "m").exec(configText)?.[1] ?? "";
      const match = /^\s*url\s*=\s*(["'])(.*?)\1\s*(?:#.*)?$/m.exec(section);
      endpoint = safeEndpoint(match?.[2]);
      transport = endpoint ? "http" : "stdio-or-unknown";
    }
    return { name, transport, ...(endpoint ? { endpoint } : {}) };
  });
  return { schema: 1, client, capturedAt: new Date().toISOString(), servers };
}

async function createSafeBackup(client: LocalMcpClient, options: Required<Pick<ClientConnectionsOptions, "homeDir" | "backupDir" | "now">>): Promise<string | undefined> {
  const config = await readMcpConfig(client, options.homeDir);
  if (!config.exists) return undefined;
  const snapshot = safeSnapshot(client, config.text, config.names);
  const path = join(options.backupDir, `${options.now()}-${client}-mcp.json`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(snapshot, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  return path;
}

function validatedUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Server URL must be an absolute HTTP(S) URL."); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP(S) URL without embedded credentials, query parameters, or a fragment.");
  }
  return url.toString();
}

function commandFor(action: "add" | "remove", client: LocalMcpClient, name: string, url?: string): { command: string; args: string[] } {
  const executable = CLIENTS[client].executable;
  if (action === "remove") return client === "claude-code"
    ? { command: executable, args: ["mcp", "remove", name, "--scope", "user"] }
    : { command: executable, args: ["mcp", "remove", name] };
  return client === "claude-code"
    ? { command: executable, args: ["mcp", "add", "--transport", "http", "--scope", "user", name, url!] }
    : { command: executable, args: ["mcp", "add", name, "--url", url!] };
}

function optionsWithDefaults(options: ClientConnectionsOptions) {
  const homeDir = options.homeDir ?? homedir();
  return {
    runner: options.runner ?? defaultRunner(),
    homeDir,
    backupDir: options.backupDir ?? join(homeDir, ".token2oauth", "mcp-backups"),
    now: options.now ?? Date.now,
  };
}

/** Read-only discovery: checks client versions and extracts names from user-level MCP config files. */
export async function inspectClientConnections(options: ClientConnectionsOptions = {}): Promise<ClientConnectionStatus[]> {
  const { runner, homeDir } = optionsWithDefaults(options);
  return Promise.all((Object.keys(CLIENTS) as LocalMcpClient[]).map(async (client) => {
    const definition = CLIENTS[client];
    const version = await runner(definition.executable, ["--version"]);
    if (version.exitCode !== 0) {
      return { client, label: definition.label, executable: definition.executable, installed: false, registration: "unknown", serverNames: [], note: "CLI was not found or its version check failed; no client config was inspected." };
    }
    const config = await readMcpConfig(client, homeDir);
    return {
      client, label: definition.label, executable: definition.executable, installed: true,
      version: (version.stdout || "").match(/\b(?:v?\d+\.){1,3}\d+(?:[-+][A-Za-z0-9.-]+)?\b/)?.[0] || "version available",
      registration: !config.readable ? "unknown" : !config.exists ? "not-configured" : config.names.length ? "configured" : "not-configured",
      serverNames: config.names,
      note: "Registration is local configuration only; this does not test authentication or server execution.",
    };
  }));
}

export interface ClientSetupResult {
  client: LocalMcpClient;
  action: "add" | "remove";
  applied: boolean;
  command: string;
  args: string[];
  backupPath?: string;
  message: string;
}

/** Dry-run unless apply:true. Changes are delegated to the official client CLI. */
export async function configureClientConnection(input: {
  client: LocalMcpClient;
  name: string;
  url: string;
  apply?: boolean;
}, options: ClientConnectionsOptions = {}): Promise<ClientSetupResult> {
  assertClient(input.client);
  if (!SERVER_NAME.test(input.name)) throw new Error("Server name must use 1-64 letters, digits, dots, underscores, or dashes and start with a letter or digit.");
  const url = validatedUrl(input.url);
  return changeClientConnection(input.client, "add", input.name, url, Boolean(input.apply), options);
}

export async function removeClientConnection(input: {
  client: LocalMcpClient;
  name: string;
  apply?: boolean;
}, options: ClientConnectionsOptions = {}): Promise<ClientSetupResult> {
  assertClient(input.client);
  if (!SERVER_NAME.test(input.name)) throw new Error("Invalid MCP server name.");
  return changeClientConnection(input.client, "remove", input.name, undefined, Boolean(input.apply), options);
}

async function changeClientConnection(client: LocalMcpClient, action: "add" | "remove", name: string, url: string | undefined, apply: boolean, options: ClientConnectionsOptions): Promise<ClientSetupResult> {
  const { runner, homeDir, backupDir, now } = optionsWithDefaults(options);
  const definition = CLIENTS[client];
  const version = await runner(definition.executable, ["--version"]);
  if (version.exitCode !== 0) throw new Error(`${definition.label} CLI is unavailable; no changes were made.`);
  const config = await readMcpConfig(client, homeDir);
  if (!config.readable) throw new Error(`${definition.label} MCP configuration is unreadable; no changes were made.`);
  const exists = config.names.includes(name);
  if (action === "add" && exists) throw new Error(`MCP server "${name}" is already registered; refusing to replace it.`);
  if (action === "remove" && !exists) throw new Error(`MCP server "${name}" was not found in the user-level configuration.`);
  const command = commandFor(action, client, name, url);
  if (!apply) {
    return { client, action, applied: false, ...command, message: `Dry run only. Re-run with --apply to let ${definition.label}'s official CLI change its user-level MCP configuration.` };
  }

  const backupPath = action === "add" ? await createSafeBackup(client, { homeDir, backupDir, now }) : undefined;
  const result = await runner(command.command, command.args);
  if (result.exitCode !== 0) throw new Error(`${definition.label} CLI returned exit code ${result.exitCode}; consult its local output. ${backupPath ? `Redacted MCP snapshot: ${backupPath}` : "No existing MCP configuration needed a snapshot."}`);
  return {
    client, action, applied: true, ...command, ...(backupPath ? { backupPath } : {}),
    message: action === "add"
      ? `Server registration command completed. Finish any OAuth flow in ${definition.label}; registration does not prove authentication or successful tool execution.`
      : `Official CLI removal command completed for "${name}".`,
  };
}

/** Honest product boundary: browser-only setup has no local official CLI command here. */
export function manualClientSetupNotes(): Array<{ client: string; support: "manual" | "unsupported"; note: string }> {
  return [
    { client: "ChatGPT Web", support: "manual", note: "Remote MCP setup is managed in ChatGPT Developer Mode by the user; this local CLI cannot configure the web account." },
    { client: "Claude Desktop", support: "unsupported", note: "This helper targets Claude Code CLI only; no Desktop config writer is provided." },
  ];
}
