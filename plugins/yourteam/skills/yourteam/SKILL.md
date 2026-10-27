---
name: yourteam
description: YourTeam runs a multi-agent AI software team (CEO, CTO, backend, frontend, QA and any specialists the CTO hires) that builds a product phase by phase, with each agent's phase in its own fresh `claude -p` session, QA closing every phase, and a live interactive browser dashboard (interview, CTO chat, plan board with per-phase auto-run, phase review with diffs, Run app, approvals, usage and context). Use this skill whenever the user wants a team of agents to build something, says "YourTeam", asks for a CEO/CTO/dev/QA agent workflow, wants to hand off a whole product, feature, refactor or bug-fix to autonomous agents, wants to run development unattended in phases, or asks to check on, resume or control a running YourTeam project, even if they don't name the skill.
---

# YourTeam

YourTeam is an orchestrator plus a dashboard. The orchestrator is a Node program (`scripts/yourteam.mjs`) that runs one headless Claude Code session at a time and moves a project through these stages:

1. **Interview:** the CEO agent chats with the user (the customer) and writes `.yourteam/spec.md`. Its replies stream live; its questions appear as cards with suggested answers, and a coverage checklist shows how complete the picture is.
2. **Plan:** the CTO picks the stack and writes the architecture, conventions, API contracts and decisions. It hires the team (from templates, or as new specialist roles) and writes a phased plan.
3. **Build:** each phase runs every step in order (for example backend, then frontend). **Each step is one fresh session for that agent**, so context never piles up. A step too big for one session ends as `partial`, and a new session continues from the handoff file.
4. **Agent messages:** agents talk through a message board. A frontend bug report to the backend triggers a backend fix session, then a fresh frontend session that continues.
5. **QA:** a QA session closes every phase by running the software. Failures go back to their owners as fix sessions, then QA runs again. After the configured number of rounds it escalates to the user.
6. **CTO chat:** during plan review, the user chats with the CTO and it edits the plan directly (the dashboard shows a diff). During and after the build, the user reports what they tested; the CTO proposes **change orders** (fix phases with QA, new or changed phases, new agents, notes to agents), and nothing changes until the user clicks Apply.
7. **Gates and checkpoints:** spec and plan approvals; a per-phase **Auto-run** switch (off = the team stops before that phase so the user can test what exists); blocking questions; budget limits; a git commit and tag per phase, which powers the **Review** screen (files changed, diffs, QA result, manual test steps) and rollback. **Run app** starts the product from `.yourteam/run.json` so the user can try it without a terminal.
8. **Done:** the CTO writes a retrospective and saves its lessons to `~/.yourteam/lessons.md` for future plans.

Everything lives in `<project>/.yourteam/`, so runs survive restarts. The user drives everything from the dashboard at `http://localhost:4477` (or the next free port). You can drive it too, through the CLI.

`SCRIPT` below means `node "<this skill's directory>/scripts/yourteam.mjs"`. Use the real absolute path; the skill directory is shown when the skill loads.

## Starting a project

1. **Pick the project folder.**
   - New product: create a new folder named after the product (ask the user where, if it isn't obvious; default to a sibling of the current directory, never inside this skill's folder).
   - Existing codebase: use its root. YourTeam notices the code, and the CTO maps it before planning.
2. **Check prerequisites:** run `SCRIPT doctor "<dir>"`.
   - If the Claude CLI sign-in fails, give the user the exact `auth login` command that doctor printed and ask them to run it in their own terminal. Signing in is theirs to do. Do not attempt it, and do not continue until doctor passes.
   - If the CLI is not found, they need Claude Code installed, or `claude.bin` set in Settings.
3. **Start the orchestrator** as a long-running background process: `SCRIPT start "<dir>"` (use the shell tool's background mode; it keeps running between turns). It prints the dashboard URL and opens the user's browser. Add `--no-open` to skip opening it, or `--port N` to pick a port. When the desktop app's built-in browser is available, you can also open the URL there.
   - If it says the project is already running, just give the user the URL.
4. **Tell the user** what happens next, briefly: they talk to the CEO in the Interview tab, approve the spec, shape the plan with the CTO and approve it, then watch the build. To test phase by phase, they turn off **Auto-run** on phases in the Plan tab; the team then stops before those phases, and the user can use **Run app** and **Review**, and report problems to the CTO. Point out the Pause/Stop buttons and the budget setting, because real sessions spend real tokens.
   - If YourTeam was updated while an orchestrator was running, that process still has the old code. Ask the user before restarting it (stop it, then run `start` again; state is kept on disk).

**Trying it out first:** `SCRIPT start "<scratch dir>" --demo` runs the whole pipeline with simulated agents. It spends no tokens and is good for showing the dashboard. Never use `--demo` for real work.

## Doing the interview in this chat instead

Some users prefer to describe the product to you directly. In that case:

1. Act as the CEO. Follow `templates/agents/ceo.md`: ask focused questions in rounds and cover users, scope (must-have, nice-to-have, out of scope), flows, data, integrations, platform, non-functional needs and what "done" means.
2. Write `.yourteam/spec.md` in the project, following `templates/docs/spec.md`. List every assumption.
3. Start the orchestrator (if it isn't running), then run `SCRIPT action spec-written --dir "<dir>"` to move it to spec review. If the user already approved the spec here in the chat, run `SCRIPT action approve-spec --dir "<dir>"` instead, which starts the CTO.

## Checking on and controlling a running project

- `SCRIPT status "<dir>"` prints the stage, the phase table, spend, and anything waiting for the user, with inbox ids. Use it when the user asks how things are going. Don't read the raw logs unless you're debugging; they're large.
- `SCRIPT action <type> '<json>' --dir "<dir>"` does the same things as the dashboard buttons:

| Action | Payload | What it does |
|---|---|---|
| `chat` | `{"text"}` | Message to the CEO during the interview |
| `brief` | `{"text"}` | Skip the interview; the CEO writes the spec from this brief |
| `finalize-spec` | | Ask the CEO to write the spec now |
| `spec-written` / `approve-spec` | | Spec written outside the dashboard / approve the spec and start planning |
| `approve-plan` | | Plan gate |
| `cto-chat` | `{"text"}` | Message to the CTO (plan edits in review, change orders during the build) |
| `apply-change-order` / `reject-change-order` | `{"id"}` | Act on a CTO change order (ids are in state.json `changeOrders`) |
| `set-autorun` | `{"phase","value"}` or `{"all":true,"value"}` | Auto-run switch; off = stop before that phase |
| `start-phase` | `{"phase"}` | Start a phase that is waiting at its gate |
| `app-start` / `app-stop` | | Run or stop the product (from run.json) |
| `review-phase` | `{"phase"}` | Mark a finished phase as reviewed |
| `answer` | `{"id","text"}` | Answer an agent's question (id from `status`) |
| `resolve` | `{"id","option"}` | Escalations: `retry`, `accept`, `skip-step`, `continue`, `pause` |
| `pause` / `stop` / `resume` | | Pause after the current session / kill it now / continue |
| `rerun-phase` / `rerun-qa` / `skip-phase` / `rollback-phase` | `{"phase"}` | Phase controls (rollback discards code changes: confirm with the user first) |
| `change-request` | `{"text"}` | New or changed requirement; the CTO re-plans the remaining phases (the CTO chat is usually better) |
| `send-message` | `{"to","text"}` | A note delivered to an agent's next session |
| `update-config` | `{"patch":{...}}` | Change settings (see `references/protocol.md`) |

Only take actions the user asked for. Approvals, answers, applying change orders and rollbacks are the user's decisions; relay them, don't make them up. If an agent's question comes up while you're talking with the user, show it to them and pass on their answer.

## Adapting to the project

- The CTO sizes the plan to the request: a bug fix can be one phase with one developer and QA, while a product gets a setup phase plus vertical slices.
- The CTO hires from `templates/agents/` (backend, frontend, fullstack, mobile, devops, database, security, designer, docs, data-ml) or writes new roles. Role files are copied into `.yourteam/agents/`, where the user can edit them in the Docs tab.
- To add a reusable specialist for all future projects, add a template file to `templates/agents/` with the same frontmatter (`id`, `name`, `description`, `model`, `tools`).
- Models, budgets, retry limits, approval gates, permissions and git checkpoints are all in Settings (`.yourteam/config.json`).

## When things go wrong

- **Status `error`:** the dashboard shows the stack trace, and Resume retries. Read the Timeline to see which session failed.
- **Sessions fail with "Not logged in":** the CLI sign-in expired. Run doctor again.
- **An agent keeps producing no valid report:** after the configured failures the step escalates to the Inbox. Look at that session in Live sessions to see why.
- **Agents are blocked by permission denials:** sessions run with `acceptEdits` plus each agent's tool list, and anything else is denied automatically rather than prompting. Add the tool to the agent in `roster.json`, or in a sandbox enable "Skip all permission checks".
- For file formats, the state machine and every config key, read `references/protocol.md`.
