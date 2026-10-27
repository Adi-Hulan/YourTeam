// YourTeam dashboard. Plain JS, no build step. State comes from /api/state and is refreshed
// whenever the server signals a change over /api/events. The DOM is updated by morphing, so
// typing, focus and scroll positions survive live updates.
(() => {
  'use strict';

  let S = null; // latest snapshot
  const ui = {
    view: 'overview',
    arg: null,
    session: null,
    followLive: true,
    doc: null,
    editing: false,
    phase: null,
    msgFilter: 'all',
    answers: {}, // interview: qid -> { choice, text }
    quote: { interview: null, cto: null },
    openDiff: null,
    cmdOpen: false,
    cmdIdx: 0,
    mention: null, // { target, items, idx, start }
  };
  const stream = {}; // sessionId -> { text, status, hadDelta }
  const liveEntries = {}; // sessionId -> entries received live
  const logCache = {}; // sessionId -> entries fetched
  const docCache = {}; // path -> { content, mtime }
  const reviewCache = {}; // phase -> { key, data }
  const diffCache = {}; // phase|file -> text
  const qaCache = {}; // path -> { mtime, data }
  let appLines = [];
  let appKey = null;
  let lastOpen = -1;
  let connected = false;

  // ---------- helpers ----------
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (n) => '$' + (n || 0).toFixed((n || 0) < 1 ? 3 : 2);
  const tok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0));
  const pct = (a, b) => (b ? Math.min(100, Math.round((a / b) * 100)) : 0);
  const ago = (iso) => {
    if (!iso) return '';
    const s = Math.round((Date.now() - (typeof iso === 'number' ? iso : Date.parse(iso))) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return new Date(iso).toLocaleDateString();
  };
  const dur = (ms) => {
    if (!ms) return '-';
    const s = Math.round(ms / 1000);
    return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : Math.floor(s / 3600) + 'h ' + Math.round((s % 3600) / 60) + 'm';
  };
  const agentName = (id) => {
    if (id === 'customer') return 'You';
    const a = [...(S?.core || []), ...(S?.roster || [])].find((x) => x.id === id);
    return a?.name || id;
  };
  const phases = () => S?.plan?.phases || [];
  const phaseStatus = (id) => S.state.phases?.[id]?.status || 'pending';
  const autoRun = (id) => S.state.phaseSettings?.[id]?.autoRun !== false;
  const openInbox = () => S.inbox.filter((i) => i.status === 'open');
  const needsYou = () => openInbox().filter((i) => i.type !== 'info');
  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        if (v == null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      } catch {}
    },
  };

  // ---------- icons ----------
  const P = {
    overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    cto: '<path d="M12 3l1.9 5.8L20 9l-4.9 3.6L17 18.5 12 15l-5 3.5 1.9-5.9L4 9l6.1-.2z"/>',
    plan: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 7v7M12 7v4M16 7v9"/>',
    review: '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7M11 18H8a2 2 0 0 1-2-2V9"/>',
    play: '<polygon points="6 4 20 12 6 20 6 4"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    messages: '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    usage: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
    qa: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/>',
    docs: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
    timeline: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    reply: '<path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    skills: '<path d="M14.5 4h-5L7 7H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-3z"/><circle cx="12" cy="13" r="3"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
  };
  const ic = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24">${P[name] || ''}</svg>`;

  // Vercel-style status glyphs.
  function stIcon(kind, title = '') {
    const t = title ? `<title>${esc(title)}</title>` : '';
    const c = { done: 'var(--green)', running: 'var(--blue)', waiting: 'var(--amber)', error: 'var(--red)', pending: 'var(--text-3)', skipped: 'var(--text-3)' }[kind] || 'var(--text-3)';
    let inner;
    if (kind === 'done') inner = `<circle cx="9" cy="9" r="7.5" fill="none" stroke="${c}" stroke-width="1.5"/><path d="M5.8 9.2l2.2 2.2 4.2-4.6" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
    else if (kind === 'running') inner = `<circle cx="9" cy="9" r="7.5" fill="none" stroke="var(--border-2)" stroke-width="1.5"/><path class="spin" d="M9 1.5a7.5 7.5 0 0 1 7.5 7.5" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>`;
    else if (kind === 'waiting') inner = `<circle cx="9" cy="9" r="7.5" fill="none" stroke="${c}" stroke-width="1.5"/><circle cx="9" cy="9" r="3" fill="${c}"/>`;
    else if (kind === 'error') inner = `<circle cx="9" cy="9" r="7.5" fill="none" stroke="${c}" stroke-width="1.5"/><path d="M6.5 6.5l5 5M11.5 6.5l-5 5" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>`;
    else if (kind === 'skipped') inner = `<circle cx="9" cy="9" r="7.5" fill="none" stroke="${c}" stroke-width="1.5"/><path d="M5 13 13 5" stroke="${c}" stroke-width="1.5"/>`;
    else inner = `<circle cx="9" cy="9" r="7.5" fill="none" stroke="${c}" stroke-width="1.5" stroke-dasharray="3 3"/>`;
    return `<span class="st"><svg viewBox="0 0 18 18">${t}${inner}</svg></span>`;
  }
  const PHASE_KIND = { pending: 'pending', building: 'running', qa: 'running', awaiting_approval: 'waiting', escalated: 'error', done: 'done', skipped: 'skipped' };
  const PHASE_LABEL = { pending: 'Pending', building: 'Building', qa: 'In QA', awaiting_approval: 'Awaiting approval', escalated: 'Needs you', done: 'Done', skipped: 'Skipped' };
  const STATUS = {
    interview: ['Interview', 'blue'],
    spec_review: ['Spec review', 'amber'],
    planning: ['CTO planning', 'blue'],
    replanning: ['CTO re-planning', 'blue'],
    plan_review: ['Plan review', 'amber'],
    running: ['Building', 'blue'],
    awaiting_answer: ['Waiting for your answer', 'amber'],
    awaiting_approval: ['Waiting for you', 'amber'],
    escalated: ['Needs your decision', 'red'],
    paused: ['Paused', ''],
    finishing: ['Wrapping up', 'blue'],
    done: ['Complete', 'green'],
    error: ['Error', 'red'],
  };
  const statusBadge = (st) => {
    const [label, cls] = STATUS[st] || [st, ''];
    return `<span class="badge ${cls}">${['running', 'planning', 'replanning', 'finishing'].includes(st) ? '<span class="dot blue pulse"></span>' : ''}${esc(label)}</span>`;
  };
  const ctxBar = (tokens, win, w = 70) => {
    const p = pct(tokens, win);
    return `<span class="row nowrap" style="gap:6px" title="Context window: ${tok(tokens)} of ${tok(win)}"><span class="bar ${p > 80 ? 'bad' : p > 60 ? 'warn' : 'blue'}" style="width:${w}px"><i style="width:${p}%"></i></span><span class="xs muted">${p}%</span></span>`;
  };

  function md(src) {
    const lines = String(src || '').replace(/\r/g, '').split('\n');
    let out = '';
    let inCode = false;
    let list = false;
    let table = null;
    let quote = [];
    const inline = (t) =>
      esc(t)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
        .replace(/(^|\s)#(Q\d+)\b/g, '$1<span class="qid">$2</span>');
    const closeList = () => {
      if (list) out += '</ul>';
      list = false;
    };
    const closeTable = () => {
      if (!table) return;
      out += '<table>' + table.map((r, i) => '<tr>' + r.map((c) => (i ? `<td>${inline(c)}</td>` : `<th>${inline(c)}</th>`)).join('') + '</tr>').join('') + '</table>';
      table = null;
    };
    const closeQuote = () => {
      if (quote.length) out += `<blockquote>${quote.map(inline).join('<br>')}</blockquote>`;
      quote = [];
    };
    for (const line of lines) {
      if (line.trim().startsWith('```')) {
        closeList();
        closeTable();
        closeQuote();
        out += inCode ? '</code></pre>' : '<pre><code>';
        inCode = !inCode;
        continue;
      }
      if (inCode) {
        out += esc(line) + '\n';
        continue;
      }
      if (/^>\s?/.test(line)) {
        closeList();
        closeTable();
        quote.push(line.replace(/^>\s?/, ''));
        continue;
      }
      closeQuote();
      if (/^\s*\|.*\|\s*$/.test(line)) {
        closeList();
        const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
        if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
        (table ||= []).push(cells);
        continue;
      }
      closeTable();
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        closeList();
        const n = Math.min(h[1].length, 3);
        out += `<h${n}>${inline(h[2])}</h${n}>`;
      } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
        if (!list) out += '<ul>';
        list = true;
        out += `<li>${inline(line.replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`;
      } else if (!line.trim()) closeList();
      else {
        closeList();
        out += `<p>${inline(line)}</p>`;
      }
    }
    closeList();
    closeTable();
    closeQuote();
    if (inCode) out += '</code></pre>';
    return `<div class="md">${out}</div>`;
  }

  function toast(text, err) {
    const el = document.createElement('div');
    el.className = 'toast' + (err ? ' err' : '');
    el.innerHTML = `${err ? ic('x') : ic('check')}<span>${esc(text)}</span>`;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), err ? 6000 : 2600);
  }

  async function act(type, payload = {}, okText) {
    try {
      const res = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-YourTeam': '1' }, body: JSON.stringify({ ...payload, type }) });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || res.statusText);
      if (okText) toast(out.queued ? 'Queued: applies when the current session ends' : okText);
      await load();
      return true;
    } catch (e) {
      toast(e.message, true);
      return false;
    }
  }

  function confirmDialog(title, text, okLabel = 'Confirm', danger = false) {
    return new Promise((resolve) => {
      const d = $('#dialog');
      $('#dialog-form').innerHTML = `<h2>${esc(title)}</h2><p class="muted" style="margin:10px 0 20px">${esc(text)}</p><div class="row" style="justify-content:flex-end"><button class="btn" value="cancel">Cancel</button><button class="btn ${danger ? 'danger solid' : 'primary'}" value="ok">${esc(okLabel)}</button></div>`;
      d.onclose = () => resolve(d.returnValue === 'ok');
      d.showModal();
    });
  }

  // ---------- DOM morphing ----------
  const keyOf = (n) => (n.nodeType === 1 ? n.getAttribute('data-key') : null);
  function sameNode(a, b) {
    return a.nodeType === b.nodeType && (a.nodeType !== 1 || (a.tagName === b.tagName && keyOf(a) === keyOf(b) && a.id === b.id));
  }
  function morphNode(from, to) {
    if (from.nodeType !== 1) {
      if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
      return;
    }
    for (const a of [...from.attributes]) if (!to.hasAttribute(a.name)) from.removeAttribute(a.name);
    for (const a of [...to.attributes]) if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value);
    // Form fields keep what the user typed; data-static containers are filled by live code.
    if (from.hasAttribute('data-static') || from.tagName === 'TEXTAREA' || from.tagName === 'INPUT') return;
    morphChildren(from, to);
  }
  function morphChildren(from, to) {
    const keyed = new Map();
    for (const n of from.childNodes) {
      const k = keyOf(n);
      if (k) keyed.set(k, n);
    }
    const next = [...to.childNodes];
    for (let i = 0; i < next.length; i++) {
      const nk = next[i];
      const cur = from.childNodes[i] || null;
      const k = keyOf(nk);
      let match = null;
      if (k) {
        match = keyed.get(k) || null;
        if (match) keyed.delete(k);
      } else if (cur && !keyOf(cur) && sameNode(cur, nk)) match = cur;
      if (match) {
        if (match !== cur) from.insertBefore(match, cur);
        morphNode(match, nk);
      } else from.insertBefore(nk.cloneNode(true), cur);
    }
    while (from.childNodes.length > next.length) from.removeChild(from.lastChild);
  }
  function morph(el, html) {
    const t = document.createElement(el.tagName);
    t.innerHTML = html;
    morphChildren(el, t);
  }

  // ---------- data ----------
  async function load() {
    try {
      const res = await fetch('/api/state');
      S = await res.json();
      render();
      notify();
    } catch {
      setConn(false);
    }
  }
  function setConn(ok) {
    connected = ok;
    const el = $('#conn');
    if (el) el.className = 'conn-dot ' + (ok ? 'ok' : 'bad');
    const t = $('#conn-text');
    if (t) t.textContent = ok ? 'Live' : 'Reconnecting…';
  }

  function connect() {
    const es = new EventSource('/api/events');
    let t = null;
    es.addEventListener('hello', () => {
      setConn(true);
      load();
    });
    es.addEventListener('changed', () => {
      clearTimeout(t);
      t = setTimeout(load, 120);
    });
    es.addEventListener('live', (ev) => onLive(JSON.parse(ev.data)));
    es.addEventListener('app', (ev) => {
      const line = JSON.parse(ev.data);
      appLines.push(line);
      if (appLines.length > 800) appLines.splice(0, appLines.length - 800);
      const box = $('#console');
      if (box) {
        const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        box.insertAdjacentHTML('beforeend', consoleLine(line));
        if (stick) box.scrollTop = box.scrollHeight;
      }
    });
    es.onerror = () => setConn(false);
  }

  function onLive(d) {
    const s = (stream[d.sessionId] ||= { text: '', status: 'Thinking', hadDelta: false });
    const logged = [];
    for (const e of d.entries) {
      if (e.t === 'delta') {
        s.text += e.text;
        s.hadDelta = true;
      } else if (e.t === 'status') {
        if (e.text === 'Thinking' && s.text && !s.text.endsWith('\n\n')) s.text += '\n\n';
        s.status = e.text;
      } else {
        if (e.t === 'tool') s.status = `${e.name} ${e.text ? '· ' + e.text.slice(0, 60) : ''}`;
        if (e.t === 'text' && !s.hadDelta) s.text += (s.text ? '\n\n' : '') + e.text;
        logged.push(e);
      }
    }
    paintStream(d.sessionId);
    if (!logged.length) return;
    (liveEntries[d.sessionId] ||= []).push(...logged);
    // Keep an already-fetched log current even when it is not on screen.
    if (Array.isArray(logCache[d.sessionId])) logCache[d.sessionId].push(...logged);
    const el = ui.view === 'live' && ui.session === d.sessionId ? $('#log') : null;
    if (el && Array.isArray(logCache[d.sessionId])) {
      const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (el.querySelector('.skeleton, .muted')) el.innerHTML = '';
      el.insertAdjacentHTML('beforeend', logged.map(entryHtml).join(''));
      if (stick) el.scrollTop = el.scrollHeight;
    }
  }

  // Hides the trailing JSON block while it streams; the dashboard renders it as cards afterwards.
  function streamHtml(id) {
    const s = stream[id] || { text: '', status: 'Thinking' };
    let text = s.text;
    let status = s.status;
    const cut = text.indexOf('```yourteam');
    if (cut >= 0) {
      text = text.slice(0, cut);
      status = 'Preparing questions and options';
    }
    return `<div class="status"><span class="typing"><i></i><i></i><i></i></span><span class="shimmer-text">${esc(status || 'Thinking')}…</span></div>${text.trim() ? `<div class="caret">${md(text)}</div>` : ''}`;
  }
  function paintStream(id) {
    const el = document.getElementById('stream-' + id);
    if (!el) return;
    const scroller = el.closest('.chat-scroll');
    const stick = scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    el.innerHTML = streamHtml(id);
    if (stick) scroller.scrollTop = scroller.scrollHeight;
  }

  function notify() {
    const n = needsYou().length;
    document.title = (n ? `(${n}) ` : '') + `${S.state.project || ''} – YourTeam`;
    if (lastOpen >= 0 && n > lastOpen && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('YourTeam needs you', { body: needsYou().at(-1)?.title || 'New item in your inbox' });
    }
    lastOpen = n;
  }

  // ---------- routing & render ----------
  const NAV = [
    [['overview', 'overview', 'Overview'], ['inbox', 'inbox', 'Inbox']],
    [['interview', 'chat', 'Interview'], ['cto', 'cto', 'CTO'], ['plan', 'plan', 'Plan'], ['skills', 'skills', 'Skills'], ['review', 'review', 'Review'], ['app', 'play', 'Run app']],
    [['agents', 'users', 'Agents'], ['live', 'activity', 'Live sessions'], ['messages', 'messages', 'Agent messages']],
    [['usage', 'usage', 'Usage'], ['qa', 'qa', 'QA reports'], ['timeline', 'timeline', 'Timeline']],
    [['docs', 'docs', 'Docs'], ['settings', 'settings', 'Settings']],
  ];
  const TITLES = Object.fromEntries(NAV.flat().map(([id, , l]) => [id, l]));

  function parseHash() {
    const [v, arg] = (location.hash.slice(1) || 'overview').split('/');
    ui.view = TITLES[v] ? v : 'overview';
    ui.arg = arg ? decodeURIComponent(arg) : null;
  }
  function go(view, arg) {
    location.hash = arg ? `${view}/${encodeURIComponent(arg)}` : view;
  }

  function render() {
    if (!S) return;
    morph($('#sidebar'), sidebar());
    morph($('#topbar'), topbar());
    const main = $('#main');
    const chat = main.querySelector('.chat-scroll');
    const stickChat = !chat || chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
    const views = { overview, inbox, interview, cto, plan, skills: skillsView, review, app: appView, agents, live: liveView, messages, usage, qa, docs, timeline, settings };
    if (!(ui.editing && ui.view === 'docs')) morph(main, (views[ui.view] || overview)());
    const chat2 = main.querySelector('.chat-scroll');
    if (chat2 && (stickChat || chat2 !== chat)) chat2.scrollTop = chat2.scrollHeight;
    afterRender();
  }

  function afterRender() {
    if (ui.view === 'live') ensureLog();
    if (ui.view === 'docs' && ui.doc) ensureDoc(ui.doc);
    if (ui.view === 'review') ensureReview();
    if (ui.view === 'app') ensureApp();
    if (ui.view === 'qa') ensureQa();
    for (const id of Object.keys(stream)) paintStream(id);
  }

  function sidebar() {
    const n = needsYou().length;
    const badges = {
      inbox: n ? `<span class="count">${n}</span>` : '',
      live: S.active ? '<span class="dot blue pulse count" style="min-width:8px;height:8px;padding:0"></span>' : '',
      cto: (S.state.changeOrders || []).filter((c) => c.status === 'proposed').length ? `<span class="count blue">${(S.state.changeOrders || []).filter((c) => c.status === 'proposed').length}</span>` : '',
      app: S.app?.status === 'running' ? '<span class="dot green"></span>' : '',
      interview: S.chatActive?.kind === 'interview' ? '<span class="dot blue pulse"></span>' : '',
    };
    if (S.chatActive?.kind === 'cto-chat') badges.cto = '<span class="dot blue pulse"></span>';
    return `
      <div class="sb-head"><img class="sb-logo" src="logo.svg" alt=""><div class="grow"><div class="sb-name" title="${esc(S.projectDir)}">${esc(S.state.project)}</div><div class="sb-sub">YourTeam${S.demo ? ' · demo' : ''}</div></div></div>
      <div class="find" data-cmd>${ic('search')}<span>Find…</span><kbd>Ctrl K</kbd></div>
      <nav class="nav">${NAV.map((g) => g.map(([id, icon, label]) => `<a href="#${id}" class="${ui.view === id ? 'on' : ''}" data-key="nav-${id}">${ic(icon)}<span>${label}</span>${badges[id] ? `<span class="count-wrap" style="margin-left:auto;display:flex">${badges[id]}</span>` : ''}</a>`).join('')).join('<div class="sep"></div>')}</nav>
      <div class="sb-foot"><span id="conn" class="conn-dot ${connected ? 'ok' : 'bad'}"></span><span id="conn-text">${connected ? 'Live' : 'Connecting…'}</span><span class="grow"></span><button class="btn ghost icon sm" data-theme-toggle title="Theme">${ic(themeIcon())}</button></div>`;
  }

  function themeIcon() {
    const t = document.documentElement.dataset.theme;
    return t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'monitor';
  }

  function topbar() {
    const st = S.state.status;
    const a = S.active;
    const sess = a && S.sessions.find((s) => s.id === a.id);
    const canPause = ['running', 'planning', 'replanning', 'finishing', 'awaiting_answer'].includes(st);
    const canResume = ['paused', 'error', 'escalated'].includes(st);
    const app = S.app || {};
    return `
      <div class="crumbs"><span>${esc(S.state.project)}</span><span class="slash">/</span><b>${esc(TITLES[ui.view] || '')}${ui.view === 'review' && ui.arg ? ' · ' + esc(ui.arg) : ''}</b></div>
      <span class="spacer"></span>
      ${statusBadge(st)}
      ${a ? `<a class="tb-chip" href="#live" title="Running session">${stIcon('running')}<b>${esc(agentName(a.agent))}</b>${esc(a.kind)}${a.phase ? ' · ' + esc(a.phase) : ''}${sess ? ctxBar(sess.contextTokens, sess.contextWindow, 48) : ''}</a>` : ''}
      ${S.hasRun ? `<a class="tb-chip" href="#app" title="Run app">${app.status === 'running' ? '<span class="dot green"></span>' : ic('play')}${app.status === 'running' ? 'App running' : 'Run app'}</a>` : ''}
      <span class="tb-chip" style="cursor:default" title="Total spend">${money(S.state.totals?.costUsd)}</span>
      ${canPause ? `<button class="btn sm" data-act="pause" title="Finish the current session, then pause">${ic('pause')}Pause</button>` : ''}
      ${canResume ? `<button class="btn primary sm" data-act="resume">${ic('play')}Resume</button>` : ''}
      ${a ? `<button class="btn sm danger" data-act="stop" title="Stop the running session now">${ic('stop')}Stop</button>` : ''}
      ${'Notification' in window && Notification.permission === 'default' ? '<button class="btn ghost sm" data-notify>Enable alerts</button>' : ''}`;
  }

  const pageHead = (title, sub, right = '') => `<div class="page-head"><div><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div><div class="row">${right}</div></div>`;
  const empty = (icon, text, extra = '') => `<div class="empty">${ic(icon)}<div>${text}</div>${extra}</div>`;
  const view = (name, html, fill) => `<div class="view${fill ? ' fill' : ''}" data-key="view-${name}${ui.arg ? '-' + esc(ui.arg) : ''}">${html}</div>`;

  // ---------- overview ----------
  function overview() {
    const ph = phases();
    const done = ph.filter((p) => phaseStatus(p.id) === 'done').length;
    const t = S.state.totals || {};
    const open = needsYou();
    const st = S.state.status;
    const ses = S.sessions;
    const avgPeak = ses.length ? Math.round(ses.reduce((a, s) => a + pct(s.peakContextTokens, s.contextWindow), 0) / ses.length) : 0;
    const err = st === 'error' ? `<div class="banner red"><div class="grow"><b>The orchestrator hit an error.</b><pre class="small muted" style="margin-top:6px">${esc(String(S.state.error || '').slice(0, 1200))}</pre></div><button class="btn primary" data-act="resume">Resume</button></div>` : '';
    const start = st === 'interview' && !S.chat.length ? `<div class="banner blue"><div class="grow"><b>Start here.</b> Tell the CEO what you want to build, or paste a complete brief to skip the interview.</div><a class="btn primary" href="#interview">${ic('chat')}Open interview</a></div>` : '';
    const stages = [
      ['Interview', ['interview'], 'CEO learns what you need'],
      ['Spec', ['spec_review'], 'You approve the spec'],
      ['Plan', ['planning', 'plan_review'], 'CTO plans and hires'],
      ['Build', ['running', 'awaiting_answer', 'awaiting_approval', 'escalated', 'replanning', 'finishing', 'paused'], `${done}/${ph.length} phases`],
      ['Done', ['done'], 'Retro and lessons'],
    ];
    let at = stages.findIndex((s) => s[1].includes(st));
    if (at < 0) at = S.plan ? 3 : 0;
    const usageRows = [
      ['Spend', money(t.costUsd), S.config.budget?.totalUsd ? pct(t.costUsd, S.config.budget.totalUsd) : null, S.config.budget?.totalUsd ? `of ${money(S.config.budget.totalUsd)}` : 'no total budget'],
      ['Sessions', String(ses.length), null, `${ses.filter((s) => s.status === 'failed').length} failed`],
      ['Tokens', tok((t.inputTokens || 0) + (t.outputTokens || 0)), null, `${tok(t.outputTokens)} output`],
      ['Avg. peak context', avgPeak + '%', avgPeak, 'per fresh session'],
    ];
    return view(
      'overview',
      `${err}${start}
      ${pageHead(esc(S.state.project), esc(S.plan?.summary || S.projectDir))}
      <div class="card" style="padding:0;margin-bottom:28px"><div class="row nowrap" style="gap:0;overflow-x:auto">${stages
        .map((s, i) => `<div style="flex:1;min-width:150px;padding:14px 18px;border-right:${i < 4 ? '1px solid var(--border)' : '0'}"><div class="row nowrap" style="gap:8px">${stIcon(i < at || st === 'done' ? 'done' : i === at ? (['running', 'planning', 'replanning', 'finishing'].includes(st) ? 'running' : 'waiting') : 'pending')}<b style="font-weight:500">${s[0]}</b></div><div class="xs muted" style="margin:4px 0 0 26px">${s[2]}</div></div>`)
        .join('')}</div></div>
      <div class="ov-grid">
        <div class="col" style="gap:28px">
          <div><div class="section-title">Usage</div><div class="card" style="padding:6px 0">${usageRows
            .map((r) => `<div class="row nowrap" style="padding:10px 18px;justify-content:space-between"><span class="row nowrap" style="gap:10px">${r[2] != null ? `<span class="ring" style="--p:${r[2]}"></span>` : '<span class="ring" style="--p:0"></span>'}${r[0]}</span><span class="small"><b style="font-weight:500">${r[1]}</b> <span class="muted">${r[3]}</span></span></div>`)
            .join('')}</div></div>
          <div><div class="section-title">Needs you <a class="small muted" href="#inbox">View all</a></div>${open.length ? `<div class="col" style="gap:10px">${open.slice(0, 4).map((i) => inboxCard(i, true)).join('')}</div>` : `<div class="card" style="text-align:center;padding:28px">${ic('inbox')}<div class="muted small" style="margin-top:6px">Nothing needs you right now.</div></div>`}</div>
        </div>
        <div class="col" style="gap:28px">
          <div><div class="section-title">Phases <a class="small muted" href="#plan">Open plan</a></div>${ph.length ? `<div class="grid g2" style="gap:12px">${ph.map(phaseTile).join('')}</div>` : `<div class="card muted" style="text-align:center;padding:28px">${['planning', 'replanning'].includes(st) ? 'The CTO is writing the plan…' : 'Phases appear here once the CTO writes the plan.'}</div>`}</div>
          <div><div class="section-title">Recent activity <a class="small muted" href="#timeline">Timeline</a></div><div class="card" style="padding:4px 18px">${eventsList(S.events.slice(-8).reverse())}</div></div>
        </div>
      </div>`
    );
  }

  function phaseTile(p) {
    const ps = S.state.phases?.[p.id] || {};
    const status = ps.status || 'pending';
    const n = (p.steps || []).length;
    const d = Object.values(ps.steps || {}).filter((x) => x.status === 'done').length;
    const last = S.sessions.filter((s) => s.phase === p.id).at(-1);
    return `<div class="card link" data-key="tile-${esc(p.id)}" data-go="plan" data-phase-sel="${esc(p.id)}">
      <div class="row nowrap" style="justify-content:space-between"><div class="row nowrap" style="gap:10px;min-width:0"><span class="badge">${esc(p.id)}</span><b style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.title)}</b></div>${stIcon(PHASE_KIND[status], PHASE_LABEL[status])}</div>
      <div class="small muted" style="margin:8px 0">${[...new Set((p.steps || []).map((s) => agentName(s.agent)))].map(esc).join(' → ')} → QA</div>
      <div class="row nowrap" style="justify-content:space-between"><span class="bar ${status === 'done' ? '' : 'blue'}" style="flex:1"><i style="width:${status === 'done' ? 100 : pct(d, n + 1)}%"></i></span><span class="xs faint" style="margin-left:10px">${status === 'pending' && !autoRun(p.id) ? 'waits for you' : last ? ago(last.endedAt || last.startedAt) : PHASE_LABEL[status]}</span></div>
    </div>`;
  }

  function eventsList(evs) {
    if (!evs.length) return '<div class="muted small" style="padding:12px 0">Nothing yet.</div>';
    return `<div class="list-rows">${evs.map((e, i) => `<div class="row nowrap" data-key="ev-${esc(e.ts)}-${i}" style="padding:10px 0;align-items:flex-start;gap:12px"><span class="xs faint" style="width:64px;flex:none;padding-top:2px">${ago(e.ts)}</span><span class="small grow">${esc(e.text)}</span></div>`).join('')}</div>`;
  }

  // ---------- inbox ----------
  function inboxCard(it, compact) {
    const meta = [ago(it.createdAt), it.from ? agentName(it.from) : '', it.phase || ''].filter(Boolean).map(esc).join(' · ');
    let body = '';
    if (it.status !== 'open') body = `<div class="small muted">Resolved ${ago(it.resolvedAt)}: <b>${esc(it.response)}</b></div>`;
    else if (it.type === 'question')
      body = `${it.assumption ? `<div class="small muted" style="margin-bottom:8px">Agent's assumption: ${esc(it.assumption)}</div>` : ''}<div class="row nowrap" style="align-items:flex-end"><textarea rows="1" id="ans-${it.id}" placeholder="Your answer" style="min-height:34px"></textarea><button class="btn primary" data-answer="${it.id}">Answer</button></div>`;
    else if (it.kind === 'plan') body = `<div class="row"><button class="btn primary sm" data-act="approve-plan">Approve plan</button><a class="btn sm" href="#plan">Review plan</a><a class="btn sm" href="#cto">${ic('cto')}Discuss with CTO</a></div>`;
    else if (it.kind === 'spec') body = `<div class="row"><button class="btn primary sm" data-act="approve-spec">Approve spec</button><a class="btn sm" href="#docs" data-open-doc="spec.md">Read spec</a><button class="btn sm" data-act="reopen-interview">Keep discussing</button></div>`;
    else if (it.kind === 'phase-start') {
      const tests = it.manualTests?.length && !compact ? `<div class="card flat tight" style="margin:4px 0 12px"><div class="label" style="margin-bottom:6px">How to test ${esc(it.prevPhase || '')}</div><div class="checklist">${it.manualTests.map((t, i) => `<label><input type="checkbox" data-key="mt-${it.id}-${i}"><span class="small">${esc(t)}</span></label>`).join('')}</div></div>` : '';
      body = `${tests}<div class="row"><button class="btn primary sm" data-act="start-phase" data-phase="${esc(it.phase)}">${ic('play')}Start ${esc(it.phase)}</button>${S.hasRun ? `<a class="btn sm" href="#app">Run app</a>` : ''}${it.prevPhase ? `<a class="btn sm" href="#review/${esc(it.prevPhase)}">Review ${esc(it.prevPhase)}</a>` : ''}<button class="btn sm" data-cto-ref="${esc(it.prevPhase || it.phase)}">${ic('cto')}Report to CTO</button><button class="btn ghost sm" data-act="set-autorun" data-phase="${esc(it.phase)}" data-value="1">Turn on auto-run</button></div>`;
    } else if (it.kind === 'phase') body = `<div class="row"><button class="btn primary sm" data-act="approve-phase" data-phase="${esc(it.phase)}">Approve ${esc(it.phase)}</button></div>`;
    else if (it.options?.length) {
      const labels = { retry: 'Retry', accept: 'Accept anyway', pause: 'Pause', 'skip-step': 'Skip this step', continue: 'Continue', ok: 'Dismiss' };
      body = `<div class="row">${it.options.map((o, i) => `<button class="btn sm ${i === 0 ? 'primary' : ''}" data-resolve="${it.id}" data-option="${o}">${labels[o] || o}</button>`).join('')}</div>`;
    }
    const type = { question: [it.blocking ? 'Blocking question' : 'Question', it.blocking ? 'red' : 'amber'], approval: [it.kind === 'phase-start' ? 'Phase gate' : 'Approval', 'blue'], escalation: ['Decision', 'red'], info: ['Info', 'green'] }[it.type] || [it.type, ''];
    return `<div class="card ${compact ? 'tight' : ''}" data-key="inbox-${it.id}">
      <div class="row nowrap" style="justify-content:space-between;align-items:flex-start;gap:12px"><div class="col" style="gap:6px;min-width:0"><div class="row"><span class="badge ${type[1]}">${type[0]}</span><b style="font-weight:500">${esc(it.title)}</b></div></div><span class="xs faint" style="white-space:nowrap">${meta}</span></div>
      ${it.text && it.text !== it.title ? `<div class="small" style="margin:8px 0 10px;white-space:pre-wrap;color:var(--text-2)">${esc(it.text)}</div>` : '<div style="height:10px"></div>'}
      ${body}
    </div>`;
  }

  function inbox() {
    const open = openInbox().reverse();
    const done = S.inbox.filter((i) => i.status !== 'open').reverse().slice(0, 50);
    return view(
      'inbox',
      `${pageHead('Inbox', 'Questions from agents, phase gates, approvals and decisions. Blocking questions pause the phase until you answer.')}
      <div class="col">${open.length ? open.map((i) => inboxCard(i)).join('') : empty('inbox', 'All clear. Nothing needs you.')}</div>
      ${done.length ? `<details style="margin-top:28px"><summary class="small">${ic('chevron')} Resolved (${done.length})</summary><div class="col" style="margin-top:12px">${done.map((i) => inboxCard(i, true)).join('')}</div></details>` : ''}`
    );
  }

  // ---------- chat building blocks ----------
  function composer({ id, placeholder, disabled, busy, ctxChips = '', extraFoot = '', sendLabel = 'Send' }) {
    const m = ui.mention && ui.mention.target === id ? ui.mention : null;
    return `<div class="composer" data-key="composer-${id}">
      ${m && m.items.length ? `<div class="mention-menu" data-key="mm">${m.items.map((x, i) => `<button class="${i === m.idx ? 'on' : ''}" data-mention="${esc(x.insert)}">${x.icon || ''}<span class="grow">${esc(x.label)}</span><span class="xs faint">${esc(x.hint || '')}</span></button>`).join('')}</div>` : ''}
      ${ctxChips ? `<div class="ctx" data-key="ctx">${ctxChips}</div>` : ''}
      <div class="composer-box" data-key="box"><textarea id="${id}" rows="1" placeholder="${esc(placeholder)}" ${disabled ? 'disabled' : ''}></textarea>
        ${busy ? `<button class="btn sm" data-act="chat-stop" title="Stop this reply">${ic('stop')}Stop</button>` : `<button class="btn primary sm" data-send="${id}" ${disabled ? 'disabled' : ''}>${ic('send')}${sendLabel}</button>`}</div>
      <div class="composer-foot" data-key="foot"><span class="xs faint">Enter to send · Shift+Enter for a new line${extraFoot}</span></div>
    </div>`;
  }

  function quoteChip(scope) {
    const q = ui.quote[scope];
    return q ? `<span class="ctx-chip">${ic('reply')}<span>Replying to ${esc(q.who)}: ${esc(q.text.slice(0, 120))}</span><button data-unquote="${scope}" title="Remove">${ic('x')}</button></span>` : '';
  }

  function msgActions(scope, who, idx) {
    return `<div class="actions"><button class="btn ghost icon xs" data-quote="${scope}" data-who="${esc(who)}" data-idx="${idx}" title="Reply to this">${ic('reply')}</button><button class="btn ghost icon xs" data-copy="${scope}" data-idx="${idx}" title="Copy">${ic('copy')}</button></div>`;
  }

  function userBubble(m, scope, idx) {
    const answers = (m.answers || []).map((a) => `<span class="answer-chip"><span class="qid" style="border:0;padding:0">${esc(a.id)}</span> <b>${esc(a.answer)}</b></span>`).join('');
    const text = m.text || '';
    const qm = text.match(/^((?:>.*\n?)+)\n?([\s\S]*)$/);
    return `<div class="msg user" data-key="${scope}-${idx}">${msgActions(scope, 'you', idx)}<div class="body">
      <div class="who">${ago(m.ts)}</div>
      ${answers ? `<div class="answer-chips">${answers}</div>` : ''}
      ${text.trim() ? `<div class="bubble">${qm ? `<div class="quote">${esc(qm[1].replace(/^> ?/gm, '').trim())}</div>${esc(qm[2])}` : esc(text)}</div>` : ''}
    </div></div>`;
  }

  // ---------- interview ----------
  function answeredQuestions() {
    const ids = new Set();
    for (const m of S.chat) if (m.role === 'user') for (const a of m.answers || []) ids.add(a.id);
    return ids;
  }

  function questionCard(q, msgIdx, answered, interactive) {
    const a = ui.answers[q.id] || {};
    const picked = !!(a.choice || a.text);
    const prev = answered ? S.chat.find((m) => m.role === 'user' && (m.answers || []).some((x) => x.id === q.id))?.answers.find((x) => x.id === q.id) : null;
    return `<div class="qcard ${answered ? 'done' : picked ? 'picked' : interactive ? 'pending' : ''}" data-key="q-${msgIdx}-${esc(q.id)}">
      <div class="qtop"><span class="qid">${esc(q.id)}</span><div class="qtext">${esc(q.text)}</div>${interactive && !answered ? `<button class="btn ghost icon xs" data-quote-q="${esc(q.id)}" title="Reply about this question">${ic('reply')}</button>` : ''}</div>
      ${answered ? `<div class="small muted" style="margin:6px 0 0 34px">${ic('check')} ${esc(prev?.answer || 'Answered')}</div>` : interactive ? `<div class="opts" style="margin-left:34px">${q.options.map((o) => `<button class="opt ${a.choice === o ? 'on' : ''}" data-qopt="${esc(q.id)}" data-val="${esc(o)}">${esc(o)}</button>`).join('')}</div>
        <div class="qother" style="margin-left:34px"><input type="text" data-qother="${esc(q.id)}" placeholder="Or answer in your own words…"></div>` : ''}
    </div>`;
  }

  function interview() {
    const st = S.state.status;
    const open = ['interview', 'spec_review'].includes(st);
    const busy = S.chatActive?.kind === 'interview';
    const started = !!S.state.interviewSessionId;
    const answered = answeredQuestions();
    const lastCeo = S.chat.map((m, i) => [m, i]).filter(([m]) => m.role === 'ceo').at(-1)?.[1];
    const msgs = S.chat
      .map((m, i) => {
        if (m.role === 'user') return userBubble(m, 'interview', i);
        if (m.role === 'system' || m.role === 'error') return `<div class="msg ${m.role}" data-key="interview-${i}"><div class="body"><div class="small">${esc(m.text)}</div></div></div>`;
        const qs = (m.questions || []).map((q) => questionCard(q, i, answered.has(q.id), open && i === lastCeo && !busy)).join('');
        return `<div class="msg" data-key="interview-${i}">${msgActions('interview', 'CEO', i)}<span class="av ceo">CEO</span><div class="body"><div class="who"><b>CEO</b>${ago(m.ts)}${m.readyForSpec ? '<span class="badge green">Ready to write the spec</span>' : ''}</div>${md(m.text)}${qs ? `<div class="qcards">${qs}</div>` : ''}</div></div>`;
      })
      .join('');
    const streaming = busy ? `<div class="msg streaming" data-key="stream-${S.chatActive.id}"><span class="av ceo">CEO</span><div class="body"><div class="who"><b>CEO</b></div><div id="stream-${S.chatActive.id}" data-static>${streamHtml(S.chatActive.id)}</div></div></div>` : '';
    const pending = Object.entries(ui.answers).filter(([, v]) => v.choice || v.text);
    const chips = pending.map(([id, v]) => `<span class="ctx-chip"><span><span class="qid" style="border:0;padding:0">${esc(id)}</span> ${esc(v.text || v.choice)}</span><button data-unanswer="${esc(id)}" title="Remove">${ic('x')}</button></span>`).join('') + quoteChip('interview');
    const review = st === 'spec_review' ? `<div class="banner amber" style="margin:0;border-radius:0;border-width:0 0 1px"><div class="grow"><b>The spec is ready for your review.</b> Read it, then approve so the CTO can plan, or keep discussing.</div><a class="btn sm" href="#docs" data-open-doc="spec.md">Read spec</a><button class="btn primary sm" data-act="approve-spec">Approve spec</button></div>` : '';
    const intro = `<div class="empty" style="margin:auto;max-width:520px;border:0">${ic('chat')}<div style="color:var(--text);font-weight:500;margin-bottom:6px">What do you want to build?</div><div class="small">Describe it in your own words, e.g. “A booking app for my yoga studio: clients book classes, I manage the schedule.” The CEO will ask a few questions with suggested answers, then write the spec.<br><br>Have a complete brief already? Tick “Skip the interview” below and paste it.</div></div>`;
    const cov = S.state.coverage || {};
    const areas = [['users', 'Users'], ['scope', 'Scope'], ['flows', 'User flows'], ['data', 'Data'], ['integrations', 'Integrations'], ['platform', 'Platform'], ['quality', 'Quality needs'], ['done', 'Definition of done']];
    const covDone = areas.filter(([k]) => cov[k] === 'done').length + areas.filter(([k]) => cov[k] === 'partial').length * 0.5;
    const ctx = S.state.interviewContext;
    return view(
      'interview',
      `<div class="chat-layout">
        <div class="chat-col" data-key="col">
          <div class="chat-head" data-key="head"><span class="av ceo" style="width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:9px;font-weight:700;color:#fff;background:linear-gradient(135deg,#ff9a3c,#ff4d8d)">CEO</span><div class="grow"><b>Interview with the CEO</b><div class="xs muted">You are the customer. The CEO turns this conversation into the spec.</div></div>
            ${S.hasSpec ? `<a class="btn sm" href="#docs" data-open-doc="spec.md">${ic('file')}Spec</a>` : ''}
            ${open && started ? `<button class="btn primary sm" data-act="finalize-spec" ${busy ? 'disabled' : ''}>Write the spec</button>` : ''}</div>
          ${review}
          ${!open ? `<div class="banner" style="margin:0;border-radius:0;border-width:0 0 1px"><div class="grow small">The interview is closed. To change scope now, talk to the CTO.</div><a class="btn sm" href="#cto">${ic('cto')}Open CTO chat</a></div>` : ''}
          <div class="chat-scroll" data-key="scroll">${msgs || (busy ? '' : intro)}${streaming}</div>
          ${open ? composer({ id: 'chat-input', placeholder: started ? 'Reply to the CEO… (type # to reference a question)' : 'Describe what you want to build…', busy, ctxChips: chips, sendLabel: pending.length && !started ? 'Send' : pending.length ? `Send ${pending.length} answer${pending.length > 1 ? 's' : ''}` : 'Send', extraFoot: !started ? ' · <label class="check" style="display:inline-flex"><input type="checkbox" id="brief-mode"> Skip the interview: this is a complete brief</label>' : '' }) : ''}
        </div>
        <div class="rail" data-key="rail">
          <div class="card"><div class="card-head"><h3>Coverage</h3><span class="xs muted">${Math.round((covDone / areas.length) * 100)}%</span></div>
            <div class="bar blue" style="margin-bottom:10px"><i style="width:${(covDone / areas.length) * 100}%"></i></div>
            ${areas.map(([k, l]) => `<div class="cov-row">${stIcon(cov[k] === 'done' ? 'done' : cov[k] === 'partial' ? 'waiting' : 'pending')}<span class="grow">${l}</span><span class="xs faint">${cov[k] || 'todo'}</span></div>`).join('')}
            ${S.chat.filter((m) => m.role === 'ceo').at(-1)?.readyForSpec && open && st === 'interview' ? `<div class="divider"></div><div class="small muted" style="margin-bottom:8px">The CEO has enough to write a solid spec.</div><button class="btn primary sm" data-act="finalize-spec" style="width:100%" ${busy ? 'disabled' : ''}>Write the spec</button>` : ''}</div>
          ${S.hasSpec ? `<div class="card"><div class="card-head"><h3>Spec</h3>${st === 'spec_review' ? '<span class="badge amber">Needs review</span>' : st === 'interview' ? '<span class="badge">Draft</span>' : '<span class="badge green">Approved</span>'}</div><div class="row"><a class="btn sm" href="#docs" data-open-doc="spec.md">Open</a>${st === 'spec_review' ? '<button class="btn primary sm" data-act="approve-spec">Approve</button>' : ''}</div></div>` : ''}
          <div class="card"><h3 style="margin-bottom:8px">Tips</h3><div class="small muted col" style="gap:6px"><div>Click a suggested answer, or type your own under any question. Answers are sent together.</div><div>Type <span class="qid">#</span> to reference a question, or hover a message and click ${ic('reply')} to quote it.</div></div></div>
          ${ctx ? `<div class="card"><div class="card-head" style="margin-bottom:6px"><h3>Conversation context</h3></div>${ctxBar(ctx.tokens, ctx.window, 160)}</div>` : ''}
        </div>
      </div>`,
      true
    );
  }

  // ---------- CTO chat ----------
  const CTO_OK = ['plan_review', 'running', 'paused', 'awaiting_answer', 'awaiting_approval', 'escalated', 'done', 'error', 'finishing'];

  function coDetail(co) {
    const p = co.payload || {};
    if (co.type === 'fix') return (p.steps || [{ agent: p.agent, items: p.items }]).map((s) => `<div class="small" style="margin-top:6px"><span class="badge">${esc(agentName(s.agent))}</span> ${(Array.isArray(s.items) ? s.items : [s.items]).filter(Boolean).map(esc).join('<br>')}</div>`).join('') + (p.acceptance?.length ? `<div class="xs muted" style="margin-top:6px">QA checks: ${p.acceptance.map(esc).join('; ')}</div>` : '');
    if (co.type === 'add-phase') return `<div class="small muted" style="margin-top:6px">New phase <b>${esc(p.phase?.id)}</b> ${esc(p.phase?.title || '')} · ${esc(p.position || 'end')}</div>`;
    if (co.type === 'update-phase') return `<div class="small muted" style="margin-top:6px">Changes ${esc(p.id)}: ${esc(Object.keys(p.phase || {}).join(', '))}</div>`;
    if (co.type === 'remove-phase') return `<div class="small muted" style="margin-top:6px">Removes ${esc(p.id)}</div>`;
    if (co.type === 'add-agent') return `<div class="small muted" style="margin-top:6px">Hires ${esc(p.agent?.name || p.agent?.id)} (${esc(p.agent?.model || 'sonnet')})</div>`;
    if (co.type === 'message') return `<div class="small muted" style="margin-top:6px">To ${esc(agentName(p.to))}: ${esc(p.text)}</div>`;
    if (co.type === 'spec-change') return `<div class="small muted" style="margin-top:6px">${esc(p.text)}</div>`;
    return '';
  }
  function coCard(co) {
    const labels = { fix: 'Fix', 'add-phase': 'New phase', 'update-phase': 'Change phase', 'remove-phase': 'Remove phase', 'add-agent': 'Hire agent', message: 'Note to agent', 'spec-change': 'Spec change' };
    const status = { proposed: ['Proposed', 'blue'], queued: ['Queued', 'amber'], applied: ['Applied', 'green'], failed: ['Failed', 'red'], rejected: ['Rejected', ''] }[co.status] || [co.status, ''];
    return `<div class="co-card ${co.status}" data-key="co-${co.id}"><div class="row nowrap" style="justify-content:space-between;gap:10px"><div class="row" style="min-width:0"><span class="badge purple">${labels[co.type] || co.type}</span><b style="font-weight:500">${esc(co.title)}</b></div><span class="badge ${status[1]}">${status[0]}</span></div>
      ${coDetail(co)}
      ${co.error ? `<div class="small" style="color:var(--red);margin-top:6px">${esc(co.error)}</div>` : ''}
      ${['proposed', 'failed'].includes(co.status) ? `<div class="row" style="margin-top:10px"><button class="btn primary xs" data-apply-co="${co.id}">${ic('check')}Apply</button><button class="btn ghost xs" data-reject-co="${co.id}">Dismiss</button></div>` : ''}</div>`;
  }

  function cto() {
    const st = S.state.status;
    const ok = CTO_OK.includes(st);
    const threads = S.cto?.threads || [];
    const th = threads.find((t) => t.id === S.cto?.activeThread) || threads.at(-1);
    const log = th ? S.cto.logs[th.id] || [] : [];
    const busy = S.chatActive?.kind === 'cto-chat';
    const cos = S.state.changeOrders || [];
    const byId = Object.fromEntries(cos.map((c) => [c.id, c]));
    const planMode = st === 'plan_review';
    const msgs = log
      .map((m, i) => {
        if (m.role === 'user') return userBubble(m, 'cto', i);
        if (m.role === 'error' || m.role === 'system') return `<div class="msg ${m.role}" data-key="cto-${i}"><div class="body"><div class="small">${esc(m.text)}</div></div></div>`;
        const diff = m.planChanges?.length
          ? `<div class="diff-card"><div class="dh"><span>Plan and team changes</span>${m.planErrors?.length ? '<span style="color:var(--red)">Invalid plan</span>' : '<span style="color:var(--green)">Valid plan</span>'}</div>${m.planChanges.map((c) => `<div class="diff-line ${c.op}"><span class="op">${c.op === 'add' ? '+' : c.op === 'remove' ? '−' : '~'}</span><span class="grow">${esc(c.text)}${c.detail ? ` <span class="muted small">${esc(c.detail)}</span>` : ''}</span></div>`).join('')}${m.planErrors?.length ? `<div class="small" style="color:var(--red);padding:8px 12px;border-top:1px solid var(--border)">${m.planErrors.map(esc).join('<br>')}</div>` : ''}</div>`
          : m.planErrors?.length
            ? `<div class="diff-card"><div class="small" style="color:var(--red);padding:8px 12px">${m.planErrors.map(esc).join('<br>')}</div></div>`
            : '';
        const orders = (m.changeOrders || []).map((id) => (byId[id] ? coCard(byId[id]) : '')).join('');
        return `<div class="msg" data-key="cto-${i}">${msgActions('cto', 'CTO', i)}<span class="av cto">CTO</span><div class="body"><div class="who"><b>CTO</b>${ago(m.ts)}</div>${md(m.text)}${m.note ? `<div class="small muted" style="margin-top:6px">${esc(m.note)}</div>` : ''}${diff}${orders}</div></div>`;
      })
      .join('');
    const streaming = busy ? `<div class="msg streaming" data-key="stream-${S.chatActive.id}"><span class="av cto">CTO</span><div class="body"><div class="who"><b>CTO</b></div><div id="stream-${S.chatActive.id}" data-static>${streamHtml(S.chatActive.id)}</div></div></div>` : '';
    const suggestions = planMode
      ? ['Walk me through the plan', 'Split the biggest phase into smaller ones', 'Use fewer agents to save tokens', 'Add a phase for tests and docs']
      : ['I tested the last phase and found a problem: ', 'What is left to build?', 'Change the next phase so that ', 'Why did QA fail?'];
    const intro = `<div class="empty" style="margin:auto;max-width:540px;border:0">${ic('cto')}<div style="color:var(--text);font-weight:500;margin-bottom:6px">${planMode ? 'Shape the plan with the CTO' : 'Talk to the CTO'}</div><div class="small">${planMode ? 'Ask for any change to the phases, tasks or team. The CTO edits the plan directly and you see a diff after each reply.' : 'Tested something and want changes? Describe it here. The CTO works out which agent owns it and proposes change orders that you apply with one click.'}</div><div class="row" style="justify-content:center;margin-top:16px">${suggestions.map((s) => `<button class="btn sm" data-suggest="${esc(s)}">${esc(s.replace(/: $/, '…').replace(/ that $/, '…'))}</button>`).join('')}</div></div>`;
    const pendingCos = cos.filter((c) => ['proposed', 'queued', 'failed'].includes(c.status));
    if (!ok) return view('cto', `${pageHead('CTO', 'Chat with the CTO about the plan, the team and anything you test.')}${empty('cto', ['planning', 'replanning'].includes(st) ? 'The CTO is writing the plan. The chat opens when it is ready for your review.' : 'The CTO chat opens once the spec is approved and the plan is written.')}`);
    return view(
      'cto',
      `<div class="chat-layout">
        <div class="chat-col" data-key="col">
          <div class="chat-head" data-key="head"><span class="av cto" style="width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:9px;font-weight:700;color:#fff;background:linear-gradient(135deg,#3291ff,#7c3aed)">CTO</span>
            <div class="grow"><b>CTO</b><div class="xs muted">${planMode ? 'Plan review · the CTO edits the plan directly' : 'Build mode · the CTO proposes change orders you apply'}</div></div>
            ${threads.length > 1 ? `<select id="thread-select" style="width:auto;height:30px;padding:0 8px">${threads.map((t) => `<option value="${t.id}" ${t.id === th?.id ? 'selected' : ''}>${esc(t.title)}</option>`).join('')}</select>` : ''}
            ${th ? ctxBar(th.contextTokens, th.contextWindow, 60) : ''}
            <button class="btn sm" data-act="cto-new-thread" ${busy ? 'disabled' : ''} title="Start a fresh conversation (keeps context small)">${ic('plus')}New thread</button></div>
          ${planMode ? `<div class="banner amber" style="margin:0;border-radius:0;border-width:0 0 1px"><div class="grow small"><b>The plan is waiting for your approval.</b> Approve when you're happy with it.</div><a class="btn sm" href="#plan">View plan</a><button class="btn primary sm" data-act="approve-plan">Approve plan</button></div>` : ''}
          <div class="chat-scroll" data-key="scroll">${msgs || (busy ? '' : intro)}${streaming}</div>
          ${composer({ id: 'cto-input', placeholder: 'Message the CTO… (type @ to mention a phase or agent)', busy, ctxChips: quoteChip('cto') })}
        </div>
        <div class="rail" data-key="rail">
          <div class="card"><div class="card-head"><h3>Change orders</h3><span class="xs muted">${pendingCos.length} open</span></div>${pendingCos.length ? pendingCos.map(coCard).join('') : '<div class="small muted">Nothing waiting. When you report a problem, the CTO proposes fixes here.</div>'}
            ${cos.filter((c) => c.status === 'applied').length ? `<details style="margin-top:12px"><summary class="xs">${cos.filter((c) => c.status === 'applied').length} applied</summary>${cos.filter((c) => c.status === 'applied').slice(-6).reverse().map(coCard).join('')}</details>` : ''}</div>
          <div class="card"><h3 style="margin-bottom:8px">What the CTO can do now</h3><div class="small muted col" style="gap:6px">${planMode ? '<div>Edit phases, tasks, acceptance criteria and the team directly. A diff appears under each reply.</div><div>Approve the plan when you are happy with it.</div>' : '<div>Read the code, handoffs and QA reports to find the cause of a problem.</div><div>Propose fixes (they run as a small phase with QA before the next phase), new phases, plan changes, new agents or notes to agents.</div><div>Nothing changes until you click Apply.</div>'}</div></div>
        </div>
      </div>`,
      true
    );
  }

  // ---------- plan ----------
  function sw(on, attrs, label) {
    return `<span class="switch-row" ${attrs}><button class="switch" role="switch" aria-label="Auto-run" aria-checked="${on}" ${attrs}></button>${label ? `<span>${label}</span>` : ''}</span>`;
  }

  function phaseDetail(p) {
    const ps = S.state.phases?.[p.id] || {};
    const status = ps.status || 'pending';
    const gate = openInbox().find((i) => i.kind === 'phase-start' && i.phase === p.id);
    const steps = (p.steps || [])
      .map((s, i) => {
        const ss = ps.steps?.[i] || {};
        const sst = ss.status || 'pending';
        const kind = { done: 'done', running: 'running', blocked: 'error', waiting: 'waiting' }[sst] || 'pending';
        return `<div class="step" data-key="step-${esc(p.id)}-${i}"><div class="row nowrap" style="justify-content:space-between"><div class="row nowrap">${stIcon(kind, sst)}<b style="font-weight:500">${i + 1}. ${esc(agentName(s.agent))}</b></div><span class="xs faint">${ss.sessions?.length ? `${ss.sessions.length} session${ss.sessions.length > 1 ? 's' : ''}` : sst}</span></div>
          <div style="margin-top:8px">${(s.tasks || []).map((t) => `<div class="task"><div class="row nowrap" style="justify-content:space-between;align-items:flex-start"><span><span class="mono xs faint">${esc(t.id)}</span> <span style="font-weight:500">${esc(t.title)}</span></span>${(ss.tasksDone || []).includes(t.id) ? '<span class="badge green">done</span>' : ''}</div>${t.details ? `<div class="small muted" style="margin-top:2px;white-space:pre-wrap">${esc(t.details)}</div>` : ''}${(t.acceptance || []).length ? `<div class="xs faint" style="margin-top:4px">Acceptance: ${t.acceptance.map(esc).join(' · ')}</div>` : ''}</div>`).join('')}</div></div>`;
      })
      .join('');
    const fixes = (ps.fixQueue || []).map((f) => `<div class="small">${ic('refresh')} ${esc(agentName(f.agent))}: ${esc(f.reason)} (${f.items.length})</div>`).join('');
    return `<div class="card" data-key="detail-${esc(p.id)}">
      <div class="row nowrap" style="justify-content:space-between;align-items:flex-start;gap:16px">
        <div style="min-width:0"><div class="row"><span class="badge">${esc(p.id)}</span>${stIcon(PHASE_KIND[status])}<span class="small muted">${PHASE_LABEL[status]}</span>${p.fix ? '<span class="badge purple">Fix</span>' : ''}</div><h2 style="margin-top:8px">${esc(p.title)}</h2><p class="sub small">${esc(p.goal || '')}</p></div>
        ${status === 'pending' ? sw(autoRun(p.id), `data-autorun="${esc(p.id)}"`, autoRun(p.id) ? 'Auto-run' : 'Ask before starting') : ''}
      </div>
      <div class="row" style="margin:14px 0">
        ${gate ? `<button class="btn primary sm" data-act="start-phase" data-phase="${esc(p.id)}">${ic('play')}Start ${esc(p.id)}</button>` : ''}
        ${status !== 'pending' ? `<a class="btn sm" href="#review/${esc(p.id)}">${ic('review')}Review</a>` : ''}
        <button class="btn sm" data-cto-ref="${esc(p.id)}">${ic('cto')}Discuss with CTO</button>
        <button class="btn ghost sm" data-act="rerun-qa" data-phase="${esc(p.id)}" ${status === 'pending' ? 'disabled' : ''}>Re-run QA</button>
        <button class="btn ghost sm" data-confirm="rerun-phase" data-phase="${esc(p.id)}">Re-run phase</button>
        <button class="btn ghost sm" data-confirm="skip-phase" data-phase="${esc(p.id)}">Skip</button>
        ${S.git ? `<button class="btn ghost sm danger" data-confirm="rollback-phase" data-phase="${esc(p.id)}" ${status === 'pending' ? 'disabled' : ''}>Roll back</button>` : ''}
      </div>
      <div class="steps">${steps}</div>
      <div class="step" style="margin-top:8px"><div class="row nowrap">${stIcon(status === 'done' ? 'done' : status === 'qa' ? 'running' : 'pending')}<b style="font-weight:500">QA</b><span class="xs faint" style="margin-left:auto">${ps.qaRounds ? `${ps.qaRounds} round${ps.qaRounds > 1 ? 's' : ''}` : ''}</span></div>
        <ul style="margin:8px 0 0;padding-left:20px" class="small">${(p.qa?.criteria || []).map((c) => `<li>${esc(c)}</li>`).join('')}</ul>${p.qa?.how ? `<div class="xs faint" style="margin-top:6px">How: ${esc(p.qa.how)}</div>` : ''}</div>
      ${fixes ? `<div class="col" style="gap:4px;margin-top:12px"><div class="label">Fix queue</div>${fixes}</div>` : ''}
    </div>`;
  }

  function plan() {
    const st = S.state.status;
    if (!S.plan) return view('plan', `${pageHead('Plan', 'Phases, steps and tasks the CTO planned.')}${empty('plan', ['planning', 'replanning'].includes(st) ? 'The CTO is designing the architecture, hiring the team and writing the plan…' : 'No plan yet. It is written after you approve the spec.')}`);
    const ph = phases();
    const cols = [['Pending', ['pending']], ['Building', ['building']], ['QA', ['qa']], ['Needs you', ['awaiting_approval', 'escalated']], ['Done', ['done', 'skipped']]];
    const sel = ph.find((p) => p.id === ui.phase) || ph.find((p) => p.id === S.state.currentPhase) || ph[0];
    const allAuto = ph.every((p) => autoRun(p.id));
    const noneAuto = ph.every((p) => !autoRun(p.id));
    const review = st === 'plan_review' ? `<div class="banner amber"><div class="grow"><b>Review the plan and the team.</b> Want changes? Chat with the CTO; it edits the plan and shows you a diff. ${pendingSuggestions().length ? `The CTO also suggests ${pendingSuggestions().length} skill${pendingSuggestions().length > 1 ? 's' : ''} for the agents. ` : ''}Approve when you're happy.</div>${pendingSuggestions().length ? `<a class="btn sm" href="#skills">${ic('skills')}Review skills</a>` : ''}<a class="btn sm" href="#cto">${ic('cto')}Discuss with CTO</a><button class="btn primary sm" data-act="approve-plan">Approve plan</button></div>` : '';
    return view(
      'plan',
      `${review}${pageHead('Plan', `${esc(S.plan.mode || '')} · ${ph.length} phases · ${esc(S.plan.summary || '')}`, `<span class="small muted">When a phase is ready</span><div class="seg"><button class="${allAuto ? 'on' : ''}" data-autorun-all="1">Auto-run all</button><button class="${noneAuto ? 'on' : ''}" data-autorun-all="0">Ask before each</button></div>`)}
      <div class="board">${cols
        .map(([label, sts]) => {
          const items = ph.filter((p) => sts.includes(phaseStatus(p.id)));
          return `<div class="board-col" data-key="col-${label}"><div class="ch"><span>${label}</span><span>${items.length}</span></div><div class="cards">${items
            .map((p) => {
              const ps = S.state.phases?.[p.id] || {};
              const n = (p.steps || []).length;
              const d = Object.values(ps.steps || {}).filter((x) => x.status === 'done').length;
              const status = phaseStatus(p.id);
              return `<div class="pcard ${sel?.id === p.id ? 'sel' : ''}" data-key="pc-${esc(p.id)}" data-phase-sel="${esc(p.id)}"><div class="row nowrap" style="justify-content:space-between"><span class="mono xs muted">${esc(p.id)}</span>${stIcon(PHASE_KIND[status], PHASE_LABEL[status])}</div><div class="t">${esc(p.title)}</div><div class="xs muted">${[...new Set((p.steps || []).map((s) => agentName(s.agent)))].map(esc).join(' → ')} → QA</div>
                ${status === 'pending' ? `<div class="row nowrap" style="justify-content:space-between;margin-top:10px">${sw(autoRun(p.id), `data-autorun="${esc(p.id)}"`, `<span class="xs">${autoRun(p.id) ? 'Auto-run' : 'Ask first'}</span>`)}</div>` : `<div class="bar ${status === 'done' ? '' : 'blue'}" style="margin-top:10px"><i style="width:${status === 'done' ? 100 : pct(d, n + 1)}%"></i></div>`}</div>`;
            })
            .join('')}</div></div>`;
        })
        .join('')}</div>
      <div style="margin-top:24px">${sel ? phaseDetail(sel) : ''}</div>`
    );
  }

  // ---------- review ----------
  function ensureReview() {
    const id = ui.arg;
    if (!id) return;
    const ps = S.state.phases?.[id] || {};
    const key = `${ps.status}-${ps.qaRounds}-${S.sessions.filter((s) => s.phase === id).length}`;
    if (reviewCache[id]?.key === key) return;
    reviewCache[id] = { key, data: reviewCache[id]?.data || null };
    fetch(`/api/review?phase=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((d) => {
        reviewCache[id].data = d;
        if (ui.view === 'review') render();
      });
  }

  function diffHtml(text) {
    return `<div class="diff">${String(text)
      .split('\n')
      .map((l) => {
        const c = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') ? 'm' : l.startsWith('@@') ? 'h' : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'r' : '';
        return `<div class="${c}">${esc(l) || ' '}</div>`;
      })
      .join('')}</div>`;
  }

  function review() {
    const ph = phases();
    if (!ph.length) return view('review', `${pageHead('Review', 'Check what each phase built before the next one starts.')}${empty('review', 'Nothing to review yet.')}`);
    if (!ui.arg || !ph.some((p) => p.id === ui.arg)) {
      const def = [...ph].reverse().find((p) => ['done', 'qa', 'building'].includes(phaseStatus(p.id))) || ph[0];
      ui.arg = def.id;
    }
    const p = ph.find((x) => x.id === ui.arg);
    const ps = S.state.phases?.[p.id] || {};
    const status = ps.status || 'pending';
    const data = reviewCache[p.id]?.data;
    const qa = data?.qa;
    const list = `<div class="side-list">${ph.map((x) => `<a href="#review/${esc(x.id)}" class="${x.id === p.id ? 'on' : ''}" data-key="rv-${esc(x.id)}">${stIcon(PHASE_KIND[phaseStatus(x.id)])}<span class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span class="mono xs faint">${esc(x.id)}</span> ${esc(x.title)}</span>${S.state.phases?.[x.id]?.reviewed ? ic('check') : ''}</a>`).join('')}</div>`;
    let body;
    if (status === 'pending') body = empty('review', `${esc(p.id)} hasn't started yet.`);
    else if (!data) body = `<div class="card col"><div class="skeleton" style="width:40%"></div><div class="skeleton"></div><div class="skeleton" style="width:70%"></div></div>`;
    else {
      const files = data.files || [];
      const tests = qa?.manualTests || [];
      body = `
        <div class="grid g4" style="margin-bottom:20px">
          <div class="card tight"><div class="label">Status</div><div class="row" style="margin-top:4px">${stIcon(PHASE_KIND[status])}${PHASE_LABEL[status]}</div></div>
          <div class="card tight"><div class="label">QA</div><div style="margin-top:4px">${qa ? `<span class="badge ${qa.verdict === 'pass' ? 'green' : 'red'}">${esc(qa.verdict)}</span> <span class="small muted">round ${qa.round}</span>` : '<span class="muted small">no report yet</span>'}</div></div>
          <div class="card tight"><div class="label">Files changed</div><div style="margin-top:4px">${files.length} ${data.range ? `<span class="xs faint">${esc(data.range.to === 'working tree' ? 'so far' : '')}</span>` : ''}</div></div>
          <div class="card tight"><div class="label">Cost</div><div style="margin-top:4px">${money(data.cost)} <span class="xs faint">${data.sessions} sessions</span></div></div>
        </div>
        ${tests.length ? `<div class="card" style="margin-bottom:16px"><div class="card-head"><h3>How to test</h3>${S.hasRun ? `<a class="btn sm" href="#app">${ic('play')}Run app</a>` : ''}</div><div class="checklist">${tests.map((t, i) => `<label data-key="rt-${esc(p.id)}-${i}"><input type="checkbox"><span class="small">${esc(t)}</span></label>`).join('')}</div></div>` : ''}
        <div class="card" style="padding:0;margin-bottom:16px;overflow:hidden"><div class="card-head" style="padding:16px 20px 0"><h3>Files changed</h3>${data.range ? `<span class="mono xs faint">${esc(data.range.from)} → ${esc(data.range.to)}</span>` : ''}</div>
          ${!data.git ? '<div class="small muted" style="padding:0 20px 16px">Git checkpoints are off, so file changes are not tracked.</div>' : files.length ? `<table>${files.map((f) => {
            const open = ui.openDiff === `${p.id}|${f.path}`;
            const diff = diffCache[`${p.id}|${f.path}`];
            return `<tr class="link" data-diff="${esc(f.path)}" data-key="f-${esc(f.path)}"><td class="mono small">${ic(open ? 'chevron' : 'file')} ${esc(f.path)}${f.untracked ? ' <span class="badge">new</span>' : ''}</td><td class="num"><span class="add-n">${f.added != null ? '+' + f.added : ''}</span> <span class="rem-n">${f.removed != null ? '−' + f.removed : ''}</span></td></tr>${open ? `<tr data-key="fd-${esc(f.path)}"><td colspan="2" style="padding:0">${diff != null ? diffHtml(diff) : '<div class="small muted" style="padding:10px 12px">Loading diff…</div>'}</td></tr>` : ''}`;
          }).join('')}</table>` : '<div class="small muted" style="padding:0 20px 16px">No file changes recorded.</div>'}</div>
        ${qa ? `<div class="card" style="margin-bottom:16px"><div class="card-head"><h3>QA report</h3><a class="btn ghost sm" href="#docs" data-open-doc="qa/${esc(p.id)}-r${qa.round}.md">Full report</a></div><p class="small" style="margin:0 0 12px">${esc(qa.summary || '')}</p>
          ${(qa.checks || []).length ? `<table>${qa.checks.map((c) => `<tr><td>${stIcon(c.result === 'pass' ? 'done' : 'error')}</td><td class="small">${esc(c.criterion)}<div class="xs faint mono" style="margin-top:2px">${esc(c.evidence || '')}</div></td></tr>`).join('')}</table>` : ''}
          ${(qa.issues || []).length ? `<div class="label" style="margin:12px 0 6px">Issues</div>${qa.issues.map((i) => `<div class="small" style="padding:6px 0"><span class="badge ${i.severity === 'high' ? 'red' : i.severity === 'medium' ? 'amber' : ''}">${esc(i.severity || '')}</span> <b style="font-weight:500">${esc(i.title)}</b> → ${esc(agentName(i.agent))}</div>`).join('')}` : ''}</div>` : ''}
        ${(data.handoffs || []).length ? `<div class="card"><h3 style="margin-bottom:8px">Handoffs</h3><div class="list-rows">${data.handoffs.map((h) => `<div class="row nowrap" style="padding:8px 0;justify-content:space-between"><span class="small"><b style="font-weight:500">${esc(agentName(h.agent))}</b> <span class="muted">${esc(h.kind)}</span> ${esc(h.summary).slice(0, 140)}</span><a class="btn ghost xs" href="#docs" data-open-doc="${esc(h.path)}">Open</a></div>`).join('')}</div></div>` : ''}`;
    }
    const reviewed = ps.reviewed;
    return view(
      'review',
      `${pageHead(`<span class="mono muted" style="font-size:18px">${esc(p.id)}</span> ${esc(p.title)}`, esc(p.goal || ''), status === 'pending' ? '' : `${reviewed ? `<span class="badge green">${ic('check')}Reviewed ${ago(reviewed.at)}</span>` : `<button class="btn sm" data-act="review-phase" data-phase="${esc(p.id)}">${ic('check')}Looks good</button>`}<button class="btn primary sm" data-cto-ref="${esc(p.id)}" data-problem="1">${ic('flag')}Report a problem</button>`)}
      <div class="review-layout"><div>${list}</div><div style="min-width:0">${body}</div></div>`
    );
  }

  // ---------- run app ----------
  function consoleLine(l) {
    return `<div class="${l.stream === 'err' ? 'err' : l.stream === 'system' ? 'system' : ''}">${esc(l.text)}</div>`;
  }
  function ensureApp() {
    const key = `${S.app?.startedAt}-${S.app?.status}`;
    if (appKey === key) return;
    appKey = key;
    fetch('/api/app')
      .then((r) => r.json())
      .then((d) => {
        appLines = d.lines || [];
        const box = $('#console');
        if (box) {
          box.innerHTML = appLines.length ? appLines.map(consoleLine).join('') : '<div class="system">No output yet.</div>';
          box.scrollTop = box.scrollHeight;
        }
      });
  }
  // ---------- skills ----------
  const ownerOf = (repo) => String(repo || '').split('/')[0];
  const avatar = (repo, size = 36) => `<img src="https://github.com/${esc(ownerOf(repo))}.png?size=${size * 2}" alt="" width="${size}" height="${size}" style="border-radius:8px;flex:none;background:var(--bg-3)" loading="lazy" onerror="this.style.visibility='hidden'">`;
  const skillCatalog = () => S.skills?.catalog || [];
  const selectedSkills = () => S.skills?.selected || [];
  const skillName = (id) => skillCatalog().find((e) => e.id === id)?.name || selectedSkills().find((e) => e.id === id)?.name || id;
  const pendingSuggestions = () => (S.skills?.suggestions || []).filter((sg) => !selectedSkills().some((x) => x.id === sg.skill) && skillCatalog().some((e) => e.id === sg.skill));
  const devAgents = () => S.roster;
  function agentSkillChips(agentId) {
    const list = selectedSkills().filter((x) => x.agents?.includes(agentId));
    if (!list.length) return `<a class="small muted" href="#skills">None · add</a>`;
    return `<span class="row" style="gap:4px">${list.map((x) => `<a class="badge ${x.status === 'ready' ? '' : x.status === 'error' ? 'red' : 'blue'}" href="#skills" style="text-decoration:none">${esc(x.name)}</a>`).join('')}</span>`;
  }
  function skillWarnings() {
    const out = [];
    for (const a of devAgents()) {
      const mine = selectedSkills().filter((x) => x.agents?.includes(a.id));
      const design = mine.filter((x) => skillCatalog().find((e) => e.id === x.id)?.group === 'design');
      if (mine.length > 3) out.push(`${a.name || a.id} has ${mine.length} skills. More than 3 per agent costs tokens in every session and gives mixed direction.`);
      if (design.length > 1) out.push(`${a.name || a.id} has ${design.length} design skills (${design.map((x) => x.name).join(', ')}). They may give conflicting direction; one is usually better.`);
    }
    return out;
  }
  function agentPicker(key, chosen) {
    if (!devAgents().length) return '<span class="xs muted">Agents appear once the CTO hires the team.</span>';
    return `<span class="row" style="gap:6px">${devAgents().map((a) => `<button class="opt ${chosen.includes(a.id) ? 'on' : ''}" style="height:26px;font-size:12.5px;padding:0 10px" data-pick="${esc(key)}" data-agent="${esc(a.id)}">${esc(a.name || a.id)}</button>`).join('')}</span>`;
  }
  // Agent choices follow the catalog's recommendation until the user changes them.
  function fallbackFor(key) {
    const roster = devAgents().map((a) => a.id);
    return (skillCatalog().find((e) => e.id === key)?.recommendedFor || []).filter((id) => roster.includes(id));
  }
  function pickFor(key) {
    ui.skillPick ||= {};
    return ui.skillPick[key] || fallbackFor(key);
  }
  function skillsView() {
    const sel = selectedSkills();
    const roster = devAgents().map((a) => a.id);
    const sugg = pendingSuggestions();
    const warnings = skillWarnings();
    const statusLine = (x) =>
      x.status === 'ready'
        ? `${stIcon('done')}<span class="small">Ready · pinned to <span class="mono">${esc((x.sha || '').slice(0, 7))}</span> · ${x.files || 0} file${x.files === 1 ? '' : 's'}</span>`
        : x.status === 'error'
          ? `${stIcon('error')}<span class="small" style="color:var(--red)">${esc(x.error || 'Download failed')}</span>`
          : `${stIcon('running')}<span class="small muted">Downloading from GitHub…</span>`;
    const selectedHtml = sel.length
      ? `<div class="grid g2">${sel
          .map((x) => {
            const e = skillCatalog().find((c) => c.id === x.id) || {};
            const scripts = x.scripts?.length || 0;
            return `<div class="card" data-key="sk-${esc(x.id)}">
              <div class="row nowrap" style="gap:12px;align-items:flex-start">${avatar(x.repo)}<div class="grow"><div class="row"><b style="font-weight:500">${esc(x.name)}</b>${e.license ? `<span class="badge">${esc(e.license)}</span>` : ''}${scripts ? `<span class="badge amber" title="${esc(x.scripts.join(', '))}">${ic('alert')}${scripts} script${scripts > 1 ? 's' : ''}</span>` : ''}</div>
                <a class="xs muted mono" href="https://github.com/${esc(x.repo)}/tree/${esc(x.sha || 'HEAD')}/${esc(x.path || '')}" target="_blank" rel="noopener">${esc(x.repo)}${x.path ? '/' + esc(x.path) : ''}</a></div></div>
              <div class="row nowrap" style="margin:12px 0 10px;gap:8px">${statusLine(x)}</div>
              <div class="label" style="margin-bottom:6px">Used by</div>${roster.length ? `<span class="row" style="gap:6px">${devAgents().map((a) => `<button class="opt ${x.agents?.includes(a.id) ? 'on' : ''}" style="height:26px;font-size:12.5px;padding:0 10px" data-skill-agent="${esc(x.id)}" data-agent="${esc(a.id)}">${esc(a.name || a.id)}</button>`).join('')}</span>` : ''}
              <div class="row" style="margin-top:14px">${x.status === 'ready' ? `<button class="btn sm" data-skill-preview="${esc(x.id)}">${ic('eye')}Preview</button>` : ''}${x.status === 'error' ? `<button class="btn sm" data-skill-retry="${esc(x.id)}">${ic('refresh')}Retry</button>` : ''}<button class="btn ghost sm danger" data-skill-remove="${esc(x.id)}">Remove</button></div>
            </div>`;
          })
          .join('')}</div>`
      : `<div class="card muted small" style="text-align:center;padding:24px">No skills yet. The agents work fine without them; add one below if you want a specialist's guidance built in.</div>`;
    const suggHtml = sugg.length
      ? `<div class="section-title" style="margin-top:28px">Suggested by the CTO <button class="btn primary sm" data-act="skill-accept-suggestions">${ic('plus')}Add all</button></div><div class="col" style="gap:10px">${sugg
          .map((sg) => {
            const e = skillCatalog().find((c) => c.id === sg.skill);
            return `<div class="card tight" data-key="sg-${esc(sg.skill)}"><div class="row nowrap" style="gap:12px">${avatar(e.repo, 32)}<div class="grow"><div class="row"><b style="font-weight:500">${esc(e.name)}</b><span class="xs muted">for ${sg.agents.map((id) => esc(agentNameSafe(id))).join(', ') || 'no agent'}</span></div><div class="small muted">${esc(sg.reason)}</div></div><button class="btn sm" data-skill-add="${esc(sg.skill)}" data-agents="${esc(sg.agents.join(','))}" ${sg.agents.length ? '' : 'disabled'}>${ic('plus')}Add</button></div></div>`;
          })
          .join('')}</div>`
      : '';
    const catHtml = skillCatalog()
      .filter((e) => !e.custom)
      .map((e) => {
        const added = sel.some((x) => x.id === e.id);
        const chosen = pickFor(e.id);
        return `<div class="card" data-key="cat-${esc(e.id)}" style="display:flex;flex-direction:column">
          <div class="row nowrap" style="gap:12px;align-items:flex-start">${avatar(e.repo, 40)}<div class="grow"><b style="font-weight:500">${esc(e.name)}</b><div class="xs muted">${esc(e.author || ownerOf(e.repo))} · ${esc(e.category || '')}</div></div>${added ? `<span class="badge green">${ic('check')}Added</span>` : ''}</div>
          <p class="small muted" style="margin:12px 0;flex:1">${esc(e.description)}</p>
          <div class="row" style="gap:6px;margin-bottom:12px"><span class="badge">${esc(e.license)}</span>${e.group === 'design' ? '<span class="badge purple">Design</span>' : ''}${e.hasScripts ? `<span class="badge amber">${ic('alert')}Includes scripts</span>` : ''}<a class="badge" href="https://github.com/${esc(e.repo)}/tree/${esc(e.ref || 'main')}/${esc(e.path)}" target="_blank" rel="noopener" style="text-decoration:none">${ic('link')}GitHub</a></div>
          ${added ? '' : `<div class="label" style="margin-bottom:6px">Give it to</div>${agentPicker(e.id, chosen)}<div class="row" style="margin-top:12px"><button class="btn primary sm" data-skill-add="${esc(e.id)}" ${chosen.length ? '' : 'disabled'}>${ic('plus')}Add skill</button></div>`}
        </div>`;
      })
      .join('');
    const urlPick = pickFor('__url');
    return view(
      'skills',
      `${pageHead('Skills', 'Give agents expert skills from GitHub. Nothing is downloaded until you add a skill, and each one is pinned to the exact version you added. Changes apply from the next session.')}
      ${!roster.length ? `<div class="banner"><div class="grow small">Skills are given to agents, and the team is hired when the CTO writes the plan. You can browse the catalog now and add skills once the plan is ready.</div></div>` : ''}
      ${warnings.map((w) => `<div class="banner amber"><span>${ic('alert')}</span><div class="grow small">${esc(w)}</div></div>`).join('')}
      <div class="section-title">Selected for this project</div>${selectedHtml}
      ${suggHtml}
      <div class="section-title" style="margin-top:28px">Catalog</div><div class="grid g3">${catHtml}</div>
      <div class="card" style="margin-top:20px"><h3 style="margin-bottom:4px">Add a skill from GitHub</h3><p class="small muted" style="margin:0 0 12px">Paste a link to a folder that contains a SKILL.md, e.g. https://github.com/owner/repo/tree/main/skills/name. Only add skills from sources you trust: agents follow them unattended.</p>
        <div class="row nowrap"><input type="text" id="skill-url" placeholder="https://github.com/…" style="flex:1"><button class="btn primary" data-skill-url ${roster.length ? '' : 'disabled'}>Add</button></div>
        <div style="margin-top:10px">${agentPicker('__url', urlPick)}</div></div>`
    );
  }
  const agentNameSafe = (id) => (S.roster.find((a) => a.id === id)?.name || id);

  async function skillPreview(id) {
    const d = $('#dialog');
    $('#dialog-form').innerHTML = '<div class="col"><div class="skeleton" style="width:40%"></div><div class="skeleton"></div></div>';
    d.style.maxWidth = '820px';
    d.onclose = () => (d.style.maxWidth = '');
    d.showModal();
    try {
      const r = await fetch(`/api/skill?id=${encodeURIComponent(id)}`);
      const p = await r.json();
      if (!r.ok) throw new Error(p.error);
      $('#dialog-form').innerHTML = `<div class="row nowrap" style="justify-content:space-between;gap:12px"><div class="row nowrap" style="gap:12px">${avatar(p.repo)}<div><h2>${esc(skillName(id))}</h2><div class="xs muted mono">${esc(p.repo)}/${esc(p.path)} @ ${esc(p.sha.slice(0, 7))}</div></div></div><button class="btn ghost icon" value="close">${ic('x')}</button></div>
        ${p.scripts.length ? `<div class="banner amber" style="margin:16px 0 0"><span>${ic('alert')}</span><div class="grow small"><b>This skill includes ${p.scripts.length} script${p.scripts.length > 1 ? 's' : ''}</b> that agents may run: ${p.scripts.map(esc).join(', ')}</div></div>` : ''}
        <details style="margin:14px 0"><summary class="small">${p.files.length} file${p.files.length > 1 ? 's' : ''} · ${Math.round(p.bytes / 1024)} KB</summary><div class="mono xs muted" style="margin-top:8px;max-height:140px;overflow:auto">${p.files.map(esc).join('<br>')}</div></details>
        <div class="card flat" style="max-height:55vh;overflow:auto">${md(p.skillMd.replace(/^---[\s\S]*?---\s*/, ''))}</div>`;
    } catch (e) {
      $('#dialog-form').innerHTML = `<p style="color:var(--red)">${esc(e.message)}</p><div class="row" style="justify-content:flex-end"><button class="btn" value="close">Close</button></div>`;
    }
  }

  function appView() {
    const a = S.app || {};
    const running = a.status === 'running';
    const kind = running ? (a.ready ? 'done' : 'running') : a.status === 'exited' && a.code ? 'error' : 'pending';
    const label = running ? (a.ready ? 'Running' : 'Starting…') : a.status === 'exited' ? `Exited${a.code != null ? ` (code ${a.code})` : ''}` : 'Stopped';
    return view(
      'app',
      `${pageHead('Run app', 'Start the product the team is building and try it yourself between phases.', `${running ? `<button class="btn sm" data-act="app-stop">${ic('stop')}Stop</button><button class="btn sm" data-restart>${ic('refresh')}Restart</button>` : `<button class="btn primary sm" data-act="app-start" ${a.configured ? '' : 'disabled'}>${ic('play')}Start</button>`}${a.url ? `<a class="btn sm" href="${esc(a.url)}" target="_blank" rel="noopener">${ic('ext')}Open</a>` : ''}`)}
      ${!a.configured ? `<div class="banner amber"><div class="grow small">There is no start command yet. The CTO writes <code>.yourteam/run.json</code> during planning; you can also create it in Docs, e.g. <code>{"command": "npm run dev", "url": "http://localhost:3000"}</code>.</div></div>` : ''}
      <div class="grid g4" style="margin-bottom:16px">
        <div class="card tight"><div class="label">Status</div><div class="row" style="margin-top:4px">${stIcon(kind)}${esc(label)}</div></div>
        <div class="card tight" style="grid-column:span 2"><div class="label">Command</div><div class="mono small" style="margin-top:4px">${esc(a.command || '—')}</div></div>
        <div class="card tight"><div class="label">URL</div><div class="small" style="margin-top:4px">${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.url)}</a>` : '—'}</div></div>
      </div>
      <div class="console" id="console" data-static data-key="console-${esc(a.startedAt || 'none')}">${appLines.length ? appLines.map(consoleLine).join('') : '<div class="system">No output yet.</div>'}</div>
      <p class="xs faint" style="margin-top:10px">QA stops the app automatically when it runs, since it needs the same ports. Edit the command in Docs → run.json.</p>`
    );
  }

  // ---------- agents ----------
  function agentStats(id) {
    const ss = S.sessions.filter((s) => s.agent === id);
    return { n: ss.length, cost: ss.reduce((a, s) => a + (s.costUsd || 0), 0), tokens: ss.reduce((a, s) => a + (s.tokens?.input || 0) + (s.tokens?.output || 0) + (s.tokens?.cacheRead || 0) + (s.tokens?.cacheWrite || 0), 0), peak: Math.max(0, ...ss.map((s) => pct(s.peakContextTokens, s.contextWindow))) };
  }
  function agents() {
    const all = [...S.core.map((a) => ({ ...a, core: true })), ...S.roster];
    const models = ['opus', 'sonnet', 'haiku', 'fable'];
    return view(
      'agents',
      `${pageHead('Agents', 'The team for this project. CEO and CTO are always present; the CTO hires the rest. Change a model here, or edit role files in Docs.')}
      <div class="grid g3">${all
        .map((a) => {
          const s = agentStats(a.id);
          const working = S.active?.agent === a.id || S.chatActive?.agent === a.id;
          const model = a.core ? a.model : S.config.models?.[a.id] || a.model || S.config.models?.default;
          const desc = a.description || (a.id === 'ceo' ? 'Interviews you and writes the spec.' : a.id === 'cto' ? 'Architecture, team, plan, CTO chat and the retro.' : '');
          return `<div class="card" data-key="ag-${esc(a.id)}">
            <div class="row nowrap" style="justify-content:space-between"><div class="row nowrap" style="gap:10px"><span class="av ${a.id === 'ceo' ? 'ceo' : a.id === 'cto' ? 'cto' : ''}" style="width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-size:10px;font-weight:700;border:1px solid var(--border-2);${a.id === 'ceo' ? 'background:linear-gradient(135deg,#ff9a3c,#ff4d8d);color:#fff;border:0' : a.id === 'cto' ? 'background:linear-gradient(135deg,#3291ff,#7c3aed);color:#fff;border:0' : ''}">${esc(a.id.slice(0, 3).toUpperCase())}</span><div><b style="font-weight:500">${esc(a.name || a.id)}</b><div class="xs faint mono">${esc(a.id)}</div></div></div>${working ? `<span class="badge blue"><span class="dot blue pulse"></span>working</span>` : '<span class="badge">idle</span>'}</div>
            <p class="small muted" style="margin:10px 0 14px;min-height:38px">${esc(desc)}</p>
            <dl class="kv"><dt>Model</dt><dd><select data-model="${esc(a.id)}" style="height:28px;padding:0 8px">${[...new Set([model, ...models])].map((m) => `<option ${m === model ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></dd>
            ${a.core ? '' : `<dt>Skills</dt><dd>${agentSkillChips(a.id)}</dd>`}<dt>Sessions</dt><dd>${s.n}</dd><dt>Cost</dt><dd>${money(s.cost)}</dd><dt>Tokens</dt><dd>${tok(s.tokens)}</dd><dt>Peak context</dt><dd>${ctxBar(s.peak, 100, 90)}</dd></dl>
            <div class="row" style="margin-top:14px">${!a.core || a.id === 'cto' ? `<a class="btn sm" href="#docs" data-open-doc="agents/${esc(a.id)}.md">Role file</a>` : ''}${!a.core ? `<button class="btn ghost sm" data-msg-to="${esc(a.id)}">Message</button>` : ''}${a.id === 'cto' ? `<a class="btn ghost sm" href="#cto">Chat</a>` : ''}${a.id === 'ceo' ? `<a class="btn ghost sm" href="#interview">Interview</a>` : ''}</div>
          </div>`;
        })
        .join('')}</div>`
    );
  }

  // ---------- live sessions ----------
  // Re-fetched when the session's status changes, so a finished session always shows its full log.
  const logStatus = {};
  function ensureLog() {
    const id = ui.session;
    if (!id) return;
    const status = S.sessions.find((x) => x.id === id)?.status;
    if (logCache[id] !== undefined && logStatus[id] === status) return;
    logStatus[id] = status;
    if (logCache[id] === undefined) logCache[id] = null;
    fetch(`/api/session/${id}`)
      .then((r) => r.json())
      .then((d) => {
        logCache[id] = d.entries || [];
        const el = $('#log');
        if (el && el.dataset.key === `log-${id}`) {
          el.innerHTML = logCache[id].length ? logCache[id].map(entryHtml).join('') : '<div class="muted small">No output yet.</div>';
          el.scrollTop = el.scrollHeight;
        }
      });
  }
  function entryHtml(e) {
    if (e.t === 'tool') return `<div class="e tool"><b>${esc(e.name)}</b> ${esc(e.text)}</div>`;
    if (e.t === 'tool_result') return `<div class="e tool_result ${e.isError ? 'err' : ''}">${esc(e.text) || '(no output)'}</div>`;
    if (e.t === 'result') return `<div class="e result ${e.isError ? 'err' : ''}"><b>Finished${e.cost != null ? ' · ' + money(e.cost) : ''}</b>\n${esc(e.text)}</div>`;
    if (e.t === 'init') return `<div class="e tool_result">${esc(e.text)}</div>`;
    return `<div class="e">${esc(e.text)}</div>`;
  }
  function liveView() {
    const list = [...S.sessions].reverse();
    if (ui.followLive && S.active) ui.session = S.active.id;
    if (!list.some((s) => s.id === ui.session)) ui.session = list[0]?.id || null;
    const sel = list.find((s) => s.id === ui.session);
    const cached = sel && Array.isArray(logCache[sel.id]) ? logCache[sel.id] : null;
    const header = sel
      ? `<div class="row nowrap" style="justify-content:space-between;gap:12px"><div class="row nowrap" style="gap:10px;min-width:0">${stIcon(sel.status === 'running' ? 'running' : sel.status === 'done' ? 'done' : sel.status === 'failed' ? 'error' : 'waiting')}<b style="font-weight:500">${esc(agentName(sel.agent))}</b><span class="muted small">${esc(sel.kind)}${sel.phase ? ' · ' + esc(sel.phase) : ''} · ${esc(sel.model || '')}</span></div><span class="mono xs faint">${esc(sel.id.slice(0, 8))}</span></div>
        <div class="row small muted" style="margin:8px 0;gap:14px">${ctxBar(sel.contextTokens, sel.contextWindow, 120)}<span>Peak ${pct(sel.peakContextTokens, sel.contextWindow)}%</span>${sel.skills?.length ? `<span>${ic('skills')} ${sel.skills.map((id) => esc(skillName(id))).join(', ')}</span>` : ''}<span>${sel.toolCalls || 0} tools</span><span>${sel.turns || 0} turns</span><span>${money(sel.costUsd)}</span><span>${dur(sel.durationMs || (sel.status === 'running' ? Date.now() - Date.parse(sel.startedAt) : 0))}</span></div>
        ${sel.summary ? `<div class="small" style="margin-bottom:8px"><b style="font-weight:500">Report (${esc(sel.reportStatus)}):</b> ${esc(sel.summary)}</div>` : ''}
        ${sel.error ? `<div class="small" style="color:var(--red);white-space:pre-wrap;margin-bottom:8px">${esc(sel.error.slice(0, 600))}</div>` : ''}
        <div class="row" style="margin-bottom:10px">${sel.handoffPath ? `<a class="btn ghost xs" href="#docs" data-open-doc="${esc(sel.handoffPath.replace(/^\.yourteam\//, ''))}">Handoff</a>` : ''}${sel.reportPath ? `<a class="btn ghost xs" href="#docs" data-open-doc="${esc(sel.reportPath.replace(/^\.yourteam\//, ''))}">Report</a>` : ''}</div>`
      : '';
    return view(
      'live',
      `${pageHead('Live sessions', 'Every agent session runs in a fresh context. Pick one to see what it did.', `<label class="check small muted"><input type="checkbox" id="follow" ${ui.followLive ? 'checked' : ''}> Follow the running session</label>`)}
      ${list.length ? `<div class="split"><div class="col scroll" style="gap:8px">${list
        .map((s) => {
          const c = pct(s.peakContextTokens, s.contextWindow);
          return `<div class="card tight link ${ui.session === s.id ? 'sel' : ''}" data-session="${s.id}" data-key="s-${s.id}"><div class="row nowrap" style="justify-content:space-between"><div class="row nowrap" style="gap:8px">${stIcon(s.status === 'running' ? 'running' : s.status === 'done' ? 'done' : s.status === 'failed' ? 'error' : 'waiting')}<b style="font-weight:500">${esc(agentName(s.agent))}</b></div><span class="xs faint">${ago(s.startedAt)}</span></div><div class="row nowrap xs muted" style="justify-content:space-between;margin-top:6px"><span>${esc(s.kind)}${s.phase ? ' · ' + esc(s.phase) : ''} · ${money(s.costUsd)}</span>${ctxBar(c, 100, 40)}</div></div>`;
        })
        .join('')}</div>
        <div class="card col" style="min-height:0;gap:0">${header}<div class="log" id="log" data-static data-key="log-${esc(sel?.id || '')}">${cached ? (cached.length ? cached.map(entryHtml).join('') : '<div class="muted small">No output yet.</div>') : '<div class="col"><div class="skeleton"></div><div class="skeleton" style="width:60%"></div></div>'}</div></div></div>` : empty('activity', 'No sessions yet.')}`,
      true
    );
  }

  // ---------- messages ----------
  function messages() {
    const ids = [...new Set(S.messages.flatMap((m) => [m.from, m.to]))];
    const f = ui.msgFilter;
    const list = S.messages.filter((m) => f === 'all' || m.from === f || m.to === f).reverse();
    const types = { 'bug-report': 'red', 'api-change': 'blue', 'fix-done': 'green', question: 'amber', info: '' };
    return view(
      'messages',
      `${pageHead('Agent messages', 'How agents pass API changes, bug reports and fixes to each other. Each message is delivered to the next fresh session of its recipient.', `<select id="msg-filter" style="width:auto;height:32px"><option value="all">All agents</option>${ids.map((id) => `<option value="${esc(id)}" ${f === id ? 'selected' : ''}>${esc(agentName(id))}</option>`).join('')}</select>`)}
      <div class="card" style="margin-bottom:20px"><div class="row nowrap" style="align-items:flex-end"><label class="field" style="width:200px">To<select id="msg-to">${S.roster.map((a) => `<option value="${esc(a.id)}">${esc(a.name || a.id)}</option>`).join('')}</select></label><label class="field grow">Message<input type="text" id="msg-text" placeholder="Delivered at the start of its next session"></label><button class="btn primary" data-send-msg>Send</button></div></div>
      ${list.length ? `<div class="table-wrap"><table><tr><th>When</th><th>From → To</th><th>Type</th><th>Phase</th><th>Message</th><th>Read</th></tr>${list.map((m) => `<tr data-key="m-${m.id}"><td class="xs faint" style="white-space:nowrap">${ago(m.ts)}</td><td class="small" style="white-space:nowrap"><b style="font-weight:500">${esc(agentName(m.from))}</b> → ${esc(m.to === 'all' ? 'everyone' : agentName(m.to))}</td><td><span class="badge ${types[m.type] || ''}">${esc(m.type)}</span></td><td class="mono xs">${esc(m.phase || '')}</td><td class="small" style="white-space:pre-wrap">${esc(m.text)}</td><td class="xs faint">${m.readBy?.length ? 'yes' : 'not yet'}</td></tr>`).join('')}</table></div>` : empty('messages', 'No messages yet.')}`
    );
  }

  // ---------- usage ----------
  function hbars(obj, label, name) {
    const rows = Object.entries(obj).sort((a, b) => b[1].costUsd - a[1].costUsd);
    const max = Math.max(0.0001, ...rows.map((r) => r[1].costUsd));
    return `<div class="card"><h3 style="margin-bottom:14px">${label}</h3>${rows.length ? rows.map(([k, v]) => `<div class="hbar"><span title="${esc(k)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name(k))}</span><span class="track"><i style="width:${pct(v.costUsd, max)}%"></i></span><span class="num small" style="text-align:right">${money(v.costUsd)}</span></div>`).join('') : '<div class="muted small">No data yet.</div>'}</div>`;
  }
  function usage() {
    const t = S.state.totals || {};
    const ss = [...S.sessions].reverse();
    const budget = S.config.budget?.totalUsd;
    const avgPeak = ss.length ? Math.round(ss.reduce((a, s) => a + pct(s.peakContextTokens, s.contextWindow), 0) / ss.length) : 0;
    const cacheRead = ss.reduce((a, s) => a + (s.tokens?.cacheRead || 0), 0);
    const kpi = (v, l, extra = '') => `<div class="card"><div class="label">${l}</div><div style="font-size:24px;font-weight:600;letter-spacing:-.02em;margin-top:6px">${v}</div>${extra}</div>`;
    return view(
      'usage',
      `${pageHead('Usage', 'Tokens, cost and context per agent, phase and session. Peak context shows how full each fresh session got.')}
      <div class="grid g4" style="margin-bottom:20px">
        ${kpi(money(t.costUsd), `Total spend${budget ? ` of ${money(budget)}` : ''}`, budget ? `<div class="bar ${pct(t.costUsd, budget) > 85 ? 'bad' : 'blue'}" style="margin-top:10px"><i style="width:${pct(t.costUsd, budget)}%"></i></div>` : '')}
        ${kpi(tok(t.inputTokens), 'Input tokens', `<div class="xs faint" style="margin-top:4px">${tok(cacheRead)} from cache</div>`)}
        ${kpi(tok(t.outputTokens), 'Output tokens')}
        ${kpi(avgPeak + '%', 'Average peak context')}
      </div>
      <div class="grid g3" style="margin-bottom:20px">${hbars(S.usage.byAgent, 'Cost by agent', agentName)}${hbars(S.usage.byPhase, 'Cost by phase', (k) => (k === '-' || k === 'null' ? 'Interview, plan, chat' : k))}${hbars(S.usage.byKind, 'Cost by session type', (k) => k)}</div>
      <div class="section-title">Sessions</div>
      ${ss.length ? `<div class="table-wrap"><table><tr><th>Started</th><th>Agent</th><th>Type</th><th>Phase</th><th>Model</th><th class="num">Input</th><th class="num">Cached</th><th class="num">Output</th><th>Peak context</th><th class="num">Tools</th><th class="num">Time</th><th class="num">Cost</th><th>Status</th></tr>${ss
        .map((s) => `<tr class="link" data-session-open="${s.id}" data-key="u-${s.id}"><td class="xs faint" style="white-space:nowrap">${ago(s.startedAt)}</td><td class="small">${esc(agentName(s.agent))}</td><td class="small">${esc(s.kind)}</td><td class="mono xs">${esc(s.phase || '')}</td><td class="xs muted">${esc(s.model || '')}</td><td class="num small">${tok(s.tokens?.input)}</td><td class="num small">${tok(s.tokens?.cacheRead)}</td><td class="num small">${tok(s.tokens?.output)}</td><td>${ctxBar(s.peakContextTokens, s.contextWindow, 60)}</td><td class="num small">${s.toolCalls || 0}</td><td class="num small">${dur(s.durationMs)}</td><td class="num small">${money(s.costUsd)}</td><td>${stIcon(s.status === 'done' ? 'done' : s.status === 'running' ? 'running' : s.status === 'failed' ? 'error' : 'waiting', s.status)}</td></tr>`)
        .join('')}</table></div>` : empty('usage', 'No sessions yet.')}`
    );
  }

  // ---------- QA ----------
  function ensureQa() {
    for (const f of S.docs.filter((d) => /^qa\/.+\.json$/.test(d.path))) {
      if (qaCache[f.path]?.mtime === f.mtime) continue;
      qaCache[f.path] = { mtime: f.mtime, data: null };
      fetch(`/api/doc?path=${encodeURIComponent(f.path)}`)
        .then((r) => r.json())
        .then((d) => {
          try {
            qaCache[f.path].data = JSON.parse(d.content);
          } catch {
            qaCache[f.path].data = { verdict: 'invalid', summary: 'Report is not valid JSON' };
          }
          if (ui.view === 'qa') render();
        });
    }
  }
  function qa() {
    const files = S.docs.filter((d) => /^qa\/.+\.json$/.test(d.path)).sort((a, b) => b.mtime - a.mtime);
    return view(
      'qa',
      `${pageHead('QA reports', 'Every phase ends with a QA session that runs the software and checks the criteria.')}
      ${files.length ? `<div class="col">${files
        .map((f) => {
          const d = qaCache[f.path]?.data;
          const m = f.path.match(/qa\/(.+)-r(\d+)\.json$/);
          if (!d) return `<div class="card col" data-key="qa-${esc(f.path)}"><div class="skeleton" style="width:30%"></div><div class="skeleton"></div></div>`;
          return `<div class="card" data-key="qa-${esc(f.path)}"><div class="row nowrap" style="justify-content:space-between"><div class="row">${stIcon(d.verdict === 'pass' ? 'done' : 'error')}<b style="font-weight:500">${esc(m?.[1] || '')}</b><span class="muted small">round ${esc(m?.[2] || '')}</span><span class="badge ${d.verdict === 'pass' ? 'green' : 'red'}">${esc(d.verdict)}</span></div><div class="row"><span class="xs faint">${ago(f.mtime)}</span><a class="btn ghost xs" href="#review/${esc(m?.[1] || '')}">Review</a><a class="btn ghost xs" href="#docs" data-open-doc="${esc(f.path.replace(/\.json$/, '.md'))}">Full report</a></div></div>
            <p class="small" style="margin:10px 0">${esc(d.summary || '')}</p>
            ${(d.checks || []).length ? `<table>${d.checks.map((c) => `<tr><td style="width:28px">${stIcon(c.result === 'pass' ? 'done' : 'error')}</td><td class="small">${esc(c.criterion)}</td><td class="mono xs faint" style="white-space:pre-wrap">${esc(c.evidence || '')}</td></tr>`).join('')}</table>` : ''}
            ${(d.issues || []).length ? `<div class="label" style="margin:12px 0 6px">Issues</div>${d.issues.map((i) => `<div class="small" style="padding:4px 0"><span class="badge ${i.severity === 'high' ? 'red' : i.severity === 'medium' ? 'amber' : ''}">${esc(i.severity || '')}</span> <b style="font-weight:500">${esc(i.title)}</b> → ${esc(agentName(i.agent))}<div class="xs muted" style="white-space:pre-wrap;margin-top:2px">${esc(i.details || '')}</div></div>`).join('')}` : ''}</div>`;
        })
        .join('')}</div>` : empty('qa', 'No QA reports yet.')}`
    );
  }

  // ---------- docs ----------
  function ensureDoc(p) {
    const meta = S.docs.find((d) => d.path === p);
    const mtime = meta?.mtime || 0;
    if (docCache[p] && docCache[p].mtime === mtime) return;
    docCache[p] = { content: docCache[p]?.content ?? null, mtime };
    fetch(`/api/doc?path=${encodeURIComponent(p)}`)
      .then((r) => r.json())
      .then((d) => {
        docCache[p].content = d.content ?? '';
        if (ui.view === 'docs' && !ui.editing) render();
      });
  }
  function docs() {
    const groups = {};
    for (const d of S.docs) {
      const dir = d.path.includes('/') ? d.path.split('/')[0] : '';
      (groups[dir] ||= []).push(d);
    }
    const order = ['', 'agents', 'contracts', 'decisions', 'handoffs', 'reports', 'qa'];
    const dirs = [...new Set([...order, ...Object.keys(groups)])].filter((k) => groups[k]);
    const tree = dirs.map((k) => `<div class="dir">${esc(k || 'project')}</div>${groups[k].map((d) => `<a href="#docs" data-open-doc="${esc(d.path)}" class="${ui.doc === d.path ? 'on' : ''}" data-key="doc-${esc(d.path)}">${esc(k ? d.path.slice(k.length + 1) : d.path)}</a>`).join('')}`).join('');
    let pane = empty('docs', 'Pick a document.');
    if (ui.doc) {
      const c = docCache[ui.doc]?.content;
      let body;
      if (c == null) body = '<div class="col"><div class="skeleton" style="width:40%"></div><div class="skeleton"></div><div class="skeleton" style="width:80%"></div></div>';
      else if (ui.doc.endsWith('.json')) {
        try {
          body = `<pre>${esc(JSON.stringify(JSON.parse(c), null, 2))}</pre>`;
        } catch {
          body = `<pre>${esc(c)}</pre>`;
        }
      } else if (ui.doc.endsWith('.md')) body = md(c);
      else body = `<pre>${esc(c)}</pre>`;
      pane = `<div class="row nowrap" style="justify-content:space-between;margin-bottom:14px"><b class="mono small">${esc(ui.doc)}</b><button class="btn sm" data-doc-edit ${c == null ? 'disabled' : ''}>Edit</button></div><div class="scroll" style="flex:1">${body || '<div class="muted">(empty)</div>'}</div>`;
    }
    return view(
      'docs',
      `${pageHead('Docs', 'The team’s shared memory in .yourteam/. Every fresh session reads from here. You can edit any file.')}
      <div class="split"><div class="card tree scroll" style="padding:8px">${tree || '<div class="muted small" style="padding:8px">No documents yet.</div>'}</div><div class="card col" style="min-height:0;gap:0" id="doc-pane" data-key="pane-${esc(ui.doc || '')}">${pane}</div></div>`,
      true
    );
  }
  function editDoc() {
    ui.editing = true;
    $('#doc-pane').innerHTML = `<div class="row nowrap" style="justify-content:space-between;margin-bottom:12px"><b class="mono small">Editing ${esc(ui.doc)}</b><div class="row"><button class="btn sm" data-doc-cancel>Cancel</button><button class="btn primary sm" data-doc-save>Save</button></div></div><textarea class="code" id="doc-text">${esc(docCache[ui.doc]?.content || '')}</textarea>`;
  }

  // ---------- timeline ----------
  function timeline() {
    return view(
      'timeline',
      `${pageHead('Timeline', `Everything the orchestrator did, newest first${S.git ? ', plus git checkpoints for each phase' : ''}.`)}
      <div class="grid g2"><div class="card" style="padding:4px 20px">${eventsList([...S.events].reverse())}</div>
      ${S.git ? `<div class="card" style="padding:0"><div style="padding:16px 20px 4px"><h3>Git checkpoints</h3></div><table>${S.git.map((c) => `<tr data-key="g-${esc(c.hash)}"><td class="mono small">${esc(c.hash)}</td><td class="small">${esc(c.subject)}<div class="xs faint">${esc(c.refs)}</div></td><td class="xs faint" style="white-space:nowrap">${ago(c.date)}</td></tr>`).join('')}</table></div>` : ''}</div>`
    );
  }

  // ---------- settings ----------
  function settings() {
    const c = S.config;
    const models = ['opus', 'sonnet', 'haiku', 'fable'];
    const sel = (key, val, opts) => `<select data-cfg="${key}">${[...new Set([val, ...opts])].filter((v) => v !== undefined).map((o) => `<option value="${esc(o ?? '')}" ${o === val ? 'selected' : ''}>${esc(o ?? '(default)')}</option>`).join('')}</select>`;
    const num = (key, val, step = 1) => `<input type="number" step="${step}" min="0" data-cfg="${key}" value="${val ?? ''}" placeholder="none">`;
    const chk = (key, val, label) => `<label class="check"><input type="checkbox" data-cfg="${key}" ${val ? 'checked' : ''}> <span>${label}</span></label>`;
    return view(
      'settings',
      `${pageHead('Settings', 'Saved to .yourteam/config.json and used from the next session on.', '<button class="btn primary" data-cfg-save>Save settings</button>')}
      <div class="grid g2">
        <div class="card col"><h3>Models</h3>
          <label class="field">CEO ${sel('models.ceo', c.models.ceo, models)}</label>
          <label class="field">CTO (planning) ${sel('models.cto', c.models.cto, models)}</label>
          <label class="field">CTO chat ${sel('models.ctoChat', c.models.ctoChat, models)}</label>
          <label class="field">QA ${sel('models.qa', c.models.qa, models)}</label>
          <label class="field">Default for hired agents (unless the roster sets one) ${sel('models.default', c.models.default, models)}</label>
          <label class="field">Effort ${sel('claude.effort', c.claude.effort, [null, 'low', 'medium', 'high', 'xhigh', 'max'])}</label></div>
        <div class="card col"><h3>Budget and limits</h3>
          <label class="field">Max spend per session (USD) ${num('budget.perSessionUsd', c.budget.perSessionUsd, 0.5)}</label>
          <label class="field">Total budget (USD); pauses when reached ${num('budget.totalUsd', c.budget.totalUsd, 1)}</label>
          <label class="field">Continuation sessions per step ${num('limits.maxContinuations', c.limits.maxContinuations)}</label>
          <label class="field">Bug-fix rounds per phase ${num('limits.maxFixRounds', c.limits.maxFixRounds)}</label>
          <label class="field">QA rounds before asking you ${num('limits.maxQaRounds', c.limits.maxQaRounds)}</label></div>
        <div class="card col"><h3>Approvals</h3>
          ${chk('approval.spec', c.approval.spec, 'Approve the spec before planning')}
          ${chk('approval.plan', c.approval.plan, 'Approve the plan and team before building')}
          <div class="small muted">Whether to stop before a phase starts is set per phase with the Auto-run switch in the Plan tab.</div></div>
        <div class="card col"><h3>Permissions and tools</h3>
          <label class="field">Permission mode ${sel('permissions.mode', c.permissions.mode, ['acceptEdits', 'dontAsk', 'auto'])}</label>
          ${chk('permissions.skipAll', c.permissions.skipAll, '<b>Skip all permission checks</b> (only in a sandbox or VM)')}
          ${chk('claude.loadMcp', c.claude.loadMcp, 'Load my MCP servers in agent sessions (uses more tokens)')}
          ${chk('claude.disableSkills', c.claude.disableSkills, 'Disable skills in agent sessions')}
          ${chk('git.enabled', c.git.enabled, 'Git checkpoint per phase (enables review diffs and rollback)')}
          ${chk('retro', c.retro, 'Write a retrospective and save lessons at the end')}
          <label class="field">Claude CLI path (blank = auto-detect) <input type="text" data-cfg="claude.bin" value="${esc(c.claude.bin || '')}"></label></div>
      </div>`
    );
  }

  // ---------- command menu ----------
  function cmdItems() {
    const items = [];
    for (const [id, icon, label] of NAV.flat()) items.push({ group: 'Go to', label, icon, run: () => go(id) });
    for (const p of phases()) items.push({ group: 'Phases', label: `${p.id} ${p.title}`, icon: 'plan', hint: PHASE_LABEL[phaseStatus(p.id)], run: () => (phaseStatus(p.id) === 'pending' ? ((ui.phase = p.id), go('plan')) : go('review', p.id)) });
    const st = S?.state.status;
    if (['running', 'planning', 'replanning', 'finishing'].includes(st)) items.push({ group: 'Actions', label: 'Pause after the current session', icon: 'pause', run: () => act('pause') });
    if (['paused', 'error', 'escalated'].includes(st)) items.push({ group: 'Actions', label: 'Resume', icon: 'play', run: () => act('resume') });
    if (S?.hasRun) items.push({ group: 'Actions', label: S.app?.status === 'running' ? 'Stop the app' : 'Run the app', icon: 'play', run: () => act(S.app?.status === 'running' ? 'app-stop' : 'app-start') });
    if (CTO_OK.includes(st)) items.push({ group: 'Actions', label: 'New CTO thread', icon: 'cto', run: () => act('cto-new-thread').then(() => go('cto')) });
    items.push({ group: 'Actions', label: 'Toggle theme', icon: 'sun', run: cycleTheme });
    for (const d of S?.docs || []) items.push({ group: 'Docs', label: d.path, icon: 'file', run: () => ((ui.doc = d.path), go('docs')) });
    return items;
  }
  function renderCmd() {
    const box = $('#cmdk');
    if (!ui.cmdOpen) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    const q = ($('#cmdk-input')?.value || '').toLowerCase();
    const items = cmdItems().filter((x) => !q || x.label.toLowerCase().includes(q) || x.group.toLowerCase().includes(q));
    ui.cmdList = items;
    ui.cmdIdx = Math.min(ui.cmdIdx, Math.max(0, items.length - 1));
    let html = '';
    let group = '';
    items.slice(0, 60).forEach((x, i) => {
      if (x.group !== group) html += `<div class="cmdk-group">${esc((group = x.group))}</div>`;
      html += `<div class="cmdk-item ${i === ui.cmdIdx ? 'on' : ''}" data-cmd-i="${i}">${ic(x.icon)}<span>${esc(x.label)}</span>${x.hint ? `<span class="faint">${esc(x.hint)}</span>` : ''}</div>`;
    });
    if (box.hidden) {
      box.innerHTML = `<div class="cmdk-box"><input id="cmdk-input" type="text" placeholder="Search views, phases, docs and actions…" autocomplete="off"><div class="cmdk-list" id="cmdk-list"></div></div>`;
      box.hidden = false;
      $('#cmdk-input').focus();
    }
    $('#cmdk-list').innerHTML = html || '<div class="cmdk-group">No results</div>';
    $('#cmdk-list .on')?.scrollIntoView({ block: 'nearest' });
  }
  function openCmd() {
    ui.cmdOpen = true;
    ui.cmdIdx = 0;
    renderCmd();
  }
  function closeCmd() {
    ui.cmdOpen = false;
    renderCmd();
  }
  function runCmd(i) {
    const x = ui.cmdList?.[i];
    closeCmd();
    if (x) x.run();
  }

  function cycleTheme() {
    const t = document.documentElement.dataset.theme;
    const next = !t ? 'dark' : t === 'dark' ? 'light' : null;
    if (next) document.documentElement.dataset.theme = next;
    else delete document.documentElement.dataset.theme;
    store.set('yt-theme', next);
    toast(`Theme: ${next || 'system'}`);
    render();
  }

  // ---------- mentions (#Q in interview, @ in CTO chat) ----------
  function mentionItems(target, query) {
    const q = query.toLowerCase();
    if (target === 'chat-input') {
      const answered = answeredQuestions();
      return S.chat
        .flatMap((m) => m.questions || [])
        .filter((x) => !answered.has(x.id))
        .filter((x) => !q || x.id.toLowerCase().includes(q) || x.text.toLowerCase().includes(q))
        .slice(-8)
        .map((x) => ({ label: x.text, hint: x.id, insert: `#${x.id} `, icon: `<span class="qid">${esc(x.id)}</span>` }));
    }
    const items = [
      ...phases().map((p) => ({ label: `${p.id} ${p.title}`, hint: PHASE_LABEL[phaseStatus(p.id)], insert: `@${p.id} ` })),
      ...S.roster.map((a) => ({ label: a.name || a.id, hint: 'agent', insert: `@${a.id} ` })),
    ];
    return items.filter((x) => !q || x.label.toLowerCase().includes(q) || x.insert.toLowerCase().includes(q)).slice(0, 8);
  }
  function updateMention(el) {
    const trigger = el.id === 'chat-input' ? '#' : el.id === 'cto-input' ? '@' : null;
    if (!trigger) return;
    const before = el.value.slice(0, el.selectionStart);
    const m = before.match(new RegExp(`(^|\\s)\\${trigger}([\\w-]*)$`));
    const prev = ui.mention;
    if (m) {
      const items = mentionItems(el.id, m[2]);
      ui.mention = items.length ? { target: el.id, items, idx: 0, start: before.length - m[2].length - 1 } : null;
    } else ui.mention = null;
    if (prev || ui.mention) render();
  }
  function applyMention(insert) {
    const m = ui.mention;
    const el = m && document.getElementById(m.target);
    if (!el) return;
    const end = el.selectionStart;
    el.value = el.value.slice(0, m.start) + insert + el.value.slice(end);
    const pos = m.start + insert.length;
    ui.mention = null;
    render();
    el.focus();
    el.setSelectionRange(pos, pos);
    autosize(el);
  }
  function autosize(el) {
    if (el.tagName !== 'TEXTAREA' || !el.closest('.composer-box')) return;
    el.style.height = 'auto';
    el.style.height = Math.min(200, el.scrollHeight) + 'px';
  }

  // ---------- sending ----------
  async function sendInterview() {
    const el = $('#chat-input');
    if (!el) return;
    let text = el.value.trim();
    const answers = [];
    const qs = Object.fromEntries(S.chat.flatMap((m) => m.questions || []).map((q) => [q.id, q.text]));
    for (const [id, v] of Object.entries(ui.answers)) {
      const a = (v.text || '').trim() || v.choice;
      if (a) answers.push({ id, question: qs[id] || '', answer: a });
    }
    const q = ui.quote.interview;
    if (q) text = `${q.text.split('\n').map((l) => '> ' + l).join('\n')}\n\n${text}`;
    if (!text.trim() && !answers.length) return;
    const brief = $('#brief-mode')?.checked && !S.state.interviewSessionId;
    const saved = { value: el.value, answers: ui.answers, quote: q };
    el.value = '';
    autosize(el);
    ui.answers = {};
    ui.quote.interview = null;
    document.querySelectorAll('[data-qother]').forEach((i) => (i.value = ''));
    const ok = await act(brief ? 'brief' : 'chat', brief ? { text } : { text, answers });
    if (!ok) {
      if ($('#chat-input')) $('#chat-input').value = saved.value;
      ui.answers = saved.answers;
      ui.quote.interview = saved.quote;
      render();
    }
  }
  async function sendCto(textOverride) {
    const el = $('#cto-input');
    let text = (textOverride ?? el?.value ?? '').trim();
    if (!text) return;
    const q = ui.quote.cto;
    if (q) text = `${q.text.split('\n').map((l) => '> ' + l).join('\n')}\n\n${text}`;
    const saved = el?.value;
    if (el) {
      el.value = '';
      autosize(el);
    }
    ui.quote.cto = null;
    const st = S.state.cto;
    const ok = await act('cto-chat', { text, thread: st?.activeThread || undefined });
    if (!ok && el) el.value = saved;
  }

  function msgText(scope, idx) {
    if (scope === 'interview') return S.chat[idx]?.text || '';
    const th = S.cto?.activeThread;
    return (S.cto?.logs?.[th] || [])[idx]?.text || '';
  }

  // Opens the CTO chat with a reference to a phase pre-filled.
  function ctoRef(phaseId, problem) {
    const p = phases().find((x) => x.id === phaseId);
    go('cto');
    setTimeout(() => {
      const el = $('#cto-input');
      if (!el) return;
      el.value = `@${phaseId} ${problem ? `I tested ${phaseId}${p ? ` (${p.title})` : ''} and found a problem: ` : ''}`;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      autosize(el);
    }, 60);
  }

  // ---------- events ----------
  function setCfg(obj, key, val) {
    const parts = key.split('.');
    let o = obj;
    for (const p of parts.slice(0, -1)) o = o[p] ||= {};
    o[parts.at(-1)] = val;
  }

  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest('button, a, [data-session], [data-phase-sel], [data-session-open], [data-cmd], [data-cmd-i], [data-diff], .switch-row');
    if (!t) {
      if (ev.target.id === 'cmdk') closeCmd();
      return;
    }
    const d = t.dataset;
    if (d.cmdI !== undefined) return runCmd(Number(d.cmdI));
    if (d.cmd !== undefined) return openCmd();
    if (d.themeToggle !== undefined) return cycleTheme();
    if (d.openDoc) {
      ui.doc = d.openDoc;
      ui.editing = false;
      if (ui.view !== 'docs') return;
      ev.preventDefault();
      return render();
    }
    if (d.phaseSel && !t.closest('.switch-row') && !ev.target.closest('.switch-row')) {
      ui.phase = d.phaseSel;
      if (d.go && ui.view !== d.go) return go(d.go);
      return render();
    }
    if (d.autorun) {
      ev.stopPropagation();
      return act('set-autorun', { phase: d.autorun, value: !autoRun(d.autorun) });
    }
    if (d.autorunAll !== undefined) return act('set-autorun', { all: true, value: d.autorunAll === '1' }, d.autorunAll === '1' ? 'All phases run automatically' : 'The team will ask before each phase');
    if (d.session) {
      ui.session = d.session;
      ui.followLive = false;
      return render();
    }
    if (d.sessionOpen) {
      ui.session = d.sessionOpen;
      ui.followLive = false;
      return go('live');
    }
    if (d.diff) {
      const k = `${ui.arg}|${d.diff}`;
      ui.openDiff = ui.openDiff === k ? null : k;
      render();
      if (ui.openDiff && diffCache[k] == null) {
        const r = await fetch(`/api/review?phase=${encodeURIComponent(ui.arg)}&file=${encodeURIComponent(d.diff)}`);
        diffCache[k] = (await r.json()).diff || '(no changes)';
        render();
      }
      return;
    }
    if (d.act) {
      t.disabled = true;
      const payload = {};
      if (d.phase) payload.phase = d.phase;
      if (d.value !== undefined) payload.value = d.value === '1';
      const labels = { 'start-phase': `Starting ${d.phase}`, 'approve-plan': 'Plan approved', 'approve-spec': 'Spec approved', 'review-phase': 'Marked as reviewed', 'app-start': 'Starting the app', 'cto-new-thread': 'New thread', 'set-autorun': 'Auto-run on' };
      await act(d.act, payload, labels[d.act]);
      t.disabled = false;
      return;
    }
    if (d.restart !== undefined) {
      await act('app-stop');
      setTimeout(() => act('app-start', {}, 'Restarted'), 600);
      return;
    }
    if (d.confirm) {
      const texts = {
        'rerun-phase': ['Re-run this phase?', 'Every step runs again with fresh sessions. Existing code is kept and built upon.', 'Re-run'],
        'skip-phase': ['Skip this phase?', 'The team moves on without building or testing it.', 'Skip'],
        'rollback-phase': ['Roll back the code?', 'This discards all code changes since this phase started (git reset --hard and git clean), including later phases. Those phases are reset to pending. This cannot be undone.', 'Roll back'],
      };
      const [title, text, ok] = texts[d.confirm];
      if (await confirmDialog(title, text, ok, d.confirm === 'rollback-phase')) await act(d.confirm, { phase: d.phase }, 'Done');
      return;
    }
    if (d.answer) {
      const el = document.getElementById(`ans-${d.answer}`);
      const text = el?.value.trim();
      if (!text) return;
      el.value = '';
      if (!(await act('answer', { id: d.answer, text }, 'Answer sent')) && el) el.value = text;
      return;
    }
    if (d.resolve) return act('resolve', { id: d.resolve, option: d.option });
    if (d.qopt) {
      const cur = ui.answers[d.qopt] || {};
      ui.answers[d.qopt] = { ...cur, choice: cur.choice === d.val ? null : d.val };
      render();
      return $('#chat-input')?.focus();
    }
    if (d.unanswer) {
      delete ui.answers[d.unanswer];
      const inp = document.querySelector(`[data-qother="${CSS.escape(d.unanswer)}"]`);
      if (inp) inp.value = '';
      return render();
    }
    if (d.quote) {
      ui.quote[d.quote] = { who: d.who, text: msgText(d.quote, Number(d.idx)).slice(0, 600) };
      render();
      return $(d.quote === 'interview' ? '#chat-input' : '#cto-input')?.focus();
    }
    if (d.quoteQ) {
      const el = $('#chat-input');
      if (el) {
        el.value = `${el.value}${el.value && !el.value.endsWith(' ') ? ' ' : ''}#${d.quoteQ} `;
        el.focus();
      }
      return;
    }
    if (d.unquote) {
      ui.quote[d.unquote] = null;
      return render();
    }
    if (d.copy) {
      try {
        await navigator.clipboard.writeText(msgText(d.copy, Number(d.idx)));
        toast('Copied');
      } catch {
        toast('Copy failed', true);
      }
      return;
    }
    if (d.mention) return applyMention(d.mention);
    if (d.send === 'chat-input') return sendInterview();
    if (d.send === 'cto-input') return sendCto();
    if (d.suggest) {
      const el = $('#cto-input');
      if (d.suggest.endsWith(' ') || d.suggest.endsWith(': ')) {
        el.value = d.suggest;
        el.focus();
        return autosize(el);
      }
      return sendCto(d.suggest);
    }
    if (d.ctoRef) return ctoRef(d.ctoRef, d.problem === '1');
    if (d.applyCo) return act('apply-change-order', { id: d.applyCo }, 'Change order applied');
    if (d.pick) {
      ui.skillPick ||= {};
      const list = (ui.skillPick[d.pick] ||= [...pickFor(d.pick)]);
      const i = list.indexOf(d.agent);
      if (i >= 0) list.splice(i, 1);
      else list.push(d.agent);
      return render();
    }
    if (d.skillAdd) {
      const agents = d.agents !== undefined ? d.agents.split(',').filter(Boolean) : pickFor(d.skillAdd);
      return act('skill-select', { id: d.skillAdd, agents }, `Adding ${skillName(d.skillAdd)}…`);
    }
    if (d.skillAgent) {
      const x = selectedSkills().find((s) => s.id === d.skillAgent);
      const cur = new Set(x?.agents || []);
      if (cur.has(d.agent)) cur.delete(d.agent);
      else cur.add(d.agent);
      if (!cur.size) return toast('A skill needs at least one agent. Use Remove to drop it.', true);
      return act('skill-agents', { id: d.skillAgent, agents: [...cur] });
    }
    if (d.skillRemove) {
      if (await confirmDialog(`Remove ${skillName(d.skillRemove)}?`, 'Agents stop loading it from their next session. The downloaded copy stays cached, so adding it back is quick.', 'Remove', true)) await act('skill-remove', { id: d.skillRemove }, 'Skill removed');
      return;
    }
    if (d.skillRetry) {
      const x = selectedSkills().find((s) => s.id === d.skillRetry);
      return act('skill-select', { id: d.skillRetry, agents: x?.agents || [] }, 'Retrying download');
    }
    if (d.skillPreview) return skillPreview(d.skillPreview);
    if (d.skillUrl !== undefined) {
      const el = $('#skill-url');
      const url = el.value.trim();
      if (!url) return;
      const agents = pickFor('__url');
      if (!agents.length) return toast('Pick at least one agent for this skill.', true);
      if (await act('skill-add-url', { url, agents }, 'Adding skill…')) el.value = '';
      return;
    }
    if (d.rejectCo) return act('reject-change-order', { id: d.rejectCo });
    if (d.msgTo) {
      go('messages');
      setTimeout(() => {
        if ($('#msg-to')) $('#msg-to').value = d.msgTo;
        $('#msg-text')?.focus();
      }, 60);
      return;
    }
    if (d.sendMsg !== undefined) {
      const el = $('#msg-text');
      const text = el.value.trim();
      if (!text) return;
      el.value = '';
      if (!(await act('send-message', { to: $('#msg-to').value, text }, 'Message queued'))) el.value = text;
      return;
    }
    if (d.notify !== undefined) {
      await Notification.requestPermission();
      return render();
    }
    if (d.docEdit !== undefined) return editDoc();
    if (d.docCancel !== undefined) {
      ui.editing = false;
      return render();
    }
    if (d.docSave !== undefined) {
      const content = $('#doc-text').value;
      if (await act('save-doc', { path: ui.doc, content }, 'Saved')) {
        ui.editing = false;
        docCache[ui.doc] = { content, mtime: -1 };
        render();
      }
      return;
    }
    if (d.cfgSave !== undefined) {
      const patch = {};
      document.querySelectorAll('[data-cfg]').forEach((el) => {
        let v = el.type === 'checkbox' ? el.checked : el.value;
        if (el.type === 'number') v = v === '' ? null : Number(v);
        if (el.tagName === 'SELECT' && v === '') v = null;
        if (el.type === 'text') v = v.trim() || null;
        setCfg(patch, el.dataset.cfg, v);
      });
      if (patch.permissions?.skipAll && !S.config.permissions.skipAll) {
        if (!(await confirmDialog('Skip all permission checks?', 'Agents will run any command without restriction. Only do this inside a sandbox, container or VM.', 'Skip checks', true))) return;
      }
      return act('update-config', { patch }, 'Settings saved');
    }
  });

  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.id === 'cmdk-input') {
      ui.cmdIdx = 0;
      return renderCmd();
    }
    if (t.dataset.qother) {
      const cur = ui.answers[t.dataset.qother] || {};
      ui.answers[t.dataset.qother] = { ...cur, text: t.value };
      // Update the card highlight and chips without stealing focus.
      clearTimeout(t._r);
      t._r = setTimeout(render, 250);
      return;
    }
    if (t.id === 'chat-input' || t.id === 'cto-input') {
      autosize(t);
      updateMention(t);
    }
  });

  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.dataset.model) act('update-agent', { id: t.dataset.model, model: t.value }, 'Model updated');
    if (t.id === 'follow') {
      ui.followLive = t.checked;
      if (t.checked && S.active) ui.session = S.active.id;
      render();
    }
    if (t.id === 'msg-filter') {
      ui.msgFilter = t.value;
      render();
    }
    if (t.id === 'thread-select') act('cto-select-thread', { thread: t.value });
  });

  document.addEventListener('keydown', (ev) => {
    const t = ev.target;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      return ui.cmdOpen ? closeCmd() : openCmd();
    }
    if (ui.cmdOpen) {
      if (ev.key === 'Escape') return closeCmd();
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        ui.cmdIdx = Math.max(0, Math.min((ui.cmdList?.length || 1) - 1, ui.cmdIdx + (ev.key === 'ArrowDown' ? 1 : -1)));
        return renderCmd();
      }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        return runCmd(ui.cmdIdx);
      }
      return;
    }
    if (ui.mention && ui.mention.target === t.id) {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        ui.mention.idx = (ui.mention.idx + (ev.key === 'ArrowDown' ? 1 : ui.mention.items.length - 1)) % ui.mention.items.length;
        return render();
      }
      if (ev.key === 'Enter' || ev.key === 'Tab') {
        ev.preventDefault();
        return applyMention(ui.mention.items[ui.mention.idx].insert);
      }
      if (ev.key === 'Escape') {
        ui.mention = null;
        return render();
      }
    }
    if ((t.id === 'chat-input' || t.id === 'cto-input') && ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      return t.id === 'chat-input' ? sendInterview() : sendCto();
    }
    if (t.id === 'msg-text' && ev.key === 'Enter') return $('[data-send-msg]')?.click();
    if (t.id?.startsWith('ans-') && ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      return document.querySelector(`[data-answer="${t.id.slice(4)}"]`)?.click();
    }
    if (!typing && (ev.key === '/' || ev.key === 'f')) {
      ev.preventDefault();
      openCmd();
    }
  });

  window.addEventListener('hashchange', () => {
    parseHash();
    ui.editing = false;
    ui.mention = null;
    render();
    $('#main').scrollTop = 0;
  });

  // Keep relative times and running durations fresh.
  setInterval(() => {
    if (S && !document.activeElement?.closest?.('.composer, .qcard, dialog')) render();
  }, 10000);

  parseHash();
  load();
  connect();
})();
