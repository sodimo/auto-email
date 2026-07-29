-- auto-email schema. Applied by `wrangler d1 migrations apply auto-email`.
-- All timestamps are ISO-8601 UTC TEXT (`YYYY-MM-DDTHH:MM:SSZ`).

CREATE TABLE templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  subject_fr  TEXT NOT NULL,
  body_html   TEXT NOT NULL,
  body_text   TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE recipient_lists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE recipient_list_members (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id       INTEGER NOT NULL REFERENCES recipient_lists(id),
  email         TEXT NOT NULL,
  display_name  TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  UNIQUE (list_id, email)
);

CREATE TABLE jobs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL UNIQUE,
  kind              TEXT NOT NULL CHECK (kind IN ('digest', 'condition')),
  enabled           INTEGER NOT NULL DEFAULT 0,
  -- Standard 5-field cron, UTC. See src/lib/cron.ts for the supported subset.
  schedule          TEXT NOT NULL,
  template_id       INTEGER NOT NULL REFERENCES templates(id),
  recipient_list_id INTEGER NOT NULL REFERENCES recipient_lists(id),
  -- Required for kind='condition': a single read-only SELECT/WITH statement.
  -- Rows it returns drive the send; for dedupe_strategy='per_row' it MUST
  -- return a `dedupe_key` column.
  condition_sql     TEXT,
  dedupe_strategy   TEXT NOT NULL DEFAULT 'per_run'
                    CHECK (dedupe_strategy IN ('per_run', 'per_day', 'per_row')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CHECK (kind <> 'condition' OR condition_sql IS NOT NULL)
);

-- The idempotency ledger AND the audit log. A row is claimed at ENQUEUE time,
-- before any SMTP work exists, and the UNIQUE constraint is what makes "same
-- (job, recipient, dedupe_key) never goes twice" true even across concurrent
-- runs, retries, and a manual trigger racing the cron. See src/lib/enqueue.ts.
CREATE TABLE send_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          INTEGER NOT NULL REFERENCES jobs(id),
  recipient       TEXT NOT NULL,
  dedupe_key      TEXT NOT NULL,
  -- 'pending' means "claimed and queued in the outbox"; the drain overwrites
  -- it with a terminal status.
  status          TEXT NOT NULL
                  CHECK (status IN ('pending', 'sent', 'failed', 'suppressed', 'skipped_test_mode')),
  smtp_response   TEXT,
  message_id      TEXT,
  -- The Sent-folder copy is tracked SEPARATELY: a failed IMAP APPEND must
  -- never make a delivered email count as failed.
  append_status   TEXT CHECK (append_status IN ('appended', 'failed', 'skipped')),
  append_response TEXT,
  sent_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (job_id, recipient, dedupe_key)
);

CREATE INDEX idx_send_log_job_time ON send_log (job_id, sent_at);

-- The work queue. Cron ENQUEUEs (cheap: render once, insert rows) and a
-- separate frequent drain sends a small batch per invocation. This split
-- exists because the Workers free plan allows ~10ms CPU per invocation, which
-- a whole run of SMTP sends would blow through.
CREATE TABLE outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  -- One outbox row per ledger row: the ledger owns idempotency, this owns work.
  send_log_id     INTEGER NOT NULL UNIQUE REFERENCES send_log(id),
  job_id          INTEGER NOT NULL REFERENCES jobs(id),
  recipient       TEXT NOT NULL,
  recipient_name  TEXT,
  dedupe_key      TEXT NOT NULL,
  -- The rendered message. Templates are interpolated ONCE, at enqueue.
  subject         TEXT NOT NULL,
  body_html       TEXT NOT NULL,
  body_text       TEXT NOT NULL,
  rfc_message_id  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_outbox_due ON outbox (status, next_attempt_at, id);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

INSERT INTO settings (key, value) VALUES
  ('kill_switch',          'off'),
  ('test_mode',            'on'),
  ('smtp_host',            'smtp.strato.com'),
  ('smtp_port',            '465'),
  ('from_address',         'rapports@sodimo.eu'),
  ('from_name',            'Rapports Sodimo'),
  -- Empty = authenticate (and bounce) as from_address. Set this to send as a
  -- DIFFERENT From: than the mailbox that authenticates — e.g. From:
  -- facturation@ over rapports@ credentials. Whether Strato permits that is
  -- unverified; the fallback is From: rapports@ with reply_to set instead.
  ('smtp_username',        ''),
  -- Empty = replies go to from_address.
  ('reply_to',             ''),
  -- Announced in EHLO. NOT cosmetic: with the library's hardcoded 127.0.0.1,
  -- Strato answers 250 queued and then silently drops mail to same-provider
  -- recipients — i.e. every @sodimo.eu address.
  ('ehlo_hostname',        'sodimo.eu'),
  -- Sent-folder copies, so the team sees automated mail in Strato webmail.
  ('imap_append',          'on'),
  ('imap_host',            'imap.strato.com'),
  ('imap_port',            '993'),
  -- Empty = discover the \Sent mailbox via LIST (SPECIAL-USE).
  ('sent_folder_override', ''),
  -- Messages sent per drain invocation. Keep it small: 10ms CPU per run.
  ('drain_batch_size',     '10');
