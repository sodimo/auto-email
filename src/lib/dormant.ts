/**
 * Dormant mode: the whole Worker parked on purpose, with ZERO D1 queries.
 *
 * Why: D1 Free is 5,000,000 rows read and 100,000 rows written per UTC day for
 * the WHOLE Cloudflare account. The CRM, its MCP tools, the status page and the
 * ERP mirror share that allowance with this Worker. While nobody uses scheduled
 * mail, every D1 row this Worker reads or writes is taken from them.
 *
 * Fail closed, like the kill switch: the Worker is dormant unless the `DORMANT`
 * var is exactly "off". A missing var, a typo or "on" all mean dormant.
 *
 * Dormant is checked FIRST, before authentication, in fetch() and scheduled(),
 * and again at the top of the two choke points and the manual runner, so no
 * code path reaches env.DB or env.ERP. tests/dormant.test.ts enforces this with
 * D1 bindings that record and throw on any use.
 *
 * Waking it is a decision for the Sodimo operations lead and the technical lead
 * together, never an agent's or a single person's call. See CLAUDE.md,
 * section "Dormant", for the steps and the D1 cost of waking.
 */
import type { Env } from "../types.js";

export const DORMANT_REASON = "dormant (vars.DORMANT is not \"off\")";

export function isDormant(env: Pick<Env, "DORMANT">): boolean {
  return (env.DORMANT ?? "").trim() !== "off";
}

const MESSAGE_FR =
  "auto-email est en sommeil. Ce service est mis en pause volontairement pour " +
  "préserver le quota quotidien gratuit de la base de données partagée (Cloudflare D1). " +
  "Aucun e-mail n'est envoyé et aucune donnée n'est lue. Ce n'est pas une panne.";
const WAKE_FR =
  "Pour le réveiller : décision conjointe des responsables opérations et technique de Sodimo, " +
  "puis la procédure « Dormant » du fichier CLAUDE.md du dépôt (variable DORMANT à \"off\" " +
  "et rétablissement du déclencheur cron, puis déploiement).";
const MESSAGE_EN =
  "auto-email is dormant. This service is paused on purpose to protect the shared " +
  "free daily database allowance (Cloudflare D1). No email is sent and no data is read. " +
  "This is not an outage.";
const WAKE_EN =
  "To wake it: a joint decision of Sodimo's operations and technical leads, then the " +
  "\"Dormant\" procedure in the repository's CLAUDE.md (set the DORMANT var to \"off\", " +
  "restore the cron trigger, deploy).";

const PAGE = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>auto-email : en sommeil / dormant</title>
<style>
body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#1f2328;background:#fff}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem}p.note{color:#57606a}
</style>
</head>
<body>
<h1>auto-email : en sommeil</h1>
<p>${MESSAGE_FR}</p>
<p class="note">${WAKE_FR}</p>
<h2 lang="en">auto-email: dormant</h2>
<p lang="en">${MESSAGE_EN}</p>
<p class="note" lang="en">${WAKE_EN}</p>
</body>
</html>
`;

function wantsHtml(request: Request, url: URL): boolean {
  if (url.pathname === "/" || url.pathname === "/admin") return true;
  return (request.headers.get("accept") ?? "").includes("text/html");
}

/** The only response the Worker gives while dormant. Static: no D1, no I/O. */
export function dormantResponse(request: Request): Response {
  const url = new URL(request.url);
  const common = {
    "cache-control": "no-store",
    "retry-after": "86400",
    "x-auto-email-mode": "dormant",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
  if (wantsHtml(request, url)) {
    return new Response(request.method === "HEAD" ? null : PAGE, {
      status: 503,
      headers: {
        ...common,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "x-frame-options": "DENY",
      },
    });
  }
  const body = {
    status: "dormant",
    dormant: true,
    message_fr: MESSAGE_FR,
    wake_fr: WAKE_FR,
    message_en: MESSAGE_EN,
    wake_en: WAKE_EN,
  };
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body, null, 2), {
    status: 503,
    headers: { ...common, "content-type": "application/json; charset=utf-8" },
  });
}
