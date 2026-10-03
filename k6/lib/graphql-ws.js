// A graphql-transport-ws client for k6, on the built-in `k6/websockets` module (ticket 022).
//
// The protocol is five message types and a ping: `connection_init` answered by
// `connection_ack`, then `subscribe` producing `next`/`error`/`complete` per operation id, and
// `ping`/`pong` in either direction. The odb serializes operations per socket, which is why
// Observe's server keeps one for its reads and why a subscriber's eight subscriptions share one.
//
// Everything is promise based so a VU can hold a socket for a whole session and still do
// other things: `k6/ws` would block the VU inside its callback. Operations come only from
// lib/odb-operations.js; a one-shot `query` is judged and measured exactly like `gql` does
// over HTTP, so the two transports land in the same trends under the same operation tag.
import { check } from "k6";
import { WebSocket } from "k6/websockets";
import { OPERATION_KIND } from "../../lib/odb-operations.js";
import { endpoints } from "./config.js";
import {
  graphqlErrors,
  readDuration,
  tags,
  writeDuration,
  wsConnections,
  wsMessages,
  wsPing,
  wsReconnects,
  wsUnansweredPings,
} from "./metrics.js";

const PROTOCOL = "graphql-transport-ws";

/**
 * @typedef {object} ClientOptions
 * @property {string} scenario the scenario label every sample carries
 * @property {number} [pingIntervalMs] our own ping cadence; 0 disables it (default 15 s)
 * @property {number} [pingTimeoutMs] a pong later than this counts as unanswered (default 10 s)
 * @property {boolean} [reconnect] reconnect and resubscribe after a drop (default true)
 * @property {number} [maxBackoffMs] reconnect backoff cap (default 10 s)
 * @property {number} [connectTimeoutMs] how long to wait for connection_ack (default 20 s)
 */

export class GraphqlWsClient {
  /**
   * @param {{token: string}} session
   * @param {ClientOptions} opts
   */
  constructor(session, opts) {
    this.session = session;
    this.scenario = opts.scenario;
    this.pingIntervalMs = opts.pingIntervalMs ?? 15000;
    this.pingTimeoutMs = opts.pingTimeoutMs ?? 10000;
    this.reconnectEnabled = opts.reconnect ?? true;
    this.maxBackoffMs = opts.maxBackoffMs ?? 10000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 20000;

    /** @type {any} */
    this.ws = null;
    this.generation = 0;
    this.nextId = 1;
    this.connected = false;
    this.closing = false;
    this.attempts = 0;
    /** @type {Map<string, {operation: any, onNext: (payload: any) => void, onError?: (errors: any[]) => void}>} */
    this.subscriptions = new Map();
    /** @type {Map<string, {operation: any, opts: any, started: number, resolve: (v: any) => void, data: any}>} */
    this.pending = new Map();
    /** @type {{sentAt: number, timer: any} | null} */
    this.pingInFlight = null;
    this.pingTimer = null;
    /** @type {null | Promise<void>} */
    this.connecting = null;
  }

  /** Open the socket and complete the handshake; resolves once the server acknowledged. */
  connect() {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** @private */
  open() {
    this.closing = false;
    const generation = ++this.generation;
    const ws = new WebSocket(endpoints.odbWsUrl, [PROTOCOL], {
      tags: tags({ scenario: this.scenario, operation: "websocket" }),
    });
    this.ws = ws;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`no connection_ack within ${this.connectTimeoutMs} ms`));
        this.dropped(generation, "handshake timeout");
      }, this.connectTimeoutMs);

      ws.onopen = () => {
        if (generation !== this.generation) return;
        ws.send(
          JSON.stringify({
            type: "connection_init",
            payload: { Authorization: `Bearer ${this.session.token}` },
          }),
        );
      };
      ws.onmessage = (event) => {
        if (generation !== this.generation) return;
        const message = parse(event.data);
        if (!message) return;
        wsMessages.add(1, tags({ scenario: this.scenario, operation: message.type || "unknown" }));
        if (message.type === "connection_ack") {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.connected = true;
          this.attempts = 0;
          wsConnections.add(1, tags({ scenario: this.scenario }));
          this.startPinging();
          this.resubscribe();
          resolve();
          return;
        }
        this.dispatch(message);
      };
      ws.onerror = (event) => {
        if (generation !== this.generation) return;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`websocket error: ${describe(event)}`));
        }
        this.dropped(generation, "error");
      };
      ws.onclose = () => {
        if (generation !== this.generation) return;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("websocket closed before connection_ack"));
        }
        this.dropped(generation, "close");
      };
    });
  }

  /**
   * Hold a subscription; `onNext` receives each event's payload (`{data}`), `onError` the
   * server's errors for it. Survives reconnects: the subscription is re-sent with a new id.
   *
   * @param {import('../../lib/odb-operations.js').Operation} operation
   * @param {(data: any) => void} onNext
   * @param {{onError?: (errors: any[]) => void}} [handlers]
   * @returns {{id: string, complete: () => void}}
   */
  subscribe(operation, onNext, handlers = {}) {
    const id = String(this.nextId++);
    this.subscriptions.set(id, { operation, onNext, onError: handlers.onError });
    if (this.connected) this.send(id, operation);
    return {
      id,
      complete: () => {
        this.subscriptions.delete(id);
        if (this.connected) this.ws.send(JSON.stringify({ id, type: "complete" }));
      },
    };
  }

  /**
   * One request over the socket, resolved with the `data` payload or undefined on failure,
   * recorded like {@link gql}: a check named after the operation, odb_graphql_errors on
   * failure (status `ws-error` for GraphQL errors, `ws-closed` for a socket lost mid-flight),
   * and the read or write trend tagged with the operation.
   *
   * @param {import('../../lib/odb-operations.js').Operation} operation
   * @param {{measure?: boolean, tolerate?: string[]}} [opts]
   * @returns {Promise<any | undefined>}
   */
  async query(operation, opts = {}) {
    if (!this.connected) {
      try {
        await this.connect();
      } catch (error) {
        this.record(operation, opts, { ok: false, status: "ws-closed", started: Date.now() });
        return undefined;
      }
    }
    const id = String(this.nextId++);
    return new Promise((resolve) => {
      this.pending.set(id, { operation, opts, started: Date.now(), resolve, data: undefined });
      this.send(id, operation);
    });
  }

  /**
   * Our own ping; resolves with the round trip in ms, or undefined when no pong arrived in
   * time (also counted in odb_ws_unanswered_pings).
   * @returns {Promise<number | undefined>}
   */
  ping() {
    if (!this.connected || this.pingInFlight) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const sentAt = Date.now();
      const timer = setTimeout(() => {
        if (this.pingInFlight && this.pingInFlight.sentAt === sentAt) {
          this.pingInFlight = null;
          wsUnansweredPings.add(1, tags({ scenario: this.scenario }));
          resolve(undefined);
        }
      }, this.pingTimeoutMs);
      this.pingInFlight = { sentAt, timer, resolve };
      this.ws.send(JSON.stringify({ type: "ping" }));
    });
  }

  /** Complete every subscription, close the socket, and stay closed. */
  close() {
    this.closing = true;
    this.stopPinging();
    if (this.connected) {
      for (const id of this.subscriptions.keys()) {
        this.ws.send(JSON.stringify({ id, type: "complete" }));
      }
    }
    this.subscriptions.clear();
    this.failPending("ws-closed");
    this.connected = false;
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch (_error) {
        // already gone
      }
    }
  }

  /** Close the socket without completing anything: a tab closed, a laptop lid shut. */
  drop() {
    this.closing = true;
    this.stopPinging();
    this.subscriptions.clear();
    this.failPending("ws-closed");
    this.connected = false;
    if (this.ws) {
      try {
        this.ws.close(1001);
      } catch (_error) {
        // already gone
      }
    }
  }

  // --- internals ---------------------------------------------------------------------------

  /** @private */
  send(id, operation) {
    this.ws.send(
      JSON.stringify({
        id,
        type: "subscribe",
        payload: {
          operationName: operation.operationName,
          query: operation.query,
          variables: operation.variables,
        },
      }),
    );
  }

  /** @private */
  dispatch(message) {
    switch (message.type) {
      case "ping":
        this.ws.send(JSON.stringify({ type: "pong", payload: message.payload }));
        return;
      case "pong": {
        const inFlight = this.pingInFlight;
        if (inFlight) {
          this.pingInFlight = null;
          clearTimeout(inFlight.timer);
          const ms = Date.now() - inFlight.sentAt;
          wsPing.add(ms, tags({ scenario: this.scenario }));
          inFlight.resolve(ms);
        }
        return;
      }
      case "next": {
        const pending = this.pending.get(message.id);
        if (pending) {
          // A query over the socket answers with one `next` then `complete`; judge the `next`.
          pending.data = message.payload;
          return;
        }
        const subscription = this.subscriptions.get(message.id);
        if (subscription) subscription.onNext(message.payload);
        return;
      }
      case "error": {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          this.settle(pending, { data: undefined, errors: message.payload });
          return;
        }
        const subscription = this.subscriptions.get(message.id);
        if (subscription) {
          graphqlErrors.add(
            1,
            tags({ scenario: this.scenario, operation: subscription.operation.operationName, status: "ws-error" }),
          );
          if (subscription.onError) subscription.onError(message.payload);
        }
        return;
      }
      case "complete": {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          this.settle(pending, pending.data || { data: undefined, errors: [{ message: "completed without data" }] });
        }
        return;
      }
      default:
        return;
    }
  }

  /** @private */
  settle(pending, payload) {
    const { operation, opts } = pending;
    const errors = payload && payload.errors;
    const data = payload && payload.data;
    const tolerated =
      !!errors &&
      errors.length > 0 &&
      !!opts.tolerate &&
      errors.every((e) => opts.tolerate.some((tag) => JSON.stringify(e).includes(tag)));
    const ok = tolerated || (!errors && data !== undefined);
    this.record(operation, opts, { ok, status: ok ? "ok" : "ws-error", started: pending.started, errors });
    pending.resolve(ok ? (tolerated ? PENDING_WS : data) : undefined);
  }

  /** @private */
  record(operation, opts, { ok, status, started, errors }) {
    const kind = OPERATION_KIND[operation.operationName] || "read";
    check(null, { [`${operation.operationName} succeeded`]: () => ok });
    if (!ok) {
      graphqlErrors.add(1, tags({ scenario: this.scenario, operation: operation.operationName, status }));
      warnOnce(operation.operationName, status, errors);
    }
    if (opts.measure !== false) {
      const trend = kind === "write" ? writeDuration : readDuration;
      trend.add(
        Date.now() - started,
        tags({ scenario: this.scenario, operation: operation.operationName, status: ok ? "ok" : "error" }),
      );
    }
  }

  /** @private */
  failPending(status) {
    for (const pending of this.pending.values()) {
      this.record(pending.operation, pending.opts, { ok: false, status, started: pending.started });
      pending.resolve(undefined);
    }
    this.pending.clear();
  }

  /** @private */
  resubscribe() {
    for (const [id, subscription] of this.subscriptions) this.send(id, subscription.operation);
  }

  /** @private */
  dropped(generation, reason) {
    if (generation !== this.generation) return;
    const wasConnected = this.connected;
    this.connected = false;
    this.stopPinging();
    this.failPending("ws-closed");
    if (this.closing || !this.reconnectEnabled) return;
    if (!wasConnected && this.attempts === 0) return; // the first connect failed; the caller decides
    // Reconnect with backoff, keeping the subscriptions to re-send after the handshake.
    this.attempts += 1;
    const delay = Math.min(this.maxBackoffMs, 500 * 2 ** Math.min(this.attempts, 5));
    wsReconnects.add(1, tags({ scenario: this.scenario, status: reason }));
    setTimeout(() => {
      if (this.closing) return;
      this.connect().catch(() => {
        // dropped() runs again from the failed attempt's handlers and schedules the next try
      });
    }, delay);
  }

  /** @private */
  startPinging() {
    this.stopPinging();
    if (this.pingIntervalMs <= 0) return;
    this.pingTimer = setInterval(() => {
      this.ping();
    }, this.pingIntervalMs);
  }

  /** @private */
  stopPinging() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pingInFlight) {
      clearTimeout(this.pingInFlight.timer);
      this.pingInFlight.resolve(undefined);
      this.pingInFlight = null;
    }
  }
}

/** Returned by {@link GraphqlWsClient.query} for a tolerated error, like `gql`'s PENDING. */
export const PENDING_WS = { pending: true };

/** @param {any} raw */
function parse(raw) {
  try {
    return JSON.parse(String(raw));
  } catch (_error) {
    return null;
  }
}

/** @param {any} event */
function describe(event) {
  try {
    return JSON.stringify(event).slice(0, 200);
  } catch (_error) {
    return String(event);
  }
}

/** @type {Record<string, boolean>} */
const seenFailures = {};

/**
 * @param {string} operationName
 * @param {string} status
 * @param {any[] | undefined} errors
 */
function warnOnce(operationName, status, errors) {
  const key = `${operationName}:${status}`;
  if (seenFailures[key]) return;
  seenFailures[key] = true;
  const detail = errors ? JSON.stringify(errors).slice(0, 300) : status;
  console.warn(`${operationName} over websocket failed: ${detail}`);
}
