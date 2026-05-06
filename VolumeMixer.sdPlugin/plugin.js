#!/usr/bin/env node
"use strict";
//
// const fs = require("node:fs");
// const path = require("node:path");
//
// // --- START: LOGGING IN DATEI UMLEITEN ---
// const logFilePath = path.join(__dirname, "debug.log");
// const logStream = fs.createWriteStream(logFilePath, { flags: "a" });
//
// function formatLogMsg(level, args) {
//   const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(" ");
//   return `[${new Date().toISOString()}] [${level}] ${msg}\n`;
// }
//
// const origLog = console.log;
// const origError = console.error;
//
// console.log = function (...args) {
//   logStream.write(formatLogMsg("INFO", args));
//   origLog.apply(console, args);
// };
// console.error = function (...args) {
//   logStream.write(formatLogMsg("ERROR", args));
//   origError.apply(console, args);
// };
//
// console.log("=========================================");
// console.log("PLUGIN GESTARTET");
// console.log("=========================================");
// --- ENDE: LOGGING ---

const config = require("./config");
const audio = require("./audio-service");
const renderer = require("./svg-renderer");
const opendeck = require("./opendeck-client");
const peakPoll = require("./poll-node-peak-level");

// WICHTIG: Dies war im letzten Log nicht geladen!
const pipeweaver = require("./pipeweaver-client");

const contexts = new Map();

function resolveActionType(settings) {
  if (settings.isStatusOnly) return "dbStatus";
  if (settings.stepPercent === 0) return "toggleMute";
  return settings.stepPercent > 0 ? "increaseBy" : "decreaseBy";
}

function mergeSettings(current, incoming) {
  return {
    ...config.defaultSettings,
    ...current,
    ...incoming,
    nodeId: incoming?.nodeId != null ? String(incoming.nodeId) : String(current?.nodeId || ""),
    nodeName: incoming?.nodeName != null ? String(incoming.nodeName) : String(current?.nodeName || ""),
    stepPercent: incoming?.stepPercent !== undefined ? Math.max(-30, Math.min(30, Number(incoming.stepPercent) || 0)) : (current?.stepPercent || 0),
    isStatusOnly: incoming?.isStatusOnly !== undefined ? Boolean(incoming.isStatusOnly) : Boolean(current?.isStatusOnly)
  };
}

function getRuntime(context) {
  if (!contexts.has(context)) {
    contexts.set(context, {
      settings: { ...config.defaultSettings },
      lastKnownState: {
        available: false,
        volume: config.defaultSettings.volume,
        muted: config.defaultSettings.muted,
        peakLevel: config.defaultSettings.peakLevel
      }
    });
  }
  return contexts.get(context);
}

async function syncContext(runtime, context, options = { sendPi: true, sendImage: true }) {
  const devices = await audio.listAudioNodes();
  const selected = devices.find((d) => d.id === String(runtime.settings.nodeId));
  const actionType = resolveActionType(runtime.settings);

  if (!selected) {
    runtime.settings.nodeKind = "";
    runtime.lastKnownState.available = false;
  } else {
    const nodeState = await audio.getNodeState(selected.id);
    if (!nodeState) {
      runtime.settings.nodeKind = selected.kind;
      runtime.lastKnownState.available = false;
    } else {
      runtime.settings.nodeKind = selected.kind;
      runtime.settings.nodeName = selected.name;

      // Auto-Farbe von PipeWeaver holen
      const pwColor = pipeweaver.getColorForNodeName(selected.name);
      if (pwColor) {
        runtime.settings.accentColor = pwColor;
      } else {
        runtime.settings.accentColor = config.defaultSettings.accentColor;
      }

      runtime.lastKnownState = {
        available: true,
        volume: nodeState.volume,
        muted: nodeState.muted,
        peakLevel: peakPoll.pollNodePeakLevel(selected.id, nodeState.volume, nodeState.muted)
      };
    }
    opendeck.setSettings(context, runtime.settings);
  }

  if (options.sendImage) {
    opendeck.setImage(context, renderer.buildButtonImage(actionType, runtime.settings, runtime.lastKnownState));
  }

  if (options.sendPi) {
    opendeck.sendToPropertyInspector("com.opendeck.pipewire.mixer", context, {
      type: "status",
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

async function applyKeyAction(runtime) {
  const nodeId = runtime.settings.nodeId;
  if (!nodeId) return;

  const actionType = resolveActionType(runtime.settings);

  if (actionType === "dbStatus") return;

  if (actionType === "toggleMute") {
    await audio.toggleNodeMute(nodeId);
    return;
  }

  const current = await audio.getNodeState(nodeId);
  if (!current) return;
  const next = audio.clampInt(current.volume + runtime.settings.stepPercent, 0, 100, current.volume);
  await audio.setNodeVolume(nodeId, next);
}

function refreshPeakVisuals() {
  for (const [context, runtime] of contexts.entries()) {
    if (!runtime.settings.nodeId || !runtime.lastKnownState.available) continue;

    runtime.lastKnownState.peakLevel = peakPoll.pollNodePeakLevel(runtime.settings.nodeId, runtime.lastKnownState.volume, runtime.lastKnownState.muted);

    opendeck.setImage(context, renderer.buildButtonImage(resolveActionType(runtime.settings), runtime.settings, runtime.lastKnownState));
    opendeck.sendToPropertyInspector("com.opendeck.pipewire.mixer", context, {
      type: "peak",
      settings: { accentColor: renderer.resolveAccentColor(runtime.settings) },
      state: runtime.lastKnownState
    });
  }
}

async function onMessage(message) {
  const context = message.context;
  const runtime = context ? getRuntime(context) : null;

  switch (message.event) {
    case "willAppear":
    case "didReceiveSettings":
      runtime.settings = mergeSettings(runtime.settings, message.payload?.settings || {});
      await syncContext(runtime, context, { sendPi: true, sendImage: true });
      break;

    case "keyUp":
      await applyKeyAction(runtime);
      if (runtime.settings.nodeId) await syncAllContextsForNode(runtime.settings.nodeId);
      break;

    case "sendToPlugin":
      const cmd = message.payload?.command;
      if (cmd === "requestNodes") {
        await syncContext(runtime, context, { sendPi: true, sendImage: false });
      } else if (cmd === "setNode") {
        runtime.settings = mergeSettings(runtime.settings, { nodeId: message.payload?.nodeId });
        opendeck.setSettings(context, runtime.settings);
        await syncContext(runtime, context, { sendPi: true, sendImage: true });
      } else if (cmd === "setFlags") {
        runtime.settings = mergeSettings(runtime.settings, {
          isStatusOnly: message.payload?.isStatusOnly,
          stepPercent: message.payload?.stepPercent
        });
        opendeck.setSettings(context, runtime.settings);
        await syncContext(runtime, context, { sendPi: true, sendImage: true });
      }
      break;

    case "willDisappear":
      contexts.delete(message.context);
      break;
  }
}

setInterval(async () => {
  if (!contexts.size) return;
  await Promise.all(Array.from(contexts.entries()).map(([context, runtime]) => syncContext(runtime, context, { sendPi: true, sendImage: true })));
}, config.POLL_INTERVAL_MS);

setInterval(() => {
  if (contexts.size) refreshPeakVisuals();
}, config.PEAK_POLL_INTERVAL_MS);

function tryStartFromCliArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) args[String(process.argv[i] || "").replace(/^-/, "")] = process.argv[i + 1];

  if (args.port && args.pluginUUID && args.registerEvent) {
    opendeck.connect(args.port, args.pluginUUID, args.registerEvent, onMessage);
  } else {
    require("node:child_process").spawn("node", ["plugin.js"], { stdio: "inherit" });
  }
}

global.connectElgatoStreamDeckSocket = function(inPort, inPluginUUID, inRegisterEvent) {
  opendeck.connect(inPort, inPluginUUID, inRegisterEvent, onMessage);
};

process.on("unhandledRejection", (err) => console.error("Unhandled Rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));

tryStartFromCliArgs();