"use strict";

const config = require("./config");
const audio = require("./audio-service");
const renderer = require("./svg-renderer");
const opendeck = require("./opendeck-client");
const peakPoll = require("./poll-node-peak-level");


const contexts = new Map();

// --- Hilfsfunktionen für State ---

function actionTypeFromUuid(uuid) {
  if (uuid === config.UUID_DB_STATUS) return "dbStatus";
  if (uuid === config.UUID_INCREASE) return "increaseBy";
  if (uuid === config.UUID_DECREASE) return "decreaseBy";
  return "toggleMute";
}

function mergeSettings(current, incoming) {
  const rawColor = incoming?.accentColor ?? current?.accentColor ?? config.defaultSettings.accentColor;
  const normalizedColor = typeof rawColor === "string" ? rawColor.trim() : config.defaultSettings.accentColor;
  return {
    ...config.defaultSettings,
    ...current,
    ...incoming,
    nodeId: incoming?.nodeId != null ? String(incoming.nodeId) : String(current?.nodeId || ""),
    nodeName: incoming?.nodeName != null ? String(incoming.nodeName) : String(current?.nodeName || ""),
    accentColor: renderer.isValidHexColor(normalizedColor) ? normalizedColor : config.defaultSettings.accentColor,
    stepPercent: audio.clampInt(incoming?.stepPercent ?? current?.stepPercent, 1, 30, 5)
  };
}

function getRuntime(context, actionUuid = config.UUID_TOGGLE) {
  if (!contexts.has(context)) {
    contexts.set(context, {
      actionUuid,
      actionType: actionTypeFromUuid(actionUuid),
      settings: { ...config.defaultSettings },
      lastKnownState: {
        available: false,
        volume: config.defaultSettings.volume,
        muted: config.defaultSettings.muted,
        peakLevel: config.defaultSettings.peakLevel
      }
    });
  }

  const runtime = contexts.get(context);
  if (actionUuid && runtime.actionUuid !== actionUuid) {
    runtime.actionUuid = actionUuid;
    runtime.actionType = actionTypeFromUuid(actionUuid);
  }
  return runtime;
}

// --- Hauptlogik ---

async function syncContext(runtime, context, options = { sendPi: true, sendImage: true }) {
  const devices = await audio.listAudioNodes();
  const selected = devices.find((d) => d.id === String(runtime.settings.nodeId));

  if (!selected) {
    runtime.settings = {
      ...runtime.settings,
      nodeKind: "",
      nodeName: runtime.settings.nodeName || ""
    };
    runtime.lastKnownState = {
      available: false,
      volume: audio.clampInt(runtime.settings.volume, 0, 100, 50),
      muted: Boolean(runtime.settings.muted),
      peakLevel: 0
    };
  } else {
    const nodeState = await audio.getNodeState(selected.id);
    if (!nodeState) {
      runtime.settings = {
        ...runtime.settings,
        nodeKind: selected.kind,
        nodeName: selected.name
      };
      opendeck.setSettings(context, runtime.settings);
      runtime.lastKnownState = {
        available: false,
        volume: audio.clampInt(runtime.settings.volume, 0, 100, 50),
        muted: Boolean(runtime.settings.muted),
        peakLevel: 0
      };
    } else {
      const currentPeakLevel = peakPoll.pollNodePeakLevel(selected.id, nodeState.volume, nodeState.muted);
      runtime.lastKnownState = {
        available: true,
        volume: nodeState.volume,
        muted: nodeState.muted,
        peakLevel: currentPeakLevel
      };

      runtime.settings = {
        ...runtime.settings,
        nodeKind: selected.kind,
        nodeName: selected.name,
        volume: nodeState.volume,
        muted: nodeState.muted,
        peakLevel: currentPeakLevel
      };
      opendeck.setSettings(context, runtime.settings);
    }
  }

  if (options.sendImage) {
    opendeck.setImage(context, renderer.buildButtonImage(runtime.actionType, runtime.settings, runtime.lastKnownState));
    opendeck.setTitle(context, "");
  }

  if (options.sendPi) {
    opendeck.sendToPropertyInspector(runtime.actionUuid, context, {
      type: "status",
      actionType: runtime.actionType,
      devices,
      settings: runtime.settings,
      state: runtime.lastKnownState
    });
  }
}

async function syncAllContextsForNode(nodeId) {
  if (!nodeId) return;
  const entries = Array.from(contexts.entries()).filter(([, runtime]) => String(runtime.settings.nodeId) === String(nodeId));
  await Promise.all(entries.map(([context, runtime]) => syncContext(runtime, context, { sendPi: true, sendImage: true })));
}

async function applyKeyAction(runtime, context) {
  const nodeId = runtime.settings.nodeId;
  if (!nodeId) return;

  if (runtime.actionType === "dbStatus") return;

  if (runtime.actionType === "toggleMute") {
    await audio.toggleNodeMute(nodeId);
    return;
  }

  const current = await audio.getNodeState(nodeId);
  if (!current) return;

  const delta = runtime.actionType === "increaseBy" ? runtime.settings.stepPercent : -runtime.settings.stepPercent;
  const next = audio.clampInt(current.volume + delta, 0, 100, current.volume);
  await audio.setNodeVolume(nodeId, next);
}

function refreshPeakVisuals() {
  for (const [context, runtime] of contexts.entries()) {
    const nodeId = runtime.settings.nodeId;
    if (!nodeId || !runtime.lastKnownState.available) continue;

    const nextPeak = peakPoll.pollNodePeakLevel(nodeId, runtime.lastKnownState.volume, runtime.lastKnownState.muted);
    runtime.lastKnownState = { ...runtime.lastKnownState, peakLevel: nextPeak };

    opendeck.setImage(context, renderer.buildButtonImage(runtime.actionType, runtime.settings, runtime.lastKnownState));
    opendeck.sendToPropertyInspector(runtime.actionUuid, context, {
      type: "peak",
      settings: { accentColor: renderer.resolveAccentColor(runtime.settings) },
      state: {
        volume: runtime.lastKnownState.volume,
        peakLevel: runtime.lastKnownState.peakLevel,
        muted: runtime.lastKnownState.muted,
        available: runtime.lastKnownState.available
      }
    });
  }
}

// --- Event Handler ---

async function onMessage(message) {
  const context = message.context;
  const runtime = context ? getRuntime(context, message.action) : null;

  switch (message.event) {
    case "willAppear":
      runtime.settings = mergeSettings(runtime.settings, message.payload?.settings || {});
      await syncContext(runtime, context, { sendPi: true, sendImage: true });
      break;

    case "didReceiveSettings":
      runtime.settings = mergeSettings(runtime.settings, message.payload?.settings || {});
      await syncContext(runtime, context, { sendPi: true, sendImage: true });
      break;

    case "keyUp":
      const nodeId = runtime.settings.nodeId;
      await applyKeyAction(runtime, context);
      if (nodeId) {
        await syncAllContextsForNode(nodeId);
      } else {
        await syncContext(runtime, context, { sendPi: true, sendImage: true });
      }
      break;

    case "sendToPlugin":
      const cmd = message.payload?.command;

      if (cmd === "requestNodes") {
        await syncContext(runtime, context, { sendPi: true, sendImage: false });
      } else if (cmd === "setNode") {
        runtime.settings = { ...runtime.settings, nodeId: String(message.payload?.nodeId || ""), nodeName: message.payload?.nodeId ? runtime.settings.nodeName : "" };
        opendeck.setSettings(context, runtime.settings);
        await syncContext(runtime, context, { sendPi: true, sendImage: true });
      } else if (cmd === "setStep") {
        runtime.settings = { ...runtime.settings, stepPercent: audio.clampInt(message.payload?.stepPercent, 1, 30, runtime.settings.stepPercent) };
        opendeck.setSettings(context, runtime.settings);
        await syncContext(runtime, context, { sendPi: true, sendImage: true });
      } else if (cmd === "setAccent") {
        const accentColor = String(message.payload?.accentColor || "").trim();
        if (renderer.isValidHexColor(accentColor)) {
          runtime.settings = { ...runtime.settings, accentColor };
          opendeck.setSettings(context, runtime.settings);
          await syncContext(runtime, context, { sendPi: true, sendImage: true });
        }
      }
      break;

    case "willDisappear":
      contexts.delete(message.context);
      break;
  }
}

// --- Intervalle ---

setInterval(async () => {
  if (!contexts.size) return;
  const entries = Array.from(contexts.entries());
  await Promise.all(entries.map(([context, runtime]) => syncContext(runtime, context, { sendPi: true, sendImage: true })));
}, config.POLL_INTERVAL_MS);

setInterval(() => {
  if (!contexts.size) return;
  refreshPeakVisuals();
}, config.PEAK_POLL_INTERVAL_MS);

// --- Startup Logik ---

function tryStartFromCliArgs() {
  const args = {};
  process.env.OSENDECK_DEBUG = process.env.OSENDECK_DEBUG || "1";

  console.log("[VolumeMixer] CLI args:", process.argv.slice(2));
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = String(process.argv[i] || "").replace(/^-/, "");
    args[key] = process.argv[i + 1];
  }

  if (args.port && args.pluginUUID && args.registerEvent) {
    opendeck.connect(args.port, args.pluginUUID, args.registerEvent, onMessage);
    return;
  }

  console.log("[VolumeMixer] Warning: Missing required args (port, pluginUUID, registerEvent)");
  console.log("[VolumeMixer] Fallback: Starting via node script...");
  const { spawn } = require("node:child_process");

  // Hinweis: Wenn dieses Skript über node aufgerufen wird, versucht es sich selbst (oder ein anderes Skript)
  // neu zu starten, wenn die CLI Parameter fehlen.
  const nodeProcess = spawn("node", ["plugin.js"], { stdio: "inherit" });
  nodeProcess.on("error", (err) => console.error("[VolumeMixer] Error spawning node:", err));
  nodeProcess.on("close", (code) => console.log(`[VolumeMixer] Node process closed with code: ${code}`));
}

// Wrapper-Funktion für Kompatibilität
global.connectElgatoStreamDeckSocket = function(inPort, inPluginUUID, inRegisterEvent) {
  opendeck.connect(inPort, inPluginUUID, inRegisterEvent, onMessage);
};

process.on("unhandledRejection", (err) => console.error("[VolumeMixer] Unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("[VolumeMixer] Uncaught exception:", err));

tryStartFromCliArgs();