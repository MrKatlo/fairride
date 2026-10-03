import { env } from 'cloudflare:workers';
import type { ServerEvent } from '@fairride/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  connectToRoom,
  lastStatus,
  seedRide,
  seedUser,
  type SocketClient,
  waitFor,
} from './helpers.ts';

/**
 * These run inside workerd against a real Durable Object and a real D1. They
 * exist to protect the two things that are hardest to reason about by reading
 * the code: the negotiation state machine and the concurrency semantics of a
 * single instance.
 */

const open: SocketClient[] = [];

afterEach(() => {
  for (const socket of open.splice(0)) socket.close();
});

function track(socket: SocketClient): SocketClient {
  open.push(socket);
  return socket;
}

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+1555000${String(phoneCounter).padStart(4, '0')}`;
}

async function roster() {
  const passengerId = await seedUser('passenger', nextPhone());
  const driverId = await seedUser('driver', nextPhone());
  const ride = await seedRide(passengerId);
  return { passengerId, driverId, ride, rideId: ride.id };
}

function errors(events: ServerEvent[]): Extract<ServerEvent, { type: 'error' }>[] {
  return events.filter((event): event is Extract<ServerEvent, { type: 'error' }> => event.type === 'error');
}

/**
 * Waits for the transition to `accepted` specifically. `lastStatus` can resolve
 * on the earlier requested -> negotiating event, so asserting on it races.
 */
function waitForAccepted(events: ServerEvent[]): Promise<Extract<ServerEvent, { type: 'ride.status_changed' }>> {
  return waitFor(
    () =>
      events.find(
        (event): event is Extract<ServerEvent, { type: 'ride.status_changed' }> =>
          event.type === 'ride.status_changed' && event.to === 'accepted',
      ),
    'accepted status',
  );
}

describe('RideRoom negotiation', () => {
  it('sends a snapshot to a participant on connect', async () => {
    const { passengerId, rideId } = await roster();
    const passenger = track(await connectToRoom(rideId, passengerId, 'passenger'));

    const snapshot = await waitFor(
      () => passenger.events.find((e) => e.type === 'ride.snapshot'),
      'initial snapshot',
    );
    if (snapshot.type !== 'ride.snapshot') throw new Error('unreachable');
    expect(snapshot.ride.id).toBe(rideId);
    expect(snapshot.ride.status).toBe('requested');
    expect(snapshot.offers).toEqual([]);
  });

  it('refuses a socket for a non-participant', async () => {
    const { rideId } = await roster();
    const stranger = await seedUser('passenger', nextPhone());
    const stub = env.RIDE_ROOM.getByName(rideId);

    const response = await stub.fetch(
      new Request('https://ride-room.internal/ws', {
        headers: { Upgrade: 'websocket', 'X-User-Id': stranger, 'X-User-Role': 'passenger' },
      }),
    );

    expect(response.status).toBe(403);
    expect(response.webSocket).toBeNull();
  });

  it('moves requested -> negotiating when a driver makes an offer, and broadcasts it', async () => {
    const { passengerId, driverId, rideId } = await roster();
    const passenger = track(await connectToRoom(rideId, passengerId, 'passenger'));
    const driver = track(await connectToRoom(rideId, driverId, 'driver'));

    await waitFor(() => passenger.events.find((e) => e.type === 'ride.snapshot'), 'snapshot');

    driver.send({ type: 'offer.create', offer: { price: 14.5, message: 'Two minutes away.' } });

    const created = await waitFor(
      () => driver.events.find((e) => e.type === 'offer.created'),
      'offer.created',
    );
    if (created.type !== 'offer.created') throw new Error('unreachable');
    expect(created.offer.price).toBe(14.5);
    expect(created.offer.fromUserId).toBe(driverId);
    expect(created.offer.status).toBe('pending');

    // The passenger sees the same offer: the room fans out, it does not poll.
    await waitFor(
      () => passenger.events.find((e) => e.type === 'offer.created'),
      'passenger sees offer',
    );

    const status = await waitFor(() => lastStatus(passenger.events), 'status change');
    if (status.type !== 'ride.status_changed') throw new Error('unreachable');
    expect(status.from).toBe('requested');
    expect(status.to).toBe('negotiating');
  });

  it('lets the passenger accept a driver offer, assigning that driver and price', async () => {
    const { passengerId, driverId, rideId } = await roster();
    const passenger = track(await connectToRoom(rideId, passengerId, 'passenger'));
    const driver = track(await connectToRoom(rideId, driverId, 'driver'));

    driver.send({ type: 'offer.create', offer: { price: 18 } });
    const created = await waitFor(
      () => driver.events.find((e) => e.type === 'offer.created'),
      'offer.created',
    );
    if (created.type !== 'offer.created') throw new Error('unreachable');

    passenger.send({ type: 'offer.accept', offerId: created.offer.id });

    const status = await waitForAccepted(passenger.events);
    expect(status.to).toBe('accepted');

    // The durable row is the source of truth; assert against D1, not just events.
    const ride = await env.DB.prepare('SELECT * FROM rides WHERE id = ?')
      .bind(rideId)
      .first<{ status: string; driver_id: string; final_price: number }>();
    expect(ride?.status).toBe('accepted');
    expect(ride?.driver_id).toBe(driverId);
    expect(ride?.final_price).toBe(18);

    const offer = await env.DB.prepare('SELECT * FROM ride_offers WHERE id = ?')
      .bind(created.offer.id)
      .first<{ status: string }>();
    expect(offer?.status).toBe('accepted');
  });

  it('lets a driver accept the passenger proposed price with no counter round', async () => {
    const { passengerId, driverId, rideId } = await roster();
    const passenger = track(await connectToRoom(rideId, passengerId, 'passenger'));
    const driver = track(await connectToRoom(rideId, driverId, 'driver'));

    passenger.send({ type: 'offer.create', offer: { price: 9 } });
    const created = await waitFor(
      () => passenger.events.find((e) => e.type === 'offer.created'),
      'passenger offer',
    );
    if (created.type !== 'offer.created') throw new Error('unreachable');

    driver.send({ type: 'offer.accept', offerId: created.offer.id });

    const status = await waitForAccepted(driver.events);
    expect(status.to).toBe('accepted');

    const ride = await env.DB.prepare('SELECT * FROM rides WHERE id = ?')
      .bind(rideId)
      .first<{ driver_id: string; final_price: number }>();
    // The accepting caller becomes the driver even though the passenger authored the offer.
    expect(ride?.driver_id).toBe(driverId);
    expect(ride?.final_price).toBe(9);
  });

  it('rejects an offer without leaving the negotiating state', async () => {
    const { passengerId, driverId, rideId } = await roster();
    const passenger = track(await connectToRoom(rideId, passengerId, 'passenger'));
    const driver = track(await connectToRoom(rideId, driverId, 'driver'));

    driver.send({ type: 'offer.create', offer: { price: 22 } });
    const created = await waitFor(
      () => driver.events.find((e) => e.type === 'offer.created'),
      'offer.created',
    );
    if (created.type !== 'offer.created') throw new Error('unreachable');

    passenger.send({ type: 'offer.reject', offerId: created.offer.id });

    const updated = await waitFor(
      () => driver.events.find((e) => e.type === 'offer.updated'),
      'offer.updated',
    );
    if (updated.type !== 'offer.updated') throw new Error('unreachable');
    expect(updated.offer.status).toBe('rejected');

    const ride = await env.DB.prepare('SELECT status FROM rides WHERE id = ?')
      .bind(rideId)
      .first<{ status: string }>();
    expect(ride?.status).toBe('negotiating');
  });

  it('supersedes the previous pending offer when a new one is made', async () => {
    const { passengerId, driverId, rideId } = await roster();
    const passenger = track(await connectToRoom(rideId, passengerId, 'passenger'));
    const driver = track(await connectToRoom(rideId, driverId, 'driver'));

    driver.send({ type: 'offer.create', offer: { price: 12 } });
    const first = await waitFor(
      () => driver.events.find((e) => e.type === 'offer.created'),
      'first offer',
    );
    if (first.type !== 'offer.created') throw new Error('unreachable');

    driver.send({ type: 'offer.create', offer: { price: 15 } });
    await waitFor(
      () => driver.events.filter((e) => e.type === 'offer.created').length === 2,
      'second offer',
    );

    const superseded = await waitFor(
      () =>
        driver.events.find(
          (e) => e.type === 'offer.updated' && e.offer.id === first.offer.id,
        ),
      'superseded event',
    );
    if (superseded.type !== 'offer.updated') throw new Error('unreachable');
    expect(superseded.offer.status).toBe('superseded');

    const rows = await env.DB.prepare(
      "SELECT id, status FROM ride_offers WHERE ride_id = ? ORDER BY created_at",
    )
      .bind(rideId)
      .all<{ id: string; status: string }>();
    expect(rows.results.map((r) => r.status)).toEqual(['superseded', 'pending']);
  });

  it('refuses to answer your own offer', async () => {
    const { passengerId, driverId, rideId } = await roster();
    const driver = track(await connectToRoom(rideId, driverId, 'driver'));

    driver.send({ type: 'offer.create', offer: { price: 11 } });
    const created = await waitFor(
      () => driver.events.find((e) => e.type === 'offer.created'),
      'offer',
    );
    if (created.type !== 'offer.created') throw new Error('unreachable');

    driver.send({ type: 'offer.accept', offerId: created.offer.id });

    const error = await waitFor(() => errors(driver.events)[0], 'forbidden error');
    expect(error.code).toBe('forbidden');

    // A rejected intent must not mutate the ride.
    const ride = await env.DB.prepare('SELECT status FROM rides WHERE id = ?')
      .bind(rideId)
      .first<{ status: string }>();
    expect(ride?.status).toBe('negotiating');
  });

  it('reports stale_state for an illegal transition from a terminal ride', async () => {
    const { passengerId, driverId, rideId } = await roster();
    const passenger = track(await connectToRoom(rideId, passengerId, 'passenger'));
    const driver = track(await connectToRoom(rideId, driverId, 'driver'));

    driver.send({ type: 'offer.create', offer: { price: 20 } });
    const created = await waitFor(
      () => driver.events.find((e) => e.type === 'offer.created'),
      'offer',
    );
    if (created.type !== 'offer.created') throw new Error('unreachable');
    passenger.send({ type: 'offer.accept', offerId: created.offer.id });
    await waitForAccepted(driver.events);

    // A passenger may not mark the ride "arrived": only the driver may.
    passenger.send({ type: 'ride.transition', to: 'arrived' });

    const error = await waitFor(() => errors(passenger.events)[0], 'stale_state error');
    expect(error.code).toBe('stale_state');
  });

  it('walks the accepted ride through arrived -> started -> completed as the driver', async () => {
    const { passengerId, driverId, rideId } = await roster();
    const passenger = track(await connectToRoom(rideId, passengerId, 'passenger'));
    const driver = track(await connectToRoom(rideId, driverId, 'driver'));

    driver.send({ type: 'offer.create', offer: { price: 30 } });
    const created = await waitFor(
      () => driver.events.find((e) => e.type === 'offer.created'),
      'offer',
    );
    if (created.type !== 'offer.created') throw new Error('unreachable');
    passenger.send({ type: 'offer.accept', offerId: created.offer.id });
    await waitForAccepted(driver.events);

    for (const to of ['arrived', 'started', 'completed'] as const) {
      const before = driver.events.length;
      driver.send({ type: 'ride.transition', to });
      await waitFor(
        () => {
          const statuses = driver.events
            .slice(before)
            .filter((e) => e.type === 'ride.status_changed');
          return statuses.find((e) => e.type === 'ride.status_changed' && e.to === to);
        },
        `transition to ${to}`,
      );
    }

    const ride = await env.DB.prepare(
      'SELECT status, completed_at FROM rides WHERE id = ?',
    )
      .bind(rideId)
      .first<{ status: string; completed_at: string | null }>();
    expect(ride?.status).toBe('completed');
    expect(ride?.completed_at).not.toBeNull();
  });

  it('only lets the assigned driver publish location', async () => {
    const { passengerId, driverId, rideId } = await roster();
    const passenger = track(await connectToRoom(rideId, passengerId, 'passenger'));
    const driver = track(await connectToRoom(rideId, driverId, 'driver'));

    driver.send({ type: 'offer.create', offer: { price: 10 } });
    const created = await waitFor(
      () => driver.events.find((e) => e.type === 'offer.created'),
      'offer',
    );
    if (created.type !== 'offer.created') throw new Error('unreachable');
    passenger.send({ type: 'offer.accept', offerId: created.offer.id });
    await waitForAccepted(driver.events);

    passenger.send({ type: 'driver.location', lat: 1, lng: 2 });
    const error = await waitFor(() => errors(passenger.events)[0], 'forbidden error');
    expect(error.code).toBe('forbidden');

    driver.send({ type: 'driver.location', lat: 6.51, lng: 3.41 });
    const location = await waitFor(
      () => passenger.events.find((e) => e.type === 'driver.location'),
      'location broadcast',
    );
    if (location.type !== 'driver.location') throw new Error('unreachable');
    expect(location.lat).toBe(6.51);
  });

  it('relays chat messages to everyone in the room', async () => {
    const { passengerId, driverId, rideId } = await roster();
    const passenger = track(await connectToRoom(rideId, passengerId, 'passenger'));
    const driver = track(await connectToRoom(rideId, driverId, 'driver'));

    driver.send({ type: 'chat.message', text: 'I am at the corner.' });

    const received = await waitFor(
      () => passenger.events.find((e) => e.type === 'chat.message'),
      'chat broadcast',
    );
    if (received.type !== 'chat.message') throw new Error('unreachable');
    expect(received.message.text).toBe('I am at the corner.');
    expect(received.message.userId).toBe(driverId);

    const row = await env.DB.prepare('SELECT text FROM chat_messages WHERE ride_id = ?')
      .bind(rideId)
      .first<{ text: string }>();
    expect(row?.text).toBe('I am at the corner.');
  });

  it('rate-limits a socket that floods intents', async () => {
    const { passengerId, rideId } = await roster();
    const passenger = track(await connectToRoom(rideId, passengerId, 'passenger'));
    await waitFor(() => passenger.events.find((e) => e.type === 'ride.snapshot'), 'snapshot');

    for (let i = 0; i < 40; i += 1) passenger.send({ type: 'ping' });

    const error = await waitFor(
      () => errors(passenger.events).find((e) => e.code === 'rate_limited'),
      'rate_limited error',
    );
    expect(error.code).toBe('rate_limited');
  });

  it('rejects a malformed frame with invalid_intent', async () => {
    const { passengerId, rideId } = await roster();
    const passenger = track(await connectToRoom(rideId, passengerId, 'passenger'));
    await waitFor(() => passenger.events.find((e) => e.type === 'ride.snapshot'), 'snapshot');

    passenger.ws.send('not json{');

    const error = await waitFor(() => errors(passenger.events)[0], 'invalid_intent error');
    expect(error.code).toBe('invalid_intent');
  });
});
