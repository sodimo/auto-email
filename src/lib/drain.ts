/**
 * CHOKE POINT 2 of 2. The only place in the codebase that talks to SMTP.
 *
 * Cron enqueues; this drains a small batch per invocation, because the Workers
 * free plan allows roughly 10ms of CPU per invocation and a whole run of sends
 * would not fit. One SMTP session serves the whole batch, and one IMAP session
 * files the Sent copies.
 *
 * The guard runs AGAIN here, not just at enqueue: minutes can pass between the
 * two, and the kill switch has to be able to stop mail that is already queued.
 * An engaged kill switch HOLDS the queue (rows stay pending) rather than
 * cancelling it — turning the switch off resumes exactly where it stopped.
 *
 * Retries are deliberately narrow. A queued message is re-attempted only when
 * the SMTP client can prove the bytes never reached the server's queue
 * (vendor/worker-mailer#SmtpError.retryable). A failure we cannot place
 * relative to DATA is terminal, because a duplicate would break hard rule 1.
 */
import { DEFAULT_DRAIN_BATCH, MAX_DRAIN_BATCH, MAX_SEND_ATTEMPTS, RETRY_BACKOFF_MINUTES } from "../config.js";
import { loadSettings } from "./db.js";
import { guardRecipient, guardRun, normalizeEmail } from "./guard.js";
import { openSentAppender, type SentAppender } from "./imap-append.js";
import { buildMessage, createTransport, isRetryable, type MailSession, type MailTransport } from "./mailer.js";
import type { AppendStatus, Env, MessageAddress, OutboxRow, SendStatus, Settings } from "../types.js";

export interface DrainOptions {
  /** Injected by tests; production builds one from settings. */
  transport?: MailTransport;
  /** Injected by tests. Returning null means "no Sent copies this run". */
  openAppender?: (settings: Settings, env: Env) => Promise<SentAppender | null>;
  limit?: number;
}

export interface DrainSummary {
  suppressed?: string;
  scanned: number;
  sent: number;
  failed: number;
  retrying: number;
  cancelled: number;
  appended: number;
  appendFailed: number;
  errors: string[];
}

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";
/** A leased row is never picked up again by the drain's due-row query. */
const LEASE_UNTIL = "9999-12-31T23:59:59Z";
type DrainRow = OutboxRow;
type SendableRow = DrainRow & { toRecipients: MessageAddress[]; ccRecipients: MessageAddress[] };
type CurrentPlan = { to: Set<string>; cc: Set<string> };

function emptySummary(): DrainSummary {
  return { scanned: 0, sent: 0, failed: 0, retrying: 0, cancelled: 0, appended: 0, appendFailed: 0, errors: [] };
}

export function batchSize(settings: Settings, override?: number): number {
  const requested = override ?? Number(settings.drain_batch_size);
  const value = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_DRAIN_BATCH;
  return Math.min(value, MAX_DRAIN_BATCH);
}

/** Minutes to wait before attempt `attempts + 1`. The last step repeats. */
export function backoffMinutes(attempts: number): number {
  const index = Math.min(Math.max(attempts - 1, 0), RETRY_BACKOFF_MINUTES.length - 1);
  return RETRY_BACKOFF_MINUTES[index]!;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function parseSnapshot(value: string, fallback: MessageAddress[] = []): MessageAddress[] {
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) return fallback;
    const seen = new Set<string>();
    const result: MessageAddress[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const email = normalizeEmail(String((item as Record<string, unknown>)["email"] ?? ""));
      if (!email || seen.has(email)) continue;
      const rawName = (item as Record<string, unknown>)["name"];
      seen.add(email);
      result.push({ email, name: typeof rawName === "string" && rawName ? rawName : null });
    }
    return result.length > 0 ? result : fallback;
  } catch {
    return fallback;
  }
}

function configuredCc(value: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .filter((address): address is string => typeof address === "string")
        .map(normalizeEmail)
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

async function loadCurrentPlans(db: D1Database, rows: DrainRow[]): Promise<Map<number, CurrentPlan>> {
  const jobIds = Array.from(new Set(rows.map((row) => row.job_id)));
  const placeholders = jobIds.map(() => "?").join(", ");
  const [jobs, members] = await Promise.all([
    db
      .prepare(`SELECT id, cc_recipients_json FROM jobs WHERE id IN (${placeholders})`)
      .bind(...jobIds)
      .all<{ id: number; cc_recipients_json: string }>(),
    db
      .prepare(
        `SELECT j.id AS job_id, m.email
           FROM jobs j
           JOIN recipient_list_members m ON m.list_id = j.recipient_list_id
          WHERE j.id IN (${placeholders}) AND m.active = 1`,
      )
      .bind(...jobIds)
      .all<{ job_id: number; email: string }>(),
  ]);

  const plans = new Map<number, CurrentPlan>();
  for (const job of jobs.results) {
    plans.set(job.id, { to: new Set(), cc: configuredCc(job.cc_recipients_json) });
  }
  for (const member of members.results) {
    plans.get(member.job_id)?.to.add(normalizeEmail(member.email));
  }
  for (const plan of plans.values()) {
    for (const address of plan.to) plan.cc.delete(address);
  }
  return plans;
}

async function cancelRow(
  db: D1Database,
  row: DrainRow,
  status: Extract<SendStatus, "suppressed" | "skipped_test_mode">,
  reason: string,
): Promise<void> {
  await db.batch([
    db.prepare("UPDATE outbox SET status = 'cancelled', last_error = ? WHERE id = ?").bind(reason, row.id),
    db.prepare(`UPDATE send_log SET status = ?, smtp_response = ?, sent_at = ${NOW_SQL} WHERE id = ?`).bind(
      status,
      reason,
      row.send_log_id,
    ),
  ]);
}

async function defaultOpenAppender(settings: Settings, env: Env): Promise<SentAppender | null> {
  if ((settings.imap_append ?? "").trim().toLowerCase() !== "on") return null;
  const host = settings.imap_host;
  if (!host) throw new Error("settings.imap_host is not configured");
  const port = Number(settings.imap_port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`settings.imap_port is not a port number: ${settings.imap_port}`);
  }
  return await openSentAppender({
    host,
    port,
    username: settings.from_address!,
    password: env.STRATO_SMTP_PASSWORD,
    folderOverride: settings.sent_folder_override,
  });
}

export async function drainOutbox(env: Env, options: DrainOptions = {}): Promise<DrainSummary> {
  const summary = emptySummary();
  const settings = await loadSettings(env.DB);

  const run = guardRun(settings);
  if (!run.allowed) {
    summary.suppressed = run.reason;
    return summary;
  }

  const fromAddress = settings.from_address;
  const fromName = settings.from_name;
  if (!fromAddress || !fromName) {
    summary.errors.push("settings.from_address / settings.from_name are not configured");
    return summary;
  }

  const { results: rows } = await env.DB.prepare(
    `SELECT o.id, o.send_log_id, o.job_id, o.recipient, o.recipient_name, o.dedupe_key,
            o.recipient_kind, o.to_recipients_json, o.cc_recipients_json,
            o.subject, o.body_html, o.body_text, o.rfc_message_id, o.attempts
       FROM outbox o
      WHERE o.status = 'pending' AND o.next_attempt_at <= ${NOW_SQL}
      ORDER BY o.id
      LIMIT ?`,
  )
    .bind(batchSize(settings, options.limit))
    .all<DrainRow>();

  summary.scanned = rows.length;
  if (rows.length === 0) return summary;

  const currentPlans = await loadCurrentPlans(env.DB, rows);

  // Recipient-list changes are authoritative even after enqueue. This matters
  // when the kill switch holds a queue while an operator pauses or removes an
  // address: resuming must not deliver the stale queued copy.
  const sendableRows: SendableRow[] = [];
  for (const row of rows) {
    const plan = currentPlans.get(row.job_id);
    const normalizedRecipient = normalizeEmail(row.recipient);
    const roleActive = row.recipient_kind === "cc"
      ? plan?.cc.has(normalizedRecipient) === true
      : plan?.to.has(normalizedRecipient) === true;
    if (!roleActive) {
      const reason = row.recipient_kind === "cc"
        ? "recipient is no longer configured as CC for the job"
        : "recipient is no longer active in the job's selected list";
      summary.cancelled++;
      await cancelRow(env.DB, row, "suppressed", reason);
      continue;
    }

    const verdict = guardRecipient(settings, row.recipient);
    if (!verdict.allowed) {
      summary.cancelled++;
      await cancelRow(env.DB, row, verdict.status, verdict.reason);
      continue;
    }

    const fallbackTo = row.recipient_kind === "to"
      ? [{ email: normalizedRecipient, name: row.recipient_name }]
      : [];
    const toRecipients = parseSnapshot(row.to_recipients_json, fallbackTo).filter(
      (recipient) => plan!.to.has(recipient.email) && guardRecipient(settings, recipient.email).allowed,
    );
    const toAddresses = new Set(toRecipients.map((recipient) => recipient.email));
    const ccRecipients = parseSnapshot(row.cc_recipients_json).filter(
      (recipient) =>
        plan!.cc.has(recipient.email) &&
        !toAddresses.has(recipient.email) &&
        guardRecipient(settings, recipient.email).allowed,
    );
    if (toRecipients.length === 0) {
      const reason = "the queued message no longer has an active primary recipient";
      summary.cancelled++;
      await cancelRow(env.DB, row, "suppressed", reason);
      continue;
    }
    sendableRows.push({ ...row, toRecipients, ccRecipients });
  }
  if (sendableRows.length === 0) return summary;

  let session: MailSession;
  try {
    const transport = options.transport ?? createTransport(settings, env);
    session = await transport.open();
  } catch (cause) {
    // Nothing was attempted, so nothing is charged an attempt: the rows stay
    // pending and the next tick tries again. A sustained outage shows up as a
    // growing pending backlog in /healthz, not as silently dropped mail.
    summary.errors.push(`SMTP session unavailable: ${describe(cause)}`);
    return summary;
  }

  const openAppender = options.openAppender ?? defaultOpenAppender;
  let appender: SentAppender | null = null;
  let appenderError: string | null = null;
  let appenderTried = false;

  try {
    for (const row of sendableRows) {
      // Built once, used by SMTP and IMAP alike.
      const raw = buildMessage({
        to: row.toRecipients,
        cc: row.ccRecipients,
        from: { email: fromAddress, name: fromName },
        replyTo: settings.reply_to?.trim() || fromAddress,
        subject: row.subject,
        html: row.body_html,
        text: row.body_text,
        messageId: row.rfc_message_id,
      });

      // Write-ahead lease. Nothing is sent unless D1 has just accepted a write
      // for this row. Without it, a D1 that refuses writes (daily row-write
      // limit reached, outage) lets the send succeed but not the bookkeeping,
      // and the next tick re-sends the same message every five minutes. The
      // lease also stops two concurrent drains from sending one row twice.
      // If the bookkeeping below fails after a send, the row keeps its lease:
      // it stays visible as pending in /healthz and is never re-sent.
      let leased: boolean;
      try {
        const lease = await env.DB.prepare(
          `UPDATE outbox SET next_attempt_at = '${LEASE_UNTIL}'
            WHERE id = ? AND status = 'pending' AND next_attempt_at <= ${NOW_SQL}`,
        )
          .bind(row.id)
          .run();
        leased = Number(lease.meta.changes ?? 0) === 1;
      } catch (cause) {
        summary.errors.push(`D1 refused the pre-send write; nothing more is sent this run: ${describe(cause)}`);
        break;
      }
      if (!leased) continue;

      let response: string;
      try {
        response = await session.sendRaw(row.recipient, raw);
      } catch (cause) {
        const error = describe(cause);
        const attempts = row.attempts + 1;
        const willRetry = isRetryable(cause) && attempts < MAX_SEND_ATTEMPTS;

        if (willRetry) {
          summary.retrying++;
          await env.DB.prepare(
            `UPDATE outbox
                SET attempts = ?, last_error = ?,
                    next_attempt_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
              WHERE id = ?`,
          )
            .bind(attempts, error, `+${backoffMinutes(attempts)} minutes`, row.id)
            .run();
        } else {
          summary.failed++;
          summary.errors.push(`${row.recipient}: ${error}`);
          await env.DB.batch([
            env.DB.prepare("UPDATE outbox SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?").bind(
              attempts,
              error,
              row.id,
            ),
            env.DB.prepare(
              `UPDATE send_log SET status = 'failed', smtp_response = ?, sent_at = ${NOW_SQL} WHERE id = ?`,
            ).bind(error.slice(0, 1000), row.send_log_id),
          ]);
        }
        continue;
      }

      // Delivered. Everything below is bookkeeping and MUST NOT change that.
      summary.sent++;

      let appendStatus: AppendStatus = "skipped";
      let appendResponse: string | null = null;
      if (!appenderTried) {
        appenderTried = true;
        try {
          appender = await openAppender(settings, env);
        } catch (cause) {
          appenderError = `Sent folder unavailable: ${describe(cause)}`;
          summary.errors.push(appenderError);
        }
      }
      if (appender) {
        const result = await appender.append(raw);
        appendStatus = result.status;
        appendResponse = result.response;
        if (result.status === "appended") summary.appended++;
        else summary.appendFailed++;
      } else if (appenderError) {
        appendStatus = "failed";
        appendResponse = appenderError;
        summary.appendFailed++;
      }

      await env.DB.batch([
        env.DB.prepare("UPDATE outbox SET status = 'sent', attempts = ? WHERE id = ?").bind(row.attempts + 1, row.id),
        env.DB.prepare(
          `UPDATE send_log
              SET status = 'sent', smtp_response = ?, append_status = ?, append_response = ?, sent_at = ${NOW_SQL}
            WHERE id = ?`,
        ).bind(response.slice(0, 1000), appendStatus, appendResponse?.slice(0, 1000) ?? null, row.send_log_id),
      ]);
    }
  } finally {
    await session.close().catch(() => undefined);
    await appender?.close().catch(() => undefined);
  }

  return summary;
}
