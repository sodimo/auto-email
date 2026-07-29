# auto-email

Cloudflare Worker that sends the Sodimo team's scheduled digests and
condition-based alerts over Strato SMTP. **Read SPEC.md first** — it is the
contract, and its two hard rules are not negotiable. EXTENDING.md walks one new
job end to end.

## Commands

Node is not on `PATH` on this NixOS host. Get it from the store, e.g.:

```sh
export PATH=/nix/store/*-nodejs-24.18.0/bin:$PATH
```

- `npm run check` — `tsc --noEmit` (typechecks `src/` and `tests/`)
- `npm test` — vitest in the workers pool, real D1 with migrations applied
- `npm run dev` — `wrangler dev` (needs `.dev.vars`)

Both must pass before pushing. There are no Cloudflare credentials on this
machine and the user's local wrangler auth is personal — **never deploy or
create resources from here**. `bootstrap.yml` and `deploy.yml` do that in CI.

## Invariants

- **`src/lib/dispatch.ts#dispatch` is the only caller of `Mailer.send`.** Adding
  a second call site defeats the idempotency ledger and the guard in one move.
  Every new sending feature goes *through* dispatch, never around it.
- **`src/lib/guard.ts` is the only place that decides who may be written to.**
  `TEST_MODE_ALLOWLIST` is code, not data, and `config.ts#FORCE_TEST_MODE` keeps
  it in force over the settings row for all of Wave 1. Do not widen either to
  "make testing easier" — that is exactly what they exist to prevent.
- Both switches fail closed. Absent or unrecognised value ⇒ kill switch engaged,
  test mode on. Never "helpfully" default them permissive.
- Insert-first, then send, then settle. Never send before the `send_log` row
  exists, and never delete a `send_log` row to "allow a resend" — write a new
  dedupe key instead.
- Per-recipient try/catch in the runner. One bad address must not cost the run.
- `condition_sql` goes through `assertReadOnlySql`. D1 bindings are read/WRITE;
  that guard is the only thing preventing a job from mutating data.
- Everything is UTC. Cron fields, `dedupe_key` slots, timestamps.
- All email copy is French. Code, comments, docs, commits are English.

## Layout

```
src/index.ts        fetch (token-gated /trigger, /healthz) + scheduled
src/runner.ts       due-job selection, fan-out, per-recipient loop
src/config.ts       TICK_MINUTES, FORCE_TEST_MODE, caps
src/types.ts        Env (hand-written — CI typechecks without CF creds) + rows
src/lib/cron.ts     5-field matcher + dueSlots window
src/lib/guard.ts    kill switch + test-mode pinning
src/lib/dispatch.ts THE choke point: guard → claim → send → settle
src/lib/mailer.ts   Mailer interface + worker-mailer/Strato implementation
src/lib/render.ts   {{var}} / {{{var}}} + row table builders
src/lib/db.ts       typed reads; src/lib/datasource.ts  condition SQL + ERP seam
migrations/         0001 schema, 0002 seed
```

## Sharp edges

- **`wrangler.jsonc` ships a placeholder `database_id`.** `bootstrap.yml`
  resolves the real uuid and commits it. `deploy.yml` refuses to deploy while
  the placeholder is present.
- **worker-mailer's `send()` resolves `void`** — no SMTP reply line, no
  message id. We generate the `Message-ID` ourselves (it only fills one in when
  the caller has not) and `smtp_response` is a reconstruction, not a transcript.
  Do not write code that parses it.
- **No automatic 465→587 fallback**, by design: a retry that cannot be placed
  relative to `DATA` risks a double send. Change `settings.smtp_port` instead.
- **`wrangler` is pinned to 4.105.0** to match the copy inside
  `@cloudflare/vitest-pool-workers`; bumping only one side breaks `npm ci` on a
  `@cloudflare/workers-types` peer conflict.
- **`npm run check` does not cover `vitest.config.ts`** — it is a Node-side file
  and `@types/node` conflicts with `@cloudflare/workers-types` in one program.
- Tests share one D1 per file. `tests/setup.ts` resets to the seeded state in
  `beforeEach`; if you add a table or a fixture recipient, reset it there too.
- `env.ERP` is declared but unused. `resolveDataSource` has the Wave 3 branch
  written and **not taken** on purpose: merely adding the binding must not
  silently redirect existing condition jobs.

## Workflow

Issues → branch `feat/<issue>-slug` → PR → squash-merge. Conventional commits.
Atomic commits: schema, engine module, tests and docs move separately.
