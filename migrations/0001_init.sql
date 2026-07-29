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

-- The idempotency ledger AND the audit log. Every outbound attempt claims a row
-- here BEFORE the SMTP dialogue (insert-first); the UNIQUE constraint is what
-- makes "same (job, recipient, dedupe_key) never goes twice" true even across
-- concurrent or retried runs. See src/lib/dispatch.ts.
CREATE TABLE send_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         INTEGER NOT NULL REFERENCES jobs(id),
  recipient      TEXT NOT NULL,
  dedupe_key     TEXT NOT NULL,
  -- 'pending' is the claim state written by the insert-first step; it is
  -- overwritten by a terminal status once the attempt resolves. A row still
  -- 'pending' long after sent_at means the isolate died mid-send.
  status         TEXT NOT NULL
                 CHECK (status IN ('pending', 'sent', 'failed', 'suppressed', 'skipped_test_mode')),
  smtp_response  TEXT,
  message_id     TEXT,
  sent_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (job_id, recipient, dedupe_key)
);

CREATE INDEX idx_send_log_job_time ON send_log (job_id, sent_at);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

INSERT INTO settings (key, value) VALUES
  ('kill_switch',  'off'),
  ('test_mode',    'on'),
  ('smtp_host',    'smtp.strato.com'),
  ('smtp_port',    '465'),
  ('from_address', 'rapports@sodimo.eu'),
  ('from_name',    'Rapports Sodimo');
