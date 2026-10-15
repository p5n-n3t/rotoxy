#!/usr/bin/env node
import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const packageName = "rotoxy";
const expectedBins = { rotoxy: "scripts/rotoxy-control.mjs", "rotoxy-cli": "dist/cli.js" };
const maxLogBytes = 256 * 1024;
let scratch;
let child;
let childOutput = "";
let adminPassword = "";

function capture(chunk) {
  childOutput = (childOutput + chunk.toString()).slice(-maxLogBytes);
}

function recordCommandOutput(label, stdout = "", stderr = "") {
  childOutput = `${childOutput}\n[${label}]\n${stdout}\n${stderr}`.slice(-maxLogBytes);
}

function sanitize(text) {
  let safe = String(text)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted-token]")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]");
  if (adminPassword) safe = safe.split(adminPassword).join("[redacted-admin-password]");
  return safe.slice(-maxLogBytes);
}

async function run(file, args, options = {}) {
  try {
    const result = await execFile(file, args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: options.timeout ?? 120_000,
      maxBuffer: maxLogBytes,
      windowsHide: true,
      ...options,
    });
    recordCommandOutput(file.split(/[\\/]/).at(-1), result.stdout, result.stderr);
    return result;
  } catch (error) {
    recordCommandOutput(file.split(/[\\/]/).at(-1), error?.stdout, error?.stderr);
    throw error;
  }
}

function normalizePackJson(parsed) {
  if (Array.isArray(parsed)) return parsed[0];
  if (parsed && typeof parsed === "object") {
    if (typeof parsed.filename === "string") return parsed;
    return Object.values(parsed).find((value) => value && typeof value === "object" && typeof value.filename === "string");
  }
  return undefined;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function reservePort() {
  const net = await import("node:net");
  return new Promise((resolvePort, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") return reject(new Error("could not reserve a loopback port"));
      probe.close((error) => {
        if (error) return reject(error);
        if ([2025, 2030, 2031].includes(address.port)) return resolvePort().then(resolvePort, reject);
        resolvePort(address.port);
      });
    });
  });
}

async function waitForHealth(url, exited) {
  const deadline = Date.now() + 15_000;
  let lastStatus;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`packaged server exited before health check (${child.exitCode ?? child.signalCode})`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000), redirect: "error" });
      lastStatus = response.status;
      if (response.ok) {
        const value = await response.json();
        assert(value?.ok === true, "packaged health response did not report ok=true");
        return;
      }
    } catch (error) {
      if (error instanceof Error && /health response/.test(error.message)) throw error;
    }
    await Promise.race([new Promise((resolveWait) => setTimeout(resolveWait, 200)), exited]);
  }
  throw new Error(`packaged server health check timed out${lastStatus ? ` (last HTTP ${lastStatus})` : ""}`);
}

async function stopOwnedChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 5_000)),
  ]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const python = process.env.PYTHON || "python3";
  const compilerPath = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  try {
    await run(compilerPath, ["--version"], { timeout: 5_000 });
  } catch {
    const error = new Error("PACKAGE_SMOKE_BLOCKED: project npm dependencies are unavailable; install the locked project dependencies, then rerun.");
    error.exitCode = 2;
    throw error;
  }
  await run(python, ["--version"], { timeout: 5_000 });

  scratch = await mkdtemp(join(tmpdir(), "rotoxy-package-smoke-"));
  await chmod(scratch, 0o700);
  const packDir = join(scratch, "pack");
  const installPrefix = join(scratch, "install");
  const homeDir = join(scratch, "home");
  const configDir = join(scratch, "config");
  const npmUserConfig = join(scratch, "empty.npmrc");
  const npmGlobalConfig = join(scratch, "empty-global.npmrc");
  const npmCache = join(scratch, "npm-cache");
  await Promise.all([mkdir(packDir, { mode: 0o700 }), mkdir(installPrefix, { mode: 0o700 }), mkdir(homeDir, { mode: 0o700 }), mkdir(configDir, { mode: 0o700 }), mkdir(npmCache, { mode: 0o700 }), writeFile(npmUserConfig, "", { mode: 0o600 }), writeFile(npmGlobalConfig, "", { mode: 0o600 })]);
  assert(packageJson.name === packageName, "package identity is not rotoxy");
  assert(JSON.stringify(packageJson.bin) === JSON.stringify(expectedBins), "package bin map does not match the canonical ROTOXY entrypoints");
  const isolatedEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: homeDir,
    TMPDIR: scratch,
    TOKEN2OAUTH_CONFIG_DIR: configDir,
    ROTOXY_PREFIX: "",
    NPM_CONFIG_USERCONFIG: npmUserConfig,
    NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig,
    NPM_CONFIG_CACHE: npmCache,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };

  // npm >=12 may emit a single object; older versions emit a one-element array.
  const packed = await run(npm, ["pack", "--json", "--pack-destination", packDir], { timeout: 120_000, env: isolatedEnv });
  const metadata = normalizePackJson(JSON.parse(packed.stdout));
  assert(metadata && typeof metadata.filename === "string" && Array.isArray(metadata.files), "npm pack returned an unsupported JSON shape");
  assert(metadata.name === packageName && metadata.version === packageJson.version, "packed artifact identity differs from package.json");
  const tarball = join(packDir, metadata.filename);
  const packFiles = new Set(metadata.files.map((file) => file.path));
  const archiveText = (await run("tar", ["-tzf", tarball], { timeout: 10_000 })).stdout;
  const archiveFiles = new Set(archiveText.split(/\r?\n/).filter(Boolean).map((path) => path.replace(/^package\//, "")));
  for (const required of [
    "dist/cli.js", "dist/store.js", "supervisor/snooze/bridge.py", "supervisor/snooze/jobs.py",
    "supervisor/snooze/static/index.html", "supervisor/snooze/static/THIRD_PARTY_NOTICES.md",
    "supervisor/snooze/static/THIRD_PARTY_LICENSES-svelte.txt",
    "supervisor/snooze/static/THIRD_PARTY_LICENSES-kit-ui.txt",
    "supervisor/snooze/static/THIRD_PARTY_LICENSES-lucide.txt",
    "supervisor/snooze/static/THIRD_PARTY_LICENSES-agentsview.txt",
    "supervisor/snooze/static/assets/ui/OFL-fonts.txt", "supervisor/LICENSE", "LICENSE",
  ]) {
    assert(packFiles.has(required), `npm pack inventory is missing ${required}`);
    assert(archiveFiles.has(required), `actual tarball is missing ${required}`);
  }
  for (const target of Object.values(expectedBins)) assert(archiveFiles.has(target), `actual tarball is missing declared bin target ${target}`);
  assert([...packFiles].some((path) => /^supervisor\/snooze\/static\/assets\/ui\/.*\.js$/.test(path)), "packaged UI JavaScript is missing");
  assert([...packFiles].some((path) => /^supervisor\/snooze\/static\/assets\/ui\/.*\.css$/.test(path)), "packaged UI stylesheet is missing");
  assert([...packFiles].some((path) => /^supervisor\/snooze\/static\/assets\/ui\/.*\.woff2$/.test(path)), "packaged UI fonts are missing");
  for (const path of packFiles) {
    assert(!/(^|\/)node_modules\//.test(path), `node_modules leaked into package: ${path}`);
    assert(!/(^|\/)frontend\//.test(path), `frontend development tree leaked into package: ${path}`);
    assert(!/(?:__pycache__|\.py[co]$|\.env(?:$|\.)|supervisor-config|(^|\/)\.git(?:\/|$))/i.test(path), `cache or private material leaked into package: ${path}`);
  }
  assert(metadata.files.every((file) => archiveFiles.has(file.path)), "tarball contents do not match npm pack inventory");

  await run(npm, ["install", tarball, "--ignore-scripts", "--prefix", installPrefix, "--no-audit", "--no-fund"], { timeout: 120_000, env: isolatedEnv });
  const installed = join(installPrefix, "node_modules", packageName);
  const cliSuffix = process.platform === "win32" ? ".cmd" : "";
  process.env.HOME = homeDir;
  process.env.TOKEN2OAUTH_CONFIG_DIR = configDir;
  process.env.ROTOXY_PREFIX = installed;
  const installedEnv = { ...isolatedEnv, ROTOXY_PREFIX: installed };
  const wrapperHelp = await run(join(installPrefix, "node_modules", ".bin", `rotoxy${cliSuffix}`), ["--help"], { cwd: scratch, timeout: 10_000, env: installedEnv });
  assert(/Usage: rotoxy/i.test(wrapperHelp.stdout), "installed rotoxy wrapper did not forward to the canonical CLI");
  const cliHelp = await run(join(installPrefix, "node_modules", ".bin", `rotoxy-cli${cliSuffix}`), ["--help"], { cwd: scratch, timeout: 10_000, env: installedEnv });
  assert(/Usage: rotoxy/i.test(cliHelp.stdout), "installed rotoxy-cli --help did not show canonical CLI usage");
  const installPlan = await run(join(installPrefix, "node_modules", ".bin", `rotoxy${cliSuffix}`), ["install-plan"], { cwd: scratch, timeout: 10_000, env: installedEnv });
  const plan = JSON.parse(installPlan.stdout);
  assert(plan.mode === "manual; no unit is enabled at boot", "install plan must remain explicit/manual with boot disabled");
  assert(!installPlan.stdout.includes("systemctl --user enable"), "install plan unexpectedly enables a user service");
  const supervisorDir = join(installed, "supervisor");
  await run(python, ["-m", "snooze.bridge", "--help"], {
    cwd: supervisorDir,
    env: { ...installedEnv, PYTHONPATH: supervisorDir, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" },
    timeout: 10_000,
  });

  const { StateStore } = await import(pathToFileURL(join(installed, "dist", "store.js")).href);
  const stateStore = new StateStore();
  adminPassword = randomBytes(32).toString("base64url");
  await stateStore.init({ adminPassword });
  adminPassword = "";

  const port = await reservePort();
  const serverEnv = { ...installedEnv, TOKEN2OAUTH_HOST: "127.0.0.1", TOKEN2OAUTH_PORT: String(port), PYTHONDONTWRITEBYTECODE: "1" };
  child = spawn(process.execPath, [join(installed, "dist", "cli.js"), "serve", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: scratch,
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const childExited = new Promise((resolveExit) => child.once("exit", resolveExit));
  await waitForHealth(`http://127.0.0.1:${port}/healthz`, childExited);
  await stopOwnedChild();
  child = undefined;

  const tarStat = await import("node:fs/promises").then(({ stat }) => stat(tarball));
  console.log(JSON.stringify({
    ok: true,
    package: `${packageJson.name}@${packageJson.version}`,
    archiveBytes: tarStat.size,
    files: archiveFiles.size,
    checks: ["canonical rotoxy package and both installed bins", "built CLI, static UI, and checked licenses included", "no caches, node_modules, or private config", "manual install plan leaves boot disabled", "installed Python bridge help", "isolated fresh state initialization", "explicit loopback /healthz", "owned server child stopped with SIGTERM"],
  }, null, 2));
} catch (error) {
  await stopOwnedChild().catch(() => undefined);
  const message = sanitize(error?.stack || error?.message || error);
  if (scratch) {
    await writeFile(join(scratch, "failure.log"), sanitize(`${message}\n\n${childOutput}`), { mode: 0o600 }).catch(() => undefined);
    console.error(`Package smoke failed. Sanitized log retained at ${join(scratch, "failure.log")}`);
  }
  console.error(message);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
} finally {
  if (child) await stopOwnedChild().catch(() => undefined);
  if (scratch && process.exitCode === undefined) await rm(scratch, { recursive: true, force: true });
}
