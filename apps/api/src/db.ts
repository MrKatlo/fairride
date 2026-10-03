import type {
  ActorRole,
  OfferStatus,
  Role,
  Ride,
  RideOffer,
  RideStatus,
} from '@fairride/shared';

/**
 * D1 row shapes (snake_case, SQLite types) and mappers to the camelCase domain
 * types in `@fairride/shared`.
 *
 * Keeping the mapping in one place means the SQL never leaks into business
 * logic, and a schema change surfaces as a single type error here.
 */

export interface RideRow {
  id: string;
  passenger_id: string;
  driver_id: string | null;
  status: RideStatus;
  pickup_lat: number;
  pickup_lng: number;
  pickup_address: string | null;
  dropoff_lat: number;
  dropoff_lng: number;
  dropoff_address: string | null;
  passenger_proposed_price: number | null;
  final_price: number | null;
  currency: string;
  distance_meters: number | null;
  duration_seconds: number | null;
  version: number;
  created_at: string;
  accepted_at: string | null;
  arrived_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
}

export interface OfferRow {
  id: string;
  ride_id: string;
  from_user_id: string;
  from_role: ActorRole;
  price: number;
  message: string | null;
  status: OfferStatus;
  created_at: string;
  resolved_at: string | null;
}

export interface UserRow {
  id: string;
  phone: string;
  email: string | null;
  role: Role;
  full_name: string | null;
  profile_photo_url: string | null;
  rating: number;
  total_rides: number;
  is_blocked: number;
  created_at: string;
  updated_at: string;
}

export function mapRideRow(row: RideRow): Ride {
  return {
    id: row.id,
    passengerId: row.passenger_id,
    driverId: row.driver_id,
    status: row.status,
    pickup: { lat: row.pickup_lat, lng: row.pickup_lng, address: row.pickup_address },
    dropoff: { lat: row.dropoff_lat, lng: row.dropoff_lng, address: row.dropoff_address },
    passengerProposedPrice: row.passenger_proposed_price,
    finalPrice: row.final_price,
    currency: row.currency,
    distanceMeters: row.distance_meters,
    durationSeconds: row.duration_seconds,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    arrivedAt: row.arrived_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by,
    cancellationReason: row.cancellation_reason,
  };
}

export function mapOfferRow(row: OfferRow): RideOffer {
  return {
    id: row.id,
    rideId: row.ride_id,
    fromUserId: row.from_user_id,
    fromRole: row.from_role,
    price: row.price,
    message: row.message,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export async function findRide(db: D1Database, rideId: string): Promise<Ride | null> {
  const row = await db.prepare('SELECT * FROM rides WHERE id = ?').bind(rideId).first<RideRow>();
  return row ? mapRideRow(row) : null;
}

export async function findOffers(db: D1Database, rideId: string): Promise<RideOffer[]> {
  const { results } = await db
    .prepare('SELECT * FROM ride_offers WHERE ride_id = ? ORDER BY created_at ASC')
    .bind(rideId)
    .all<OfferRow>();
  return results.map(mapOfferRow);
}

/** A driver is a participant of an unmatched ride; only the assignee once matched. */
export function isRideParticipant(
  ride: Ride,
  user: { id: string; role: Role },
): boolean {
  if (user.role === 'admin') return true;
  if (user.id === ride.passengerId) return true;
  if (user.role === 'driver') return ride.driverId === null || ride.driverId === user.id;
  return false;
}

/** ISO-8601 UTC with milliseconds - the exact format `z.iso.datetime()` expects. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Prefixed, sortable-enough opaque id. Prefixes make logs readable. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Haversine distance in metres between two coordinates.
 *
 * Used for nearby-driver search and to sanity-check reported driver movement
 * (a driver that "teleports" 40km in 3 seconds is spoofing). Good enough for a
 * launch city; move to geohash cells when the driver table grows.
 */
export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const EARTH_RADIUS_M = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Bounding box for a radius search, so the SQL can use an index on
 * (is_online, current_lat, current_lng) before the exact Haversine filter.
 */
export function boundingBox(center: { lat: number; lng: number }, radiusMeters: number) {
  const latDelta = radiusMeters / 111_320;
  const cosLat = Math.max(Math.cos((center.lat * Math.PI) / 180), 0.01);
  const lngDelta = radiusMeters / (111_320 * cosLat);
  return {
    minLat: center.lat - latDelta,
    maxLat: center.lat + latDelta,
    minLng: center.lng - lngDelta,
    maxLng: center.lng + lngDelta,
  };
}
