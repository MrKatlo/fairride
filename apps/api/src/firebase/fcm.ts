import { bytesToBase64Url, pemToPkcs8, textEncoder } from '../encoding.ts';

/**
 * Firebase Cloud Messaging (HTTP v1) sender.
 *
 * FCM v1 needs an OAuth2 access token minted from the service account: sign a
 * JWT assertion with the account's private key, exchange it for a bearer token,
 * then call the send endpoint. No SDK required, and the access token is cached
 * until shortly before it expires.
 *
 * Sending is best-effort by design: a push that fails must never fail the ride
 * operation that triggered it.
 */

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const FCM_ENDPOINT = 'https://fcm.googleapis.com/v1/projects';
const ASSERTION_TTL_SECONDS = 3600;

export interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** String-only by FCM contract; everything is coerced by the caller. */
  data?: Record<string, string>;
}

/** Parses the JSON key file. Returns `null` rather than throwing on junk. */
export function parseServiceAccount(raw: string): ServiceAccount | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const { project_id, client_email, private_key, token_uri } = parsed;
  if (typeof project_id !== 'string' || typeof client_email !== 'string' || typeof private_key !== 'string') {
    return null;
  }
  return {
    projectId: project_id,
    clientEmail: client_email,
    privateKey: private_key,
    tokenUri: typeof token_uri === 'string' ? token_uri : DEFAULT_TOKEN_URI,
  };
}

/** Builds and signs the `jwt-bearer` assertion for the FCM scope. */
export async function createServiceAccountAssertion(
  account: ServiceAccount,
  scope: string = FCM_SCOPE,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = bytesToBase64Url(textEncoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = bytesToBase64Url(
    textEncoder.encode(
      JSON.stringify({
        iss: account.clientEmail,
        scope,
        aud: account.tokenUri,
        iat: nowSeconds,
        exp: nowSeconds + ASSERTION_TTL_SECONDS,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(account.privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, textEncoder.encode(signingInput));
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

let accessTokenCache: { value: string; expiresAt: number } | null = null;

async function getAccessToken(account: ServiceAccount): Promise<string> {
  // Refresh a minute early so a token cannot expire mid-flight.
  if (accessTokenCache && accessTokenCache.expiresAt > Date.now() + 60_000) return accessTokenCache.value;

  const assertion = await createServiceAccountAssertion(account);
  const response = await fetch(account.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  if (!response.ok) throw new Error(`Service-account token exchange failed (${response.status}).`);

  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error('Service-account token exchange returned no token.');

  accessTokenCache = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? ASSERTION_TTL_SECONDS) * 1000,
  };
  return accessTokenCache.value;
}

/**
 * Sends to many device tokens.
 *
 * Returns the tokens FCM rejected as permanently invalid so the caller can
 * delete them; everything else is swallowed. Never throws.
 */
export async function sendPush(
  serviceAccountJson: string | undefined,
  tokens: readonly string[],
  message: PushMessage,
): Promise<string[]> {
  if (!serviceAccountJson || tokens.length === 0) return [];

  const account = parseServiceAccount(serviceAccountJson);
  if (!account) return [];

  let accessToken: string;
  try {
    accessToken = await getAccessToken(account);
  } catch {
    return [];
  }

  const invalidTokens: string[] = [];

  await Promise.all(
    tokens.map(async (token) => {
      try {
        const response = await fetch(`${FCM_ENDPOINT}/${account.projectId}/messages:send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              token,
              notification: { title: message.title, body: message.body },
              ...(message.data ? { data: message.data } : {}),
            },
          }),
        });

        if (response.ok) return;
        if (response.status === 404) {
          invalidTokens.push(token);
          return;
        }
        if (response.status === 400) {
          const error = (await response.json().catch(() => null)) as
            | { error?: { details?: Array<{ errorCode?: string }> } }
            | null;
          const unregistered = error?.error?.details?.some(
            (detail) => detail.errorCode === 'UNREGISTERED' || detail.errorCode === 'INVALID_ARGUMENT',
          );
          if (unregistered) invalidTokens.push(token);
        }
      } catch {
        // Network hiccup: leave the token alone.
      }
    }),
  );

  return invalidTokens;
}

/** Test seam: forget the cached access token. */
export function resetAccessTokenCache(): void {
  accessTokenCache = null;
}
