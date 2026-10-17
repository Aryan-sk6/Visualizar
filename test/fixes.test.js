import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readFixes, saveEdit, fixesPath } from '../src/fixes.js';
import { tmpdir } from './helpers.js';

test('reads inject fixes and applies edits from the sidecar, never touching fixes.jsonl', () => {
  const cwd = tmpdir();
  fs.mkdirSync(path.join(cwd, '.steer'));
  const lines = [
    { ts: '2026-10-16T10:00:00Z', text: 'use pnpm', urgency: 'normal', delivered_at: '2026-10-16T10:00:05Z', delivered_via: 'PostToolUse', doing: 'just ran Bash: npm i', session_id: 's1' },
    { ts: '2026-10-16T10:01:00Z', text: 'stop', urgency: 'urgent', delivered_at: null, delivered_via: null, session_id: 's1' },
    'not json',
  ];
  fs.writeFileSync(fixesPath(cwd), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  const before = fs.readFileSync(fixesPath(cwd), 'utf8');

  let fixes = readFixes(cwd);
  assert.equal(fixes.length, 2);
  assert.equal(fixes[0].ts, '2026-10-16T10:00:05Z', 'placed at delivery time');
  assert.equal(fixes[1].ts, '2026-10-16T10:01:00Z', 'undelivered falls back to queue time');

  saveEdit(cwd, fixes[0].id, { text: 'always use pnpm', note: 'npm broke the lockfile', hidden: true, evil: 'x' });
  fixes = readFixes(cwd);
  assert.equal(fixes[0].text, 'always use pnpm');
  assert.equal(fixes[0].originalText, 'use pnpm');
  assert.equal(fixes[0].note, 'npm broke the lockfile');
  assert.equal(fixes[0].hidden, true);
  assert.equal(fixes[0].edited, true);
  assert.equal(fs.readFileSync(fixesPath(cwd), 'utf8'), before);
  assert.throws(() => saveEdit(cwd, '../../etc', {}), /bad id/);
  assert.deepEqual(readFixes(path.join(cwd, 'nope')), []);
});
