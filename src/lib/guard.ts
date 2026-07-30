/**
 * The safety gate. Nothing decides whether an address may be written to
 * except this module, and nothing reaches the SMTP layer except through
 * lib/dispatch.ts, which consults it.
 *
 * Both switches FAIL CLOSED: a missing or unrecognised settings value means
 * "kill switch engaged" / "test mode on", never the permissive reading.
 */
import { FORCE_TEST_MODE } from "../config.js";
import type { Settings } from "../types.js";

/** Emergency test recipient used only if settings.test_mode is re-enabled. */
export const TEST_MODE_ALLOWLIST: readonly string[] = ["paul.ghafary@sodimo.eu"];

export type GuardVerdict =
  | { allowed: true }
  | { allowed: false; status: "suppressed" | "skipped_test_mode"; reason: string };

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Explicitly off, or it is on. */
function isOff(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "off";
}

export function isKillSwitchEngaged(settings: Settings): boolean {
  return !isOff(settings.kill_switch);
}

export function isTestMode(settings: Settings): boolean {
  return FORCE_TEST_MODE || !isOff(settings.test_mode);
}

export function isPinnedTestRecipient(email: string): boolean {
  return TEST_MODE_ALLOWLIST.includes(normalizeEmail(email));
}

/**
 * The whole-run gate, checked at the top of every cron run and every manual
 * trigger before any job is even loaded.
 */
export function guardRun(settings: Settings): GuardVerdict {
  if (isKillSwitchEngaged(settings)) {
    return {
      allowed: false,
      status: "suppressed",
      reason: `kill switch engaged (settings.kill_switch=${JSON.stringify(settings.kill_switch ?? null)})`,
    };
  }
  return { allowed: true };
}

/** The per-address gate, checked immediately before every single send. */
export function guardRecipient(settings: Settings, email: string): GuardVerdict {
  const run = guardRun(settings);
  if (!run.allowed) return run;

  if (isTestMode(settings) && !isPinnedTestRecipient(email)) {
    return {
      allowed: false,
      status: "skipped_test_mode",
      reason: `test mode: ${normalizeEmail(email)} is not one of ${TEST_MODE_ALLOWLIST.join(", ")}`,
    };
  }
  return { allowed: true };
}
