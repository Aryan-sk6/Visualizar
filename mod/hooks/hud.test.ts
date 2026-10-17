import { test, expect } from 'claude-code/testing'
import { startStep, finishStep, pushStep, viewOf, textFor, elapsed, parseFixes, stepTime, LAYOUTS, scanCells, MAX_STEPS } from './hud.js'

test('translates a tool call into the three levels', () => {
  const step = startStep({ tool: 'Edit', tool_use_id: 't1', file_path: '/p/src/TopCard.tsx', old_string: 'a', new_string: 'b' }, 0)
  const view = viewOf(step, '/p')
  expect(textFor(view, 'simple')).toBe('Building the top card')
  expect(textFor(view, 'eng')).toBe('Edit src/TopCard.tsx')
})

test('tracks step state and keeps only the newest steps', () => {
  let steps: any[] = []
  for (let i = 0; i < MAX_STEPS + 3; i++) steps = pushStep(steps, startStep({ tool: 'Read', tool_use_id: 't' + i, file_path: '/x' }, i))
  expect(steps.length).toBe(MAX_STEPS)
  steps = finishStep(steps, steps.at(-1).id, { isError: true, now: 9 })
  expect(steps.at(-1).status).toBe('error')
})

test('formats time and fixes, skipping bad lines', () => {
  expect(elapsed(65000)).toBe('1:05')
  const fixes = parseFixes('{"text":"use tabs","urgency":"urgent"}\nnot json\n{"text":"ok"}\n')
  expect(fixes.length).toBe(2)
  expect(fixes[0].urgent).toBe(true)
})

test('the scan strip has one cell triplet per column', () => {
  // 8 columns * 3 u32 * 4 bytes = 96 bytes -> 128 base64 chars
  expect(scanCells(8, 3, true).length).toBe(128)
})

test('timeline times are relative to the turn start', () => {
  const step = startStep({ tool: 'Read', tool_use_id: 'r', file_path: '/x' }, 7000)
  expect(stepTime(step, 0)).toBe('0:07')
  expect(LAYOUTS.length).toBe(3)
})
