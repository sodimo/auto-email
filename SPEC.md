# auto-email — Specification

Automated email sendings for the Sodimo team: **scheduled digests** (the nightly
report that replaces Sodiwin's emailed Excel files) and **condition-based alerts**
(e.g. an invoice unpaid for ≥30 days). One Cloudflare Worker, its operational D1
database, and a logically read-only binding to the production ERP mirror;
Strato SMTP + IMAP. **Free plan.** The audience is non-technical and French —
every email body is French; the code and these docs are English.

Wave 2 is implemented. The same Worker serves the French admin UI and sending
engine. `auto-email.sodimo.eu` is attached by a manual CI workflow and will sit
behind Cloudflare Access; until that policy is installed, every route is
protected by the Worker's fail-closed shared-secret authentication.

## The two hard rules

**1. One choke point per direction, and it is idempotent.** Nothing enters the
outbox except through `src/lib/enqueue.ts`, and nothing reaches SMTP except
through `src/lib/drain.ts`. Enqueue writes a `send_log` row *before* any message
exists, and `UNIQUE (job_id, recipient, dedupe_key)` is what enforces the
guarantee: **a send with the same (job_id, recipient, dedupe_key) never goes
twice** — not across retries, not across concurrent isolates, not across a
manual trigger racing the cron. Losing the insert race means someone else owns
that send; we stop.

**2. Kill switch.** `settings.kill_switch` stops ALL sending. It is checked at
the top of every cron run, every manual trigger and every drain, and again per
recipient inside both choke points. It **fails closed**: any value other than
exactly `off` — including a missing row — means engaged. An engaged switch
*holds* the queue rather than cancelling it; turning it off resumes exactly
where it stopped.

## TEST MODE IS LAW

Recipients are hard-pinned to `thomas@leger.run` and `tombionic@gmail.com`. The
allowlist is **code** (`src/lib/guard.ts#TEST_MODE_ALLOWLIST`), and
`config.ts#FORCE_TEST_MODE` keeps it in force regardless of the
`settings.test_mode` row, so no database edit or UI action can put a real
Sodimo address in play. Any other recipient is logged
`skipped_test_mode` and never contacted — at enqueue, and again at drain, so a
message queued before the rule tightened is cancelled rather than sent.
Recipient lists can be prepared in the UI, but test mode remains forced until a
separate, explicit production-readiness change.

## The sharded outbox, and why

A Workers **free-plan invocation gets ~10ms of CPU**. A whole run of sends does
not fit, so the work is split:

- **Cron enqueues.** Render each message once, claim its ledger row, write it to
  `outbox`. Cheap, and bounded by the number of recipients.
- **A frequent drain sends.** Every 5-minute tick takes at most
  `settings.drain_batch_size` (default 10, hard cap 25) queued messages and
  sends them over ONE SMTP session (Strato allows 1000 messages per connection).

Both halves run on the same tick, in that order. `POST /trigger/:jobId` and
`POST /drain` reuse exactly the same functions.

### Retry policy

A queued message is re-attempted **only when the SMTP client can prove the bytes
never reached the server's queue** — `SmtpError.retryable`, true for a 4xx reply
or a failure before the body was flushed, false for a 5xx and for any failure
after the body went out with no reply at all. Backoff is 5, 15 then 60 minutes,
up to `MAX_SEND_ATTEMPTS` (4), after which the message is `failed` and left for
an operator. A failure whose delivery cannot be ruled out is terminal on the
first attempt: a duplicate would break hard rule 1.

If the SMTP *session* cannot be opened at all, no attempt is charged and the rows
stay queued — a transient outage must not burn the retry budget. That shows up
as a growing `outbox.pending` in `/healthz`.

## Stack

| Layer | Choice |
|---|---|
| Runtime | One TypeScript Worker, no framework, **no runtime npm dependencies** |
| SMTP | `vendor/worker-mailer` — worker-mailer v1.2.1 vendored and patched (see its README); uses `cloudflare:sockets`, so `nodejs_compat` is required |
| Transport | `smtp.strato.com:465` implicit TLS, `authType: ['plain','login']` stated explicitly (the library has no working default). 587 STARTTLS is the fallback, applied by changing `settings.smtp_port`, never automatically. **Port 25 is unavailable on Workers and is refused in code.** |
| EHLO | `settings.ehlo_hostname` = `sodimo.eu`. Not cosmetic — see below |
| From | `Rapports Sodimo <rapports@sodimo.eu>`; password from the `STRATO_SMTP_PASSWORD` Worker secret |
| Sent copies | IMAP APPEND to the discovered `\Sent` mailbox at `imap.strato.com:993` (`src/lib/imap-append.ts`, hand-rolled) |
| Operational DB | D1 binding `DB`, database `auto-email`. Plain SQL in `migrations/`. No ORM |
| ERP mirror | D1 binding `ERP`, database `sodimo-prod` (`c7552dfa-d55e-4a29-9510-9ab25109e952`). The frozen `sodimo/etl` remains its sole writer; auto-email runs guarded `SELECT` queries only |
| Tests | `vitest` + `@cloudflare/vitest-pool-workers`, real D1 with migrations applied; SMTP and IMAP driven against a scripted mock socket, never a network |

### EHLO is load-bearing

The upstream library hardcodes `EHLO 127.0.0.1`. Strato accepts the message with
`250 queued` and then **silently drops it** when the recipient is on the same
provider — which is every `@sodimo.eu` address. The Worker announces
`settings.ehlo_hostname`, and **refuses to build an SMTP config when that
setting is missing**, because a default here fails silently rather than loudly.

### BCC does not exist

Upstream's `bcc` option writes a literal `BCC:` header, exposing every recipient
to all of them. It is deleted from the vendored copy, along with `cc`, so it
cannot be reached by mistake. auto-email sends one message per recipient anyway.

## Data model

Timestamps are ISO-8601 UTC TEXT. See all files in `migrations/` for the truth.

- **jobs** — `name`, `display_name`, `kind` (`digest|condition`), `enabled`,
  `schedule` (5-field cron, UTC), `template_id`, `recipient_list_id`,
  `condition_sql`, `dedupe_strategy`, `source` (`own|erp`) and `preset`
  (`custom|sales_daily|overdue_30`). The admin UI converts four
  human-readable schedule forms to cron; it never asks a business user to type
  cron.
- **templates** — `subject_fr`, friendly editable `body_source`, and the
  generated MIME alternatives `body_html`/`body_text`.
- **recipient_lists** / **recipient_list_members** — `email`, `display_name`, `active`.
- **send_log** — the idempotency ledger *and* the audit trail. `status` ∈
  `pending | sent | failed | suppressed | skipped_test_mode`, plus
  `smtp_response` and `message_id`, and — tracked **separately** —
  `append_status` ∈ `appended | failed | skipped` with `append_response` (the
  `[APPENDUID …]` line). `UNIQUE (job_id, recipient, dedupe_key)`.
- **outbox** — the work queue: one row per claimed ledger row, carrying the
  rendered `subject`/`body_html`/`body_text`, `rfc_message_id`, `status` ∈
  `pending | sent | failed | cancelled`, `attempts`, `next_attempt_at`,
  `last_error`.
- **settings** — `kill_switch`, `test_mode`, `smtp_host`, `smtp_port`,
  `from_address`, `from_name`, `ehlo_hostname`, `imap_append`, `imap_host`,
  `imap_port`, `sent_folder_override`, `drain_batch_size`.

`send_log.status = 'pending'` means "claimed and queued"; the drain overwrites it
with a terminal status.

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
per job: select the declared `own` or `erp` data source, run `condition_sql`
(read-only) → render once → resolve recipients → per recipient: `enqueue`. Then
drain a batch. Every recipient is wrapped in its own try/catch at both stages;
one failure never aborts the run.

Before any ERP query, readiness must pass: all four required tables have
conservative row-count floors, share the same non-null `loaded_at`, that load
has settled for at least 10 minutes and is no older than 36 hours, and at least
one `VF` sales day exists. A failed gate sends nothing and reports 503 for a
manual trigger. This prevents a digest from observing the nightly ETL between
its table-by-table replacements.

The Worker cron ticks every 5 minutes (`wrangler.jsonc`), and each tick is
matched over the 5 minutes it covers, so **job schedules do not have to align to
tick boundaries**. A malformed `schedule` is reported in the run summary rather
than silently never firing.

Cron subset, UTC only: `*`, `n`, `a-b`, `*/s`, `a-b/s`, comma lists; day-of-week
0-6 with 7 accepted as Sunday; vixie-cron OR semantics when both day fields are
restricted. Names (JAN/MON), `L`, `W`, `#`, `?`, `@daily`, seconds and per-job
timezones are **not** supported and throw.

### Sent-folder copies

After each successful send, the **same bytes** are APPENDed to the mailbox's Sent
folder so the team sees automated mail in Strato webmail. The message is built
once and handed to both paths; building it twice would archive a copy differing
from the one delivered, down to the MIME boundary and `Date`.

The folder is **discovered**, never assumed: `LIST (SPECIAL-USE) "" "*"` and the
`\Sent` attribute (the display name is localised), with
`settings.sent_folder_override` as an escape hatch. APPEND uses a
**synchronizing literal** — the octet count (`TextEncoder`, not `String.length`)
goes out, the `+` continuation is awaited, and only then the bytes; the server
advertises no LITERAL+, so a client that writes early hangs until the timeout.

**A failed copy never fails the send.** The email is already delivered; the
outcome is recorded in `append_status`/`append_response` and nowhere else.

### Admin UI and fetch()

Every route requires `TRIGGER_TOKEN`. Automation can present it as
`X-Trigger-Token` or `Authorization: Bearer`; a browser uses HTTP Basic with
username `sodimo` and the token as password. There is no login page and no
anonymous route — an unauthenticated request gets 401 even for an unknown path.
State-changing browser requests also enforce same-origin/Sec-Fetch checks.

- `GET /` and `GET /admin` — French, responsive administration UI: jobs,
  friendly schedules, templates and variables, recipient lists, send/append
  history, failures, and the prominent kill switch.
- `/api/admin/*` — the authenticated UI's CRUD and test actions. A test action
  reuses `runJobById` and `drainOutbox`; it is not another send path.

- `POST /trigger/:jobId` — enqueue one job now, by id or name, then drain, so a
  manual test is one command. Runs even if the job is disabled (that is the
  point). 409 while the kill switch is engaged, 404 if the job does not exist.
- `POST /drain` — drain the queue without enqueueing anything.
- `GET /healthz` — both D1 bindings reachable, required settings present,
  secrets set, both switch states, the pinned recipient list, and the queue
  backlog. 503 when something is wrong.

### condition_sql

A single read-only `SELECT`/`WITH`, enforced by
`src/lib/datasource.ts#assertReadOnlySql`: comments stripped, no stacked
statements, no write/DDL/transaction keywords, ≤500 rows. **D1 has no read-only
binding mode** — the bindings are ordinary read/write handles, so this guard is
load-bearing for write prevention, not belt-and-braces.

### Built-in ERP jobs

- **`rapport-nightly`** — every day at 06:00 UTC, `per_day`. It finds the
  latest loaded `VF` sales day, then reports revenue (`qte × pvnet`), gross
  margin (`qte × (pvnet − pmpa)`), margin rate, prior-day revenue change,
  documents, clients and quantity, with a dashboard link.
- **`paiements-en-retard`** — every Monday at 07:00 UTC, `per_day`. It derives
  client identity through the frozen loader's actual
  `fact_echeances.numdoc → fact_reglements.numreg` relationship, with
  `fact_ventes.numdoc` as a compatibility fallback; nets available payments at
  client level FIFO against the oldest due items; selects remaining amounts at
  least 30 days overdue; and sends one internal summary capped at 100 clients.
  Because the mirror cannot map a payment to a specific invoice, the email
  labels this as an estimate that does not replace accounting reconciliation.
  Weekly scheduling plus daily slot dedupe prevents the same population from
  re-alerting every day.

Both are seeded disabled so the first real sends are deliberate; operators
enable them after verification.

### Templates

`{{var}}` (HTML-escaped in HTML bodies) and `{{{var}}}` (raw). No loops, no
conditionals. Always available: `job_name`, `date_fr`, `generated_at`,
`dashboard_url`, `row_count`, `rows_table_html` (raw), `rows_text`. For
single-row digests and `per_row` jobs, the row's columns are variables too.
The admin editor accepts a friendly plain-text source and compiles safe,
responsive HTML plus a text alternative.

## Non-goals

**No attachments in v1.** They are the thing that would push this onto a paid
plan, so they are the deliberate trigger for that conversation rather than a
quiet addition — and the vendored SMTP client has the code removed, not merely
unused. Also out: inbound mail, bounce handling, open/click tracking, per-user
preferences, queueing beyond D1, and any retry broader than the narrow rule
above.
