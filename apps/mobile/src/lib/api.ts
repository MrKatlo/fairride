import { z } from 'zod';

import {
  type CreateRideRequest,
  type RateRide,
  type Ride,
  driverProfileSchema,
  rideOfferSchema,
  rideSchema,
  type User,
  userSchema,
} from '@fairride/shared';

import { API_URL } from './config';

/** Validation error detail returned by the API on a 422. */
export const problemDetailSchema = z.object({ path: z.string(), message: z.string() });

/** An error carrying the HTTP status and (when present) field-level details. */
export class ApiError extends Error {
  readonly status: number;
  readonly details: ReadonlyArray<{ path: string; message: string }>;

  constructor(status: number, message: string, details: ReadonlyArray<{ path: string; message: string }> = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

const otpRequestResponseSchema = z.object({
  delivered: z.boolean(),
  expiresInSeconds: z.number().int().positive(),
  devCode: z.string().optional(),
});

const verifyResponseSchema = z.object({ token: z.string().min(1), user: userSchema });

const rideDetailSchema = z.object({ ride: rideSchema, offers: z.array(rideOfferSchema) });
const rideListSchema = z.object({ rides: z.array(rideSchema) });
const snapshotSchema = z.object({
  ride: rideSchema,
  offers: z.array(rideOfferSchema),
  serverTime: z.iso.datetime(),
});

const nearbyDriverSchema = z.object({
  userId: z.string(),
  fullName: z.string().nullable(),
  rating: z.number(),
  totalRides: z.number().int(),
  vehicle: z.object({
    make: z.string().nullable(),
    model: z.string().nullable(),
    color: z.string().nullable(),
    plate: z.string().nullable(),
  }),
  location: z.object({ lat: z.number(), lng: z.number() }),
  distanceMeters: z.number().int().nonnegative(),
});

export type OtpRequestResult = z.infer<typeof otpRequestResponseSchema>;
export type NearbyDriver = z.infer<typeof nearbyDriverSchema>;
export type LiveSnapshot = z.infer<typeof snapshotSchema>;
export type DriverProfile = z.infer<typeof driverProfileSchema>;

export interface DriverOnboardingInput {
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleYear?: number;
  vehicleColor?: string;
  vehiclePlate?: string;
  licenseNumber?: string;
}

/**
 * The one HTTP entry point. Every response is parsed through a Zod schema, so a
 * server change surfaces here as a loud error instead of a silent `undefined`
 * three screens later.
 */
export class FairRideApi {
  private token: string | null = null;

  constructor(private readonly baseUrl: string = API_URL) {}

  /** The token is held in memory only; persistence is the caller's job. */
  setToken(token: string | null): void {
    this.token = token;
  }

  private async request<S extends z.ZodType>(
    path: string,
    schema: S,
    init: { method?: string; body?: unknown } = {},
  ): Promise<z.infer<S>> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch {
      throw new ApiError(0, 'Network request failed. Check your connection and the API URL.');
    }

    const text = await response.text();
    const payload: unknown = text.length > 0 ? safeJsonParse(text) : null;

    if (!response.ok) {
      const error = payload as { error?: string; details?: unknown } | null;
      const details = problemDetailSchema.array().safeParse(error?.details);
      throw new ApiError(
        response.status,
        typeof error?.error === 'string' ? error.error : `Request failed (${response.status}).`,
        details.success ? details.data : [],
      );
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiError(response.status, 'The server returned an unexpected response shape.');
    }
    return parsed.data;
  }

  requestOtp(phone: string): Promise<OtpRequestResult> {
    return this.request('/v1/auth/otp/request', otpRequestResponseSchema, {
      method: 'POST',
      body: { phone },
    });
  }

  verifyOtp(phone: string, code: string): Promise<{ token: string; user: User }> {
    return this.request('/v1/auth/otp/verify', verifyResponseSchema, {
      method: 'POST',
      body: { phone, code },
    });
  }

  /**
   * Exchanges a Firebase ID token for our session JWT. The phone number is taken
   * from the verified token server-side, so nothing about identity is trusted
   * from here.
   */
  firebaseSignIn(idToken: string): Promise<{ token: string; user: User }> {
    return this.request('/v1/auth/firebase', verifyResponseSchema, {
      method: 'POST',
      body: { idToken },
    });
  }

  registerDevice(token: string, platform: 'android' | 'ios' | 'web'): Promise<{ ok: boolean }> {
    return this.request('/v1/notifications/devices', z.object({ ok: z.boolean() }), {
      method: 'POST',
      body: { token, platform },
    });
  }

  unregisterDevice(token: string): Promise<{ ok: boolean }> {
    return this.request('/v1/notifications/devices', z.object({ ok: z.boolean() }), {
      method: 'DELETE',
      body: { token },
    });
  }

  listRides(): Promise<{ rides: Ride[] }> {
    return this.request('/v1/rides', rideListSchema);
  }

  /** Open requests a driver could bid on. Server filters to a 5km box when it knows our location. */
  availableRides(): Promise<{ rides: Ride[] }> {
    return this.request('/v1/rides/available', rideListSchema);
  }

  createRide(input: CreateRideRequest) {
    return this.request('/v1/rides', z.object({ ride: rideSchema }), { method: 'POST', body: input });
  }

  getRide(rideId: string): Promise<z.infer<typeof rideDetailSchema>> {
    return this.request(`/v1/rides/${rideId}`, rideDetailSchema);
  }

  liveSnapshot(rideId: string): Promise<LiveSnapshot> {
    return this.request(`/v1/rides/${rideId}/live`, snapshotSchema);
  }

  rateRide(rideId: string, input: RateRide): Promise<{ ok: boolean }> {
    return this.request(`/v1/rides/${rideId}/rate`, z.object({ ok: z.boolean() }), {
      method: 'POST',
      body: input,
    });
  }

  getDriverProfile(): Promise<{ profile: DriverProfile }> {
    return this.request('/v1/drivers/me', z.object({ profile: driverProfileSchema }));
  }

  onboardDriver(input: DriverOnboardingInput): Promise<{ profile: DriverProfile }> {
    return this.request('/v1/drivers/me', z.object({ profile: driverProfileSchema }), {
      method: 'POST',
      body: input,
    });
  }

  setDriverOnline(online: boolean): Promise<{ isOnline: boolean }> {
    return this.request(
      `/v1/drivers/me/${online ? 'online' : 'offline'}`,
      z.object({ isOnline: z.boolean() }),
      { method: 'POST' },
    );
  }

  updateDriverLocation(lat: number, lng: number): Promise<{ ok: boolean; at: string }> {
    return this.request('/v1/drivers/me/location', z.object({ ok: z.boolean(), at: z.iso.datetime() }), {
      method: 'POST',
      body: { lat, lng },
    });
  }

  nearbyDrivers(lat: number, lng: number, radiusMeters = 3000): Promise<{ drivers: NearbyDriver[] }> {
    const query = `?lat=${lat}&lng=${lng}&radiusMeters=${radiusMeters}`;
    return this.request(`/v1/drivers/nearby${query}`, z.object({ drivers: z.array(nearbyDriverSchema) }));
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The app shares a single client instance; the token is set after sign-in. */
export const api = new FairRideApi();
