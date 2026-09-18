import type { CharacteristicValue, PlatformAccessory } from 'homebridge';

import type { GroupFavouriteConfig } from './config.js';
import type { FavouriteCoordinator } from './favourites.js';
import type { LinakDeskPlatform } from './platform.js';
import { MANUFACTURER, MODEL_GROUP, PLUGIN_VERSION } from './settings.js';
import { slug } from './util.js';

/**
 * A favourite that moves several desks at once, as a single switch accessory.
 * It is mutually exclusive with any other favourite that touches one of the
 * same desks, and switches itself off if the desks do not all arrive.
 */
export class GroupFavouriteAccessory {
  constructor(
    platform: LinakDeskPlatform,
    accessory: PlatformAccessory,
    group: GroupFavouriteConfig,
    coordinator: FavouriteCoordinator,
  ) {
    const { Characteristic, Service } = platform;
    const key = `group:${slug(group.name)}`;

    accessory.getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Model, MODEL_GROUP)
      .setCharacteristic(Characteristic.SerialNumber, slug(group.name))
      .setCharacteristic(Characteristic.FirmwareRevision, PLUGIN_VERSION);

    const service = accessory.getService(Service.Switch) ?? accessory.addService(Service.Switch, group.name);
    service.setCharacteristic(Characteristic.Name, group.name);

    coordinator.register({
      key,
      label: group.name,
      heightMm: group.heightMm,
      deskIds: group.deskIds,
      toleranceMm: group.toleranceMm,
      moveTimeoutMs: group.moveTimeoutMs,
      setSwitch: on => service.updateCharacteristic(Characteristic.On, on),
    });

    service.getCharacteristic(Characteristic.On)
      .onGet(() => coordinator.isActive(key))
      .onSet((value: CharacteristicValue) => {
        if (value === true) {
          platform.log.info(`Group favourite ${group.name} requested for ${group.deskIds.join(', ')}.`);
          coordinator.activate(key);
        } else {
          coordinator.deactivate(key);
        }
      });
  }
}
