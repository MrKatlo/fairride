/**
 * Ride lifecycle: statuses, actors, and the transition table.
 *
 * This module is the single source of truth for what a ride is allowed to do.
 * It is deliberately dependency-free so it can run in a Worker, a Durable
 * Object, React Native, and the admin panel without change.
 *
 * Rule of thumb: never mutate `ride.status` directly. Route every change
 * through `assertTransition` so the audit log and the state machine agree.
 */

export const RIDE_STATUSES = [
  'requested',
  'negotiating',
  'accepted',
  'arrived',
  'started',
  'completed',
  'cancelled',
] as const;

export type RideStatus = (typeof RIDE_STATUSES)[number];

/** Who is asking for the transition. `system` covers cron jobs, queues, and timeouts. */
export type ActorRole = 'passenger' | 'driver' | 'admin' | 'system';

export interface RideTransition {
  readonly from: RideStatus;
  readonly to: RideStatus;
  /** Roles permitted to trigger this transition. */
  readonly actors: readonly ActorRole[];
}

/**
 * The complete transition table.
 *
 * Notable choices:
 * - `requested -> accepted` allows a driver to take the passenger's price with
 *   no counter round (the common fast path).
 * - `negotiating -> negotiating` is a re-entry edge: each new counter-offer
 *   stays inside the negotiating state rather than creating a new one.
 * - `negotiating -> requested` lets a ride reopen for matching when every
 *   offer is declined or expires.
 * - `started -> cancelled` is admin/system only; mid-trip cancellation is an
 *   incident, not a normal user action.
 */
export const RIDE_TRANSITIONS: readonly RideTransition[] = [
  { from: 'requested', to: 'negotiating', actors: ['passenger', 'driver', 'system'] },
  { from: 'requested', to: 'accepted', actors: ['passenger', 'driver', 'system'] },
  { from: 'requested', to: 'cancelled', actors: ['passenger', 'admin', 'system'] },
  { from: 'negotiating', to: 'negotiating', actors: ['passenger', 'driver'] },
  { from: 'negotiating', to: 'accepted', actors: ['passenger', 'driver'] },
  { from: 'negotiating', to: 'requested', actors: ['passenger', 'system'] },
  { from: 'negotiating', to: 'cancelled', actors: ['passenger', 'admin', 'system'] },
  { from: 'accepted', to: 'arrived', actors: ['driver', 'system'] },
  { from: 'accepted', to: 'cancelled', actors: ['passenger', 'driver', 'admin', 'system'] },
  { from: 'arrived', to: 'started', actors: ['driver'] },
  { from: 'arrived', to: 'cancelled', actors: ['passenger', 'driver', 'admin', 'system'] },
  { from: 'started', to: 'completed', actors: ['driver'] },
  { from: 'started', to: 'cancelled', actors: ['admin', 'system'] },
];

/** Statuses with no outgoing edges. */
export const TERMINAL_STATUSES = ['completed', 'cancelled'] as const satisfies readonly RideStatus[];

export function isTerminalStatus(status: RideStatus): boolean {
  return (TERMINAL_STATUSES as readonly RideStatus[]).includes(status);
}

/** Statuses from which a passenger can still walk away without a completed trip. */
export function isActiveStatus(status: RideStatus): boolean {
  return !isTerminalStatus(status);
}

export function findTransition(from: RideStatus, to: RideStatus): RideTransition | undefined {
  return RIDE_TRANSITIONS.find((t) => t.from === from && t.to === to);
}

export function canTransition(from: RideStatus, to: RideStatus, actor: ActorRole): boolean {
  const rule = findTransition(from, to);
  return rule !== undefined && rule.actors.includes(actor);
}

/** All statuses `actor` can move to from `from`. Handy for UI action buttons. */
export function allowedTransitions(from: RideStatus, actor: ActorRole): RideStatus[] {
  return RIDE_TRANSITIONS.filter((t) => t.from === from && t.actors.includes(actor)).map((t) => t.to);
}

export function assertTransition(from: RideStatus, to: RideStatus, actor: ActorRole): void {
  const rule = findTransition(from, to);
  if (!rule) {
    throw new InvalidTransitionError(from, to, actor, 'no such transition exists');
  }
  if (!rule.actors.includes(actor)) {
    throw new InvalidTransitionError(from, to, actor, `actor "${actor}" may not trigger it`);
  }
}

/**
 * Cross-field invariants that the transition table cannot express.
 * Called by the Durable Object before it persists a new status.
 */
export function assertRideInvariants(ride: {
  status: RideStatus;
  driverId: string | null;
  finalPrice: number | null;
  passengerProposedPrice: number | null;
}): void {
  const { status, driverId, finalPrice, passengerProposedPrice } = ride;

  if (status === 'requested' && passengerProposedPrice === null) {
    throw new RideInvariantError('a requested ride must carry a passenger proposed price');
  }
  if ((status === 'accepted' || status === 'arrived' || status === 'started') && driverId === null) {
    throw new RideInvariantError(`a ride in status "${status}" must have a driver`);
  }
  if ((status === 'accepted' || status === 'arrived' || status === 'started') && finalPrice === null) {
    throw new RideInvariantError(`a ride in status "${status}" must have an agreed price`);
  }
  if (status === 'completed' && (driverId === null || finalPrice === null)) {
    throw new RideInvariantError('a completed ride must have a driver and a final price');
  }
}

export class InvalidTransitionError extends Error {
  readonly from: RideStatus;
  readonly to: RideStatus;
  readonly actor: ActorRole;

  constructor(from: RideStatus, to: RideStatus, actor: ActorRole, why: string) {
    super(`Invalid ride transition ${from} -> ${to} by ${actor}: ${why}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
    this.actor = actor;
  }
}

export class RideInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RideInvariantError';
  }
}
