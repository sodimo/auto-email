/** Compile-time constants. Anything an admin should be able to change at
 *  runtime belongs in the `settings` table. */
import type { AuthType } from "../vendor/worker-mailer/index.js";

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
 * Wave 1 forced this on while the UI was unfinished. The business-owner
 * handoff explicitly graduates recipient control to the administration UI.
 * Test mode remains available as a fail-closed setting, but is no longer
 * compile-time forced.
 */
export const FORCE_TEST_MODE = false;

/**
 * Stated explicitly because the vendored client has no working default: with
 * an empty list, auth() throws before it ever reaches the server.
 */
export const SMTP_AUTH_TYPES: AuthType[] = ["plain", "login"];

/** Fallback when settings.drain_batch_size is missing or unparseable. */
export const DEFAULT_DRAIN_BATCH = 10;

/** Never drain more than this per invocation whatever the setting says — the
 *  free plan gives ~10ms CPU per cron invocation. */
export const MAX_DRAIN_BATCH = 25;

/**
 * A queued message is attempted at most this many times, and only for failures
 * the SMTP client can prove did not deliver (vendor/worker-mailer#SmtpError).
 */
export const MAX_SEND_ATTEMPTS = 4;

/** Backoff before the next attempt, in minutes. The last value repeats. */
export const RETRY_BACKOFF_MINUTES = [5, 15, 60];
