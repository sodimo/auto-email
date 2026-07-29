/**
 * Production ERP mirror readiness gate.
 *
 * The NAS loader replaces one table at a time with DELETE + chunked INSERTs.
 * A query during that window can otherwise see a plausible but partial table.
 * The loader stamps every table in one run with the same `loaded_at` value, so
 * readiness requires:
 *   - conservative cardinality floors (copied from the dashboard posture),
 *   - all four tables needed by Wave 2 carrying the same load stamp,
 *   - the stamp being at least 10 minutes old (the final table cannot still be
 *     receiving chunks), and
 *   - a load no older than 36 hours (do not email silently stale data).
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
}

export interface ErpReadiness {
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

const SNAPSHOT_SQL = `
SELECT
  (SELECT COUNT(*) FROM fact_ventes) AS fact_ventes,
  (SELECT COUNT(*) FROM dim_client) AS dim_client,
  (SELECT COUNT(*) FROM fact_reglements) AS fact_reglements,
  (SELECT COUNT(*) FROM fact_echeances) AS fact_echeances,
  (SELECT MAX(loaded_at) FROM fact_ventes) AS ventes_loaded_at,
  (SELECT MAX(loaded_at) FROM dim_client) AS clients_loaded_at,
  (SELECT MAX(loaded_at) FROM fact_reglements) AS reglements_loaded_at,
  (SELECT MAX(loaded_at) FROM fact_echeances) AS echeances_loaded_at,
  (SELECT MAX(date) FROM fact_ventes WHERE type = 'VF') AS latest_sales_day
`;

export async function readErpSnapshot(db: D1Database): Promise<ErpSnapshot> {
  const row = await db.prepare(SNAPSHOT_SQL).first<ErpSnapshot>();
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

  const distinct = new Set(stamps as string[]);
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

export async function erpReadiness(db: D1Database, now = new Date()): Promise<ErpReadiness> {
  return validateErpSnapshot(await readErpSnapshot(db), now);
}

export async function assertErpReady(db: D1Database, now = new Date()): Promise<void> {
  const readiness = await erpReadiness(db, now);
  if (!readiness.ready) {
    throw new ErpNotReadyError(`Miroir ERP non prêt : ${readiness.reason}`);
  }
}
