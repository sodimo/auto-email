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
import { guardRecipient, guardRun } from "./guard.js";
import { openSentAppender, type SentAppender } from "./imap-append.js";
import { buildMessage, createTransport, isRetryable, type MailSession, type MailTransport } from "./mailer.js";
import type { AppendStatus, Env, OutboxRow, Settings } from "../types.js";

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
type DrainRow = OutboxRow & { recipient_active: number };

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
            o.subject, o.body_html, o.body_text, o.rfc_message_id, o.attempts,
            EXISTS (
              SELECT 1
                FROM jobs j
                JOIN recipient_list_members m ON m.list_id = j.recipient_list_id
               WHERE j.id = o.job_id
                 AND m.active = 1
                 AND lower(trim(m.email)) = lower(trim(o.recipient))
            ) AS recipient_active
       FROM outbox o
      WHERE o.status = 'pending' AND o.next_attempt_at <= ${NOW_SQL}
      ORDER BY o.id
      LIMIT ?`,
  )
    .bind(batchSize(settings, options.limit))
    .all<DrainRow>();

  summary.scanned = rows.length;
  if (rows.length === 0) return summary;

  // Recipient-list changes are authoritative even after enqueue. This matters
  // when the kill switch holds a queue while an operator pauses or removes an
  // address: resuming must not deliver the stale queued copy.
  const sendableRows: DrainRow[] = [];
  for (const row of rows) {
    const verdict = row.recipient_active === 1
      ? guardRecipient(settings, row.recipient)
      : {
          allowed: false as const,
          status: "suppressed" as const,
          reason: "recipient is no longer active in the job's selected list",
        };
    if (verdict.allowed) {
      sendableRows.push(row);
      continue;
    }
    summary.cancelled++;
    await env.DB.batch([
      env.DB.prepare("UPDATE outbox SET status = 'cancelled', last_error = ? WHERE id = ?").bind(
        verdict.reason,
        row.id,
      ),
      env.DB.prepare(`UPDATE send_log SET status = ?, smtp_response = ?, sent_at = ${NOW_SQL} WHERE id = ?`).bind(
        verdict.status,
        verdict.reason,
        row.send_log_id,
      ),
    ]);
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
        to: { email: row.recipient, name: row.recipient_name },
        from: { email: fromAddress, name: fromName },
        replyTo: settings.reply_to?.trim() || fromAddress,
        subject: row.subject,
        html: row.body_html,
        text: row.body_text,
        messageId: row.rfc_message_id,
      });

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
