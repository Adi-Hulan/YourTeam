// Phase checkpoints: a tag before each phase starts and a commit + tag when it passes QA,
// so a phase can be rolled back from the dashboard.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function ok(cwd, args) {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

export function gitAvailable() {
  return ok(process.cwd(), ['--version']);
}

export function isRepo(cwd) {
  return ok(cwd, ['rev-parse', '--is-inside-work-tree']);
}

// Commits as "YourTeam" only when the user has no identity configured for this repo.
function identityArgs(cwd) {
  let name = '';
  let email = '';
  try {
    name = git(cwd, ['config', 'user.name']);
  } catch {}
  try {
    email = git(cwd, ['config', 'user.email']);
  } catch {}
  const args = [];
  if (!name) args.push('-c', 'user.name=YourTeam');
  if (!email) args.push('-c', 'user.email=yourteam@localhost');
  return args;
}

export function initRepo(cwd) {
  git(cwd, ['init']);
  ensureHead(cwd);
}

export function ensureHead(cwd) {
  if (ok(cwd, ['rev-parse', '--verify', 'HEAD'])) return;
  git(cwd, [...identityArgs(cwd), 'commit', '--allow-empty', '-m', 'YourTeam: initial commit']);
}

export function commitAll(cwd, message) {
  git(cwd, ['add', '-A']);
  if (ok(cwd, ['diff', '--cached', '--quiet'])) return null;
  git(cwd, [...identityArgs(cwd), 'commit', '-m', message]);
  return git(cwd, ['rev-parse', '--short', 'HEAD']);
}

export function tag(cwd, name) {
  ensureHead(cwd);
  git(cwd, ['tag', '-f', name]);
}

export function hasRef(cwd, ref) {
  return ok(cwd, ['rev-parse', '--verify', '--quiet', ref]);
}

// .yourteam holds live orchestration state, so it must never be committed or rolled back.
// info/exclude keeps it out of git without touching the project's own .gitignore.
export function excludeStateDir(cwd) {
  const rel = git(cwd, ['rev-parse', '--git-path', 'info/exclude']);
  const file = path.resolve(cwd, rel);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {}
  if (text.split(/\r?\n/).includes('.yourteam/')) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, (text && !text.endsWith('\n') ? '\n' : '') + '.yourteam/\n');
}

// Discards tracked changes and untracked files since `ref`. Ignored files (and .yourteam) survive.
export function rollbackTo(cwd, ref) {
  git(cwd, ['reset', '--hard', ref]);
  git(cwd, ['clean', '-fd']);
}

export function log(cwd, limit = 50) {
  try {
    const out = git(cwd, ['log', `-n${limit}`, '--date=iso-strict', '--pretty=format:%h%x09%ad%x09%s%x09%D']);
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [hash, date, subject, refs] = l.split('\t');
        return { hash, date, subject, refs: refs || '' };
      });
  } catch {
    return [];
  }
}

// Per-file line counts between two refs (`to` null = working tree, including new untracked files).
export function diffNumstat(cwd, from, to) {
  const args = ['diff', '--numstat', from];
  if (to) args.push(to);
  const files = [];
  try {
    for (const line of git(cwd, args).split('\n').filter(Boolean)) {
      const [a, r, ...p] = line.split('\t');
      files.push({ path: p.join('\t'), added: a === '-' ? null : Number(a), removed: r === '-' ? null : Number(r) });
    }
    if (!to) {
      for (const f of git(cwd, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) files.push({ path: f, added: null, removed: null, untracked: true });
    }
  } catch {}
  return files;
}

export function diffFile(cwd, from, to, file) {
  try {
    const args = ['diff', from];
    if (to) args.push(to);
    args.push('--', file);
    const out = git(cwd, args, { maxBuffer: 8 * 1024 * 1024 });
    if (out) return out.length > 200000 ? out.slice(0, 200000) + '\n… (truncated)' : out;
    // Untracked file: show it as entirely new.
    const text = fs.readFileSync(path.join(cwd, file), 'utf8');
    return text
      .split('\n')
      .slice(0, 3000)
      .map((l) => '+' + l)
      .join('\n');
  } catch (e) {
    return `Could not read the diff: ${e.message}`;
  }
}
