// Pure helpers for the HUD: step bookkeeping, text, and the scanline strip.
// No engine calls here, so they can be tested on their own.
import { translate } from './translate.js';

export const LEVELS = ['simple', 'vibe', 'eng'];
export const LEVEL_NAMES = { simple: 'Simple', vibe: 'Vibe', eng: 'Engineer' };
export const LAYOUTS = ['cards', 'flow', 'timeline'];
export const LAYOUT_NAMES = { cards: 'Cards', flow: 'Flow', timeline: 'Timeline' };
export const MAX_STEPS = 40;
export const THEMES = ['claude', 'codex'];
export const THEME_NAMES = { claude: 'Claude', codex: 'Codex' };

// Same palettes as the browser UI (public/styles.css). Solid hex only, so the
// terminal can use them too.
export const PALETTES = {
  claude: {
    bg: '#11100f', panel: '#1c1a17', panel2: '#241f1b', line: '#2b2925', line2: '#45413b',
    text: '#ece9e0', dim: '#9a958a', faint: '#6b665d', accent: '#d97757', accent2: '#f0b48c',
    grid: '#1a1612', ok: '#9ccb8a', error: '#ff7a6b',
    cats: { you: '#f0b48c', say: '#ece9e0', read: '#8fb8de', write: '#e0875f', run: '#c7a0dc', test: '#9ccb8a', search: '#7fc4c0', web: '#86a9e8', plan: '#e0c26a', agent: '#b39ddb', ask: '#f5a3b5', tool: '#b8b2a6', fix: '#ff5f7e' },
  },
  codex: {
    bg: '#090b0e', panel: '#10151b', panel2: '#151c24', line: '#1e252d', line2: '#36414c',
    text: '#e6edf3', dim: '#8b98a5', faint: '#5b6773', accent: '#7dd3fc', accent2: '#e6edf3',
    grid: '#0f151a', ok: '#86efac', error: '#f87171',
    cats: { you: '#e6edf3', say: '#c9d6e2', read: '#7dd3fc', write: '#a5b4fc', run: '#c4b5fd', test: '#86efac', search: '#5eead4', web: '#93c5fd', plan: '#fde68a', agent: '#d8b4fe', ask: '#f9a8d4', tool: '#94a3b8', fix: '#fb7185' },
  },
};

export const catColor = (P, cat) => P.cats[cat] || P.cats.tool;

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

/** When a step began, relative to the turn: "0:07". */
export function stepTime(step, turnStart) {
  return elapsed(turnStart === null ? 0 : step.startedAt - turnStart);
}

/** The last `n` fixes from fixes.jsonl text, newest last. Unreadable lines are skipped. */
export function parseFixes(raw, n = 50) {
  const out = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const f = JSON.parse(line);
      if (typeof f.text !== 'string') continue;
      const at = Date.parse(f.delivered_at || f.ts || '');
      out.push({
        text: f.text,
        urgent: f.urgency === 'urgent',
        at: Number.isFinite(at) ? at : null,
        sessionId: f.session_id ?? null,
        deliveredAt: f.delivered_at ?? null,
        doing: f.doing ?? null,
      });
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
export function scanCells(columns, tick, busy, P = PALETTES.claude) {
  const words = new Uint32Array(columns * 3);
  const bg = hex(P.bg);
  const head = ((tick * 2) % (columns + 8)) - 4;
  for (let x = 0; x < columns; x++) {
    let cp = 0x2500; // ─
    let fg = hex(P.line2);
    if (busy) {
      const d = head - x;
      if (d === 0) { cp = 0x2588; fg = hex(P.accent); }
      else if (d > 0 && d < 7) { cp = d < 3 ? 0x2593 : d < 5 ? 0x2592 : 0x2591; fg = mix(hex(P.accent), hex(P.line2), d / 7); }
      else if (x % 4 === 0) cp = 0x2574; // ╴ tick marks
    }
    words.set([cp, fg, bg], x * 3);
  }
  return toBase64(new Uint8Array(words.buffer));
}
