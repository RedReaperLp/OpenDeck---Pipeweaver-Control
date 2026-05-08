"use strict";

const { spawn, execSync } = require("node:child_process");
const { clampInt } = require("./audio-service");

const peakStateByNode = new Map();
const activeMonitors = new Map();

/**
 * Mappt eine wpctl Node-ID auf die zugehörige pactl Source-ID.
 */
function getPactlTargetId(wpctlId, nodeKind) {
    try {
        // 1. Internen Namen über wpctl herausfinden
        const inspectOut = execSync(`wpctl inspect ${wpctlId}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const nameMatch = inspectOut.match(/node\.name\s*=\s*"([^"]+)"/);

        if (!nameMatch || !nameMatch[1]) return wpctlId;

        let targetName = nameMatch[1];

        // Wenn es ein Lautsprecher (Sink/Stream) ist, suchen wir den Monitor-Port
        if (nodeKind && !String(nodeKind).includes("source")) {
            targetName += ".monitor";
        }

        // 2. pactl Liste abfragen und ID extrahieren
        const pactlOut = execSync(`pactl list sources short`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const lines = pactlOut.split(/\r?\n/);

        for (const line of lines) {
            if (line.includes(targetName)) {
                const idMatch = line.match(/^(\d+)\s+/);
                if (idMatch && idMatch[1]) {
                    console.log(`[Mapper] wpctl ID ${wpctlId} ---> pactl Source ID ${idMatch[1]} (${targetName})`);
                    return idMatch[1]; // Die echte pactl ID (z.B. 209 oder 231)
                }
            }
        }
    } catch (e) {
        console.error(`[Mapper] Fehler beim Mappen von Node ${wpctlId}:`, e.message);
    }

    // Fallback auf wpctl ID, falls nichts gefunden wird
    return wpctlId;
}

class PeakMonitor {
    constructor(nodeId, nodeKind) {
        this.nodeId = nodeId;
        this.rawPeak = 0;
        this.lastPolled = Date.now();

        // Holt die korrekte pactl ID für pw-record
        const pactlId = getPactlTargetId(nodeId, nodeKind);

        // Keine Hacks mehr! Wir nutzen einfach direkt die pactl ID
        const args = [
            "--target", String(pactlId),
            "--format=f32",
            "--rate=8000",
            "--channels=1",
            "--latency=100ms",
            "-"
        ];

        console.log(`[PeakMonitor] Starte pw-record für Target ${pactlId}`);

        this.process = spawn("pw-record", args);

        let isFirstChunk = true;

        this.process.stdout.on("data", (chunk) => {
            let offset = 0;
            if (isFirstChunk) {
                offset = 44; // WAV Header überspringen
                isFirstChunk = false;
            }

            let maxAbs = 0;

            for (let i = offset; i <= chunk.length - 4; i += 4) {
                const sample = Math.abs(chunk.readFloatLE(i));
                if (sample > maxAbs) {
                    maxAbs = sample;
                }
            }

            let peakPercent = maxAbs * 100;
            if (peakPercent > 100) peakPercent = 100;

            if (peakPercent > this.rawPeak) {
                this.rawPeak = peakPercent;
            }
        });

        this.process.stderr.on("data", (data) => {
            const msg = data.toString().trim();
            if (msg !== "-") {
                console.error(`[PeakMonitor] STDERR Target ${pactlId}:`, msg);
            }
        });

        this.process.on("error", (err) => {
            console.error(`[PeakMonitor] FEHLER bei Target ${pactlId}:`, err.message);
        });

        this.process.on("close", (code) => {
            console.log(`[PeakMonitor] Stream beendet für ${pactlId} (Code ${code}).`);
        });
    }

    getPeak() {
        this.lastPolled = Date.now();
        const current = this.rawPeak;
        this.rawPeak = 0;
        return current;
    }

    destroy() {
        if (this.process && !this.process.killed) {
            this.process.kill("SIGTERM");
        }
    }
}

setInterval(() => {
    const now = Date.now();
    for (const [nodeId, monitor] of activeMonitors.entries()) {
        if (now - monitor.lastPolled > 2000) {
            monitor.destroy();
            activeMonitors.delete(nodeId);
            console.log(`[VolumeMixer] Garbage Collector: Stopped background stream for inactive Node ${nodeId}`);
        }
    }
}, 2000);

function pollNodePeakLevel(nodeId, nodeKind, volumePercent, isMuted) {
    const now = Date.now();
    const currentVolume = clampInt(volumePercent, 0, 100, 0);
    const key = String(nodeId || "");

    if (!nodeId || isMuted || currentVolume <= 0) {
        peakStateByNode.set(key, { value: 0, tick: now });
        return 0;
    }

    let monitor = activeMonitors.get(key);
    if (!monitor) {
        monitor = new PeakMonitor(key, nodeKind);
        activeMonitors.set(key, monitor);
        peakStateByNode.set(key, { value: 0, tick: now });
        return 0;
    }

    const rawPeak = monitor.getPeak() * (currentVolume / 100);

    const prev = peakStateByNode.get(key) || { value: 0, tick: now };
    const elapsed = Math.max(1, now - prev.tick);

    const rise = 0.6;
    const decay = Math.min(0.85, elapsed / 400);

    const next = rawPeak > prev.value
        ? prev.value + (rawPeak - prev.value) * rise
        : prev.value - (prev.value - rawPeak) * decay;

    const clamped = clampInt(next, 0, 100, 0);
    peakStateByNode.set(key, { value: clamped, tick: now });

    if (clamped > 0 || rawPeak > 0) {
        console.log(`[Peak-Calc] Node ${key} | F32-Raw: ${rawPeak.toFixed(2)}% | Smoothed (UI): ${clamped}%`);
    }

    return clamped;
}

module.exports = {
    pollNodePeakLevel
};