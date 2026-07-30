/**
 * CHOKE POINT 1 of 2. Nothing enters the outbox except through `enqueue()`,
 * and nothing leaves it except through lib/drain.ts. Both consult the guard.
 *
 * Order of operations, and why:
 *   1. guard  — kill switch and test-mode pinning, decided before anything is
 *               written, so a suppressed run costs one D1 write and no SMTP.
 *   2. claim  — insert-first into send_log. UNIQUE(job_id, recipient,
 *               dedupe_key) is what makes "never twice" true: losing the race
 *               means someone else already owns this send, so we stop.
 *   3. queue  — the rendered message goes into the outbox for the drain.
 *
 * Rendering happens ONCE per message, here, not per drain attempt.
 */
import { guardRecipient, normalizeEmail } from "./guard.js";
import { newMessageId } from "./mailer.js";
import type { Job, MessageAddress, Recipient, RecipientKind, SendStatus, Settings } from "../types.js";

export type EnqueueOutcome =
  | { result: "queued"; sendLogId: number; messageId: string }
  | { result: "duplicate"; dedupeKey: string }
  | { result: "blocked"; status: Extract<SendStatus, "suppressed" | "skipped_test_mode">; reason: string }
  | { result: "failed"; error: string };

export interface EnqueueRequest {
  db: D1Database;
  settings: Settings;
  job: Pick<Job, "id" | "name">;
  recipient: Recipient;
  recipientKind?: RecipientKind;
  toRecipients?: Recipient[];
  ccRecipients?: Recipient[];
  dedupeKey: string;
  subject: string;
  html: string;
  text: string;
}

export const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

function snapshot(recipients: Recipient[]): MessageAddress[] {
  const seen = new Set<string>();
  const result: MessageAddress[] = [];
  for (const recipient of recipients) {
    const address = normalizeEmail(recipient.email);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    result.push({ email: address, name: recipient.display_name ?? null });
  }
  return result;
}

/** Records a terminal outcome for a triple we never intend to attempt. */
export async function logTerminal(
  db: D1Database,
  jobId: number,
  recipient: string,
  dedupeKey: string,
  status: SendStatus,
  reason: string,
  recipientKind: RecipientKind = "to",
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO send_log (job_id, recipient, recipient_kind, dedupe_key, status, smtp_response, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ${NOW_SQL})
       ON CONFLICT (job_id, recipient, dedupe_key) DO NOTHING`,
    )
    .bind(jobId, recipient, recipientKind, dedupeKey, status, reason)
    .run();
}

/** Returns the send_log row id, or null when the triple was already claimed. */
async function claim(
  db: D1Database,
  jobId: number,
  recipient: string,
  dedupeKey: string,
  messageId: string,
  recipientKind: RecipientKind,
): Promise<number | null> {
  const row = await db
    .prepare(
      `INSERT INTO send_log (job_id, recipient, recipient_kind, dedupe_key, status, message_id, sent_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ${NOW_SQL})
       ON CONFLICT (job_id, recipient, dedupe_key) DO NOTHING
       RETURNING id`,
    )
    .bind(jobId, recipient, recipientKind, dedupeKey, messageId)
    .first<{ id: number }>();
  return row?.id ?? null;
}

export async function enqueue(request: EnqueueRequest): Promise<EnqueueOutcome> {
  const { db, settings, job, dedupeKey } = request;
  const recipient = normalizeEmail(request.recipient.email);
  const recipientKind = request.recipientKind ?? "to";
  const toRecipients = snapshot(
    request.toRecipients ?? (recipientKind === "to" ? [request.recipient] : []),
  );
  const ccRecipients = snapshot(
    request.ccRecipients ?? (recipientKind === "cc" ? [request.recipient] : []),
  );

  const verdict = guardRecipient(settings, recipient);
  if (!verdict.allowed) {
    await logTerminal(db, job.id, recipient, dedupeKey, verdict.status, verdict.reason, recipientKind);
    return { result: "blocked", status: verdict.status, reason: verdict.reason };
  }

  const fromAddress = settings.from_address;
  if (!fromAddress || !settings.from_name) {
    const error = "settings.from_address / settings.from_name are not configured";
    await logTerminal(db, job.id, recipient, dedupeKey, "failed", error, recipientKind);
    return { result: "failed", error };
  }

  const messageId = newMessageId(fromAddress);
  const sendLogId = await claim(db, job.id, recipient, dedupeKey, messageId, recipientKind);
  if (sendLogId === null) return { result: "duplicate", dedupeKey };

  try {
    await db
      .prepare(
        `INSERT INTO outbox
           (send_log_id, job_id, recipient, recipient_name, recipient_kind,
            to_recipients_json, cc_recipients_json, dedupe_key,
            subject, body_html, body_text, rfc_message_id, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_SQL}, ${NOW_SQL})`,
      )
      .bind(
        sendLogId,
        job.id,
        recipient,
        request.recipient.display_name,
        recipientKind,
        JSON.stringify(toRecipients),
        JSON.stringify(ccRecipients),
        dedupeKey,
        request.subject,
        request.html,
        request.text,
        messageId,
      )
      .run();
  } catch (cause) {
    // The claim exists but the work item does not; say so instead of leaving a
    // ledger row that will sit 'pending' forever with nothing to drain it.
    const error = `claimed but not queued: ${cause instanceof Error ? cause.message : String(cause)}`;
    await db
      .prepare(`UPDATE send_log SET status = 'failed', smtp_response = ? WHERE id = ?`)
      .bind(error, sendLogId)
      .run();
    return { result: "failed", error };
  }

  return { result: "queued", sendLogId, messageId };
}
