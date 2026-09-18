import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The name of the platform users put in the Homebridge `config.json`.
 * Must match `pluginAlias` in `config.schema.json`.
 */
export const PLATFORM_NAME = 'LinakDesk';

/**
 * Must match the `name` property of `package.json`.
 */
export const PLUGIN_NAME = 'homebridge-linak-desk';

export const MANUFACTURER = 'LINAK';
export const MODEL_DESK = 'DPG Desk';
export const MODEL_GROUP = 'Desk Group';

/**
 * Reported to HomeKit as the firmware revision of every accessory this plugin
 * creates. Read from `package.json` so it never drifts from the release.
 */
export const PLUGIN_VERSION: string = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, '..', 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
