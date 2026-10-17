// Finds Claude Code session transcripts on disk.
//
// Claude Code stores each session as JSONL at
//   ~/.claude/projects/<project>/<session-id>.jsonl
// where <project> is the working directory with every non-alphanumeric
// character replaced by "-" (CLAUDE_CONFIG_DIR moves ~/.claude).
// https://code.claude.com/docs/en/sessions#where-transcripts-are-stored
//
// The docs say the entry format is internal and changes between versions, so
// everything here reads defensively and skips what it doesn't recognise.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function projectsDir() {
  return path.join(configDir(), 'projects');
}

/** The <project> directory name Claude Code uses for a working directory. */
export function projectKey(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * All transcripts, newest first.
 * @returns {{id:string, file:string, project:string, mtimeMs:number, size:number}[]}
 */
export function listTranscripts(root = projectsDir()) {
  const out = [];
  let projects = [];
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const p of projects) {
    const dir = path.join(root, p.name);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.size === 0) continue;
        out.push({ id: name.slice(0, -6), file, project: p.name, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // Deleted while listing.
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function readSlice(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Partial line at a slice edge.
    }
  }
  return out;
}

const HEAD = 256 * 1024;
const TAIL = 128 * 1024;

/** Title, cwd and first prompt, from the head and tail of a transcript. */
export function describeTranscript(t) {
  let cwd = null;
  let title = null;
  let firstPrompt = null;
  try {
    const head = parseLines(readSlice(t.file, 0, Math.min(HEAD, t.size)));
    const tail = t.size > HEAD ? parseLines(readSlice(t.file, t.size - TAIL, TAIL)) : [];
    for (const e of [...head, ...tail]) {
      if (!cwd && typeof e.cwd === 'string') cwd = e.cwd;
      if (e.type === 'custom-title' && e.customTitle) title = e.customTitle;
      else if (e.type === 'agent-name' && e.agentName && !title) title = e.agentName;
      if (!firstPrompt && e.type === 'user' && !e.isMeta && !e.isSidechain) {
        const text = promptText(e.message?.content);
        if (text) firstPrompt = text;
      }
    }
  } catch {
    // Unreadable file: list it anyway.
  }
  return {
    id: t.id,
    project: t.project,
    cwd,
    title: title || (firstPrompt ? firstPrompt.slice(0, 80) : t.id.slice(0, 8)),
    mtimeMs: t.mtimeMs,
    size: t.size,
  };
}

// Wrappers Claude Code puts around things that aren't the user's own words.
const NOT_A_PROMPT = /^<(local-command-(caveat|stdout|stderr)|command-(name|message|args)|system-reminder|task-notification|bash-(input|stdout|stderr))>/;

/** The user's own words from a user entry's content, or null. */
export function promptText(content) {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((b) => b?.type === 'tool_result')) return null;
    text = content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
  }
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text || NOT_A_PROMPT.test(text)) return null;
  if (/^\[Request interrupted/.test(text)) return null;
  return text;
}

/** Slash command typed by the user ("/model claude-sonnet"), or null. */
export function slashCommand(content) {
  if (typeof content !== 'string') return null;
  const m = /<command-name>([^<]+)<\/command-name>[\s\S]*?(?:<command-args>([^<]*)<\/command-args>)?/.exec(content);
  return m ? `${m[1].trim()}${m[2] ? ' ' + m[2].trim() : ''}` : null;
}

/** Pick a session: an explicit id, else the newest one for cwd, else the newest anywhere. */
export function pickSession(all, { id, cwd } = {}) {
  if (id) return all.find((t) => t.id === id || t.id.startsWith(id)) || null;
  if (cwd) {
    const mine = all.find((t) => t.project === projectKey(cwd));
    if (mine) return mine;
  }
  return all[0] || null;
}
