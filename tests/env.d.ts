import type { D1Migration } from "cloudflare:test";
import type { Env as AutoEmailEnv } from "../src/types.js";

// `cloudflare:test` types its `env` as the global `Cloudflare.Env`, which
// `wrangler types` would normally generate. This Worker hand-writes its
// bindings (src/types.ts) so CI can typecheck without Cloudflare credentials,
// so the two are joined here instead.
declare global {
  namespace Cloudflare {
    interface Env extends AutoEmailEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
