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
const stateCache = new Map();
function stateOf(s) {
  const hit = stateCache.get(s.path);
  if (hit && hit.mtime === s.mtime) return hit.st;
  const st = { waiting: false, tool: null };
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
  } catch { }
  stateCache.set(s.path, { mtime: s.mtime, st });
  return st;
}

// The project a session belongs to. Read from the transcript rather than decoded
// out of the directory name, which mangles any project whose name holds a dash.
const cwdCache = new Map();
function projOf(s) {
  if (!cwdCache.has(s.path)) cwdCache.set(s.path, path.basename(cwdOf(s)));
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

// What a click on a row should open, and which block each row belongs to, both
// keyed by that row's index in the output array. Screen rows are 1-based, so a
// click at row y looks up index y - 1 in either.
let rowHits = {};
let blockAt = {};

// Each block keeps its own scroll offset across redraws. That is what lets the
// wheel move the block under the pointer while the rest of the pane stays put.
const scroll = {};
const LIST = 'SESSIONS';

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
    if (it.session != null) rowHits[out.length] = { session: it.session };
    blockAt[out.length] = key;
    out.push(clip(it.text, W()));
  }
}

// Lay the blocks out so the whole pane fits: one row per rule, the rest shared
// by appetite. What does not fit scrolls inside its own block rather than
// pushing the footer off the bottom of the screen.
function layout(out, blocks, avail) {
  const wants = blocks.map((b) => (b.want != null ? b.want : Math.max(1, b.items.length)));
  const room = share(wants, Math.max(0, avail - blocks.length));
  blocks.forEach((b, i) => panel(out, b.key, b.label, b.items, room[i], b.count, b.focus, b.empty));
}

// Reading a transcript's tail to see what it is doing is only worth it for a
// session that moved recently. Older ones are cold by definition.
function stateFor(s) {
  return Date.now() - s.mtime > RECENT ? { waiting: false, tool: null } : stateOf(s);
}

function iconFor(s, st) {
  const age = Date.now() - s.mtime;
  if (age > RECENT) return dim('○');
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
  const note = st.waiting ? sgr('33', 'чекає на тебе') : dim(st.tool || 'працює');
  return ' ' + iconFor(s, st) + ' ' + dim(stamp) + '  ' + (self ? sgr('1;36', name) : name) + '  ' + note;
}

function pickRow(s, on) {
  const st = stateFor(s);
  const line = ' ' + iconFor(s, st) + ' ' + dim(when(s.mtime)) + '  ' + (s.title || '(без назви) ' + s.id.slice(0, 8));
  return on ? sgr('7', strip(line)) : line;
}

// The three blocks a session's body is made of, as items rather than lines, so
// the layout can decide how many of each actually fit. Long values are left
// whole here — clip() cuts them to the pane's width as they are printed.
function bodyItems(st, base) {
  const w = W();
  return {
    media: (st.media || []).map((m) => ({
      open: m.full,
      text: '  ' + sgr('36', m.name) + dim('  ' + kb(m.size)) + dim('  ' + shorten(m.full, w - 20, base)),
    })),
    files: [...st.files.entries()]
      .sort((a, b) => (b[1].t > a[1].t ? 1 : -1))
      .map(([p, meta]) => {
        const line = '  ' + dim(hhmm(meta.t)) + ' ' + (meta.n > 1 ? dim('×' + meta.n + ' ') : '') + shorten(p, w - 12, base);
        return { text: TEMP.test(p) ? dim(strip(line)) : line };
      }),
    links: [...st.links.entries()]
      .sort((a, b) => (b[1] > a[1] ? 1 : -1))
      .map(([u]) => ({ open: u, text: '  ' + sgr('4;34', u) })),
  };
}

// The blocks below the head of a view, shared by both of them.
function bodyBlocks(st, base) {
  const b = bodyItems(st, base);
  const out = [];
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
  const live_ = activeSessions().map((s) => ({ text: activeRow(s, s.path === file) }));

  layout(out, [
    { key: 'ЖИВІ', label: 'СЕСІЇ', items: live_, empty: 'нічого не рухалось останні 3 год' },
    { key: 'ПЛАН', label: 'ПЛАН', items: todos, empty: 'немає активного плану' },
    ...bodyBlocks(live, live.cwd),
  ], H() - 2);

  paint(out, dim(' Tab — список · клік відкриває · колесо гортає блок · q — вихід'));
}

function renderPick() {
  const out = [];
  rowHits = {}; blockAt = {};
  const items = sessions.map((s, i) => ({ session: i, text: pickRow(s, i === cursor) }));
  const sel = sessions[cursor];
  const st = sel ? scanSession(sel) : null;
  const avail = H() - 2;

  // The list takes about half the pane and the selected session's body the rest,
  // so moving the cursor always shows something about what you are pointing at.
  layout(out, [
    { key: LIST, label: 'СЕСІЇ', items, want: Math.max(4, Math.floor(avail / 2)), count: sessions.length, focus: cursor },
    ...(st ? bodyBlocks(st, st.cwd) : []),
  ], avail);

  paint(out, dim(' ↑↓ вибір · Enter новий таб · колесо гортає блок · Esc назад'));
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
  if (b === 64 || b === 65) return onWheel(y, b === 64 ? -3 : 3);
  if (b !== 0) return;
  const hit = rowHits[y - 1];
  if (!hit) return;
  if (hit.open) return openExternal(hit.open);
  if (hit.session === cursor) openInTab(sessions[cursor]);
  else cursor = hit.session;
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
