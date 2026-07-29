# auto-email

Cloudflare Worker that sends the Sodimo team's scheduled digests and
condition-based alerts over Strato SMTP, and files a copy in the mailbox's Sent
folder over IMAP. **Read SPEC.md first** — it is the contract, and its two hard
rules are not negotiable. EXTENDING.md walks one new job end to end.

## Commands

Node is not on `PATH` on this NixOS host. Get it from the store, e.g.:

```sh
export PATH=/nix/store/*-nodejs-24.18.0/bin:$PATH
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
- **`src/lib/guard.ts` is the only place that decides who may be written to.**
  `TEST_MODE_ALLOWLIST` is code, not data, and `config.ts#FORCE_TEST_MODE` keeps
  it in force over the settings row for all of Wave 1. Do not widen either to
  "make testing easier" — that is exactly what they exist to prevent. The guard
  runs at enqueue AND at drain; keep it that way.
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
src/lib/db.ts         typed reads; src/lib/datasource.ts  condition SQL + ERP seam
vendor/worker-mailer/ patched SMTP client (MIT, see its README)
migrations/           0001 schema, 0002 seed
```

## Sharp edges

- **`wrangler.jsonc` ships a placeholder `database_id`.** `bootstrap.yml`
  resolves the real uuid and commits it. `deploy.yml` refuses to deploy while
  the placeholder is present.
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
- `env.ERP` is declared but unused. `resolveDataSource` has the Wave 3 branch
  written and **not taken** on purpose: merely adding the binding must not
  silently redirect existing condition jobs.

## Live-sending caveats (unverified until the first real send)

- **The `rapports@sodimo.eu` mailbox was created 2026-07-29** and is inside
  Strato's new-mailbox trial window: roughly **100 messages/hour for its first
  30 days**. Keep `drain_batch_size` modest and do not bulk-test.
- **Sending as a different From than the authenticating user is unverified.**
  The first live test should try `From: facturation@sodimo.eu` over
  `rapports@sodimo.eu` auth; if Strato rejects it, fall back to
  `From: rapports@sodimo.eu` with `Reply-To: facturation@sodimo.eu`. The code
  already separates the envelope sender from the `From:` header, so this is a
  settings change, not a code change.

## Workflow

Issues → branch `feat/<issue>-slug` → PR → squash-merge. Conventional commits.
Atomic commits: schema, engine module, tests and docs move separately.
