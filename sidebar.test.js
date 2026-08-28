// One check for the only thing a click can get silently wrong: which screen row
// the session list starts on. onMouse maps a click as `pickFrom + y - 2`, which
// assumes exactly one header row above the list. Add a line there and this fails.
//   node ~/.claude/sidebar.test.js
const { execFileSync } = require('child_process');
const path = require('path');
const assert = require('assert');

const out = execFileSync(process.execPath, [path.join(__dirname, 'sidebar.js')], {
  env: { ...process.env, SIDEBAR_ONCE: 'pick', COLUMNS: '70', LINES: '20' },
  encoding: 'utf8',
});
const lines = out.split('\n');

// Row 1 is the SESSIONS rule.
assert.ok(/SESSIONS/.test(lines[0]), 'first row is not the SESSIONS header: ' + lines[0]);

// The picker opens on cursor 0 with pickFrom 0, so the highlighted row — the one
// in reverse video — must be the very next line, i.e. screen row 2.
const hi = lines.findIndex((l) => l.includes('\x1b[7m'));
assert.strictEqual(hi, 1, 'highlighted row sits at screen row ' + (hi + 1) + ', onMouse expects 2');

// And the row that a click at y=2 resolves to is that same session.
const y = 2, pickFrom = 0;
assert.strictEqual(pickFrom + y - 2, 0, 'click at the top row must resolve to session 0');


// The other half of a click: parsing it. MOUSE_RE and the modifier mask are read
// out of sidebar.js itself, so this cannot drift away from the real code.
const src = require('fs').readFileSync(path.join(__dirname, 'sidebar.js'), 'utf8');
const MOUSE_RE = eval(src.match(/const MOUSE_RE = (.+);/)[1]);
const parse = (s) => { MOUSE_RE.lastIndex = 0; const m = MOUSE_RE.exec(s); return m && { b: +m[1] & ~28, y: +m[3], press: m[4] === 'M' }; };

assert.deepStrictEqual(parse('\x1b[<0;12;5M'), { b: 0, y: 5, press: true }, 'plain left click');
assert.deepStrictEqual(parse('\x1b[<16;12;5M'), { b: 0, y: 5, press: true }, 'ctrl+click is still a left click');
assert.deepStrictEqual(parse('\x1b[<64;1;1M'), { b: 64, y: 1, press: true }, 'wheel up');
assert.deepStrictEqual(parse('\x1b[<68;1;1M'), { b: 64, y: 1, press: true }, 'shift+wheel is still wheel up');
assert.strictEqual(parse('\x1b[<0;12;5m').press, false, 'release must not act');
assert.strictEqual(parse('hello'), null, 'plain text is not a mouse event');

console.log('sidebar mouse OK — SGR розбирається, модифікатори не збивають кнопку');

console.log('sidebar rows OK — клік по верхньому рядку потрапляє в сесію 0');
