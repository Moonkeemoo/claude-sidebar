#!/usr/bin/env node
// Session sidebar for Claude Code — run it in a split terminal pane.
//
//   node sidebar.js                  follow the session that is live right now
//   node sidebar.js <session-id>     pin one session
//
// Keys:  Tab or S  session list · ↑↓ move · Enter open in a new Warp tab
//        Esc back · Q quit
// Mouse: click a session row to select it, click it again to open it; click a
//        link or a media file to open that. Wheel scrolls. Selecting text then
//        needs Shift, as in any mouse-aware TUI.
// The letter keys accept Latin, Ukrainian and Russian layouts.
//
// No dependencies.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

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
const K_UP = new Set(['\u001b[A', 'k', 'л', 'Л']);
const K_DOWN = new Set(['\u001b[B', 'j', 'о', 'О']);

// ---- mouse, SGR 1006 ----
// 1000 reports press/release; 1006 encodes them as \x1b[<btn;col;rowM|m, so the
// coordinates survive past column 95. Modifier bits (shift/alt/ctrl = 4|8|16)
// ride in the button field and are masked off. 64/65 are the wheel.
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1000l\x1b[?1006l';
const MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

// ---- locating the live transcript ----
// statusline.js writes ACTIVE on every turn, and that hook fires only for the
// session that just moved. An mtime scan is the fallback: it guesses, and
// guesses wrong the moment a parallel session takes a turn.
function fromStatusline() {
  if (arg) return null;
  try {
    const a = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
    if (a.transcript_path && fs.existsSync(a.transcript_path)) return a.transcript_path;
  } catch { }
  return null;
}

function findTranscript() {
  if (arg && arg.endsWith('.jsonl') && fs.existsSync(arg)) return arg;
  const live = fromStatusline();
  if (live) return live;
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

function newState() { return { files: new Map(), links: new Map(), todos: [], cwd: null }; }

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
  live.files.clear(); live.links.clear(); live.todos = []; live.cwd = null;
}

// ---- session list ----
const titleCache = new Map();
const scanCache = new Map();

function titleOf(f, size) {
  const lines = (s) => s.split('\n').filter((l) => l.trim());
  for (const l of lines(readSlice(f, Math.max(0, size - 262144), Math.min(size, 262144))).reverse()) {
    try { const d = JSON.parse(l); if (d.type === 'ai-title' && d.aiTitle) return d.aiTitle; } catch { }
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
      const hit = titleCache.get(p);
      let title;
      if (hit && hit.mtimeMs === st.mtimeMs) title = hit.title;
      else { try { title = titleOf(p, st.size); } catch { title = null; } titleCache.set(p, { mtimeMs: st.mtimeMs, title }); }
      out.push({ id: name.replace(/\.jsonl$/, ''), path: p, mtime: st.mtimeMs, size: st.size, title });
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
const TABDIR = path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'warp', 'Warp', 'data', 'tab_configs');
const TABNAME = 'claude-resume';

function cwdOf(s) {
  try {
    for (const l of readSlice(s.path, 0, 65536).split('\n')) {
      if (!l.trim()) continue;
      const d = JSON.parse(l);
      if (d.cwd && fs.existsSync(d.cwd)) return d.cwd;
    }
  } catch { }
  return process.cwd();
}

function openInTab(s) {
  const dir = cwdOf(s);
  const title = (s.title || s.id.slice(0, 8)).replace(/'/g, '').slice(0, 60);
  // TOML literal strings: no escaping, which is what Windows paths need
  const toml = [
    "name = 'Claude · resume'",
    `title = '${title}'`,
    '',
    '[[panes]]',
    "id = 'main'",
    "type = 'terminal'",
    `directory = '${dir}'`,
    `commands = ['claude --resume ${s.id}']`,
    '',
  ].join('\n');
  fs.mkdirSync(TABDIR, { recursive: true });
  fs.writeFileSync(path.join(TABDIR, TABNAME + '.toml'), toml, 'utf8');
  const uri = 'warp://tab_config/' + TABNAME;
  if (process.env.SIDEBAR_NO_LAUNCH) return uri;   // write the config, skip the URI
  const child = process.platform === 'win32'
    ? spawn('cmd', ['/c', 'start', '', uri], { detached: true, stdio: 'ignore', windowsVerbatimArguments: false })
    : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [uri], { detached: true, stdio: 'ignore' });
  child.unref();
  return uri;
}

// ---- rendering ----
const W = () => Math.max(28, (process.stdout.columns || 60) - 1);
const H = () => Math.max(10, process.stdout.rows || 24);

function rule(title, count) {
  const w = W();
  const plain = '── ' + title + (count != null ? ' ' + count : '') + ' ';
  return dim('── ') + head(title) + (count != null ? dim(' ' + count) : '') + ' ' + dim('─'.repeat(Math.max(0, w - plain.length)));
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

function when(ms) {
  const d = new Date(ms);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (d >= today) return 'сьогодні ' + d.toTimeString().slice(0, 5);
  if (d >= new Date(+today - 86400000)) return 'вчора    ' + d.toTimeString().slice(0, 5);
  return d.toISOString().slice(5, 10).replace('-', '.') + '    ' + d.toTimeString().slice(0, 5);
}

// What a click on a row should open, keyed by that row's index in the output
// array. Screen rows are 1-based, so a click at row y looks up rowHits[y - 1].
let rowHits = {};

// Media, files and links for one state object. It pushes into the caller's array
// rather than returning its own, so the indices it records are the final ones.
function bodyOf(out, st, base, limits) {
  const w = W();
  const media = st.media || [];
  if (media.length) {
    out.push(rule('MEDIA', media.length));
    for (const m of media.slice(0, limits.media)) {
      rowHits[out.length] = { open: m.full };
      out.push('  ' + sgr('36', m.name) + dim('  ' + kb(m.size)) + dim('  ' + shorten(m.full, w - 20, base)));
    }
  }
  const fl = [...st.files.entries()].sort((a, b) => (b[1].t > a[1].t ? 1 : -1));
  out.push(rule('FILES', fl.length + (st.partial ? '+' : '')));
  if (!fl.length) out.push(dim('  (порожньо)'));
  for (const [p, meta] of fl.slice(0, limits.files)) {
    const line = '  ' + dim(hhmm(meta.t)) + ' ' + (meta.n > 1 ? dim('×' + meta.n + ' ') : '') + shorten(p, w - 12, base);
    out.push(TEMP.test(p) ? dim(strip(line)) : line);
  }
  const lk = [...st.links.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1));
  out.push(rule('LINKS', lk.length));
  if (!lk.length) out.push(dim('  (порожньо)'));
  for (const [u] of lk.slice(0, limits.links)) {
    rowHits[out.length] = { open: u };
    out.push('  ' + sgr('4;34', u.length > w - 4 ? u.slice(0, w - 5) + '…' : u));
  }
}

function renderWatch() {
  const w = W();
  const out = [];
  rowHits = {};
  out.push(rule('PLAN'));
  if (!live.todos.length) out.push(dim('  (немає активного плану)'));
  for (const td of live.todos.slice(0, 12)) {
    const mark = td.status === 'completed' ? sgr('32', '✓') : td.status === 'in_progress' ? sgr('1;33', '▸') : dim('·');
    const txt = (td.status === 'in_progress' && td.activeForm) || td.content || '';
    const body = txt.length > w - 4 ? txt.slice(0, w - 5) + '…' : txt;
    out.push('  ' + mark + ' ' + (td.status === 'completed' ? dim(body) : body));
  }
  out.push('');
  live.media = mediaOf(path.basename(file, '.jsonl'));
  bodyOf(out, live, live.cwd, { media: 6, files: 14, links: 12 });
  out.push('');
  out.push(dim(' Tab — сесії · клік по лінку чи медіа відкриє його · q — вихід'));
  if (process.env.SIDEBAR_HITS) process.stderr.write(JSON.stringify(rowHits));
  process.stdout.write('\x1b[H\x1b[2J' + out.join('\n') + '\n');
}

function renderPick() {
  const out = [];
  rowHits = {};
  const rows = H();
  const listRoom = Math.max(3, Math.min(sessions.length, Math.floor((rows - 6) / 2)));
  out.push(rule('SESSIONS', sessions.length));
  const from = Math.min(Math.max(0, cursor - Math.floor(listRoom / 2)), Math.max(0, sessions.length - listRoom));
  for (let i = from; i < Math.min(sessions.length, from + listRoom); i++) {
    const s = sessions[i];
    const on = i === cursor;
    const stamp = when(s.mtime);
    const room = W() - stamp.length - 5;
    const t = s.title || '(без назви) ' + s.id.slice(0, 8);
    const body = t.length > room ? t.slice(0, room - 1) + '…' : t;
    rowHits[out.length] = { session: i };
    out.push(on ? sgr('7', ' ▸ ' + stamp + '  ' + body) : '   ' + dim(stamp) + '  ' + body);
  }
  out.push('');
  const sel = sessions[cursor];
  if (sel) {
    const st = scanSession(sel);
    const left = rows - out.length - 3;
    bodyOf(out, st, st.cwd, { media: 3, files: Math.max(2, Math.floor(left * 0.45)), links: Math.max(2, Math.floor(left * 0.3)) });
  }
  out.push('');
  out.push(dim(' ↑↓ вибір · Enter новий таб · клік по лінку відкриє · Esc назад'));
  if (process.env.SIDEBAR_HITS) process.stderr.write(JSON.stringify(rowHits));
  process.stdout.write('\x1b[H\x1b[2J' + out.join('\n') + '\n');
}

let mode = 'watch';
let sessions = [];
let cursor = 0;
const draw = () => (mode === 'pick' ? renderPick() : renderWatch());

// Every click resolves through rowHits. A session row highlights, and a second
// click on the row already highlighted opens it — a double-click without the
// timing guesswork. A media or link row opens the thing itself. The rest of the
// screen is inert.
function onMouse(btn, y, press) {
  if (!press) return;
  const b = btn & ~28;                       // strip shift/alt/ctrl
  if (b === 64) { if (mode === 'pick') cursor = Math.max(0, cursor - 3); return; }
  if (b === 65) { if (mode === 'pick') cursor = Math.min(sessions.length - 1, cursor + 3); return; }
  if (b !== 0) return;
  const hit = rowHits[y - 1];
  if (!hit) return;
  if (hit.open) return openExternal(hit.open);
  if (hit.session === cursor) openInTab(sessions[cursor]);
  else cursor = hit.session;
}

// ---- run ----
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
if (process.env.SIDEBAR_ONCE) {
  if (process.env.SIDEBAR_ONCE === 'pick') { sessions = listSessions(); mode = 'pick'; }
  draw(); showCursor(); process.exit(0);
}
draw();

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (buf) => {
    const k = buf.toString();
    if (k.indexOf('\x1b[<') >= 0) {          // one chunk can hold several events
      let m; MOUSE_RE.lastIndex = 0;
      while ((m = MOUSE_RE.exec(k))) onMouse(+m[1], +m[3], m[4] === 'M');
      draw();
      return;
    }
    if (k === '\u0003') return bye();
    if (mode === 'watch') {
      if (K_LIST.has(k)) { sessions = listSessions(); cursor = 0; mode = 'pick'; draw(); }
      else if (K_QUIT.has(k)) bye();
      return;
    }
    if (K_UP.has(k)) cursor = Math.max(0, cursor - 1);
    else if (K_DOWN.has(k)) cursor = Math.min(sessions.length - 1, cursor + 1);
    else if (k === '\r' || k === '\n') { const s = sessions[cursor]; if (s) openInTab(s); }
    else if (k === '\u001b' || K_QUIT.has(k)) mode = 'watch';
    else if (k === 'g') cursor = 0;
    else if (k === 'G') cursor = sessions.length - 1;
    draw();
  });
}

setInterval(() => {
  if (mode === 'pick') return;
  if (!arg) {
    const latest = findTranscript();
    if (latest && latest !== file) resetLive(latest);
  }
  if (readNew()) draw();
}, 1000);
process.stdout.on('resize', draw);
