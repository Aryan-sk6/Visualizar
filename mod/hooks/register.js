// visualizar, inside Claude Code: a HUD pane showing what the agent is doing.
// Read-only: it listens to events and reads .steer/fixes.jsonl, and writes nothing.
//
// Desktop and VS Code draw the HUD as one SVG (scene.js) that mirrors the
// browser version. The terminal draws the same layout with boxes and a
// coloured cell track.
import {
  LAYOUT_NAMES, LEVEL_NAMES, THEME_NAMES, PALETTES, catColor, startStep, pushStep, finishStep, viewOf, textFor,
  clipTo, elapsed, stepTime, parseFixes, scanCells, toBase64, MAX_STEPS,
} from './hud.js'
import { sceneSvg } from './scene.js'

const PANE = 'visualizar'

// Module variables: a hot reload resets them, which only costs the step history.
let steps = []
let level = 'simple'
let layout = 'cards'
let theme = 'claude'
let fixes = []
let cwd = ''
let sessionId = null
let turnStart = null
let lastActivity = null
let busy = false
let isOpen = false
let tick = 0

const CAT_LABEL = {
  you: 'YOU', say: 'CLAUDE', read: 'READ', write: 'WRITE', run: 'RUN', test: 'TEST', search: 'SEARCH',
  web: 'WEB', plan: 'PLAN', agent: 'HELPER', ask: 'QUESTION', tool: 'TOOL', fix: 'YOUR FIX',
}
// Terminal stand-ins for the icons.
const GLYPH = {
  user: '●', slash: '/', chat: '❝', read: '◉', create: '✚', edit: '✎', terminal: '❯', test: '⚗', package: '⬡',
  git: '⎇', globe: '◍', search: '⌕', folder: '▤', agent: '◈', list: '☰', question: '?', spark: '✦', plug: '⏻',
  flag: '⚑', think: '◌', pause: '◼',
}

function redraw($) {
  $.ui.invalidate('ui.render')
}

async function loadFixes($) {
  if (!cwd) return
  try {
    fixes = parseFixes(await $.fs.read(cwd + '/.steer/fixes.jsonl'))
  } catch {
    fixes = []
  }
}

const clockText = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = String(Math.floor(s / 60) % 60).padStart(2, '0')
  const h = Math.floor(s / 3600)
  return `T+${h ? h + ':' : ''}${m}:${String(s % 60).padStart(2, '0')}`
}
const hhmmss = (ms) => {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

/** Steps plus this session's fixes, in time order, each with its view. */
function sequence() {
  const first = steps[0]?.startedAt ?? Infinity
  const mine = fixes
    .filter((f) => f.at !== null && (f.sessionId ? f.sessionId === sessionId : f.at >= first))
    .map((f, i) => ({
      id: 'fix' + i, kind: 'fix', text: f.text, urgent: f.urgent, startedAt: f.at, deliveredAt: f.deliveredAt,
      view: {
        icon: 'flag', cat: 'fix',
        simple: `You steered: ${f.text}`,
        vibe: `${f.urgent ? 'Urgent fix' : 'Fix'}: ${f.text}${f.doing ? ` (while it ${f.doing.replace(/^about to run/, 'was about to run')})` : ''}`,
        eng: { title: `fix · ${f.urgent ? 'urgent' : 'normal'} · ${f.deliveredAt ? 'delivered' : 'logged'}` },
      },
    }))
  const all = [...steps.map((s) => ({ ...s, view: viewOf(s, cwd) })), ...mine]
  all.sort((a, b) => a.startedAt - b.startedAt)
  for (const s of all) s.time = hhmmss(s.startedAt)
  return all
}

/** What the NOW strip says. */
function nowState(seq, now) {
  const running = [...seq].reverse().find((s) => s.kind === 'tool' && s.status === 'running' && !s.side)
  if (running) {
    return {
      live: true, nowIcon: running.view.icon, nowLabel: `NOW · ${CAT_LABEL[running.view.cat] || 'TOOL'}`,
      nowText: textFor(running.view, level) + '…', clock: clockText(now - running.startedAt), cur: seq.indexOf(running),
    }
  }
  const cur = seq.length - 1
  if (busy) {
    return { live: true, nowIcon: 'think', nowLabel: 'NOW', nowText: level === 'simple' ? 'Thinking…' : 'Thinking about the next step…', clock: clockText(now - (lastActivity ?? turnStart ?? now)), cur }
  }
  return { live: false, nowIcon: 'pause', nowLabel: 'IDLE', nowText: 'Done — waiting for you', clock: turnStart ? `${elapsed(now - turnStart)} ago` : '', cur }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'visualizar',
      description: 'Open the live HUD pane of what Claude is doing',
      immediate: true,
    })
    try {
      cwd = await $.session.cwd()
    } catch {
      cwd = ''
    }
    try {
      sessionId = await $.session.id()
    } catch {
      sessionId = null
    }
    // Keep the clock and the terminal scan line moving while the pane is open.
    $.clock.every(500, () => {
      if (!isOpen) return
      tick++
      if (tick % 4 === 0) void loadFixes($).then(() => redraw($))
      else if (busy) redraw($)
    })
    return next(e)
  })

  on('command.run', { command: 'visualizar' }, async ($) => {
    if (isOpen) {
      await $.ui.close({ id: PANE })
      isOpen = false
      return { text: 'visualizar closed.' }
    }
    await loadFixes($)
    const opened = await $.ui.open({ id: PANE, title: 'visualizar', focus: true })
    isOpen = opened.isPlaced
    return { text: opened.isPlaced ? 'visualizar open. 1/2/3 layout · s/v/e detail · c/x theme · q close.' : 'visualizar is waiting for a wider window.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) isOpen = false
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const text = typeof e.text === 'string' ? e.text.trim() : ''
    if (text && !text.startsWith('/')) {
      const now = await $.clock.now()
      steps = pushStep(steps, { id: 'p' + now, kind: 'prompt', text, status: 'done', startedAt: now, endedAt: now })
      redraw($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      turnStart = await $.clock.now()
      lastActivity = turnStart
      busy = true
      redraw($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      busy = false
      turnStart = await $.clock.now()
      redraw($)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const step = startStep(e, await $.clock.now())
    steps = pushStep(steps, step)
    redraw($)
    let ran
    try {
      ran = await next(e)
      return ran
    } finally {
      lastActivity = await $.clock.now()
      steps = finishStep(steps, step.id, { isError: Boolean(ran && (ran.deny || ran.isError)), now: lastActivity })
      redraw($)
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Raster, Svg } = $.ui.resolve(e)
    const now = await $.clock.now()
    const P = PALETTES[theme]
    const cols = Math.max(24, e.props?.bodyColumns ?? 60)
    const isDock = e.props?.placement === 'dock'
    const seq = sequence()
    const st = nowState(seq, now)

    // ---- controls: layout · detail · theme
    const seg = (prefix, names, value, set, keys) =>
      Object.keys(names).map((name, i) =>
        Button({
          key: prefix + name,
          label: names[name],
          hotkey: keys[i],
          plain: true,
          dimColor: value !== name,
          onPress: () => {
            set(name)
            redraw($)
          },
        }),
      )
    const controls = Box({
      flexDirection: 'row',
      flexWrap: 'wrap',
      columnGap: 2,
      children: [
        Box({ flexDirection: 'row', columnGap: 1, children: seg('ly-', LAYOUT_NAMES, layout, (v) => (layout = v), ['1', '2', '3']) }),
        Box({ flexDirection: 'row', columnGap: 1, children: seg('lv-', LEVEL_NAMES, level, (v) => (level = v), ['s', 'v', 'e']) }),
        Box({ flexDirection: 'row', columnGap: 1, children: seg('th-', THEME_NAMES, theme, (v) => (theme = v), ['c', 'x']) }),
        Button({ key: 'close', label: 'Close', hotkey: 'q', plain: true, dimColor: true, onPress: () => { void $.ui.close({ id: PANE }) } }),
      ],
    })

    // ---- Desktop and VS Code: the full HUD as one SVG
    if (e.surface === 'desktop' || e.surface === 'vscode') {
      const width = Math.round(Math.max(360, Math.min(1100, cols * 7.6)))
      const d = {
        ...st, seq, index: st.cur + 1, total: seq.length,
        meta: [String(await $.session.model().catch(() => '')).replace(/^claude-/, '').toUpperCase(), `${seq.length} STEPS`].filter(Boolean).join(' · '),
      }
      return Box({
        flexDirection: 'column',
        rowGap: 1,
        children: [
          controls,
          Svg({ source: sceneSvg(d, { width, level, layout, theme, now }), alt: `${st.nowLabel}: ${st.nowText}`, width, isInteractive: true }),
        ],
      })
    }

    // ---- Terminal: the same layout in boxes and cells
    const header = Box({
      flexDirection: 'row',
      columnGap: 2,
      children: [
        Text({ color: P.accent, weight: 'semibold', children: ['◆ VISUALIZAR'] }),
        Text({ color: st.live ? P.accent : P.dim, children: [st.live ? '● LIVE' : '○ IDLE'] }),
      ],
    })
    const nowBox = Box({
      flexDirection: 'row',
      columnGap: 2,
      borderStyle: 'round',
      borderColor: st.live ? P.accent : P.line2,
      paddingX: 1,
      children: [
        Text({ color: st.live ? P.accent2 : P.dim, children: [GLYPH[st.nowIcon] || '◆'] }),
        Box({
          flexDirection: 'column',
          flexGrow: 1,
          children: [
            Text({ color: P.dim, children: [st.nowLabel] }),
            Text({ weight: 'semibold', color: st.live ? P.text : P.dim, wrap: 'truncate-end', children: [st.nowText] }),
          ],
        }),
        Text({ color: P.accent2, children: [st.clock] }),
      ],
    })

    const line = (s, isCur) => {
      const color = catColor(P, s.view.cat)
      const mark = s.kind === 'fix' ? '⚑' : s.status === 'running' ? '▶' : s.status === 'error' ? '✗' : '✓'
      return Text({ key: s.id, color: isCur || s.kind === 'fix' ? color : P.faint, wrap: 'truncate-end', children: [`${mark} ${textFor(s.view, level)}`] })
    }

    let body = []
    if (layout === 'flow') {
      const recent = seq.slice(Math.max(0, st.cur - (isDock ? 6 : 4)), st.cur + 1)
      recent.forEach((s, i) => {
        if (i > 0) body.push(Text({ key: 'a' + s.id, color: P.line2, children: [s.kind === 'fix' ? '├╌╌' : '│'] }))
        body.push(line(s, i === recent.length - 1))
      })
    } else if (layout === 'timeline') {
      body = seq.slice(-(isDock ? 10 : 6)).map((s, i, arr) => Box({
        key: s.id, flexDirection: 'row', columnGap: 1, children: [
          Text({ color: P.faint, children: [stepTime(s, steps[0]?.startedAt ?? now)] }),
          Text({ color: catColor(P, s.view.cat), children: [s.kind === 'fix' ? '⚑' : i === arr.length - 1 ? '┣' : '┃'] }),
          line(s, i === arr.length - 1),
        ],
      }))
    } else {
      const c = seq[st.cur]
      const before = seq.slice(Math.max(0, st.cur - (isDock ? 3 : 2)), st.cur)
      body = before.map((s) => line(s, false))
      if (c) {
        const color = catColor(P, c.view.cat)
        const sub = level === 'vibe' && c.kind === 'tool' ? c.view.simple : level === 'simple' ? '' : c.view.vibe
        const status = c.kind !== 'tool' ? c.time : c.status === 'running' ? `● working · ${elapsed(now - c.startedAt)}` : c.status === 'error' ? '✗ snag' : '✓ done'
        body.push(Box({
          key: 'card-' + c.id,
          flexDirection: 'column',
          borderStyle: 'bold',
          borderColor: color,
          paddingX: 1,
          children: [
            Box({ flexDirection: 'row', columnGap: 2, children: [
              Text({ color, weight: 'semibold', children: [`${GLYPH[c.view.icon] || '◆'} ${CAT_LABEL[c.view.cat] || 'STEP'}`] }),
              Text({ color: P.faint, children: [c.time] }),
            ] }),
            Text({ weight: 'semibold', color: P.text, wrap: 'wrap', children: [textFor(c.view, level)] }),
            ...(sub && sub !== textFor(c.view, level) ? [Text({ color: P.dim, wrap: 'truncate-end', children: [sub] })] : []),
            Text({ color: c.status === 'running' ? P.accent : P.dim, children: [`${status}   ${st.cur + 1} / ${seq.length}`] }),
          ],
        }))
      }
    }

    // Coloured track of the whole session: one cell per step, fixes as ⚑.
    const track = []
    if (seq.length) {
      const n = Math.min(seq.length, cols - 2, MAX_STEPS * 2)
      const shown = seq.slice(-n)
      const words = new Uint32Array(n * 3)
      const hex = (h) => parseInt(h.slice(1), 16)
      shown.forEach((s, i) => {
        const isCur = s === seq[st.cur]
        const cp = s.kind === 'fix' ? 0x2691 : isCur ? 0x2588 : s.kind === 'prompt' ? 0x2503 : 0x2585
        const fg = s.kind === 'fix' ? hex(P.cats.fix) : isCur ? hex(catColor(P, s.view.cat)) : hex(catColor(P, s.view.cat)) & 0x7f7f7f
        words.set([cp, fg, hex(P.bg)], i * 3)
      })
      track.push(Box({ children: [Raster({ key: 'track', columns: n, rows: 1, cells: toBase64(new Uint8Array(words.buffer)) })] }))
    }
    const scan = Box({ children: [Raster({ key: 'scan', columns: cols, rows: 1, cells: scanCells(cols, tick, st.live, P) })] })
    const empty = seq.length === 0 ? [Text({ color: P.dim, children: ['No steps yet. They appear here as Claude works.'] })] : []

    return Box({ flexDirection: 'column', children: [header, controls, nowBox, scan, ...empty, ...body, ...track] })
  })
}
