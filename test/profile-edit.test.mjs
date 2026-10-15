import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { chmod, mkdtemp, open, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFile = promisify(execFileCb);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("profile and Ollama metadata edits preserve auth, ownership, secrets, and unrelated records across processes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "t2o-profile-edit-"));
  const oldHome = process.env.HOME;
  const oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home");
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(process.env.HOME, { mode: 0o700, recursive: true }));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig;
  });

  const [{ StateStore }, { CodexProfiles, renderCodexProfilesPage }, { ModelCredentialStore }] = await Promise.all([
    import("../dist/store.js"), import("../dist/codex-profiles.js"), import("../dist/model-credentials.js"),
  ]);
  const store = new StateStore();
  await store.init({ adminPassword: "synthetic-profile-test-password" });
  const upstream = await store.addAccount({ label: "Unrelated upstream", token: "synthetic-upstream-token-0001" });
  const stateAccountsBefore = (await store.load()).accounts;
  const codexBinary = join(root, "codex");
  await writeFile(codexBinary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(codexBinary, 0o700);
  const profiles = new CodexProfiles({ codexBinary, configDir: store.dir });
  t.after(() => profiles.close());
  const one = await profiles.registerProfile("Team One");
  const two = await profiles.registerProfile("Team Two");
  const authFixture = "synthetic-existing-auth-file-preserve-exactly";
  await writeFile(join(one.profileDir, "auth.json"), authFixture, { mode: 0o600 });
  const removableAuthFixture = "synthetic-auth-retained-after-profile-removal";
  await writeFile(join(two.profileDir, "auth.json"), removableAuthFixture, { mode: 0o600 });
  await profiles.bindThread("thread-synthetic-123", one.id);

  // Hold the exact interprocess lock shared with StateStore, then race edits
  // from this process and a separate Node process against independent rows.
  const lock = await open(store.lockPath, "wx", 0o600);
  let parentDone = false;
  const parentEdit = profiles.renameProfile(one.id, "Team One Renamed").finally(() => { parentDone = true; });
  const codexModule = new URL("../dist/codex-profiles.js", import.meta.url).href;
  const childCode = `import { CodexProfiles } from ${JSON.stringify(codexModule)}; const p = new CodexProfiles({codexBinary:${JSON.stringify(codexBinary)},configDir:${JSON.stringify(store.dir)}}); await p.renameProfile(${JSON.stringify(two.id)}, "Team Two Renamed"); await p.close();`;
  const childEdit = execFile(process.execPath, ["--input-type=module", "-e", childCode], {
    env: { ...process.env, HOME: process.env.HOME, TOKEN2OAUTH_CONFIG_DIR: store.dir }, timeout: 10_000,
  });
  await pause(120);
  assert.equal(parentDone, false, "profile mutation waits for the cross-process state lock");
  await lock.close();
  await unlink(store.lockPath);
  await Promise.all([parentEdit, childEdit]);

  const listedProfiles = await profiles.listProfiles();
  const editedOne = listedProfiles.find((p) => p.id === one.id);
  const editedTwo = listedProfiles.find((p) => p.id === two.id);
  assert.equal(editedOne.label, "Team One Renamed");
  assert.equal(editedTwo.label, "Team Two Renamed");
  assert.equal(editedOne.profileDir, one.profileDir);
  assert.equal(editedOne.createdAt, one.createdAt);
  assert.equal(await readFile(join(one.profileDir, "auth.json"), "utf8"), authFixture);
  assert.equal(await profiles.profileForThread("thread-synthetic-123"), one.id);
  await assert.rejects(profiles.renameProfile(one.id, "Team Two Renamed"), /label already exists/);
  await assert.rejects(profiles.renameProfile(one.id, "\n"), /profile label/);
  await assert.rejects(profiles.updateProfile(one.id, { label: "Changed", profileDir: "/tmp/unsafe" }), /update is invalid/);
  assert.equal(JSON.stringify(listedProfiles).includes(authFixture), false);
  const page = renderCodexProfilesPage(listedProfiles, [], "/gateway");
  assert.match(page, /action="\/gateway\/admin\/codex\/action"/);
  assert.match(page, /name="action" value="rename"/);
  assert.match(page, /name="action" value="remove"/);
  assert.match(page, /value="Team One Renamed"/);
  await assert.rejects(profiles.removeProfile(one.id), /owns Codex threads/);
  assert.equal((await profiles.listProfiles()).length, 2, "owned thread prevents deletion");
  await profiles.removeProfile(two.id);
  assert.deepEqual((await profiles.listProfiles()).map((profile) => profile.id), [one.id]);
  assert.equal(await readFile(join(two.profileDir, "auth.json"), "utf8"), removableAuthFixture, "removal preserves private auth directory");
  const codexRegistry = JSON.parse(await readFile(join(store.dir, "codex-profiles.json"), "utf8"));
  assert.equal(codexRegistry.audit.at(-1).action, "profile_removed");
  assert.equal(codexRegistry.audit.at(-1).profileId, two.id);
  assert.equal(Number.isSafeInteger(codexRegistry.audit.at(-1).at), true);
  assert.equal(JSON.stringify(codexRegistry.audit).includes(removableAuthFixture), false);

  const credentialStoreA = new ModelCredentialStore(store);
  const storeB = new StateStore();
  await storeB.init();
  const credentialStoreB = new ModelCredentialStore(storeB);
  const credentialA = await credentialStoreA.addCredential("Ollama One", "synthetic-ollama-secret-0001");
  const credentialB = await credentialStoreA.addCredential("Ollama Two", "synthetic-ollama-secret-0002");
  const independentToken = await credentialStoreA.issueToken({ scopes: ["model:read"], expiresInSeconds: 3600 });
  const [editedA] = await Promise.all([
    credentialStoreA.updateCredential(credentialA.id, { label: "Ollama One Renamed", enabled: false }),
    credentialStoreB.updateCredential(credentialB.id, { label: "Ollama Two Renamed" }),
  ]);
  assert.equal(editedA.id, credentialA.id);
  assert.equal(editedA.enabled, false);
  assert.equal((await credentialStoreA.credentialForRequest(credentialA.id)).apiKey, "synthetic-ollama-secret-0001");
  assert.equal((await credentialStoreA.credentialForRequest(credentialB.id)).apiKey, "synthetic-ollama-secret-0002");
  assert.deepEqual((await credentialStoreA.listCredentials()).map(({ id, label }) => ({ id, label })).sort((a, b) => a.id.localeCompare(b.id)), [
    { id: credentialA.id, label: "Ollama One Renamed" }, { id: credentialB.id, label: "Ollama Two Renamed" },
  ].sort((a, b) => a.id.localeCompare(b.id)));
  await assert.rejects(credentialStoreA.updateCredential(credentialA.id, { label: "Ollama Two Renamed" }), /label already exists/);
  await assert.rejects(credentialStoreA.updateCredential(credentialA.id, { label: "\n" }), /update is invalid/);
  await assert.rejects(credentialStoreA.updateCredential(credentialA.id, { apiKey: "not-an-editable-field" }), /update is invalid/);
  const encrypted = await readFile(join(store.dir, "model-credentials.json"), "utf8");
  assert.equal(encrypted.includes("synthetic-ollama-secret-0001"), false);
  assert.equal(encrypted.includes("synthetic-ollama-secret-0002"), false);
  assert.deepEqual((await store.load()).accounts, stateAccountsBefore);
  assert.equal(upstream.id, stateAccountsBefore[0].id);
  await credentialStoreA.removeCredential(credentialA.id);
  assert.deepEqual((await credentialStoreA.listCredentials()).map((account) => account.id), [credentialB.id]);
  assert.equal(await credentialStoreA.credentialForRequest(credentialA.id), undefined);
  assert.equal((await credentialStoreA.credentialForRequest(credentialB.id)).apiKey, "synthetic-ollama-secret-0002");
  assert.deepEqual((await credentialStoreA.listTokens()).map((token) => token.id), [independentToken.id]);
  const afterRemoval = JSON.parse(await readFile(join(store.dir, "model-credentials.json"), "utf8"));
  assert.equal(afterRemoval.audit.at(-1).action, "credential_removed");
  assert.equal(afterRemoval.audit.at(-1).credentialId, credentialA.id);
  assert.equal(Number.isSafeInteger(afterRemoval.audit.at(-1).at), true);
  assert.doesNotMatch(JSON.stringify(afterRemoval.audit), /synthetic-ollama-secret/);
  await assert.rejects(credentialStoreA.removeCredential(credentialA.id), /not found/);
});

test("Codex removal blocks pending login and in-flight work, then leaves auth data and records an audit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "t2o-profile-remove-"));
  const oldHome = process.env.HOME;
  const oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home");
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(process.env.HOME, { mode: 0o700, recursive: true });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig;
  });
  const [{ StateStore }, { CodexProfiles }] = await Promise.all([import("../dist/store.js"), import("../dist/codex-profiles.js")]);
  const store = new StateStore();
  await store.init({ adminPassword: "synthetic-profile-remove-password" });
  const binary = join(root, "codex");
  await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); await chmod(binary, 0o700);
  let releaseRead;
  let readStarted;
  let holdRead = false;
  const transports = [];
  const profiles = new CodexProfiles({ codexBinary: binary, configDir: store.dir, transportFactory: (_binary, profileDir) => {
    const transport = {
    async request(method) {
      if (method === "account/login/start") return { loginId: "synthetic-login-id", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" };
      if (method === "account/login/cancel") return {};
      if (method === "account/read" && holdRead) {
        readStarted();
        await new Promise((resolve) => { releaseRead = resolve; });
      }
      if (method === "account/read") return { account: { type: "chatgpt" } };
      if (method === "model/list") return { data: [] };
      if (method === "account/rateLimits/read") return { rateLimits: {} };
      return {};
    },
    notify() {}, onNotification() { return () => {}; }, async close() { this.closed = true; },
    };
    transports.push({ profileId: profileDir.split(/[\\/]/).at(-1), transport });
    return transport;
  } });
  t.after(() => profiles.close());
  const pending = await profiles.registerProfile("Pending login");
  await profiles.startDeviceLogin(pending.id);
  await assert.rejects(profiles.removeProfile(pending.id), /pending device login/);
  assert.equal((await profiles.listProfiles()).some((profile) => profile.id === pending.id), true);
  await profiles.cancelDeviceLogin(pending.id);

  const active = await profiles.registerProfile("Busy profile");
  const auth = "synthetic-active-auth";
  await writeFile(join(active.profileDir, "auth.json"), auth, { mode: 0o600 });
  holdRead = true;
  const started = new Promise((resolve) => { readStarted = resolve; });
  const refreshing = profiles.refreshProfile(active.id);
  await started;
  await assert.rejects(profiles.removeProfile(active.id), /in-flight operation/);
  releaseRead();
  await refreshing;
  holdRead = false;
  await profiles.removeProfile(active.id);
  assert.equal(await readFile(join(active.profileDir, "auth.json"), "utf8"), auth);
  assert.equal(transports.find((entry) => entry.profileId === active.id)?.transport.closed, true);
  assert.equal((await profiles.listProfiles()).some((profile) => profile.id === active.id), false);
  const registry = JSON.parse(await readFile(join(store.dir, "codex-profiles.json"), "utf8"));
  assert.equal(registry.audit.some((event) => event.profileId === active.id && event.action === "profile_removed"), true);
});
