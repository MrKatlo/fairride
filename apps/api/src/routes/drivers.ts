import { Hono } from 'hono';
import { z } from 'zod';
import { updateDriverLocationSchema } from '@fairride/shared';

import { boundingBox, haversineMeters, nowIso } from '../db.ts';
import { ApiError, type AppEnv, conflict, forbidden, notFound, readJson, requireAuth, requireRole } from '../http.ts';

export const driverRoutes = new Hono<AppEnv>();

driverRoutes.use('*', requireAuth);

interface DriverProfileRow {
  user_id: string;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_year: number | null;
  vehicle_color: string | null;
  vehicle_plate: string | null;
  vehicle_photo_url: string | null;
  license_number: string | null;
  license_photo_url: string | null;
  insurance_photo_url: string | null;
  approval_status: 'pending' | 'approved' | 'rejected';
  is_online: number;
  current_lat: number | null;
  current_lng: number | null;
  last_location_update: string | null;
  total_earnings: number;
  commission_rate: number;
}

interface NearbyRow {
  user_id: string;
  full_name: string | null;
  rating: number;
  total_rides: number;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_color: string | null;
  vehicle_plate: string | null;
  current_lat: number | null;
  current_lng: number | null;
}

const DOCUMENT_COLUMNS: Record<string, string> = {
  license: 'license_photo_url',
  insurance: 'insurance_photo_url',
  vehicle: 'vehicle_photo_url',
};

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

async function requireDriverRow(env: AppEnv['Bindings'], userId: string): Promise<DriverProfileRow> {
  const row = await env.DB.prepare('SELECT * FROM drivers WHERE user_id = ?').bind(userId).first<DriverProfileRow>();
  if (!row) throw notFound('No driver profile found. Complete onboarding first.');
  return row;
}

function publicProfile(row: DriverProfileRow) {
  return {
    userId: row.user_id,
    vehicleMake: row.vehicle_make,
    vehicleModel: row.vehicle_model,
    vehicleYear: row.vehicle_year,
    vehicleColor: row.vehicle_color,
    vehiclePlate: row.vehicle_plate,
    vehiclePhotoUrl: row.vehicle_photo_url,
    licenseNumber: row.license_number,
    licensePhotoUrl: row.license_photo_url,
    insurancePhotoUrl: row.insurance_photo_url,
    approvalStatus: row.approval_status,
    isOnline: row.is_online === 1,
    location:
      row.current_lat !== null && row.current_lng !== null
        ? { lat: row.current_lat, lng: row.current_lng }
        : null,
    lastLocationUpdate: row.last_location_update,
    totalEarnings: row.total_earnings,
    commissionRate: row.commission_rate,
  };
}

const driverOnboardingSchema = z.object({
  vehicleMake: z.string().max(120).optional(),
  vehicleModel: z.string().max(120).optional(),
  vehicleYear: z.number().int().min(1950).max(2100).optional(),
  vehicleColor: z.string().max(60).optional(),
  vehiclePlate: z.string().max(32).optional(),
  licenseNumber: z.string().max(64).optional(),
});

/** Self-service driver profile creation, before admin approval. */
driverRoutes.post('/me', async (c) => {
  const user = c.get('user');
  const body = await readJson(c, driverOnboardingSchema);
  const existing = await c.env.DB.prepare('SELECT user_id FROM drivers WHERE user_id = ?').bind(user.id).first();
  if (existing) throw conflict('You already have a driver profile.');

  await c.env.DB.prepare(
    `INSERT INTO drivers (user_id, vehicle_make, vehicle_model, vehicle_year, vehicle_color, vehicle_plate, license_number)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      user.id,
      body.vehicleMake ?? null,
      body.vehicleModel ?? null,
      body.vehicleYear ?? null,
      body.vehicleColor ?? null,
      body.vehiclePlate ?? null,
      body.licenseNumber ?? null,
    )
    .run();

  return c.json({ profile: publicProfile(await requireDriverRow(c.env, user.id)) }, 201);
});

driverRoutes.get('/me', requireRole('driver'), async (c) => {
  const user = c.get('user');
  return c.json({ profile: publicProfile(await requireDriverRow(c.env, user.id)) });
});

/** Go online. Blocked until an admin has approved the documents. */
driverRoutes.post('/me/online', requireRole('driver'), async (c) => {
  const user = c.get('user');
  const row = await requireDriverRow(c.env, user.id);
  if (row.approval_status !== 'approved') {
    throw forbidden(`Your account is "${row.approval_status}" and cannot go online yet.`);
  }
  await c.env.DB.prepare('UPDATE drivers SET is_online = 1 WHERE user_id = ?').bind(user.id).run();
  return c.json({ isOnline: true });
});

driverRoutes.post('/me/offline', requireRole('driver'), async (c) => {
  const user = c.get('user');
  await c.env.DB.prepare('UPDATE drivers SET is_online = 0 WHERE user_id = ?').bind(user.id).run();
  return c.json({ isOnline: false });
});

/**
 * Location heartbeat while online or on a trip.
 *
 * This is the one hot write path. When you outgrow it, move presence into a
 * per-city Durable Object and only flush to D1 periodically - every 3s per
 * online driver adds up fast in rows written.
 */
driverRoutes.post('/me/location', requireRole('driver'), async (c) => {
  const user = c.get('user');
  const { lat, lng } = await readJson(c, updateDriverLocationSchema);
  const now = nowIso();

  await c.env.DB.prepare(
    'UPDATE drivers SET current_lat = ?, current_lng = ?, last_location_update = ? WHERE user_id = ?',
  )
    .bind(lat, lng, now, user.id)
    .run();

  return c.json({ ok: true, at: now });
});

/** Upload a document (or, with kind=avatar, the profile photo) to R2. */
driverRoutes.put('/me/documents/:kind', requireRole('driver'), async (c) => {
  const user = c.get('user');
  const kind = c.req.param('kind');
  const isAvatar = kind === 'avatar';
  const column = DOCUMENT_COLUMNS[kind];

  if (isAvatar) {
    // avatars live on the users table; handled by the same storage path
  } else if (!column) {
    throw new ApiError(400, `Unknown document kind "${kind}". Expected license, insurance, vehicle or avatar.`);
  }

  const contentType = c.req.header('content-type') ?? 'application/octet-stream';
  const allowed = contentType.startsWith('image/') || contentType === 'application/pdf';
  if (!allowed) throw new ApiError(415, 'Only images and PDFs are accepted.');

  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) throw new ApiError(400, 'The uploaded file was empty.');
  if (body.byteLength > MAX_UPLOAD_BYTES) throw new ApiError(413, 'Files must be 8MB or smaller.');

  const extension = contentType === 'application/pdf' ? 'pdf' : contentType.split('/')[1] ?? 'bin';
  const key = `drivers/${user.id}/${kind}-${Date.now()}.${extension}`;
  await c.env.FILES.put(key, body, { httpMetadata: { contentType } });

  if (isAvatar) {
    await c.env.DB.prepare('UPDATE users SET profile_photo_url = ?, updated_at = ? WHERE id = ?')
      .bind(key, nowIso(), user.id)
      .run();
  } else if (column) {
    await c.env.DB.prepare(`UPDATE drivers SET ${column} = ? WHERE user_id = ?`).bind(key, user.id).run();
  }

  return c.json({ key }, 201);
});

/** Nearby online drivers, for the passenger's "who can take this" view. */
driverRoutes.get('/nearby', async (c) => {
  const lat = Number(c.req.query('lat'));
  const lng = Number(c.req.query('lng'));
  const radiusMeters = Math.min(Number(c.req.query('radiusMeters') ?? 3000) || 3000, 20_000);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new ApiError(400, 'Query parameters "lat" and "lng" are required.');
  }

  const box = boundingBox({ lat, lng }, radiusMeters);
  const { results } = await c.env.DB.prepare(
    `SELECT d.user_id, d.current_lat, d.current_lng,
            d.vehicle_make, d.vehicle_model, d.vehicle_color, d.vehicle_plate,
            u.full_name, u.rating, u.total_rides
       FROM drivers d
       JOIN users u ON u.id = d.user_id
      WHERE d.is_online = 1
        AND d.approval_status = 'approved'
        AND u.is_blocked = 0
        AND d.current_lat BETWEEN ? AND ?
        AND d.current_lng BETWEEN ? AND ?`,
  )
    .bind(box.minLat, box.maxLat, box.minLng, box.maxLng)
    .all<NearbyRow>();

  // The bounding box is an index-friendly pre-filter; Haversine is the truth.
  const drivers = results
    .filter((row): row is NearbyRow & { current_lat: number; current_lng: number } =>
      row.current_lat !== null && row.current_lng !== null,
    )
    .map((row) => ({
      userId: row.user_id,
      fullName: row.full_name,
      rating: row.rating,
      totalRides: row.total_rides,
      vehicle: {
        make: row.vehicle_make,
        model: row.vehicle_model,
        color: row.vehicle_color,
        plate: row.vehicle_plate,
      },
      location: { lat: row.current_lat, lng: row.current_lng },
      distanceMeters: Math.round(haversineMeters({ lat, lng }, { lat: row.current_lat, lng: row.current_lng })),
    }))
    .filter((driver) => driver.distanceMeters <= radiusMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);

  return c.json({ drivers });
});
