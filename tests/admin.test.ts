import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { OVERDUE_PAYMENTS_SQL } from "../src/lib/job-presets.js";
import { cronToSchedule, scheduleLabel, scheduleToCron } from "../src/admin/schedule.js";
import { friendlyBodyToHtml } from "../src/admin/template.js";

const tokenAuth = { "x-trigger-token": "test-token" };
const basicAuth = { authorization: "Basic c29kaW1vOnRlc3QtdG9rZW4=" }; // sodimo:test-token

async function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = tokenAuth,
): Promise<Response> {
  return await SELF.fetch(`https://auto-email.test${path}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function state(): Promise<any> {
  const response = await request("GET", "/api/admin/state");
  expect(response.status).toBe(200);
  return await response.json();
}

describe("human schedules", () => {
  it("round-trips the four UI choices without exposing cron to the operator", () => {
    const choices = [
      [{ cadence: "daily", hour: 6, minute: 0 }, "0 6 * * *", "Tous les jours à 06:00 UTC"],
      [{ cadence: "weekdays", hour: 7, minute: 15 }, "15 7 * * 1-5", "Du lundi au vendredi à 07:15 UTC"],
      [{ cadence: "weekly", hour: 8, minute: 30, weekday: 2 }, "30 8 * * 2", "Chaque mardi à 08:30 UTC"],
      [{ cadence: "monthly", hour: 9, minute: 5, monthday: 12 }, "5 9 12 * *", "Le 12 de chaque mois à 09:05 UTC"],
    ] as const;

    for (const [human, cron, label] of choices) {
      expect(scheduleToCron(human)).toBe(cron);
      expect(cronToSchedule(cron)).toEqual(human);
      expect(scheduleLabel(human)).toBe(label);
    }
    expect(cronToSchedule("*/5 * * * *")).toBeNull();
  });
});

describe("friendly template conversion", () => {
  it("keeps placeholders, escapes authored HTML and creates the dashboard action", () => {
    const html = friendlyBodyToHtml(
      "Bonjour {{job_label}},\n\n<script>alert(1)</script>\n\n{{{rows_table_html}}}\n\nTableau de bord : {{dashboard_url}}",
    );
    expect(html).toContain("Bonjour {{job_label}}");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("{{{rows_table_html}}}");
    expect(html).toContain('href="{{dashboard_url}}"');
  });
});

describe("admin authentication and page", () => {
  it("keeps the complete UI behind auth and accepts interim HTTP Basic", async () => {
    const anonymous = await SELF.fetch("https://auto-email.test/");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("Basic");
    expect((await SELF.fetch("https://auto-email.test/api/admin/state")).status).toBe(401);

    const wrongUser = await request("GET", "/", undefined, {
      authorization: "Basic bm90LXNvZGltbzp0ZXN0LXRva2Vu", // not-sodimo:test-token
    });
    expect(wrongUser.status).toBe(401);

    const response = await request("GET", "/", undefined, basicAuth);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-security-policy")).toMatch(/script-src 'nonce-[^']+'/);
    expect(html).toContain("Envois automatiques");
    expect(html).toContain("Arrêt général");
    expect(html).toContain("Mode test verrouillé");
    expect(html).not.toContain("0 6 * * *");
    expect((await request("GET", "/api/admin/state", undefined, basicAuth)).status).toBe(200);
  });

  it("refuses cross-site mutations even with a valid credential", async () => {
    const response = await request(
      "POST",
      "/api/admin/kill-switch",
      { engaged: true },
      { ...tokenAuth, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    );
    expect(response.status).toBe(403);
    expect((await state()).safety.kill_switch).toBe("off");
  });
});

describe("admin state and job management", () => {
  it("returns the French-facing state with structured schedules and safety posture", async () => {
    const snapshot = await state();
    const digest = snapshot.jobs.find((job: any) => job.name === "rapport-nightly");
    expect(digest).toMatchObject({
      display_name: "Rapport quotidien des ventes",
      kind: "digest",
      enabled: false,
      source: "erp",
      preset: "sales_daily",
      schedule: { cadence: "daily", hour: 6, minute: 0 },
      schedule_label: "Tous les jours à 06:00 UTC",
    });
    expect(snapshot.safety).toMatchObject({
      kill_switch: "off",
      test_mode: "on",
      forced_test_mode: true,
      pinned_recipients: ["thomas@leger.run", "tombionic@gmail.com"],
    });
    expect(snapshot.templates.some((template: any) => template.name === "echeances-retard")).toBe(true);
  });

  it("creates and updates a job from human schedule fields only", async () => {
    const snapshot = await state();
    const template = snapshot.templates.find((item: any) => item.name === "test-generic");
    const list = snapshot.recipient_lists.find((item: any) => item.name === "test");
    const created = await request("POST", "/api/admin/jobs", {
      display_name: "Rapport des jours ouvrés",
      kind: "digest",
      enabled: false,
      schedule: { cadence: "weekdays", hour: 7, minute: 15 },
      template_id: template.id,
      recipient_list_id: list.id,
      condition_sql: null,
      dedupe_strategy: "per_day",
      source: "own",
      preset: "custom",
    });
    expect(created.status).toBe(201);
    const id = (await created.json() as any).id;
    expect(
      await env.DB.prepare("SELECT name, schedule, enabled FROM jobs WHERE id = ?")
        .bind(id)
        .first(),
    ).toEqual({ name: "rapport-des-jours-ouvres", schedule: "15 7 * * 1-5", enabled: 0 });

    const updated = await request("PUT", `/api/admin/jobs/${id}`, {
      display_name: "Rapport du mardi",
      kind: "digest",
      enabled: true,
      schedule: { cadence: "weekly", hour: 8, minute: 30, weekday: 2 },
      template_id: template.id,
      recipient_list_id: list.id,
      condition_sql: null,
      dedupe_strategy: "per_run",
      source: "own",
      preset: "custom",
    });
    expect(updated.status).toBe(200);
    expect(
      await env.DB.prepare("SELECT display_name, schedule, enabled FROM jobs WHERE id = ?")
        .bind(id)
        .first(),
    ).toEqual({ display_name: "Rapport du mardi", schedule: "30 8 * * 2", enabled: 1 });
  });

  it("rejects raw cron input and unsafe custom conditions", async () => {
    const snapshot = await state();
    const base = {
      display_name: "Invalide",
      kind: "condition",
      enabled: false,
      template_id: snapshot.templates[0].id,
      recipient_list_id: snapshot.recipient_lists[0].id,
      dedupe_strategy: "per_run",
      source: "erp",
      preset: "custom",
    };
    const cron = await request("POST", "/api/admin/jobs", {
      ...base,
      schedule: "0 7 * * *",
      condition_sql: "SELECT 1",
    });
    expect(cron.status).toBe(400);

    const unsafe = await request("POST", "/api/admin/jobs", {
      ...base,
      schedule: { cadence: "daily", hour: 7, minute: 0 },
      condition_sql: "DELETE FROM send_log",
    });
    expect(unsafe.status).toBe(400);
  });

  it("pins an integrated preset to its reviewed ERP SQL", async () => {
    const snapshot = await state();
    const response = await request("POST", "/api/admin/jobs", {
      display_name: "Alerte test échéances",
      kind: "condition",
      enabled: false,
      schedule: { cadence: "weekly", hour: 7, minute: 0, weekday: 1 },
      template_id: snapshot.templates[0].id,
      recipient_list_id: snapshot.recipient_lists[0].id,
      condition_sql: "DELETE FROM fact_echeances",
      dedupe_strategy: "per_day",
      source: "own",
      preset: "overdue_30",
    });
    expect(response.status).toBe(201);
    const id = (await response.json() as any).id;
    expect(
      await env.DB.prepare("SELECT source, preset, condition_sql FROM jobs WHERE id = ?")
        .bind(id)
        .first(),
    ).toEqual({ source: "erp", preset: "overdue_30", condition_sql: OVERDUE_PAYMENTS_SQL });
  });

  it("pauses and enables without changing the job definition", async () => {
    const digest = (await state()).jobs.find((job: any) => job.name === "rapport-nightly");
    const enable = await request("POST", `/api/admin/jobs/${digest.id}/status`, { enabled: true });
    expect(enable.status).toBe(200);
    expect(
      await env.DB.prepare("SELECT enabled, preset FROM jobs WHERE id = ?").bind(digest.id).first(),
    ).toEqual({ enabled: 1, preset: "sales_daily" });

    const pause = await request("POST", `/api/admin/jobs/${digest.id}/status`, { enabled: false });
    expect(pause.status).toBe(200);
    expect(await env.DB.prepare("SELECT enabled FROM jobs WHERE id = ?").bind(digest.id).first()).toEqual({
      enabled: 0,
    });
  });

  it("runs admin tests through the same kill switch before any transport", async () => {
    const digest = (await state()).jobs.find((job: any) => job.name === "rapport-nightly");
    await request("POST", "/api/admin/kill-switch", { engaged: true });
    const response = await request("POST", `/api/admin/jobs/${digest.id}/trigger`);
    expect(response.status).toBe(409);
    expect((await response.json() as any).error).toContain("kill switch");
  });
});

describe("templates, recipients, history and kill switch", () => {
  it("creates a safe HTML alternative from the friendly template body", async () => {
    const response = await request("POST", "/api/admin/templates", {
      name: "Relance interne",
      subject_fr: "Point {{date_fr}}",
      body_source: "Bonjour,\n\n<script>non</script>\n\nTableau de bord : {{dashboard_url}}",
    });
    expect(response.status).toBe(201);
    const id = (await response.json() as any).id;
    const row = await env.DB.prepare(
      "SELECT subject_fr, body_source, body_text, body_html FROM templates WHERE id = ?",
    )
      .bind(id)
      .first<any>();
    expect(row.subject_fr).toBe("Point {{date_fr}}");
    expect(row.body_text).toBe(row.body_source);
    expect(row.body_html).toContain("&lt;script&gt;non&lt;/script&gt;");
    expect(row.body_html).not.toContain("<script>non");
    expect(row.body_html).toContain('href="{{dashboard_url}}"');
  });

  it("creates a list and manages its members", async () => {
    const listResponse = await request("POST", "/api/admin/recipient-lists", { name: "Direction" });
    expect(listResponse.status).toBe(201);
    const listId = (await listResponse.json() as any).id;

    const add = await request("POST", `/api/admin/recipient-lists/${listId}/members`, {
      email: "RANI@SODIMO.EU",
      display_name: "Rani",
      active: true,
    });
    expect(add.status).toBe(201);
    const memberId = (await add.json() as any).id;
    expect(
      await env.DB.prepare("SELECT email, display_name, active FROM recipient_list_members WHERE id = ?")
        .bind(memberId)
        .first(),
    ).toEqual({ email: "rani@sodimo.eu", display_name: "Rani", active: 1 });

    expect(
      (await request("PUT", `/api/admin/recipients/${memberId}`, {
        email: "rani@sodimo.eu",
        display_name: "Rani Sodimo",
        active: false,
      })).status,
    ).toBe(200);
    expect(
      await env.DB.prepare("SELECT display_name, active FROM recipient_list_members WHERE id = ?")
        .bind(memberId)
        .first(),
    ).toEqual({ display_name: "Rani Sodimo", active: 0 });

    expect((await request("DELETE", `/api/admin/recipients/${memberId}`)).status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM recipient_list_members WHERE id = ?").bind(memberId).first()).toBeNull();
  });

  it("makes the kill switch visible in state and fails closed on unexpected values", async () => {
    expect((await request("POST", "/api/admin/kill-switch", { engaged: true })).status).toBe(200);
    expect((await state()).safety.kill_switch).toBe("engaged");
    await env.DB.prepare("UPDATE settings SET value = 'unexpected' WHERE key = 'kill_switch'").run();
    expect((await state()).safety.kill_switch).toBe("engaged");
    expect((await request("POST", "/api/admin/kill-switch", { engaged: false })).status).toBe(200);
    expect((await state()).safety.kill_switch).toBe("off");
  });

  it("shows SMTP, failure and Sent-folder append evidence in history", async () => {
    const job = await env.DB.prepare("SELECT id FROM jobs WHERE name = 'rapport-nightly'").first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO send_log (
         job_id, recipient, dedupe_key, status, smtp_response, message_id,
         append_status, append_response
       )
       VALUES (?, 'thomas@leger.run', 'manual:test', 'sent', '250 queued', '<test@sodimo.eu>',
               'failed', 'APPEND failed: quota')`,
    )
      .bind(job!.id)
      .run();

    const history = (await state()).history[0];
    expect(history).toMatchObject({
      job_label: "Rapport quotidien des ventes",
      recipient: "thomas@leger.run",
      status: "sent",
      smtp_response: "250 queued",
      append_status: "failed",
      append_response: "APPEND failed: quota",
    });
  });
});
