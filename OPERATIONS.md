# Operating auto-email

## Access the administration

The Worker has no anonymous surface. Before Cloudflare Access is installed,
open `https://auto-email.sodimo.workers.dev/` and use:

- username: `sodimo`
- password: the current `TRIGGER_TOKEN` secret

The same Basic authentication remains underneath Cloudflare Access. Never put
the token in a URL, screenshot, issue, command output or browser bookmark.

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

## Attach `auto-email.sodimo.eu`

The account-level Workers Custom Domain API call is automated separately so a
domain-permission failure cannot break routine deploys:

```sh
gh workflow run attach-domain.yml -R sodimo/auto-email
```

The workflow resolves the `sodimo.eu` zone and performs:

```text
PUT /accounts/<account id>/workers/domains
hostname=auto-email.sodimo.eu, service=auto-email, zone_name=sodimo.eu
```

The current Cloudflare API accepts the zone name, so the workflow does not need
Zone Read permission or a copied zone identifier.

## Put Cloudflare Access in front

Zero Trust configuration is deliberately an operator step:

1. In the Sodimo Cloudflare account, open **Zero Trust → Access →
   Applications**.
2. Add a **Self-hosted** application for `auto-email.sodimo.eu`.
3. Add an **Allow** policy whose Include rule is the existing Access group
   **Équipe Sodimo**.
4. Verify that a member can pass Access and then the Worker's Basic prompt, and
   that a non-member is stopped by Access.
5. Keep the workers.dev route and forced test mode until this check is complete.

Do not create a broad email-domain allow rule as a substitute for the group.

## Release a sending safely

1. Confirm `/healthz` is healthy, the kill switch is off, and test mode is on.
2. Keep a new job paused and use **Tester maintenant** once.
3. In **Historique**, check one `Envoyé` and one `Copie classée` result for each
   pinned recipient. Read any SMTP or IMAP failure details before retrying.
4. Enable the job only after its subject, content, recipients and schedule are
   correct.

The built-in sales report runs daily at 06:00 UTC. The overdue-payment estimate
runs Mondays at 07:00 UTC. ERP jobs refuse to run while the nightly mirror is
partial, still settling, or older than 36 hours.

## Emergency stop

Use **Sécurité → Arrêter tous les envois**. The switch fails closed and holds
the outbox; it does not delete queued mail. Inspect the history and queue state
before resuming.
