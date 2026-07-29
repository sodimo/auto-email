/**
 * Worker entry. Two surfaces, no UI (that is Wave 2, at auto-email.sodimo.eu
 * behind Cloudflare Access):
 *   scheduled()             the cron tick — see runner.ts
 *   POST /trigger/:jobId    a manual run of one job, same code path as cron
 *   GET  /healthz           D1 reachable + settings sane + switch states
 *
 * Both HTTP endpoints require the TRIGGER_TOKEN shared secret. There is no
 * anonymous surface at all: an unauthenticated request cannot even distinguish
 * a missing route from a wrong token.
 */
import { loadSettings } from "./lib/db.js";
import { isKillSwitchEngaged, isTestMode, TEST_MODE_ALLOWLIST } from "./lib/guard.js";
import { runDueJobs, runJobById } from "./runner.js";
import type { Env } from "./types.js";

const REQUIRED_SETTINGS = ["kill_switch", "test_mode", "smtp_host", "smtp_port", "from_address", "from_name"];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Length-independent compare; both sides are hashed first so the loop never
 *  runs over the secret itself and length is not leaked by timing. */
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
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
}

async function authorize(request: Request, env: Env): Promise<Response | null> {
  if (!env.TRIGGER_TOKEN) return json({ error: "TRIGGER_TOKEN secret is not set" }, 503);
  if (!(await secretsMatch(presentedToken(request), env.TRIGGER_TOKEN))) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

async function healthz(env: Env): Promise<Response> {
  const problems: string[] = [];
  let settings: Awaited<ReturnType<typeof loadSettings>> = {};
  let jobCount: number | null = null;

  try {
    settings = await loadSettings(env.DB);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE enabled = 1").first<{ n: number }>();
    jobCount = row?.n ?? 0;
  } catch (cause) {
    problems.push(`D1 unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  for (const key of REQUIRED_SETTINGS) {
    if (settings[key] === undefined) problems.push(`settings.${key} is missing`);
  }
  if (!env.STRATO_SMTP_PASSWORD) problems.push("STRATO_SMTP_PASSWORD secret is not set");

  return json(
    {
      ok: problems.length === 0,
      problems,
      enabled_jobs: jobCount,
      kill_switch: isKillSwitchEngaged(settings) ? "engaged" : "off",
      test_mode: isTestMode(settings) ? "on" : "off",
      pinned_recipients: isTestMode(settings) ? TEST_MODE_ALLOWLIST : null,
      smtp: settings.smtp_host ? `${settings.smtp_host}:${settings.smtp_port}` : null,
      from: settings.from_address ?? null,
    },
    problems.length === 0 ? 200 : 503,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const denied = await authorize(request, env);
    if (denied) return denied;

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return await healthz(env);
    }

    const trigger = /^\/trigger\/([^/]+)$/.exec(url.pathname);
    if (trigger && request.method === "POST") {
      const jobId = decodeURIComponent(trigger[1]!);
      try {
        const outcome = await runJobById(env, jobId);
        if (outcome.suppressed) return json({ job: jobId, suppressed: outcome.suppressed }, 409);
        return json(outcome.result);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return json({ job: jobId, error: message }, message.startsWith("job not found") ? 404 : 500);
      }
    }
    if (trigger) return json({ error: "use POST" }, 405);

    return json({ error: "not found" }, 404);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Awaited inside waitUntil so the isolate survives the SMTP round trips and
    // the summary reaches the tail worker / observability logs.
    ctx.waitUntil(
      runDueJobs(env, event.scheduledTime).then((summary) => {
        console.log(JSON.stringify({ event: "cron", ...summary }));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
