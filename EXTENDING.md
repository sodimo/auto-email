# Extending auto-email

Read SPEC.md first. This file is the "how", one worked example at a time.

## Add a new alert (no code)

Most new sendings are three rows, not a deploy. Say: warn when an invoice has
been unpaid for 30 days or more, once per invoice, checked every morning at
07:00 UTC.

1. **Template** — French subject and both bodies. `per_row` jobs get the matched
   row's columns as variables on top of the standard bag (`job_name`, `date_fr`,
   `generated_at`, `dashboard_url`, `row_count`, `rows_table_html`, `rows_text`).

   ```sql
   INSERT INTO templates (name, subject_fr, body_html, body_text) VALUES (
     'facture-impayee',
     'Facture {{numero}} impayée depuis {{jours}} jours',
     '<p>La facture <strong>{{numero}}</strong> ({{client}}, {{montant}} €) est impayée depuis {{jours}} jours.</p>',
     'Facture {{numero}} ({{client}}, {{montant}} EUR) impayée depuis {{jours}} jours.'
   );
   ```

2. **Job** — `condition` kind, `per_row` dedupe. The SQL **must** return a
   `dedupe_key` column; its value is what makes the alert fire once and never
   again for that invoice.

   ```sql
   INSERT INTO jobs (name, kind, enabled, schedule, template_id, recipient_list_id, condition_sql, dedupe_strategy)
   SELECT 'factures-impayees', 'condition', 0, '0 7 * * *', t.id, l.id,
          'SELECT numero AS dedupe_key, numero, client, montant, jours FROM factures WHERE jours >= 30',
          'per_row'
   FROM templates t, recipient_lists l WHERE t.name = 'facture-impayee' AND l.name = 'test';
   ```

3. **Test it before enabling.** The job ships `enabled = 0`; a manual trigger
   runs it anyway, under a `manual:` dedupe key that does not consume the
   scheduled slot.

   ```sh
   curl -s -X POST -H "X-Trigger-Token: $TOKEN" "$BASE/trigger/factures-impayees"
   ```

   Check `send_log`, then `UPDATE jobs SET enabled = 1 WHERE name = '…'`.

Choosing a dedupe strategy: `per_row` for "alert once about this thing",
`per_day` for "one of these per day whatever happens", `per_run` for "once per
scheduled slot".

## Add a variable to templates

`src/runner.ts#baseVars` is the whole bag. Add the key there and it is available
to every template; renderers report unknown names in `RenderResult.missing`
rather than throwing, so an old template keeps working.

## Add an endpoint

Add the route in `src/index.ts`, after `authorize()`. There is no anonymous
surface and no framework — the router is a couple of `if`s, deliberately. If an
endpoint sends mail it must go through `runJobById`/`runJob` and `drainOutbox`,
never near a `MailTransport` directly.

## Change what may be sent

Widening recipients is a Wave 2 decision, not a convenience. It means flipping
`config.ts#FORCE_TEST_MODE` to `false` and handing control to the
`settings.test_mode` row, with the admin UI and Cloudflare Access in front of
it. `TEST_MODE_ALLOWLIST` stays as the test-mode target. Do not edit either to
unblock a test — inject a fake `MailTransport` instead, the way
`tests/helpers.ts` does.

## Tune throughput

`settings.drain_batch_size` (default 10, hard-capped at 25 by
`config.ts#MAX_DRAIN_BATCH`) is how many messages one invocation sends. The cap
exists because a free-plan invocation gets ~10ms of CPU. Raising the tick rate
in `wrangler.jsonc` means raising `config.ts#TICK_MINUTES` to match, or jobs
will fire more than once per slot — the dedupe ledger will catch it, but the
run summaries will be full of duplicates.

Attachments would blow the CPU budget and are the intended trigger for the
paid-plan conversation, not a quiet addition. The vendored client has the code
removed; re-adding it is a deliberate vendor patch.

## Update the vendored SMTP client

`vendor/worker-mailer/` is worker-mailer v1.2.1 with three patches and several
removals, all listed in its README. There is no npm dependency to bump: diff
against upstream `v1.2.1` and re-apply. `tests/vendor-mailer.test.ts` pins the
behaviour that matters — if it fails after an update, a patch was lost. The
EHLO hostname is the one that fails silently in production, so treat that test
as a tripwire, not a nuisance.

## Wire the ERP mirror (Wave 3)

1. Add the second D1 binding to `wrangler.jsonc`: `ERP` / `sodimo-prod`, with
   **no** `migrations_dir` — the NAS ETL owns that database.
2. Add a `source` column to `jobs` (`'own' | 'erp'`, default `'own'`).
3. Take the branch already written in `src/lib/datasource.ts#resolveDataSource`.
   It is commented out on purpose so that adding the binding alone cannot
   redirect existing jobs.
4. `assertReadOnlySql` applies unchanged and must keep applying — the ERP
   binding is a read/write handle like any other.

## Add a test

`tests/helpers.ts` gives you `FakeTransport` (records the raw bytes, can fail a
chosen address), `UnreachableTransport`, `FakeAppender`, `insertJob`,
`addRecipient`, `setSetting`, `sendLog`, `outbox` and `makeQueueDue`. For
protocol-level work, `tests/mock-socket.ts` scripts a whole SMTP or IMAP
dialogue in memory — that is how the EHLO patch and the IMAP synchronizing
literal are tested.

No test opens a socket, and `tests/setup.ts` points `smtp_host`/`imap_host` at
`127.0.0.1` so an accidental real connection fails locally instead of reaching
Strato. Reset any new table, fixture **or settings row** in that file's
`beforeEach` — a setting one test tunes silently becomes the next test's
premise otherwise.
