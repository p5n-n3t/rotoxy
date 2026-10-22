/** Human-facing identity for ROTOXY's single provider control plane. */
export const PRIMARY_FLEET_ID = "token2oauth";
export const PRIMARY_FLEET_LABEL = "ROTOXY Fleet";

/** The persisted ID remains a compatibility key for OAuth grants and jobs. */
export function isPrimaryFleet(id: string): boolean { return id === PRIMARY_FLEET_ID; }

export function fleetLabel(id: string): string {
  return isPrimaryFleet(id) ? PRIMARY_FLEET_LABEL : id;
}

export function fleetAccessDescription(id: string): string {
  return isPrimaryFleet(id)
    ? "One ROTOXY Fleet gives authorized clients access to the same provider accounts and supervision controls. Repository and project fields remain task context; they do not create separate provider pools."
    : "Only explicitly authorized OAuth clients can discover or use this task context. Provider credentials and account pools remain governed by the ROTOXY Fleet policy.";
}
