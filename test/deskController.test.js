import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DeskController, parseTenths } from '../dist/deskController.js';
import { FakeBus, MQTT_SETTINGS, deskConfig, fakeLog } from './helpers.js';

function makeDesk(overrides = {}) {
  const bus = new FakeBus();
  const desk = new DeskController(deskConfig(overrides), bus, MQTT_SETTINGS, fakeLog());
  desk.start();
  return { bus, desk };
}

const HEIGHT = 'linak/desk/office/height';
const BASE = 'linak/desk/office/base_height';
const DESK_AVAILABILITY = 'linak/desk/office/availability';
const BRIDGE_AVAILABILITY = 'linak/desk/bridge/availability';
const COMMAND = 'linak/cmd/office/height';

describe('parseTenths', () => {
  it('reads the plain decimal string the bridge publishes', () => {
    assert.equal(parseTenths('7350'), 7350);
    assert.equal(parseTenths('  620  '), 620);
  });

  it('reads the JSON shapes the bridge accepts on the command side', () => {
    assert.equal(parseTenths('{"value": 7350}'), 7350);
    assert.equal(parseTenths('{"base_height": 620}'), 620);
    assert.equal(parseTenths('{"height": "7350"}'), 7350);
  });

  it('returns nothing for anything else', () => {
    assert.equal(parseTenths(''), undefined);
    assert.equal(parseTenths('online'), undefined);
    assert.equal(parseTenths('{"speed": 3}'), undefined);
  });
});

describe('DeskController', () => {
  it('is unreachable until both the height and the base height arrive', () => {
    const { bus, desk } = makeDesk();
    bus.deliver(BRIDGE_AVAILABILITY, 'online');
    bus.deliver(DESK_AVAILABILITY, 'online');
    assert.equal(desk.reachable, false);

    // A height alone is not a height above the floor.
    bus.deliver(HEIGHT, '3250');
    assert.equal(desk.reachable, false);

    bus.deliver(BASE, '6200');
    assert.equal(desk.reachable, true);
    desk.dispose();
  });

  it('maps the configured floor range onto 0-100%', () => {
    const { bus, desk } = makeDesk({ minHeightMm: 620, maxHeightMm: 1270 });
    bus.deliver(BRIDGE_AVAILABILITY, 'online');
    bus.deliver(DESK_AVAILABILITY, 'online');
    bus.deliver(BASE, '6200');

    bus.deliver(HEIGHT, '0');
    assert.equal(desk.positionPercent, 0, '620 mm above the floor is the bottom');
    bus.deliver(HEIGHT, '6500');
    assert.equal(desk.positionPercent, 100, '1270 mm above the floor is the top');
    bus.deliver(HEIGHT, '3250');
    assert.equal(desk.positionPercent, 50);
    desk.dispose();
  });

  it('maps the same desk differently when it sits on a taller base', () => {
    const { bus, desk } = makeDesk({ minHeightMm: 620, maxHeightMm: 1270 });
    // The same desk raised 100 mm: its own zero is now 720 mm above the floor.
    bus.deliver(BASE, '7200');

    bus.deliver(HEIGHT, '0');
    assert.equal(desk.positionPercent, 15, '720 mm above the floor is 15% of 620-1270');
    desk.dispose();
  });

  it('converts a percentage into a height above the base', () => {
    const { bus, desk } = makeDesk({ minHeightMm: 620, maxHeightMm: 1270 });
    bus.deliver(BASE, '6200');

    assert.deepEqual(desk.moveToPercent(50), { ok: true });
    assert.deepEqual(bus.lastPublished, { topic: COMMAND, payload: '3250' }, '945 mm floor - 620 mm base');
    desk.dispose();
  });

  it('refuses a percentage before the base height is known', () => {
    const { bus, desk } = makeDesk();

    const result = desk.moveToPercent(50);
    assert.equal(result.ok, false);
    assert.match(result.reason, /base height/);
    assert.equal(bus.published.length, 0);
    desk.dispose();
  });

  it('adds the base height for a height above the floor', () => {
    const { bus, desk } = makeDesk();
    bus.deliver(BASE, '6200');
    bus.deliver(HEIGHT, '1000');

    assert.equal(desk.floorHeightMm, 720);
    assert.deepEqual(desk.moveToFloorHeightMm(1150), { ok: true });
    assert.deepEqual(bus.lastPublished, { topic: COMMAND, payload: '5300' }, '1150 mm floor - 620 mm base');
    desk.dispose();
  });

  it('refuses a floor height before the base height is known', () => {
    const { bus, desk } = makeDesk();
    bus.deliver(HEIGHT, '1000');

    const result = desk.moveToFloorHeightMm(1150);
    assert.equal(result.ok, false);
    assert.match(result.reason, /base height/);
    assert.equal(bus.published.length, 0, 'nothing is published on refusal');
    desk.dispose();
  });

  it('refuses a floor height outside the configured range', () => {
    const { bus, desk } = makeDesk({ minHeightMm: 620, maxHeightMm: 1270 });
    bus.deliver(BASE, '6200');

    const result = desk.moveToFloorHeightMm(2000);
    assert.equal(result.ok, false);
    assert.match(result.reason, /outside this desk's configured range of 620-1270 mm/);
    assert.equal(bus.published.length, 0);
    desk.dispose();
  });

  it('refuses a range that reaches below the desk base', () => {
    const { bus, desk } = makeDesk({ minHeightMm: 400, maxHeightMm: 1270 });
    bus.deliver(BASE, '6200');

    const result = desk.moveToFloorHeightMm(400);
    assert.equal(result.ok, false);
    assert.match(result.reason, /below this desk's base/);
    assert.equal(bus.published.length, 0);
    desk.dispose();
  });

  it('refuses to publish while the broker is down', () => {
    const { bus, desk } = makeDesk();
    bus.deliver(BASE, '6200');
    bus.setConnected(false);

    const result = desk.moveToPercent(50);
    assert.equal(result.ok, false);
    assert.match(result.reason, /broker/);
    desk.dispose();
  });

  it('goes unreachable when the bridge or the desk reports offline', () => {
    const { bus, desk } = makeDesk();
    bus.deliver(BRIDGE_AVAILABILITY, 'online');
    bus.deliver(DESK_AVAILABILITY, 'online');
    bus.deliver(BASE, '6200');
    bus.deliver(HEIGHT, '3250');
    assert.equal(desk.reachable, true);

    bus.deliver(DESK_AVAILABILITY, 'offline');
    assert.equal(desk.reachable, false);

    bus.deliver(DESK_AVAILABILITY, 'online');
    bus.deliver(BRIDGE_AVAILABILITY, 'offline');
    assert.equal(desk.reachable, false);

    bus.deliver(BRIDGE_AVAILABILITY, 'online');
    bus.setConnected(false);
    assert.equal(desk.reachable, false);
    desk.dispose();
  });

  it('reports which way it is moving and settles', async () => {
    const { bus, desk } = makeDesk({ settleMs: 20 });
    bus.deliver(HEIGHT, '3000');
    bus.deliver(HEIGHT, '3200');
    assert.equal(desk.trend, 'up');

    bus.deliver(HEIGHT, '3100');
    assert.equal(desk.trend, 'down');

    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(desk.trend, 'stopped');
    desk.dispose();
  });

  it('resolves the wait as soon as the desk is within tolerance', async () => {
    const { bus, desk } = makeDesk({ toleranceMm: 10, settleMs: 20 });
    bus.deliver(BASE, '6200');
    bus.deliver(HEIGHT, '1000');

    const arrived = desk.waitForFloorHeightMm(1150, 10, 500);
    bus.deliver(HEIGHT, '5295');
    assert.equal(await arrived, true, '1149.5 mm is within 10 mm of 1150 mm');
    desk.dispose();
  });

  it('fails the wait when the desk stops somewhere else', async () => {
    const { bus, desk } = makeDesk({ toleranceMm: 10, settleMs: 20 });
    bus.deliver(BASE, '6200');
    bus.deliver(HEIGHT, '1000');

    const arrived = desk.waitForFloorHeightMm(1150, 10, 1000);
    bus.deliver(HEIGHT, '3000');
    assert.equal(await arrived, false, 'settling short of the target is a failure');
    desk.dispose();
  });

  it('fails the wait when nothing happens at all', async () => {
    const { bus, desk } = makeDesk();
    bus.deliver(BASE, '6200');
    bus.deliver(HEIGHT, '1000');

    assert.equal(await desk.waitForFloorHeightMm(1150, 10, 60), false);
    desk.dispose();
  });
});
