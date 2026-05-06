"use strict";

const WebSocket = require("ws");

let websocket = null;

function connect(port, pluginUUID, registerEvent, onMessageCallback) {
    console.log(`[WS] Connecting to ws://127.0.0.1:${port}`);
    websocket = new WebSocket(`ws://127.0.0.1:${port}`);

    websocket.on("open", () => {
        console.log(`[WS] Connected, sending register event...`);
        send(registerEvent, { uuid: pluginUUID });
    });

    websocket.on("message", (data) => {
        try {
            const msg = JSON.parse(String(data));
            console.log(`[WS] Received: ${msg.event || "unknown"}`);
            onMessageCallback(msg);
        } catch (e) {
            console.log(`[WS] Raw message error:`, e);
        }
    });

    websocket.on("close", () => {
        console.log("[WS] Connection closed");
        websocket = null;
    });

    websocket.on("error", (err) => {
        console.error("[WS] WebSocket error:", err?.message || err);
    });

    websocket.on("unexpected-response", (req, res) => {
        console.log(`[WS] Unexpected response: ${res.statusCode} ${res.statusMessage}`);
    });
}

function send(event, data) {
    if (!websocket || websocket.readyState !== WebSocket.OPEN) return;
    websocket.send(JSON.stringify({ event, ...data }));
}

function setSettings(context, settings) {
    send("setSettings", { context, payload: settings });
}

function setImage(context, imageDataUrl) {
    send("setImage", {
        context,
        payload: {
            image: imageDataUrl,
            target: 0
        }
    });
}

function setTitle(context, title) {
    send("setTitle", {
        context,
        payload: {
            title,
            target: 0
        }
    });
}

function sendToPropertyInspector(actionUuid, context, payload) {
    send("sendToPropertyInspector", {
        action: actionUuid,
        context,
        payload
    });
}

module.exports = {
    connect,
    setSettings,
    setImage,
    setTitle,
    sendToPropertyInspector
};