-- The frozen ERP loader builds fact_echeances.numdoc from REGLE.NUMREG.
-- Production verification showed that this identifier has no overlap with
-- fact_ventes.numdoc, but does match fact_reglements.numreg. Prefer that real
-- settlement-document relationship and retain the sales mapping as a fallback
-- for older mirrors. Client-level FIFO netting remains an explicitly labelled
-- approximation.

UPDATE jobs
SET
  condition_sql = 'WITH
sales_document_clients AS (
  SELECT
    TRIM(numdoc) AS numdoc,
    MIN(NULLIF(TRIM(tiers_code), '''')) AS tiers_code
  FROM fact_ventes
  WHERE type = ''VF''
  GROUP BY TRIM(numdoc)
),
payment_document_clients AS (
  SELECT
    TRIM(numreg) AS numdoc,
    MIN(NULLIF(TRIM(tiers_code), '''')) AS tiers_code
  FROM fact_reglements
  GROUP BY TRIM(numreg)
),
document_clients AS (
  SELECT numdoc, tiers_code
  FROM payment_document_clients
  WHERE tiers_code IS NOT NULL
  UNION ALL
  SELECT s.numdoc, s.tiers_code
  FROM sales_document_clients s
  LEFT JOIN payment_document_clients p ON p.numdoc = s.numdoc
  WHERE p.numdoc IS NULL AND s.tiers_code IS NOT NULL
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
    AND date(e.datech) <= date(''now'')
    AND COALESCE(e.montant, 0) > 0
),
payments AS (
  SELECT
    TRIM(tiers_code) AS tiers_code,
    MAX(COALESCE(SUM(COALESCE(montant, 0)), 0), 0) AS paid_amount
  FROM fact_reglements
  WHERE tiers_code IS NOT NULL
    AND TRIM(tiers_code) <> ''''
    AND date(date) <= date(''now'')
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
  WHERE due_date <= date(''now'', ''-30 days'')
    AND outstanding > 0.005
)
SELECT
  COALESCE(NULLIF(TRIM(c.nom), ''''), o.tiers_code) AS "Client",
  o.tiers_code AS "Code",
  COUNT(*) AS "Échéances",
  replace(
    replace(
      replace(printf(''%,.2f'', ROUND(SUM(o.outstanding), 2)), '','', ''~''),
      ''.'',
      '',''
    ),
    ''~'',
    '' ''
  ) || '' €'' AS "Montant net estimé",
  strftime(''%d/%m/%Y'', MIN(o.due_date)) AS "Plus ancienne",
  CAST(julianday(''now'') - julianday(MIN(o.due_date)) AS INTEGER) AS "Retard max (jours)"
FROM overdue o
LEFT JOIN dim_client c ON c.code = o.tiers_code AND c.type = ''C''
GROUP BY o.tiers_code, COALESCE(NULLIF(TRIM(c.nom), ''''), o.tiers_code)
HAVING SUM(o.outstanding) > 0.005
ORDER BY SUM(o.outstanding) DESC, "Client"
LIMIT 100',
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE name = 'paiements-en-retard' AND preset = 'overdue_30';
