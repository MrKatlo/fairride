import * as WebBrowser from 'expo-web-browser';

/**
 * Hosted checkout in the system browser.
 *
 * The provider's SDK is deliberately not embedded: a hosted page keeps PCI scope
 * with the provider and avoids a heavyweight native module. The important rule
 * is that the *client never decides* whether a payment succeeded - the app only
 * surfaces a result, and the Worker confirms via the provider's webhook before
 * marking a ride paid.
 */

export type CheckoutOutcome = 'completed' | 'cancelled' | 'dismissed' | 'failed';

export interface CheckoutResult {
  outcome: CheckoutOutcome;
  /** The return URL the provider redirected to, when the session completed. */
  url?: string;
}

/**
 * @param checkoutUrl  Session URL created server-side (an authenticated API call,
 *                     so the amount is never chosen by the client).
 * @param returnUrl    The app's deep link, e.g. `fairride://checkout/return`.
 */
export async function startHostedCheckout(checkoutUrl: string, returnUrl: string): Promise<CheckoutResult> {
  const result = await WebBrowser.openAuthSessionAsync(checkoutUrl, returnUrl);

  switch (result.type) {
    case 'success':
      return { outcome: 'completed', url: result.url };
    case 'cancel':
      return { outcome: 'cancelled' };
    case 'dismiss':
      return { outcome: 'dismissed' };
    default:
      return { outcome: 'failed' };
  }
}
