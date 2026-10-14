# auto-email

Cloudflare Worker that sends the Sodimo team's scheduled digests and
condition-based alerts over Strato SMTP, and files a copy in the mailbox's Sent
folder over IMAP. **Read SPEC.md first** — it is the contract, and its two hard
rules are not negotiable. EXTENDING.md walks one new job end to end.

## Dormant

**This Worker is parked on purpose (since 2026-10-14).** `wrangler.jsonc` ships
`"vars": { "DORMANT": "on" }` and `"triggers": { "crons": [] }`. While dormant:

- every HTTP path and method, HEAD and OPTIONS included (admin UI,
  `/api/admin/*` including Tester and job runs, `/trigger/*`, `/drain`,
  `/healthz`, unknown paths) answers a static 503
  page (HTML for `/`, `/admin` and browsers) or 503 JSON, in French and
  English, **before authentication and with zero D1 queries**;
- `scheduled()` returns before any D1 call if a stale trigger ever fires, and
  `drainOutbox`, `enqueueDueJobs` and `runJobById` refuse the same way;
- no email can be sent. The D1 `settings.kill_switch` stays engaged as well:
  never release it as part of waking.

Fail closed: dormant unless `DORMANT` is exactly `off` (`src/lib/dormant.ts`).
`tests/dormant.test.ts` replaces both D1 bindings with recorders that throw on
any use and fails if any route or the scheduled handler touches them; it also
pins the shipped `wrangler.jsonc` to `DORMANT: "on"` and an empty cron list.

Why `crons: []` and not deleting the key: on deploy wrangler PUTs the cron
list to the Worker's schedules, so an empty list deletes every trigger. A
missing `triggers` key leaves the old `*/5` trigger running.

**Waking it needs the joint decision of the Sodimo operations lead and the
technical lead.** An agent never wakes it, and neither does one person
alone. Once both have decided, in ONE reviewed commit:

1. set `"vars": { "DORMANT": "off" }` in `wrangler.jsonc`;
2. restore `"triggers": { "crons": ["*/5 * * * *"] }`;
3. update the two pins in `tests/dormant.test.ts` ("the shipped wrangler.jsonc
   is dormant") to the awake values; keep the zero-D1 guard tests;
4. push to `main`, then run the `deploy` workflow by hand (push alone does not
   deploy while the repo variable `DEPLOY_ENABLED` is unset).

D1 cost of waking (account allowance 5,000,000 reads and 100,000 writes per
UTC day, shared by every Sodimo Worker): the cron alone, kill switch still
engaged, reads the 14-row settings table twice per tick, up to about 8,000
rows a day, 0 writes. Each admin page open or save reads about a dozen ERP
marker rows plus about 100 rows here. The daily sales digest reads about 400
rows per run. The Monday overdue review (and every Tester press on it) reads
about 1.8 million rows, a third of the whole account's day: keep that job
disabled unless both decision makers accept the cost that day. Each delivered
message writes about 16 rows per recipient.

To park it again: set `DORMANT` back to `on` and `crons` back to `[]`, push,
run `deploy`.

## Account-wide D1 rules (every Sodimo repo)

- The Sodimo Cloudflare account is on the Free plan: 5,000,000 D1 rows read and
  100,000 rows written per day, shared by every database (auto-email, crm,
  sodimo-prod), reset at 00:00 UTC (02:00 Paris in summer, 01:00 in winter).
  Once spent, every Sodimo app that uses D1 fails until the reset.
- Here the operations lead is Paul (on call) and the technical lead is Rani
  (technical owner). Only the two together change `DORMANT`, the cron list,
  `settings.kill_switch` or a job's enabled flag. Keep them as they are.
- Every `env.ERP` (sodimo-prod) query filters by client or by month, or reads
  the row markers, with `LIMIT`. D1 bills rows scanned, not rows returned:
  never a bare `SELECT` or `COUNT(*)` over `fact_ventes`, `fact_stocks_dep`,
  `fact_reglements`, `fact_echeances` or `fact_lots`.
- Never `wrangler d1 execute` bulk statements on production, and never run the
  old ETL bulk loader or "protocole A" (full reload).
- Before pushing: `npm ci`, `npm run check`, `npm test` (local D1 only).

## Commands

Node is not on `PATH` on this NixOS host. Get it from the store, e.g.:

```sh
export PATH="$(ls -d /nix/store/*-nodejs-24.18.0/bin | head -1):$PATH"
```

- `npm run check` — `tsc --noEmit` (typechecks `src/`, `tests/`, `vendor/`)
- `npm test` — vitest in the workers pool, real D1 with migrations applied
- `npm run dev` — `wrangler dev` (needs `.dev.vars`)

Both must pass before pushing. There are no Cloudflare credentials on this
machine and the user's local wrangler auth is personal — **never deploy or
create resources from here**. `bootstrap.yml` and `deploy.yml` do that in CI.

## Invariants

- **Two choke points, and only two.** `src/lib/enqueue.ts#enqueue` is the only
  way into the outbox; `src/lib/drain.ts#drainOutbox` is the only code in the
  repo that talks to SMTP. A second path around either defeats the idempotency
  ledger and the guard in one move. New sending features go *through* them.
- **`src/lib/guard.ts` is the only place that applies global safety gates.**
  Active UI recipient-list rows and per-job CC fields govern normal sends. If
  `settings.test_mode` is re-enabled, `TEST_MODE_ALLOWLIST` pins the emergency
  scope to Paul. Do not widen it to "make testing easier". The guard runs at
  enqueue AND at drain; keep it that way.
- Both switches fail closed. Absent or unrecognised value ⇒ kill switch engaged,
  test mode on. Never "helpfully" default them permissive.
- Claim first, then queue, then send, then settle. Never send before the
  `send_log` row exists, and never delete a `send_log` or `outbox` row to
  "allow a resend" — write a new dedupe key instead.
- **Retry only what `SmtpError.retryable` says.** A failure that cannot be placed
  relative to the message body is terminal. Widening this to "retry everything"
  reintroduces double sends.
- The message is built ONCE per send and the same bytes go to SMTP and IMAP.
  Do not rebuild for the archive copy.
- A Sent-copy failure never changes a send's status. It lands in
  `append_status`/`append_response` and nowhere else.
- `condition_sql` goes through `assertReadOnlySql`. D1 bindings are read/WRITE;
  that guard is the only thing preventing a job from mutating data.
- Everything is UTC. Cron fields, `dedupe_key` slots, timestamps.
- All email copy is French. Code, comments, docs, commits are English.

## Layout

```
src/index.ts          fetch (/trigger, /drain, /healthz) + scheduled
src/admin/            authenticated French UI, CRUD, friendly schedules/templates
src/runner.ts         due-job selection, fan-out, per-recipient ENQUEUE
src/config.ts         TICK_MINUTES, FORCE_TEST_MODE, batch and retry limits
src/types.ts          Env (hand-written — CI typechecks without CF creds) + rows
src/lib/cron.ts       5-field matcher + dueSlots window
src/lib/guard.ts      kill switch + test-mode pinning
src/lib/enqueue.ts    CHOKE POINT 1: guard → claim → queue
src/lib/drain.ts      CHOKE POINT 2: guard → build → SMTP → IMAP → settle
src/lib/mailer.ts     MailTransport/MailSession seam + buildMessage
src/lib/imap-append.ts hand-rolled IMAP APPEND to the discovered \Sent folder
src/lib/render.ts     {{var}} / {{{var}}} + row table builders
src/lib/db.ts         typed reads; src/lib/datasource.ts source routing + SQL guard
src/lib/erp.ts        production-mirror completeness/freshness gate
src/lib/dormant.ts    DORMANT var: static 503 for every route, no D1, no cron work
src/lib/job-presets.ts canonical sales-digest and overdue-payment ERP queries
vendor/worker-mailer/ patched SMTP client (MIT, see its README)
migrations/           0001 schema through 0008 job-level CC delivery
```

## Sharp edges

- **The two D1 bindings have different ownership.** Migrations apply only to
  `DB` (`auto-email`). `ERP` is `sodimo-prod`; the frozen `sodimo/etl` owns its
  schema and data. Never add `migrations_dir` to the ERP binding or write to it.
- **The vendored SMTP client is patched; the patches are not optional.**
  `tests/vendor-mailer.test.ts` pins them. If one fails after an update, the
  patch was lost — read `vendor/worker-mailer/README.md` before "fixing" the
  test. The EHLO hostname is the dangerous one: unpatched, mail to `@sodimo.eu`
  addresses is accepted with `250 queued` and then silently dropped.
- **`authType` must be stated.** The client has no working default and throws
  before reaching the server. `config.ts#SMTP_AUTH_TYPES` is `['plain','login']`.
- **IMAP APPEND must wait for the `+` continuation.** Strato advertises no
  LITERAL+; writing the bytes early hangs until the timeout. Byte counts come
  from `TextEncoder`, never `String.length` — French accents are multi-byte.
- **No automatic 465→587 fallback**, by design. Change `settings.smtp_port`.
- **`wrangler` is pinned to 4.105.0** to match the copy inside
  `@cloudflare/vitest-pool-workers`; bumping only one side breaks `npm ci` on a
  `@cloudflare/workers-types` peer conflict.
- **`npm run check` does not cover `vitest.config.ts`** — it is a Node-side file
  and `@types/node` conflicts with `@cloudflare/workers-types` in one program.
- Tests share one D1 per file. `tests/setup.ts` resets to the seeded state in
  `beforeEach`, **including every settings row a test might tune**; if you add a
  table, a fixture recipient or a setting, reset it there too.
- Every ERP job passes `assertErpReady` before its `SELECT`: row floors, matching
  load stamps, 10-minute settling time and 36-hour freshness are deliberate
  protection against the nightly table-by-table reload. Do not weaken the gate
  merely to get a send through.
- In the frozen ETL, `fact_echeances.numdoc` is `REGLE.NUMREG`; production data
  maps it to `fact_reglements.numreg`, not to a sales invoice number. The
  overdue preset keeps `fact_ventes.numdoc` only as a compatibility fallback.
- Browser authentication is the existing Sodimo Cloudflare Access gate on
  `auto-email.sodimo.eu`; the Worker accepts its identity assertion only on
  that hostname. API callers use the trigger header or bearer token on
  workers.dev. Never add an HTTP Basic challenge: it causes the native browser
  password dialog that Access is meant to replace.

## Live-sending caveats

- **The `rapports@sodimo.eu` mailbox was created 2026-07-29** and is inside
  Strato's new-mailbox trial window: roughly **100 messages/hour for its first
  30 days**. Keep `drain_batch_size` modest and do not bulk-test.
- A first production transport test on 2026-07-29 verified SMTP through Strato
  and IMAP APPEND to the discovered Sent folder. Preserve the explicit EHLO,
  authentication and synchronizing-literal behavior that made it succeed.

## Workflow

This repository's convention is direct, atomic conventional commits to `main`.
Run `npm run check` and `npm test`, push, confirm GitHub CI, then deploy only by
manual workflow dispatch:

```sh
gh workflow run deploy.yml -R sodimo/auto-email
```

Push-to-main deployment remains gated by `DEPLOY_ENABLED`. Never use the local
wrangler login for account operations: it belongs to a personal Cloudflare
account, not Sodimo. See `OPERATIONS.md` for the custom-domain and Access steps.
