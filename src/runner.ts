/**
 * Job orchestration — the ENQUEUE half. One code path serves both the cron tick
 * and a manual /trigger; the only difference is how the dedupe key is derived.
 * Nothing here talks to SMTP: rendering and claiming happen now, sending is the
 * drain's job (lib/drain.ts), which is what keeps a cron invocation inside the
 * free plan's CPU budget.
 *
 * Fan-out and emptiness are governed by two different columns, on purpose:
 *   dedupe_strategy = 'per_row'  → ONE message per matched row (an alert)
 *   otherwise                    → ONE message per run, all rows in a table
 *   kind = 'condition'           → zero rows means send nothing
 *   kind = 'digest'              → zero rows still sends ("Aucune donnée…")
 */
import { DORMANT_REASON, isDormant } from "./lib/dormant.js";
import { DASHBOARD_URL, TICK_MINUTES } from "./config.js";
import { dueSlots, isoMinute } from "./lib/cron.js";
import { resolveDataSource } from "./lib/datasource.js";
import { loadEnabledJobs, loadJob, loadRecipients, loadSettings, loadTemplate } from "./lib/db.js";
import { enqueue } from "./lib/enqueue.js";
import { assertErpReady, assertErpUnchanged } from "./lib/erp.js";
import { guardRun, normalizeEmail } from "./lib/guard.js";
import { sqlForPreset } from "./lib/job-presets.js";
import { buildRowsTableHtml, buildRowsText, frenchDate, render } from "./lib/render.js";
import type { DataRow, Env, Job, JobResult, Recipient, RecipientKind, Settings } from "./types.js";

export type Trigger = { kind: "cron"; slot: string } | { kind: "manual"; at: Date };

export interface RunSummary {
  at: string;
  suppressed?: string;
  jobs: JobResult[];
  skipped: { job: string; reason: string }[];
}

/** One outbound message: its dedupe key and the variable bag it renders with. */
interface Envelope {
  dedupeKey: string;
  vars: Record<string, unknown>;
}

function uniqueRecipients(recipients: Recipient[]): Recipient[] {
  const seen = new Set<string>();
  const result: Recipient[] = [];
  for (const recipient of recipients) {
    const address = normalizeEmail(recipient.email);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    result.push({ email: address, display_name: recipient.display_name });
  }
  return result;
}

function configuredCcRecipients(job: Job): Recipient[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(job.cc_recipients_json || "[]");
  } catch {
    throw new Error(`job ${job.name} has invalid CC configuration`);
  }
  if (!Array.isArray(parsed) || parsed.some((address) => typeof address !== "string")) {
    throw new Error(`job ${job.name} has invalid CC configuration`);
  }
  const recipients = parsed.map((address) => ({
    email: normalizeEmail(String(address)),
    display_name: null,
  }));
  if (recipients.some((recipient) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.email))) {
    throw new Error(`job ${job.name} has invalid CC configuration`);
  }
  return uniqueRecipients(recipients);
}

function emptyResult(job: Job): JobResult {
  return {
    job: job.name,
    jobId: job.id,
    dedupeKeys: [],
    rowCount: 0,
    attempted: 0,
    queued: 0,
    skipped: 0,
    failed: 0,
    duplicates: 0,
    errors: [],
  };
}

function baseVars(job: Job, rows: DataRow[], now: Date): Record<string, unknown> {
  return {
    // A one-row aggregate (the standard digest shape) exposes its named
    // columns directly to the friendly template editor. Standard variables
    // come afterwards and cannot be shadowed by ERP column names.
    ...(rows.length === 1 ? rows[0] : {}),
    job_name: job.name,
    job_label: job.display_name ?? job.name,
    date_fr: frenchDate(now),
    generated_at: `${now.toISOString().slice(0, 19)}Z`,
    dashboard_url: DASHBOARD_URL,
    row_count: rows.length,
    rows_table_html: buildRowsTableHtml(rows),
    rows_text: buildRowsText(rows),
  };
}

/**
 * Manual runs never reuse a scheduled slot's key, so testing a job cannot be
 * blocked by (nor block) its real nightly send. Row keys are exempt: an alert
 * that already went out must not be re-sent because a human pressed a button.
 */
function buildEnvelopes(job: Job, rows: DataRow[], trigger: Trigger, now: Date): Envelope[] {
  if (job.dedupe_strategy === "per_row") {
    return rows.map((row) => {
      const key = row["dedupe_key"];
      if (key === undefined || key === null || String(key) === "") {
        throw new Error(
          `dedupe_strategy='per_row' requires condition_sql to return a non-empty dedupe_key column`,
        );
      }
      return {
        dedupeKey: `row:${String(key)}`,
        vars: { ...baseVars(job, [row], now), ...row },
      };
    });
  }

  const scheduled = trigger.kind === "cron" ? trigger.slot : isoMinute(trigger.at);
  const dedupeKey =
    trigger.kind === "manual"
      ? `manual:${scheduled}`
      : job.dedupe_strategy === "per_day"
        ? `day:${scheduled.slice(0, 10)}`
        : `run:${scheduled}`;

  return [{ dedupeKey, vars: baseVars(job, rows, now) }];
}

export async function runJob(env: Env, settings: Settings, job: Job, trigger: Trigger): Promise<JobResult> {
  const result = emptyResult(job);
  const now = trigger.kind === "manual" ? trigger.at : new Date(`${trigger.slot.slice(0, 16)}:00Z`);

  const template = await loadTemplate(env.DB, job.template_id);
  if (!template) {
    result.errors.push(`template ${job.template_id} not found`);
    return result;
  }
  const recipients = uniqueRecipients(await loadRecipients(env.DB, job.recipient_list_id));
  if (recipients.length === 0) {
    result.errors.push(`recipient list ${job.recipient_list_id} has no active members`);
    return result;
  }
  const primaryAddresses = new Set(recipients.map((recipient) => recipient.email));
  const ccRecipients = configuredCcRecipients(job).filter(
    (recipient) => !primaryAddresses.has(recipient.email),
  );
  const deliveryRecipients: { recipient: Recipient; kind: RecipientKind }[] = [
    ...recipients.map((recipient) => ({ recipient, kind: "to" as const })),
    ...ccRecipients.map((recipient) => ({ recipient, kind: "cc" as const })),
  ];

  // A built-in report always runs the SQL shipped with this code, not the copy
  // saved in D1 when the job was created, so a cheaper or corrected preset
  // takes effect on deploy without a D1 write.
  const presetSql = job.preset && job.preset !== "custom" ? sqlForPreset(job.preset) : null;
  const conditionSql = presetSql ?? job.condition_sql;

  let rows: DataRow[] = [];
  if (conditionSql) {
    const before = job.source === "erp" ? await assertErpReady(env.ERP, now) : null;
    rows = await resolveDataSource(env, job.source).query(conditionSql);
    if (before) await assertErpUnchanged(env.ERP, before, now);
  }
  result.rowCount = rows.length;

  if (job.kind === "condition" && rows.length === 0) return result;

  const envelopes = buildEnvelopes(job, rows, trigger, now);
  result.dedupeKeys = envelopes.map((e) => e.dedupeKey);

  for (const envelope of envelopes) {
    // Rendered ONCE per message, then copied to each recipient's queue row.
    const subject = render(template.subject_fr, envelope.vars, { escape: false }).output;
    const html = render(template.body_html, envelope.vars, { escape: true }).output;
    const text = render(template.body_text, envelope.vars, { escape: false }).output;

    for (const { recipient, kind } of deliveryRecipients) {
      result.attempted++;
      try {
        // One failure never aborts the run — not for the other recipients of
        // this message, and not for the other messages of this job.
        const outcome = await enqueue({
          db: env.DB,
          settings,
          job,
          recipient,
          recipientKind: kind,
          toRecipients: recipients,
          ccRecipients,
          dedupeKey: envelope.dedupeKey,
          subject,
          html,
          text,
        });
        if (outcome.result === "queued") result.queued++;
        else if (outcome.result === "duplicate") result.duplicates++;
        else if (outcome.result === "blocked") result.skipped++;
        else {
          result.failed++;
          result.errors.push(`${recipient.email}: ${outcome.error}`);
        }
      } catch (cause) {
        result.failed++;
        result.errors.push(`${recipient.email}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }

  return result;
}

/** The cron entry point: kill switch, then every enabled job whose schedule
 *  fired in the window this tick covers. */
export async function enqueueDueJobs(env: Env, scheduledTime: number): Promise<RunSummary> {
  if (isDormant(env)) {
    return { at: new Date(scheduledTime).toISOString(), jobs: [], skipped: [], suppressed: DORMANT_REASON };
  }
  const settings = await loadSettings(env.DB);
  const summary: RunSummary = { at: new Date(scheduledTime).toISOString(), jobs: [], skipped: [] };

  const run = guardRun(settings);
  if (!run.allowed) {
    summary.suppressed = run.reason;
    return summary;
  }

  const jobs = await loadEnabledJobs(env.DB);
  const due: { job: Job; slot: string }[] = [];
  for (const job of jobs) {
    try {
      const slots = dueSlots(job.schedule, scheduledTime, TICK_MINUTES);
      if (slots.length === 0) continue;
      due.push({ job, slot: slots[slots.length - 1]! });
    } catch (cause) {
      // A malformed schedule is reported, not silently never-firing.
      summary.skipped.push({ job: job.name, reason: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  for (const { job, slot } of due) {
    try {
      summary.jobs.push(await runJob(env, settings, job, { kind: "cron", slot }));
    } catch (cause) {
      summary.skipped.push({ job: job.name, reason: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  return summary;
}

/** The manual entry point, sharing every line of the enqueue path with cron. */
export async function runJobById(
  env: Env,
  idOrName: Job | string,
): Promise<{ suppressed?: string; result?: JobResult }> {
  if (isDormant(env)) return { suppressed: DORMANT_REASON };
  const settings = await loadSettings(env.DB);
  const run = guardRun(settings);
  if (!run.allowed) return { suppressed: run.reason };

  const job = typeof idOrName === "string" ? await loadJob(env.DB, idOrName) : idOrName;
  if (!job) throw new Error(`job not found: ${String(idOrName)}`);

  return { result: await runJob(env, settings, job, { kind: "manual", at: new Date() }) };
}
