import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("release CLI keeps supervisor and Oracle integrations explicit opt-ins", () => {
  const help = execFileSync(process.execPath, [new URL("dist/cli.js", root).pathname, "serve", "--help"], { encoding: "utf8" });
  assert.match(help, /--oracle-pool/);
  assert.match(help, /--supervisor-config <path>/);
  assert.match(help, /--host <host>/);
});

test("published tarball includes install, runtime, and rollback guidance", async () => {
  const [manifest, packed] = await Promise.all([
    readFile(new URL("package.json", root), "utf8").then(JSON.parse),
    Promise.resolve(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { encoding: "utf8" })).then(JSON.parse),
  ]);
  const metadata = (Array.isArray(packed) ? packed : [packed, ...Object.values(packed ?? {})])
    .find((row) => row && Array.isArray(row.files));
  assert.ok(metadata, "npm pack must provide a file inventory");
  assert.equal(manifest.name, "rotoxy");
  assert.equal(manifest.bin["rotoxy-cli"], "dist/cli.js");
  assert.equal(manifest.bin.rotoxy, "scripts/rotoxy-control.mjs");
  const files = new Set(metadata.files.map((file) => file.path));
  for (const required of [
    "install.sh", "install-rotoxy.sh", "scripts/rotoxy-control.mjs", "packaging/rotoxy.target", "packaging/rotoxy-funnel.service", "uninstall.sh", "supervisor/install.sh",
    "docs/deployment/unified-supervisor.md", "docs/RELEASE-VERIFICATION.md", "dist/worker-observation.js",
    "supervisor/snooze/static/index.html",
  ]) assert.ok(files.has(required), `release tarball omits ${required}`);
  assert.ok(![...files].some((path) => /(^|\/)frontend\//.test(path)), "frontend development sources must stay out of the public package");
});

test("release verifiers use canonical ROTOXY bins and keep the boot smoke manual", async () => {
  const [audit, install] = await Promise.all([
    readFile(new URL("scripts/verify-release.mjs", root), "utf8"),
    readFile(new URL("scripts/verify-package-install.mjs", root), "utf8"),
  ]);
  assert.match(audit, /packageJson\.name === "rotoxy"/);
  assert.match(audit, /"rotoxy-cli": "dist\/cli\.js"/);
  assert.match(install, /const packageName = "rotoxy"/);
  assert.match(install, /node_modules.*rotoxy\$\{cliSuffix\}/);
  assert.match(install, /node_modules.*rotoxy-cli\$\{cliSuffix\}/);
  assert.match(install, /manual; no unit is enabled at boot/);
  assert.match(install, /TOKEN2OAUTH_HOST: "127\.0\.0\.1"/);
  assert.doesNotMatch(install, /token2oauth-package-smoke|token2oauth --help/i);
});
