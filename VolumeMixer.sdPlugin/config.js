"use strict";

module.exports = {
    UUID_INCREASE: "com.opendeck.pipewire.mixer.increaseBy",
    UUID_DECREASE: "com.opendeck.pipewire.mixer.decreaseBy",
    UUID_TOGGLE: "com.opendeck.pipewire.mixer.toggleMute",
    UUID_DB_STATUS: "com.opendeck.pipewire.mixer.dbStatus",

    WPCTL_TIMEOUT_MS: 3000,
    POLL_INTERVAL_MS: 2500,
    PEAK_POLL_INTERVAL_MS: 100,

    defaultSettings: {
        nodeId: "",
        nodeName: "",
        nodeKind: "",
        accentColor: "#00d2ff",
        stepPercent: 5,
        volume: 50,
        muted: false,
        peakLevel: 0
    }
};