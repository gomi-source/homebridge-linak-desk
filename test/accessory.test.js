import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Accessory, Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';

import { DeskAccessory } from '../dist/deskAccessory.js';
import { DeskController } from '../dist/deskController.js';
import { FavouriteCoordinator } from '../dist/favourites.js';
import { GroupFavouriteAccessory } from '../dist/groupFavouriteAccessory.js';
import { FakeBus, MQTT_SETTINGS, deskConfig, fakeLog } from './helpers.js';

/**
 * Exercises the HomeKit surface against the real HAP service and characteristic
 * classes, so service composition, subtypes and the not-responding behaviour are
 * checked rather than assumed.
 */
function fakePlatform(log) {
  return {
    log,
    Service,
    Characteristic,
    api: { hap: { HapStatusError, HAPStatus } },
    notResponding() {
      return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    },
  };
}

function setup(favourites = [{ name: 'Sitting', heightMm: 720 }, { name: 'Standing', heightMm: 1150 }]) {
  const bus = new FakeBus();
  const log = fakeLog();
  const platform = fakePlatform(log);
  const config = deskConfig({ favourites, settleMs: 20, moveTimeoutMs: 150 });

  const desk = new DeskController(config, bus, MQTT_SETTINGS, log);
  desk.start();

  const desks = new Map([[config.id, desk]]);
  const coordinator = new FavouriteCoordinator(desks, log);
  coordinator.watch(desk);

  const accessory = new Accessory(config.name, uuid.generate(`test:${config.id}`));
  const handler = new DeskAccessory(platform, accessory, desk, coordinator);

  return { accessory, bus, coordinator, desk, handler, platform, log };
}

/** Long enough for the target-coalescing window (400 ms) to elapse. */
const settle = () => new Promise(resolve => setTimeout(resolve, 500));

function online(bus, heightTenths = 1000) {
  bus.deliver('linak/desk/office/base_height', '6200');
  bus.deliver('linak/desk/bridge/availability', 'online');
  bus.deliver('linak/desk/office/availability', 'online');
  bus.deliver('linak/desk/office/height', String(heightTenths));
}

describe('DeskAccessory', () => {
  it('exposes a window covering and one switch per favourite', () => {
    const { accessory } = setup();

    const covering = accessory.getService(Service.WindowCovering);
    assert.ok(covering, 'the desk is a window covering');

    const switches = accessory.services.filter(service => service.UUID === Service.Switch.UUID);
    assert.equal(switches.length, 2);
    assert.deepEqual(switches.map(service => service.subtype), ['favourite-sitting', 'favourite-standing']);
    assert.deepEqual(switches.map(service => service.displayName), ['Sitting', 'Standing']);
  });

  it('names each service so the Home app can label the tiles', () => {
    const { accessory } = setup();
    const sitting = accessory.getServiceById(Service.Switch, 'favourite-sitting');

    assert.equal(sitting.getCharacteristic(Characteristic.Name).value, 'Sitting');
    assert.equal(sitting.getCharacteristic(Characteristic.ConfiguredName).value, 'Sitting');
  });

  it('reports not responding until a height has arrived', async () => {
    const { accessory } = setup();
    const covering = accessory.getService(Service.WindowCovering);

    await assert.rejects(
      () => covering.getCharacteristic(Characteristic.CurrentPosition).handleGetRequest(),
      status => status === HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  });

  it('reports the position once the desk is online', async () => {
    const { accessory, bus } = setup();
    online(bus, 3250);
    const covering = accessory.getService(Service.WindowCovering);

    assert.equal(await covering.getCharacteristic(Characteristic.CurrentPosition).handleGetRequest(), 50);
    assert.equal(covering.getCharacteristic(Characteristic.CurrentPosition).value, 50, 'and it was pushed, not only polled');
  });

  it('publishes a move once the slider comes to rest', async () => {
    const { accessory, bus } = setup();
    online(bus, 0);

    await accessory.getService(Service.WindowCovering)
      .getCharacteristic(Characteristic.TargetPosition)
      .handleSetRequest(100);

    assert.equal(bus.published.length, 0, 'nothing goes out while the slider may still be moving');
    await settle();
    assert.deepEqual(bus.lastPublished, { topic: 'linak/cmd/office/height', payload: '6500' });
  });

  it('collapses a whole drag into a single move to the final position', async () => {
    const { accessory, bus } = setup();
    online(bus, 0);
    const target = accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.TargetPosition);

    // What the Home app sends while a finger travels down the slider.
    for (const percent of [12, 27, 41, 58, 73, 90, 100]) {
      await target.handleSetRequest(percent);
    }

    assert.equal(bus.published.length, 0, 'no intermediate target reaches the desk');
    await settle();
    assert.equal(bus.published.length, 1, 'exactly one move is published');
    assert.deepEqual(bus.lastPublished, { topic: 'linak/cmd/office/height', payload: '6500' });
  });

  it('answers HomeKit with the dragged position immediately', async () => {
    const { accessory, bus } = setup();
    online(bus, 0);
    const target = accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.TargetPosition);

    await target.handleSetRequest(70);
    assert.equal(await target.handleGetRequest(), 70, 'the slider does not snap back while the command waits');
    await settle();
  });

  it('reports not responding when the desk cannot be reached', async () => {
    const { accessory, bus } = setup();
    online(bus, 0);
    bus.setConnected(false);

    await assert.rejects(
      () => accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.TargetPosition).handleSetRequest(100),
      status => status === HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  });

  it('follows the desk while it moves and stops claiming a target once it rests', async () => {
    const { accessory, bus } = setup();
    online(bus, 0);
    const covering = accessory.getService(Service.WindowCovering);

    await covering.getCharacteristic(Characteristic.TargetPosition).handleSetRequest(100);
    bus.deliver('linak/desk/office/height', '3000');
    assert.equal(covering.getCharacteristic(Characteristic.PositionState).value, Characteristic.PositionState.INCREASING);

    // The desk stops a little short of the requested position.
    bus.deliver('linak/desk/office/height', '6400');
    await new Promise(resolve => setTimeout(resolve, 60));

    assert.equal(covering.getCharacteristic(Characteristic.PositionState).value, Characteristic.PositionState.STOPPED);
    assert.equal(covering.getCharacteristic(Characteristic.TargetPosition).value, 98, 'the target follows the desk once it has settled');
  });

  it('moves the desk when a favourite switch is turned on', async () => {
    const { accessory, bus } = setup();
    online(bus, 1000);

    await accessory.getServiceById(Service.Switch, 'favourite-standing')
      .getCharacteristic(Characteristic.On)
      .handleSetRequest(true);

    assert.deepEqual(bus.lastPublished, { topic: 'linak/cmd/office/height', payload: '5300' });
  });

  it('turns a favourite switch back off when the desk does not arrive', async () => {
    const { accessory, bus } = setup();
    online(bus, 1000);
    const standing = accessory.getServiceById(Service.Switch, 'favourite-standing').getCharacteristic(Characteristic.On);

    await standing.handleSetRequest(true);
    bus.deliver('linak/desk/office/height', '3000');
    await new Promise(resolve => setTimeout(resolve, 250));

    assert.equal(standing.value, false);
  });

  it('turns the other favourite off when one is switched on', async () => {
    const { accessory, bus } = setup();
    online(bus, 1000);
    const sitting = accessory.getServiceById(Service.Switch, 'favourite-sitting').getCharacteristic(Characteristic.On);
    const standing = accessory.getServiceById(Service.Switch, 'favourite-standing').getCharacteristic(Characteristic.On);

    await sitting.handleSetRequest(true);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(await sitting.handleGetRequest(), true, 'the desk is already at 720 mm');

    await standing.handleSetRequest(true);
    assert.equal(sitting.value, false);
  });

  it('lights up the favourite switch when the desk is driven there by hand', async () => {
    const { accessory, bus } = setup();
    online(bus, 1000);
    const standing = accessory.getServiceById(Service.Switch, 'favourite-standing').getCharacteristic(Characteristic.On);
    assert.equal(standing.value, false);

    // No HomeKit write at all: the desk simply arrives at 1150 mm.
    bus.deliver('linak/desk/office/height', '5300');
    await new Promise(resolve => setTimeout(resolve, 60));

    assert.equal(standing.value, true, 'Home sees the switch turn itself on');
    assert.equal(await standing.handleGetRequest(), true);
  });

  it('drops switches for favourites removed from the config', () => {
    const { accessory, bus, coordinator, desk, platform } = setup();
    assert.equal(accessory.services.filter(service => service.UUID === Service.Switch.UUID).length, 2);

    // Restart with one favourite gone, against the same cached accessory.
    const trimmed = new DeskController(
      deskConfig({ favourites: [{ name: 'Standing', heightMm: 1150 }] }),
      bus,
      MQTT_SETTINGS,
      platform.log,
    );
    new DeskAccessory(platform, accessory, trimmed, coordinator);

    const remaining = accessory.services.filter(service => service.UUID === Service.Switch.UUID);
    assert.deepEqual(remaining.map(service => service.subtype), ['favourite-standing']);
    desk.dispose();
    trimmed.dispose();
  });
});

describe('GroupFavouriteAccessory', () => {
  it('is a single switch that moves every listed desk', async () => {
    const bus = new FakeBus();
    const log = fakeLog();
    const platform = fakePlatform(log);
    const desks = new Map();

    for (const id of ['office', 'studio']) {
      const desk = new DeskController(deskConfig({ id, name: id, settleMs: 20 }), bus, MQTT_SETTINGS, log);
      desk.start();
      desks.set(id, desk);
      bus.deliver(`linak/desk/${id}/base_height`, '6200');
      bus.deliver(`linak/desk/${id}/height`, '1000');
    }

    const coordinator = new FavouriteCoordinator(desks, log);
    const group = { name: 'Everyone Up', deskIds: ['office', 'studio'], heightMm: 1150, toleranceMm: 10, moveTimeoutMs: 150 };
    const accessory = new Accessory(group.name, uuid.generate('test:group'));
    new GroupFavouriteAccessory(platform, accessory, group, coordinator);

    const service = accessory.getService(Service.Switch);
    assert.ok(service);

    await service.getCharacteristic(Characteristic.On).handleSetRequest(true);
    assert.deepEqual(bus.published.map(entry => entry.topic), ['linak/cmd/office/height', 'linak/cmd/studio/height']);
    assert.deepEqual(bus.published.map(entry => entry.payload), ['5300', '5300']);

    for (const desk of desks.values()) {
      desk.dispose();
    }
  });
});
