# Paul handoff — automated reports and overdue-payment review

Date: 2026-07-30  
Business owner: Paul Ghafary (`paul.ghafary@sodimo.eu`)

## What is ready

The live French administration interface is at
`https://auto-email.sodimo.eu/`. It controls two internal sendings:

- a daily sales digest based on the latest complete ERP mirror;
- a Monday summary of clients with estimated balances at least 30 days overdue.

`rapports@sodimo.eu` is the single system-wide sender for both jobs. Messages
are sent through Strato, and the exact sent message is also filed in that
mailbox's Sent folder. Delivery history, failures,
recipient lists, templates, schedules and the global stop are visible in the
web interface.

## Safe handoff state

- The global stop is engaged.
- Both scheduled jobs are paused.
- The **Suivi clients** list contains only Paul as an active recipient.
- Normal recipient control belongs to this web interface; emergency test mode
  is off.
- The outbox is empty and the ERP readiness gate is healthy.

This means Paul can inspect everything without an automatic email going out.
When the stop is released, every active address in a job's selected list and
every CC address configured on that job is a real recipient, so both must be
reviewed before pressing **Tester**.

## Access

Open `https://auto-email.sodimo.eu/`. Cloudflare Access shows the same Sodimo
login used by the other internal websites. Paul enters
`paul.ghafary@sodimo.eu`, requests the one-time code and enters it. The
administration interface then opens directly—there is no Chrome/native
username-and-password prompt and no trigger token to hand over.

## Paul's first controlled run

1. Open **Sécurité** and confirm **Arrêt général** is active.
2. Open **Destinataires → Suivi clients** and confirm Paul is the only active
   address. Show how to add, pause, edit and remove an address.
3. Review **Modèles** and the two jobs under **Envois**. Show that **Modifier**
   chooses the schedule, model, recipient list and optional **Adresses en copie
   (CC)**. **Ajouter une adresse en copie** creates another field; **Retirer**
   removes one. CC addresses are visible to all recipients and receive one
   copy each. **Activer** controls scheduled runs.
4. Compare the overdue estimate with known Sodiwin balances before relying on
   it operationally.
5. For one controlled test, release the global stop, use **Tester**
   on the overdue job, then immediately restore the global stop.
6. In **Historique**, confirm one delivered message and one classified Sent
   copy for Paul. Confirm receipt in Paul's mailbox.

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
2. Paul confirms the primary list and any CC addresses for the daily digest and
   weekly overdue review.
3. Paul confirms the two schedules and which job may be activated.
4. Only then: release the global stop and enable the approved jobs.

Technical source: `https://github.com/sodimo/auto-email`. Deployments and D1
migrations run only through GitHub Actions; no Cloudflare account operation is
performed from a laptop.
