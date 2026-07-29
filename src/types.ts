/** Bindings and secrets. Hand-written on purpose: `wrangler types` needs
 *  Cloudflare auth, and CI must typecheck without any credentials. */
export interface Env {
  DB: D1Database;
  /** Production sodimo-prod ERP mirror. Logically read-only; see datasource.ts. */
  ERP: D1Database;
  /** Strato mailbox password for rapports@sodimo.eu. `wrangler secret put`. */
  STRATO_SMTP_PASSWORD: string;
  /** Shared secret required by every fetch() endpoint. `wrangler secret put`. */
  TRIGGER_TOKEN: string;
}

export type JobKind = "digest" | "condition";
export type DedupeStrategy = "per_run" | "per_day" | "per_row";
export type DataSourceName = "own" | "erp";
export type JobPreset = "custom" | "sales_daily" | "overdue_30";
export type SendStatus = "pending" | "sent" | "failed" | "suppressed" | "skipped_test_mode";
export type OutboxStatus = "pending" | "sent" | "failed" | "cancelled";
export type AppendStatus = "appended" | "failed" | "skipped";

export interface Job {
  id: number;
  name: string;
  display_name: string | null;
  kind: JobKind;
  enabled: number;
  schedule: string;
  template_id: number;
  recipient_list_id: number;
  condition_sql: string | null;
  dedupe_strategy: DedupeStrategy;
  source: DataSourceName;
  preset: JobPreset;
}

export interface Template {
  id: number;
  name: string;
  subject_fr: string;
  body_html: string;
  body_text: string;
  body_source: string | null;
}

export interface Recipient {
  email: string;
  display_name: string | null;
}

/** A queued message, as the drain reads it back. */
export interface OutboxRow {
  id: number;
  send_log_id: number;
  job_id: number;
  recipient: string;
  recipient_name: string | null;
  dedupe_key: string;
  subject: string;
  body_html: string;
  body_text: string;
  rfc_message_id: string;
  attempts: number;
}

/** Every key is optional because a row can be missing from D1; the guard and
 *  the SMTP config both fail closed on absence rather than assuming a default. */
export type Settings = {
  kill_switch?: string;
  test_mode?: string;
  smtp_host?: string;
  smtp_port?: string;
  from_address?: string;
  from_name?: string;
  /** Empty = authenticate and bounce as from_address. */
  smtp_username?: string;
  /** Empty = replies go to from_address. */
  reply_to?: string;
  ehlo_hostname?: string;
  imap_append?: string;
  imap_host?: string;
  imap_port?: string;
  sent_folder_override?: string;
  drain_batch_size?: string;
} & Record<string, string | undefined>;

/** A row produced by a condition job's SQL, or synthesised for a digest. */
export type DataRow = Record<string, unknown>;

/** What enqueuing one job produced. Shape of the /trigger response body. */
export interface JobResult {
  job: string;
  jobId: number;
  dedupeKeys: string[];
  rowCount: number;
  attempted: number;
  queued: number;
  skipped: number;
  failed: number;
  duplicates: number;
  errors: string[];
}
