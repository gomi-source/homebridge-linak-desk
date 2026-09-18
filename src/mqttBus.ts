import type { Logging } from 'homebridge';
import type { IClientOptions, MqttClient } from 'mqtt';

import mqtt from 'mqtt';

import type { MqttSettings } from './config.js';

export type MessageHandler = (payload: string) => void;

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A thin wrapper around the MQTT client. It keeps one broker subscription per
 * topic no matter how many accessories are interested, re-subscribes after a
 * reconnect, and never throws at its callers: a broker that is down surfaces as
 * accessories going "not responding", not as an unhandled rejection.
 */
export class MqttBus {
  private client?: MqttClient;
  private readonly handlers = new Map<string, Set<MessageHandler>>();
  private readonly connectionListeners = new Set<(connected: boolean) => void>();
  private connectedState = false;
  private stopped = false;
  private reportedOffline = false;

  constructor(
    private readonly settings: MqttSettings,
    private readonly log: Logging,
  ) {}

  get connected(): boolean {
    return this.connectedState;
  }

  /**
   * Opens the connection. The client retries on its own, so this never rejects
   * and the platform keeps running while the broker is unavailable.
   */
  start(): void {
    const options: IClientOptions = {
      clientId: this.settings.clientId,
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 15000,
      // Subscriptions are re-issued from `handlers` on every connect instead,
      // so a topic added while the broker was down is not missed.
      resubscribe: false,
    };
    if (this.settings.username !== undefined) {
      options.username = this.settings.username;
    }
    if (this.settings.password !== undefined) {
      options.password = this.settings.password;
    }

    this.log.info(`Connecting to MQTT broker at ${this.settings.url}`);

    let client: MqttClient;
    try {
      client = mqtt.connect(this.settings.url, options);
    } catch (error) {
      this.log.error(`Could not create the MQTT client: ${describe(error)}. No desks will be controllable.`);
      return;
    }
    this.client = client;

    client.on('connect', () => {
      this.reportedOffline = false;
      this.log.info('Connected to the MQTT broker.');
      for (const topic of this.handlers.keys()) {
        this.subscribeOnBroker(topic);
      }
      this.setConnected(true);
    });

    client.on('reconnect', () => {
      this.log.debug('Reconnecting to the MQTT broker.');
    });

    client.on('close', () => {
      this.setConnected(false);
      if (!this.stopped && !this.reportedOffline) {
        this.reportedOffline = true;
        this.log.warn('Lost the connection to the MQTT broker, retrying.');
      }
    });

    client.on('error', error => {
      // The client reconnects by itself; log once per outage so a broker that
      // is down overnight does not fill the log.
      if (!this.reportedOffline) {
        this.reportedOffline = true;
        this.log.error(`MQTT error: ${describe(error)}`);
      } else {
        this.log.debug(`MQTT error: ${describe(error)}`);
      }
    });

    client.on('message', (topic, payload) => {
      const listeners = this.handlers.get(topic);
      if (listeners === undefined) {
        return;
      }
      const text = payload.toString('utf8').trim();
      this.log.debug(`<- ${topic} ${text}`);
      for (const listener of listeners) {
        try {
          listener(text);
        } catch (error) {
          this.log.error(`Handling a message on ${topic} failed: ${describe(error)}`);
        }
      }
    });
  }

  onConnectionChange(listener: (connected: boolean) => void): void {
    this.connectionListeners.add(listener);
  }

  subscribe(topic: string, handler: MessageHandler): void {
    const existing = this.handlers.get(topic);
    if (existing !== undefined) {
      existing.add(handler);
      return;
    }
    this.handlers.set(topic, new Set([handler]));
    if (this.connectedState) {
      this.subscribeOnBroker(topic);
    }
  }

  publish(topic: string, payload: string): boolean {
    const client = this.client;
    if (client === undefined || !this.connectedState) {
      this.log.warn(`Not connected to the MQTT broker, dropping publish to ${topic}.`);
      return false;
    }
    client.publish(topic, payload, { qos: 1, retain: false }, error => {
      if (error) {
        this.log.error(`Publishing to ${topic} failed: ${describe(error)}`);
      }
    });
    this.log.debug(`-> ${topic} ${payload}`);
    return true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const client = this.client;
    this.client = undefined;
    this.setConnected(false);
    if (client === undefined) {
      return;
    }
    await new Promise<void>(resolve => client.end(true, undefined, () => resolve()));
  }

  private subscribeOnBroker(topic: string): void {
    this.client?.subscribe(topic, { qos: 1 }, error => {
      if (error) {
        this.log.error(`Subscribing to ${topic} failed: ${describe(error)}`);
      } else {
        this.log.debug(`Subscribed to ${topic}`);
      }
    });
  }

  private setConnected(connected: boolean): void {
    if (this.connectedState === connected) {
      return;
    }
    this.connectedState = connected;
    for (const listener of this.connectionListeners) {
      try {
        listener(connected);
      } catch (error) {
        this.log.error(`An MQTT connection listener threw: ${describe(error)}`);
      }
    }
  }
}
