// Pure helpers for the HUD: step bookkeeping, text, and the scanline strip.
// No engine calls here, so they can be tested on their own.
import { translate } from './translate.js';

export const LEVELS = ['simple', 'vibe', 'eng'];
export const LEVEL_NAMES = { simple: 'Simple', vibe: 'Vibe', eng: 'Engineer' };
export const MAX_STEPS = 12;

export const COLORS = {
  cyan: '#38e8ff',
  dim: '#2a6f7c',
  amber: '#ffb347',
  green: '#4dffa6',
  red: '#ff4d5e',
};

/** A new running step from a tool.call event. */
export function startStep(e, now) {
  const { tool, tool_use_id, agentId, ...input } = e;
  return {
    id: tool_use_id,
    kind: 'tool',
    name: String(tool),
    input: stripReserved(input),
    status: 'running',
    startedAt: now,
    endedAt: null,
    side: Boolean(agentId),
  };
}

function stripReserved(input) {
  const out = {};
  for (const [k, v] of Object.entries(input)) if (k !== 'requestMeta') out[k] = v;
  return out;
}

/** Pushes a step, keeping the newest MAX_STEPS. */
export function pushStep(steps, step) {
  return [...steps, step].slice(-MAX_STEPS);
}

export function finishStep(steps, id, { isError, now }) {
  return steps.map((s) => (s.id === id ? { ...s, status: isError ? 'error' : 'done', endedAt: now } : s));
}

/** translate() from visualizar, guarded: an unexpected step never breaks the pane. */
export function viewOf(step, cwd) {
  try {
    return translate(step, { cwd }).view;
  } catch {
    return { simple: `Using ${step.name}`, vibe: `Using ${step.name}`, eng: { title: step.name } };
  }
}

const plain = (s) => String(s ?? '').replace(/`/g, '').replace(/\s+/g, ' ').trim();

export function textFor(view, level) {
  if (level === 'eng') return plain(view.eng?.title || view.simple);
  return plain(level === 'vibe' ? view.vibe : view.simple);
}

export function clipTo(s, n) {
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s;
}

/** 65000 ms -> "1:05" */
export function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The last `n` fixes from fixes.jsonl text, newest last. Unreadable lines are skipped. */
export function parseFixes(raw, n = 3) {
  const out = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const f = JSON.parse(line);
      if (typeof f.text === 'string') out.push({ text: f.text, urgent: f.urgency === 'urgent' });
    } catch {
      /* skip */
    }
  }
  return out.slice(-n);
}

// ---------------------------------------------------------------------------
// Scanline strip (terminal Raster)

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

const hex = (s) => parseInt(s.slice(1), 16);
const mix = (a, b, t) => {
  const c = (sh) => Math.round(((a >> sh) & 255) * (1 - t) + ((b >> sh) & 255) * t);
  return (c(16) << 16) | (c(8) << 8) | c(0);
};

/**
 * One row of cells: a bright head sweeping left to right with a fading trail
 * while busy, a dim static rule when idle. Returns the Raster `cells` string.
 */
export function scanCells(columns, tick, busy) {
  const words = new Uint32Array(columns * 3);
  const bg = 0x05161a;
  const head = ((tick * 2) % (columns + 8)) - 4;
  for (let x = 0; x < columns; x++) {
    let cp = 0x2500; // ─
    let fg = hex(COLORS.dim);
    if (busy) {
      const d = head - x;
      if (d === 0) { cp = 0x2588; fg = hex(COLORS.cyan); }
      else if (d > 0 && d < 7) { cp = d < 3 ? 0x2593 : d < 5 ? 0x2592 : 0x2591; fg = mix(hex(COLORS.cyan), hex(COLORS.dim), d / 7); }
      else if (x % 4 === 0) cp = 0x2574; // ╴ tick marks
    }
    words.set([cp, fg, bg], x * 3);
  }
  return toBase64(new Uint8Array(words.buffer));
}

/** Animated strip for the surfaces with Svg (Desktop, VS Code). */
export function stripSvg(width, busy) {
  const h = 6;
  const bar = busy
    ? `<rect y="1" width="60" height="4" rx="2" fill="url(#g)"><animate attributeName="x" from="-60" to="${width}" dur="1.6s" repeatCount="indefinite"/></rect>`
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">` +
    `<defs><linearGradient id="g"><stop offset="0" stop-color="${COLORS.cyan}" stop-opacity="0"/><stop offset="1" stop-color="${COLORS.cyan}"/></linearGradient></defs>` +
    `<rect y="2" width="${width}" height="2" rx="1" fill="${COLORS.dim}" opacity="0.5"/>${bar}</svg>`
  );
}
