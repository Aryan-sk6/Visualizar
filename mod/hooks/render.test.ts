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
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Running the tests' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'Engineer' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '3 / 3' })).toBeDefined()
  }
})

test('◀ steps back through the session and Back to live returns', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'prev' })
  expect(await ui.find({ type: 'Text', text: '2 / 3' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'Back to live' })).toBeDefined()
  await ui.press({ key: 'live' })
  expect(await ui.find({ type: 'Text', text: '3 / 3' })).toBeDefined()
})

test('a narrow pane stacks the earlier steps above the current card', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount(pane('terminal', 50))
  expect(await ui.find({ type: 'Text', text: '✓ Building the top card' })).toBeDefined()
})

test('Engineer level shows the real command', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'lv-eng' })
  expect(await ui.find({ type: 'Code', text: 'npm test' })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: 'Running the tests' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '● snag' })).toBeDefined()
  await ui.press({ key: 'prev' })
  await ui.press({ key: 'prev' })
  expect(await ui.find({ type: 'Text', text: 'You asked: Make the top card bigger' })).toBeDefined()
})
