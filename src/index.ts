/**
 * Worker entry. Three surfaces, no UI (that is Wave 2, at auto-email.sodimo.eu
 * behind Cloudflare Access):
 *   scheduled()             the cron tick: enqueue what is due, then drain a batch
 *   POST /trigger/:jobId    enqueue one job now and drain, same code path as cron
 *   POST /drain             drain the outbox without enqueueing anything
 *   GET  /healthz           D1, settings, secrets, switch states, queue backlog
 *
 * Every endpoint requires the TRIGGER_TOKEN shared secret. There is no
 * anonymous surface at all: an unauthenticated request cannot even distinguish
 * a missing route from a wrong token.
 */
import { loadSettings } from "./lib/db.js";
import { drainOutbox } from "./lib/drain.js";
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
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
  let enabledJobs: number | null = null;
  let queue: { pending: number; failed: number; oldest: string | null } | null = null;

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
        return json({ job: jobId, error: message }, message.startsWith("job not found") ? 404 : 500);
      }
    }
    if (trigger) return json({ error: "use POST" }, 405);

    return json({ error: "not found" }, 404);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
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
