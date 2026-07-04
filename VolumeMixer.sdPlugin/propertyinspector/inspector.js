"use strict";

let websocket = null;
let uuid = null;
let actionUUID = "com.opendeck.pipewire.mixer";

const state = {
    devices: [],
    nodeId: "",
    stepPercent: 0,
    isStatusOnly: false,
    globalTrackAmp: 1, // <--- Speichert den globalen Wert
    volume: 0,
    peakLevel: 0,
    muted: false,
    available: false,
    accentColor: "#00d2ff"
};

const els = {
    body: document.body,
    actionLabel: document.getElementById("actionLabel"),
    nodeSelect: document.getElementById("nodeSelect"),
    statusCheckbox: document.getElementById("statusCheckbox"),
    stepRow: document.getElementById("stepRow"),
    stepSlider: document.getElementById("stepSlider"),
    stepValue: document.getElementById("stepValue"),
    ampRow: document.getElementById("ampRow"),
    ampSlider: document.getElementById("ampSlider"),
    ampValue: document.getElementById("ampValue"),
    volumeValue: document.getElementById("volumeValue"),
    muteValue: document.getElementById("muteValue"),
    meterFill: document.getElementById("meterFill"),
    status: document.getElementById("status")
};

function isValidHexColor(value) { return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim()); }
function clampPercent(value) { const n = Number(value); return !Number.isFinite(n) ? 0 : Math.max(0, Math.min(100, Math.round(n))); }
function clampStep(value) { const n = Number(value); return !Number.isFinite(n) ? 0 : Math.max(-30, Math.min(30, Math.round(n))); }
function normalizeHexColor(value, fallback = "#00d2ff") { return !isValidHexColor(value) ? fallback : value.trim().toLowerCase(); }

function resolveActionString() {
    if (state.isStatusOnly) return "Nur Status-Anzeige";
    if (state.stepPercent === 0) return "Mute Toggle";
    if (state.stepPercent > 0) return `Lauter (Obere Taste)`;
    return `Leiser (Untere Taste)`;
}

function updateStatus(text) { els.status.textContent = text; }

function updateSliderUi() {
    const step = clampStep(state.stepPercent);
    const min = -30, max = 30;
    const progress = ((step - min) / (max - min)) * 100;

    els.stepSlider.value = String(step);
    els.stepSlider.style.setProperty("--step-progress", `${progress}%`);

    if (step === 0) els.stepValue.textContent = "Toggle";
    else if (step > 0) els.stepValue.textContent = `+${step}%`;
    else els.stepValue.textContent = `${step}%`;

    els.actionLabel.textContent = `Aktion: ${resolveActionString()}`;

    els.stepRow.classList.toggle("hidden", state.isStatusOnly);
    els.statusCheckbox.checked = state.isStatusOnly;

    // --- Amp Slider Update ---
    els.ampRow.classList.toggle("hidden", !state.nodeId);

    const ampMin = 1, ampMax = 10;
    const ampProgress = ((state.globalTrackAmp - ampMin) / (ampMax - ampMin)) * 100;
    els.ampSlider.value = String(state.globalTrackAmp);
    els.ampSlider.style.setProperty("--step-progress", `${ampProgress}%`);
    els.ampValue.textContent = `${Number(state.globalTrackAmp).toFixed(1)}x`;
}

function updateTheme() {
    const muted = Boolean(state.muted);
    els.body.classList.toggle("muted", muted);
    els.body.style.setProperty("--accent", state.accentColor);
}

function updateMeter() {
    els.volumeValue.textContent = `${clampPercent(state.volume)}%`;
    els.muteValue.textContent = state.muted ? "MUTED" : "LIVE";
    els.muteValue.classList.toggle("muted", state.muted);
    els.meterFill.style.width = state.muted ? "100%" : `${clampPercent(state.peakLevel)}%`;
}

function renderNodes() {
    els.nodeSelect.innerHTML = state.devices.length ? "" : `<option value="">Keine Nodes gefunden</option>`;
    for (const node of state.devices) {
        const opt = document.createElement("option");
        opt.value = String(node.id);
        opt.dataset.name = node.name;
        opt.textContent = `[${String(node.kind).toUpperCase()}] ${node.name}${node.isDefault ? " (Default)" : ""}`;
        els.nodeSelect.appendChild(opt);
    }
    if (state.devices.some(n => String(n.id) === String(state.nodeId))) els.nodeSelect.value = String(state.nodeId);
}

function sendToPlugin(payload) {
    if (websocket?.readyState === WebSocket.OPEN && uuid) {
        websocket.send(JSON.stringify({action: actionUUID, event: "sendToPlugin", context: uuid, payload}));
    }
}

function applyBackendStatus(payload) {
    if (Array.isArray(payload.devices)) state.devices = payload.devices;

    if (payload.globalTrackAmp !== undefined) {
        state.globalTrackAmp = payload.globalTrackAmp;
    }

    if (payload.settings) {
        state.nodeId = String(payload.settings.nodeId || "");
        state.stepPercent = clampStep(payload.settings.stepPercent);
        state.isStatusOnly = Boolean(payload.settings.isStatusOnly);
        state.accentColor = normalizeHexColor(payload.settings.accentColor);
    }
    if (payload.state) {
        state.available = Boolean(payload.state.available);
        state.volume = clampPercent(payload.state.volume);
        state.peakLevel = clampPercent(payload.state.peakLevel);
        state.muted = Boolean(payload.state.muted);
    }
    updateTheme();
    updateSliderUi();
    renderNodes();
    updateMeter();
    updateStatus(state.nodeId ? (state.available ? "Bereit." : "Node nicht verfuegbar.") : "Bitte Audiospur auswaehlen.");
}

function wireEvents() {
    els.nodeSelect.addEventListener("change", () => {
        const selectedOpt = els.nodeSelect.options[els.nodeSelect.selectedIndex];
        sendToPlugin({
            command: "setNode",
            nodeId: String(els.nodeSelect.value || ""),
            nodeName: selectedOpt ? selectedOpt.dataset.name : ""
        });
    });
    els.statusCheckbox.addEventListener("change", () => {
        state.isStatusOnly = els.statusCheckbox.checked;
        updateSliderUi();
        sendToPlugin({command: "setFlags", isStatusOnly: state.isStatusOnly, stepPercent: state.stepPercent});
    });
    els.stepSlider.addEventListener("input", () => {
        state.stepPercent = clampStep(els.stepSlider.value);
        updateSliderUi();
        sendToPlugin({command: "setFlags", isStatusOnly: state.isStatusOnly, stepPercent: state.stepPercent});
    });
    els.ampSlider.addEventListener("input", () => {
        state.globalTrackAmp = Number(els.ampSlider.value) || 1;
        updateSliderUi();
        sendToPlugin({command: "setTrackAmp", nodeId: state.nodeId, peakAmplifier: state.globalTrackAmp});
    });
}

function connectElgatoStreamDeckSocket(inPort, inUUID, inRegisterEvent, inInfo, inActionInfo) {
    uuid = inUUID;
    if (inActionInfo) {
        try {
            const actionInfo = JSON.parse(inActionInfo);
            if (actionInfo.action) actionUUID = actionInfo.action;
            if (actionInfo.payload?.settings) {
                state.nodeId = String(actionInfo.payload.settings.nodeId || "");
                state.stepPercent = clampStep(actionInfo.payload.settings.stepPercent);
                state.isStatusOnly = Boolean(actionInfo.payload.settings.isStatusOnly);
                state.accentColor = normalizeHexColor(actionInfo.payload.settings.accentColor);
                updateTheme();
                updateSliderUi();
            }
        } catch (e) {}
    }

    websocket = new WebSocket(`ws://127.0.0.1:${inPort}`);
    websocket.onopen = () => {
        websocket.send(JSON.stringify({event: inRegisterEvent, uuid}));
        sendToPlugin({command: "requestNodes"});
    };
    websocket.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);
        if (msg.event === "sendToPropertyInspector" && msg.payload?.type === "status") applyBackendStatus(msg.payload); else if (msg.payload?.type === "peak") {
            applyBackendStatus({state: msg.payload.state});
            updateMeter();
        }
    };
}

wireEvents();
updateTheme();
updateSliderUi();
updateMeter();
window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;