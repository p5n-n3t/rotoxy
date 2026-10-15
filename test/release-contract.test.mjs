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
