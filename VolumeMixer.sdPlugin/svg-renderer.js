"use strict";

const {clampInt} = require("./audio-service");

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

function buildOldHeadphoneIcon({x, y, width, stroke, strokeWidth}) {
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

function buildMicrophoneIcon({x, y, width, stroke, strokeWidth}) {
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
    return buildOldHeadphoneIcon(options);
}

function buildTileFrame({fill = "#141414", outerStroke = "#2f2f2f", innerStroke = "#575757"} = {}) {
    return [
        `<rect x="0" y="0" width="144" height="144" rx="25" fill="${fill}" />`,
        `<rect x="3" y="3" width="138" height="138" rx="22" fill="none" stroke="${outerStroke}" stroke-width="6" />`,
        `<rect x="9" y="9" width="126" height="126" rx="18" fill="none" stroke="${innerStroke}" stroke-width="2" />`
    ].join("");
}

// -------------------------------------------------------------------------
// NEUES SPLIT-FADER DESIGN (Nahtlose Rahmen & FARBE AUS PIPEWEAVER!)
// -------------------------------------------------------------------------
function buildSplitFaderSvg(actionType, state, settings, accentColor) {
    const available = Boolean(state.available);
    const volumePercent = clampInt(state.volume, 0, 100, 0);
    const currentPeakLevel = clampInt(state.peakLevel, 0, 100, 0);
    const muted = Boolean(state.muted);
    const isTop = actionType === "increaseBy";

    // 1. Hintergrund / Button-Rahmen
    let frameElements = [];
    frameElements.push(
        `<defs>`,
        `<linearGradient id="bgGrad" x1="0%" y1="0%" x2="0%" y2="100%">`,
        `<stop offset="0%" stop-color="#2c2c2c" />`,
        `<stop offset="100%" stop-color="#181818" />`,
        `</linearGradient>`,
        `</defs>`
    );

    if (isTop) {
        frameElements.push(`<rect x="0" y="0" width="144" height="164" rx="20" fill="url(#bgGrad)" />`);
        if (muted) {
            frameElements.push(`<rect x="3" y="3" width="138" height="161" rx="18" fill="none" stroke="#ff2f45" stroke-width="6" />`);
            frameElements.push(`<rect x="9" y="9" width="126" height="155" rx="14" fill="none" stroke="#ff9fa8" stroke-width="2" />`);
        } else {
            frameElements.push(`<rect x="2" y="2" width="140" height="162" rx="18" fill="none" stroke="#3d3d3d" stroke-width="2" />`);
        }
    } else {
        frameElements.push(`<rect x="0" y="-20" width="144" height="164" rx="20" fill="url(#bgGrad)" />`);
        if (muted) {
            frameElements.push(`<rect x="3" y="-20" width="138" height="161" rx="18" fill="none" stroke="#ff2f45" stroke-width="6" />`);
            frameElements.push(`<rect x="9" y="-20" width="126" height="155" rx="14" fill="none" stroke="#ff9fa8" stroke-width="2" />`);
        } else {
            frameElements.push(`<rect x="2" y="-20" width="140" height="162" rx="18" fill="none" stroke="#3d3d3d" stroke-width="2" />`);
        }
    }
    const frame = frameElements.join("");

    // 2. Slider Bahn
    const trackX = 42;
    const trackW = 16;
    const topTrackY = 24;
    const bottomTrackEndY = 120;
    const virtualY = ((100 - volumePercent) / 100) * 240;
    const darkGrey = "#111111";

    // HIER WIRD NUN DIE FARBE ZUGEWIESEN:
    const activeTrackColor = muted ? "#e74c3c" : accentColor;

    let trackElements = [];
    if (isTop) {
        trackElements.push(`<path d="M ${trackX} ${topTrackY + trackW / 2} A ${trackW / 2} ${trackW / 2} 0 0 1 ${trackX + trackW} ${topTrackY + trackW / 2} L ${trackX + trackW} 144 L ${trackX} 144 Z" fill="${darkGrey}" />`);
        if (virtualY < 120) {
            const fillY = topTrackY + virtualY;
            trackElements.push(`<rect x="${trackX}" y="${fillY}" width="${trackW}" height="${144 - fillY}" fill="${activeTrackColor}" />`);
        }
    } else {
        trackElements.push(`<path d="M ${trackX} 0 L ${trackX + trackW} 0 L ${trackX + trackW} ${bottomTrackEndY - trackW / 2} A ${trackW / 2} ${trackW / 2} 0 0 1 ${trackX} ${bottomTrackEndY - trackW / 2} Z" fill="${darkGrey}" />`);
        if (virtualY <= 120) {
            trackElements.push(`<path d="M ${trackX} 0 L ${trackX + trackW} 0 L ${trackX + trackW} ${bottomTrackEndY - trackW / 2} A ${trackW / 2} ${trackW / 2} 0 0 1 ${trackX} ${bottomTrackEndY - trackW / 2} Z" fill="${activeTrackColor}" />`);
        } else {
            const fillY = virtualY - 120;
            trackElements.push(`<path d="M ${trackX} ${fillY} L ${trackX + trackW} ${fillY} L ${trackX + trackW} ${bottomTrackEndY - trackW / 2} A ${trackW / 2} ${trackW / 2} 0 0 1 ${trackX} ${bottomTrackEndY - trackW / 2} Z" fill="${activeTrackColor}" />`);
        }
    }

    // 3. Slider Knob
    let knobElement = "";
    if (available) {
        const knobW = 44;
        const knobH = 24;
        const knobX = trackX + (trackW / 2) - (knobW / 2);
        let localCenterY = isTop ? (24 + virtualY) : (virtualY - 120);
        const knobTop = localCenterY - (knobH / 2);

        if ((isTop && knobTop <= 144) || (!isTop && (knobTop + knobH) >= 0)) {
            const filterDef = `
              <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
                  <feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#000" flood-opacity="0.8"/>
              </filter>
          `;
            knobElement = [
                filterDef,
                `<rect x="${knobX}" y="${knobTop}" width="${knobW}" height="${knobH}" rx="4" fill="#e0e0e0" filter="url(#shadow)" />`,
                `<rect x="${knobX + 6}" y="${knobTop + (knobH / 2) - 1.5}" width="${knobW - 12}" height="3" rx="1.5" fill="#222" />`
            ].join("");
        }
    }

    // 4. LED Meter
    const meterElements = [];
    if (available) {
        const activeSegments = Math.round((currentPeakLevel / 100) * 11);
        const colors = [
            "#39d267", "#39d267", "#39d267", "#39d267", "#39d267",
            "#39d267", "#39d267", "#a4d936", "#f1d42f", "#f59e28", "#eb4926"
        ];
        const meterX = 92;
        const meterW = 18;
        const meterH = 10;

        if (isTop) {
            const topYs = [116, 98, 80, 62, 44, 26];
            for (let i = 0; i < 6; i++) {
                const segmentNum = 6 + i;
                const color = (segmentNum <= activeSegments) ? colors[segmentNum - 1] : "#111111";
                meterElements.push(`<rect x="${meterX}" y="${topYs[i]}" width="${meterW}" height="${meterH}" rx="2" fill="${color}" />`);
            }
        } else {
            const bottomYs = [86, 68, 50, 32, 14];
            for (let i = 0; i < 5; i++) {
                const segmentNum = 1 + i;
                const color = (segmentNum <= activeSegments) ? colors[segmentNum - 1] : "#111111";
                meterElements.push(`<rect x="${meterX}" y="${bottomYs[i]}" width="${meterW}" height="${meterH}" rx="2" fill="${color}" />`);
            }
        }
    }

    // 5. Kleines Icon unten
    let iconElement = "";
    if (!isTop) {
        const cx = 72;
        const cy = 118;
        iconElement = [
            `<g fill="none" stroke="#888" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">`,
            `<path d="M ${cx - 9} ${cy + 5} A 9 9 0 0 1 ${cx + 9} ${cy + 5}" />`,
            `<rect x="${cx - 12}" y="${cy}" width="5" height="8" rx="2" fill="#888" />`,
            `<rect x="${cx + 7}" y="${cy}" width="5" height="8" rx="2" fill="#888" />`,
            `</g>`
        ].join("");
    }

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">`,
        frame,
        trackElements.join(""),
        meterElements.join(""),
        knobElement,
        iconElement,
        `</svg>`
    ].join("");
}

function buildDbStatusSvg(state, settings) {
    const available = Boolean(state.available);
    const iconColor = available ? "#ffffff" : "#737373";
    const valueText = `${clampInt(state.volume, 0, 100, 0)}%`;

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">`,
        buildTileFrame({
            fill: "#131313",
            outerStroke: available ? "#2f2f2f" : "#1e1e1e",
            innerStroke: available ? "#545454" : "#2a2a2a"
        }),
        buildNodeIcon(settings, {x: 40, y: 30, width: 64, stroke: iconColor, strokeWidth: 6}),
        `<text x="72" y="30" text-anchor="middle" font-size="11" font-weight="600" fill="#8f8f8f" font-family="Inter, Arial, sans-serif">LEVEL</text>`,
        `<text x="72" y="122" text-anchor="middle" font-size="30" font-weight="700" fill="${iconColor}" font-family="Inter, Arial, sans-serif">${valueText}</text>`,
        `</svg>`
    ].join("");
}

function buildToggleStatusSvg(state, settings, accentColor) {
    const muted = Boolean(state.muted);
    const liveColor = resolveAccentColor({...settings, accentColor});
    const signalColor = muted ? "#ff2f45" : liveColor;
    const outerStroke = muted ? "#ff2f45" : "#2f2f2f";
    const innerStroke = muted ? "#ff9fa8" : hexToRgba(liveColor, 0.65);
    const glow = muted ? hexToRgba("#ff2f45", 0.45) : hexToRgba(liveColor, 0.45);
    const percentText = `${clampInt(state.volume, 0, 100, 0)}%`;

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">`,
        buildTileFrame({fill: "#121214", outerStroke, innerStroke}),
        `<rect x="29" y="23" width="86" height="72" rx="16" fill="none" stroke="${signalColor}" stroke-width="6" />`,
        `<rect x="33" y="27" width="78" height="64" rx="12" fill="none" stroke="${glow}" stroke-width="2" />`,
        `<path d="M41 66L50 50L60 72L71 44L82 72L92 56L103 66" fill="none" stroke="${signalColor}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />`,
        muted ? `<path d="M35 30L109 92" fill="none" stroke="#ff2f45" stroke-width="7" stroke-linecap="round" />` : "",
        `<text x="72" y="127" text-anchor="middle" font-size="23" font-weight="700" fill="#ffffff" font-family="Inter, Arial, sans-serif">${percentText}</text>`,
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

module.exports = {
    buildButtonImage,
    resolveAccentColor,
};