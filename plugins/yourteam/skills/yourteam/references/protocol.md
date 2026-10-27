# YourTeam protocol reference

Read this when you need exact file formats, the state machine, or config keys.

## Contents
1. Project layout
2. Project status values
3. Phase lifecycle
4. Agent session contract
5. Plan and roster formats
6. Config keys
7. Skill layout

## 1. Project layout (`<project>/.yourteam/`)

| Path | Written by | Purpose |
|---|---|---|
| `spec.md` | CEO | Requirements; the source of truth for scope |
| `project-map.md` | CTO | Map of pre-existing code (existing codebases only) |
| `architecture.md`, `conventions.md` | CTO | Stack, design, folder layout, and the run/build/test commands |
| `contracts/` | CTO, devs | API and interface contracts shared between agents |
| `decisions/NNN-*.md` | anyone | Decision records, so later sessions don't reopen them |
| `roster.json`, `agents/<id>.md` | CTO | The hired team and their role prompts |
| `plan.json` | CTO | Phases, steps and tasks |
| `handoffs/<phase>-<agent>-<nn>[-fix].md` | each session | Short handoff note for the next session |
| `reports/<same>.json` | each session | Machine-readable result (status, messages, questions) |
| `qa/<phase>-r<n>.md/.json` | QA | QA report per round |
| `run.json` | CTO, devs | How to start the product: `{"command", "cwd", "url", "env"}`; used by Run app |
| `retro.md` | CTO | Retrospective; its `## Lessons` section is appended to `~/.yourteam/lessons.md` |
| `state.json` | orchestrator | Status, phase and step states, totals, change requests |
| `sessions.json` | orchestrator | Every session: agent, kind, phase, tokens, cost, context peak, status |
| `inbox.json` | orchestrator | Questions, approvals, escalations and their answers |
| `messages.json` | orchestrator | Agent message board, with read receipts |
| `events.jsonl` | orchestrator | Timeline |
| `logs/<sessionId>.jsonl` | orchestrator | Raw stream-json output of each session |
| `chat/interview.json` | orchestrator | Interview transcript, with parsed question cards and coverage |
| `chat/cto-<thread>.json` | orchestrator | CTO chat threads, with plan diffs and change order ids |
| `config.json` | user | Settings |
| `server.json` | orchestrator | Port and pid of the running dashboard |

`.yourteam/` is added to `.git/info/exclude`, so it's never committed or rolled back.

## 2. Project status values

`interview` → `spec_review` → `planning` → `plan_review` → `running` ⇄ (`awaiting_answer` | `awaiting_approval` | `escalated` | `replanning`) → `finishing` → `done`.
`awaiting_approval` now means a phase with Auto-run off is waiting at its gate (or a legacy phase approval).
`paused` and `error` can happen at any point, and Resume returns to the stage that was interrupted. A change request while `running` moves to `replanning` before the next session. When it comes after `done`, it re-plans and the build resumes once the user approves.

After a crash or restart, any status that was mid-session becomes `paused` (unless `autoResume` is set). Sessions that were running are marked `interrupted`.

## 3. Phase lifecycle

```
pending ─(Auto-run off? wait for start-phase)─(git tag yourteam/<P>-start)→ building
building: fix queue first, then the next unfinished step, in order
   step session report:
     done     → step done; any bug-report messages to other agents queue fix sessions
     partial  → same step continues in a NEW session (up to limits.maxContinuations)
     waiting  → fix sessions for the agents it reported, then the step continues
     blocked  → blocking question in Inbox; the phase waits for the answer
   no valid report → retried; after limits.maxSessionFailures → escalation
all steps done → qa
qa: pass → git commit + tag yourteam/<P>-done → done
    fail → issues become fix sessions per owning agent → building → qa again
    after limits.maxQaRounds → escalation (retry / accept / pause)
```

Change orders are applied between build sessions. A `fix` order becomes a phase `F<n>` (marked `"fix": true`) inserted before the first phase that has not started; it runs right away if the team was idle or waiting at a gate.

Fix rounds from bug reports are capped by `limits.maxFixRounds` per phase. After that, the remaining bugs are left for QA.

## 4. Agent session contract

Each session is `claude -p --output-format stream-json` with:
- `--append-system-prompt`: the team preamble plus the agent's role file
- the prompt on stdin: the context pack (task, docs to read, messages, answers, previous handoff, output paths)
- `--model`, `--permission-mode acceptEdits --allowedTools <agent tools>` (or `--dangerously-skip-permissions` when enabled), `--permission-prompts none`, `--max-budget-usd`, `--strict-mcp-config` (unless MCP is enabled), and `--add-dir <skill>/templates`

A work session must write a handoff markdown file and a report JSON:

```json
{
  "status": "done | partial | waiting | blocked",
  "summary": "...",
  "tasksDone": ["P2-T1"], "tasksRemaining": [], "filesChanged": [],
  "messages": [{ "to": "frontend", "type": "api-change | bug-report | fix-done | info | question", "text": "..." }],
  "questions": [{ "text": "...", "assumption": "...", "blocking": false }]
}
```

A QA session writes `qa/<phase>-r<n>.json`:

```json
{ "verdict": "pass | fail", "summary": "...",
  "checks": [{ "criterion": "...", "result": "pass | fail", "evidence": "..." }],
  "issues": [{ "agent": "backend", "severity": "high | medium | low", "title": "...", "details": "..." }],
  "manualTests": ["steps the customer can follow by hand"] }
```

Messages are delivered in the prompt of the recipient's next session, then marked read. Answers to questions are delivered to the next session of the agent that asked.

## 5. Plan and roster formats

`roster.json`: `{ "agents": [{ "id", "name", "description", "model", "tools": [...], "template" }] }`. It must include `qa`. CEO and CTO are built in and never listed. Ids use `[a-z0-9-]`.

`plan.json`:
Per-phase Auto-run lives in state.json `phaseSettings.<id>.autoRun` (default true), so re-planning never resets it.

```json
{ "mode": "product | feature | bugfix | refactor | spike", "summary": "...",
  "phases": [{ "id": "P1", "title": "...", "goal": "...",
    "steps": [{ "agent": "backend", "tasks": [{ "id": "P1-T1", "title": "...", "details": "...", "acceptance": ["..."] }] }],
    "qa": { "criteria": ["..."], "how": "..." } }] }
```

The orchestrator validates both files after every CTO planning session. Validation failures go back to the CTO (up to `limits.planRetries`) before escalating.

## 6. Config keys (`config.json`)

| Key | Default | Meaning |
|---|---|---|
| `models.ceo` / `models.cto` / `models.qa` | opus / opus / sonnet | Models for the core roles |
| `models.ctoChat` | sonnet | Model for the CTO chat |
| `models.default` | sonnet | Model for hired agents whose roster entry has none |
| `models.<agentId>` | - | Per-agent override (the dashboard's Agents tab sets the roster entry instead) |
| `budget.perSessionUsd` | 10 | Passed as `--max-budget-usd` |
| `budget.totalUsd` | null | Pauses with an escalation once total spend reaches it |
| `limits.maxContinuations` | 4 | Fresh sessions per step before escalating |
| `limits.maxFixRounds` | 3 | Bug-report fix rounds per phase |
| `limits.maxQaRounds` | 3 | QA rounds before escalating |
| `limits.maxSessionFailures` | 2 | Failed or report-less sessions per step before escalating |
| `limits.planRetries` | 2 | CTO attempts to fix an invalid plan |
| `approval.spec` / `approval.plan` | true | Human gates |
| `permissions.mode` | acceptEdits | `acceptEdits`, `dontAsk` or `auto` |
| `permissions.skipAll` | false | `--dangerously-skip-permissions` (sandbox only) |
| `git.enabled` / `git.autoInit` | true / true | Phase checkpoints; init a repo if there is none |
| `claude.bin` | auto | CLI path. Auto-detection checks `YOURTEAM_CLAUDE_BIN`, PATH, `~/.local/bin`, then the desktop app's bundled CLI |
| `claude.effort` | null | `--effort` |
| `claude.loadMcp` | false | Load the user's MCP servers in agent sessions |
| `claude.disableSkills` | false | `--disable-slash-commands` |
| `claude.extraArgs` | [] | Extra CLI arguments for every session |
| `retro` | true | Retrospective at the end |
| `autoResume` | false | Continue automatically after an orchestrator restart |

## 7. Skill layout

```
yourteam/
  SKILL.md
  references/protocol.md          this file
  templates/agents/*.md           role templates the CTO hires from
  templates/docs/spec.md, handoff.md
  scripts/yourteam.mjs            CLI: start | status | action | doctor
  scripts/lib/                    orchestrator, prompts, store, claude runner, git, server, app runner
  scripts/dashboard/              the browser UI (no build step)
  scripts/test/mock-claude.mjs    simulated CLI for --demo
  scripts/test/selftest.mjs       end-to-end test: node scripts/test/selftest.mjs
```
