import { escapeHtml } from "../lib/render.js";

const MAX_BODY_LENGTH = 20_000;

export function normalizeTemplateBody(source: unknown): string {
  if (typeof source !== "string") throw new Error("Le corps du message est absent.");
  const normalized = source.replace(/\r\n?/g, "\n").trim();
  if (!normalized) throw new Error("Le corps du message ne peut pas être vide.");
  if (normalized.length > MAX_BODY_LENGTH) {
    throw new Error(`Le corps du message dépasse ${MAX_BODY_LENGTH.toLocaleString("fr-FR")} caractères.`);
  }
  return normalized;
}

function renderBlock(block: string): string {
  const trimmed = block.trim();
  if (trimmed === "{{{rows_table_html}}}") return "{{{rows_table_html}}}";

  if (/^tableau de bord\s*:\s*\{\{\s*dashboard_url\s*\}\}$/i.test(trimmed)) {
    return `<p style="margin:20px 0 0;"><a href="{{dashboard_url}}" style="display:inline-block;padding:10px 16px;background:#292524;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Ouvrir le tableau de bord</a></p>`;
  }

  return `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;">${escapeHtml(trimmed).replace(/\n/g, "<br>")}</p>`;
}

/**
 * Turns the UI's friendly plain-text body into restrained email-safe HTML.
 * Placeholders survive escaping and are interpolated later by runner.ts.
 */
export function friendlyBodyToHtml(sourceValue: unknown): string {
  const source = normalizeTemplateBody(sourceValue);
  const content = source
    .split(/\n{2,}/)
    .map(renderBlock)
    .join("\n");

  return `<!doctype html>
<html lang="fr">
<body style="margin:0;padding:24px;background:#f5f5f4;font-family:Helvetica,Arial,sans-serif;color:#292524;">
  <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:8px;overflow:hidden;">
    <div style="padding:24px;">
      ${content}
    </div>
    <div style="padding:14px 24px;border-top:1px solid #e7e5e4;background:#fafaf9;">
      <p style="margin:0;font-size:12px;color:#78716c;line-height:1.5;">Message automatique « {{job_label}} » · {{generated_at}} UTC</p>
    </div>
  </div>
</body>
</html>`;
}

