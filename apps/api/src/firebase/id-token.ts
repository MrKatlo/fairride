import { base64UrlToBytes, decodeJsonSegment, textEncoder } from '../encoding.ts';

/**
 * Firebase ID token verification, dependency-free.
 *
 * Firebase issues RS256 JWTs signed by a key set published by Google. We verify
 * the signature with `crypto.subtle` and check `iss`/`aud`/`exp`/`iat`
 * ourselves, which is what the Firebase Admin SDK does - minus a Node-only
 * dependency tree that does not belong in a Worker's request path.
 *
 * The key set is cached in module scope until Google's `Cache-Control: max-age`
 * elapses. Workers isolates are short-lived, so this cache is a latency win, not
 * a correctness mechanism.
 */

const DEFAULT_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

/** Tolerance for a client clock that is slightly ahead of ours. */
const CLOCK_SKEW_SECONDS = 60;

export interface FirebaseIdentity {
  uid: string;
  phone: string | null;
  email: string | null;
  name: string | null;
  picture: string | null;
  /** e.g. `phone`, `google.com`, `password`. */
  signInProvider: string | null;
}

interface GoogleJwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

interface IdTokenClaims {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  exp?: unknown;
  iat?: unknown;
  phone_number?: unknown;
  email?: unknown;
  name?: unknown;
  picture?: unknown;
  firebase?: { sign_in_provider?: unknown };
}

let keyCache: { keys: Map<string, CryptoKey>; expiresAt: number } | null = null;

function cacheSeconds(cacheControl: string | null): number {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl ?? '');
  const seconds = match ? Number(match[1]) : 0;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 3600;
}

async function loadSigningKeys(jwksUrl: string): Promise<Map<string, CryptoKey>> {
  const now = Date.now();
  if (keyCache && keyCache.expiresAt > now) return keyCache.keys;

  const response = await fetch(jwksUrl, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`JWKS fetch failed with status ${response.status}`);

  const body = (await response.json()) as { keys?: GoogleJwk[] };
  const keys = new Map<string, CryptoKey>();

  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    keys.set(jwk.kid, key);
  }

  keyCache = { keys, expiresAt: now + cacheSeconds(response.headers.get('cache-control')) * 1000 };
  return keys;
}

/**
 * Returns the verified identity, or `null` for anything invalid - a bad
 * signature, a token minted for another project, an expired token. Callers
 * should treat `null` as 401 and never distinguish the reasons to the client.
 */
export async function verifyFirebaseIdToken(
  idToken: string,
  projectId: string,
  options: { jwksUrl?: string; nowMs?: number } = {},
): Promise<FirebaseIdentity | null> {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  let header: { alg?: unknown; kid?: unknown };
  let claims: IdTokenClaims;
  try {
    header = decodeJsonSegment<{ alg?: unknown; kid?: unknown }>(headerSegment);
    claims = decodeJsonSegment<IdTokenClaims>(payloadSegment);
  } catch {
    return null;
  }

  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length === 0) return null;

  let keys: Map<string, CryptoKey>;
  try {
    keys = await loadSigningKeys(options.jwksUrl ?? DEFAULT_JWKS_URL);
  } catch {
    // Never fail open: an unreachable key set means we cannot trust the token.
    return null;
  }

  const key = keys.get(header.kid);
  if (!key) return null;

  let signatureValid: boolean;
  try {
    signatureValid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      base64UrlToBytes(signatureSegment),
      textEncoder.encode(`${headerSegment}.${payloadSegment}`),
    );
  } catch {
    return null;
  }
  if (!signatureValid) return null;

  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) return null;
  if (claims.aud !== projectId) return null;
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) return null;
  if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) return null;
  if (typeof claims.iat !== 'number' || claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) return null;

  return {
    uid: claims.sub,
    phone: typeof claims.phone_number === 'string' ? claims.phone_number : null,
    email: typeof claims.email === 'string' ? claims.email : null,
    name: typeof claims.name === 'string' ? claims.name : null,
    picture: typeof claims.picture === 'string' ? claims.picture : null,
    signInProvider:
      typeof claims.firebase?.sign_in_provider === 'string' ? claims.firebase.sign_in_provider : null,
  };
}

/** Test seam: drops the cached signing keys so a fresh JWKS is fetched. */
export function resetSigningKeyCache(): void {
  keyCache = null;
}

/** Exposed so tests can sign tokens against a key set they control. */
export const FIREBASE_JWKS_URL = DEFAULT_JWKS_URL;
