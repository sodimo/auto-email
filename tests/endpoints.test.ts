import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { setSetting } from "./helpers.js";

const TOKEN = "test-token";
const auth = (token = TOKEN) => ({ "x-trigger-token": token });

describe("authentication", () => {
  it("rejects every endpoint without a token", async () => {
    for (const [path, method] of [
      ["/healthz", "GET"],
      ["/trigger/rapport-nightly", "POST"],
      ["/", "GET"],
    ] as const) {
      const response = await SELF.fetch(`https://auto-email.test${path}`, { method });
      expect(response.status, path).toBe(401);
    }
  });

  it("rejects a wrong token, including a prefix of the right one", async () => {
    for (const token of ["", "wrong", TOKEN.slice(0, -1), `${TOKEN}x`]) {
      const response = await SELF.fetch("https://auto-email.test/healthz", { headers: auth(token) });
      expect(response.status, token).toBe(401);
    }
  });

  it("accepts the token as a bearer credential too", async () => {
    const response = await SELF.fetch("https://auto-email.test/healthz", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
  });

  it("does not reveal routes to an anonymous caller", async () => {
    const response = await SELF.fetch("https://auto-email.test/no-such-route");
    expect(response.status).toBe(401);
  });
});

describe("GET /healthz", () => {
  it("reports D1, settings and both switch states", async () => {
    const response = await SELF.fetch("https://auto-email.test/healthz", { headers: auth() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      problems: [],
      enabled_jobs: 0,
      kill_switch: "off",
      test_mode: "on",
      pinned_recipients: ["thomas@leger.run", "tombionic@gmail.com"],
      from: "rapports@sodimo.eu",
    });
  });

  it("surfaces an engaged kill switch without failing the check", async () => {
    await setSetting("kill_switch", "on");
    const response = await SELF.fetch("https://auto-email.test/healthz", { headers: auth() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, kill_switch: "engaged" });
  });

  it("fails the check when a required setting is missing", async () => {
    await SELF.fetch("https://auto-email.test/healthz", { headers: auth() });
    const { env } = await import("cloudflare:test");
    await env.DB.prepare("DELETE FROM settings WHERE key = 'from_address'").run();

    const response = await SELF.fetch("https://auto-email.test/healthz", { headers: auth() });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { ok: boolean; problems: string[] };
    expect(body.ok).toBe(false);
    expect(body.problems).toContain("settings.from_address is missing");

    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('from_address', 'rapports@sodimo.eu')").run();
  });
});

describe("POST /trigger/:jobId", () => {
  it("404s an unknown job", async () => {
    const response = await SELF.fetch("https://auto-email.test/trigger/nope", {
      method: "POST",
      headers: auth(),
    });
    expect(response.status).toBe(404);
  });

  it("409s while the kill switch is engaged, before any send", async () => {
    await setSetting("kill_switch", "on");
    const response = await SELF.fetch("https://auto-email.test/trigger/rapport-nightly", {
      method: "POST",
      headers: auth(),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ suppressed: expect.stringContaining("kill switch") });
  });

  it("405s a GET on the trigger route", async () => {
    const response = await SELF.fetch("https://auto-email.test/trigger/rapport-nightly", { headers: auth() });
    expect(response.status).toBe(405);
  });

  it("404s an unknown route for an authenticated caller", async () => {
    const response = await SELF.fetch("https://auto-email.test/admin", { headers: auth() });
    expect(response.status).toBe(404);
  });
});
