// Optional: describe unusual tool calls (MCP tools, tools the rules don't know)
// with a cheap model, using the user's own Anthropic credentials.
//
// Off unless the user passes --ai. Never required: without it, or if a call
// fails, the rule-based generic description stays. Only the tool name and a
// clipped copy of its input are sent, never tool output or file contents.

const MODEL = 'claude-haiku-5-5';
const INPUT_LIMIT = 1200;

export class AiDescriber {
  /** @param {(stepId:string)=>void} onReady called when a description arrives */
  constructor(onReady) {
    this.onReady = onReady;
    this.cache = new Map(); // key -> {simple, vibe} | 'pending' | 'failed'
    this.client = null;
    this.disabled = false;
    this.inflight = 0;
    this.queue = [];
    this.warned = false;
  }

  async init() {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      this.client = new Anthropic();
      return true;
    } catch (err) {
      this.disabled = true;
      this.warn(`AI descriptions are off: ${err.message}`);
      return false;
    }
  }

  warn(msg) {
    if (this.warned) return;
    this.warned = true;
    process.stderr.write(`visualizar: ${msg}\n`);
  }

  key(step) {
    return `${step.name}\n${JSON.stringify(step.input).slice(0, INPUT_LIMIT)}`;
  }

  /** Cached description for a step, or null; schedules a request if needed. */
  get(step) {
    if (this.disabled || !this.client) return null;
    const k = this.key(step);
    const hit = this.cache.get(k);
    if (hit && typeof hit === 'object') return hit;
    if (!hit) {
      this.cache.set(k, 'pending');
      this.queue.push({ k, stepId: step.id, name: step.name, input: step.input });
      this.pump();
    }
    return null;
  }

  pump() {
    while (this.inflight < 2 && this.queue.length) {
      const job = this.queue.shift();
      this.inflight++;
      this.describe(job)
        .then((d) => {
          this.cache.set(job.k, d);
          this.onReady(job.stepId);
        })
        .catch((err) => {
          this.cache.set(job.k, 'failed');
          const status = err?.status;
          if (status === 401 || status === 403 || (!status && /authentication/i.test(err.message))) {
            this.disabled = true;
            this.queue = [];
            this.warn(
              status
                ? 'AI descriptions are off: the API rejected your credentials.'
                : 'AI descriptions are off: no Anthropic credentials found (set ANTHROPIC_API_KEY or run `ant auth login`).',
            );
          } else {
            this.warn(`an AI description failed (${status || err.message}); using the generic text.`);
          }
        })
        .finally(() => {
          this.inflight--;
          this.pump();
        });
    }
  }

  async describe({ name, input }) {
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      output_config: { effort: 'low' },
      system:
        'You label steps taken by an AI coding agent for a dashboard. Given one tool call, reply with only a JSON object: ' +
        '{"simple": "<= 7 words, present tense -ing phrase a non-programmer understands, e.g. \\"Opening the login page\\"", ' +
        '"vibe": "<= 18 words, friendly past-tense summary that names the specific thing touched"}. No other text.',
      messages: [
        {
          role: 'user',
          content: `Tool: ${name}\nInput: ${JSON.stringify(input).slice(0, INPUT_LIMIT)}`,
        },
      ],
    });
    if (response.stop_reason === 'refusal') throw new Error('refused');
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const clean = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');
    const out = { simple: clean(json.simple, 80), vibe: clean(json.vibe, 200) };
    if (!out.simple) throw new Error('empty description');
    return out;
  }
}
