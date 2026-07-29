/**
 * Template rendering. Deliberately not a template engine: `{{var}}` and
 * `{{{var}}}` (raw) over a flat variable bag, nothing else. No loops, no
 * conditionals, no expressions — tabular content arrives pre-rendered as the
 * `rows_table_html` / `rows_text` variables built here.
 */
import type { DataRow } from "../types.js";

export interface RenderResult {
  output: string;
  /** Names referenced by the template that the bag had nothing for. */
  missing: string[];
}

const PLACEHOLDER = /\{\{\{\s*([A-Za-z0-9_]+)\s*\}\}\}|\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * `escape: true` for HTML bodies (so `{{var}}` cannot inject markup and
 * `{{{var}}}` is the explicit opt-out); `escape: false` for text bodies, where
 * both forms are literal.
 */
export function render(
  template: string,
  vars: Record<string, unknown>,
  options: { escape: boolean },
): RenderResult {
  const missing: string[] = [];
  const output = template.replace(PLACEHOLDER, (_match, rawName?: string, escName?: string) => {
    const name = rawName ?? escName!;
    if (!(name in vars) || vars[name] === undefined || vars[name] === null) {
      missing.push(name);
      return "";
    }
    const text = stringify(vars[name]);
    return rawName !== undefined || !options.escape ? text : escapeHtml(text);
  });
  return { output, missing };
}

/** e.g. "mercredi 29 juillet 2026" — always UTC, matching the schedule. */
export function frenchDate(date: Date): string {
  try {
    return new Intl.DateTimeFormat("fr-FR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function buildRowsTableHtml(rows: DataRow[]): string {
  if (rows.length === 0) {
    return '<p style="margin:0;font-size:14px;color:#71717a;">Aucune donnée à signaler.</p>';
  }
  const columns = Object.keys(rows[0]!);
  const head = columns
    .map(
      (c) =>
        `<th align="left" style="padding:8px 10px;border-bottom:2px solid #e4e4e7;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:#71717a;">${escapeHtml(c)}</th>`,
    )
    .join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${columns
          .map(
            (c) =>
              `<td style="padding:8px 10px;border-bottom:1px solid #f4f4f5;font-size:14px;">${escapeHtml(stringify(row[c]))}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function buildRowsText(rows: DataRow[]): string {
  if (rows.length === 0) return "Aucune donnée à signaler.";
  return rows
    .map((row, i) =>
      [`[${i + 1}]`, ...Object.entries(row).map(([k, v]) => `  ${k}: ${stringify(v)}`)].join("\n"),
    )
    .join("\n\n");
}
