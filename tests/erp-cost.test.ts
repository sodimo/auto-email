/**
 * Read-cost guards against the real ERP schema (sodimo/etl migrations 0002,
 * 0005, 0007, 0008). D1 Free gives the whole account 5 million rows read per
 * day, so the readiness check and the daily digest must read a bounded number
 * of rows however large the sales table grows.
 */
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { erpReadiness, MARKER_SNAPSHOT_SQL } from "../src/lib/erp.js";
import { NIGHTLY_DIGEST_SQL } from "../src/lib/job-presets.js";

const LOADED = "2026-07-29T01:00:00Z";
const NOW = new Date("2026-07-29T08:00:00Z");
const SALES = 120_000; // above the 100,000 floor
const LINES_PER_DAY = 150;

const SCHEMA = [
  `CREATE TABLE dim_client (code TEXT PRIMARY KEY, type TEXT, nom TEXT, cp TEXT, pays TEXT, coll TEXT, famcli TEXT, row_hash TEXT NOT NULL, loaded_at TEXT NOT NULL)`,
  `CREATE INDEX idx_dim_client_type ON dim_client(type)`,
  `CREATE TABLE fact_ventes (numdoc TEXT NOT NULL, numligne INTEGER NOT NULL, date TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('VF','VA')), tiers_code TEXT, article_code TEXT, qte REAL, pvnet REAL, pmpa REAL, rep_code TEXT, marque TEXT, artfam TEXT, pays TEXT, clifam TEXT, row_hash TEXT NOT NULL, loaded_at TEXT NOT NULL, PRIMARY KEY (numdoc, numligne))`,
  `CREATE INDEX idx_fact_ventes_date ON fact_ventes(date)`,
  `CREATE INDEX idx_fact_ventes_tiers_date ON fact_ventes(tiers_code, date)`,
  `CREATE INDEX idx_fact_ventes_article_date ON fact_ventes(article_code, date)`,
  `CREATE INDEX idx_fact_ventes_type ON fact_ventes(type)`,
  `CREATE TABLE fact_reglements (numreg TEXT NOT NULL, numlig INTEGER NOT NULL, date TEXT NOT NULL, tiers_code TEXT, montant REAL, solde REAL, row_hash TEXT NOT NULL, loaded_at TEXT NOT NULL, PRIMARY KEY (numreg, numlig))`,
  `CREATE TABLE fact_echeances (numdoc TEXT NOT NULL, numech INTEGER NOT NULL, datech TEXT, montant REAL, solde REAL, row_hash TEXT NOT NULL, loaded_at TEXT NOT NULL, PRIMARY KEY (numdoc, numech))`,
];

function series(count: number, select: string, table: string): string {
  return `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${count - 1})
          INSERT INTO ${table} SELECT ${select} FROM n`;
}

/** The full-scan form shipped until 2026-10: kept here as the reference. */
const REFERENCE_DIGEST_SQL = `
WITH
latest AS (SELECT MAX(date) AS day FROM fact_ventes WHERE type = 'VF'),
previous AS (SELECT MAX(v.date) AS day FROM fact_ventes v, latest l WHERE v.type = 'VF' AND v.date < l.day),
current_metrics AS (
  SELECT
    COALESCE(SUM(COALESCE(v.qte, 0) * COALESCE(v.pvnet, 0)), 0) AS revenue,
    COALESCE(SUM(COALESCE(v.qte, 0) * (COALESCE(v.pvnet, 0) - COALESCE(v.pmpa, 0))), 0) AS margin,
    COALESCE(SUM(COALESCE(v.qte, 0)), 0) AS quantity,
    COUNT(DISTINCT v.numdoc) AS documents,
    COUNT(DISTINCT NULLIF(TRIM(v.tiers_code), '')) AS clients
  FROM fact_ventes v, latest l WHERE v.type = 'VF' AND v.date = l.day
),
previous_metrics AS (
  SELECT COALESCE(SUM(COALESCE(v.qte, 0) * COALESCE(v.pvnet, 0)), 0) AS revenue
  FROM fact_ventes v, previous p WHERE v.type = 'VF' AND v.date = p.day
)
SELECT l.day, p.day AS previous_day, c.revenue, c.margin, c.quantity, c.documents, c.clients, pm.revenue AS previous_revenue
FROM latest l CROSS JOIN previous p CROSS JOIN current_metrics c CROSS JOIN previous_metrics pm
WHERE l.day IS NOT NULL`;

beforeAll(async () => {
  for (const statement of SCHEMA) await env.ERP.prepare(statement).run();
  await env.ERP.batch([
    env.ERP.prepare(series(1_200, `'C' || i, 'C', 'Client ' || i, '', 'FR', '', '', hex(i), '${LOADED}'`, "dim_client")),
    env.ERP.prepare(series(SALES,
      `'F' || (i / 5), (i % 5) + 1, date('2026-07-28', '-' || ((${SALES - 1} - i) / ${LINES_PER_DAY}) || ' days'),
       CASE WHEN (i / 5) % 10 = 0 THEN 'VA' ELSE 'VF' END, 'C' || ((i / 5) % 1200), 'A' || (i % 900),
       (i % 13) + 1, (i % 89) + 0.5, (i % 89) * 0.6, '', '', '', '', '', hex(i), '${LOADED}'`, "fact_ventes")),
    env.ERP.prepare(series(12_000, `'R' || i, 1, '2026-06-01', 'C' || (i % 1200), 100, 0, hex(i), '${LOADED}'`, "fact_reglements")),
    env.ERP.prepare(series(12_000, `'R' || i, 1, '2026-06-01', 150, 0, hex(i), '${LOADED}'`, "fact_echeances")),
  ]);
});

describe("ERP read cost against the production schema", () => {
  it("checks readiness with a few marker rows, not table scans", async () => {
    const result = await env.ERP.prepare(MARKER_SNAPSHOT_SQL).all();
    expect(result.meta.rows_read).toBeLessThanOrEqual(20);
    expect(await erpReadiness(env.ERP, NOW)).toMatchObject({
      ready: true,
      loadedAt: LOADED,
      latestSalesDay: "2026-07-28",
      counts: { fact_ventes: SALES, dim_client: 1_200, fact_reglements: 12_000, fact_echeances: 12_000 },
    });
  });

  it("computes the daily digest from two days of index lookups with the reference figures", async () => {
    const cheap = await env.ERP.prepare(NIGHTLY_DIGEST_SQL).all<Record<string, string>>();
    const reference = await env.ERP.prepare(REFERENCE_DIGEST_SQL).all<Record<string, number | string>>();
    expect(cheap.meta.rows_read).toBeLessThanOrEqual(LINES_PER_DAY * 3 + 20);
    expect(reference.meta.rows_read).toBeGreaterThan(SALES);

    const ref = reference.results[0]!;
    const row = cheap.results[0]!;
    const day = String(ref["day"]);
    expect(row["jour_fr"]).toBe(`${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`);
    const previous = String(ref["previous_day"]);
    expect(row["jour_precedent_fr"]).toBe(`${previous.slice(8, 10)}/${previous.slice(5, 7)}/${previous.slice(0, 4)}`);
    expect(row["documents"]).toBe(String(ref["documents"]));
    expect(row["clients"]).toBe(String(ref["clients"]));
    const euros = (value: string) => Number(value.replace(/[^\d,-]/g, "").replace(",", "."));
    expect(euros(row["ca_ht"]!)).toBeCloseTo(Number(ref["revenue"]), 2);
    expect(euros(row["marge_brute"]!)).toBeCloseTo(Number(ref["margin"]), 2);
    expect(row["mise_a_jour_fr"]).toBe("29/07/2026 à 01:00 UTC");
  });

  it("is not ready when a table holds rows from more than one load", async () => {
    await env.ERP.prepare(
      `INSERT INTO dim_client VALUES ('LATE', 'C', 'Ajout', '', 'FR', '', '', 'x', '2026-07-29T01:30:00Z')`,
    ).run();
    const readiness = await erpReadiness(env.ERP, NOW);
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toContain("même chargement");
    await env.ERP.prepare("DELETE FROM dim_client WHERE code = 'LATE'").run();
  });

  it("fails loudly, not with a full scan, if the date index disappears", async () => {
    await env.ERP.prepare("DROP INDEX idx_fact_ventes_date").run();
    await expect(env.ERP.prepare(NIGHTLY_DIGEST_SQL).all()).rejects.toThrow(/no such index/);
    await expect(erpReadiness(env.ERP, NOW)).rejects.toThrow(/no such index/);
    await env.ERP.prepare("CREATE INDEX idx_fact_ventes_date ON fact_ventes(date)").run();
  });
});
