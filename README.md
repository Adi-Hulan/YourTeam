# YourTeam

**A multi-agent AI software team for Claude Code.** You talk to a CEO, a CTO plans the product and hires the team, developers build it phase by phase, and QA tests every phase. You watch and steer all of it from a live dashboard in your browser.

Each step of each phase runs as its **own fresh `claude -p` session**, so no agent's context keeps growing. Agents remember things through shared files (the spec, architecture, API contracts, handoff notes), not through a long chat history.

## Features

- **CEO interview:** describe what you want. The CEO's replies stream live, and its questions come as cards with suggested answers you can click. A coverage checklist shows how complete the picture is. The interview ends with a written spec for you to approve.
- **CTO planning:** the CTO picks the stack, writes the architecture, conventions and API contracts, and hires the team from 12 role templates (backend, frontend, mobile, devops, security, designer, data/ML and more). It can also write brand-new specialist roles. The result is a phased plan.
- **CTO chat:** shape the plan by chatting. The CTO edits it and shows you a diff. After testing, tell the CTO what's wrong. It works out which agent owns the problem and proposes change orders (fix phases with QA, new phases, new agents). Nothing changes until you click **Apply**.
- **Phase by phase:** each phase has an **Auto-run** switch. Turn it off and the team stops before that phase, so you can test what exists so far.
- **Agents talk to each other:** a frontend bug report to the backend triggers a backend fix session, then a fresh frontend session that continues.
- **QA closes every phase:** QA runs the software, checks the acceptance criteria and writes manual test steps for you. Failures go back to their owners automatically.
- **Review and Run app:**
  - See the files each phase changed, with diffs, plus its QA result and test steps.
  - Start the product from the dashboard and read its output.
  - Roll a phase back using git checkpoints.
- **Full visibility:** an inbox for agent questions and approvals, live session logs, the agent message board, and token, cost and context-window usage per agent, phase and session.
- **Safe defaults:** budget caps, per-agent tool permissions, retry limits, and crash-safe state on disk.
- **Learns over time:** at the end, the CTO writes a retrospective, and its lessons feed into future plans.

## Requirements

- [Claude Code](https://claude.com/claude-code). The `claude` CLI must be signed in, because the orchestrator runs headless `claude -p` sessions.
- Node.js 18 or newer. There are no npm dependencies.
- Git (optional, recommended). It powers phase checkpoints, review diffs and rollback.

## Install

### As a Claude Code plugin

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

The orchestrator starts its own `claude` processes, so the CLI needs its own sign-in. Run this in a terminal:

```bash
claude auth login
```

## Quick start

In Claude Code, just ask:

> Use YourTeam to build a small quote-of-the-day web app in D:\Projects\quotes

Claude checks your setup, starts the orchestrator and opens the dashboard. You can also run it yourself:

```bash
node plugins/yourteam/skills/yourteam/scripts/yourteam.mjs doctor
```

```bash
node plugins/yourteam/skills/yourteam/scripts/yourteam.mjs start ./my-project
```

**Try it without spending tokens:** `--demo` runs the whole pipeline with simulated agents.

```bash
node plugins/yourteam/skills/yourteam/scripts/yourteam.mjs start ./yourteam-demo --demo
```

## How it works

```
You ──chat──▶ CEO ──spec──▶ CTO ──plan + team──▶ Phase 1 ─▶ Phase 2 ─▶ … ─▶ Retro
                             ▲                     │
                             │       backend ─▶ frontend ─▶ QA   (each step = one fresh session)
                             │         ▲   bug-report │
                             │         └──── fix ─────┘
              you test ──▶ CTO chat ──▶ change orders ──▶ fix phase + QA
```

Everything lives in `<project>/.yourteam/`, so a run survives restarts:

| What | Where |
|---|---|
| Spec, architecture, conventions | `spec.md`, `architecture.md`, `conventions.md` |
| API contracts and decisions | `contracts/`, `decisions/` |
| Team and plan | `roster.json`, `agents/*.md`, `plan.json` |
| Each session's output | `handoffs/*.md` (for the next session), `reports/*.json` |
| QA results | `qa/<phase>-r<round>.json/.md` |
| Live state | `state.json`, `sessions.json`, `inbox.json`, `messages.json`, `logs/` |

Full file formats, the state machine and every setting: [`references/protocol.md`](plugins/yourteam/skills/yourteam/references/protocol.md).

## Controlling it from Claude Code

```bash
node .../yourteam.mjs status ./my-project
```

```bash
node .../yourteam.mjs action cto-chat '{"text":"The add form accepts empty titles"}' --dir ./my-project
```

Every dashboard button has a matching action (`approve-plan`, `start-phase`, `apply-change-order`, `pause`, `resume`, `app-start`, and more). They're all listed in [`SKILL.md`](plugins/yourteam/skills/yourteam/SKILL.md).

## Costs and safety

- **Cost:** real runs spend real tokens. The defaults are Opus for the CEO and CTO and Sonnet for the rest, with a $10 cap per session. Set a total budget in **Settings**; the team pauses when it's reached.
- **Permissions:** agents run with `acceptEdits` plus only the tools listed for that agent. Anything else is denied automatically rather than prompting. The "Skip all permission checks" switch is meant for sandboxes and VMs only.
- **Local only:** the dashboard listens on `127.0.0.1` and rejects requests from other websites.
- **Your git history:** `.yourteam/` is kept out of git through `.git/info/exclude`, so your project's own `.gitignore` isn't touched.

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
    templates/agents/*.md              role templates the CTO hires from
    templates/docs/                    spec and handoff templates
    scripts/yourteam.mjs               CLI: start | status | action | doctor
    scripts/lib/                       orchestrator, prompts, store, runner, git, server
    scripts/dashboard/                 the browser UI (no build step)
    scripts/test/                      simulated CLI and self-test
```

## License

[Apache License 2.0](LICENSE)
