-- Belt-and-braces cleanup for messages that may have been queued before the
-- two test addresses were removed from recipient lists in migration 0006.
-- Historical sent rows remain intact as the audit trail.

UPDATE outbox
SET status = 'cancelled',
    last_error = 'recipient removed during Paul handoff'
WHERE status = 'pending'
  AND lower(trim(recipient)) IN ('thomas@leger.run', 'tombionic@gmail.com');

UPDATE send_log
SET status = 'suppressed',
    smtp_response = 'recipient removed during Paul handoff',
    sent_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE status = 'pending'
  AND lower(trim(recipient)) IN ('thomas@leger.run', 'tombionic@gmail.com');
