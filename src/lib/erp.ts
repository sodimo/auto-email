/**
 * Production ERP mirror readiness gate.
 *
 * Incremental NAS loads publish one completion record in etl_run. Unchanged
 * rows deliberately keep their loaded_at, so row timestamps cannot establish
 * readiness after that cutover. The completion record supplies verified counts.
 * The legacy path below is used only while the ledger table does not exist.
 * The current NAS loader replaces one table at a time with DELETE + chunked
 * INSERTs. A query during that window can otherwise see a plausible but partial
 * table. The loader stamps every table in one run with the same `loaded_at`
 * value, so readiness requires:
 *   - conservative cardinality floors (copied from the dashboard posture),
 *   - all four tables needed by Wave 2 carrying the same load stamp, on their
 *     first and last rows (the whole table came from one load),
 *   - the stamp being at least 10 minutes old (the final table cannot still be
 *     receiving chunks), and
 *   - a load no older than 36 hours (do not email silently stale data).
 *
 * The legacy gate reads row MARKERS, never whole tables. Because the loader
 * starts each table from empty, rowids restart at 1 and the last rowid is the
 * row count; the first and last rows carry the load stamp. Each marker is one
 * row read, and the latest sales-invoice day walks the date index backwards.
 * About a dozen rows read per check, instead of the ~1.35 million that
 * COUNT(*) and MAX(loaded_at) over the four tables cost (measured locally at
 * production scale; there is no index on loaded_at).
 *
 * D1 has no read-only binding flag. The ERP binding is logically read-only
 * because every job query still goes through assertReadOnlySql.
 */

const MIN_SETTLE_MS = 10 * 60_000;
const MAX_AGE_MS = 36 * 60 * 60_000;

export const ERP_ROW_FLOORS = {
  fact_ventes: 100_000,
  dim_client: 1_000,
  fact_reglements: 10_000,
  fact_echeances: 10_000,
} as const;

export interface ErpSnapshot {
  fact_ventes: number;
  dim_client: number;
  fact_reglements: number;
  fact_echeances: number;
  ventes_loaded_at: string | null;
  clients_loaded_at: string | null;
  reglements_loaded_at: string | null;
  echeances_loaded_at: string | null;
  latest_sales_day: string | null;
  /** Load stamp of each table's FIRST row (legacy markers only). */
  ventes_first_loaded_at?: string | null;
  clients_first_loaded_at?: string | null;
  reglements_first_loaded_at?: string | null;
  echeances_first_loaded_at?: string | null;
}

export interface ErpReadiness {
  /** Present only for a verified incremental run; legacy bulk loads have no revision. */
  runId?: string;
  ready: boolean;
  reason: string | null;
  loadedAt: string | null;
  latestSalesDay: string | null;
  counts: {
    fact_ventes: number;
    dim_client: number;
    fact_reglements: number;
    fact_echeances: number;
  };
}

export class ErpNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErpNotReadyError";
  }
}

export interface ErpRun {
  run_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  source_loaded_at: string;
  counts_json: string;
  latest_sales_day: string | null;
}

function unavailable(reason: string): ErpReadiness {
  return {
    ready: false, reason, loadedAt: null, latestSalesDay: null,
    counts: { fact_ventes: 0, dim_client: 0, fact_reglements: 0, fact_echeances: 0 },
  };
}

export function validateErpRun(run: ErpRun | null, now = new Date()): ErpReadiness {
  if (!run || run.status !== "ok" || typeof run.run_id !== "string" || !run.run_id.trim()) {
    return unavailable("Le dernier chargement ERP n’est pas terminé avec succès.");
  }
  const started = Date.parse(run.started_at);
  const finished = Date.parse(run.finished_at ?? "");
  const source = Date.parse(run.source_loaded_at);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || !Number.isFinite(source)
      || finished < started || source > finished || source > now.getTime()
      || now.getTime() - source > MAX_AGE_MS) {
    return unavailable("Le suivi du chargement ERP contient des dates invalides ou trop anciennes.");
  }
  let counts: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(run.counts_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("counts");
    counts = parsed as Record<string, unknown>;
  } catch {
    return unavailable("Le comptage du dernier chargement ERP est illisible.");
  }
  // Reuse the same cardinality, settling and freshness checks as before.
  // Every stamp represents the completed run, not a changed row's timestamp.
  const readiness = validateErpSnapshot({
    fact_ventes: Number(counts.fact_ventes), dim_client: Number(counts.dim_client),
    fact_reglements: Number(counts.fact_reglements), fact_echeances: Number(counts.fact_echeances),
    ventes_loaded_at: run.finished_at, clients_loaded_at: run.finished_at,
    reglements_loaded_at: run.finished_at, echeances_loaded_at: run.finished_at,
    latest_sales_day: run.latest_sales_day,
  }, now);
  return { ...readiness, runId: run.run_id };
}

/** One row read per marker; see the header. INDEXED BY makes a missing index
 *  fail loudly instead of silently falling back to a full scan. */
export const MARKER_SNAPSHOT_SQL = `
SELECT
  (SELECT rowid FROM fact_ventes ORDER BY rowid DESC LIMIT 1) AS fact_ventes,
  (SELECT rowid FROM dim_client ORDER BY rowid DESC LIMIT 1) AS dim_client,
  (SELECT rowid FROM fact_reglements ORDER BY rowid DESC LIMIT 1) AS fact_reglements,
  (SELECT rowid FROM fact_echeances ORDER BY rowid DESC LIMIT 1) AS fact_echeances,
  (SELECT loaded_at FROM fact_ventes ORDER BY rowid DESC LIMIT 1) AS ventes_loaded_at,
  (SELECT loaded_at FROM dim_client ORDER BY rowid DESC LIMIT 1) AS clients_loaded_at,
  (SELECT loaded_at FROM fact_reglements ORDER BY rowid DESC LIMIT 1) AS reglements_loaded_at,
  (SELECT loaded_at FROM fact_echeances ORDER BY rowid DESC LIMIT 1) AS echeances_loaded_at,
  (SELECT loaded_at FROM fact_ventes ORDER BY rowid ASC LIMIT 1) AS ventes_first_loaded_at,
  (SELECT loaded_at FROM dim_client ORDER BY rowid ASC LIMIT 1) AS clients_first_loaded_at,
  (SELECT loaded_at FROM fact_reglements ORDER BY rowid ASC LIMIT 1) AS reglements_first_loaded_at,
  (SELECT loaded_at FROM fact_echeances ORDER BY rowid ASC LIMIT 1) AS echeances_first_loaded_at,
  (SELECT date FROM fact_ventes INDEXED BY idx_fact_ventes_date
    WHERE type = 'VF' ORDER BY date DESC LIMIT 1) AS latest_sales_day
`;

export async function readErpSnapshot(db: D1Database): Promise<ErpSnapshot> {
  const row = await db.prepare(MARKER_SNAPSHOT_SQL).first<ErpSnapshot>();
  if (!row) throw new ErpNotReadyError("Le miroir ERP n’a retourné aucun état de chargement.");
  return row;
}

/** Pure validation is exported so every failure mode can be tested without
 * manufacturing hundreds of thousands of fixture rows. */
export function validateErpSnapshot(snapshot: ErpSnapshot, now = new Date()): ErpReadiness {
  const counts = {
    fact_ventes: Number(snapshot.fact_ventes),
    dim_client: Number(snapshot.dim_client),
    fact_reglements: Number(snapshot.fact_reglements),
    fact_echeances: Number(snapshot.fact_echeances),
  };

  for (const [table, floor] of Object.entries(ERP_ROW_FLOORS) as [
    keyof typeof ERP_ROW_FLOORS,
    number,
  ][]) {
    if (!Number.isFinite(counts[table]) || counts[table] < floor) {
      return {
        ready: false,
        reason: `${table} semble vide ou en cours de chargement (${counts[table]} lignes, minimum ${floor}).`,
        loadedAt: null,
        latestSalesDay: snapshot.latest_sales_day,
        counts,
      };
    }
  }

  const stamps = [
    snapshot.ventes_loaded_at,
    snapshot.clients_loaded_at,
    snapshot.reglements_loaded_at,
    snapshot.echeances_loaded_at,
  ];
  if (stamps.some((stamp) => !stamp)) {
    return {
      ready: false,
      reason: "Un horodatage de chargement ERP est absent.",
      loadedAt: null,
      latestSalesDay: snapshot.latest_sales_day,
      counts,
    };
  }

  const firstStamps = [
    snapshot.ventes_first_loaded_at,
    snapshot.clients_first_loaded_at,
    snapshot.reglements_first_loaded_at,
    snapshot.echeances_first_loaded_at,
  ];
  const distinct = new Set(stamps as string[]);
  for (const first of firstStamps) {
    // Undefined means "not measured" (ledger path); null means an empty table.
    if (first !== undefined) distinct.add(first ?? "");
  }
  if (distinct.size !== 1) {
    return {
      ready: false,
      reason: "Les tables ERP ne proviennent pas toutes du même chargement nocturne.",
      loadedAt: null,
      latestSalesDay: snapshot.latest_sales_day,
      counts,
    };
  }

  const loadedAt = stamps[0]!;
  const loadedMs = Date.parse(loadedAt);
  if (!Number.isFinite(loadedMs)) {
    return {
      ready: false,
      reason: `Horodatage ERP illisible (${loadedAt}).`,
      loadedAt,
      latestSalesDay: snapshot.latest_sales_day,
      counts,
    };
  }

  const age = now.getTime() - loadedMs;
  if (age < 0) {
    return {
      ready: false,
      reason: `Le chargement ERP est daté dans le futur (${loadedAt}).`,
      loadedAt,
      latestSalesDay: snapshot.latest_sales_day,
      counts,
    };
  }
  if (age < MIN_SETTLE_MS) {
    return {
      ready: false,
      reason: "Le chargement ERP vient de démarrer ou de finir; attente de stabilisation (10 minutes).",
      loadedAt,
      latestSalesDay: snapshot.latest_sales_day,
      counts,
    };
  }
  if (age > MAX_AGE_MS) {
    return {
      ready: false,
      reason: `Le dernier chargement ERP est trop ancien (${loadedAt}, limite 36 h).`,
      loadedAt,
      latestSalesDay: snapshot.latest_sales_day,
      counts,
    };
  }
  if (!snapshot.latest_sales_day) {
    return {
      ready: false,
      reason: "Aucun jour de vente VF n’est disponible.",
      loadedAt,
      latestSalesDay: null,
      counts,
    };
  }

  return {
    ready: true,
    reason: null,
    loadedAt,
    latestSalesDay: snapshot.latest_sales_day,
    counts,
  };
}

function isMissingLedger(error: unknown): boolean {
  return error instanceof Error && /no such table:\s*(?:main\.)?etl_run\b/i.test(error.message);
}

export async function erpReadiness(db: D1Database, now = new Date()): Promise<ErpReadiness> {
  try {
    const run = await db.prepare(
      `SELECT run_id, status, started_at, finished_at, source_loaded_at, counts_json, latest_sales_day
         FROM etl_run WHERE id = 'latest'`,
    ).first<ErpRun>();
    return validateErpRun(run, now);
  } catch (error) {
    // Only a not-yet-installed ledger permits the old bulk-loader gate.
    // Quota, network, malformed schema and failed/partial imports never do.
    if (!isMissingLedger(error)) throw error;
    return validateErpSnapshot(await readErpSnapshot(db), now);
  }
}

export async function assertErpReady(db: D1Database, now = new Date()): Promise<ErpReadiness> {
  const readiness = await erpReadiness(db, now);
  if (!readiness.ready) {
    throw new ErpNotReadyError(`Miroir ERP non prêt : ${readiness.reason}`);
  }
  return readiness;
}

/** Reject data collected across a delta or cutover, before any outbox writes. */
export async function assertErpUnchanged(
  db: D1Database,
  before: ErpReadiness,
  now = new Date(),
): Promise<void> {
  let run: ErpRun | null;
  try {
    run = await db.prepare(
      `SELECT run_id, status, started_at, finished_at, source_loaded_at, counts_json, latest_sales_day
         FROM etl_run WHERE id = 'latest'`,
    ).first<ErpRun>();
  } catch (error) {
    if (before.runId || !isMissingLedger(error)) throw error;
    // Before cutover the markers are cheap, so re-read them: a nightly load
    // that started or finished while the report ran changes the stamp or a
    // row count, and the report must not be queued.
    const after = validateErpSnapshot(await readErpSnapshot(db), now);
    const same = after.ready && after.loadedAt === before.loadedAt &&
      after.latestSalesDay === before.latestSalesDay &&
      JSON.stringify(after.counts) === JSON.stringify(before.counts);
    if (!same) {
      throw new ErpNotReadyError("Le chargement ERP a changé pendant le rapport; aucun message n’a été mis en attente. Réessayez après la fin du chargement.");
    }
    return;
  }
  const after = validateErpRun(run, now);
  if (!before.runId || !after.ready || after.runId !== before.runId || after.loadedAt !== before.loadedAt) {
    throw new ErpNotReadyError("Le chargement ERP a changé pendant le rapport; aucun message n’a été mis en attente. Réessayez après la fin du chargement.");
  }
}
