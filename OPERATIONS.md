# Operating auto-email

## Dormant (current state)

auto-email is paused on purpose: every page answers "en sommeil / dormant",
no cron runs, nothing is read from the database and no email can be sent.
This is not an outage. Waking it is a joint decision of Sodimo operations and
the technical lead; the steps and their database cost are in `CLAUDE.md`,
section "Dormant".

## Access the administration

Open `https://auto-email.sodimo.eu/` and use the existing Sodimo Cloudflare
Access login. Paul signs in as `paul.ghafary@sodimo.eu` and receives a one-time
code through the configured Access login method. There is no second HTTP Basic
prompt. The workers.dev hostname is for machine calls with `TRIGGER_TOKEN`;
never put that token in a URL, screenshot, issue or browser bookmark.

Useful paths for a Claude-guided session:

- `/?section=jobs&action=new-job` — create a sending
- `/?section=templates&action=new-template` — create a template
- `/?section=recipients&action=new-list` — create a recipient list
- `/?section=history` — verify delivery and Sent-folder copies
- `/?section=safety` — operate the kill switch

## Deploy

Use GitHub Actions only:

```sh
gh workflow run deploy.yml -R sodimo/auto-email
```

Confirm the run succeeded before testing. Pushes to `main` do not deploy unless
the repository variable `DEPLOY_ENABLED` is deliberately enabled. Never use
the laptop's authenticated wrangler for deploys, D1 writes or Cloudflare
account operations: it is connected to a personal account.

## Attach `auto-email.sodimo.eu` and Access

The account-level Workers Custom Domain and Access attachment are automated
separately so an account-permission failure cannot break routine deploys:

```sh
gh workflow run attach-domain.yml -R sodimo/auto-email
```

The workflow resolves the `sodimo.eu` zone and performs:

```text
PUT /accounts/<account id>/workers/domains
hostname=auto-email.sodimo.eu, service=auto-email, zone_name=sodimo.eu
```

The final workflow step attaches the existing `sodimo-staff` group as the only
rule: no individual address is admitted outside that group, and re-running the
step rewrites the managed policy back to the group alone. It does not create or
edit the reusable group. Success requires an anonymous request to redirect to
`sodimo.cloudflareaccess.com`; no manual Zero Trust change is normally required.

## Release a sending safely

1. In **Destinataires**, confirm every active address intended for the test.
2. Keep a new job paused, release the global stop briefly, and use **Tester**
   once.
3. In **Historique**, check one `Envoyé` and one `Copie classée` result for each
   active recipient. Read any SMTP or IMAP failure details before retrying.
4. Re-engage the global stop during the handoff. Enable a job only after its
   subject, content, recipients and schedule are correct.

The built-in sales report runs daily at 06:00 UTC. The overdue-payment estimate
runs Mondays at 07:00 UTC. ERP jobs refuse to run while the nightly mirror is
partial, still settling, or older than 36 hours.

## Daily D1 limits (Cloudflare Free)

All Sodimo D1 databases share one account allowance: 5,000,000 rows read and
100,000 rows written per day, reset at 00:00 UTC. Reads cost per row visited,
not per row returned.

- Opening this site checks ERP freshness from about a dozen marker rows.
- The daily sales digest reads about 400 ERP rows per run.
- The Monday overdue review reads about 1.8 million ERP rows per run, about a
  third of a day's allowance. Enable it only when the rest of the account has
  room that day.
- Each delivered message writes about 16 rows here per recipient (queue,
  history and their indexes).

While the NAS still runs the full-reload loader (about 3.3 million rows written
each night shortly before 01:00 UTC), D1 has been observed refusing writes for
the rest of the UTC day. The administration site still opens, but saving a
recipient, a job or the kill switch fails, and scheduled reports cannot be
queued. That failure is safe: a message is only sent after D1 has accepted a
write for it, so nothing is sent twice.

## Emergency stop

Use **Sécurité → Arrêter tous les envois**. The switch fails closed and holds
the outbox; it does not delete queued mail. Inspect the history and queue state
before resuming.
