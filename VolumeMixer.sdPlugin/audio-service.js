"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { WPCTL_TIMEOUT_MS } = require("./config");

const execFileAsync = promisify(execFile);
let debugLogCount = 0;

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

async function runWpctl(args) {
    debugLogCount++;
    const logId = `WPCTL-${debugLogCount}`;
    console.log(`[${logId}] Executing wpctl: ${args.join(" ")}`);
    try {
        const { stdout, stderr } = await execFileAsync("wpctl", args, { timeout: WPCTL_TIMEOUT_MS });
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

        const sectionMatch = line.match(/^[\s│├└─]*(Sinks|Sources|Sink endpoints|Source endpoints|Streams):\s*$/i);
        if (sectionMatch) {
            section = sectionMatch[1].toLowerCase();
            continue;
        }

        if (!sectionKinds[section]) continue;

        const cleaned = line.replace(/^[\s│├└─]+/, "");
        const idMatch = cleaned.match(/^(\*)?\s*([0-9]+)\.\s+(.+?)\s*$/);
        if (!idMatch) continue;

        const id = idMatch[2];
        if (seenIds.has(id)) continue;

        const isDefault = Boolean(idMatch[1]);
        let name = idMatch[3].replace(/\s*\[vol:[^\]]+\]\s*$/i, "").trim();

        if (sectionKinds[section] === "stream" && /[<>]/.test(name)) continue;
        if (!name) name = `Node ${id}`;

        nodes.push({ id, kind: sectionKinds[section], name, isDefault });
        seenIds.add(id);
    }
    return nodes;
}

async function getNodeState(nodeId) {
    const result = await runWpctl(["get-volume", String(nodeId)]);
    if (!result.ok) return null;

    const volMatch = result.stdout.match(/Volume:\s*([0-9]*\.?[0-9]+)/i);
    if (!volMatch) return null;

    const volumeFloat = Number(volMatch[1]);
    if (!Number.isFinite(volumeFloat)) return null;

    let volume = clampInt(volumeFloat * 100, 0, 150, 0);
    return {
        volume: volume,
        muted: /\[MUTED\]/i.test(result.stdout) || volume === 0
    };
}

async function setNodeVolume(nodeId, volumePercent) {
    const normalized = clampInt(volumePercent, 0, 100, 50);
    return runWpctl(["set-volume", String(nodeId), `${normalized}%`]);
}

const preMuteVolumes = new Map();

async function toggleNodeMute(nodeId) {
    const state = await getNodeState(nodeId);
    if (!state) return { ok: false };

    const key = String(nodeId);

    // Wir definieren "gemutet" als: Entweder ist das Flag gesetzt ODER die Lautstärke ist auf 0
    const isEffectivelyMuted = state.muted || state.volume === 0;

    if (!isEffectivelyMuted) {
        // --- MUTE VORGANG ---
        console.log(`[VolumeMixer] Hard-Muting Node ${key} (Current Vol: ${state.volume}%)`);

        // 1. Aktuelle Lautstärke merken
        preMuteVolumes.set(key, state.volume);

        // 2. Offizielles Mute-Flag setzen (Für die UI-Anzeige in pavucontrol/PipeWeaver)
        await runWpctl(["set-mute", key, "1"]);

        // 3. HARD MUTE: Die Lautstärke radikal auf 0% ziehen.
        // Das unterbricht den Audiofluss zuverlässig, auch bei direkten Routings.
        return runWpctl(["set-volume", key, "0%"]);

    } else {
        // --- UNMUTE VORGANG ---
        console.log(`[VolumeMixer] Unmuting Node ${key}`);

        // 1. Offizielles Mute-Flag entfernen
        await runWpctl(["set-mute", key, "0"]);

        // 2. Alte Lautstärke wiederherstellen (oder 50% als Fallback)
        const restoredVolume = preMuteVolumes.get(key) || 50;
        return runWpctl(["set-volume", key, `${restoredVolume}%`]);
    }
}

module.exports = {
    listAudioNodes,
    getNodeState,
    setNodeVolume,
    toggleNodeMute,
    clampInt
};