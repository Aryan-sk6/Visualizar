import { test, expect } from 'claude-code/testing'

const pane = (surface: any, bodyColumns = 120) => ({
  plugin: 'visualizar',
  surface,
  component: 'Pane' as const,
  requestId: 'visualizar',
  props: { title: 'visualizar', isFocused: true, bodyColumns, placement: 'dock', scroll: { bodyRows: 40, offset: 0 }, view: {} } as any,
  viewport: { columns: 200, rows: 50, isFullscreen: true },
})

async function setup($: any, on: any) {
  let t = 1_760_000_000_000
  on('clock.now', () => ({ value: (t += 1500) }))
  on('tool.call', () => ({ result: 'ok' }))
  await $.tool.call({ tool: 'Read', file_path: '/p/README.md' } as any)
  await $.tool.call({ tool: 'Edit', file_path: '/p/src/components/TopCard.tsx', old_string: 'a', new_string: 'b' } as any)
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' } as any)
}

test('the pane is built from native elements on Desktop, VS Code and the terminal', async ($, on) => {
  await setup($, on)
  for (const surface of ['desktop', 'vscode', 'terminal']) {
    const ui = await $.ui.mount(pane(surface))
    const inCards = surface === 'vscode' ? {} : { in: 'carousel' }
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Done — waiting for you' })).toBeDefined() // NOW panel
    expect(await ui.find({ type: 'Text', text: 'Running the tests', ...inCards })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'Engineer' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '3 / 3', ...inCards })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Building the top card', ...inCards })).toBeDefined() // neighbour card
  }
})

test('◀ steps back through the session and Back to live returns', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'prev' })
  expect(await ui.find({ type: 'Text', text: '2 / 3', in: 'carousel' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'Back to live' })).toBeDefined()
  await ui.press({ key: 'live' })
  expect(await ui.find({ type: 'Text', text: '3 / 3', in: 'carousel' })).toBeDefined()
})

test('dragging the deck right brings earlier cards to the centre', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount(pane('desktop'))
  await ui.resize({ columns: 120, rows: 16, in: 'carousel' })
  await ui.pointer({ type: 'down', x: 60, y: 5, button: 'left', in: 'carousel' } as any)
  await ui.pointer({ type: 'move', x: 92, y: 5, button: 'left', in: 'carousel' } as any)
  await ui.pointer({ type: 'up', x: 92, y: 5, button: 'left', in: 'carousel' } as any)
  expect(await ui.find({ type: 'Text', text: '2 / 3', in: 'carousel' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'Back to live' })).toBeDefined()
})

test('clicking a side card centres it', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount(pane('desktop'))
  await ui.resize({ columns: 120, rows: 16, in: 'carousel' })
  // The centre card is 40 wide in 120 columns; the card left of it ends just before.
  await ui.pointer({ type: 'down', x: 35, y: 5, button: 'left', in: 'carousel' } as any)
  await ui.pointer({ type: 'up', x: 35, y: 5, button: 'left', in: 'carousel' } as any)
  expect(await ui.find({ type: 'Text', text: '2 / 3', in: 'carousel' })).toBeDefined()
})

test('the wheel steps through cards in the Cards view', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount(pane('desktop'))
  const r = await ($ as any).ui.scroll({ component: 'Pane', requestId: 'visualizar', offset: 0, by: -1, bodyRows: 40, contentRows: 40, origin: { kind: 'person' } })
  expect(r.deny).toContain('stepping through cards')
  expect(await ui.find({ type: 'Text', text: '2 / 3', in: 'carousel' })).toBeDefined()
})

test('Engineer level shows a quick technical summary, not raw output', async ($, on) => {
  let t = 1_760_000_000_000
  on('clock.now', () => ({ value: (t += 1500) }))
  on('tool.call', (_$: any, e: any) => {
    if (e.tool === 'Bash' && e.command === 'npm test') return { result: { stdout: '> app@1 test\n> node --test\n\nℹ tests 12\nℹ pass 12\nℹ fail 0\n', stderr: '' } }
    if (e.tool === 'Bash') return { deny: 'Error: build failed\nTS2304: Cannot find name foo' }
    return { result: 'ok' }
  })
  await $.tool.call({ tool: 'Edit', file_path: '/p/src/components/TopCard.tsx', old_string: 'width: 200', new_string: 'width: 320\nheight: 180' } as any)
  await $.tool.call({ tool: 'Bash', command: 'npm run build' } as any)
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' } as any)
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'lv-eng' })
  const c = { in: 'carousel' }
  expect(await ui.find({ type: 'Code', ...c })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '$ npm test', ...c })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'exit ok', ...c })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ℹ pass 12', ...c })).toBeDefined()
  // The failed build, one card back: failed chip and the error line.
  await ui.press({ key: 'prev' })
  expect(await ui.find({ type: 'Text', text: 'failed', ...c })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'TS2304: Cannot find name foo', ...c })).toBeDefined()
  // The edit: changed lines in +/− form and a line count chip.
  await ui.press({ key: 'prev' })
  expect(await ui.find({ type: 'Text', text: '+1 −1 lines'.replace('+1', '+2'), ...c })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '− width: 200', ...c })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '+ width: 320', ...c })).toBeDefined()
})

test('opening the pane loads the earlier steps of the session', async ($, on) => {
  let t = 1_760_000_000_000
  on('clock.now', () => ({ value: (t += 1500) }))
  on('session.messages', () => ({ value: [
    { role: 'user', text: 'Make the top card bigger', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'old1', tool: 'Read', input: { file_path: '/p/README.md' }, text: 'ok' }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'old1', text: 'ok' }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'old2', tool: 'Bash', input: { command: 'npm test' }, text: 'fail', isError: true }] },
  ] }))
  const ui = await $.ui.mount(pane('desktop'))
  expect(await ui.find({ type: 'Text', text: '3 steps' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Running the tests', in: 'carousel' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '● snag', in: 'carousel' })).toBeDefined()
  await ui.press({ key: 'prev' })
  await ui.press({ key: 'prev' })
  expect(await ui.find({ type: 'Text', text: 'You asked: Make the top card bigger', in: 'carousel' })).toBeDefined()
})
