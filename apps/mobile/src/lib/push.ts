import {
  AuthorizationStatus,
  deleteToken,
  getMessaging,
  getToken,
  onTokenRefresh,
  requestPermission,
  setBackgroundMessageHandler,
} from '@react-native-firebase/messaging';
import { Platform } from 'react-native';

import { api } from './api';

/**
 * FCM registration.
 *
 * `installPushHandlers` must run at module load (not inside a component) so the
 * background handler is registered before a notification arrives while the app
 * is terminated.
 */

function platform(): 'android' | 'ios' {
  return Platform.OS === 'ios' ? 'ios' : 'android';
}

async function upload(token: string): Promise<void> {
  try {
    await api.registerDevice(token, platform());
  } catch {
    // Registration is retried on the next app launch; never block startup on it.
  }
}

/** Asks for permission, then registers this device's token with the API. */
export async function registerForPush(): Promise<void> {
  const messaging = getMessaging();
  const authorization = await requestPermission(messaging);
  const granted =
    authorization === AuthorizationStatus.AUTHORIZED || authorization === AuthorizationStatus.PROVISIONAL;
  if (!granted) return;

  const token = await getToken(messaging);
  if (token) await upload(token);
}

/**
 * Registers the background handler and the token-rotation listener. Safe to call
 * more than once: the OS renders `notification` payloads itself, and this
 * handler is a no-op until we move to data-only messages.
 */
export function installPushHandlers(): void {
  const messaging = getMessaging();

  setBackgroundMessageHandler(messaging, async () => undefined);

  onTokenRefresh(messaging, (token: string) => {
    void upload(token);
  });
}

/** Best-effort cleanup so a signed-out device stops receiving the account's push. */
export async function unregisterForPush(): Promise<void> {
  const messaging = getMessaging();
  try {
    const token = await getToken(messaging);
    if (token) await api.unregisterDevice(token);
    await deleteToken(messaging);
  } catch {
    // Nothing to do: the token is pruned server-side if FCM reports it dead.
  }
}
