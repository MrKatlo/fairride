import { Hono } from 'hono';
import { z } from 'zod';

import { mapRideRow, nowIso, type RideRow } from '../db.ts';
import { ApiError, type AppEnv, readJson, requireAuth, requireRole } from '../http.ts';

/**
 * Admin console API. Every route is gated on the persisted `admin` role.
 *
 * Deliberately read-mostly: an operator needs to see what is happening and
 * approve drivers, not to impersonate users. Anything destructive belongs in a
 * separate, audited surface.
 */
export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('*', requireAuth, requireRole('admin'));

adminRoutes.get('/metrics', async (c) => {
  const byStatus = await c.env.DB.prepare('SELECT status, COUNT(*) AS count FROM rides GROUP BY status').all<{
    status: string;
    count: number;
  }>();
  const driverCounts = await c.env.DB.prepare(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) AS online, SUM(CASE WHEN approval_status = 'pending' THEN 1 ELSE 0 END) AS pending FROM drivers",
  ).first<{ total: number; online: number | null; pending: number | null }>();
  const revenue = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(final_price), 0) AS gross FROM rides WHERE status = 'completed'",
  ).first<{ gross: number }>();

  const ridesByStatus: Record<string, number> = {};
  for (const row of byStatus.results) ridesByStatus[row.status] = row.count;

  return c.json({
    ridesByStatus,
    drivers: {
      total: driverCounts?.total ?? 0,
      online: driverCounts?.online ?? 0,
      pendingApproval: driverCounts?.pending ?? 0,
    },
    grossCompletedValue: revenue?.gross ?? 0,
  });
});

adminRoutes.get('/rides', async (c) => {
  const status = c.req.query('status');
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);

  const sql =
    'SELECT * FROM rides' + (status ? ' WHERE status = ?' : '') + ' ORDER BY created_at DESC LIMIT ?';
  const bindings: unknown[] = status ? [status, limit] : [limit];

  const { results } = await c.env.DB.prepare(sql).bind(...bindings).all<RideRow>();
  return c.json({ rides: results.map(mapRideRow) });
});

adminRoutes.get('/drivers', async (c) => {
  const approval = c.req.query('approval');
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);

  const sql =
    `SELECT d.user_id, d.vehicle_make, d.vehicle_model, d.vehicle_plate, d.approval_status,
            d.is_online, d.total_earnings, u.full_name, u.phone, u.rating, u.created_at
       FROM drivers d JOIN users u ON u.id = d.user_id` +
    (approval ? ' WHERE d.approval_status = ?' : '') +
    ' ORDER BY u.created_at DESC LIMIT ?';
  const bindings: unknown[] = approval ? [approval, limit] : [limit];

  const { results } = await c.env.DB.prepare(sql).bind(...bindings).all();
  return c.json({ drivers: results });
});

const approvalSchema = z.object({ approvalStatus: z.enum(['pending', 'approved', 'rejected']) });

adminRoutes.post('/drivers/:userId/approval', async (c) => {
  const { approvalStatus } = await readJson(c, approvalSchema);
  const userId = c.req.param('userId');

  const updated = await c.env.DB.prepare('UPDATE drivers SET approval_status = ? WHERE user_id = ?')
    .bind(approvalStatus, userId)
    .run();

  if ((updated.meta.changes ?? 0) === 0) throw new ApiError(404, 'Driver not found.');

  // Going offline when a driver is rejected avoids leaving them discoverable.
  if (approvalStatus !== 'approved') {
    await c.env.DB.prepare('UPDATE drivers SET is_online = 0 WHERE user_id = ?').bind(userId).run();
  }

  return c.json({ ok: true, approvalStatus, at: nowIso() });
});
