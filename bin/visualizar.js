#!/usr/bin/env node
// visualizar [--session <id>] [--port <n>] [--no-open] [--ai]
//
// Opens a local browser tab that shows what Claude Code is doing in the
// current directory's newest session, live.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { startServer } from '../src/server.js';
import { listTranscripts, projectsDir } from '../src/sessions.js';

const HELP = `visualizar — watch what your coding agent is doing, live

Usage: visualizar [options]

  --session <id>   follow this session (prefix ok) instead of the newest one
                   for the current directory
  --port <n>       port to listen on (default 4777; the next free one is used)
  --no-open        don't open a browser tab
  --ai             describe unusual tool calls with claude-haiku-5-5, using your
                   own Anthropic credentials (ANTHROPIC_API_KEY or ant auth login).
                   Sends the tool name and a clipped copy of its input only.
  -h, --help       show this help
`;

function parseArgs(argv) {
  const o = { port: 4777, open: true, ai: false, session: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (a === '--no-open') o.open = false;
    else if (a === '--ai') o.ai = true;
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--session') o.session = argv[++i];
    else {
      process.stderr.write(`visualizar: unknown option ${a}\n\n${HELP}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) {
    process.stderr.write('visualizar: --port needs a number between 1 and 65535\n');
    process.exit(2);
  }
  return o;
}

function openBrowser(url) {
  let cmd;
  let args;
  if (process.platform === 'darwin') [cmd, args] = ['open', [url]];
  else if (process.platform === 'win32') [cmd, args] = ['cmd', ['/c', 'start', '', url]];
  else if (fs.existsSync('/proc/version') && /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'))) {
    [cmd, args] = ['cmd.exe', ['/c', 'start', '', url]]; // WSL2
  } else [cmd, args] = ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The URL is printed anyway.
  }
}

const opts = parseArgs(process.argv.slice(2));

if (listTranscripts().length === 0) {
  process.stderr.write(`visualizar: no Claude Code transcripts found in ${projectsDir()}\n`);
  process.exit(1);
}

let ai = null;
if (opts.ai) {
  const { AiDescriber } = await import('../src/ai.js');
  ai = new AiDescriber(() => {});
  if (!(await ai.init())) ai = null;
}

const { url } = await startServer({ port: opts.port, cwd: process.cwd(), sessionId: opts.session, ai });
process.stdout.write(`visualizar: ${url}  (Ctrl+C to stop)\n`);
if (opts.open) openBrowser(url);
