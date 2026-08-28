# claude-sidebar

A companion pane for [Claude Code](https://claude.com/claude-code). Run it in a split terminal next
to your session and it shows, live, what that session is doing — the plan it is working through, the
files it has touched, the links it produced, and the images you pasted in. Press `Tab` and it becomes
a list of every Claude session on the machine; pick one and it opens in a new terminal tab, resumed.

It follows whichever session took the last turn, so it keeps up when you move between windows.

Node only, no dependencies, one file. It reads transcripts and never writes to them.

## The two screens

**The live view** is what you get on start. It opens with every session that has moved in the last
three hours, then the plan, media, files and links of the one it is following:

```
── СЕСІЇ 5 1–3 ──────────────────────────────────────
 ● зараз  Status line modific  Bash git push
 ◐  2 хв  Reef сессія - варп   чекає на тебе
 ◑ 1 год  Пошук інструменту    Edit sidebar.js
── ПЛАН 3 ───────────────────────────────────────────
  ✓ Diagnose why Warp closed
  ▸ Make the session rows clickable
  · Write the README
── МЕДІА 1 ──────────────────────────────────────────
  1.png  121K  image-cache/9de93e09…/1.png
── ФАЙЛИ 25 1–4 ─────────────────────────────────────
  20:27 ×11 ~/.claude/sidebar.js
  20:17 statusline.js
── ЛІНКИ 17 ─────────────────────────────────────────
  https://docs.warp.dev/terminal/windows/tab-configs/

 Tab — список · клік відкриває · колесо гортає блок · q — вихід
```

The mark in front of a session is the useful part of that first block:

| Mark | Means |
|---|---|
| `●` green | moving right now, with the tool it is running beside it |
| `◐` yellow | the turn ended and nothing will happen until you say something |
| `◑` | it has a tool call open but has not written for a while |
| `○` | cold, nothing in the last three hours |

`◐` is the one to look for. A session that reported and stopped will not restart on its own, and with
several running in parallel that is the state easiest to lose track of. The session the pane is
following is the one shown in cyan.

`── ФАЙЛИ 25 1–4 ──` means the block holds 25 rows and is showing the first four of them — scroll it
to see the rest. `FILES 16+` with a plus is a different thing: the count comes from the newest slice
of a long transcript rather than the whole of it. Greyed-out file rows are temp paths. The МЕДІА and
ЛІНКИ rows are clickable — see [Mouse](#mouse).

**The session list** opens on `Tab`. Every Claude session on the machine, newest first, titled by what
the session was actually about. Move the highlight and the blocks below it switch to that session's
project, media, files and links, so you can find a conversation by what it touched rather than by its
id.

ПРОЄКТ is the repo the session is working in and the addresses that repo is deployed to, both
clickable. Sessions are usually started in the directory that holds every repo, so the cwd names no
project — the files a session touched do, and their first path segment under that directory is the
repo. The deployments come from the repo's own markdown, one level down at most, plus any
`*.vercel.app` the conversation itself mentioned; preview URLs are left out, they are dead within
days and there are far more of them than real ones.

```
── СЕСІЇ 88 1–4 ─────────────────────────────────────
 ● сьогодні 21:45  Status line modification and warp
 ◐ сьогодні 21:44  Reef сессія - варп закрився
 ◑ сьогодні 20:27  Пошук інструменту для гуманізації
 ○ вчора    18:02  Mono card API balance tracking
── ФАЙЛИ 25 1–4 ─────────────────────────────────────
  21:45 ×20 claude-sidebar/sidebar.js
  …
 ↑↓ вибір · клік або Enter відкриває · колесо гортає · Tab назад
```

The pane's own labels are Ukrainian.

## Fitting the window

The whole pane always fits: it paints exactly as many rows as the window has and never wraps a line.
Blocks are handed the room they ask for while there is enough, and share what is left evenly when
there is not — so two images never cost a long file list a quarter of the pane. Anything that does
not fit scrolls inside its own block instead of pushing the footer off the bottom.

That is why nothing here reflows when you drag the divider. Make the pane narrower and rows get
clipped with an `…`; make it shorter and blocks give up rows to each other and start scrolling.

## Install

```bash
git clone https://github.com/Moonkeemoo/claude-sidebar.git
```

Nothing to build, nothing to install into `~/.claude`. Run the file where it landed.

You need Node 18 or newer and a terminal that supports the alternate screen and SGR mouse reporting —
Warp, Windows Terminal, iTerm2, kitty, WezTerm and GNOME Terminal all do. Without mouse support the
keyboard still drives everything.

## Run it

Split your terminal — `Ctrl+Shift+D` in Warp — narrow the new pane, and run one of these in it:

```powershell
node C:\Users\tomoo\Documents\GitHub\claude-sidebar\sidebar.js
```

```bash
node ~/Documents/GitHub/claude-sidebar/sidebar.js
```

With no argument it follows the live session. Give it a session id, or any unique prefix of one, and
it pins to that session and stops following:

```bash
node sidebar.js 9de93e09
```

## What to press

| Press | What happens |
|---|---|
| `Tab` or `S` | open the session list, and press it again to close it |
| `↑` `↓`, or `k` `j` | move the highlight; the blocks below follow it |
| `g` / `G` | jump to the newest / oldest session |
| `Enter` | open the highlighted session in a new terminal tab, resumed |
| `Esc` | leave the list, back to the live view |
| `Q` | quit |
| `Ctrl+C` | quit |

`Tab` and the arrow keys work in any keyboard layout, and so do the letters — the pane accepts them in
their Ukrainian and Russian positions too (`і`/`ы` for `S`, `й` for `Q`, `л` and `о` for `k` and `j`).
You never have to switch layouts to drive it. `g` and `G` are the exception, Latin only.

### Mouse

**The row under the pointer lights up when clicking it would do something**, so you can tell a live
row from an inert one without trying it. Rules, plan lines and empty blocks stay dark.

Files, links and media are clickable on both screens. **Click a link and it opens in your browser,
click a file or a pasted image and it opens in whatever your system opens that with.** That works in
the live view and in the session list alike, so you can find an old conversation, see the screenshot
you pasted into it, and open it without leaving the pane.

In the live view, **a click anywhere in the СЕСІЇ block opens the session list**, on the session you
clicked. That includes its header and the line saying nothing has moved, so the block is one target
however empty it is. In the list itself, **a click on a session row opens that session** — the same
thing `Enter` does, without moving the highlight there first.

**The wheel scrolls whatever the pointer is over, and only that.** Put it on ФАЙЛИ and the file list
moves while the session list above stays where it was; move to ЛІНКИ and that one moves instead. Each
block keeps its own position, so a block you scrolled stays scrolled while the pane keeps updating
around it.

A click can never run a command. A row opens only an `http`/`https` link or a file that exists on
disk, and the target is handed to the operating system as one argument rather than through a shell —
the links come out of transcripts, and a transcript can contain anything.

While the pane is listening for the mouse, selecting text inside it needs `Shift` held down. That is
how every mouse-aware terminal program behaves, not a quirk of this one.

## Opening a session in its own tab

`Enter`, or a click on the row, opens a new Warp tab split the same way this one is: the session's own
working directory running `claude --resume <id>`, with a pane of this program beside it. You are back
in that conversation with its history intact and still watching it.

It works by writing a Warp tab config and then firing `warp://tab_config/claude-resume`. The config is
rewritten immediately before the URI fires, because a `warp://` link carries no parameters of its own.
The file lands in:

| Platform | Directory |
|---|---|
| Windows | `%APPDATA%\warp\Warp\data\tab_configs\` |
| macOS | `~/.warp/tab_configs/` |
| Linux | `${XDG_DATA_HOME:-$HOME/.local/share}/warp-terminal/tab_configs/` |

Only Warp is wired up. On another terminal the keypress writes the config and nothing opens.

To see what it would have launched without launching it, run the pane with `SIDEBAR_NO_LAUNCH=1` — the
config gets written, the URI does not fire.

## Starting Claude and the pane together

A shell cannot split the pane it is running in, and neither can a Claude Code `SessionStart` hook — a
hook is a child process with no say over the terminal's layout. So there is no way to make typing
`claude` grow a sidebar next to itself. What works instead is opening a tab that is already split.

`warp/claude.toml` is that tab: Claude Code on the left, this pane on the right.

1. Copy it into your tab config directory, then open it and fix the two `directory` lines — they point
   at one machine's paths and you will want your own.

   ```powershell
   Copy-Item warp\claude.toml "$env:APPDATA\warp\Warp\data\tab_configs\"
   ```

2. Click the `+` at the right of Warp's tab bar. `Claude + sidebar` is now in that menu — click it and
   the tab opens with both halves already running.

3. Optional: mark the config as the default tab in Warp's sidecar panel. After that `Ctrl+T` opens
   Claude and the pane together every time, and step 2 stops being a step.

Panes in a Warp split are always equally sized, so the tab opens half and half. Drag the divider once
to narrow the pane and Warp remembers it for that config.

## Following the live session

Left alone, the pane picks the transcript with the newest modification time and re-checks once a
second. That is a guess, and it guesses wrong the moment a second session takes a turn in parallel.

To make it exact, have your status line publish the session that just moved. Claude Code runs the
status line command only for the session taking a turn, so what it writes is authoritative rather than
inferred. Add this to your `statusline.js`, wherever it has already parsed its stdin JSON as `j`:

```js
try {
  const fs = require('fs'), path = require('path'), os = require('os');
  fs.writeFileSync(
    path.join(os.homedir(), '.claude', '.active-session.json'),
    JSON.stringify({
      session_id: j.session_id || null,
      session_name: j.session_name || null,
      transcript_path: j.transcript_path || null,
      cwd: (j.workspace && j.workspace.current_dir) || j.cwd || null,
      ts: Date.now(),
    })
  );
} catch { /* the status line must render regardless */ }
```

The pane reads that file, falls back to the mtime scan when it is missing, and ignores it entirely
when you pinned a session with an argument. Nothing breaks if you skip this.

## Test

```bash
node sidebar.test.js
```

The pane builds three things on every frame: the lines it prints, a map from each row to what clicking
it does, and a map from each row to the block it belongs to. Let any of them drift by a single line
and clicks land on the wrong thing, or the wheel scrolls the wrong block, while the screen still looks
right.

So the test renders both views for real, at five window sizes, and checks that the frame never
overflows the window or wraps a line, that every clickable row actually shows the link or file it
claims to open and sits inside a block, that the row under the header is the first session, that a
squeezed window makes something report a scroll window, that a mouse report resolves to the right
button with `Shift` or `Ctrl` held, and that the opener still refuses anything but a link or an
existing file. Insert one stray line into a renderer and it goes red.

## What it deliberately does not do

It reads `~/.claude/projects/*/*.jsonl` and nothing else. It never writes to a transcript and never
talks to Claude.

Only the newest 3 MB of a transcript is parsed. Sessions reach 100 MB, and reading one whole on every
switch costs a second and the memory to match — hence the `+` on truncated counts.

Images are listed by name, size and path, not drawn. Inline image protocols would cost a dependency,
and Warp on Windows does not support them anyway.

## Environment variables

| Variable | Effect |
|---|---|
| `SIDEBAR_ONCE=1` | render the live view once and exit |
| `SIDEBAR_ONCE=pick` | render the session list once and exit |
| `SIDEBAR_NO_LAUNCH=1` | write the tab config, do not fire the URI |
| `SIDEBAR_HITS=1` | dump the row-to-click and row-to-block maps to stderr on every frame |
| `COLUMNS`, `LINES` | the pane size to lay out for when stdout is not a terminal |

The `SIDEBAR_ONCE` modes skip the alternate screen and the mouse, so their output pipes cleanly into
`grep` and friends.
