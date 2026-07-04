"use strict";

module.exports = {
    UUID_MIXER: "com.opendeck.pipewire.mixer",

    WPCTL_TIMEOUT_MS: 3000,
    POLL_INTERVAL_MS: 2500,
    PEAK_POLL_INTERVAL_MS: 100,

    defaultSettings: {
        nodeId: "",
        nodeName: "",
        nodeKind: "",
        accentColor: "#00d2ff",
        stepPercent: 0,
        isStatusOnly: false,
        peakAmplifier: 1,
        volume: 50,
        muted: false,
        peakLevel: 0
    }
};