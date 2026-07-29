import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // Schema + seed, applied to each test file's isolated D1 by tests/setup.ts.
      const migrations = await readD1Migrations(new URL("./migrations", import.meta.url).pathname);
      return {
        main: "./src/index.ts",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Stand-ins for the real Worker secrets. The SMTP password is never
            // used: every test injects a fake Mailer, and setup.ts points
            // settings.smtp_host at 127.0.0.1 so an accidental real connection
            // fails locally instead of reaching Strato.
            STRATO_SMTP_PASSWORD: "not-a-real-password",
            TRIGGER_TOKEN: "test-token",
          },
        },
      };
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
  },
});
