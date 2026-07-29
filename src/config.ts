/** Compile-time constants. Anything an admin should be able to change at
 *  runtime belongs in the `settings` table instead — except the test-mode
 *  allowlist, which is deliberately code (see lib/guard.ts). */

/**
 * Must match the Worker cron in wrangler.jsonc (`*​/5 * * * *`). The scheduler
 * treats every tick as covering the TICK_MINUTES that preceded it, so job
 * schedules need not align to tick boundaries.
 */
export const TICK_MINUTES = 5;

/** Linked from the digest template; overridable per-render later. */
export const DASHBOARD_URL = "https://dashboard.sodimo.eu";

/** Hard cap on rows a condition query may drive a single mail from. */
export const MAX_CONDITION_ROWS = 500;

/**
 * WAVE 1 LAW. While true, the guard pins recipients to TEST_MODE_ALLOWLIST no
 * matter what the `settings.test_mode` row says — so a stray D1 UPDATE cannot
 * put production addresses in play before there is an admin UI to do it
 * deliberately. Wave 2 flips this to false and hands control to the setting.
 */
export const FORCE_TEST_MODE = true;
