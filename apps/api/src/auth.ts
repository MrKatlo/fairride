import type { Role } from '@fairride/shared';

import { base64UrlToBytes, bytesToBase64Url, textDecoder, textEncoder } from './encoding.ts';

/**
 * Minimal, dependency-free HS256 JWT auth built on WebCrypto.
 *
 * Why not a library: Workers ship `crypto.subtle`, JWT signing is ~60 lines, and
 * a solo developer should not have an unaudited auth dependency in the request
 * path. Swap in a managed provider (Clerk, Supabase Auth) later without touching
 * call sites - everything funnels through `authenticate()`.
 *
 * These are *access* tokens only. Refresh tokens, rotation and revocation are
 * deliberately out of scope for the scaffold; see README "Known gaps".
 */

export interface AuthUser {
  id: string;
  role: Role;
  phone: string;
}

interface JwtClaims {
  sub: string;
  role: Role;
  phone: string;
  iat: number;
  exp: number;
}

const encoder = textEncoder;
const decoder = textDecoder;

const VALID_ROLES: readonly string[] = ['passenger', 'driver', 'admin'];

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signJwt(
  user: AuthUser,
  secret: string,
  ttlSeconds = 60 * 60 * 12,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = bytesToBase64Url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const claims: JwtClaims = {
    sub: user.id,
    role: user.role,
    phone: user.phone,
    iat: now,
    exp: now + ttlSeconds,
  };
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/** Returns the caller identity, or `null` for any invalid/expired/forged token. */
export async function verifyJwt(token: string, secret: string): Promise<AuthUser | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];

  let valid: boolean;
  try {
    const key = await importHmacKey(secret);
    valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlToBytes(signature),
      encoder.encode(`${header}.${payload}`),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  let claims: Partial<JwtClaims>;
  try {
    claims = JSON.parse(decoder.decode(base64UrlToBytes(payload))) as Partial<JwtClaims>;
  } catch {
    return null;
  }

  if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
  if (claims.exp * 1000 <= Date.now()) return null;
  if (typeof claims.role !== 'string' || !VALID_ROLES.includes(claims.role)) return null;

  return {
    id: claims.sub,
    role: claims.role as Role,
    phone: typeof claims.phone === 'string' ? claims.phone : '',
  };
}

/** Extracts a bearer token from an `Authorization` header, if present. */
export function bearerToken(header: string | undefined | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Constant-time string comparison.
 * Comparing OTP hashes with `===` leaks timing information.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** SHA-256 hex digest, used to store OTP codes without keeping the plaintext. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
