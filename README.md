<p align="center"><img src="assets/logo.svg" alt="YourTeam logo: four agent faces in a grid" width="96" height="96"></p>

<h1 align="center">YourTeam</h1>

<p align="center"><strong>A multi-agent orchestrator for Claude Code that runs a whole AI software team: CEO, CTO, developers and QA.</strong><br>
You describe the product. The team plans it, builds it phase by phase, and tests every phase, while you watch and steer from a live dashboard.</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-blue.svg"></a>
  <img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude%20Code-plugin%20%2B%20skill-black">
  <img alt="Node.js 18 or newer" src="https://img.shields.io/badge/node-%E2%89%A518-339933">
  <img alt="Zero npm dependencies" src="https://img.shields.io/badge/dependencies-0-brightgreen">
</p>

<p align="center"><a href="assets/yourteam-demo.mp4"><img src="assets/yourteam-demo-poster.jpg" alt="Watch the YourTeam demo video: a 72-second tour of the dashboard, from the CEO interview to QA-checked phases" width="900"></a><br><sub><a href="assets/yourteam-demo.mp4">▶ Watch the 72-second demo</a></sub></p>

## TL;DR

- **What it is:** a [Claude Code](https://claude.com/claude-code) plugin and skill that orchestrates several AI agents into a software team. A CEO interviews you, a CTO designs the system and hires the team, developers write the code, and QA runs it to check the work.
- **How it works:** a small Node.js orchestrator starts each step of each phase as its **own fresh Claude Code session** (`claude -p`). Agents share knowledge through files (spec, architecture, API contracts, handoff notes), so no agent's context window fills up.
- **Same quality as Claude Code:** every agent is a real Claude Code session, with the same agent harness, tools and models you already use. YourTeam doesn't replace the model or rewrite its output. It only decides who works on what, and when.
- **Built for unattended runs:** phases run one after another on their own. QA failures go back to the agent responsible for a fix, and a run survives restarts. You can also pause before any phase to test it yourself.
- **Try it free:** `--demo` runs the whole pipeline with simulated agents and spends no tokens.

## Contents

- [Why YourTeam](#why-yourteam)
- [How it works](#how-it-works)
- [Built with YourTeam: a real project](#built-with-yourteam-a-real-project)
- [The dashboard](#the-dashboard)
- [Install](#install)
- [Quick start](#quick-start)
- [Features](#features)
- [Skills for agents](#skills-for-agents)
- [Controlling it from Claude Code or another agent](#controlling-it-from-claude-code-or-another-agent)
- [Costs and safety](#costs-and-safety)
- [FAQ](#faq)
- [Development](#development)

## Why YourTeam

One long AI coding session works well for small tasks. For a whole product, it runs into the same problems again and again:

| Problem with one long session | What YourTeam does |
|---|---|
| The context window fills up, and quality drops as the chat grows | Every step is a **fresh session** that starts with only what it needs |
| Requirements are vague, so the agent guesses | A **CEO interview** produces a written spec that you approve |
| No architecture, so the code drifts | A **CTO** writes the architecture, conventions and API contracts first |
| The agent says "done" without running anything | **QA runs the software** and checks each acceptance criterion |
| You have to watch it the whole time | Phases **run unattended**, and failures go back to their owners automatically |
| Hard to see what happened | A **live dashboard** shows every session, diff, message, cost and QA result |

## How it works

<p align="center"><img src="assets/yourteam-flow.png" alt="YourTeam flow: you chat with the CEO, who writes the spec; the CTO plans architecture, team and phases; developers build each phase and hand off to QA; QA runs the app, sends failures back as fixes and passes finished phases on to a git commit; every agent runs as a fresh Claude Code session and shares memory through the .yourteam folder" width="900"></p>

<p align="center"><sub>Drawn with <a href="https://github.com/cathrynlavery/diagram-design">diagram-design</a>. Source: <a href="assets/diagram/yourteam-flow.html"><code>assets/diagram/yourteam-flow.html</code></a></sub></p>

1. **You chat with the CEO.** It interviews you and writes `spec.md`, which you approve.
2. **The CTO plans.** It picks the stack, writes the architecture and API contracts, hires the team and splits the work into phases. You approve the plan.
3. **Developers build each phase.** Backend runs before frontend, and each step is a fresh session that starts from the handoff notes.
4. **QA runs the app** and checks every acceptance criterion. Failures go back to the agent that owns them as fixes. A passing phase is committed and tagged in git, and the next phase starts.
5. **You test whenever you like** and tell the CTO what you found. It turns your feedback into change orders, such as a fix phase with its own QA run.

If an agent runs out of room, it writes a handoff and a new session continues the work. If it needs a decision, the question shows up in your Inbox. If QA keeps failing, the team escalates to you instead of looping forever.

### Same agent harness as Claude Code

YourTeam is an **orchestrator**, not a new coding agent. It doesn't call a model API directly, and it doesn't wrap the model in a different harness. Every box in the diagram is a real `claude -p` session.

- **Same tools:** agents use Claude Code's own Read, Edit, Write, Bash, Grep and other tools, with Claude Code's permission system.
- **Same models:** Opus for the CEO and CTO and Sonnet for the rest by default. You can change the model per agent.
- **Same project context:** sessions run in your project folder, so Claude Code loads your `CLAUDE.md` as usual.
- **Same sign-in:** sessions use your own Claude Code CLI login. YourTeam never handles API keys.
- **Code quality is unchanged:** the code is written by Claude Code itself. YourTeam adds structure around it (a spec, an architecture, contracts, a QA gate), so code quality is the same, and usually more consistent across a large project.

### Memory lives in files, not chat history

Everything lives in `<project>/.yourteam/`, so a run survives restarts:

| What | Where |
|---|---|
| Spec, architecture, conventions | `spec.md`, `architecture.md`, `conventions.md` |
| API contracts and decisions | `contracts/`, `decisions/` |
| Team and plan | `roster.json`, `agents/*.md`, `plan.json` |
| Each session's output | `handoffs/*.md` (for the next session), `reports/*.json` |
| QA results | `qa/<phase>-r<round>.json/.md` |
| Live state | `state.json`, `sessions.json`, `inbox.json`, `messages.json`, `logs/` |

File formats, the state machine and every setting are documented in [`references/protocol.md`](plugins/yourteam/skills/yourteam/references/protocol.md).

## Built with YourTeam: a real project

YourTeam built **Planner**, a Notion-style Electron desktop app for Windows (React, FullCalendar, BlockNote, SQLite with Drizzle) that keeps all tasks on one calendar, syncs both ways with Google Calendar, and shows native reminders when the window is closed.

| | |
|---|---|
| Plan | 18 phases, 13 done so far |
| Team | CEO, CTO, main-process, Google sync, frontend, UI/UX, QA, security and docs agents |
| Sessions | 63 fresh Claude Code sessions |
| Cost so far | $38.53 |
| Average peak context | 7% of the context window per session |

## The dashboard

Everything runs from a local dashboard in your browser. The [demo video](assets/yourteam-demo.mp4) walks through it.

| View | What you do there |
|---|---|
| Overview | See the pipeline from interview to done, every phase, spend and anything that needs you |
| Interview | Answer the CEO's questions as cards with suggested answers, then approve the spec |
| Plan | Watch phases move from Pending to Done, and turn on **Ask first** for phases you want to test |
| Inbox | Answer agent questions and pass phase gates, with QA's step-by-step test instructions |
| CTO chat | Report problems or ask for changes; the CTO proposes change orders you **Apply** |
| Agents | See the team the CTO hired, change models, edit role files and message agents |
| Skills | Give agents community skills from GitHub, pinned to an exact version |
| Live sessions | Follow every agent session and its tool calls as they happen |
| Usage | Track cost, tokens and context-window use per agent, phase and session |

## Install

### Requirements

- [Claude Code](https://claude.com/claude-code), with the `claude` CLI signed in.
- Node.js 18 or newer. There are no npm dependencies.
- Git (optional, recommended). It powers phase checkpoints, review diffs and rollback.

### As a Claude Code plugin (recommended)

```bash
claude plugin marketplace add Adi-Hulan/yourteam
```

```bash
claude plugin install yourteam@yourteam
```

Or inside Claude Code: `/plugin marketplace add Adi-Hulan/yourteam`, then `/plugin install yourteam@yourteam`.

### As a personal skill

Copy `plugins/yourteam/skills/yourteam` to `~/.claude/skills/yourteam`.

### Sign in the CLI once

The orchestrator starts its own `claude` processes, so the CLI needs its own sign-in:

```bash
claude auth login
```

## Quick start

In Claude Code, just ask:

> Use YourTeam to build a small quote-of-the-day web app in ./quotes

Claude checks your setup, starts the orchestrator and opens the dashboard. Then:

1. **Talk to the CEO** in the Interview tab and approve the spec.
2. **Shape the plan** with the CTO and approve it.
3. **Watch the build.** Answer questions in the Inbox, review each phase, and report problems to the CTO.

You can also run it yourself:

```bash
node plugins/yourteam/skills/yourteam/scripts/yourteam.mjs doctor
```

```bash
node plugins/yourteam/skills/yourteam/scripts/yourteam.mjs start ./my-project
```

**Try it without spending tokens:**

```bash
node plugins/yourteam/skills/yourteam/scripts/yourteam.mjs start ./yourteam-demo --demo
```

## Features

- **CEO interview:** questions as cards with suggested answers, a coverage checklist, and a written spec at the end.
- **CTO planning:** the CTO picks the tech stack, writes the architecture, conventions and API contracts, and hires the team from 10 specialist role templates: backend, frontend, fullstack, mobile, devops, database, security, designer, docs and data/ML. It can also write brand-new roles.
- **CTO chat:** during planning, the CTO edits the plan and shows a diff. During the build, it proposes change orders: fix phases with QA, new phases, plan changes, new agents, or notes to agents.
- **Phase by phase:** a per-phase **Auto-run** switch lets you stop before any phase and test what exists so far.
- **Agents talk to each other:** a frontend bug report to the backend triggers a backend fix session, then a fresh frontend session that continues.
- **QA closes every phase:** QA runs the software, checks the acceptance criteria and writes manual test steps. Failures go back to their owners automatically.
- **Review and Run app:** diffs per phase, QA results, test checklists, one-click **Run app** with a console, and rollback to git checkpoints.
- **Full visibility:** an inbox, live session logs, the agent message board, a timeline, and cost, tokens and context-window use.
- **Safe defaults:** budget caps, per-agent tool permissions, retry limits and crash-safe state on disk.
- **Learns over time:** the CTO writes a retrospective, and its lessons feed into future plans.

## Skills for agents

Give agents expert [Claude Code skills](https://docs.claude.com/en/docs/claude-code/skills) from the community. The catalog holds only links, so no third-party code ships with YourTeam.

| Skill | Repository | Good for |
|---|---|---|
| Emil Kowalski: Design Engineering | [emilkowalski/skills](https://github.com/emilkowalski/skills) | UI polish and animation decisions |
| Ponytail | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | The smallest change that fully solves the task |
| Impeccable | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | Frontend design system and design audits |
| Taste Skill | [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) | Art direction for landing pages and marketing sites |

- **The CTO suggests:** while planning, the CTO recommends skills for specific agents. You accept, change or skip them.
- **You add:** pick a catalog skill and the agents that should use it, or paste a link to any GitHub folder that contains a `SKILL.md`.
- **Pinned and previewed:** the skill is downloaded at that moment and pinned to the exact commit. Preview its `SKILL.md` and scripts before the team uses it.
- **Only where needed:** each agent loads only its own skills, which keeps token use down.

Skills run inside agents that work unattended with shell access, so only add skills from sources you trust. Want a skill in the catalog? Open a pull request that adds it to [`catalog/skills.json`](plugins/yourteam/skills/yourteam/catalog/skills.json).

## Controlling it from Claude Code or another agent

Every dashboard button has a matching command-line action, so Claude Code or any other agent can drive a run:

```bash
node .../yourteam.mjs status ./my-project
```

```bash
node .../yourteam.mjs action cto-chat '{"text":"The add form accepts empty titles"}' --dir ./my-project
```

Actions include `chat`, `brief`, `approve-spec`, `approve-plan`, `start-phase`, `cto-chat`, `apply-change-order`, `pause`, `resume` and `app-start`. The full list is in [`SKILL.md`](plugins/yourteam/skills/yourteam/SKILL.md).

## Costs and safety

- **Cost:** real runs spend real tokens. The defaults are Opus for the CEO and CTO and Sonnet for the rest, with a $10 cap per session. Set a total budget in **Settings**; the team pauses when it's reached.
- **Permissions:** agents run with `acceptEdits` plus only the tools listed for that agent. Anything else is denied automatically rather than prompting. MCP servers are off for agent sessions. The "Skip all permission checks" switch is meant for sandboxes and VMs only.
- **Local only:** the dashboard listens on `127.0.0.1` and rejects requests from other websites.
- **Your git history:** `.yourteam/` is kept out of git through `.git/info/exclude`, so your project's own `.gitignore` isn't touched.

## FAQ

**What is YourTeam?**
YourTeam is an open-source multi-agent orchestrator for Claude Code. It turns Claude Code into a software team (CEO, CTO, developers, QA and any specialists the CTO hires) that builds a product phase by phase, with a browser dashboard to watch and steer the work.

**Does YourTeam change or lower Claude Code's code quality?**
No. Every agent is a real Claude Code session, using the same harness, tools and models. YourTeam only orchestrates: it decides which agent works on what, gives each one a focused prompt, and gates every phase with QA.

**How is this different from Claude Code subagents?**
Subagents run inside one parent session, and their results come back into its context. YourTeam runs each step as a separate top-level Claude Code session, controlled by an external process. Durable state lives on disk, so a run can go for hours unattended, survive restarts, and never fill one context window.

**Can it run unattended?**
Yes. Phases auto-run by default, failures turn into fix sessions, and blocking questions wait in the Inbox. Turn off Auto-run on a phase when you want to test before the team continues.

**Which languages and frameworks does it support?**
Any that Claude Code can work with. The CTO picks the stack for each project, or you can tell it which stack to use.

**How much does it cost?**
It depends on the project size and models. You see the cost of every session live, and you can set a per-session cap and a total budget. `--demo` costs nothing.

**Does it need an API key?**
No. It uses your existing Claude Code CLI sign-in.

**Can I use it on an existing codebase?**
Yes. Point it at an existing folder and describe the feature, refactor or bug fix. The CTO reads the code before planning.

## Development

The self-test runs the full pipeline with the simulated CLI. It covers the interview, the plan, CTO edits, auto-run gates, the fix loop, QA retries, Run app, change orders and the retro.

```bash
node plugins/yourteam/skills/yourteam/scripts/test/selftest.mjs
```

```
.claude-plugin/marketplace.json        marketplace manifest
plugins/yourteam/
  .claude-plugin/plugin.json           plugin manifest
  skills/yourteam/
    SKILL.md                           instructions Claude follows
    references/protocol.md             formats, state machine, config
    catalog/skills.json                skill catalog (links to GitHub only)
    templates/agents/*.md              role templates the CTO hires from
    templates/docs/                    spec and handoff templates
    scripts/yourteam.mjs               CLI: start | status | action | doctor
    scripts/lib/                       orchestrator, prompts, store, runner, git, server, skills
    scripts/dashboard/                 the browser UI (no build step)
    scripts/test/                      simulated CLI and self-test
```

## License

[Apache License 2.0](LICENSE)

<sub>Keywords: multi-agent orchestrator, Claude Code plugin, Claude Code skill, AI software team, autonomous coding agents, AI CTO, AI QA agent, agentic software development, headless claude -p orchestration, AI developer team dashboard.</sub>
