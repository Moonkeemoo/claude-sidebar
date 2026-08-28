# claude-sidebar

A read-only companion pane for [Claude Code](https://claude.com/claude-code). Run it in a split
terminal next to your session and it shows, live, what that session is doing: the current plan, the
files it has touched, the links it produced, and the images you pasted into it. Press `Tab` and it
turns into a picker over every Claude session on the machine — click one to open it in a new
terminal tab, resumed.

It follows whichever session took the last turn, so it keeps up when you switch windows.

Node only, no dependencies, one file.

```
── PLAN ─────────────────────────────────────────────
  ✓ Diagnose why Warp closed
  ▸ Make the session rows clickable
  · Write the README
── MEDIA 1 ──────────────────────────────────────────
  1.png  121K  image-cache/9de93e09…/1.png
── FILES 16 ─────────────────────────────────────────
  20:27 ×11 ~/.claude/sidebar.js
  20:17 statusline.js
── LINKS 17 ─────────────────────────────────────────
  https://docs.warp.dev/terminal/windows/tab-configs/
```

## Requirements

Node 18 or newer, and a terminal that supports the alternate screen buffer and SGR mouse reporting.
Warp, Windows Terminal, iTerm2, kitty, WezTerm and GNOME Terminal all do. Without mouse support the
keyboard still works.

## Install

```bash
git clone https://github.com/Moonkeemoo/claude-sidebar.git
```

There is nothing to build and nothing to install into `~/.claude`. Run the file where it landed.

## Use

Split your terminal (`Ctrl+Shift+D` in Warp), narrow the new pane, and run:

```powershell
node C:\Users\tomoo\Documents\GitHub\claude-sidebar\sidebar.js
```

```bash
node ~/Documents/GitHub/claude-sidebar/sidebar.js
```

With no argument it follows the live session. Pass a session id — or any unique prefix of one — to
pin the pane to that session instead:

```bash
node sidebar.js 9de93e09
```

### Keys

| Key | Does |
|---|---|
| `Tab` or `S` | open the session list |
| `↑` `↓`, or `k` `j` | move the selection |
| `Enter` | open the selected session in a new terminal tab, resumed |
| `g` / `G` | jump to the first / last session |
| `Esc` | back to the live view |
| `Q` or `Ctrl+C` | quit |

`Tab` and the arrows work in any keyboard layout. The letter keys also accept their Ukrainian and
Russian positions (`і`/`ы` for `S`, `й` for `Q`, `л`/`о` for `k`/`j`), so you do not have to switch
layouts to drive the pane. `g` and `G` are Latin only.

### Mouse

Click a row to select it, click the selected row to open it, scroll the wheel to move through the
list. While the pane has mouse reporting on, selecting text in it needs `Shift` held down — that is
how every mouse-aware terminal program behaves.

## Opening a session in a new tab

`Enter` (or a second click) writes a Warp tab config and fires `warp://tab_config/claude-resume`,
which opens a tab in the session's own working directory running `claude --resume <id>`. The config
is rewritten immediately before the URI fires, because `warp://` carries no parameters.

Tab configs live where Warp expects them:

| Platform | Directory |
|---|---|
| Windows | `%APPDATA%\warp\Warp\data\tab_configs\` |
| macOS | `~/.warp/tab_configs/` |
| Linux | `${XDG_DATA_HOME:-$HOME/.local/share}/warp-terminal/tab_configs/` |

Only Warp is wired up. On a different terminal the keypress writes the config and nothing opens.

Set `SIDEBAR_NO_LAUNCH=1` to write the tab config without firing the URI, which is how you inspect
what it would have opened.

## Starting Claude with the pane already open

Warp can open a tab already split, each half running its own command, which is the whole setup in
one click. `warp/claude.toml` is that config — Claude Code on the left, this pane on the right.

Copy it into your tab config directory and edit the two `directory` lines:

```powershell
copy warp\claude.toml "$env:APPDATA\warp\Warp\data	ab_configs\"
```

It then appears in the `+` menu in the tab bar. To make it what every new tab does, mark it as the
default tab in Warp's sidecar panel; after that `Ctrl+T` opens Claude and the pane together.

There is no way to trigger this by typing `claude` in an already-open pane. A shell running inside a
pane cannot split the pane it lives in, and a Claude Code `SessionStart` hook cannot either — a hook
runs as a child process with no say over the terminal's layout. The tab has to be opened as a tab.

Panes in a Warp split are always equally sized, so the config gives you a half-and-half tab. Drag the
divider once and Warp remembers it for that config.

## Following the live session

By default the pane picks the transcript with the newest modification time and re-checks once a
second. That guesses, and it guesses wrong the moment a second session takes a turn in parallel.

To make it exact, have your status line publish the session that just moved. Claude Code runs the
status line command only for the session taking a turn, so the file it writes is authoritative.
Add this to your `statusline.js`, wherever it has parsed its stdin JSON as `j`:

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

The pane reads that file, falls back to the mtime scan when it is missing or stale, and ignores it
entirely when you pinned a session with an argument.

## Test

```bash
node sidebar.test.js
```

It renders the picker and checks the two things a click depends on: that the session list starts on
screen row 2, and that an SGR mouse report parses to the right button once modifier keys are masked
off. Both read their expectations out of `sidebar.js` itself, so they cannot drift.

## What it deliberately does not do

It never writes to a transcript and never talks to Claude — it reads `~/.claude/projects/*/*.jsonl`
and nothing else.

Only the newest 3 MB of a transcript is parsed. Sessions reach 100 MB, and reading one whole on
every switch costs a second and the memory to match; a truncated count is shown as `FILES 21+`.

Images are listed by name, size and path, not drawn. Terminal image protocols are not worth the
dependency here, and Warp on Windows does not support them anyway.

## Environment variables

| Variable | Effect |
|---|---|
| `SIDEBAR_ONCE=1` | render the live view once and exit |
| `SIDEBAR_ONCE=pick` | render the picker once and exit |
| `SIDEBAR_NO_LAUNCH=1` | write the tab config, do not fire the URI |

The `SIDEBAR_ONCE` modes skip the alternate screen and mouse reporting so their output pipes
cleanly.
