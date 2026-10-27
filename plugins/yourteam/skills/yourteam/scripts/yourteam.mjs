#!/usr/bin/env node
// YourTeam command line.
//   start [dir] [--port N] [--no-open] [--demo]   start the orchestrator + dashboard (long-running)
//   status [dir]                                  print a summary of the project
//   action <type> [json] [--dir D]                send a dashboard action to the running orchestrator
//   doctor [dir]                                  check Node, git and the Claude CLI
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from './lib/store.mjs';
import { Orchestrator } from './lib/orchestrator.mjs';
import { startServer } from './lib/server.mjs';
import { resolveClaudeBin, runClaudeSync } from './lib/claude.mjs';
import * as git from './lib/git.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const rest = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) flags[k] = v;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--') && ['port', 'dir'].includes(k)) flags[k] = argv[++i];
    else flags[k] = true;
  } else rest.push(a);
}

function projectDir(arg) {
  return path.resolve(arg || flags.dir || process.cwd());
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function serverInfo(store) {
  const info = store.readJSON('server.json', null);
  return info && alive(info.pid) ? info : null;
}

function openBrowser(url) {
  const opts = { detached: true, stdio: 'ignore', windowsHide: true };
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], opts).unref();
  else if (process.platform === 'darwin') spawn('open', [url], opts).unref();
  else spawn('xdg-open', [url], opts).unref();
}

async function start() {
  const dir = projectDir(rest[0]);
  fs.mkdirSync(dir, { recursive: true });
  const store = new Store(dir);
  const running = store.exists('server.json') && serverInfo(store);
  if (running) {
    console.log(`YourTeam is already running for this project: ${running.url}`);
    if (!flags['no-open']) openBrowser(running.url);
    return;
  }
  const orch = new Orchestrator(store, { demo: !!flags.demo });
  orch.init();
  const { url, port } = await startServer(orch, { port: Number(flags.port) || 4477 });
  store.writeJSON('server.json', { pid: process.pid, port, url, startedAt: new Date().toISOString() });
  const cleanup = () => {
    orch.shutdown();
    try {
      const info = store.readJSON('server.json', null);
      if (info?.pid === process.pid) fs.rmSync(store.p('server.json'), { force: true });
    } catch {}
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
  console.log(`YourTeam dashboard: ${url}`);
  console.log(`Project: ${dir}${flags.demo ? '  (demo mode: simulated agents, no tokens spent)' : ''}`);
  if (!flags['no-open']) openBrowser(url);
  orch.wake();
}

function status() {
  const store = new Store(projectDir(rest[0]));
  if (!store.exists('state.json')) {
    console.log('No YourTeam project here. Run: yourteam start <dir>');
    process.exitCode = 1;
    return;
  }
  const st = store.readJSON('state.json', {});
  const plan = store.readJSON('plan.json', { phases: [] });
  const inbox = store.readJSON('inbox.json', []).filter((i) => i.status === 'open');
  const sessions = store.readJSON('sessions.json', []);
  const info = serverInfo(store);
  console.log(`Project:   ${st.project}  (${store.projectDir})`);
  console.log(`Status:    ${st.status}${st.currentPhase ? `  current phase ${st.currentPhase}` : ''}`);
  console.log(`Dashboard: ${info ? info.url : 'not running'}`);
  console.log(`Spend:     $${(st.totals?.costUsd || 0).toFixed(2)} over ${sessions.length} sessions`);
  if (plan.phases?.length) {
    console.log('Phases:');
    for (const p of plan.phases) console.log(`  ${p.id.padEnd(5)} ${(st.phases?.[p.id]?.status || 'pending').padEnd(18)} ${p.title}`);
  }
  if (inbox.length) {
    console.log('Waiting for you:');
    for (const i of inbox) console.log(`  [${i.type}] ${i.title}${i.from ? ` (from ${i.from})` : ''}  id=${i.id}`);
  }
  const running = sessions.filter((s) => s.status === 'running');
  for (const s of running) console.log(`Running:   ${s.agent} ${s.kind}${s.phase ? ` ${s.phase}` : ''} since ${s.startedAt}`);
}

async function action() {
  const store = new Store(projectDir(flags.dir));
  const info = serverInfo(store);
  if (!info) {
    console.error('The orchestrator is not running for this project. Start it with: yourteam start <dir>');
    process.exitCode = 1;
    return;
  }
  const type = rest[0];
  let payload = {};
  if (rest[1]) {
    try {
      payload = JSON.parse(rest[1]);
    } catch {
      payload = { text: rest.slice(1).join(' ') };
    }
  }
  const res = await fetch(`http://127.0.0.1:${info.port}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-YourTeam': '1' },
    body: JSON.stringify({ ...payload, type }),
  });
  const out = await res.json();
  console.log(JSON.stringify(out));
  if (!res.ok) process.exitCode = 1;
}

function doctor() {
  let ok = true;
  const line = (good, label, detail) => {
    if (!good) ok = false;
    console.log(`${good ? 'OK  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  };
  const [major] = process.versions.node.split('.').map(Number);
  line(major >= 18, 'Node.js', process.version + (major >= 18 ? '' : ' (need 18 or newer)'));
  line(git.gitAvailable(), 'git', git.gitAvailable() ? 'available (used for phase checkpoints)' : 'not found; checkpoints and rollback will be off');
  const store = new Store(projectDir(rest[0]));
  const cfg = store.readJSON('config.json', {});
  const bin = resolveClaudeBin(cfg);
  line(!!bin, 'Claude CLI', bin || 'not found. Install Claude Code, or set claude.bin in .yourteam/config.json or YOURTEAM_CLAUDE_BIN');
  if (bin) {
    const v = runClaudeSync(bin, ['--version']);
    line(v.status === 0, 'Claude CLI version', (v.stdout || v.stderr || '').trim());
    const a = runClaudeSync(bin, ['auth', 'status']);
    const text = `${a.stdout || ''}${a.stderr || ''}`.trim();
    let loggedIn = a.status === 0;
    try {
      const j = JSON.parse(a.stdout);
      loggedIn = !!(j.loggedIn ?? j.logged_in ?? loggedIn);
    } catch {}
    if (/not logged in|logged out|no credentials/i.test(text)) loggedIn = false;
    line(loggedIn, 'Claude CLI sign-in', loggedIn ? text.split('\n')[0] : `not signed in. In a terminal, run:\n       "${bin}" auth login`);
  }
  console.log(ok ? '\nReady.' : '\nFix the FAIL lines above, then run doctor again.');
  if (!ok) process.exitCode = 1;
}

const commands = { start, status, action, doctor };
if (!commands[cmd]) {
  console.log('Usage: yourteam <start|status|action|doctor> [dir] [options]\n  start [dir] [--port N] [--no-open] [--demo]\n  status [dir]\n  action <type> [json] [--dir D]\n  doctor [dir]');
  process.exitCode = cmd ? 1 : 0;
} else {
  Promise.resolve(commands[cmd]()).catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}
