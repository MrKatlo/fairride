import type { Ride, RideStatus } from '@fairride/shared';

import type { Env } from './env.ts';
import { type PushMessage, sendPush } from './firebase/fcm.ts';

/**
 * Push delivery that knows about the database.
 *
 * `sendPush` handles tokens and FCM; this layer resolves users to devices and
 * prunes tokens FCM reported as permanently dead, so the table stays clean
 * without a cron job.
 */
export async function notifyUsers(env: Env, userIds: readonly string[], message: PushMessage): Promise<void> {
  const unique = [...new Set(userIds)].filter((id) => id.length > 0);
  if (unique.length === 0) return;

  const placeholders = unique.map(() => '?').join(', ');
  const { results } = await env.DB.prepare(`SELECT token FROM device_tokens WHERE user_id IN (${placeholders})`)
    .bind(...unique)
    .all<{ token: string }>();
  if (results.length === 0) return;

  const invalid = await sendPush(
    env.FIREBASE_SERVICE_ACCOUNT,
    results.map((row) => row.token),
    message,
  );

  if (invalid.length > 0) {
    const tokens = invalid.map(() => '?').join(', ');
    await env.DB.prepare(`DELETE FROM device_tokens WHERE token IN (${tokens})`).bind(...invalid).run();
  }
}

/** Human copy for a status change, or `null` when the change is not noteworthy. */
export function statusPush(ride: Ride, to: RideStatus, actorRole: string): { userIds: string[]; message: PushMessage } | null {
  // The acting party already knows what they did; notify the counterparty.
  const passenger = ride.passengerId;
  const driver = ride.driverId;

  switch (to) {
    case 'negotiating':
      return null; // A bid is shown live in the app; no push needed.
    case 'accepted':
      return {
        userIds: [passenger, driver].filter((id): id is string => Boolean(id)),
        message: {
          title: 'Ride confirmed',
          body: 'A price was agreed. Your driver is on the way.',
          data: { rideId: ride.id, status: to },
        },
      };
    case 'arrived':
      return actorRole === 'driver' && passenger
        ? {
            userIds: [passenger],
            message: { title: 'Your driver has arrived', body: 'Meet your driver at the pickup point.', data: { rideId: ride.id, status: to } },
          }
        : null;
    case 'started':
      return actorRole === 'driver' && passenger
        ? { userIds: [passenger], message: { title: 'Trip started', body: 'Heading to your destination.', data: { rideId: ride.id, status: to } } }
        : null;
    case 'completed':
      return actorRole === 'driver' && passenger
        ? { userIds: [passenger], message: { title: 'Trip complete', body: 'Thanks for riding. Rate your driver?', data: { rideId: ride.id, status: to } } }
        : null;
    case 'cancelled':
      return {
        userIds: [passenger, driver].filter((id): id is string => Boolean(id)),
        message: { title: 'Ride cancelled', body: ride.cancellationReason ?? 'This ride was cancelled.', data: { rideId: ride.id, status: to } },
      };
    case 'requested':
      return null;
    default:
      return null;
  }
}
