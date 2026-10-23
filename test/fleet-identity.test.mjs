import test from "node:test";
import assert from "node:assert/strict";
import { PRIMARY_FLEET_ID, PRIMARY_FLEET_LABEL, fleetAccessDescription, fleetLabel, isPrimaryFleet } from "../dist/fleet-identity.js";

test("the durable compatibility ID has a ROTOXY Fleet display identity without relabeling task contexts", () => {
  assert.equal(PRIMARY_FLEET_ID, "token2oauth");
  assert.equal(PRIMARY_FLEET_LABEL, "ROTOXY Fleet");
  assert.equal(isPrimaryFleet(PRIMARY_FLEET_ID), true);
  assert.equal(fleetLabel(PRIMARY_FLEET_ID), "ROTOXY Fleet");
  assert.equal(fleetLabel("project-a"), "project-a");
  assert.match(fleetAccessDescription(PRIMARY_FLEET_ID), /do not create separate provider pools/);
});
