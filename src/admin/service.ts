import { FORCE_TEST_MODE } from "../config.js";
import { assertReadOnlySql } from "../lib/datasource.js";
import { erpReadiness, type ErpReadiness } from "../lib/erp.js";
import { TEST_MODE_ALLOWLIST } from "../lib/guard.js";
import { sqlForPreset } from "../lib/job-presets.js";
import type {
  DataSourceName,
  DedupeStrategy,
  Env,
  JobKind,
  JobPreset,
} from "../types.js";
import {
  cronToSchedule,
  scheduleLabel,
  scheduleToCron,
  type HumanSchedule,
} from "./schedule.js";
import { friendlyBodyToHtml, normalizeTemplateBody } from "./template.js";

export class AdminInputError extends Error {
  readonly status = 400;
}

export class AdminNotFoundError extends Error {
  readonly status = 404;
}

export class AdminConflictError extends Error {
  readonly status = 409;
}

type Input = Record<string, unknown>;

function inputRecord(value: unknown): Input {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdminInputError("Le formulaire envoyé est invalide.");
  }
  return value as Input;
}

function text(
  value: unknown,
  label: string,
  options: { min?: number; max: number; optional?: boolean } = { max: 200 },
): string | null {
  if ((value === undefined || value === null) && options.optional) return null;
  if (typeof value !== "string") throw new AdminInputError(`${label} est absent.`);
  const normalized = value.trim();
  if (!normalized && options.optional) return null;
  const min = options.min ?? 1;
  if (normalized.length < min) throw new AdminInputError(`${label} est trop court.`);
  if (normalized.length > options.max) {
    throw new AdminInputError(`${label} dépasse ${options.max} caractères.`);
  }
  return normalized;
}

function positiveId(value: unknown, label: string): number {
  const id = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(id) || id < 1) throw new AdminInputError(`${label} est invalide.`);
  return id;
}

function bool(value: unknown, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new AdminInputError("Une valeur oui/non est invalide.");
  return value;
}

function choice<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) throw new AdminInputError(`${label} n’est pas reconnu.`);
  return value as T;
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 54)
    .replace(/-+$/g, "");
  return slug || "envoi";
}

async function uniqueJobName(db: D1Database, label: string): Promise<string> {
  const base = slugify(label);
  for (let suffix = 1; suffix <= 99; suffix++) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    const existing = await db.prepare("SELECT 1 FROM jobs WHERE name = ?").bind(candidate).first();
    if (!existing) return candidate;
  }
  throw new AdminConflictError("Impossible de créer un identifiant unique pour cet envoi.");
}

interface NormalizedJobInput {
  displayName: string;
  kind: JobKind;
  enabled: boolean;
  schedule: string;
  templateId: number;
  recipientListId: number;
  conditionSql: string | null;
  dedupeStrategy: DedupeStrategy;
  source: DataSourceName;
  preset: JobPreset;
}

function normalizeJobInput(value: unknown): NormalizedJobInput {
  const body = inputRecord(value);
  const displayName = text(body["display_name"], "Le nom de l’envoi", { max: 120 })!;
  const kind = choice(body["kind"], ["digest", "condition"] as const, "Le type d’envoi");
  let source = choice(body["source"] ?? "erp", ["own", "erp"] as const, "La source de données");
  const preset = choice(
    body["preset"] ?? "custom",
    ["custom", "sales_daily", "overdue_30"] as const,
    "La règle",
  );
  const dedupeStrategy = choice(
    body["dedupe_strategy"] ?? (kind === "digest" ? "per_day" : "per_run"),
    ["per_run", "per_day", "per_row"] as const,
    "La règle anti-doublon",
  );

  let conditionSql = text(body["condition_sql"], "La requête", {
    max: 50_000,
    optional: true,
  });
  const presetSql = sqlForPreset(preset);
  if (presetSql) {
    conditionSql = presetSql;
    source = "erp";
  }

  if (preset === "sales_daily" && kind !== "digest") {
    throw new AdminInputError("La règle « ventes du dernier jour » est un rapport programmé.");
  }
  if (preset === "overdue_30" && kind !== "condition") {
    throw new AdminInputError("La règle « échéances de 30 jours » est une alerte conditionnelle.");
  }
  if (kind === "condition" && !conditionSql) {
    throw new AdminInputError("Une alerte conditionnelle a besoin d’une règle de données.");
  }
  if (dedupeStrategy === "per_row" && kind !== "condition") {
    throw new AdminInputError("L’option « une fois par élément » est réservée aux alertes.");
  }
  if (dedupeStrategy === "per_row" && preset !== "custom") {
    throw new AdminInputError("Cette règle intégrée envoie une synthèse, pas un message par élément.");
  }
  if (conditionSql) {
    try {
      assertReadOnlySql(conditionSql);
    } catch (cause) {
      throw new AdminInputError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  let schedule: string;
  try {
    schedule = scheduleToCron(body["schedule"]);
  } catch (cause) {
    throw new AdminInputError(cause instanceof Error ? cause.message : String(cause));
  }

  return {
    displayName,
    kind,
    enabled: bool(body["enabled"]),
    schedule,
    templateId: positiveId(body["template_id"], "Le modèle"),
    recipientListId: positiveId(body["recipient_list_id"], "La liste de destinataires"),
    conditionSql,
    dedupeStrategy,
    source,
    preset,
  };
}

async function validateJobReferences(
  db: D1Database,
  input: Pick<NormalizedJobInput, "templateId" | "recipientListId" | "enabled">,
): Promise<void> {
  const [template, list] = await Promise.all([
    db.prepare("SELECT 1 FROM templates WHERE id = ?").bind(input.templateId).first(),
    db
      .prepare(
        `SELECT l.id, COUNT(CASE WHEN m.active = 1 THEN 1 END) AS active_members
           FROM recipient_lists l
           LEFT JOIN recipient_list_members m ON m.list_id = l.id
          WHERE l.id = ?
          GROUP BY l.id`,
      )
      .bind(input.recipientListId)
      .first<{ id: number; active_members: number }>(),
  ]);
  if (!template) throw new AdminInputError("Le modèle choisi n’existe plus.");
  if (!list) throw new AdminInputError("La liste de destinataires choisie n’existe plus.");
  if (input.enabled && Number(list.active_members) < 1) {
    throw new AdminInputError("Ajoutez au moins un destinataire actif avant d’activer cet envoi.");
  }
}

export async function createJob(db: D1Database, value: unknown): Promise<{ id: number }> {
  const input = normalizeJobInput(value);
  await validateJobReferences(db, input);
  const name = await uniqueJobName(db, input.displayName);
  const row = await db
    .prepare(
      `INSERT INTO jobs (
         name, display_name, kind, enabled, schedule, template_id,
         recipient_list_id, condition_sql, dedupe_strategy, source, preset
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .bind(
      name,
      input.displayName,
      input.kind,
      input.enabled ? 1 : 0,
      input.schedule,
      input.templateId,
      input.recipientListId,
      input.conditionSql,
      input.dedupeStrategy,
      input.source,
      input.preset,
    )
    .first<{ id: number }>();
  if (!row) throw new Error("La création de l’envoi n’a retourné aucun identifiant.");
  return row;
}

export async function updateJob(db: D1Database, idValue: unknown, value: unknown): Promise<void> {
  const id = positiveId(idValue, "L’envoi");
  const input = normalizeJobInput(value);
  await validateJobReferences(db, input);
  const result = await db
    .prepare(
      `UPDATE jobs
          SET display_name = ?, kind = ?, enabled = ?, schedule = ?,
              template_id = ?, recipient_list_id = ?, condition_sql = ?,
              dedupe_strategy = ?, source = ?, preset = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
    )
    .bind(
      input.displayName,
      input.kind,
      input.enabled ? 1 : 0,
      input.schedule,
      input.templateId,
      input.recipientListId,
      input.conditionSql,
      input.dedupeStrategy,
      input.source,
      input.preset,
      id,
    )
    .run();
  if (Number(result.meta.changes) !== 1) throw new AdminNotFoundError("Envoi introuvable.");
}

export async function setJobEnabled(db: D1Database, idValue: unknown, value: unknown): Promise<void> {
  const id = positiveId(idValue, "L’envoi");
  const body = inputRecord(value);
  const enabled = bool(body["enabled"]);
  const job = await db
    .prepare(
      `SELECT j.id, j.template_id, j.recipient_list_id,
              COUNT(CASE WHEN m.active = 1 THEN 1 END) AS active_members
         FROM jobs j
         LEFT JOIN recipient_list_members m ON m.list_id = j.recipient_list_id
        WHERE j.id = ?
        GROUP BY j.id`,
    )
    .bind(id)
    .first<{ id: number; template_id: number; recipient_list_id: number; active_members: number }>();
  if (!job) throw new AdminNotFoundError("Envoi introuvable.");
  if (enabled && Number(job.active_members) < 1) {
    throw new AdminInputError("Cet envoi n’a aucun destinataire actif.");
  }
  await db
    .prepare(
      `UPDATE jobs SET enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
    )
    .bind(enabled ? 1 : 0, id)
    .run();
}

function templateName(value: unknown): string {
  return text(value, "Le nom du modèle", { max: 100 })!;
}

function templateSubject(value: unknown): string {
  return text(value, "L’objet du message", { max: 240 })!;
}

function normalizeTemplateInput(value: unknown): {
  name: string;
  subject: string;
  source: string;
  html: string;
} {
  const body = inputRecord(value);
  let source: string;
  try {
    source = normalizeTemplateBody(body["body_source"]);
  } catch (cause) {
    throw new AdminInputError(cause instanceof Error ? cause.message : String(cause));
  }
  return {
    name: templateName(body["name"]),
    subject: templateSubject(body["subject_fr"]),
    source,
    html: friendlyBodyToHtml(source),
  };
}

export async function createTemplate(db: D1Database, value: unknown): Promise<{ id: number }> {
  const template = normalizeTemplateInput(value);
  try {
    const row = await db
      .prepare(
        `INSERT INTO templates (name, subject_fr, body_source, body_html, body_text)
         VALUES (?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .bind(template.name, template.subject, template.source, template.html, template.source)
      .first<{ id: number }>();
    if (!row) throw new Error("La création du modèle n’a retourné aucun identifiant.");
    return row;
  } catch (cause) {
    if (/unique/i.test(cause instanceof Error ? cause.message : String(cause))) {
      throw new AdminConflictError("Un modèle porte déjà ce nom.");
    }
    throw cause;
  }
}

export async function updateTemplate(db: D1Database, idValue: unknown, value: unknown): Promise<void> {
  const id = positiveId(idValue, "Le modèle");
  const template = normalizeTemplateInput(value);
  try {
    const result = await db
      .prepare(
        `UPDATE templates
            SET name = ?, subject_fr = ?, body_source = ?, body_html = ?, body_text = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          WHERE id = ?`,
      )
      .bind(template.name, template.subject, template.source, template.html, template.source, id)
      .run();
    if (Number(result.meta.changes) !== 1) throw new AdminNotFoundError("Modèle introuvable.");
  } catch (cause) {
    if (/unique/i.test(cause instanceof Error ? cause.message : String(cause))) {
      throw new AdminConflictError("Un modèle porte déjà ce nom.");
    }
    throw cause;
  }
}

function listName(value: unknown): string {
  return text(value, "Le nom de la liste", { max: 100 })!;
}

export async function createRecipientList(db: D1Database, value: unknown): Promise<{ id: number }> {
  const body = inputRecord(value);
  try {
    const row = await db
      .prepare("INSERT INTO recipient_lists (name) VALUES (?) RETURNING id")
      .bind(listName(body["name"]))
      .first<{ id: number }>();
    if (!row) throw new Error("La création de la liste n’a retourné aucun identifiant.");
    return row;
  } catch (cause) {
    if (/unique/i.test(cause instanceof Error ? cause.message : String(cause))) {
      throw new AdminConflictError("Une liste porte déjà ce nom.");
    }
    throw cause;
  }
}

export async function updateRecipientList(
  db: D1Database,
  idValue: unknown,
  value: unknown,
): Promise<void> {
  const id = positiveId(idValue, "La liste");
  const body = inputRecord(value);
  try {
    const result = await db
      .prepare(
        "UPDATE recipient_lists SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?",
      )
      .bind(listName(body["name"]), id)
      .run();
    if (Number(result.meta.changes) !== 1) throw new AdminNotFoundError("Liste introuvable.");
  } catch (cause) {
    if (/unique/i.test(cause instanceof Error ? cause.message : String(cause))) {
      throw new AdminConflictError("Une liste porte déjà ce nom.");
    }
    throw cause;
  }
}

function email(value: unknown): string {
  const address = text(value, "L’adresse e-mail", { max: 254 })!.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new AdminInputError("L’adresse e-mail n’est pas valide.");
  }
  return address;
}

function memberInput(value: unknown): { email: string; displayName: string | null; active: boolean } {
  const body = inputRecord(value);
  return {
    email: email(body["email"]),
    displayName: text(body["display_name"], "Le nom", { max: 100, optional: true }),
    active: bool(body["active"], true),
  };
}

export async function addRecipient(
  db: D1Database,
  listIdValue: unknown,
  value: unknown,
): Promise<{ id: number }> {
  const listId = positiveId(listIdValue, "La liste");
  const list = await db.prepare("SELECT 1 FROM recipient_lists WHERE id = ?").bind(listId).first();
  if (!list) throw new AdminNotFoundError("Liste introuvable.");
  const member = memberInput(value);
  try {
    const row = await db
      .prepare(
        `INSERT INTO recipient_list_members (list_id, email, display_name, active)
         VALUES (?, ?, ?, ?)
         RETURNING id`,
      )
      .bind(listId, member.email, member.displayName, member.active ? 1 : 0)
      .first<{ id: number }>();
    if (!row) throw new Error("L’ajout du destinataire n’a retourné aucun identifiant.");
    return row;
  } catch (cause) {
    if (/unique/i.test(cause instanceof Error ? cause.message : String(cause))) {
      throw new AdminConflictError("Cette adresse figure déjà dans la liste.");
    }
    throw cause;
  }
}

export async function updateRecipient(
  db: D1Database,
  memberIdValue: unknown,
  value: unknown,
): Promise<void> {
  const id = positiveId(memberIdValue, "Le destinataire");
  const member = memberInput(value);
  try {
    const result = await db
      .prepare(
        "UPDATE recipient_list_members SET email = ?, display_name = ?, active = ? WHERE id = ?",
      )
      .bind(member.email, member.displayName, member.active ? 1 : 0, id)
      .run();
    if (Number(result.meta.changes) !== 1) throw new AdminNotFoundError("Destinataire introuvable.");
  } catch (cause) {
    if (/unique/i.test(cause instanceof Error ? cause.message : String(cause))) {
      throw new AdminConflictError("Cette adresse figure déjà dans la liste.");
    }
    throw cause;
  }
}

export async function deleteRecipient(db: D1Database, memberIdValue: unknown): Promise<void> {
  const id = positiveId(memberIdValue, "Le destinataire");
  const result = await db.prepare("DELETE FROM recipient_list_members WHERE id = ?").bind(id).run();
  if (Number(result.meta.changes) !== 1) throw new AdminNotFoundError("Destinataire introuvable.");
}

export async function setKillSwitch(db: D1Database, value: unknown): Promise<"on" | "off"> {
  const body = inputRecord(value);
  const state = bool(body["engaged"]) ? "on" : "off";
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('kill_switch', ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .bind(state)
    .run();
  return state;
}

interface AdminJobRow {
  id: number;
  name: string;
  display_name: string | null;
  kind: JobKind;
  enabled: number;
  schedule: string;
  template_id: number;
  template_name: string;
  recipient_list_id: number;
  recipient_list_name: string;
  active_recipients: number;
  condition_sql: string | null;
  dedupe_strategy: DedupeStrategy;
  source: DataSourceName;
  preset: JobPreset;
  last_sent_at: string | null;
  last_status: string | null;
}

export async function loadAdminState(env: Env): Promise<unknown> {
  const [jobsResult, templatesResult, listsResult, membersResult, historyResult, settingsResult] =
    await Promise.all([
      env.DB.prepare(
        `SELECT
           j.id, j.name, j.display_name, j.kind, j.enabled, j.schedule,
           j.template_id, t.name AS template_name,
           j.recipient_list_id, l.name AS recipient_list_name,
           COUNT(DISTINCT CASE WHEN m.active = 1 THEN m.id END) AS active_recipients,
           j.condition_sql, j.dedupe_strategy, j.source, j.preset,
           (SELECT sent_at FROM send_log s WHERE s.job_id = j.id ORDER BY s.id DESC LIMIT 1) AS last_sent_at,
           (SELECT status FROM send_log s WHERE s.job_id = j.id ORDER BY s.id DESC LIMIT 1) AS last_status
         FROM jobs j
         JOIN templates t ON t.id = j.template_id
         JOIN recipient_lists l ON l.id = j.recipient_list_id
         LEFT JOIN recipient_list_members m ON m.list_id = l.id
         GROUP BY j.id
         ORDER BY j.id`,
      ).all<AdminJobRow>(),
      env.DB.prepare(
        `SELECT id, name, subject_fr, COALESCE(body_source, body_text) AS body_source, updated_at
           FROM templates ORDER BY name`,
      ).all<{
        id: number;
        name: string;
        subject_fr: string;
        body_source: string;
        updated_at: string;
      }>(),
      env.DB.prepare(
        `SELECT l.id, l.name, l.updated_at,
                COUNT(m.id) AS members,
                COUNT(CASE WHEN m.active = 1 THEN 1 END) AS active_members
           FROM recipient_lists l
           LEFT JOIN recipient_list_members m ON m.list_id = l.id
          GROUP BY l.id
          ORDER BY l.name`,
      ).all(),
      env.DB.prepare(
        `SELECT id, list_id, email, display_name, active
           FROM recipient_list_members
          ORDER BY list_id, active DESC, email`,
      ).all(),
      env.DB.prepare(
        `SELECT
           s.id, s.sent_at, s.recipient, s.dedupe_key, s.status,
           s.smtp_response, s.message_id, s.append_status, s.append_response,
           j.name AS job_name, COALESCE(j.display_name, j.name) AS job_label,
           o.subject, o.attempts, o.last_error
         FROM send_log s
         JOIN jobs j ON j.id = s.job_id
         LEFT JOIN outbox o ON o.send_log_id = s.id
         ORDER BY s.id DESC
         LIMIT 200`,
      ).all(),
      env.DB.prepare("SELECT key, value, updated_at FROM settings").all<{
        key: string;
        value: string;
        updated_at: string;
      }>(),
    ]);

  const settings = Object.fromEntries(settingsResult.results.map((row) => [row.key, row.value]));
  const testMode = FORCE_TEST_MODE || settings["test_mode"] !== "off";
  let erp: ErpReadiness;
  try {
    erp = await erpReadiness(env.ERP);
  } catch (cause) {
    erp = {
      ready: false,
      reason: cause instanceof Error ? cause.message : String(cause),
      loadedAt: null,
      latestSalesDay: null,
      counts: { fact_ventes: 0, dim_client: 0, fact_reglements: 0, fact_echeances: 0 },
    };
  }

  const jobs = jobsResult.results.map((job) => {
    const schedule = cronToSchedule(job.schedule);
    return {
      ...job,
      enabled: job.enabled === 1,
      schedule,
      schedule_label: scheduleLabel(schedule),
      active_recipients: Number(job.active_recipients),
    };
  });

  return {
    jobs,
    templates: templatesResult.results,
    recipient_lists: listsResult.results,
    recipients: membersResult.results.map((row: Record<string, unknown>) => ({
      ...row,
      active: Number(row["active"]) === 1,
    })),
    history: historyResult.results,
    safety: {
      kill_switch: settings["kill_switch"] === "off" ? "off" : "engaged",
      test_mode: testMode ? "on" : "off",
      forced_test_mode: FORCE_TEST_MODE,
      pinned_recipients: testMode ? TEST_MODE_ALLOWLIST : [],
    },
    erp,
    template_variables: {
      standard: [
        "job_label",
        "date_fr",
        "generated_at",
        "dashboard_url",
        "row_count",
        "rows_text",
        "rows_table_html",
      ],
      sales_daily: [
        "jour_fr",
        "ca_ht",
        "marge_brute",
        "taux_marge",
        "documents",
        "clients",
        "quantite",
        "jour_precedent_fr",
        "variation_ca",
        "mise_a_jour_fr",
      ],
    },
  };
}

export type { HumanSchedule };
