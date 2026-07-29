# auto-email — Specification

Automated email sendings for the Sodimo team: **scheduled digests** (the nightly
report that replaces Sodiwin's emailed Excel files) and **condition-based alerts**
(e.g. an invoice unpaid for ≥30 days). One Cloudflare Worker, one D1 database,
Strato SMTP. Free plan. The audience is non-technical and French — every email
body is French; the code and these docs are English.

Wave 1 (this repo, now) is the engine. Wave 2 adds the French admin UI at
`auto-email.sodimo.eu` behind Cloudflare Access. Wave 3 wires the read-only
`sodimo-prod` ERP mirror in as a condition data source.

## The two hard rules

**1. One choke point, and it is idempotent.** Every outbound email passes through
`src/lib/dispatch.ts#dispatch`, which is the only caller of the SMTP layer in the
codebase. It writes a `send_log` row *before* opening the connection, and
`UNIQUE (job_id, recipient, dedupe_key)` is what enforces the guarantee: **a send
with the same (job_id, recipient, dedupe_key) never goes twice** — not across
retries, not across concurrent isolates, not across a manual trigger racing the
cron. Losing the insert race means someone else owns that send; we stop.

**2. Kill switch.** `settings.kill_switch` stops ALL sending. It is checked at the
top of every cron run, at the top of every manual trigger, and again inside the
choke point for every individual recipient. It **fails closed**: any value other
than exactly `off` — including a missing row — means engaged.

## TEST MODE IS LAW (Wave 1)

Recipients are hard-pinned to `thomas@leger.run` and `tombionic@gmail.com`. The
allowlist is **code** (`src/lib/guard.ts#TEST_MODE_ALLOWLIST`), and
`config.ts#FORCE_TEST_MODE` keeps it in force regardless of the
`settings.test_mode` row, so no database edit can put a real Sodimo address in
play before Wave 2 does it deliberately. Any other recipient is logged
`skipped_test_mode` and never contacted. Production recipient lists exist in the
schema only.

## Stack

| Layer | Choice |
|---|---|
| Runtime | One TypeScript Worker, no framework (two endpoints do not need one) |
| SMTP | `worker-mailer@^1.2` over `cloudflare:sockets`; `nodejs_compat` flag required |
| Transport | `smtp.strato.com:465` implicit TLS, AUTH LOGIN as `rapports@sodimo.eu`. 587 STARTTLS is the fallback, applied by changing `settings.smtp_port` — never automatically (see below). **Port 25 is unavailable on Workers and is refused in code.** |
| From | `Rapports Sodimo <rapports@sodimo.eu>`; password from the `STRATO_SMTP_PASSWORD` Worker secret |
| DB | D1, binding `DB`, database `auto-email`. Plain SQL in `migrations/`, applied by `wrangler d1 migrations apply`. No ORM |
| Tests | `vitest` + `@cloudflare/vitest-pool-workers`, real D1 with migrations applied, SMTP replaced at the `Mailer` interface |
| CI | typecheck + tests on PR/push; `bootstrap.yml` provisions D1; `deploy.yml` deploys and syncs secrets |

There is **no automatic 465→587 retry**. worker-mailer surfaces no way to tell
whether a failure happened before or after `DATA`, so a blind retry could deliver
the same mail twice — and rule 1 outranks availability.

## Data model

Timestamps are ISO-8601 UTC TEXT. See `migrations/0001_init.sql` for the truth.

- **jobs** — `name`, `kind` (`digest|condition`), `enabled`, `schedule` (5-field
  cron, UTC), `template_id`, `recipient_list_id`, `condition_sql` (required for
  `condition`), `dedupe_strategy`.
- **templates** — `subject_fr`, `body_html`, `body_text`.
- **recipient_lists** / **recipient_list_members** — `email`, `display_name`, `active`.
- **send_log** — the idempotency ledger *and* the audit trail. `status` ∈
  `pending | sent | failed | suppressed | skipped_test_mode`, plus
  `smtp_response`, `message_id`. `UNIQUE (job_id, recipient, dedupe_key)`.
- **settings** — `kill_switch`, `test_mode`, `smtp_host`, `smtp_port`,
  `from_address`, `from_name`.

`pending` is an extension to the four statuses in the original brief: insert-first
needs a claim state. A row left `pending` means the isolate died between the SMTP
send and the status update — the mail may or may not have gone out, and no later
run will resend it, because the claim stands. That is deliberate: an unresolved
row an operator can see beats a silent double-send.

## Behaviour

### Fan-out and emptiness

Two columns, two different decisions:

- `dedupe_strategy = 'per_row'` → **one message per matched row** (an alert).
  `condition_sql` must return a non-empty `dedupe_key` column; the key is
  `row:<value>`, so a given invoice alerts exactly once, ever.
- otherwise → **one message per run**, all rows rendered into one table.
  Key is `run:<slot>` (`per_run`) or `day:<YYYY-MM-DD>` (`per_day`).
- `kind = 'condition'` with zero rows sends **nothing**.
- `kind = 'digest'` with zero rows still sends, saying "Aucune donnée à signaler."

Manual triggers use `manual:<ISO-minute>` for `per_run`/`per_day`, so testing a
job neither consumes nor is blocked by its scheduled slot. `per_row` keys are
unaffected — an alert already sent must not be resent because a human pressed a
button.

### scheduled()

Kill switch → enabled jobs whose cron fired in the window this tick covers →
per job: run `condition_sql` (read-only, against auto-email's own D1 in Wave 1)
→ render → resolve recipients → per recipient: `dispatch`. Every recipient is
wrapped in its own try/catch; one failure never aborts the run.

The Worker cron ticks every 5 minutes (`wrangler.jsonc`), and each tick is
matched over the 5 minutes it covers, so **job schedules do not have to align to
tick boundaries**. A malformed `schedule` is reported in the run summary rather
than silently never firing.

Cron subset, UTC only: `*`, `n`, `a-b`, `*/s`, `a-b/s`, comma lists; day-of-week
0-6 with 7 accepted as Sunday; vixie-cron OR semantics when both day fields are
restricted. Names (JAN/MON), `L`, `W`, `#`, `?`, `@daily`, seconds and per-job
timezones are **not** supported and throw.

### fetch()

Both endpoints require the `TRIGGER_TOKEN` shared secret, as `X-Trigger-Token`
or `Authorization: Bearer`. There is no anonymous surface — an unauthenticated
request gets 401 even for an unknown path.

- `POST /trigger/:jobId` — run one job now, by id or name, through the same code
  path as cron. Runs even if the job is disabled (that is the point). 409 while
  the kill switch is engaged, 404 if the job does not exist.
- `GET /healthz` — D1 reachable, required settings present, secrets set, plus
  both switch states and the pinned recipient list. 503 when something is wrong.

No UI. Wave 2 owns that.

### condition_sql

A single read-only `SELECT`/`WITH`, enforced by
`src/lib/datasource.ts#assertReadOnlySql`: comments stripped, no stacked
statements, no write/DDL/transaction keywords, ≤500 rows. **D1 has no read-only
binding mode** — the bindings are ordinary read/write handles, so this guard is
load-bearing for write prevention, not belt-and-braces.

### Templates

`{{var}}` (HTML-escaped in HTML bodies) and `{{{var}}}` (raw). No loops, no
conditionals. Always available: `job_name`, `date_fr`, `generated_at`,
`dashboard_url`, `row_count`, `rows_table_html` (raw), `rows_text`. For `per_row`
jobs, the matched row's columns are variables too.

## Non-goals

No inbound mail, no bounce handling, no open/click tracking, no attachments in
Wave 1, no per-user preferences, no template editor, no queueing beyond D1, no
retry/backoff (a failed send is recorded and left for an operator).
