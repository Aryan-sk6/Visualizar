// Turns transcript entries into steps the UI can show.
//
// A step is one of:
//   prompt   something you asked
//   command  a slash command you ran
//   tool     a tool call (Edit, Bash, Read, ...) and, once it finishes, its result
//   message  text Claude wrote to you
//
// Reads the file incrementally: update() parses only bytes appended since the
// last call and returns the steps that are new or changed.

import fs from 'node:fs';
import { promptText, slashCommand } from './sessions.js';

const OUTPUT_LIMIT = 6000;

export class SessionModel {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.partial = '';
    /** @type {Map<string, object>} */
    this.steps = new Map();
    this.order = [];
    this.meta = { sessionId: null, cwd: null, title: null, version: null, gitBranch: null, model: null };
    // What Claude is doing right now, from the last entries seen.
    this.activity = { kind: 'idle', since: null, last: null };
    this.lastEntryTs = null;
  }

  /** @returns {{changed: object[], metaChanged: boolean}} */
  update() {
    let size;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return { changed: [], metaChanged: false };
    }
    if (size < this.offset) {
      // Truncated or replaced: start over.
      this.offset = 0;
      this.partial = '';
      this.steps.clear();
      this.order = [];
    }
    if (size === this.offset) return { changed: [], metaChanged: false };

    const fd = fs.openSync(this.file, 'r');
    let text;
    try {
      const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      text = this.partial + buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    this.offset = size;
    const lines = text.split('\n');
    this.partial = lines.pop();

    const changed = new Set();
    const metaBefore = JSON.stringify(this.meta);
    for (const line of lines) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      for (const s of this.ingest(e)) changed.add(s);
    }
    return { changed: [...changed], metaChanged: JSON.stringify(this.meta) !== metaBefore };
  }

  add(step) {
    if (!this.steps.has(step.id)) this.order.push(step.id);
    this.steps.set(step.id, step);
    return step;
  }

  all() {
    return this.order.map((id) => this.steps.get(id));
  }

  /** @returns {object[]} steps created or changed by this entry */
  ingest(e) {
    const out = [];
    if (e.sessionId && !this.meta.sessionId) this.meta.sessionId = e.sessionId;
    if (typeof e.cwd === 'string' && !this.meta.cwd) this.meta.cwd = e.cwd;
    if (e.version) this.meta.version = e.version;
    if (e.gitBranch) this.meta.gitBranch = e.gitBranch;
    if (e.type === 'custom-title' && e.customTitle) this.meta.title = e.customTitle;
    if (e.type === 'agent-name' && e.agentName && !this.meta.title) this.meta.title = e.agentName;
    if (e.timestamp) this.lastEntryTs = e.timestamp;

    const ts = e.timestamp || this.lastEntryTs;
    const side = Boolean(e.isSidechain);
    const content = e.message?.content;

    if (e.type === 'user') {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type !== 'tool_result') continue;
          const step = this.steps.get(b.tool_use_id);
          if (!step) continue;
          step.endTs = ts;
          step.status = b.is_error ? 'error' : 'done';
          step.output = resultText(b.content);
          step.result = slimResult(e.toolUseResult);
          if (/\[inject\]/.test(step.output) && b.is_error) step.blockedByFix = true;
          out.push(step);
          this.setActivity('thinking', ts, step.id);
        }
      }
      if (e.isMeta) return out;
      const cmd = slashCommand(content);
      if (cmd && !side) {
        out.push(this.add({ id: e.uuid || `cmd-${ts}`, kind: 'command', ts, text: cmd }));
        return out;
      }
      const text = promptText(content);
      if (text && !side) {
        out.push(this.add({ id: e.uuid || `p-${ts}`, kind: 'prompt', ts, text }));
        this.setActivity('thinking', ts, null);
      }
      if (typeof content === 'string' && /^\[Request interrupted/.test(content)) {
        this.setActivity('idle', ts, null);
      }
      return out;
    }

    if (e.type === 'assistant' && Array.isArray(content)) {
      if (e.message?.model && !side) this.meta.model = e.message.model;
      content.forEach((b, i) => {
        if (b?.type === 'tool_use') {
          const step = this.add({
            id: b.id,
            kind: 'tool',
            ts,
            endTs: null,
            status: 'running',
            name: String(b.name || 'tool'),
            input: b.input && typeof b.input === 'object' ? b.input : {},
            side,
          });
          out.push(step);
          if (!side) this.setActivity('tool', ts, step.id);
        } else if (b?.type === 'text' && b.text && b.text.trim() && !side) {
          out.push(this.add({ id: `${e.uuid || ts}-${i}`, kind: 'message', ts, text: b.text.trim() }));
          const end = e.message?.stop_reason === 'end_turn';
          this.setActivity(end ? 'idle' : 'writing', ts, null);
        } else if (b?.type === 'thinking' && !side) {
          this.setActivity('thinking', ts, null);
        }
      });
      if (e.message?.stop_reason === 'end_turn' && !side) this.setActivity('idle', ts, null);
      return out;
    }

    if (e.type === 'system' && e.subtype === 'stop_hook_summary') {
      // Claude Code writes this when a turn ends.
      this.setActivity('idle', ts, null);
    }
    return out;
  }

  setActivity(kind, since, stepId) {
    this.activity = { kind, since, stepId };
  }

  /** Activity, corrected for tool calls still waiting on a result. */
  currentActivity() {
    const a = { ...this.activity };
    if (a.kind !== 'tool') {
      // A later message may have arrived while a parallel tool is still running.
      const running = this.all().filter((s) => s.kind === 'tool' && s.status === 'running' && !s.side);
      if (running.length && a.kind !== 'idle') return { kind: 'tool', since: running.at(-1).ts, stepId: running.at(-1).id };
    }
    return a;
  }
}

function resultText(content) {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : b?.type === 'tool_reference' ? `[${b.tool_name}]` : ''))
      .filter(Boolean)
      .join('\n');
  }
  return clip(text, OUTPUT_LIMIT);
}

// Keep the parts of toolUseResult the translator uses; drop large blobs.
function slimResult(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const out = {};
  for (const k of ['type', 'filePath', 'interrupted', 'numFiles', 'numLines', 'numMatches', 'durationMs', 'code', 'totalDurationMs']) {
    if (r[k] !== undefined && typeof r[k] !== 'object') out[k] = r[k];
  }
  if (typeof r.stderr === 'string' && r.stderr) out.stderr = clip(r.stderr, 1500);
  if (Array.isArray(r.structuredPatch)) {
    let added = 0;
    let removed = 0;
    for (const h of r.structuredPatch) {
      for (const l of h?.lines || []) {
        if (l.startsWith('+')) added++;
        else if (l.startsWith('-')) removed++;
      }
    }
    out.added = added;
    out.removed = removed;
  }
  if (typeof r.content === 'string' && r.type === 'create') out.lines = r.content.split('\n').length;
  if (r.file && typeof r.file === 'object' && typeof r.file.numLines === 'number') out.numLines = r.file.numLines;
  return out;
}

export function clip(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s;
}
