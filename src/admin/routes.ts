import { drainOutbox } from "../lib/drain.js";
import { ErpNotReadyError } from "../lib/erp.js";
import { runJobById } from "../runner.js";
import type { Env } from "../types.js";
import {
  addRecipient,
  AdminConflictError,
  AdminInputError,
  AdminNotFoundError,
  createJob,
  createRecipientList,
  createTemplate,
  deleteRecipient,
  loadAdminState,
  setJobEnabled,
  setKillSwitch,
  updateJob,
  updateRecipient,
  updateRecipientList,
  updateTemplate,
} from "./service.js";

const MAX_JSON_BYTES = 128_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function readJson(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new AdminInputError("Le contenu doit être envoyé en JSON.");
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    throw new AdminInputError("Le formulaire envoyé est trop volumineux.");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_JSON_BYTES) {
    throw new AdminInputError("Le formulaire envoyé est trop volumineux.");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new AdminInputError("Le formulaire envoyé n’est pas un JSON valide.");
  }
}

function mutationDenied(request: Request, url: URL): Response | null {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return null;
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site") return json({ error: "Requête intersite refusée." }, 403);
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return json({ error: "Origine refusée." }, 403);
  return null;
}

function errorResponse(cause: unknown): Response {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (
    cause instanceof AdminInputError ||
    cause instanceof AdminNotFoundError ||
    cause instanceof AdminConflictError
  ) {
    return json({ error: message }, cause.status);
  }
  if (cause instanceof ErpNotReadyError) return json({ error: message }, 503);
  console.error(JSON.stringify({ event: "admin_error", error: message }));
  return json({ error: "Une erreur interne est survenue." }, 500);
}

/**
 * Auth is intentionally handled before this router in index.ts. Returning null
 * means "not an admin API path"; an unknown /api/admin path gets a protected 404.
 */
export async function handleAdminApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/admin")) return null;
  const denied = mutationDenied(request, url);
  if (denied) return denied;

  try {
    if (url.pathname === "/api/admin/state") {
      if (request.method !== "GET") return json({ error: "Utilisez GET." }, 405);
      return json(await loadAdminState(env));
    }

    if (url.pathname === "/api/admin/jobs") {
      if (request.method !== "POST") return json({ error: "Utilisez POST." }, 405);
      return json({ ok: true, ...(await createJob(env.DB, await readJson(request))) }, 201);
    }

    const jobTrigger = /^\/api\/admin\/jobs\/(\d+)\/trigger$/.exec(url.pathname);
    if (jobTrigger) {
      if (request.method !== "POST") return json({ error: "Utilisez POST." }, 405);
      const queued = await runJobById(env, jobTrigger[1]!);
      if (queued.suppressed) return json({ error: queued.suppressed }, 409);
      return json({ ok: true, queued: queued.result, drained: await drainOutbox(env) });
    }

    const jobStatus = /^\/api\/admin\/jobs\/(\d+)\/status$/.exec(url.pathname);
    if (jobStatus) {
      if (request.method !== "POST") return json({ error: "Utilisez POST." }, 405);
      await setJobEnabled(env.DB, jobStatus[1], await readJson(request));
      return json({ ok: true });
    }

    const job = /^\/api\/admin\/jobs\/(\d+)$/.exec(url.pathname);
    if (job) {
      if (request.method !== "PUT") return json({ error: "Utilisez PUT." }, 405);
      await updateJob(env.DB, job[1], await readJson(request));
      return json({ ok: true });
    }

    if (url.pathname === "/api/admin/templates") {
      if (request.method !== "POST") return json({ error: "Utilisez POST." }, 405);
      return json({ ok: true, ...(await createTemplate(env.DB, await readJson(request))) }, 201);
    }

    const template = /^\/api\/admin\/templates\/(\d+)$/.exec(url.pathname);
    if (template) {
      if (request.method !== "PUT") return json({ error: "Utilisez PUT." }, 405);
      await updateTemplate(env.DB, template[1], await readJson(request));
      return json({ ok: true });
    }

    if (url.pathname === "/api/admin/recipient-lists") {
      if (request.method !== "POST") return json({ error: "Utilisez POST." }, 405);
      return json({ ok: true, ...(await createRecipientList(env.DB, await readJson(request))) }, 201);
    }

    const members = /^\/api\/admin\/recipient-lists\/(\d+)\/members$/.exec(url.pathname);
    if (members) {
      if (request.method !== "POST") return json({ error: "Utilisez POST." }, 405);
      return json(
        { ok: true, ...(await addRecipient(env.DB, members[1], await readJson(request))) },
        201,
      );
    }

    const list = /^\/api\/admin\/recipient-lists\/(\d+)$/.exec(url.pathname);
    if (list) {
      if (request.method !== "PUT") return json({ error: "Utilisez PUT." }, 405);
      await updateRecipientList(env.DB, list[1], await readJson(request));
      return json({ ok: true });
    }

    const member = /^\/api\/admin\/recipients\/(\d+)$/.exec(url.pathname);
    if (member) {
      if (request.method === "PUT") {
        await updateRecipient(env.DB, member[1], await readJson(request));
        return json({ ok: true });
      }
      if (request.method === "DELETE") {
        await deleteRecipient(env.DB, member[1]);
        return json({ ok: true });
      }
      return json({ error: "Utilisez PUT ou DELETE." }, 405);
    }

    if (url.pathname === "/api/admin/kill-switch") {
      if (request.method !== "POST") return json({ error: "Utilisez POST." }, 405);
      return json({ ok: true, state: await setKillSwitch(env.DB, await readJson(request)) });
    }

    return json({ error: "Route d’administration introuvable." }, 404);
  } catch (cause) {
    return errorResponse(cause);
  }
}

