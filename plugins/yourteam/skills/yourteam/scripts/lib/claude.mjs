// Finds the Claude Code CLI and runs one headless `claude -p` session, streaming its
// stream-json output to a log file and to a callback.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const isWin = process.platform === 'win32';

function isFile(f) {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
}

function compareVersions(a, b) {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// npm's claude.cmd shim can't be spawned without a shell, so run its cli.js with node.
function unwrapCmdShim(file) {
  const cli = path.join(path.dirname(file), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  return isFile(cli) ? cli : null;
}

// The Claude desktop app bundles its own CLI under Claude-Data\<id>\claude-code\<version>\<hash>\.
function findDesktopBundled() {
  const roots = [];
  if (isWin && process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Claude-Data'));
  if (process.platform === 'darwin') roots.push(path.join(os.homedir(), 'Library', 'Application Support', 'Claude-Data'));
  const found = [];
  for (const root of roots) {
    let profiles = [];
    try {
      profiles = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const prof of profiles) {
      const cc = path.join(root, prof, 'claude-code');
      let versions = [];
      try {
        versions = fs.readdirSync(cc);
      } catch {
        continue;
      }
      for (const ver of versions) {
        let hashes = [];
        try {
          hashes = fs.readdirSync(path.join(cc, ver));
        } catch {
          continue;
        }
        for (const h of hashes) {
          const exe = path.join(cc, ver, h, isWin ? 'claude.exe' : 'claude');
          if (isFile(exe)) found.push({ ver, exe });
        }
      }
    }
  }
  found.sort((a, b) => compareVersions(b.ver, a.ver));
  return found[0]?.exe || null;
}

export function resolveClaudeBin(config = {}) {
  const explicit = config?.claude?.bin || process.env.YOURTEAM_CLAUDE_BIN;
  if (explicit) return explicit;
  const exts = isWin ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const f = path.join(dir, 'claude' + ext);
      if (!isFile(f)) continue;
      if (ext === '.cmd') {
        const cli = unwrapCmdShim(f);
        if (cli) return cli;
        continue;
      }
      return f;
    }
  }
  const local = path.join(os.homedir(), '.local', 'bin', isWin ? 'claude.exe' : 'claude');
  if (isFile(local)) return local;
  return findDesktopBundled();
}

// When the orchestrator is launched from inside a Claude Code session it inherits that
// session's host variables, which would make the child CLI try to talk to the host.
export function cleanEnv() {
  const env = { ...process.env };
  const nested = env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_AGENT_SDK_VERSION;
  if (nested) {
    const keep = /^CLAUDE_CODE_(OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY|SKIP_)/;
    for (const k of Object.keys(env)) {
      if (keep.test(k)) continue;
      if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PREVIEW_|BAGGAGE$|AI_AGENT$)/.test(k)) delete env[k];
    }
    if (env.ANTHROPIC_BASE_URL && /localhost|127\.0\.0\.1|\[::1\]/.test(env.ANTHROPIC_BASE_URL)) delete env.ANTHROPIC_BASE_URL;
  }
  env.YOURTEAM_CHILD = '1';
  return env;
}

function commandFor(bin, args) {
  if (/\.(mjs|cjs|js)$/i.test(bin)) return { cmd: process.execPath, args: [bin, ...args] };
  return { cmd: bin, args };
}

export function runClaudeSync(bin, args, opts = {}) {
  const c = commandFor(bin, args);
  return spawnSync(c.cmd, c.args, { encoding: 'utf8', env: cleanEnv(), windowsHide: true, timeout: 60000, ...opts });
}

// Starts one headless session. The prompt goes through stdin so it is not limited by
// the Windows command-line length.
export function runClaude({ bin, args, prompt, cwd, logFile, onJSON }) {
  const c = commandFor(bin, args);
  const child = spawn(c.cmd, c.args, { cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  let buf = '';
  let stderr = '';
  let result = null;

  const handleLine = (raw) => {
    const line = raw.trim();
    if (!line) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      log.write(line + '\n');
      return;
    }
    // Token-by-token deltas are only for the live view; the full messages follow anyway.
    if (obj.type !== 'stream_event') log.write(line + '\n');
    if (obj.type === 'result') result = obj;
    try {
      onJSON?.(obj);
    } catch {
      // a broken listener must not kill the stream
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-20000);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);

  const promise = new Promise((resolve) => {
    let done = false;
    const finish = (out) => {
      if (done) return;
      done = true;
      if (buf) handleLine(buf);
      log.end();
      resolve({ ...out, result, stderr });
    };
    child.on('error', (err) => finish({ code: -1, error: err.message }));
    child.on('close', (code) => finish({ code }));
  });

  const kill = () => {
    if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGTERM');
  };
  return { promise, kill, pid: child.pid };
}

function summarizeInput(name, input = {}) {
  if (input.command) return String(input.command).slice(0, 300);
  if (input.file_path) return String(input.file_path);
  if (input.pattern) return `${input.pattern}${input.path ? ' in ' + input.path : ''}`;
  if (input.url) return String(input.url);
  if (input.query) return String(input.query);
  if (input.description) return String(input.description).slice(0, 200);
  const s = JSON.stringify(input);
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('\n');
  return '';
}

// Turns one stream-json event into the small entries the dashboard's live view shows.
export function toEntries(obj) {
  const out = [];
  if (obj.type === 'stream_event') {
    const ev = obj.event || {};
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') out.push({ t: 'delta', text: ev.delta.text });
    else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') out.push({ t: 'status', text: `Using ${ev.content_block.name}` });
    else if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') out.push({ t: 'status', text: 'Thinking' });
    else if (ev.type === 'message_start') out.push({ t: 'status', text: 'Thinking' });
    return out;
  }
  if (obj.type === 'system' && obj.subtype === 'init') {
    out.push({ t: 'init', model: obj.model, text: `Session started (${obj.model})` });
  } else if (obj.type === 'assistant') {
    for (const b of obj.message?.content || []) {
      if (b.type === 'text' && b.text?.trim()) out.push({ t: 'text', text: b.text });
      else if (b.type === 'tool_use') out.push({ t: 'tool', name: b.name, text: summarizeInput(b.name, b.input) });
    }
  } else if (obj.type === 'user') {
    const content = obj.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type !== 'tool_result') continue;
        const text = resultText(b.content);
        out.push({ t: 'tool_result', isError: !!b.is_error, text: text.length > 400 ? text.slice(0, 400) + '…' : text });
      }
    }
  } else if (obj.type === 'result') {
    out.push({ t: 'result', isError: !!obj.is_error, text: obj.result || obj.subtype || 'finished', cost: obj.total_cost_usd });
  }
  return out;
}

export function readLogEntries(file, limit = 2000) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(...toEntries(JSON.parse(line)));
    } catch {
      // ignore torn lines
    }
  }
  return entries.slice(-limit);
}
