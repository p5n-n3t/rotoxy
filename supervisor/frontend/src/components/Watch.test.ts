import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import Watch from "./Watch.svelte";
import { makeSlot, makeState } from "../test/fixtures";

describe("Watch", () => {
  it("does not substitute requested effort for an unreported confirmed effort", () => {
    render(Watch, {
      props: {
        dashboard: makeState({ slots: [makeSlot({ confirmed_effort: null, requested_effort: "low" })] }),
        loading: false,
        notice: "",
        oninspect: () => undefined,
        oncheck: () => undefined,
        onack: () => undefined,
      },
    });

    expect(screen.getByTestId("confirmed-effort")).toHaveTextContent("Not reported");
    expect(screen.getByTestId("requested-effort")).toHaveTextContent("Requested low");
  });
});
