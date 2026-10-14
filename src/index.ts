/**
 * Worker entry. Human and automation surfaces are both fail-closed:
 *   GET  /                    French admin UI
 *   /api/admin/*              admin CRUD + manual tests
 *   scheduled()             the cron tick: enqueue what is due, then drain a batch
 *   POST /trigger/:jobId    enqueue one job now and drain, same code path as cron
 *   POST /drain             drain the outbox without enqueueing anything
 *   GET  /healthz           D1, settings, secrets, switch states, queue backlog
 *
 * While vars.DORMANT is not "off" (src/lib/dormant.ts) every path answers a
 * static 503 "dormant" page or JSON and scheduled() returns at once: no D1.
 *
 * Browser traffic on auto-email.sodimo.eu is authenticated by Cloudflare
 * Access. Machine traffic on workers.dev requires TRIGGER_TOKEN. There is no
 * anonymous surface at either hostname.
 */
import { handleAdminApi } from "./admin/routes.js";
import { adminPage } from "./admin/view.js";
import { loadSettings } from "./lib/db.js";
import { dormantResponse, isDormant } from "./lib/dormant.js";
import { drainOutbox } from "./lib/drain.js";
import { ErpNotReadyError } from "./lib/erp.js";
import { isKillSwitchEngaged, isTestMode, TEST_MODE_ALLOWLIST } from "./lib/guard.js";
import { enqueueDueJobs, runJobById } from "./runner.js";
import type { Env } from "./types.js";

const REQUIRED_SETTINGS = [
  "kill_switch",
  "test_mode",
  "smtp_host",
  "smtp_port",
  "from_address",
  "from_name",
  "ehlo_hostname",
];

function json(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

/** Length-independent compare: both sides are hashed first, so the loop never
 *  runs over the secret itself and the length is not leaked by timing. */
async function secretsMatch(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

function presentedToken(request: Request): string {
  const header = request.headers.get("x-trigger-token");
  if (header) return header;
  const auth = request.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7);
  return "";
}

function hasCloudflareAccessIdentity(request: Request): boolean {
  const url = new URL(request.url);
  return (
    url.hostname === "auto-email.sodimo.eu" &&
    Boolean(request.headers.get("cf-access-jwt-assertion"))
  );
}

async function authorize(request: Request, env: Env): Promise<Response | null> {
  // Access runs before the Worker on the custom domain and injects this header
  // only after its policy succeeds. Never accept it on workers.dev.
  if (hasCloudflareAccessIdentity(request)) return null;
  if (!env.TRIGGER_TOKEN) return json({ error: "TRIGGER_TOKEN secret is not set" }, 503);
  if (!(await secretsMatch(presentedToken(request), env.TRIGGER_TOKEN))) {
    // Deliberately no WWW-Authenticate: Basic header. Browsers must never show
    // a native password dialog; humans enter through Cloudflare Access.
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

function adminHtml(): Response {
  const nonce = crypto.randomUUID();
  return new Response(adminPage(nonce), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "content-security-policy": [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "style-src-attr 'unsafe-inline'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
    },
  });
}

async function healthz(env: Env): Promise<Response> {
  const problems: string[] = [];
  let settings: Awaited<ReturnType<typeof loadSettings>> = {};
  let enabledJobs: number | null = null;
  let queue: { pending: number; failed: number; oldest: string | null } | null = null;
  let erp: "reachable" | "unreachable" = "unreachable";

  try {
    settings = await loadSettings(env.DB);
    const jobs = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE enabled = 1").first<{ n: number }>();
    enabledJobs = jobs?.n ?? 0;
    // A growing backlog is how a sustained SMTP outage shows up: unretryable
    // failures are terminal, but connection problems leave rows queued.
    const outbox = await env.DB.prepare(
      `SELECT
         COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending,
         COUNT(CASE WHEN status = 'failed' THEN 1 END) AS failed,
         MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest
       FROM outbox`,
    ).first<{ pending: number | null; failed: number | null; oldest: string | null }>();
    queue = { pending: outbox?.pending ?? 0, failed: outbox?.failed ?? 0, oldest: outbox?.oldest ?? null };
  } catch (cause) {
    problems.push(`D1 unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  try {
    await env.ERP.prepare("SELECT 1 AS ok").first();
    erp = "reachable";
  } catch (cause) {
    problems.push(`ERP D1 unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  for (const key of REQUIRED_SETTINGS) {
    if (settings[key] === undefined) problems.push(`settings.${key} is missing`);
  }
  if (!env.STRATO_SMTP_PASSWORD) problems.push("STRATO_SMTP_PASSWORD secret is not set");

  return json(
    {
      ok: problems.length === 0,
      problems,
      enabled_jobs: enabledJobs,
      outbox: queue,
      kill_switch: isKillSwitchEngaged(settings) ? "engaged" : "off",
      test_mode: isTestMode(settings) ? "on" : "off",
      pinned_recipients: isTestMode(settings) ? TEST_MODE_ALLOWLIST : null,
      smtp: settings.smtp_host ? `${settings.smtp_host}:${settings.smtp_port}` : null,
      ehlo: settings.ehlo_hostname ?? null,
      from: settings.from_address ?? null,
      sent_copies:
        (settings.imap_append ?? "").trim().toLowerCase() === "on"
          ? `${settings.imap_host}:${settings.imap_port}`
          : "off",
      erp,
    },
    problems.length === 0 ? 200 : 503,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Dormant first: a static answer for every path, before auth, before D1.
    if (isDormant(env)) return dormantResponse(request);

    const denied = await authorize(request, env);
    if (denied) return denied;

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/admin") {
      if (request.method !== "GET") return json({ error: "use GET" }, 405);
      return adminHtml();
    }
    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }

    const admin = await handleAdminApi(request, env, url);
    if (admin) return admin;

    if (request.method === "GET" && url.pathname === "/healthz") {
      return await healthz(env);
    }

    if (url.pathname === "/drain") {
      if (request.method !== "POST") return json({ error: "use POST" }, 405);
      return json(await drainOutbox(env));
    }

    const trigger = /^\/trigger\/([^/]+)$/.exec(url.pathname);
    if (trigger && request.method === "POST") {
      const jobId = decodeURIComponent(trigger[1]!);
      try {
        const queued = await runJobById(env, jobId);
        if (queued.suppressed) return json({ job: jobId, suppressed: queued.suppressed }, 409);
        // Drain in the same request, so a manual test is one command rather
        // than one command and a five-minute wait.
        return json({ queued: queued.result, drained: await drainOutbox(env) });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return json(
          { job: jobId, error: message },
          message.startsWith("job not found") ? 404 : cause instanceof ErpNotReadyError ? 503 : 500,
        );
      }
    }
    if (trigger) return json({ error: "use POST" }, 405);

    return json({ error: "not found" }, 404);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Dormant: wrangler.jsonc ships no cron, but if a stale trigger still
    // fires, stop here, before any D1 call.
    if (isDormant(env)) {
      console.log(JSON.stringify({ event: "cron", dormant: true, cron: event.cron }));
      return;
    }
    // Enqueue is cheap (render + inserts); the drain is capped at a handful of
    // messages so the invocation stays inside the free plan's CPU budget.
    ctx.waitUntil(
      (async () => {
        const enqueued = await enqueueDueJobs(env, event.scheduledTime);
        const drained = await drainOutbox(env);
        console.log(JSON.stringify({ event: "cron", enqueued, drained }));
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
