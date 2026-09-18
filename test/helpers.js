/**
 * Minimal stand-ins for the Homebridge logger and the MQTT bus, so the pure
 * logic can be tested without a broker or a running Homebridge.
 */

export function fakeLog() {
  const lines = { info: [], warn: [], error: [], debug: [], log: [] };
  const log = (...args) => lines.log.push(args.join(' '));
  log.info = (...args) => lines.info.push(args.join(' '));
  log.warn = (...args) => lines.warn.push(args.join(' '));
  log.error = (...args) => lines.error.push(args.join(' '));
  log.debug = (...args) => lines.debug.push(args.join(' '));
  log.success = (...args) => lines.info.push(args.join(' '));
  log.lines = lines;
  return log;
}

export class FakeBus {
  constructor() {
    this.connected = true;
    this.published = [];
    this.handlers = new Map();
    this.connectionListeners = [];
  }

  onConnectionChange(listener) {
    this.connectionListeners.push(listener);
  }

  setConnected(connected) {
    this.connected = connected;
    for (const listener of this.connectionListeners) {
      listener(connected);
    }
  }

  subscribe(topic, handler) {
    const existing = this.handlers.get(topic);
    if (existing === undefined) {
      this.handlers.set(topic, [handler]);
    } else {
      existing.push(handler);
    }
  }

  /** Simulates a retained or live message arriving from the broker. */
  deliver(topic, payload) {
    for (const handler of this.handlers.get(topic) ?? []) {
      handler(String(payload));
    }
  }

  publish(topic, payload) {
    if (!this.connected) {
      return false;
    }
    this.published.push({ topic, payload });
    return true;
  }

  get lastPublished() {
    return this.published[this.published.length - 1];
  }
}

export const MQTT_SETTINGS = {
  url: 'mqtt://localhost:1883',
  clientId: 'test',
  commandTopicBase: 'linak/cmd',
  metricTopicBase: 'linak/desk',
  useAvailability: true,
};

export function deskConfig(overrides = {}) {
  return {
    id: 'office',
    name: 'Office Desk',
    minHeightMm: 620,
    maxHeightMm: 1270,
    toleranceMm: 10,
    moveTimeoutMs: 200,
    settleMs: 20,
    favourites: [],
    ...overrides,
  };
}
