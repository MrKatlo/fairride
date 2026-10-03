import { z } from 'zod';

import { placeOfferSchema, rideOfferSchema, rideSchema, rideStatusSchema } from './schemas.ts';

/**
 * The WebSocket wire protocol used by the `RideRoom` Durable Object.
 *
 * One connection == one ride room. The client sends `ClientIntent`s; the server
 * replies with `ServerEvent`s. Every inbound frame is parsed with Zod before it
 * reaches business logic; a malformed frame closes nothing but returns an
 * `error` event, so one bad client cannot take down a room.
 *
 * Bump `REALTIME_PROTOCOL_VERSION` on any breaking change and reject clients on
 * a different major version at handshake time.
 */
export const REALTIME_PROTOCOL_VERSION = 1;

/** Handshake query parameters: `/rides/:rideId/ws?token=<jwt>&v=1` */
export const handshakeSchema = z.object({
  token: z.string().min(1),
  v: z.coerce.number().int().optional(),
});
export type Handshake = z.infer<typeof handshakeSchema>;

export const REALTIME_ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'invalid_intent',
  'ride_not_found',
  'not_participant',
  'stale_state',
  'rate_limited',
  'internal',
] as const;
export const realtimeErrorCodeSchema = z.enum(REALTIME_ERROR_CODES);
export type RealtimeErrorCode = z.infer<typeof realtimeErrorCodeSchema>;

/* ------------------------------------------------------------------ *
 * Client -> Server
 * ------------------------------------------------------------------ */

export const clientIntentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('offer.create'), offer: placeOfferSchema }),
  z.object({ type: z.literal('offer.accept'), offerId: z.string().min(1) }),
  z.object({ type: z.literal('offer.reject'), offerId: z.string().min(1) }),
  z.object({ type: z.literal('ride.transition'), to: rideStatusSchema }),
  z.object({
    type: z.literal('driver.location'),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
  z.object({ type: z.literal('chat.message'), text: z.string().min(1).max(1000) }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientIntent = z.infer<typeof clientIntentSchema>;
export type ClientIntentType = ClientIntent['type'];

/* ------------------------------------------------------------------ *
 * Server -> Client
 * ------------------------------------------------------------------ */

export const chatMessageSchema = z.object({
  id: z.string().min(1),
  rideId: z.string().min(1),
  userId: z.string().min(1),
  role: z.enum(['passenger', 'driver', 'admin', 'system']),
  text: z.string().min(1).max(1000),
  at: z.iso.datetime(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ride.snapshot'),
    ride: rideSchema,
    offers: z.array(rideOfferSchema),
    serverTime: z.iso.datetime(),
  }),
  z.object({ type: z.literal('offer.created'), offer: rideOfferSchema }),
  z.object({ type: z.literal('offer.updated'), offer: rideOfferSchema }),
  z.object({
    type: z.literal('ride.status_changed'),
    rideId: z.string().min(1),
    from: rideStatusSchema,
    to: rideStatusSchema,
    actorRole: z.enum(['passenger', 'driver', 'admin', 'system']),
    at: z.iso.datetime(),
  }),
  z.object({
    type: z.literal('driver.location'),
    rideId: z.string().min(1),
    driverId: z.string().min(1),
    lat: z.number(),
    lng: z.number(),
    at: z.iso.datetime(),
  }),
  z.object({ type: z.literal('chat.message'), message: chatMessageSchema }),
  z.object({
    type: z.literal('ride.presence'),
    rideId: z.string().min(1),
    viewers: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('error'),
    code: realtimeErrorCodeSchema,
    message: z.string(),
    /** Echoed back so a client can correlate a rejected intent with its request. */
    intentType: z.string().optional(),
  }),
  z.object({ type: z.literal('pong'), at: z.iso.datetime() }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;
export type ServerEventType = ServerEvent['type'];

/** Safe parse helper so clients do not have to import Zod where they do not need it. */
export function parseServerEvent(raw: unknown): ServerEvent | null {
  const result = serverEventSchema.safeParse(raw);
  return result.success ? result.data : null;
}
