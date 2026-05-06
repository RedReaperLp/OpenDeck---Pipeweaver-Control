"use strict";

/**
 * OpenDeck PipeWire Mixer
 *
 * Enthaltene Actions:
 * - DbStatus
 * - IncreaseBy
 * - DecreaseBy
 * - ToggleMute
 *
 * Schwerpunkt:
 * - pro Key eine konkrete PipeWire-Spur (inkl. Streams) auswaehlbar
 * - wpctl-basierte Steuerung mit robustem Fehlerverhalten
 * - dynamische Button-Visualisierung (immer SVG-Data-URL fuer maximale OpenDeck-Kompatibilitaet)
 */

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const WebSocket = require("ws");

const execFileAsync = promisify(execFile);

// Bewusst immer SVG:
// Einige OpenDeck-Setups zeigen PNG-DataURLs aus Node-Canvas nur als schwarze Flaechen.
// Mit reinem SVG-DataURL-Rendering ist die Darstellung stabiler.
const createCanvas = null;

const UUID_INCREASE = "com.opendeck.pipewire.mixer.increaseBy";
const UUID_DECREASE = "com.opendeck.pipewire.mixer.decreaseBy";
const UUID_TOGGLE = "com.opendeck.pipewire.mixer.toggleMute";
const UUID_DB_STATUS = "com.opendeck.pipewire.mixer.dbStatus";

const WPCTL_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 2500;
const PEAK_POLL_INTERVAL_MS = 100;

let websocket = null;
let pluginUUID = null;

const contexts = new Map();
const peakStateByNode = new Map();

const defaultSettings = {
  nodeId: "",
  nodeName: "",
  nodeKind: "",
  accentColor: "#00d2ff",
  stepPercent: 5,
  volume: 50,
  muted: false,
  peakLevel: 0
};

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function actionTypeFromUuid(uuid) {
  if (uuid === UUID_DB_STATUS) return "dbStatus";
  if (uuid === UUID_INCREASE) return "increaseBy";
  if (uuid === UUID_DECREASE) return "decreaseBy";
  return "toggleMute";
}

function isStepAction(actionType) {
  return actionType === "increaseBy" || actionType === "decreaseBy";
}

/**
 * Fuehrt `wpctl` robust aus.
 *
 * Warum `execFile`:
 * - Kein Shell-Parsing -> weniger Angriffsflaeche und keine Quote-Probleme.
 * - Direkte Argumentliste, exakt wie angegeben.
 *
 * Fehler werden als Ergebnisobjekt zurueckgegeben, damit die Plugin-Loop stabil bleibt
 * und nicht bei einem temporaren PipeWire/WirePlumber-Fehler abstuerzt.
 */
let debugLogCount = 0;

async function runWpctl(args) {
  debugLogCount++;
  const logId = `WPCTL-${debugLogCount}`;
  console.log(`[${logId}] Executing wpctl: ${args.join(" ")}`);
  try {
    const { stdout, stderr } = await execFileAsync("wpctl", args, { timeout: WPCTL_TIMEOUT_MS });
    console.log(`[${logId}] SUCCESS: ${stdout}`);
    return { ok: true, stdout: (stdout || "").trim(), stderr: (stderr || "").trim() };
  } catch (error) {
    console.error(`[${logId}] FAILED: ${error.stderr || error.message}`);
    return {
      ok: false,
      stdout: (error.stdout || "").trim(),
      stderr: (error.stderr || error.message || "").trim()
    };
  }
}

/**
 * Extrahiert steuerbare Audioziele aus `wpctl status`.
 *
 * PipeWeaver/PipeWire nutzt in der Praxis mehrere relevante Sektionen:
 * - Sinks
 * - Sources
 * - Sink endpoints
 * - Source endpoints
 * - Streams
 *
 * Damit "jede Audiospur separat" moeglich wird, werden Streams bewusst mit aufgenommen.
 *
 * Defensive Parsing-Regeln:
 * - nur bekannte Sektionen werden geparst
 * - nur Zeilen mit numerischer ID (z. B. "56. <name>")
 * - tiefe Untereintraege (Ports/Channel) werden ueber Einrueckung ausgefiltert
 * - doppelte IDs werden dedupliziert
 */
async function listAudioNodes() {
  const result = await runWpctl(["status"]);
  if (!result.ok) return [];

  const sectionKinds = {
    sinks: "sink",
    sources: "source",
    "sink endpoints": "sink-endpoint",
    "source endpoints": "source-endpoint",
    streams: "stream"
  };

  const nodes = [];
  const seenIds = new Set();
  const lines = result.stdout.split(/\r?\n/);
  let section = "";

  for (const rawLine of lines) {
    const line = rawLine || "";

    // wpctl nutzt Tree-Glyphen (│ ├ └ ─). Diese werden bei Header-Erkennung toleriert.
    const sectionMatch = line.match(
      /^[\s│├└─]*(Sinks|Sources|Sink endpoints|Source endpoints|Streams):\s*$/i
    );
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase();
      continue;
    }

    if (!sectionKinds[section]) continue;

    // Entfernt Tree-Praefixe, damit "│  *   98. Name" und "97. Stream" gleich parsebar sind.
    const cleaned = line.replace(/^[\s│├└─]+/, "");

    const idMatch = cleaned.match(/^(\*)?\s*([0-9]+)\.\s+(.+?)\s*$/);
    if (!idMatch) continue;

    const id = idMatch[2];
    if (seenIds.has(id)) continue;

    const isDefault = Boolean(idMatch[1]);
    let name = idMatch[3].replace(/\s*\[vol:[^\]]+\]\s*$/i, "").trim();

    // Bei Streams nur Top-Level-Spuren aufnehmen, nicht deren Channel-Ports.
    if (sectionKinds[section] === "stream" && /[<>]/.test(name)) continue;

    if (!name) name = `Node ${id}`;

    nodes.push({
      id,
      kind: sectionKinds[section],
      name,
      isDefault
    });
    seenIds.add(id);
  }

  return nodes;
}

/**
 * Liest Zustand eines Ziels:
 *   wpctl get-volume <ID>
 *
 * Beispiele:
 * - "Volume: 0.35"
 * - "Volume: 0.35 [MUTED]"
 */
async function getNodeState(nodeId) {
  const result = await runWpctl(["get-volume", String(nodeId)]);
  if (!result.ok) return null;

  const volMatch = result.stdout.match(/Volume:\s*([0-9]*\.?[0-9]+)/i);
  if (!volMatch) return null;

  const volumeFloat = Number(volMatch[1]);
  if (!Number.isFinite(volumeFloat)) return null;

  return {
    volume: clampInt(volumeFloat * 100, 0, 150, 0),
    muted: /\[MUTED\]/i.test(result.stdout)
  };
}

/**
 * Setzt absolute Lautstaerke:
 *   wpctl set-volume <ID> <PERCENT>%
 */
async function setNodeVolume(nodeId, volumePercent) {
  const normalized = clampInt(volumePercent, 0, 100, 50);
  return runWpctl(["set-volume", String(nodeId), `${normalized}%`]);
}

/**
 * Mute-Status umschalten:
 *   wpctl set-mute <ID> toggle
 */
async function toggleNodeMute(nodeId) {
  return runWpctl(["set-mute", String(nodeId), "toggle"]);
}

function mergeSettings(current, incoming) {
  const rawColor = incoming?.accentColor ?? current?.accentColor ?? defaultSettings.accentColor;
  const normalizedColor = typeof rawColor === "string" ? rawColor.trim() : defaultSettings.accentColor;
  return {
    ...defaultSettings,
    ...current,
    ...incoming,
    nodeId: incoming?.nodeId != null ? String(incoming.nodeId) : String(current?.nodeId || ""),
    nodeName: incoming?.nodeName != null ? String(incoming.nodeName) : String(current?.nodeName || ""),
    accentColor: isValidHexColor(normalizedColor) ? normalizedColor : defaultSettings.accentColor,
    stepPercent: clampInt(incoming?.stepPercent ?? current?.stepPercent, 1, 30, 5)
  };
}

function getRuntime(context, actionUuid = UUID_TOGGLE) {
  if (!contexts.has(context)) {
    contexts.set(context, {
      actionUuid,
      actionType: actionTypeFromUuid(actionUuid),
      settings: { ...defaultSettings },
      lastKnownState: {
        available: false,
        volume: defaultSettings.volume,
        muted: defaultSettings.muted,
        peakLevel: defaultSettings.peakLevel
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

function sendToPropertyInspector(runtime, context, payload) {
  send("sendToPropertyInspector", {
    action: runtime.actionUuid,
    context,
    payload
  });
}

function isValidHexColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim());
}

function defaultAccentColor(nodeKind) {
  if (nodeKind === "source" || nodeKind === "source-endpoint") return "#00d2ff";
  if (nodeKind === "sink" || nodeKind === "sink-endpoint") return "#46d66d";
  if (nodeKind === "stream") return "#a78bfa";
  return "#00d2ff";
}

function resolveAccentColor(settings) {
  const custom = typeof settings?.accentColor === "string" ? settings.accentColor.trim() : "";
  if (isValidHexColor(custom)) return custom;
  return defaultAccentColor(settings?.nodeKind || "");
}

function hexToRgba(hexColor, alpha) {
  if (!isValidHexColor(hexColor)) return `rgba(0, 210, 255, ${alpha})`;
  const r = Number.parseInt(hexColor.slice(1, 3), 16);
  const g = Number.parseInt(hexColor.slice(3, 5), 16);
  const b = Number.parseInt(hexColor.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function escapeSvgText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}

function clipLabel(value, maxLength = 12) {
  const raw = String(value || "").trim();
  if (!raw) return "TRACK";
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function pollNodePeakLevelMock(nodeId, volumePercent, isMuted) {
  const now = Date.now();
  const currentVolume = clampInt(volumePercent, 0, 100, 0);
  if (!nodeId || isMuted || currentVolume <= 0) {
    peakStateByNode.set(String(nodeId || ""), { value: 0, tick: now });
    return 0;
  }

  const key = String(nodeId);
  const prev = peakStateByNode.get(key) || { value: 0, tick: now };
  const elapsed = Math.max(1, now - prev.tick);
  const phaseA = (now / 190) + Number(nodeId) * 0.13;
  const phaseB = (now / 90) + Number(nodeId) * 0.07;
  const waveform = ((Math.sin(phaseA) + 1) * 0.5) * 0.65 + ((Math.sin(phaseB) + 1) * 0.5) * 0.35;
  const target = Math.max(0, Math.min(100, waveform * currentVolume));

  const rise = 0.4;
  const decay = Math.min(0.85, elapsed / 600);
  const next = target > prev.value
    ? prev.value + (target - prev.value) * rise
    : prev.value - (prev.value - target) * decay;

  const clamped = clampInt(next, 0, 100, 0);
  peakStateByNode.set(key, { value: clamped, tick: now });
  return clamped;
}

function buildHeadphoneIcon({ x, y, width, stroke, strokeWidth }) {
  const leftCupX = x + 0.1 * width;
  const rightCupX = x + 0.72 * width;
  const cupY = y + 0.42 * width;
  const cupW = 0.18 * width;
  const cupH = 0.3 * width;
  const arcLeft = x + 0.22 * width;
  const arcRight = x + 0.78 * width;
  const arcY = y + 0.28 * width;
  const arcBottomY = y + 0.62 * width;
  return [
    `<g fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">`,
    `<path d="M${arcLeft} ${arcBottomY} A${0.28 * width} ${0.28 * width} 0 0 1 ${arcRight} ${arcBottomY}" />`,
    `<rect x="${leftCupX}" y="${cupY}" width="${cupW}" height="${cupH}" rx="${0.09 * width}" />`,
    `<rect x="${rightCupX}" y="${cupY}" width="${cupW}" height="${cupH}" rx="${0.09 * width}" />`,
    `<path d="M${arcLeft} ${arcBottomY}V${arcY + 0.05 * width}" />`,
    `<path d="M${arcRight} ${arcBottomY}V${arcY + 0.05 * width}" />`,
    `</g>`
  ].join("");
}

function buildMicrophoneIcon({ x, y, width, stroke, strokeWidth }) {
  const capsuleW = 0.34 * width;
  const capsuleH = 0.5 * width;
  const capsuleX = x + 0.33 * width;
  const capsuleY = y + 0.08 * width;
  const stemY = capsuleY + capsuleH;
  const baseY = y + 0.9 * width;
  return [
    `<g fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">`,
    `<rect x="${capsuleX}" y="${capsuleY}" width="${capsuleW}" height="${capsuleH}" rx="${0.16 * width}" />`,
    `<path d="M${x + 0.2 * width} ${stemY - 0.02 * width}A${0.3 * width} ${0.3 * width} 0 0 0 ${x + 0.8 * width} ${stemY - 0.02 * width}" />`,
    `<path d="M${x + 0.5 * width} ${stemY - 0.02 * width}V${baseY - 0.08 * width}" />`,
    `<path d="M${x + 0.32 * width} ${baseY}H${x + 0.68 * width}" />`,
    `</g>`
  ].join("");
}

function buildNodeIcon(settings, options) {
  const kind = String(settings?.nodeKind || "");
  if (kind === "source" || kind === "source-endpoint") return buildMicrophoneIcon(options);
  return buildHeadphoneIcon(options);
}

function buildTileFrame({ fill = "#141414", outerStroke = "#2f2f2f", innerStroke = "#575757" } = {}) {
  return [
    `<rect x="0" y="0" width="144" height="144" rx="25" fill="${fill}" />`,
    `<rect x="3" y="3" width="138" height="138" rx="22" fill="none" stroke="${outerStroke}" stroke-width="6" />`,
    `<rect x="9" y="9" width="126" height="126" rx="18" fill="none" stroke="${innerStroke}" stroke-width="2" />`
  ].join("");
}

function meterColorForGlobalSegment(globalSegment) {
  if (globalSegment >= 9) return "#ff5d47";
  if (globalSegment >= 5) return "#ffc84d";
  return "#39d267";
}

const SPLIT_TRACK_TOP = 20;
const SPLIT_TRACK_HEIGHT = 100;
const SPLIT_TRACK_GAP = 6;
const SPLIT_KNOB_X = 52;
const SPLIT_KNOB_Y_PAD = 5;
const SPLIT_KNOB_WIDTH = 42;
const SPLIT_KNOB_HEIGHT = 30;
const SPLIT_KNOB_ACCENT_X = 70;
const SPLIT_KNOB_ACCENT_WIDTH = 6;
const SPLIT_KNOB_ACCENT_HEIGHT = 20;

function halfRoundedRectPath(x, y, width, height, radius, flatSide) {
  const right = x + width;
  const bottom = y + height;
  const r = Math.max(0, Math.min(radius, Math.floor(Math.min(width, height) / 2)));

  if (flatSide === "bottom") {
    return [
      `M ${x + r} ${y}`,
      `H ${right - r}`,
      `Q ${right} ${y} ${right} ${y + r}`,
      `V ${bottom}`,
      `H ${x}`,
      `V ${y + r}`,
      `Q ${x} ${y} ${x + r} ${y}`,
      "Z"
    ].join(" ");
  }

  return [
    `M ${x} ${y}`,
    `H ${right}`,
    `V ${bottom - r}`,
    `Q ${right} ${bottom} ${right - r} ${bottom}`,
    `H ${x + r}`,
    `Q ${x} ${bottom} ${x} ${bottom - r}`,
    "Z"
  ].join(" ");
}

function buildSplitSliderTrack(actionType, clipPathId) {
  const flatSide = actionType === "increaseBy" ? "bottom" : "top";
  const outerPath = halfRoundedRectPath(54, SPLIT_TRACK_TOP, 38, SPLIT_TRACK_HEIGHT, 19, flatSide);
  const innerPath = halfRoundedRectPath(56, SPLIT_TRACK_TOP + 2, 34, SPLIT_TRACK_HEIGHT - 4, 17, flatSide);
  return {
    defs: `<clipPath id="${clipPathId}"><path d="${innerPath}" /></clipPath>`,
    markup: [
      `<path d="${outerPath}" fill="#080808" />`,
      `<path d="${innerPath}" fill="#0f0f0f" stroke="#2d2d2d" stroke-width="2" />`
    ].join("")
  };
}

function buildSplitVerticalMeter(actionType, currentPeakLevel) {
  const flatSide = actionType === "increaseBy" ? "bottom" : "top";
  const meterOuterPath = halfRoundedRectPath(106, SPLIT_TRACK_TOP, 16, SPLIT_TRACK_HEIGHT, 8, flatSide);
  const meterInnerPath = halfRoundedRectPath(107, SPLIT_TRACK_TOP + 1, 14, SPLIT_TRACK_HEIGHT - 2, 7, flatSide);
  const peak = clampInt(currentPeakLevel, 0, 100, 0);
  const activeGlobalSegments = Math.round((peak / 100) * 10);
  const globalStart = actionType === "increaseBy" ? 6 : 1;
  const segments = [];

  for (let localFromBottom = 1; localFromBottom <= 5; localFromBottom += 1) {
    const globalSegment = globalStart + (localFromBottom - 1);
    const isOn = globalSegment <= activeGlobalSegments;
    const y = SPLIT_TRACK_TOP + 2 + (5 - localFromBottom) * 19;
    const color = isOn ? meterColorForGlobalSegment(globalSegment) : "#2a2d34";
    segments.push(`<rect x="108" y="${y}" width="12" height="16" fill="${color}" />`);
  }

  return [
    `<path d="${meterOuterPath}" fill="#080808" />`,
    `<path d="${meterInnerPath}" fill="#111318" stroke="#2d313a" stroke-width="1.5" />`,
    segments.join("")
  ].join("");
}

function splitRangeForAction(actionType) {
  if (actionType === "increaseBy") {
    return { start: 50, end: 100, label: "50-100%" };
  }
  return { start: 0, end: 50, label: "0-50%" };
}

function splitKnobCenterY(actionType, volumePercent) {
  const globalPercent = clampInt(volumePercent, 0, 100, 0);
  const totalHeight = SPLIT_TRACK_HEIGHT * 2 + SPLIT_TRACK_GAP;
  const globalOffset = ((100 - globalPercent) / 100) * totalHeight;
  const localOffset = actionType === "increaseBy"
    ? globalOffset
    : globalOffset - (SPLIT_TRACK_HEIGHT + SPLIT_TRACK_GAP);
  return SPLIT_TRACK_TOP + localOffset;
}

function buildSplitFaderKnob(actionType, volumePercent, accentColor, clipPathId) {
  const centerY = splitKnobCenterY(actionType, volumePercent);
  const knobTop = centerY - (SPLIT_KNOB_HEIGHT / 2);
  const visibleTop = SPLIT_TRACK_TOP;
  const visibleBottom = SPLIT_TRACK_TOP + SPLIT_TRACK_HEIGHT;
  if (knobTop >= visibleBottom || knobTop + SPLIT_KNOB_HEIGHT <= visibleTop) return "";

  return [
    `<g clip-path="url(#${clipPathId})">`,
    `<rect x="${SPLIT_KNOB_X}" y="${knobTop.toFixed(2)}" width="${SPLIT_KNOB_WIDTH}" height="${SPLIT_KNOB_HEIGHT}" rx="10" fill="#ffffff" />`,
    `<rect x="${SPLIT_KNOB_ACCENT_X}" y="${(knobTop + SPLIT_KNOB_Y_PAD).toFixed(2)}" width="${SPLIT_KNOB_ACCENT_WIDTH}" height="${SPLIT_KNOB_ACCENT_HEIGHT}" rx="3" fill="${accentColor}" />`,
    `</g>`
  ].join("");
}

function buildSplitFaderMuteFrame(actionType, muted) {
  if (!muted) return "";
  const showTop = actionType === "increaseBy";
  const showBottom = actionType === "decreaseBy";
  const sideOuter = "#ff2f45";
  const sideInner = "#ff9fa8";
  const fragments = [];

  fragments.push(`<rect x="4" y="8" width="6" height="128" rx="3" fill="${sideOuter}" />`);
  fragments.push(`<rect x="12" y="11" width="2" height="122" rx="1" fill="${sideInner}" />`);
  fragments.push(`<rect x="134" y="8" width="6" height="128" rx="3" fill="${sideOuter}" />`);
  fragments.push(`<rect x="130" y="11" width="2" height="122" rx="1" fill="${sideInner}" />`);

  if (showTop) {
    fragments.push(`<rect x="8" y="4" width="128" height="6" rx="3" fill="${sideOuter}" />`);
    fragments.push(`<rect x="11" y="12" width="122" height="2" rx="1" fill="${sideInner}" />`);
  }
  if (showBottom) {
    fragments.push(`<rect x="8" y="134" width="128" height="6" rx="3" fill="${sideOuter}" />`);
    fragments.push(`<rect x="11" y="130" width="122" height="2" rx="1" fill="${sideInner}" />`);
  }

  return fragments.join("");
}

function buildDbStatusSvg(state, settings) {
  const available = Boolean(state.available);
  const iconColor = available ? "#ffffff" : "#737373";
  const valueText = `${clampInt(state.volume, 0, 100, 0)}%`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">`,
    buildTileFrame({ fill: "#131313", outerStroke: available ? "#2f2f2f" : "#1e1e1e", innerStroke: available ? "#545454" : "#2a2a2a" }),
    buildNodeIcon(settings, { x: 40, y: 30, width: 64, stroke: iconColor, strokeWidth: 6 }),
    `<text x="72" y="30" text-anchor="middle" font-size="11" font-weight="600" fill="#8f8f8f" font-family="Inter, Arial, sans-serif">LEVEL</text>`,
    `<text x="72" y="122" text-anchor="middle" font-size="30" font-weight="700" fill="${iconColor}" font-family="Inter, Arial, sans-serif">${valueText}</text>`,
    `</svg>`
  ].join("");
}

function buildToggleStatusSvg(state, settings, accentColor) {
  const muted = Boolean(state.muted);
  const liveColor = resolveAccentColor({ ...settings, accentColor });
  const signalColor = muted ? "#ff2f45" : liveColor;
  const outerStroke = muted ? "#ff2f45" : "#2f2f2f";
  const innerStroke = muted ? "#ff9fa8" : hexToRgba(liveColor, 0.65);
  const glow = muted ? hexToRgba("#ff2f45", 0.45) : hexToRgba(liveColor, 0.45);
  const percentText = `${clampInt(state.volume, 0, 100, 0)}%`;
  const trackName = escapeSvgText(clipLabel(settings?.nodeName || "TRACK", 13));

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">`,
    buildTileFrame({ fill: "#121214", outerStroke, innerStroke }),
    `<rect x="29" y="23" width="86" height="72" rx="16" fill="none" stroke="${signalColor}" stroke-width="6" />`,
    `<rect x="33" y="27" width="78" height="64" rx="12" fill="none" stroke="${glow}" stroke-width="2" />`,
    `<path d="M41 66L50 50L60 72L71 44L82 72L92 56L103 66" fill="none" stroke="${signalColor}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />`,
    muted ? `<path d="M35 30L109 92" fill="none" stroke="#ff2f45" stroke-width="7" stroke-linecap="round" />` : "",
    `<text x="72" y="112" text-anchor="middle" font-size="23" font-weight="700" fill="#ffffff" font-family="Inter, Arial, sans-serif">${percentText}</text>`,
    `<text x="72" y="132" text-anchor="middle" font-size="12" font-weight="600" fill="${signalColor}" font-family="Inter, Arial, sans-serif">${trackName}</text>`,
    `</svg>`
  ].join("");
}

function buildSplitFaderSvg(actionType, state, settings, accentColor) {
  const available = Boolean(state.available);
  const volumePercent = clampInt(state.volume, 0, 100, 0);
  const currentPeakLevel = clampInt(state.peakLevel, 0, 100, 0);
  const muted = Boolean(state.muted);
  const split = splitRangeForAction(actionType);
  const symbol = actionType === "increaseBy" ? "+" : "−";
  const clipPathId = `split-fader-clip-${actionType}`;
  const sliderTrack = buildSplitSliderTrack(actionType, clipPathId);
  const faderKnob = available ? buildSplitFaderKnob(actionType, volumePercent, accentColor, clipPathId) : "";
  const muteFrame = buildSplitFaderMuteFrame(actionType, muted);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">`,
    `<defs>${sliderTrack.defs}</defs>`,
    buildTileFrame({ fill: "#131313", outerStroke: "#2f2f2f", innerStroke: "#575757" }),
    `<text x="22" y="33" text-anchor="middle" font-size="28" font-weight="700" fill="#ffffff" font-family="Inter, Arial, sans-serif">${symbol}</text>`,
    `<text x="26" y="122" text-anchor="middle" font-size="10" font-weight="600" fill="#9a9a9a" font-family="Inter, Arial, sans-serif">${split.label}</text>`,
    sliderTrack.markup,
    faderKnob,
    buildSplitVerticalMeter(actionType, available ? currentPeakLevel : 0),
    buildNodeIcon(settings, { x: 57, y: 114, width: 30, stroke: "#ffffff", strokeWidth: 2.6 }),
    muteFrame,
    `</svg>`
  ].join("");
}

function buildButtonImage(actionType, settings, state) {
  const accentColor = resolveAccentColor(settings);
  const svg = actionType === "dbStatus"
    ? buildDbStatusSvg(state, settings)
      : actionType === "toggleMute"
      ? buildToggleStatusSvg(state, settings, accentColor)
      : buildSplitFaderSvg(actionType, state, settings, accentColor);
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function refreshPeakVisuals() {
  for (const [context, runtime] of contexts.entries()) {
    const nodeId = runtime.settings.nodeId;
    if (!nodeId || !runtime.lastKnownState.available) continue;

    const nextPeak = pollNodePeakLevelMock(nodeId, runtime.lastKnownState.volume, runtime.lastKnownState.muted);
    runtime.lastKnownState = {
      ...runtime.lastKnownState,
      peakLevel: nextPeak
    };

    setImage(context, buildButtonImage(runtime.actionType, runtime.settings, runtime.lastKnownState));
    sendToPropertyInspector(runtime, context, {
      type: "peak",
      settings: {
        accentColor: resolveAccentColor(runtime.settings)
      },
      state: {
        volume: runtime.lastKnownState.volume,
        peakLevel: runtime.lastKnownState.peakLevel,
        muted: runtime.lastKnownState.muted,
        available: runtime.lastKnownState.available
      }
    });
  }
}

async function syncAllContextsForNode(nodeId) {
  if (!nodeId) return;
  const entries = Array.from(contexts.entries()).filter(([, runtime]) => String(runtime.settings.nodeId) === String(nodeId));
  await Promise.all(entries.map(([context, runtime]) => syncContext(runtime, context, { sendPi: true, sendImage: true })));
}

async function syncContext(runtime, context, options = { sendPi: true, sendImage: true }) {
  const devices = await listAudioNodes();
  const selected = devices.find((d) => d.id === String(runtime.settings.nodeId));

  if (!selected) {
    runtime.settings = {
      ...runtime.settings,
      nodeKind: "",
      nodeName: runtime.settings.nodeName || ""
    };
    runtime.lastKnownState = {
      available: false,
      volume: clampInt(runtime.settings.volume, 0, 100, 50),
      muted: Boolean(runtime.settings.muted),
      peakLevel: 0
    };
  } else {
    const nodeState = await getNodeState(selected.id);
    if (!nodeState) {
      runtime.settings = {
        ...runtime.settings,
        nodeKind: selected.kind,
        nodeName: selected.name
      };
      setSettings(context, runtime.settings);
      runtime.lastKnownState = {
        available: false,
        volume: clampInt(runtime.settings.volume, 0, 100, 50),
        muted: Boolean(runtime.settings.muted),
        peakLevel: 0
      };
    } else {
      const currentPeakLevel = pollNodePeakLevelMock(selected.id, nodeState.volume, nodeState.muted);
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
      setSettings(context, runtime.settings);
    }
  }

  if (options.sendImage) {
    setImage(
      context,
      buildButtonImage(runtime.actionType, runtime.settings, runtime.lastKnownState)
    );
    setTitle(context, "");
  }

  if (options.sendPi) {
    sendToPropertyInspector(runtime, context, {
      type: "status",
      actionType: runtime.actionType,
      devices,
      settings: runtime.settings,
      state: runtime.lastKnownState
    });
  }
}

async function applyKeyAction(runtime, context) {
  const nodeId = runtime.settings.nodeId;
  if (!nodeId) return;

  if (runtime.actionType === "dbStatus") return;

  if (runtime.actionType === "toggleMute") {
    await toggleNodeMute(nodeId);
    return;
  }

  const current = await getNodeState(nodeId);
  if (!current) return;

  const delta = runtime.actionType === "increaseBy" ? runtime.settings.stepPercent : -runtime.settings.stepPercent;
  const next = clampInt(current.volume + delta, 0, 100, current.volume);
  await setNodeVolume(nodeId, next);
}

async function handleWillAppear(message) {
  const context = message.context;
  const runtime = getRuntime(context, message.action);
  runtime.settings = mergeSettings(runtime.settings, message.payload?.settings || {});
  await syncContext(runtime, context, { sendPi: true, sendImage: true });
}

async function handleDidReceiveSettings(message) {
  const context = message.context;
  const runtime = getRuntime(context, message.action);
  runtime.settings = mergeSettings(runtime.settings, message.payload?.settings || {});
  await syncContext(runtime, context, { sendPi: true, sendImage: true });
}

async function handleKeyUp(message) {
  const context = message.context;
  const runtime = getRuntime(context, message.action);
  const nodeId = runtime.settings.nodeId;
  await applyKeyAction(runtime, context);
  if (nodeId) {
    await syncAllContextsForNode(nodeId);
  } else {
    await syncContext(runtime, context, { sendPi: true, sendImage: true });
  }
}

async function handleSendToPlugin(message) {
  const context = message.context;
  const runtime = getRuntime(context, message.action);
  const cmd = message.payload?.command;

  if (cmd === "requestNodes") {
    await syncContext(runtime, context, { sendPi: true, sendImage: false });
    return;
  }

  if (cmd === "setNode") {
    const nodeId = String(message.payload?.nodeId || "");
    runtime.settings = {
      ...runtime.settings,
      nodeId,
      nodeName: nodeId ? runtime.settings.nodeName : ""
    };
    setSettings(context, runtime.settings);
    await syncContext(runtime, context, { sendPi: true, sendImage: true });
    return;
  }

  if (cmd === "setStep") {
    runtime.settings = {
      ...runtime.settings,
      stepPercent: clampInt(message.payload?.stepPercent, 1, 30, runtime.settings.stepPercent)
    };
    setSettings(context, runtime.settings);
    await syncContext(runtime, context, { sendPi: true, sendImage: true });
    return;
  }

  if (cmd === "setAccent") {
    const accentColor = String(message.payload?.accentColor || "").trim();
    if (!isValidHexColor(accentColor)) return;
    runtime.settings = {
      ...runtime.settings,
      accentColor
    };
    setSettings(context, runtime.settings);
    await syncContext(runtime, context, { sendPi: true, sendImage: true });
  }
}

const pollInterval = setInterval(async () => {
  if (!contexts.size) {
    console.log("[Poll] No contexts to poll");
    return;
  }
  console.log(`[Poll] Refreshing ${contexts.size} context(s)...`);
  const entries = Array.from(contexts.entries());
  await Promise.all(
    entries.map(([context, runtime]) => syncContext(runtime, context, { sendPi: true, sendImage: true }))
  );
}, POLL_INTERVAL_MS);

setInterval(() => {
  if (!contexts.size) return;
  refreshPeakVisuals();
}, PEAK_POLL_INTERVAL_MS);

async function onMessage(rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch {
    return;
  }

  switch (message.event) {
    case "willAppear":
      await handleWillAppear(message);
      break;
    case "didReceiveSettings":
      await handleDidReceiveSettings(message);
      break;
    case "keyUp":
      await handleKeyUp(message);
      break;
    case "sendToPlugin":
      await handleSendToPlugin(message);
      break;
    case "willDisappear":
      contexts.delete(message.context);
      break;
    default:
      break;
  }
}

function connectSocket(inPort, inPluginUUID, inRegisterEvent) {
  pluginUUID = inPluginUUID;
  console.log(`[WS] Connecting to ws://127.0.0.1:${inPort}`);
  websocket = new WebSocket(`ws://127.0.0.1:${inPort}`);

  websocket.on("open", () => {
    console.log(`[WS] Connected, sending register event...`);
    send(inRegisterEvent, { uuid: pluginUUID });
  });
  websocket.on("message", (data) => {
    try {
      const msg = JSON.parse(String(data));
      console.log(`[WS] Received: ${msg.event || "unknown"}`);
      onMessage(String(data)).catch((err) => {
        console.error("[VolumeMixer] Message handling failed:", err);
      });
    } catch (e) {
      console.log(`[WS] Raw message: ${data}`);
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

function connectElgatoStreamDeckSocket(inPort, inPluginUUID, inRegisterEvent) {
  connectSocket(inPort, inPluginUUID, inRegisterEvent);
}

global.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;

function tryStartFromCliArgs() {
  const args = {};
  process.env.OSENDECK_DEBUG = process.env.OSENDECK_DEBUG || "1";
  // DEBUGGING: Alle CLI-Argumente anzeigen
  console.log("[VolumeMixer] CLI args:", process.argv.slice(2));
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = String(process.argv[i] || "").replace(/^-/, "");
    args[key] = process.argv[i + 1];
    console.log(`[VolumeMixer] Arg ${key}: ${process.argv[i + 1] || "(undefined)"}`);
  }
  if (args.port && args.pluginUUID && args.registerEvent) {
    console.log("[VolumeMixer] Starting WebSocket connection...");
    console.log("[VolumeMixer] Port:", args.port);
    console.log("[VolumeMixer] Plugin UUID:", args.pluginUUID);
    console.log("[VolumeMixer] Register Event:", args.registerEvent);
    connectSocket(args.port, args.pluginUUID, args.registerEvent);
    return;
  }
  console.log("[VolumeMixer] Warning: Missing required args (port, pluginUUID, registerEvent)");
  
  // DEBUGGING: Fallback zu Node.js Shell-Start
  console.log("[VolumeMixer] Fallback: Starting via node script...");
  const { spawn } = require("node:child_process");
  
  const nodeProcess = spawn("node", ["plugin.js"], {
    stdio: "inherit"
  });
  
  nodeProcess.on("error", (err) => {
    console.error("[VolumeMixer] Error spawning node:", err);
  });
  
  nodeProcess.on("close", (code) => {
    console.log(`[VolumeMixer] Node process closed with code: ${code}`);
  });
}

process.on("unhandledRejection", (err) => {
  console.error("[VolumeMixer] Unhandled rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("[VolumeMixer] Uncaught exception:", err);
});

tryStartFromCliArgs();
