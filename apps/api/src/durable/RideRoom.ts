import { DurableObject } from 'cloudflare:workers';

import {
  type ActorRole,
  type ChatMessage,
  type ClientIntent,
  InvalidTransitionError,
  type RealtimeErrorCode,
  type Ride,
  RideInvariantError,
  type RideOffer,
  type RideStatus,
  type ServerEvent,
  assertRideInvariants,
  assertTransition,
  clientIntentSchema,
} from '@fairride/shared';

import { mapOfferRow, mapRideRow, newId, nowIso, type OfferRow, type RideRow } from '../db.ts';
import type { Env } from '../env.ts';
import type { PushMessage } from '../firebase/fcm.ts';
import { notifyUsers, statusPush } from '../notifications.ts';

/**
 * One Durable Object per ride: `env.RIDE_ROOM.getByName(rideId)`.
 *
 * Why a Durable Object instead of a plain Worker:
 *   * A Durable Object is single-threaded, so two drivers accepting the same
 *     offer at the same instant are *serialised*. The second one loses. With a
 *     stateless Worker you would need a distributed lock or an optimistic-retry
 *     loop around D1 and would still race.
 *   * It holds the WebSocket fan-out for the room without polling D1.
 *   * It owns the negotiation timeout via a single alarm.
 *
 * Storage model: D1 remains the durable source of truth for rides, offers and
 * chat, because the admin panel and analytics need to query them with SQL. The
 * Durable Object is the *coordination and ordering* layer. Negotiation write
 * volume is a handful of rows per ride, so write-through to D1 is cheap and it
 * avoids a dual-source-of-truth problem that would bite a solo developer later.
 *
 * WebSocket lifecycle uses the hibernation API (`ctx.acceptWebSocket`), so an
 * idle room costs nothing: no billable duration while everyone sits in the
 * negotiation screen staring at each other.
 */

interface Session {
  userId: string;
  role: ActorRole;
}

interface RateBucket {
  tokens: number;
  updatedAt: number;
}

/** A ride that gets no agreement within this window reopens/cancels itself. */
const NEGOTIATION_TTL_MS = 3 * 60 * 1000;

/** Per-connection intent budget. Generous for humans, hostile to loops. */
const MAX_INTENTS_PER_WINDOW = 30;
const INTENT_WINDOW_MS = 1000;

/** Location writes to D1 are throttled; broadcasts are not. */
const LOCATION_WRITE_INTERVAL_MS = 5_000;

/** Which column records the time a given status was entered. */
const STATUS_TIMESTAMP_COLUMN: Partial<Record<RideStatus, string>> = {
  accepted: 'accepted_at',
  arrived: 'arrived_at',
  started: 'started_at',
  completed: 'completed_at',
  cancelled: 'cancelled_at',
};

/** Thrown for client mistakes we want to report with a specific protocol code. */
class IntentDeniedError extends Error {
  readonly code: RealtimeErrorCode;

  constructor(code: RealtimeErrorCode, message: string) {
    super(message);
    this.name = 'IntentDeniedError';
    this.code = code;
  }
}

interface StatusExtras {
  driverId?: string | null;
  finalPrice?: number | null;
  cancelledBy?: string | null;
  reason?: string | null;
}

export class RideRoom extends DurableObject<Env> {
  private readonly sessions = new Map<WebSocket, Session>();
  private readonly buckets = new Map<WebSocket, RateBucket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Reattach to sockets that survived an eviction. Their identity lives in the
    // attachment, which is the only thing the runtime keeps across hibernation.
    for (const ws of this.ctx.getWebSockets()) {
      const session = ws.deserializeAttachment() as Session | null;
      if (session) this.sessions.set(ws, session);
    }
  }

  /* ---------------------------------------------------------------- *
   * Entrypoints
   * ---------------------------------------------------------------- */

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/ws')) return this.handleUpgrade(request);
    return new Response('Not found', { status: 404 });
  }

  /**
   * Read-only snapshot, callable over RPC from the Worker
   * (`env.RIDE_ROOM.getByName(id).snapshot()`).
   */
  async snapshot(): Promise<{ ride: Ride; offers: RideOffer[] } | null> {
    const ride = await this.loadRide();
    if (!ride) return null;
    return { ride, offers: await this.loadOffers() };
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const session = this.sessions.get(ws);
    if (!session) {
      this.sendError(ws, 'unauthorized', 'Session expired. Reconnect to the ride room.');
      ws.close(1008, 'unauthorized');
      return;
    }
    if (!this.consumeToken(ws)) {
      this.sendError(ws, 'rate_limited', 'Slow down.');
      return;
    }

    let intent: ClientIntent;
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      const parsed = clientIntentSchema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        this.sendError(ws, 'invalid_intent', 'Unrecognised intent shape.');
        return;
      }
      intent = parsed.data;
    } catch {
      this.sendError(ws, 'invalid_intent', 'Frame was not valid JSON.');
      return;
    }

    try {
      await this.dispatch(session, intent);
    } catch (error) {
      if (error instanceof IntentDeniedError) {
        this.sendError(ws, error.code, error.message, intent.type);
        return;
      }
      if (error instanceof InvalidTransitionError || error instanceof RideInvariantError) {
        this.sendError(ws, 'stale_state', error.message, intent.type);
        return;
      }
      // Never leak an internal message to the client; log it instead.
      console.error('ride_room.intent_failed', {
        rideId: this.ctx.id.toString(),
        intent: intent.type,
        error: error instanceof Error ? error.message : String(error),
      });
      this.sendError(ws, 'internal', 'Something went wrong handling that request.', intent.type);
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.dropSession(ws);
    const ride = await this.loadRide();
    if (ride) this.broadcast({ type: 'ride.presence', rideId: ride.id, viewers: this.sessions.size });
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.dropSession(ws);
  }

  /**
   * Fires when a ride has been open for offers for `NEGOTIATION_TTL_MS` without
   * agreement. `setAlarm` replaces any previous alarm, so moving through states
   * just reschedules rather than stacking timers.
   */
  override async alarm(): Promise<void> {
    const ride = await this.loadRide();
    if (!ride) return;
    if (ride.status !== 'requested' && ride.status !== 'negotiating') return;

    const now = nowIso();
    await this.applyStatus(ride, 'cancelled', 'system', now, {
      reason: 'No agreement reached before the offer window closed.',
    });
    this.broadcastStatus(ride.id, ride.status, 'cancelled', 'system', now);
    this.pushToUsers([ride.passengerId], {
      title: 'Ride cancelled',
      body: 'No driver agreed in time. Try again with a different price.',
      data: { rideId: ride.id, status: 'cancelled' },
    });
  }

  /* ---------------------------------------------------------------- *
   * Handshake
   * ---------------------------------------------------------------- */

  private async handleUpgrade(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }

    // The Worker already verified the JWT and is the only thing that can reach
    // this Durable Object; these headers are inside our trust boundary.
    const userId = request.headers.get('X-User-Id');
    const role = request.headers.get('X-User-Role') as ActorRole | null;
    if (!userId || !role) return new Response('Missing caller identity', { status: 401 });

    const ride = await this.loadRide();
    if (!ride) return new Response('Ride not found', { status: 404 });
    if (!this.isParticipant(ride, { userId, role })) {
      return new Response('You are not part of this ride', { status: 403 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const session: Session = { userId, role };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(session);
    this.sessions.set(server, session);
    this.buckets.set(server, { tokens: MAX_INTENTS_PER_WINDOW, updatedAt: Date.now() });

    // Render-from-truth: the client draws the negotiation screen from this
    // snapshot plus the events that follow, so a late joiner is never behind.
    this.send(server, {
      type: 'ride.snapshot',
      ride,
      offers: await this.loadOffers(),
      serverTime: nowIso(),
    });
    this.broadcast({ type: 'ride.presence', rideId: ride.id, viewers: this.sessions.size });

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---------------------------------------------------------------- *
   * Intent handling
   * ---------------------------------------------------------------- */

  private async dispatch(session: Session, intent: ClientIntent): Promise<void> {
    switch (intent.type) {
      case 'ping':
        // Handled by the caller's socket; nothing to broadcast.
        this.sendToUser(session.userId, { type: 'pong', at: nowIso() });
        return;
      case 'offer.create':
        return this.onCreateOffer(session, intent.offer.price, intent.offer.message ?? null);
      case 'offer.accept':
        return this.onResolveOffer(session, intent.offerId, true);
      case 'offer.reject':
        return this.onResolveOffer(session, intent.offerId, false);
      case 'ride.transition':
        return this.onTransition(session, intent.to);
      case 'driver.location':
        return this.onDriverLocation(session, intent.lat, intent.lng);
      case 'chat.message':
        return this.onChat(session, intent.text);
      default: {
        // Exhaustiveness: a new intent member becomes a compile error here.
        const never: never = intent;
        throw new IntentDeniedError('invalid_intent', `Unsupported intent: ${String(never)}`);
      }
    }
  }

  private async onCreateOffer(session: Session, price: number, message: string | null): Promise<void> {
    const ride = await this.requireRide();
    this.assertParticipant(ride, session);

    if (ride.status !== 'requested' && ride.status !== 'negotiating') {
      throw new IntentDeniedError(
        'stale_state',
        `This ride is "${ride.status}" and no longer accepting offers.`,
      );
    }

    const now = nowIso();

    // At most one live offer at a time: making a new offer implicitly withdraws
    // the previous one, which is what the inDrive-style timeline shows.
    const pending = await this.env.DB.prepare(
      "SELECT * FROM ride_offers WHERE ride_id = ? AND status = 'pending'",
    )
      .bind(ride.id)
      .all<OfferRow>();

    if (pending.results.length > 0) {
      await this.env.DB.prepare(
        "UPDATE ride_offers SET status = 'superseded', resolved_at = ? WHERE ride_id = ? AND status = 'pending'",
      )
        .bind(now, ride.id)
        .run();
    }

    const offer: RideOffer = {
      id: newId('off'),
      rideId: ride.id,
      fromUserId: session.userId,
      fromRole: session.role,
      price,
      message,
      status: 'pending',
      createdAt: now,
      resolvedAt: null,
    };

    await this.env.DB.prepare(
      `INSERT INTO ride_offers (id, ride_id, from_user_id, from_role, price, message, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
      .bind(offer.id, offer.rideId, offer.fromUserId, offer.fromRole, offer.price, offer.message, offer.createdAt)
      .run();

    let statusChanged = false;
    if (ride.status === 'requested') {
      await this.applyStatus(ride, 'negotiating', session.role, now);
      statusChanged = true;
    }

    await this.recordEvent(ride.id, 'offer.created', { offerId: offer.id, price, role: session.role });

    for (const row of pending.results) {
      this.broadcast({
        type: 'offer.updated',
        offer: mapOfferRow({ ...row, status: 'superseded', resolved_at: now }),
      });
    }
    this.broadcast({ type: 'offer.created', offer });
    if (statusChanged) this.broadcastStatus(ride.id, ride.status, 'negotiating', session.role, now);

    // A bid arrives while the passenger may have the app backgrounded.
    if (session.role === 'driver') {
      this.pushToUsers([ride.passengerId], {
        title: 'New offer',
        body: `A driver offered ${price}. Open FairRide to respond.`,
        data: { rideId: ride.id, status: 'negotiating' },
      });
    }

    await this.scheduleNegotiationTimeout(ride.id);
  }

  private async onResolveOffer(session: Session, offerId: string, accept: boolean): Promise<void> {
    const ride = await this.requireRide();
    this.assertParticipant(ride, session);

    if (ride.status !== 'requested' && ride.status !== 'negotiating') {
      throw new IntentDeniedError('stale_state', `This ride is "${ride.status}".`);
    }

    const row = await this.env.DB.prepare('SELECT * FROM ride_offers WHERE id = ? AND ride_id = ?')
      .bind(offerId, ride.id)
      .first<OfferRow>();

    if (!row) throw new IntentDeniedError('stale_state', 'That offer no longer exists.');
    if (row.status !== 'pending') {
      throw new IntentDeniedError('stale_state', 'That offer has already been resolved.');
    }
    if (row.from_user_id === session.userId) {
      throw new IntentDeniedError('forbidden', 'You cannot answer your own offer.');
    }

    const now = nowIso();

    if (!accept) {
      await this.env.DB.prepare("UPDATE ride_offers SET status = 'rejected', resolved_at = ? WHERE id = ?")
        .bind(now, offerId)
        .run();
      await this.recordEvent(ride.id, 'offer.rejected', { offerId, by: session.userId });
      this.broadcast({
        type: 'offer.updated',
        offer: mapOfferRow({ ...row, status: 'rejected', resolved_at: now }),
      });
      await this.scheduleNegotiationTimeout(ride.id);
      return;
    }

    // Accept. The offer author becomes the driver when it was a driver's counter;
    // otherwise the accepting caller is the driver taking the passenger's price.
    const driverId = row.from_role === 'driver' ? row.from_user_id : session.userId;

    await this.env.DB.prepare("UPDATE ride_offers SET status = 'accepted', resolved_at = ? WHERE id = ?")
      .bind(now, offerId)
      .run();
    await this.env.DB.prepare(
      "UPDATE ride_offers SET status = 'superseded', resolved_at = ? WHERE ride_id = ? AND status = 'pending'",
    )
      .bind(now, ride.id)
      .run();

    await this.applyStatus(ride, 'accepted', session.role, now, {
      driverId,
      finalPrice: row.price,
    });
    await this.recordEvent(ride.id, 'offer.accepted', {
      offerId,
      price: row.price,
      driverId,
      acceptedBy: session.userId,
    });

    this.broadcast({
      type: 'offer.updated',
      offer: mapOfferRow({ ...row, status: 'accepted', resolved_at: now }),
    });
    this.broadcastStatus(ride.id, ride.status, 'accepted', session.role, now);

    // Use the *post-match* ride so both parties are notified with the assigned
    // driver; the pre-match object still has `driverId: null`.
    const matched: Ride = { ...ride, driverId, finalPrice: row.price, status: 'accepted' };
    const acceptedPush = statusPush(matched, 'accepted', session.role);
    if (acceptedPush) this.pushToUsers(acceptedPush.userIds, acceptedPush.message);

    // The ride is matched: the negotiation timer is no longer meaningful.
    await this.ctx.storage.deleteAlarm();
  }

  private async onTransition(session: Session, to: RideStatus): Promise<void> {
    const ride = await this.requireRide();
    this.assertParticipant(ride, session);

    if (to === 'cancelled' && session.role === 'driver' && ride.driverId !== session.userId) {
      throw new IntentDeniedError('forbidden', 'Only the assigned driver can cancel this ride.');
    }

    const now = nowIso();
    await this.applyStatus(ride, to, session.role, now, {
      cancelledBy: to === 'cancelled' ? session.userId : undefined,
      reason: to === 'cancelled' ? `Cancelled by ${session.role}.` : undefined,
    });
    await this.recordEvent(ride.id, 'ride.status_changed', { from: ride.status, to, by: session.userId });

    this.broadcastStatus(ride.id, ride.status, to, session.role, now);

    const statusNotification = statusPush({ ...ride, status: to }, to, session.role);
    if (statusNotification) this.pushToUsers(statusNotification.userIds, statusNotification.message);

    await this.scheduleNegotiationTimeout(ride.id);
  }

  private async onDriverLocation(session: Session, lat: number, lng: number): Promise<void> {
    const ride = await this.requireRide();

    if (session.role !== 'driver' || ride.driverId !== session.userId) {
      throw new IntentDeniedError('forbidden', 'Only the assigned driver may publish location.');
    }

    const now = nowIso();
    const nowMs = Date.now();
    const lastWrite = (await this.ctx.storage.get<number>('lastLocationWrite')) ?? 0;

    // Broadcast every update (the map should be smooth) but only persist on a
    // slow cadence. Hammering D1 every 3s per ride is the fastest way to a
    // surprising invoice.
    if (nowMs - lastWrite >= LOCATION_WRITE_INTERVAL_MS) {
      await this.env.DB.prepare(
        'UPDATE drivers SET current_lat = ?, current_lng = ?, last_location_update = ? WHERE user_id = ?',
      )
        .bind(lat, lng, now, session.userId)
        .run();
      await this.ctx.storage.put('lastLocationWrite', nowMs);
    }

    this.broadcast({
      type: 'driver.location',
      rideId: ride.id,
      driverId: session.userId,
      lat,
      lng,
      at: now,
    });
  }

  private async onChat(session: Session, text: string): Promise<void> {
    const ride = await this.requireRide();
    this.assertParticipant(ride, session);

    const message: ChatMessage = {
      id: newId('msg'),
      rideId: ride.id,
      userId: session.userId,
      role: session.role,
      text,
      at: nowIso(),
    };

    await this.env.DB.prepare(
      'INSERT INTO chat_messages (id, ride_id, user_id, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(message.id, message.rideId, message.userId, message.role, message.text, message.at)
      .run();

    this.broadcast({ type: 'chat.message', message });
  }

  /* ---------------------------------------------------------------- *
   * State machine plumbing
   * ---------------------------------------------------------------- */

  /**
   * The only place a ride's status changes.
   *
   * Validates the transition against the shared table *and* the cross-field
   * invariants, writes D1, then hands back the updated ride. Anything that
   * needs to move a ride goes through here, so an invalid transition cannot be
   * persisted even if a future handler forgets to check.
   */
  private async applyStatus(
    ride: Ride,
    to: RideStatus,
    actor: ActorRole,
    at: string,
    extras: StatusExtras = {},
  ): Promise<Ride> {
    assertTransition(ride.status, to, actor);

    const next: Ride = {
      ...ride,
      status: to,
      driverId: extras.driverId !== undefined ? extras.driverId : ride.driverId,
      finalPrice: extras.finalPrice !== undefined ? extras.finalPrice : ride.finalPrice,
    };

    assertRideInvariants({
      status: next.status,
      driverId: next.driverId,
      finalPrice: next.finalPrice,
      passengerProposedPrice: next.passengerProposedPrice,
    });

    const sets = ['status = ?', 'version = version + 1'];
    const bindings: unknown[] = [to];

    const column = STATUS_TIMESTAMP_COLUMN[to];
    if (column) {
      sets.push(`${column} = ?`);
      bindings.push(at);
    }
    if (extras.driverId !== undefined) {
      sets.push('driver_id = ?');
      bindings.push(extras.driverId);
    }
    if (extras.finalPrice !== undefined) {
      sets.push('final_price = ?');
      bindings.push(extras.finalPrice);
    }
    if (extras.cancelledBy !== undefined) {
      sets.push('cancelled_by = ?');
      bindings.push(extras.cancelledBy);
    }
    if (extras.reason !== undefined) {
      sets.push('cancellation_reason = ?');
      bindings.push(extras.reason);
    }
    bindings.push(ride.id);

    await this.env.DB.prepare(`UPDATE rides SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...bindings)
      .run();

    return next;
  }

  private async scheduleNegotiationTimeout(rideId: string): Promise<void> {
    const ride = await this.loadRide();
    if (!ride || ride.id !== rideId) return;
    if (ride.status === 'requested' || ride.status === 'negotiating') {
      await this.ctx.storage.setAlarm(Date.now() + NEGOTIATION_TTL_MS);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  /* ---------------------------------------------------------------- *
   * Data access
   * ---------------------------------------------------------------- */

  private async loadRide(): Promise<Ride | null> {
    const rideId = this.rideId();
    const row = await this.env.DB.prepare('SELECT * FROM rides WHERE id = ?').bind(rideId).first<RideRow>();
    return row ? mapRideRow(row) : null;
  }

  private async requireRide(): Promise<Ride> {
    const ride = await this.loadRide();
    if (!ride) throw new IntentDeniedError('ride_not_found', 'This ride does not exist.');
    return ride;
  }

  private async loadOffers(): Promise<RideOffer[]> {
    const { results } = await this.env.DB.prepare(
      'SELECT * FROM ride_offers WHERE ride_id = ? ORDER BY created_at ASC',
    )
      .bind(this.rideId())
      .all<OfferRow>();
    return results.map(mapOfferRow);
  }

  private async recordEvent(rideId: string, eventType: string, payload: unknown): Promise<void> {
    await this.env.DB.prepare(
      'INSERT INTO ride_events (id, ride_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(newId('evt'), rideId, eventType, JSON.stringify(payload), nowIso())
      .run();
  }

  /* ---------------------------------------------------------------- *
   * Room helpers
   * ---------------------------------------------------------------- */

  /** The Durable Object's name is the ride id, set by `getByName(rideId)`. */
  private rideId(): string {
    return this.ctx.id.name ?? '';
  }

  private isParticipant(ride: Ride, session: Session): boolean {
    if (session.role === 'admin') return true;
    if (session.userId === ride.passengerId) return true;
    // Before a match, any driver may be in the room: that is the point - they
    // are the ones being asked to bid.
    if (session.role === 'driver') return ride.driverId === null || ride.driverId === session.userId;
    return false;
  }

  private assertParticipant(ride: Ride, session: Session): void {
    if (!this.isParticipant(ride, session)) {
      throw new IntentDeniedError('not_participant', 'You are not part of this ride.');
    }
  }

  private consumeToken(ws: WebSocket): boolean {
    const bucket = this.buckets.get(ws);
    const now = Date.now();
    if (!bucket) {
      this.buckets.set(ws, { tokens: MAX_INTENTS_PER_WINDOW, updatedAt: now });
      return true;
    }
    const elapsed = now - bucket.updatedAt;
    if (elapsed > INTENT_WINDOW_MS) {
      bucket.tokens = MAX_INTENTS_PER_WINDOW;
      bucket.updatedAt = now;
    }
    if (bucket.tokens <= 0) return false;
    bucket.tokens -= 1;
    return true;
  }

  private broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.sessions.keys()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(payload);
      } catch {
        this.dropSession(ws);
      }
    }
  }

  private send(ws: WebSocket, event: ServerEvent): void {
    try {
      ws.send(JSON.stringify(event));
    } catch {
      this.dropSession(ws);
    }
  }

  /** Sends only to sockets belonging to one user (used for `pong`). */
  private sendToUser(userId: string, event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const [ws, session] of this.sessions) {
      if (session.userId !== userId) continue;
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(payload);
      } catch {
        this.dropSession(ws);
      }
    }
  }

  private sendError(ws: WebSocket, code: RealtimeErrorCode, message: string, intentType?: string): void {
    this.send(ws, { type: 'error', code, message, ...(intentType ? { intentType } : {}) });
  }

  private broadcastStatus(
    rideId: string,
    from: RideStatus,
    to: RideStatus,
    actorRole: ActorRole,
    at: string,
  ): void {
    this.broadcast({ type: 'ride.status_changed', rideId, from, to, actorRole, at });
  }

  private dropSession(ws: WebSocket): void {
    this.sessions.delete(ws);
    this.buckets.delete(ws);
  }

  /*
   * Push notifications.
   *
   * Fired via `waitUntil` so an FCM round-trip never delays the WebSocket
   * broadcast the user is watching, and a delivery failure can never fail the
   * ride operation. Best-effort by design.
   */
  private pushToUsers(userIds: readonly string[], message: PushMessage): void {
    if (userIds.length === 0) return;
    this.ctx.waitUntil(
      notifyUsers(this.env, userIds, message).catch((error) => {
        console.error('ride_room.push_failed', {
          rideId: this.ctx.id.toString(),
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  }
}
