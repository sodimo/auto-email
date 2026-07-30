# Paul handoff — automated reports and overdue-payment review

Date: 2026-07-30  
Business owner: Paul Ghafary (`paul.ghafary@sodimo.eu`)

## What is ready

The live French administration interface is at
`https://auto-email.sodimo.eu/`. It controls two internal sendings:

- a daily sales digest based on the latest complete ERP mirror;
- a Monday summary of clients with estimated balances at least 30 days overdue.

Messages are sent as `rapports@sodimo.eu` through Strato. The exact sent message
is also filed in that mailbox's Sent folder. Delivery history, failures,
recipient lists, templates, schedules and the global stop are visible in the
web interface.

## Safe handoff state

- The global stop is engaged.
- Both scheduled jobs are paused.
- Forced test mode permits only Paul and Thomas as recipients.
- The outbox is empty and the ERP readiness gate is healthy.

This means Paul can inspect everything without an automatic email going out.
Changing a recipient in the UI cannot bypass the forced test allowlist.

## Access

Open `https://auto-email.sodimo.eu/`. The underlying browser prompt uses:

- username: `sodimo`
- password: the current `TRIGGER_TOKEN`, transferred separately through a
  private credential channel; never place it in an email, screenshot or URL.

Cloudflare Access with the shared **Équipe Sodimo** group is still required as
the outer login gate. Until it is installed, the underlying prompt is the only
login layer.

## Paul's first controlled run

1. Open **Sécurité** and confirm **Arrêt général** is active and test mode is
   locked.
2. Review **Destinataires**, **Modèles** and the two jobs under **Envois**.
3. Compare the overdue estimate with known Sodiwin balances before relying on
   it operationally.
4. For one controlled test, release the global stop, use **Tester maintenant**
   on the overdue job, then immediately restore the global stop.
5. In **Historique**, confirm one delivered message and one classified Sent
   copy for both Paul and Thomas. Confirm receipt in Paul's mailbox.

Do not enable either schedule during this first run.

## Accounting boundary

The overdue email is an **internal review summary**, not an automatic reminder
sent to clients. The frozen ERP mirror cannot map every settlement to one
specific invoice, so the Worker nets payments oldest-first at client level and
labels the result as an estimate. Sodiwin remains the accounting source of
truth. Client-facing relance email requires a separate approved workflow,
recipient/contact rules and message review.

## Before routine operation

1. Paul validates a sample of overdue balances against Sodiwin.
2. Paul confirms who should receive the daily digest and weekly overdue review.
3. Thomas installs the Cloudflare Access application using the **Équipe
   Sodimo** group.
4. A reviewed code change replaces forced test mode with the agreed internal
   recipient policy.
5. Only then: release the global stop and enable the approved jobs.

Technical source: `https://github.com/sodimo/auto-email`. Deployments and D1
migrations run only through GitHub Actions; no Cloudflare account operation is
performed from a laptop.
