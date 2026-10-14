import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveDataSource } from "../src/lib/datasource.js";
import { ERP_ROW_FLOORS, erpReadiness, validateErpRun, validateErpSnapshot, type ErpRun, type ErpSnapshot } from "../src/lib/erp.js";
import { NIGHTLY_DIGEST_SQL, OVERDUE_PAYMENTS_SQL } from "../src/lib/job-presets.js";

const NOW = new Date("2026-07-29T08:00:00Z");
const LOADED = "2026-07-29T01:00:00Z";

function healthySnapshot(overrides: Partial<ErpSnapshot> = {}): ErpSnapshot {
  return {
    fact_ventes: ERP_ROW_FLOORS.fact_ventes,
    dim_client: ERP_ROW_FLOORS.dim_client,
    fact_reglements: ERP_ROW_FLOORS.fact_reglements,
    fact_echeances: ERP_ROW_FLOORS.fact_echeances,
    ventes_loaded_at: LOADED,
    clients_loaded_at: LOADED,
    reglements_loaded_at: LOADED,
    echeances_loaded_at: LOADED,
    latest_sales_day: "2026-07-28",
    ...overrides,
  };
}

describe("ERP readiness", () => {
  it("accepts a complete, settled and fresh nightly load", () => {
    expect(validateErpSnapshot(healthySnapshot(), NOW)).toMatchObject({
      ready: true,
      reason: null,
      loadedAt: LOADED,
      latestSalesDay: "2026-07-28",
    });
  });

  it("fails closed on partial, mixed, still-loading, stale and future snapshots", () => {
    const cases: [string, Partial<ErpSnapshot>][] = [
      ["vide", { fact_ventes: 99_999 }],
      ["même chargement", { reglements_loaded_at: "2026-07-28T01:00:00Z" }],
      [
        "stabilisation",
        {
          ventes_loaded_at: "2026-07-29T07:55:00Z",
          clients_loaded_at: "2026-07-29T07:55:00Z",
          reglements_loaded_at: "2026-07-29T07:55:00Z",
          echeances_loaded_at: "2026-07-29T07:55:00Z",
        },
      ],
      [
        "trop ancien",
        {
          ventes_loaded_at: "2026-07-27T01:00:00Z",
          clients_loaded_at: "2026-07-27T01:00:00Z",
          reglements_loaded_at: "2026-07-27T01:00:00Z",
          echeances_loaded_at: "2026-07-27T01:00:00Z",
        },
      ],
      [
        "futur",
        {
          ventes_loaded_at: "2026-07-29T09:00:00Z",
          clients_loaded_at: "2026-07-29T09:00:00Z",
          reglements_loaded_at: "2026-07-29T09:00:00Z",
          echeances_loaded_at: "2026-07-29T09:00:00Z",
        },
      ],
    ];

    for (const [reason, overrides] of cases) {
      const result = validateErpSnapshot(healthySnapshot(overrides), NOW);
      expect(result.ready, reason).toBe(false);
      expect(result.reason?.toLowerCase(), reason).toContain(reason);
    }
  });
});

describe("incremental ERP completion", () => {
  const completed: ErpRun = {
    run_id: "run-complete", status: "ok", started_at: LOADED, finished_at: "2026-07-29T01:05:00Z",
    source_loaded_at: LOADED, counts_json: JSON.stringify(ERP_ROW_FLOORS),
    latest_sales_day: "2026-07-28",
  };

  it("accepts an unchanged but freshly verified run without querying ERP rows", async () => {
    await env.ERP.prepare(`CREATE TABLE IF NOT EXISTS etl_run (
      id TEXT PRIMARY KEY, run_id TEXT, status TEXT, started_at TEXT, finished_at TEXT,
      source_loaded_at TEXT, counts_json TEXT, latest_sales_day TEXT
    )`).run();
    await env.ERP.prepare(`INSERT OR REPLACE INTO etl_run VALUES ('latest', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(completed.run_id, completed.status, completed.started_at, completed.finished_at,
        completed.source_loaded_at, completed.counts_json, completed.latest_sales_day).run();
    expect(await erpReadiness(env.ERP, NOW)).toMatchObject({
      ready: true, loadedAt: completed.finished_at, latestSalesDay: "2026-07-28",
    });
    await env.ERP.exec("DROP TABLE etl_run");
  });

  it("rejects missing, partial, failed, malformed, stale and future completion records", () => {
    expect(validateErpRun(null, NOW).ready).toBe(false);
    for (const patch of [
      { run_id: "" }, { status: "running" }, { status: "failed" }, { finished_at: null },
      { counts_json: "oops" }, { counts_json: "null" }, { counts_json: "[]" },
      { counts_json: JSON.stringify({ ...ERP_ROW_FLOORS, fact_ventes: 99_999 }) },
      { source_loaded_at: "2026-07-26T01:00:00Z" },
      { finished_at: "2026-07-29T00:00:00Z" },
      { finished_at: "2026-07-29T09:00:00Z" },
      { finished_at: "2026-07-29T07:55:00Z" },
    ]) {
      expect(validateErpRun({ ...completed, ...patch }, NOW).ready, JSON.stringify(patch)).toBe(false);
    }
  });
});

describe("built-in ERP job queries", () => {
  it("seeds both production jobs against their explicit ERP presets", async () => {
    const { results } = await env.DB.prepare(
      `SELECT name, kind, enabled, schedule, source, preset, condition_sql
         FROM jobs
        WHERE name IN ('rapport-nightly', 'paiements-en-retard')
        ORDER BY name`,
    ).all<{
      name: string;
      kind: string;
      enabled: number;
      schedule: string;
      source: string;
      preset: string;
      condition_sql: string;
    }>();

    expect(results).toEqual([
      expect.objectContaining({
        name: "paiements-en-retard",
        kind: "condition",
        enabled: 0,
        schedule: "0 7 * * 1",
        source: "erp",
        preset: "overdue_30",
        condition_sql: OVERDUE_PAYMENTS_SQL,
      }),
      expect.objectContaining({
        name: "rapport-nightly",
        kind: "digest",
        enabled: 0,
        schedule: "0 6 * * *",
        source: "erp",
        preset: "sales_daily",
        condition_sql: NIGHTLY_DIGEST_SQL,
      }),
    ]);
  });

  beforeEach(async () => {
    await env.ERP.prepare(
      `CREATE TABLE IF NOT EXISTS fact_ventes (
        numdoc TEXT, date TEXT, type TEXT, tiers_code TEXT,
        qte REAL, pvnet REAL, pmpa REAL, loaded_at TEXT
      )`,
    ).run();
    // Same index as sodimo/etl migration 0005; the digest names it explicitly.
    await env.ERP.prepare(
      "CREATE INDEX IF NOT EXISTS idx_fact_ventes_date ON fact_ventes(date)",
    ).run();
    await env.ERP.prepare(
      `CREATE TABLE IF NOT EXISTS dim_client (
        code TEXT, type TEXT, nom TEXT, loaded_at TEXT
      )`,
    ).run();
    await env.ERP.prepare(
      `CREATE TABLE IF NOT EXISTS fact_echeances (
        numdoc TEXT, numech INTEGER, datech TEXT, montant REAL, loaded_at TEXT
      )`,
    ).run();
    await env.ERP.prepare(
      `CREATE TABLE IF NOT EXISTS fact_reglements (
        numreg TEXT, date TEXT, tiers_code TEXT, montant REAL, loaded_at TEXT
      )`,
    ).run();
    await env.ERP.batch([
      env.ERP.prepare("DELETE FROM fact_ventes"),
      env.ERP.prepare("DELETE FROM dim_client"),
      env.ERP.prepare("DELETE FROM fact_echeances"),
      env.ERP.prepare("DELETE FROM fact_reglements"),
    ]);
  });

  it("computes dashboard-faithful metrics for the latest loaded sales day", async () => {
    await env.ERP.prepare(`
      INSERT INTO fact_ventes VALUES
        ('F-OLD', '2026-07-27', 'VF', 'C1', 1, 100, 60, '${LOADED}'),
        ('F-1',   '2026-07-28', 'VF', 'C1', 2, 100, 60, '${LOADED}'),
        ('F-2',   '2026-07-28', 'VF', 'C2', 1, 50,  20, '${LOADED}'),
        ('A-1',   '2026-07-28', 'VA', 'C2', 9, 999,  0, '${LOADED}')
    `).run();

    const rows = await resolveDataSource(env, "erp").query(NIGHTLY_DIGEST_SQL);

    expect(rows).toEqual([
      expect.objectContaining({
        jour_fr: "28/07/2026",
        ca_ht: "250,00 €",
        marge_brute: "110,00 €",
        taux_marge: "44,0 %",
        documents: "2",
        clients: "2",
        quantite: "3",
        jour_precedent_fr: "27/07/2026",
        variation_ca: "+150,0 %",
        mise_a_jour_fr: "29/07/2026 à 01:00 UTC",
      }),
    ]);
  });

  it("nets payments oldest-first at client level and keeps only 30-day balances", async () => {
    await env.ERP.batch([
      env.ERP.prepare(`INSERT INTO dim_client VALUES ('C1', 'C', 'Maison Démo', '${LOADED}')`),
      env.ERP.prepare(`
        INSERT INTO fact_ventes VALUES
          ('F-100', '2026-04-01', 'VF', 'C1', 1, 100, 50, '${LOADED}'),
          ('F-200', '2026-05-01', 'VF', 'C1', 1, 200, 80, '${LOADED}')
      `),
      env.ERP.prepare(`
        INSERT INTO fact_echeances VALUES
          ('F-100', 1, '2026-05-01', 100, '${LOADED}'),
          ('F-200', 1, '2026-06-01', 200, '${LOADED}')
      `),
      env.ERP.prepare(
        `INSERT INTO fact_reglements VALUES ('R-120', '2026-06-15', 'C1', 120, '${LOADED}')`,
      ),
    ]);

    const rows = await resolveDataSource(env, "erp").query(OVERDUE_PAYMENTS_SQL);

    expect(rows).toEqual([
      {
        Client: "Maison Démo",
        Code: "C1",
        Échéances: 1,
        "Montant net estimé": "180,00 €",
        "Plus ancienne": "01/06/2026",
        "Retard max (jours)": expect.any(Number),
      },
    ]);
  });

  it("uses the settlement document to identify the client when no sales document matches", async () => {
    await env.ERP.batch([
      env.ERP.prepare(`INSERT INTO dim_client VALUES ('C2', 'C', 'Client Réel', '${LOADED}')`),
      env.ERP.prepare(`
        INSERT INTO fact_echeances VALUES
          ('R-900', 1, '2026-05-01', 250, '${LOADED}')
      `),
      env.ERP.prepare(
        `INSERT INTO fact_reglements VALUES ('R-900', '2026-06-15', 'C2', 50, '${LOADED}')`,
      ),
    ]);

    const rows = await resolveDataSource(env, "erp").query(OVERDUE_PAYMENTS_SQL);

    expect(rows).toEqual([
      expect.objectContaining({
        Client: "Client Réel",
        Code: "C2",
        Échéances: 1,
        "Montant net estimé": "200,00 €",
      }),
    ]);
  });
});
