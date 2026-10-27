// Skill library: a catalog of references to third-party skills on GitHub. A skill is only
// downloaded after the customer selects it, pinned to the exact commit, cached in
// ~/.yourteam/skills/<id>/<sha>/, and loaded into an agent's sessions as a small plugin
// (claude --plugin-dir) so each agent only carries the skills chosen for it.
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DIR, USER_DIR } from './paths.mjs';
import { parseFrontmatter } from './prompts.mjs';

const CATALOG_FILE = path.join(SKILL_DIR, 'catalog', 'skills.json');
const MAX_FILES = 400;
const MAX_BYTES = 15 * 1024 * 1024;
const SCRIPT_RE = /\.(sh|bash|ps1|py|js|mjs|cjs|ts|rb|pl|exe|bat|cmd)$/i;
const MANIFEST = '.yourteam-skill.json';

export function readCatalog() {
  try {
    return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')).skills || [];
  } catch {
    return [];
  }
}

// Accepts github.com/<owner>/<repo>[/tree|blob/<ref>/<path>] (a link to SKILL.md works too).
export function parseGithubUrl(url) {
  let u;
  try {
    u = new URL(String(url).trim());
  } catch {
    throw new Error('That is not a valid URL');
  }
  if (u.hostname !== 'github.com') throw new Error('Only github.com links are supported');
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('The link needs at least an owner and a repository');
  const repo = `${parts[0]}/${parts[1].replace(/\.git$/, '')}`;
  let ref = null;
  let p = '';
  if (['tree', 'blob'].includes(parts[2]) && parts[3]) {
    ref = parts[3];
    p = parts.slice(4).join('/');
    if (/(^|\/)SKILL\.md$/i.test(p)) p = p.replace(/\/?SKILL\.md$/i, '');
  }
  return { repo, ref, path: p };
}

export class SkillLibrary {
  constructor({ fetchImpl = globalThis.fetch, cacheDir = path.join(USER_DIR, 'skills') } = {}) {
    this.fetch = fetchImpl;
    this.cacheDir = cacheDir;
  }

  async getJSON(url) {
    const res = await this.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'yourteam' } });
    if (res.status === 404) throw new Error(`Not found on GitHub: ${url.replace('https://api.github.com/repos/', '')}`);
    if (res.status === 403 || res.status === 429) throw new Error('GitHub rate limit reached (60 requests an hour without signing in). Try again later.');
    if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${url}`);
    return res.json();
  }

  async resolve(repo, ref) {
    let branch = ref;
    if (!branch) branch = (await this.getJSON(`https://api.github.com/repos/${repo}`)).default_branch || 'main';
    const commit = await this.getJSON(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`);
    const tree = await this.getJSON(`https://api.github.com/repos/${repo}/git/trees/${commit.sha}?recursive=1`);
    if (tree.truncated) throw new Error('This repository is too large to read in one request');
    return { sha: commit.sha, ref: branch, blobs: tree.tree.filter((x) => x.type === 'blob') };
  }

  // For a URL without a folder: use the repo's only SKILL.md, or list the choices.
  findSkillPath(blobs) {
    const skills = blobs.map((b) => b.path).filter((p) => /(^|\/)SKILL\.md$/.test(p));
    const preferred = skills.filter((p) => !p.split('/').some((s) => s.startsWith('.') && s !== '.claude'));
    const list = preferred.length ? preferred : skills;
    if (list.length === 1) return list[0].replace(/\/?SKILL\.md$/, '');
    if (!list.length) throw new Error('No SKILL.md found in that repository');
    throw new Error(`That repository has ${list.length} skills. Link to one folder, e.g. …/tree/main/${list[0].replace(/\/SKILL\.md$/, '')}. Options: ${list.slice(0, 8).map((p) => p.replace(/\/SKILL\.md$/, '')).join(', ')}`);
  }

  manifestPath(id, sha) {
    return path.join(this.cacheDir, id, sha, MANIFEST);
  }

  readManifest(id, sha) {
    try {
      return JSON.parse(fs.readFileSync(this.manifestPath(id, sha), 'utf8'));
    } catch {
      return null;
    }
  }

  // Downloads entry.path from entry.repo at the current commit of entry.ref (or `pinSha`).
  async download(entry, { pinSha } = {}) {
    let sha = pinSha;
    let blobs;
    let skillPath = entry.path || '';
    if (sha) {
      const cached = this.readManifest(entry.id, sha);
      if (cached) return cached;
      const tree = await this.getJSON(`https://api.github.com/repos/${entry.repo}/git/trees/${sha}?recursive=1`);
      blobs = tree.tree.filter((x) => x.type === 'blob');
    } else {
      const r = await this.resolve(entry.repo, entry.ref);
      sha = r.sha;
      blobs = r.blobs;
      const cached = this.readManifest(entry.id, sha);
      if (cached) return cached;
    }
    if (!skillPath) skillPath = this.findSkillPath(blobs);
    const prefix = skillPath ? skillPath.replace(/\/$/, '') + '/' : '';
    const files = blobs.filter((b) => b.path.startsWith(prefix));
    if (!files.some((b) => b.path === `${prefix}SKILL.md`)) throw new Error(`No SKILL.md in ${entry.repo}/${skillPath || '(root)'}`);
    if (files.length > MAX_FILES) throw new Error(`The skill has ${files.length} files (limit ${MAX_FILES})`);
    const bytes = files.reduce((a, b) => a + (b.size || 0), 0);
    if (bytes > MAX_BYTES) throw new Error(`The skill is ${Math.round(bytes / 1048576)} MB (limit ${MAX_BYTES / 1048576} MB)`);

    const dir = path.join(this.cacheDir, entry.id, sha);
    const tmp = `${dir}.part-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    const queue = [...files];
    const worker = async () => {
      while (queue.length) {
        const b = queue.shift();
        const rel = b.path.slice(prefix.length);
        const url = `https://raw.githubusercontent.com/${entry.repo}/${sha}/${b.path.split('/').map(encodeURIComponent).join('/')}`;
        const res = await this.fetch(url, { headers: { 'User-Agent': 'yourteam' } });
        if (!res.ok) throw new Error(`Download failed (${res.status}) for ${b.path}`);
        const out = path.join(tmp, rel);
        if (!path.resolve(out).startsWith(path.resolve(tmp) + path.sep)) throw new Error(`Unsafe path in skill: ${rel}`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, files.length) }, worker));
    const skillMd = fs.readFileSync(path.join(tmp, 'SKILL.md'), 'utf8');
    const meta = parseFrontmatter(skillMd);
    const rels = files.map((b) => b.path.slice(prefix.length));
    const manifest = {
      id: entry.id,
      repo: entry.repo,
      path: skillPath,
      ref: entry.ref || null,
      sha,
      skillName: String(meta.name || entry.id).replace(/[^\w-]/g, '-'),
      description: String(meta.description || entry.description || ''),
      files: rels,
      scripts: rels.filter((r) => SCRIPT_RE.test(r)),
      bytes,
      downloadedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(tmp, MANIFEST), JSON.stringify(manifest, null, 2));
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    return manifest;
  }

  // Copies a cached skill into <project>/.yourteam/skillpacks/<id>/ as a one-skill plugin.
  ensurePack(store, manifest) {
    const pack = store.p('skillpacks', manifest.id);
    const marker = path.join(pack, '.sha');
    let current = '';
    try {
      current = fs.readFileSync(marker, 'utf8').trim();
    } catch {}
    if (current === manifest.sha) return pack;
    const src = path.join(this.cacheDir, manifest.id, manifest.sha);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error(`Skill ${manifest.id} is missing from the cache; select it again`);
    fs.rmSync(pack, { recursive: true, force: true });
    fs.mkdirSync(path.join(pack, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(pack, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: `yt-${manifest.id}`, version: '0.0.0', description: `${manifest.repo} @ ${manifest.sha.slice(0, 7)} (added by YourTeam)` }, null, 2));
    fs.cpSync(src, path.join(pack, 'skills', manifest.skillName), { recursive: true, filter: (f) => path.basename(f) !== MANIFEST });
    fs.writeFileSync(marker, manifest.sha);
    return pack;
  }

  preview(id, sha) {
    const m = this.readManifest(id, sha);
    if (!m) return null;
    let skillMd = '';
    try {
      skillMd = fs.readFileSync(path.join(this.cacheDir, id, sha, 'SKILL.md'), 'utf8');
    } catch {}
    return { ...m, skillMd: skillMd.length > 40000 ? skillMd.slice(0, 40000) + '\n\n… (truncated)' : skillMd };
  }
}
