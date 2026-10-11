import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readFile, lstat, realpath, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_BACKUP_BYTES = 3 * 1024 * 1024;
type ConfigState = { exists: false } | { exists: true; bytes: Buffer; mode: number };
interface ExactConfigBackup {
  schema: 1;
  client: LocalMcpClient;
  configPath: string;
  action: "add" | "remove";
  name: string;
  createdAt: string;
  original: { exists: false } | { exists: true; mode: number; contentBase64: string };
  expectedAfter?: { exists: false } | { exists: true; sha256: string };
  restoredAt?: string;
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

function ownedByCurrentUser(info: { uid?: number }): boolean {
  return process.platform === "win32" || typeof process.getuid !== "function" || info.uid === process.getuid();
}

async function ensurePrivateBackupDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || !ownedByCurrentUser(info) || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new Error("Client config backup directory must be a real owner-only directory.");
  }
  if (await realpath(path) !== resolve(path)) throw new Error("Client config backup directory must not traverse symbolic links.");
}

async function exactConfigState(client: LocalMcpClient, homeDir: string): Promise<ConfigState> {
  const path = CLIENTS[client].configPath(homeDir);
  let info;
  try { info = await lstat(path); }
  catch (error: any) { if (error?.code === "ENOENT") return { exists: false }; throw new Error(`Cannot inspect ${CLIENTS[client].label} config file (${error?.code || "read error"}).`); }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${CLIENTS[client].label} config must be a regular non-symlink file before backup or restore.`);
  if (info.size > MAX_CONFIG_BYTES) throw new Error(`${CLIENTS[client].label} config exceeds the 2 MiB exact-backup limit.`);
  if (!ownedByCurrentUser(info)) throw new Error(`${CLIENTS[client].label} config is not owned by the current user.`);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_CONFIG_BYTES) throw new Error(`${CLIENTS[client].label} config changed or exceeds the exact-backup limit.`);
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_CONFIG_BYTES) throw new Error(`${CLIENTS[client].label} config exceeds the exact-backup limit.`);
    return { exists: true, bytes, mode: info.mode & 0o777 };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error instanceof Error && error.message.includes("config") ? error : new Error(`Cannot safely read ${CLIENTS[client].label} config (${error?.code || "read error"}).`);
  } finally { await handle?.close(); }
}

function stateFingerprint(state: ConfigState): { exists: false } | { exists: true; sha256: string } {
  return state.exists ? { exists: true, sha256: createHash("sha256").update(state.bytes).digest("hex") } : { exists: false };
}

async function writeNewPrivateFile(path: string, text: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(text, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || !ownedByCurrentUser(info) || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new Error("Exact client config backup was not created with private file permissions.");
  }
}

async function writeBackupRecord(path: string, record: ExactConfigBackup, create = false): Promise<void> {
  const text = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_BACKUP_BYTES) throw new Error("Exact client config backup exceeds the 3 MiB limit.");
  if (create) { await writeNewPrivateFile(path, text); return; }
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeNewPrivateFile(tempPath, text);
  try { await rename(tempPath, path); }
  catch (error) { await unlink(tempPath).catch(() => {}); throw error; }
  const info = await lstat(path);
  if (!ownedByCurrentUser(info) || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw new Error("Exact client config backup permissions changed unexpectedly.");
}

async function createExactBackup(client: LocalMcpClient, action: "add" | "remove", name: string, options: Required<Pick<ClientConnectionsOptions, "homeDir" | "backupDir" | "now">>): Promise<{ path: string; record: ExactConfigBackup }> {
  await ensurePrivateBackupDir(options.backupDir);
  const configPath = CLIENTS[client].configPath(options.homeDir);
  const state = await exactConfigState(client, options.homeDir);
  const record: ExactConfigBackup = {
    schema: 1, client, configPath, action, name, createdAt: new Date(options.now()).toISOString(),
    original: state.exists ? { exists: true, mode: state.mode, contentBase64: state.bytes.toString("base64") } : { exists: false },
  };
  const path = join(options.backupDir, `${options.now()}-${client}-${randomUUID()}-exact-config.json`);
  await writeBackupRecord(path, record, true);
  return { path, record };
}

function isExpectedFingerprint(value: unknown): value is ExactConfigBackup["expectedAfter"] {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { exists?: unknown; sha256?: unknown };
  return candidate.exists === false || (candidate.exists === true && typeof candidate.sha256 === "string" && /^[a-f0-9]{64}$/.test(candidate.sha256));
}

async function updateBackupAfterChange(path: string, record: ExactConfigBackup, client: LocalMcpClient, homeDir: string): Promise<void> {
  record.expectedAfter = stateFingerprint(await exactConfigState(client, homeDir));
  await writeBackupRecord(path, record);
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

function parseVersion(text: string): string | undefined {
  return /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?)\b/.exec(text)?.[1];
}

async function verifyCliCompatibility(client: LocalMcpClient, action: "add" | "remove", runner: ClientCommandRunner): Promise<string> {
  const { executable, label } = CLIENTS[client];
  const versionResult = await runner(executable, ["--version"]);
  const version = parseVersion(`${versionResult.stdout || ""} ${versionResult.stderr || ""}`);
  if (versionResult.exitCode !== 0 || !version) throw new Error(`${label} CLI version could not be verified; no changes were made.`);
  const addHelp = await runner(executable, ["mcp", "add", "--help"]);
  const removeHelp = await runner(executable, ["mcp", "remove", "--help"]);
  const helpText = (result: { stdout?: string; stderr?: string }): string => `${result.stdout || ""}\n${result.stderr || ""}`;
  const addText = helpText(addHelp);
  const removeText = helpText(removeHelp);
  const compatible = addHelp.exitCode === 0 && removeHelp.exitCode === 0 && (client === "claude-code"
    ? /--transport\b/.test(addText) && /--scope\b/.test(addText) && /--scope\b/.test(removeText)
    : /--url\b/.test(addText));
  if (!compatible) throw new Error(`${label} ${version} does not advertise the required official MCP ${action} options; no config was changed.`);
  return version;
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
  action: "add" | "remove" | "restore";
  applied: boolean;
  version?: string;
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
  const version = await verifyCliCompatibility(client, action, runner);
  const config = await readMcpConfig(client, homeDir);
  if (!config.readable) throw new Error(`${definition.label} MCP configuration is unreadable; no changes were made.`);
  const exists = config.names.includes(name);
  if (action === "add" && exists) throw new Error(`MCP server "${name}" is already registered; refusing to replace it.`);
  if (action === "remove" && !exists) throw new Error(`MCP server "${name}" was not found in the user-level configuration.`);
  const command = commandFor(action, client, name, url);
  if (!apply) {
    return { client, action, applied: false, version, ...command, message: `Dry run only. Re-run with --apply to let ${definition.label}'s official CLI change its user-level MCP configuration.` };
  }

  const backup = await createExactBackup(client, action, name, { homeDir, backupDir, now });
  let result: Awaited<ReturnType<ClientCommandRunner>>;
  try { result = await runner(command.command, command.args); }
  catch {
    await updateBackupAfterChange(backup.path, backup.record, client, homeDir).catch(() => {});
    throw new Error(`${definition.label} CLI result is uncertain. No retry was attempted; inspect its local state. Private exact config backup: ${backup.path}`);
  }
  try { await updateBackupAfterChange(backup.path, backup.record, client, homeDir); }
  catch { throw new Error(`${definition.label} CLI completed but its resulting config could not be fingerprinted. Do not retry automatically. Private exact config backup: ${backup.path}`); }
  if (result.exitCode !== 0) throw new Error(`${definition.label} CLI returned exit code ${result.exitCode}; consult its local output. Private exact config backup: ${backup.path}`);
  return {
    client, action, applied: true, version, ...command, backupPath: backup.path,
    message: action === "add"
      ? `Server registration command completed. Finish any OAuth flow in ${definition.label}; registration does not prove authentication or successful tool execution.`
      : `Official CLI removal command completed for "${name}".`,
  };
}

function pathInside(directory: string, candidate: string): boolean {
  const rel = relative(resolve(directory), resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function readPrivateBackup(path: string, backupDir: string): Promise<ExactConfigBackup> {
  await ensurePrivateBackupDir(backupDir);
  const absolutePath = resolve(path);
  if (!pathInside(backupDir, absolutePath) || dirname(absolutePath) !== resolve(backupDir)) throw new Error("Restore accepts only a backup from the configured private client-backup directory.");
  let handle;
  let parsed: Partial<ExactConfigBackup>;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile() || !ownedByCurrentUser(info) || (process.platform !== "win32" && (info.mode & 0o077) !== 0) || info.size > MAX_BACKUP_BYTES) throw new Error("Restore backup must be a bounded, owner-only regular file.");
    const text = await handle.readFile("utf8");
    if (Buffer.byteLength(text) > MAX_BACKUP_BYTES) throw new Error("Restore backup exceeded the size limit.");
    parsed = JSON.parse(text) as Partial<ExactConfigBackup>;
  } catch (error: any) {
    if (error?.message === "Restore backup must be a bounded, owner-only regular file.") throw error;
    throw new Error(`Cannot safely read restore backup (${error?.code || "invalid backup"}).`);
  } finally { await handle?.close(); }
  if (parsed.schema !== 1 || (parsed.client !== "claude-code" && parsed.client !== "codex") || typeof parsed.configPath !== "string" || typeof parsed.action !== "string" || typeof parsed.name !== "string" || !parsed.original || !isExpectedFingerprint(parsed.expectedAfter)) {
    throw new Error("Restore backup format or post-operation fingerprint is invalid.");
  }
  if (parsed.action !== "add" && parsed.action !== "remove") throw new Error("Restore backup action is invalid.");
  if (parsed.original.exists) {
    if (typeof parsed.original.contentBase64 !== "string" || !Number.isInteger(parsed.original.mode) || parsed.original.mode < 0 || parsed.original.mode > 0o777 || parsed.original.contentBase64.length > Math.ceil(MAX_CONFIG_BYTES * 4 / 3) + 8) throw new Error("Restore backup does not contain a valid bounded original config.");
    const bytes = Buffer.from(parsed.original.contentBase64, "base64");
    if (bytes.byteLength > MAX_CONFIG_BYTES || bytes.toString("base64") !== parsed.original.contentBase64) throw new Error("Restore backup original config encoding is invalid or oversized.");
  }
  return parsed as ExactConfigBackup;
}

async function restoreConfigFile(client: LocalMcpClient, homeDir: string, original: ExactConfigBackup["original"]): Promise<void> {
  const path = CLIENTS[client].configPath(homeDir);
  if (!original.exists) { await unlink(path).catch((error: any) => { if (error?.code !== "ENOENT") throw error; }); return; }
  const parent = dirname(path);
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory() || await realpath(parent) !== resolve(parent)) throw new Error("Client config parent directory must be a real, non-symlink directory for restore.");
  const tempPath = `${path}.token2oauth-restore-${randomUUID()}`;
  const bytes = Buffer.from(original.contentBase64, "base64");
  if (bytes.byteLength > MAX_CONFIG_BYTES || bytes.toString("base64") !== original.contentBase64) throw new Error("Restore config payload is invalid or exceeds the size limit.");
  const handle = await open(tempPath, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.chmod(original.mode); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(tempPath, path); }
  catch (error) { await unlink(tempPath).catch(() => {}); throw error; }
}

/** Dry-run by default. Restore exact prior bytes only while the managed config is unchanged since the recorded CLI operation. */
export async function restoreClientConnection(input: { client: LocalMcpClient; backupPath: string; apply?: boolean }, options: ClientConnectionsOptions = {}): Promise<ClientSetupResult> {
  assertClient(input.client);
  const { homeDir, backupDir } = optionsWithDefaults(options);
  const backupPath = resolve(input.backupPath);
  const backup = await readPrivateBackup(backupPath, backupDir);
  if (backup.client !== input.client || backup.configPath !== CLIENTS[input.client].configPath(homeDir)) throw new Error("Restore backup belongs to a different client or home directory.");
  if (backup.restoredAt) throw new Error("This exact config backup has already been restored.");
  const current = stateFingerprint(await exactConfigState(input.client, homeDir));
  if (JSON.stringify(current) !== JSON.stringify(backup.expectedAfter)) throw new Error("Client config changed after this backup was captured; restore refused to preserve later edits.");
  const command = { command: "restoreClientConnection", args: [backupPath] };
  if (!input.apply) return { client: input.client, action: "restore", applied: false, ...command, backupPath, message: "Dry run only. Restore will replace only this client's config with the exact backed-up bytes, and only if its post-operation fingerprint still matches." };
  // Recheck immediately before writing, so edits made after the preview are protected.
  const latest = stateFingerprint(await exactConfigState(input.client, homeDir));
  if (JSON.stringify(latest) !== JSON.stringify(backup.expectedAfter)) throw new Error("Client config changed after the restore preview; no restore was performed.");
  await restoreConfigFile(input.client, homeDir, backup.original);
  backup.restoredAt = new Date().toISOString();
  await writeBackupRecord(backupPath, backup);
  return { client: input.client, action: "restore", applied: true, ...command, backupPath, message: "The exact backed-up client config was restored. Client authentication sessions were not read or restored." };
}

/** Honest product boundary: browser-only setup has no local official CLI command here. */
export function manualClientSetupNotes(): Array<{ client: string; support: "manual" | "unsupported"; note: string }> {
  return [
    { client: "ChatGPT Web", support: "manual", note: "Remote MCP setup is managed in ChatGPT Developer Mode by the user; this local CLI cannot configure the web account." },
    { client: "Claude Desktop", support: "unsupported", note: "This helper targets Claude Code CLI only; no Desktop config writer is provided." },
  ];
}
