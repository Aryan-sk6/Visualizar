// Reads <project>/.steer/fixes.jsonl, the log written by inject
// (https://github.com/sk82santhosh-cpu/Inject): one line per message the user
// injected while the agent was working.
//
// visualizar never writes to fixes.jsonl (inject appends to it while running).
// Edits from the Mistakes panel go to a sidecar file, .steer/mistakes.json,
// keyed by a hash of the original line:
//   { "<id>": { "text"?: string, "note"?: string, "hidden"?: boolean } }

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const fixesPath = (cwd) => path.join(cwd, '.steer', 'fixes.jsonl');
export const mistakesPath = (cwd) => path.join(cwd, '.steer', 'mistakes.json');

const idOf = (line) => crypto.createHash('sha1').update(line).digest('hex').slice(0, 16);

/** @returns {object[]} fixes for the project, oldest first, with edits applied */
export function readFixes(cwd) {
  if (!cwd) return [];
  let raw = '';
  try {
    raw = fs.readFileSync(fixesPath(cwd), 'utf8');
  } catch {
    return [];
  }
  const edits = readEdits(cwd);
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let f;
    try {
      f = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof f.text !== 'string') continue;
    const id = idOf(line);
    const edit = edits[id] || {};
    out.push({
      id,
      kind: 'fix',
      ts: f.delivered_at || f.ts || null,
      queuedAt: f.ts || null,
      deliveredAt: f.delivered_at ?? null,
      text: typeof edit.text === 'string' ? edit.text : f.text,
      originalText: f.text,
      note: edit.note || '',
      hidden: Boolean(edit.hidden),
      edited: typeof edit.text === 'string' && edit.text !== f.text,
      urgency: f.urgency === 'urgent' ? 'urgent' : 'normal',
      via: f.delivered_via ?? null,
      doing: f.doing ?? null,
      sessionId: f.session_id ?? null,
    });
  }
  return out;
}

export function readEdits(cwd) {
  try {
    const v = JSON.parse(fs.readFileSync(mistakesPath(cwd), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Saves one edit. Only text, note and hidden are accepted. */
export function saveEdit(cwd, id, patch) {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error('bad id');
  const edits = readEdits(cwd);
  const cur = { ...(edits[id] || {}) };
  if (typeof patch.text === 'string') cur.text = patch.text.slice(0, 2000);
  if (typeof patch.note === 'string') cur.note = patch.note.slice(0, 2000);
  if (typeof patch.hidden === 'boolean') cur.hidden = patch.hidden;
  edits[id] = cur;
  const file = mistakesPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(edits, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return cur;
}
