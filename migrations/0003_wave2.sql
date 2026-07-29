-- Wave 2: explicit ERP routing, friendly admin metadata, real digest content,
-- and the internal overdue-payments summary.
--
-- The ERP database is a separate Worker binding. No ERP schema is created or
-- changed here: sodimo/etl remains its sole owner.

ALTER TABLE jobs ADD COLUMN display_name TEXT;
ALTER TABLE jobs ADD COLUMN source TEXT NOT NULL DEFAULT 'own'
  CHECK (source IN ('own', 'erp'));
ALTER TABLE jobs ADD COLUMN preset TEXT NOT NULL DEFAULT 'custom'
  CHECK (preset IN ('custom', 'sales_daily', 'overdue_30'));

-- Friendly source edited in the admin UI. body_html/body_text remain the actual
-- MIME alternatives enqueued once by the Wave 1 choke point.
ALTER TABLE templates ADD COLUMN body_source TEXT;

UPDATE templates
SET
  subject_fr = 'Sodimo — activité du {{jour_fr}} · {{ca_ht}}',
  body_source = 'Bonjour,

Voici les ventes enregistrées pour le {{jour_fr}}.

Chiffre d’affaires HT : {{ca_ht}}
Marge brute : {{marge_brute}} ({{taux_marge}})
Évolution par rapport au {{jour_precedent_fr}} : {{variation_ca}}
Documents : {{documents}}
Clients actifs : {{clients}}
Quantité vendue : {{quantite}}

Tableau de bord : {{dashboard_url}}

Données ERP chargées le {{mise_a_jour_fr}}.',
  body_html = '<!doctype html>
<html lang="fr">
<body style="margin:0;padding:24px;background:#f5f5f4;font-family:Helvetica,Arial,sans-serif;color:#292524;">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:8px;overflow:hidden;">
    <div style="padding:20px 24px;border-bottom:1px solid #e7e5e4;">
      <h1 style="margin:0;font-size:18px;line-height:1.35;font-weight:700;">Activité commerciale du {{jour_fr}}</h1>
      <p style="margin:5px 0 0;font-size:13px;color:#78716c;">Dernier jour de vente disponible dans Sodiwin</p>
    </div>
    <div style="padding:24px;">
      <p style="margin:0 0 20px;font-size:14px;line-height:1.55;">Bonjour, voici les principaux chiffres du {{jour_fr}}.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;border:1px solid #e7e5e4;">
        <tr>
          <td style="padding:12px 14px;border-bottom:1px solid #e7e5e4;color:#57534e;font-size:13px;">Chiffre d’affaires HT</td>
          <td align="right" style="padding:12px 14px;border-bottom:1px solid #e7e5e4;font-size:17px;font-weight:700;">{{ca_ht}}</td>
        </tr>
        <tr>
          <td style="padding:12px 14px;border-bottom:1px solid #e7e5e4;color:#57534e;font-size:13px;">Marge brute</td>
          <td align="right" style="padding:12px 14px;border-bottom:1px solid #e7e5e4;font-size:14px;font-weight:600;">{{marge_brute}} · {{taux_marge}}</td>
        </tr>
        <tr>
          <td style="padding:12px 14px;border-bottom:1px solid #e7e5e4;color:#57534e;font-size:13px;">Évolution vs {{jour_precedent_fr}}</td>
          <td align="right" style="padding:12px 14px;border-bottom:1px solid #e7e5e4;font-size:14px;font-weight:600;">{{variation_ca}}</td>
        </tr>
        <tr>
          <td style="padding:12px 14px;color:#57534e;font-size:13px;">Activité</td>
          <td align="right" style="padding:12px 14px;font-size:14px;">{{documents}} documents · {{clients}} clients · {{quantite}} unités</td>
        </tr>
      </table>
      <p style="margin:22px 0 0;">
        <a href="{{dashboard_url}}" style="display:inline-block;padding:10px 16px;background:#292524;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Ouvrir le tableau de bord</a>
      </p>
    </div>
    <div style="padding:14px 24px;border-top:1px solid #e7e5e4;background:#fafaf9;">
      <p style="margin:0;font-size:12px;color:#78716c;line-height:1.5;">Données ERP chargées le {{mise_a_jour_fr}}. Message automatique « {{job_label}} ».</p>
    </div>
  </div>
</body>
</html>',
  body_text = 'ACTIVITÉ COMMERCIALE DU {{jour_fr}}

Bonjour,

Chiffre d’affaires HT : {{ca_ht}}
Marge brute : {{marge_brute}} ({{taux_marge}})
Évolution par rapport au {{jour_precedent_fr}} : {{variation_ca}}
Documents : {{documents}}
Clients actifs : {{clients}}
Quantité vendue : {{quantite}}

Tableau de bord : {{dashboard_url}}

Données ERP chargées le {{mise_a_jour_fr}}.'
WHERE name = 'rapport-quotidien';

UPDATE jobs
SET
  display_name = 'Rapport quotidien des ventes',
  source = 'erp',
  preset = 'sales_daily',
  schedule = '0 6 * * *',
  condition_sql = 'WITH
latest AS (
  SELECT MAX(date) AS day
  FROM fact_ventes
  WHERE type = ''VF''
),
previous AS (
  SELECT MAX(v.date) AS day
  FROM fact_ventes v, latest l
  WHERE v.type = ''VF'' AND v.date < l.day
),
current_metrics AS (
  SELECT
    COALESCE(SUM(COALESCE(v.qte, 0) * COALESCE(v.pvnet, 0)), 0) AS revenue,
    COALESCE(SUM(COALESCE(v.qte, 0) * (COALESCE(v.pvnet, 0) - COALESCE(v.pmpa, 0))), 0) AS margin,
    COALESCE(SUM(COALESCE(v.qte, 0)), 0) AS quantity,
    COUNT(DISTINCT v.numdoc) AS documents,
    COUNT(DISTINCT NULLIF(TRIM(v.tiers_code), '''')) AS clients
  FROM fact_ventes v, latest l
  WHERE v.type = ''VF'' AND v.date = l.day
),
previous_metrics AS (
  SELECT COALESCE(SUM(COALESCE(v.qte, 0) * COALESCE(v.pvnet, 0)), 0) AS revenue
  FROM fact_ventes v, previous p
  WHERE v.type = ''VF'' AND v.date = p.day
),
loaded AS (
  SELECT MAX(loaded_at) AS at FROM fact_ventes
)
SELECT
  strftime(''%d/%m/%Y'', l.day) AS jour_fr,
  replace(replace(replace(printf(''%,.2f'', ROUND(c.revenue, 2)), '','', ''~''), ''.'', '',''), ''~'', '' '') || '' €'' AS ca_ht,
  replace(replace(replace(printf(''%,.2f'', ROUND(c.margin, 2)), '','', ''~''), ''.'', '',''), ''~'', '' '') || '' €'' AS marge_brute,
  CASE
    WHEN ABS(c.revenue) < 0.005 THEN ''—''
    ELSE replace(printf(''%.1f'', 100.0 * c.margin / c.revenue), ''.'', '','') || '' %''
  END AS taux_marge,
  CAST(c.documents AS TEXT) AS documents,
  CAST(c.clients AS TEXT) AS clients,
  replace(replace(printf(''%,.0f'', ROUND(c.quantity, 0)), '','', '' ''), ''.'', '','') AS quantite,
  COALESCE(strftime(''%d/%m/%Y'', p.day), ''—'') AS jour_precedent_fr,
  CASE
    WHEN ABS(pm.revenue) < 0.005 THEN ''—''
    ELSE
      CASE WHEN c.revenue >= pm.revenue THEN ''+'' ELSE '''' END ||
      replace(printf(''%.1f'', 100.0 * (c.revenue - pm.revenue) / pm.revenue), ''.'', '','') || '' %''
  END AS variation_ca,
  substr(ld.at, 9, 2) || ''/'' || substr(ld.at, 6, 2) || ''/'' || substr(ld.at, 1, 4) ||
    '' à '' || substr(ld.at, 12, 5) || '' UTC'' AS mise_a_jour_fr
FROM latest l
CROSS JOIN previous p
CROSS JOIN current_metrics c
CROSS JOIN previous_metrics pm
CROSS JOIN loaded ld
WHERE l.day IS NOT NULL',
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE name = 'rapport-nightly';

INSERT INTO templates (name, subject_fr, body_source, body_html, body_text)
VALUES (
  'echeances-retard',
  'Interne — {{row_count}} client(s) avec échéances de 30 jours ou plus',
  'Bonjour,

{{row_count}} client(s) présentent des échéances âgées d’au moins 30 jours.

{{{rows_table_html}}}

Important : estimation interne. Les règlements disponibles dans le miroir ERP sont imputés au niveau client, du plus ancien au plus récent. Cette synthèse ne remplace pas le lettrage comptable facture par facture.

Tableau de bord : {{dashboard_url}}',
  '<!doctype html>
<html lang="fr">
<body style="margin:0;padding:24px;background:#f5f5f4;font-family:Helvetica,Arial,sans-serif;color:#292524;">
  <div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:8px;overflow:hidden;">
    <div style="padding:20px 24px;border-bottom:1px solid #e7e5e4;">
      <h1 style="margin:0;font-size:18px;line-height:1.35;font-weight:700;">Échéances clients de 30 jours ou plus</h1>
      <p style="margin:5px 0 0;font-size:13px;color:#78716c;">Synthèse interne · {{date_fr}}</p>
    </div>
    <div style="padding:24px;">
      <p style="margin:0 0 18px;font-size:14px;line-height:1.55;"><strong>{{row_count}} client(s)</strong> présentent un solde estimé sur des échéances âgées d’au moins 30 jours.</p>
      {{{rows_table_html}}}
      <div style="margin:20px 0 0;padding:12px 14px;border-left:3px solid #a16207;background:#fffbeb;color:#713f12;font-size:12px;line-height:1.55;">
        <strong>Estimation interne.</strong> Les règlements disponibles dans le miroir ERP sont imputés au niveau client, du plus ancien au plus récent. Cette synthèse ne remplace pas le lettrage comptable facture par facture.
      </div>
      <p style="margin:22px 0 0;"><a href="{{dashboard_url}}" style="color:#44403c;font-size:14px;font-weight:600;">Ouvrir le tableau de bord</a></p>
    </div>
    <div style="padding:14px 24px;border-top:1px solid #e7e5e4;background:#fafaf9;">
      <p style="margin:0;font-size:12px;color:#78716c;">Message automatique interne « {{job_label}} ».</p>
    </div>
  </div>
</body>
</html>',
  'ÉCHÉANCES CLIENTS DE 30 JOURS OU PLUS

Bonjour,

{{row_count}} client(s) présentent des échéances âgées d’au moins 30 jours.

{{rows_text}}

IMPORTANT — ESTIMATION INTERNE
Les règlements disponibles dans le miroir ERP sont imputés au niveau client, du plus ancien au plus récent. Cette synthèse ne remplace pas le lettrage comptable facture par facture.

Tableau de bord : {{dashboard_url}}'
);

INSERT INTO jobs (
  name, display_name, kind, enabled, schedule, template_id,
  recipient_list_id, condition_sql, dedupe_strategy, source, preset
)
SELECT
  'paiements-en-retard',
  'Échéances clients de 30 jours ou plus',
  'condition',
  0,
  '0 7 * * 1',
  t.id,
  l.id,
  'WITH
document_clients AS (
  SELECT
    TRIM(numdoc) AS numdoc,
    MIN(NULLIF(TRIM(tiers_code), '''')) AS tiers_code
  FROM fact_ventes
  WHERE type = ''VF''
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
  'per_day',
  'erp',
  'overdue_30'
FROM templates t, recipient_lists l
WHERE t.name = 'echeances-retard' AND l.name = 'test';

CREATE INDEX IF NOT EXISTS idx_send_log_time ON send_log (sent_at DESC, id DESC);
