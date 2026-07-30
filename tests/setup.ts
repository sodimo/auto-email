import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";
import { NIGHTLY_DIGEST_SQL, OVERDUE_PAYMENTS_SQL } from "../src/lib/job-presets.js";

if (!env.TEST_MIGRATIONS) throw new Error("TEST_MIGRATIONS binding missing — check vitest.config.ts");
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Fixture table standing in for the future read-only ERP mirror, so condition
// jobs have something real to SELECT from. Not part of the schema.
await env.DB.exec(
  "CREATE TABLE IF NOT EXISTS test_invoices (numero TEXT, client TEXT, montant REAL, jours INTEGER)",
);
await env.DB.prepare(
  `INSERT OR IGNORE INTO templates (name, subject_fr, body_html, body_text, body_source)
   VALUES (
     'test-generic',
     'Rapport quotidien Sodimo — {{date_fr}}',
     '<p>{{{rows_table_html}}}</p>',
     '{{rows_text}}',
     '{{rows_text}}'
   )`,
).run();
await env.ERP.exec(
  "CREATE TABLE IF NOT EXISTS test_erp_rows (id INTEGER PRIMARY KEY, label TEXT)",
);

// Each test FILE gets its own Worker + D1; within a file, storage persists
// across tests, so reset to the seeded state between them.
beforeEach(async () => {
  await env.DB.batch([
    // outbox references send_log, so it goes first.
    env.DB.prepare("DELETE FROM outbox"),
    env.DB.prepare("DELETE FROM send_log"),
    env.DB.prepare("DELETE FROM test_invoices"),
    env.DB.prepare("DELETE FROM sqlite_sequence WHERE name IN ('send_log', 'outbox')"),
    env.DB.prepare("DELETE FROM jobs WHERE name NOT IN ('rapport-nightly', 'paiements-en-retard')"),
    env.DB.prepare(
      `UPDATE jobs
          SET enabled = 0, schedule = '0 6 * * *', kind = 'digest',
              condition_sql = ?, dedupe_strategy = 'per_day',
              source = 'erp', preset = 'sales_daily'
        WHERE name = 'rapport-nightly'`,
    ).bind(NIGHTLY_DIGEST_SQL),
    env.DB.prepare(
      `UPDATE jobs
          SET enabled = 0, schedule = '0 7 * * 1', kind = 'condition',
              condition_sql = ?, dedupe_strategy = 'per_day',
              source = 'erp', preset = 'overdue_30'
        WHERE name = 'paiements-en-retard'`,
    ).bind(OVERDUE_PAYMENTS_SQL),
    env.DB.prepare(
      "DELETE FROM templates WHERE name NOT IN ('rapport-quotidien', 'echeances-retard', 'test-generic')",
    ),
    // Back to exactly the two seeded, active members — a recipient added by one
    // test must not still be on the list for the next one.
    env.DB.prepare(
      "DELETE FROM recipient_list_members WHERE email NOT IN ('thomas@leger.run', 'paul.ghafary@sodimo.eu')",
    ),
    env.DB.prepare("UPDATE recipient_list_members SET active = 1"),
    env.DB.prepare("DELETE FROM recipient_lists WHERE name <> 'test'"),
    // Every setting a test may touch goes back to its seeded value, or one
    // test's tuning silently becomes the next test's premise.
    env.DB.prepare("UPDATE settings SET value = 'off' WHERE key = 'kill_switch'"),
    env.DB.prepare("UPDATE settings SET value = 'on' WHERE key = 'test_mode'"),
    env.DB.prepare("UPDATE settings SET value = 'on' WHERE key = 'imap_append'"),
    env.DB.prepare("UPDATE settings SET value = '10' WHERE key = 'drain_batch_size'"),
    env.DB.prepare("UPDATE settings SET value = '' WHERE key = 'sent_folder_override'"),
    env.DB.prepare("UPDATE settings SET value = 'sodimo.eu' WHERE key = 'ehlo_hostname'"),
    env.DB.prepare("UPDATE settings SET value = '' WHERE key = 'smtp_username'"),
    env.DB.prepare("UPDATE settings SET value = '' WHERE key = 'reply_to'"),
    env.DB.prepare("UPDATE settings SET value = 'rapports@sodimo.eu' WHERE key = 'from_address'"),
    env.DB.prepare("UPDATE settings SET value = 'Rapports Sodimo' WHERE key = 'from_name'"),
    // Belt and braces: no test may ever reach smtp.strato.com or imap.strato.com.
    env.DB.prepare("UPDATE settings SET value = '127.0.0.1' WHERE key = 'smtp_host'"),
    env.DB.prepare("UPDATE settings SET value = '127.0.0.1' WHERE key = 'imap_host'"),
  ]);
  await env.ERP.prepare("DELETE FROM test_erp_rows").run();
});
