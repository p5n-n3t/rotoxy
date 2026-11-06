import type { StateStore } from "./store.js";
import type { CodexProfiles } from "./codex-profiles.js";
import { CodexPoolPolicyStore } from "./codex-pool-policy.js";
import { OriginProtectionStore } from "./origin-protection.js";
import { esc } from "./html.js";

export async function renderCodexWorkerControls(store: StateStore, profiles: CodexProfiles, base: string): Promise<string> {
  const [policy, registry, state, origins, bindings] = await Promise.all([
    new CodexPoolPolicyStore(store).read(), profiles.listProfiles(), store.load(), new OriginProtectionStore(store).snapshot(), new OriginProtectionStore(store).listAdmin(),
  ]);
  const profileOptions = registry.map(profile => `<option value="${esc(profile.id)}">${esc(profile.label)}</option>`).join("");
  const clients = state.oauthClients.map(client => `<option value="${esc(client.clientId)}">${esc(client.clientName || client.clientId)}</option>`).join("");
  return `<section class="card full"><h2>Codex workers</h2><p>Dispatch is ${policy.dispatchEnabled ? "enabled" : "paused"}. Each profile runs one read-only worker at a time. Five-hour and weekly limits stay separate.</p>
<form method="post" action="${esc(base)}/admin/codex/worker"><input type="hidden" name="action" value="pool"><label>New dispatch<select name="enabled"><option value="0" ${!policy.dispatchEnabled ? "selected" : ""}>Paused</option><option value="1" ${policy.dispatchEnabled ? "selected" : ""}>Enabled</option></select></label>${policy.profiles.map(rule => `<label><input type="checkbox" name="profile" value="${esc(rule.profileId)}" ${rule.enabled ? "checked" : ""}>${esc(registry.find(profile => profile.id === rule.profileId)?.label || rule.profileId)}</label>`).join("")}<button>Save worker pool</button></form>
${bindings.filter(binding => !binding.closed).map(binding => `<p>${esc(registry.find(profile => profile.id === binding.nativeProfileId)?.label || binding.nativeProfileId)} · lease until ${esc(new Date(binding.expiresAt).toLocaleString("en-GB", {timeZone: "UTC"}))} UTC · <code>${esc(binding.bindingId)}</code></p>`).join("")}<details><summary>Protect this session’s native account</summary><p>Choose the account currently running your client. Use the session name in Codex job submissions as originSessionId. Bindings last twelve hours. Rebind after switching native accounts.</p>
<form method="post" action="${esc(base)}/admin/codex/worker"><input type="hidden" name="action" value="bind"><input type="hidden" name="revision" value="${origins.revision}"><label>Connected client<select name="clientId">${clients}</select></label><label>Session name<input name="sessionId" required maxlength="128" pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,127}" placeholder="desktop-project-session"></label><label>Native account<select name="profileId">${profileOptions}</select></label><button>Protect account for this session</button></form>
<form method="post" action="${esc(base)}/admin/codex/worker"><input type="hidden" name="action" value="close"><input type="hidden" name="revision" value="${origins.revision}"><label>Client<select name="clientId">${clients}</select></label><label>Session name<input name="sessionId" required maxlength="128"></label><label>Binding ID<input name="bindingId" required maxlength="64"></label><button>Close session binding</button></form></details></section>`;
}

export async function updateCodexWorkerControls(store: StateStore, profiles: CodexProfiles, body: Record<string, unknown>): Promise<string> {
  const policyStore = new CodexPoolPolicyStore(store);
  const origins = new OriginProtectionStore(store);
  if (body.action === "pool") {
    if (body.enabled !== "0" && body.enabled !== "1") throw Error("invalid_pool_setting");
    const selected = body.profile === undefined ? [] : Array.isArray(body.profile) ? body.profile : [body.profile];
    const policy = await policyStore.read();
    if (selected.some(id => typeof id !== "string" || !policy.profiles.some(profile => profile.profileId === id))) throw Error("invalid_profile_selection");
    await policyStore.configure({ ...policy, dispatchEnabled: body.enabled === "1",
      profiles: policy.profiles.map(profile => ({ ...profile, enabled: selected.includes(profile.profileId) })) });
    return "Worker pool settings saved.";
  }
  const actor = { clientId: String(body.clientId), sessionId: String(body.sessionId) };
  const state = await store.load();
  if (!state.oauthClients.some(client => client.clientId === actor.clientId)) throw Error("client_unavailable");
  if (body.action === "close") {
    await origins.close({ ...actor, bindingId: String(body.bindingId), expectedRevision: Number(body.revision) });
    return "Session binding closed. Create a new binding before dispatching from this session.";
  }
  if (body.action !== "bind") throw Error("invalid_worker_action");
  const snapshot = await profiles.refreshProfile(String(body.profileId));
  if (snapshot.authMode !== "chatgpt" || !snapshot.accountIdentity) throw Error("profile_identity_unavailable");
  const registry = await profiles.listProfiles();
  const snapshots = await profiles.listSnapshots();
  const aliases = registry.filter(profile => snapshots.some(row => row.profileId === profile.id && row.accountIdentity === snapshot.accountIdentity)).map(profile => profile.id);
  const binding = await origins.bindOrRenew({ actor, nativeProfileId: snapshot.profileId, profileAliases: aliases,
    verifiedProviderAccountSubject: snapshot.accountIdentity, source: "trusted-server-resolver",
    expectedRevision: Number(body.revision), expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
  return `Native account protected. Binding ID ${binding.bindingId}. Use session ${actor.sessionId} in job submissions. Save the binding ID to close it after switching accounts.`;
}
