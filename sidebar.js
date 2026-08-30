#!/usr/bin/env node
// Session sidebar for Claude Code — run it in a split terminal pane.
//
//   node sidebar.js                  follow the session that is live right now
//   node sidebar.js <session-id>     pin one session
//   node sidebar.js --install [dir]  set up the split that opens Claude beside
//                                    this pane; dir is where Claude starts. A
//                                    third argument overrides where the Ghostty
//                                    launcher script is written.
//   node sidebar.js --check          say which terminal this is and try to open
//                                    a split, printing whatever comes back
//
// Keys:  Tab or S  session list, Tab again closes it · ↑↓ move · Enter open the
//        session beside you — a Warp tab, a Ghostty split · Esc back · Q quit
// Mouse: the row under the pointer lights up when it opens something — click a
//        session row to open that session, a link or a media row to open that.
//        Wheel scrolls. Selecting text needs Shift, as in any mouse-aware TUI.
// The letter keys accept Latin, Ukrainian and Russian layouts.
//
// No dependencies.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const ACTIVE = path.join(HOME, '.claude', '.active-session.json');
const IMAGES = path.join(HOME, '.claude', 'image-cache');
const arg = process.argv[2];

// ---- ANSI ----
const sgr = (c, s) => '\x1b[' + c + 'm' + s + '\x1b[0m';
const dim = (s) => sgr('2', s);
const head = (s) => sgr('1;36', s);
const strip = (s) => s.replace(/\x1b\[[\d;]*m/g, '');

// ---- keys, layout independent ----
// A key is identified by the character it produces, so the same physical key
// arrives as 's' / 'і' / 'ы' depending on the active layout. Tab is the
// layout-proof alternative.
const K_LIST = new Set(['s', 'S', 'і', 'І', 'ы', 'Ы', '\t']);
const K_QUIT = new Set(['q', 'Q', 'й', 'Й']);
const K_VIEW = new Set(['v', 'V', 'м', 'М']);
const K_STATS = new Set(['a', 'A', 'ф', 'Ф']);
const K_UP = new Set(['\u001b[A', 'k', 'л', 'Л']);
const K_DOWN = new Set(['\u001b[B', 'j', 'о', 'О']);

// ---- mouse, SGR 1006 ----
// 1000 reports press/release, 1003 adds bare motion — that is what lets a row
// light up under the pointer; 1006 encodes both as \x1b[<btn;col;rowM|m, so the
// coordinates survive past column 95. Modifier bits (shift/alt/ctrl = 4|8|16)
// ride in the button field and are masked off. Bit 32 marks motion, 64/65 are
// the wheel.
const MOUSE_ON = '\x1b[?1000h\x1b[?1003h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1003l\x1b[?1000l\x1b[?1006l';
const MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

// ---- locating the live transcript ----
// statusline.js writes ACTIVE on every turn, and that hook fires only for the
// session that just moved. An mtime scan is the fallback: it guesses, and
// guesses wrong the moment a parallel session takes a turn.
function fromStatusline() {
  if (arg) return null;
  try {
    const a = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
    if (a.transcript_path && fs.existsSync(a.transcript_path)) return a;
  } catch { }
  return null;
}

function findTranscript() {
  if (arg && arg.endsWith('.jsonl') && fs.existsSync(arg)) return arg;
  const live = fromStatusline();
  if (live) return live.transcript_path;
  let best = null;
  let dirs; try { dirs = fs.readdirSync(PROJECTS, { withFileTypes: true }); } catch { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let ents; try { ents = fs.readdirSync(path.join(PROJECTS, d.name)); } catch { continue; }
    for (const name of ents) {
      if (!name.endsWith('.jsonl')) continue;
      if (arg && !name.startsWith(arg)) continue;
      const p = path.join(PROJECTS, d.name, name);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (!best || st.mtimeMs > best.mtimeMs) best = { p, mtimeMs: st.mtimeMs };
    }
  }
  return best && best.p;
}

function readSlice(file, from, len) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, from);
  fs.closeSync(fd);
  return buf.slice(0, n).toString('utf8');
}

// ---- transcript parsing ----
const TEMP = /[\\/](Temp|tmp)[\\/]/i;
const NOISE = /^(\/dev\/null|&\d|-|\d)$/;
// characters no real path holds, but python f-strings and shell arithmetic do,
// and the redirect regex below happily matches those too
const BAD = /[{}()%*?<>|"]|:$/;

function newState() { return { files: new Map(), links: new Map(), todos: [], agents: new Map(), cwd: null }; }

function noteFile(st, p, t) {
  if (!p || NOISE.test(p)) return;
  p = p.replace(/^["']|["']$/g, '');
  if (BAD.test(p)) return;
  if (!/[\\/]/.test(p) && !/\.\w{1,5}$/.test(p)) return;
  const cur = st.files.get(p) || { n: 0, t };
  cur.n++; cur.t = t;
  st.files.set(p, cur);
}

// plausible written-to paths in a shell command
function pathsFromBash(st, cmd, t) {
  let m;
  const redir = /(?:^|[^>\d])>>?\s*("[^"]+"|'[^']+'|[^\s|&;<>]+)/g;
  while ((m = redir.exec(cmd))) noteFile(st, m[1], t);
  const two = /\b(?:cp|mv|install)\s+(?:-\S+\s+)*(\S+)\s+(\S+)/g;
  while ((m = two.exec(cmd))) noteFile(st, m[2], t);
  const tee = /\btee\s+(?:-\S+\s+)*(\S+)/g;
  while ((m = tee.exec(cmd))) noteFile(st, m[1], t);
}

function ingest(st, line) {
  let d; try { d = JSON.parse(line); } catch { return; }
  const t = d.timestamp || '';
  if (d.cwd && !st.cwd) st.cwd = d.cwd;
  if (d.type === 'file-history-delta' && d.trackingPath) noteFile(st, d.trackingPath, t);

  const content = (d.message || {}).content;
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'tool_use') {
      const inp = b.input || {};
      if (inp.file_path) noteFile(st, inp.file_path, t);
      if (b.name === 'Bash' && inp.command) pathsFromBash(st, String(inp.command), t);
      if (b.name === 'TodoWrite' && Array.isArray(inp.todos)) st.todos = inp.todos;
      // What the session handed off and whether it has come back. A dispatched
      // agent is the one piece of work a session queues that it cannot report
      // on itself — it is busy waiting for it.
      if (b.name === 'Agent' && b.id) {
        st.agents.set(b.id, { what: inp.description || inp.subagent_type || 'агент', at: t, done: null });
      }
    } else if (b.type === 'tool_result' && st.agents.has(b.tool_use_id)) {
      st.agents.get(b.tool_use_id).done = t;
    } else if (b.type === 'text' && b.text) {
      const re = /https?:\/\/[^\s)>\]"'`]+/g;
      let m;
      while ((m = re.exec(b.text))) st.links.set(m[0].replace(/[.,;:]$/, ''), t);
    }
  }
}

// Images pasted into a session are cached on disk per session id.
function mediaOf(id) {
  const dir = path.join(IMAGES, id);
  try {
    return fs.readdirSync(dir).map((f) => {
      let st; try { st = fs.statSync(path.join(dir, f)); } catch { st = null; }
      return { name: f, full: path.join(dir, f), size: st ? st.size : 0 };
    });
  } catch { return []; }
}

const TAIL = 3 * 1024 * 1024;   // newest slice only; see resetLive

// ---- live session (incremental) ----
const live = newState();
let file = findTranscript();

// One pane, one session. ACTIVE names whichever session took the last turn
// anywhere on the machine, so every pane open at once shows the same one — in
// the tab holding reef as much as in the tab holding this repo. Which tab has
// focus is not something a terminal will tell us, but the pane and its Claude
// open together and the tab config gives Claude the focus, so the first turn
// taken after this pane came up is this tab's. Pin to that and stop reading
// ACTIVE. A session id on the command line pins before the first turn.
// ponytail: type into another tab first and the pane pins there instead —
// Tab, then click the session you meant, and it re-pins.
const BORN = Date.now();
let pinned = arg ? file : null;
let offset = file ? startOffset(file) : 0;
let carry = '';
live.partial = offset > 0;


function readNew() {
  let st; try { st = fs.statSync(file); } catch { return false; }
  if (st.size < offset) { offset = 0; carry = ''; }
  if (st.size === offset) return false;
  const chunk = carry + readSlice(file, offset, st.size - offset);
  offset = st.size;
  const lines = chunk.split('\n');
  carry = lines.pop() || '';
  for (const l of lines) if (l.trim()) ingest(live, l);
  return true;
}

// A transcript reaches 100 MB. Reading one whole on every session switch costs
// a second and the memory to match, so the panel starts at the newest slice —
// the same window the picker uses. The half-cut first line fails JSON.parse and
// is dropped on its own.
function startOffset(f) {
  try { return Math.max(0, fs.statSync(f).size - TAIL); } catch { return 0; }
}

function resetLive(f) {
  file = f; offset = startOffset(f); carry = '';
  live.partial = offset > 0;
  live.files.clear(); live.links.clear(); live.agents.clear(); live.todos = []; live.cwd = null;
}

// ---- session list ----
const titleCache = new Map();
const scanCache = new Map();

function titleOf(f, size) {
  const lines = (s) => s.split('\n').filter((l) => l.trim());
  for (const l of lines(readSlice(f, Math.max(0, size - 262144), Math.min(size, 262144))).reverse()) {
    try { const d = JSON.parse(l); if (d.type === 'ai-title' && d.aiTitle) return d.aiTitle.replace(/\s+/g, ' ').trim(); } catch { }
  }
  for (const l of lines(readSlice(f, 0, Math.min(size, 131072)))) {
    try {
      const d = JSON.parse(l);
      const c = d.type === 'user' && d.message && d.message.content;
      const s = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b.type === 'text') || {}).text : null;
      if (s && !s.startsWith('<')) return s.replace(/\s+/g, ' ').slice(0, 90);
    } catch { }
  }
  return null;
}

function titleFor(p, size, mtimeMs) {
  const hit = titleCache.get(p);
  if (hit && hit.mtimeMs === mtimeMs) return hit.title;
  let title = null;
  try { title = titleOf(p, size); } catch { }
  titleCache.set(p, { mtimeMs, title });
  return title;
}

// The one argument worth showing next to a tool's name.
function toolArg(call) {
  const i = call.input || {};
  const one = i.command || i.file_path || i.path || i.pattern || i.description || i.url || '';
  const s = String(one).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return ' ' + (/[\\/]/.test(s) && !i.command ? path.basename(s) : s);
}

// What a session is doing, read from the end of its transcript. Walking back to
// the newest assistant record answers it: a pending tool call means the session
// is still moving, no tool call means the turn ended and it is waiting on its
// human. That second state is the one worth seeing across a row of sessions —
// it is a session that stopped and will not restart on its own.
// A dispatched agent keeps working after the turn that sent it has ended, so a
// session with one still out is not waiting on you — it is waiting on the agent.
// The row that says otherwise is the one lie this pane can tell that costs an
// hour. A result closes the agent whose id it carries; the oldest of whatever is
// left is what the row reports.
function agentOut(lines) {
  const out = new Map();
  for (const l of lines) {
    if (!l.trim()) continue;
    let d; try { d = JSON.parse(l); } catch { continue; }
    const c = (d.message || {}).content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' && b.name === 'Agent' && b.id) {
        out.set(b.id, { what: (b.input || {}).description || 'агент', at: Date.parse(d.timestamp || '') || 0 });
      } else if (b.type === 'tool_result') out.delete(b.tool_use_id);
    }
  }
  return [...out.values()].sort((a, b) => a.at - b.at)[0] || null;
}

const stateCache = new Map();
function stateOf(s) {
  const hit = stateCache.get(s.path);
  if (hit && hit.mtime === s.mtime) return hit.st;
  const st = { waiting: false, tool: null, agent: null };
  try {
    const from = Math.max(0, s.size - 65536);
    const lines = readSlice(s.path, from, Math.min(s.size, 65536)).split('\n');
    if (from > 0) lines.shift();                    // the first line is cut in half
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let d; try { d = JSON.parse(lines[i]); } catch { continue; }
      if (d.type !== 'assistant') continue;
      const c = (d.message || {}).content;
      const call = Array.isArray(c) && c.find((b) => b && b.type === 'tool_use');
      st.tool = call ? call.name + toolArg(call) : null;
      st.waiting = !call;
      break;
    }
    st.agent = agentOut(lines);
  } catch { }
  stateCache.set(s.path, { mtime: s.mtime, st });
  return st;
}

// The project a session belongs to. Read from the transcript rather than decoded
// out of the directory name, which mangles any project whose name holds a dash.
const cwdCache = new Map();
function projOf(s) {
  if (!cwdCache.has(s.path)) { const d = cwdOf(s); cwdCache.set(s.path, path.basename(gitUp(d) || d)); }
  return cwdCache.get(s.path);
}

// Sessions touched recently, with what each is doing. listSessions stats every
// transcript on the machine, so this is refreshed on a timer rather than on
// every frame.
const RECENT = 3 * 3600 * 1000;
let activeCache = null;
let activeAt = 0;
function activeSessions() {
  const now = Date.now();
  if (activeCache && now - activeAt < 3000) return activeCache;
  activeAt = now;
  activeCache = listSessions()
    .filter((s) => now - s.mtime < RECENT)
    .slice(0, 12)
    .map((s) => Object.assign(s, { state: stateOf(s) }));
  return activeCache;
}

function listSessions() {
  const out = [];
  let dirs; try { dirs = fs.readdirSync(PROJECTS, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(PROJECTS, d.name);
    let ents; try { ents = fs.readdirSync(dir); } catch { continue; }
    for (const name of ents) {
      if (!name.endsWith('.jsonl')) continue;
      const p = path.join(dir, name);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.size < 2048) continue;
      out.push({ id: name.replace(/\.jsonl$/, ''), path: p, mtime: st.mtimeMs, size: st.size, title: titleFor(p, st.size, st.mtimeMs) });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Scan a session for its files and links. Only the newest slice is parsed, so
// a long session shows recent work rather than everything it ever touched.
function scanSession(s) {
  const hit = scanCache.get(s.path);
  if (hit && hit.mtime === s.mtime) return hit.st;
  const st = newState();
  const from = Math.max(0, s.size - TAIL);
  const text = readSlice(s.path, from, Math.min(s.size, TAIL));
  const lines = text.split('\n');
  if (from > 0) lines.shift();                       // the first line is cut in half
  for (const l of lines) if (l.trim()) ingest(st, l);
  st.partial = from > 0;
  st.media = mediaOf(s.id);
  scanCache.set(s.path, { mtime: s.mtime, st });
  return st;
}

// ---- the project behind a session ----
// Sessions are mostly started in the directory that holds every repo, so a
// session's cwd names no project at all. The files it touched do: their first
// path segment under that directory is the repo it is really working in.
const VERCEL = /\b([a-z0-9][a-z0-9-]*\.vercel\.app)\b/gi;
const VERCEL_ONE = /\b([a-z0-9][a-z0-9-]*\.vercel\.app)\b/i;
// Preview deployments — <project>-<hash>-<scope> and <project>-git-<branch> —
// outnumber the real hosts and are dead within days. The address you lose and
// go looking for is the one you would send someone.
const PREVIEW = /-[a-z0-9]{9}-|-git-/;
// A fenced block is a picture of something else — a pane, a terminal, another
// project's README — and an address inside it is that picture's, not this
// repo's. The example frame in our own README is why every session working in
// this repo was reported as deployed to reef.
const FENCE = /^ {0,3}(`{3,}|~{3,})[\s\S]*?(?:^ {0,3}\1|$(?![\s\S]))/gm;
const DOC_LIMIT = 60;              // markdown files read per repo
const projInfo = new Map();

// The nearest repo at or above a directory, so a session sitting in `app/` or
// `memory/` is still reported as working in the repo that holds it. Bounded by
// the home directory: above it a stray .git would swallow every project at once.
function gitUp(dir) {
  for (let d = dir; d && d !== HOME;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

function repoOf(cwd, st) {
  const own = gitUp(cwd);
  if (own) return own;
  const count = new Map();
  for (const p of st.files.keys()) {
    const rel = path.relative(cwd, p);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !/[\\/]/.test(rel)) continue;
    const top = rel.split(/[\\/]/)[0];
    count.set(top, (count.get(top) || 0) + 1);
  }
  const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
  const dir = best && path.join(cwd, best[0]);
  return dir && fs.existsSync(path.join(dir, '.git')) ? dir : cwd;
}

function githubOf(dir) {
  try {
    const cfg = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
    const m = cfg.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s/);
    return m && m[1];
  } catch { return null; }
}

// A repo says where it is deployed in its own documentation, one level down at
// most — README, CLAUDE.md, whatever notes sit beside them.
function vercelInDocs(dir) {
  const hosts = new Set();
  let budget = DOC_LIMIT;
  const walk = (d, depth) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (budget <= 0) return;
      if (e.isDirectory()) {
        if (depth > 0 && e.name[0] !== '.' && e.name !== 'node_modules') walk(path.join(d, e.name), depth - 1);
        continue;
      }
      if (!e.name.endsWith('.md')) continue;
      budget--;
      let text; try { text = fs.readFileSync(path.join(d, e.name), 'utf8'); } catch { continue; }
      text = text.replace(FENCE, '');
      let m; VERCEL.lastIndex = 0;
      while ((m = VERCEL.exec(text))) { const h = m[1].toLowerCase(); if (!PREVIEW.test(h)) hosts.add(h); }
    }
  };
  walk(dir, 1);
  return [...hosts];
}

// What the repo documents, plus what this session said out loud. The second is
// how a deployment made an hour ago shows up before anyone writes it down.
function projectOf(s, st) {
  const dir = repoOf(cwdOf(s), st);
  let info = projInfo.get(dir);
  if (!info) {
    info = { dir, name: path.basename(dir), repo: githubOf(dir), git: fs.existsSync(path.join(dir, '.git')), docs: vercelInDocs(dir) };
    projInfo.set(dir, info);
  }
  const hosts = new Set(info.docs);
  for (const u of st.links.keys()) {
    const m = u.match(VERCEL_ONE);
    if (m && !PREVIEW.test(m[1])) hosts.add(m[1].toLowerCase());
  }
  return { dir, name: info.name, repo: info.repo, git: info.git, urls: [...hosts].sort() };
}

// ---- answers that take longer than a frame ----
// Walking a repo, asking git, listing processes: none of these finish inside the
// 16 ms a redraw is allowed, and doing them on the render path is how a pane
// starts to stutter. `slow` returns whatever it has, starts the work if the
// answer has gone stale, and redraws when the real one lands. One job per key at
// a time, so a cursor resting on a session cannot pile up a queue.
const later = new Map();

function slow(key, ttl, run) {
  const at = later.get(key) || { value: null, at: 0, busy: false };
  later.set(key, at);
  if (!at.busy && Date.now() - at.at >= ttl) {
    at.busy = true;
    Promise.resolve().then(run).then((v) => { at.value = v; }, () => { })
      .then(() => { at.busy = false; at.at = Date.now(); draw(); });
  }
  return at.value;
}

// stderr is kept, not discarded: the one command here that can fail in a way a
// user must hear about — osascript, refused permission to drive Ghostty — says
// so only there, and throwing it away is how a click becomes "nothing happens".
function capture(cmd, args, cwd) {
  return new Promise((done) => {
    let out = '';
    let err = '';
    let p;
    try { p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { return done({ out: '', err: String(e.message || e), code: -1 }); }
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => done({ out, err: String(e.message || e), code: -1 }));
    p.on('close', (code) => done({ out, err, code }));
  });
}

// A repo's weight, and the one child directory to blame when there is one. The
// count is capped because a tree with a quarter of a million files in it is
// exactly the tree you are asking about, and the answer is already "too much"
// well before the walk ends.
const FILE_CAP = 200000;

async function dirSize(dir) {
  const per = new Map();
  let total = 0;
  let seen = 0;
  const walk = async (d, top) => {
    if (seen >= FILE_CAP) return;
    let ents; try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (seen >= FILE_CAP) return;
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { await walk(p, top || e.name); continue; }
      let st; try { st = await fs.promises.stat(p); } catch { continue; }
      seen++;
      total += st.size;
      if (top) per.set(top, (per.get(top) || 0) + st.size);
    }
  };
  await walk(dir, null);
  const worst = [...per.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    total,
    capped: seen >= FILE_CAP,
    // Naming a child is only worth a row when it is most of the answer.
    blame: worst && worst[1] > total * 0.4 ? { name: worst[0], bytes: worst[1] } : null,
  };
}

const LOG_N = 4;                   // commits shown under the branch
const HEAT_DAYS = 26 * 7;          // half a year of commits, as whole weeks
const defaults = new Map();        // what the remote calls its default branch, per repo

// A remote's default branch is settled at clone time and does not move while the
// pane is open, so it is asked once. A repo with no origin has none, and then
// there is nothing to be behind.
async function defaultBranch(dir) {
  if (!defaults.has(dir)) {
    const { out } = await capture('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir);
    defaults.set(dir, out.trim().replace(/^origin\//, '') || null);
  }
  return defaults.get(dir);
}

async function gitState(dir) {
  const { out } = await capture('git', ['status', '--porcelain=v1', '-b'], dir);
  if (!out) return null;
  const lines = out.split('\n').filter((l) => l.trim());
  const head = lines.shift() || '';
  if (!head.startsWith('##')) return null;
  const branch = (head.match(/^## ([^\s]+?)(?:\.\.\.|$)/) || [])[1] || '?';
  const g = {
    branch,
    ahead: +((head.match(/ahead (\d+)/) || [])[1] || 0),
    behind: +((head.match(/behind (\d+)/) || [])[1] || 0),
    dirty: lines.length,
    log: [],
    base: null,
  };
  // --graph keeps the column that shows a merge; a line of it alone carries no
  // hash and is dropped, which is what the match is for.
  const log = await capture('git', ['log', '--graph', '-n', String(LOG_N), '--format=%h %at %s'], dir);
  for (const l of log.out.split('\n')) {
    const m = l.match(/^(\D*?)([0-9a-f]{7,40}) (\d+) (.*)$/);
    if (m) g.log.push({ graph: m[1], hash: m[2], at: +m[3] * 1000, subject: m[4] });
  }
  // Two months of commits, one count per day, newest last. A repo that has been
  // quiet for three weeks says so in a row nothing else in the pane reports.
  const heat = await capture('git', ['log', '--format=%at', '--since=' + HEAT_DAYS + ' days ago'], dir);
  const midnight = new Date().setHours(0, 0, 0, 0);
  g.days = new Array(HEAT_DAYS).fill(0);
  for (const l of heat.out.split('\n')) {
    const t = +l.trim() * 1000;
    if (!t) continue;
    const d = Math.round((midnight - new Date(t).setHours(0, 0, 0, 0)) / 86400000);
    if (d >= 0 && d < HEAT_DAYS) g.days[HEAT_DAYS - 1 - d]++;
  }

  // How far the branch has drifted from the default one: the number that says
  // whether to rebase before carrying on, and the one nothing else reports until
  // a merge conflict does.
  const def = await defaultBranch(dir);
  if (def && def !== branch) {
    const { out: div } = await capture('git', ['rev-list', '--left-right', '--count', 'origin/' + def + '...HEAD'], dir);
    const [b, a] = div.trim().split(/\s+/).map(Number);
    if (b >= 0 && a >= 0) g.base = { name: def, behind: b, ahead: a };
  }
  return g;
}

// Headless browsers a test run walked away from. They hold gigabytes and nothing
// is ever going to close them. A browser you opened yourself carries no
// --headless, so it is never counted, and neither is one young enough to still
// be someone's running test. Windows only: this is where the precedents are.
const ORPHAN_AGE = 10 * 60 * 1000;

async function orphans() {
  if (process.platform !== 'win32') return [];
  const q = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe' or Name='chromium.exe'\""
    + " | Select-Object Name,CommandLine,WorkingSetSize,CreationDate | ConvertTo-Json -Compress";
  const { out } = await capture('powershell', ['-NoProfile', '-NonInteractive', '-Command', q]);
  let rows; try { rows = JSON.parse(out); } catch { return []; }
  return orphanRows(Array.isArray(rows) ? rows : rows ? [rows] : [], Date.now());
}

// CIM writes a date as "/Date(1787659826477)/", so the digits are the whole of
// it. A process with no CreationDate is treated as new, which keeps it out of
// the list rather than inventing a stranded one.
function orphanRows(rows, now, minAge = ORPHAN_AGE) {
  const by = new Map();
  for (const r of rows) {
    if (!r || !r.CommandLine || !/--headless|--remote-debugging-/.test(r.CommandLine)) continue;
    const born = +String(r.CreationDate || '').replace(/\D/g, '').slice(0, 13) || now;
    if (now - born < minAge) continue;
    const key = String(r.Name || '?').replace(/\.exe$/i, '');
    const cur = by.get(key) || { name: key, n: 0, bytes: 0, born };
    cur.n++;
    cur.bytes += +r.WorkingSetSize || 0;
    cur.born = Math.min(cur.born, born);
    by.set(key, cur);
  }
  return [...by.values()].sort((a, b) => b.bytes - a.bytes);
}

// ---- what the machine is doing ----
// The pane sits open all day next to a session that compiles, renders and starts
// browsers, so the load belongs on it. One sample a second, kept back only as far
// as the pane is wide. CPU comes off the tick counters node already keeps; VRAM
// needs nvidia-smi, and its absence is a row that never appears.
const GPU_TTL = 3000;
const HIST = 600;
const load = { cpu: [], ram: [], vram: [], net: [], gpu: null, rate: null, disk: null };
let cpuAt = cpuTicks();

function cpuTicks() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    for (const k in c.times) total += c.times[k];
  }
  return { idle, total };
}

function gpuMem() {
  return capture('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'])
    .then(({ out }) => {
      const [used, total] = out.trim().split(/\s*,\s*/).map(Number);
      return total > 0 ? { used: used * 1048576, total: total * 1048576 } : null;
    });
}

function keep(series, v) { series.push(v); if (series.length > HIST) series.shift(); }

// Called from the tick, never from a renderer: os.cpus() walks every core and
// nvidia-smi is a process, and neither belongs on the render path.
function sampleLoad() {
  const now = cpuTicks();
  const dt = now.total - cpuAt.total;
  const di = now.idle - cpuAt.idle;
  cpuAt = now;
  keep(load.cpu, dt > 0 ? 1 - di / dt : 0);
  // A Mac is asked what it means by memory in use; everywhere else free pages
  // are the answer. The reading holds between refreshes rather than being taken
  // every second, because it costs a process to take.
  const used = process.platform === 'darwin' ? slow('mem', PROC_TTL, memUsed) : null;
  load.used = used || os.totalmem() - os.freemem();
  keep(load.ram, load.used / os.totalmem());
  const g = slow('gpu', GPU_TTL, gpuMem);
  if (g) { load.gpu = g; keep(load.vram, g.used / g.total); }
  // The same poll that finds the heavy processes carries the counters, so the
  // rate is only as new as that poll — the line steps rather than flows.
  const d = slow('procs', PROC_TTL, processes);
  if (d && d.disk) load.disk = d.disk;
  if (d && d.net) load.rate = d.net;
  if (load.rate) keep(load.net, load.rate.rx + load.rate.tx);
}

// ---- what is holding the machine ----
// A pane that says the box is at 90% and nothing about what is holding it there
// sends you to the task manager anyway. The two sorts are deliberate: the
// heaviest by memory and the heaviest by processor time are rarely the same
// process, and one query returning both beats two queries. Windows only, like
// the orphan check.
const PROC_TTL = 5000;
const PROC_N = 4;                            // rows shown under the chart
const PROC_SKIP = /^(System|System Idle Process|Memory Compression|Registry)$/i;
// Every process, not the heaviest dozen: a browser is thirty-odd of them and no
// single one is ever heavy. The command line is fetched only for the runtimes
// whose name says nothing about what they are running.
const PROC_Q = [
  '$r = Get-CimInstance Win32_Process | ForEach-Object {',
  '  $c = [string]::Empty;',
  "  if ($_.Name -match '^(node|claude|python|pythonw|bun|deno|java)') {",
  '    if ($_.CommandLine) { $c = $_.CommandLine.Substring(0, [Math]::Min(200, $_.CommandLine.Length)) } };',
  '  [pscustomobject]@{ id = $_.ProcessId; pp = $_.ParentProcessId; n = $_.Name; ws = $_.WorkingSetSize;',
  '    t = ($_.KernelModeTime + $_.UserModeTime); c = $c } };',
  // Raw counters, not the formatted per-second ones: the pane keeps its own
  // clock, and two readings of a total are all a rate needs.
  "$n = Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface | Where-Object { $_.Name -notmatch 'Loopback|isatap|Pseudo' };",
  '$d = Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DeviceID -eq $env:SystemDrive };',
  '[pscustomobject]@{ p = @($r);',
  '  rx = ($n | Measure-Object BytesReceivedPersec -Sum).Sum;',
  '  tx = ($n | Measure-Object BytesSentPersec -Sum).Sum;',
  '  free = $d.FreeSpace; size = $d.Size } | ConvertTo-Json -Compress -Depth 3',
].join(' ');

// Everywhere that is not Windows, ps says the same things in fewer characters.
// `comm` is one field and `args` is another, and both hold spaces on a Mac
// (`/Applications/Google Chrome.app/...`), so they cannot be asked for at once —
// the second call names the runtimes, whose own name says nothing.
const RUNTIME = /^(node|claude|python\d?|bun|deno|java|ruby)$/i;

function cpuTicks100ns(t) {
  const m = String(t).match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return 0;
  const s = (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
  return s * 1e7;
}

// rss is in kilobytes, and the command is the whole of the rest of the line,
// spaces and all — which is why it has to be last.
function psRows(out) {
  const list = [];
  for (const l of out.split('\n')) {
    const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (m) list.push({ id: +m[1], pp: +m[2], ws: +m[3] * 1024, t: cpuTicks100ns(m[4]), n: m[5].trim().replace(/^.*\//, ''), c: '' });
  }
  return list;
}

async function unixProcesses() {
  const { out } = await capture('ps', ['-Ao', 'pid=,ppid=,rss=,time=,comm=']);
  const list = psRows(out);
  const runtimes = list.filter((p) => RUNTIME.test(p.n));
  if (runtimes.length) {
    const { out: args } = await capture('ps', ['-o', 'pid=,args=', '-p', runtimes.map((p) => p.id).join(',')]);
    const byId = new Map(runtimes.map((p) => [p.id, p]));
    for (const l of args.split('\n')) {
      const m = l.match(/^\s*(\d+)\s+(.+)$/);
      if (m && byId.has(+m[1])) byId.get(+m[1]).c = m[2];
    }
  }
  return { list, net: netBytes((await capture('netstat', ['-ib'])).out), disk: dfSpace((await capture('df', ['-k', '/'])).out) };
}

// What a Mac calls memory in use: what applications hold, what is wired down and
// what the compressor is sitting on. os.freemem() there counts only pages that
// are free right now, which on any Mac that has been awake an hour is almost
// none of them, and a pane reporting 97% forever reports nothing.
function vmUsed(out) {
  const page = +((out.match(/page size of (\d+)/) || [])[1]) || 4096;
  const pages = (k) => +((out.match(new RegExp('Pages ' + k + ':\\s+(\\d+)')) || [])[1]) || 0;
  const used = (pages('active') + pages('wired down') + pages('occupied by compressor')) * page;
  return used > 0 ? used : null;
}

async function memUsed() {
  const { out } = await capture('vm_stat', []);
  return vmUsed(out);
}

let procAt = { at: 0, cpu: new Map() };

// node.exe says nothing; the script it is running says everything. The last
// script path on the command line is the one node was handed.
function procName(p) {
  const bare = String(p.n || '?').replace(/\.exe$/i, '');
  if (isClaude(p)) return 'claude';
  if (!RUNTIME.test(bare)) return bare;
  const hits = String(p.c || '').match(/[\w.-]+\.(?:m?[jt]s|py|rb)\b/g);
  return hits ? hits[hits.length - 1] : bare;
}

// Claude Code is claude.exe on Windows and a node process running a script
// called claude everywhere else, so the name alone answers only half the time.
function isClaude(p) {
  return /^claude(\.exe)?$/i.test(String(p.n || '')) || /[\\/]claude[\\/]/i.test(String(p.c || ''));
}

// Claude spawns bash, node and browsers, and none of them say so on their own
// command line — the answer is up the parent chain, where claude.exe sits.
function claudeOwned(id, by) {
  for (let i = 0, cur = id; i < 12 && cur; i++) {
    const p = by.get(cur);
    if (!p) return false;
    if (isClaude(p)) return true;
    cur = p.pp;
  }
  return false;
}

// netstat lists an interface once per address it holds; the <Link#> line is the
// one carrying the counters, and loopback traffic is not traffic.
function netBytes(out) {
  let rx = 0, tx = 0;
  for (const l of out.split('\n')) {
    const f = l.trim().split(/\s+/);
    if (f.length < 10 || !/^<Link#/.test(f[2]) || /^lo\d/.test(f[0])) continue;
    rx += +f[6] || 0;
    tx += +f[9] || 0;
  }
  return rx || tx ? { rx, tx } : null;
}

// df -k, so the numbers are kilobytes whatever the shell's own idea of a block.
function dfSpace(out) {
  const l = out.split('\n')[1] || '';
  const f = l.trim().split(/\s+/);
  return f.length > 3 && +f[1] ? { size: +f[1] * 1024, free: +f[3] * 1024 } : null;
}

async function winProcesses() {
  const { out } = await capture('powershell', ['-NoProfile', '-NonInteractive', '-Command', PROC_Q]);
  let d; try { d = JSON.parse(out); } catch { return null; }
  return d && Array.isArray(d.p)
    ? { list: d.p, net: { rx: +d.rx || 0, tx: +d.tx || 0 }, disk: d.size ? { free: +d.free, size: +d.size } : null }
    : null;
}

async function processes() {
  const got = process.platform === 'win32' ? await winProcesses() : await unixProcesses();
  if (!got || !got.list.length) return null;
  const list = got.list;
  const by = new Map(list.map((p) => [p.id, p]));
  const now = Date.now();
  const span = now - procAt.at;
  const cores = os.cpus().length;
  const cpu = new Map();
  const groups = new Map();
  for (const p of list) {
    cpu.set(p.id, p.t);
    if (p.id <= 4 || PROC_SKIP.test(p.n)) continue;
    const was = procAt.cpu.get(p.id);
    // CIM counts processor time in 100ns ticks, over every core there is.
    const pct = procAt.at && was != null && span > 0 ? Math.max(0, (p.t - was) / 1e4 / (span * cores) * 100) : 0;
    const name = procName(p);
    const g = groups.get(name) || { name, n: 0, ws: 0, cpu: 0, claude: 0 };
    g.n++;
    g.ws += p.ws || 0;
    g.cpu += pct;
    // Counted, not flagged: one headless browser a test forgot does not make
    // every tab you have open Claude's doing.
    if (claudeOwned(p.id, by)) g.claude++;
    groups.set(name, g);
  }
  procAt = { at: now, cpu };
  // Ranked by whichever resource it is heavy in, because the process eating the
  // processor and the one eating the memory are rarely the same one.
  const ranked = [...groups.values()].sort((a, b) => (b.ws / os.totalmem() + b.cpu / 100) - (a.ws / os.totalmem() + a.cpu / 100));
  return {
    top: ranked.slice(0, PROC_N),
    rest: ranked.slice(PROC_N).reduce((a, g) => ({ n: a.n + g.n, ws: a.ws + g.ws, cpu: a.cpu + g.cpu }), { n: 0, ws: 0, cpu: 0 }),
    net: netRate(got.net, now),
    disk: got.disk,
  };
}

// Interfaces count bytes since boot, so a rate is two readings and the time
// between them. A counter that went backwards is an adapter that was reset, and
// the answer to that is to wait for the next pair rather than to report a number
// the size of the machine's uptime.
let netAt = null;

function netRate(now2, now) {
  const was = netAt;
  if (!now2) return null;
  netAt = { at: now, rx: now2.rx, tx: now2.tx };
  const span = was ? (now - was.at) / 1000 : 0;
  if (!was || span <= 0 || now2.rx < was.rx || now2.tx < was.tx) return null;
  return { rx: (now2.rx - was.rx) / span, tx: (now2.tx - was.tx) / span };
}

// Columns are padded before they are coloured: an escape sequence has no width,
// and padEnd counts it anyway.
const cell = (s, w, right) => (right ? String(s).padStart(w) : String(s).padEnd(w));

function procRows() {
  const d = slow('procs', PROC_TTL, processes);
  if (!d || !d.top.length) return [];
  const row = (g, tag) => ({
    text: '  ' + cell(clip(g.name, 16), 15) + dim(cell(g.n > 1 ? '×' + g.n : '', 5))
      + cell(weigh(g.ws), 6, true) + cell(Math.round(g.cpu) + '%', 6, true) + '  ' + tag,
  });
  return [
    { text: dim('  ' + cell('', 20) + cell('RAM', 6, true) + cell('CPU', 6, true)) },
    ...d.top.map((g) => row(g, !g.claude || g.name === 'claude' ? ''
      : sgr('36', 'claude' + (g.claude < g.n ? ' ×' + g.claude : '')))),
    ...(d.rest.n ? [{ text: dim(strip(row({ ...d.rest, name: 'решта' }, '').text)) }] : []),
  ];
}

// Open a link or a file with whatever the OS has registered for it. On Windows
// this stays away from `cmd /c start`: these targets come out of a transcript,
// and cmd reads an & or a | inside one as its own syntax. rundll32 takes the
// string as a single argument and never parses it.
function openExternal(target) {
  const safe = target.startsWith('http://') || target.startsWith('https://') || fs.existsSync(target);
  if (!safe) return;
  const child = process.platform === 'win32'
    ? spawn('rundll32', ['url.dll,FileProtocolHandler', target], { detached: true, stdio: 'ignore' })
    : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { detached: true, stdio: 'ignore' });
  child.unref();
}

// ---- opening a session in a new Warp tab ----
// warp:// carries no parameters, so the tab config is rewritten just before the
// URI is fired. Windows path per Warp docs; the file name is the URI name.
// Where Warp keeps tab configs, which is a different place on each platform.
function tabDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'warp', 'Warp', 'data', 'tab_configs');
  }
  if (process.platform === 'darwin') return path.join(HOME, '.warp', 'tab_configs');
  return path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'warp-terminal', 'tab_configs');
}
const TABDIR = tabDir();
const TABNAME = 'claude-resume';

// ---- Ghostty ----
// Ghostty cannot describe a split layout anywhere: not in its config, not on a
// keybind — a chained keybind runs every action against the pane that had focus
// when it started, so "split, then type into the split" is impossible by
// design. It has no URI scheme, and its CLI cannot reach a running instance on
// macOS; that was prototyped and declined. What it has, since 1.3, is
// AppleScript that can split a terminal and type into the result. That is the
// entire mechanism, and everything below is built on those two verbs.
// Which terminal is on the other side decides how a session opens, and guessing
// it wrong fails the way everything else here warns about: no split, no tab, no
// error. So the guess is made from more than one signal — `TERM_PROGRAM`, or any
// variable the terminal stamps on its own shells — and `SIDEBAR_TERMINAL=ghostty`
// or `=warp` overrides the lot when a terminal turns out to say something new.
const FORCED = (process.env.SIDEBAR_TERMINAL || '').toLowerCase();
const stamped = (prefix) => Object.keys(process.env).some((k) => k.startsWith(prefix));
const GHOSTTY = FORCED
  ? FORCED === 'ghostty'
  : /ghostty/i.test(process.env.TERM_PROGRAM || '') || stamped('GHOSTTY_');
const WARP = FORCED
  ? FORCED === 'warp'
  : /warp/i.test(process.env.TERM_PROGRAM || '') || stamped('WARP_');
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const osaStr = (s) => '"' + String(s).replace(/["\\]/g, '\\$&') + '\\n"';

function ghosttyScript(cmd, direction) {
  return [
    'tell application "Ghostty"',
    '  set t to focused terminal of selected tab of front window',
    '  set s to split t direction ' + direction,
    '  input text ' + osaStr(cmd) + ' to s',
    'end tell',
  ].join('\n');
}

// What osascript says when it refuses, kept so the pane can show it. This is the
// one call in the program that fails for a reason a person has to act on —
// macOS withholding permission to drive Ghostty, or a Ghostty too old to have
// `split` — and it says so on stderr and nowhere else.
let openError = null;

function ghosttySplit(cmd, direction) {
  capture('osascript', ['-e', ghosttyScript(cmd, direction)]).then((r) => {
    openError = r.code === 0 ? null : (r.err.trim().split('\n')[0] || 'osascript: код ' + r.code);
    try { draw(); } catch { }
  });
}

// A one-command answer to "the click does nothing": everything the pane decides
// in silence, said out loud, and then the mechanism actually exercised.
function check() {
  console.log('TERM_PROGRAM      ' + (process.env.TERM_PROGRAM || '(порожньо)'));
  const marks = Object.keys(process.env).filter((k) => /^(GHOSTTY|WARP)_/.test(k)).sort();
  console.log('змінні термінала  ' + (marks.length ? marks.slice(0, 5).join(', ') : '(жодної)'));
  console.log('SIDEBAR_TERMINAL  ' + (process.env.SIDEBAR_TERMINAL || '(не задано)'));
  console.log('розпізнано        ' + (GHOSTTY ? 'Ghostty' : WARP ? 'Warp' : 'нічого — сесії не відкриватимуться'));
  if (!GHOSTTY) {
    console.log('');
    console.log('Спліт перевіряю лише під Ghostty. Якщо ти в ньому, а тут написано інше —');
    console.log('запусти ще раз як: SIDEBAR_TERMINAL=ghostty node sidebar.js --check');
    return;
  }
  const r = spawnSync('osascript', ['-e', ghosttyScript("echo 'sidebar ok'", 'right')], { encoding: 'utf8' });
  console.log('');
  console.log('osascript код     ' + r.status);
  if (r.error) console.log('запуск            ' + r.error.message);   // no osascript at all
  if ((r.stdout || '').trim()) console.log('вивід             ' + r.stdout.trim());
  if ((r.stderr || '').trim()) console.log('помилка           ' + r.stderr.trim());
  console.log('');
  console.log(r.status === 0
    ? 'Праворуч мав відкритись спліт зі словами «sidebar ok». Якщо його немає — AppleScript'
      + '\nвідпрацював, але Ghostty нічого не зробив, і це вже питання до його версії.'
    : 'Спліт не відкрився, і текст помилки вище — відповідь чому.');
}

// Claude goes into the new pane on the left, so the halves land the way they do
// under Warp and the focus lands where you are about to type. The shell that ran
// this becomes the pane.
function installGhostty(work, target) {
  const file = target || path.join(HOME, '.local', 'bin', 'claude-sidebar');
  const body = [
    '#!/bin/sh',
    '# Claude Code with the sidebar beside it. Written by `sidebar.js --install`;',
    '# rerun that rather than editing the paths here.',
    'osascript -e ' + shq(ghosttyScript('cd ' + shq(work) + ' && claude', 'left')) + ' >/dev/null',
    'exec node ' + shq(path.join(__dirname, path.basename(__filename))),
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  fs.chmodSync(file, 0o755);
  console.log("Записано " + file);
  console.log("Claude стартуватиме в " + work);
  console.log("Відкрий новий таб у Ghostty і запусти: " + file);
  console.log("Якщо " + path.dirname(file) + " не в PATH — додай, і команда зватиметься claude-sidebar.");
  console.log("Перший запуск попросить дозвіл на автоматизацію Ghostty — це AppleScript, інакше спліт не відкриється.");
}

// The paths inside a tab config are absolute, so one committed to a repo is only
// ever right on the machine that wrote it. `--install` writes the config for
// wherever this copy actually landed, which is the whole of the setup.
function install(where, target) {
  const work = path.resolve(where || path.dirname(__dirname));
  if (GHOSTTY) return installGhostty(work, target);
  const toml = [
    "name = 'Claude + sidebar'",
    '',
    '[[panes]]',
    "id = 'root'",
    "split = 'horizontal'",
    "children = ['claude', 'sidebar']",
    '',
    '[[panes]]',
    "id = 'claude'",
    "type = 'terminal'",
    `directory = '${work}'`,
    "commands = ['claude']",
    'is_focused = true',
    '',
    '[[panes]]',
    "id = 'sidebar'",
    "type = 'terminal'",
    `directory = '${__dirname}'`,
    `commands = ['node ${path.basename(__filename)}']`,
    '',
  ].join('\n');
  fs.mkdirSync(TABDIR, { recursive: true });
  fs.writeFileSync(path.join(TABDIR, 'claude.toml'), toml, 'utf8');
  console.log("Записано " + path.join(TABDIR, 'claude.toml'));
  console.log("Claude стартуватиме в " + work);
  console.log("Відкрий меню поруч із + у Warp — там зʼявився «Claude + sidebar».");
  if (!WARP) {
    console.log("Термінал не розпізнано, тому записано конфіг для Warp.");
    console.log("Для Ghostty: SIDEBAR_TERMINAL=ghostty node sidebar.js --install " + work);
  }
}

// The newest cwd in a transcript, not the oldest. Every session here is started
// in the directory that holds every repo and then cd's into the one it actually
// works in, so the first entry names no project and the last one does. Reading
// the head instead is how the panel came to report `GitHub, не git, >15.9G` for
// whatever session was live.
function cwdOf(s) {
  try {
    const size = fs.statSync(s.path).size;
    const from = Math.max(0, size - 65536);
    const lines = readSlice(s.path, from, Math.min(size, 65536)).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let d; try { d = JSON.parse(lines[i]); } catch { continue; }  // incl. the half-cut first line
      if (d.cwd && fs.existsSync(d.cwd)) return d.cwd;
    }
  } catch { }
  return process.cwd();
}

function openInTab(s) {
  const dir = cwdOf(s);
  // Ghostty has no tab config to write and nothing to fire a URI at, so the
  // session opens as a split of the window you are already in.
  if (GHOSTTY) {
    const cmd = 'cd ' + shq(dir) + ' && claude --resume ' + s.id;
    if (!process.env.SIDEBAR_NO_LAUNCH) ghosttySplit(cmd, 'right');
    return cmd;
  }
  const title = (s.title || s.id.slice(0, 8)).replace(/'/g, '').slice(0, 60);
  // TOML literal strings: no escaping, which is what Windows paths need
  // The same split the pane itself was opened in: the resumed session gets its
  // own companion rather than sending you back here to change what this one
  // watches.
  const toml = [
    "name = 'Claude · resume'",
    `title = '${title}'`,
    '',
    '[[panes]]',
    "id = 'root'",
    "split = 'horizontal'",
    "children = ['claude', 'sidebar']",
    '',
    '[[panes]]',
    "id = 'claude'",
    "type = 'terminal'",
    `directory = '${dir}'`,
    `commands = ['claude --resume ${s.id}']`,
    'is_focused = true',
    '',
    '[[panes]]',
    "id = 'sidebar'",
    "type = 'terminal'",
    `directory = '${__dirname}'`,
    // The id, so the new pane watches the session this tab was opened for
    // rather than guessing from whoever takes the next turn.
    `commands = ['node ${path.basename(__filename)} ${s.id}']`,
    '',
  ].join('\n');
  fs.mkdirSync(TABDIR, { recursive: true });
  fs.writeFileSync(path.join(TABDIR, TABNAME + '.toml'), toml, 'utf8');
  const uri = 'warp://tab_config/' + TABNAME;
  if (process.env.SIDEBAR_NO_LAUNCH) return uri;   // write the config, skip the URI
  // Warp puts the tab in whatever window is active when the URI lands, and the
  // window holding this pane is not always that one — a second window opens and
  // fills itself from the restored session, which reads as a duplicate. Warp
  // hands every pane a URI pointing at itself, so raising this one first settles
  // the question before the tab config asks it.
  const focus = process.env.WARP_FOCUS_URL;
  if (focus) fireURI(focus);
  setTimeout(() => fireURI(uri), focus ? 250 : 0);
  return uri;
}

// rundll32 rather than `cmd /c start`: start puts a console window on screen
// before the URI ever reaches Warp, and that window taking the foreground is
// itself a change of which window is active.
function fireURI(uri) {
  const child = process.platform === 'win32'
    ? spawn('rundll32', ['url.dll,FileProtocolHandler', uri], { detached: true, stdio: 'ignore', windowsHide: true })
    : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [uri], { detached: true, stdio: 'ignore' });
  child.unref();
}

// ---- what a session spent ----
// Every other reader here takes the newest slice of a transcript. This one takes
// all of it, because the question — where did the tokens and the minutes go — is
// answered across the whole file. A hundred megabytes is six hundred
// milliseconds of parsing, and six hundred milliseconds of parsing on this
// thread is six hundred milliseconds of frozen pane, so it goes eight megabytes
// at a time and yields in between. It runs only while the screen showing it is
// open.
const STAT_TTL = 30 * 1000;
const STAT_CHUNK = 8 * 1024 * 1024;


function newStats() {
  return {
    turns: 0, out: 0, think: 0, read: 0, wrote: 0, ctx: 0, model: '', bytes: 0, from: 0, to: 0,
    tools: new Map(), open: new Map(),
    // Per turn, so the screen can draw the session rather than sum it: where the
    // context grew and where it was cut back, and when the work actually
    // happened as against when the session was open.
    marks: [], rounds: [], base: 0, toolChars: 0, errs: new Map(), reads: new Map(),
  };
}

// A round is one thing asked and everything the model did about it. The
// transcript marks it with a user message that is not a tool result and not one
// of the reminders the harness injects, which all arrive wrapped in a tag.
function askedIn(m) {
  const c = m.content;
  // Every text block, not the first: a message with a screenshot in it arrives
  // as the path in one block and the words in another, and the words are the ask.
  const s = typeof c === 'string' ? c
    : Array.isArray(c) ? c.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join(' ') : '';
  const text = String(s)
    .replace(/<[^>]*>[\s\S]*?<\/[^>]*>/g, ' ')
    .replace(/\[Image[^\]]*\]/g, '▣')
    .replace(/\s+/g, ' ').trim();
  // The harness echoes a pasted screenshot as a second message holding nothing
  // but its path. That is the same ask arriving twice, and counting it as a new
  // one takes the turns off the message that actually asked something.
  if (/^\s*\[Image: source:[^\]]*\]\s*$/.test(String(s))) return null;
  if (!text || text.startsWith('<')) return null;
  const words = text.replace(/▣/g, ' ').replace(/\s+/g, ' ').trim();
  return words || '▣';                    // a screenshot with nothing said is still an ask
}

// What a call was about, in the few words its input carries. It is kept for
// every open call because the result that makes it expensive arrives later.
function briefOf(name, inp) {
  const v = inp.command || inp.description || inp.file_path || inp.pattern || inp.query || inp.url || inp.prompt || '';
  return String(v).replace(/\s+/g, ' ').trim().slice(0, 120);
}

function toolOf(s, name) {
  let e = s.tools.get(name);
  if (!e) s.tools.set(name, (e = { name, calls: 0, bytes: 0, ms: 0, errors: 0 }));
  return e;
}

// What went wrong, in the words the tools actually use. Every pattern here was
// read out of transcripts on this machine rather than imagined: the anchor drift
// that Edit reports, the stale-read guard, the shell quoting that dies on an
// unexpected EOF, and the exceptions a script throws back through Bash. The
// order matters — the first match wins, and the specific ones come first.
const ERRORS = [
  ['якір Edit не знайдено', /String to replace not found|old_string/i],
  ['файл змінився після читання', /has been modified since|has not been read yet/i],
  ['нема файла або шляху', /No such file|cannot find|ENOENT|does not exist/i],
  ['синтаксис у команді', /unexpected EOF|syntax error|unexpected token|parse error/i],
  ['виняток у скрипті', /Traceback|node:internal|SyntaxError|ReferenceError|TypeError|AssertionError/i],
  ['заблоковано', /Blocked:|permission denied|EACCES|not permitted|refused/i],
  ['відмова людини', /want to proceed|user rejected|declined/i],
  ['таймаут', /timed out|ETIMEDOUT|timeout/i],
];

function classify(text) {
  for (const [name, re] of ERRORS) if (re.test(text)) return name;
  return 'інше';
}

// A tool result is a string on some calls and a list of blocks on others, and
// its length is the closest thing to what it cost: four characters to the token,
// near enough to rank on.
function resultSize(c) {
  if (typeof c === 'string') return c.length;
  if (!Array.isArray(c)) return 0;
  let n = 0;
  for (const b of c) n += b && typeof b.text === 'string' ? b.text.length : 0;
  return n;
}

function statLine(s, line) {
  let d; try { d = JSON.parse(line); } catch { return; }
  const t = Date.parse(d.timestamp || '') || 0;
  if (t) { s.from = s.from ? Math.min(s.from, t) : t; s.to = Math.max(s.to, t); }
  const m = d.message || {};
  if (d.type === 'user') {
    const asked = askedIn(m);
    if (asked) s.rounds.push({ at: t, text: asked, out: 0, wrote: 0, turns: 0, ctx0: s.ctx, ctx: s.ctx });
  }
  const u = m.usage;
  if (u) {
    s.turns++;
    s.out += u.output_tokens || 0;
    s.think += (u.output_tokens_details || {}).thinking_tokens || 0;
    s.read += u.cache_read_input_tokens || 0;
    s.wrote += u.cache_creation_input_tokens || 0;
    // The newest turn's prompt is the context as it stands: what was sent fresh,
    // what came from cache, and what was written into it.
    s.ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (m.model) s.model = String(m.model).replace(/^claude-/, '');
    s.marks.push({ t, ctx: s.ctx, out: u.output_tokens || 0, err: 0 });
    // The first prompt of a session is everything that is in the window before
    // anything is said: the system prompt, every tool definition, the memory
    // files. Nothing later can separate those out, and this measures them.
    if (!s.base) s.base = s.ctx;
    const r = s.rounds[s.rounds.length - 1];
    if (r) {
      r.turns++;
      r.out += u.output_tokens || 0;
      r.wrote += u.cache_creation_input_tokens || 0;
      r.ctx = s.ctx;
      r.to = t;
    }
  }
  if (!Array.isArray(m.content)) return;
  for (const b of m.content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'tool_use') {
      toolOf(s, b.name || '?').calls++;
      if (b.id) s.open.set(b.id, { name: b.name || '?', at: t, brief: briefOf(b.name || '', b.input || {}), file: (b.input || {}).file_path || '' });
    } else if (b.type === 'tool_result') {
      const was = s.open.get(b.tool_use_id);
      const e = toolOf(s, was ? was.name : '?');
      const bytes = resultSize(b.content);
      let ms = 0;
      if (was) {
        ms = t && was.at ? Math.max(0, t - was.at) : 0;
        e.ms += ms;
        s.open.delete(b.tool_use_id);
      }
      e.bytes += bytes;
      s.toolChars += bytes;
      if (b.is_error) {
        e.errors++;
        if (s.marks.length) s.marks[s.marks.length - 1].err++;
        const text = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map((x) => (x && x.text) || '').join(' ') : '';
        const kind = classify(text);
        const cur = s.errs.get(kind) || { kind, n: 0, tool: '', sample: '' };
        cur.n++;
        cur.tool = was ? was.name : cur.tool;
        // The first line of the first one is enough to recognise it; the rest is
        // a stack trace, and a stack trace in a pane is a wall.
        if (!cur.sample) cur.sample = text.replace(/\s+/g, ' ').replace(/^<tool_use_error>/, '').trim().slice(0, 160);
        s.errs.set(kind, cur);
      }
      // The same file read twice is the same tokens paid for twice. It is the
      // cheapest waste there is to see and the easiest to miss.
      if (was && was.file && /^(Read|NotebookRead)$/.test(was.name)) {
        const r = s.reads.get(was.file) || { n: 0, bytes: 0 };
        r.n++;
        r.bytes += bytes;
        s.reads.set(was.file, r);
      }
    }
  }
}

async function statsOf(file) {
  let size; try { size = fs.statSync(file).size; } catch { return null; }
  const s = newStats();
  let off = 0;
  let carry = '';
  while (off < size) {
    const len = Math.min(STAT_CHUNK, size - off);
    const chunk = carry + readSlice(file, off, len);
    off += len;
    const lines = chunk.split('\n');
    carry = off < size ? lines.pop() || '' : '';
    for (const l of lines) if (l.trim()) statLine(s, l);
    await new Promise((r) => setImmediate(r));
  }
  s.bytes = size;
  return s;
}

// ---- rendering ----
// COLUMNS and LINES are the fallback when stdout is not a terminal, which is how
// the layout gets measured at sizes nobody has a window for.
const W = () => Math.max(28, (process.stdout.columns || +process.env.COLUMNS || 60) - 1);
const H = () => Math.max(10, process.stdout.rows || +process.env.LINES || 24);

// Truncate to `w` visible columns with the ANSI codes left intact. A row wider
// than the pane wraps, a wrapped row costs two screen lines, and from there
// every click below it lands one row off. Nothing reaches the screen unclipped.
function clip(s, w) {
  let out = '', cut = '', n = 0, i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) === 27) {              // an escape costs no width
      const j = s.indexOf('m', i);
      if (j < 0) break;
      out += s.slice(i, j + 1); i = j + 1; continue;
    }
    if (s.charCodeAt(i) < 32) { i++; continue; }  // a newline inside a row would
                                                  // split it into two screen rows
    if (n === w - 1) cut = out;                // where the ellipsis would go
    if (n === w) return cut + dim('…');        // there is more than fits
    out += s[i]; n++; i++;
  }
  return out;                                  // it ended within the width
}

// Give every block the rows it asks for while there are enough, and split what
// is left evenly when there are not. Modest blocks are satisfied first, so two
// images never cost a long file list a quarter of the pane.
function share(wants, total) {
  const room = wants.map(() => 0);
  let left = total;
  let open = wants.map((_, i) => i).filter((i) => wants[i] > 0);
  while (left > 0 && open.length) {
    const each = Math.max(1, Math.floor(left / open.length));
    let spent = 0;
    for (const i of open) {
      const give = Math.min(each, wants[i] - room[i], left - spent);
      if (give > 0) { room[i] += give; spent += give; }
    }
    if (!spent) break;
    left -= spent;
    open = open.filter((i) => room[i] < wants[i]);
  }
  return room;
}

function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'зараз';
  if (m < 60) return m + ' хв';
  const h = Math.floor(m / 60);
  return h < 24 ? h + ' год' : Math.floor(h / 24) + ' дн';
}

function rule(title, count) {
  const w = W();
  // An empty count is a block that has nothing to count — the chart — and it
  // takes no space in the rule at all.
  const plain = '── ' + title + (count ? ' ' + count : '') + ' ';
  return dim('── ') + head(title) + (count ? dim(' ' + count) : '') + ' ' + dim('─'.repeat(Math.max(0, w - plain.length)));
}

function shorten(p, w, base) {
  let s = p;
  if (base && s.toLowerCase().startsWith(base.toLowerCase())) s = s.slice(base.length).replace(/^[\\/]/, '');
  s = s.replace(/\\/g, '/');
  const h = HOME.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  s = s.replace(new RegExp('^' + h, 'i'), '~');
  if (s.length <= w) return s;
  const tail = s.split('/').slice(-2).join('/');
  return tail.length <= w - 2 ? '…/' + tail : '…' + s.slice(-(w - 1));
}

const hhmm = (t) => (t ? new Date(t).toTimeString().slice(0, 5) : '  :  ');
const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + 'M' : Math.max(1, Math.round(n / 1024)) + 'K');
// Directory weights run to gigabytes, and a tenth of one is as much precision as
// anybody acts on.
const weigh = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(1) + 'G' : n >= 1048576 ? Math.round(n / 1048576) + 'M' : Math.max(1, Math.round(n / 1024)) + 'K');

function when(ms) {
  const d = new Date(ms);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (d >= today) return 'сьогодні ' + d.toTimeString().slice(0, 5);
  if (d >= new Date(+today - 86400000)) return 'вчора    ' + d.toTimeString().slice(0, 5);
  return d.toISOString().slice(5, 10).replace('-', '.') + '    ' + d.toTimeString().slice(0, 5);
}

// What a click on a row should open, and which block each row belongs to, both
// keyed by that row's index in the output array. Screen rows are 1-based, so a
// click at row y looks up index y - 1 in either.
let rowHits = {};
let blockAt = {};

// Each block keeps its own scroll offset across redraws. That is what lets the
// wheel move the block under the pointer while the rest of the pane stays put.
const scroll = {};
const LIST = 'SESSIONS';
const ALIVE = 'ЖИВІ';

// One block: its rule, then as many item rows as `room` allows, starting at this
// block's own offset. Items are { text, open?, session? }. `focus`, when given,
// drags the offset until that item is on screen — the picker's cursor.
function panel(out, key, label, items, room, count, focus, empty) {
  const max = Math.max(0, items.length - room);
  let off = Math.min(Math.max(0, scroll[key] || 0), max);
  if (focus != null) {
    if (focus < off) off = focus;
    if (focus >= off + room) off = focus - room + 1;
    off = Math.min(Math.max(0, off), max);
  }
  scroll[key] = off;
  // rule() pads by the plain length of what it is given, so the tag stays free
  // of colour codes.
  const tag = (count != null ? count : items.length)
    + (max > 0 ? ' ' + (off + 1) + '–' + Math.min(items.length, off + room) : '');
  blockAt[out.length] = key;
  out.push(clip(rule(label, tag), W()));
  if (!items.length) { blockAt[out.length] = key; out.push(clip(dim('  ' + (empty || '(порожньо)')), W())); return; }
  for (const it of items.slice(off, off + room)) {
    if (it.open) rowHits[out.length] = { open: it.open };
    if (it.chart) rowHits[out.length] = { chart: true };
    if (it.session != null) rowHits[out.length] = { session: it.session };
    if (it.pick) rowHits[out.length] = { pick: it.pick };
    blockAt[out.length] = key;
    out.push(clip(it.text, W()));
  }
}

// Lay the blocks out so the whole pane fits: one row per rule, the rest shared
// by appetite. What does not fit scrolls inside its own block rather than
// pushing the footer off the bottom of the screen.
// A blank row above every block but the first, so the rules read as separators
// rather than as more rows. The gap is charged to the budget with the headers,
// and belongs to the block above it, so the wheel still works when the pointer
// lands in the space.
function layout(out, blocks, avail) {
  const wants = blocks.map((b) => (b.want != null ? b.want : Math.max(1, b.items.length)));
  const room = share(wants, Math.max(0, avail - blocks.length * 2 + 1));
  blocks.forEach((b, i) => {
    if (i) { blockAt[out.length] = blocks[i - 1].key; out.push(''); }
    panel(out, b.key, b.label, b.items, room[i], b.count, b.focus, b.empty);
  });
}

// Reading a transcript's tail to see what it is doing is only worth it for a
// session that moved recently. Older ones are cold by definition.
function stateFor(s) {
  return Date.now() - s.mtime > RECENT ? { waiting: false, tool: null, agent: null } : stateOf(s);
}

function iconFor(s, st) {
  const age = Date.now() - s.mtime;
  if (age > RECENT) return dim('○');
  if (st.agent) return sgr('1;36', '◉');       // an agent is out; the session is not idle
  if (st.waiting) return sgr('1;33', '◐');
  return age < 90000 ? sgr('1;32', '●') : sgr('33', '◑');
}

// One row of the live-sessions block: what the session is, how long since it
// moved, and either the tool it is running or the fact that it stopped and is
// waiting for you.
function activeRow(s, self) {
  const st = s.state || stateFor(s);
  const stamp = ago(Date.now() - s.mtime).padStart(5);
  const room = Math.max(10, Math.floor((W() - 12) * 0.5));
  const name = (s.title || projOf(s) || s.id.slice(0, 8)).slice(0, room).padEnd(room);
  const note = st.agent ? sgr('36', 'агент ' + (st.agent.at ? ago(Date.now() - st.agent.at) : 'в роботі'))
    : st.waiting ? sgr('33', 'чекає на тебе') : dim(st.tool || 'працює');
  // The pane holds one session and no longer swaps to whoever moved last, so
  // which row it is holding has to be readable at a glance, not inferred from
  // a shade of the name.
  return (self ? sgr('1;36', '▸') : ' ') + iconFor(s, st) + ' ' + dim(stamp) + '  ' + (self ? sgr('1;36', name) : name) + '  ' + note;
}

function pickRow(s, on) {
  const st = stateFor(s);
  const line = ' ' + iconFor(s, st) + ' ' + dim(when(s.mtime)) + '  ' + (s.title || '(без назви) ' + s.id.slice(0, 8));
  return on ? sgr('7', strip(line)) : line;
}

// The three blocks a session's body is made of, as items rather than lines, so
// the layout can decide how many of each actually fit. Long values are left
// whole here — clip() cuts them to the pane's width as they are printed.
// Of everything a session writes, three kinds are worth a click: notes to read,
// pages to look at, screenshots to check. Sources, configs, probe scripts and
// the half-guessed paths that come out of shell commands are the work itself,
// and the row that says a file was touched forty-seven times says nothing you
// can act on. The filter is here rather than in `noteFile`, because `repoOf`
// places a session by every path it touched, most of them source.
const KEEP = /\.(md|html?|png|jpe?g|gif|webp|svg|pdf)$/i;

// One file reaches the transcript under several names — absolute from an Edit,
// relative from a shell line — and on a list this short, two rows for one file
// is half the block. Rows that read the same are the same file; the absolute
// spelling is the one kept, because it is the one that opens. A row opens its
// file, and plenty of the paths guessed out of shell commands do not exist —
// openExternal is what says no.
function fileRows(st, w, base) {
  const by = new Map();
  for (const [p, meta] of [...st.files.entries()].sort((a, b) => (b[1].t > a[1].t ? 1 : -1))) {
    if (!KEEP.test(p)) continue;
    const label = shorten(p, w - 12, base);
    const cur = by.get(strip(label));
    if (!cur) by.set(strip(label), { p, text: '  ' + dim(hhmm(meta.t)) + ' ' + label });
    else if (path.isAbsolute(p) && !path.isAbsolute(cur.p)) cur.p = p;
  }
  return [...by.values()].map(({ p, text }) => ({ open: p, text: TEMP.test(p) ? dim(strip(text)) : text }));
}

function bodyItems(st, base) {
  const w = W();
  return {
    media: (st.media || []).map((m) => ({
      open: m.full,
      text: '  ' + sgr('36', m.name) + dim('  ' + kb(m.size)) + dim('  ' + shorten(m.full, w - 20, base)),
    })),
    files: fileRows(st, w, base),
    links: [...st.links.entries()]
      .sort((a, b) => (b[1] > a[1] ? 1 : -1))
      .map(([u]) => ({ open: u, text: '  ' + sgr('4;34', u) })),
  };
}

// One chart with three lines on it rather than three bars beside each other:
// the same grid, the newest sample at the right edge, so a build that takes the
// machine shows up as one shape instead of three. Five ways to draw the same
// history, because which one reads best depends on the pane and on what is
// being watched: `v` cycles them, and so does a click on the chart.
const CHART_MODES = ['колонки', 'лінії', 'брайль', 'тепло', 'тепло ×2'];
let chartMode = 0;

const SERIES = [
  { key: 'cpu', label: 'CPU', colour: '33' },
  { key: 'ram', label: 'RAM', colour: '36' },
  { key: 'vram', label: 'VRAM', colour: '32' },
  // Traffic has no ceiling to be a percentage of, so its line is scaled to the
  // busiest moment on show. It is the shape that carries — a download starting,
  // a build pulling packages — and the legend carries the actual rate.
  { key: 'net', label: 'NET', colour: '35', auto: true },
];

function seriesData(s, n) {
  const raw = load[s.key].slice(-n);
  if (!s.auto) return raw;
  const peak = Math.max(...raw, 1);
  return raw.map((v) => v / peak);
}

// Lines, not marks: a run along a row where the reading holds, a corner where it
// turns, a stem down the rows it jumped. One column is one sample, so the chart
// reaches back as far as the pane is wide, and a cell belongs to whichever
// series drew on it first — a line that disappears under another reads as a
// reading that disappeared.
// The grid every line chart in the pane is drawn on. Values arrive between 0 and
// 1 and come out as box drawing: a run along a row where the reading holds, a
// corner where it turns, a stem down the rows it jumped. A cell belongs to
// whichever series drew on it first — a line that disappears under another reads
// as a reading that disappeared.
function lineGrid(list, h, n) {
  const cells = Array.from({ length: h }, () => new Array(n).fill(null));
  const put = (r, c, ch, colour) => {
    if (r >= 0 && r < h && c >= 0 && c < n && !cells[r][c]) cells[r][c] = { ch, colour };
  };
  for (const s of list) {
    const data = s.data;
    const from = n - data.length;             // a short history starts mid-grid
    const at = (v) => Math.max(0, Math.min(h - 1, Math.round((1 - v) * (h - 1))));
    data.forEach((v, i) => {
      const y = at(v);
      const p = i ? at(data[i - 1]) : y;
      if (p === y) return put(y, from + i, '─', s.colour);
      put(p, from + i, p < y ? '╮' : '╯', s.colour);
      put(y, from + i, p < y ? '╰' : '╭', s.colour);
      for (let r = Math.min(p, y) + 1; r < Math.max(p, y); r++) put(r, from + i, '│', s.colour);
    });
  }
  return cells;
}

// The axis carries the scale, so the grid behind the lines can stay empty. Its
// top label is whatever the full height means for this chart.
function gridRows(cells, top, extra) {
  const h = cells.length;
  const mid = h >> 1;
  return cells.map((row, r) => Object.assign({
    text: '  ' + dim(r === 0 ? cell(top, 4, true) : r === h - 1 ? '   0' : '    ')
      + dim(r === 0 || r === mid || r === h - 1 ? '┤' : '│')
      + row.map((c) => (c ? sgr(c.colour, c.ch) : ' ')).join(''),
  }, extra || {}));
}

function chart(h, n) {
  return gridRows(lineGrid(SERIES.map((s) => ({ data: seriesData(s, n), colour: s.colour })), h, n), '100%', { chart: true });
}

// Columns answer a different question than the lines do: not which part of the
// machine was busy, but how hard each part was being pushed. So every series
// gets its own band with its own floor — a memory leak does not hide under a
// busy processor — a column in it is one sample, and its colour is how close
// that reading came to the ceiling. Green while there is room, amber once the
// machine is working for it, red at the wall. Traffic has no ceiling to be
// graded against and keeps its own colour, its height read against the busiest
// moment on show. Eighth-blocks carry eight levels in a row, so a band one row
// tall is still a chart, and an idle series draws a floor rather than a gap.
const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const GRADE = (v) => (v >= 0.9 ? '1;31' : v >= 0.8 ? '31' : v >= 0.6 ? '33' : '32');

function barCell(v, r, h) {
  const level = v * h;                        // how many rows tall this column is
  const base = h - 1 - r;                     // whole rows under this one
  if (level >= base + 1) return '█';
  if (level <= base && base) return ' ';
  return BARS[Math.max(0, Math.min(7, Math.round((level - base) * 8) - 1))];
}

function columns(h, n) {
  const list = SERIES.filter((s) => load[s.key].length);
  const band = Math.max(1, Math.floor(h / list.length));
  const w = n - 1;                            // the label is a column wider than the chart's axis
  const rows = [];
  for (const s of list) {
    const data = seriesData(s, w);
    const pad = ' '.repeat(Math.max(0, w - data.length));   // a short history starts mid-band
    for (let r = 0; r < band; r++) {
      rows.push({
        chart: true,
        text: '  ' + dim(r ? '    ' : s.label.padEnd(4)) + ' ' + pad + data.map((v) => {
          const ch = barCell(v, r, band);
          return ch === ' ' ? ch : sgr(s.auto ? s.colour : GRADE(v), ch);
        }).join(''),
      });
    }
  }
  return rows;
}

// Braille packs four rows of dots into a cell, so the same eight rows carry
// thirty-two levels and two samples a column. It reads as a denser, dottier
// version of the same chart — worth having when the numbers are close together
// and the lines would sit on top of each other.
const DOT = [[1, 2, 4, 64], [8, 16, 32, 128]];

function braille(h, n) {
  const cells = Array.from({ length: h }, () => new Array(n).fill(null));
  const top = h * 4 - 1;
  const put = (dx, dy, colour) => {
    const row = cells[dy >> 2];
    const cur = row[dx >> 1] || { bits: 0, colour };
    cur.bits |= DOT[dx & 1][dy & 3];
    row[dx >> 1] = cur;
  };
  for (const s of SERIES) {
    const data = seriesData(s, n * 2);
    const from = n * 2 - data.length;
    let prev = null;
    data.forEach((v, i) => {
      const y = Math.max(0, Math.min(top, Math.round((1 - v) * top)));
      for (let d = Math.min(y, prev == null ? y : prev); d <= Math.max(y, prev == null ? y : prev); d++) put(from + i, d, s.colour);
      prev = y;
    });
  }
  const mid = h >> 1;
  return cells.map((row, r) => ({
    chart: true,
    text: '  ' + dim(r === 0 ? '100' : r === mid ? ' 50' : r === h - 1 ? '  0' : '   ')
      + dim(r === 0 || r === mid || r === h - 1 ? '┤' : '│')
      + row.map((c) => (c ? sgr(c.colour, String.fromCharCode(0x2800 + c.bits)) : ' ')).join(''),
  }));
}

// The same history as colour instead of position: a row per series, a column a
// sample, dark blue idle through to red pinned. Three rows instead of nine, and
// three series that never cross each other.
const HEAT = [17, 18, 20, 26, 32, 38, 44, 49, 83, 119, 154, 190, 220, 214, 208, 196];
const STOPS = [[20, 30, 70], [30, 120, 200], [60, 200, 140], [230, 210, 60], [220, 60, 50]];

// One cell of colour, the reading carried by the background so a row of them
// reads as a band rather than as characters.
const heatCell = (v) => '\x1b[48;5;' + HEAT[Math.max(0, Math.min(15, Math.round(v * 15)))] + 'm \x1b[0m';

// A row of them, scaled to the busiest value in the row: what is being read is
// which stretches were quiet, and an absolute scale answers that for nobody.
function heatStrip(values, n) {
  const peak = Math.max(...values, 1);
  const cells = values.slice(-n).map((v) => heatCell(v / peak));
  return ' '.repeat(Math.max(0, n - cells.length)) + cells.join('');
}

function heatRGB(v) {
  const x = Math.max(0, Math.min(0.999, v)) * (STOPS.length - 1);
  const [a, b] = [STOPS[Math.floor(x)], STOPS[Math.floor(x) + 1]];
  const k = x % 1;
  return a.map((c, i) => Math.round(c + (b[i] - c) * k)).join(';');
}

// dense packs two samples into one cell, the upper half painted as foreground
// over the lower half as background, which doubles the history a row holds.
function heat(n, dense) {
  n -= 1;                                     // the label is a column wider than the chart's axis
  return SERIES.filter((s) => load[s.key].length).map((s) => {
    const data = seriesData(s, dense ? n * 2 : n);
    const cells = [];
    if (dense) {
      for (let i = 0; i < data.length; i += 2) {
        cells.push('\x1b[38;2;' + heatRGB(data[i]) + 'm\x1b[48;2;' + heatRGB(data[i + 1] == null ? data[i] : data[i + 1]) + 'm▀\x1b[0m');
      }
    } else {
      for (const v of data) cells.push(heatCell(v));
    }
    return { chart: true, text: '  ' + dim(s.label.padEnd(4)) + ' ' + ' '.repeat(Math.max(0, n - cells.length)) + cells.join('') };
  });
}

// The chart takes about a third of the pane, and the numbers sit above it: a
// window too short for the whole block loses its lower rows, and the readings
// are the part worth keeping. The heat rows cost three whatever the window, so
// only the tall views are held back on a short one.
function loadRows() {
  const h = Math.max(3, Math.min(8, Math.round((H() - 2) * 0.3)));
  const n = Math.max(8, Math.min(HIST, W() - 7));
  const note = {
    ram: () => weigh(load.used || os.totalmem() - os.freemem()) + '/' + weigh(os.totalmem()),
    vram: () => (load.gpu ? weigh(load.gpu.used) + '/' + weigh(load.gpu.total) : ''),
  };
  const legend = SERIES.filter((s) => load[s.key].length).map((s) => {
    const v = load[s.key][load[s.key].length - 1];
    const tail = note[s.key] ? note[s.key]() : '';
    // Everything but traffic is a share of something; traffic is a rate.
    const read = s.key === 'net'
      ? (load.rate ? '↓' + weigh(load.rate.rx) + ' ↑' + weigh(load.rate.tx) : '—')
      : Math.round(v * 100) + '%';
    return sgr(s.colour, s.label) + ' ' + read + (tail ? dim(' ' + tail) : '');
  });
  if (load.disk) legend.push(dim('диск ' + weigh(load.disk.free) + ' вільно'));
  // Under about two dozen rows a tall chart would be handed two of them and
  // paint its empty ceiling, so the numbers go on alone.
  const row = { chart: true, text: '  ' + legend.join(dim('  ·  ')) };
  const heavy = procRows();
  // Bands and heat rows cost what they cost whatever the window; only the two
  // views that want a tall grid are held back on a short one.
  const tall = chartMode === 1 || chartMode === 2;
  if (tall && H() < 24) return [row, ...heavy];
  const body = chartMode === 0 ? columns(h, n)
    : tall ? [chart, braille][chartMode - 1](h, n)
      : heat(n, chartMode === 4);
  return [row, ...body, ...heavy];
}

// Where the selected session's work lives and what it has been deployed to.
// Every row here opens in a browser, because losing the address is the whole
// reason the block exists. The folder name rides along only when it differs
// from the repo — a directory renamed out from under its remote is exactly when
// you cannot remember which is which.
const SIZE_TTL = 5 * 60 * 1000;    // a repo does not double in weight in a minute
const GIT_TTL = 15 * 1000;
const ORPHAN_TTL = 60 * 1000;

// Branch, then only what is not in order. A clean tree says so in one word
// rather than in three zeroes.
function gitRow(g) {
  const bits = [];
  if (g.dirty) bits.push(sgr('33', '● змінено ' + g.dirty));
  if (g.ahead) bits.push(sgr('33', '↑' + g.ahead + ' не запушено'));
  if (g.behind) bits.push(dim('↓' + g.behind));
  return '  ' + sgr('1', g.branch) + '  ' + (bits.length ? bits.join('  ') : dim('чисто'));
}

// Commits the way GitHub draws them: a row per weekday, a column per week, the
// current week last. Shade is relative to the busiest day on show, so what reads
// is which weeks were the quiet ones — the question a repo's own history answers
// and its newest commit does not. Cut to the weeks the pane can hold.
const GREEN = [236, 22, 28, 34, 40];
const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'нд'];

function commitMatrix(days) {
  const weeks = Math.max(6, Math.min(Math.ceil(days.length / 7), W() - 8));
  const grid = Array.from({ length: 7 }, () => new Array(weeks).fill(null));
  const todayRow = (new Date().getDay() + 6) % 7;     // Monday first, as the labels are
  days.forEach((n, i) => {
    const back = days.length - 1 - i;
    const col = weeks - 1 - Math.floor((back + (6 - todayRow)) / 7);
    if (col >= 0) grid[((todayRow - back) % 7 + 7) % 7][col] = n;
  });
  const peak = Math.max(1, ...days);
  return grid.map((row, i) => ({
    text: '  ' + dim(WEEKDAYS[i]) + ' '
      + row.map((n) => (n == null ? ' ' : sgr('38;5;' + GREEN[n ? Math.min(4, Math.ceil(n / peak * 4)) : 0], '█'))).join(''),
  }));
}

function projectItems(info) {
  const rows = [];
  const size = slow('size:' + info.dir, SIZE_TTL, () => dirSize(info.dir));
  const weight = dim('  ' + (size ? (size.capped ? '>' : '') + weigh(size.total) : '…'));
  if (info.repo) {
    const folder = info.repo.split('/')[1] === info.name ? '' : dim('  ' + info.name);
    rows.push({ open: 'https://github.com/' + info.repo, text: '  ' + sgr('4;34', 'github.com/' + info.repo) + folder + weight });
  } else {
    rows.push({ text: '  ' + info.name + dim('  не git') + weight });
  }
  if (size && size.blame) rows.push({ text: dim('    з них ' + size.blame.name + '  ' + weigh(size.blame.bytes)) });
  const git = info.git ? slow('git:' + info.dir, GIT_TTL, () => gitState(info.dir)) : null;
  if (git) {
    // The half-year belongs to the repo, above the line where the branch starts,
    // and stands clear of both.
    if (git.days) rows.push({ text: '' }, ...commitMatrix(git.days));
    rows.push({ text: '' });
    rows.push({ text: gitRow(git) });
    if (git.base) rows.push({ text: '    ' + dim('від ' + git.base.name) + '  ' + (git.base.behind ? sgr('33', '↓' + git.base.behind + ' відстала') : dim('свіжа')) + (git.base.ahead ? dim('  ↑' + git.base.ahead + ' своїх') : '') });
    // The tail of the history, newest first, with its age: how long ago work
    // stopped here is the whole of "is this branch still warm". A commit opens
    // on GitHub, where the diff is.
    for (const c of git.log) {
      rows.push({
        open: info.repo ? 'https://github.com/' + info.repo + '/commit/' + c.hash : null,
        text: '    ' + dim(c.graph) + sgr('35', c.hash) + ' ' + dim(ago(Date.now() - c.at).padStart(6)) + '  ' + c.subject,
      });
    }
  }
  return rows;
}

// The addresses get a block of their own rather than the bottom of that one:
// losing a deployment's address is the reason the block exists, and the bottom
// of a block that holds half a year of commits is exactly what scrolls away.
function deployItems(info) {
  return info.urls.map((u) => ({ open: 'https://' + u, text: '  ' + sgr('4;34', u) }));
}

// The blocks below the head of a view, shared by both of them.
// Work the session handed off, newest first, with how long it has been gone. An
// agent still out is the one thing a session is waiting on that its own last
// line does not mention.
function agentRows(st) {
  const room = Math.max(10, W() - 13);
  return [...st.agents.values()]
    .sort((a, b) => (b.at > a.at ? 1 : -1))
    .slice(0, 5)
    .map((a) => {
      const from = Date.parse(a.at) || 0;
      const span = Math.max(0, (a.done ? Date.parse(a.done) : Date.now()) - from);
      const what = clip(a.what, room);
      return {
        text: '  ' + (a.done ? sgr('32', '✓') + ' ' + dim(cell(what, room)) : sgr('1;33', '▸') + ' ' + cell(what, room))
          + dim(cell(from ? ago(span) : '', 7, true)),
      };
    });
}

function bodyBlocks(st, base) {
  const b = bodyItems(st, base);
  const out = [];
  const agents = agentRows(st);
  if (agents.length) out.push({ key: 'АГЕНТИ', label: 'АГЕНТИ', items: agents });
  if (b.media.length) out.push({ key: 'МЕДІА', label: 'МЕДІА', items: b.media });
  out.push({ key: 'ФАЙЛИ', label: 'ФАЙЛИ', items: b.files, count: b.files.length + (st.partial ? '+' : '') });
  out.push({ key: 'ЛІНКИ', label: 'ЛІНКИ', items: b.links });
  return out;
}

// Paint exactly H() - 1 rows: the blocks, blank filler, then the footer on the
// last one. Writing a full screen and then a newline would scroll the terminal
// by a row, which on a block terminal is a frame that never comes back.
function paint(out, footer) {
  const rows = H() - 1;
  while (out.length < rows - 1) out.push('');
  out.length = rows - 1;
  out.push(clip(footer, W()));
  // The row under the pointer, reversed out, so which rows do something is
  // visible before clicking rather than after. rowHits is this frame's own map,
  // so a row that stopped being clickable simply stops lighting up. strip()
  // first: a reverse that runs into the row's own \x1b[0m ends there and leaves
  // half a bar behind.
  if (hitAt(hover)) out[hover - 1] = sgr('7', strip(out[hover - 1]));
  if (process.env.SIDEBAR_HITS) process.stderr.write(JSON.stringify({ hits: rowHits, blocks: blockAt }));
  process.stdout.write('\x1b[H\x1b[2J' + out.join('\n') + '\n');
}

function renderWatch() {
  const out = [];
  rowHits = {}; blockAt = {};
  live.media = mediaOf(path.basename(file, '.jsonl'));

  const todos = live.todos.map((td) => {
    const mark = td.status === 'completed' ? sgr('32', '✓') : td.status === 'in_progress' ? sgr('1;33', '▸') : dim('·');
    const txt = (td.status === 'in_progress' && td.activeForm) || td.content || '';
    return { text: '  ' + mark + ' ' + (td.status === 'completed' ? dim(txt) : txt) };
  });
  const live_ = activeSessions().map((s) => ({ pick: s.path, text: activeRow(s, s.path === file) }));

  // Only ever a row when something is actually stranded, so an empty machine
  // costs the pane nothing.
  const proj = projectOf({ path: file }, live);
  const stray = slow('orphans', ORPHAN_TTL, orphans) || [];
  const strayRows = stray.map((o) => ({
    text: '  ' + sgr('33', o.name) + dim('  ×' + o.n + '  ' + weigh(o.bytes) + '  від ' + hhmm(o.born)),
  }));

  layout(out, [
    { key: ALIVE, label: 'СЕСІЇ', items: live_, empty: 'нічого не рухалось останні 3 год' },
    ...(strayRows.length ? [{ key: 'СИРОТИ', label: 'СИРОТИ', items: strayRows }] : []),
    { key: 'ЗАЛІЗО', label: 'ЗАЛІЗО', items: loadRows(), count: CHART_MODES[chartMode] },
    { key: 'ПРОЄКТ', label: 'ПРОЄКТ', items: projectItems(proj) },
    ...(proj.urls.length ? [{ key: 'ДЕПЛОЙ', label: 'ДЕПЛОЙ', items: deployItems(proj), count: '' }] : []),
    // A session that never writes a todo list — which, on this machine, is every
    // session — would otherwise hold three rows open to say so forever.
    ...(todos.length ? [{ key: 'ПЛАН', label: 'ПЛАН', items: todos }] : []),
    ...bodyBlocks(live, live.cwd),
  ], H() - 2);

  paint(out, dim(' Tab — список · a — витрати · v — вид графіка · клік відкриває · q — вихід'));
}

// A count as a person reads it: thousands and millions, two significant figures
// where it matters and none where it does not.
// 21 запит, 24 запити, 25 запитів — the one place the pane counts things in
// a sentence rather than in a column.
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  return n + ' ' + (a > 10 && a < 20 ? many : b === 1 ? one : b > 1 && b < 5 ? few : many);
}

const num = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(Math.round(n)));

function span(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + ' хв';
  return Math.floor(m / 60) + ' год ' + (m % 60) + ' хв';
}

// What the session has spent, and what it is still waiting on. The cache share
// is the one number that says whether the prompt is being rebuilt from scratch:
// tokens read out of cache cost a tenth of tokens written into it.
function spentRows(s) {
  const cached = s.read + s.wrote;
  const inTools = [...s.tools.values()].reduce((a, e) => a + e.ms, 0);
  const stuck = [...s.open.values()].filter((o) => o.at && Date.now() - o.at > 60000)
    .sort((a, b) => a.at - b.at);
  return [
    { text: '  ' + dim(cell('контекст', 11)) + sgr('1', num(s.ctx)) + dim('  токенів у промті останнього ходу') },
    { text: '  ' + dim(cell('кеш', 11)) + (cached ? Math.round(s.read / cached * 100) + '% зчитано' : '—')
      + dim('  ' + num(s.wrote) + ' записано в кеш') },
    { text: '  ' + dim(cell('вихід', 11)) + num(s.out) + dim('  думання ' + num(s.think) + '  ·  ходів ' + s.turns) },
    { text: '  ' + dim(cell('час', 11)) + (s.to > s.from ? span(s.to - s.from) : '—')
      + dim('  транскрипт ' + weigh(s.bytes) + (s.model ? '  ·  ' + s.model : '')) },
    // Wall clock split the only way a transcript can split it: time spent inside
    // a tool, and everything else — the model writing, and the session waiting
    // for a person.
    { text: '  ' + dim(cell('з них', 11)) + span(inTools) + dim(' в інструментах  ·  ')
      + span(Math.max(0, s.to - s.from - inTools)) + dim(' модель і очікування') },
    ...stuck.slice(0, 3).map((o) => ({
      text: '  ' + sgr('33', '⏱ ' + o.name + ' висить ' + span(Date.now() - o.at)),
    })),
  ];
}

// Ranked by what came back, not by how often it was called: a tool used twice
// that returns a megabyte each time is the leak, and it sits below a tool called
// three hundred times in every list sorted the other way.
function toolRows(s) {
  const rows = [...s.tools.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 8);
  return [
    { text: dim('  ' + cell('', 18) + cell('виклики', 8, true) + cell('вихід', 8, true) + cell('час', 8, true) + cell('збої', 7, true)) },
    ...rows.map((e) => ({
      text: '  ' + cell(clip(e.name, 18), 18) + cell(e.calls, 8, true) + cell(num(e.bytes / 4), 8, true)
        + cell(e.ms > 60000 ? span(e.ms) : Math.round(e.ms / 1000) + ' с', 8, true)
        + (e.errors ? sgr('33', cell(e.errors, 7, true)) : dim(cell('·', 7, true))),
    })),
  ];
}

// The session cut into as many slices as the pane is wide, so a strip under the
// chart is time rather than turns: an hour of nothing looks like an hour of
// nothing, which counting turns would hide.
function slices(marks, n, pick, keepPeak) {
  const out = new Array(n).fill(0);
  const from = marks[0] ? marks[0].t : 0;
  const to = marks[marks.length - 1] ? marks[marks.length - 1].t : 0;
  if (!(to > from)) return out;
  for (const m of marks) {
    const i = Math.min(n - 1, Math.floor((m.t - from) / (to - from) * n));
    const v = pick(m);
    out[i] = keepPeak ? Math.max(out[i], v) : out[i] + v;
  }
  // A slice with no turn in it inherits the last reading, so the context line
  // holds through a pause instead of falling to the floor and back.
  if (keepPeak) for (let i = 1; i < n; i++) if (!out[i]) out[i] = out[i - 1];
  return out;
}

// Where the context went over the session, drawn against its own peak. The drops
// are compactions; a long climb with no drop is a session that has been carrying
// everything it ever read.
function ctxRows(s, h, n) {
  const peak = Math.max(...s.marks.map((m) => m.ctx), 1);
  const line = slices(s.marks, n, (m) => m.ctx, true).map((v) => v / peak);
  return gridRows(lineGrid([{ data: line, colour: '36' }], h, n), num(peak));
}

// Two bands over the same span: what was generated, and where results came back
// as errors. Bright patches in the second one are retry loops, and they sit
// under the minutes that produced them.
function bandRows(s, n) {
  const room = n - 3;
  return [
    { text: '  ' + dim(cell('вихід', 6)) + heatStrip(slices(s.marks, room, (m) => m.out), room) },
    { text: '  ' + dim(cell('збої', 6)) + heatStrip(slices(s.marks, room, (m) => m.err), room) },
    { text: dim('  ' + cell(s.from ? hhmm(new Date(s.from).toISOString()) : '', 6)
      + cell(s.to ? hhmm(new Date(s.to).toISOString()) : '', room, true)) },
  ];
}

const ASK_N = 6;                   // rounds shown

// Errors by what they are rather than by which tool reported them: six failed
// Bash calls say nothing, while four of them being the same missing path says
// where the session was going wrong. The bar is the share of all failures, so
// one dominant kind is visible without reading the numbers.
function errRows(s) {
  const all = [...s.errs.values()].sort((a, b) => b.n - a.n);
  const total = all.reduce((a, e) => a + e.n, 0) || 1;
  const room = Math.max(12, W() - 52);
  return all.slice(0, 5).map((e) => {
    const on = Math.round(e.n / total * 10);
    return {
      text: '  ' + cell(clip(e.kind, 26), 26) + cell(e.n, 4, true) + '  '
        + sgr('33', '█'.repeat(on)) + dim('░'.repeat(10 - on)) + '  ' + dim(clip(e.sample || e.tool, room)),
    };
  });
}

// What a session actually costs, in one unit. A cached prompt token is a tenth
// of a fresh one, writing into the cache is a quarter more than sending it, and
// output is five times input — the ratios every Claude model is priced on. Add
// them up in input-token equivalents and the shape of the bill appears, which is
// rarely the shape anyone expects: on a long session it is almost entirely the
// prompt being re-read on every single turn.
const RATE = { read: 0.1, wrote: 1.25, input: 1, out: 5 };

function priceOf(s) {
  const parts = [
    { label: 'кеш перечитано', v: s.read * RATE.read, colour: '36' },
    { label: 'вихід і думання', v: s.out * RATE.out, colour: '33' },
    { label: 'запис у кеш', v: s.wrote * RATE.wrote, colour: '35' },
  ];
  return { parts, total: parts.reduce((a, p) => a + p.v, 0) };
}

// The same file, read again, and every call that failed: two things paid for
// that bought nothing. Neither is the big number on a long session, and both are
// the only ones a person can simply stop doing.
function wasteOf(s) {
  let files = 0;
  let reread = 0;
  for (const [, r] of s.reads) {
    if (r.n < 2) continue;
    files++;
    reread += r.bytes * (r.n - 1) / r.n / 4;
  }
  const fails = [...s.tools.values()].reduce((a, e) => a + e.errors, 0);
  return { files, reread, fails };
}

function priceRows(s) {
  const { parts, total } = priceOf(s);
  const w = Math.max(8, Math.min(20, W() - 54));
  const first = s.marks[0];
  const last = s.marks[s.marks.length - 1];
  const waste = wasteOf(s);
  const rows = [
    { text: '  ' + dim(cell('разом', 17)) + sgr('1', cell(num(total), 6, true)) + dim('  еквівалентних токенів входу') },
    ...parts.map((p) => ({
      text: '  ' + dim(cell(p.label, 17)) + cell(num(p.v), 6, true) + '  '
        + sgr(p.colour, '█'.repeat(Math.round(p.v / (total || 1) * w)))
        + dim('░'.repeat(Math.max(0, w - Math.round(p.v / (total || 1) * w))))
        + dim('  ' + Math.round(p.v / (total || 1) * 100) + '%'),
    })),
  ];
  // The cost of one more turn is the context times the cache rate, and it is the
  // number that decides whether to carry on here or start again: it grows with
  // every turn whether or not the turn was useful.
  if (first && last && first.ctx) {
    rows.push({
      text: '  ' + dim(cell('один хід', 17)) + cell(num(last.ctx * RATE.read), 6, true)
        + dim('  на початку ' + num(first.ctx * RATE.read) + '  ·  дорожче в '
          + (last.ctx / first.ctx).toFixed(1).replace('.0', '') + ' раза'),
    });
  }
  if (waste.files || waste.fails) {
    const bits = [];
    if (waste.files) bits.push(plural(waste.files, 'файл', 'файли', 'файлів') + ' перечитано, ~' + num(waste.reread));
    if (waste.fails) bits.push(plural(waste.fails, 'виклик', 'виклики', 'викликів') + ' впало намарно');
    rows.push({ text: '  ' + dim(cell('намарно', 17)) + dim(bits.join('  ·  ')) });
  }
  return rows;
}

// What the window is made of, as far as a transcript can say. The base is
// measured, not guessed: it is the prompt of the first turn, before anything had
// been said. The rest is the conversation, and the share of it that came back
// from tools is an estimate at four characters to the token — good enough to
// answer whether the window is full of talk or full of output nobody read.
function makeupRows(s) {
  const grown = Math.max(0, s.ctx - s.base);
  const fromTools = Math.min(grown, Math.round(s.toolChars / 4));
  const bar = (v) => {
    const w = Math.max(6, Math.min(24, W() - 46));
    const on = s.ctx ? Math.round(v / s.ctx * w) : 0;
    return dim('█'.repeat(on) + '░'.repeat(Math.max(0, w - on)));
  };
  const line = (label, v, note) => ({
    text: '  ' + dim(cell(label, 11)) + cell(num(v), 6, true) + '  ' + bar(v) + dim('  ' + note),
  });
  return [
    line('база', s.base, 'системний промт, інструменти, пам\'ять'),
    line('розмова', grown, 'за ' + plural(s.rounds.length, 'запит', 'запити', 'запитів')),
    line('з неї', fromTools, 'відповіді інструментів, приблизно'),
  ];
}

// Rounds, by what they cost: everything the model wrote plus everything it had
// to write into the cache. One line of what was asked, because a round is
// remembered by the ask and not by the tools it happened to use.
function askRows(s) {
  const rows = s.rounds.filter((r) => r.turns).map((r) => ({ ...r, cost: r.out + r.wrote }));
  const top = [...rows].sort((a, b) => b.cost - a.cost).slice(0, ASK_N);
  const room = Math.max(12, W() - 34);
  const mid = rows.length ? [...rows].sort((a, b) => a.cost - b.cost)[rows.length >> 1] : null;
  return [
    ...top.map((r) => ({
      text: '  ' + dim(hhmm(new Date(r.at).toISOString())) + cell(num(r.cost), 7, true)
        + dim(cell(r.turns + ' х', 5, true)) + dim(cell(r.to && r.at ? span(r.to - r.at) : '', 8, true))
        + '  ' + clip(r.text, room),
    })),
    ...(mid ? [{ text: dim('  медіана запиту ' + num(mid.cost) + ' токенів  ·  ' + num(rows.reduce((a, r) => a + r.cost, 0) / Math.max(1, rows.length)) + ' у середньому') }] : []),
  ];
}

function renderStats() {
  const out = [];
  rowHits = {}; blockAt = {};
  const s = slow('stats:' + file, STAT_TTL, () => statsOf(file));
  // titleOf reads from both ends of the file, so it needs the size to find them.
  let bytes = 0; try { bytes = fs.statSync(file).size; } catch { }
  const title = (bytes && titleOf(file, bytes)) || path.basename(file, '.jsonl').slice(0, 8);
  if (!s) {
    layout(out, [{ key: 'ВИТРАТИ', label: 'ВИТРАТИ', items: [], count: '', empty: 'рахую транскрипт…' }], H() - 2);
  } else {
    const n = Math.max(12, W() - 7);
    const h = Math.max(3, Math.min(7, Math.round((H() - 2) * 0.18)));
    layout(out, [
      { key: 'ВИТРАТИ', label: clip('ВИТРАТИ · ' + title, 40), items: spentRows(s), count: '' },
      ...(s.marks.length > 1 ? [
        { key: 'КОНТЕКСТ', label: 'КОНТЕКСТ', items: ctxRows(s, h, n), count: '' },
        { key: 'ПЕРЕБІГ', label: 'ПЕРЕБІГ', items: bandRows(s, n), count: '' },
      ] : []),
      ...(s.turns ? [{ key: 'ЦІНА', label: 'ЦІНА', items: priceRows(s), count: '' }] : []),
      ...(s.base ? [{ key: 'СКЛАД', label: 'СКЛАД КОНТЕКСТУ', items: makeupRows(s), count: '' }] : []),
      ...(s.errs.size ? [{ key: 'ЗБОЇ', label: 'ЗБОЇ', items: errRows(s), count: '' }] : []),
      ...(s.rounds.length ? [{ key: 'ЗАПИТИ', label: 'НАЙДОРОЖЧІ ЗАПИТИ', items: askRows(s), count: '' }] : []),
      { key: 'ІНСТРУМЕНТИ', label: 'ІНСТРУМЕНТИ', items: toolRows(s), count: '' },
    ], H() - 2);
  }
  paint(out, dim(' a — назад · Tab — список · q — вихід'));
}

function renderPick() {
  const out = [];
  rowHits = {}; blockAt = {};
  const items = sessions.map((s, i) => ({ session: i, text: pickRow(s, i === cursor) }));
  const sel = sessions[cursor];
  const st = sel ? scanSession(sel) : null;
  const proj = st ? projectOf(sel, st) : null;
  const avail = H() - 2;

  // The list takes about half the pane and the selected session's body the rest,
  // so moving the cursor always shows something about what you are pointing at.
  layout(out, [
    { key: LIST, label: 'СЕСІЇ', items, want: Math.max(4, Math.floor(avail / 2)), count: sessions.length, focus: cursor },
    ...(proj ? [{ key: 'ПРОЄКТ', label: 'ПРОЄКТ', items: projectItems(proj) }] : []),
    ...(proj && proj.urls.length ? [{ key: 'ДЕПЛОЙ', label: 'ДЕПЛОЙ', items: deployItems(proj), count: '' }] : []),
    ...(st ? bodyBlocks(st, st.cwd) : []),
  ], avail);

  // A refusal is reported where the click happened, and saying the terminal is
  // unknown beats offering a keypress that does nothing and explains nothing.
  paint(out, openError
    ? sgr('33', clip(' ' + openError, W()))
    : dim(GHOSTTY || WARP
      ? ' ↑↓ вибір · клік перемикає панель · Enter відкриває табом · Tab назад'
      : ' ↑↓ вибір · клік перемикає панель · табів цей термінал не вміє · Tab назад'));
}

let mode = 'watch';
let sessions = [];
let cursor = 0;
// The screen row the pointer rests on, 1-based, or -1 for nowhere. paint() draws
// it highlighted, but only while that row is still clickable in the frame being
// painted — so a layout that shifts under a resting pointer cannot strand a
// highlight on a row that no longer opens anything.
let hover = -1;
const draw = () => (mode === 'pick' ? renderPick() : mode === 'stats' ? renderStats() : renderWatch());

// Every mouse event resolves through rowHits: motion moves the highlight, a
// click on a link or a media row opens that, a click on a session row opens the
// session. The rest of the screen is inert. The return value says whether the
// frame changed — motion is reported per cell of travel, and repainting the pane
// on each of those would put a screenful a millisecond into a terminal that then
// has to draw them all.
// The whole СЕСІЇ block of the live view is a way into the session list — its
// rows through rowHits, its rule and its "nothing moved" line through blockAt,
// which is the only map that covers those. Tapping the block you are already
// reading is a shorter path to the list than remembering that Tab opens it.
function hitAt(y) {
  const hit = rowHits[y - 1];
  if (hit) return hit;
  return mode === 'watch' && blockAt[y - 1] === ALIVE ? { pick: true } : null;
}

// Open the list with the cursor already on the session that was tapped. A row
// of the live block carries its transcript path; the rule carries nothing, and
// the list opens where it always did.
function openPicker(at) {
  sessions = listSessions();
  const i = typeof at === 'string' ? sessions.findIndex((s) => s.path === at) : -1;
  cursor = i < 0 ? 0 : i;
  mode = 'pick';
}

function onMouse(btn, y, press) {
  const b = btn & ~28;                       // strip shift/alt/ctrl
  if (b === 64 || b === 65) { onWheel(y, b === 64 ? -3 : 3); return true; }
  if (b & 32) {                              // motion, button held or not
    const at = hitAt(y) ? y : -1;
    if (at === hover) return false;
    hover = at;
    return true;
  }
  if (!press || b !== 0) return false;
  const hit = hitAt(y);
  if (!hit) return false;
  if (hit.chart) { chartMode = (chartMode + 1) % CHART_MODES.length; return true; }
  if (hit.open) { openExternal(hit.open); return false; }
  if (hit.pick) { openPicker(hit.pick); return true; }
  if (hit.session == null) return false;
  cursor = hit.session;
  pinTo(sessions[cursor]);
  return true;
}

// Clicking a session moves this pane onto it and leaves it there — Enter is what
// opens a session in a tab of its own. Without the pin the next turn taken
// anywhere would pull the pane straight back off what was just chosen.
function pinTo(s) {
  if (!s) return;
  pinned = s.path;
  if (s.path !== file) resetLive(s.path);
  mode = 'watch';
}

// The wheel moves whatever the pointer is over, and only that. Over the picker's
// session list it moves the cursor rather than the offset: the cursor drags the
// offset along already, and moving both would have them fight.
function onWheel(y, step) {
  const key = blockAt[y - 1];
  if (!key) return;
  if (key === LIST) { cursor = Math.min(Math.max(0, cursor + step), Math.max(0, sessions.length - 1)); return; }
  scroll[key] = Math.max(0, (scroll[key] || 0) + step);
}

// ---- run ----
// Before the transcript check: a machine that has never run Claude has none, and
// installing the tab is exactly what you do there first.
if (arg === '--check') { check(); process.exit(0); }
if (arg === '--install') { install(process.argv[3], process.argv[4]); process.exit(0); }
if (!file) { console.error('Транскрипт не знайдено в ' + PROJECTS); process.exit(1); }
// Alternate screen buffer. Without it every \x1b[H\x1b[2J repaint is appended to
// the host terminal's scrollback instead of replacing it — in a block terminal
// like Warp that is a screenful per second, straight into memory. Alt-screen
// gives the pane its own buffer and leaves nothing behind on exit.
const ALT = process.stdin.isTTY && !process.env.SIDEBAR_ONCE;
const ALT_ON = '\x1b[?1049h' + MOUSE_ON;
const ALT_OFF = MOUSE_OFF + '\x1b[?1049l';
const showCursor = () => process.stdout.write('\x1b[?25h');
if (ALT) process.stdout.write(ALT_ON);
process.stdout.write('\x1b[?25l');
const bye = () => { showCursor(); try { process.stdin.setRawMode(false); } catch { } process.exit(0); };
process.on('SIGINT', bye);
process.on('exit', () => process.stdout.write('\x1b[?25h' + (ALT ? ALT_OFF : '\n')));

readNew();
sampleLoad();                               // so the first frame already knows what the machine is doing
if (process.env.SIDEBAR_ONCE) {
  if (process.env.SIDEBAR_ONCE === 'pick') { sessions = listSessions(); mode = 'pick'; }
  if (process.env.SIDEBAR_ONCE === 'stats') mode = 'stats';
  draw(); showCursor(); process.exit(0);
}
draw();

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (buf) => {
    const k = buf.toString();
    if (k.indexOf('\x1b[<') >= 0) {          // one chunk can hold several events
      let m, changed = false; MOUSE_RE.lastIndex = 0;
      while ((m = MOUSE_RE.exec(k))) changed = onMouse(+m[1], +m[3], m[4] === 'M') || changed;
      if (changed) draw();
      return;
    }
    if (k === '\u0003') return bye();
    if (mode === 'watch') {
      if (K_LIST.has(k)) { openPicker(); draw(); }
      else if (K_VIEW.has(k)) { chartMode = (chartMode + 1) % CHART_MODES.length; draw(); }
      else if (K_STATS.has(k)) { mode = 'stats'; draw(); }
      else if (K_QUIT.has(k)) bye();
      return;
    }
    if (mode === 'stats') {
      if (K_LIST.has(k)) { openPicker(); draw(); }
      else if (K_STATS.has(k) || k === '\u001b') { mode = 'watch'; draw(); }
      else if (K_QUIT.has(k)) bye();
      return;
    }
    if (K_UP.has(k)) cursor = Math.max(0, cursor - 1);
    else if (K_DOWN.has(k)) cursor = Math.min(sessions.length - 1, cursor + 1);
    else if (k === '\r' || k === '\n') { const s = sessions[cursor]; if (s) openInTab(s); }
    else if (K_LIST.has(k)) mode = 'watch';   // Tab closes what Tab opened
    else if (k === '\u001b' || K_QUIT.has(k)) mode = 'watch';
    else if (k === 'g') cursor = 0;
    else if (k === 'G') cursor = sessions.length - 1;
    draw();
  });
}

setInterval(() => {
  sampleLoad();                            // the graph fills while the picker is open too
  if (mode === 'pick') return;
  if (!pinned) {
    const a = fromStatusline();
    if (a && a.ts >= BORN) pinned = a.transcript_path;
    const next = pinned || findTranscript();
    if (next && next !== file) resetLive(next);
  }
  readNew();
  draw();                                  // once a second, because the graph moves on its own
}, 1000);
process.stdout.on('resize', draw);
