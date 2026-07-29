/**
 * Built-in ERP queries offered by the admin UI.
 *
 * They remain ordinary read-only SQL and still pass through assertReadOnlySql.
 * Keeping them in code gives non-technical operators useful choices without
 * asking them to write SQL; the advanced editor can still store a custom query.
 */

export type JobPreset = "custom" | "sales_daily" | "overdue_30";

/**
 * One row, deliberately: a digest can expose these columns directly as
 * template variables while also retaining the generic rows table.
 *
 * Revenue and margin follow the dashboard's verified rules:
 *   revenue = qte * pvnet
 *   margin  = qte * (pvnet - pmpa)
 * and only sales invoices (`VF`) count.
 */
export const NIGHTLY_DIGEST_SQL = `
WITH
latest AS (
  SELECT MAX(date) AS day
  FROM fact_ventes
  WHERE type = 'VF'
),
previous AS (
  SELECT MAX(v.date) AS day
  FROM fact_ventes v, latest l
  WHERE v.type = 'VF' AND v.date < l.day
),
current_metrics AS (
  SELECT
    COALESCE(SUM(COALESCE(v.qte, 0) * COALESCE(v.pvnet, 0)), 0) AS revenue,
    COALESCE(SUM(COALESCE(v.qte, 0) * (COALESCE(v.pvnet, 0) - COALESCE(v.pmpa, 0))), 0) AS margin,
    COALESCE(SUM(COALESCE(v.qte, 0)), 0) AS quantity,
    COUNT(DISTINCT v.numdoc) AS documents,
    COUNT(DISTINCT NULLIF(TRIM(v.tiers_code), '')) AS clients
  FROM fact_ventes v, latest l
  WHERE v.type = 'VF' AND v.date = l.day
),
previous_metrics AS (
  SELECT COALESCE(SUM(COALESCE(v.qte, 0) * COALESCE(v.pvnet, 0)), 0) AS revenue
  FROM fact_ventes v, previous p
  WHERE v.type = 'VF' AND v.date = p.day
),
loaded AS (
  SELECT MAX(loaded_at) AS at FROM fact_ventes
)
SELECT
  strftime('%d/%m/%Y', l.day) AS jour_fr,
  replace(replace(replace(printf('%,.2f', ROUND(c.revenue, 2)), ',', '~'), '.', ','), '~', ' ') || ' €' AS ca_ht,
  replace(replace(replace(printf('%,.2f', ROUND(c.margin, 2)), ',', '~'), '.', ','), '~', ' ') || ' €' AS marge_brute,
  CASE
    WHEN ABS(c.revenue) < 0.005 THEN '—'
    ELSE replace(printf('%.1f', 100.0 * c.margin / c.revenue), '.', ',') || ' %'
  END AS taux_marge,
  CAST(c.documents AS TEXT) AS documents,
  CAST(c.clients AS TEXT) AS clients,
  replace(replace(printf('%,.0f', ROUND(c.quantity, 0)), ',', ' '), '.', ',') AS quantite,
  COALESCE(strftime('%d/%m/%Y', p.day), '—') AS jour_precedent_fr,
  CASE
    WHEN ABS(pm.revenue) < 0.005 THEN '—'
    ELSE
      CASE WHEN c.revenue >= pm.revenue THEN '+' ELSE '' END ||
      replace(printf('%.1f', 100.0 * (c.revenue - pm.revenue) / pm.revenue), '.', ',') || ' %'
  END AS variation_ca,
  substr(ld.at, 9, 2) || '/' || substr(ld.at, 6, 2) || '/' || substr(ld.at, 1, 4) ||
    ' à ' || substr(ld.at, 12, 5) || ' UTC' AS mise_a_jour_fr
FROM latest l
CROSS JOIN previous p
CROSS JOIN current_metrics c
CROSS JOIN previous_metrics pm
CROSS JOIN loaded ld
WHERE l.day IS NOT NULL
`.trim();

/**
 * Client-level FIFO approximation, constrained to tables already mirrored by
 * the frozen ETL:
 *   échéance.numdoc -> vente.numdoc -> client
 *   règlement -> client
 *
 * Payments cannot be tied to an invoice in the mirror, so each client's total
 * payments are applied oldest due item first. The email labels this explicitly.
 * One row per client keeps the result concise; the 100-client ceiling also
 * bounds email size independently of the generic 500-row datasource cap.
 */
export const OVERDUE_PAYMENTS_SQL = `
WITH
document_clients AS (
  SELECT
    TRIM(numdoc) AS numdoc,
    MIN(NULLIF(TRIM(tiers_code), '')) AS tiers_code
  FROM fact_ventes
  WHERE type = 'VF'
  GROUP BY TRIM(numdoc)
),
due_items AS (
  SELECT
    TRIM(e.numdoc) AS numdoc,
    e.numech,
    date(e.datech) AS due_date,
    dc.tiers_code,
    CASE WHEN COALESCE(e.montant, 0) > 0 THEN e.montant ELSE 0 END AS due_amount
  FROM fact_echeances e
  JOIN document_clients dc ON dc.numdoc = TRIM(e.numdoc)
  WHERE e.datech IS NOT NULL
    AND date(e.datech) <= date('now')
    AND COALESCE(e.montant, 0) > 0
),
payments AS (
  SELECT
    TRIM(tiers_code) AS tiers_code,
    MAX(COALESCE(SUM(COALESCE(montant, 0)), 0), 0) AS paid_amount
  FROM fact_reglements
  WHERE tiers_code IS NOT NULL
    AND TRIM(tiers_code) <> ''
    AND date(date) <= date('now')
  GROUP BY TRIM(tiers_code)
),
allocated AS (
  SELECT
    d.*,
    COALESCE(p.paid_amount, 0) AS paid_amount,
    SUM(d.due_amount) OVER (
      PARTITION BY d.tiers_code
      ORDER BY d.due_date, d.numdoc, d.numech
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS cumulative_due
  FROM due_items d
  LEFT JOIN payments p ON p.tiers_code = d.tiers_code
),
open_items AS (
  SELECT
    *,
    CASE
      WHEN cumulative_due <= paid_amount THEN 0
      WHEN cumulative_due - paid_amount >= due_amount THEN due_amount
      ELSE cumulative_due - paid_amount
    END AS outstanding
  FROM allocated
),
overdue AS (
  SELECT *
  FROM open_items
  WHERE due_date <= date('now', '-30 days')
    AND outstanding > 0.005
)
SELECT
  COALESCE(NULLIF(TRIM(c.nom), ''), o.tiers_code) AS "Client",
  o.tiers_code AS "Code",
  COUNT(*) AS "Échéances",
  replace(
    replace(
      replace(printf('%,.2f', ROUND(SUM(o.outstanding), 2)), ',', '~'),
      '.',
      ','
    ),
    '~',
    ' '
  ) || ' €' AS "Montant net estimé",
  strftime('%d/%m/%Y', MIN(o.due_date)) AS "Plus ancienne",
  CAST(julianday('now') - julianday(MIN(o.due_date)) AS INTEGER) AS "Retard max (jours)"
FROM overdue o
LEFT JOIN dim_client c ON c.code = o.tiers_code AND c.type = 'C'
GROUP BY o.tiers_code, COALESCE(NULLIF(TRIM(c.nom), ''), o.tiers_code)
HAVING SUM(o.outstanding) > 0.005
ORDER BY SUM(o.outstanding) DESC, "Client"
LIMIT 100
`.trim();

export function sqlForPreset(preset: JobPreset): string | null {
  if (preset === "sales_daily") return NIGHTLY_DIGEST_SQL;
  if (preset === "overdue_30") return OVERDUE_PAYMENTS_SQL;
  return null;
}
