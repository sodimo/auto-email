/**
 * THE CHOKE POINT. Every outbound email in this Worker goes through
 * `dispatch()`, and `dispatch()` is the only caller of `Mailer.send`. Adding a
 * second call site anywhere else defeats both hard rules at once — do not.
 *
 * Order of operations, and why:
 *   1. guard   — kill switch and test-mode pinning, decided before anything is
 *                written, so a suppressed run costs nothing.
 *   2. claim   — insert-first into send_log. The UNIQUE(job_id, recipient,
 *                dedupe_key) index is what makes "never twice" true: losing the
 *                race means someone else already owns this send, so we stop.
 *   3. send    — SMTP, outside any transaction (D1 has none that could span it).
 *   4. settle  — overwrite the claim with the terminal status.
 *
 * A crash between 3 and 4 leaves the row `pending`. That is the honest record:
 * the mail may or may not have gone, and a later run will NOT resend it,
 * because the claim still stands. Prefer that to a silent double-send.
 */
import { guardRecipient, normalizeEmail } from "./guard.js";
import type { Mailer, OutboundMessage } from "./mailer.js";
import { newMessageId } from "./mailer.js";
import type { Job, Recipient, SendStatus, Settings } from "../types.js";

export type DispatchOutcome =
  | { result: "sent"; messageId: string }
  | { result: "duplicate"; dedupeKey: string }
  | { result: "blocked"; status: Extract<SendStatus, "suppressed" | "skipped_test_mode">; reason: string }
  | { result: "failed"; error: string };

export interface DispatchRequest {
  db: D1Database;
  settings: Settings;
  mailer: Mailer;
  job: Pick<Job, "id" | "name">;
  recipient: Recipient;
  dedupeKey: string;
  subject: string;
  html: string;
  text: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

/** Records a terminal outcome for a triple we never intend to attempt. */
async function logBlocked(
  db: D1Database,
  jobId: number,
  recipient: string,
  dedupeKey: string,
  status: SendStatus,
  reason: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO send_log (job_id, recipient, dedupe_key, status, smtp_response, sent_at)
       VALUES (?, ?, ?, ?, ?, ${NOW})
       ON CONFLICT (job_id, recipient, dedupe_key) DO NOTHING`,
    )
    .bind(jobId, recipient, dedupeKey, status, reason)
    .run();
}

/** Returns the send_log row id, or null when the triple was already claimed. */
async function claim(
  db: D1Database,
  jobId: number,
  recipient: string,
  dedupeKey: string,
  messageId: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      `INSERT INTO send_log (job_id, recipient, dedupe_key, status, message_id, sent_at)
       VALUES (?, ?, ?, 'pending', ?, ${NOW})
       ON CONFLICT (job_id, recipient, dedupe_key) DO NOTHING
       RETURNING id`,
    )
    .bind(jobId, recipient, dedupeKey, messageId)
    .first<{ id: number }>();
  return row?.id ?? null;
}

async function settle(
  db: D1Database,
  rowId: number,
  status: SendStatus,
  smtpResponse: string,
): Promise<void> {
  await db
    .prepare(`UPDATE send_log SET status = ?, smtp_response = ?, sent_at = ${NOW} WHERE id = ?`)
    .bind(status, smtpResponse.slice(0, 1000), rowId)
    .run();
}

export async function dispatch(request: DispatchRequest): Promise<DispatchOutcome> {
  const { db, settings, mailer, job, dedupeKey } = request;
  const recipient = normalizeEmail(request.recipient.email);

  const verdict = guardRecipient(settings, recipient);
  if (!verdict.allowed) {
    await logBlocked(db, job.id, recipient, dedupeKey, verdict.status, verdict.reason);
    return { result: "blocked", status: verdict.status, reason: verdict.reason };
  }

  const fromAddress = settings.from_address;
  const fromName = settings.from_name;
  if (!fromAddress || !fromName) {
    const error = "settings.from_address / settings.from_name are not configured";
    await logBlocked(db, job.id, recipient, dedupeKey, "failed", error);
    return { result: "failed", error };
  }

  const messageId = newMessageId(fromAddress);
  const rowId = await claim(db, job.id, recipient, dedupeKey, messageId);
  if (rowId === null) return { result: "duplicate", dedupeKey };

  const message: OutboundMessage = {
    to: { email: recipient, name: request.recipient.display_name },
    from: { email: fromAddress, name: fromName },
    replyTo: fromAddress,
    subject: request.subject,
    html: request.html,
    text: request.text,
    messageId,
  };

  try {
    const result = await mailer.send(message);
    await settle(db, rowId, "sent", result.response);
    return { result: "sent", messageId: result.messageId };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    await settle(db, rowId, "failed", error);
    return { result: "failed", error };
  }
}
