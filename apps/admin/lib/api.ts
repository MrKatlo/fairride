import { z } from 'zod';

import { rideSchema } from '@fairride/shared';

/**
 * The console talks to the same Worker as the mobile app, only with an admin
 * token. It runs in the browser, so it keeps the token in `localStorage` and
 * attaches it to every request.
 */
const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787';
const TOKEN_KEY = 'fairride.admin.token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

async function request<S extends z.ZodType>(path: string, schema: S, init?: RequestInit): Promise<z.infer<S>> {
  const token = getToken();
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (payload as { error?: string } | null)?.error ?? `Request failed (${response.status}).`;
    throw new AdminApiError(response.status, message);
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new AdminApiError(response.status, 'Unexpected response shape.');
  return parsed.data;
}

const metricsSchema = z.object({
  ridesByStatus: z.record(z.string(), z.number()),
  drivers: z.object({
    total: z.number(),
    online: z.number(),
    pendingApproval: z.number(),
  }),
  grossCompletedValue: z.number(),
});

const driverRowSchema = z.object({
  user_id: z.string(),
  full_name: z.string().nullable(),
  phone: z.string(),
  vehicle_make: z.string().nullable(),
  vehicle_model: z.string().nullable(),
  vehicle_plate: z.string().nullable(),
  approval_status: z.enum(['pending', 'approved', 'rejected']),
  is_online: z.number(),
  total_earnings: z.number(),
  rating: z.number(),
});

export type AdminMetrics = z.infer<typeof metricsSchema>;
export type AdminDriverRow = z.infer<typeof driverRowSchema>;

export type AdminRide = z.infer<typeof rideSchema>;

export function fetchMetrics(): Promise<AdminMetrics> {
  return request('/v1/admin/metrics', metricsSchema);
}

export function fetchRides(status?: string): Promise<{ rides: AdminRide[] }> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  return request(`/v1/admin/rides${query}`, z.object({ rides: z.array(rideSchema) }));
}

export function fetchDrivers(approval?: string): Promise<{ drivers: AdminDriverRow[] }> {
  const query = approval ? `?approval=${encodeURIComponent(approval)}` : '';
  return request(`/v1/admin/drivers${query}`, z.object({ drivers: z.array(driverRowSchema) }));
}

export function setDriverApproval(
  userId: string,
  approvalStatus: 'approved' | 'rejected' | 'pending',
): Promise<{ ok: boolean }> {
  return request(`/v1/admin/drivers/${encodeURIComponent(userId)}/approval`, z.object({ ok: z.boolean() }), {
    method: 'POST',
    body: JSON.stringify({ approvalStatus }),
  });
}

/**
 * Mints a development admin token. `POST /v1/auth/dev/token` fails closed
 * outside a development environment, so this can never become a back door.
 */
export async function devSignIn(userId: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/v1/auth/dev/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, role: 'admin', phone: '+10000000000' }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new AdminApiError(response.status, (payload as { error?: string } | null)?.error ?? 'Sign-in failed.');
  }
  const parsed = z.object({ token: z.string() }).safeParse(payload);
  if (!parsed.success) throw new AdminApiError(500, 'Unexpected sign-in response.');
  return parsed.data.token;
}
