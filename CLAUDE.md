# Working on this repo

`sidebar.js` is one file, ~1000 lines, no dependencies, and it should stay that way. It is a viewer:
it reads `~/.claude/projects/*/*.jsonl` and writes nothing except a Warp tab config. Any change that
makes it write to a transcript is wrong.

Commits, comments and docs in English. The strings the pane prints are Ukrainian, because that is
the language its user reads — keep them Ukrainian.

## Six invariants, and what breaks if you drop them

**The alternate screen is not optional.** `renderWatch` and `renderPick` repaint the whole pane with
`\x1b[H\x1b[2J`, up to once a second while a session is active. In a block terminal — Warp — that
sequence does not replace the previous frame, it appends. On 2026-08-28 Warp accumulated those frames
until Windows flagged `warp.exe` with `RADAR_PRE_LEAK_64` three minutes after the pane was opened,
and the terminal went down. `ALT_ON` / `ALT_OFF` fix it by giving the pane its own buffer. Do not
remove them, and keep the `process.on('exit')` restore so a crash does not strand the user on a blank
screen.

**Rows reach the screen through `panel()`, and nothing else may push one.** It is what records
`rowHits[i]` (what a click there opens) and `blockAt[i]` (which block the wheel should move), and what
runs every row through `clip()`. Push a line straight into `out` and both maps slip against the
render from that point down: clicks land on the wrong thing, the wheel scrolls the wrong block, and
the screen still looks perfectly correct. Both renderers reset the maps on entry — keep that.

**`clip()` is the only thing standing between a long or dirty value and a broken frame.** A row wider
than the pane wraps and costs two screen lines; a row containing a newline — an `ai-title` can — does
the same. Either shifts every row below it. `clip` truncates to the width and drops control
characters, so every row goes through it, including rules, empty-block text and the footer.

**`paint()` owns the height.** It pads and truncates to exactly `H() - 1` rows and puts the footer on
the last of them. Writing a full screen plus a newline scrolls the terminal by a row, and on a block
terminal that row never comes back. `layout()` keeps blocks inside that budget by sharing rows out
with `share()`; anything that does not fit scrolls inside its block.

`sidebar.test.js` guards all three, at five window sizes, and goes red on a single stray `out.push`.
Run it after touching a renderer, `panel`, `layout` or `bodyItems`.

**`openExternal` is the only path from a transcript to the operating system.** It opens an `http`/
`https` link or a file that exists, nothing else. Both it and `openInTab` go through `rundll32` on
Windows: no shell, so an `&` or a `|` inside a URL cannot become syntax, and no console window
flashing up to take the foreground away from Warp before the URI arrives. Keep the guard in
`openExternal` where it is — `openInTab` fires a URI this program built, and does not need it.

**Nothing slow runs on the render path.** Walking a repo, asking git, listing processes: all of them
go through `slow(key, ttl, run)`, which hands back whatever answer it already has, starts the work
when that has gone stale, and calls `draw()` when the real one lands. One job per key at a time, so a
pointer resting on a session cannot pile up a queue. Call any of them directly from a renderer and
the pane stops repainting while a `node_modules` gets counted.

**Only the newest `TAIL` bytes of a transcript are parsed.** Transcripts reach 100 MB. `startOffset`
and `scanSession` both start at `size - TAIL`; the half-cut first line fails `JSON.parse` and
`ingest` drops it. Reading a transcript whole anywhere in the hot path brings back a one-second
freeze and the memory to match.

## Editing escapes on Windows

Patching this file with a shell heredoc collapses `\\x1b` down to a raw `0x1b` byte, which lands in
the source as an invisible control character. It still runs, which is why it is easy to miss. After
any patch that touches an escape sequence:

`sidebar.test.js` fails on any control character in the source, which is the general form of this.
`\x1b` is not the only one that collapses: `\b` becomes a backspace byte the same way, and a regex
written `/\b(host)\b/` then asks for a literal backspace on either side — it matches nothing, on
every input, and says nothing about it. That is how `\b([a-z0-9-]*\.vercel\.app)\b` was quietly
turned off on 2026-08-28.

The collapse happens whether the heredoc writes the file or feeds a script that writes it: `python -
<<'PY'` mangles the source before Python ever parses it. To find the damage by hand:

```bash
node -e "require('fs').readFileSync('sidebar.js','utf8').split(/\r?\n/).forEach((l,i)=>{if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(l))console.log(i+1,JSON.stringify(l))})"
```

Convert them back in Python: `t.replace(chr(27), chr(92) + 'x1b')`, `t.replace(chr(8), chr(92) + 'b')`.

The Edit tool has the same hazard in a narrower form: a `\uXXXX` in the string you hand it
arrives as the character itself, so an edit anchored on `k === '\u001b'` never matches the
source it is looking at. `\x1b` survives intact. Anchor on a neighbouring line instead, or patch
that line with sed.

## Before claiming a change works

```bash
node --check sidebar.js
node sidebar.test.js
SIDEBAR_ONCE=1    COLUMNS=76 LINES=24 node sidebar.js | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g'
SIDEBAR_ONCE=pick COLUMNS=76 LINES=24 node sidebar.js | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g'
```

The two `SIDEBAR_ONCE` renders must not emit `1049`, `1000h`, `1003h` or `1006h` — those modes
pipe their output, and a stray mode-switch corrupts whatever reads it.

Interactive behaviour — mouse, keys, the Warp tab — cannot be verified from a tool call. Ask the user
to press the key and report what happened rather than asserting it works.

## Where the pieces live

The pane runs from this repo; nothing is installed into `~/.claude`. The one optional integration is
the `.active-session.json` block inside the user's `statusline.js`, which lives in the separate
`claude-config` repo — README explains the contract. Without it the pane falls back to an mtime scan
and still works, so never assume the file exists.
