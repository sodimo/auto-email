# auto-email

Scheduled digests and condition-based alerts for the Sodimo team, sent from a
Cloudflare Worker via Strato SMTP, with a copy filed in the mailbox's Sent
folder over IMAP. See [SPEC.md](SPEC.md) for the contract and
[CLAUDE.md](CLAUDE.md) if you are an agent picking this up.

**Wave 1 sends only to `thomas@leger.run` and `tombionic@gmail.com`.** Every
other recipient is refused in code. Nothing here can email the Sodimo team yet.

## Develop

```sh
npm ci
npm run check   # tsc --noEmit
npm test        # vitest, real D1, SMTP/IMAP driven against a mock socket
```

There are **no runtime dependencies**: the SMTP client lives in
[`vendor/worker-mailer/`](vendor/worker-mailer/README.md), patched, and the IMAP
client is a few hundred lines in `src/lib/imap-append.ts`.

`npm run dev` starts `wrangler dev` against a local D1 in `.wrangler/state`. It
needs `.dev.vars` (gitignored):

```
STRATO_SMTP_PASSWORD=...
TRIGGER_TOKEN=...
```

Local D1 starts empty — apply the migrations once:

```sh
npx wrangler d1 migrations apply auto-email --local
```

## Deploy

Nothing deploys from a laptop; there are no Cloudflare credentials here on
purpose. Both workflows use the org-level `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID` secrets.

1. **Set the trigger token** (once, any random 32 bytes):

   ```sh
   gh secret set TRIGGER_TOKEN --body "$(openssl rand -hex 32)"
   ```

   `STRATO_SMTP_PASSWORD` is already a repo secret. `deploy.yml` pushes both to
   the Worker with `wrangler secret put` after deploying.

2. **Provision D1** (re-runnable):

   ```sh
   gh workflow run bootstrap.yml
   ```

   Creates the `auto-email` database if absent, applies `migrations/` to the
   remote, and commits the real `database_id` into `wrangler.jsonc`.

3. **Deploy**:

   ```sh
   gh workflow run deploy.yml
   ```

   Push-to-main auto-deploy stays off until you opt in with
   `gh variable set DEPLOY_ENABLED --body true`.

## Operate

Every endpoint needs the token:

```sh
TOKEN=...                       # the TRIGGER_TOKEN value
BASE=https://auto-email.<subdomain>.workers.dev   # Wave 2: https://auto-email.sodimo.eu

curl -s -H "X-Trigger-Token: $TOKEN" "$BASE/healthz"
curl -s -X POST -H "X-Trigger-Token: $TOKEN" "$BASE/trigger/rapport-nightly"
curl -s -X POST -H "X-Trigger-Token: $TOKEN" "$BASE/drain"
```

`/trigger` queues the job and drains in the same request, so a manual test is
one command. It returns what was queued (`queued`, `skipped`, `duplicates`) and
what went out (`sent`, `failed`, `retrying`, `appended`). It runs a job even
when the job is disabled — the seeded `rapport-nightly` ships disabled precisely
so the first send is a deliberate manual one.

`/drain` sends what is already queued without enqueueing anything. Cron does
both every five minutes.

### Switches

```sh
npx wrangler d1 execute auto-email --remote \
  --command "UPDATE settings SET value='on' WHERE key='kill_switch'"   # stop everything
```

`kill_switch` fails closed: anything other than `off` (including a missing row)
means engaged, and it **holds** the queue rather than discarding it — turning it
back off resumes where it stopped. Turning `test_mode` off does nothing in
Wave 1; the allowlist is enforced in code.

Other knobs worth knowing: `drain_batch_size` (default 10, capped at 25),
`imap_append` (`on`/`off` for Sent copies), `sent_folder_override` (empty =
discover the `\Sent` mailbox), `smtp_username` (empty = authenticate as
`from_address`) and `reply_to` (empty = `from_address`).

### What went out

```sh
npx wrangler d1 execute auto-email --remote \
  --command "SELECT sent_at, recipient, status, append_status, smtp_response FROM send_log ORDER BY id DESC LIMIT 20"
```

A backlog means SMTP is unreachable — `/healthz` reports `outbox.pending` and
the age of the oldest queued message:

```sh
npx wrangler d1 execute auto-email --remote \
  --command "SELECT status, COUNT(*), MAX(last_error) FROM outbox GROUP BY status"
```
