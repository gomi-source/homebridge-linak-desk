---
name: Bug Report
about: Report a problem with the plugin
title: ''
labels: bug
assignees: ''
---

**Describe the bug**
A clear and concise description of what the bug is.

**To reproduce**
Steps to reproduce the behaviour.

**Expected behaviour**
What you expected to happen.

**Logs**

```
Paste the Homebridge log here, with the plugin in debug mode (homebridge -D).
```

**Plugin config**

```json
Paste your LinakDesk platform config here, with any broker credentials removed.
```

**mqtt-linak / broker**

- Does `mosquitto_sub -t '<metricTopicBase>/#' -v` show `height` and `base_height` for the desk?
- mqtt-linak version:

**Environment**

- Plugin version:
- Homebridge version:
- Node.js version:
- Operating system:
