import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DeskController } from '../dist/deskController.js';
import { FavouriteCoordinator } from '../dist/favourites.js';
import { FakeBus, MQTT_SETTINGS, deskConfig, fakeLog } from './helpers.js';

const SETTLE_MS = 20;

function setup(ids = ['office']) {
  const bus = new FakeBus();
  const log = fakeLog();
  const desks = new Map();
  const coordinator = new FavouriteCoordinator(desks, log);

  for (const id of ids) {
    const desk = new DeskController(deskConfig({ id, name: id, settleMs: SETTLE_MS, moveTimeoutMs: 150 }), bus, MQTT_SETTINGS, log);
    desk.start();
    desks.set(id, desk);
    coordinator.watch(desk);
    // Both readings present: base 620 mm above the floor, desk at 720 mm.
    bus.deliver(`linak/desk/${id}/base_height`, '6200');
    bus.deliver(`linak/desk/${id}/availability`, 'online');
    bus.deliver('linak/desk/bridge/availability', 'online');
    bus.deliver(`linak/desk/${id}/height`, '1000');
  }

  return { bus, log, desks, coordinator };
}

function favourite(coordinator, key, heightMm, deskIds) {
  const state = { on: false };
  coordinator.register({
    key,
    label: key,
    heightMm,
    deskIds,
    toleranceMm: 10,
    moveTimeoutMs: 150,
    setSwitch: on => {
      state.on = on;
    },
  });
  return state;
}

const settle = (ms = SETTLE_MS + 40) => new Promise(resolve => setTimeout(resolve, ms));

describe('FavouriteCoordinator', () => {
  it('publishes a move and stays on once the desk arrives', async () => {
    const { bus, coordinator } = setup();
    const standing = favourite(coordinator, 'office:standing', 1150, ['office']);

    coordinator.activate('office:standing');
    assert.deepEqual(bus.lastPublished, { topic: 'linak/cmd/office/height', payload: '5300' });

    bus.deliver('linak/desk/office/height', '5300');
    await settle();

    assert.equal(coordinator.isActive('office:standing'), true);
    assert.equal(standing.on, false, 'the switch was never pushed off');
  });

  it('switches itself back off when the desk does not arrive', async () => {
    const { bus, coordinator } = setup();
    const standing = favourite(coordinator, 'office:standing', 1150, ['office']);

    coordinator.activate('office:standing');
    bus.deliver('linak/desk/office/height', '3000');
    await settle(250);

    assert.equal(coordinator.isActive('office:standing'), false);
    assert.equal(standing.on, false, 'the switch is pushed off');
  });

  it('switches itself back off when the move cannot be sent at all', async () => {
    const { bus, coordinator } = setup();
    const standing = favourite(coordinator, 'office:standing', 1150, ['office']);
    bus.setConnected(false);

    coordinator.activate('office:standing');
    await settle();

    assert.equal(coordinator.isActive('office:standing'), false);
    assert.equal(standing.on, false);
  });

  it('refuses a height outside the desk travel and switches back off', async () => {
    const { coordinator } = setup();
    const silly = favourite(coordinator, 'office:silly', 3000, ['office']);

    coordinator.activate('office:silly');
    await settle();

    assert.equal(coordinator.isActive('office:silly'), false);
    assert.equal(silly.on, false);
  });

  it('makes favourites on the same desk mutually exclusive', async () => {
    const { bus, coordinator } = setup();
    const sitting = favourite(coordinator, 'office:sitting', 720, ['office']);
    const standing = favourite(coordinator, 'office:standing', 1150, ['office']);

    coordinator.activate('office:sitting');
    await settle();
    assert.equal(coordinator.isActive('office:sitting'), true, 'the desk is already at 720 mm');

    coordinator.activate('office:standing');
    assert.equal(coordinator.isActive('office:sitting'), false);
    assert.equal(sitting.on, false, 'the other switch was pushed off immediately');

    bus.deliver('linak/desk/office/height', '5300');
    await settle();
    assert.equal(coordinator.isActive('office:standing'), true);
    assert.equal(standing.on, false);
  });

  it('a group favourite clears the per-desk favourites it overlaps', async () => {
    const { bus, coordinator } = setup(['office', 'studio']);
    const sitting = favourite(coordinator, 'office:sitting', 720, ['office']);
    favourite(coordinator, 'group:everyone', 1150, ['office', 'studio']);

    coordinator.activate('office:sitting');
    await settle();
    assert.equal(coordinator.isActive('office:sitting'), true);

    coordinator.activate('group:everyone');
    assert.equal(sitting.on, false);
    assert.equal(coordinator.isActive('office:sitting'), false);

    bus.deliver('linak/desk/office/height', '5300');
    bus.deliver('linak/desk/studio/height', '5300');
    await settle();
    assert.equal(coordinator.isActive('group:everyone'), true);
  });

  it('a group favourite fails if any one desk does not arrive', async () => {
    const { bus, coordinator } = setup(['office', 'studio']);
    const everyone = favourite(coordinator, 'group:everyone', 1150, ['office', 'studio']);

    coordinator.activate('group:everyone');
    bus.deliver('linak/desk/office/height', '5300');
    bus.deliver('linak/desk/studio/height', '2000');
    await settle(250);

    assert.equal(coordinator.isActive('group:everyone'), false);
    assert.equal(everyone.on, false);
  });

  it('switches off when the desk is moved away afterwards', async () => {
    const { bus, coordinator } = setup();
    const standing = favourite(coordinator, 'office:standing', 1150, ['office']);

    coordinator.activate('office:standing');
    bus.deliver('linak/desk/office/height', '5300');
    await settle();
    assert.equal(coordinator.isActive('office:standing'), true);

    // Somebody used the panel on the desk.
    bus.deliver('linak/desk/office/height', '2000');
    await settle();

    assert.equal(coordinator.isActive('office:standing'), false);
    assert.equal(standing.on, false);
  });

  it('switches off when the desk goes offline', async () => {
    const { bus, coordinator } = setup();
    const standing = favourite(coordinator, 'office:standing', 1150, ['office']);

    coordinator.activate('office:standing');
    bus.deliver('linak/desk/office/height', '5300');
    await settle();
    assert.equal(coordinator.isActive('office:standing'), true);

    bus.deliver('linak/desk/office/availability', 'offline');
    assert.equal(coordinator.isActive('office:standing'), false);
    assert.equal(standing.on, false);
  });

  it('switching off by hand does not move the desk', () => {
    const { bus, coordinator } = setup();
    favourite(coordinator, 'office:standing', 1150, ['office']);

    coordinator.activate('office:standing');
    const published = bus.published.length;

    coordinator.deactivate('office:standing');
    assert.equal(coordinator.isActive('office:standing'), false);
    assert.equal(bus.published.length, published, 'nothing further was published');
  });
});
