import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { assertReadOnlySql, ConditionSqlError, resolveDataSource } from "../src/lib/datasource.js";

describe("assertReadOnlySql", () => {
  it("accepts a single SELECT or WITH, trailing semicolon and all", () => {
    for (const sql of [
      "SELECT 1",
      "  select numero from test_invoices where jours >= 30  ",
      "WITH x AS (SELECT 1 AS n) SELECT n FROM x",
      "SELECT 1;",
      "-- an explanatory comment\nSELECT 1",
    ]) {
      expect(() => assertReadOnlySql(sql), sql).not.toThrow();
    }
  });

  it("rejects writes, DDL, transaction control and stacked statements", () => {
    for (const sql of [
      "DELETE FROM test_invoices",
      "UPDATE settings SET value = 'off'",
      "INSERT INTO jobs (name) VALUES ('x')",
      "DROP TABLE send_log",
      "PRAGMA table_list",
      "ATTACH DATABASE 'x' AS y",
      "SELECT 1; DELETE FROM send_log",
      "SELECT 1 /* */; DROP TABLE jobs",
      "BEGIN",
      "",
      "   ",
    ]) {
      expect(() => assertReadOnlySql(sql), sql).toThrow(ConditionSqlError);
    }
  });

  it("does not trip over column names that merely contain a keyword", () => {
    expect(() => assertReadOnlySql("SELECT updated_at, created_at FROM jobs")).not.toThrow();
  });

  it("sees through comments used to smuggle a second statement", () => {
    expect(() => assertReadOnlySql("SELECT 1 --\n; DROP TABLE jobs")).toThrow(ConditionSqlError);
  });
});

describe("resolveDataSource", () => {
  it("reads auto-email's own D1 in Wave 1", async () => {
    const source = resolveDataSource(env);
    expect(source.name).toBe("own");
    expect(await source.query("SELECT key FROM settings WHERE key = 'test_mode'")).toEqual([{ key: "test_mode" }]);
  });

  it("enforces the read-only guard on the way through", async () => {
    await expect(resolveDataSource(env).query("DELETE FROM send_log")).rejects.toThrow(ConditionSqlError);
  });
});
