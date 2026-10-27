// The YourTeam state machine. It runs one headless Claude build session at a time, moving the
// project through interview -> spec -> plan -> phases (build, fix, QA, gates) -> done.
// A separate chat channel (CEO interview, CTO chat) can run next to a build session.
// All state is on disk, so the dashboard and a restarted orchestrator see the same thing.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolveClaudeBin, runClaude, toEntries } from './claude.mjs';
import * as git from './git.mjs';
import * as P from './prompts.mjs';
import { AppRunner } from './apprunner.mjs';
import { LESSONS_FILE, USER_DIR, MOCK_CLAUDE } from './paths.mjs';

export const DEFAULT_CONFIG = {
  models: { ceo: 'opus', cto: 'opus', ctoChat: 'sonnet', qa: 'sonnet', default: 'sonnet' },
  budget: { perSessionUsd: 10, totalUsd: null },
  limits: { maxContinuations: 4, maxFixRounds: 3, maxQaRounds: 3, maxSessionFailures: 2, planRetries: 2 },
  approval: { spec: true, plan: true },
  permissions: { mode: 'acceptEdits', skipAll: false },
  git: { enabled: true, autoInit: true },
  claude: { bin: null, effort: null, loadMcp: false, disableSkills: false, extraArgs: [] },
  retro: true,
  autoResume: false,
};

const DEV_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'PowerShell', 'WebSearch', 'WebFetch', 'TodoWrite'];
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'PowerShell'];
const CORE_AGENTS = {
  ceo: { id: 'ceo', name: 'CEO', template: 'ceo', tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'WebSearch', 'WebFetch'], restrict: true },
  cto: { id: 'cto', name: 'CTO', template: 'cto', tools: DEV_TOOLS },
};
const WAITING = ['interview', 'spec_review', 'plan_review', 'awaiting_answer', 'awaiting_approval', 'escalated', 'paused', 'done', 'error'];
const CTO_CHAT_OK = ['plan_review', 'running', 'paused', 'awaiting_answer', 'awaiting_approval', 'escalated', 'done', 'error', 'finishing'];
const CO_TYPES = ['fix', 'add-phase', 'update-phase', 'remove-phase', 'add-agent', 'message', 'spec-change'];

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = k in base && typeof base[k] === 'object' && base[k] && !Array.isArray(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

const now = () => new Date().toISOString();
const shortId = () => randomUUID().slice(0, 8);
const str = (v, max = 4000) => String(v ?? '').slice(0, max);

function hasExistingCode(dir) {
  try {
    return fs.readdirSync(dir).some((f) => !['.yourteam', '.git', '.claude', '.gitignore', '.DS_Store', 'README.md', 'LICENSE'].includes(f));
  } catch {
    return false;
  }
}

// What changed in the plan and team, in a form the dashboard can show as a diff.
export function diffPlans(a, b, ra = [], rb = []) {
  const out = [];
  const tasks = (p) => (p.steps || []).reduce((n, s) => n + (s.tasks || []).length, 0);
  const agents = (p) => (p.steps || []).map((s) => s.agent).join(' → ');
  const A = new Map((a?.phases || []).map((p) => [p.id, p]));
  const B = new Map((b?.phases || []).map((p) => [p.id, p]));
  for (const [id, p] of B) if (!A.has(id)) out.push({ op: 'add', text: `${id} ${p.title}`, detail: `${agents(p)} · ${tasks(p)} tasks` });
  for (const [id, p] of A) if (!B.has(id)) out.push({ op: 'remove', text: `${id} ${p.title}` });
  for (const [id, p] of B) {
    const o = A.get(id);
    if (!o) continue;
    const ch = [];
    if (o.title !== p.title) ch.push(`renamed to "${p.title}"`);
    if (o.goal !== p.goal) ch.push('goal');
    if (JSON.stringify(o.steps) !== JSON.stringify(p.steps)) ch.push(agents(o) === agents(p) ? `tasks ${tasks(o)} → ${tasks(p)}` : `steps ${agents(o)} → ${agents(p)}`);
    if (JSON.stringify(o.qa) !== JSON.stringify(p.qa)) ch.push('QA criteria');
    if (ch.length) out.push({ op: 'change', text: `${id} ${p.title}`, detail: ch.join(', ') });
  }
  const order = (x) => (x?.phases || []).map((p) => p.id).filter((id) => A.has(id) && B.has(id)).join(',');
  if (order(a) !== order(b)) out.push({ op: 'change', text: 'Phase order', detail: (b.phases || []).map((p) => p.id).join(' → ') });
  const RA = new Map(ra.map((x) => [x.id, x]));
  const RB = new Map(rb.map((x) => [x.id, x]));
  for (const [id, x] of RB) if (!RA.has(id)) out.push({ op: 'add', text: `Agent ${x.name || id}`, detail: x.model || '' });
  for (const [id, x] of RA) if (!RB.has(id)) out.push({ op: 'remove', text: `Agent ${x.name || id}` });
  for (const [id, x] of RB) if (RA.has(id) && RA.get(id).model !== x.model) out.push({ op: 'change', text: `Agent ${x.name || id}`, detail: `model ${RA.get(id).model} → ${x.model}` });
  return out;
}

export class Orchestrator extends EventEmitter {
  constructor(store, { demo = false } = {}) {
    super();
    this.store = store;
    this.demo = demo;
    this.active = null; // build channel: { id, agent, kind, phase, kill, startedAt }
    this.chatActive = null; // chat channel: CEO interview or CTO chat
    this.loopRunning = false;
    this.wakeAgain = false;
    this.app = new AppRunner(store);
  }

  // ---------- state helpers ----------
  config() {
    return deepMerge(DEFAULT_CONFIG, this.store.readJSON('config.json', {}));
  }
  state() {
    return this.store.readJSON('state.json', {});
  }
  saveState(st) {
    this.store.writeJSON('state.json', st);
  }
  mutate(fn) {
    const st = this.state();
    fn(st);
    this.saveState(st);
    return st;
  }
  plan() {
    const p = this.store.readJSON('plan.json', { phases: [] });
    if (!Array.isArray(p.phases)) p.phases = [];
    return p;
  }
  roster() {
    const r = this.store.readJSON('roster.json', { agents: [] });
    return Array.isArray(r.agents) ? r.agents : [];
  }
  agent(id) {
    if (CORE_AGENTS[id]) return { ...CORE_AGENTS[id], ...(this.roster().find((a) => a.id === id) || {}) };
    const a = this.roster().find((x) => x.id === id);
    return a ? { tools: DEV_TOOLS, ...a } : { id, name: id, template: id, tools: DEV_TOOLS };
  }
  sessions() {
    return this.store.readJSON('sessions.json', []);
  }
  inbox() {
    return this.store.readJSON('inbox.json', []);
  }
  messages() {
    return this.store.readJSON('messages.json', []);
  }

  event(type, text, extra = {}) {
    const ev = { ts: now(), type, text, ...extra };
    this.store.appendJSONL('events.jsonl', ev);
    this.emit('event', ev);
  }

  setStatus(status, extra = {}) {
    this.mutate((st) => {
      if (st.status !== status) st.prevStatus = st.status;
      st.status = status;
      Object.assign(st, extra);
    });
  }

  addInbox(item) {
    const it = { id: shortId(), status: 'open', createdAt: now(), ...item };
    this.store.update('inbox.json', [], (list) => {
      list.push(it);
    });
    this.event('inbox', `${item.type}: ${item.title}`, { phase: item.phase, agent: item.from });
    return it;
  }

  resolveInbox(id, response) {
    let found = null;
    this.store.update('inbox.json', [], (list) => {
      const it = list.find((x) => x.id === id);
      if (it && it.status === 'open') {
        Object.assign(it, { status: 'resolved', response, resolvedAt: now() });
        found = it;
      }
    });
    return found;
  }

  resolveInboxWhere(pred, response) {
    this.store.update('inbox.json', [], (list) => {
      for (const it of list) if (it.status === 'open' && pred(it)) Object.assign(it, { status: 'resolved', response, resolvedAt: now() });
    });
  }

  postMessage(m) {
    const msg = { id: shortId(), ts: now(), readBy: [], ...m };
    this.store.update('messages.json', [], (list) => {
      list.push(msg);
    });
    return msg;
  }

  unreadFor(agentId) {
    return this.messages().filter((m) => (m.to === agentId || m.to === 'all') && m.from !== agentId && !m.readBy.includes(agentId));
  }

  markRead(ids, agentId) {
    if (!ids.length) return;
    this.store.update('messages.json', [], (list) => {
      for (const m of list) if (ids.includes(m.id) && !m.readBy.includes(agentId)) m.readBy.push(agentId);
    });
  }

  phaseState(st, id) {
    st.phases ||= {};
    st.phases[id] ||= { status: 'pending', steps: {}, qaRounds: 0, fixRounds: 0, fixQueue: [] };
    return st.phases[id];
  }
  stepState(ps, i) {
    ps.steps[i] ||= { status: 'pending', sessions: [], continuations: 0, failures: 0, tasksDone: [] };
    return ps.steps[i];
  }
  autoRun(st, id) {
    return st.phaseSettings?.[id]?.autoRun !== false;
  }

  // ---------- lifecycle ----------
  init() {
    const s = this.store;
    s.ensureDirs();
    if (!s.exists('config.json')) s.writeJSON('config.json', DEFAULT_CONFIG);
    if (!s.exists('.gitignore')) s.writeText('.gitignore', 'logs/\n*.tmp\n');
    for (const [f, v] of [['sessions.json', []], ['inbox.json', []], ['messages.json', []], ['chat/interview.json', []]]) if (!s.exists(f)) s.writeJSON(f, v);
    if (!s.exists('state.json')) {
      this.saveState({
        version: 2,
        project: path.basename(s.projectDir),
        projectDir: s.projectDir,
        createdAt: now(),
        status: 'interview',
        existingCode: hasExistingCode(s.projectDir),
        phases: {},
        phaseSettings: {},
        changeRequests: [],
        changeOrders: [],
        cto: { threads: [], activeThread: null },
        totals: { costUsd: 0, inputTokens: 0, outputTokens: 0, sessions: 0 },
      });
      this.event('project', 'Project created');
    }
    // Crash recovery: anything marked running belonged to a process that is gone.
    this.store.update('sessions.json', [], (list) => {
      for (const x of list) if (x.status === 'running') Object.assign(x, { status: 'interrupted', endedAt: now() });
    });
    this.mutate((st) => {
      st.phaseSettings ||= {};
      st.changeOrders ||= [];
      st.cto ||= { threads: [], activeThread: null };
      for (const co of st.changeOrders) if (co.status === 'queued') co.status = 'proposed';
    });
    const st = this.state();
    if (['running', 'planning', 'replanning', 'finishing'].includes(st.status) && !this.config().autoResume) {
      this.setStatus('paused', { resumeTo: st.status });
      this.event('control', 'Recovered after restart. Press Resume to continue.');
    }
    this.app.on('status', () => this.emit('active'));
    this.setupGit();
  }

  shutdown() {
    this.app.stop();
    for (const a of [this.active, this.chatActive]) if (a) a.kill();
  }

  setupGit() {
    const cfg = this.config();
    const dir = this.store.projectDir;
    if (!cfg.git.enabled || !git.gitAvailable()) return;
    try {
      if (!git.isRepo(dir)) {
        if (!cfg.git.autoInit) return;
        git.initRepo(dir);
        this.event('git', 'Initialized a git repository for phase checkpoints');
      }
      git.excludeStateDir(dir);
    } catch (e) {
      this.event('git', `Git setup failed: ${e.message}`);
    }
  }

  gitOn() {
    return this.config().git.enabled && git.gitAvailable() && git.isRepo(this.store.projectDir);
  }

  wake() {
    if (this.loopRunning) {
      this.wakeAgain = true;
      return;
    }
    this.loop();
  }

  async loop() {
    this.loopRunning = true;
    try {
      do {
        this.wakeAgain = false;
        while (await this.tick()) {}
      } while (this.wakeAgain);
    } catch (e) {
      this.setStatus('error', { error: e.stack || String(e) });
      this.event('error', `Orchestrator error: ${e.message}`);
    } finally {
      this.loopRunning = false;
    }
  }

  async tick() {
    if (this.active) return false;
    // Change orders approved while a session was running are applied between sessions.
    for (const co of this.state().changeOrders || []) if (co.status === 'queued') this.applyChangeOrder(co.id);
    const st = this.state();
    if (st.pauseRequested) {
      this.setStatus('paused', { pauseRequested: false, resumeTo: WAITING.includes(st.status) ? st.resumeTo : st.status });
      this.event('control', 'Paused');
      return false;
    }
    switch (st.status) {
      case 'planning':
        await this.runPlanning();
        return true;
      case 'replanning':
        await this.runReplan();
        return true;
      case 'running':
        return this.advance();
      case 'finishing':
        await this.finish();
        return true;
      default:
        return false;
    }
  }

  budgetOk() {
    const cfg = this.config();
    const st = this.state();
    if (cfg.budget.totalUsd && st.totals.costUsd >= cfg.budget.totalUsd) {
      if (!this.inbox().some((i) => i.status === 'open' && i.kind === 'budget')) {
        this.addInbox({ type: 'escalation', kind: 'budget', title: 'Total budget reached', text: `Spent $${st.totals.costUsd.toFixed(2)} of the $${cfg.budget.totalUsd} budget. Raise the total budget in Settings, then choose Continue.`, options: ['continue', 'pause'] });
      }
      this.setStatus('escalated');
      return false;
    }
    return true;
  }

  // ---------- running a session ----------
  modelFor(agent) {
    const cfg = this.config();
    return cfg.models[agent.id] || agent.model || cfg.models.default;
  }

  buildArgs(agent, { resumeId, sessionUuid, addDirs = [], system, model, partial }) {
    const cfg = this.config();
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model || this.modelFor(agent), '--permission-prompts', 'none'];
    if (partial) args.push('--include-partial-messages');
    if (cfg.permissions.skipAll) args.push('--dangerously-skip-permissions');
    else args.push('--permission-mode', cfg.permissions.mode || 'acceptEdits', '--allowedTools', (agent.tools || DEV_TOOLS).join(','));
    if (agent.restrict) args.push('--tools', agent.tools.join(','));
    if (system) args.push('--append-system-prompt', system);
    if (cfg.budget.perSessionUsd) args.push('--max-budget-usd', String(cfg.budget.perSessionUsd));
    if (!cfg.claude.loadMcp) args.push('--strict-mcp-config');
    if (cfg.claude.disableSkills) args.push('--disable-slash-commands');
    if (cfg.claude.effort) args.push('--effort', cfg.claude.effort);
    for (const d of addDirs) args.push('--add-dir', d);
    if (resumeId) args.push('--resume', resumeId);
    else if (sessionUuid) args.push('--session-id', sessionUuid);
    args.push(...(cfg.claude.extraArgs || []));
    return args;
  }

  async runSession({ agentId, agentOverride, kind, phase = null, step = null, prompt, resumeId, sessionUuid, addDirs = [], channel = 'build', partial = false, model }) {
    const agent = agentOverride || this.agent(agentId);
    const bin = this.demo ? MOCK_CLAUDE : resolveClaudeBin(this.config());
    if (!bin) throw new Error('Claude Code CLI not found. Install it or set claude.bin in Settings.');
    const id = randomUUID();
    const rec = {
      id,
      agent: agentId,
      kind,
      phase,
      step,
      channel,
      status: 'running',
      model: model || this.modelFor(agent),
      startedAt: now(),
      endedAt: null,
      costUsd: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextTokens: 0,
      peakContextTokens: 0,
      contextWindow: 200000,
      toolCalls: 0,
      turns: 0,
      claudeSessionId: resumeId || sessionUuid || null,
    };
    this.store.update('sessions.json', [], (l) => {
      l.push(rec);
    });
    if (channel === 'build') this.event('session', `${agent.name || agentId} started ${kind}${phase ? ` (${phase})` : ''}`, { agent: agentId, phase, sessionId: id });

    const system = P.roleSystem(this.store, agent);
    const args = this.buildArgs(agent, { resumeId, sessionUuid, addDirs: [P.TEMPLATES_DIR, ...addDirs], system, model, partial });
    const seenTools = new Set();
    let lastFlush = 0;
    const flush = (force) => {
      const t = Date.now();
      if (!force && t - lastFlush < 1500) return;
      lastFlush = t;
      this.store.update('sessions.json', [], (l) => {
        const i = l.findIndex((x) => x.id === id);
        if (i >= 0) l[i] = { ...l[i], ...rec };
      });
    };

    const handle = runClaude({
      bin,
      args,
      prompt,
      cwd: this.store.projectDir,
      logFile: this.store.p('logs', `${id}.jsonl`),
      onJSON: (obj) => {
        if (obj.type === 'system' && obj.subtype === 'init') {
          rec.claudeSessionId = obj.session_id;
          if (obj.model) rec.model = obj.model;
        } else if (obj.type === 'assistant') {
          const u = obj.message?.usage;
          if (u) {
            const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
            if (ctx > 0) {
              rec.contextTokens = ctx;
              rec.peakContextTokens = Math.max(rec.peakContextTokens, ctx);
            }
          }
          for (const b of obj.message?.content || []) {
            if (b.type !== 'tool_use' || seenTools.has(b.id)) continue;
            seenTools.add(b.id);
            rec.toolCalls++;
          }
        } else if (obj.type === 'result') {
          const u = obj.usage || {};
          rec.costUsd = obj.total_cost_usd || 0;
          rec.turns = obj.num_turns || 0;
          rec.tokens = { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 };
          const windows = Object.values(obj.modelUsage || {}).map((m) => m.contextWindow).filter(Boolean);
          if (windows.length) rec.contextWindow = Math.max(...windows);
          rec.resultText = str(obj.result, 30000);
          rec.isError = !!obj.is_error;
          rec.terminalReason = obj.terminal_reason || obj.subtype;
        }
        const entries = toEntries(obj);
        if (entries.length) this.emit('live', { sessionId: id, channel, entries });
        if (obj.type !== 'stream_event') flush(false);
      },
    });
    const slot = { id, agent: agentId, kind, phase, kill: handle.kill, startedAt: rec.startedAt, channel };
    if (channel === 'chat') this.chatActive = slot;
    else this.active = slot;
    this.emit('active');
    const out = await handle.promise;
    const killed = slot.killed;
    if (channel === 'chat') this.chatActive = null;
    else this.active = null;

    rec.endedAt = now();
    rec.durationMs = Date.parse(rec.endedAt) - Date.parse(rec.startedAt);
    const failed = killed || out.code !== 0 || !out.result || out.result.is_error;
    rec.status = killed ? 'killed' : failed ? 'failed' : 'done';
    if (failed && !killed) rec.error = str(out.error || out.result?.result || out.stderr || `exit code ${out.code}`, 2000);
    flush(true);
    this.mutate((st) => {
      st.totals.costUsd += rec.costUsd;
      st.totals.inputTokens += rec.tokens.input + rec.tokens.cacheRead + rec.tokens.cacheWrite;
      st.totals.outputTokens += rec.tokens.output;
      st.totals.sessions += 1;
    });
    if (channel === 'build' || rec.status !== 'done') this.event('session', `${agent.name || agentId} ${rec.status} ${kind} ($${rec.costUsd.toFixed(3)})${rec.error ? ': ' + rec.error.slice(0, 160) : ''}`, { agent: agentId, phase, sessionId: id });
    this.emit('active');
    return rec;
  }

  // ---------- CEO interview ----------
  chatLog() {
    return this.store.readJSON('chat/interview.json', []);
  }
  pushChat(entry, file = 'chat/interview.json') {
    this.store.update(file, [], (l) => {
      l.push({ ts: now(), ...entry });
    });
  }

  // Replaces "#Q2" with the question text so the CEO sees exactly what was referenced.
  expandQuestionRefs(text) {
    const qs = new Map();
    for (const e of this.chatLog()) for (const q of e.questions || []) qs.set(q.id.toUpperCase(), q.text);
    return text.replace(/#(Q\d+)\b/gi, (m, id) => (qs.has(id.toUpperCase()) ? `#${id.toUpperCase()} ("${qs.get(id.toUpperCase())}")` : m));
  }

  async chat(text, { brief = false, system = false, answers = [] } = {}) {
    if (this.chatActive) throw new Error('The CEO is still replying.');
    const st = this.state();
    if (!['interview', 'spec_review'].includes(st.status)) throw new Error('The interview is closed.');
    if (st.status === 'spec_review') this.setStatus('interview');
    const cleanAnswers = (answers || []).filter((a) => a && a.id && String(a.answer || '').trim()).map((a) => ({ id: str(a.id, 10), question: str(a.question, 500), answer: str(a.answer, 2000) }));
    this.pushChat(system ? { role: 'system', text: 'Asked the CEO to write the spec.' } : { role: 'user', text, answers: cleanAnswers, brief });
    const first = !st.interviewSessionId;
    const uuid = st.interviewSessionId || randomUUID();
    if (first) this.mutate((s) => (s.interviewSessionId = uuid));
    const specBefore = this.store.mtime('spec.md');
    let body = system ? text : this.expandQuestionRefs(text);
    if (cleanAnswers.length) body = `${cleanAnswers.map((a) => `${a.id}: ${a.question}\nAnswer: ${a.answer}`).join('\n\n')}${body.trim() ? `\n\n${body}` : ''}`;
    const prompt = first ? P.interviewFirst({ text: body, existingCode: st.existingCode, brief }) : system || brief ? body : body + P.INTERVIEW_TURN_SUFFIX;
    const rec = await this.runSession({ agentId: 'ceo', kind: 'interview', prompt, sessionUuid: first ? uuid : undefined, resumeId: first ? undefined : uuid, channel: 'chat', partial: true });
    if (rec.status !== 'done') {
      if (first) this.mutate((s) => (s.interviewSessionId = null));
      this.pushChat({ role: 'error', text: rec.status === 'killed' ? 'Stopped.' : rec.error || 'The CEO session failed.' });
      return;
    }
    const { clean, data } = P.extractBlock(rec.resultText);
    const entry = { role: 'ceo', text: clean || '(no reply)', sessionId: rec.id };
    if (data) {
      entry.questions = (Array.isArray(data.questions) ? data.questions : [])
        .filter((q) => q && q.text)
        .slice(0, 8)
        .map((q, i) => ({ id: str(q.id || `Q${i + 1}`, 10), text: str(q.text, 600), options: (Array.isArray(q.options) ? q.options : []).slice(0, 6).map((o) => str(o, 80)) }));
      if (data.coverage && typeof data.coverage === 'object') {
        entry.coverage = data.coverage;
        this.mutate((s) => (s.coverage = data.coverage));
      }
      entry.readyForSpec = !!data.readyForSpec;
    }
    this.pushChat(entry);
    this.mutate((s) => {
      s.interviewContext = { tokens: rec.contextTokens, window: rec.contextWindow };
    });
    if (this.store.mtime('spec.md') > specBefore) this.specReady();
  }

  specReady() {
    const cfg = this.config();
    this.resolveInboxWhere((i) => i.kind === 'spec', 'superseded');
    this.event('spec', 'Spec written');
    if (!cfg.approval.spec) return this.approveSpec();
    this.setStatus('spec_review');
    this.addInbox({ type: 'approval', kind: 'spec', title: 'Review the product spec', text: 'The CEO wrote the spec. Approve it to start planning, or keep discussing in the Interview tab.', options: ['approve'] });
  }

  approveSpec() {
    this.resolveInboxWhere((i) => i.kind === 'spec', 'approved');
    this.setStatus('planning');
    this.event('spec', 'Spec approved; CTO is planning');
    this.wake();
  }

  // ---------- CTO chat ----------
  ctoLog(threadId) {
    return this.store.readJSON(`chat/cto-${threadId}.json`, []);
  }

  newCtoThread(title) {
    const th = { id: shortId(), uuid: randomUUID(), title: str(title || 'New thread', 60), createdAt: now(), started: false, mode: null, contextTokens: 0, contextWindow: 200000, turns: 0 };
    this.mutate((st) => {
      st.cto.threads.push(th);
      st.cto.activeThread = th.id;
    });
    this.store.writeJSON(`chat/cto-${th.id}.json`, []);
    return th;
  }

  projectSummary() {
    const st = this.state();
    const lines = [`Stage: ${st.status}${st.currentPhase ? ` (current phase ${st.currentPhase})` : ''}. Spent so far: $${(st.totals?.costUsd || 0).toFixed(2)}.`];
    for (const p of this.plan().phases) {
      const ps = st.phases?.[p.id];
      const extra = [ps?.qaRounds ? `QA rounds ${ps.qaRounds}` : '', this.autoRun(st, p.id) ? '' : 'waits for the customer before starting'].filter(Boolean).join(', ');
      lines.push(`- ${p.id} "${p.title}" [${(p.steps || []).map((s) => s.agent).join(' → ')} → qa]: ${ps?.status || 'pending'}${extra ? ` (${extra})` : ''}`);
    }
    const open = this.inbox().filter((i) => i.status === 'open');
    if (open.length) lines.push(`Waiting for the customer: ${open.map((i) => i.title).join('; ')}`);
    const pending = (st.changeOrders || []).filter((c) => ['proposed', 'queued'].includes(c.status));
    if (pending.length) lines.push(`Change orders not applied yet: ${pending.map((c) => `${c.title} (${c.status})`).join('; ')}`);
    const run = this.store.readJSON('run.json', null);
    if (run?.command) lines.push(`Start command (run.json): ${run.command}${run.url ? ` → ${run.url}` : ''}`);
    return lines.join('\n');
  }

  async ctoChat(text, threadId) {
    if (this.chatActive) throw new Error('The CTO is still replying.');
    const st = this.state();
    if (!CTO_CHAT_OK.includes(st.status)) throw new Error('The CTO chat opens once the plan is written.');
    let th = st.cto.threads.find((t) => t.id === (threadId || st.cto.activeThread));
    if (!th) th = this.newCtoThread(text);
    else if (st.cto.activeThread !== th.id) this.mutate((s) => (s.cto.activeThread = th.id));
    const file = `chat/cto-${th.id}.json`;
    const canEditPlan = st.status === 'plan_review';
    const mode = canEditPlan ? 'plan' : 'build';
    this.pushChat({ role: 'user', text }, file);
    const beforePlan = this.store.readText('plan.json', '');
    const beforeRoster = this.store.readText('roster.json', '');
    const planObj = this.plan();
    const rosterObj = this.roster();
    const cto = { ...this.agent('cto'), tools: canEditPlan ? [...READ_TOOLS, 'Write', 'Edit'] : READ_TOOLS, restrict: true };
    const prompt = P.ctoChatPrompt({ first: !th.started, modeChanged: th.started && th.mode !== mode, canEditPlan, status: this.projectSummary(), text });
    const rec = await this.runSession({
      agentId: 'cto',
      agentOverride: cto,
      kind: 'cto-chat',
      prompt,
      sessionUuid: th.started ? undefined : th.uuid,
      resumeId: th.started ? th.uuid : undefined,
      channel: 'chat',
      partial: true,
      model: this.config().models.ctoChat || undefined,
    });
    if (rec.status !== 'done') {
      this.pushChat({ role: 'error', text: rec.status === 'killed' ? 'Stopped.' : rec.error || 'The CTO session failed.' }, file);
      return;
    }
    this.mutate((s) => {
      const t = s.cto.threads.find((x) => x.id === th.id);
      if (t) Object.assign(t, { started: true, mode, contextTokens: rec.contextTokens, contextWindow: rec.contextWindow, turns: (t.turns || 0) + 1 });
    });
    const { clean, data } = P.extractBlock(rec.resultText);
    const entry = { role: 'cto', text: clean || '(no reply)', sessionId: rec.id };
    const afterPlan = this.store.readText('plan.json', '');
    const afterRoster = this.store.readText('roster.json', '');
    if (afterPlan !== beforePlan || afterRoster !== beforeRoster) {
      if (!canEditPlan) {
        // The build reads plan.json between sessions, so chat edits must go through change orders.
        if (beforePlan) this.store.writeText('plan.json', beforePlan);
        if (beforeRoster) this.store.writeText('roster.json', beforeRoster);
        entry.note = 'Direct plan edits were reverted. During the build, changes go through change orders.';
      } else {
        entry.planChanges = diffPlans(planObj, this.plan(), rosterObj, this.roster());
        const errors = this.validatePlan();
        if (errors.length) entry.planErrors = errors;
        else if (entry.planChanges.length) this.event('plan', `CTO updated the plan in chat (${entry.planChanges.length} change(s))`);
        this.mutate((s) => {
          for (const ph of this.plan().phases) {
            const ps = this.phaseState(s, ph.id);
            if (ps.status === 'pending') ps.steps = {};
          }
        });
      }
    }
    if (Array.isArray(data?.changeOrders) && data.changeOrders.length) entry.changeOrders = this.addChangeOrders(data.changeOrders, th.id);
    this.pushChat(entry, file);
  }

  addChangeOrders(list, threadId) {
    const ids = [];
    this.mutate((st) => {
      for (const raw of list) {
        if (!raw || !CO_TYPES.includes(raw.type)) continue;
        const co = { id: shortId(), threadId, type: raw.type, title: str(raw.title || raw.type, 200), payload: raw, status: 'proposed', createdAt: now() };
        st.changeOrders.push(co);
        ids.push(co.id);
      }
    });
    if (ids.length) this.event('change', `CTO proposed ${ids.length} change order(s)`);
    return ids;
  }

  // Applies one change order to the plan or team. Reverts and marks it failed if the result is invalid.
  applyChangeOrder(id) {
    const st = this.state();
    const co = st.changeOrders.find((c) => c.id === id);
    if (!co || !['proposed', 'queued', 'failed'].includes(co.status)) return false;
    const planText = this.store.readText('plan.json', '');
    const rosterText = this.store.readText('roster.json', '');
    const plan = this.plan();
    const p = co.payload || {};
    const started = (pid) => (st.phases?.[pid]?.status || 'pending') !== 'pending';
    const insertAt = (pos) => {
      if (pos === 'end') return plan.phases.length;
      if (typeof pos === 'string' && pos.startsWith('after:')) {
        const i = plan.phases.findIndex((x) => x.id === pos.slice(6));
        if (i < 0) throw new Error(`There is no phase ${pos.slice(6)}`);
        return i + 1;
      }
      const i = plan.phases.findIndex((x) => !started(x.id));
      return i < 0 ? plan.phases.length : i;
    };
    let planChanged = false;
    try {
      switch (co.type) {
        case 'fix': {
          let n = 1;
          while (plan.phases.some((x) => x.id === `F${n}`)) n++;
          const fid = `F${n}`;
          const rawSteps = Array.isArray(p.steps) && p.steps.length ? p.steps : [{ agent: p.agent, items: p.items }];
          const steps = rawSteps.map((s, i) => {
            const items = (Array.isArray(s.items) ? s.items : [s.items]).filter(Boolean).map((x) => str(x, 2000));
            return { agent: s.agent, tasks: [{ id: `${fid}-T${i + 1}`, title: co.title, details: items.join('\n') || co.title, acceptance: Array.isArray(p.acceptance) && p.acceptance.length ? p.acceptance : items.length ? items : [co.title] }] };
          });
          const criteria = Array.isArray(p.acceptance) && p.acceptance.length ? p.acceptance : steps.flatMap((s) => s.tasks[0].acceptance);
          plan.phases.splice(insertAt('next'), 0, { id: fid, title: `Fix: ${co.title}`, goal: co.title, fix: true, steps, qa: { criteria } });
          planChanged = true;
          break;
        }
        case 'add-phase': {
          const ph = p.phase;
          if (!ph?.id) throw new Error('The phase has no id');
          if (plan.phases.some((x) => x.id === ph.id)) throw new Error(`Phase id ${ph.id} already exists`);
          plan.phases.splice(insertAt(p.position || 'end'), 0, ph);
          planChanged = true;
          break;
        }
        case 'update-phase': {
          const i = plan.phases.findIndex((x) => x.id === p.id);
          if (i < 0) throw new Error(`There is no phase ${p.id}`);
          if (started(p.id)) throw new Error(`${p.id} has already started`);
          plan.phases[i] = { ...plan.phases[i], ...(p.phase || {}), id: p.id };
          planChanged = true;
          break;
        }
        case 'remove-phase': {
          const i = plan.phases.findIndex((x) => x.id === p.id);
          if (i < 0) throw new Error(`There is no phase ${p.id}`);
          if (started(p.id)) throw new Error(`${p.id} has already started`);
          plan.phases.splice(i, 1);
          planChanged = true;
          break;
        }
        case 'add-agent': {
          const a = p.agent || {};
          if (!/^[a-z0-9-]+$/.test(a.id || '')) throw new Error('The agent needs an id of lowercase letters, digits and hyphens');
          if (CORE_AGENTS[a.id] || this.roster().some((x) => x.id === a.id)) throw new Error(`Agent ${a.id} already exists`);
          const role = p.role || P.templateText(a.template || a.id);
          if (!role) throw new Error('No role text and no matching template');
          this.store.writeText(`agents/${a.id}.md`, role);
          this.store.update('roster.json', { agents: [] }, (r) => {
            r.agents.push({ id: a.id, name: a.name || a.id, description: a.description || '', model: a.model || 'sonnet', tools: a.tools || DEV_TOOLS, template: a.template || null });
          });
          planChanged = true;
          break;
        }
        case 'message':
          if (!p.to || !p.text) throw new Error('A message needs "to" and "text"');
          this.postMessage({ phase: st.currentPhase || null, from: 'cto', to: p.to, type: 'info', text: str(p.text) });
          break;
        case 'spec-change':
          if (!p.text) throw new Error('A spec change needs "text"');
          fs.appendFileSync(this.store.p('spec.md'), `\n- ${now().slice(0, 10)} (change order): ${str(p.text)}\n`);
          break;
        default:
          throw new Error(`Unknown change order type ${co.type}`);
      }
      if (planChanged) {
        if (['fix', 'add-phase', 'update-phase', 'remove-phase'].includes(co.type)) this.store.writeJSON('plan.json', plan);
        const errors = this.validatePlan();
        if (errors.length) throw new Error(errors.join('; '));
      }
    } catch (e) {
      if (planChanged || co.type === 'add-agent') {
        if (planText) this.store.writeText('plan.json', planText);
        if (rosterText) this.store.writeText('roster.json', rosterText);
      }
      this.mutate((s) => Object.assign(s.changeOrders.find((c) => c.id === id), { status: 'failed', error: e.message }));
      this.event('change', `Change order failed: ${co.title}: ${e.message}`);
      return false;
    }
    this.mutate((s) => Object.assign(s.changeOrders.find((c) => c.id === id), { status: 'applied', appliedAt: now(), error: null }));
    this.event('change', `Applied change order: ${co.title}`);
    const after = this.state();
    const hasWork = this.plan().phases.some((x) => !['done', 'skipped'].includes(after.phases?.[x.id]?.status || 'pending'));
    // A fix applied while the team waits (finished, or at a phase gate) should run now;
    // a gated phase after it still waits for the customer.
    if (planChanged && hasWork && ['done', 'awaiting_approval'].includes(after.status)) this.kick();
    return true;
  }

  // ---------- planning ----------
  validatePlan() {
    const errors = [];
    const r = this.store.tryReadJSON('roster.json');
    const p = this.store.tryReadJSON('plan.json');
    if (!r.ok) errors.push(r.error);
    if (!p.ok) errors.push(p.error);
    if (errors.length) return errors;
    const agents = r.value.agents;
    if (!Array.isArray(agents) || !agents.length) errors.push('roster.json needs a non-empty "agents" array');
    const ids = new Set((agents || []).map((a) => a.id));
    if (!ids.has('qa')) errors.push('roster.json must include an agent with id "qa"');
    for (const a of agents || []) {
      if (!/^[a-z0-9-]+$/.test(a.id || '')) errors.push(`agent id "${a.id}" must be lowercase letters, digits and hyphens`);
      if (!this.store.exists(`agents/${a.id}.md`) && !P.templateText(a.template || a.id)) errors.push(`missing role file .yourteam/agents/${a.id}.md`);
    }
    const phases = p.value.phases;
    if (!Array.isArray(phases) || !phases.length) errors.push('plan.json needs a non-empty "phases" array');
    const seen = new Set();
    for (const ph of phases || []) {
      if (!ph.id || seen.has(ph.id)) errors.push(`phase id "${ph.id}" is missing or duplicated`);
      seen.add(ph.id);
      if (!ph.title) errors.push(`phase ${ph.id} needs a title`);
      if (!Array.isArray(ph.steps)) errors.push(`phase ${ph.id} needs a "steps" array`);
      for (const s of ph.steps || []) {
        if (!ids.has(s.agent) && s.agent !== 'cto') errors.push(`phase ${ph.id} step uses unknown agent "${s.agent}"`);
        if (!Array.isArray(s.tasks) || !s.tasks.length) errors.push(`phase ${ph.id} step for ${s.agent} needs tasks`);
      }
      if (!Array.isArray(ph.qa?.criteria) || !ph.qa.criteria.length) errors.push(`phase ${ph.id} needs qa.criteria`);
    }
    return errors;
  }

  lessons() {
    try {
      return fs.readFileSync(LESSONS_FILE, 'utf8').split('\n').slice(-60).join('\n');
    } catch {
      return '';
    }
  }

  async planWithRetries(makePrompt, kind) {
    const cfg = this.config();
    let errors = [];
    for (let attempt = 0; attempt <= cfg.limits.planRetries; attempt++) {
      const rec = await this.runSession({ agentId: 'cto', kind: attempt ? 'plan-fix' : kind, prompt: makePrompt(errors) });
      if (rec.status === 'killed') return { killed: true };
      if (rec.status !== 'done') {
        errors = [`The previous session failed: ${rec.error || 'unknown error'}`];
        continue;
      }
      errors = this.validatePlan();
      if (!errors.length) return { ok: true, summary: rec.resultText };
      this.event('plan', `Plan validation failed: ${errors.join('; ').slice(0, 300)}`);
    }
    return { ok: false, errors };
  }

  async runPlanning() {
    const st = this.state();
    const feedback = st.planFeedback || null;
    const res = await this.planWithRetries((errors) => P.planPrompt({ existingCode: st.existingCode, lessons: this.lessons(), feedback, errors, mode: st.mode }), 'plan');
    if (res.ok) this.mutate((s) => (s.planFeedback = null));
    this.afterPlan(res);
  }

  phaseStatusText() {
    const st = this.state();
    return this.plan().phases.map((p) => `- ${p.id} "${p.title}": ${st.phases?.[p.id]?.status || 'pending'}`).join('\n') || '(no phases yet)';
  }

  async runReplan() {
    const st = this.state();
    const pending = (st.changeRequests || []).filter((c) => c.status === 'pending');
    const feedback = st.planFeedback || null;
    const res = await this.planWithRetries((errors) => P.replanPrompt({ changeRequests: pending, feedback, phaseStatus: this.phaseStatusText(), errors }), 'replan');
    if (res.ok) {
      this.mutate((s) => {
        for (const c of s.changeRequests || []) if (pending.some((p) => p.id === c.id)) c.status = 'applied';
        s.planFeedback = null;
      });
    }
    this.afterPlan(res);
  }

  afterPlan(res) {
    if (res.killed) return;
    if (!res.ok) {
      this.setStatus('escalated');
      this.addInbox({ type: 'escalation', kind: 'plan-failed', title: 'Planning failed', text: `The CTO could not produce a valid plan:\n${(res.errors || []).join('\n')}`, options: ['retry', 'pause'] });
      return;
    }
    this.mutate((st) => {
      for (const ph of this.plan().phases) {
        const ps = this.phaseState(st, ph.id);
        if (ps.status === 'pending') ps.steps = {};
      }
    });
    this.event('plan', `Plan ready: ${this.plan().phases.length} phases, ${this.roster().length} agents`);
    if (!this.config().approval.plan) return this.approvePlan();
    this.resolveInboxWhere((i) => i.kind === 'plan', 'superseded');
    this.setStatus('plan_review');
    this.addInbox({ type: 'approval', kind: 'plan', title: 'Review the plan and the team', text: 'The CTO wrote the plan and hired the team. Review them in the Plan tab, change anything by chatting with the CTO, then approve.', options: ['approve'] });
  }

  approvePlan() {
    this.resolveInboxWhere((i) => i.kind === 'plan', 'approved');
    this.setStatus('running');
    this.event('plan', 'Plan approved; building');
    this.wake();
  }

  // ---------- phases ----------
  lastQa(phaseId) {
    const ps = this.state().phases?.[phaseId];
    for (let r = ps?.qaRounds || 0; r >= 1; r--) {
      const q = this.store.readJSON(`qa/${phaseId}-r${r}.json`, null);
      if (q) return { round: r, ...q };
    }
    return null;
  }

  async advance() {
    const st = this.state();
    if ((st.changeRequests || []).some((c) => c.status === 'pending')) {
      this.setStatus('replanning');
      return true;
    }
    if (!this.budgetOk()) return false;
    const plan = this.plan();
    const idx = plan.phases.findIndex((p) => !['done', 'skipped'].includes(st.phases?.[p.id]?.status || 'pending'));
    const phase = plan.phases[idx];
    if (!phase) {
      this.setStatus('finishing');
      return true;
    }
    const ps = this.phaseState(st, phase.id);
    st.currentPhase = phase.id;
    this.saveState(st);

    switch (ps.status) {
      case 'pending': {
        // Phases with auto-run off wait here so the customer can test what exists so far.
        if (!this.autoRun(st, phase.id) && !ps.startApproved) {
          if (!this.inbox().some((i) => i.status === 'open' && i.kind === 'phase-start' && i.phase === phase.id)) {
            const prev = plan.phases.slice(0, idx).reverse().find((p) => st.phases?.[p.id]?.status === 'done');
            const qa = prev ? this.lastQa(prev.id) : null;
            this.addInbox({
              type: 'approval',
              kind: 'phase-start',
              phase: phase.id,
              prevPhase: prev?.id || null,
              title: `Ready to start ${phase.id}: ${phase.title}`,
              text: prev ? `${prev.id} "${prev.title}" is done and passed QA. Try it, then start ${phase.id} when you're happy. Found a problem? Tell the CTO.` : `Start ${phase.id} when you're ready.`,
              manualTests: Array.isArray(qa?.manualTests) ? qa.manualTests.slice(0, 10) : [],
              options: ['start'],
            });
          }
          this.setStatus('awaiting_approval');
          return false;
        }
        if (this.gitOn()) {
          try {
            git.commitAll(this.store.projectDir, `YourTeam: before ${phase.id}`);
            git.tag(this.store.projectDir, `yourteam/${phase.id}-start`);
          } catch (e) {
            this.event('git', `Checkpoint failed: ${e.message}`);
          }
        }
        this.mutate((s) => Object.assign(this.phaseState(s, phase.id), { status: 'building', startedAt: now() }));
        this.event('phase', `Phase ${phase.id} "${phase.title}" started`, { phase: phase.id });
        return true;
      }
      case 'building':
        return this.buildStep(phase, ps);
      case 'qa':
        await this.runQa(phase);
        return true;
      case 'awaiting_approval':
        this.setStatus('awaiting_approval');
        return false;
      case 'escalated':
        this.setStatus('escalated');
        return false;
      default:
        return false;
    }
  }

  async buildStep(phase, ps) {
    if (ps.fixQueue?.length) {
      await this.runFix(phase, ps.fixQueue[0]);
      return true;
    }
    const idx = phase.steps.findIndex((_, i) => (ps.steps[i]?.status || 'pending') !== 'done');
    if (idx === -1) {
      this.mutate((s) => (this.phaseState(s, phase.id).status = 'qa'));
      return true;
    }
    const ss = ps.steps[idx];
    if (ss?.status === 'blocked') {
      const open = this.inbox().some((i) => i.status === 'open' && i.blocking && i.phase === phase.id);
      if (open) {
        this.setStatus('awaiting_answer');
        return false;
      }
    }
    await this.runStep(phase, idx);
    return true;
  }

  previousHandoff(phaseId, agentId) {
    const last = this.sessions()
      .filter((s) => s.phase === phaseId && s.agent === agentId && s.handoffPath && s.status === 'done')
      .at(-1);
    return last ? this.store.readText(last.handoffPath.replace(/^\.yourteam\//, ''), '') : '';
  }

  phaseHandoffs(phaseId) {
    return this.sessions()
      .filter((s) => s.phase === phaseId && s.handoffPath && this.store.exists(s.handoffPath.replace(/^\.yourteam\//, '')))
      .map((s) => `${s.handoffPath} (${s.agent}, ${s.kind})`);
  }

  answersFor(agentId) {
    return this.inbox()
      .filter((i) => i.type === 'question' && i.from === agentId && i.status === 'resolved' && i.response && !i.delivered)
      .map((i) => ({ id: i.id, q: i.text, a: i.response }));
  }

  markAnswersDelivered(ids) {
    if (!ids.length) return;
    this.store.update('inbox.json', [], (l) => {
      for (const i of l) if (ids.includes(i.id)) i.delivered = true;
    });
  }

  sessionPaths(phaseId, agentId, kind) {
    const n = this.sessions().filter((s) => s.phase === phaseId && s.agent === agentId).length + 1;
    const base = `${phaseId}-${agentId}-${String(n).padStart(2, '0')}${kind === 'fix' ? '-fix' : ''}`;
    return { n, handoff: `.yourteam/handoffs/${base}.md`, report: `.yourteam/reports/${base}.json` };
  }

  readReport(rel) {
    const r = this.store.tryReadJSON(rel.replace(/^\.yourteam\//, ''));
    if (!r.ok || typeof r.value !== 'object' || !r.value) return null;
    const v = r.value;
    return {
      status: ['done', 'partial', 'waiting', 'blocked'].includes(v.status) ? v.status : 'partial',
      summary: String(v.summary || ''),
      tasksDone: Array.isArray(v.tasksDone) ? v.tasksDone : [],
      tasksRemaining: Array.isArray(v.tasksRemaining) ? v.tasksRemaining : [],
      filesChanged: Array.isArray(v.filesChanged) ? v.filesChanged : [],
      messages: Array.isArray(v.messages) ? v.messages.filter((m) => m && m.to && m.text) : [],
      questions: Array.isArray(v.questions) ? v.questions.filter((q) => q && q.text) : [],
    };
  }

  // Applies what an agent reported: board messages, customer questions, session record.
  applyReport(rec, report, phase) {
    for (const m of report.messages) this.postMessage({ phase: phase.id, from: rec.agent, to: m.to, type: m.type || 'info', text: m.text, sessionId: rec.id });
    for (const q of report.questions) {
      this.addInbox({ type: 'question', title: q.text.slice(0, 120), text: q.text, assumption: q.assumption || '', blocking: !!q.blocking, from: rec.agent, phase: phase.id, sessionId: rec.id });
    }
    this.store.update('sessions.json', [], (l) => {
      const s = l.find((x) => x.id === rec.id);
      if (s) Object.assign(s, { reportStatus: report.status, summary: report.summary, handoffPath: rec.handoffPath, reportPath: rec.reportPath });
    });
  }

  failureEscalation(phase, what, rec) {
    this.mutate((s) => (this.phaseState(s, phase.id).status = 'escalated'));
    this.addInbox({ type: 'escalation', kind: 'session-failed', phase: phase.id, from: rec?.agent, title: `${what} keeps failing in ${phase.id}`, text: rec?.error || 'The session did not produce a report.', options: ['retry', 'skip-step', 'pause'] });
  }

  async runStep(phase, idx) {
    const cfg = this.config();
    const step = phase.steps[idx];
    const agent = this.agent(step.agent);
    let st = this.state();
    const ss = this.stepState(this.phaseState(st, phase.id), idx);
    this.saveState(st);
    if (ss.continuations > cfg.limits.maxContinuations) {
      this.failureEscalation(phase, `${agent.name || agent.id}'s step`, { agent: agent.id, error: `Still unfinished after ${ss.continuations} sessions.` });
      return;
    }
    const kind = ss.sessions.length ? 'continue' : 'work';
    const msgs = this.unreadFor(agent.id);
    const answers = this.answersFor(agent.id);
    const paths = this.sessionPaths(phase.id, agent.id, kind);
    const prompt = P.workPrompt({
      kind,
      phase,
      step,
      agent,
      sessionNo: ss.sessions.length + 1,
      handoffPath: paths.handoff,
      reportPath: paths.report,
      messages: msgs,
      handoffs: this.phaseHandoffs(phase.id),
      previous: kind === 'continue' ? this.previousHandoff(phase.id, agent.id) : '',
      answers,
    });
    this.mutate((s) => (this.stepState(this.phaseState(s, phase.id), idx).status = 'running'));
    const rec = await this.runSession({ agentId: agent.id, kind, phase: phase.id, step: idx, prompt });
    rec.handoffPath = paths.handoff;
    rec.reportPath = paths.report;

    if (rec.status === 'killed') {
      this.mutate((s) => (this.stepState(this.phaseState(s, phase.id), idx).status = 'pending'));
      return;
    }
    const report = this.readReport(paths.report);
    if (!report) {
      st = this.mutate((s) => {
        const x = this.stepState(this.phaseState(s, phase.id), idx);
        x.failures++;
        x.status = 'pending';
        x.sessions.push(rec.id);
      });
      if (this.stepState(this.phaseState(st, phase.id), idx).failures >= cfg.limits.maxSessionFailures) this.failureEscalation(phase, `${agent.name || agent.id}'s step`, rec);
      else this.event('session', `No valid report from ${agent.id}; retrying with a fresh session`, { phase: phase.id, agent: agent.id });
      return;
    }
    this.markRead(msgs.map((m) => m.id), agent.id);
    this.markAnswersDelivered(answers.map((a) => a.id));
    this.applyReport(rec, report, phase);

    const bugReports = report.messages.filter((m) => m.type === 'bug-report' && m.to !== agent.id && this.roster().some((a) => a.id === m.to));
    this.mutate((s) => {
      const p = this.phaseState(s, phase.id);
      const x = this.stepState(p, idx);
      x.sessions.push(rec.id);
      x.failures = 0;
      x.tasksDone = [...new Set([...x.tasksDone, ...report.tasksDone])];
      if (report.status === 'done') x.status = 'done';
      else if (report.status === 'partial') {
        x.status = 'pending';
        x.continuations++;
      } else if (report.status === 'blocked') x.status = 'blocked';
      else if (report.status === 'waiting') x.status = bugReports.length ? 'waiting' : 'pending';
      // Hand bug reports to their owners before this step (or QA) continues.
      if (bugReports.length) {
        if (p.fixRounds < cfg.limits.maxFixRounds) {
          for (const to of [...new Set(bugReports.map((m) => m.to))]) p.fixQueue.push({ agent: to, reason: 'bug-report', from: agent.id, items: bugReports.filter((m) => m.to === to).map((m) => m.text) });
        } else {
          this.event('fix', `Fix round limit reached in ${phase.id}; leaving remaining bugs for QA`, { phase: phase.id });
          if (x.status === 'waiting') x.status = 'pending';
        }
      }
    });
    if (report.status === 'blocked' && !this.inbox().some((i) => i.status === 'open' && i.blocking && i.phase === phase.id)) {
      this.addInbox({ type: 'question', blocking: true, from: agent.id, phase: phase.id, title: `${agent.name || agent.id} is blocked`, text: report.summary || 'The agent reported it is blocked.', sessionId: rec.id });
    }
  }

  async runFix(phase, fx) {
    const agent = this.agent(fx.agent);
    const paths = this.sessionPaths(phase.id, agent.id, 'fix');
    const msgs = this.unreadFor(agent.id).filter((m) => m.type !== 'bug-report' || fx.reason !== 'bug-report');
    const prompt = P.workPrompt({
      kind: 'fix',
      phase,
      step: null,
      agent,
      sessionNo: (fx.attempts || 0) + 1,
      handoffPath: paths.handoff,
      reportPath: paths.report,
      messages: msgs,
      handoffs: this.phaseHandoffs(phase.id),
      previous: this.previousHandoff(phase.id, agent.id),
      fix: fx.items.map((t) => (fx.from ? `[from ${fx.from}] ${t}` : t)),
    });
    const rec = await this.runSession({ agentId: agent.id, kind: 'fix', phase: phase.id, prompt });
    rec.handoffPath = paths.handoff;
    rec.reportPath = paths.report;
    if (rec.status === 'killed') return;
    const report = this.readReport(paths.report);
    if (report) {
      this.markRead(this.unreadFor(agent.id).map((m) => m.id), agent.id);
      this.applyReport(rec, report, phase);
    }
    this.mutate((s) => {
      const p = this.phaseState(s, phase.id);
      const head = p.fixQueue[0];
      if (!head) return;
      head.attempts = (head.attempts || 0) + 1;
      const retry = (!report || report.status === 'partial') && head.attempts < 2;
      if (retry) return;
      p.fixQueue.shift();
      if (head.reason === 'bug-report') p.fixRounds++;
      // Wake up the reporter's step that was waiting for this fix.
      if (!p.fixQueue.some((f) => f.reason === head.reason)) for (const k of Object.keys(p.steps)) if (p.steps[k].status === 'waiting') p.steps[k].status = 'pending';
    });
  }

  async runQa(phase) {
    const cfg = this.config();
    const ps = this.phaseState(this.state(), phase.id);
    const round = ps.qaRounds + 1;
    const base = `qa/${phase.id}-r${round}`;
    const prev = ps.qaRounds ? this.store.readText(`qa/${phase.id}-r${ps.qaRounds}.md`, '') : '';
    const msgs = this.unreadFor('qa');
    // QA starts the app itself; the customer's copy would hold the ports.
    if (this.app.stop()) this.event('app', 'Stopped the running app so QA can use its ports');
    const prompt = P.qaPrompt({ phase, round, reportPath: `.yourteam/${base}.json`, mdPath: `.yourteam/${base}.md`, handoffs: this.phaseHandoffs(phase.id), previous: prev.slice(0, 6000), messages: msgs });
    const rec = await this.runSession({ agentId: 'qa', kind: 'qa', phase: phase.id, prompt });
    if (rec.status === 'killed') return;
    this.markRead(msgs.map((m) => m.id), 'qa');
    const r = this.store.tryReadJSON(`${base}.json`);
    const qa = r.ok && r.value && ['pass', 'fail'].includes(r.value.verdict) ? r.value : null;
    this.store.update('sessions.json', [], (l) => {
      const s = l.find((x) => x.id === rec.id);
      if (s) Object.assign(s, { reportStatus: qa?.verdict || 'no-report', summary: qa?.summary || '', reportPath: `.yourteam/${base}.json` });
    });

    if (qa?.verdict === 'pass') {
      this.mutate((s) => (this.phaseState(s, phase.id).qaRounds = round));
      this.event('qa', `QA passed ${phase.id} (round ${round})`, { phase: phase.id });
      return this.phasePassed(phase);
    }
    const roster = this.roster().map((a) => a.id);
    const issues = (qa?.issues || []).filter((i) => i && i.title);
    this.mutate((s) => {
      const p = this.phaseState(s, phase.id);
      p.qaRounds = round;
      if (round >= cfg.limits.maxQaRounds) {
        p.status = 'escalated';
        return;
      }
      if (!qa) return; // no valid report: QA runs again
      const fallback = phase.steps.at(-1)?.agent || 'cto';
      const byAgent = {};
      for (const i of issues) {
        const owner = roster.includes(i.agent) && i.agent !== 'qa' ? i.agent : fallback;
        (byAgent[owner] ||= []).push(`[${i.severity || 'medium'}] ${i.title}: ${i.details || ''}`);
      }
      if (!Object.keys(byAgent).length) byAgent[fallback] = [`QA failed: ${qa.summary}`];
      for (const [agent, items] of Object.entries(byAgent)) p.fixQueue.push({ agent, reason: 'qa', from: 'qa', items });
      p.status = 'building';
    });
    const after = this.phaseState(this.state(), phase.id);
    if (after.status === 'escalated') {
      this.addInbox({ type: 'escalation', kind: 'qa-failed', phase: phase.id, title: `QA still failing for ${phase.id} after ${round} rounds`, text: qa?.summary || rec.error || 'QA produced no valid report.', options: ['retry', 'accept', 'pause'] });
    } else {
      this.event('qa', `QA ${qa ? 'failed' : 'gave no report for'} ${phase.id} (round ${round}); ${after.fixQueue.length} fix session(s) queued`, { phase: phase.id });
    }
  }

  phasePassed(phase) {
    if (this.gitOn()) {
      try {
        const hash = git.commitAll(this.store.projectDir, `YourTeam: ${phase.id} ${phase.title}`);
        git.tag(this.store.projectDir, `yourteam/${phase.id}-done`);
        if (hash) this.event('git', `Committed ${phase.id} as ${hash}`, { phase: phase.id });
      } catch (e) {
        this.event('git', `Commit failed: ${e.message}`);
      }
    }
    this.completePhase(phase.id);
  }

  completePhase(id) {
    this.mutate((s) => Object.assign(this.phaseState(s, id), { status: 'done', endedAt: now() }));
    this.event('phase', `Phase ${id} done`, { phase: id });
  }

  async finish() {
    const cfg = this.config();
    if (cfg.retro && !this.store.exists('retro.md')) {
      const sessions = this.sessions();
      const st = this.state();
      const byAgent = {};
      for (const s of sessions) {
        const a = (byAgent[s.agent] ||= { sessions: 0, cost: 0, failed: 0 });
        a.sessions++;
        a.cost += s.costUsd || 0;
        if (s.status !== 'done') a.failed++;
      }
      const stats = [
        `Total cost: $${st.totals.costUsd.toFixed(2)} over ${sessions.length} sessions`,
        ...Object.entries(st.phases || {}).map(([id, p]) => `${id}: QA rounds ${p.qaRounds}, fix rounds ${p.fixRounds}, status ${p.status}`),
        ...Object.entries(byAgent).map(([id, a]) => `${id}: ${a.sessions} sessions, $${a.cost.toFixed(2)}, ${a.failed} failed`),
      ].join('\n');
      const rec = await this.runSession({ agentId: 'cto', kind: 'retro', prompt: P.retroPrompt({ stats }) });
      if (rec.status === 'killed') return;
      const lessons = this.store.readText('retro.md', '').split(/^## Lessons\s*$/m)[1];
      // Demo runs use canned output, so they must not teach future real projects anything.
      if (lessons?.trim() && !this.demo) {
        fs.mkdirSync(USER_DIR, { recursive: true });
        fs.appendFileSync(LESSONS_FILE, `\n<!-- ${this.state().project} ${now().slice(0, 10)} -->\n${lessons.trim()}\n`);
      }
    }
    this.setStatus('done', { currentPhase: null });
    this.event('project', 'Project complete');
    this.resolveInboxWhere((i) => i.kind === 'done', 'superseded');
    this.addInbox({ type: 'info', kind: 'done', title: 'Project complete', text: 'All phases passed QA. Try it with Run app, and tell the CTO about anything you want changed.', options: ['ok'] });
  }

  // ---------- dashboard actions ----------
  async action(type, a = {}) {
    const st = this.state();
    const phase = a.phase ? this.plan().phases.find((p) => p.id === a.phase) : null;
    const need = (cond, msg) => {
      if (!cond) throw new Error(msg);
    };
    switch (type) {
      case 'chat':
        need(a.text?.trim() || a.answers?.length, 'Message is empty');
        need(!this.chatActive, 'The CEO is still replying.');
        this.chat(String(a.text || '').trim(), { answers: a.answers }).catch((e) => this.pushChat({ role: 'error', text: e.message }));
        return { ok: true };
      case 'brief':
        need(a.text?.trim(), 'Brief is empty');
        need(!st.interviewSessionId, 'The interview already started; send the brief as a chat message instead.');
        this.chat(a.text.trim(), { brief: true }).catch((e) => this.pushChat({ role: 'error', text: e.message }));
        return { ok: true };
      case 'finalize-spec':
        need(st.interviewSessionId, 'Talk to the CEO first.');
        need(!this.chatActive, 'The CEO is still replying.');
        this.chat(P.finalizeSpecMessage(), { system: true })
          .then(() => {
            if (this.state().status === 'interview' && this.store.exists('spec.md')) this.specReady();
          })
          .catch((e) => this.pushChat({ role: 'error', text: e.message }));
        return { ok: true };
      case 'spec-written':
        need(this.store.exists('spec.md'), '.yourteam/spec.md does not exist');
        need(['interview', 'spec_review'].includes(st.status), 'The spec stage is over');
        this.specReady();
        return { ok: true };
      case 'approve-spec':
        need(this.store.exists('spec.md'), 'There is no spec yet');
        need(['interview', 'spec_review'].includes(st.status), 'The spec stage is over');
        this.approveSpec();
        return { ok: true };
      case 'reopen-interview':
        need(st.status === 'spec_review', 'Not reviewing a spec');
        this.resolveInboxWhere((i) => i.kind === 'spec', 'reopened');
        this.setStatus('interview');
        return { ok: true };
      case 'chat-stop':
        if (this.chatActive) {
          this.chatActive.killed = true;
          this.chatActive.kill();
        }
        return { ok: true };
      case 'cto-chat':
        need(a.text?.trim(), 'Message is empty');
        need(!this.chatActive, 'The CTO is still replying.');
        need(CTO_CHAT_OK.includes(st.status), 'The CTO chat opens once the plan is written.');
        this.ctoChat(a.text.trim(), a.thread).catch((e) => this.event('error', `CTO chat: ${e.message}`));
        return { ok: true };
      case 'cto-new-thread':
        need(!this.chatActive, 'Wait for the current reply to finish.');
        this.newCtoThread(a.title || 'New thread');
        return { ok: true };
      case 'cto-select-thread':
        need(st.cto.threads.some((t) => t.id === a.thread), 'Unknown thread');
        this.mutate((s) => (s.cto.activeThread = a.thread));
        return { ok: true };
      case 'apply-change-order': {
        const co = st.changeOrders.find((c) => c.id === a.id);
        need(co && ['proposed', 'failed'].includes(co.status), 'That change order cannot be applied');
        if (this.active) {
          this.mutate((s) => (s.changeOrders.find((c) => c.id === a.id).status = 'queued'));
          this.event('change', `Change order queued until the current session ends: ${co.title}`);
          return { ok: true, queued: true };
        }
        const ok = this.applyChangeOrder(a.id);
        const after = this.state().changeOrders.find((c) => c.id === a.id);
        if (!ok) throw new Error(after?.error || 'Could not apply the change order');
        return { ok: true };
      }
      case 'reject-change-order':
        this.mutate((s) => {
          const co = s.changeOrders.find((c) => c.id === a.id);
          if (co && ['proposed', 'failed', 'queued'].includes(co.status)) co.status = 'rejected';
        });
        return { ok: true };
      case 'approve-plan':
        need(st.status === 'plan_review', 'No plan is waiting for approval');
        {
          const errors = this.validatePlan();
          need(!errors.length, `The plan has problems: ${errors.join('; ')}`);
        }
        this.approvePlan();
        return { ok: true };
      case 'request-plan-changes':
        need(st.status === 'plan_review', 'No plan is waiting for approval');
        need(a.text?.trim(), 'Describe the changes');
        this.resolveInboxWhere((i) => i.kind === 'plan', 'changes requested');
        this.setStatus(Object.values(st.phases || {}).some((p) => p.status !== 'pending') ? 'replanning' : 'planning', { planFeedback: a.text.trim() });
        this.wake();
        return { ok: true };
      case 'set-autorun': {
        const ids = a.all ? this.plan().phases.map((p) => p.id) : [a.phase];
        need(ids.every(Boolean), 'Unknown phase');
        const value = !!a.value;
        this.mutate((s) => {
          s.phaseSettings ||= {};
          for (const id of ids) s.phaseSettings[id] = { ...(s.phaseSettings[id] || {}), autoRun: value };
        });
        // Turning auto-run on for a phase that is waiting at its gate starts it.
        if (value) {
          const gated = this.inbox().filter((i) => i.status === 'open' && i.kind === 'phase-start' && ids.includes(i.phase));
          if (gated.length) {
            this.resolveInboxWhere((i) => i.kind === 'phase-start' && ids.includes(i.phase), 'auto-run on');
            this.kick();
          }
        }
        return { ok: true };
      }
      case 'start-phase': {
        need(phase, 'Unknown phase');
        need((st.phases?.[phase.id]?.status || 'pending') === 'pending', 'That phase has already started');
        this.mutate((s) => (this.phaseState(s, phase.id).startApproved = true));
        this.resolveInboxWhere((i) => i.kind === 'phase-start' && i.phase === phase.id, 'started');
        this.event('control', `Customer started ${phase.id}`, { phase: phase.id });
        this.kick();
        return { ok: true };
      }
      case 'approve-phase': {
        // Kept for projects created before auto-run gates replaced phase approvals.
        need(phase && st.phases?.[phase.id]?.status === 'awaiting_approval', 'That phase is not waiting for approval');
        this.resolveInboxWhere((i) => i.kind === 'phase' && i.phase === phase.id, 'approved');
        this.completePhase(phase.id);
        this.kick();
        return { ok: true };
      }
      case 'review-phase':
        need(phase, 'Unknown phase');
        this.mutate((s) => (this.phaseState(s, phase.id).reviewed = { verdict: a.verdict || 'ok', at: now() }));
        this.event('review', `Customer reviewed ${phase.id}: looks good`, { phase: phase.id });
        return { ok: true };
      case 'answer': {
        const item = this.inbox().find((i) => i.id === a.id);
        need(item && item.status === 'open' && item.type === 'question', 'Question not found');
        need(a.text?.trim(), 'Answer is empty');
        this.resolveInbox(item.id, a.text.trim());
        this.event('inbox', `Customer answered ${item.from}`, { phase: item.phase, agent: item.from });
        if (item.blocking && !this.inbox().some((i) => i.status === 'open' && i.blocking && i.phase === item.phase)) {
          this.mutate((s) => {
            const p = s.phases?.[item.phase];
            if (p) for (const k of Object.keys(p.steps)) if (p.steps[k].status === 'blocked') p.steps[k].status = 'pending';
          });
          if (this.state().status === 'awaiting_answer') {
            this.setStatus('running');
            this.wake();
          }
        }
        return { ok: true };
      }
      case 'resolve': {
        const item = this.inbox().find((i) => i.id === a.id);
        need(item && item.status === 'open', 'Item not found');
        return this.resolveEscalation(item, a.option);
      }
      case 'pause':
        if (this.active || this.loopRunning) this.mutate((s) => (s.pauseRequested = true));
        else if (!WAITING.includes(st.status) || st.status === 'awaiting_answer') this.setStatus('paused', { resumeTo: st.status });
        this.event('control', 'Pause requested (the current session will finish first)');
        return { ok: true };
      case 'stop':
        if (this.active) {
          this.active.killed = true;
          this.active.kill();
        }
        this.mutate((s) => (s.pauseRequested = true));
        if (!this.loopRunning) this.setStatus('paused', { pauseRequested: false, resumeTo: st.resumeTo || st.status });
        this.event('control', 'Stopped the current session');
        return { ok: true };
      case 'resume': {
        need(['paused', 'error', 'escalated'].includes(st.status), 'Nothing to resume');
        const to = st.status === 'escalated' ? 'running' : st.resumeTo && !['paused', 'error'].includes(st.resumeTo) ? st.resumeTo : Object.keys(st.phases || {}).length ? 'running' : 'interview';
        this.setStatus(to, { pauseRequested: false, error: null, resumeTo: null });
        this.event('control', `Resumed (${to})`);
        this.wake();
        return { ok: true };
      }
      case 'rerun-phase':
        need(phase, 'Unknown phase');
        this.mutate((s) => {
          s.phases[phase.id] = { status: 'pending', steps: {}, qaRounds: 0, fixRounds: 0, fixQueue: [], startApproved: true };
        });
        this.resolveInboxWhere((i) => i.phase === phase.id && i.type !== 'question', 'rerun');
        this.event('control', `Phase ${phase.id} will run again`, { phase: phase.id });
        this.kick();
        return { ok: true };
      case 'rerun-qa':
        need(phase, 'Unknown phase');
        this.mutate((s) => Object.assign(this.phaseState(s, phase.id), { status: 'qa', qaRounds: 0, fixQueue: [] }));
        this.resolveInboxWhere((i) => i.phase === phase.id && i.type !== 'question', 'rerun-qa');
        this.kick();
        return { ok: true };
      case 'skip-phase':
        need(phase, 'Unknown phase');
        this.mutate((s) => (this.phaseState(s, phase.id).status = 'skipped'));
        this.resolveInboxWhere((i) => i.phase === phase.id && i.type !== 'question', 'skipped');
        this.event('control', `Phase ${phase.id} skipped`, { phase: phase.id });
        this.kick();
        return { ok: true };
      case 'rollback-phase': {
        need(phase, 'Unknown phase');
        need(!this.active, 'Stop the running session first');
        need(this.gitOn() && git.hasRef(this.store.projectDir, `yourteam/${phase.id}-start`), 'No git checkpoint exists for that phase');
        this.app.stop();
        git.rollbackTo(this.store.projectDir, `yourteam/${phase.id}-start`);
        const ids = this.plan().phases.map((p) => p.id);
        this.mutate((s) => {
          for (const id of ids.slice(ids.indexOf(phase.id))) s.phases[id] = { status: 'pending', steps: {}, qaRounds: 0, fixRounds: 0, fixQueue: [] };
          s.status = 'paused';
          s.resumeTo = 'running';
        });
        this.resolveInboxWhere((i) => ids.slice(ids.indexOf(phase.id)).includes(i.phase) && i.type !== 'question', 'rolled back');
        this.event('git', `Rolled code back to before ${phase.id}; ${phase.id} and later phases reset. Press Resume to rebuild.`, { phase: phase.id });
        return { ok: true };
      }
      case 'change-request':
        need(a.text?.trim(), 'Describe the change');
        this.mutate((s) => (s.changeRequests ||= []).push({ id: shortId(), text: a.text.trim(), status: 'pending', createdAt: now() }));
        this.event('change', `Change request: ${a.text.trim().slice(0, 120)}`);
        if (st.status === 'done') this.setStatus('replanning');
        if (['done', 'running'].includes(st.status)) this.wake();
        return { ok: true };
      case 'send-message':
        need(a.to && a.text?.trim(), 'Pick an agent and write a message');
        this.postMessage({ phase: st.currentPhase || null, from: 'customer', to: a.to, type: 'info', text: a.text.trim() });
        return { ok: true };
      case 'app-start':
        this.app.start();
        this.event('app', `Started the app: ${this.app.command}`);
        return { ok: true };
      case 'app-stop':
        need(this.app.stop(), 'The app is not running');
        return { ok: true };
      case 'update-config': {
        const cur = this.store.readJSON('config.json', {});
        this.store.writeJSON('config.json', deepMerge(deepMerge(DEFAULT_CONFIG, cur), a.patch || {}));
        this.event('config', 'Settings updated');
        return { ok: true };
      }
      case 'update-agent': {
        need(a.id, 'Missing agent id');
        if (CORE_AGENTS[a.id]) {
          const cur = this.store.readJSON('config.json', {});
          this.store.writeJSON('config.json', deepMerge(deepMerge(DEFAULT_CONFIG, cur), { models: { [a.id]: a.model } }));
        } else {
          this.store.update('roster.json', { agents: [] }, (r) => {
            const ag = r.agents.find((x) => x.id === a.id);
            if (ag && a.model) ag.model = a.model;
          });
          // A per-agent override in config would shadow the roster, so clear it.
          this.store.update('config.json', {}, (c) => {
            if (c.models) delete c.models[a.id];
          });
        }
        return { ok: true };
      }
      case 'save-doc': {
        const rel = this.store.safeDocPath(a.path);
        need(rel, 'Invalid document path');
        if (rel.endsWith('.json')) {
          try {
            JSON.parse(a.content);
          } catch (e) {
            throw new Error(`Not valid JSON: ${e.message}`);
          }
        }
        this.store.writeText(rel, a.content);
        this.event('doc', `Edited ${rel}`);
        return { ok: true };
      }
      default:
        throw new Error(`Unknown action: ${type}`);
    }
  }

  // Restarts the loop after a manual phase change, unless the user is mid-review.
  kick() {
    const st = this.state();
    if (['escalated', 'awaiting_approval', 'awaiting_answer', 'done'].includes(st.status)) this.setStatus('running');
    this.wake();
  }

  resolveEscalation(item, option) {
    const phase = item.phase;
    this.resolveInbox(item.id, option || 'ok');
    switch (item.kind) {
      case 'budget':
        if (option === 'continue') {
          this.setStatus('running');
          this.wake();
        } else this.setStatus('paused', { resumeTo: 'running' });
        break;
      case 'plan-failed':
        if (option === 'retry') {
          this.setStatus(Object.keys(this.state().phases || {}).length && this.plan().phases.length ? 'replanning' : 'planning');
          this.wake();
        } else this.setStatus('paused', { resumeTo: 'planning' });
        break;
      case 'qa-failed':
        if (option === 'retry') {
          this.mutate((s) => Object.assign(this.phaseState(s, phase), { status: 'qa', qaRounds: 0 }));
          this.kick();
        } else if (option === 'accept') {
          this.completePhase(phase);
          this.kick();
        } else this.setStatus('paused', { resumeTo: 'running' });
        break;
      case 'session-failed':
        this.mutate((s) => {
          const p = this.phaseState(s, phase);
          p.status = 'building';
          for (const k of Object.keys(p.steps)) {
            const x = p.steps[k];
            if (x.status === 'done') continue;
            if (option === 'skip-step') x.status = 'done';
            else Object.assign(x, { status: 'pending', failures: 0, continuations: 0 });
            break;
          }
        });
        if (option === 'pause') this.setStatus('paused', { resumeTo: 'running' });
        else this.kick();
        break;
      default:
        break;
    }
    return { ok: true };
  }

  activeInfo() {
    if (!this.active) return null;
    const { id, agent, kind, phase, startedAt } = this.active;
    return { id, agent, kind, phase, startedAt };
  }

  chatInfo() {
    if (!this.chatActive) return null;
    const { id, agent, kind, startedAt } = this.chatActive;
    return { id, agent, kind, startedAt };
  }
}
