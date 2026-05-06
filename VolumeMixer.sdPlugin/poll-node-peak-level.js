"use strict";

const { spawn } = require("node:child_process");
const { clampInt } = require("./audio-service");

const peakStateByNode = new Map();
const activeMonitors = new Map();

/**
 * Der PeakMonitor spawnt einen minimalen pw-record Prozess für eine Node.
 * Er läuft im Hintergrund und liest direkt den rohen Binär-Audiostream.
 */
class PeakMonitor {
    constructor(nodeId) {
        this.nodeId = nodeId;
        this.rawPeak = 0;
        this.lastPolled = Date.now();
        this.process = spawn("pw-record", [
            "--target", String(nodeId),
            "--format=s16",
            "--rate=8000",
            "--channels=1",
            "-"
        ]);

        let isFirstChunk = true;

        this.process.stdout.on("data", (chunk) => {
            let offset = 0;
            if (isFirstChunk) {
                offset = 44;
                isFirstChunk = false;
            }

            let localMax = 0;
            for (let i = offset; i < chunk.length - 1; i += 2) {
                const sample = Math.abs(chunk.readInt16LE(i));
                if (sample > localMax) localMax = sample;
            }

            const normalized = localMax / 32768;
            this.rawPeak = Math.sqrt(normalized) * 100;
        });

        this.process.on("error", (err) => {
            console.error(`[PeakMonitor] Fehler bei Node ${nodeId}:`, err.message);
        });
    }

    getPeak() {
        this.lastPolled = Date.now();
        const current = this.rawPeak;
        this.rawPeak *= 0.5;
        return current;
    }

    destroy() {
        if (this.process && !this.process.killed) {
            this.process.kill("SIGTERM");
        }
    }
}

/**
 * Garbage Collector:
 * Räumt Prozesse auf, wenn Tasten auf dem OpenDeck nicht mehr sichtbar sind.
 * Wenn eine Node 2 Sekunden lang nicht gepollt wurde, wird der Stream beendet.
 */
setInterval(() => {
    const now = Date.now();
    for (const [nodeId, monitor] of activeMonitors.entries()) {
        if (now - monitor.lastPolled > 2000) {
            monitor.destroy();
            activeMonitors.delete(nodeId);
            console.log(`[VolumeMixer] Stopped background stream for inactive Node ${nodeId}`);
        }
    }
}, 2000);

/**
 * Deine Export-Funktion
 */
function pollNodePeakLevel(nodeId, volumePercent, isMuted) {
    const now = Date.now();
    const currentVolume = clampInt(volumePercent, 0, 100, 0);
    const key = String(nodeId || "");

    if (!nodeId || isMuted || currentVolume <= 0) {
        peakStateByNode.set(key, { value: 0, tick: now });
        return 0;
    }

    // 1. Hintergrund-Stream holen oder starten
    let monitor = activeMonitors.get(key);
    if (!monitor) {
        monitor = new PeakMonitor(key);
        activeMonitors.set(key, monitor);

        // Da der Prozess gerade erst startet, direkt 0 zurückgeben (verhindert Glitches)
        peakStateByNode.set(key, { value: 0, tick: now });
        return 0;
    }

    // 2. Echtes Audio-Signal holen
    // Hinweis: pw-record liefert das Signal "Pre-Fader" (unabhängig vom eingestellten Volumen).
    // Daher skalieren wir es mit deiner aktuellen Deck-Lautstärke.
    const rawPeak = monitor.getPeak() * (currentVolume / 100);

    // 3. Deine Smoothing & Decay Logik (Bewusst beibehalten für flüssige UI-Animationen)
    const prev = peakStateByNode.get(key) || { value: 0, tick: now };
    const elapsed = Math.max(1, now - prev.tick);

    // Anstiegsgeschwindigkeit (schnell)
    const rise = 0.6;
    // Abfallgeschwindigkeit (weich, abhängig von vergangener Zeit)
    const decay = Math.min(0.85, elapsed / 400);

    const next = rawPeak > prev.value
        ? prev.value + (rawPeak - prev.value) * rise
        : prev.value - (prev.value - rawPeak) * decay;

    const clamped = clampInt(next, 0, 100, 0);
    peakStateByNode.set(key, { value: clamped, tick: now });

    return clamped;
}

module.exports = {
    pollNodePeakLevel
};