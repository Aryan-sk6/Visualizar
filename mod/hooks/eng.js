// Engineer level: a quick-look technical summary of a step, not a raw dump.
//   head   the call in one line: "Edit src/TopCard.tsx", "$ npm test"
//   facts  short chips: "+5 −3 lines", "exit ok", "1.2s", "12 matches"
//   lines  a few lines worth seeing: changed lines (add/del) or key output
// Pure: works from the step's input and the small result kept by slimResult().

const MAX_LINE = 110

const clipLine = (s) => {
  const t = String(s ?? '').replace(/\t/g, '  ').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  return t.length > MAX_LINE ? t.slice(0, MAX_LINE - 1) + '…' : t
}
const lineCount = (s) => (typeof s === 'string' && s ? s.split('\n').length : 0)
const nonEmpty = (s) => String(s || '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim())

function rel(file, cwd) {
  if (!file) return ''
  const f = String(file)
  if (cwd && f.startsWith(cwd + '/')) return f.slice(cwd.length + 1)
  const home = f.match(/^\/Users\/[^/]+\/|^\/home\/[^/]+\//)
  return home ? '~/' + f.slice(home[0].length) : f
}

function dur(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null
  return ms < 1000 ? `${Math.round(ms)}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

/** Keeps the parts of a tool.call result the summary uses. */
export function slimResult(ran) {
  if (!ran) return null
  if (typeof ran.deny === 'string') return { isError: true, output: ran.deny.slice(-800) }
  const r = ran.result
  const out = {}
  let text = ''
  if (typeof r === 'string') text = r
  else if (r && typeof r === 'object') {
    if (typeof r.stdout === 'string') text = r.stdout
    if (typeof r.stderr === 'string' && r.stderr.trim()) out.stderr = r.stderr.slice(-400)
    if (!text && typeof r.content === 'string') text = r.content
    if (!text && typeof r.output === 'string') text = r.output
    if (!text && Array.isArray(r.filenames)) text = r.filenames.join('\n')
    for (const k of ['numFiles', 'numLines', 'numMatches', 'durationMs', 'type', 'interrupted']) {
      if (typeof r[k] === 'number' || typeof r[k] === 'string' || typeof r[k] === 'boolean') out[k] = r[k]
    }
    if (r.file && typeof r.file === 'object' && typeof r.file.numLines === 'number') out.numLines = r.file.numLines
    if (Array.isArray(r.structuredPatch)) {
      let added = 0
      let removed = 0
      for (const h of r.structuredPatch) for (const l of h?.lines || []) {
        if (l.startsWith('+')) added++
        else if (l.startsWith('-')) removed++
      }
      out.added = added
      out.removed = removed
    }
  }
  if (text) out.output = text.slice(-800)
  if (ran.isError) out.isError = true
  return out
}

// A test runner's summary line, if the output has one.
function testSummary(text) {
  const lines = nonEmpty(text)
  const re = /(\d+\s+(passed|passing|failed|failing|pass|fail|tests?|errors?)\b)|(Tests?:\s+\d)|(ℹ (pass|fail) \d+)|(\bok\b.*\d+ tests?)/i
  const hits = lines.filter((l) => re.test(l))
  return hits.slice(-2)
}

/** @returns {{head:string, facts:string[], lines:{t:string,k:'add'|'del'|'out'|'err'}[]}} */
export function engSummary(step, cwd) {
  const i = step.input || {}
  const r = step.result || {}
  const name = step.name
  const facts = []
  const lines = []
  const ok = step.status !== 'error'
  const d = dur(r.durationMs ?? (step.endedAt && step.startedAt > 1e12 ? step.endedAt - step.startedAt : NaN))
  const out = r.output || ''
  const tail = (n) => nonEmpty(out).slice(-n).forEach((t) => lines.push({ t: clipLine(t), k: ok ? 'out' : 'err' }))

  if (step.kind === 'prompt') return { head: 'prompt', facts: [`${lineCount(step.text)} lines`], lines: nonEmpty(step.text).slice(0, 3).map((t) => ({ t: clipLine(t), k: 'out' })) }
  if (step.kind === 'fix') return { head: `fix · ${step.urgent ? 'urgent' : 'note'}`, facts: [step.deliveredAt ? 'delivered' : 'logged'], lines: [{ t: clipLine(step.text), k: 'out' }] }

  switch (name) {
    case 'Edit':
    case 'MultiEdit': {
      const edits = name === 'MultiEdit' && Array.isArray(i.edits) ? i.edits : [i]
      const removed = r.removed ?? edits.reduce((a, e) => a + lineCount(e.old_string), 0)
      const added = r.added ?? edits.reduce((a, e) => a + lineCount(e.new_string), 0)
      facts.push(`+${added} −${removed} lines`)
      if (edits.length > 1) facts.push(`${edits.length} edits`)
      if (i.replace_all) facts.push('replace all')
      const e0 = edits[0] || {}
      nonEmpty(e0.old_string).slice(0, 3).forEach((t) => lines.push({ t: clipLine(t), k: 'del' }))
      nonEmpty(e0.new_string).slice(0, 4).forEach((t) => lines.push({ t: clipLine(t), k: 'add' }))
      return { head: `${name} ${rel(i.file_path, cwd)}`, facts, lines }
    }
    case 'Write': {
      facts.push(`${lineCount(i.content)} lines`)
      if (r.type) facts.push(r.type === 'create' ? 'new file' : 'overwrote')
      nonEmpty(i.content).slice(0, 4).forEach((t) => lines.push({ t: clipLine(t), k: 'add' }))
      return { head: `Write ${rel(i.file_path, cwd)}`, facts, lines }
    }
    case 'Read': {
      if (i.offset || i.limit) facts.push(`lines ${i.offset || 1}–${(i.offset || 1) + (i.limit || 0) - 1 || '…'}`)
      if (r.numLines) facts.push(`${r.numLines} lines read`)
      return { head: `Read ${rel(i.file_path, cwd)}`, facts, lines }
    }
    case 'Bash': {
      const cmd = String(i.command || '').split('\n')[0]
      facts.push(step.status === 'running' ? 'running' : ok ? 'exit ok' : 'failed')
      if (d) facts.push(d)
      if (i.run_in_background) facts.push('background')
      if (r.interrupted) facts.push('interrupted')
      const summary = testSummary(out)
      if (summary.length) summary.forEach((t) => lines.push({ t: clipLine(t.trim()), k: ok ? 'out' : 'err' }))
      else tail(3)
      if (r.stderr && !ok) nonEmpty(r.stderr).slice(-2).forEach((t) => lines.push({ t: clipLine(t), k: 'err' }))
      return { head: `$ ${clipLine(cmd)}`, facts, lines }
    }
    case 'Grep':
    case 'Glob': {
      if (i.path) facts.push(`in ${rel(i.path, cwd)}`)
      if (i.glob || i.type) facts.push(String(i.glob || i.type))
      const n = r.numFiles ?? r.numMatches ?? (out ? nonEmpty(out).length : null)
      if (n != null) facts.push(`${n} ${name === 'Glob' ? 'files' : 'matches'}`)
      nonEmpty(out).slice(0, 3).forEach((t) => lines.push({ t: clipLine(rel(t, cwd)), k: 'out' }))
      return { head: `${name} ${clipLine(i.pattern)}`, facts, lines }
    }
    case 'WebFetch': {
      let host = String(i.url || '')
      try {
        const u = new URL(host)
        host = u.host + u.pathname
      } catch {}
      return { head: `fetch ${clipLine(host)}`, facts: d ? [d] : [], lines: i.prompt ? [{ t: clipLine(i.prompt), k: 'out' }] : [] }
    }
    case 'WebSearch':
      return { head: `search “${clipLine(i.query)}”`, facts, lines: [] }
    case 'Task':
    case 'Agent':
      return { head: `agent ${i.subagent_type || 'general'}`, facts: d ? [d] : [], lines: [{ t: clipLine(i.description || i.prompt), k: 'out' }] }
    case 'TodoWrite':
    case 'mcp__ccd_turn__update_plan': {
      const items = i.todos || i.items || []
      if (Array.isArray(items) && items.length) {
        facts.push(`${items.filter((t) => t.status === 'completed').length}/${items.length} done`)
        const now = items.find((t) => t.status === 'in_progress')
        if (now) lines.push({ t: clipLine('▶ ' + (now.content || now.activeForm)), k: 'out' })
      }
      return { head: 'plan', facts, lines }
    }
  }

  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  const args = Object.entries(i)
    .filter(([, v]) => typeof v !== 'object')
    .slice(0, 3)
    .map(([k, v]) => `${k}=${clipLine(String(v)).slice(0, 40)}`)
  if (d) facts.push(d)
  if (!ok) facts.push('failed')
  args.forEach((a) => lines.push({ t: a, k: 'out' }))
  if (!ok) tail(2)
  return { head: m ? `${m[1]} · ${m[2]}` : name, facts, lines }
}
