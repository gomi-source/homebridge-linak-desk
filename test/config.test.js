import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseConfig } from '../dist/config.js';
import { fakeLog } from './helpers.js';

const base = {
  platform: 'LinakDesk',
  name: 'LINAK Desk',
  mqtt: { url: 'mqtt://broker:1883' },
  desks: [{ id: 'office' }],
};

describe('parseConfig', () => {
  it('applies the documented defaults', () => {
    const settings = parseConfig(base, fakeLog());

    assert.equal(settings.mqtt.commandTopicBase, 'cmd/linak');
    assert.equal(settings.mqtt.metricTopicBase, 'tele/linak');
    assert.equal(settings.mqtt.useAvailability, true);
    assert.equal(settings.desks.length, 1);
    assert.equal(settings.desks[0].name, 'office', 'name falls back to the id');
    assert.equal(settings.desks[0].minHeightMm, 620, 'measured from the floor');
    assert.equal(settings.desks[0].maxHeightMm, 1200, 'measured from the floor');
    assert.equal(settings.desks[0].toleranceMm, 5);
    assert.equal(settings.desks[0].moveTimeoutMs, 30000);
  });

  it('trims stray slashes from the topic bases', () => {
    const settings = parseConfig(
      { ...base, mqtt: { url: 'mqtt://broker:1883', commandTopicBase: '/cmd/linak/', metricTopicBase: 'tele/linak/' } },
      fakeLog(),
    );

    assert.equal(settings.mqtt.commandTopicBase, 'cmd/linak');
    assert.equal(settings.mqtt.metricTopicBase, 'tele/linak');
  });

  it('refuses wildcards in a topic base', () => {
    assert.equal(parseConfig({ ...base, mqtt: { url: 'mqtt://b:1883', metricTopicBase: 'linak/+' } }, fakeLog()), undefined);
  });

  it('refuses a broker URL that is not one', () => {
    assert.equal(parseConfig({ ...base, mqtt: { url: 'broker:1883' } }, fakeLog()), undefined);
  });

  it('drops bad desks but keeps the good ones', () => {
    const log = fakeLog();
    const settings = parseConfig({
      ...base,
      desks: [
        { id: 'office' },
        { id: 'bridge' },
        { id: 'office' },
        { name: 'no id here' },
        { id: 'broken', minHeightMm: 700, maxHeightMm: 650 },
        { id: 'above-base-style', minHeightMm: 0, maxHeightMm: 650 },
        { id: 'studio', name: 'Studio' },
      ],
    }, log);

    assert.deepEqual(settings.desks.map(desk => desk.id), ['office', 'studio']);
    assert.equal(log.lines.error.length, 5, 'each dropped desk is explained');
    assert.match(log.lines.error.join('\n'), /measured from the floor/, 'the floor frame is spelled out');
  });

  it('keeps favourites and rejects unusable ones', () => {
    const log = fakeLog();
    const settings = parseConfig({
      ...base,
      desks: [{
        id: 'office',
        favourites: [
          { name: 'Sitting', heightMm: 720 },
          { name: 'Standing', heightMm: 1150 },
          { name: 'Sitting', heightMm: 730 },
          { name: 'No height' },
          { name: 'Negative', heightMm: -5 },
        ],
      }],
    }, log);

    assert.deepEqual(settings.desks[0].favourites, [
      { name: 'Sitting', heightMm: 720 },
      { name: 'Standing', heightMm: 1150 },
    ]);
    assert.equal(log.lines.error.length, 3);
  });

  it('keeps only group favourites that name known desks', () => {
    const log = fakeLog();
    const settings = parseConfig({
      ...base,
      desks: [{ id: 'office', toleranceMm: 5, moveTimeoutSeconds: 10 }, { id: 'studio', toleranceMm: 20, moveTimeoutSeconds: 40 }],
      groupFavourites: [
        { name: 'Everyone Up', deskIds: ['office', 'studio', 'office'], heightMm: 1150 },
        { name: 'Ghost', deskIds: ['nowhere'], heightMm: 1150 },
        { name: 'No height', deskIds: ['office'] },
      ],
    }, log);

    assert.equal(settings.groupFavourites.length, 1);
    assert.deepEqual(settings.groupFavourites[0].deskIds, ['office', 'studio'], 'duplicates collapse');
    assert.equal(settings.groupFavourites[0].toleranceMm, 20, 'the most forgiving member wins');
    assert.equal(settings.groupFavourites[0].moveTimeoutMs, 40000);
  });

  it('returns nothing when no desk survives', () => {
    assert.equal(parseConfig({ ...base, desks: [] }, fakeLog()), undefined);
  });

  it('does not throw on wholly malformed input', () => {
    assert.doesNotThrow(() => parseConfig({ platform: 'LinakDesk', mqtt: 'nope', desks: 'nope' }, fakeLog()));
  });
});
