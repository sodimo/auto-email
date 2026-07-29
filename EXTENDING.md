# Extending auto-email

Read SPEC.md first. This file is the "how", one worked example at a time.

## Add a new alert (normally no code)

Open the French admin UI, choose **Nouvel envoi**, then:

1. Give the sending a plain French name and select a built-in purpose where one
   fits. Built-in purposes own their audited ERP query.
2. Pick a human schedule such as “tous les jours à 07:00”. The UI stores UTC
   cron internally; business users never type it.
3. Select a template and recipient list. Templates expose their available
   `{{variables}}` and compile the friendly source into safe HTML and text.
4. Save it paused, use **Tester maintenant**, inspect **Historique** for both
   SMTP and Sent-folder status, then enable it.

Deep links make a Claude-guided handoff precise:

```text
/?section=jobs&action=new-job
/?section=templates&action=new-template
/?section=recipients&action=new-list
/?section=history
/?section=safety
```

The **Options avancées** editor exists for a genuinely new condition. Its SQL
must be one read-only `SELECT`/`WITH`; choose the operational or ERP source.
`per_row` jobs must return a non-empty `dedupe_key` and alert once per key.
`per_day` sends at most once per UTC date, and `per_run` once per scheduled
slot. The read-only guard and 500-row limit always apply.

Manual tests for `per_day`/`per_run` use a `manual:<ISO-minute>` key and do not
consume the scheduled slot. `per_row` deliberately does not bypass an already
claimed business key.

## Add a variable to templates

`src/runner.ts#baseVars` is the whole bag. Add the key there and it is available
to every template; renderers report unknown names in `RenderResult.missing`
rather than throwing, so an old template keeps working.

## Add an endpoint

Add a legacy route in `src/index.ts` after `authorize()`, or an admin route in
`src/admin/routes.ts`. There is no anonymous surface and no framework. Mutating
admin routes must keep the same-origin CSRF checks. If an endpoint sends mail it
must go through `runJobById`/`runJob` and `drainOutbox`, never near a
`MailTransport` directly.

## Change what may be sent

Test mode is still forced. Widening recipients requires a separate production
readiness decision: Cloudflare Access must already protect the custom domain,
operators must confirm recipient lists and volumes, and the change to
`config.ts#FORCE_TEST_MODE` must be reviewed explicitly. `TEST_MODE_ALLOWLIST`
stays as the test-mode target. Do not edit either to unblock a test — inject a
fake `MailTransport` instead, the way `tests/helpers.ts` does.

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

## Add or change ERP-derived content

The `ERP` binding already points at `sodimo-prod`. The NAS ETL is frozen and
remains the sole owner: do not change it, request a new mirrored table, add ERP
migrations, or execute a write.

For a reusable non-technical choice, add the canonical read-only query to
`src/lib/job-presets.ts` and expose its preset in the admin service/view. Reuse
the dashboard's established field meanings and business rules. Every ERP run
must retain both `assertReadOnlySql` and `assertErpReady`; the latter prevents
sending while the nightly table replacements are incomplete or stale.

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
