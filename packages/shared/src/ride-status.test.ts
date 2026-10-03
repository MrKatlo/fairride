import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  InvalidTransitionError,
  RIDE_STATUSES,
  RIDE_TRANSITIONS,
  RideInvariantError,
  allowedTransitions,
  assertRideInvariants,
  assertTransition,
  canTransition,
  isTerminalStatus,
} from './ride-status.ts';

describe('ride state machine', () => {
  it('marks completed and cancelled as terminal', () => {
    assert.equal(isTerminalStatus('completed'), true);
    assert.equal(isTerminalStatus('cancelled'), true);
    assert.equal(isTerminalStatus('started'), false);
  });

  it('every listed status appears in the transition table', () => {
    for (const status of RIDE_STATUSES) {
      const appears = RIDE_TRANSITIONS.some((t) => t.from === status || t.to === status);
      assert.ok(appears, `status "${status}" is unreachable and unused`);
    }
  });

  it('never lets a terminal status move anywhere', () => {
    for (const status of ['completed', 'cancelled'] as const) {
      for (const other of RIDE_STATUSES) {
        assert.equal(canTransition(status, other, 'system'), false);
      }
    }
  });

  it('allows the fast path: requested -> accepted by a driver', () => {
    assert.equal(canTransition('requested', 'accepted', 'driver'), true);
  });

  it('does not let a driver cancel a ride that is in progress', () => {
    assert.equal(canTransition('started', 'cancelled', 'driver'), false);
    assert.equal(canTransition('started', 'cancelled', 'admin'), true);
  });

  it('does not let a passenger mark a ride started', () => {
    assert.equal(canTransition('arrived', 'started', 'passenger'), false);
    assert.equal(canTransition('arrived', 'started', 'driver'), true);
  });

  it('throws a descriptive error for an impossible transition', () => {
    assert.throws(
      () => assertTransition('completed', 'started', 'driver'),
      (error: unknown) => {
        assert.ok(error instanceof InvalidTransitionError);
        assert.equal(error.from, 'completed');
        assert.equal(error.to, 'started');
        return true;
      },
    );
  });

  it('reports the actions available to an actor', () => {
    assert.deepEqual(allowedTransitions('accepted', 'driver').sort(), ['arrived', 'cancelled']);
    assert.deepEqual(allowedTransitions('completed', 'admin'), []);
  });
});

describe('ride invariants', () => {
  it('requires a proposed price on a requested ride', () => {
    assert.throws(
      () =>
        assertRideInvariants({
          status: 'requested',
          driverId: null,
          finalPrice: null,
          passengerProposedPrice: null,
        }),
      RideInvariantError,
    );
  });

  it('requires a driver and an agreed price once accepted', () => {
    assert.throws(
      () =>
        assertRideInvariants({
          status: 'accepted',
          driverId: null,
          finalPrice: 12,
          passengerProposedPrice: 12,
        }),
      RideInvariantError,
    );
    assert.throws(
      () =>
        assertRideInvariants({
          status: 'accepted',
          driverId: 'drv_1',
          finalPrice: null,
          passengerProposedPrice: 12,
        }),
      RideInvariantError,
    );
  });

  it('accepts a well-formed accepted ride', () => {
    assert.doesNotThrow(() =>
      assertRideInvariants({
        status: 'accepted',
        driverId: 'drv_1',
        finalPrice: 12,
        passengerProposedPrice: 10,
      }),
    );
  });
});
