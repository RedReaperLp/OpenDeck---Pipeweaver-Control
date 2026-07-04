# PipeWire & PipeWeaver Volume Control Plugin for OpenDeck

A premium OpenDeck & StreamController plugin designed to manage **PipeWire** audio nodes and sync seamlessly with the **PipeWeaver** streamer routing daemon.

---

## Key Features

### 1. Dynamic Audio Mixer & Fader (`com.opendeck.pipewire.mixer`)
* **Volume Adjustment**: Map keys/encoders to increase or decrease volume with custom step sizes.
* **Mute Toggle**: Easily mute or unmute individual applications or devices.
* **Status-Only Mode**: Display live state, volume percentage, and peak levels without registering key clicks.
* **Live Peak Metering**: Real-time volume level indicators powered by `pw-record` with a smooth decay filter.
* **Volume Meter Amplifier**: Boost level feedback for quiet audio tracks directly within the Property Inspector.
* **Auto-Color Syncing**: Automatically reads active application colors configured in your PipeWeaver profile.

### 2. [NEW] Dynamic Default Output Control (`@DEFAULT_AUDIO_SINK@`)
* Choose the **`[DYNAMIC] Default Output Device`** option in the mixer track dropdown.
* This key dynamically controls the volume, mute, and peak levels of whatever output device is currently set as the system default.
* If you toggle your default output (e.g. Speaker to Headphone), this key **automatically follows the switch**, showing the new device's level, peaks, and updating its color scheme instantly.

### 3. Output Channel Muting (`com.opendeck.pipewire.target_mute`)
* Mute or unmute specific output profile channels (e.g., *Speakers*, *Headset*, *Chat Mic*) directly via PipeWeaver's WebSocket API.
* Clean visual indicators showing custom mute icons with a clear red slash when inactive.

### 4. Output Device Toggling (`com.opendeck.pipewire.target_toggle`)
* **Dual Action Toggle**: Switches your default system output between two chosen outputs (Target A & Target B).
* **Automatic A/B Mute Swap**: Simultaneously unmutes the active output's PipeWeaver routing profile while muting the inactive one. This ensures both *unmanaged* system audio and *matrix-routed* streamer channels redirect seamlessly.
* **Intelligent ID Resolution**: Dynamically maps configuration profiles even if target IDs shift during PipeWeaver/OpenDeck restarts.
* Displays a checkmark and custom color outline indicating which target is active.

---

## Installation & Requirements

1. Ensure **PipeWire** and **WirePlumber** are installed and running on your Linux system.
2. Ensure **PipeWeaver** is running (`ws://localhost:14565`).
3. Place this plugin folder (`VolumeMixer.sdPlugin`) inside your OpenDeck or StreamController plugin directory.
4. Reload/Restart your deck software.

---

## Usage Guide

### Controlling the Current System Volume (Dynamic)
1. Add a **Mixer** action.
2. Open the Property Inspector.
3. Choose **`[DYNAMIC] Default Output Device (Follows Default)`** in the dropdown.
4. Set the step size to `0` for Mute Toggle, or a positive/negative percentage to turn it into a volume adjuster key.

### Configuring Output Toggle (A/B Switch)
1. Add a **Toggle Output** action.
2. Open the Property Inspector.
3. Select **Target A** (e.g., *Speakers*) and **Target B** (e.g., *Headset*).
4. Save the configuration. Toggling the button will now swap both system defaults and active mix profile paths.
