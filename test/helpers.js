// Builds transcripts shaped like Claude Code 2.1.x's JSONL entries.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SID = '11111111-2222-3333-4444-555555555555';

export function tmpdir(prefix = 'viz-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

let n = 0;
const base = (cwd, ts, extra = {}) => ({ uuid: `u${++n}`, sessionId: SID, cwd, version: '2.1.299', gitBranch: 'main', isSidechain: false, timestamp: ts, ...extra });

export const prompt = (cwd, ts, text) => base(cwd, ts, { type: 'user', promptId: 'p1', message: { role: 'user', content: text } });
export const toolUse = (cwd, ts, id, name, input) =>
  base(cwd, ts, { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } });
export const toolResult = (cwd, ts, id, text, { isError = false, toolUseResult } = {}) =>
  base(cwd, ts, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] }, toolUseResult });
export const say = (cwd, ts, text, end = true) =>
  base(cwd, ts, { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: end ? 'end_turn' : null, content: [{ type: 'text', text }] } });
export const title = (t) => ({ type: 'custom-title', customTitle: t, sessionId: SID });

export function writeTranscript(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
export function append(file, entries) {
  fs.appendFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
