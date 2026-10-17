// visualizar, inside Claude Code: a HUD pane showing what the agent is doing.
// Read-only: it listens to events and reads .steer/fixes.jsonl, and writes nothing.
import {
  COLORS, LAYOUTS, LAYOUT_NAMES, LEVEL_NAMES, startStep, pushStep, finishStep, viewOf, textFor,
  clipTo, elapsed, stepTime, parseFixes, scanCells, stripSvg,
} from './hud.js'

const PANE = 'visualizar'

// Module variables: a hot reload resets them, which only costs the step history.
let steps = []
let level = 'simple'
let layout = 'cards'
let fixes = []
let cwd = ''
let turnStart = null
let busy = false
let isOpen = false
let tick = 0

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
    // Animate the strip and refresh the clock and fixes while the pane is open.
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
      return { text: 'visualizar HUD closed.' }
    }
    await loadFixes($)
    const opened = await $.ui.open({ id: PANE, title: 'visualizar', focus: true })
    isOpen = opened.isPlaced
    return { text: opened.isPlaced ? 'visualizar HUD open. 1 / 2 / 3 change layout, s / v / e change detail, q closes.' : 'visualizar HUD waits for a wider terminal.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) isOpen = false
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      turnStart = await $.clock.now()
      busy = true
      steps = []
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
      steps = finishStep(steps, step.id, { isError: Boolean(ran && (ran.deny || ran.isError)), now: await $.clock.now() })
      redraw($)
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Raster, Svg } = $.ui.resolve(e)
    const now = await $.clock.now()
    const cols = Math.max(20, e.props?.bodyColumns ?? 40)
    const isDock = e.props?.placement === 'dock'
    const view = (s) => viewOf(s, cwd)
    const current = [...steps].reverse().find((s) => s.status === 'running')
    const running = busy || Boolean(current)

    // ---- header: title and the detail toggle
    const levelButton = (name, hotkey) =>
      Button({
        key: 'lv-' + name,
        label: LEVEL_NAMES[name],
        hotkey,
        plain: true,
        dimColor: level !== name,
        onPress: () => {
          level = name
          redraw($)
        },
      })
    const layoutButton = (name, hotkey) =>
      Button({
        key: 'ly-' + name,
        label: LAYOUT_NAMES[name],
        hotkey,
        plain: true,
        dimColor: layout !== name,
        onPress: () => {
          layout = name
          redraw($)
        },
      })
    const header = Box({
      flexDirection: 'row',
      columnGap: 2,
      children: [
        Text({ bold: true, color: COLORS.cyan, children: ['◢ VISUALIZAR ◣'] }),
        Text({ color: running ? COLORS.green : COLORS.dim, children: [running ? '● LIVE' : '○ IDLE'] }),
        layoutButton('cards', '1'),
        layoutButton('flow', '2'),
        layoutButton('timeline', '3'),
        levelButton('simple', 's'),
        levelButton('vibe', 'v'),
        levelButton('eng', 'e'),
        Button({ key: 'close', label: 'Close', hotkey: 'q', plain: true, dimColor: true, onPress: () => { void $.ui.close({ id: PANE }) } }),
      ],
    })

    // ---- scanline strip: Raster in the terminal, Svg on the remote surfaces
    let strip
    if (e.surface === 'terminal') {
      strip = Box({ children: [Raster({ key: 'scan', columns: cols, rows: 1, cells: scanCells(cols, tick, running) })] })
    } else if (e.surface === 'desktop' || e.surface === 'vscode') {
      strip = Box({ children: [Svg({ source: stripSvg(Math.min(cols * 8, 480), running), alt: running ? 'Activity strip: working' : 'Activity strip: idle', isInteractive: true })] })
    } else {
      strip = Text({ color: COLORS.dim, children: [running ? '▰▰▰▱▱▱' : '▱▱▱▱▱▱'] })
    }

    // ---- NOW line
    const nowText = current
      ? textFor(view(current), level)
      : busy ? 'Thinking…' : 'Standing by — nothing running'
    const clock = turnStart !== null ? (busy ? 'T+' : 'idle ') + elapsed(now - turnStart) : ''
    const nowLine = Box({
      flexDirection: 'row',
      columnGap: 1,
      ...(isDock ? { borderStyle: 'double', borderColor: running ? COLORS.cyan : COLORS.dim, paddingX: 1 } : {}),
      children: [
        Text({ bold: true, color: COLORS.amber, children: ['NOW'] }),
        Box({ flexGrow: 1, children: [Text({ bold: running, color: running ? COLORS.cyan : COLORS.dim, children: [clipTo(nowText, cols - 16)] })] }),
        Text({ dimColor: true, children: [clock] }),
      ],
    })

    // ---- recent steps, laid out as Cards, Flow or Timeline
    const markOf = (s) => (s.status === 'running' ? '▶' : s.status === 'error' ? '✗' : '✓')
    const colorOf = (s, isCurrent) => (s.status === 'error' ? COLORS.red : isCurrent ? COLORS.cyan : COLORS.dim)
    const room = isDock ? 4 : Math.max(1, Math.min(3, (e.viewport?.rows ?? 24) / 4 | 0))
    let body
    if (layout === 'flow') {
      // A chain of short nodes: ✓ Reading ─▶ ✓ Editing ─▶ ▶ Running the tests
      const recent = steps.slice(-(isDock ? 6 : 5))
      const nodes = []
      recent.forEach((s, i) => {
        const isCurrent = i === recent.length - 1 && s.status === 'running'
        if (i > 0) nodes.push(Text({ key: 'a' + i, color: COLORS.dim, children: ['─▶'] }))
        nodes.push(Text({ key: s.id, bold: isCurrent, dimColor: !isCurrent && s.status !== 'error', color: colorOf(s, isCurrent), children: [`${markOf(s)} ${clipTo(textFor(view(s), 'simple'), 16)}`] }))
      })
      body = nodes.length ? [Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, children: nodes })] : []
    } else if (layout === 'timeline') {
      // A spine with the time each step began: 0:07 ┃ ✓ Reading a file
      const recent = steps.slice(-(isDock ? 8 : room + 1))
      body = recent.map((s, i) => {
        const isCurrent = i === recent.length - 1 && s.status === 'running'
        const c = colorOf(s, isCurrent)
        return Box({ key: s.id, flexDirection: 'row', columnGap: 1, children: [
          Text({ dimColor: true, children: [stepTime(s, turnStart)] }),
          Text({ color: c, children: [isCurrent ? '┣' : '┃'] }),
          Text({ bold: isCurrent, dimColor: !isCurrent && s.status !== 'error', color: c, children: [clipTo(`${markOf(s)} ${textFor(view(s), level)}`, cols - 9)] }),
        ] })
      })
    } else {
      // Cards: bordered in a sidebar, one-liners above the prompt
      const recent = steps.slice(-room)
      body = recent.map((s, i) => {
        const isCurrent = i === recent.length - 1 && s.status === 'running'
        const color = colorOf(s, isCurrent)
        const line = Text({ bold: isCurrent, dimColor: !isCurrent && s.status !== 'error', color, children: [clipTo(`${markOf(s)} ${textFor(view(s), level)}`, cols - (isDock ? 6 : 2))] })
        return isDock
          ? Box({ key: s.id, borderStyle: isCurrent ? 'bold' : 'round', borderColor: color, paddingX: 1, children: [line] })
          : Box({ key: s.id, children: [line] })
      })
    }

    // ---- fixes from .steer/fixes.jsonl, as red flags
    const flags = fixes.map((f, i) =>
      Box({ key: 'fix' + i, borderStyle: isDock ? 'round' : undefined, borderColor: COLORS.red, paddingX: isDock ? 1 : 0, children: [
        Text({ color: COLORS.red, bold: true, children: [clipTo(`⚑ ${f.urgent ? 'URGENT FIX' : 'FIX'}: ${f.text.replace(/\s+/g, ' ')}`, cols - 6)] }),
      ] }),
    )

    const empty = steps.length === 0 ? [Text({ dimColor: true, children: ['No steps yet. They appear as Claude works.'] })] : []
    return Box({ flexDirection: 'column', children: [header, strip, nowLine, ...empty, ...body, ...flags] })
  })
}
