import { env } from 'cloudflare:workers';
import type { ServerEvent } from '@fairride/shared';

import { signJwt } from '../src/auth.ts';
import { newId, nowIso, type RideRow } from '../src/db.ts';

export const TEST_SECRET = 'test-secret-do-not-use-in-production';

/** Inserts a user row directly - we are testing the API, not the OTP flow. */
export async function seedUser(role: 'passenger' | 'driver' | 'admin', phone: string): Promise<string> {
  const id = newId(role === 'driver' ? 'drv' : 'usr');
  const at = nowIso();
  await env.DB.prepare(
    'INSERT INTO users (id, phone, role, rating, total_rides, created_at, updated_at) VALUES (?, ?, ?, 5.0, 0, ?, ?)',
  )
    .bind(id, phone, role, at, at)
    .run();

  if (role === 'driver') {
    await env.DB.prepare(
      "INSERT INTO drivers (user_id, approval_status, is_online) VALUES (?, 'approved', 1)",
    )
      .bind(id)
      .run();
  }
  return id;
}

export async function tokenFor(
  id: string,
  role: 'passenger' | 'driver' | 'admin',
  phone = '+10000000000',
): Promise<string> {
  return signJwt({ id, role, phone }, TEST_SECRET);
}

export async function seedRide(passengerId: string, proposedPrice = 10): Promise<RideRow> {
  const id = newId('ride');
  const at = nowIso();
  await env.DB.prepare(
    `INSERT INTO rides (
       id, passenger_id, status, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
       passenger_proposed_price, currency, created_at
     ) VALUES (?, ?, 'requested', 6.5, 3.4, 6.6, 3.5, ?, 'USD', ?)`,
  )
    .bind(id, passengerId, proposedPrice, at)
    .run();

  const row = await env.DB.prepare('SELECT * FROM rides WHERE id = ?').bind(id).first<RideRow>();
  if (!row) throw new Error('seedRide failed');
  return row;
}

export interface SocketClient {
  ws: WebSocket;
  events: ServerEvent[];
  send(intent: unknown): void;
  close(): void;
}

/**
 * Opens a ride-room socket straight against the Durable Object, bypassing the
 * HTTP upgrade route so negotiation tests stay focused on the protocol.
 */
export async function connectToRoom(
  rideId: string,
  userId: string,
  role: 'passenger' | 'driver' | 'admin',
): Promise<SocketClient> {
  const stub = env.RIDE_ROOM.getByName(rideId);
  const response = await stub.fetch(
    new Request('https://ride-room.internal/ws', {
      headers: { Upgrade: 'websocket', 'X-User-Id': userId, 'X-User-Role': role },
    }),
  );

  const ws = response.webSocket;
  if (!ws) throw new Error(`Upgrade failed with status ${response.status}`);
  ws.accept();

  const events: ServerEvent[] = [];
  ws.addEventListener('message', (event: MessageEvent) => {
    try {
      events.push(JSON.parse(String(event.data)) as ServerEvent);
    } catch {
      // A non-JSON frame is not part of the protocol; ignore it.
    }
  });

  return {
    ws,
    events,
    send: (intent: unknown) => ws.send(JSON.stringify(intent)),
    close: () => ws.close(1000, 'test complete'),
  };
}

/** Polls until `predicate` returns something other than undefined. */
export async function waitFor<T>(
  predicate: () => T | undefined,
  description: string,
  timeoutMs = 5_000,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = predicate();
    if (value !== undefined) return value;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function lastStatus(events: ServerEvent[]): ServerEvent | undefined {
  return [...events].reverse().find((event) => event.type === 'ride.status_changed');
}
