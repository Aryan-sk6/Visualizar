// The HUD drawn as one SVG for the surfaces that have Svg (Desktop, VS Code).
// Mirrors the browser version: NOW strip, a big glowing centre card with the
// steps around it, a coloured step track, and Flow / Timeline layouts.
// Pure: data in, markup out.

import { PALETTES, catColor, textFor } from './hud.js';
import { ICONS } from './icons.js';

const SANS = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, system-ui, Segoe UI, sans-serif';
const MONO = 'ui-monospace, SF Mono, Menlo, Consolas, monospace';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CAT_LABEL = {
  you: 'YOU', say: 'CLAUDE', read: 'READ', write: 'WRITE', run: 'RUN', test: 'TEST', search: 'SEARCH',
  web: 'WEB', plan: 'PLAN', agent: 'HELPER', ask: 'QUESTION', tool: 'TOOL', fix: 'YOUR FIX',
};

/** Splits text into at most `max` lines of about `chars` characters. */
export function wrap(text, chars, max) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= chars) cur += ' ' + w;
    else {
      lines.push(cur);
      cur = w;
    }
    if (lines.length === max) break;
  }
  if (lines.length < max && cur) lines.push(cur);
  const used = lines.join(' ').length;
  const full = words.join(' ');
  if (used < full.length && lines.length) {
    let last = lines[lines.length - 1];
    if (last.length > chars - 1) last = last.slice(0, chars - 1);
    lines[lines.length - 1] = last.replace(/[\s,.;:]+$/, '') + '…';
  }
  return lines.map((l) => (l.length > chars ? l.slice(0, chars - 1) + '…' : l));
}

function icon(name, x, y, size, color, width = 1.6) {
  const s = size / 24;
  return `<g transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="${color}" stroke-width="${width / s > 3 ? 1.6 : width}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.spark}</g>`;
}

function text(x, y, str, { size = 13, color, weight = 400, family = SANS, anchor = 'start', spacing = 0, opacity = 1 } = {}) {
  return `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}"${spacing ? ` letter-spacing="${spacing}"` : ''}${opacity !== 1 ? ` opacity="${opacity}"` : ''}>${esc(str)}</text>`;
}

function brackets(x, y, w, h, color, len = 14, width = 2) {
  return `<path d="M${x} ${y + len}V${y}H${x + len} M${x + w - len} ${y + h}H${x + w}V${y + h - len}" fill="none" stroke="${color}" stroke-width="${width}"/>`;
}

function statusOf(s, now) {
  if (s.kind === 'fix') return { color: 'fix', label: s.deliveredAt ? 'delivered' : 'logged' };
  if (s.kind !== 'tool') return { color: 'done', label: '' };
  const secs = Math.max(0, Math.round(((s.endedAt ?? now) - s.startedAt) / 1000));
  const d = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
  if (s.status === 'running') return { color: 'run', label: `working · ${d}` };
  if (s.status === 'error') return { color: 'error', label: `snag · ${d}` };
  return { color: 'done', label: `done · ${d}` };
}

const statusFill = (P, c) => (c === 'run' ? P.accent : c === 'error' ? P.error : c === 'fix' ? P.cats.fix : P.ok);

// ---------------------------------------------------------------------------

function defs(P, W, H) {
  return `<defs>
    <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M28 0H0V28" fill="none" stroke="${P.grid}" stroke-width="1"/></pattern>
    <radialGradient id="vig" cx="50%" cy="45%" r="70%"><stop offset="55%" stop-color="${P.bg}" stop-opacity="0"/><stop offset="100%" stop-color="${P.bg}" stop-opacity="0.95"/></radialGradient>
    <linearGradient id="sweep"><stop offset="0" stop-color="${P.accent}" stop-opacity="0"/><stop offset="0.5" stop-color="${P.accent}"/><stop offset="1" stop-color="${P.accent}" stop-opacity="0"/></linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="14"/></filter>
    <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>
    <clipPath id="frame"><rect width="${W}" height="${H}" rx="10"/></clipPath>
  </defs>`;
}

function background(P, W, H) {
  return `<rect width="${W}" height="${H}" rx="10" fill="${P.bg}"/><rect width="${W}" height="${H}" fill="url(#grid)"/><rect width="${W}" height="${H}" fill="url(#vig)"/>`;
}

function nowStrip(P, d, x, y, w) {
  const h = 74;
  const live = d.live;
  const parts = [`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${P.panel}" stroke="${P.line}" />`, brackets(x - 1, y - 1, w + 2, h + 2, P.accent2, 11, 1.2)];
  const cx = x + 40;
  const cy = y + h / 2;
  parts.push(`<circle cx="${cx}" cy="${cy}" r="22" fill="none" stroke="${live ? P.accent : P.line2}" stroke-width="1.5"/>`);
  if (live) {
    parts.push(`<circle cx="${cx}" cy="${cy}" r="22" fill="none" stroke="${P.accent}" stroke-width="2"><animate attributeName="r" values="22;34" dur="1.8s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.7;0" dur="1.8s" repeatCount="indefinite"/></circle>`);
  }
  parts.push(icon(d.nowIcon, cx - 11, cy - 11, 22, live ? P.accent2 : P.dim));
  parts.push(text(x + 76, y + 27, d.nowLabel, { size: 10, color: P.dim, family: MONO, spacing: 1.8 }));
  const narrow = w < 520;
  const clockW = narrow ? 92 : 128;
  const fs = narrow ? 17 : 20;
  const maxChars = Math.max(8, Math.floor((w - 76 - clockW - 12) / (fs * 0.56)));
  const line = d.nowText.length > maxChars ? d.nowText.slice(0, maxChars - 1) + '…' : d.nowText;
  parts.push(text(x + 76, y + 52, line, { size: fs, weight: 650, color: live ? P.text : P.dim }));
  parts.push(text(x + w - 16, y + (narrow ? 43 : 36), d.clock, { size: narrow ? 16 : 20, color: P.accent2, family: MONO, anchor: 'end', spacing: 1 }));
  if (!narrow) parts.push(text(x + w - 16, y + 56, d.meta, { size: 10, color: P.dim, family: MONO, anchor: 'end', spacing: 1.4 }));
  if (live) {
    parts.push(`<rect x="${x}" y="${y + h - 2}" width="${w * 0.3}" height="2" fill="url(#sweep)"><animate attributeName="x" values="${x - w * 0.3};${x + w}" dur="1.8s" repeatCount="indefinite"/></rect>`);
  }
  return { svg: parts.join(''), h };
}

function card(P, s, d, { x, y, w, h, center, opacity, level, now }) {
  const color = catColor(P, s.view.cat);
  const parts = [];
  if (center) {
    parts.push(`<rect x="${x + 10}" y="${y + 10}" width="${w - 20}" height="${h - 20}" fill="${color}" opacity="0.28" filter="url(#glow)"/>`);
  }
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${P.panel}" stroke="${center ? color : P.line2}" stroke-opacity="${center ? 0.65 : 1}"/>`);
  parts.push(brackets(x - 1, y - 1, w + 2, h + 2, color, center ? 16 : 12, center ? 2 : 1.4));
  const pad = center ? 24 : 16;
  const bs = center ? 44 : 32;
  parts.push(`<rect x="${x + pad}" y="${y + pad}" width="${bs}" height="${bs}" rx="9" fill="${color}" fill-opacity="0.1" stroke="${color}" stroke-opacity="0.45"/>`);
  if (center && s.status === 'running') {
    parts.push(`<rect x="${x + pad}" y="${y + pad}" width="${bs}" height="${bs}" rx="9" fill="none" stroke="${color}" stroke-width="2"><animate attributeName="opacity" values="0.9;0" dur="1.6s" repeatCount="indefinite"/></rect>`);
  }
  const is = center ? 24 : 18;
  parts.push(icon(s.view.icon, x + pad + (bs - is) / 2, y + pad + (bs - is) / 2, is, color));
  parts.push(text(x + pad + bs + 12, y + pad + (center ? 17 : 13), (CAT_LABEL[s.view.cat] || 'STEP') + (s.side ? ' · HELPER' : ''), { size: center ? 11 : 9.5, color, family: MONO, spacing: 1.8, weight: 600 }));
  parts.push(text(x + pad + bs + 12, y + pad + (center ? 35 : 27), s.time || '', { size: center ? 10.5 : 9, color: P.dim, family: MONO, spacing: 1.2 }));

  const fs = center ? 22 : 15;
  const chars = Math.max(8, Math.floor((w - pad * 2) / (fs * 0.53)));
  const title = textFor(s.view, level);
  const lines = wrap(title, chars, center ? 3 : 2);
  let ty = y + pad + bs + (center ? 36 : 26);
  for (const l of lines) {
    parts.push(text(x + pad, ty, l, { size: fs, weight: center ? 650 : 600, color: P.text }));
    ty += fs * 1.28;
  }
  if (center && level !== 'simple' && s.kind === 'tool') {
    const sub = level === 'vibe' ? s.view.simple : s.view.vibe;
    for (const l of wrap(sub, Math.floor((w - pad * 2) / 7.4), 2)) {
      parts.push(text(x + pad, ty + 4, l, { size: 13.5, color: P.dim }));
      ty += 19;
    }
  }
  const st = statusOf(s, now);
  const fy = y + h - pad + 2;
  parts.push(`<circle cx="${x + pad + 4}" cy="${fy - 4}" r="3.5" fill="${statusFill(P, st.color)}">${s.status === 'running' ? '<animate attributeName="opacity" values="1;0.2;1" dur="1s" repeatCount="indefinite"/>' : ''}</circle>`);
  parts.push(text(x + pad + 14, fy, st.label, { size: center ? 12 : 10.5, color: P.dim }));
  if (center) parts.push(text(x + w - pad, fy, `${d.index} / ${d.total}`, { size: 11, color: P.faint, family: MONO, anchor: 'end', spacing: 1 }));
  return `<g opacity="${opacity}">${parts.join('')}</g>`;
}

function track(P, d, x, y, w) {
  const n = d.seq.length;
  if (!n) return '';
  const gap = 3;
  const bw = Math.max(4, Math.min(10, (w - gap * n) / n));
  const total = n * (bw + gap);
  let cx = x + Math.max(0, (w - total) / 2);
  if (total > w) cx = x + w - total; // keep the newest steps in view
  const parts = [];
  d.seq.forEach((s, i) => {
    const on = i === d.cur;
    const color = catColor(P, s.view.cat);
    if (s.kind === 'prompt') parts.push(`<rect x="${cx - 2}" y="${y - 6}" width="1.5" height="28" fill="${P.line2}"/>`);
    if (s.kind === 'fix') {
      parts.push(`<path d="M${cx} ${y - 2}h${bw + 3}l-3 8l3 8h-${bw + 3}z" fill="${P.cats.fix}"/>`);
    } else {
      const hh = on ? 26 : 16;
      parts.push(`<rect x="${cx}" y="${y + (16 - hh) / 2}" width="${bw}" height="${hh}" rx="1.5" fill="${color}" opacity="${on ? 1 : 0.45}"${on ? ' filter="url(#soft)"' : ''}/>`);
      if (on) parts.push(`<rect x="${cx}" y="${y + (16 - hh) / 2}" width="${bw}" height="${hh}" rx="1.5" fill="${color}"/>`);
    }
    cx += bw + gap;
  });
  return parts.join('');
}

function cardsLayout(P, d, x, y, w, level, now) {
  const H = 236;
  const cw = Math.min(520, w * (w < 520 ? 0.84 : 0.7));
  const parts = [];
  const order = [-2, 2, -1, 1, 0]; // draw the centre last so it sits on top
  for (const off of order) {
    const s = d.seq[d.cur + off];
    if (!s) continue;
    const a = Math.abs(off);
    const scale = off === 0 ? 1 : a === 1 ? 0.74 : 0.6;
    const ww = cw * scale;
    const hh = (off === 0 ? H : H * 0.82) * (off === 0 ? 1 : scale / 0.74 * 0.9);
    const cx = x + w / 2 + Math.sign(off) * (cw * 0.5 + (a === 1 ? ww * 0.18 : cw * 0.4 + ww * 0.25)) - ww / 2;
    const cy = y + (H - hh) / 2;
    parts.push(card(P, s, d, { x: cx, y: cy, w: ww, h: hh, center: off === 0, opacity: off === 0 ? 1 : a === 1 ? 0.55 : 0.25, level, now }));
  }
  return { svg: parts.join(''), h: H };
}

function flowLayout(P, d, x, y, w, level, now) {
  const rows = d.seq.slice(Math.max(0, d.cur - 4), d.cur + 2);
  const nh = 46;
  const gap = 18;
  const parts = [];
  let cy = y;
  const nx = x + 40;
  const nw = Math.min(620, w - 80);
  rows.forEach((s, i) => {
    const isCur = d.seq.indexOf(s) === d.cur;
    const color = catColor(P, s.view.cat);
    if (i > 0) {
      parts.push(`<path d="M${nx + 18} ${cy - gap + 2}V${cy - 4}" stroke="${P.line2}"/><path d="M${nx + 14} ${cy - 8}l4 5l4 -5" fill="none" stroke="${P.line2}"/>`);
    }
    if (s.kind === 'fix') {
      const fx = nx + 70;
      parts.push(`<path d="M${nx + 18} ${cy + nh / 2}H${fx}" stroke="${P.cats.fix}" stroke-dasharray="4 4"/>`);
      parts.push(`<rect x="${fx}" y="${cy}" width="${nw - 70}" height="${nh}" fill="${P.cats.fix}" fill-opacity="0.08" stroke="${P.cats.fix}" stroke-dasharray="5 4"/>`);
      parts.push(icon('flag', fx + 12, cy + 13, 20, P.cats.fix));
      parts.push(text(fx + 42, cy + 19, s.urgent ? 'URGENT FIX LANDED HERE' : 'FIX LANDED HERE', { size: 9.5, color: P.cats.fix, family: MONO, spacing: 1.6 }));
      parts.push(text(fx + 42, cy + 36, wrap(s.text, Math.floor((nw - 130) / 7.3), 1)[0] || '', { size: 13.5, color: P.text }));
    } else {
      if (isCur) parts.push(`<rect x="${nx + 6}" y="${cy + 6}" width="${nw - 12}" height="${nh - 12}" fill="${color}" opacity="0.35" filter="url(#glow)"/>`);
      parts.push(`<rect x="${nx}" y="${cy}" width="${nw}" height="${nh}" fill="${s.kind === 'prompt' ? P.panel2 : P.panel}" stroke="${isCur ? color : P.line}"/>`);
      parts.push(`<rect x="${nx}" y="${cy}" width="3" height="${nh}" fill="${color}"/>`);
      parts.push(icon(s.view.icon, nx + 14, cy + 12, 20, color));
      const st = statusOf(s, now);
      parts.push(text(nx + 44, cy + 21, wrap(textFor(s.view, level), Math.floor((nw - 60) / 7.6), 1)[0] || '', { size: 14, weight: isCur ? 650 : 500, color: P.text }));
      parts.push(`<circle cx="${nx + 48}" cy="${cy + 33}" r="3" fill="${statusFill(P, st.color)}"/>`);
      parts.push(text(nx + 57, cy + 37, st.label || (s.time || ''), { size: 10.5, color: P.dim }));
    }
    cy += nh + gap;
  });
  return { svg: parts.join(''), h: Math.max(120, cy - y - gap) };
}

function timelineLayout(P, d, x, y, w, now) {
  const lanes = [
    ['you', 'YOU'],
    ['tools', 'TOOLS'],
    ['helpers', 'HELPERS'],
    ['fixes', 'FIXES'],
  ];
  const laneOf = (s) => (s.kind === 'prompt' ? 'you' : s.kind === 'fix' ? 'fixes' : s.side ? 'helpers' : 'tools');
  const lh = 40;
  const top = y + 22;
  const left = x + 80;
  const right = x + w - 16;
  // The current turn: from the last prompt, or the last five minutes.
  const lastPrompt = [...d.seq].reverse().find((s) => s.kind === 'prompt');
  const t0 = Math.max(Math.min(...d.seq.map((s) => s.startedAt ?? now)), lastPrompt ? lastPrompt.startedAt : now - 5 * 60_000);
  const t1 = Math.max(now, ...d.seq.map((s) => s.endedAt ?? s.startedAt ?? now));
  const span = Math.max(10_000, t1 - t0);
  const X = (t) => left + ((t - t0) / span) * (right - left);
  const parts = [`<rect x="${x}" y="${y}" width="${w}" height="${22 + lanes.length * lh}" fill="${P.panel}" stroke="${P.line}"/>`];
  for (let i = 0; i <= 4; i++) {
    const t = t0 + (span * i) / 4;
    const tx = X(t);
    const secs = Math.round((t - t0) / 1000);
    parts.push(`<path d="M${tx} ${y + 16}V${y + 22}" stroke="${P.line2}"/>`);
    parts.push(text(tx, y + 13, `+${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`, { size: 9.5, color: P.faint, family: MONO, anchor: i === 4 ? 'end' : i === 0 ? 'start' : 'middle' }));
  }
  lanes.forEach(([, label], i) => {
    parts.push(`<path d="M${x} ${top + i * lh}H${x + w}" stroke="${P.line}"/>`);
    parts.push(text(x + 12, top + i * lh + 24, label, { size: 9.5, color: P.dim, family: MONO, spacing: 1.6 }));
  });
  for (const s of d.seq) {
    if ((s.endedAt ?? s.startedAt ?? now) < t0) continue;
    const lane = lanes.findIndex(([k]) => k === laneOf(s));
    const ly = top + lane * lh + 9;
    const a = X(s.startedAt ?? now);
    const color = catColor(P, s.view.cat);
    if (s.kind === 'fix') {
      parts.push(`<path d="M${a} ${top}V${top + lanes.length * lh}" stroke="${P.cats.fix}" stroke-dasharray="4 4"/>`);
      parts.push(icon('flag', a - 2, ly, 20, P.cats.fix));
    } else if (s.kind === 'prompt') {
      parts.push(`<rect x="${a - 2}" y="${ly}" width="4" height="22" fill="${color}"/>`);
    } else {
      const b = X(s.endedAt ?? now);
      parts.push(`<rect x="${a}" y="${ly}" width="${Math.max(6, b - a)}" height="22" rx="3" fill="${color}" fill-opacity="0.35" stroke="${s.status === 'error' ? P.error : color}">${s.status === 'running' ? '<animate attributeName="opacity" values="1;0.35;1" dur="1s" repeatCount="indefinite"/>' : ''}</rect>`);
    }
  }
  if (d.live) parts.push(`<path d="M${X(now)} ${y}V${top + lanes.length * lh}" stroke="${P.accent}" stroke-width="1.5"/>`);
  const cur = d.seq[d.cur];
  if (cur) parts.push(text(x, top + lanes.length * lh + 26, textFor(cur.view, 'vibe'), { size: 13, color: P.text }));
  return { svg: parts.join(''), h: 22 + lanes.length * lh + 34 };
}

/**
 * @param {object} d  seq (steps with .view), cur (index), live, nowText,
 *   nowLabel, nowIcon, clock, meta, index, total
 */
export function sceneSvg(d, { width = 760, level = 'simple', layout = 'cards', theme = 'claude', now = Date.now() } = {}) {
  const P = PALETTES[theme] || PALETTES.claude;
  const W = Math.round(Math.max(360, Math.min(1100, width)));
  const pad = 16;
  const body = [];
  let y = pad;
  const strip = nowStrip(P, d, pad, y, W - pad * 2);
  body.push(strip.svg);
  y += strip.h + 22;
  if (!d.seq.length) {
    body.push(text(W / 2, y + 60, 'No steps yet. They appear here as Claude works.', { size: 14, color: P.dim, anchor: 'middle' }));
    y += 110;
  } else {
    const part =
      layout === 'flow' ? flowLayout(P, d, pad, y, W - pad * 2, level, now)
      : layout === 'timeline' ? timelineLayout(P, d, pad, y, W - pad * 2, now)
      : cardsLayout(P, d, pad, y, W - pad * 2, level, now);
    body.push(part.svg);
    y += part.h + 22;
    body.push(track(P, d, pad, y, W - pad * 2));
    y += 30;
  }
  const H = Math.round(y + pad);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs(P, W, H)}<g clip-path="url(#frame)">${background(P, W, H)}${body.join('')}</g></svg>`;
}
