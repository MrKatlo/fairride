import {
  type ConfirmationResult,
  getAuth,
  getIdToken,
  signInWithPhoneNumber,
  signOut,
} from '@react-native-firebase/auth';

/**
 * Firebase Auth wrapper.
 *
 * Firebase is the identity provider; our Worker only ever sees a *verified* ID
 * token. Keeping the SDK behind this module means the screens never import it
 * directly and the sign-in flow stays swappable.
 *
 * Note: `@react-native-firebase/*` ships native code, so the app must run in a
 * development build (or a real build) - not in Expo Go. Run `npx expo prebuild`
 * and `npx expo run:android` once after installing dependencies.
 */

export type PhoneConfirmation = ConfirmationResult;

/** Sends the SMS. Rejects with a Firebase error code on a bad number or quota. */
export function startPhoneSignIn(phoneNumber: string): Promise<ConfirmationResult> {
  return signInWithPhoneNumber(getAuth(), phoneNumber);
}

/** The current Firebase ID token, refreshed if it is close to expiry. */
export async function currentIdToken(forceRefresh = false): Promise<string | null> {
  const user = getAuth().currentUser;
  if (!user) return null;
  return getIdToken(user, forceRefresh);
}

export async function signOutOfFirebase(): Promise<void> {
  await signOut(getAuth());
}

/** Maps Firebase's error codes to copy a human can act on. */
export function describeAuthError(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  switch (code) {
    case 'auth/invalid-phone-number':
      return 'That phone number does not look right. Include the country code, e.g. +44...';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes and try again.';
    case 'auth/invalid-verification-code':
      return 'That code is not correct.';
    case 'auth/code-expired':
      return 'That code has expired. Request a new one.';
    case 'auth/quota-exceeded':
      return 'SMS quota exceeded. Try again later.';
    default:
      return 'Could not sign you in. Check your connection and try again.';
  }
}
