/** Bindings and secrets. Hand-written on purpose: `wrangler types` needs
 *  Cloudflare auth, and CI must typecheck without any credentials. */
export interface Env {
  DB: D1Database;
  /** Strato mailbox password for rapports@sodimo.eu. `wrangler secret put`. */
  STRATO_SMTP_PASSWORD: string;
  /** Shared secret required by every fetch() endpoint. `wrangler secret put`. */
  TRIGGER_TOKEN: string;
  /** WAVE 3 SEAM: read-only sodimo-prod ERP mirror. Absent in Wave 1. */
  ERP?: D1Database;
}

export type JobKind = "digest" | "condition";
export type DedupeStrategy = "per_run" | "per_day" | "per_row";
export type SendStatus = "pending" | "sent" | "failed" | "suppressed" | "skipped_test_mode";

export interface Job {
  id: number;
  name: string;
  kind: JobKind;
  enabled: number;
  schedule: string;
  template_id: number;
  recipient_list_id: number;
  condition_sql: string | null;
  dedupe_strategy: DedupeStrategy;
}

export interface Template {
  id: number;
  name: string;
  subject_fr: string;
  body_html: string;
  body_text: string;
}

export interface Recipient {
  email: string;
  display_name: string | null;
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
} & Record<string, string | undefined>;

/** A row produced by a condition job's SQL, or synthesised for a digest. */
export type DataRow = Record<string, unknown>;

/** What the runner reports back per job. Shape is the /trigger response body. */
export interface JobResult {
  job: string;
  jobId: number;
  dedupeKeys: string[];
  rowCount: number;
  attempted: number;
  sent: number;
  skipped: number;
  failed: number;
  duplicates: number;
  errors: string[];
}
