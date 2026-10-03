import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';

import { ApiError, type AppEnv } from './http.ts';
import { adminRoutes } from './routes/admin.ts';
import { authRoutes } from './routes/auth.ts';
import { driverRoutes } from './routes/drivers.ts';
import { notificationRoutes } from './routes/notifications.ts';
import { rideRoutes } from './routes/rides.ts';

/**
 * FairRide API worker.
 *
 * Everything is authenticated with a bearer JWT except `/health` and the
 * `/v1/auth/*` endpoints. Long-lived sockets bypass this app entirely: the
 * `/ws` route forwards the upgraded request into the ride's Durable Object.
 */
const app = new Hono<AppEnv>();

// The mobile app and admin panel are separate origins. We authenticate with
// bearer tokens rather than cookies, so a permissive origin is safe here; pin
// this to your admin origin once it is deployed if you ever add cookies.
app.use(
  '*',
  cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
  }),
);

app.get('/health', (c) =>
  c.json({
    ok: true,
    environment: c.env.ENVIRONMENT,
    now: new Date().toISOString(),
  }),
);

app.route('/v1/auth', authRoutes);
app.route('/v1/rides', rideRoutes);
app.route('/v1/drivers', driverRoutes);
app.route('/v1/notifications', notificationRoutes);
app.route('/v1/admin', adminRoutes);

app.notFound((c) => c.json({ error: 'Not found', path: c.req.path }, 404));

app.onError((error, c) => {
  if (error instanceof ApiError) {
    return c.json({ error: error.message, details: error.details }, error.status);
  }
  if (error instanceof HTTPException) {
    return c.json({ error: error.message }, error.status);
  }
  console.error('unhandled_error', error);
  return c.json({ error: 'Internal server error.' }, 500);
});

// The Durable Object class must be exported from the entry module so the
// `migrations` entry in wrangler.jsonc can bind it.
export { RideRoom } from './durable/RideRoom.ts';

export default app;
