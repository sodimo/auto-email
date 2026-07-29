-- Seed: the starter template, the pinned test recipient list, and the (disabled)
-- nightly digest job that will replace Sodiwin's emailed Excel report.
--
-- Placeholders use {{var}} (HTML-escaped) and {{{var}}} (raw). The runner always
-- provides: job_name, date_fr, generated_at, dashboard_url, row_count,
-- rows_table_html (raw), rows_text. See src/lib/render.ts.

INSERT INTO templates (name, subject_fr, body_html, body_text) VALUES (
  'rapport-quotidien',
  'Rapport quotidien Sodimo — {{date_fr}}',
  '<!doctype html>
<html lang="fr">
<body style="margin:0;padding:24px;background:#f4f4f5;font-family:Helvetica,Arial,sans-serif;color:#18181b;">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:8px;overflow:hidden;">
    <div style="padding:20px 24px;border-bottom:1px solid #e4e4e7;">
      <h1 style="margin:0;font-size:18px;font-weight:600;">Rapport quotidien Sodimo</h1>
      <p style="margin:4px 0 0;font-size:13px;color:#71717a;">{{date_fr}}</p>
    </div>
    <div style="padding:24px;">
      <p style="margin:0 0 16px;font-size:14px;line-height:1.5;">Bonjour,</p>
      <p style="margin:0 0 20px;font-size:14px;line-height:1.5;">
        Voici le récapitulatif automatique du jour ({{row_count}} ligne(s)).
      </p>
      {{{rows_table_html}}}
      <p style="margin:24px 0 0;font-size:14px;line-height:1.5;">
        <a href="{{dashboard_url}}" style="display:inline-block;padding:10px 18px;background:#18181b;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;">Ouvrir le tableau de bord</a>
      </p>
    </div>
    <div style="padding:16px 24px;border-top:1px solid #e4e4e7;background:#fafafa;">
      <p style="margin:0;font-size:12px;color:#71717a;line-height:1.5;">
        Message automatique envoyé par « {{job_name}} » le {{generated_at}} (UTC).<br>
        Merci de ne pas répondre à cet e-mail.
      </p>
    </div>
  </div>
</body>
</html>',
  'RAPPORT QUOTIDIEN SODIMO — {{date_fr}}

Bonjour,

Voici le récapitulatif automatique du jour ({{row_count}} ligne(s)).

{{rows_text}}

Tableau de bord : {{dashboard_url}}

--
Message automatique envoyé par « {{job_name}} » le {{generated_at}} (UTC).
Merci de ne pas répondre à cet e-mail.'
);

INSERT INTO recipient_lists (name) VALUES ('test');

-- The two addresses hard-pinned by TEST MODE (src/lib/guard.ts). Rows here are
-- data; the allowlist in the guard is code — the guard is what enforces.
INSERT INTO recipient_list_members (list_id, email, display_name, active)
SELECT id, 'thomas@leger.run', 'Thomas Léger', 1 FROM recipient_lists WHERE name = 'test';
INSERT INTO recipient_list_members (list_id, email, display_name, active)
SELECT id, 'tombionic@gmail.com', 'Thomas (perso)', 1 FROM recipient_lists WHERE name = 'test';

-- Disabled on purpose: enable it only after a successful manual /trigger run.
INSERT INTO jobs (name, kind, enabled, schedule, template_id, recipient_list_id, dedupe_strategy)
SELECT 'rapport-nightly', 'digest', 0, '0 6 * * *', t.id, l.id, 'per_day'
FROM templates t, recipient_lists l
WHERE t.name = 'rapport-quotidien' AND l.name = 'test';
