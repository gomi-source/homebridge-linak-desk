<p align="center">
<img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-vertical.png" width="150">
</p>

<span align="center">

# homebridge-linak-desk

[![npm version](https://img.shields.io/npm/v/homebridge-linak-desk.svg)](https://www.npmjs.com/package/homebridge-linak-desk)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-linak-desk.svg)](https://www.npmjs.com/package/homebridge-linak-desk)

</span>

Control the height of LINAK sit/stand desks from the Apple Home app.

This plugin does not talk to the desks directly. It is the HomeKit half of
[`mqtt-linak`](https://github.com/gomi-source/mqtt-linak), which keeps the
Bluetooth connections to the desks and exposes them as MQTT topics:

```
Apple Home <--> Homebridge <--> MQTT broker <--> mqtt-linak <--> LINAK DPG desk
                (this plugin)
```

## How a desk looks in the Home app

HomeKit has no desk. It has no height control of any kind, and neither HAP nor
Matter has anything closer, so each desk is exposed as a **window covering**:

- **0%** is the lowest position you configured, **100%** the highest.
- Dragging the slider moves the desk; the tile follows the desk as it moves,
  including when someone uses the panel on the desk itself.
- The Home app will describe the desk as "open" or "closed". That is the one
  place the analogy leaks; everything else — Siri ("set the desk to 80%"),
  automations, scenes — behaves the way you would want.

Dragging the slider sends a stream of positions, not one. A desk position is
absolute, so the plugin waits 400 ms for the drag to end and publishes only the
position you let go on — one move, not a queue of them. HomeKit still gets the
position you asked for straight away, so the slider never snaps back.

Each **favourite** you configure becomes a switch on the same accessory, so a
desk tile in Home expands into the height slider plus "Sitting", "Standing", and
whatever else you named. **Group favourites** are separate switch accessories
that move several desks at once.

A favourite switch is on exactly when the desk is resting at that height. It is
a description of where the desk is, not a memory of what you last pressed:

- Switching one on switches off every other favourite that touches the same
  desk, group favourites included — Apple Home has no radio group, so this is
  done here.
- The desk is then watched until it arrives. A favourite that does not get
  there — the desk was blocked, the bridge went away, someone pressed a button
  on the panel — **switches itself back off**, so the Home app never claims a
  position the desk is not in.
- Driving a desk onto a favourite's height by any other means — the slider, the
  panel on the desk, another automation — **switches that favourite on**, and
  moving it away switches it off. A group favourite comes on once all of its
  desks are there. After a Homebridge restart the switches come up matching
  wherever the desks already are, rather than all off.
- Switching a favourite off by hand does not move the desk; there is nothing
  sensible for "off" to mean physically. The switch then stays off while the
  desk sits there, rather than springing back on, and becomes live again once
  the desk leaves that height.

## Requirements

- Node.js 22 or 24
- Homebridge v1.8 or v2
- A running [`mqtt-linak`](https://github.com/gomi-source/mqtt-linak) bridge and
  the MQTT broker it publishes to

## Installation

Search for **LINAK Desk** in the Homebridge UI plugin screen, or:

```shell
sudo npm install -g homebridge-linak-desk
```

## Configuration

The Homebridge UI settings screen covers everything. The equivalent JSON:

```json
{
  "platforms": [
    {
      "platform": "LinakDesk",
      "name": "LINAK Desk",
      "mqtt": {
        "url": "mqtt://localhost:1883",
        "commandTopicBase": "cmd/linak",
        "metricTopicBase": "tele/linak"
      },
      "desks": [
        {
          "id": "office",
          "name": "Office Desk",
          "minHeightMm": 620,
          "maxHeightMm": 1200,
          "favourites": [
            { "name": "Sitting", "heightMm": 720 },
            { "name": "Standing", "heightMm": 1150 }
          ]
        },
        {
          "id": "studio",
          "name": "Studio Desk"
        }
      ],
      "groupFavourites": [
        {
          "name": "Everyone Stand Up",
          "deskIds": ["office", "studio"],
          "heightMm": 1150
        }
      ]
    }
  ]
}
```

### Everything is measured from the floor

Every height you configure — the two travel limits and every favourite — is in
**millimetres above the floor**, which is how anyone actually thinks about a
desk.

The desk itself does not work that way, and this is the one piece of plumbing
worth knowing about. It reports and accepts heights measured from its **own
base**, and publishes the distance from the floor to that base separately:

| Value | Measured from | Where it comes from |
|---|---|---|
| `height` | the desk's own base | `{metricTopicBase}/{deskId}/height`, and what moves are published as |
| `base_height` | the floor | `{metricTopicBase}/{deskId}/base_height` |

Height above the floor is `base_height + height`, and the plugin does that
arithmetic in both directions so you never have to. `mqtt-linak` deliberately
does none of it, which is why the two topics exist separately.

The consequence: **a desk cannot be mapped or moved until `base_height` has
arrived.** The bridge publishes it retained on every connect, so in practice it
is there within a second of Homebridge starting. If it is not, the desk shows as
*No Response* rather than guessing, and the log says so once. A favourite or a
position the configured range cannot reach is refused for the same reason —
better a switch that turns itself back off than a desk that goes somewhere you
did not ask for.

`minHeightMm` and `maxHeightMm` define the 0–100% range in HomeKit. The defaults
(620 and 1200) suit a typical LINAK DPG desk standing on the floor; set them to
where your desk actually stops at each end.

### Desk configuration

| Field | Default | Meaning |
|---|---|---|
| `id` | — | Required. The desk's `id` in the `mqtt-linak` config. `bridge` is reserved. |
| `name` | the id | Shown in the Home app. |
| `minHeightMm` | `620` | Lowest position, mm above the **floor**. HomeKit 0%. |
| `maxHeightMm` | `1200` | Highest position, mm above the **floor**. HomeKit 100%. |
| `toleranceMm` | `5` | How close to a favourite's height counts as arrived. |
| `moveTimeoutSeconds` | `30` | A favourite that has not arrived by then switches back off. |
| `favourites` | `[]` | `{ "name": ..., "heightMm": ... }`, height above the **floor**. |

### Group favourites

| Field | Meaning |
|---|---|
| `name` | Switch name in the Home app. |
| `deskIds` | Desk ids to move together. |
| `heightMm` | Height above the **floor**, in millimetres. |

Each group favourite is its own switch accessory. Tolerance and timeout are
taken from the most forgiving of its member desks.

### MQTT

| Field | Default | Meaning |
|---|---|---|
| `url` | `mqtt://localhost:1883` | `mqtt://` and `tcp://` are aliases, as are `mqtts://`, `ssl://` and `tls://`. `ws://`/`wss://` select the WebSocket transport instead. |
| `username`, `password` | — | Optional broker credentials. |
| `clientId` | random | Optional fixed client id. |
| `commandTopicBase` | `cmd/linak` | Must match `command_topic_base` in `mqtt-linak`. |
| `metricTopicBase` | `tele/linak` | Must match `metric_topic_base` in `mqtt-linak`. |
| `useAvailability` | `true` | Follow the bridge's availability topics. |

Topics used, all values in tenths of a millimetre:

| Direction | Topic |
|---|---|
| published | `{commandTopicBase}/{deskId}/height` |
| subscribed | `{metricTopicBase}/{deskId}/height` |
| subscribed | `{metricTopicBase}/{deskId}/base_height` |
| subscribed | `{metricTopicBase}/{deskId}/availability` |
| subscribed | `{metricTopicBase}/bridge/availability` |

With `useAvailability` on, a desk shows as **No Response** in the Home app while
the broker is unreachable, while the bridge publishes `offline`, or while that
desk's own Bluetooth connection is down — rather than showing a stale height as
if it were live.

## Troubleshooting

Run Homebridge with `-D` for this plugin's debug log, which prints every topic
it publishes and receives.

**A desk shows "No Response".** Most often `base_height` has not arrived; the
plugin needs both it and `height` before it can place the desk. Check the broker
connection first, then:

```shell
mosquitto_sub -t 'tele/linak/#' -v
```

You should see retained `height` and `base_height` values for the desk, and
`online` on both availability topics. If `height` never appears, the problem is
between `mqtt-linak` and the desk, not here.

**A favourite switches itself off again.** That is the verification working: the
desk did not reach the height within `moveTimeoutSeconds`. The log line says
where it stopped. Common causes are a favourite height outside the desk's
travel, a `toleranceMm` tighter than the desk can position, or something
physically in the way.

**The desk stutters through several short moves.** If it still does this after
letting go of the slider, the commands are arriving faster than `mqtt-linak` can
run them: it queues height commands eight deep and runs each move to completion
before starting the next, so any burst from any MQTT client becomes a sequence
of moves to stale targets. This plugin no longer produces such a burst; another
client on the same topics still can.

**The slider moves the desk to the wrong place.** Drive the desk to each end of
its travel with its own panel and add `base_height` to the `height` you see;
those two numbers are your `minHeightMm` and `maxHeightMm`.

## Development

```shell
npm install
npm run build
npm run lint
npm test
npm run watch   # rebuilds and restarts Homebridge on every change
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
