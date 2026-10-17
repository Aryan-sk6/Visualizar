// Local HTTP server: serves the UI and streams session updates over
// Server-Sent Events. Binds to 127.0.0.1 only.
//
// Read-only with respect to the agent: it reads transcripts and fixes.jsonl and
// never writes to them. The only write is Mistakes-panel edits, which go to
// <project>/.steer/mistakes.json.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeTranscript, listTranscripts, pickSession, projectsDir } from './sessions.js';
import { SessionModel } from './model.js';
import { translate } from './translate.js';
import { fixesPath, mistakesPath, readFixes, saveEdit } from './fixes.js';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const POLL_MS = 300;
const STATIC = {
  '/app.js': 'text/javascript',
  '/styles.css': 'text/css',
  '/icons.js': 'text/javascript',
};

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

class Watcher {
  constructor(transcript, ai) {
    this.t = transcript;
    this.ai = ai;
    this.model = new SessionModel(transcript.file);
    this.clients = new Set();
    this.fixes = [];
    this.fixStamp = '';
    this.timer = null;
    this.lastActivity = '';
  }

  view(step) {
    const cwd = this.model.meta.cwd;
    let v = translate(step, { cwd });
    if (this.ai && step.kind === 'tool' && !v.view.known) {
      const d = this.ai.get(step);
      if (d) v = translate(step, { cwd, ai: d });
    }
    return v;
  }

  start() {
    this.model.update();
    this.refreshFixes();
    this.timer = setInterval(() => this.tick(), POLL_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  refreshFixes() {
    const cwd = this.model.meta.cwd;
    if (!cwd) return false;
    const stamp = `${mtime(fixesPath(cwd))}:${mtime(mistakesPath(cwd))}`;
    if (stamp === this.fixStamp) return false;
    this.fixStamp = stamp;
    this.fixes = readFixes(cwd);
    return true;
  }

  activity() {
    return { ...this.model.currentActivity(), lastEntryTs: this.model.lastEntryTs };
  }

  snapshot() {
    return {
      session: { id: this.t.id, file: this.t.file },
      meta: this.model.meta,
      steps: this.model.all().map((s) => this.view(s)),
      activity: this.activity(),
      fixes: this.fixes,
    };
  }

  tick() {
    const { changed, metaChanged } = this.model.update();
    if (changed.length) this.send('steps', { steps: changed.map((s) => this.view(s)) });
    if (metaChanged) this.send('meta', this.model.meta);
    if (this.refreshFixes()) this.send('fixes', { fixes: this.fixes });
    const a = JSON.stringify(this.activity());
    if (a !== this.lastActivity) {
      this.lastActivity = a;
      this.send('activity', JSON.parse(a));
    }
  }

  restep(stepId) {
    const s = this.model.steps.get(stepId);
    if (s) this.send('steps', { steps: [this.view(s)] });
  }

  send(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(msg);
  }
}

/**
 * @param {{port:number, cwd:string, sessionId?:string, ai?:import('./ai.js').AiDescriber|null}} opts
 */
export async function startServer({ port, cwd, sessionId, ai = null }) {
  const token = crypto.randomBytes(16).toString('hex');
  // A --session prefix resolves to the full id once, so the page's picker can show it.
  const pinnedT = sessionId ? pickSession(listTranscripts(), { id: sessionId }) : null;
  const pinned = pinnedT ? pinnedT.id.replace(/[^\w-]/g, '') : '';
  /** @type {Map<string, Watcher>} */
  const watchers = new Map();
  let boundPort = port;

  if (ai) ai.onReady = (stepId) => { for (const w of watchers.values()) w.restep(stepId); };

  function watcherFor(id) {
    const all = listTranscripts();
    const t = pickSession(all, id ? { id } : { cwd });
    if (!t) return null;
    let w = watchers.get(t.id);
    if (!w) {
      w = new Watcher(t, ai);
      w.start();
      watchers.set(t.id, w);
    }
    return w;
  }

  // Projects visualizar has seen, so edits can only target a real project dir.
  function knownProjectFor(id) {
    const w = watchers.get(id);
    return w?.model.meta.cwd || null;
  }

  const server = http.createServer(async (req, res) => {
    // Block DNS rebinding: only answer requests addressed to us by loopback name.
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const url = new URL(req.url, `http://${host}`);
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace('__TOKEN__', token).replace('__SESSION__', pinned);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
        return;
      }
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const body = fs.readFileSync(path.join(PUBLIC, url.pathname.slice(1)));
        res.writeHead(200, { 'content-type': `${STATIC[url.pathname]}; charset=utf-8`, 'cache-control': 'no-store' }).end(body);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        const list = listTranscripts().slice(0, 40).map(describeTranscript);
        json(res, 200, { sessions: list, cwd, projectsDir: projectsDir() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        const w = watcherFor(url.searchParams.get('session') || sessionId);
        if (!w) {
          json(res, 404, { error: `No Claude Code transcripts found in ${projectsDir()}` });
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.write(`event: snapshot\ndata: ${JSON.stringify(w.snapshot())}\n\n`);
        w.clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => {
          clearInterval(ping);
          w.clients.delete(res);
          if (w.clients.size === 0) {
            w.stop();
            watchers.delete(w.t.id);
          }
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/mistakes') {
        if (req.headers['x-token'] !== token) {
          json(res, 403, { error: 'bad token' });
          return;
        }
        const body = JSON.parse(await readBody(req, 64 * 1024));
        const project = knownProjectFor(body.session);
        if (!project) {
          json(res, 400, { error: 'unknown session' });
          return;
        }
        const saved = saveEdit(project, String(body.id || ''), body);
        const w = watchers.get(body.session);
        if (w && w.refreshFixes()) w.send('fixes', { fixes: w.fixes });
        json(res, 200, { saved });
        return;
      }
      res.writeHead(404).end('not found');
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });

  boundPort = await listenOnFreePort(server, port);
  return { server, port: boundPort, url: `http://127.0.0.1:${boundPort}/` };
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(data));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function listenOnFreePort(server, start) {
  return new Promise((resolve, reject) => {
    let port = start;
    const attempt = () => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && port < start + 20) {
          port++;
          attempt();
        } else reject(err);
      });
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    };
    attempt();
  });
}
