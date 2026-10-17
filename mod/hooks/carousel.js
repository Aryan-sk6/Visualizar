// The Cards view as a Client region: a deck of step cards you can drag
// sideways with the mouse, click to bring a card to the centre, or step with
// the arrow keys once it has focus. Runs on the drawing surface (terminal,
// Desktop) with no mods API; it tells the hooks module which card to centre
// by posting { select: index }.
//
// props: { cards: Card[], cur: number, P: palette }
//   Card: { title, sub?, kind, glyph, color, time, status, statusColor,
//           mono?, facts?: string[], lines?: { t, k: 'add'|'del'|'out'|'err' }[] }

const GAP = 2

// Card sizes in cells by distance from the centre: [width, height].
export function sizes(columns) {
  const w0 = Math.max(24, Math.min(40, Math.floor(columns * 0.36)))
  return [
    [w0, 14],
    [Math.round(w0 * 0.7), 10],
    [Math.round(w0 * 0.52), 8],
  ]
}

// Which cards fit around `cur`, and the column span of each.
export function layoutDeck(columns, cur, count) {
  const sz = sizes(columns)
  const slots = [{ i: cur, d: 0 }]
  let used = sz[0][0]
  for (const d of [1, 2]) {
    const w = sz[d][0] + GAP
    if (used + 2 * w > columns) break
    if (cur - d >= 0) slots.unshift({ i: cur - d, d })
    if (cur + d < count) slots.push({ i: cur + d, d })
    used += 2 * w
  }
  const total = slots.reduce((a, { d }) => a + sz[d][0], 0) + GAP * (slots.length - 1)
  let x = Math.max(0, Math.floor((columns - total) / 2))
  const spans = slots.map(({ i, d }) => {
    const span = { i, from: x, to: x + sz[d][0] }
    x += sz[d][0] + GAP
    return span
  })
  return { slots, sz, spans }
}

// The latest props and layout per instance, for the pointer and key
// listeners, which are registered once.
const live = new WeakMap()

export default function Carousel(props, surface) {
  const { Box, Text } = surface.elements
  const { cards = [], cur: propCur = 0, P } = props || {}
  const st = surface.state || {}
  const columns = surface.columns || 80
  const step = sizes(columns)[1][0] + GAP
  const clamp = (n) => Math.max(0, Math.min(cards.length - 1, n))

  if (surface.state === undefined) {
    const select = (target) => {
      const ref = live.get(surface)
      surface.setState({ ...(surface.state || {}), drag: null, pending: target, pendingFrom: ref.cur })
      surface.post({ select: target })
    }
    surface.onPointer((ev) => {
      const s = surface.state || {}
      const ref = live.get(surface)
      if (ev.type === 'down' && ev.button === 'left') {
        surface.setState({ ...s, drag: { x0: ev.x, from: ref.shown, dx: 0 } })
      } else if (ev.type === 'move' && s.drag) {
        surface.setState({ ...s, drag: { ...s.drag, dx: ev.x - s.drag.x0 } })
      } else if (ev.type === 'up' && s.drag) {
        const { from, dx } = s.drag
        const hit = ref.spans.find((sp) => ev.x >= sp.from && ev.x < sp.to)
        const target = Math.abs(dx) < 2 ? (hit ? hit.i : from) : from - Math.round(dx / ref.step)
        select(Math.max(0, Math.min(ref.count - 1, target)))
      }
    })
    surface.onKey((ev) => {
      const ref = live.get(surface)
      if (ev.key !== 'left' && ev.key !== 'right') return
      select(Math.max(0, Math.min(ref.count - 1, ref.shown + (ev.key === 'left' ? -1 : 1))))
    })
    surface.setState({})
  }

  // Which card is centred: a drag in progress, then a choice the hooks
  // module hasn't confirmed yet, then the props.
  let cur = propCur
  if (st.pending !== undefined && st.pendingFrom === propCur) cur = st.pending
  if (st.drag) cur = clamp(st.drag.from - Math.round(st.drag.dx / step))
  cur = clamp(cur)

  const { slots, sz, spans } = layoutDeck(columns, cur, cards.length)
  live.set(surface, { cur: propCur, shown: cur, spans, step, count: cards.length })
  if (!cards.length) return Text({ color: P && P.dim, children: ['No steps yet.'] })

  const card = ({ i, d }) => {
    const c = cards[i]
    const [w, h] = sz[d]
    const big = d === 0
    const children = [
      Box({ flexDirection: 'row', columnGap: 1, alignItems: 'center', children: [
        Box({ borderStyle: 'round', borderColor: c.color, paddingX: 1, children: [Text({ color: c.color, size: big ? 'heading' : 'body', children: [c.glyph] })] }),
        Box({ flexDirection: 'column', flexShrink: 1, children: [
          Text({ color: c.color, size: 'caption', mono: true, weight: 'semibold', wrap: 'truncate-end', children: [c.kind] }),
          Text({ color: P.faint, size: 'caption', mono: true, children: [c.time] }),
        ] }),
      ] }),
      Text({
        color: big ? P.text : P.dim,
        size: c.mono ? (big ? 'heading' : 'caption') : big ? 'title' : d === 1 ? 'body' : 'caption',
        mono: Boolean(c.mono),
        weight: big ? 'bold' : 'medium',
        wrap: 'wrap',
        children: [c.title],
      }),
    ]
    if (big && c.sub) children.push(Text({ color: P.dim, wrap: 'wrap', children: [c.sub] }))
    // Engineer: facts as chips, then the few lines worth seeing.
    if (c.facts && c.facts.length && d < 2) {
      children.push(Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, rowGap: 0, children: c.facts.map((f, k) =>
        Text({ key: 'f' + k, color: P.text, backgroundColor: P.line, size: 'caption', mono: true, children: [` ${f} `] })) }))
    }
    if (big && c.lines) {
      for (const [k, l] of c.lines.entries()) {
        const color = l.k === 'add' ? P.ok : l.k === 'del' || l.k === 'err' ? P.error : P.dim
        const mark = l.k === 'add' ? '+ ' : l.k === 'del' ? '− ' : ''
        children.push(Text({ key: 'l' + k, color, size: 'caption', mono: true, wrap: 'truncate-end', children: [mark + l.t] }))
      }
    }
    children.push(Box({ flexGrow: 1 }))
    children.push(Box({ flexDirection: 'row', justifyContent: 'space-between', children: [
      Text({ color: c.statusColor, size: 'caption', wrap: 'truncate-end', children: [`● ${c.status}`] }),
      ...(big ? [Text({ color: P.faint, size: 'caption', mono: true, children: [`${i + 1} / ${cards.length}`] })] : []),
    ] }))
    return Box({
      key: 'c' + i,
      flexDirection: 'column',
      rowGap: big ? 1 : 0,
      width: w,
      height: h,
      flexShrink: 0,
      overflow: 'hidden',
      paddingX: big ? 2 : 1,
      paddingY: big ? 1 : 0,
      borderStyle: big ? 'bold' : 'round',
      borderColor: big ? c.color : P.line2,
      backgroundColor: big ? P.panel2 : P.panel,
      children,
    })
  }

  return Box({
    flexDirection: 'row',
    columnGap: GAP,
    justifyContent: 'center',
    alignItems: 'center',
    height: sz[0][1] + 1,
    children: slots.map(card),
  })
}
