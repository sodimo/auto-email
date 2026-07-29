/**
 * Where a condition job's rows come from.
 *
 * WAVE 1 runs `condition_sql` against auto-email's own D1. WAVE 3 will bind the
 * read-only `sodimo-prod` ERP mirror as `env.ERP` and route condition jobs
 * there; `resolveDataSource` is the single place that changes.
 *
 * D1 has NO read-only binding mode — `env.DB`/`env.ERP` are ordinary read/WRITE
 * handles. `assertReadOnlySql` is therefore load-bearing for write-prevention,
 * not belt-and-braces. Never weaken it. (Same lesson as the sibling `crm`
 * Worker's ERP guard.)
 */
import { MAX_CONDITION_ROWS } from "../config.js";
import type { DataRow, Env } from "../types.js";

export interface DataSource {
  readonly name: string;
  query(sql: string): Promise<DataRow[]>;
}

const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|truncate|begin|commit|rollback|savepoint)\b/i;

export class ConditionSqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConditionSqlError";
  }
}

/** Strips comments, then insists on exactly one SELECT/WITH statement. */
export function assertReadOnlySql(sql: string): void {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim()
    .replace(/;\s*$/, "")
    .trim();

  if (stripped === "") throw new ConditionSqlError("condition_sql is empty");
  if (stripped.includes(";")) {
    throw new ConditionSqlError("condition_sql must be a single statement (no ';')");
  }
  if (!/^(select|with)\b/i.test(stripped)) {
    throw new ConditionSqlError("condition_sql must start with SELECT or WITH");
  }
  const forbidden = FORBIDDEN.exec(stripped);
  if (forbidden) {
    throw new ConditionSqlError(`condition_sql contains the forbidden keyword "${forbidden[0]}"`);
  }
}

function d1Source(name: string, db: D1Database): DataSource {
  return {
    name,
    async query(sql: string): Promise<DataRow[]> {
      assertReadOnlySql(sql);
      const { results } = await db.prepare(sql).all<DataRow>();
      if (results.length > MAX_CONDITION_ROWS) {
        throw new ConditionSqlError(
          `condition_sql returned ${results.length} rows, over the ${MAX_CONDITION_ROWS} cap`,
        );
      }
      return results;
    },
  };
}

export function resolveDataSource(env: Env): DataSource {
  // WAVE 3 SEAM. Merely adding the ERP binding must NOT silently redirect
  // existing condition jobs, so the branch is written but not taken: routing
  // will become a per-job column (`source`) decided when the mirror lands.
  //   if (job.source === "erp" && env.ERP) return d1Source("erp", env.ERP);
  void env.ERP;
  return d1Source("own", env.DB);
}
