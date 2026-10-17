import { test, expect } from 'claude-code/testing'
import { sceneSvg, wrap } from './scene.js'

const pane = (surface: any) => ({
  plugin: 'visualizar',
  surface,
  component: 'Pane' as const,
  requestId: 'visualizar',
  props: { title: 'visualizar', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 40, offset: 0 }, view: {} } as any,
  viewport: { columns: 160, rows: 48, isFullscreen: true },
})

test('the pane draws the SVG HUD on Desktop and boxes in the terminal', async ($, on) => {
  let t = 1_760_000_000_000
  on('clock.now', () => ({ value: (t += 1500) }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('tool.call', () => ({ result: 'ok' }))
  await $.tool.call({ tool: 'Edit', file_path: '/p/src/components/TopCard.tsx', old_string: 'a', new_string: 'b' } as any)
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' } as any)

  const desktop = await $.ui.mount(pane('desktop'))
  const svg = await desktop.find({ type: 'Svg' })
  expect(svg).toBeDefined()
  const source = String((svg as any).props.source)
  expect(source.startsWith('<svg')).toBe(true)
  expect(source).toContain('Running the tests')
  expect(source.length).toBeLessThan(131072)
  expect(await desktop.find({ type: 'Button', text: 'Engineer' })).toBeDefined()

  const terminal = await $.ui.mount(pane('terminal'))
  expect(await terminal.find({ type: 'Text', text: 'Running the tests' })).toBeDefined()
  expect(await terminal.find({ type: 'Raster', key: 'track' })).toBeDefined()
})

test('the scene escapes text and wraps long titles', () => {
  const step = { id: 'x', kind: 'tool', status: 'running', startedAt: 0, time: '10:00:00', view: { icon: 'edit', cat: 'write', simple: 'Editing <script>"a" & b', vibe: 'v', eng: { title: 'e' } } }
  const svg = sceneSvg({ seq: [step], cur: 0, live: true, nowIcon: 'edit', nowLabel: 'NOW', nowText: 'x', clock: 'T+00:01', meta: '', index: 1, total: 1 }, { width: 600, now: 5000 })
  expect(svg).toContain('&lt;script&gt;&quot;a&quot; &amp; b')
  expect(svg).not.toContain('<script>')
  expect(wrap('one two three four five six', 9, 2)).toEqual(['one two', 'three…'])
})
