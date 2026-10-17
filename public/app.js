// visualizar client: live session view with Cards, Flow and Timeline layouts,
// three detail levels, and the Mistakes panel.

import { icon } from '/icons.js';

const $ = (s, r = document) => r.querySelector(s);
const TOKEN = $('meta[name="token"]').content;
const store = {
  get(k, d) {
    try { return localStorage.getItem('visualizar.' + k) ?? d; } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem('visualizar.' + k, v); } catch {}
  },
};

const S = {
  view: store.get('view', 'cards'),
  level: store.get('level', 'simple'),
  theme: store.get('theme', 'claude'),
  // '' = newest session in this folder; the CLI's --session pins one.
  session: new URLSearchParams(location.search).get('session') || $('meta[name="pinned"]').content || '',
  steps: new Map(),
  order: [],
  fixes: [],
  meta: {},
  activity: null,
  sessions: [],
  cwd: '',
  follow: true,
  sel: null,
  detail: false,
  mistakes: false,
  zoom: Number(store.get('zoom', 1)) || 1,
  es: null,
  connected: false,
};

const CAT_LABEL = {
  you: 'You', say: 'Claude', read: 'Read', write: 'Write', run: 'Run', test: 'Test', search: 'Search',
  web: 'Web', plan: 'Plan', agent: 'Helper', ask: 'Question', tool: 'Tool', fix: 'Your fix',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ms = (ts) => (ts ? Date.parse(ts) : NaN);

function dur(a, b) {
  const d = Math.max(0, Math.round(((b ?? Date.now()) - a) / 1000));
  if (!Number.isFinite(d)) return '';
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m ${String(d % 60).padStart(2, '0')}s`;
  return `${Math.floor(d / 3600)}h ${String(Math.floor((d % 3600) / 60)).padStart(2, '0')}m`;
}
function clock(a, b = Date.now()) {
  const d = Math.max(0, Math.round((b - a) / 1000));
  const h = Math.floor(d / 3600);
  const m = String(Math.floor((d % 3600) / 60)).padStart(2, '0');
  const s = String(d % 60).padStart(2, '0');
  return h ? `T+${h}:${m}:${s}` : `T+${m}:${s}`;
}
const hhmm = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const ago = (t) => {
  const d = Math.round((Date.now() - t) / 60000);
  return d < 1 ? 'now' : d < 60 ? `${d}m ago` : d < 1440 ? `${Math.round(d / 60)}h ago` : `${Math.round(d / 1440)}d ago`;
};

// ---------------------------------------------------------------------------
// Data

function fixView(f) {
  const doing = f.doing ? f.doing.replace(/^about to run/, 'was about to run') : '';
  return {
    icon: 'flag',
    cat: 'fix',
    simple: `You steered: ${f.text}`,
    vibe: `${f.urgency === 'urgent' ? 'Urgent fix' : 'Fix'}: ${f.text}${doing ? ` — while it ${doing}` : ''}`,
    eng: {
      title: `fix · ${f.urgency} · ${f.via || 'not delivered'}`,
      body: JSON.stringify({ text: f.text, urgency: f.urgency, queued: f.queuedAt, delivered: f.deliveredAt, via: f.via, doing: f.doing }, null, 2),
      lang: 'json',
    },
  };
}

/** Steps plus this session's fixes, in time order. */
function sequence() {
  const steps = S.order.map((id) => S.steps.get(id)).filter(Boolean);
  const sid = S.meta.sessionId;
  const first = ms(steps[0]?.ts);
  const fixes = S.fixes
    .filter((f) => !f.hidden && f.ts)
    .filter((f) => (f.sessionId ? f.sessionId === sid : ms(f.ts) >= first))
    .map((f) => ({ ...f, id: 'fix-' + f.id, fixId: f.id, view: fixView(f) }))
    .sort((a, b) => ms(a.ts) - ms(b.ts));
  if (!fixes.length) return steps;
  const out = [];
  let k = 0;
  for (const s of steps) {
    while (k < fixes.length && ms(fixes[k].ts) < ms(s.ts)) out.push(fixes[k++]);
    out.push(s);
  }
  while (k < fixes.length) out.push(fixes[k++]);
  return out;
}

/** The step Claude is on right now, or the last one. */
function currentId(seq) {
  const a = S.activity;
  if (a?.kind === 'tool' && a.stepId && S.steps.has(a.stepId)) return a.stepId;
  return seq.at(-1)?.id ?? null;
}

const isLive = () => {
  const a = S.activity;
  if (!a || a.kind === 'idle') return false;
  return Date.now() - ms(a.lastEntryTs) < 5 * 60 * 1000;
};

function textOf(s, level = S.level) {
  const v = s.view;
  if (level === 'simple') return v.simple;
  if (level === 'vibe' || s.kind === 'prompt' || s.kind === 'message' || s.kind === 'command') return v.vibe;
  return v.eng.title;
}

function statusOf(s) {
  if (s.kind === 'fix') return { cls: 'blocked', label: s.deliveredAt ? `delivered ${hhmm(s.deliveredAt)}` : 'logged' };
  if (s.kind !== 'tool') return { cls: 'done', label: hhmm(s.ts) };
  if (s.status === 'running') return { cls: 'running', label: `working · ${dur(ms(s.ts))}` };
  if (s.blockedByFix) return { cls: 'blocked', label: 'stopped by your fix' };
  if (s.status === 'error') return { cls: 'error', label: `snag · ${dur(ms(s.ts), ms(s.endTs))}` };
  return { cls: 'done', label: `done · ${dur(ms(s.ts), ms(s.endTs))}` };
}

function codeBlock(text, lang) {
  if (!text) return '';
  if (lang === 'diff') {
    return `<pre>${text.split('\n').map((l) => `<span class="${l.startsWith('+ ') ? 'add' : l.startsWith('- ') ? 'del' : ''}">${esc(l)}</span>`).join('\n')}</pre>`;
  }
  return `<pre>${esc(text)}</pre>`;
}

function engBody(s, max = 1200) {
  const e = s.view.eng;
  const cut = (t) => (t && t.length > max ? t.slice(0, max) + '\n…' : t);
  let html = '';
  if (e.body && e.body !== e.title && s.kind !== 'prompt' && s.kind !== 'message') html += codeBlock(cut(e.body), e.lang);
  if (s.kind === 'prompt' || s.kind === 'message') html += `<pre>${esc(cut(s.text))}</pre>`;
  if (e.output) html += `<pre class="out">${esc(cut(e.output))}</pre>`;
  if (e.stderr) html += `<pre class="out">${esc(cut(e.stderr))}</pre>`;
  return html;
}

// ---------------------------------------------------------------------------
// Connection

function connect() {
  S.es?.close();
  S.steps.clear();
  S.order = [];
  S.sel = null;
  S.follow = true;
  const q = S.session ? `?session=${encodeURIComponent(S.session)}` : '';
  const es = new EventSource('/events' + q);
  S.es = es;
  es.addEventListener('snapshot', (e) => {
    const d = JSON.parse(e.data);
    S.steps.clear();
    S.order = [];
    for (const s of d.steps) upsert(s);
    S.meta = d.meta;
    S.activity = d.activity;
    S.fixes = d.fixes;
    S.connected = true;
    // A prefix from the URL or --session: show the full id in the picker.
    if (S.session && d.session.id !== S.session && d.session.id.startsWith(S.session)) S.session = d.session.id;
    renderSessions();
    render();
  });
  es.addEventListener('steps', (e) => {
    for (const s of JSON.parse(e.data).steps) upsert(s);
    schedule();
  });
  es.addEventListener('activity', (e) => {
    S.activity = JSON.parse(e.data);
    schedule();
  });
  es.addEventListener('meta', (e) => {
    S.meta = JSON.parse(e.data);
    schedule();
  });
  es.addEventListener('fixes', (e) => {
    S.fixes = JSON.parse(e.data).fixes;
    schedule();
  });
  es.onerror = () => {
    S.connected = false;
    renderNow();
  };
}

function upsert(s) {
  if (!S.steps.has(s.id)) S.order.push(s.id);
  S.steps.set(s.id, s);
}

let pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    render();
  });
}

async function loadSessions() {
  try {
    const r = await fetch('/api/sessions');
    const d = await r.json();
    S.sessions = d.sessions;
    S.cwd = d.cwd;
    renderSessions();
    // In auto mode, follow a newer session that starts in this folder.
    if (!S.session && S.meta.sessionId) {
      const key = S.cwd.replace(/[^a-zA-Z0-9]/g, '-');
      const newest = S.sessions.find((x) => x.project === key) || S.sessions[0];
      if (newest && newest.id !== S.meta.sessionId && newest.mtimeMs > Date.now() - 10 * 60 * 1000) connect();
    }
  } catch {}
}

function renderSessions() {
  const sel = $('#session');
  const opts = [`<option value="">Newest in this folder (auto)</option>`];
  const listed = S.sessions.some((x) => x.id === S.session);
  if (S.session && !listed) opts.push(`<option value="${esc(S.session)}">${esc(S.meta.title || S.session.slice(0, 8))}</option>`);
  for (const x of S.sessions) {
    const where = (x.cwd || x.project).split('/').filter(Boolean).pop();
    opts.push(`<option value="${esc(x.id)}">${esc(x.title.slice(0, 60))} · ${esc(where)} · ${ago(x.mtimeMs)}</option>`);
  }
  if (sel.dataset.sig !== opts.join('')) {
    sel.innerHTML = opts.join('');
    sel.dataset.sig = opts.join('');
  }
  sel.value = S.session;
}

// ---------------------------------------------------------------------------
// NOW strip

function renderNow() {
  const a = S.activity;
  const now = $('#now');
  const live = isLive();
  now.classList.toggle('live', live);
  now.classList.toggle('idle', !live);
  let ico = 'pause';
  let label = 'IDLE';
  let text = 'Done — waiting for you';
  if (!S.connected) {
    label = 'LINK';
    text = 'Connecting to the session…';
  } else if (a && a.kind !== 'idle') {
    const quiet = Date.now() - ms(a.lastEntryTs) > 5 * 60 * 1000;
    if (a.kind === 'tool' && S.steps.get(a.stepId)) {
      const s = S.steps.get(a.stepId);
      ico = s.view.icon;
      text = textOf(s) + '…';
      label = 'NOW · ' + (CAT_LABEL[s.view.cat] || 'Working').toUpperCase();
    } else if (a.kind === 'writing') {
      ico = 'chat';
      text = 'Writing a reply…';
      label = 'NOW';
    } else {
      ico = 'think';
      text = S.level === 'simple' ? 'Thinking…' : 'Thinking about the next step…';
      label = 'NOW';
    }
    if (quiet) {
      label = 'QUIET';
      text += ` (nothing new for ${dur(ms(a.lastEntryTs))})`;
    }
  }
  $('#now-ico').innerHTML = icon(ico);
  $('#now-label').textContent = label;
  $('#now-text').textContent = text;
  const since = a && a.kind !== 'idle' ? ms(a.since) : ms(a?.lastEntryTs);
  $('#now-clock').textContent = !Number.isFinite(since) ? 'T+00:00' : live ? clock(since) : `${dur(since)} ago`;
  const steps = S.order.length;
  const model = (S.meta.model || '').replace(/^claude-/, '');
  $('#now-meta').textContent = [model, S.meta.gitBranch && S.meta.gitBranch !== 'HEAD' ? S.meta.gitBranch : '', `${steps} steps`].filter(Boolean).join(' · ');
  document.title = live ? `● ${text} — visualizar` : 'visualizar';
}

// ---------------------------------------------------------------------------
// Views

function selected(seq) {
  if (S.follow || !S.sel || !seq.some((s) => s.id === S.sel)) return currentId(seq);
  return S.sel;
}

function select(id, { open = false } = {}) {
  S.sel = id;
  const seq = sequence();
  S.follow = id === currentId(seq);
  if (open) S.detail = true;
  render();
}

function renderCards(seq) {
  const stage = $('#stage');
  if (!stage.querySelector('.cards')) stage.innerHTML = `<div class="cards"><div class="deck"></div><div class="track"></div></div>`;
  const deck = stage.querySelector('.deck');
  const idx = Math.max(0, seq.findIndex((s) => s.id === selected(seq)));
  const width = Math.min(560, window.innerWidth * 0.78);
  const html = [];
  for (let d = -3; d <= 3; d++) {
    const s = seq[idx + d];
    if (!s) continue;
    const a = Math.abs(d);
    const scale = d === 0 ? 1 : 0.74 - (a - 1) * 0.08;
    const x = d === 0 ? 0 : Math.sign(d) * (width * 0.58 + (a - 1) * width * 0.3);
    const st = statusOf(s);
    const showBody = d === 0 && S.level === 'engineer';
    const secondary = d === 0 && S.level === 'vibe' && s.kind === 'tool' ? `<div class="sub">${esc(s.view.simple)}</div>` : '';
    html.push(`
      <article class="card hud ${d === 0 ? 'center' : 'side'} ${s.status === 'running' ? 'running' : ''}" data-cat="${s.view.cat}" data-id="${esc(s.id)}"
        style="transform: translate(-50%,-50%) translateX(${x}px) scale(${scale}) rotateY(${-d * 6}deg); opacity:${d === 0 ? 1 : Math.max(0.18, 0.62 - (a - 1) * 0.2)}; z-index:${10 - a}; filter:${d === 0 ? 'none' : `blur(${(a - 1) * 0.6}px)`}">
        <div class="head">
          <div class="badge">${icon(s.view.icon)}</div>
          <div><div class="micro kind">${esc(CAT_LABEL[s.view.cat] || s.view.cat)}${s.side ? ' · helper' : ''}${s.view.ai ? ' · ai' : ''}</div>
          <div class="micro">${esc(hhmm(s.ts))}</div></div>
        </div>
        <div class="title">${esc(textOf(s))}</div>
        ${secondary}
        ${showBody ? engBody(s, 900) : ''}
        <div class="foot"><span class="status ${st.cls}"><i></i>${esc(st.label)}</span>${d === 0 ? `<span>${idx + 1} / ${seq.length}</span>` : ''}</div>
      </article>`);
  }
  deck.innerHTML = html.join('') || `<div class="empty">No steps yet.</div>`;

  const track = stage.querySelector('.track');
  const cur = seq[idx]?.id;
  track.innerHTML = seq
    .map((s) => {
      const turn = s.kind === 'prompt' ? '<span class="dot turn"></span>' : '';
      const cls = s.kind === 'fix' ? 'dot fix' : 'dot';
      return `${turn}<button class="${cls} ${s.id === cur ? 'on' : ''}" data-cat="${s.view.cat}" data-id="${esc(s.id)}" title="${esc(s.view.simple)}"></button>`;
    })
    .join('');
  const on = track.querySelector('.dot.on');
  if (on) {
    const left = on.offsetLeft - track.clientWidth / 2;
    if (Math.abs(track.scrollLeft - left) > track.clientWidth / 3) track.scrollLeft = left;
  }
}

function renderFlow(seq) {
  const stage = $('#stage');
  let box = stage.querySelector('.flow');
  const wasAtBottom = box ? box.scrollTop + box.clientHeight >= box.scrollHeight - 40 : true;
  if (!box) {
    stage.innerHTML = `<div class="flow"><div class="flow-inner"></div></div>`;
    box = stage.querySelector('.flow');
  }
  const cur = selected(seq);
  const parts = [];
  for (const s of seq) {
    const v = s.view;
    if (s.kind === 'fix') {
      parts.push(`<div class="fixnode" data-id="${esc(s.id)}">${icon('flag')}<div class="t"><div class="micro">${s.urgency === 'urgent' ? 'Urgent fix landed here' : 'Fix landed here'}</div>${esc(S.level === 'simple' ? s.text : textOf(s))}</div></div>`);
      continue;
    }
    const st = statusOf(s);
    const body = S.level === 'engineer' && s.kind === 'tool' ? engBody(s, 500) : '';
    parts.push(`<div class="node ${s.kind === 'prompt' ? 'prompt' : ''} ${s.status === 'running' ? 'running' : ''} ${s.side ? 'side' : ''} ${s.id === cur && !S.follow ? 'sel' : ''}" data-cat="${v.cat}" data-id="${esc(s.id)}">
      ${icon(v.icon)}<div class="t">${esc(textOf(s))}<small><span class="status ${st.cls}"><i></i>${esc(st.label)}</span></small>${body}</div></div>`);
  }
  box.firstElementChild.innerHTML = parts.join('') || `<div class="empty">No steps yet.</div>`;
  if (S.follow && wasAtBottom) box.scrollTop = box.scrollHeight;
}

const GAP_S = 45;
const GAP_PX = 22;
const LANES = [
  { key: 'you', label: 'You' },
  { key: 'claude', label: 'Claude' },
  { key: 'tools', label: 'Tools' },
  { key: 'helpers', label: 'Helpers' },
  { key: 'fixes', label: 'Fixes' },
];

function laneOf(s) {
  if (s.kind === 'prompt' || s.kind === 'command') return 'you';
  if (s.kind === 'message') return 'claude';
  if (s.kind === 'fix') return 'fixes';
  return s.side ? 'helpers' : 'tools';
}

function renderTimeline(seq) {
  const stage = $('#stage');
  let root = stage.querySelector('.timeline');
  if (!root) {
    stage.innerHTML = `<div class="timeline">
      <div class="tl-tools"><span class="micro">Zoom</span>
        <div class="seg small"><button data-zoom="-1">−</button><button data-zoom="1">+</button></div>
        <span class="micro" id="tl-note">Long pauses are squeezed</span></div>
      <div class="tl-scroll"><div class="tl-canvas"></div></div></div>`;
    root = stage.querySelector('.timeline');
  }
  const scroll = root.querySelector('.tl-scroll');
  const canvas = root.querySelector('.tl-canvas');
  const wasAtEnd = scroll.scrollLeft + scroll.clientWidth >= scroll.scrollWidth - 60;
  const pps = 6 * S.zoom; // pixels per second
  const now = Date.now();

  // Time -> x with long gaps squeezed to GAP_PX.
  const times = [];
  for (const s of seq) {
    const a = ms(s.ts);
    if (Number.isFinite(a)) times.push(a);
    const b = s.kind === 'tool' ? (s.endTs ? ms(s.endTs) : now) : NaN;
    if (Number.isFinite(b)) times.push(b);
  }
  if (isLive()) times.push(now);
  times.sort((x, y) => x - y);
  const pts = [];
  const gaps = [];
  let x = 90;
  for (let i = 0; i < times.length; i++) {
    if (i > 0) {
      const dt = (times[i] - times[i - 1]) / 1000;
      if (dt > GAP_S) {
        gaps.push(x);
        x += GAP_PX;
      } else x += dt * pps;
    }
    pts.push([times[i], x]);
  }
  const X = (t) => {
    if (!pts.length) return 90;
    let lo = 0;
    let hi = pts.length - 1;
    if (t <= pts[0][0]) return pts[0][1];
    if (t >= pts[hi][0]) return pts[hi][1];
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (pts[m][0] <= t) lo = m;
      else hi = m;
    }
    const [t0, x0] = pts[lo];
    const [t1, x1] = pts[hi];
    return t1 === t0 ? x0 : x0 + ((t - t0) / (t1 - t0)) * (x1 - x0);
  };

  const LANE_H = 38;
  const TOP = 24;
  const width = x + 160;
  const height = TOP + LANES.length * LANE_H + 10;
  const html = [`<div class="axis" style="width:${width}px">`];
  let lastLabel = -1e9;
  for (const [t, px] of pts) {
    if (px - lastLabel < 110) continue;
    lastLabel = px;
    html.push(`<span style="left:${px}px">${hhmm(new Date(t).toISOString())}</span>`);
  }
  html.push('</div>');
  LANES.forEach((l, i) => {
    html.push(`<div class="lane" style="top:${TOP + i * LANE_H}px;height:${LANE_H}px;width:${width}px"><span class="lane-label micro">${l.label}</span></div>`);
  });
  for (const g of gaps) html.push(`<div class="gap" style="left:${g}px"></div>`);
  const cur = selected(seq);
  for (const s of seq) {
    const lane = LANES.findIndex((l) => l.key === laneOf(s));
    const a = X(ms(s.ts));
    const top = TOP + lane * LANE_H + 8;
    if (s.kind === 'fix') {
      html.push(`<div class="fixline" style="left:${a}px"></div>`);
      html.push(`<div class="fixflag" style="left:${a}px;top:${top - 2}px" data-id="${esc(s.id)}" data-cat="fix">${icon('flag')}${esc(s.text.slice(0, 28))}</div>`);
      continue;
    }
    if (s.kind === 'tool') {
      const b = X(s.endTs ? ms(s.endTs) : now);
      const w = Math.max(6, b - a);
      html.push(`<div class="ev ${s.status === 'running' ? 'running' : ''} ${s.status === 'error' ? 'err' : ''} ${s.id === cur && !S.follow ? 'sel' : ''}" data-cat="${s.view.cat}" data-id="${esc(s.id)}" style="left:${a}px;top:${top}px;width:${w}px"></div>`);
    } else {
      html.push(`<div class="ev tick ${s.id === cur && !S.follow ? 'sel' : ''}" data-cat="${s.view.cat}" data-id="${esc(s.id)}" style="left:${a}px;top:${top}px"></div>`);
    }
  }
  if (isLive()) html.push(`<div class="nowline" style="left:${X(now)}px"></div>`);
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  canvas.innerHTML = html.join('');
  if (S.follow && wasAtEnd) scroll.scrollLeft = scroll.scrollWidth;
}

// ---------------------------------------------------------------------------
// Detail drawer and Mistakes panel

function renderDetail(seq) {
  const el = $('#detail');
  const s = S.detail ? seq.find((x) => x.id === S.sel) : null;
  if (!s) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  const st = statusOf(s);
  let body = '';
  if (s.kind === 'fix') {
    body = `<p>${esc(s.text)}</p>${s.note ? `<p class="micro">Note</p><p>${esc(s.note)}</p>` : ''}
      <p class="micro">${esc(s.urgency)} · ${s.via ? 'delivered via ' + esc(s.via) : 'not delivered'}${s.doing ? ' · ' + esc(s.doing) : ''}</p>`;
    if (S.level === 'engineer') body += codeBlock(s.view.eng.body, 'json');
  } else if (S.level === 'engineer') {
    body = engBody(s, 20000);
  } else {
    body = `<p>${esc(S.level === 'simple' ? s.view.vibe : s.view.simple)}</p>${s.kind === 'prompt' || s.kind === 'message' ? `<pre>${esc(s.text)}</pre>` : ''}`;
  }
  el.innerHTML = `<button class="x" data-close="detail" aria-label="Close">${icon('close')}</button>
    <h3 data-cat="${s.view.cat}"><span style="color:var(--c)">${icon(s.view.icon)}</span>${esc(textOf(s))}</h3>
    <div class="micro"><span class="status ${st.cls}"><i></i>${esc(st.label)}</span> · ${esc(hhmm(s.ts))}${s.name ? ' · ' + esc(s.name) : ''}</div>
    ${body}`;
}

let editing = false;
function renderMistakes(seq) {
  const el = $('#mistakes');
  $('#mistakes-count').textContent = S.fixes.filter((f) => !f.hidden).length;
  if (!S.mistakes) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  if (editing) return; // don't clobber what the user is typing
  const inSeq = new Set(seq.map((s) => s.fixId).filter(Boolean));
  const project = S.meta.cwd || '';
  const list = [...S.fixes].reverse();
  el.innerHTML = `<button class="x" data-close="mistakes" aria-label="Close">${icon('close')}</button>
    <h2>${icon('flag')} MISTAKES</h2>
    <div class="micro">${esc(project)} · .steer/fixes.jsonl</div>
    ${list.length ? '' : `<p class="empty" style="height:auto;margin-top:24px">No fixes logged for this project yet. Fixes you send with <code>inject</code> show up here.</p>`}
    ${list
      .map(
        (f) => `<div class="mistake ${f.hidden ? 'hidden-fix' : ''}" data-fix="${f.id}">
      <div class="row"><span class="pill ${f.urgency}">${f.urgency}</span><span class="micro">${esc(new Date(f.ts || f.queuedAt).toLocaleString())}${f.sessionId === S.meta.sessionId ? ' · this session' : ''}${f.edited ? ' · edited' : ''}</span></div>
      <textarea class="text" aria-label="Fix text">${esc(f.text)}</textarea>
      <textarea class="note" placeholder="Note: what went wrong, what to remember next time" aria-label="Note">${esc(f.note)}</textarea>
      ${f.doing ? `<div class="micro" style="margin-top:6px">${esc(f.doing)}</div>` : ''}
      <div class="acts"><button class="save" data-act="save">Save</button><button data-act="hide">${f.hidden ? 'Unhide' : 'Hide'}</button>${inSeq.has(f.id) ? '<button data-act="jump">Show on timeline</button>' : ''}</div>
    </div>`,
      )
      .join('')}`;
}

async function saveFix(id, patch) {
  const r = await fetch('/api/mistakes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-token': TOKEN },
    body: JSON.stringify({ session: S.meta.sessionId, id, ...patch }),
  });
  if (!r.ok) alert('Could not save: ' + (await r.text()));
}

// ---------------------------------------------------------------------------

function render() {
  document.documentElement.dataset.theme = S.theme;
  for (const b of document.querySelectorAll('#view-seg button')) b.classList.toggle('on', b.dataset.view === S.view);
  for (const b of document.querySelectorAll('#level-seg button')) b.classList.toggle('on', b.dataset.level === S.level);
  for (const b of document.querySelectorAll('#theme-seg button')) b.classList.toggle('on', b.dataset.theme === S.theme);
  const seq = sequence();
  renderNow();
  if (S.view === 'flow') renderFlow(seq);
  else if (S.view === 'timeline') renderTimeline(seq);
  else renderCards(seq);
  renderDetail(seq);
  renderMistakes(seq);
  $('#jump').classList.toggle('hidden', S.follow);
}

// ---------------------------------------------------------------------------
// Events

$('#mistakes-ico').innerHTML = icon('flag');

document.addEventListener('click', (e) => {
  const t = e.target.closest('button, [data-id], [data-close]');
  if (!t) return;
  if (t.dataset.view) {
    S.view = t.dataset.view;
    store.set('view', S.view);
    $('#stage').innerHTML = '';
    return render();
  }
  if (t.dataset.level) {
    S.level = t.dataset.level;
    store.set('level', S.level);
    return render();
  }
  if (t.dataset.theme) {
    S.theme = t.dataset.theme;
    store.set('theme', S.theme);
    return render();
  }
  if (t.dataset.zoom) {
    S.zoom = Math.min(16, Math.max(0.25, S.zoom * (t.dataset.zoom === '1' ? 1.6 : 1 / 1.6)));
    store.set('zoom', S.zoom);
    return render();
  }
  if (t.dataset.close) {
    if (t.dataset.close === 'detail') S.detail = false;
    else S.mistakes = false;
    editing = false;
    return render();
  }
  if (t.id === 'mistakes-btn') {
    S.mistakes = !S.mistakes;
    return render();
  }
  if (t.id === 'jump') {
    S.follow = true;
    S.sel = null;
    return render();
  }
  if (t.dataset.act) {
    const card = t.closest('[data-fix]');
    const id = card.dataset.fix;
    const fix = S.fixes.find((f) => f.id === id);
    if (t.dataset.act === 'save') {
      editing = false;
      saveFix(id, { text: card.querySelector('.text').value, note: card.querySelector('.note').value });
    } else if (t.dataset.act === 'hide') {
      editing = false;
      saveFix(id, { hidden: !fix.hidden });
    } else if (t.dataset.act === 'jump') {
      S.mistakes = false;
      editing = false;
      select('fix-' + id, { open: true });
    }
    return;
  }
  if (t.dataset.id) {
    // Cards: a side card or a track dot moves it to the centre; the centre card opens its detail.
    select(t.dataset.id, { open: S.view !== 'cards' || t.classList.contains('center') });
  }
});

$('#mistakes').addEventListener('input', () => (editing = true));

$('#session').addEventListener('change', (e) => {
  S.session = e.target.value;
  const u = new URL(location.href);
  if (S.session) u.searchParams.set('session', S.session);
  else u.searchParams.delete('session');
  history.replaceState(null, '', u);
  S.detail = false;
  connect();
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches('textarea, input, select')) return;
  if (e.key === 'Escape') {
    S.detail = false;
    S.mistakes = false;
    editing = false;
    return render();
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const seq = sequence();
    const i = seq.findIndex((s) => s.id === selected(seq));
    const j = Math.min(seq.length - 1, Math.max(0, i + (e.key === 'ArrowLeft' ? -1 : 1)));
    if (seq[j]) select(seq[j].id);
    e.preventDefault();
  }
  if (e.key === 'Enter' && S.view === 'cards') {
    S.sel = selected(sequence());
    S.detail = !S.detail;
    render();
  }
});

// Tooltips on the timeline.
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest('.ev, .fixflag');
  const tip = $('#tip');
  if (!t) return tip.classList.add('hidden');
  const s = sequence().find((x) => x.id === t.dataset.id);
  if (!s) return;
  tip.innerHTML = `<b>${esc(textOf(s))}</b><div class="micro">${esc(statusOf(s).label)}</div>`;
  tip.classList.remove('hidden');
  const r = t.getBoundingClientRect();
  tip.style.left = Math.min(window.innerWidth - 370, r.left) + 'px';
  tip.style.top = r.bottom + 8 + 'px';
});

window.addEventListener('resize', schedule);
setInterval(() => {
  renderNow();
  if (isLive() && S.view !== 'flow') schedule(); // running durations and the now line
}, 1000);
setInterval(loadSessions, 10000);

render();
loadSessions();
connect();
