import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { SID, tmpdir, prompt, toolUse, toolResult, writeTranscript, append } from './helpers.js';

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function sse(port, p) {
  const events = [];
  let req;
  const ready = new Promise((resolve) => {
    req = http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(chunk)?.[1];
          const data = /^data: (.+)$/m.exec(chunk)?.[1];
          if (ev) events.push({ ev, data: JSON.parse(data) });
        }
      });
      resolve();
    });
  });
  return { events, ready, close: () => req.destroy() };
}

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

test('serves the UI, streams a live session, and guards writes', async () => {
  const root = tmpdir();
  const project = tmpdir('viz-proj-');
  process.env.CLAUDE_CONFIG_DIR = root;
  const file = path.join(root, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'), `${SID}.jsonl`);
  writeTranscript(file, [prompt(project, '2026-10-16T10:00:00Z', 'Build the top card')]);
  fs.mkdirSync(path.join(project, '.steer'));
  fs.writeFileSync(path.join(project, '.steer', 'fixes.jsonl'), JSON.stringify({ ts: '2026-10-16T10:00:01Z', text: 'make it blue', urgency: 'normal', session_id: SID }) + '\n');

  const { startServer } = await import('../src/server.js');
  const { server, port } = await startServer({ port: 0, cwd: project });
  try {
    const page = await get(port, '/');
    assert.equal(page.status, 200);
    const token = /name="token" content="([0-9a-f]+)"/.exec(page.body)[1];
    assert.equal((await get(port, '/api/sessions', { host: 'evil.test' })).status, 403, 'DNS rebinding guard');
    assert.equal(JSON.parse((await get(port, '/api/sessions')).body).sessions[0].id, SID);

    const s = sse(port, '/events');
    await s.ready;
    await until(() => s.events.some((e) => e.ev === 'snapshot'));
    const snap = s.events.find((e) => e.ev === 'snapshot').data;
    assert.equal(snap.steps.length, 1);
    assert.equal(snap.fixes[0].text, 'make it blue');

    append(file, [toolUse(project, '2026-10-16T10:00:02Z', 't1', 'Write', { file_path: `${project}/src/TopCard.tsx`, content: 'x' })]);
    await until(() => s.events.some((e) => e.ev === 'steps' && e.data.steps.some((x) => x.id === 't1')));
    await until(() => s.events.some((e) => e.ev === 'activity' && e.data.kind === 'tool'));
    append(file, [toolResult(project, '2026-10-16T10:00:03Z', 't1', 'created')]);
    await until(() => s.events.some((e) => e.ev === 'steps' && e.data.steps.some((x) => x.id === 't1' && x.status === 'done')));

    // Mistakes edit: needs the page token.
    const post = (headers) =>
      new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/mistakes', method: 'POST', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.end(JSON.stringify({ session: SID, id: snap.fixes[0].id, note: 'remember blue' }));
      });
    assert.equal(await post({}), 403);
    assert.equal(await post({ 'x-token': token }), 200);
    await until(() => s.events.some((e) => e.ev === 'fixes' && e.data.fixes[0].note === 'remember blue'));
    s.close();
  } finally {
    server.close();
  }
});
