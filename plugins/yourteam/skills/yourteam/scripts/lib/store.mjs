// File-backed state for one YourTeam project. Everything lives in <project>/.yourteam
// so a run can be resumed after a crash and every fresh agent session can read it.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const SUBDIRS = ['agents', 'handoffs', 'reports', 'qa', 'contracts', 'decisions', 'logs', 'chat'];
// Orchestrator bookkeeping: shown and changed through the dashboard's own views, never as documents.
const INTERNAL = new Set(['state.json', 'sessions.json', 'inbox.json', 'messages.json', 'server.json', 'config.json']);
const isInternal = (rel) => INTERNAL.has(rel) || rel.split('/').some((part) => part.startsWith('.'));

export class Store extends EventEmitter {
  constructor(projectDir) {
    super();
    this.setMaxListeners(100);
    this.projectDir = path.resolve(projectDir);
    this.dir = path.join(this.projectDir, '.yourteam');
  }

  p(...rel) {
    return path.join(this.dir, ...rel);
  }

  exists(rel) {
    return fs.existsSync(this.p(rel));
  }

  ensureDirs() {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const d of SUBDIRS) fs.mkdirSync(this.p(d), { recursive: true });
  }

  readText(rel, fallback = '') {
    try {
      return fs.readFileSync(this.p(rel), 'utf8').replace(/^﻿/, '');
    } catch {
      return fallback;
    }
  }

  readJSON(rel, fallback = null) {
    const text = this.readText(rel, null);
    if (text == null) return structuredClone(fallback);
    try {
      return JSON.parse(text);
    } catch {
      return structuredClone(fallback);
    }
  }

  // Like readJSON but reports why parsing failed, for validating agent-written files.
  tryReadJSON(rel) {
    const text = this.readText(rel, null);
    if (text == null) return { ok: false, error: `${rel} does not exist` };
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: `${rel} is not valid JSON: ${e.message}` };
    }
  }

  writeText(rel, text) {
    const file = this.p(rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    try {
      fs.renameSync(tmp, file);
    } catch {
      // Windows refuses the rename while another process holds the file open.
      fs.writeFileSync(file, text);
      fs.rmSync(tmp, { force: true });
    }
    this.emit('change', rel);
  }

  writeJSON(rel, data) {
    this.writeText(rel, JSON.stringify(data, null, 2));
  }

  update(rel, fallback, fn) {
    const data = this.readJSON(rel, fallback);
    const out = fn(data) ?? data;
    this.writeJSON(rel, out);
    return out;
  }

  appendJSONL(rel, obj) {
    const file = this.p(rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
    this.emit('change', rel);
  }

  readJSONL(rel, limit = 0) {
    const text = this.readText(rel, '');
    const lines = text.split('\n').filter(Boolean);
    const picked = limit ? lines.slice(-limit) : lines;
    const out = [];
    for (const line of picked) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // skip a torn line
      }
    }
    return out;
  }

  mtime(rel) {
    try {
      return fs.statSync(this.p(rel)).mtimeMs;
    } catch {
      return 0;
    }
  }

  // Lists readable documents under .yourteam for the dashboard's Docs view.
  listDocs() {
    const out = [];
    const walk = (dir, rel) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (r === 'logs' || r === 'chat') continue;
          walk(path.join(dir, e.name), r);
        } else if (/\.(md|json|ya?ml|txt)$/i.test(e.name) && !isInternal(r)) {
          const st = fs.statSync(path.join(dir, e.name));
          out.push({ path: r, size: st.size, mtime: st.mtimeMs });
        }
      }
    };
    walk(this.dir, '');
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  // Resolves a dashboard-supplied path, refusing anything outside .yourteam.
  safeDocPath(rel) {
    if (typeof rel !== 'string' || !rel) return null;
    const full = path.resolve(this.dir, rel);
    if (!full.startsWith(this.dir + path.sep)) return null;
    if (!/\.(md|json|ya?ml|txt)$/i.test(full)) return null;
    const out = path.relative(this.dir, full).split(path.sep).join('/');
    return isInternal(out) ? null : out;
  }
}
