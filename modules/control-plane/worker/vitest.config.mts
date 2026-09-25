import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Workers Vitest integration: tests run inside workerd with the Durable
// Objects from wrangler.jsonc. The miniflare bindings replace the empty Access
// placeholders with test-only values; no real team domain is ever contacted
// because the tests stub the JWKS fetch.
// https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Test-only: lets test/interop.test.mts load the node client, which
        // signs with node:crypto. The Worker itself uses WebCrypto only and is
        // bundled without this flag (see wrangler.jsonc and the dry run).
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          ACCESS_TEAM_DOMAIN: "https://team.example.com",
          ACCESS_AUD: "test-audience",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.mts"],
  },
});
