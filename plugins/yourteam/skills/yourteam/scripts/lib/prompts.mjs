// Prompt builders. Every agent session starts empty, so each prompt is a self-contained
// "context pack": who you are, what to read, what to do, and where to write results.
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DIR } from './paths.mjs';

export const TEMPLATES_DIR = path.join(SKILL_DIR, 'templates');

export function stripFrontmatter(text) {
  return text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

export function parseFrontmatter(text) {
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (!m) return meta;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else v = v.replace(/^["']|["']$/g, '');
    meta[kv[1]] = v;
  }
  return meta;
}

export function listTemplates() {
  const dir = path.join(TEMPLATES_DIR, 'agents');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      return { file: f, ...parseFrontmatter(text) };
    });
}

export function templateText(id) {
  try {
    return fs.readFileSync(path.join(TEMPLATES_DIR, 'agents', `${id}.md`), 'utf8');
  } catch {
    return null;
  }
}

const SHARED_DOCS = [
  '.yourteam/spec.md - what the customer wants (the source of truth for scope)',
  '.yourteam/architecture.md - tech stack, structure, key design',
  '.yourteam/conventions.md - code style, folder layout, how to run, build and test',
  '.yourteam/contracts/ - API and interface contracts shared between agents',
  '.yourteam/decisions/ - short records of decisions already made (do not re-argue them)',
  '.yourteam/project-map.md - map of the existing codebase (only when the project had code before YourTeam)',
];

function teamPreamble(name) {
  return `You are ${name}, a member of YourTeam: an AI software team run by an orchestrator program.

How YourTeam works:
- You run as one headless session with no human watching. Nobody can answer a question mid-session, so never wait for input. If you truly cannot continue, finish cleanly and report it (see the report format in your task).
- You remember nothing from earlier sessions. Your memory is the files in .yourteam/ and the code itself. Read what you need, not everything: your context window is limited and a fresh session will continue after you if needed.
- The customer is the human who owns this project. Questions for them go in your report; the orchestrator shows them in the dashboard.
- Other agents read what you write. Keep handoffs short, factual and specific (file paths, endpoints, commands).
- Stay inside your role and your assigned tasks. If you notice work outside your scope, mention it in your report instead of doing it.
- The working directory is the project root. Use relative paths.`;
}

export function roleSystem(store, agent) {
  const custom = store.readText(`agents/${agent.id}.md`, null);
  const text = custom ?? templateText(agent.template || agent.id) ?? '';
  return `${teamPreamble(agent.name || agent.id)}\n\n# Your role\n\n${stripFrontmatter(text)}`;
}

function list(items) {
  return items.map((s) => `- ${s}`).join('\n');
}

function fmtMessages(messages) {
  if (!messages.length) return '(none)';
  return messages.map((m) => `- [${m.type}] from ${m.from}${m.phase ? ` (${m.phase})` : ''}: ${m.text}`).join('\n');
}

const REPORT_SCHEMA = `{
  "status": "done | partial | waiting | blocked",
  "summary": "2-5 sentences: what you did and the state you left things in",
  "tasksDone": ["task ids you completed"],
  "tasksRemaining": ["task ids not finished"],
  "filesChanged": ["relative paths"],
  "messages": [
    { "to": "agent id or all", "type": "api-change | bug-report | fix-done | info | question", "text": "specific, actionable" }
  ],
  "questions": [
    { "text": "question for the customer", "assumption": "what you assumed so you could keep going, or empty if you could not", "blocking": false }
  ]
}`;

const STATUS_RULES = `Status meanings:
- done: every assigned task is complete and verified as far as you can (it builds, your tests pass).
- partial: you made solid progress but stopped at a clean point because the work was larger than one session or your context is getting long. A fresh session of your role will continue from your handoff. Prefer this over rushing.
- waiting: you cannot finish because another agent's work is broken or missing. Send that agent a bug-report message describing exactly what is wrong; the orchestrator runs their fix and then starts a fresh session of you.
- blocked: you need the customer's decision before any meaningful progress. Add a question with "blocking": true. Use this rarely: when a reasonable assumption exists, take it, record it as a non-blocking question, and continue.`;

export function interviewFirst({ text, existingCode, brief }) {
  const code = existingCode
    ? 'This folder already contains code. Look around it (Glob, Read) before asking about tech, so your questions are informed, and treat the request as changing an existing product unless the customer says otherwise.'
    : 'This folder is empty or nearly empty: this is a new product.';
  if (brief) {
    return `YOURTEAM_TASK_KIND: interview-brief

The customer skipped the interview and gave this brief:

<brief>
${text}
</brief>

${code}

Write the product spec now to .yourteam/spec.md using the spec template (read ${path.join(TEMPLATES_DIR, 'docs', 'spec.md')}). Where the brief is silent, make sensible assumptions and list every one of them under "Assumptions" so the customer can correct them. Then reply with a short summary of the spec and the main assumptions.`;
  }
  return `YOURTEAM_TASK_KIND: interview

You are starting the discovery interview with the customer. ${code}

The customer's first message:

<customer>
${text}
</customer>

Run the interview as a conversation, one turn at a time:
- Ask at most 3-4 focused questions per turn, most important first, each with 2-4 short suggested answers so replying is fast.
- Cover: the problem and the users, core features and what is out of scope, key user flows, data and integrations, platform (web, mobile, desktop, CLI, API...), non-functional needs (scale, security, offline, accessibility), and what "done" looks like. Skip anything already answered.
- Do not pick the tech stack in detail; the CTO decides that. Do record any hard constraints the customer states.
- When you have a clear picture (usually 3-6 turns), say so and offer to write the spec. Do not write .yourteam/spec.md until the customer agrees or the orchestrator asks you to.

${INTERVIEW_FORMAT}`;
}

// The dashboard turns this block into question cards and a coverage checklist.
const INTERVIEW_FORMAT = `Reply format (important, the dashboard depends on it):
- Write a short, friendly lead-in in plain prose (what you understood, what you need next). Do not list the questions in prose.
- End EVERY reply with one fenced code block tagged yourteam containing JSON:
\`\`\`yourteam
{
  "questions": [ { "id": "Q1", "text": "the question", "options": ["short answer", "another"] } ],
  "coverage": { "users": "todo", "scope": "todo", "flows": "todo", "data": "todo", "integrations": "todo", "platform": "todo", "quality": "todo", "done": "todo" },
  "readyForSpec": false
}
\`\`\`
- Number questions Q1, Q2, ... continuing across the whole conversation; never reuse a number. Options are at most 6 words each. The customer can always answer in their own words.
- Coverage values are "todo", "partial" or "done", reflecting what you know so far. Set "readyForSpec" to true once you could write a solid spec, with an empty questions list or only optional ones.
- The customer may refer to a question as #Q3 and may quote your earlier messages with "> ".`;

export const INTERVIEW_TURN_SUFFIX = '\n\n[Reminder: end your reply with the yourteam JSON block: questions, coverage, readyForSpec.]';

// Pulls the last ```yourteam JSON block out of an agent reply. Returns the reply without it.
export function extractBlock(text) {
  const src = String(text || '');
  const re = /```yourteam[^\n]*\n([\s\S]*?)```/g;
  let m;
  let last = null;
  while ((m = re.exec(src))) last = m;
  if (!last) return { clean: src.trim(), data: null };
  let data = null;
  try {
    data = JSON.parse(last[1]);
  } catch {
    data = null;
  }
  return { clean: (src.slice(0, last.index) + src.slice(last.index + last[0].length)).trim(), data };
}

const CHANGE_ORDER_FORMAT = `Change orders: to have the team do something, end your reply with one fenced block tagged yourteam:
\`\`\`yourteam
{ "changeOrders": [ ... ] }
\`\`\`
Types (every order also has a short "title"):
- {"type": "fix", "title": "...", "steps": [{"agent": "frontend", "items": ["what is wrong and how to reproduce it", "..."]}], "acceptance": ["how QA verifies the fix"]}
  Runs as a small fix phase (each step in order, then QA) before the next planned phase.
- {"type": "add-phase", "title": "...", "position": "next | end | after:P3", "phase": { a full phase object in the plan.json format, with a new unique id }}
- {"type": "update-phase", "title": "...", "id": "P4", "phase": { the fields to replace: title, goal, steps, qa }}   (only phases that have not started)
- {"type": "remove-phase", "title": "...", "id": "P5"}   (only phases that have not started)
- {"type": "add-agent", "title": "...", "agent": {"id": "security", "name": "...", "description": "...", "model": "sonnet", "tools": ["Read","Write","Edit","Glob","Grep","Bash","PowerShell"], "template": "security"}, "role": "optional full role markdown"}
- {"type": "message", "title": "...", "to": "backend", "text": "a note delivered to that agent's next session"}
- {"type": "spec-change", "title": "...", "text": "what changes in the spec; appended to its change log"}
The customer reviews each order and clicks Apply; nothing happens until then. Omit the block when there is nothing to propose.`;

const CTO_PLAN_REVIEW_RULES = `The plan is waiting for the customer's approval, and nothing is being built yet. Apply what the customer asks by editing the files directly: .yourteam/plan.json, roster.json, agents/<id>.md, architecture.md, conventions.md, contracts/, run.json. Keep plan.json and roster.json valid in the same format. The dashboard shows the customer a diff of your plan and team changes after each reply, so describe the change briefly instead of repeating the plan. Do not write application code. If a request is unclear or has a real trade-off, ask first.
Skills from the catalog are chosen by the customer in the Skills tab. You can recommend one (by its catalog id and the agent it fits), but you cannot add it yourself.`;

const CTO_BUILD_RULES = `The build is under way or finished. Do not edit plan.json, roster.json or application code yourself; the orchestrator reverts direct plan edits made in this chat. You may read anything: the code, .yourteam/handoffs/, .yourteam/qa/, .yourteam/reports/, git history.
When the customer reports a problem or asks for a change:
1. Work out what is wrong and which agent owns it. Read the code or the handoffs when you are not sure.
2. Explain in plain language what you will have the team do.
3. Propose change orders. Prefer one focused order per problem, with concrete repro steps and acceptance criteria.
If the request is ambiguous, ask a clarifying question instead of guessing. You can also just answer questions about the project.
Skills from the catalog are chosen by the customer in the Skills tab. You can recommend one (by its catalog id and the agent it fits), but you cannot add it yourself.`;

export function ctoChatPrompt({ first, modeChanged, canEditPlan, status, text }) {
  const rules = `${canEditPlan ? CTO_PLAN_REVIEW_RULES : CTO_BUILD_RULES}\n\n${CHANGE_ORDER_FORMAT}`;
  if (!first) {
    // The rules are only repeated when the stage switched since the thread started.
    const mode = modeChanged ? `\n[The project moved to a new stage. From now on:]\n${rules}` : canEditPlan ? '[Plan review: you may edit the plan files directly.]' : '[Build mode: propose change orders; do not edit plan or code.]';
    return `YOURTEAM_TASK_KIND: cto-chat
[Status update from the orchestrator]
${status}
${mode}

${text}`;
  }
  return `YOURTEAM_TASK_KIND: cto-chat

You are now talking directly with the customer in the CTO chat of the YourTeam dashboard. The conversation can continue over many turns, and each turn starts with a status update from the orchestrator. Keep replies short and concrete.

Project status:
${status}

${rules}

The customer's message:
<customer>
${text}
</customer>`;
}

export function finalizeSpecMessage() {
  return `YOURTEAM_TASK_KIND: write-spec

[Orchestrator] The customer wants the spec written now. Write it to .yourteam/spec.md following the template at ${path.join(TEMPLATES_DIR, 'docs', 'spec.md')}. Include everything agreed in this conversation; put open points under "Assumptions" with the assumption you chose. Then reply with a brief summary.`;
}

function templateCatalog() {
  return listTemplates()
    .filter((t) => !['ceo', 'cto'].includes(t.id))
    .map((t) => `- ${t.file.replace(/\.md$/, '')}: ${t.description || ''} (default model: ${t.model || 'sonnet'})`)
    .join('\n');
}

const PLAN_RULES = `Planning rules:
- Phases are vertical slices that each end in something testable. Phase 1 is usually setup: scaffolding, tooling, a test harness and a health check that QA can run.
- Size every step so ONE focused session of that agent can finish it (roughly 1-6 related tasks touching a coherent area). A fresh session runs every step, so smaller and clearer is better than big and vague. The project can have as many phases as it needs.
- Within a phase, steps run in order. When a phase has backend and frontend work, put the backend step first so the API exists and is in contracts/ before the frontend uses it.
- Every task has concrete acceptance criteria. Every phase has QA criteria that QA can verify by running something (tests, a build, a curl request, a script, starting the app).
- Cover the whole product: setup, features, error handling, tests, docs (README with how to run), and anything the spec calls for (auth, deployment, seed data...). Nothing in the spec should be left without a task, and nothing outside the spec should be added without listing it as an assumption.
- The customer can test the product between phases (the dashboard starts it with .yourteam/run.json), so order phases so each one leaves something the customer can try.`;

const PLAN_FILES = `Write these files:
1. .yourteam/architecture.md - stack and why, structure, main components, data model, how the parts talk.
2. .yourteam/conventions.md - folder layout, code style, and the exact commands to install, run, build and test. QA and every developer rely on these commands.
3. .yourteam/contracts/ - the initial API or interface contracts (an OpenAPI file, typed interfaces, or a markdown table of endpoints) that backend and frontend will build against. Skip only if there is no boundary between agents.
4. .yourteam/decisions/001-<slug>.md ... - one short file per important decision (context, decision, consequences).
5. .yourteam/roster.json - the team, in the format below.
6. .yourteam/agents/<id>.md - one role file per agent in the roster. Start from a template when one fits (copy it and tailor it to this project's stack and conventions), or write a new role when the project needs a specialist no template covers (for example a payments-integration agent or a game-physics agent). Keep the frontmatter fields id, name, description, model, tools.
7. .yourteam/plan.json - the phased plan, in the format below.
8. .yourteam/run.json - how to start the product so the customer can try it from the dashboard: {"command": "npm run dev", "cwd": ".", "url": "http://localhost:3000"}. Use the command a developer would run locally (no install step), and the URL to open, or null for a CLI or library. Developers keep this file correct as the project grows.

roster.json format:
{
  "agents": [
    { "id": "backend", "name": "Backend Engineer", "description": "what this agent owns", "model": "sonnet", "tools": ["Read","Write","Edit","Glob","Grep","Bash","PowerShell","WebSearch","WebFetch"], "template": "backend" }
  ]
}
The roster must include "qa". Do not include "ceo" or "cto"; they are always present. Use ids made of lowercase letters, digits and hyphens. Models: "opus" for the hardest reasoning, "sonnet" for most building, "haiku" for simple mechanical work.

plan.json format:
{
  "mode": "product | feature | bugfix | refactor | spike",
  "summary": "one paragraph",
  "phases": [
    {
      "id": "P1",
      "title": "Project setup",
      "goal": "what is true when this phase is done",
      "steps": [
        { "agent": "backend", "tasks": [ { "id": "P1-T1", "title": "...", "details": "what to build, where, and any constraints", "acceptance": ["verifiable criterion"] } ] }
      ],
      "qa": { "criteria": ["verifiable criterion"], "how": "commands or checks QA should run" }
    }
  ]
}`;

export function skillsNote(skills) {
  if (!skills?.length) return '';
  const lines = skills.map((s) => `- ${s.name} (yt-${s.id}:${s.skillName}): ${String(s.description).replace(/\s+/g, ' ').slice(0, 300)}`);
  return `\n\n# Skills loaded for you\nThe customer chose these skills for your role. They are loaded in this session as plugin skills named yt-<id>:<skill>. Use them whenever your task touches their area, and read their reference files when a skill tells you to:\n${lines.join('\n')}\nIf a skill conflicts with .yourteam/conventions.md, the contracts or the spec, the project documents win.`;
}

function skillCatalogText(catalog) {
  if (!catalog?.length) return '';
  const lines = catalog.map((s) => `- ${s.id}: ${s.name} [${s.group}] ${s.description}${s.recommendedFor?.length ? ` (fits: ${s.recommendedFor.join(', ')})` : ''}`);
  return `\n\nSkill catalog. The customer can attach these third-party skills to agents; a skill is downloaded only if the customer agrees:
${lines.join('\n')}
Write .yourteam/skill-suggestions.json with the skills you recommend for this project, or an empty list if none fit:
{"suggestions": [{"skill": "<catalog id>", "agents": ["<roster agent id>"], "reason": "one sentence on why it helps this project"}]}
Suggest a skill only when it clearly helps this product. At most 3 skills per agent, and at most one skill from the "design" group per agent, because overlapping design skills give conflicting direction. The plan must work without any skill, since the customer may decline.`;
}

export function planPrompt({ existingCode, lessons, feedback, errors, mode, skillCatalog }) {
  const scan = existingCode
    ? `This project already has code. Before planning, explore it and write .yourteam/project-map.md: stack, structure, entry points, how to run and test it, conventions you observed, and risky areas. Plan changes that fit the existing code instead of rewriting it.`
    : 'This is a new project with no existing code.';
  const fix = errors?.length
    ? `\n\nYour previous plan files failed validation. Fix exactly these problems (keep everything else):\n${list(errors)}`
    : '';
  const fb = feedback ? `\n\nThe customer reviewed the previous plan and asked for these changes:\n<feedback>\n${feedback}\n</feedback>\nUpdate the plan and roster accordingly.` : '';
  const learned = lessons?.trim() ? `\n\nLessons from earlier YourTeam projects (apply what is relevant):\n${lessons.trim()}` : '';
  return `YOURTEAM_TASK_KIND: ${errors?.length ? 'plan-fix' : 'plan'}

Read .yourteam/spec.md. As CTO, choose the stack, design the system, hire the team and write the phased plan that delivers the whole spec. ${scan}${mode ? ` The CEO classified this request as: ${mode}. Match the plan's size to it (a bug fix may be one phase).` : ''}

Agent templates you can hire from (files in ${path.join(TEMPLATES_DIR, 'agents')}):
${templateCatalog()}

${PLAN_FILES}

${PLAN_RULES}${skillCatalogText(skillCatalog)}${learned}${fb}${fix}

Finish by replying with a short summary: the stack, the team, and the phases.`;
}

export function replanPrompt({ changeRequests, feedback, phaseStatus, errors }) {
  const crs = changeRequests?.length ? `Change requests from the customer:\n${list(changeRequests.map((c) => c.text))}\n` : '';
  const fb = feedback ? `Customer feedback on the plan:\n<feedback>\n${feedback}\n</feedback>\n` : '';
  const fix = errors?.length ? `\nYour previous edit failed validation. Fix exactly these problems:\n${list(errors)}\n` : '';
  return `YOURTEAM_TASK_KIND: ${errors?.length ? 'plan-fix' : 'replan'}

You are the CTO updating the plan of a project that is already under way.

${crs}${fb}
Current phase status (do not change phases that are done or in progress; you may change, reorder, add or remove pending phases):
${phaseStatus}

Steps:
1. If the change affects scope, update .yourteam/spec.md (add a "Change log" entry with the date).
2. Update .yourteam/plan.json, and roster.json plus .yourteam/agents/<id>.md if the change needs a new specialist. New phases get new ids that are not used yet.
3. Update architecture.md, conventions.md, contracts/ or decisions/ if the change affects them.

${PLAN_RULES}
${fix}
Reply with a short summary of what changed in the plan.`;
}

export function workPrompt({ kind, phase, step, agent, sessionNo, handoffPath, reportPath, messages, handoffs, previous, fix, answers }) {
  const tasks = JSON.stringify(step?.tasks || [], null, 2);
  const docs = list(SHARED_DOCS);
  const prev = previous ? `\nYour previous session on this step left this handoff (read it first, then continue from where it stopped):\n${previous}\n` : '';
  const others = handoffs.length ? `\nHandoffs from earlier work in this phase (read the ones relevant to you):\n${list(handoffs)}\n` : '';
  const ans = answers?.length ? `\nAnswers from the customer:\n${answers.map((a) => `- Q: ${a.q}\n  A: ${a.a}`).join('\n')}\n` : '';
  let mission;
  if (kind === 'fix') {
    mission = `This is a FIX session. Fix the problems below that were found in your area during ${phase.id}. Do not start new features. After fixing, verify (run the build or tests) and send a "fix-done" message to whoever reported each problem, saying what changed.

Problems to fix:
${fix.map((f) => `- ${f}`).join('\n')}`;
  } else {
    mission = `Your step in phase ${phase.id} "${phase.title}". Phase goal: ${phase.goal}

Your tasks:
${tasks}`;
  }
  return `YOURTEAM_TASK_KIND: ${kind}
Agent: ${agent.id} | Phase: ${phase.id} | Session ${sessionNo} on this ${kind === 'fix' ? 'fix' : 'step'}

${mission}

Project documents (read what you need; conventions.md and contracts/ are the most important):
${docs}
${prev}${others}
Messages addressed to you:
${fmtMessages(messages)}
${ans}
How to work:
- Follow conventions.md. If you change an API or a shared interface, update the matching file in .yourteam/contracts/ and send an "api-change" message to the agents that use it. If you change how the product starts, update .yourteam/run.json.
- Verify your own work before reporting: build it, run the relevant tests, and add tests for what you built when the conventions call for them.
- If a decision affects other agents, record it as a new file in .yourteam/decisions/.
- If something another agent owns is broken, do not fix it yourself: send them a "bug-report" with the exact error, the request or command that triggers it, and what you expected.

Before you finish, ALWAYS write both files:
1. Handoff: ${handoffPath}
   Markdown, at most about 40 lines: what you did, files touched, how to run or check it, open issues, and the exact next step if you stopped early. Template: ${path.join(TEMPLATES_DIR, 'docs', 'handoff.md')}
2. Report: ${reportPath}
   JSON in this shape:
${REPORT_SCHEMA}

${STATUS_RULES}`;
}

export function qaPrompt({ phase, round, reportPath, mdPath, handoffs, previous, messages }) {
  const prev = previous ? `\nThe previous QA round for this phase found these issues; check each one is really fixed:\n${previous}\n` : '';
  return `YOURTEAM_TASK_KIND: qa
Agent: qa | Phase: ${phase.id} | QA round ${round}

Verify phase ${phase.id} "${phase.title}". Phase goal: ${phase.goal}

QA criteria:
${list(phase.qa?.criteria || [])}
${phase.qa?.how ? `\nHow to check (from the CTO): ${phase.qa.how}\n` : ''}
Task acceptance criteria for this phase:
${JSON.stringify((phase.steps || []).map((s) => ({ agent: s.agent, tasks: (s.tasks || []).map((t) => ({ id: t.id, title: t.title, acceptance: t.acceptance })) })), null, 2)}

Read .yourteam/conventions.md for how to install, run, build and test. Handoffs from this phase:
${handoffs.length ? list(handoffs) : '(none)'}
${prev}
Messages addressed to you:
${fmtMessages(messages)}

How to test:
- Actually run things: install, build, run the test suite, start the app or server and exercise it (curl, scripts, a headless browser if one is installed). Reading code is not enough to pass a criterion.
- You may write or extend automated tests, but do not change application code. Problems go back to the owning agent.
- Stop any server or process you started before you finish.
- Be strict about the criteria and fair about scope: do not fail the phase for work planned in later phases.

Write both files before you finish:
1. ${mdPath} - a readable QA report: what you ran, results, issues, and a "How to test manually" section.
2. ${reportPath} - JSON:
{
  "verdict": "pass | fail",
  "summary": "2-4 sentences",
  "checks": [ { "criterion": "...", "result": "pass | fail", "evidence": "command and what it showed" } ],
  "issues": [ { "agent": "id of the agent who owns the fix", "severity": "high | medium | low", "title": "...", "details": "steps to reproduce, expected, actual" } ],
  "manualTests": [ "3-6 short steps the customer can follow to try this phase by hand, e.g. 'Run node server.js, open http://localhost:3000, add an empty quote: an error appears'" ]
}
Use "fail" if any criterion fails or any high-severity issue exists. Low-severity issues alone do not fail a phase; list them anyway.`;
}

export function retroPrompt({ stats }) {
  return `YOURTEAM_TASK_KIND: retro

The project is complete. Write a short retrospective to .yourteam/retro.md:
- What was delivered versus the spec (read .yourteam/spec.md and .yourteam/plan.json).
- What went well and what went wrong, using the numbers below and the QA reports in .yourteam/qa/.
- A final section titled exactly "## Lessons" with 3-6 bullet points of general, reusable advice for planning future projects (not specific to this product). These are saved and shown to future CTO sessions.

Run statistics:
${stats}

Reply with a two-line summary.`;
}
