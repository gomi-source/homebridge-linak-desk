# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-09-19

### Changed

- A favourite switch now describes where a desk **is**, rather than remembering
  what was last pressed. It turns on whenever every desk it covers comes to rest
  within tolerance of its height — whether that was the Home slider, the panel
  on the desk itself, or another automation — and off again when a desk leaves.
  Previously only the switching-off half was detected, so a desk driven onto a
  favourite by any other means left the switch stubbornly off.
- Favourite switches are restored on startup to match where the desks already
  are, instead of all coming up off.
- Switching a favourite off by hand now stays off while the desk remains at that
  height, rather than being immediately switched back on by the rule above. It
  becomes live again as soon as the desk leaves.

### Fixed

- Accept `tls://` broker URLs, which MQTT.js supports but the plugin's own URL
  validation rejected.

## [0.1.0] - 2026-09-18

Initial release.

### Added

- **Desks as window coverings.** Each configured desk appears in Apple Home as a
  Window Covering, where 0% is its lowest configured position and 100% its
  highest. HomeKit, HAP and Matter have nothing desk-shaped, and a window
  covering is the closest fit: a position, a target and a direction of travel.
  The tile follows the desk as it moves, including when it is driven from its
  own panel.
- **Favourite positions as switches.** Any number per desk, each becoming a
  Switch service on the same accessory. Switching one on moves the desk and
  switches off every other favourite touching that desk, since Apple Home has no
  radio group of its own. The move is then verified: a favourite whose desk does
  not arrive within the timeout switches itself back off rather than claiming a
  position the desk is not in.
- **Group favourites**, moving any set of desks to one height as a single switch
  accessory, verified the same way — all the desks have to arrive.
- **Heights configured from the floor**, in millimetres, for both the travel
  limits and every favourite. The desk itself reports and accepts heights above
  its own base and publishes the floor offset separately; the plugin reconciles
  the two so the config only ever speaks in one frame.
- **Reachability from the bridge's availability topics.** A desk shows as *No
  Response* in the Home app while the broker is unreachable, while `mqtt-linak`
  reports itself offline, or while that desk's own Bluetooth connection is down,
  rather than showing a stale height as if it were live.
- **Drag coalescing.** The Home app streams positions while the slider is
  dragged; only the position it comes to rest on is published, so the desk makes
  one move instead of a queue of moves to stale targets.
- **Settings UI** via `config.schema.json`, covering the broker, every desk and
  both kinds of favourite.
- **Dynamic platform** behaviour throughout: accessories are cached between
  restarts, and desks, favourites or groups removed from the config are
  unregistered on the next start.
- Supports Node.js 22 and 24, Homebridge v1.8 and v2.

[0.1.1]: https://github.com/gomi-source/homebridge-linak-desk/compare/0.1.0...0.1.1
[0.1.0]: https://github.com/gomi-source/homebridge-linak-desk/releases/tag/0.1.0
