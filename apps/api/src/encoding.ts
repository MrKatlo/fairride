/**
 * base64 / PEM helpers shared by the HS256 session tokens and the RS256
 * Firebase token and service-account code. Kept in one place so encoding bugs
 * cannot differ between the two.
 */

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();

/** Decodes standard base64 (padding optional) into bytes. */
export function base64ToBytes(value: string): Uint8Array {
  const normalised = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decodes base64url (JWT segment encoding, `-`/`_`, unpadded). */
export function base64UrlToBytes(value: string): Uint8Array {
  return base64ToBytes(value);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes a JWT segment as UTF-8 JSON. Throws on malformed input. */
export function decodeJsonSegment<T>(segment: string): T {
  return JSON.parse(textDecoder.decode(base64UrlToBytes(segment))) as T;
}

/** PEM (PKCS#8) private key -> raw bytes, for `crypto.subtle.importKey`. */
export function pemToPkcs8(pem: string): Uint8Array {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '');
  return base64ToBytes(body);
}
