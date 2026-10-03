import Constants from 'expo-constants';

/**
 * Where the API lives.
 *
 * Set `EXPO_PUBLIC_API_URL` in `.env` (see `.env.example`). The fallback assumes
 * `wrangler dev`, which listens on :8787. Android emulators cannot see the host's
 * `localhost`, so use `http://10.0.2.2:8787` there; an iOS simulator can use
 * `http://localhost:8787`.
 */
function resolveApiUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv.replace(/\/$/, '');

  const fromExtra = Constants.expoConfig?.extra?.apiUrl;
  if (typeof fromExtra === 'string' && fromExtra.length > 0) return fromExtra.replace(/\/$/, '');

  return 'http://localhost:8787';
}

export const API_URL = resolveApiUrl();

/** Derives the WebSocket origin from the HTTP one: http -> ws, https -> wss. */
export const WS_URL = API_URL.replace(/^http/, 'ws');
