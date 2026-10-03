import type { RideStatus } from '@fairride/shared';

/** Formats an amount in the ride's currency. Falls back to a bare number. */
export function formatMoney(amount: number | null | undefined, currency = 'USD'): string {
  if (amount === null || amount === undefined) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatDistance(meters: number | null | undefined): string {
  if (meters === null || meters === undefined) return '—';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

const STATUS_LABELS: Record<RideStatus, string> = {
  requested: 'Finding a driver',
  negotiating: 'Negotiating price',
  accepted: 'Driver on the way',
  arrived: 'Driver has arrived',
  started: 'On the trip',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export function statusLabel(status: RideStatus): string {
  return STATUS_LABELS[status];
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
