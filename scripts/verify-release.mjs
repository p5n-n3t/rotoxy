#!/usr/bin/env node
/** Offline package audit. Builds and packs a temporary copy; never starts the service. */
import { execFile as execFileCallback } from "node:child_process";
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const expectedBins = { rotoxy: "scripts/rotoxy-control.mjs", "rotoxy-cli": "dist/cli.js" };
const requiredPackageFiles = [
  "skills/rotoxy-orchestrate/SKILL.md",
  "skills/rotoxy-orchestrate/references/scenarios.md",
  "dist/agent-onboarding.js",
  "dist/fleet-identity.js",
  "dist/lightsprint-session-bindings.js",
  "dist/cli.js",
  "dist/store.js",
  "dist/oracle-tools.js",
  "assets/brand/logo.svg",
  "assets/brand/favicon.svg",
  "dist/jsonrpc-wire.js",
  "scripts/monitor-workforce.mjs",
  "scripts/desktop-alarm-hook.mjs",
  "scripts/verify-recovery-continuity.py",
  "supervisor/snooze/headless.py",
  "scripts/rotoxy-control.mjs", "install-rotoxy.sh", "packaging/rotoxy.target", "packaging/rotoxy-funnel.service",
  "supervisor/snooze/bridge.py",
  "supervisor/snooze/jobs.py",
  "supervisor/snooze/job_inbox.py",
  "supervisor/snooze/monitor.py",
  "supervisor/snooze/guidance.py",
  "supervisor/snooze/oracle_pool.py",
  "supervisor/snooze/credit_ledger.py",
  "supervisor/snooze/credit_admission.py",
  "supervisor/snooze/recovery.py",
  "supervisor/snooze/recovery_service.py",
  "dist/analytics.js",
  "dist/web-tools.js",
  "supervisor/snooze/adapters/lightsprint.py",
  "supervisor/snooze/adapters/registered.py",
  "supervisor/snooze/static/index.html",
  "supervisor/snooze/static/THIRD_PARTY_NOTICES.md",
  "supervisor/THIRD_PARTY_NOTICES.md",
  "supervisor/LICENSE",
  "LICENSE",
];
const pythonImports = [
  "snooze.bridge",
  "snooze.jobs",
  "snooze.job_inbox",
  "snooze.monitor",
  "snooze.guidance",
  "snooze.oracle_pool",
  "snooze.oracle_fleet_config",
  "snooze.agent_workspace",
  "snooze.workspace_execution",
  "snooze.claude_workspace_worker",
  "snooze.credit_ledger",
  "snooze.credit_admission",
  "snooze.controlled_batches",
  "snooze.controlled_batch_admin",
  "snooze.private_services",
  "snooze.runner_registry",
  "snooze.oracle_model_admin",
  "snooze.recovery",
  "snooze.recovery_service",
  "snooze.headless",
  "snooze.adapters.lightsprint",
  "snooze.adapters.registered",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run(file, args, { cwd, env, label, timeout = 120_000 } = {}) {
  try {
    return await execFile(file, args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label ?? file} is required but was not found on PATH`);
    if (error?.killed) throw new Error(`${label ?? file} timed out`);
    throw new Error(`${label ?? file} failed${Number.isInteger(error?.code) ? ` with exit ${error.code}` : ""}${label === "temporary TypeScript build" ? `: ${String(error.stdout ?? "").slice(0, 4000)}` : ""}`);
  }
}

async function listFiles(root) {
  const { readdir } = await import("node:fs/promises");
  const output = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  await visit(root);
  return output;
}

function safeRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}

function parsePackJson(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("npm pack did not return JSON metadata"); }
  const rows = Array.isArray(parsed) ? parsed : [parsed, ...Object.values(parsed ?? {})];
  return rows.find((row) => row && typeof row.filename === "string" && Array.isArray(row.files));
}

let scratch;
try {
  assert(Number(process.versions.node.split(".")[0]) >= 22, "Node.js 22 or newer is required");
  assert(packageJson.name === "rotoxy", "unexpected package name");
  assert(JSON.stringify(packageJson.bin) === JSON.stringify(expectedBins), "package bin map does not match the canonical ROTOXY entrypoints");
  assert(packageJson.files?.includes("scripts/monitor-workforce.mjs"), "package files allowlist omits scripts/monitor-workforce.mjs");
  assert(packageJson.files?.includes("scripts/desktop-alarm-hook.mjs"), "package files allowlist omits scripts/desktop-alarm-hook.mjs");

  const compiler = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  try { await access(compiler); } catch {
    throw new Error("TypeScript is not installed in this checkout; provide the lockfile-pinned dev dependencies first. This verifier never installs dependencies.");
  }

  scratch = await mkdtemp(join(tmpdir(), "rotoxy-release-"));
  await chmod(scratch, 0o700);
  const home = join(scratch, "home");
  const stage = join(scratch, "package-source");
  const packDir = join(scratch, "pack");
  const extractDir = join(scratch, "extract");
  const npmConfig = join(scratch, "empty.npmrc");
  const npmGlobalConfig = join(scratch, "empty-global.npmrc");
  await Promise.all([
    mkdir(home, { mode: 0o700 }),
    mkdir(stage, { mode: 0o700 }),
    mkdir(packDir, { mode: 0o700 }),
    mkdir(extractDir, { mode: 0o700 }),
    writeFile(npmConfig, "", { mode: 0o600 }),
    writeFile(npmGlobalConfig, "", { mode: 0o600 }),
  ]);

  // Stage only the public package inputs and TypeScript build inputs. Never copy .git,
  // node_modules, private configs, or generated output from the working checkout.
  const stagePaths = [
    "package.json", "tsconfig.json", "src", "docs", "skills", "assets/brand", "supervisor/snooze",
    "supervisor/LICENSE", "supervisor/THIRD_PARTY_NOTICES.md", "supervisor/SECURITY.md",
    "supervisor/UPSTREAM.md", "supervisor/install.sh", "scripts/monitor-workforce.mjs", "scripts/desktop-alarm-hook.mjs", "scripts/verify-recovery-continuity.py",
    "scripts/rotoxy-control.mjs", "packaging/rotoxy.target", "packaging/rotoxy-funnel.service", "install-rotoxy.sh",
    "install.sh", "uninstall.sh", "LICENSE", "README.md", "SECURITY.md", "CHANGELOG.md",
  ];
  for (const item of stagePaths) {
    const destination = join(stage, item);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await cp(join(repoRoot, item), destination, { recursive: true, force: false, errorOnExist: true });
  }
  await symlink(join(repoRoot, "node_modules"), join(stage, "node_modules"), process.platform === "win32" ? "junction" : "dir");

  const commandEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: scratch,
    NPM_CONFIG_USERCONFIG: npmConfig,
    NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig,
    NPM_CONFIG_CACHE: join(scratch, "npm-cache"),
    npm_config_offline: "true",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  await run("npm", ["run", "build"], { cwd: stage, env: commandEnv, label: "temporary TypeScript build", timeout: 180_000 });

  const packed = await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir], {
    cwd: stage, env: commandEnv, label: "local npm pack", timeout: 120_000,
  });
  const metadata = parsePackJson(packed.stdout);
  assert(metadata, "npm pack returned an unsupported metadata shape");
  assert(metadata.name === "rotoxy" && metadata.version === packageJson.version, "packed metadata does not match canonical package identity");
  const inventory = new Set(metadata.files.map((file) => file.path));
  const tarball = join(packDir, metadata.filename);
  const listing = await run("tar", ["-tzf", tarball], { cwd: scratch, env: commandEnv, label: "tar listing", timeout: 10_000 });
  const archive = new Set(listing.stdout.split(/\r?\n/).filter((path) => path && !path.endsWith("/")).map((path) => path.replace(/^package\//, "")));

  for (const path of requiredPackageFiles) {
    assert(inventory.has(path), `npm inventory is missing ${path}`);
    assert(archive.has(path), `actual tarball is missing ${path}`);
  }
  for (const path of Object.values(expectedBins)) {
    assert(inventory.has(path), `npm inventory is missing declared bin target ${path}`);
    assert(archive.has(path), `actual tarball is missing declared bin target ${path}`);
  }
  const builtFiles = (await listFiles(join(stage, "dist"))).map((path) => safeRelative(stage, path));
  assert(builtFiles.length > 0, "temporary build produced no dist files");
  for (const path of builtFiles) {
    assert(inventory.has(path), `npm inventory is missing built output ${path}`);
    assert(archive.has(path), `actual tarball is missing built output ${path}`);
  }
  const pythonSources = (await listFiles(join(stage, "supervisor", "snooze")))
    .filter((path) => path.endsWith(".py"))
    .map((path) => safeRelative(stage, path));
  for (const path of pythonSources) assert(archive.has(path), `actual tarball is missing Python module ${path}`);
  assert([...archive].every((path) => inventory.has(path)), "tarball contains paths absent from npm inventory");
  assert([...inventory].every((path) => archive.has(path)), "npm inventory lists files absent from the tarball");

  const forbidden = /(^|\/)(?:node_modules|frontend|__pycache__|\.git|\.venv)(?:\/|$)|(^|\/)\.env(?:$|\.)|supervisor-config|private-config/i;
  for (const path of archive) assert(!forbidden.test(path), `private or development material is packaged: ${path}`);
  assert([...archive].some((path) => /^supervisor\/snooze\/static\/assets\/ui\/.*\.js$/.test(path)), "built dashboard JavaScript is missing");
  assert([...archive].some((path) => /^supervisor\/snooze\/static\/assets\/ui\/.*\.css$/.test(path)), "built dashboard CSS is missing");

  await run("tar", ["-xzf", tarball, "-C", extractDir], { cwd: scratch, env: commandEnv, label: "tar extraction", timeout: 20_000 });
  const installedRoot = join(extractDir, "package");
  const installedSupervisor = join(installedRoot, "supervisor");
  const python = "python3";
  const pythonEnv = {
    PATH: commandEnv.PATH,
    HOME: home,
    TMPDIR: scratch,
    PYTHONPATH: installedSupervisor,
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
  const version = await run(python, ["--version"], { cwd: installedSupervisor, env: pythonEnv, label: "Python 3.11+", timeout: 5_000 });
  const versionText = `${version.stdout}${version.stderr}`;
  const match = versionText.match(/Python\s+(\d+)\.(\d+)/);
  assert(match && (Number(match[1]) > 3 || Number(match[1]) === 3 && Number(match[2]) >= 11), "Python 3.11 or newer is required");
  const importCode = `import importlib; modules=${JSON.stringify(pythonImports)}; [importlib.import_module(name) for name in modules]; print(len(modules))`;
  const imported = await run(python, ["-c", importCode], { cwd: installedSupervisor, env: pythonEnv, label: "packaged Python imports", timeout: 60_000 });
  assert(imported.stdout.trim() === String(pythonImports.length), "not all packaged supervisor modules imported");

  const { stat } = await import("node:fs/promises");
  const archiveStat = await stat(tarball);
  console.log(JSON.stringify({
    ok: true,
    mode: "offline package audit; no provider or private-config access",
    package: `${packageJson.name}@${packageJson.version}`,
    archiveBytes: archiveStat.size,
    archiveFiles: archive.size,
    pythonModulesIncluded: pythonSources.length,
    pythonModulesImported: pythonImports.length,
    checks: ["temporary TypeScript build", "all built dist files are in actual tarball", "monitor script and compiled dependencies are packaged", "all Snooze Python modules included", "Oracle/guidance/credit imports", "dashboard assets and license notices", "no node_modules/frontend/private config", "tarball matches npm pack inventory"],
  }, null, 2));
} catch (error) {
  console.error(`release verification failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
} finally {
  if (scratch) await rm(scratch, { recursive: true, force: true });
}
