import { afterEach, describe, expect, it, vi } from 'vitest';

import { base64UrlToBytes, decodeJsonSegment, textEncoder } from '../src/encoding.ts';
import {
  createServiceAccountAssertion,
  parseServiceAccount,
  resetAccessTokenCache,
  sendPush,
  type ServiceAccount,
} from '../src/firebase/fcm.ts';

/**
 * The JWT-bearer assertion is the part of FCM v1 most likely to be subtly wrong
 * (base64url vs base64, PEM decoding, claim names), and it fails only at runtime
 * against Google. Here we sign with a key we generate and verify the result.
 */

function toPkcs8Pem(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  const lines = (btoa(binary).match(/.{1,64}/g) ?? []).join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

async function makeAccount(): Promise<{ account: ServiceAccount; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

  const pkcs8 = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
  return {
    account: {
      projectId: 'fairride-test',
      clientEmail: 'sender@fairride-test.iam.gserviceaccount.com',
      privateKey: toPkcs8Pem(pkcs8),
      tokenUri: 'https://oauth2.test/token',
    },
    publicKey: pair.publicKey,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetAccessTokenCache();
});

describe('parseServiceAccount', () => {
  it('reads the fields we need', () => {
    const account = parseServiceAccount(
      JSON.stringify({
        project_id: 'p1',
        client_email: 'a@b.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nxx\n-----END PRIVATE KEY-----\n',
        token_uri: 'https://oauth2.googleapis.com/token',
      }),
    );
    expect(account?.projectId).toBe('p1');
    expect(account?.clientEmail).toBe('a@b.iam.gserviceaccount.com');
  });

  it('returns null for junk or incomplete JSON', () => {
    expect(parseServiceAccount('not json')).toBeNull();
    expect(parseServiceAccount('{}')).toBeNull();
    expect(parseServiceAccount(JSON.stringify({ project_id: 'p1' }))).toBeNull();
  });
});

describe('createServiceAccountAssertion', () => {
  it('produces a valid RS256 assertion with the expected claims', async () => {
    const { account, publicKey } = await makeAccount();
    const assertion = await createServiceAccountAssertion(account, 'scope-x', 1_000_000);

    const [headerSegment, payloadSegment, signatureSegment] = assertion.split('.') as [string, string, string];

    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      base64UrlToBytes(signatureSegment),
      textEncoder.encode(`${headerSegment}.${payloadSegment}`),
    );
    expect(valid).toBe(true);

    const header = decodeJsonSegment<{ alg: string; typ: string }>(headerSegment);
    expect(header.alg).toBe('RS256');
    expect(header.typ).toBe('JWT');

    const claims = decodeJsonSegment<{ iss: string; scope: string; aud: string; iat: number; exp: number }>(
      payloadSegment,
    );
    expect(claims.iss).toBe(account.clientEmail);
    expect(claims.scope).toBe('scope-x');
    expect(claims.aud).toBe(account.tokenUri);
    expect(claims.iat).toBe(1_000_000);
    expect(claims.exp).toBe(1_000_000 + 3600);
  });
});

describe('sendPush', () => {
  it('is a no-op without a service account or tokens', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await sendPush(undefined, ['token'], { title: 'a', body: 'b' })).toEqual([]);
    expect(await sendPush('{}', ['token'], { title: 'a', body: 'b' })).toEqual([]);
    expect(await sendPush('{}', [], { title: 'a', body: 'b' })).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when the token exchange fails', async () => {
    const { account } = await makeAccount();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 401 })));

    const result = await sendPush(JSON.stringify({ project_id: account.projectId, client_email: account.clientEmail, private_key: account.privateKey, token_uri: account.tokenUri }), ['token'], {
      title: 'a',
      body: 'b',
    });

    expect(result).toEqual([]);
  });
});
