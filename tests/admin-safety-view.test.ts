/**
 * Runs the admin page's own inline script against a minimal DOM stand-in, so
 * the side-panel stop status is checked as the browser would compute it, and
 * checks that the page still makes a single state request on load.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { loadAdminState } from "../src/admin/service.js";
import type { Env } from "../src/types.js";

const tokenAuth = { "x-trigger-token": "test-token" };
const accessAuth = { "cf-access-jwt-assertion": "test-access-jwt" };

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return await SELF.fetch(`https://auto-email.test${path}`, {
    method,
    headers: {
      ...tokenAuth,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Wraps a D1 binding and records every statement handed to it. */
function counted(db: D1Database, log: string[]): D1Database {
  return {
    prepare(sql: string) {
      log.push(sql);
      return db.prepare(sql);
    },
    batch(statements: D1PreparedStatement[]) {
      log.push(`batch of ${statements.length}`);
      return db.batch(statements);
    },
    exec(sql: string) {
      log.push(sql);
      return db.exec(sql);
    },
    withSession() {
      throw new Error("unexpected D1 session in the admin page load");
    },
    dump() {
      return db.dump();
    },
  } as unknown as D1Database;
}

class FakeElement {
  textContent = "";
  innerHTML = "";
  hidden = false;
  className = "";
  value = "";
  disabled = false;
  checked = false;
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  classList = { toggle: () => undefined };
  addEventListener(): void {}
  append(): void {}
  showModal(): void {}
  close(): void {}
  focus(): void {}
  reset(): void {}
  closest(): null {
    return null;
  }
  querySelector(): FakeElement {
    return new FakeElement();
  }
}

interface PageLoad {
  elements: Map<string, FakeElement>;
  requests: string[];
  db: string[];
  erp: string[];
}

/** Serves the real page, runs its script, and answers its one state request. */
async function loadPage(): Promise<PageLoad> {
  const response = await SELF.fetch("https://auto-email.sodimo.eu/", { headers: accessAuth });
  expect(response.status).toBe(200);
  const html = await response.text();
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1];
  expect(script).toBeTruthy();

  const load: PageLoad = { elements: new Map(), requests: [], db: [], erp: [] };
  const element = (selector: string): FakeElement => {
    let node = load.elements.get(selector);
    if (!node) {
      node = new FakeElement();
      load.elements.set(selector, node);
    }
    return node;
  };
  const document = {
    querySelector: element,
    querySelectorAll: () => [],
    getElementById: (id: string) => element(`#${id}`),
    createElement: () => new FakeElement(),
    addEventListener: () => undefined,
  };
  const pageEnv = { ...env, DB: counted(env.DB, load.db), ERP: counted(env.ERP, load.erp) } as Env;
  let settled!: () => void;
  const stateServed = new Promise<void>((resolve) => { settled = resolve; });
  const fetch = async (url: URL, options: { method: string }) => {
    load.requests.push(`${options.method} ${url.pathname}`);
    if (options.method !== "GET" || url.pathname !== "/api/admin/state") {
      throw new Error(`unexpected request on page load: ${options.method} ${url.pathname}`);
    }
    const body = JSON.stringify(await loadAdminState(pageEnv));
    settled();
    return new Response(body, { headers: { "content-type": "application/json" } });
  };
  const location = { origin: "https://auto-email.sodimo.eu", search: "" };

  new Function("document", "fetch", "location", script!)(document, fetch, location);
  await stateServed;
  // reload() renders after two more awaits (response.json, then renderAll).
  for (let tick = 0; tick < 20 && !load.elements.get("#erp-head")?.textContent; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(load.elements.get("#jobs-body")?.innerHTML ?? "").not.toContain("Impossible de charger");
  return load;
}

function text(load: PageLoad, selector: string): string {
  return load.elements.get(selector)?.textContent ?? "";
}

async function enableJob(name: string): Promise<void> {
  const state = (await (await api("GET", "/api/admin/state")).json()) as any;
  const job = state.jobs.find((item: any) => item.name === name);
  expect((await api("POST", `/api/admin/jobs/${job.id}/status`, { enabled: true })).status).toBe(200);
}

describe("side-panel stop status", () => {
  it("says the stop is lifted but nothing is active when every job is paused", async () => {
    // tests/setup.ts seeds exactly this: kill switch off, both jobs paused.
    const state = (await (await api("GET", "/api/admin/state")).json()) as any;
    expect(state.safety.kill_switch).toBe("off");
    expect(state.jobs.length).toBeGreaterThan(0);
    expect(state.jobs.every((job: any) => job.enabled === false)).toBe(true);

    const page = await loadPage();
    expect(text(page, "#side-kill-title")).toBe("Arrêt général levé, aucun envoi actif");
    expect(text(page, "#side-kill-copy")).toBe("Tous les envois programmés sont en pause");
    expect(text(page, "#safety-kill-copy")).toContain("tous les envois sont en pause");
    // Pausing a job does not hold rows already queued: the drain sends them.
    expect(text(page, "#safety-kill-copy")).toContain("« Tester » part quand même");
    expect(text(page, "#safety-kill-copy")).toContain("les messages déjà en file d’attente partent encore");
    expect(text(page, "#safety-kill-copy")).toContain("Pour tout retenir, utilisez l’arrêt général");
    expect(text(page, "#side-kill-title")).not.toBe("Envois autorisés");
    expect(page.elements.get("#kill-banner")?.hidden).toBe(true);
  });

  it("keeps 'Envois autorisés' once one job is active", async () => {
    await enableJob("rapport-nightly");
    const page = await loadPage();
    expect(text(page, "#side-kill-title")).toBe("Envois autorisés");
    expect(text(page, "#side-kill-copy")).toBe("L’arrêt général est désengagé");
    expect(text(page, "#safety-kill-copy")).toContain("selon leur programmation");
  });

  it("shows the engaged stop first, whatever the jobs", async () => {
    await enableJob("rapport-nightly");
    expect((await api("POST", "/api/admin/kill-switch", { engaged: true })).status).toBe(200);
    const page = await loadPage();
    expect(text(page, "#side-kill-title")).toBe("Envois arrêtés");
    expect(page.elements.get("#kill-banner")?.hidden).toBe(false);
  });
});

describe("page-load cost", () => {
  it("makes no extra request from the page and keeps 6 own-database statements", async () => {
    // One direct state load is the reference: it is what /api/admin/state runs.
    // The page must cost exactly one such load. The own-database count is
    // pinned so a new statement in loadAdminState fails here. The ERP count is
    // not pinned: the ERP freshness check is owned and tuned elsewhere.
    const reference = { db: [] as string[], erp: [] as string[] };
    await loadAdminState({ ...env, DB: counted(env.DB, reference.db), ERP: counted(env.ERP, reference.erp) } as Env);
    expect(reference.db).toHaveLength(6);

    const idle = await loadPage();
    await enableJob("rapport-nightly");
    const active = await loadPage();

    for (const page of [idle, active]) {
      expect(page.requests).toEqual(["GET /api/admin/state"]);
      expect(page.db).toEqual(reference.db);
      expect(page.erp).toEqual(reference.erp);
    }
  });
});

describe("Sécurité tab", () => {
  it("explains that the stop cannot change while D1 refuses writes", async () => {
    const response = await SELF.fetch("https://auto-email.sodimo.eu/", { headers: accessAuth });
    const html = await response.text();
    const note = /<p class="safety-note" id="safety-d1-note">([^<]+)<\/p>/.exec(html)?.[1] ?? "";
    expect(note).toContain("refuse les écritures");
    expect(note).toContain("l’arrêt général ne peut pas être modifié");
    expect(note).toContain("aucun message n’est envoyé");
    expect(note).toContain("la base de données (Cloudflare D1)");
    expect(note).toContain("Le compteur repart à zéro à 00:00 UTC");
  });
});
