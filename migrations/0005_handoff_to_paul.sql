-- Move the second forced-test recipient from Tom's personal inbox to Paul,
-- the Sodimo business owner receiving the 2026-07-30 operating handoff.
-- Keep Thomas on the list so the first controlled runs have two observers.

INSERT OR IGNORE INTO recipient_list_members (list_id, email, display_name, active)
SELECT id, 'paul.ghafary@sodimo.eu', 'Paul Ghafary', 1
FROM recipient_lists
WHERE name = 'test';

UPDATE recipient_list_members
SET display_name = 'Paul Ghafary', active = 1
WHERE list_id = (SELECT id FROM recipient_lists WHERE name = 'test')
  AND email = 'paul.ghafary@sodimo.eu';

DELETE FROM recipient_list_members
WHERE list_id = (SELECT id FROM recipient_lists WHERE name = 'test')
  AND email = 'tombionic@gmail.com';

UPDATE recipient_lists
SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE name = 'test';
