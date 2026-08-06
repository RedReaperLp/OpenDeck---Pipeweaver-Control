# Project Rules & Architecture for VolumeControl

This file defines the codebase layout, architectural decisions, and developmental rules for working on the OpenDeck PipeWire Volume Mixer plugin.

---

## 1. Repository Structure & Key Components

- **[VolumeMixer.sdPlugin/plugin.js](./VolumeMixer.sdPlugin/plugin.js):** The main entrypoint. Handles Stream Deck plugin lifecycle events (`willAppear`, `willDisappear`, `didReceiveSettings`, `keyUp`), maintains in-memory contexts, and schedules updates.
- **[VolumeMixer.sdPlugin/audio-service.js](./VolumeMixer.sdPlugin/audio-service.js):** Integrates with `wpctl` to list audio nodes, fetch volume/mute states, set volumes, and perform hard muting.
- **[VolumeMixer.sdPlugin/pipeweaver-client.js](./VolumeMixer.sdPlugin/pipeweaver-client.js):** Manages a WebSocket connection to the Pipeweaver daemon. Synchronizes layout routing profile targets and outputs.
- **[VolumeMixer.sdPlugin/svg-renderer.js](./VolumeMixer.sdPlugin/svg-renderer.js):** Builds dynamic SVG button overlays displaying volume levels, peak level animations, and mute indicators.
- **[VolumeMixer.sdPlugin/propertyinspector/](./VolumeMixer.sdPlugin/propertyinspector/):** Contains the configuration UI shown in the OpenDeck client when a button is selected.

---

## 2. Architectural Guidelines & Hard Constraints

### A. Persistent Configuration vs. Transient IDs
- **Rule:** Never invoke `opendeck.setSettings` inside asynchronous status update loops (e.g. inside `syncContext`).
- **Rationale:** OpenDeck persistent configuration should only store user-intent settings (like `nodeName: "Firefox"` or profile target UUIDs). `syncContext` resolves these names to transient PipeWire IDs (like `228`) at runtime. Overwriting the persistent configuration with these transient IDs causes buttons to break or hijack other applications when IDs are reused by PipeWire.
- Settings must only be written to OpenDeck database during explicit property inspector commands (`setNode`, `setTargetMuteNode`, etc.).

### B. Race Conditions and Visibility Caching
- **Rule:** Do not delete context configuration from memory inside `willDisappear` events. Instead, set `runtime.visible = false`. On `willAppear`, set `runtime.visible = true`.
- **Rationale:** Deleting the button from memory causes settings loss if OpenDeck does not send the settings payload on reappearing. By caching configurations in memory, settings are preserved when switching pages or profiles back and forth.
- **Rule:** Verify `runtime !== contexts.get(context)` and check `myVersion === runtime.syncVersion` after all `await` statements in `syncContext`.
- **Rationale:** Prevents out-of-order writes from slow background processes when profiles are switched rapidly.

### C. CPU Performance & Polling
- **Rule:** Only execute system-level queries (`wpctl`) and image rendering for visible buttons.
- **Filter Check:** Inside `syncContext`, interval syncs, and the StatusListener, check `if (!runtime.visible) return;`.

### D. Audio Stream Filtering
- **Rule:** Filter out internal channel linkage and monitor ports from the `Streams` section in `audio-service.js`.
- **Filtering Logic:** Ignore stream names that start with `monitor_`, `output_`, `input_` or contain/match channel layout suffixes (e.g. `_FL`, `_FR`, etc.) so only user-facing application names are exposed.

---

## 3. WebSocket Command Mapping (Pipeweaver)

- **Default Output Switching (`setDefaultOutput`):** Must pass the physical defaultable output ID (starts with `01KZC...` or matching name).
- **Mute Target Toggling (`setTargetMute`):** Must pass the profile target ID (starts with `01KZC...`).
- **Mute State Source of Truth:** Use the profile target's `mute_state` (`"Unmuted"` vs `"Muted"`) to determine active toggle states.
