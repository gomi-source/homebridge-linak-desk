import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { DeskController } from './deskController.js';
import type { FavouriteCoordinator } from './favourites.js';
import type { LinakDeskPlatform } from './platform.js';
import { MANUFACTURER, MODEL_DESK, PLUGIN_VERSION } from './settings.js';
import { slug } from './util.js';

const FAVOURITE_SUBTYPE_PREFIX = 'favourite-';

/**
 * How long the target has to stay still before it is published.
 *
 * The Home app streams TargetPosition writes while the slider is being
 * dragged. A desk position is absolute and idempotent, so every value but the
 * last one is waste — and worse than waste downstream, where mqtt-linak queues
 * commands and runs each move to completion before starting the next, so a
 * drag became a sequence of complete moves to stale targets.
 *
 * Deliberately trailing-edge only. Publishing the first value immediately would
 * send the desk off towards wherever the finger happened to be a moment after
 * touching down, which is the stutter this exists to remove. A one-off set from
 * Siri, a scene or an automation pays this delay once, which is nothing next to
 * the seconds the desk itself takes.
 */
const TARGET_COALESCE_MS = 400;

/**
 * One desk, as Apple Home sees it.
 *
 * HomeKit has no desk, so the height is a Window Covering: 0% is the lowest
 * configured position and 100% the highest. Each configured favourite is an
 * extra Switch service on the same accessory, which Home shows as a group of
 * tiles that can be split apart.
 */
export class DeskAccessory {
  private readonly covering: Service;
  private readonly favouriteServices = new Map<string, Service>();
  private targetPercent?: number;
  private pendingPercent?: number;
  private coalesceTimer?: NodeJS.Timeout;

  constructor(
    private readonly platform: LinakDeskPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly desk: DeskController,
    private readonly coordinator: FavouriteCoordinator,
  ) {
    const { Characteristic, Service: HapService } = this.platform;

    this.accessory.getService(HapService.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Model, MODEL_DESK)
      .setCharacteristic(Characteristic.SerialNumber, desk.id)
      .setCharacteristic(Characteristic.FirmwareRevision, PLUGIN_VERSION);

    this.covering = this.accessory.getService(HapService.WindowCovering)
      ?? this.accessory.addService(HapService.WindowCovering, desk.name);
    this.covering.setCharacteristic(Characteristic.Name, desk.name);
    this.setConfiguredName(this.covering, desk.name);

    this.covering.getCharacteristic(Characteristic.CurrentPosition)
      .onGet(() => this.currentPosition());

    this.covering.getCharacteristic(Characteristic.PositionState)
      .onGet(() => this.positionState());

    this.covering.getCharacteristic(Characteristic.TargetPosition)
      .onGet(() => this.targetPosition())
      .onSet(value => this.setTargetPosition(value));

    this.addFavourites();
    this.pruneRemovedFavourites();

    this.desk.on('state', () => this.push());
    this.desk.on('settled', () => this.onSettled());
    this.push();
  }

  private addFavourites(): void {
    const { Characteristic, Service: HapService } = this.platform;

    for (const favourite of this.desk.config.favourites) {
      const subtype = `${FAVOURITE_SUBTYPE_PREFIX}${slug(favourite.name)}`;
      const key = `${this.desk.id}:${subtype}`;
      const service = this.accessory.getServiceById(HapService.Switch, subtype)
        ?? this.accessory.addService(HapService.Switch, favourite.name, subtype);

      service.setCharacteristic(Characteristic.Name, favourite.name);
      this.setConfiguredName(service, favourite.name);
      this.favouriteServices.set(subtype, service);

      this.coordinator.register({
        key,
        label: `${this.desk.name} / ${favourite.name}`,
        heightMm: favourite.heightMm,
        deskIds: [this.desk.id],
        toleranceMm: this.desk.config.toleranceMm,
        moveTimeoutMs: this.desk.config.moveTimeoutMs,
        setSwitch: on => service.updateCharacteristic(Characteristic.On, on),
      });

      service.getCharacteristic(Characteristic.On)
        .onGet(() => this.coordinator.isActive(key))
        .onSet(value => this.setFavourite(key, favourite.name, value));
    }
  }

  /** Drops switches for favourites the user has since removed from the config. */
  private pruneRemovedFavourites(): void {
    for (const service of [...this.accessory.services]) {
      if (service.UUID !== this.platform.Service.Switch.UUID) {
        continue;
      }
      const subtype = service.subtype;
      if (subtype !== undefined && subtype.startsWith(FAVOURITE_SUBTYPE_PREFIX) && !this.favouriteServices.has(subtype)) {
        this.platform.log.info(`Removing favourite ${service.displayName} from ${this.accessory.displayName}, it is no longer configured.`);
        this.accessory.removeService(service);
      }
    }
  }

  private setFavourite(key: string, name: string, value: CharacteristicValue): void {
    if (value === true) {
      this.platform.log.info(`${this.desk.name}: favourite ${name} requested.`);
      this.coordinator.activate(key);
    } else {
      this.coordinator.deactivate(key);
    }
  }

  private currentPosition(): CharacteristicValue {
    const position = this.desk.positionPercent;
    if (!this.desk.reachable || position === undefined) {
      throw this.platform.notResponding();
    }
    return position;
  }

  private targetPosition(): CharacteristicValue {
    const position = this.targetPercent ?? this.desk.positionPercent;
    if (!this.desk.reachable || position === undefined) {
      throw this.platform.notResponding();
    }
    return position;
  }

  private positionState(): CharacteristicValue {
    const { Characteristic } = this.platform;
    if (this.desk.trend === 'up') {
      return Characteristic.PositionState.INCREASING;
    }
    if (this.desk.trend === 'down') {
      return Characteristic.PositionState.DECREASING;
    }
    return Characteristic.PositionState.STOPPED;
  }

  private setTargetPosition(value: CharacteristicValue): void {
    const percent = typeof value === 'number' ? value : Number(value);

    // What can be checked synchronously is reported synchronously, so an
    // unreachable desk still says so in the Home app rather than silently
    // swallowing the drag.
    if (!this.desk.reachable) {
      throw this.platform.notResponding();
    }

    // Answer HomeKit with the position the user asked for straight away; only
    // the MQTT command waits for the drag to end.
    this.targetPercent = percent;
    this.pendingPercent = percent;

    if (this.coalesceTimer !== undefined) {
      clearTimeout(this.coalesceTimer);
    }
    this.coalesceTimer = setTimeout(() => this.publishPendingTarget(), TARGET_COALESCE_MS);
    this.coalesceTimer.unref();
  }

  /**
   * Publishes the position the slider came to rest on. Runs after the HomeKit
   * write has been answered, so a failure here can only be logged - the Home
   * app finds out the honest way, by the desk not moving.
   */
  private publishPendingTarget(): void {
    this.coalesceTimer = undefined;
    const percent = this.pendingPercent;
    this.pendingPercent = undefined;
    if (percent === undefined) {
      return;
    }

    const result = this.desk.moveToPercent(percent);
    if (!result.ok) {
      this.platform.log.error(`${this.desk.name}: could not move to ${percent}% - ${result.reason}.`);
    }
  }

  /**
   * Once the desk has stopped, the target is wherever it actually came to rest.
   * Without this the Home app keeps showing "Opening to 60%" after a move that
   * ended a millimetre or two short.
   */
  private onSettled(): void {
    const position = this.desk.positionPercent;
    if (position === undefined) {
      return;
    }
    this.targetPercent = position;
    this.covering.updateCharacteristic(this.platform.Characteristic.TargetPosition, position);
  }

  private push(): void {
    const { Characteristic } = this.platform;
    const position = this.desk.positionPercent;
    if (position === undefined) {
      return;
    }
    this.covering.updateCharacteristic(Characteristic.CurrentPosition, position);
    this.covering.updateCharacteristic(Characteristic.PositionState, this.positionState());
    if (this.targetPercent === undefined) {
      this.targetPercent = position;
      this.covering.updateCharacteristic(Characteristic.TargetPosition, position);
    }
  }

  /**
   * Home only shows a per-service name for accessories with several services,
   * and only reads it from ConfiguredName.
   */
  private setConfiguredName(service: Service, name: string): void {
    const { Characteristic } = this.platform;
    // Neither WindowCovering nor Switch lists ConfiguredName as optional, and
    // HAP logs a warning for anything it was not told to expect.
    service.addOptionalCharacteristic(Characteristic.ConfiguredName);

    const characteristic = service.getCharacteristic(Characteristic.ConfiguredName);
    // Only seed it: a name the user changed in the Home app is theirs to keep.
    if (characteristic.value === null || characteristic.value === undefined || characteristic.value === '') {
      service.updateCharacteristic(Characteristic.ConfiguredName, name);
    }
  }
}
