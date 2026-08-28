# Working on this repo

`sidebar.js` is one file, ~420 lines, no dependencies, and it should stay that way. It is a viewer:
it reads `~/.claude/projects/*/*.jsonl` and writes nothing except a Warp tab config. Any change that
makes it write to a transcript is wrong.

Commits, comments and docs in English. The strings the pane prints are Ukrainian, because that is
the language its user reads — keep them Ukrainian.

## Three invariants, and what breaks if you drop them

**The alternate screen is not optional.** `renderWatch` and `renderPick` repaint the whole pane with
`\x1b[H\x1b[2J`, up to once a second while a session is active. In a block terminal — Warp — that
sequence does not replace the previous frame, it appends. On 2026-08-28 Warp accumulated those frames
until Windows flagged `warp.exe` with `RADAR_PRE_LEAK_64` three minutes after the pane was opened,
and the terminal went down. `ALT_ON` / `ALT_OFF` fix it by giving the pane its own buffer. Do not
remove them, and keep the `process.on('exit')` restore so a crash does not strand the user on a blank
screen.

**A click maps to a session as `pickFrom + y - 2`.** That `2` is the SESSIONS header occupying screen
row 1. Add a line above the list in `renderPick` and every click lands one session off, silently.
`sidebar.test.js` guards exactly this — run it after touching either function.

**Only the newest `TAIL` bytes of a transcript are parsed.** Transcripts reach 100 MB. `startOffset`
and `scanSession` both start at `size - TAIL`; the half-cut first line fails `JSON.parse` and
`ingest` drops it. Reading a transcript whole anywhere in the hot path brings back a one-second
freeze and the memory to match.

## Editing escapes on Windows

Patching this file with a shell heredoc collapses `\\x1b` down to a raw `0x1b` byte, which lands in
the source as an invisible control character. It still runs, which is why it is easy to miss. After
any patch that touches an escape sequence:

```bash
grep -c $'\x1b' sidebar.js   # must print 0
```

If it does not, convert them back — in Python, `t.replace(chr(27), chr(92) + 'x1b')`.

## Before claiming a change works

```bash
node --check sidebar.js
node sidebar.test.js
SIDEBAR_ONCE=1    COLUMNS=76 LINES=24 node sidebar.js | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g'
SIDEBAR_ONCE=pick COLUMNS=76 LINES=24 node sidebar.js | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g'
```

The two `SIDEBAR_ONCE` renders must not emit `1049`, `1000h` or `1006h` — those modes pipe their
output, and a stray mode-switch corrupts whatever reads it.

Interactive behaviour — mouse, keys, the Warp tab — cannot be verified from a tool call. Ask the user
to press the key and report what happened rather than asserting it works.

## Where the pieces live

The pane runs from this repo; nothing is installed into `~/.claude`. The one optional integration is
the `.active-session.json` block inside the user's `statusline.js`, which lives in the separate
`claude-config` repo — README explains the contract. Without it the pane falls back to an mtime scan
and still works, so never assume the file exists.
