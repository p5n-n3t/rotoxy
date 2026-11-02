import type { PersistedState, UpstreamAccount } from "./types.js";
import { PROVIDER_PROFILES } from "./provider-capabilities.js";

/** Historical credentials may remain in storage until the separately backed-up purge. */
export function retiredAccount(account: UpstreamAccount, state: PersistedState): boolean {
  if (account.provider === "lightsprint") return true;
  if (account.provider !== "generic-bearer-mcp") return false;
  try { return new URL(state.config.upstreamUrl).origin === new URL(PROVIDER_PROFILES.lightsprint.defaultServerUrl).origin; }
  catch { return false; }
}
export function activeAccountState(state: PersistedState): PersistedState {
  const accounts=state.accounts.filter(account=>!retiredAccount(account,state));
  const ids=new Set(accounts.map(account=>account.id));
  return {...state,accounts,capabilities:Object.fromEntries(Object.entries(state.capabilities??{}).filter(([id])=>ids.has(id)))};
}
