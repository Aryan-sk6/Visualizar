// visualizar, inside Claude Code: a HUD pane showing what the agent is doing.
// Read-only: it listens to events and reads .steer/fixes.jsonl, and writes nothing.
//
// The pane is built from Claude Code's own elements (boxes, borders, text
// sizes, buttons, code), so it fills the pane, updates in place and looks
// native in the Desktop app, VS Code and the terminal alike.
import {
  LAYOUT_NAMES, LEVEL_NAMES, THEME_NAMES, PALETTES, catColor, startStep, pushStep, finishStep, viewOf, textFor,
  elapsed, stepTime, parseFixes, MAX_STEPS,
} from './hud.js'
import { layoutDeck } from './carousel.js'

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
// Which step the cards view centres on: null follows the live step.
let pinned = null
// Whether the session's earlier steps have been loaded into the pane.
let backfilled = false
let lastWheel = 0

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

// Loads the steps from before the pane opened (or before a reload) from the
// conversation. They have no timestamps, so they sort before every live step
// and show as "earlier".
async function backfill($) {
  backfilled = true // once per load, even if reading fails
  let msgs = []
  try {
    msgs = await $.session.messages()
  } catch {
    return
  }
  const have = new Set(steps.map((s) => s.id))
  const hist = []
  msgs.forEach((m, k) => {
    if (m.role === 'user') {
      const text = String(m.text || '').trim()
      if (text && !text.startsWith('<') && !(m.toolResults && m.toolResults.length)) {
        hist.push({ id: 'h' + k, kind: 'prompt', text: text.slice(0, 500), status: 'done', startedAt: k, endedAt: k, historic: true })
      }
      return
    }
    for (const u of m.toolUses || []) {
      if (have.has(u.tool_use_id) || u.text === undefined) continue // in flight: live events cover it
      hist.push({ id: u.tool_use_id, kind: 'tool', name: String(u.tool), input: u.input || {}, status: u.isError ? 'error' : 'done', startedAt: k, endedAt: k, side: false, historic: true })
    }
  })
  steps = [...hist, ...steps].slice(-MAX_STEPS)
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
  // Fixes have real times; the backfilled steps don't, so fixes are placed
  // only among the live steps.
  const first = steps.find((s) => !s.historic)?.startedAt ?? Infinity
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
  for (const s of all) s.time = s.historic ? 'earlier' : hhmmss(s.startedAt)
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
    // While the pane is open: tick the clock once a second during a turn,
    // and pick up new fixes every few seconds. Nothing redraws when idle.
    $.clock.every(1000, () => {
      if (!isOpen) return
      tick++
      if (tick % 3 === 0) {
        const before = fixes.length
        void loadFixes($).then(() => {
          if (busy || fixes.length !== before) redraw($)
        })
      } else if (busy) redraw($)
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
    if (!backfilled) await backfill($)
    const opened = await $.ui.open({ id: PANE, title: 'visualizar', focus: true })
    isOpen = opened.isPlaced
    return { text: opened.isPlaced ? 'visualizar open. 1/2/3 layout · s/v/e detail · c/x theme · b/n step · l live.' : 'visualizar is waiting for a wider window.' }
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

  // The carousel centres the card you dragged to or clicked.
  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== 'carousel' || typeof e.data?.select !== 'number') return next(e)
    const n = sequence().length
    pinned = e.data.select >= n - 1 ? null : Math.max(0, e.data.select)
    redraw($)
    return {}
  }).catch(($, e, next) => next(e))

  // In the Cards view, the wheel or trackpad steps through cards instead of
  // scrolling the pane. One step per 120 ms, so a trackpad flick doesn't race.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (layout !== 'cards' || e.by === 0) return next(e)
    const now = await $.clock.now()
    if (now - lastWheel < 120) return { deny: 'visualizar: stepping through cards' }
    lastWheel = now
    const n = sequence().length
    if (!n) return next(e)
    const at = pinned ?? n - 1
    const to = Math.max(0, Math.min(n - 1, at + Math.sign(e.by)))
    pinned = to >= n - 1 ? null : to
    redraw($)
    return { deny: 'visualizar: stepping through cards' }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code, Client } = $.ui.resolve(e)
    // Being drawn means the pane is open, including after a reload.
    isOpen = true
    if (!backfilled) await backfill($)
    const now = await $.clock.now()
    const P = PALETTES[theme]
    const cols = Math.max(24, e.props?.bodyColumns ?? 60)
    const seq = sequence()
    const st = nowState(seq, now)
    const curIndex = pinned !== null && seq[pinned] ? pinned : st.cur
    const follow = pinned === null || !seq[pinned]

    const T = (children, props = {}) => Text({ ...props, children: [children] })
    const label = (s, color = P.dim) => T(s, { color, size: 'caption', mono: true })

    // ---- top bar: brand, live state, controls
    const seg = (prefix, names, value, set, keys) =>
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: Object.keys(names).map((name, i) =>
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
        ),
      })
    const top = Box({
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      alignItems: 'center',
      rowGap: 1,
      columnGap: 2,
      children: [
        Box({ flexDirection: 'row', columnGap: 2, alignItems: 'center', children: [
          T('◆ VISUALIZAR', { color: P.accent, weight: 'bold', mono: true }),
          T(st.live ? ' ● LIVE ' : ' ○ IDLE ', { color: st.live ? P.bg : P.dim, backgroundColor: st.live ? P.accent : undefined, size: 'caption', mono: true, weight: 'semibold' }),
        ] }),
        Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 3, children: [
          seg('ly-', LAYOUT_NAMES, layout, (v) => (layout = v), ['1', '2', '3']),
          seg('lv-', LEVEL_NAMES, level, (v) => (level = v), ['s', 'v', 'e']),
          seg('th-', THEME_NAMES, theme, (v) => (theme = v), ['c', 'x']),
        ] }),
      ],
    })

    // ---- NOW panel
    const nowPanel = Box({
      flexDirection: 'row',
      alignItems: 'center',
      columnGap: 2,
      paddingX: 2,
      paddingY: 1,
      borderStyle: 'round',
      borderColor: st.live ? P.accent : P.line2,
      backgroundColor: P.panel,
      children: [
        Box({ borderStyle: 'round', borderColor: st.live ? P.accent : P.line2, paddingX: 1, children: [T(GLYPH[st.nowIcon] || '◆', { color: st.live ? P.accent2 : P.dim, size: 'heading' })] }),
        Box({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, children: [
          label(st.nowLabel),
          T(st.nowText, { color: st.live ? P.text : P.dim, size: 'title', weight: 'bold', wrap: 'truncate-end' }),
        ] }),
        Box({ flexDirection: 'column', alignItems: 'flex-end', children: [
          T(st.clock, { color: P.accent2, size: 'heading', mono: true, tabular: true }),
          label(`${seq.length} steps`),
        ] }),
      ],
    })

    const statusOf = (s) => {
      if (s.kind === 'fix') return [P.cats.fix, s.deliveredAt ? 'delivered' : 'logged']
      if (s.kind !== 'tool') return [P.dim, s.time]
      if (s.historic) return s.status === 'error' ? [P.error, 'snag'] : [P.ok, 'done']
      const d = elapsed((s.endedAt ?? now) - s.startedAt)
      if (s.status === 'running') return [P.accent, `working · ${d}`]
      if (s.status === 'error') return [P.error, `snag · ${d}`]
      return [P.ok, `done · ${d}`]
    }
    const kindLabel = (s) => (CAT_LABEL[s.view.cat] || 'STEP') + (s.side ? ' · HELPER' : '')

    // One step as plain card data: what the carousel (a Client, which only
    // takes plain data) and the static deck both draw.
    const cardData = (s, i) => {
      const color = catColor(P, s.view.cat)
      const [statusColor, status] = statusOf(s)
      const c = { title: textFor(s.view, level), kind: kindLabel(s), glyph: GLYPH[s.view.icon] || '◆', color, time: s.time, status, statusColor }
      if (i === curIndex) {
        if (level === 'vibe' && s.kind === 'tool') c.sub = s.view.simple
        if (level === 'eng' && s.kind === 'tool' && s.view.eng?.body) {
          const body = s.view.eng.body.length > 600 ? s.view.eng.body.slice(0, 600) + '\n…' : s.view.eng.body
          c.code = s.view.eng.lang === 'diff'
            ? { format: 'diff', source: '@@ -1 +1 @@\n' + body.replace(/^- /gm, '-').replace(/^\+ /gm, '+') }
            : { language: s.view.eng.lang === 'shell' ? 'bash' : 'text', source: body }
        }
      }
      return c
    }

    // The same deck without dragging, for surfaces with no Client (VS Code).
    const staticDeck = () => {
      const { slots, sz } = layoutDeck(cols, curIndex, seq.length)
      return Box({ flexDirection: 'row', columnGap: 2, justifyContent: 'center', alignItems: 'center', children: slots.map(({ i, d }) => {
        const c = cardData(seq[i], i)
        const big = d === 0
        return Box({
          key: 'sd-' + i, flexDirection: 'column', rowGap: big ? 1 : 0, width: sz[d][0], height: sz[d][1], flexShrink: 0, overflow: 'hidden',
          paddingX: big ? 2 : 1, paddingY: big ? 1 : 0, borderStyle: big ? 'bold' : 'round', borderColor: big ? c.color : P.line2, backgroundColor: big ? P.panel2 : P.panel,
          children: [
            Box({ flexDirection: 'row', columnGap: 1, alignItems: 'center', children: [
              Box({ borderStyle: 'round', borderColor: c.color, paddingX: 1, children: [T(c.glyph, { color: c.color, size: big ? 'heading' : 'body' })] }),
              Box({ flexDirection: 'column', flexShrink: 1, children: [label(c.kind, c.color), label(c.time, P.faint)] }),
            ] }),
            T(c.title, { color: big ? P.text : P.dim, size: big ? 'title' : 'body', weight: big ? 'bold' : 'medium', wrap: 'wrap' }),
            ...(big && c.sub ? [T(c.sub, { color: P.dim, wrap: 'wrap' })] : []),
            ...(big && c.code ? [Code({ ...c.code, wrap: 'truncate-end' })] : []),
            Box({ flexGrow: 1 }),
            Box({ flexDirection: 'row', justifyContent: 'space-between', children: [
              T(`● ${c.status}`, { color: c.statusColor, size: 'caption', wrap: 'truncate-end' }),
              ...(big ? [label(`${i + 1} / ${seq.length}`, P.faint)] : []),
            ] }),
          ],
        })
      }) })
    }

    // ---- the main view
    let main
    if (!seq.length) {
      main = Box({ paddingY: 2, justifyContent: 'center', children: [T('No steps yet. They appear here as Claude works.', { color: P.dim })] })
    } else if (layout === 'flow') {
      // The pane scrolls, so show a long stretch of the session.
      const recent = seq.slice(Math.max(0, curIndex - 40), curIndex + 1)
      const nodes = []
      recent.forEach((s, i) => {
        const isCur = i === recent.length - 1
        if (i > 0) nodes.push(Box({ key: 'ar-' + s.id, paddingLeft: 2, children: [T('↓', { color: P.line2 })] }))
        if (s.kind === 'fix') {
          nodes.push(Box({ key: 'fx-' + s.id, marginLeft: 4, flexDirection: 'column', paddingX: 1, borderStyle: 'dashed', borderColor: P.cats.fix, children: [
            label(s.urgent ? '⚑ URGENT FIX LANDED HERE' : '⚑ FIX LANDED HERE', P.cats.fix),
            T(s.text, { color: P.text, wrap: 'wrap' }),
          ] }))
          return
        }
        const color = catColor(P, s.view.cat)
        const [sc, sl] = statusOf(s)
        nodes.push(Box({
          key: 'nd-' + s.id, flexDirection: 'row', columnGap: 2, alignItems: 'center', paddingX: 1,
          borderStyle: isCur ? 'bold' : 'round', borderColor: isCur ? color : P.line2, backgroundColor: s.kind === 'prompt' ? P.panel2 : P.panel,
          children: [
            T(GLYPH[s.view.icon] || '◆', { color }),
            Box({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, children: [
              T(textFor(s.view, level), { color: isCur ? P.text : P.dim, weight: isCur ? 'semibold' : 'regular', wrap: 'truncate-end' }),
              T(`● ${sl}`, { color: sc, size: 'caption' }),
            ] }),
          ],
        }))
      })
      main = Box({ flexDirection: 'column', children: nodes })
    } else if (layout === 'timeline') {
      const lastPrompt = [...seq].reverse().findIndex((s) => s.kind === 'prompt')
      const turn = lastPrompt >= 0 ? seq.slice(seq.length - 1 - lastPrompt) : seq.slice(-12)
      const t0 = turn[0].startedAt
      const span = Math.max(10_000, now - t0)
      const barRoom = Math.max(8, Math.min(40, cols - 40))
      main = Box({ flexDirection: 'column', rowGap: 0, children: turn.slice(-60).map((s) => {
        const color = s.kind === 'fix' ? P.cats.fix : catColor(P, s.view.cat)
        const start = Math.round(((s.startedAt - t0) / span) * barRoom)
        const len = s.kind === 'tool' ? Math.max(1, Math.round((((s.endedAt ?? now) - s.startedAt) / span) * barRoom)) : 1
        const mark = s.kind === 'fix' ? '⚑' : s.kind === 'prompt' ? '┃' : '█'.repeat(len)
        return Box({ key: 'tl-' + s.id, flexDirection: 'row', columnGap: 1, children: [
          label(stepTime(s, t0), P.faint),
          T(' '.repeat(start) + mark + ' '.repeat(Math.max(0, barRoom - start - len)), { color, mono: true }),
          T(textFor(s.view, level), { color: s === seq[curIndex] ? P.text : P.dim, wrap: 'truncate-end' }),
        ] })
      }) })
    } else if (e.surface === 'terminal' || e.surface === 'desktop') {
      // Drag the cards with the mouse; wheel over the pane steps them (ui.scroll).
      main = Client({
        key: 'carousel',
        module: './carousel.js',
        width: '100%',
        props: { cards: seq.map(cardData), cur: curIndex, P },
      })
    } else {
      main = staticDeck()
    }

    // ---- session track: one mark per step, fixes as flags
    const shown = seq.slice(-Math.max(10, Math.min(80, cols - 4)))
    const track = Box({ flexDirection: 'row', flexWrap: 'wrap', children: shown.map((s) => {
      const isCur = s === seq[curIndex]
      const ch = s.kind === 'fix' ? '⚑' : s.kind === 'prompt' ? '┃' : isCur ? '█' : '▮'
      return T(ch, { key: 'tk-' + s.id, color: s.kind === 'fix' ? P.cats.fix : isCur ? catColor(P, s.view.cat) : P.line2, mono: true })
    }) })

    // ---- stepping through the session
    const nav = Box({ flexDirection: 'row', columnGap: 2, alignItems: 'center', children: [
      Button({ key: 'prev', label: '◀', hotkey: 'b', plain: true, dimColor: curIndex <= 0, onPress: () => { pinned = Math.max(0, curIndex - 1); redraw($) } }),
      Button({ key: 'next', label: '▶', hotkey: 'n', plain: true, dimColor: follow, onPress: () => { pinned = curIndex + 1 >= seq.length - 1 ? null : curIndex + 1; redraw($) } }),
      Button({ key: 'live', label: follow ? 'Following live' : 'Back to live', hotkey: 'l', plain: true, dimColor: follow, onPress: () => { pinned = null; redraw($) } }),
    ] })

    // Fill the pane's height, with the main view taking the room in between.
    const rows = e.props?.scroll?.bodyRows
    const body = Box({
      flexDirection: 'column',
      flexGrow: 1,
      justifyContent: layout === 'cards' || !seq.length ? 'center' : 'flex-start',
      children: [main],
    })
    return Box({
      flexDirection: 'column',
      rowGap: 1,
      padding: 1,
      backgroundColor: P.bg,
      ...(rows ? { minHeight: rows } : {}),
      children: [top, nowPanel, body, ...(seq.length ? [track, nav] : [])],
    })
  })
}
