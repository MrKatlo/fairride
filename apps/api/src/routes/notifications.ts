import { Hono } from 'hono';
import { z } from 'zod';

import { newId, nowIso } from '../db.ts';
import { type AppEnv, readJson, requireAuth } from '../http.ts';

/**
 * Device registration for push notifications.
 *
 * A token identifies a *device install*, and that install can be handed to a
 * different account (someone logs out and back in). So registration upserts on
 * the token, transferring ownership, rather than inserting another row.
 */
export const notificationRoutes = new Hono<AppEnv>();

notificationRoutes.use('*', requireAuth);

const deviceSchema = z.object({
  token: z.string().min(10).max(4096),
  platform: z.enum(['android', 'ios', 'web']),
});

notificationRoutes.post('/devices', async (c) => {
  const user = c.get('user');
  const { token, platform } = await readJson(c, deviceSchema);
  const now = nowIso();

  await c.env.DB.prepare(
    `INSERT INTO device_tokens (id, user_id, token, platform, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (token) DO UPDATE SET
       user_id = excluded.user_id,
       platform = excluded.platform,
       updated_at = excluded.updated_at`,
  )
    .bind(newId('dev'), user.id, token, platform, now, now)
    .run();

  return c.json({ ok: true }, 201);
});

notificationRoutes.delete('/devices', async (c) => {
  const user = c.get('user');
  const { token } = await readJson(c, z.object({ token: z.string().min(10).max(4096) }));

  // Scoped to the caller: one user must not be able to unregister another's device.
  await c.env.DB.prepare('DELETE FROM device_tokens WHERE token = ? AND user_id = ?')
    .bind(token, user.id)
    .run();

  return c.json({ ok: true });
});
