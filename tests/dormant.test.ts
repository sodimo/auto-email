/**
 * Guard for dormant mode (src/lib/dormant.ts, CLAUDE.md "Dormant").
 *
 * Both D1 bindings are replaced by recorders that THROW on any use (prepare,
 * exec, batch, dump, withSession, anything). Every call is also logged, so a
 * code path that catches the error (healthz does) still fails the test.
 */
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { isDormant } from "../src/lib/dormant.js";
import { drainOutbox } from "../src/lib/drain.js";
import { enqueueDueJobs, runJobById } from "../src/runner.js";
import type { Env } from "../src/types.js";
import wranglerConfig from "../wrangler.jsonc?raw";

function trapD1(name: string, touches: string[]): D1Database {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        // Promise-resolution probes are not D1 use; everything else is.
        if (prop === "then" || typeof prop === "symbol") return undefined;
        touches.push(`${name}.${String(prop)}`);
        throw new Error(`D1 touched while dormant: ${name}.${String(prop)}`);
      },
    },
  ) as D1Database;
}

function dormantEnv(dormant: string | undefined = "on"): { env: Env; touches: string[] } {
  const touches: string[] = [];
  const base: Env = {
    ...env,
    DB: trapD1("DB", touches),
    ERP: trapD1("ERP", touches),
  };
  if (dormant === undefined) delete base.DORMANT;
  else base.DORMANT = dormant;
  return { env: base, touches };
}

const ROUTES: Array<[string, string]> = [
  ["GET", "/"],
  ["GET", "/admin"],
  ["HEAD", "/"],
  ["HEAD", "/healthz"],
  ["OPTIONS", "/"],
  ["OPTIONS", "/api/admin/state"],
  ["GET", "/favicon.ico"],
  ["GET", "/healthz"],
  ["POST", "/drain"],
  ["POST", "/trigger/rapport-nightly"],
  ["GET", "/trigger/rapport-nightly"],
  ["GET", "/api/admin/state"],
  ["POST", "/api/admin/jobs"],
  ["POST", "/api/admin/jobs/1/trigger"],
  ["POST", "/api/admin/jobs/2/trigger"],
  ["PUT", "/api/admin/jobs/1/status"],
  ["PUT", "/api/admin/jobs/1"],
  ["POST", "/api/admin/templates"],
  ["PUT", "/api/admin/templates/1"],
  ["POST", "/api/admin/recipient-lists"],
  ["POST", "/api/admin/recipient-lists/1/members"],
  ["PUT", "/api/admin/recipient-lists/1"],
  ["PUT", "/api/admin/recipients/1"],
  ["DELETE", "/api/admin/recipients/1"],
  ["PATCH", "/api/admin/jobs/1"],
  ["PUT", "/api/admin/kill-switch"],
  ["GET", "/no-such-route"],
];

const HOSTS: Array<[string, Record<string, string>]> = [
  ["https://auto-email.test", {}],
  ["https://auto-email.test", { "x-trigger-token": "test-token" }],
  ["https://auto-email.sodimo.eu", { "cf-access-jwt-assertion": "x" }],
];

describe("dormant mode makes zero D1 calls", () => {
  it("is the default: anything but exactly \"off\" is dormant", () => {
    expect(isDormant({})).toBe(true);
    expect(isDormant({ DORMANT: "on" })).toBe(true);
    expect(isDormant({ DORMANT: "" })).toBe(true);
    expect(isDormant({ DORMANT: "of" })).toBe(true);
    expect(isDormant({ DORMANT: "OFF" })).toBe(true);
    expect(isDormant({ DORMANT: "off" })).toBe(false);
  });

  for (const dormant of ["on", undefined]) {
    it(`every route answers 503 dormant without D1 (DORMANT=${String(dormant)})`, async () => {
      for (const [origin, headers] of HOSTS) {
        for (const [method, path] of ROUTES) {
          const { env: denv, touches } = dormantEnv(dormant);
          const body = ["POST", "PUT", "PATCH"].includes(method) ? JSON.stringify({ enabled: true }) : undefined;
          const request = new Request(`${origin}${path}`, {
            method,
            headers: { ...headers, "content-type": "application/json", origin },
            body,
          });
          const response = await worker.fetch(request, denv);
          const label = `${method} ${origin}${path}`;
          expect(touches, label).toEqual([]);
          expect(response.status, label).toBe(503);
          expect(response.headers.get("x-auto-email-mode"), label).toBe("dormant");
          if (method === "HEAD") continue;
          const text = await response.text();
          expect(text, label).toContain("dormant");
          expect(text, label).toContain("en sommeil");
          if (path === "/" || path === "/admin") {
            expect(response.headers.get("content-type"), label).toContain("text/html");
          } else {
            expect(JSON.parse(text), label).toMatchObject({ status: "dormant", dormant: true });
          }
        }
      }
    });
  }

  it("an HTML-accepting browser gets the page on any path", async () => {
    const { env: denv, touches } = dormantEnv();
    const response = await worker.fetch(
      new Request("https://auto-email.sodimo.eu/api/admin/state", { headers: { accept: "text/html" } }),
      denv,
    );
    expect(touches).toEqual([]);
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("the scheduled handler returns before any D1 call", async () => {
    for (const cron of ["*/5 * * * *", "0 6 * * *", "0 7 * * 1"]) {
      const { env: denv, touches } = dormantEnv();
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ scheduledTime: Date.UTC(2026, 9, 19, 7, 0), cron }), denv, ctx);
      await waitOnExecutionContext(ctx);
      expect(touches, cron).toEqual([]);
    }
  });

  it("the choke points and the manual runner refuse without D1 too", async () => {
    const { env: denv, touches } = dormantEnv();
    expect((await drainOutbox(denv)).suppressed).toMatch(/^dormant/);
    expect((await enqueueDueJobs(denv, Date.UTC(2026, 9, 19, 7, 0))).suppressed).toMatch(/^dormant/);
    expect((await runJobById(denv, "rapport-nightly")).suppressed).toMatch(/^dormant/);
    expect(touches).toEqual([]);
  });
});

describe("the shipped wrangler.jsonc is dormant", () => {
  const code = wranglerConfig
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  it("sets DORMANT to on", () => {
    expect(code).toMatch(/"vars"\s*:\s*\{\s*"DORMANT"\s*:\s*"on"\s*\}/);
  });

  it("ships an EMPTY cron list (deploy deletes the triggers) and no other cron", () => {
    expect(code).toMatch(/"triggers"\s*:\s*\{\s*"crons"\s*:\s*\[\s*\]\s*\}/);
    expect(code.match(/"crons"/g)?.length).toBe(1);
  });
});
