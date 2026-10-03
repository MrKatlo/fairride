# FairRide

A negotiation-based ride-sharing platform in the spirit of inDrive: passengers name
their price, nearby drivers counter-offer, and a deal is struck in real time. The
whole thing runs on Cloudflare's edge (Workers, D1, R2, Durable Objects) with a
React Native (Expo) client and a Next.js operations console.

This repository is a **monorepo** managed with npm workspaces.

```
apps/
  api/      Cloudflare Worker: REST, Durable Object rooms, D1 schema
  mobile/   Expo + expo-router client (passenger and driver)
  admin/    Next.js App Router operations console
packages/
  shared/   Domain types, Zod schemas, the realtime protocol, ride state machine
```

## Why it is built this way

**Real-time price negotiation is the core feature, so it gets the serious
machinery.** Each ride is a Durable Object (`RideRoom`). A Durable Object is
single-threaded, so two drivers accepting the same offer at the same instant are
*serialised* by the runtime: the first wins, the second is told the offer is
already resolved. Without it you would need a distributed lock or an optimistic
retry loop against D1, and you would still race.

**D1 is the durable source of truth; the Durable Object is the coordination
layer.** Rides, offers, chat and an append-only event log live in D1 so the admin
console and analytics can query them with SQL. The DO owns socket fan-out, the
negotiation timeout (a single alarm), and ordering. Negotiation write volume is a
handful of rows per ride, so writing through to D1 is cheap and avoids a
dual-source-of-truth problem.

**The state machine lives in `packages/shared`.** `ride-status.ts` is the single
source of truth for which status transitions are legal and who may trigger them,
and it is used by the API, the Durable Object, and the clients. `assertTransition`
and `assertRideInvariants` are called before anything is persisted, so an invalid
transition cannot reach the database even if a future handler forgets to check.

**WebSockets, not Socket.IO.** Socket.IO's long-polling fallback and adapter model
fight the Workers runtime. The native WebSocket API + hibernatable Durable Object
sockets is the supported path, and an idle room costs nothing while everyone
stares at the negotiation screen.

**Money is `REAL` in the ride's currency.** Fine for a launch city; see
*Known gaps* for the migration to integer minor units before real volume.

**Firebase Authentication owns identity; the Worker only verifies it.** The app
signs in with Firebase phone auth, then trades the resulting ID token at
`POST /v1/auth/firebase` for our own session JWT. The Worker verifies the ID
token against Google's published JWKS with `crypto.subtle` - no `firebase-admin`,
no Node-only dependency in the request path - and reads the phone number from the
*verified* token, so a client can never claim someone else's number.

**Push notifications go through FCM HTTP v1.** The Worker signs a service-account
assertion, exchanges it for an OAuth2 token, and sends. Delivery happens in
`ctx.waitUntil` from the ride room, so a slow FCM call never delays the
WebSocket broadcast and a failed push never fails a ride operation.

## Getting started

Requirements: Node 20+ (22 recommended), an npm that supports workspaces, and a
Cloudflare account for deployment (not needed for local development).

```bash
npm install
```

### 1. API (Cloudflare Worker)

```bash
cd apps/api
cp .dev.vars.example .dev.vars         # local secrets for `wrangler dev`
npx wrangler d1 create fairride        # prints a database_id
```

Paste the printed `database_id` into `apps/api/wrangler.jsonc`, replacing the
placeholder in the `d1_databases` block.

```bash
npm run db:migrate:local -w @fairride/api   # create tables in the local D1
npm run api:dev                             # wrangler dev on http://localhost:8787
```

The API needs `JWT_SECRET`. Locally it comes from `apps/api/.dev.vars` (created
above). For production:

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put STRIPE_SECRET_KEY   # when payments are wired up
```

`ENVIRONMENT=development` makes OTP codes echo back in the response and enables
`POST /v1/auth/dev/token`, which mints tokens for testing. Both fail closed
outside development.

### 2. Mobile app (Expo + Firebase)

Firebase Auth, FCM, Maps and Reanimated all ship **native code**, so the app runs
in a development build, not Expo Go. After installing dependencies:

```bash
cp apps/mobile/.env.example apps/mobile/.env.local
npm run doctor -w @fairride/mobile    # must be 21/21 before you build
npm run android -w @fairride/mobile   # prebuilds, then builds and installs
```

Twenty of the app's dependencies compile native code. Changing any of them, or
any field under `expo.android` / `expo.ios` / `expo.plugins` in `app.json`,
requires a **new build**. Everything currently needed is already installed and
pinned to the versions Expo SDK 57 expects:

| Native module | Why it needs a build |
| --- | --- |
| `react-native`, `react-native-screens`, `react-native-safe-area-context` | App shell and navigation |
| `expo`, `expo-constants`, `expo-linking`, `expo-status-bar` | Runtime, deep links |
| `@react-native-firebase/app` `…/auth` `…/messaging` | Phone sign-in, FCM |
| `expo-location` | GPS for pickup and live driver position |
| `react-native-maps` | Map view (needs the Google Maps key in `app.json`) |
| `expo-secure-store` | Stores the session token in the keychain |
| `expo-image-picker`, `expo-file-system` | Driver document and avatar uploads |
| `react-native-gesture-handler`, `react-native-reanimated`, `react-native-worklets` | Gestures and animation (Reanimated 4 runs on `worklets`) |
| `expo-system-ui` | Honours `userInterfaceStyle` on Android |
| `expo-dev-client` | The development build itself |

`android/` and `ios/` are **gitignored on purpose**. The project uses Continuous
Native Generation: `expo prebuild` regenerates them from `app.json` on every
build, so they can never drift from your config.

`apps/mobile/google-services.json` is the Firebase Android config and is
committed (it contains client keys only). It registers the package
`com.polecreates.fairride`, which must match `android.package` in `app.json`.
Phone-auth SMS on Android also requires your signing certificate's SHA-1 to be
registered in the Firebase console.

Set `EXPO_PUBLIC_API_URL` for your target: `http://localhost:8787` on an iOS
simulator or web, `http://10.0.2.2:8787` on an Android emulator, or your machine's
LAN address on a physical device.

The app has two surfaces:

- **Passenger**: request a ride at your own price, watch offers arrive live,
  accept or decline, chat, and track your driver.
- **Driver**: onboard, go online, see open requests nearby, counter-offer, accept
  the passenger's price, and walk the trip through `arrived → started → completed`.

Sign in with a real phone number; Firebase sends the SMS. Your number must be
allowed in the Firebase console (test numbers while the project is in
sandbox mode).

### 3. Admin console (Next.js)

```bash
npm run admin:dev        # http://localhost:3001
```

Sign in with a development admin id (the page calls `/v1/auth/dev/token`). The
dashboard shows ride/driver metrics, lets you approve or reject drivers, and
lists recent rides filtered by status.

## Testing

Tests run **inside workerd** through `@cloudflare/vitest-pool-workers`, so `env.DB`
is a real D1 and `RideRoom` is a real Durable Object with real WebSockets. That is
the only way to trust negotiation concurrency.

```bash
npm test                       # all workspaces
npm test -w @fairride/api      # RideRoom negotiation integration tests
npm run typecheck              # tsc --noEmit across the monorepo
```

`apps/api/test/negotiation.test.ts` covers the offer → counter → accept flow,
rejections, self-answers, supersede semantics, illegal transitions, the full
`arrived → started → completed` walk, driver-location permissions, chat, rate
limiting, and malformed frames.

## API surface

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/auth/firebase` | Exchange a Firebase ID token for a session JWT (primary login) |
| `POST` | `/v1/auth/otp/request` | Legacy phone OTP (dev only; superseded by Firebase) |
| `POST` | `/v1/auth/otp/verify` | Legacy phone OTP |
| `POST` | `/v1/auth/dev/token` | Development only |
| `POST` | `/v1/notifications/devices` | Register this device's FCM token |
| `DELETE` | `/v1/notifications/devices` | Unregister the device's FCM token |
| `POST` | `/v1/rides` | Request a ride at a price |
| `GET` | `/v1/rides` | The caller's rides |
| `GET` | `/v1/rides/available` | Open requests (drivers) |
| `GET` | `/v1/rides/:id` | Ride + offers |
| `GET` | `/v1/rides/:id/live` | Snapshot from the Durable Object |
| `GET` | `/v1/rides/:id/ws` | WebSocket upgrade |
| `POST` | `/v1/rides/:id/rate` | Rate the counterparty (completed rides) |
| `POST` | `/v1/drivers/me` | Driver onboarding |
| `GET` | `/v1/drivers/me` | Driver profile |
| `POST` | `/v1/drivers/me/online` \| `/offline` | Availability |
| `POST` | `/v1/drivers/me/location` | Location heartbeat |
| `PUT` | `/v1/drivers/me/documents/:kind` | Upload to R2 |
| `GET` | `/v1/drivers/nearby` | Nearby online drivers |
| `GET` | `/v1/admin/metrics` | Admin only |
| `GET` | `/v1/admin/rides` | Admin only |
| `GET` | `/v1/admin/drivers` | Admin only |
| `POST` | `/v1/admin/drivers/:userId/approval` | Admin only |

### Realtime protocol

One socket == one ride room: `GET /v1/rides/:rideId/ws?token=<jwt>&v=1`.

Clients send `ClientIntent`s — `offer.create`, `offer.accept`, `offer.reject`,
`ride.transition`, `driver.location`, `chat.message`, `ping`. The server replies
with `ServerEvent`s — `ride.snapshot`, `offer.created`, `offer.updated`,
`ride.status_changed`, `driver.location`, `chat.message`, `ride.presence`,
`error`, `pong`. Both directions are validated with Zod; a malformed frame yields
an `error` event rather than tearing the room down. A snapshot is sent on every
(re)connect, so a client never has to reconcile a gap.

## Known gaps / next steps

- **Payments** are modelled in D1 (`payments`) but no provider is wired up.
  `STRIPE_SECRET_KEY` is reserved, and the mobile app has `expo-web-browser` plus
  `src/lib/payments.ts` ready for a **hosted checkout**: create the session
  server-side, open it in the system browser, and let the provider's webhook -
  not the client - mark the ride paid. `payments` already has a unique index per
  ride, so webhook retries upsert instead of double-charging.
- **Money should be integer minor units.** `REAL` currency columns are a
  deliberate launch shortcut; convert to cents (`INTEGER`) before meaningful
  volume and keep a migration that re-scales existing rows.
- **Negotiation timeout** uses a Durable Object alarm with a 3-minute TTL. It
  cancels the ride; a production system would also notify both parties and
  reopen the request.
- **Driver presence** is still a D1 hotspot: `/v1/drivers/me/location` writes on
  every heartbeat. Move presence into a per-city Durable Object and flush to D1
  periodically.
- **Matching is pull-based.** `GET /v1/rides/available` polls. Push open requests
  to nearby drivers via a Queue fan-out or a presence Durable Object.
- **Places and maps.** The mobile app uses device coordinates and a demo
  destination offset. Wrap a places-autocomplete + map picker next.
- **The built-in phone OTP routes are now legacy.** Firebase Authentication is
  the login path; `deliverCode` still throws outside development. Delete the
  `/v1/auth/otp/*` routes once you are sure nothing depends on them.
- **Session JWTs do not expire during a session** (12h TTL, no refresh). Firebase
  handles identity refresh; add our own rotation if you need short-lived access
  tokens with revocation.
- **FCM sends happen inline in `waitUntil`.** At volume, move delivery to a
  Queue so a burst of ride updates cannot exhaust a room's subrequests.
- **Admin auth** reuses the dev token endpoint in the skeleton; production should
  route admins through the OTP flow with the role checked server-side.
