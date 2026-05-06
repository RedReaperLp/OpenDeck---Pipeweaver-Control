"use strict";

let websocket = null;
let uuid = null;
let actionInfo = null;

const state = {
  actionType: "toggleMute",
  devices: [],
  nodeId: "",
  stepPercent: 5,
  volume: 0,
  peakLevel: 0,
  muted: false,
  available: false,
  accentColor: "#00d2ff"
};

const ACTION_LABELS = {
  dbStatus: "DbStatus",
  increaseBy: "IncreaseBy",
  decreaseBy: "DecreaseBy",
  toggleMute: "ToggleMute"
};

const els = {
  body: document.body,
  actionLabel: document.getElementById("actionLabel"),
  nodeSelect: document.getElementById("nodeSelect"),
  stepRow: document.getElementById("stepRow"),
  stepSlider: document.getElementById("stepSlider"),
  stepValue: document.getElementById("stepValue"),
  accentPicker: document.getElementById("accentPicker"),
  accentValue: document.getElementById("accentValue"),
  volumeValue: document.getElementById("volumeValue"),
  muteValue: document.getElementById("muteValue"),
  meterFill: document.getElementById("meterFill"),
  status: document.getElementById("status")
};

function isValidHexColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim());
}

function clampStep(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(30, Math.round(n)));
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeHexColor(value, fallback = "#00d2ff") {
  if (!isValidHexColor(value)) return fallback;
  return value.trim().toLowerCase();
}

function isStepAction() {
  return state.actionType === "increaseBy" || state.actionType === "decreaseBy";
}

function updateStatus(text) {
  els.status.textContent = text;
}

function updateSliderProgress() {
  const step = clampStep(state.stepPercent);
  const min = Number(els.stepSlider.min) || 1;
  const max = Number(els.stepSlider.max) || 30;
  const progress = ((step - min) / (max - min)) * 100;
  els.stepSlider.style.setProperty("--step-progress", `${progress}%`);
}

function updateTheme() {
  const muted = Boolean(state.muted);
  els.body.classList.toggle("muted", muted);
  els.body.style.setProperty("--accent", state.accentColor);
}

function updateAccentUi() {
  const color = normalizeHexColor(state.accentColor);
  state.accentColor = color;
  els.accentPicker.value = color;
  els.accentValue.textContent = color.toUpperCase();
  els.accentValue.style.color = color;
}

function updateStepUi() {
  const step = clampStep(state.stepPercent);
  state.stepPercent = step;
  els.stepSlider.value = String(step);
  els.stepValue.textContent = `${step}%`;
  els.stepRow.classList.toggle("hidden", !isStepAction());
  updateSliderProgress();
}

function updateActionUi() {
  els.actionLabel.textContent = `Action: ${ACTION_LABELS[state.actionType] || state.actionType}`;
  updateStepUi();
  updateAccentUi();
}

function updateMeter() {
  const volume = clampPercent(state.volume);
  const peak = clampPercent(state.peakLevel);
  const muted = Boolean(state.muted);

  els.volumeValue.textContent = `${volume}%`;
  els.muteValue.textContent = muted ? "MUTED" : "LIVE";
  els.muteValue.classList.toggle("muted", muted);
  els.meterFill.style.width = muted ? "100%" : `${peak}%`;
}

function renderNodes() {
  const list = state.devices;
  els.nodeSelect.innerHTML = "";

  if (!list.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Keine steuerbaren Nodes gefunden";
    els.nodeSelect.appendChild(opt);
    return;
  }

  for (const node of list) {
    const opt = document.createElement("option");
    opt.value = String(node.id);
    const prefix = String(node.kind || "node").toUpperCase();
    const def = node.isDefault ? " (Default)" : "";
    opt.textContent = `[${prefix}] ${node.name}${def}`;
    els.nodeSelect.appendChild(opt);
  }

  const exists = list.some((node) => String(node.id) === String(state.nodeId));
  els.nodeSelect.value = exists ? String(state.nodeId) : String(list[0].id);
}

function sendToPlugin(payload) {
  if (!websocket || websocket.readyState !== WebSocket.OPEN || !uuid) return;
  websocket.send(
    JSON.stringify({
      action: actionInfo?.action,
      event: "sendToPlugin",
      context: uuid,
      payload
    })
  );
}

function applyBackendStatus(payload) {
  if (typeof payload.actionType === "string") state.actionType = payload.actionType;
  if (Array.isArray(payload.devices)) state.devices = payload.devices;

  if (payload.settings) {
    state.nodeId = String(payload.settings.nodeId || "");
    state.stepPercent = clampStep(payload.settings.stepPercent);
    state.accentColor = normalizeHexColor(payload.settings.accentColor);
  }

  if (payload.state) {
    state.available = Boolean(payload.state.available);
    state.volume = clampPercent(payload.state.volume);
    state.peakLevel = clampPercent(payload.state.peakLevel);
    state.muted = Boolean(payload.state.muted);
  }

  updateTheme();
  updateActionUi();
  renderNodes();
  updateMeter();

  if (!state.nodeId) {
    updateStatus("Bitte Audiospur auswaehlen.");
  } else if (!state.available) {
    updateStatus("Node nicht verfuegbar (evtl. getrennt/beendet).");
  } else {
    updateStatus("Bereit.");
  }
}

function applyPeakUpdate(payload) {
  if (payload.settings && isValidHexColor(payload.settings.accentColor)) {
    state.accentColor = normalizeHexColor(payload.settings.accentColor);
  }

  if (payload.state) {
    state.available = Boolean(payload.state.available);
    state.volume = clampPercent(payload.state.volume);
    state.peakLevel = clampPercent(payload.state.peakLevel);
    state.muted = Boolean(payload.state.muted);
  }

  updateTheme();
  updateAccentUi();
  updateMeter();
}

function wireEvents() {
  els.nodeSelect.addEventListener("change", () => {
    state.nodeId = String(els.nodeSelect.value || "");
    sendToPlugin({ command: "setNode", nodeId: state.nodeId });
  });

  els.stepSlider.addEventListener("input", () => {
    const stepPercent = clampStep(els.stepSlider.value);
    state.stepPercent = stepPercent;
    updateStepUi();
    sendToPlugin({ command: "setStep", stepPercent });
  });

  els.accentPicker.addEventListener("input", () => {
    const accentColor = normalizeHexColor(els.accentPicker.value, state.accentColor);
    state.accentColor = accentColor;
    updateTheme();
    updateAccentUi();
    sendToPlugin({ command: "setAccent", accentColor });
  });
}

function handleMessage(rawData) {
  let msg;
  try {
    msg = JSON.parse(rawData);
  } catch {
    return;
  }

  if (msg.event !== "sendToPropertyInspector") return;
  if (!msg.payload || typeof msg.payload.type !== "string") return;
  if (msg.payload.type === "status") {
    applyBackendStatus(msg.payload);
    return;
  }
  if (msg.payload.type === "peak") {
    applyPeakUpdate(msg.payload);
  }
}

function connectElgatoStreamDeckSocket(inPort, inUUID, inRegisterEvent, inInfo, inActionInfo) {
  uuid = inUUID;
  actionInfo = JSON.parse(inActionInfo || "{}");

  websocket = new WebSocket(`ws://127.0.0.1:${inPort}`);
  websocket.onopen = () => {
    websocket.send(JSON.stringify({ event: inRegisterEvent, uuid }));
    updateStatus("Verbunden. Lade Nodes ...");
    sendToPlugin({ command: "requestNodes" });
  };
  websocket.onmessage = (evt) => handleMessage(String(evt.data));
  websocket.onclose = () => updateStatus("Verbindung geschlossen.");
}

wireEvents();
updateTheme();
updateActionUi();
updateMeter();

window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;
