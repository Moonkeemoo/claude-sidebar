// Everything the layout and the mouse depend on, checked against real renders.
//
// The pane builds three things at once: the lines it prints, a map from each row
// to what clicking it does, and a map from each row to the block it belongs to.
// Let any of those drift by a line and clicks land on the wrong thing, the wheel
// scrolls the wrong block, or a row wraps and shifts everything below it — none
// of which looks broken on screen. SIDEBAR_HITS makes both maps observable.
//
//   node sidebar.test.js
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const SIDEBAR = path.join(__dirname, 'sidebar.js');
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const width = (s) => [...strip(s)].length;          // columns, not bytes

// A transcript of our own, pinned as the watched session. Without it the checks
// below run against whatever session happens to be live, and "every clickable
// row shows what it opens" passes or fails by luck: a session that has not
// touched a file or printed a link yet has no clickable rows to check at all.
const FIXTURE = path.join(os.tmpdir(), 'sidebar-fixture.jsonl');
const at = new Date().toISOString();
const entry = (content) => JSON.stringify({ type: 'assistant', cwd: __dirname, timestamp: at, message: { content } });
fs.writeFileSync(FIXTURE, [
  entry([{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(__dirname, 'sidebar.js') } }]),
  entry([{ type: 'tool_use', name: 'Write', input: { file_path: path.join(__dirname, 'README.md') } }]),
  entry([{ type: 'text', text: 'дивись https://example.com/sidebar/docs і далі' }]),
  entry([{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'перевірити панель', status: 'in_progress', activeForm: 'перевіряю панель' }] } }]),
].join('\n') + '\n');

// The picker lists the sessions that really exist, so it runs unpinned.
function render(mode, cols = 76, rows = 30) {
  const r = spawnSync(process.execPath, [SIDEBAR, ...(mode === 'pick' ? [] : [FIXTURE])], {
    env: { ...process.env, SIDEBAR_ONCE: mode, SIDEBAR_HITS: '1', COLUMNS: String(cols), LINES: String(rows) },
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, 'sidebar.js exited ' + r.status + ': ' + r.stderr.slice(0, 300));
  const map = JSON.parse(r.stderr);
  // The exit handler adds a newline of its own in one-shot mode, so trailing
  // blanks are not part of the frame. Row indices below it are untouched.
  const lines = r.stdout.replace(/\n+$/, '').split('\n');
  return { lines, hits: map.hits, blocks: map.blocks, cols, rows, mode };
}

// ---- the pane fits its window, whatever the window ----
// Too tall and the top scrolls away; one row too wide and it wraps, which costs
// two screen lines and puts every click below it one row out.
for (const [cols, rows] of [[40, 12], [50, 20], [60, 22], [76, 30], [120, 50]]) {
  for (const mode of ['1', 'pick']) {
    const v = render(mode, cols, rows);
    const at = mode + ' ' + cols + 'x' + rows;
    assert.ok(v.lines.length <= rows, at + ': painted ' + v.lines.length + ' rows into ' + rows);
    for (const [i, line] of v.lines.entries()) {
      assert.ok(width(line) <= cols - 1, at + ': row ' + (i + 1) + ' is ' + width(line) + ' wide, pane is ' + (cols - 1));
    }
  }
}

// ---- the picker highlights the first session, on the row below the header ----
const pick = render('pick');
assert.ok(/СЕСІЇ/.test(pick.lines[0]), 'row 1 is not the session header: ' + strip(pick.lines[0]));
assert.deepStrictEqual(
  pick.hits['1'], { session: 0 },
  'the row below the header must be session 0, not ' + JSON.stringify(pick.hits['1'])
);

// ---- every clickable row shows the thing it opens, and sits inside a block ----
// The second half matters for the wheel: a row with no block behind it is a row
// the pointer can sit on while scrolling does nothing.
let checked = 0;
for (const view of [pick, render('1')]) {
  for (const [i, hit] of Object.entries(view.hits)) {
    assert.ok(view.blocks[i], 'row ' + (+i + 1) + ' is clickable but belongs to no block');
    if (!hit.open) continue;
    const line = strip(view.lines[+i] || '');
    const needle = hit.open.startsWith('http')
      ? hit.open.replace(/^https?:\/\//, '').slice(0, 15)
      : path.basename(hit.open);
    assert.ok(line.includes(needle), 'row ' + (+i + 1) + ' opens "' + hit.open + '" but shows "' + line.trim() + '"');
    checked++;
  }
}
assert.ok(checked > 0, 'no clickable rows in either view — the map is not being built');

// ---- a long block scrolls inside itself rather than pushing the pane over ----
// Squeeze the window until something has to be cut, and the block that got cut
// must say so in its rule.
const tight = render('pick', 60, 14);
assert.ok(
  tight.lines.some((l) => /\d+–\d+/.test(strip(l))),
  'nothing reported a scroll window at 60x14, so nothing was actually clipped'
);

// ---- and a click parses to the right button ----
// MOUSE_RE and the modifier mask are read out of sidebar.js itself, so this
// cannot drift away from the code it is checking.
const src = fs.readFileSync(SIDEBAR, 'utf8');
const MOUSE_RE = eval(src.match(/const MOUSE_RE = (.+);/)[1]);
const parse = (s) => {
  MOUSE_RE.lastIndex = 0;
  const m = MOUSE_RE.exec(s);
  return m && { b: +m[1] & ~28, y: +m[3], press: m[4] === 'M' };
};

assert.deepStrictEqual(parse('\x1b[<0;12;5M'), { b: 0, y: 5, press: true }, 'plain left click');
assert.deepStrictEqual(parse('\x1b[<16;12;5M'), { b: 0, y: 5, press: true }, 'ctrl+click is still a left click');
assert.deepStrictEqual(parse('\x1b[<35;12;5M'), { b: 35, y: 5, press: true }, 'bare motion keeps its 32 bit and its row');
assert.deepStrictEqual(parse('\x1b[<64;1;1M'), { b: 64, y: 1, press: true }, 'wheel up');
assert.deepStrictEqual(parse('\x1b[<68;1;1M'), { b: 64, y: 1, press: true }, 'shift+wheel is still wheel up');
assert.strictEqual(parse('\x1b[<0;12;5m').press, false, 'a release must not act');
assert.strictEqual(parse('hello'), null, 'plain text is not a mouse event');

// ---- a click never opens something arbitrary ----
// openExternal is the only place a transcript's text reaches the OS, so it must
// refuse anything that is neither an http(s) link nor a file that exists.
// ---- and the pointer is actually being tracked ----
// Without 1003 no motion is reported at all, so nothing ever lights up and the
// pane silently goes back to "hover and see nothing".
assert.ok(/\?1003h/.test(src), 'motion reporting is off — no row can highlight under the pointer');
assert.ok(/hitAt\(hover\)/.test(src), 'the highlight stopped checking that the row still does something');
// The live view's session block opens the list even where there is no row to
// click: its rule, and its line saying nothing has moved. Only blockAt reaches
// those, so the fallback through it is the whole feature.
assert.ok(/blockAt\[y - 1\] === ALIVE/.test(src), 'tapping the session block no longer falls back to its block');

// ---- the Ghostty split survives two layers of quoting ----
// A path goes into a shell single-quoted string, which goes into an AppleScript
// double-quoted string, which goes into an -e argument. Get either layer wrong
// and osascript either fails or runs something that was never intended — the
// directory name is the part a user controls.
// An arrow assigned to a const does not survive eval the way a function
// declaration does, so these are lifted as expressions.
const shq = eval('(' + src.match(/const shq = (.+);/)[1] + ')');
const osaStr = eval('(' + src.match(/const osaStr = (.+);/)[1] + ')');
eval(src.match(/function ghosttyScript[\s\S]*?\n\}/)[0]);

assert.strictEqual(shq("O'Brien/code"), "'O'\\''Brien/code'", 'a quote must close, escape and reopen');
assert.strictEqual(osaStr('say "hi"'), '"say \\"hi\\"\\n"', 'quotes inside AppleScript text need escaping');
assert.strictEqual(osaStr('back\\slash'), '"back\\\\slash\\n"', 'so do backslashes');
const gs = ghosttyScript('cd ' + shq("/Users/o'brien/code") + ' && claude', 'right');
assert.ok(/split t direction right$/m.test(gs), 'the direction is not in the script: ' + gs);
// The shell needs '\'' to put a quote inside a quoted word; AppleScript has to
// hand it that backslash, so it must arrive doubled. Lose the doubling and the
// shell sees '' — the path silently splits in two.
assert.ok(gs.includes("'\\\\''"), 'the shell escape did not survive into AppleScript: ' + gs);
assert.strictEqual(gs.split('\n').length, 5, 'the script must stay one tell block: ' + gs);

// ---- a stranded browser is one nobody opened and nobody will close ----
// The block only ever appears when something is genuinely left over, so the
// question is entirely what gets let in: the browser you are reading this in
// must not, and neither must a headless one that a test started a minute ago.
eval(src.match(/function orphanRows[\s\S]*?\n\}/)[0]);
const NOW = Date.parse('2026-08-28T22:00:00Z');
const proc = (cmd, minutes, mb) => ({
  Name: 'chrome.exe', CommandLine: cmd, WorkingSetSize: mb * 1048576,
  CreationDate: '/Date(' + (NOW - minutes * 60000) + ')/',
});
const stranded = orphanRows([
  proc('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ', 300, 500),   // yours, open right now
  proc('chrome.exe --headless --remote-debugging-port=9222', 45, 400),
  proc('chrome.exe --headless --remote-debugging-port=9222', 30, 300),
  proc('chrome.exe --headless=new', 2, 200),                                         // a test still running
  { Name: 'chrome.exe', WorkingSetSize: 1, CreationDate: null },                     // no command line at all
], NOW, 10 * 60 * 1000);
assert.strictEqual(stranded.length, 1, 'expected one stranded group, got ' + JSON.stringify(stranded));
assert.strictEqual(stranded[0].n, 2, 'the running test and the browser you opened must both be left out');
assert.strictEqual(stranded[0].bytes, 700 * 1048576, 'memory is the sum of the stranded ones only');
assert.strictEqual(stranded[0].born, NOW - 45 * 60000, 'the age shown is the oldest of them');
assert.deepStrictEqual(orphanRows([], NOW, 1), [], 'nothing running means no block');

// ---- a deployment is what the docs say, not what they illustrate ----
// A fenced block shows some other pane, terminal or project. Our own README
// prints an example frame carrying reef's host, and until the fence was skipped
// every session working in this repo was reported as deployed there.
const vercelInDocs = eval('(function(){' + src.match(/const VERCEL = [\s\S]*?\nfunction vercelInDocs[\s\S]*?\n\}/)[0] + '\nreturn vercelInDocs })()');
const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-docs-'));
fs.writeFileSync(path.join(docs, 'README.md'), [
  'прод live-app.vercel.app, там усе',
  '',
  '```',
  '  other-app.vercel.app',
  '```',
  '',
  'ще один рядок',
].join('\n'));
assert.deepStrictEqual(vercelInDocs(docs), ['live-app.vercel.app'], 'the host inside the fence is not this repo`s');
assert.ok(!vercelInDocs(__dirname).includes('reef-money.vercel.app'), 'our own README example is being read as our deployment');
fs.rmSync(docs, { recursive: true, force: true });

// ---- the files block offers what is worth opening ----
// The fixture session edits a source file and writes a note. Only one of those
// is something its user ever wants to look at, and the other one is the work.
const watch = render('1');
const opens = Object.values(watch.hits).map((h) => h.open).filter((o) => o && !/^https?:/.test(o));
assert.ok(opens.some((o) => o.endsWith('README.md')), 'the note the session wrote is not in the block');
assert.ok(!opens.some((o) => /\.js$/.test(o)), 'a source file is still listed: ' + opens.join(' '));

// ---- blocks stand apart, and the space between them still scrolls ----
// The blank row is pushed by layout rather than by panel, which is the one
// place allowed to skip panel — so it has to carry a block of its own, or the
// wheel dies wherever the pointer lands in the gap.
const rules = watch.lines.map((l, i) => i).filter((i) => /^── /.test(strip(watch.lines[i])));
assert.ok(rules.length > 2, 'expected several blocks in the live view, found ' + rules.length);
for (const i of rules.slice(1)) {
  assert.strictEqual(strip(watch.lines[i - 1]), '', 'no blank row above the rule on row ' + (i + 1));
  assert.ok(watch.blocks[i - 1], 'the blank row on row ' + i + ' belongs to no block');
}

// ---- the Mac's own tools, parsed the way they actually print ----
// Neither of these runs on the machine this test does, and both fail silently:
// slow() swallows a throw, so a parser that matches nothing looks exactly like a
// quiet machine. The samples below are what ps and vm_stat print on macOS.
const unix = eval('(function(){'
  + src.match(/const RUNTIME = [\s\S]*?\nfunction psRows[\s\S]*?\n\}/)[0]
  + src.match(/function vmUsed[\s\S]*?\n\}/)[0]
  + '\nreturn { psRows, vmUsed, cpuTicks100ns } })()');

assert.strictEqual(unix.cpuTicks100ns('4:11.62'), 251.62 * 1e7, 'ps prints minutes:seconds for anything short');
assert.strictEqual(unix.cpuTicks100ns('1:02:03'), 3723 * 1e7, 'and hours once a process has been up a while');
assert.strictEqual(unix.cpuTicks100ns('2-03:04:05'), 183845 * 1e7, 'and days for a login session');
assert.strictEqual(unix.cpuTicks100ns('?'), 0, 'anything else is no time at all, not NaN');

const rows = unix.psRows([
  '  345     1  12345   0:03.21 /usr/libexec/secinitd',
  '  678   345 456789   4:11.62 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '  PID  PPID    RSS      TIME COMMAND',
].join('\n'));
assert.strictEqual(rows.length, 2, 'the header line is not a process: ' + JSON.stringify(rows));
assert.deepStrictEqual(
  { n: rows[1].n, ws: rows[1].ws, pp: rows[1].pp },
  { n: 'Google Chrome', ws: 456789 * 1024, pp: 345 },
  'a Mac binary lives behind spaces, and rss is kilobytes: ' + JSON.stringify(rows[1])
);

assert.strictEqual(unix.vmUsed([
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                                 100.',
  'Pages active:                                10.',
  'Pages inactive:                            9999.',
  'Pages wired down:                            20.',
  'Pages occupied by compressor:                 5.',
].join('\n')), 35 * 16384, 'used memory is what is held, wired and compressed — the trailing dot is not a digit');

// ---- the load chart spans its grid, and joins its readings into a line ----
// A reading of 1 belongs on the top row and a reading of 0 on the bottom one,
// and a jump between two of them has to draw the rows in between: corners with
// nothing between them look like a chart and read as a scatter of samples. The
// axis is cut off first — it is drawn on every row and would answer for all of
// them.
const plot = (cpu, h, n) => eval('(function(){ const dim = (s) => s, sgr = (c, s) => s;'
  + ' const load = { cpu: ' + JSON.stringify(cpu) + ', ram: [], vram: [] };'
  + src.match(/const SERIES = [\s\S]*?\nfunction chart[\s\S]*?\n\}/)[0]
  + '\nreturn chart })()')(h, n).map((r) => /\S/.test(r.text.slice(6)));

assert.deepStrictEqual(plot([1, 1], 4, 4), [true, false, false, false], 'a full reading must draw on the top row alone');
assert.deepStrictEqual(plot([0, 0], 4, 4), [false, false, false, true], 'an empty one must draw on the floor alone');
assert.deepStrictEqual(plot([0, 1], 4, 4), [true, true, true, true], 'a jump between readings must be joined into a line');

// ---- and no control character got baked into the source ----
// A shell heredoc collapses the escapes in the text it writes: `\b` becomes a
// backspace byte and `\x1b` an escape. The file still parses, and a regex like
// /\b(...)\b/ turns into one that matches a literal backspace — that is, matches
// nothing, on every input, in silence.
const ctrl = src.split('\n')
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(l))   // \r is line endings, not damage
  .map(([n]) => n);
assert.deepStrictEqual(ctrl, [], 'control characters in sidebar.js, lines ' + ctrl.join(', '));

assert.ok(/target\.startsWith\('http:\/\/'\)/.test(src), 'openExternal lost its http guard');
assert.ok(/fs\.existsSync\(target\)/.test(src), 'openExternal lost its existence guard');

console.log('sidebar OK — вписується у 5 розмірів вікна, ' + checked + ' клікабельних рядків збігаються з рендером, блоки гортаються, миша під охороною');
