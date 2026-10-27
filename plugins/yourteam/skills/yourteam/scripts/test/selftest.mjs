#!/usr/bin/env node
// End-to-end check of the orchestrator with the mock CLI:
// interview with question cards -> spec -> plan -> CTO chat edits the plan -> phases with an
// auto-run gate, the fix loop and a failed QA round -> Run app -> CTO change order -> fix phase
// -> retro -> change request.
// Usage: node selftest.mjs [projectDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { Orchestrator } from '../lib/orchestrator.mjs';
import * as git from '../lib/git.mjs';

process.env.YOURTEAM_MOCK_DELAY = process.env.YOURTEAM_MOCK_DELAY || '0';
const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'yourteam-selftest-'));
const store = new Store(dir);
const orch = new Orchestrator(store, { demo: true });
orch.init();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, label, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred(orch.state())) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}; status=${orch.state().status}\n${JSON.stringify(orch.state(), null, 2)}`);
}
const chatIdle = () => waitFor(() => !orch.chatActive, 'chat reply');
const step = (s) => console.log(`- ${s}`);

try {
  // Interview with structured questions.
  await orch.action('chat', { text: 'A todo app for my team' });
  await sleep(100);
  await chatIdle();
  const ceo = orch.chatLog().at(-1);
  assert.equal(ceo.role, 'ceo');
  assert.equal(ceo.questions.length, 3, 'CEO reply carries question cards');
  assert.ok(!ceo.text.includes('```yourteam'), 'the JSON block is stripped from the visible reply');
  await orch.action('chat', { text: 'Also see #Q1.', answers: [{ id: 'Q1', question: ceo.questions[0].text, answer: 'My small team' }] });
  await sleep(100);
  await chatIdle();
  assert.ok(orch.chatLog().at(-1).readyForSpec, 'second reply says the spec can be written');
  assert.equal(orch.state().coverage.users, 'done');
  step('interview: question cards, answers, #Q refs and coverage work');

  await orch.action('finalize-spec');
  await waitFor((s) => s.status === 'spec_review', 'spec review');
  await orch.action('approve-spec');
  await waitFor((s) => s.status === 'plan_review', 'plan review');
  assert.equal(orch.plan().phases.length, 2);
  step('spec approved; CTO produced a valid plan');

  // CTO chat edits the plan directly during review and the diff is recorded.
  await orch.action('cto-chat', { text: 'Add a polish phase please' });
  await sleep(100);
  await chatIdle();
  const th = orch.state().cto.threads[0];
  const reply = orch.ctoLog(th.id).at(-1);
  assert.equal(orch.plan().phases.length, 3);
  assert.ok(reply.planChanges.some((c) => c.op === 'add' && c.text.startsWith('P3')), 'diff shows the new phase');
  assert.ok(!reply.planErrors, 'edited plan is valid');
  step(`CTO chat changed the plan: ${reply.planChanges.map((c) => `${c.op} ${c.text}`).join('; ')}`);

  // Auto-run off for P2: the team stops before it.
  await orch.action('set-autorun', { phase: 'P2', value: false });
  await orch.action('approve-plan');
  await waitFor((s) => s.status === 'awaiting_approval', 'P2 start gate');
  const gate = orch.inbox().find((i) => i.kind === 'phase-start' && i.status === 'open');
  assert.equal(gate.phase, 'P2');
  assert.ok(gate.manualTests.length > 0, 'gate shows manual test steps from P1 QA');
  assert.equal(orch.state().phases.P1.status, 'done');
  step('P1 done; stopped before P2 with manual test steps');

  // Run app between phases.
  orch.action('app-start');
  const until = Date.now() + 10000;
  while (!orch.app.info().ready && Date.now() < until) await sleep(100);
  assert.equal(orch.app.info().status, 'running');
  assert.ok(orch.app.info().url?.includes('4599'), `app URL detected (${orch.app.info().url})`);
  const body = await (await fetch(orch.app.info().url)).text();
  assert.ok(body.includes('YourTeam demo app'));
  await orch.action('app-stop');
  while (orch.app.info().status === 'running' && Date.now() < until + 5000) await sleep(100);
  step('Run app started the product, detected its URL, served the page, and stopped');

  await orch.action('start-phase', { phase: 'P2' });
  await waitFor((s) => s.status === 'done', 'done');
  const kinds = orch.sessions().filter((s) => s.phase === 'P2').map((s) => `${s.agent}:${s.kind}`);
  assert.deepEqual(kinds, ['backend:work', 'frontend:work', 'backend:fix', 'frontend:continue', 'qa:qa', 'frontend:fix', 'qa:qa']);
  assert.equal(orch.state().phases.P3.status, 'done', 'P3 ran without a gate (auto-run default)');
  assert.ok(store.exists('retro.md'));
  const files = git.diffNumstat(dir, 'yourteam/P2-start', 'yourteam/P2-done');
  assert.ok(files.length > 0, 'phase review can list files changed in P2');
  step(`P2 ran ${kinds.join(' -> ')}; P3 auto-ran; ${files.length} files changed in P2`);

  // CTO chat after the build proposes a change order instead of editing the plan.
  await orch.action('cto-chat', { text: 'I tested it: empty titles are accepted' });
  await sleep(100);
  await chatIdle();
  const co = orch.state().changeOrders.at(-1);
  assert.equal(co.type, 'fix');
  assert.equal(co.status, 'proposed');
  await orch.action('apply-change-order', { id: co.id });
  assert.ok(orch.plan().phases.some((p) => p.id === 'F1' && p.fix), 'fix phase inserted');
  await waitFor((s) => s.status === 'done' && s.phases.F1?.status === 'done', 'fix phase done');
  assert.ok(orch.sessions().some((s) => s.phase === 'F1' && s.agent === 'frontend'), 'frontend fixed it');
  assert.ok(orch.sessions().some((s) => s.phase === 'F1' && s.agent === 'qa'), 'QA verified it');
  step('CTO turned feedback into a change order; applying it ran a fix phase with QA');

  await orch.action('change-request', { text: 'Add dark mode' });
  await waitFor((s) => s.status === 'plan_review', 'replan review');
  step('change request after completion triggered a replan');

  assert.ok(!fs.existsSync(path.join(os.homedir(), '.yourteam', 'lessons.md')) || !fs.readFileSync(path.join(os.homedir(), '.yourteam', 'lessons.md'), 'utf8').includes(path.basename(dir)), 'demo runs do not write lessons');
  console.log(`\nSelf-test passed (${orch.sessions().length} sessions). Project: ${dir}`);
} finally {
  orch.app.stop();
}
