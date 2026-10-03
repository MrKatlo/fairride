import { z } from 'zod';

import { RIDE_STATUSES, type ActorRole } from './ride-status.ts';

/**
 * Zod schemas are the source of truth for the domain shape; `./types.ts`
 * derives the TypeScript types from them so the two can never drift.
 *
 * Money is always a plain number in the ride's `currency` (a 3-letter ISO code).
 * Prices are validated with sane ceilings so a malicious client cannot send
 * `Number.MAX_VALUE` as an offer.
 */

const MAX_PRICE = 100_000;
const MAX_TEXT = 500;

export const currencySchema = z.string().length(3).toUpperCase();

export const actorRoleSchema = z.enum(['passenger', 'driver', 'admin', 'system']);

// Compile-time guarantee that the schema and the state machine agree. If either
// side changes, this line fails to typecheck.
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _actorRoleParityCheck: Equals<z.infer<typeof actorRoleSchema>, ActorRole> = true;
void _actorRoleParityCheck;

export const rideStatusSchema = z.enum(RIDE_STATUSES);

export const userRoleSchema = z.enum(['passenger', 'driver', 'admin']);

/** A persisted user role. Unlike `ActorRole`, this never includes `system`. */
export type Role = z.infer<typeof userRoleSchema>;

export const geoPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  // Kept `.nullish()`: clients may omit an address entirely on input, while
  // persisted rows always carry either a string or an explicit null.
  address: z.string().max(MAX_TEXT).nullish(),
});

export const userSchema = z.object({
  id: z.string().min(1),
  phone: z.string().min(4).max(32),
  email: z.email().nullable(),
  role: userRoleSchema,
  fullName: z.string().max(MAX_TEXT).nullable(),
  profilePhotoUrl: z.url().nullable(),
  rating: z.number().min(0).max(5),
  totalRides: z.number().int().min(0),
  isBlocked: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const driverProfileSchema = z.object({
  userId: z.string().min(1),
  vehicleMake: z.string().max(120).nullable(),
  vehicleModel: z.string().max(120).nullable(),
  vehicleYear: z.number().int().min(1950).max(2100).nullable(),
  vehicleColor: z.string().max(60).nullable(),
  vehiclePlate: z.string().max(32).nullable(),
  vehiclePhotoUrl: z.string().nullable(),
  licenseNumber: z.string().max(64).nullable(),
  licensePhotoUrl: z.string().nullable(),
  insurancePhotoUrl: z.string().nullable(),
  approvalStatus: z.enum(['pending', 'approved', 'rejected']),
  isOnline: z.boolean(),
  location: z.object({ lat: z.number(), lng: z.number() }).nullable(),
  lastLocationUpdate: z.iso.datetime().nullable(),
  totalEarnings: z.number(),
  commissionRate: z.number().min(0).max(1),
});

export const offerStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'superseded']);

export const rideOfferSchema = z.object({
  id: z.string().min(1),
  rideId: z.string().min(1),
  fromUserId: z.string().min(1),
  fromRole: actorRoleSchema,
  price: z.number().positive().max(MAX_PRICE),
  message: z.string().max(MAX_TEXT).nullable(),
  status: offerStatusSchema,
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});

export const rideSchema = z.object({
  id: z.string().min(1),
  passengerId: z.string().min(1),
  driverId: z.string().nullable(),
  status: rideStatusSchema,
  pickup: geoPointSchema,
  dropoff: geoPointSchema,
  passengerProposedPrice: z.number().positive().max(MAX_PRICE).nullable(),
  finalPrice: z.number().positive().max(MAX_PRICE).nullable(),
  currency: currencySchema,
  distanceMeters: z.number().int().min(0).nullable(),
  durationSeconds: z.number().int().min(0).nullable(),
  createdAt: z.iso.datetime(),
  acceptedAt: z.iso.datetime().nullable(),
  arrivedAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  cancelledBy: z.string().nullable(),
  cancellationReason: z.string().max(MAX_TEXT).nullable(),
});

export const rideEventSchema = z.object({
  id: z.string().min(1),
  rideId: z.string().min(1),
  eventType: z.string().min(1),
  payload: z.unknown().nullable(),
  createdAt: z.iso.datetime(),
});

export const paymentSchema = z.object({
  id: z.string().min(1),
  rideId: z.string().min(1),
  amount: z.number().positive().max(MAX_PRICE),
  currency: currencySchema,
  provider: z.string().min(1),
  providerPaymentId: z.string().nullable(),
  status: z.enum(['pending', 'succeeded', 'failed', 'refunded']),
  createdAt: z.iso.datetime(),
});

export const ratingSchema = z.object({
  id: z.string().min(1),
  rideId: z.string().min(1),
  fromUserId: z.string().min(1),
  toUserId: z.string().min(1),
  score: z.number().int().min(1).max(5),
  comment: z.string().max(1000).nullable(),
  createdAt: z.iso.datetime(),
});

/* ------------------------------------------------------------------ *
 * Request payloads (what the API accepts from clients)
 * ------------------------------------------------------------------ */

export const createRideRequestSchema = z.object({
  pickup: geoPointSchema,
  dropoff: geoPointSchema,
  proposedPrice: z.number().positive().max(MAX_PRICE),
  currency: currencySchema.default('USD'),
  note: z.string().max(MAX_TEXT).optional(),
});
export type CreateRideRequest = z.infer<typeof createRideRequestSchema>;

export const placeOfferSchema = z.object({
  price: z.number().positive().max(MAX_PRICE),
  message: z.string().max(MAX_TEXT).optional(),
});
export type PlaceOffer = z.infer<typeof placeOfferSchema>;

export const rateRideSchema = z.object({
  score: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional(),
});
export type RateRide = z.infer<typeof rateRideSchema>;

export const updateDriverLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type UpdateDriverLocation = z.infer<typeof updateDriverLocationSchema>;
