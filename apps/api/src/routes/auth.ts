import { Hono } from 'hono';
import { z } from 'zod';

import { sha256Hex, signJwt, timingSafeEqual, type AuthUser } from '../auth.ts';
import { newId, nowIso, type UserRow } from '../db.ts';
import { parseServiceAccount } from '../firebase/fcm.ts';
import { verifyFirebaseIdToken } from '../firebase/id-token.ts';
import { ApiError, type AppEnv, readJson } from '../http.ts';

/**
 * Phone-OTP authentication.
 *
 * Flow:
 *   1. POST /v1/auth/otp/request { phone }  -> a 6-digit code is created
 *   2. POST /v1/auth/otp/verify  { phone, code } -> { token, user }
 *
 * Codes are stored as a salted SHA-256 hash and never logged. In development the
 * code is echoed back in the response so you can test without an SMS provider;
 * wire a real provider (Twilio, Cloudflare Email, etc.) into `deliverCode`.
 */

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

const phoneSchema = z
  .string()
  .trim()
  .min(7)
  .max(20)
  .regex(/^\+?[0-9\s-]+$/, 'Phone must contain only digits, spaces, dashes and an optional +.');

const otpRequestSchema = z.object({ phone: phoneSchema });
const otpVerifySchema = z.object({ phone: phoneSchema, code: z.string().regex(/^\d{6}$/) });
const devTokenSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(['passenger', 'driver', 'admin']).default('passenger'),
  phone: z.string().min(7).default('+10000000000'),
});

function generateCode(): string {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return String((buffer[0] ?? 0) % 1_000_000).padStart(6, '0');
}

/**
 * Stand-in SMS delivery. Replace the body with a real provider call; keep the
 * signature so the caller does not change.
 */
async function deliverCode(phone: string, code: string, env: AppEnv['Bindings']): Promise<void> {
  if (env.ENVIRONMENT === 'development') {
    console.log(`[otp] ${phone} -> ${code}`);
    return;
  }
  // TODO: send via Twilio / Vonage / your local aggregator.
  throw new ApiError(503, 'SMS delivery is not configured.');
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/otp/request', async (c) => {
  const { phone } = await readJson(c, otpRequestSchema);
  const now = nowIso();
  const code = generateCode();
  // The secret salts the hash, so a D1 leak alone does not reveal live codes.
  const codeHash = await sha256Hex(`${phone}:${code}:${c.env.JWT_SECRET}`);

  await c.env.DB.prepare(
    'INSERT INTO otp_codes (id, phone, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(newId('otp'), phone, codeHash, new Date(Date.now() + OTP_TTL_MS).toISOString(), now)
    .run();

  await deliverCode(phone, code, c.env);

  return c.json({
    delivered: true,
    expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
    // Development convenience only - never returned in production.
    ...(c.env.ENVIRONMENT === 'development' ? { devCode: code } : {}),
  });
});

authRoutes.post('/otp/verify', async (c) => {
  const { phone, code } = await readJson(c, otpVerifySchema);

  const row = await c.env.DB.prepare(
    'SELECT * FROM otp_codes WHERE phone = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1',
  )
    .bind(phone)
    .first<{ id: string; code_hash: string; attempts: number; expires_at: string }>();

  if (!row) throw new ApiError(400, 'No active code for that number. Request a new one.');
  if (row.attempts >= MAX_OTP_ATTEMPTS) throw new ApiError(429, 'Too many attempts. Request a new code.');
  if (row.expires_at <= nowIso()) throw new ApiError(400, 'That code has expired. Request a new one.');

  const candidate = await sha256Hex(`${phone}:${code}:${c.env.JWT_SECRET}`);
  if (!timingSafeEqual(candidate, row.code_hash)) {
    await c.env.DB.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run();
    throw new ApiError(400, 'Incorrect code.');
  }

  await c.env.DB.prepare('UPDATE otp_codes SET consumed_at = ? WHERE id = ?').bind(nowIso(), row.id).run();

  // First successful verification creates the account. Role upgrades (driver,
  // admin) happen through the approval flow, not by asserting a role here.
  let user = await c.env.DB.prepare('SELECT * FROM users WHERE phone = ?').bind(phone).first<UserRow>();
  if (!user) {
    const id = newId('usr');
    const at = nowIso();
    await c.env.DB.prepare(
      "INSERT INTO users (id, phone, role, rating, total_rides, created_at, updated_at) VALUES (?, ?, 'passenger', 5.0, 0, ?, ?)",
    )
      .bind(id, phone, at, at)
      .run();
    user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
  }

  if (!user) throw new ApiError(500, 'Could not load your account.');
  if (user.is_blocked === 1) throw new ApiError(403, 'This account has been blocked.');

  const authUser: AuthUser = { id: user.id, role: user.role, phone: user.phone };
  const token = await signJwt(authUser, c.env.JWT_SECRET);

  return c.json({ token, user: publicUser(user) });
});

const firebaseSignInSchema = z.object({ idToken: z.string().min(20) });


/**
 * Exchanges a Firebase ID token for our own session JWT.
 *
 * The ID token is verified against Google's published keys, and the account is
 * created or linked by Firebase UID. The phone number comes from the *verified*
 * token, never from the request body, so a client cannot claim someone else's
 * number. A pre-existing row with the same phone (from the OTP era) is adopted
 * rather than duplicated.
 */
authRoutes.post('/firebase', async (c) => {
  const { idToken } = await readJson(c, firebaseSignInSchema);

  const projectId =
    c.env.FIREBASE_PROJECT_ID ?? parseServiceAccount(c.env.FIREBASE_SERVICE_ACCOUNT ?? '')?.projectId ?? null;
  if (!projectId) throw new ApiError(503, 'Firebase authentication is not configured on this deployment.');

  const identity = await verifyFirebaseIdToken(idToken, projectId);
  if (!identity) throw new ApiError(401, 'That Firebase token is invalid or has expired.');
  if (!identity.phone) throw new ApiError(400, 'That account has no verified phone number.');

  const now = nowIso();

  let user = await c.env.DB.prepare('SELECT * FROM users WHERE firebase_uid = ?')
    .bind(identity.uid)
    .first<UserRow>();

  if (!user) {
    user = await c.env.DB.prepare('SELECT * FROM users WHERE phone = ?').bind(identity.phone).first<UserRow>();
  }

  if (user) {
    if (user.is_blocked === 1) throw new ApiError(403, 'This account has been blocked.');
    await c.env.DB.prepare(
      'UPDATE users SET firebase_uid = ?, full_name = COALESCE(full_name, ?), updated_at = ? WHERE id = ?',
    )
      .bind(identity.uid, identity.name, now, user.id)
      .run();
  } else {
    const id = newId('usr');
    await c.env.DB.prepare(
      "INSERT INTO users (id, phone, firebase_uid, role, full_name, rating, total_rides, created_at, updated_at) VALUES (?, ?, ?, 'passenger', ?, 5.0, 0, ?, ?)",
    )
      .bind(id, identity.phone, identity.uid, identity.name, now, now)
      .run();
  }

  const stored = await c.env.DB.prepare('SELECT * FROM users WHERE firebase_uid = ?')
    .bind(identity.uid)
    .first<UserRow>();
  if (!stored) throw new ApiError(500, 'Could not load your account.');
  if (stored.is_blocked === 1) throw new ApiError(403, 'This account has been blocked.');

  const authUser: AuthUser = { id: stored.id, role: stored.role, phone: stored.phone };
  const token = await signJwt(authUser, c.env.JWT_SECRET);

  return c.json({ token, user: publicUser(stored) });
});

/**
 * Development-only token minting, so you can exercise the API from curl or the
 * admin panel before SMS is wired up. Fails closed outside development.
 */
authRoutes.post('/dev/token', async (c) => {
  if (c.env.ENVIRONMENT !== 'development') throw new ApiError(404, 'Not found.');
  const body = await readJson(c, devTokenSchema);
  const token = await signJwt({ id: body.userId, role: body.role, phone: body.phone }, c.env.JWT_SECRET);
  return c.json({ token });
});

function publicUser(row: UserRow) {
  return {
    id: row.id,
    phone: row.phone,
    email: row.email,
    role: row.role,
    fullName: row.full_name,
    profilePhotoUrl: row.profile_photo_url,
    rating: row.rating,
    totalRides: row.total_rides,
    isBlocked: row.is_blocked === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
