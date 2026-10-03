import { fileURLToPath } from 'node:url';

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Tests run *inside* workerd, not Node. That means `env.DB` is a real D1, the
 * `RideRoom` Durable Object is a real Durable Object, and WebSockets behave the
 * way they will in production - which is the only way to trust negotiation code.
 *
 * As of `@cloudflare/vitest-pool-workers` 0.13+ the integration is a Vite
 * plugin (`cloudflareTest`) rather than `defineWorkersConfig`.
 */
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrationsDir = fileURLToPath(new URL('./migrations', import.meta.url));
      const migrations = await readD1Migrations(migrationsDir);

      return {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            JWT_SECRET: 'test-secret-do-not-use-in-production',
            TEST_MIGRATIONS: migrations,
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
