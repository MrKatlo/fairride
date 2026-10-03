import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { seedRide, seedUser, tokenFor } from './helpers.ts';

/**
 * These exercise the Worker as a whole - middleware, routing and error mapping -
 * rather than the Durable Object. The room's behaviour is covered in
 * `negotiation.test.ts`.
 */

const BASE = 'https://fairride.test';

/**
 * Routes a request through the worker's default export. `SELF` is the service
 * binding to the `main` worker, which type-checks as a plain `Fetcher`; the
 * newer `exports.default.fetch` needs a generated `mainModule` declaration we
 * do not have yet.
 */
function call(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(new Request(`${BASE}${path}`, init));
}

function authed(token: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } };
}

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+1666000${String(phoneCounter).padStart(4, '0')}`;
}

describe('HTTP routes', () => {
  it('reports health without authentication', async () => {
    const response = await call('/health');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('requires a bearer token for ride routes', async () => {
    const response = await call('/v1/rides');
    expect(response.status).toBe(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const passengerId = await seedUser('passenger', nextPhone());
    const forged = `${(await tokenFor(passengerId, 'passenger')).split('.').slice(0, 2).join('.')}.deadbeef`;
    const response = await call('/v1/rides', authed(forged));
    expect(response.status).toBe(401);
  });

  it('lists open requests for a driver and hides them from passengers', async () => {
    const passengerId = await seedUser('passenger', nextPhone());
    await seedRide(passengerId, 15);
    const driverId = await seedUser('driver', nextPhone());
    const driverToken = await tokenFor(driverId, 'driver');

    const asDriver = await call('/v1/rides/available', authed(driverToken));
    expect(asDriver.status).toBe(200);
    const { rides } = (await asDriver.json()) as { rides: Array<{ status: string }> };
    expect(rides.length).toBeGreaterThan(0);
    expect(rides.every((ride) => ride.status === 'requested' || ride.status === 'negotiating')).toBe(true);

    const passengerToken = await tokenFor(passengerId, 'passenger');
    const asPassenger = await call('/v1/rides/available', authed(passengerToken));
    expect(asPassenger.status).toBe(403);
  });

  it('gates the admin console behind the admin role', async () => {
    const passengerId = await seedUser('passenger', nextPhone());
    const passengerToken = await tokenFor(passengerId, 'passenger');
    const forbidden = await call('/v1/admin/metrics', authed(passengerToken));
    expect(forbidden.status).toBe(403);

    const adminId = await seedUser('admin', nextPhone());
    const adminToken = await tokenFor(adminId, 'admin');
    const allowed = await call('/v1/admin/metrics', authed(adminToken));
    expect(allowed.status).toBe(200);
    const metrics = (await allowed.json()) as { drivers: { total: number } };
    expect(metrics.drivers.total).toBeGreaterThanOrEqual(0);
  });

  it('lets an admin approve a driver and refuses unknown drivers', async () => {
    const adminId = await seedUser('admin', nextPhone());
    const adminToken = await tokenFor(adminId, 'admin');
    const driverId = await seedUser('driver', nextPhone());
    await env.DB.prepare("UPDATE drivers SET approval_status = 'pending' WHERE user_id = ?").bind(driverId).run();

    const approved = await call(
      `/v1/admin/drivers/${driverId}/approval`,
      authed(adminToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalStatus: 'approved' }),
      }),
    );
    expect(approved.status).toBe(200);

    const row = await env.DB.prepare('SELECT approval_status FROM drivers WHERE user_id = ?')
      .bind(driverId)
      .first<{ approval_status: string }>();
    expect(row?.approval_status).toBe('approved');

    const missing = await call(
      '/v1/admin/drivers/usr_does_not_exist/approval',
      authed(adminToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalStatus: 'approved' }),
      }),
    );
    expect(missing.status).toBe(404);
  });

  it('returns 422 with field paths for an invalid ride request', async () => {
    const passengerId = await seedUser('passenger', nextPhone());
    const token = await tokenFor(passengerId, 'passenger');
    const response = await call(
      '/v1/rides',
      authed(token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pickup: { lat: 999, lng: 0 }, dropoff: { lat: 0, lng: 0 }, proposedPrice: -1 }),
      }),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { details: Array<{ path: string }> };
    expect(body.details.length).toBeGreaterThan(0);
  });
});
