import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  HapStatusError,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import type { LinakDeskSettings } from './config.js';
import { parseConfig } from './config.js';
import { DeskAccessory } from './deskAccessory.js';
import { DeskController } from './deskController.js';
import { FavouriteCoordinator } from './favourites.js';
import { GroupFavouriteAccessory } from './groupFavouriteAccessory.js';
import { MqttBus } from './mqttBus.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { slug } from './util.js';

/**
 * Bridges LINAK desks published by mqtt-linak into HomeKit.
 *
 * A dynamic platform, as the Homebridge verification requirements ask for: the
 * accessories come from the user's config, are cached between restarts, and
 * ones that disappear from the config are unregistered on the next start.
 */
export class LinakDeskPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  /** Accessories restored from the Homebridge cache, by UUID. */
  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private readonly desks = new Map<string, DeskController>();
  private readonly settings?: LinakDeskSettings;
  private bus?: MqttBus;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    try {
      this.settings = parseConfig(config, log);
    } catch (error) {
      this.log.error(`Could not read the plugin configuration: ${error instanceof Error ? error.message : String(error)}`);
    }

    this.api.on('didFinishLaunching', () => {
      try {
        this.start();
      } catch (error) {
        this.log.error(`Starting the platform failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    this.api.on('shutdown', () => {
      void this.stop();
    });
  }

  /**
   * Called by Homebridge for every accessory in its cache, before
   * `didFinishLaunching`.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug(`Loading accessory from cache: ${accessory.displayName}`);
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  /** The error thrown from a characteristic handler to show "not responding". */
  notResponding(): HapStatusError {
    return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private start(): void {
    const settings = this.settings;
    if (settings === undefined) {
      this.log.warn('The LinakDesk platform is not configured, no accessories were created.');
      return;
    }

    const bus = new MqttBus(settings.mqtt, this.log);
    this.bus = bus;

    const coordinator = new FavouriteCoordinator(this.desks, this.log);

    for (const deskConfig of settings.desks) {
      const desk = new DeskController(deskConfig, bus, settings.mqtt, this.log);
      this.desks.set(deskConfig.id, desk);
      desk.start();
      coordinator.watch(desk);
    }

    const live = new Set<string>();
    const created: PlatformAccessory[] = [];
    const restored: PlatformAccessory[] = [];

    for (const desk of this.desks.values()) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:desk:${desk.id}`);
      live.add(uuid);
      const accessory = this.obtainAccessory(uuid, desk.name, created, restored);
      new DeskAccessory(this, accessory, desk, coordinator);
    }

    for (const group of settings.groupFavourites) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:group:${slug(group.name)}`);
      live.add(uuid);
      const accessory = this.obtainAccessory(uuid, group.name, created, restored);
      new GroupFavouriteAccessory(this, accessory, group, coordinator);
    }

    // Registered only once the services exist, so what Homebridge caches is the
    // finished accessory rather than a bare AccessoryInformation.
    if (created.length > 0) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, created);
    }
    if (restored.length > 0) {
      this.api.updatePlatformAccessories(restored);
    }

    this.removeStaleAccessories(live);

    this.log.info(
      `Set up ${settings.desks.length} desk${settings.desks.length === 1 ? '' : 's'} `
      + `and ${settings.groupFavourites.length} group favourite${settings.groupFavourites.length === 1 ? '' : 's'}.`,
    );

    // Started last, so every subscription is registered before the first
    // retained message arrives.
    bus.start();
  }

  /**
   * Restores an accessory from the cache, or creates one. Newly created
   * accessories are collected in `created` and registered by the caller once
   * they have been given their services.
   */
  private obtainAccessory(uuid: string, displayName: string, created: PlatformAccessory[], restored: PlatformAccessory[]): PlatformAccessory {
    const existing = this.cachedAccessories.get(uuid);
    if (existing !== undefined) {
      this.log.debug(`Restoring ${existing.displayName} from the cache.`);
      if (existing.displayName !== displayName) {
        this.log.info(`Accessory ${existing.displayName} is now named ${displayName} in the config; rename it in the Home app to see the change there.`);
      }
      restored.push(existing);
      return existing;
    }

    this.log.info(`Adding new accessory: ${displayName}`);
    const accessory = new this.api.platformAccessory(displayName, uuid);
    this.cachedAccessories.set(uuid, accessory);
    created.push(accessory);
    return accessory;
  }

  private removeStaleAccessories(live: Set<string>): void {
    for (const [uuid, accessory] of this.cachedAccessories) {
      if (live.has(uuid)) {
        continue;
      }
      this.log.info(`Removing ${accessory.displayName}, it is no longer in the configuration.`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cachedAccessories.delete(uuid);
    }
  }

  private async stop(): Promise<void> {
    for (const desk of this.desks.values()) {
      desk.dispose();
    }
    this.desks.clear();
    try {
      await this.bus?.stop();
    } catch (error) {
      this.log.debug(`Closing the MQTT connection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
