#!/usr/bin/env node
"use strict";

const config = require("./config");
const audio = require("./audio-service");
const renderer = require("./svg-renderer");
const opendeck = require("./opendeck-client");
const peakPoll = require("./poll-node-peak-level");
const pipeweaver = require("./pipeweaver-client");

const fs = require("node:fs");
const path = require("node:path");

// --- Debug Logging ---
function debugLog(text) {
  try {
    const logLine = `[${new Date().toISOString()}] ${text}\n`;
    fs.appendFileSync(path.join(__dirname, "debug.log"), logLine, "utf8");
  } catch (e) {
    console.error("Error writing debug.log", e);
  }
}

// --- Global Storage for Track Settings ---
const trackSettingsPath = path.join(__dirname, "track-settings.json");
let trackSettings = {};

try {
  if (fs.existsSync(trackSettingsPath)) {
    trackSettings = JSON.parse(fs.readFileSync(trackSettingsPath, "utf8"));
  }
} catch (e) {
  console.error("Error loading track-settings", e);
}

function getTrackAmp(nodeId) {
  if (!nodeId) return 1;
  return trackSettings[String(nodeId)]?.peakAmplifier || 1;
}

function setTrackAmp(nodeId, amp) {
  if (!nodeId) return;
  const id = String(nodeId);
  if (!trackSettings[id]) trackSettings[id] = {};
  trackSettings[id].peakAmplifier = Number(amp) || 1;
  try {
    fs.writeFileSync(trackSettingsPath, JSON.stringify(trackSettings, null, 2), "utf8");
  } catch (e) {
    console.error("Error saving track-settings", e);
  }
}
// ----------------------------------------------------

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
    targetId: incoming?.targetId != null ? String(incoming.targetId) : String(current?.targetId || ""),
    targetName: incoming?.targetName != null ? String(incoming.targetName) : String(current?.targetName || ""),
    targetIdA: incoming?.targetIdA != null ? String(incoming.targetIdA) : String(current?.targetIdA || ""),
    targetNameA: incoming?.targetNameA != null ? String(incoming.targetNameA) : String(current?.targetNameA || ""),
    targetIdB: incoming?.targetIdB != null ? String(incoming.targetIdB) : String(current?.targetIdB || ""),
    targetNameB: incoming?.targetNameB != null ? String(incoming.targetNameB) : String(current?.targetNameB || ""),
    stepPercent: incoming?.stepPercent !== undefined ? Math.max(-30, Math.min(30, Number(incoming.stepPercent) || 0)) : (current?.stepPercent || 0),
    isStatusOnly: incoming?.isStatusOnly !== undefined ? Boolean(incoming.isStatusOnly) : Boolean(current?.isStatusOnly)
  };
}

function getRuntime(context, action) {
  if (!contexts.has(context)) {
    contexts.set(context, {
      action: action || "de.redreaperlp.opendeck.mixer",
      settings: { ...config.defaultSettings },
      lastKnownState: {
        available: false,
        volume: config.defaultSettings.volume,
        muted: config.defaultSettings.muted,
        peakLevel: config.defaultSettings.peakLevel,
        isDefault: false,
        targetName: ""
      }
    });
  } else if (action && !contexts.get(context).action) {
    contexts.get(context).action = action;
  }
  return contexts.get(context);
}

// --- Helper Functions for Robust ID Resolution ---

function getProfileTargetForId(id) {
  if (!id) return null;
  const profileTargets = pipeweaver.getProfileTargets();
  
  // 1. Direct match on profile ID
  let pt = profileTargets.find(t => t.id === id);
  if (pt) return pt;

  // 2. Match via hardware device ID (if 'id' is a device ID)
  const defaultableOutputs = pipeweaver.getDefaultableOutputs();
  const dev = defaultableOutputs.find(d => d.id === id);
  if (dev) {
    pt = profileTargets.find(t => {
      return Array.isArray(t.attached_devices) && pt.attached_devices.some(ad => ad.name === dev.name);
    });
    if (pt) return pt;
  }

  // 3. Fallback: Match by name (e.g. "speakers", "headset")
  pt = profileTargets.find(t => t.name.toLowerCase() === id.toLowerCase());
  return pt || null;
}

function getDeviceForId(id) {
  if (!id) return null;
  const defaultableOutputs = pipeweaver.getDefaultableOutputs();
  
  // 1. Direct match on device ID
  let dev = defaultableOutputs.find(d => d.id === id);
  if (dev) return dev;

  // 2. Match via profile ID (find device whose name matches pt.attached_devices[0].name)
  const profileTargets = pipeweaver.getProfileTargets();
  const pt = profileTargets.find(t => t.id === id);
  if (pt && Array.isArray(pt.attached_devices) && pt.attached_devices.length > 0) {
    dev = defaultableOutputs.find(d => d.name === pt.attached_devices[0].name);
    if (dev) return dev;
  }

  return null;
}

async function syncContext(runtime, context, options = { sendPi: true, sendImage: true }) {
  const isMixer = runtime.action === "de.redreaperlp.opendeck.mixer";
  const isTargetMute = runtime.action === "de.redreaperlp.opendeck.target_mute";
  const isTargetToggle = runtime.action === "de.redreaperlp.opendeck.target_toggle";

  debugLog(`syncContext: context=${context}, action=${runtime.action}, targetId=${runtime.settings.targetId}`);

  let devices = [];
  let profileTargets = [];
  let defaultableOutputs = [];

  if (isMixer) {
    devices = await audio.listAudioNodes();
    let selected = null;

    if (runtime.settings.nodeId === "@DEFAULT_AUDIO_SINK@") {
      selected = { id: "@DEFAULT_AUDIO_SINK@", name: "Default Output Device (Dynamic)", kind: "sink" };
    } else if (runtime.settings.nodeName) {
      selected = devices.find((d) => d.name === runtime.settings.nodeName);
    }

    if (!selected && runtime.settings.nodeId) {
      selected = devices.find((d) => d.id === String(runtime.settings.nodeId));
    }

    if (!selected) {
      runtime.settings.nodeKind = "";
      runtime.lastKnownState.available = false;
    } else {
      runtime.settings.nodeId = selected.id;
      runtime.settings.nodeName = selected.name;

      const nodeState = await audio.getNodeState(selected.id);
      if (!nodeState) {
        runtime.settings.nodeKind = selected.kind;
        runtime.lastKnownState.available = false;
      } else {
        runtime.settings.nodeKind = selected.kind;

        // If it is the dynamic default output, we fetch the color of the real default output
        let accentName = selected.name;
        if (selected.id === "@DEFAULT_AUDIO_SINK@") {
          const defaultOutputId = pipeweaver.getDefaultOutputId();
          const defaultableOutputsList = pipeweaver.getDefaultableOutputs();
          const currentDefault = defaultableOutputsList.find(d => d.id === defaultOutputId);
          accentName = currentDefault ? (currentDefault.description || currentDefault.name) : "Default Output Device (Dynamic)";
        }

        const pwColor = pipeweaver.getColorForNodeName(accentName);
        runtime.settings.accentColor = pwColor || config.defaultSettings.accentColor;

        runtime.lastKnownState = {
          available: true,
          volume: nodeState.volume,
          muted: nodeState.muted,
          peakLevel: runtime.lastKnownState.peakLevel || 0
        };
      }
    }
  } else if (isTargetMute) {
    profileTargets = pipeweaver.getProfileTargets();
    const target = getProfileTargetForId(runtime.settings.targetId || runtime.settings.targetName);

    if (!target) {
      runtime.lastKnownState.available = false;
      runtime.lastKnownState.targetName = runtime.settings.targetName || "Target";
      debugLog(`syncContext target_mute: Target not found! targetId=${runtime.settings.targetId}`);
    } else {
      runtime.settings.targetId = target.id;
      runtime.settings.targetName = target.name;

      const pwColor = pipeweaver.getColorForNodeName(target.name);
      runtime.settings.accentColor = pwColor || config.defaultSettings.accentColor;

      runtime.lastKnownState = {
        available: true,
        muted: target.mute_state === "Muted",
        targetName: target.name
      };
      debugLog(`syncContext target_mute: Target found! targetName=${target.name}, muted=${runtime.lastKnownState.muted}`);
    }
  } else if (isTargetToggle) {
    profileTargets = pipeweaver.getProfileTargets();
    defaultableOutputs = pipeweaver.getDefaultableOutputs();
    const defaultOutputId = pipeweaver.getDefaultOutputId();

    const devA = getDeviceForId(runtime.settings.targetIdA);
    const devB = getDeviceForId(runtime.settings.targetIdB);
    const ptA = getProfileTargetForId(runtime.settings.targetIdA);
    const ptB = getProfileTargetForId(runtime.settings.targetIdB);

    if (ptA) {
      runtime.settings.targetIdA = ptA.id;
      runtime.settings.targetNameA = ptA.name;
    }
    if (ptB) {
      runtime.settings.targetIdB = ptB.id;
      runtime.settings.targetNameB = ptB.name;
    }

    const isASelected = devA && defaultOutputId === devA.id;
    const isBSelected = devB && defaultOutputId === devB.id;

    let targetName = "Toggle";
    let isDefault = false;

    if (isASelected) {
      targetName = runtime.settings.targetNameA || "Target A";
      isDefault = true;
    } else if (isBSelected) {
      targetName = runtime.settings.targetNameB || "Target B";
      isDefault = true;
    } else {
      const currentDefault = defaultableOutputs.find(d => d.id === defaultOutputId);
      targetName = currentDefault ? (currentDefault.description || currentDefault.name) : (runtime.settings.targetNameA || "Toggle");
      isDefault = false;
    }

    const pwColor = pipeweaver.getColorForNodeName(targetName);
    runtime.settings.accentColor = pwColor || config.defaultSettings.accentColor;

    runtime.lastKnownState = {
      available: true,
      isDefault,
      targetName
    };
    debugLog(`syncContext target_toggle: isDefault=${isDefault}, targetName=${targetName}`);
  }

  opendeck.setSettings(context, runtime.settings);

  if (options.sendImage) {
    let actionType;
    if (isMixer) {
      actionType = resolveActionType(runtime.settings);
    } else if (isTargetMute) {
      actionType = "targetMute";
    } else if (isTargetToggle) {
      actionType = "targetToggle";
    }
    opendeck.setImage(context, renderer.buildButtonImage(actionType, runtime.settings, runtime.lastKnownState));
  }

  if (options.sendPi) {
    opendeck.sendToPropertyInspector(runtime.action, context, {
      type: "status",
      devices,
      profileTargets,
      defaultableOutputs,
      settings: runtime.settings,
      state: runtime.lastKnownState,
      globalTrackAmp: getTrackAmp(runtime.settings.nodeId)
    });
  }
}

async function applyKeyAction(runtime) {
  const isMixer = runtime.action === "de.redreaperlp.opendeck.mixer";
  const isTargetMute = runtime.action === "de.redreaperlp.opendeck.target_mute";
  const isTargetToggle = runtime.action === "de.redreaperlp.opendeck.target_toggle";

  debugLog(`applyKeyAction: action=${runtime.action}`);

  if (isMixer) {
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
  } else if (isTargetMute) {
    const targetId = runtime.settings.targetId;
    debugLog(`applyKeyAction target_mute: targetId=${targetId}`);
    if (!targetId) return;

    const target = getProfileTargetForId(targetId);
    if (!target) {
      debugLog(`applyKeyAction target_mute: target not resolvable! targetId=${targetId}`);
      return;
    }

    const nextMute = target.mute_state === "Muted" ? "Unmuted" : "Muted";
    debugLog(`applyKeyAction target_mute: current=${target.mute_state}, next=${nextMute}`);
    pipeweaver.setTargetMute(target.id, nextMute);
  } else if (isTargetToggle) {
    const targetIdA = runtime.settings.targetIdA;
    const targetIdB = runtime.settings.targetIdB;
    debugLog(`applyKeyAction target_toggle: targetIdA=${targetIdA}, targetIdB=${targetIdB}`);
    if (!targetIdA || !targetIdB) return;

    const devA = getDeviceForId(targetIdA);
    const devB = getDeviceForId(targetIdB);
    const ptA = getProfileTargetForId(targetIdA);
    const ptB = getProfileTargetForId(targetIdB);

    debugLog(`applyKeyAction target_toggle: devA=${devA?.id}, devB=${devB?.id}, ptA=${ptA?.id}, ptB=${ptB?.id}`);
    if (!devA || !devB || !ptA || !ptB) return;

    const defaultOutputId = pipeweaver.getDefaultOutputId();
    const nextDefault = (defaultOutputId === devA.id) ? devB.id : devA.id;
    debugLog(`applyKeyAction target_toggle: currentDefault=${defaultOutputId}, nextDefault=${nextDefault}`);
    
    // 1. Switch default output in PipeWire
    pipeweaver.setDefaultOutput(nextDefault);

    // 2. Simultaneously toggle mute status of corresponding profile targets
    if (nextDefault === devA.id) {
      pipeweaver.setTargetMute(ptA.id, "Unmuted");
      pipeweaver.setTargetMute(ptB.id, "Muted");
      debugLog("applyKeyAction target_toggle: Unmuted A, Muted B");
    } else {
      pipeweaver.setTargetMute(ptA.id, "Muted");
      pipeweaver.setTargetMute(ptB.id, "Unmuted");
      debugLog("applyKeyAction target_toggle: Muted A, Unmuted B");
    }
  }
}

function refreshPeakVisuals() {
  const polledPeaks = new Map();

  for (const [context, runtime] of contexts.entries()) {
    if (runtime.action !== "de.redreaperlp.opendeck.mixer") continue;
    if (!runtime.settings.nodeId || !runtime.lastKnownState.available) continue;

    let id = String(runtime.settings.nodeId);
    let kind = runtime.settings.nodeKind;

    if (id === "@DEFAULT_AUDIO_SINK@") {
      const defaultOutputId = pipeweaver.getDefaultOutputId();
      const dev = getDeviceForId(defaultOutputId);
      if (dev && dev.node_id) {
        id = String(dev.node_id);
        kind = "sink";
      } else {
        continue;
      }
    }

    const key = `${id}_${kind}`;

    if (!polledPeaks.has(key)) {
      const peak = peakPoll.pollNodePeakLevel(id, kind, runtime.lastKnownState.volume, runtime.lastKnownState.muted);
      polledPeaks.set(key, peak);
    }

    const basePeak = polledPeaks.get(key);
    const amp = getTrackAmp(id);
    runtime.lastKnownState.peakLevel = Math.min(100, Math.max(0, Math.round(basePeak * amp)));

    opendeck.setImage(context, renderer.buildButtonImage(resolveActionType(runtime.settings), runtime.settings, runtime.lastKnownState));
    opendeck.sendToPropertyInspector(runtime.action, context, {
      type: "peak",
      settings: { accentColor: renderer.resolveAccentColor(runtime.settings) },
      state: runtime.lastKnownState
    });
  }
}

async function onMessage(message) {
  const context = message.context;
  const action = message.action;
  
  debugLog(`onMessage: event=${message.event}, action=${action}, context=${context}`);

  const runtime = context ? getRuntime(context, action) : null;

  switch (message.event) {
    case "willAppear":
    case "didReceiveSettings":
      runtime.settings = mergeSettings(runtime.settings, message.payload?.settings || {});
      await syncContext(runtime, context, { sendPi: true, sendImage: true });
      break;

    case "keyUp":
      await applyKeyAction(runtime);
      await Promise.all(Array.from(contexts.entries()).map(([ctx, rt]) => syncContext(rt, ctx, { sendPi: true, sendImage: true })));
      break;

    case "sendToPlugin":
      const cmd = message.payload?.command;
      debugLog(`onMessage sendToPlugin: command=${cmd}`);
      if (cmd === "requestNodes") {
        await syncContext(runtime, context, { sendPi: true, sendImage: false });
      } else if (cmd === "setNode") {
        runtime.settings = mergeSettings(runtime.settings, {
          nodeId: message.payload?.nodeId,
          nodeName: message.payload?.nodeName
        });
        opendeck.setSettings(context, runtime.settings);
        await syncContext(runtime, context, { sendPi: true, sendImage: true });
      } else if (cmd === "setTargetMuteNode") {
        runtime.settings = mergeSettings(runtime.settings, {
          targetId: message.payload?.targetId,
          targetName: message.payload?.targetName
        });
        opendeck.setSettings(context, runtime.settings);
        await syncContext(runtime, context, { sendPi: true, sendImage: true });
      } else if (cmd === "setTargetToggleNodes") {
        runtime.settings = mergeSettings(runtime.settings, {
          targetIdA: message.payload?.targetIdA,
          targetNameA: message.payload?.targetNameA,
          targetIdB: message.payload?.targetIdB,
          targetNameB: message.payload?.targetNameB
        });
        opendeck.setSettings(context, runtime.settings);
        await syncContext(runtime, context, { sendPi: true, sendImage: true });
      } else if (cmd === "setFlags") {
        runtime.settings = mergeSettings(runtime.settings, {
          isStatusOnly: message.payload?.isStatusOnly,
          stepPercent: message.payload?.stepPercent
        });
        opendeck.setSettings(context, runtime.settings);
        await syncContext(runtime, context, { sendPi: true, sendImage: true });
      } else if (cmd === "setTrackAmp") {
        setTrackAmp(message.payload?.nodeId, message.payload?.peakAmplifier);
      }
      break;

    case "willDisappear":
      contexts.delete(message.context);
      break;
  }
}

// Update all keys in real-time on any status update from PipeWeaver
pipeweaver.registerStatusListener(() => {
  debugLog("PipeWeaver StatusListener triggered! Updating all contexts...");
  if (!contexts.size) return;
  for (const [context, runtime] of contexts.entries()) {
    syncContext(runtime, context, { sendPi: true, sendImage: true }).catch(err => {
      console.error("Error during real-time context sync:", err);
    });
  }
});

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