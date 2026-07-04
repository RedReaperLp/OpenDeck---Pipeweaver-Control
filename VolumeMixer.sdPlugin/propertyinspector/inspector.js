"use strict";

let websocket = null;
let uuid = null;
let actionUUID = "de.redreaperlp.opendeck.mixer";

const state = {
    devices: [],
    profileTargets: [],
    defaultableOutputs: [],
    nodeId: "",
    targetId: "",
    targetIdA: "",
    targetIdB: "",
    stepPercent: 0,
    isStatusOnly: false,
    globalTrackAmp: 1,
    volume: 0,
    peakLevel: 0,
    muted: false,
    available: false,
    accentColor: "#00d2ff"
};

const els = {
    body: document.body,
    actionLabel: document.getElementById("actionLabel"),
    mixerRow: document.getElementById("mixerRow"),
    nodeSelect: document.getElementById("nodeSelect"),
    targetMuteRow: document.getElementById("targetMuteRow"),
    targetMuteSelect: document.getElementById("targetMuteSelect"),
    targetToggleRow: document.getElementById("targetToggleRow"),
    targetASelect: document.getElementById("targetASelect"),
    targetBSelect: document.getElementById("targetBSelect"),
    statusCheckboxRow: document.getElementById("statusCheckboxRow"),
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
    meterRow: document.getElementById("meterRow"),
    status: document.getElementById("status")
};

function isValidHexColor(value) { return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim()); }
function clampPercent(value) { const n = Number(value); return !Number.isFinite(n) ? 0 : Math.max(0, Math.min(100, Math.round(n))); }
function clampStep(value) { const n = Number(value); return !Number.isFinite(n) ? 0 : Math.max(-30, Math.min(30, Math.round(n))); }
function normalizeHexColor(value, fallback = "#00d2ff") { return !isValidHexColor(value) ? fallback : value.trim().toLowerCase(); }

function resolveActionString() {
    if (state.isStatusOnly) return "Status Only";
    if (state.stepPercent === 0) return "Mute Toggle";
    if (state.stepPercent > 0) return `Volume Up (Upper Key)`;
    return `Volume Down (Lower Key)`;
}

function updateStatus(text) { els.status.textContent = text; }

function updateActionVisibility() {
    const isMixer = actionUUID === "de.redreaperlp.opendeck.mixer";
    const isTargetMute = actionUUID === "de.redreaperlp.opendeck.target_mute";
    const isTargetToggle = actionUUID === "de.redreaperlp.opendeck.target_toggle";

    els.mixerRow.classList.toggle("hidden", !isMixer);
    els.targetMuteRow.classList.toggle("hidden", !isTargetMute);
    els.targetToggleRow.classList.toggle("hidden", !isTargetToggle);

    els.statusCheckboxRow.classList.toggle("hidden", !isMixer);
    els.stepRow.classList.toggle("hidden", !isMixer || state.isStatusOnly);
    els.ampRow.classList.toggle("hidden", !isMixer || !state.nodeId);
    els.meterRow.classList.toggle("hidden", !isMixer);

    if (isTargetMute) {
        els.actionLabel.textContent = "Action: Output Channel Mute";
    } else if (isTargetToggle) {
        els.actionLabel.textContent = "Action: Toggle Output (Default)";
    } else {
        els.actionLabel.textContent = `Action: ${resolveActionString()}`;
    }
}

function updateSliderUi() {
    updateActionVisibility();

    const isMixer = actionUUID === "de.redreaperlp.opendeck.mixer";
    if (!isMixer) return;

    const step = clampStep(state.stepPercent);
    const min = -30, max = 30;
    const progress = ((step - min) / (max - min)) * 100;

    els.stepSlider.value = String(step);
    els.stepSlider.style.setProperty("--step-progress", `${progress}%`);

    if (step === 0) els.stepValue.textContent = "Toggle";
    else if (step > 0) els.stepValue.textContent = `+${step}%`;
    else els.stepValue.textContent = `${step}%`;

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
    const isMixer = actionUUID === "de.redreaperlp.opendeck.mixer";
    const isTargetMute = actionUUID === "de.redreaperlp.opendeck.target_mute";
    const isTargetToggle = actionUUID === "de.redreaperlp.opendeck.target_toggle";

    // 1. Mixer Nodes
    els.nodeSelect.innerHTML = "";

    const defaultOpt = document.createElement("option");
    defaultOpt.value = "@DEFAULT_AUDIO_SINK@";
    defaultOpt.dataset.name = "Default Output Device (Dynamic)";
    defaultOpt.textContent = "[DYNAMIC] Default Output Device (Follows Default)";
    els.nodeSelect.appendChild(defaultOpt);

    for (const node of state.devices) {
        const opt = document.createElement("option");
        opt.value = String(node.id);
        opt.dataset.name = node.name;
        opt.textContent = `[${String(node.kind).toUpperCase()}] ${node.name}${node.isDefault ? " (Default)" : ""}`;
        els.nodeSelect.appendChild(opt);
    }

    if (state.nodeId === "@DEFAULT_AUDIO_SINK@") {
        els.nodeSelect.value = "@DEFAULT_AUDIO_SINK@";
    } else if (state.devices.some(n => String(n.id) === String(state.nodeId))) {
        els.nodeSelect.value = String(state.nodeId);
    } else if (isMixer && state.devices.length && !state.nodeId) {
        state.nodeId = "@DEFAULT_AUDIO_SINK@";
        els.nodeSelect.value = "@DEFAULT_AUDIO_SINK@";
        sendToPlugin({
            command: "setNode",
            nodeId: state.nodeId,
            nodeName: "Default Output Device (Dynamic)"
        });
    }

    // 2. Profile Targets
    els.targetMuteSelect.innerHTML = state.profileTargets.length ? "" : `<option value="">No output channels found</option>`;
    for (const target of state.profileTargets) {
        const opt = document.createElement("option");
        opt.value = String(target.id);
        opt.dataset.name = target.name;
        opt.textContent = `${target.name} (${target.mute_state})`;
        els.targetMuteSelect.appendChild(opt);
    }
    if (state.profileTargets.some(t => String(t.id) === String(state.targetId))) {
        els.targetMuteSelect.value = String(state.targetId);
    } else if (isTargetMute && state.profileTargets.length && !state.targetId) {
        state.targetId = state.profileTargets[0].id;
        els.targetMuteSelect.value = state.targetId;
        sendToPlugin({
            command: "setTargetMuteNode",
            targetId: state.targetId,
            targetName: state.profileTargets[0].name
        });
    }

    // 3. Profile Targets for Toggle (Target A / Target B)
    const optionsHtml = state.profileTargets.length 
        ? state.profileTargets.map(d => `<option value="${d.id}" data-name="${d.name}">${d.name}</option>`).join("")
        : `<option value="">No output channels found</option>`;

    els.targetASelect.innerHTML = optionsHtml;
    els.targetBSelect.innerHTML = optionsHtml;

    if (state.profileTargets.some(d => String(d.id) === String(state.targetIdA))) els.targetASelect.value = String(state.targetIdA);
    if (state.profileTargets.some(d => String(d.id) === String(state.targetIdB))) els.targetBSelect.value = String(state.targetIdB);

    if (isTargetToggle && state.profileTargets.length) {
        let changed = false;
        if (!state.targetIdA) {
            state.targetIdA = state.profileTargets[0].id;
            els.targetASelect.value = state.targetIdA;
            state.targetNameA = state.profileTargets[0].name;
            changed = true;
        }
        if (!state.targetIdB) {
            const second = state.profileTargets[1] || state.profileTargets[0];
            state.targetIdB = second.id;
            els.targetBSelect.value = second.id;
            state.targetNameB = second.name;
            changed = true;
        }
        if (changed) {
            sendToPlugin({
                command: "setTargetToggleNodes",
                targetIdA: state.targetIdA,
                targetNameA: state.targetNameA,
                targetIdB: state.targetIdB,
                targetNameB: state.targetNameB
            });
        }
    }
}

function sendToPlugin(payload) {
    if (websocket?.readyState === WebSocket.OPEN && uuid) {
        websocket.send(JSON.stringify({action: actionUUID, event: "sendToPlugin", context: uuid, payload}));
    }
}

function applyBackendStatus(payload) {
    if (Array.isArray(payload.devices)) state.devices = payload.devices;
    if (Array.isArray(payload.profileTargets)) state.profileTargets = payload.profileTargets;
    if (Array.isArray(payload.defaultableOutputs)) state.defaultableOutputs = payload.defaultableOutputs;

    if (payload.globalTrackAmp !== undefined) {
        state.globalTrackAmp = payload.globalTrackAmp;
    }

    if (payload.settings) {
        state.nodeId = String(payload.settings.nodeId || "");
        state.targetId = String(payload.settings.targetId || "");
        state.targetIdA = String(payload.settings.targetIdA || "");
        state.targetIdB = String(payload.settings.targetIdB || "");
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

    const isMixer = actionUUID === "de.redreaperlp.opendeck.mixer";
    const isTargetMute = actionUUID === "de.redreaperlp.opendeck.target_mute";
    const isTargetToggle = actionUUID === "de.redreaperlp.opendeck.target_toggle";

    if (isTargetMute) {
        updateStatus(state.targetId ? "Ready (Output Mute)." : "Please select output channel.");
    } else if (isTargetToggle) {
        updateStatus((state.targetIdA && state.targetIdB) ? "Ready (Output Toggle)." : "Please select both targets.");
    } else {
        updateStatus(state.nodeId ? (state.available ? "Ready." : "Node not available.") : "Please select audio track.");
    }
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

    els.targetMuteSelect.addEventListener("change", () => {
        const selectedOpt = els.targetMuteSelect.options[els.targetMuteSelect.selectedIndex];
        sendToPlugin({
            command: "setTargetMuteNode",
            targetId: String(els.targetMuteSelect.value || ""),
            targetName: selectedOpt ? selectedOpt.dataset.name : ""
        });
    });

    els.targetASelect.addEventListener("change", () => {
        const selectedOpt = els.targetASelect.options[els.targetASelect.selectedIndex];
        sendToPlugin({
            command: "setTargetToggleNodes",
            targetIdA: String(els.targetASelect.value || ""),
            targetNameA: selectedOpt ? selectedOpt.dataset.name : "",
            targetIdB: state.targetIdB,
            targetNameB: state.targetNameB
        });
    });

    els.targetBSelect.addEventListener("change", () => {
        const selectedOpt = els.targetBSelect.options[els.targetBSelect.selectedIndex];
        sendToPlugin({
            command: "setTargetToggleNodes",
            targetIdA: state.targetIdA,
            targetNameA: state.targetNameA,
            targetIdB: String(els.targetBSelect.value || ""),
            targetNameB: selectedOpt ? selectedOpt.dataset.name : ""
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
                state.targetId = String(actionInfo.payload.settings.targetId || "");
                state.targetIdA = String(actionInfo.payload.settings.targetIdA || "");
                state.targetIdB = String(actionInfo.payload.settings.targetIdB || "");
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
        if (msg.event === "sendToPropertyInspector" && msg.payload?.type === "status") {
            applyBackendStatus(msg.payload);
        } else if (msg.payload?.type === "peak") {
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