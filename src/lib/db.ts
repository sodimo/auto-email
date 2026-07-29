/** Typed reads against the auto-email D1. No business logic lives here. */
import type { Job, Recipient, Settings, Template } from "../types.js";

export async function loadSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const settings: Settings = {};
  for (const row of results) settings[row.key] = row.value;
  return settings;
}

const JOB_COLUMNS =
  "id, name, display_name, kind, enabled, schedule, template_id, recipient_list_id, condition_sql, dedupe_strategy, source, preset";

export async function loadEnabledJobs(db: D1Database): Promise<Job[]> {
  const { results } = await db
    .prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE enabled = 1 ORDER BY id`)
    .all<Job>();
  return results;
}

/** Manual triggers load a job by id or by name, and IGNORE `enabled` — that is
 *  the point of a manual run. The guard still applies. */
export async function loadJob(db: D1Database, idOrName: string): Promise<Job | null> {
  const numeric = Number(idOrName);
  const statement = Number.isInteger(numeric)
    ? db.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`).bind(numeric)
    : db.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE name = ?`).bind(idOrName);
  return await statement.first<Job>();
}

export async function loadTemplate(db: D1Database, templateId: number): Promise<Template | null> {
  return await db
    .prepare("SELECT id, name, subject_fr, body_html, body_text, body_source FROM templates WHERE id = ?")
    .bind(templateId)
    .first<Template>();
}

export async function loadRecipients(db: D1Database, listId: number): Promise<Recipient[]> {
  const { results } = await db
    .prepare(
      "SELECT email, display_name FROM recipient_list_members WHERE list_id = ? AND active = 1 ORDER BY email",
    )
    .bind(listId)
    .all<Recipient>();
  return results;
}
