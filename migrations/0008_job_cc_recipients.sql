-- Optional visible CC recipients belong to a job, not to its primary list.
-- JSON keeps the ordered set atomic with the rest of the job definition.
ALTER TABLE jobs
  ADD COLUMN cc_recipients_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE send_log
  ADD COLUMN recipient_kind TEXT NOT NULL DEFAULT 'to'
  CHECK (recipient_kind IN ('to', 'cc'));

-- Every SMTP recipient still owns one outbox row for idempotency. These
-- columns snapshot the visible headers so a multi-recipient message can be
-- delivered once per address without producing duplicate CC copies.
ALTER TABLE outbox
  ADD COLUMN recipient_kind TEXT NOT NULL DEFAULT 'to'
  CHECK (recipient_kind IN ('to', 'cc'));

ALTER TABLE outbox
  ADD COLUMN to_recipients_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE outbox
  ADD COLUMN cc_recipients_json TEXT NOT NULL DEFAULT '[]';
