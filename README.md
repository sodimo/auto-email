# auto-email

Scheduled digests and condition-based alerts for the Sodimo team, sent from a
Cloudflare Worker via Strato SMTP, with a copy filed in the mailbox's Sent
folder over IMAP. See [SPEC.md](SPEC.md) for the contract and
[CLAUDE.md](CLAUDE.md) if you are an agent picking this up.

Primary recipient lists and each job's optional visible CC addresses in the
administration UI are authoritative. The production handoff starts with only
`paul.ghafary@sodimo.eu`, no CC addresses, both jobs paused and the global stop
engaged. An emergency test-mode setting can still pin sends to Paul alone, but
it is not forced during normal operation.

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
purpose. The workflows use the org-level `CLOUDFLARE_API_TOKEN` /
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

4. **Attach the custom domain and existing Sodimo Access gate** (one-time,
   idempotent):

   ```sh
   gh workflow run attach-domain.yml -R sodimo/auto-email
   ```

   The workflow attaches the existing `sodimo-staff` Access group; it does not
   create a new identity group or alter membership. Do not use locally
   authenticated wrangler for any account operation; that login is not
   Sodimo's.

## Operate

Open `https://auto-email.sodimo.eu/` and pass the usual Sodimo Cloudflare Access
login. There is no HTTP Basic browser prompt. The French UI manages sendings,
schedules, templates, primary recipient lists, repeatable per-job CC fields,
history and the kill switch.

For the in-person business-owner walkthrough, use
[`HANDOFF-PAUL.md`](HANDOFF-PAUL.md).

Automation uses the trigger token on the workers.dev hostname:

```sh
TOKEN=...                       # the TRIGGER_TOKEN value
BASE=https://auto-email.sodimo.workers.dev

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

`kill_switch` fails closed: anything other than `off` (including a missing row)
means engaged, and it **holds** the queue rather than discarding it — turning it
back off resumes where it stopped. Use the prominent switch in **Sécurité**;
do not operate production D1 through a laptop's personal wrangler login.
`test_mode` is an emergency restriction: while on, only Paul can receive mail;
while off, the active members of each UI list and the CC fields saved on each
job are authoritative. A missing or unrecognised value still fails closed as
test mode on.

Other knobs worth knowing: `drain_batch_size` (default 10, capped at 25),
`imap_append` (`on`/`off` for Sent copies), `sent_folder_override` (empty =
discover the `\Sent` mailbox), `smtp_username` (empty = authenticate as
`from_address`) and `reply_to` (empty = `from_address`).

### What went out

Use **Historique** in the UI. It displays delivery and Sent-folder append as
separate outcomes, including SMTP/IMAP responses and failure details.
`/healthz` reports `outbox.pending` and the age of the oldest queued message;
a growing backlog indicates that SMTP cannot currently be reached.
