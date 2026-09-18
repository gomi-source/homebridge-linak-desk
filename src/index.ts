import type { API } from 'homebridge';

import { LinakDeskPlatform } from './platform.js';
import { PLATFORM_NAME } from './settings.js';

/**
 * Registers the platform with Homebridge.
 */
export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, LinakDeskPlatform);
};
