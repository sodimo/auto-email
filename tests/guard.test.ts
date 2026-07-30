import { describe, expect, it } from "vitest";
import { FORCE_TEST_MODE } from "../src/config.js";
import {
  guardRecipient,
  guardRun,
  isKillSwitchEngaged,
  isPinnedTestRecipient,
  isTestMode,
  TEST_MODE_ALLOWLIST,
} from "../src/lib/guard.js";
import type { Settings } from "../src/types.js";

const live: Settings = { kill_switch: "off", test_mode: "on" };

describe("test mode", () => {
  it("pins sending to exactly the two handoff addresses", () => {
    expect(TEST_MODE_ALLOWLIST).toEqual(["thomas@leger.run", "paul.ghafary@sodimo.eu"]);
  });

  it("lets a pinned recipient through", () => {
    for (const email of TEST_MODE_ALLOWLIST) {
      expect(guardRecipient(live, email)).toEqual({ allowed: true });
    }
  });

  it("blocks every other recipient with skipped_test_mode", () => {
    for (const email of ["rani@sodimo.eu", "compta@sodimo.eu", "thomas@leger.run.evil.com", ""]) {
      const verdict = guardRecipient(live, email);
      expect(verdict.allowed, email).toBe(false);
      if (!verdict.allowed) expect(verdict.status).toBe("skipped_test_mode");
    }
  });

  it("compares case- and whitespace-insensitively", () => {
    expect(guardRecipient(live, "  Thomas@Leger.RUN ")).toEqual({ allowed: true });
    expect(isPinnedTestRecipient("PAUL.GHAFARY@SODIMO.EU")).toBe(true);
  });

  it("stays forced on even if the settings row says otherwise", () => {
    expect(FORCE_TEST_MODE).toBe(true);
    const off: Settings = { kill_switch: "off", test_mode: "off" };
    expect(isTestMode(off)).toBe(true);
    const verdict = guardRecipient(off, "rani@sodimo.eu");
    expect(verdict.allowed).toBe(false);
  });

  it("fails closed when the setting is missing or unrecognised", () => {
    expect(isTestMode({})).toBe(true);
    expect(isTestMode({ test_mode: "maybe" })).toBe(true);
  });
});

describe("kill switch", () => {
  it("stops the whole run", () => {
    const verdict = guardRun({ kill_switch: "on" });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.status).toBe("suppressed");
  });

  it("outranks the allowlist — even pinned recipients are suppressed", () => {
    for (const email of TEST_MODE_ALLOWLIST) {
      const verdict = guardRecipient({ kill_switch: "on", test_mode: "on" }, email);
      expect(verdict.allowed, email).toBe(false);
      if (!verdict.allowed) expect(verdict.status).toBe("suppressed");
    }
  });

  it("is engaged unless the value is exactly 'off'", () => {
    expect(isKillSwitchEngaged({})).toBe(true);
    expect(isKillSwitchEngaged({ kill_switch: "" })).toBe(true);
    expect(isKillSwitchEngaged({ kill_switch: "false" })).toBe(true);
    expect(isKillSwitchEngaged({ kill_switch: "OFF " })).toBe(false);
  });
});
