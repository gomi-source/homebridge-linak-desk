import type { Logging, PlatformConfig } from 'homebridge';

/**
 * `bridge` is reserved by mqtt-linak for its own availability topic, so it can
 * never be a desk id.
 */
export const RESERVED_DESK_ID = 'bridge';

export const DEFAULTS = {
  url: 'mqtt://localhost:1883',
  commandTopicBase: 'cmd/linak',
  metricTopicBase: 'tele/linak',
  /**
   * Every height in this plugin's config is measured from the floor, so these
   * defaults describe a typical LINAK DPG desk standing on the floor rather
   * than the column's own travel.
   */
  minHeightMm: 620,
  maxHeightMm: 1200,
  toleranceMm: 5,
  moveTimeoutSeconds: 30,
  /** How long the height has to stay unchanged before a move counts as finished. */
  settleMilliseconds: 1500,
} as const;

export interface FavouriteConfig {
  /** Shown in the Home app as the switch name. */
  name: string;
  /** Height above the floor, in millimetres. */
  heightMm: number;
}

export interface DeskConfig {
  id: string;
  name: string;
  /** Lowest reachable height above the floor, in millimetres. 0% in HomeKit. */
  minHeightMm: number;
  /** Highest reachable height above the floor, in millimetres. 100% in HomeKit. */
  maxHeightMm: number;
  /** How close to a favourite's height counts as having arrived. */
  toleranceMm: number;
  moveTimeoutMs: number;
  settleMs: number;
  favourites: FavouriteConfig[];
}

export interface GroupFavouriteConfig {
  name: string;
  deskIds: string[];
  /** Height above the floor, in millimetres. */
  heightMm: number;
  toleranceMm: number;
  moveTimeoutMs: number;
}

export interface MqttSettings {
  url: string;
  username?: string;
  password?: string;
  clientId: string;
  commandTopicBase: string;
  metricTopicBase: string;
  /** Mirror the bridge's availability topics into HomeKit reachability. */
  useAvailability: boolean;
}

export interface LinakDeskSettings {
  mqtt: MqttSettings;
  desks: DeskConfig[];
  groupFavourites: GroupFavouriteConfig[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (value.trim().length > 0 && Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Strips the leading and trailing slashes a user is likely to type, and
 * rejects wildcards, which would make the topic ambiguous.
 */
function normaliseTopicBase(value: string): string | undefined {
  const trimmed = value.replace(/^\/+|\/+$/g, '');
  if (trimmed.length === 0 || trimmed.includes('+') || trimmed.includes('#')) {
    return undefined;
  }
  return trimmed;
}

function parseFavourites(raw: unknown[], deskId: string, log: Logging): FavouriteConfig[] {
  const favourites: FavouriteConfig[] = [];
  const seenNames = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    const record = asRecord(entry);
    const name = record === undefined ? undefined : asTrimmedString(record.name);
    const heightMm = record === undefined ? undefined : asFiniteNumber(record.heightMm);

    if (name === undefined || heightMm === undefined) {
      log.error(`Desk ${JSON.stringify(deskId)}: favourite ${index} needs both a name and a heightMm, ignoring it.`);
      continue;
    }
    if (heightMm <= 0) {
      log.error(`Desk ${JSON.stringify(deskId)}: favourite ${JSON.stringify(name)} has a heightMm of ${heightMm}, which is not a height above the floor.`);
      continue;
    }
    const key = name.toLowerCase();
    if (seenNames.has(key)) {
      log.error(`Desk ${JSON.stringify(deskId)}: favourite ${JSON.stringify(name)} is configured more than once, ignoring the duplicate.`);
      continue;
    }

    seenNames.add(key);
    favourites.push({ name, heightMm });
  }

  return favourites;
}

function parseDesks(raw: unknown[], log: Logging): DeskConfig[] {
  const desks: DeskConfig[] = [];
  const seenIds = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    const record = asRecord(entry);
    if (record === undefined) {
      log.error(`desks[${index}] is not an object, ignoring it.`);
      continue;
    }

    const id = asTrimmedString(record.id);
    if (id === undefined) {
      log.error(`desks[${index}] has no id, ignoring it. The id must match the desk id in the mqtt-linak config.`);
      continue;
    }
    if (id === RESERVED_DESK_ID) {
      log.error(`desks[${index}] uses the reserved id ${JSON.stringify(RESERVED_DESK_ID)}, ignoring it.`);
      continue;
    }
    if (seenIds.has(id)) {
      log.error(`Desk id ${JSON.stringify(id)} is configured more than once, ignoring the duplicate.`);
      continue;
    }

    const minHeightMm = asFiniteNumber(record.minHeightMm) ?? DEFAULTS.minHeightMm;
    const maxHeightMm = asFiniteNumber(record.maxHeightMm) ?? DEFAULTS.maxHeightMm;
    if (maxHeightMm <= minHeightMm) {
      log.error(`Desk ${JSON.stringify(id)} has maxHeightMm (${maxHeightMm}) at or below minHeightMm (${minHeightMm}), ignoring the desk.`);
      continue;
    }
    if (minHeightMm <= 0) {
      log.error(
        `Desk ${JSON.stringify(id)} has a minHeightMm of ${minHeightMm}, which is not a height above the floor, ignoring the desk. `
        + 'Both travel limits are measured from the floor, like the favourites.',
      );
      continue;
    }

    const toleranceMm = Math.abs(asFiniteNumber(record.toleranceMm) ?? DEFAULTS.toleranceMm);
    const moveTimeoutSeconds = asFiniteNumber(record.moveTimeoutSeconds) ?? DEFAULTS.moveTimeoutSeconds;

    seenIds.add(id);
    desks.push({
      id,
      name: asTrimmedString(record.name) ?? id,
      minHeightMm,
      maxHeightMm,
      toleranceMm: toleranceMm > 0 ? toleranceMm : DEFAULTS.toleranceMm,
      moveTimeoutMs: Math.max(1, moveTimeoutSeconds) * 1000,
      settleMs: DEFAULTS.settleMilliseconds,
      favourites: parseFavourites(asArray(record.favourites), id, log),
    });
  }

  return desks;
}

function parseGroupFavourites(raw: unknown[], desks: DeskConfig[], log: Logging): GroupFavouriteConfig[] {
  const groups: GroupFavouriteConfig[] = [];
  const knownIds = new Map(desks.map(desk => [desk.id, desk]));
  const seenNames = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    const record = asRecord(entry);
    const name = record === undefined ? undefined : asTrimmedString(record.name);
    const heightMm = record === undefined ? undefined : asFiniteNumber(record.heightMm);

    if (record === undefined || name === undefined || heightMm === undefined) {
      log.error(`groupFavourites[${index}] needs both a name and a heightMm, ignoring it.`);
      continue;
    }
    if (heightMm <= 0) {
      log.error(`Group favourite ${JSON.stringify(name)} has a heightMm of ${heightMm}, which is not a height above the floor, ignoring it.`);
      continue;
    }

    const deskIds: string[] = [];
    for (const candidate of asArray(record.deskIds)) {
      const deskId = asTrimmedString(candidate);
      if (deskId === undefined) {
        continue;
      }
      if (!knownIds.has(deskId)) {
        log.error(`Group favourite ${JSON.stringify(name)} refers to unknown desk id ${JSON.stringify(deskId)}, skipping that desk.`);
        continue;
      }
      if (!deskIds.includes(deskId)) {
        deskIds.push(deskId);
      }
    }
    if (deskIds.length === 0) {
      log.error(`Group favourite ${JSON.stringify(name)} has no usable deskIds, ignoring it.`);
      continue;
    }

    const key = name.toLowerCase();
    if (seenNames.has(key)) {
      log.error(`Group favourite ${JSON.stringify(name)} is configured more than once, ignoring the duplicate.`);
      continue;
    }

    const members = deskIds.map(deskId => knownIds.get(deskId)).filter((desk): desk is DeskConfig => desk !== undefined);
    seenNames.add(key);
    groups.push({
      name,
      deskIds,
      heightMm,
      toleranceMm: Math.max(...members.map(desk => desk.toleranceMm)),
      moveTimeoutMs: Math.max(...members.map(desk => desk.moveTimeoutMs)),
    });
  }

  return groups;
}

/**
 * Turns the raw Homebridge config into a validated, fully defaulted settings
 * object. Anything wrong with a single desk or favourite is logged and that
 * entry is dropped, so one bad line never stops the rest of the platform.
 * Returns `undefined` only when nothing usable is left.
 */
export function parseConfig(config: PlatformConfig, log: Logging): LinakDeskSettings | undefined {
  const mqttRaw = asRecord(config.mqtt) ?? {};

  const url = asTrimmedString(mqttRaw.url) ?? DEFAULTS.url;
  // mqtt/tcp and mqtts/ssl/tls are aliases for the same transports, both here
  // and in the Go client mqtt-linak uses, so a config copied from either side
  // works. Checked up front because MQTT.js answers an unrecognised scheme by
  // quietly falling back to another transport rather than failing.
  if (!/^(mqtt|mqtts|tcp|ssl|tls|ws|wss):\/\//i.test(url)) {
    log.error(`mqtt.url ${JSON.stringify(url)} is not a broker URL (expected for example mqtt://host:1883). Platform not started.`);
    return undefined;
  }

  const commandTopicBase = normaliseTopicBase(asTrimmedString(mqttRaw.commandTopicBase) ?? DEFAULTS.commandTopicBase);
  const metricTopicBase = normaliseTopicBase(asTrimmedString(mqttRaw.metricTopicBase) ?? DEFAULTS.metricTopicBase);
  if (commandTopicBase === undefined || metricTopicBase === undefined) {
    log.error('mqtt.commandTopicBase and mqtt.metricTopicBase must be non-empty and free of the + and # wildcards. Platform not started.');
    return undefined;
  }

  const mqtt: MqttSettings = {
    url,
    clientId: asTrimmedString(mqttRaw.clientId) ?? `homebridge-linak-desk-${Math.random().toString(16).slice(2, 10)}`,
    commandTopicBase,
    metricTopicBase,
    useAvailability: asBoolean(mqttRaw.useAvailability, true),
  };

  const username = asTrimmedString(mqttRaw.username);
  if (username !== undefined) {
    mqtt.username = username;
  }
  const password = typeof mqttRaw.password === 'string' && mqttRaw.password.length > 0 ? mqttRaw.password : undefined;
  if (password !== undefined) {
    mqtt.password = password;
  }

  const desks = parseDesks(asArray(config.desks), log);
  if (desks.length === 0) {
    log.error('No usable desks configured. Add at least one desk with an id matching a desk in the mqtt-linak config.');
    return undefined;
  }

  const groupFavourites = parseGroupFavourites(asArray(config.groupFavourites), desks, log);

  return { mqtt, desks, groupFavourites };
}
