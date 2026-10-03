import type { ChatMessage, Ride, RideOffer, RideStatus, ServerEvent } from '@fairride/shared';
import { useEffect, useMemo, useReducer, useRef } from 'react';

import { RideSocket, type RideSocketState } from '../lib/ride-socket';

interface RideRoomState {
  ride: Ride | null;
  offers: RideOffer[];
  messages: ChatMessage[];
  driverLocation: { lat: number; lng: number; at: string } | null;
  viewers: number;
  connection: RideSocketState;
  error: string | null;
}

type Action =
  | { kind: 'socket_state'; state: RideSocketState }
  | { kind: 'event'; event: ServerEvent }
  | { kind: 'clear_error' };

const initialState: RideRoomState = {
  ride: null,
  offers: [],
  messages: [],
  driverLocation: null,
  viewers: 0,
  connection: 'connecting',
  error: null,
};

function upsertOffer(offers: RideOffer[], next: RideOffer): RideOffer[] {
  const index = offers.findIndex((offer) => offer.id === next.id);
  if (index === -1) return [...offers, next];
  const copy = offers.slice();
  copy[index] = next;
  return copy;
}

function reducer(state: RideRoomState, action: Action): RideRoomState {
  if (action.kind === 'socket_state') return { ...state, connection: action.state };
  if (action.kind === 'clear_error') return { ...state, error: null };

  const { event } = action;
  switch (event.type) {
    case 'ride.snapshot':
      return {
        ...state,
        ride: event.ride,
        offers: event.offers,
        driverLocation: null,
        error: null,
      };
    case 'offer.created':
      // A new offer supersedes the previous pending ones, which the server also
      // reports; applying both keeps the timeline correct either way.
      return { ...state, offers: upsertOffer(state.offers, event.offer) };
    case 'offer.updated':
      return { ...state, offers: upsertOffer(state.offers, event.offer) };
    case 'ride.status_changed':
      return state.ride ? { ...state, ride: { ...state.ride, status: event.to } } : state;
    case 'driver.location':
      return { ...state, driverLocation: { lat: event.lat, lng: event.lng, at: event.at } };
    case 'chat.message':
      return { ...state, messages: [...state.messages, event.message] };
    case 'ride.presence':
      return { ...state, viewers: event.viewers };
    case 'error':
      return { ...state, error: event.message };
    case 'pong':
      return state;
    default:
      return state;
  }
}

/**
 * Owns the socket for one ride and exposes both the reduced state and the
 * actions a screen needs. Reconnecting is transparent: the server re-sends a
 * snapshot on every (re)connect, and the reducer replaces state from it.
 */
export function useRideRoom(rideId: string | undefined, token: string | null) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const socketRef = useRef<RideSocket | null>(null);

  useEffect(() => {
    if (!rideId || !token) return;

    const socket = new RideSocket(rideId, token, {
      onEvent: (event) => dispatch({ kind: 'event', event }),
      onStateChange: (next) => dispatch({ kind: 'socket_state', state: next }),
    });
    socketRef.current = socket;
    socket.connect();

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [rideId, token]);

  const actions = useMemo(
    () => ({
      createOffer: (price: number, message?: string) =>
        socketRef.current?.send({ type: 'offer.create', offer: message ? { price, message } : { price } }) ?? false,
      acceptOffer: (offerId: string) => socketRef.current?.send({ type: 'offer.accept', offerId }) ?? false,
      rejectOffer: (offerId: string) => socketRef.current?.send({ type: 'offer.reject', offerId }) ?? false,
      transition: (to: RideStatus) => socketRef.current?.send({ type: 'ride.transition', to }) ?? false,
      publishLocation: (lat: number, lng: number) =>
        socketRef.current?.send({ type: 'driver.location', lat, lng }) ?? false,
      sendChat: (text: string) => socketRef.current?.send({ type: 'chat.message', text }) ?? false,
      clearError: () => dispatch({ kind: 'clear_error' }),
    }),
    [],
  );

  return { ...state, ...actions };
}
