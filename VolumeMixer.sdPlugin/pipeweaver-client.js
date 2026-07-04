"use strict";

const WebSocket = require("ws");

const PIPEWEAVER_WS_URL = "ws://localhost:14565/api/websocket";

let ws = null;
let reconnectTimer = null;
const colorMap = new Map();

let latestStatus = null;
const statusListeners = new Set();
let commandId = 1;

function rgbToHex(r, g, b) {
    return "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1).toLowerCase();
}

function extractColorsFromStatus(statusData) {
    try {
        const devices = statusData?.data?.Status?.audio?.profile?.devices;
        if (!devices) return;

        colorMap.clear();

        const parseList = (list) => {
            if (!Array.isArray(list)) return;
            for (const item of list) {
                if (item.description && item.description.name && item.description.colour) {
                    const { red, green, blue } = item.description.colour;
                    const hex = rgbToHex(red, green, blue);

                    // 1. Map virtual name (e.g. "browser")
                    const safeName = String(item.description.name).trim().toLowerCase();
                    colorMap.set(safeName, hex);

                    // 2. Map hardware names (for real headsets/microphones)
                    if (Array.isArray(item.attached_devices)) {
                        for (const att of item.attached_devices) {
                            if (att.description) {
                                const attName = String(att.description).trim().toLowerCase();
                                colorMap.set(attName, hex);
                            }
                        }
                    }
                }
            }
        };

        parseList(devices.sources?.physical_devices);
        parseList(devices.sources?.virtual_devices);
        parseList(devices.targets?.physical_devices);
        parseList(devices.targets?.virtual_devices);

        console.log(`[PipeWeaver] Generated ${colorMap.size} color mappings.`);
    } catch (e) {
        console.error("[PipeWeaver] Error parsing status:", e.message);
    }
}

function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    try {
        ws = new WebSocket(PIPEWEAVER_WS_URL, { headers: { "Origin": "http://localhost:14565" } });
    } catch (err) {
        scheduleReconnect();
        return;
    }

    ws.on("open", () => {
        console.log("[PipeWeaver] WebSocket connected.");
        ws.send(JSON.stringify({ id: 0, data: "GetStatus" }));
    });

    ws.on("message", (rawData) => {
        try {
            const msg = JSON.parse(String(rawData));
            if (msg.data && msg.data.Status) {
                latestStatus = msg.data.Status;
                extractColorsFromStatus(msg);
                notifyListeners();
            } else if (msg.data && msg.data.Patch) {
                // Fetch the full status on any patch update
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ id: 0, data: "GetStatus" }));
                }
            }
        } catch (e) {}
    });

    ws.on("close", () => {
        ws = null;
        scheduleReconnect();
    });
    ws.on("error", () => {});
}

function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 5000);
}

function getColorForNodeName(name) {
    if (!name) return null;
    let safeName = String(name).trim().toLowerCase();

    // 1. Exact match
    if (colorMap.has(safeName)) return colorMap.get(safeName);

    // 2. Remove PipeWeaver prefix (e.g. "PipeWeaver Browser" -> "browser")
    if (safeName.startsWith("pipeweaver ")) {
        safeName = safeName.replace("pipeweaver ", "").trim();
        if (colorMap.has(safeName)) return colorMap.get(safeName);
    }

    // 3. Fallback: Substring search (useful for longer wpctl names)
    for (const [pwName, hexColor] of colorMap.entries()) {
        if (safeName.includes(pwName)) return hexColor;
    }

    return null;
}

// --- Status & Control API ---

function registerStatusListener(listener) {
    statusListeners.add(listener);
    if (latestStatus) {
        try {
            listener(latestStatus);
        } catch (e) {}
    }
}

function unregisterStatusListener(listener) {
    statusListeners.delete(listener);
}

function notifyListeners() {
    for (const listener of statusListeners) {
        try {
            listener(latestStatus);
        } catch (e) {
            console.error("[PipeWeaver] Error in status listener:", e);
        }
    }
}

function sendCommand(command) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.error("[PipeWeaver] Cannot send command: WebSocket not connected");
        return;
    }
    const msg = {
        id: commandId++,
        data: {
            Pipewire: command
        }
    };
    ws.send(JSON.stringify(msg));
}

function getProfileTargets() {
    if (!latestStatus) return [];
    const targets = latestStatus.audio?.profile?.devices?.targets || {};
    const physical = targets.physical_devices || [];
    const virtual = targets.virtual_devices || [];

    return [
        ...physical.map(d => ({ id: d.description.id, name: d.description.name, kind: "physical", mute_state: d.mute_state, colour: d.description.colour, attached_devices: d.attached_devices })),
        ...virtual.map(d => ({ id: d.description.id, name: d.description.name, kind: "virtual", mute_state: d.mute_state, colour: d.description.colour, attached_devices: d.attached_devices }))
    ];
}

function getDefaultableOutputs() {
    if (!latestStatus) return [];
    const devices = latestStatus.audio?.devices?.Target || [];
    return devices.map(d => ({ id: d.id, name: d.name, description: d.description || d.name, node_id: d.node_id }));
}

function getDefaultOutputId() {
    return latestStatus?.audio?.defaults_id?.Target || null;
}

function getTargetMuteState(targetId) {
    if (!latestStatus) return null;
    const targets = getProfileTargets();
    const found = targets.find(t => t.id === String(targetId));
    return found ? found.mute_state : null;
}

function setTargetMute(targetId, muteState) {
    sendCommand({ SetTargetMuteState: [String(targetId), muteState] });
}

function setDefaultOutput(deviceId) {
    sendCommand({ SetDefaultOutput: String(deviceId) });
}

connect();

setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id: 0, data: "GetStatus" }));
    }
}, 10000);

module.exports = {
    getColorForNodeName,
    registerStatusListener,
    unregisterStatusListener,
    getProfileTargets,
    getDefaultableOutputs,
    getDefaultOutputId,
    getTargetMuteState,
    setTargetMute,
    setDefaultOutput
};