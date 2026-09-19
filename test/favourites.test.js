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

  it('switches on when the desk is driven onto a favourite by other means', async () => {
    const { bus, coordinator } = setup();
    const standing = favourite(coordinator, 'office:standing', 1150, ['office']);
    assert.equal(coordinator.isActive('office:standing'), false);

    // Somebody used the panel on the desk, or the Home slider.
    bus.deliver('linak/desk/office/height', '5300');
    await settle();

    assert.equal(coordinator.isActive('office:standing'), true);
    assert.equal(standing.on, true, 'the switch is pushed on');
  });

  it('does not light up a favourite the desk only travels through', async () => {
    const { bus, coordinator } = setup();
    favourite(coordinator, 'office:standing', 1150, ['office']);

    // Passing 1150 mm on the way somewhere else: still moving, so no verdict.
    bus.deliver('linak/desk/office/height', '5300');
    assert.equal(coordinator.isActive('office:standing'), false);
    bus.deliver('linak/desk/office/height', '6000');
    await settle();

    assert.equal(coordinator.isActive('office:standing'), false, 'it came to rest somewhere else');
  });

  it('picks up a desk that was already at a favourite before it started', async () => {
    const bus = new FakeBus();
    const log = fakeLog();
    const desks = new Map();
    const coordinator = new FavouriteCoordinator(desks, log);

    const desk = new DeskController(deskConfig({ settleMs: SETTLE_MS }), bus, MQTT_SETTINGS, log);
    desk.start();
    desks.set('office', desk);
    coordinator.watch(desk);
    const standing = favourite(coordinator, 'office:standing', 1150, ['office']);

    // Retained state arriving at startup, with no movement of any kind.
    bus.deliver('linak/desk/office/base_height', '6200');
    bus.deliver('linak/desk/office/availability', 'online');
    bus.deliver('linak/desk/bridge/availability', 'online');
    bus.deliver('linak/desk/office/height', '5300');

    assert.equal(coordinator.isActive('office:standing'), true, 'no settle event is needed');
    assert.equal(standing.on, true);
    desk.dispose();
  });

  it('switches a group favourite on when its desks arrive separately', async () => {
    const { bus, coordinator } = setup(['office', 'studio']);
    const everyone = favourite(coordinator, 'group:everyone', 1150, ['office', 'studio']);

    bus.deliver('linak/desk/office/height', '5300');
    await settle();
    assert.equal(coordinator.isActive('group:everyone'), false, 'one desk is not the group');

    bus.deliver('linak/desk/studio/height', '5300');
    await settle();
    assert.equal(coordinator.isActive('group:everyone'), true);
    assert.equal(everyone.on, true);
  });

  it('keeps a hand-switched-off favourite off until the desk leaves', async () => {
    const { bus, coordinator } = setup();
    const sitting = favourite(coordinator, 'office:sitting', 720, ['office']);

    // The desk starts out at 720 mm, so the switch derives itself on.
    bus.deliver('linak/desk/office/height', '1000');
    await settle();
    assert.equal(coordinator.isActive('office:sitting'), true);

    coordinator.deactivate('office:sitting');
    sitting.on = false;
    bus.deliver('linak/desk/office/availability', 'online');
    await settle();
    assert.equal(coordinator.isActive('office:sitting'), false, 'the tap is not undone under the user');
    assert.equal(sitting.on, false);

    // Leaving and coming back makes it meaningful again.
    bus.deliver('linak/desk/office/height', '5300');
    await settle();
    bus.deliver('linak/desk/office/height', '1000');
    await settle();
    assert.equal(coordinator.isActive('office:sitting'), true);
    assert.equal(sitting.on, true);
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
