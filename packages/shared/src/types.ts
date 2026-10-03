/**
 * TypeScript view of the domain. Every type here is inferred from a Zod schema
 * in `./schemas.ts`, so validation and static types move together.
 */
import type { z } from 'zod';

import type {
  createRideRequestSchema,
  driverProfileSchema,
  geoPointSchema,
  paymentSchema,
  placeOfferSchema,
  rateRideSchema,
  ratingSchema,
  rideEventSchema,
  rideOfferSchema,
  rideSchema,
  updateDriverLocationSchema,
  userSchema,
} from './schemas.ts';

export type GeoPoint = z.infer<typeof geoPointSchema>;
export type User = z.infer<typeof userSchema>;
export type DriverProfile = z.infer<typeof driverProfileSchema>;
export type Ride = z.infer<typeof rideSchema>;
export type RideOffer = z.infer<typeof rideOfferSchema>;
export type OfferStatus = RideOffer['status'];
export type RideEvent = z.infer<typeof rideEventSchema>;
export type Payment = z.infer<typeof paymentSchema>;
export type Rating = z.infer<typeof ratingSchema>;

export type { CreateRideRequest, PlaceOffer, RateRide, UpdateDriverLocation } from './schemas.ts';

export type CreateRideInput = z.infer<typeof createRideRequestSchema>;
export type PlaceOfferInput = z.infer<typeof placeOfferSchema>;
export type RateRideInput = z.infer<typeof rateRideSchema>;
export type DriverLocationInput = z.infer<typeof updateDriverLocationSchema>;
