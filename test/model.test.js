import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SessionModel } from '../src/model.js';
import { translate, friendlyName, _test } from '../src/translate.js';
import { tmpdir, prompt, toolUse, toolResult, say, title, writeTranscript, append } from './helpers.js';

test('parses prompts, tools, results and messages incrementally', () => {
  const dir = tmpdir();
  const cwd = '/work/app';
  const file = path.join(dir, 's.jsonl');
  writeTranscript(file, [
    title('Fix the header'),
    prompt(cwd, '2026-10-16T10:00:00.000Z', 'Make the top card bigger'),
    { type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>x</local-command-caveat>' } },
    toolUse(cwd, '2026-10-16T10:00:02.000Z', 't1', 'Edit', { file_path: `${cwd}/src/TopCard.tsx`, old_string: 'a\nb', new_string: 'a\nb\nc' }),
  ]);
  const m = new SessionModel(file);
  let r = m.update();
  assert.equal(r.changed.length, 2);
  assert.equal(m.meta.title, 'Fix the header');
  assert.equal(m.meta.cwd, cwd);
  assert.equal(m.currentActivity().kind, 'tool');
  assert.equal(m.steps.get('t1').status, 'running');

  // A half-written line must wait for the rest.
  const line = JSON.stringify(toolResult(cwd, '2026-10-16T10:00:03.000Z', 't1', 'ok', { toolUseResult: { structuredPatch: [{ lines: [' a', ' b', '+c'] }] } }));
  fs.appendFileSync(file, line.slice(0, 20));
  assert.equal(m.update().changed.length, 0);
  fs.appendFileSync(file, line.slice(20) + '\n');
  r = m.update();
  assert.equal(r.changed[0].id, 't1');
  assert.equal(m.steps.get('t1').status, 'done');
  assert.equal(m.steps.get('t1').result.added, 1);

  append(file, [say(cwd, '2026-10-16T10:00:05.000Z', 'Done. The card is bigger now.')]);
  m.update();
  assert.equal(m.currentActivity().kind, 'idle');
  assert.deepEqual(m.all().map((s) => s.kind), ['prompt', 'tool', 'message']);
});

test('marks a tool call blocked by an inject fix', () => {
  const dir = tmpdir();
  const file = path.join(dir, 's.jsonl');
  writeTranscript(file, [
    toolUse('/w', '2026-10-16T10:00:00.000Z', 't1', 'Bash', { command: 'npm install', description: 'Install deps' }),
    toolResult('/w', '2026-10-16T10:00:01.000Z', 't1', 'PreToolUse:Bash hook error: [inject] This tool call was blocked', { isError: true }),
  ]);
  const m = new SessionModel(file);
  m.update();
  const s = translate(m.steps.get('t1'), { cwd: '/w' });
  assert.equal(s.blockedByFix, true);
  assert.match(s.view.vibe, /stopped by your fix/);
  assert.equal(s.input, undefined, 'raw input is not sent to the browser');
});

test('rule-based translation at three levels', () => {
  const cwd = '/w';
  const t = (name, input, extra = {}) => translate({ id: 'x', kind: 'tool', ts: 't', status: 'done', name, input, ...extra }, { cwd }).view;

  let v = t('Edit', { file_path: '/w/src/components/TopCard.tsx', old_string: 'a', new_string: 'a\nb' });
  assert.equal(v.simple, 'Building the top card');
  assert.match(v.vibe, /`src\/components\/TopCard.tsx` — swapped 1 line for 2/);
  assert.equal(v.eng.title, 'Edit src/components/TopCard.tsx');
  assert.match(v.eng.body, /^- a\n\+ a\n\+ b$/);

  assert.equal(t('Write', { file_path: '/w/src/session.js', content: 'x\ny' }).simple, 'Creating the session code');
  assert.equal(t('Read', { file_path: '/w/README.md' }).simple, 'Reading the README');
  assert.equal(t('Bash', { command: 'npm test', description: 'Run the test suite' }).simple, 'Running the tests');
  assert.equal(t('Bash', { command: 'npm test', description: 'Run the test suite' }).vibe, 'Run the test suite → ok');
  assert.equal(t('Bash', { command: 'cd app && git commit -m x' }).simple, 'Saving a checkpoint');
  assert.equal(t('Grep', { pattern: 'useAuth' }).simple, 'Searching the code for “useAuth”');
  assert.equal(t('WebFetch', { url: 'https://docs.example.com/a' }).simple, 'Reading docs.example.com');
  assert.equal(t('Task', { description: 'Find the auth bug', subagent_type: 'Explore' }).simple, 'Sending a helper to find the auth bug');
  assert.equal(t('TodoWrite', { todos: [{ content: 'Style the footer', status: 'in_progress' }] }).simple, 'Next up: style the footer');

  const unknown = t('mcp__linear__create_issue', { title: 'Bug' });
  assert.equal(unknown.known, false);
  assert.equal(unknown.simple, 'Using linear: create issue');
  const ai = translate({ id: 'x', kind: 'tool', status: 'done', name: 'mcp__linear__create_issue', input: {} }, { cwd, ai: { simple: 'Filing a bug ticket', vibe: 'Opened a Linear issue' } }).view;
  assert.equal(ai.simple, 'Filing a bug ticket');
  assert.equal(ai.ai, true);

  assert.equal(friendlyName('/w/app/dashboard/page.tsx'), 'dashboard page');
  assert.equal(friendlyName('/w/src/auth.test.ts'), 'tests for the auth');
  assert.equal(_test.classifyShell('pnpm install').kind, 'install');
});
