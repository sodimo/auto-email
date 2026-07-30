# Operating auto-email

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

The final workflow step attaches the existing `sodimo-staff` group and keeps
Thomas's existing administrator identity as an Access-only exception. It does
not create or edit the reusable group. Success requires an anonymous request to
redirect to `sodimo.cloudflareaccess.com`; no manual Zero Trust change is
normally required.

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

## Emergency stop

Use **Sécurité → Arrêter tous les envois**. The switch fails closed and holds
the outbox; it does not delete queued mail. Inspect the history and queue state
before resuming.
