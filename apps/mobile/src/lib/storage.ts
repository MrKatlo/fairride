import * as SecureStore from 'expo-secure-store';

/**
 * SecureStore is the right home for a bearer token on device, but it has no web
 * implementation. This wrapper keeps one call style across platforms: secure
 * storage on iOS/Android, `localStorage` on web (acceptable for local dev).
 */
function webStorage(): Storage | null {
  return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
}

export async function readSecret(key: string): Promise<string | null> {
  const web = webStorage();
  if (web) return web.getItem(key);
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

export async function writeSecret(key: string, value: string): Promise<void> {
  const web = webStorage();
  if (web) {
    web.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

export async function deleteSecret(key: string): Promise<void> {
  const web = webStorage();
  if (web) {
    web.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}
