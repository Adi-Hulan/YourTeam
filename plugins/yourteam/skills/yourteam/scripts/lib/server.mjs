// Local dashboard server: JSON API, live updates over Server-Sent Events, static UI.
// Binds to 127.0.0.1 only and rejects cross-site requests.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DASHBOARD_DIR } from './paths.mjs';
import { readLogEntries } from './claude.mjs';
import * as git from './git.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      data += c;
      if (data.length > 5e6) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

function usage(sessions) {
  const by = (key) => {
    const out = {};
    for (const s of sessions) {
      const k = s[key] ?? '-';
      const u = (out[k] ||= { sessions: 0, costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, durationMs: 0 });
      u.sessions++;
      u.costUsd += s.costUsd || 0;
      u.input += s.tokens?.input || 0;
      u.output += s.tokens?.output || 0;
      u.cacheRead += s.tokens?.cacheRead || 0;
      u.cacheWrite += s.tokens?.cacheWrite || 0;
      u.durationMs += s.durationMs || 0;
    }
    return out;
  };
  return { byAgent: by('agent'), byPhase: by('phase'), byKind: by('kind') };
}

export function snapshot(orch) {
  const s = orch.store;
  const sessions = orch.sessions();
  const cfg = orch.config();
  return {
    state: orch.state(),
    config: cfg,
    plan: s.readJSON('plan.json', null),
    roster: orch.roster(),
    core: ['ceo', 'cto'].map((id) => ({ ...orch.agent(id), model: orch.modelFor(orch.agent(id)) })),
    sessions,
    inbox: orch.inbox(),
    messages: orch.messages().slice(-500),
    events: s.readJSONL('events.jsonl', 400),
    chat: orch.chatLog(),
    docs: s.listDocs(),
    usage: usage(sessions),
    active: orch.activeInfo(),
    chatActive: orch.chatInfo(),
    cto: { ...(orch.state().cto || { threads: [] }), logs: Object.fromEntries((orch.state().cto?.threads || []).map((t) => [t.id, orch.ctoLog(t.id)])) },
    app: { ...orch.app.info(), lines: undefined },
    hasRun: s.exists('run.json'),
    skills: { catalog: orch.catalog(), selected: orch.state().skills?.selected || [], suggestions: orch.skillSuggestions() },
    hasSpec: s.exists('spec.md'),
    git: orch.gitOn() ? git.log(s.projectDir, 40) : null,
    demo: orch.demo,
    projectDir: s.projectDir,
  };
}

// Files changed in a phase (from its git checkpoints), its final QA report and handoffs.
function phaseReview(orch, phase, file) {
  const dir = orch.store.projectDir;
  const st = orch.state();
  const ps = st.phases?.[phase.id] || {};
  const from = `yourteam/${phase.id}-start`;
  const doneTag = `yourteam/${phase.id}-done`;
  const gitOk = orch.gitOn() && git.hasRef(dir, from);
  const to = gitOk && git.hasRef(dir, doneTag) ? doneTag : null;
  if (file !== null) {
    if (!gitOk) return { diff: '' };
    const rel = path.normalize(file);
    if (path.isAbsolute(rel) || rel.startsWith('..')) return { diff: 'Invalid path' };
    return { diff: git.diffFile(dir, from, to, rel) };
  }
  const sessions = orch.sessions().filter((x) => x.phase === phase.id);
  return {
    phase,
    state: ps,
    git: gitOk,
    range: gitOk ? { from, to: to || 'working tree' } : null,
    files: gitOk ? git.diffNumstat(dir, from, to) : [],
    qa: orch.lastQa(phase.id),
    handoffs: sessions.filter((x) => x.handoffPath).map((x) => ({ path: x.handoffPath.replace(/^\.yourteam\//, ''), agent: x.agent, kind: x.kind, summary: x.summary || '' })),
    cost: sessions.reduce((a, x) => a + (x.costUsd || 0), 0),
    sessions: sessions.length,
  };
}

export function startServer(orch, { port, host = '127.0.0.1' }) {
  const clients = new Set();
  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  let pending = null;
  const changed = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      broadcast('changed', { ts: Date.now() });
    }, 250);
  };
  orch.store.on('change', changed);
  orch.on('active', changed);
  orch.on('live', (d) => broadcast('live', d));
  orch.app.on('line', (line) => broadcast('app', line));
  setInterval(() => broadcast('ping', {}), 20000).unref();

  let actualPort = port;
  const allowedHost = (h) => {
    const name = String(h || '').replace(/:\d+$/, '');
    return ['127.0.0.1', 'localhost', '[::1]'].includes(name);
  };

  const server = http.createServer(async (req, res) => {
    try {
      // DNS-rebinding and cross-site protection: only local Host headers, and writes need a custom header.
      if (!allowedHost(req.headers.host)) return send(res, 403, { error: 'Forbidden host' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      const p = url.pathname;

      if (req.method === 'POST') {
        if (req.headers['x-yourteam'] !== '1') return send(res, 403, { error: 'Missing X-YourTeam header' });
        const body = await readBody(req);
        if (p === '/api/action') {
          try {
            const out = await orch.action(body.type, body);
            return send(res, 200, out || { ok: true });
          } catch (e) {
            return send(res, 400, { error: e.message });
          }
        }
        return send(res, 404, { error: 'Not found' });
      }

      if (p === '/api/state') return send(res, 200, snapshot(orch));
      if (p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('event: hello\ndata: {}\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (p === '/api/doc') {
        const rel = orch.store.safeDocPath(url.searchParams.get('path'));
        if (!rel) return send(res, 400, { error: 'Invalid path' });
        return send(res, 200, { path: rel, content: orch.store.readText(rel, '') });
      }
      if (p === '/api/app') return send(res, 200, orch.app.info());
      if (p === '/api/skill') {
        const sk = (orch.state().skills?.selected || []).find((x) => x.id === url.searchParams.get('id'));
        const pv = sk?.sha ? orch.skillLib.preview(sk.id, sk.sha) : null;
        return pv ? send(res, 200, pv) : send(res, 404, { error: 'That skill is not downloaded' });
      }
      if (p === '/api/review') {
        const id = url.searchParams.get('phase');
        const phase = orch.plan().phases.find((x) => x.id === id);
        if (!phase) return send(res, 404, { error: 'Unknown phase' });
        return send(res, 200, phaseReview(orch, phase, url.searchParams.get('file')));
      }
      if (p.startsWith('/api/session/')) {
        const id = p.split('/')[3];
        if (!/^[0-9a-f-]{36}$/.test(id)) return send(res, 400, { error: 'Bad id' });
        return send(res, 200, { id, entries: readLogEntries(orch.store.p('logs', `${id}.jsonl`)) });
      }

      const file = p === '/' ? 'index.html' : p.slice(1);
      const full = path.resolve(DASHBOARD_DIR, file);
      if (!full.startsWith(DASHBOARD_DIR + path.sep) || !fs.existsSync(full)) return send(res, 404, 'Not found', 'text/plain');
      return send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  });

  return new Promise((resolve, reject) => {
    const tryListen = (n) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && n < 20) tryListen(n + 1);
        else reject(err);
      });
      actualPort = port + n;
      server.listen(actualPort, host, () => resolve({ server, port: actualPort, url: `http://localhost:${actualPort}/` }));
    };
    tryListen(0);
  });
}
