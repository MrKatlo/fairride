import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bytesToBase64Url, textEncoder } from '../src/encoding.ts';
import { resetSigningKeyCache, verifyFirebaseIdToken } from '../src/firebase/id-token.ts';

/**
 * We sign real RS256 tokens against a key pair we control and serve the matching
 * JWKS at a fake URL, so the verification path (signature, issuer, audience,
 * expiry) is exercised for real rather than mocked out.
 */

const PROJECT_ID = 'fairride-test';
const KID = 'test-key-1';
const JWKS_URL = 'https://example.test/jwks';

interface KeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  jwk: JsonWebKey & { kid: string; alg: string; use: string };
}

async function makeKeyPair(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey & {
    kid: string;
    alg: string;
    use: string;
  };
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  return { privateKey: pair.privateKey, publicKey: pair.publicKey, jwk };
}

async function signToken(
  pair: KeyPair,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', kid: KID, typ: 'JWT' },
): Promise<string> {
  const encodedHeader = bytesToBase64Url(textEncoder.encode(JSON.stringify(header)));
  const encodedPayload = bytesToBase64Url(textEncoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    pair.privateKey,
    textEncoder.encode(`${encodedHeader}.${encodedPayload}`),
  );
  return `${encodedHeader}.${encodedPayload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: 'firebase-uid-1',
    iat: now - 10,
    exp: now + 3600,
    phone_number: '+15551234567',
    firebase: { sign_in_provider: 'phone' },
    ...overrides,
  };
}

function serveJwks(keys: unknown[], cacheControl = 'max-age=3600'): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () =>
    new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': cacheControl },
    }),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

let pair: KeyPair;

beforeEach(async () => {
  resetSigningKeyCache();
  pair = await makeKeyPair();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSigningKeyCache();
});

describe('verifyFirebaseIdToken', () => {
  it('accepts a well-formed token and returns the identity', async () => {
    serveJwks([pair.jwk]);
    const token = await signToken(pair, baseClaims());

    const identity = await verifyFirebaseIdToken(token, PROJECT_ID, { jwksUrl: JWKS_URL });

    expect(identity).not.toBeNull();
    expect(identity?.uid).toBe('firebase-uid-1');
    expect(identity?.phone).toBe('+15551234567');
    expect(identity?.signInProvider).toBe('phone');
  });

  it('rejects a token signed by a different key', async () => {
    serveJwks([pair.jwk]);
    const attacker = await makeKeyPair();
    const token = await signToken(attacker, baseClaims());

    expect(await verifyFirebaseIdToken(token, PROJECT_ID, { jwksUrl: JWKS_URL })).toBeNull();
  });

  it('rejects a token for another audience', async () => {
    serveJwks([pair.jwk]);
    const token = await signToken(pair, baseClaims({ aud: 'some-other-project' }));

    expect(await verifyFirebaseIdToken(token, PROJECT_ID, { jwksUrl: JWKS_URL })).toBeNull();
  });

  it('rejects a token from another issuer', async () => {
    serveJwks([pair.jwk]);
    const token = await signToken(pair, baseClaims({ iss: 'https://evil.test' }));

    expect(await verifyFirebaseIdToken(token, PROJECT_ID, { jwksUrl: JWKS_URL })).toBeNull();
  });

  it('rejects an expired token', async () => {
    serveJwks([pair.jwk]);
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(pair, baseClaims({ iat: now - 7200, exp: now - 60 }));

    expect(await verifyFirebaseIdToken(token, PROJECT_ID, { jwksUrl: JWKS_URL })).toBeNull();
  });

  it('rejects an unknown key id', async () => {
    serveJwks([pair.jwk]);
    const token = await signToken(pair, baseClaims(), { alg: 'RS256', kid: 'rotated-away', typ: 'JWT' });

    expect(await verifyFirebaseIdToken(token, PROJECT_ID, { jwksUrl: JWKS_URL })).toBeNull();
  });

  it('rejects an unsigned (alg=none) token', async () => {
    serveJwks([pair.jwk]);
    const token = await signToken(pair, baseClaims(), { alg: 'none', kid: KID });

    expect(await verifyFirebaseIdToken(token, PROJECT_ID, { jwksUrl: JWKS_URL })).toBeNull();
  });

  it('fails closed when the key set cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const token = await signToken(pair, baseClaims());

    expect(await verifyFirebaseIdToken(token, PROJECT_ID, { jwksUrl: JWKS_URL })).toBeNull();
  });

  it('caches the key set between verifications', async () => {
    const mock = serveJwks([pair.jwk]);
    const token = await signToken(pair, baseClaims());

    await verifyFirebaseIdToken(token, PROJECT_ID, { jwksUrl: JWKS_URL });
    await verifyFirebaseIdToken(token, PROJECT_ID, { jwksUrl: JWKS_URL });

    expect(mock).toHaveBeenCalledTimes(1);
  });
});
