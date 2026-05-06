"use strict";

const WebSocket = require("ws");

const PIPEWEAVER_WS_URL = "ws://localhost:14565/api/websocket";

let ws = null;
let reconnectTimer = null;
const colorMap = new Map();

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

                    // 1. Virtuellen Namen mappen (z.B. "browser")
                    const safeName = String(item.description.name).trim().toLowerCase();
                    colorMap.set(safeName, hex);

                    // 2. Hardware-Namen mappen (für echte Headsets/Mikrofone)
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

        console.log(`[PipeWeaver] ${colorMap.size} Farb-Mappings generiert.`);
    } catch (e) {
        console.error("[PipeWeaver] Fehler beim Parsen:", e.message);
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

    ws.on("open", () => ws.send(JSON.stringify({ id: 0, data: "GetStatus" })));

    ws.on("message", (rawData) => {
        try {
            const msg = JSON.parse(String(rawData));
            if (msg.data && msg.data.Status) extractColorsFromStatus(msg);
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

    // 1. Exakter Match
    if (colorMap.has(safeName)) return colorMap.get(safeName);

    // 2. Pipeweaver-Präfix entfernen (z.B. "PipeWeaver Browser" -> "browser")
    if (safeName.startsWith("pipeweaver ")) {
        safeName = safeName.replace("pipeweaver ", "").trim();
        if (colorMap.has(safeName)) return colorMap.get(safeName);
    }

    // 3. Fallback: Teilwortsuche (Wenn der WPCTL String etwas länger ist)
    for (const [pwName, hexColor] of colorMap.entries()) {
        if (safeName.includes(pwName)) return hexColor;
    }

    return null;
}

connect();

setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id: 0, data: "GetStatus" }));
    }
}, 10000);

module.exports = { getColorForNodeName };