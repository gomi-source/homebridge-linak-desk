import { EventEmitter } from 'node:events';

import type { Logging } from 'homebridge';

import type { DeskConfig, MqttSettings } from './config.js';
import type { MqttBus } from './mqttBus.js';
import { clamp, tenthsToMm } from './util.js';

export type Trend = 'up' | 'down' | 'stopped';

export interface MoveResult {
  ok: boolean;
  reason?: string;
}

const AVAILABILITY_ONLINE = 'online';
const BRIDGE_ID = 'bridge';

/**
 * How long to wait before complaining that no base height has arrived. Retained
 * messages land one topic at a time, so the height nearly always beats the base
 * height to us by a few milliseconds; warning immediately would cry wolf on
 * every single startup.
 */
const MISSING_BASE_GRACE_MS = 10000;

/**
 * Reads a metric payload. The bridge publishes a plain decimal string, but it
 * also accepts JSON on the command side, so the same shapes are tolerated here.
 */
export function parseTenths(payload: string): number | undefined {
  const trimmed = payload.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const direct = Number(trimmed);
  if (Number.isFinite(direct)) {
    return Math.round(direct);
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'number' && Number.isFinite(parsed)) {
      return Math.round(parsed);
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      for (const key of ['value', 'height', 'position', 'base_height']) {
        const candidate = record[key];
        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
          return Math.round(candidate);
        }
        if (typeof candidate === 'string' && Number.isFinite(Number(candidate))) {
          return Math.round(Number(candidate));
        }
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

/**
 * Everything this plugin knows about one desk, and the only place that talks
 * MQTT on its behalf.
 *
 * Two reference frames are in play, exactly as in the mqtt-linak bridge:
 * `height` is measured from the desk's own base and is what commands and the
 * height metric both use, while `base_height` is the distance from the floor to
 * that base. Everything the user configures — the travel limits and the
 * favourites alike — is in millimetres above the floor, so this class is where
 * the two are reconciled. Nothing can be mapped or moved until `base_height`
 * has arrived.
 *
 * Emits:
 * - `state` whenever the height, base height or reachability changed
 * - `settled` when the height has stopped changing
 */
export class DeskController extends EventEmitter {
  private heightTenths?: number;
  private baseTenths?: number;
  private deskAvailable: boolean;
  private bridgeAvailable: boolean;
  private brokerConnected = false;
  private trendState: Trend = 'stopped';
  private settleTimer?: NodeJS.Timeout;
  private missingBaseTimer?: NodeJS.Timeout;

  private readonly commandHeightTopic: string;
  private readonly metricHeightTopic: string;
  private readonly metricBaseTopic: string;
  private readonly deskAvailabilityTopic: string;
  private readonly bridgeAvailabilityTopic: string;

  constructor(
    readonly config: DeskConfig,
    private readonly bus: MqttBus,
    private readonly mqtt: MqttSettings,
    private readonly log: Logging,
  ) {
    super();
    this.setMaxListeners(0);
    this.deskAvailable = !mqtt.useAvailability;
    this.bridgeAvailable = !mqtt.useAvailability;

    this.commandHeightTopic = `${mqtt.commandTopicBase}/${config.id}/height`;
    this.metricHeightTopic = `${mqtt.metricTopicBase}/${config.id}/height`;
    this.metricBaseTopic = `${mqtt.metricTopicBase}/${config.id}/base_height`;
    this.deskAvailabilityTopic = `${mqtt.metricTopicBase}/${config.id}/availability`;
    this.bridgeAvailabilityTopic = `${mqtt.metricTopicBase}/${BRIDGE_ID}/availability`;
  }

  get id(): string {
    return this.config.id;
  }

  get name(): string {
    return this.config.name;
  }

  /** Lowest reachable height above the floor, in tenths of a millimetre. */
  private get minTenths(): number {
    return Math.round(this.config.minHeightMm * 10);
  }

  /** Highest reachable height above the floor, in tenths of a millimetre. */
  private get maxTenths(): number {
    return Math.round(this.config.maxHeightMm * 10);
  }

  /** Current height above the floor in tenths of a millimetre, once both readings are in. */
  private get floorTenths(): number | undefined {
    if (this.heightTenths === undefined || this.baseTenths === undefined) {
      return undefined;
    }
    return this.heightTenths + this.baseTenths;
  }

  /**
   * False while HomeKit should show the accessory as not responding: no broker,
   * no bridge, no desk, or not yet both of the readings a height above the
   * floor is made of.
   */
  get reachable(): boolean {
    return this.brokerConnected && this.bridgeAvailable && this.deskAvailable && this.floorTenths !== undefined;
  }

  /** Height above the floor in millimetres, or undefined until both readings have arrived. */
  get floorHeightMm(): number | undefined {
    const floor = this.floorTenths;
    return floor === undefined ? undefined : tenthsToMm(floor);
  }

  /** The configured range mapped onto the 0-100 HomeKit uses for a window covering. */
  get positionPercent(): number | undefined {
    const floor = this.floorTenths;
    if (floor === undefined) {
      return undefined;
    }
    const span = this.maxTenths - this.minTenths;
    return clamp(Math.round(((floor - this.minTenths) / span) * 100), 0, 100);
  }

  get trend(): Trend {
    return this.trendState;
  }

  /** True once the base height is known, which every floor-referenced move needs. */
  get knowsBaseHeight(): boolean {
    return this.baseTenths !== undefined;
  }

  start(): void {
    this.bus.onConnectionChange(connected => {
      this.brokerConnected = connected;
      if (!connected) {
        this.stopSettleTimer();
        this.trendState = 'stopped';
      }
      this.emit('state');
    });
    this.brokerConnected = this.bus.connected;

    this.bus.subscribe(this.metricHeightTopic, payload => this.onHeight(payload));
    this.bus.subscribe(this.metricBaseTopic, payload => this.onBaseHeight(payload));

    if (this.mqtt.useAvailability) {
      this.bus.subscribe(this.deskAvailabilityTopic, payload => {
        const available = payload.toLowerCase() === AVAILABILITY_ONLINE;
        if (available !== this.deskAvailable) {
          this.log.info(`Desk ${this.name} is ${available ? 'online' : 'offline'}.`);
        }
        this.deskAvailable = available;
        this.emit('state');
      });
      this.bus.subscribe(this.bridgeAvailabilityTopic, payload => {
        this.bridgeAvailable = payload.toLowerCase() === AVAILABILITY_ONLINE;
        this.emit('state');
      });
    }
  }

  /** Moves to a position on the configured range, as HomeKit expresses it. */
  moveToPercent(percent: number): MoveResult {
    const span = this.maxTenths - this.minTenths;
    return this.moveToFloorTenths(Math.round(this.minTenths + (clamp(percent, 0, 100) / 100) * span));
  }

  /**
   * Moves to a height above the floor. Needs the base height, and refuses
   * anything outside the configured range rather than silently going somewhere
   * else.
   */
  moveToFloorHeightMm(heightMm: number): MoveResult {
    return this.moveToFloorTenths(Math.round(heightMm * 10));
  }

  private moveToFloorTenths(target: number): MoveResult {
    if (this.baseTenths === undefined) {
      return {
        ok: false,
        reason: `the base height is not known yet (nothing retained on ${this.metricBaseTopic})`,
      };
    }

    const toleranceTenths = Math.round(this.config.toleranceMm * 10);
    if (target < this.minTenths - toleranceTenths || target > this.maxTenths + toleranceTenths) {
      return {
        ok: false,
        reason: `${tenthsToMm(target)} mm above the floor is outside this desk's configured range of `
          + `${tenthsToMm(this.minTenths)}-${tenthsToMm(this.maxTenths)} mm`,
      };
    }

    // The desk only understands heights above its own base, so this is where
    // the floor frame the user configured turns into the desk's own.
    const aboveBase = clamp(target, this.minTenths, this.maxTenths) - this.baseTenths;
    if (aboveBase < 0) {
      return {
        ok: false,
        reason: `${tenthsToMm(target)} mm above the floor is below this desk's base, which sits at `
          + `${tenthsToMm(this.baseTenths)} mm - check minHeightMm`,
      };
    }

    this.log.info(`Moving ${this.name} to ${tenthsToMm(target)} mm above the floor.`);
    return this.publishHeight(aboveBase);
  }

  isAtFloorHeightMm(heightMm: number, toleranceMm: number): boolean {
    const current = this.floorHeightMm;
    return current !== undefined && Math.abs(current - heightMm) <= toleranceMm;
  }

  /**
   * Resolves true as soon as the desk is within tolerance of the height, and
   * false if it stops somewhere else or the timeout expires. Used to confirm a
   * favourite actually arrived.
   */
  waitForFloorHeightMm(heightMm: number, toleranceMm: number, timeoutMs: number): Promise<boolean> {
    const arrived = () => this.isAtFloorHeightMm(heightMm, toleranceMm);
    if (arrived()) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>(resolve => {
      const cleanups: Array<() => void> = [];
      let finished = false;
      const finish = (value: boolean) => {
        if (finished) {
          return;
        }
        finished = true;
        for (const cleanup of cleanups) {
          cleanup();
        }
        resolve(value);
      };

      const timer = setTimeout(() => finish(arrived()), timeoutMs);
      cleanups.push(() => clearTimeout(timer));

      // Arriving is enough; the desk may creep a little further before stopping.
      const onState = () => {
        if (arrived()) {
          finish(true);
        }
      };
      this.on('state', onState);
      cleanups.push(() => this.off('state', onState));

      // Stopping anywhere else means it did not make it.
      const onSettled = () => finish(arrived());
      this.on('settled', onSettled);
      cleanups.push(() => this.off('settled', onSettled));
    });
  }

  /** Publishes a height in the desk's own frame, which is the only one it accepts. */
  private publishHeight(aboveBaseTenths: number): MoveResult {
    const value = clamp(Math.round(aboveBaseTenths), 0, 65535);
    if (!this.bus.publish(this.commandHeightTopic, String(value))) {
      return { ok: false, reason: 'the MQTT broker is not connected' };
    }
    this.log.debug(`${this.name}: commanded ${tenthsToMm(value)} mm above its own base.`);
    return { ok: true };
  }

  private onHeight(payload: string): void {
    const value = parseTenths(payload);
    if (value === undefined) {
      this.log.warn(`Ignoring unreadable height ${JSON.stringify(payload)} on ${this.metricHeightTopic}.`);
      return;
    }

    if (this.baseTenths === undefined && this.missingBaseTimer === undefined) {
      this.missingBaseTimer = setTimeout(() => {
        this.missingBaseTimer = undefined;
        if (this.baseTenths === undefined) {
          this.log.warn(
            `Desk ${this.name} is reporting its height but nothing has been published on ${this.metricBaseTopic}. `
            + 'Heights are configured from the floor, so it will show as not responding until the base height arrives.',
          );
        }
      }, MISSING_BASE_GRACE_MS);
      this.missingBaseTimer.unref();
    }

    const previous = this.heightTenths;
    this.heightTenths = value;
    if (previous !== undefined && previous !== value) {
      this.trendState = value > previous ? 'up' : 'down';
    }
    this.restartSettleTimer();
    this.emit('state');
  }

  private onBaseHeight(payload: string): void {
    const value = parseTenths(payload);
    if (value === undefined) {
      this.log.warn(`Ignoring unreadable base height ${JSON.stringify(payload)} on ${this.metricBaseTopic}.`);
      return;
    }
    if (value !== this.baseTenths) {
      this.log.debug(`Desk ${this.name} base height is ${tenthsToMm(value)} mm above the floor.`);
    }
    this.baseTenths = value;
    this.clearMissingBaseTimer();
    this.emit('state');
  }

  private restartSettleTimer(): void {
    this.stopSettleTimer();
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      this.trendState = 'stopped';
      this.emit('settled');
      this.emit('state');
    }, this.config.settleMs);
  }

  private clearMissingBaseTimer(): void {
    if (this.missingBaseTimer !== undefined) {
      clearTimeout(this.missingBaseTimer);
      this.missingBaseTimer = undefined;
    }
  }

  private stopSettleTimer(): void {
    if (this.settleTimer !== undefined) {
      clearTimeout(this.settleTimer);
      this.settleTimer = undefined;
    }
  }

  dispose(): void {
    this.stopSettleTimer();
    this.clearMissingBaseTimer();
    this.removeAllListeners();
  }
}
