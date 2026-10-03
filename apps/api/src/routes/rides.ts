import { Hono } from 'hono';
import { createRideRequestSchema, rateRideSchema, type Ride } from '@fairride/shared';

import {
  boundingBox,
  findOffers,
  findRide,
  isRideParticipant,
  mapRideRow,
  newId,
  nowIso,
  type RideRow,
} from '../db.ts';
import { type AppEnv, conflict, forbidden, notFound, readJson, requireAuth, requireRole } from '../http.ts';

export const rideRoutes = new Hono<AppEnv>();

rideRoutes.use('*', requireAuth);

/** Request a ride at the passenger's own price. */
rideRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await readJson(c, createRideRequestSchema);
  const now = nowIso();

  const ride: Ride = {
    id: newId('ride'),
    passengerId: user.id,
    driverId: null,
    status: 'requested',
    pickup: { lat: body.pickup.lat, lng: body.pickup.lng, address: body.pickup.address ?? null },
    dropoff: { lat: body.dropoff.lat, lng: body.dropoff.lng, address: body.dropoff.address ?? null },
    passengerProposedPrice: body.proposedPrice,
    finalPrice: null,
    currency: body.currency,
    distanceMeters: null,
    durationSeconds: null,
    createdAt: now,
    acceptedAt: null,
    arrivedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    cancelledBy: null,
    cancellationReason: null,
  };

  // Ride + its first audit event land atomically.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO rides (
         id, passenger_id, status,
         pickup_lat, pickup_lng, pickup_address,
         dropoff_lat, dropoff_lng, dropoff_address,
         passenger_proposed_price, currency, created_at
       ) VALUES (?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      ride.id,
      ride.passengerId,
      ride.pickup.lat,
      ride.pickup.lng,
      ride.pickup.address,
      ride.dropoff.lat,
      ride.dropoff.lng,
      ride.dropoff.address,
      ride.passengerProposedPrice,
      ride.currency,
      ride.createdAt,
    ),
    c.env.DB.prepare(
      'INSERT INTO ride_events (id, ride_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(newId('evt'), ride.id, 'ride.requested', JSON.stringify({ price: body.proposedPrice }), now),
  ]);

  // TODO(matching): push `ride.new_request` to nearby online drivers. Needs a
  // presence Durable Object (see README) or a Cloudflare Queue fan-out.

  return c.json({ ride }, 201);
});

/** Rides the caller is involved in, newest first. */
rideRoutes.get('/', async (c) => {
  const user = c.get('user');
  const status = c.req.query('status');
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 100);

  const base =
    'SELECT * FROM rides WHERE (passenger_id = ? OR driver_id = ?)' +
    (status ? ' AND status = ?' : '') +
    ' ORDER BY created_at DESC LIMIT ?';

  const bindings: unknown[] = [user.id, user.id];
  if (status) bindings.push(status);
  bindings.push(limit);

  const { results } = await c.env.DB.prepare(base).bind(...bindings).all<RideRow>();
  return c.json({ rides: results.map(mapRideRow) });
});

/**
 * Open ride requests a driver could bid on.
 *
 * Not yet a push channel: this is the pull-based version of "nearby requests".
 * When presence moves into a Durable Object, drivers should receive these from
 * a queue instead of polling.
 *
 * Declared before `/:rideId` so "available" is not swallowed as a ride id.
 */
rideRoutes.get('/available', requireRole('driver'), async (c) => {
  const user = c.get('user');
  const limit = Math.min(Number(c.req.query('limit') ?? 25) || 25, 100);

  const driver = await c.env.DB.prepare(
    'SELECT current_lat, current_lng FROM drivers WHERE user_id = ?',
  )
    .bind(user.id)
    .first<{ current_lat: number | null; current_lng: number | null }>();

  // Without a known position we still show requests; the map distance is simply
  // absent. Filtering by radius here would hide everything for a stale fix.
  const hasLocation = driver?.current_lat != null && driver?.current_lng != null;
  const box = hasLocation
    ? boundingBox({ lat: driver.current_lat as number, lng: driver.current_lng as number }, 5000)
    : null;

  const sql =
    "SELECT * FROM rides WHERE status IN ('requested','negotiating') AND passenger_id != ?" +
    (box ? ' AND pickup_lat BETWEEN ? AND ? AND pickup_lng BETWEEN ? AND ?' : '') +
    ' ORDER BY created_at DESC LIMIT ?';

  const bindings: unknown[] = [user.id];
  if (box) bindings.push(box.minLat, box.maxLat, box.minLng, box.maxLng);
  bindings.push(limit);

  const { results } = await c.env.DB.prepare(sql).bind(...bindings).all<RideRow>();
  return c.json({ rides: results.map(mapRideRow) });
});

rideRoutes.get('/:rideId', async (c) => {
  const user = c.get('user');
  const ride = await findRide(c.env.DB, c.req.param('rideId'));
  if (!ride) throw notFound('Ride not found.');
  if (!isRideParticipant(ride, user)) throw forbidden('You are not part of this ride.');
  return c.json({ ride, offers: await findOffers(c.env.DB, ride.id) });
});

/**
 * Live snapshot straight out of the Durable Object (RPC, not HTTP). The room
 * holds the freshest view; D1 lags by whatever is in flight.
 */
rideRoutes.get('/:rideId/live', async (c) => {
  const user = c.get('user');
  const rideId = c.req.param('rideId');
  const ride = await findRide(c.env.DB, rideId);
  if (!ride) throw notFound('Ride not found.');
  if (!isRideParticipant(ride, user)) throw forbidden('You are not part of this ride.');

  const snapshot = await c.env.RIDE_ROOM.getByName(rideId).snapshot();
  return c.json(snapshot ?? { ride, offers: await findOffers(c.env.DB, rideId) });
});

/**
 * WebSocket upgrade. The Worker authenticates, then forwards to the ride's
 * Durable Object, which owns the connection for its whole life.
 */
rideRoutes.get('/:rideId/ws', async (c) => {
  const user = c.get('user');
  const rideId = c.req.param('rideId');

  const ride = await findRide(c.env.DB, rideId);
  if (!ride) throw notFound('Ride not found.');
  if (!isRideParticipant(ride, user)) throw forbidden('You are not part of this ride.');

  const headers = new Headers(c.req.raw.headers);
  headers.set('X-User-Id', user.id);
  headers.set('X-User-Role', user.role);

  const stub = c.env.RIDE_ROOM.getByName(rideId);
  return stub.fetch(new Request(c.req.raw.url, { method: 'GET', headers }));
});

/** Rate the other party once the ride is complete. */
rideRoutes.post('/:rideId/rate', async (c) => {
  const user = c.get('user');
  const body = await readJson(c, rateRideSchema);

  const ride = await findRide(c.env.DB, c.req.param('rideId'));
  if (!ride) throw notFound('Ride not found.');
  if (ride.status !== 'completed') throw conflict('You can only rate a completed ride.');

  const counterparty = user.id === ride.passengerId ? ride.driverId : ride.passengerId;
  if (!counterparty || counterparty === user.id) throw conflict('This ride has no counterparty to rate.');

  const now = nowIso();
  const inserted = await c.env.DB.prepare(
    'INSERT OR IGNORE INTO ratings (id, ride_id, from_user_id, to_user_id, score, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(newId('rate'), ride.id, user.id, counterparty, body.score, body.comment ?? null, now)
    .run();

  if ((inserted.meta.changes ?? 0) === 0) throw conflict('You already rated this ride.');

  // Recompute the rolling average from source rather than incrementally, so it
  // cannot drift. Cheap at this scale; move to a materialised column later.
  await c.env.DB.prepare(
    'UPDATE users SET rating = (SELECT ROUND(AVG(score), 2) FROM ratings WHERE to_user_id = ?), updated_at = ? WHERE id = ?',
  )
    .bind(counterparty, now, counterparty)
    .run();

  return c.json({ ok: true }, 201);
});
