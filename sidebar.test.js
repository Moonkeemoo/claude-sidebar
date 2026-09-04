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
// Anchored on the marker rather than on row 1: a block explanation above the
// rows moves them down, and hard-coding the index only tests the header height.
const first = Object.entries(pick.hits).find(([, h]) => h.session === 0);
assert.ok(first, 'no row in the picker opens session 0');
const row0 = +first[0];
assert.ok(
  /[●○]/.test(strip(pick.lines[row0])),
  'row ' + (row0 + 1) + ' claims session 0 but carries no session marker: ' + strip(pick.lines[row0])
);
assert.ok(
  !/[●○]/.test(strip(pick.lines[row0 - 1] || '')),
  'the row above session 0 is itself a session row — the map sits a line low'
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

// ---- a pane pairs with the session that opened beside it ----
// Every tab runs its own pane, and each has to find the one session it belongs
// to with nothing but the transcripts on disk. The rule is birth: the tab starts
// its agent and its pane together, so the transcript that appears around the
// moment the pane did is ours and every other one was already running. Get this
// wrong in the direction of "newest" and every pane in every tab lands on the
// same session, which is the bug the pairing exists to prevent.
const paired = eval('(function(){ const BORN = 1000000; let allTranscripts;'
  + src.match(/\nconst PAIR_GRACE = [\s\S]*?\nfunction bornWith[\s\S]*?\n\}\n/)[0]
  + '\nreturn { grace: PAIR_GRACE, of: (files) => { allTranscripts = () => files; return bornWith(); } } })()');
const pair = paired.of;

assert.strictEqual(pair([{ p: 'old.jsonl', bornMs: 1000000 - 5 * 60 * 1000 }]), null,
  'a session already running when the pane started is not the pane\'s session, however busy it is');
assert.strictEqual(pair([]), null, 'and with nothing on disk the pane stays unpinned rather than guessing');
assert.strictEqual(
  pair([{ p: 'old.jsonl', bornMs: 1 }, { p: 'ours.jsonl', bornMs: 1000000 + 20000 }, { p: 'later.jsonl', bornMs: 1000000 + 90000 }]),
  'ours.jsonl',
  'the first transcript to appear after the pane is the one in its tab; a tab opened afterwards is not'
);
assert.strictEqual(
  pair([{ p: 'ours.jsonl', bornMs: 1000000 - paired.grace + 1000 }]),
  'ours.jsonl',
  'the tab brings the agent up first, so a transcript born just before the pane still counts'
);

// ---- what a session spent, counted off the shapes a transcript really uses ----
// A result is a string on some calls and a list of blocks on others; a call is
// timed by the gap to the result carrying its id; and the context is the newest
// prompt, not the sum of every prompt ever sent.
const stat = eval('(function(){'
  + src.match(/\nfunction codexAsClaude[\s\S]*?\n\}\n/)[0]
  + src.match(/const RATE = [\s\S]*?\nfunction statLine[\s\S]*?\n\}/)[0]
  + '\nreturn { newStats, statLine, askedIn, RATE } })()');

// A round is one ask and everything the model did about it, so what counts as an
// ask decides the whole table. A tool result is not one, a harness reminder is
// not one, and a pasted screenshot is a mark rather than the path it arrived as.
assert.strictEqual(stat.askedIn({ content: 'зроби графік' }), 'зроби графік', 'a plain message is the ask');
assert.strictEqual(stat.askedIn({ content: [{ type: 'tool_result', content: 'ok' }] }), null, 'a tool result is not an ask');
assert.strictEqual(stat.askedIn({ content: '<system-reminder>щось</system-reminder>' }), null, 'a reminder the harness injected is not an ask');
assert.strictEqual(
  stat.askedIn({ content: [{ type: 'text', text: '[Image: source: C:\\path\\1.png]' }, { type: 'text', text: 'глянь отут' }] }),
  'глянь отут',
  'the words are the ask, wherever in the message they sit; the path is not'
);
assert.strictEqual(
  stat.askedIn({ content: [{ type: 'text', text: '[Image: source: shot.png]' }] }),
  null,
  'the path the harness echoes after a paste is the same ask arriving twice'
);
assert.strictEqual(
  stat.askedIn({ content: [{ type: 'text', text: '[Image #2]' }] }),
  '▣',
  'a screenshot with nothing said is still an ask'
);
const spent = stat.newStats();
const when = (s) => new Date(Date.parse('2026-08-29T10:00:00Z') + s * 1000).toISOString();
for (const [ts, message] of [
  [when(0), { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: {} }] }],
  [when(90), { content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: 'x'.repeat(400) }] }],
  [when(95), { content: [{ type: 'tool_use', id: 'b2', name: 'Read', input: {} }] }],
  [when(96), { content: [{ type: 'tool_result', tool_use_id: 'b2', content: [{ type: 'text', text: 'y'.repeat(800) }] }] }],
  [when(97), { content: [{ type: 'tool_use', id: 'b3', name: 'Bash', input: {} }] }],
  [when(98), { usage: { input_tokens: 5, cache_read_input_tokens: 300, cache_creation_input_tokens: 20, output_tokens: 70, output_tokens_details: { thinking_tokens: 40 } }, model: 'claude-opus-5', content: [] }],
]) stat.statLine(spent, JSON.stringify({ type: 'assistant', timestamp: ts, message }));

const bash = spent.tools.get('Bash');
assert.strictEqual(bash.calls, 2, 'both Bash calls must be counted');
assert.strictEqual(bash.ms, 90000, 'a call is timed from its own result, not the next message: ' + bash.ms);
assert.strictEqual(bash.errors, 1, 'a failed result must be counted against the tool that failed');
assert.strictEqual(bash.bytes, 400, 'a string result is measured whole');
assert.strictEqual(spent.tools.get('Read').bytes, 800, 'a block result is measured through its text');
assert.strictEqual(spent.open.size, 1, 'the call with no result yet is what "still running" is read from');
assert.strictEqual(spent.ctx, 325, 'context is the newest prompt: fresh, cached and written');
assert.deepStrictEqual([spent.out, spent.think, spent.turns], [70, 40, 1], 'output, thinking and turns come off usage');
assert.strictEqual(spent.model, 'opus-5', 'the model name is shown without its vendor prefix');

// ---- and a streamed answer is billed once, however many copies it left ----
// Claude Code writes an assistant message to the transcript several times while
// it streams, and every copy carries the usage of the same request. Two thirds
// of the turns in a real session arrive twice or three times, so summing them
// inflates the whole screen by about two thirds. The id is the request; only
// what grew since the last copy is new.
const dup = stat.newStats();
const copy = (out) => JSON.stringify({
  type: 'assistant', timestamp: when(10),
  message: { id: 'msg_01', usage: { input_tokens: 4, cache_read_input_tokens: 1000, cache_creation_input_tokens: 40, output_tokens: out }, content: [] },
});
stat.statLine(dup, copy(30));
stat.statLine(dup, copy(30));
stat.statLine(dup, copy(90));
assert.strictEqual(dup.turns, 1, 'three copies of one answer are one turn');
assert.strictEqual(dup.marks.length, 1, 'and one mark, or the session is drawn three times as long as it was');
assert.deepStrictEqual([dup.read, dup.wrote, dup.out], [1000, 40, 90],
  'the prompt is paid for once and the output grows to its final size: ' + JSON.stringify([dup.read, dup.wrote, dup.out]));
assert.strictEqual(dup.marks[0].eq, 4 + 1000 * stat.RATE.read + 40 * stat.RATE.wrote + 90 * stat.RATE.out,
  'a turn is worth the same whether it was written once or three times');

// ---- a Codex session is the same session under other names ----
// The picker lists Codex transcripts, so the spend screen is asked for them too,
// and none of the shapes it reads are in one: usage arrives once per response
// instead of once per streamed copy, and messages and calls come wrapped in
// response_item. Untranslated the screen renders empty — no price, no turns, no
// tools — which is indistinguishable from a screen that failed to load.
const cdx = stat.newStats();
for (const line of [
  { type: 'turn_context', timestamp: when(0), payload: { model: 'gpt-5.6-sol' } },
  { type: 'response_item', timestamp: when(1), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'досліди проект' }] } },
  { type: 'response_item', timestamp: when(2), payload: { type: 'custom_tool_call', name: 'shell', call_id: 'c1', input: 'ls' } },
  { type: 'response_item', timestamp: when(12), payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'z'.repeat(600) } },
  { type: 'token_usage_record', timestamp: when(13), payload: { response_id: 'resp_1', usage: { input_tokens: 16110, cached_input_tokens: 11392, cache_write_input_tokens: 0, output_tokens: 191, reasoning_output_tokens: 26 } } },
  { type: 'token_usage_record', timestamp: when(20), payload: { response_id: 'resp_2', usage: { input_tokens: 16777, cached_input_tokens: 15872, cache_write_input_tokens: 0, output_tokens: 401, reasoning_output_tokens: 13 } } },
]) stat.statLine(cdx, JSON.stringify(line));
assert.strictEqual(cdx.turns, 2, 'each Codex response is a turn of its own — nothing is streamed twice');
assert.strictEqual(cdx.read, 11392 + 15872, 'the cached part is what Claude calls a cache read');
assert.strictEqual(cdx.ctx, 16777, 'Codex counts the cached part inside input_tokens; the context is the whole prompt');
assert.strictEqual(cdx.model, 'gpt-5.6-sol', 'the model is named once per turn and never in the usage record');
assert.strictEqual(cdx.rounds.length, 1, 'a Codex message with a role of user is an ask like any other');
assert.strictEqual(cdx.tools.get('shell').bytes, 600, 'a Codex call and the output carrying its id are one tool row');
assert.strictEqual(cdx.tools.get('shell').ms, 10000, 'and the gap between them is what that call took');

// ---- the records Claude Code keeps about itself ----
// The invoice, the stopwatch and the hook traffic are not in the messages: they
// arrive as their own record types, and each one answers something no amount of
// arithmetic over usage can.
const kept = stat.newStats();
for (const line of [
  { type: 'cost-state', totalCostUSD: 64.03, totalLinesAdded: 1562, totalLinesRemoved: 185, totalDuration: 47119119, startTime: 1787983245358, modelUsage: { 'claude-opus-5': { costUSD: 63.97 } } },
  { type: 'system', subtype: 'turn_duration', durationMs: 77386 },
  { type: 'system', subtype: 'turn_duration', durationMs: 299948 },
  { type: 'attachment', attachment: { type: 'hook_success' } },
  { type: 'attachment', attachment: { type: 'hook_additional_context' } },
  { type: 'attachment', attachment: { type: 'edited_text_file' } },
]) stat.statLine(kept, JSON.stringify(line));
assert.strictEqual(kept.bill.totalCostUSD, 64.03, 'the session carries a real bill and it must be kept');
assert.deepStrictEqual(kept.durs, [77386, 299948], 'turn durations are measured by Claude Code, not derived from timestamps');
assert.deepStrictEqual([kept.attach, kept.hooks, kept.hookCtx], [3, 2, 1], 'hooks are counted apart from everything else attached');

// ---- failures are sorted by what they are, not by which tool reported them ----
// Every pattern here was read out of a real transcript. The specific ones have
// to win over the general: an Edit that lost its anchor also contains the word
// "error", and reporting it as "інше" answers nothing.
eval(src.match(/const ERRORS = \[[\s\S]*?\nfunction classify[\s\S]*?\n\}/)[0]);
assert.strictEqual(classify('<tool_use_error>String to replace not found in file.'), 'якір Edit не знайдено');
assert.strictEqual(classify('File has been modified since read, either by the user or by a linter'), 'файл змінився після читання');
assert.strictEqual(classify("sed: can't read app/index.html: No such file or directory"), 'нема файла або шляху');
assert.strictEqual(classify('/usr/bin/bash: -c: line 77: unexpected EOF while looking for matching'), 'синтаксис у команді');
assert.strictEqual(classify('Traceback (most recent call last): File "<stdin>"'), 'виняток у скрипті');
assert.strictEqual(classify('Blocked: sleep 45 followed by: tail'), 'заблоковано');
assert.strictEqual(classify('Exit code 1'), 'інше', 'an exit code on its own says nothing about what went wrong');

// ---- the bill is counted in the units every model is priced in ----
// A cached prompt token is a tenth of a fresh one, a cache write a quarter more,
// output five times. Get the ratios wrong and the block says the wrong thing is
// expensive, which is the only thing it exists to say.
const price = eval('(function(){' + src.match(/const RATE = [\s\S]*?\nfunction priceOf[\s\S]*?\n\}/)[0] + '\nreturn priceOf })()');
const bill = price({ read: 1000, out: 100, wrote: 100, input: 0 });
assert.strictEqual(bill.total, 100 + 500 + 125, 'read×0.1 + out×5 + wrote×1.25: ' + JSON.stringify(bill));
assert.strictEqual(bill.parts[0].v, 100, 'a thousand tokens re-read out of cache cost a hundred fresh ones');

// ---- a session with an agent out is working, not waiting on its human ----
// The turn that dispatched an agent ends; the agent keeps going. Reading only
// the newest assistant record calls that "чекає на тебе", which is the one lie
// the pane can tell that costs an hour.
eval(src.match(/function agentOut[\s\S]*?\n\}/)[0]);
const dispatch = (id, ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'crunch' } }] } });
const back = (id, ts) => JSON.stringify({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

assert.strictEqual(agentOut([dispatch('x', at), back('x', at)]), null, 'an agent that came back is not still out');
assert.strictEqual(agentOut(['', 'not json', dispatch('y', at)]).what, 'crunch', 'the agent still out is the one reported');
assert.strictEqual(
  agentOut([dispatch('a', '2026-08-29T10:00:00Z'), dispatch('b', '2026-08-29T10:05:00Z'), back('b', '2026-08-29T10:06:00Z')]).at,
  Date.parse('2026-08-29T10:00:00Z'),
  'the oldest one still out is what the row counts from'
);

// ---- a dispatched agent is closed by its own result, not by the next one ----
// The result arrives in a later message carrying only the id of the call it
// answers, so matching it on anything else marks the wrong agent finished and
// leaves one that is still running looking done.
const ing = eval('(function(){' + src.match(/const TEMP = [\s\S]*?\nfunction ingest[\s\S]*?\n\}/)[0] + '\nreturn { newState, ingest } })()');
const agent = ing.newState();
for (const line of [
  { content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { description: 'first' } }] },
  { content: [{ type: 'tool_use', id: 'a2', name: 'Agent', input: { subagent_type: 'explore' } }] },
  { content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'done' }] },
  { content: [{ type: 'tool_result', tool_use_id: 'unrelated', content: 'x' }] },
]) ing.ingest(agent, JSON.stringify({ type: 'assistant', timestamp: at, message: line }));

assert.strictEqual(agent.agents.size, 2, 'both dispatches must be held: ' + JSON.stringify([...agent.agents]));
assert.ok(agent.agents.get('a1').done, 'the agent whose result came back is not marked finished');
assert.strictEqual(agent.agents.get('a2').done, null, 'the one still out was closed by someone else result');
assert.strictEqual(agent.agents.get('a2').what, 'explore', 'a dispatch with no description falls back to its type');

const usageState = ing.newState();
for (const output_tokens of [20, 35]) ing.ingest(usageState, JSON.stringify({
  type: 'assistant', uuid: 'turn-1', timestamp: at,
  message: { id: 'msg-1', usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens }, content: [] },
}));
assert.strictEqual(usageState.contextTokens, 1050, 'Claude context is the complete latest input window');
assert.strictEqual(usageState.totalTokens, 1085, 'streaming copies must add only newly reported Claude tokens');

// ---- a link is what it points at, not what it was written inside ----
// A URL in a bold sentence carries the markers away with it, and the row looks
// perfectly right while opening a page that does not exist. Same for a link at
// the end of a sentence.
const said = (text) => {
  const st = ing.newState();
  ing.ingest(st, JSON.stringify({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text }] } }));
  return [...st.links.keys()];
};
assert.deepStrictEqual(said('дивись **https://claude.ai/code/artifact/58df80dd**'),
  ['https://claude.ai/code/artifact/58df80dd'], 'bold markers must not become part of the link');
assert.deepStrictEqual(said('відкрий https://example.com/a, потім https://example.com/b.'),
  ['https://example.com/a', 'https://example.com/b'], 'a link at the end of a clause keeps neither comma nor full stop');
assert.deepStrictEqual(said('https://example.com/path_with_underscore_'),
  ['https://example.com/path_with_underscore_'], 'an underscore is a path character and stays');


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
const plot = (cpu, h, n) => eval('(function(){ const dim = (s) => s, sgr = (c, s) => s, withAxis = (rows) => rows;'
  + ' const cell = (s, w, right) => (right ? String(s).padStart(w) : String(s).padEnd(w));'
  + ' const load = { cpu: ' + JSON.stringify(cpu) + ', ram: [], vram: [], net: [] };'
  + src.match(/const SERIES = [\s\S]*?\nfunction chart[\s\S]*?\n\}/)[0]
  + '\nreturn chart })()')(h, n).map((r) => /\S/.test(r.text.slice(7)));

assert.deepStrictEqual(plot([1, 1], 4, 4), [true, false, false, false], 'a full reading must draw on the top row alone');
assert.deepStrictEqual(plot([0, 0], 4, 4), [false, false, false, true], 'an empty one must draw on the floor alone');
assert.deepStrictEqual(plot([0, 1], 4, 4), [true, true, true, true], 'a jump between readings must be joined into a line');

// ---- and the column chart gives every series a band and grades its columns ----
// A band must reach its top row when that series was pinned and keep a floor
// rather than a gap when it was idle. The colour is the point of the mode: it
// says how hard that part of the machine was being pushed, and a red column on
// a calm processor would be a lie. Traffic has no ceiling to be graded against,
// so it keeps its own colour and is measured against its own busiest moment.
const bars = (load, h, n) => eval('(function(){ const dim = (s) => s, sgr = (c, s) => c + ":" + s;'
  + ' const load = ' + JSON.stringify(load) + ';'
  + src.match(/const SERIES = [\s\S]*?\nfunction columns[\s\S]*?\n\}/)[0]
  + '\nreturn columns })()')(h, n).map((r) => r.text.slice(7));

const only = (cpu) => ({ cpu, ram: [], vram: [], net: [] });
assert.deepStrictEqual(bars(only([1, 1]), 4, 3), ['1;31:█1;31:█', '1;31:█1;31:█', '1;31:█1;31:█', '1;31:█1;31:█'],
  'a full reading must fill its band to the top row, and read as critical');
assert.deepStrictEqual(bars(only([0, 0]), 4, 3), ['  ', '  ', '  ', '32:▁32:▁'],
  'an idle series must keep a floor under its band rather than an empty frame');
assert.deepStrictEqual(bars(only([0.05, 0.85]), 2, 3), [' 31:▆', '32:▁31:█'],
  'a quiet column and a loaded one must differ in colour, not only in height');

const three = bars({ cpu: [0.5], ram: [0.5], vram: [], net: [3, 9] }, 8, 3);
assert.strictEqual(three.length, 6, 'every series with a history gets a band, and an absent one takes no rows');
assert.deepStrictEqual(three.slice(4), [' 35:█', '35:▅35:█'],
  'traffic keeps its own colour and is scaled to the busiest moment on show');

// ---- the price band fills the pane exactly, and leaves gaps where turns end ----
// The spend screen is never rendered by the one-shot above — its parse is
// asynchronous — so nothing else here would catch a band one column too wide.
// Fewer turns than columns must leave the spare columns blank rather than draw a
// floor under turns that do not exist.
const pace = (marks, n, h) => eval('(function(){ const dim = (s) => s, sgr = (c, s) => s, clock = () => "", subRow = (t) => ({ text: t }), intro = (t) => [{ text: t }, { text: "" }], outro = (...a) => [{ text: "" }, ...a.map((x) => ({ text: x }))];'
  + ' const num = (v) => String(Math.round(v)), hhmm = (t) => new Date(t).toISOString().slice(11, 16);'
  + ' const cell = (s, w, right) => (right ? String(s).padStart(w) : String(s).padEnd(w));'
  + ' const heatStrip = (v, n) => " ".repeat(n);'
  + ' const s = { marks: ' + JSON.stringify(marks) + ', durs: [] };'
  + src.match(/const BARS = [\s\S]*?\nfunction barCell[\s\S]*?\n\}/)[0]
  + src.match(/\nfunction axisRow[\s\S]*?\n\}/)[0]
  + src.match(/\nfunction timeAxis[\s\S]*?\n\}/)[0]
  + src.match(/\nfunction byTurn[\s\S]*?\n\}/)[0]
  + src.match(/\nfunction traceRows[\s\S]*?\n\}/)[0]
  + '\nreturn traceRows(s, ' + h + ', ' + n + ') })()');

const t0 = Date.parse('2026-08-29T09:00:00Z');
const climb = Array.from({ length: 40 }, (_, i) => ({ eq: 1000 + i * 500, err: 0, t: t0 + i * 60000 }));
for (const cols of [40, 60, 100]) {
  const n = Math.max(12, cols - 8);
  // Found by content rather than by index: the block opens with an explanation
  // and a blank line, and pinning the test to a row number breaks the moment
  // another line is added above the chart.
  const band = pace(climb, n, 3);
  const bars = band.filter((r) => /[▁-█]/.test(strip(r.text)));
  const axis = band.filter((r) => /\d\d:\d\d/.test(strip(r.text)));
  assert.strictEqual(bars.length, 3, 'the band must be as many rows as it was asked for');
  for (const r of bars) {
    assert.strictEqual(width(r.text), 7 + n, 'a price band row must be the width of the pane, was ' + width(r.text));
  }
  assert.strictEqual(width(axis[0].text), 7 + n, 'and so must the time axis under it');
}
const sparse = pace([{ eq: 100, err: 0, t: t0 }, { eq: 400, err: 0, t: t0 + 1000 }, { eq: 900, err: 0, t: t0 + 2000 }], 12, 2);
const floor = sparse.filter((r) => /[▁-█]/.test(strip(r.text))).pop();
assert.strictEqual(strip(floor.text).slice(7).replace(/[^ ]/g, '').length, 9,
  'with three turns and twelve columns, nine columns must stay empty');

// A session that ran past midnight must not label its end with a smaller number
// than its start: the same clock time a day later reads as time running
// backwards, which is exactly what an axis must never do.
const overnight = pace(
  Array.from({ length: 40 }, (_, i) => ({ eq: 1000, err: 0, t: t0 + i * 3600000 })), 60, 2,
).filter((r) => /\d\d:\d\d/.test(strip(r.text)))[0];
assert.ok(/\d+ \d\d:\d\d/.test(strip(overnight.text)),
  'an axis spanning more than a day must carry the day: ' + strip(overnight.text).trim());

// ---- Codex transcripts use a different envelope, but feed the same pane ----
const CODEX_FIXTURE = path.join(os.tmpdir(), 'rollout-2026-09-04T12-00-00-12345678-1234-1234-1234-123456789abc.jsonl');
fs.writeFileSync(CODEX_FIXTURE, [
  JSON.stringify({ timestamp: at, type: 'session_meta', payload: { id: '12345678-1234-1234-1234-123456789abc', cwd: __dirname } }),
  JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Codex fixture title' }] } } }),
  JSON.stringify({ timestamp: at, type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c1', input: '*** Update File: README.md' } }),
  JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 4321 }, last_token_usage: { input_tokens: 1234 }, model_context_window: 258400 }, rate_limits: { primary: { used_percent: 37, window_minutes: 300, resets_at: 1788534000 } } } }),
].join('\n') + '\n');
const codex = spawnSync(process.execPath, [SIDEBAR, CODEX_FIXTURE], {
  env: { ...process.env, SIDEBAR_ONCE: '1', COLUMNS: '76', LINES: '30' }, encoding: 'utf8',
});
assert.strictEqual(codex.status, 0, 'Codex fixture exited ' + codex.status + ': ' + codex.stderr);
const codexScreen = strip(codex.stdout);
assert.ok(/ЛІМІТИ · CODEX/.test(codexScreen), 'Codex rate limits are not rendered');
assert.ok(/37%/.test(codexScreen), 'Codex used percentage is missing');
assert.ok(/токени\s+4k/.test(codexScreen), 'Codex token count is missing');
assert.ok(/контекст\s+1k \/ 258k/.test(codexScreen), 'Codex current context is missing');
assert.ok(/codex resume/.test(src), 'Codex sessions cannot be resumed');
assert.ok(/'codex\.toml'/.test(src), 'the Warp installer does not write a Codex tab config');
assert.ok(/"commands = \['codex'\]"/.test(src), 'the Codex Warp pane does not launch codex');
assert.ok(/api\.anthropic\.com\/api\/oauth\/usage/.test(src), 'Claude account limits are not requested');
assert.ok(/slow\('claude-usage', 5 \* 60 \* 1000/.test(src), 'Claude usage must stay off the render path and be cached');
assert.ok(/seven_day_opus/.test(src) && /seven_day_sonnet/.test(src), 'Claude model-specific limits are not rendered');

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
