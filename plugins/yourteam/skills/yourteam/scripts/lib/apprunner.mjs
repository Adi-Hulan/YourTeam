// Starts the product being built (the command in .yourteam/run.json) so the customer can
// try it from the dashboard between phases, and streams its output.
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

const isWin = process.platform === 'win32';
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?[^\s"'<>)]*/i;
const MAX_LINES = 800;

export class AppRunner extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.child = null;
    this.status = 'stopped'; // stopped | running | exited
    this.lines = [];
    this.detectedUrl = null;
    this.code = null;
    this.startedAt = null;
    this.command = null;
  }

  config() {
    const c = this.store.readJSON('run.json', null);
    return c && typeof c.command === 'string' && c.command.trim() ? c : null;
  }

  push(stream, text) {
    for (const raw of String(text).split(/\r?\n/)) {
      if (!raw) continue;
      const line = { ts: Date.now(), stream, text: raw.slice(0, 2000) };
      this.lines.push(line);
      if (!this.detectedUrl) {
        const m = raw.match(URL_RE);
        if (m) {
          this.detectedUrl = m[0].replace('0.0.0.0', 'localhost');
          this.emit('status');
        }
      }
      this.emit('line', line);
    }
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
  }

  start() {
    if (this.child) throw new Error('The app is already running');
    const cfg = this.config();
    if (!cfg) throw new Error('No start command yet. The CTO writes .yourteam/run.json during planning; you can also add it in Docs.');
    const cwd = path.resolve(this.store.projectDir, cfg.cwd || '.');
    if (!cwd.startsWith(this.store.projectDir)) throw new Error('run.json cwd must be inside the project');
    this.lines = [];
    this.detectedUrl = null;
    this.code = null;
    this.command = cfg.command;
    this.startedAt = new Date().toISOString();
    this.push('system', `$ ${cfg.command}`);
    // The command is a shell line written for this project (e.g. "npm run dev"), so it needs a shell.
    // PORT belongs to whatever launched the dashboard, not to the product being built.
    const env = { ...process.env };
    delete env.PORT;
    const child = spawn(cfg.command, { cwd, shell: true, env: { ...env, ...(cfg.env || {}) }, windowsHide: true, detached: !isWin });
    this.child = child;
    this.status = 'running';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => this.push('out', d));
    child.stderr.on('data', (d) => this.push('err', d));
    child.on('error', (e) => this.push('system', `Failed to start: ${e.message}`));
    child.on('close', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.status = 'exited';
      this.code = code;
      this.push('system', `Process exited${code == null ? '' : ` with code ${code}`}`);
      this.emit('status');
    });
    this.emit('status');
  }

  stop() {
    const child = this.child;
    if (!child) return false;
    this.push('system', 'Stopping…');
    try {
      if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill();
      } catch {}
    }
    return true;
  }

  info() {
    const cfg = this.config();
    return {
      status: this.status,
      // Ready once the app printed a local URL, i.e. it is actually listening.
      ready: this.status === 'running' && !!this.detectedUrl,
      configured: !!cfg,
      command: this.command || cfg?.command || null,
      // What the app printed beats what the CTO predicted (ports change).
      url: this.detectedUrl || cfg?.url || null,
      code: this.code,
      startedAt: this.startedAt,
      lines: this.lines.slice(-400),
    };
  }
}
