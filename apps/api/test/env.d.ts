/// <reference path="../../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />

import type { D1Migration } from 'cloudflare:test';

/**
 * Test-only bindings that `vitest.config.ts` injects into Miniflare but that do
 * not exist in `wrangler.jsonc`. `cloudflare:test`'s `env` is typed as
 * `Cloudflare.Env`, so we widen that namespace here rather than casting at each
 * call site.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      JWT_SECRET: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
