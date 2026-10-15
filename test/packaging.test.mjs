import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

// Exercise npm's own packlist while suppressing lifecycle scripts in this test.
// `prepack` builds dist during a normal publish; release smoke checks cover the
// extracted Python runtime without installing or executing package scripts.
test("npm pack includes the embedded Snooze runtime and excludes development payloads", () => {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { encoding: "utf8" });
  const parsed = JSON.parse(raw);
  const archive = Array.isArray(parsed) ? parsed[0] : parsed.rotoxy;
  assert.ok(archive && Array.isArray(archive.files), "npm returned no package file inventory");
  const files = new Set(archive.files.map((file) => file.path));
  for (const required of [
    "supervisor/snooze/bridge.py",
    "supervisor/snooze/jobs.py",
    "supervisor/snooze/static/index.html",
    "supervisor/snooze/static/assets/ui/index-BKgd6QmV.js",
    "supervisor/snooze/static/assets/ui/index-BP2EsJEh.css",
    "supervisor/LICENSE",
    "supervisor/THIRD_PARTY_NOTICES.md",
    "supervisor/UPSTREAM.md",
    "supervisor/snooze/static/THIRD_PARTY_NOTICES.md",
  ]) assert.ok(files.has(required), `package is missing ${required}`);

  for (const path of files) {
    assert.doesNotMatch(path, /(^|\/)frontend\//, `frontend development tree leaked into package: ${path}`);
    assert.doesNotMatch(path, /(^|\/)node_modules\//, `node_modules leaked into package: ${path}`);
    assert.doesNotMatch(path, /(__pycache__|\.py[co]$|\.env($|\.)|supervisor-config)/i, `cache or private config leaked into package: ${path}`);
  }
});
