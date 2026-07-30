-- Production-safe business-owner handoff:
--   - recipient lists in the admin UI become authoritative;
--   - Paul is the sole initial recipient;
--   - both Thomas test addresses are removed everywhere;
--   - jobs and the global stop remain paused for the in-person walkthrough.

INSERT OR IGNORE INTO recipient_list_members (list_id, email, display_name, active)
SELECT id, 'paul.ghafary@sodimo.eu', 'Paul Ghafary', 1
FROM recipient_lists
WHERE name = 'test';

DELETE FROM recipient_list_members
WHERE lower(email) IN ('thomas@leger.run', 'tombionic@gmail.com');

UPDATE recipient_list_members
SET display_name = 'Paul Ghafary', active = 1
WHERE lower(email) = 'paul.ghafary@sodimo.eu';

UPDATE recipient_lists
SET name = 'suivi-clients',
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE name = 'test';

UPDATE settings
SET value = 'off', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE key = 'test_mode';

UPDATE settings
SET value = 'on', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE key = 'kill_switch';

UPDATE jobs
SET enabled = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE name IN ('rapport-nightly', 'paiements-en-retard');
