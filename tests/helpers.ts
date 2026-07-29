import { env } from "cloudflare:test";
import type { Mailer, MailerResult, OutboundMessage } from "../src/lib/mailer.js";
import { loadSettings } from "../src/lib/db.js";
import type { Job, Settings } from "../src/types.js";

/** The SMTP seam, replaced. No test opens a socket. */
export class FakeMailer implements Mailer {
  readonly sent: OutboundMessage[] = [];
  /** Return an Error to make that one address fail; undefined to succeed. */
  constructor(private readonly failFor: (message: OutboundMessage) => Error | undefined = () => undefined) {}

  async send(message: OutboundMessage): Promise<MailerResult> {
    const failure = this.failFor(message);
    if (failure) throw failure;
    this.sent.push(message);
    return { messageId: message.messageId, response: "250 fake accepted" };
  }

  get recipients(): string[] {
    return this.sent.map((m) => m.to.email);
  }
}

export function settingsOf(overrides: Settings = {}): Promise<Settings> {
  return loadSettings(env.DB).then((s) => ({ ...s, ...overrides }));
}

export async function setSetting(key: string, value: string): Promise<void> {
  await env.DB.prepare("UPDATE settings SET value = ? WHERE key = ?").bind(value, key).run();
}

export async function testListId(): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM recipient_lists WHERE name = 'test'").first<{ id: number }>();
  return row!.id;
}

export async function templateId(name = "rapport-quotidien"): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM templates WHERE name = ?").bind(name).first<{ id: number }>();
  return row!.id;
}

export async function insertJob(overrides: Partial<Job> & { name: string }): Promise<Job> {
  const job = {
    kind: "digest" as const,
    enabled: 1,
    schedule: "0 6 * * *",
    template_id: await templateId(),
    recipient_list_id: await testListId(),
    condition_sql: null,
    dedupe_strategy: "per_run" as const,
    ...overrides,
  };
  const row = await env.DB.prepare(
    `INSERT INTO jobs (name, kind, enabled, schedule, template_id, recipient_list_id, condition_sql, dedupe_strategy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(
      job.name,
      job.kind,
      job.enabled,
      job.schedule,
      job.template_id,
      job.recipient_list_id,
      job.condition_sql,
      job.dedupe_strategy,
    )
    .first<{ id: number }>();
  return { id: row!.id, ...job } as Job;
}

export async function sendLog(): Promise<
  { job_id: number; recipient: string; dedupe_key: string; status: string; smtp_response: string | null }[]
> {
  const { results } = await env.DB.prepare(
    "SELECT job_id, recipient, dedupe_key, status, smtp_response FROM send_log ORDER BY id",
  ).all<{ job_id: number; recipient: string; dedupe_key: string; status: string; smtp_response: string | null }>();
  return results;
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
