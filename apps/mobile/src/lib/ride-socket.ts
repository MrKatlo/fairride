import {
  type ClientIntent,
  type ServerEvent,
  clientIntentSchema,
  parseServerEvent,
} from '@fairride/shared';

import { WS_URL } from './config';

export type RideSocketState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface RideSocketHandlers {
  onEvent: (event: ServerEvent) => void;
  onStateChange?: (state: RideSocketState) => void;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
/** Keeps intermediaries from closing an idle socket; the DO answers with `pong`. */
const PING_INTERVAL_MS = 20_000;

/**
 * One socket == one ride room. This wraps the raw WebSocket with the things
 * every screen would otherwise reimplement: reconnection with backoff, a
 * keepalive ping, and protocol validation on both directions.
 *
 * Inbound frames are parsed with the shared schema, so a server bug surfaces as
 * an ignored frame plus an `onEvent` for the valid ones - never a crash.
 */
export class RideSocket {
  private socket: WebSocket | null = null;
  private state: RideSocketState = 'closed';
  private closedByUser = false;
  private attempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly rideId: string,
    private readonly token: string,
    private readonly handlers: RideSocketHandlers,
  ) {}

  connect(): void {
    this.closedByUser = false;
    this.openSocket();
  }

  get currentState(): RideSocketState {
    return this.state;
  }

  /** Sends an intent if the socket is open. Returns false when it was queued away. */
  send(intent: ClientIntent): boolean {
    const parsed = clientIntentSchema.safeParse(intent);
    if (!parsed.success) {
      console.warn('ride_socket.invalid_intent', parsed.error.issues);
      return false;
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(parsed.data));
    return true;
  }

  close(): void {
    this.closedByUser = true;
    this.clearTimers();
    this.setSocket(null);
    this.setState('closed');
  }

  private openSocket(): void {
    this.clearTimers();
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    const url = `${WS_URL}/v1/rides/${encodeURIComponent(this.rideId)}/ws?token=${encodeURIComponent(this.token)}`;
    const socket = new WebSocket(url);

    socket.onopen = () => {
      this.attempt = 0;
      this.setState('open');
      this.pingTimer = setInterval(() => {
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ type: 'ping' } satisfies ClientIntent));
        }
      }, PING_INTERVAL_MS);
    };

    socket.onmessage = (event: WebSocketMessageEvent) => {
      if (typeof event.data !== 'string') return;
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = parseServerEvent(raw);
      if (parsed) this.handlers.onEvent(parsed);
    };

    socket.onerror = () => {
      // `onclose` always follows an error, so reconnection is handled there.
    };

    socket.onclose = () => {
      this.clearTimers();
      if (this.closedByUser) {
        this.setState('closed');
        return;
      }
      this.scheduleReconnect();
    };

    this.setSocket(socket);
  }

  private scheduleReconnect(): void {
    this.attempt += 1;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.attempt - 1), RECONNECT_MAX_MS);
    this.setState('reconnecting');
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }

  private setSocket(socket: WebSocket | null): void {
    this.socket = socket;
  }

  private setState(state: RideSocketState): void {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onStateChange?.(state);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
  }
}
