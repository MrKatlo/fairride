import type { RideRoom } from './durable/RideRoom.ts';

/**
 * Worker bindings.
 *
 * `Cloudflare.Env` comes from the generated `worker-configuration.d.ts`
 * (refresh it with `npm run cf-typegen` after changing wrangler.jsonc).
 * We only narrow the Durable Object binding so `RIDE_ROOM.getByName()` returns
 * a stub typed with the real RPC surface of `RideRoom`.
 */
export type Env = Omit<Cloudflare.Env, 'RIDE_ROOM'> & {
  RIDE_ROOM: DurableObjectNamespace<RideRoom>;
  /**
   * HS256 signing key. Declared here but intentionally absent from
   * wrangler.jsonc: set it with `wrangler secret put JWT_SECRET`, or put it in
   * a gitignored `.dev.vars` for local development.
   */
  JWT_SECRET: string;
  /**
   * Firebase project id. Defaults to the id embedded in the service account, so
   * in practice you only need to set the account itself. Exposed separately so
   * ID-token verification works even before push is configured.
   */
  FIREBASE_PROJECT_ID?: string;
  /**
   * The full Firebase service-account JSON, as a secret
   * (`wrangler secret put FIREBASE_SERVICE_ACCOUNT < key.json`). Optional:
   * without it, push is skipped and everything else keeps working.
   */
  FIREBASE_SERVICE_ACCOUNT?: string;
};
