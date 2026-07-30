import { env } from "cloudflare:test";
import { loadSettings } from "../src/lib/db.js";
import type { AppendResult, SentAppender } from "../src/lib/imap-append.js";
import type { MailSession, MailTransport } from "../src/lib/mailer.js";
import type { Job, Settings } from "../src/types.js";

const decoder = new TextDecoder();

/** The SMTP seam, replaced. No test opens a socket through this. */
export class FakeTransport implements MailTransport {
  readonly sent: { to: string; raw: string }[] = [];
  opens = 0;
  closes = 0;

  /** Return an Error to make that one address fail; undefined to succeed. */
  constructor(private readonly failFor: (to: string) => Error | undefined = () => undefined) {}

  async open(): Promise<MailSession> {
    this.opens++;
    return {
      sendRaw: async (to: string, raw: Uint8Array): Promise<string> => {
        const failure = this.failFor(to);
        if (failure) throw failure;
        this.sent.push({ to, raw: decoder.decode(raw) });
        return "250 2.0.0 Ok: queued as FAKE";
      },
      close: async (): Promise<void> => {
        this.closes++;
      },
    };
  }

  get recipients(): string[] {
    return this.sent.map((s) => s.to);
  }
}

/** A transport whose session cannot be opened at all (SMTP host unreachable). */
export class UnreachableTransport implements MailTransport {
  constructor(private readonly message = "connection refused") {}
  async open(): Promise<MailSession> {
    throw new Error(this.message);
  }
}

export class FakeAppender implements SentAppender {
  readonly folder = "INBOX.Sent";
  readonly appended: string[] = [];
  closes = 0;

  constructor(private readonly fail = false) {}

  async append(message: Uint8Array): Promise<AppendResult> {
    if (this.fail) return { status: "failed", response: "APPEND failed: a3 NO over quota" };
    this.appended.push(decoder.decode(message));
    return { status: "appended", response: "a3 OK [APPENDUID 1 42] APPEND completed" };
  }

  async close(): Promise<void> {
    this.closes++;
  }
}

export function settingsOf(overrides: Settings = {}): Promise<Settings> {
  return loadSettings(env.DB).then((s) => ({ ...s, ...overrides }));
}

export async function setSetting(key: string, value: string): Promise<void> {
  await env.DB.prepare("UPDATE settings SET value = ? WHERE key = ?").bind(value, key).run();
}

export async function testListId(): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM recipient_lists WHERE name = 'suivi-clients'").first<{ id: number }>();
  return row!.id;
}

export async function templateId(name = "test-generic"): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM templates WHERE name = ?").bind(name).first<{ id: number }>();
  return row!.id;
}

export async function insertJob(overrides: Partial<Job> & { name: string }): Promise<Job> {
  const job = {
    display_name: null,
    kind: "digest" as const,
    enabled: 1,
    schedule: "0 6 * * *",
    template_id: await templateId(),
    recipient_list_id: await testListId(),
    cc_recipients_json: "[]",
    condition_sql: null,
    dedupe_strategy: "per_run" as const,
    source: "own" as const,
    preset: "custom" as const,
    ...overrides,
  };
  const row = await env.DB.prepare(
    `INSERT INTO jobs (
       name, display_name, kind, enabled, schedule, template_id,
       recipient_list_id, cc_recipients_json, condition_sql, dedupe_strategy, source, preset
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(
      job.name,
      job.display_name,
      job.kind,
      job.enabled,
      job.schedule,
      job.template_id,
      job.recipient_list_id,
      job.cc_recipients_json,
      job.condition_sql,
      job.dedupe_strategy,
      job.source,
      job.preset,
    )
    .first<{ id: number }>();
  return { id: row!.id, ...job } as Job;
}

export interface SendLogRow {
  job_id: number;
  recipient: string;
  recipient_kind: string;
  dedupe_key: string;
  status: string;
  smtp_response: string | null;
  append_status: string | null;
  append_response: string | null;
}

export async function sendLog(): Promise<SendLogRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT job_id, recipient, recipient_kind, dedupe_key, status, smtp_response, append_status, append_response
       FROM send_log ORDER BY id`,
  ).all<SendLogRow>();
  return results;
}

export interface OutboxSnapshot {
  id: number;
  recipient: string;
  dedupe_key: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  subject: string;
  recipient_kind: string;
  to_recipients_json: string;
  cc_recipients_json: string;
}

export async function outbox(): Promise<OutboxSnapshot[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, recipient, dedupe_key, status, attempts, next_attempt_at, last_error, subject,
            recipient_kind, to_recipients_json, cc_recipients_json
       FROM outbox ORDER BY id`,
  ).all<OutboxSnapshot>();
  return results;
}

/** Makes every queued message due now, undoing a retry backoff. */
export async function makeQueueDue(): Promise<void> {
  await env.DB.prepare(
    "UPDATE outbox SET next_attempt_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 minute') WHERE status = 'pending'",
  ).run();
}

/** Adds a recipient to the seeded "test" list — used to prove the guard blocks
 *  addresses that are legitimately present in the database. */
export async function addRecipient(email: string, name: string | null = null): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO recipient_list_members (list_id, email, display_name, active) VALUES (?, ?, ?, 1)",
  )
    .bind(await testListId(), email, name)
    .run();
}
