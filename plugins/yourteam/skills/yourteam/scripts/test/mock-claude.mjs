#!/usr/bin/env node
// A stand-in for `claude -p --output-format stream-json`, used by `yourteam start --demo`
// and by the self-test. It reads the YourTeam prompt, writes the files a real agent would
// write, and streams fake events, so the whole pipeline can run without spending tokens.
// It deliberately exercises the fix loop (frontend reports a backend bug), a QA failure,
// interview question cards, CTO plan edits and CTO change orders.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'agents');
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const partial = args.includes('--include-partial-messages');
const delay = Number(process.env.YOURTEAM_MOCK_DELAY ?? 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const model = arg('--model') || 'sonnet';
const sessionId = arg('--resume') || arg('--session-id') || randomUUID();
const root = process.cwd();
const yt = (...p) => path.join(root, '.yourteam', ...p);
const write = (rel, text) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof text === 'string' ? text : JSON.stringify(text, null, 2));
};
const memFile = yt('.mock-memory.json');
const mem = (() => {
  try {
    return JSON.parse(fs.readFileSync(memFile, 'utf8'));
  } catch {
    return {};
  }
})();
const saveMem = () => fs.writeFileSync(memFile, JSON.stringify(mem));

let ctx = 9000;
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const stream = (event) => emit({ type: 'stream_event', event, session_id: sessionId });
const say = async (text) => {
  ctx += 800 + Math.floor(Math.random() * 1500);
  if (partial) {
    stream({ type: 'message_start' });
    await sleep(delay);
    const words = text.split(/(\s+)/);
    for (let i = 0; i < words.length; i += 6) {
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: words.slice(i, i + 6).join('') } });
      await sleep(Math.max(20, delay / 8));
    }
  }
  emit({ type: 'assistant', message: { id: randomUUID(), role: 'assistant', model, content: [{ type: 'text', text }], usage: { input_tokens: 40, cache_read_input_tokens: ctx, cache_creation_input_tokens: 600, output_tokens: 120 } } });
  await sleep(delay);
};
const tool = async (name, input, result = 'ok') => {
  const id = 'toolu_' + randomUUID().slice(0, 8);
  ctx += 1200 + Math.floor(Math.random() * 2500);
  if (partial) stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name } });
  emit({ type: 'assistant', message: { id: randomUUID(), role: 'assistant', model, content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 40, cache_read_input_tokens: ctx, cache_creation_input_tokens: 400, output_tokens: 90 } } });
  await sleep(delay);
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] } });
  await sleep(delay / 2);
};
const block = (obj) => '\n\n```yourteam\n' + JSON.stringify(obj, null, 2) + '\n```';

const prompt = fs.readFileSync(0, 'utf8');
// Record which skill packs each session was given, so the self-test can check per-agent loading.
const pluginDirs = args.flatMap((x, i) => (x === '--plugin-dir' ? [args[i + 1]] : []));
if (pluginDirs.length) {
  const who = (prompt.match(/^Agent: ([\w-]+)/m) || [])[1] || null;
  fs.appendFileSync(yt('.mock-plugin-dirs.log'), JSON.stringify({ agent: who, dirs: pluginDirs.map((d) => path.basename(d)) }) + '\n');
}
const kind = (prompt.match(/YOURTEAM_TASK_KIND: ([\w-]+)/) || [])[1] || 'chat';
const agent = (prompt.match(/^Agent: ([\w-]+)/m) || [])[1];
const phase = (prompt.match(/\| Phase: (\w+)/) || [])[1];
const handoffPath = (prompt.match(/1\. Handoff: (\S+)/) || [])[1];
const reportPath = (prompt.match(/2\. Report: (\S+)/) || [])[1];

emit({ type: 'system', subtype: 'init', session_id: sessionId, model: `claude-${model}-mock`, tools: ['Read', 'Write', 'Edit', 'Bash'] });
await sleep(delay);

let final = 'Done.';

const SERVER_JS = `// Demo app written by the mock backend agent.
const http = require('http');
const port = process.env.PORT || 4599;
const quotes = [{ text: 'Simplicity is the soul of efficiency.', author: 'Austin Freeman' }];
http
  .createServer((req, res) => {
    if (req.url === '/api/quote') return res.end(JSON.stringify(quotes[Math.floor(Math.random() * quotes.length)]));
    res.setHeader('Content-Type', 'text/html');
    res.end('<h1>YourTeam demo app</h1><p>Built by simulated agents.</p>');
  })
  .listen(port, () => console.log('Listening on http://localhost:' + port));
`;

if (kind === 'interview' || (kind === 'chat' && arg('--resume'))) {
  mem.turns = (mem.turns || 0) + 1;
  saveMem();
  if (mem.turns === 1) {
    await tool('Glob', { pattern: '**/*' }, '(empty folder)');
    final =
      'Thanks! A todo app for a team is a great fit. A few quick questions so I get the picture right.' +
      block({
        questions: [
          { id: 'Q1', text: 'Who uses it day to day?', options: ['Just me', 'My small team', 'Whole company'] },
          { id: 'Q2', text: 'Which platform comes first?', options: ['Web app', 'Mobile app', 'Both'] },
          { id: 'Q3', text: 'Do people need their own accounts?', options: ['No, single list', 'Yes, simple login'] },
        ],
        coverage: { users: 'partial', scope: 'partial', flows: 'todo', data: 'todo', integrations: 'todo', platform: 'todo', quality: 'todo', done: 'todo' },
        readyForSpec: false,
      });
  } else {
    final =
      'Got it, that gives me a clear picture: a web todo app with a shared list, no accounts for now. One optional point, then I can write the spec whenever you click **Write the spec**.' +
      block({
        questions: [{ id: 'Q4', text: 'Should finished todos stay visible?', options: ['Yes, crossed out', 'Hide them'] }],
        coverage: { users: 'done', scope: 'done', flows: 'done', data: 'done', integrations: 'done', platform: 'done', quality: 'partial', done: 'done' },
        readyForSpec: true,
      });
  }
  await say(final);
} else if (kind === 'write-spec' || kind === 'interview-brief') {
  await tool('Read', { file_path: 'templates/docs/spec.md' });
  write('.yourteam/spec.md', '# Demo Todo App — Spec\n\nRequest type: product\n\n## 1. Problem and goal\nA simple todo list app (demo spec written by the mock CEO).\n\n## 3. Scope\n### Must have\n- Add, complete and delete todos\n- Persist todos via a REST API\n\n## 10. Assumptions\n- Single user, no accounts.\n\n## Change log\n- initial spec\n');
  await tool('Write', { file_path: '.yourteam/spec.md' });
  final = 'I wrote the spec: a single-user todo web app with a REST API. Main assumption: no accounts.';
  await say(final);
} else if (kind === 'cto-chat') {
  const planMode = /Plan review: you may edit|nothing is being built yet/.test(prompt);
  await tool('Read', { file_path: '.yourteam/plan.json' });
  if (planMode) {
    const plan = JSON.parse(fs.readFileSync(yt('plan.json'), 'utf8'));
    if (!plan.phases.some((p) => p.id === 'P3')) {
      plan.phases.push({ id: 'P3', title: 'Polish and docs', goal: 'README and small UI polish', steps: [{ agent: 'frontend', tasks: [{ id: 'P3-T1', title: 'Polish UI and write README', details: 'Spacing, empty state, README with run steps', acceptance: ['README explains how to run'] }] }], qa: { criteria: ['README explains how to run', 'Empty list shows a friendly message'] } });
      plan.phases[1].title = 'Todos end to end (with validation)';
      fs.writeFileSync(yt('plan.json'), JSON.stringify(plan, null, 2));
      await tool('Edit', { file_path: '.yourteam/plan.json' });
    }
    final = 'Done. I renamed P2 to include validation and added **P3 Polish and docs** for the README and empty states. Have a look at the diff below.';
  } else {
    await tool('Grep', { pattern: 'title', path: 'src' }, 'src/frontend.js:12');
    final =
      'Thanks for testing. That is in the frontend form: it submits without checking the title. I will have the frontend agent add validation, and QA will verify it before the next phase.' +
      block({ changeOrders: [{ type: 'fix', title: 'Reject empty todo titles', steps: [{ agent: 'frontend', items: ['Submitting the add form with an empty title adds a blank todo. Show an inline error instead.'] }], acceptance: ['Submitting an empty title shows an error and adds nothing'] }] });
  }
  await say(final);
} else if (kind === 'plan' || kind === 'plan-fix' || kind === 'replan') {
  await tool('Read', { file_path: '.yourteam/spec.md' });
  write('.yourteam/architecture.md', '# Architecture\n\nNode HTTP API + static frontend (mock).\n');
  write('.yourteam/conventions.md', '# Conventions\n\n- Run: `node server.js`\n- Test: `node --test`\n');
  write('.yourteam/contracts/api.md', '# API\n\n| Method | Path | Body | Response |\n|---|---|---|---|\n| GET | /todos | - | Todo[] |\n| POST | /todos | {title} | Todo |\n');
  write('.yourteam/decisions/001-stack.md', '# 001 Stack\n\nDecision: plain Node, no framework.\n');
  write('.yourteam/run.json', { command: 'node server.js', cwd: '.', url: 'http://localhost:4599' });
  write('.yourteam/skill-suggestions.json', { suggestions: [{ skill: 'impeccable', agents: ['frontend'], reason: 'Keeps the todo UI polished and accessible instead of generic.' }, { skill: 'ponytail', agents: ['backend'], reason: 'The API is small; this keeps the backend from being over-engineered.' }] });
  for (const id of ['backend', 'frontend', 'qa']) write(`.yourteam/agents/${id}.md`, fs.readFileSync(path.join(TEMPLATES, `${id}.md`), 'utf8'));
  write('.yourteam/roster.json', {
    agents: [
      { id: 'backend', name: 'Backend Engineer', description: 'Todo API', model: 'sonnet', tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'], template: 'backend' },
      { id: 'frontend', name: 'Frontend Engineer', description: 'Todo UI', model: 'sonnet', tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'], template: 'frontend' },
      { id: 'qa', name: 'QA Engineer', description: 'Verifies phases', model: 'sonnet', tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'], template: 'qa' },
    ],
  });
  const phases = [
    { id: 'P1', title: 'Project setup', goal: 'Server starts and health check passes', steps: [{ agent: 'backend', tasks: [{ id: 'P1-T1', title: 'Scaffold server', details: 'server.js with /health', acceptance: ['GET /health returns 200'] }] }], qa: { criteria: ['GET /health returns 200'], how: 'node server.js & curl /health' } },
    {
      id: 'P2',
      title: 'Todos end to end',
      goal: 'Users can add and list todos in the UI',
      steps: [
        { agent: 'backend', tasks: [{ id: 'P2-T1', title: 'Todo API', details: 'GET/POST /todos', acceptance: ['POST then GET returns the todo'] }] },
        { agent: 'frontend', tasks: [{ id: 'P2-T2', title: 'Todo page', details: 'List and add todos', acceptance: ['Added todo appears in list'] }] },
      ],
      qa: { criteria: ['Adding a todo in the UI shows it in the list'], how: 'run tests' },
    },
  ];
  if (kind === 'replan' || prompt.includes('<feedback>')) phases.push({ id: 'P3', title: 'Change request', goal: 'Apply the requested change', steps: [{ agent: 'frontend', tasks: [{ id: 'P3-T1', title: 'Apply change', details: 'as requested', acceptance: ['change visible'] }] }], qa: { criteria: ['change visible'] } });
  write('.yourteam/plan.json', { mode: 'product', summary: 'Demo plan: setup, then todos end to end.', phases });
  await tool('Write', { file_path: '.yourteam/plan.json' });
  final = `Stack: plain Node. Team: backend, frontend, QA. Phases: ${phases.map((p) => p.id).join(', ')}.`;
  await say(final);
} else if (kind === 'qa') {
  const round = Number((prompt.match(/QA round (\d+)/) || [])[1] || 1);
  const md = (prompt.match(/1\. (\.yourteam\/qa\/\S+\.md)/) || [])[1];
  const json = (prompt.match(/2\. (\.yourteam\/qa\/\S+\.json)/) || [])[1];
  await tool('Bash', { command: 'node --test' }, 'tests 3 passed');
  await tool('Bash', { command: 'curl -s localhost:4599/health' }, '{"ok":true}');
  const fail = phase === 'P2' && round === 1;
  write(md, `# QA ${phase} round ${round}\n\n${fail ? 'FAIL: empty titles are accepted.' : 'PASS: all criteria verified.'}\n\n## How to test manually\n1. Click Run app.\n2. Open the app and add a todo.\n`);
  write(json, {
    verdict: fail ? 'fail' : 'pass',
    summary: fail ? 'Adding works, but empty todo titles are accepted and shown.' : 'All criteria verified.',
    checks: [{ criterion: 'Main criterion', result: fail ? 'fail' : 'pass', evidence: 'node --test: 3 passed' }],
    issues: fail ? [{ agent: 'frontend', severity: 'high', title: 'Empty titles accepted', details: 'Submitting an empty form adds a blank todo.' }] : [],
    manualTests: ['Click Run app in the dashboard', 'Open http://localhost:4599', 'Check the page says "YourTeam demo app"', 'Open /api/quote and check it returns JSON'],
  });
  final = fail ? 'QA failed: 1 high-severity issue.' : 'QA passed.';
  await say(final);
} else if (handoffPath && reportPath) {
  await tool('Read', { file_path: '.yourteam/conventions.md' });
  write(`src/${agent}-${phase}-${Date.now()}.txt`, `work by ${agent} in ${phase} (${kind})\n`);
  if (agent === 'backend' && !fs.existsSync(path.join(root, 'server.js'))) write('server.js', SERVER_JS);
  await tool('Write', { file_path: `src/${agent}.js` });
  await tool('Bash', { command: 'node --test' }, 'tests passed');
  let report = { status: 'done', summary: `${agent} finished its ${kind} work in ${phase}.`, tasksDone: [], tasksRemaining: [], filesChanged: [`src/${agent}.js`], messages: [], questions: [] };
  const key = `${phase}-${agent}`;
  if (agent === 'frontend' && phase === 'P2' && kind === 'work' && !mem[key]) {
    mem[key] = 1;
    report = { ...report, status: 'waiting', summary: 'UI is built, but POST /todos returns 500 so todos cannot be saved.', messages: [{ to: 'backend', type: 'bug-report', text: 'POST /todos with {"title":"x"} returns 500 (TypeError: body undefined). Contract says it returns the created Todo.' }] };
  } else if (kind === 'fix') {
    report.messages = [{ to: agent === 'backend' ? 'frontend' : 'qa', type: 'fix-done', text: `${agent} fixed the reported problem.` }];
  } else if (agent === 'backend' && phase === 'P2' && kind === 'work') {
    report.messages = [{ to: 'frontend', type: 'api-change', text: 'GET/POST /todos implemented as in contracts/api.md.' }];
    report.questions = [{ text: 'Should completed todos be hidden by default?', assumption: 'Shown, with a strikethrough.', blocking: false }];
  }
  saveMem();
  write(handoffPath, `# Handoff: ${phase} / ${agent}\n\nStatus: ${report.status}\n\n${report.summary}\n`);
  write(reportPath, report);
  await tool('Write', { file_path: reportPath });
  final = report.summary;
  await say(final);
} else if (kind === 'retro') {
  write('.yourteam/retro.md', '# Retrospective\n\nDelivered the demo.\n\n## Lessons\n- Put the API contract in place before frontend work starts.\n- Size steps so one session can finish them.\n');
  final = 'Retro written.';
  await say(final);
} else {
  await say(final);
}

const cost = Number((0.02 + Math.random() * 0.15).toFixed(4));
emit({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: final,
  session_id: sessionId,
  num_turns: 4,
  total_cost_usd: cost,
  usage: { input_tokens: 400, output_tokens: 900, cache_read_input_tokens: ctx * 3, cache_creation_input_tokens: 5000 },
  modelUsage: { [`claude-${model}-mock`]: { contextWindow: 200000, costUSD: cost } },
});
