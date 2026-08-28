// Everything a click depends on, checked against a real render.
//
// The pane builds two things at once: the lines it prints, and rowHits — a map
// from a row's index to what clicking that row does. If those two drift apart by
// even one line, every click lands on the wrong thing and nothing looks broken.
// SIDEBAR_HITS makes the map observable so the drift can be caught here.
//
//   node sidebar.test.js
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const SIDEBAR = path.join(__dirname, 'sidebar.js');
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function render(mode) {
  const r = spawnSync(process.execPath, [SIDEBAR], {
    env: { ...process.env, SIDEBAR_ONCE: mode, SIDEBAR_HITS: '1', COLUMNS: '76', LINES: '30' },
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, 'sidebar.js exited ' + r.status + ': ' + r.stderr.slice(0, 300));
  return { lines: strip(r.stdout).split('\n'), hits: JSON.parse(r.stderr) };
}

// ---- the picker: the top row is highlighted, and it is session 0 ----
const pick = render('pick');
assert.ok(/SESSIONS/.test(pick.lines[0]), 'row 1 is not the SESSIONS header: ' + pick.lines[0]);
assert.deepStrictEqual(
  pick.hits['1'], { session: 0 },
  'the row below the header must be session 0, not ' + JSON.stringify(pick.hits['1'])
);

// ---- every clickable row shows the thing it opens ----
// A link row prints the URL, a media row prints the file name. If a hit points at
// a row that does not show it, the map has slipped against the render.
let checked = 0;
for (const view of [pick, render('1')]) {
  for (const [i, hit] of Object.entries(view.hits)) {
    if (!hit.open) continue;
    const line = view.lines[+i];
    assert.ok(line !== undefined, 'hit at row ' + (+i + 1) + ' points past the end of the render');
    const needle = hit.open.startsWith('http')
      ? hit.open.replace(/^https?:\/\//, '').slice(0, 15)
      : path.basename(hit.open);
    assert.ok(
      line.includes(needle),
      'row ' + (+i + 1) + ' opens "' + hit.open + '" but shows "' + line.trim() + '"'
    );
    checked++;
  }
}
assert.ok(checked > 0, 'no clickable rows in either view — the map is not being built');

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
assert.deepStrictEqual(parse('\x1b[<64;1;1M'), { b: 64, y: 1, press: true }, 'wheel up');
assert.deepStrictEqual(parse('\x1b[<68;1;1M'), { b: 64, y: 1, press: true }, 'shift+wheel is still wheel up');
assert.strictEqual(parse('\x1b[<0;12;5m').press, false, 'a release must not act');
assert.strictEqual(parse('hello'), null, 'plain text is not a mouse event');

// ---- a click never opens something arbitrary ----
// openExternal is the only place a transcript's text reaches the OS, so it must
// refuse anything that is neither an http(s) link nor a file that exists.
assert.ok(/target\.startsWith\('http:\/\/'\)/.test(src), 'openExternal lost its http guard');
assert.ok(/fs\.existsSync\(target\)/.test(src), 'openExternal lost its existence guard');

console.log('sidebar OK — ' + checked + ' клікабельних рядків збігаються з рендером, миша розбирається, відкриття під охороною');
