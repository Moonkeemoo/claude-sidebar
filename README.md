# claude-sidebar

A companion pane for [Claude Code](https://claude.com/claude-code). Run it in a split terminal next
to your session and it shows, live, what that session is doing — the files it has touched, the links it
produced, the images you pasted in, and what the machine is spending itself on meanwhile. Press `Tab` and it becomes
a list of every Claude session on the machine; pick one and it opens in a new terminal tab, resumed.

It latches onto the session in its own tab and stays there, so a pane open beside reef keeps showing
reef however many other sessions take a turn meanwhile.

Node only, no dependencies, one file. It reads transcripts and never writes to them.

## The three screens

**The live view** is what you get on start. It opens with every session that has moved in the last
three hours, then what the machine is doing, then the plan, media, files and links of the session it
is following:

```
── СЕСІЇ 5 1–3 ──────────────────────────────────────
 ● зараз  Status line modific  Bash git push
 ◐  2 хв  Reef сессія - варп   чекає на тебе
 ◑ 1 год  Пошук інструменту    Edit sidebar.js

── ЗАЛІЗО колонки ───────────────────────────────────
  CPU 31% · RAM 56% 17.9G/31.9G · VRAM 24% · NET ↓3K ↑4K · диск 254G
  100%┤
      │                         ▂▆▇▄▁
      │                    ▃▅▅▄▆█████▆▇█▇▃
      ┤                  ▁▆███████████████▅▁ ▁▂
      │ ▃▃▁   ▂▄▂  ▁▄▇█▆▆██████████████████████▇▃  ▁
      │████▅▅▇███▇▆███████████████████████████████▇█
     0┤█████████████████████████████████████████████

                       RAM   CPU
  chrome         ×24    3.8G    5%  claude ×8
  svchost        ×93    1.6G    2%
  claude         ×3     1.4G    2%
  решта          ×357  10.0G    6%

── АГЕНТИ 2 ───────────────────────────────────────
  ▸ Review balance config              3 хв
  ✓ Pull GameFlow from Coda            6 хв

── МЕДІА 1 ──────────────────────────────────────────
  1.png  121K  image-cache/9de93e09…/1.png

── ФАЙЛИ 6 1–2 ──────────────────────────────────────
  20:27 docs/plan.md
  20:17 showcase/dashboard.html

── ЛІНКИ 17 ─────────────────────────────────────────
  https://docs.warp.dev/terminal/windows/tab-configs/

 Tab — список · v — вид графіка · клік відкриває · колесо гортає · q — вихід
```

The mark in front of a session is the useful part of that first block:

| Mark | Means |
|---|---|
| `●` green | moving right now, with the tool it is running beside it |
| `◐` yellow | the turn ended and nothing will happen until you say something |
| `◉` cyan | an agent is still out — the session is working, not waiting on you |
| `◑` | it has a tool call open but has not written for a while |
| `○` | cold, nothing in the last three hours |

`◐` is the one to look for. A session that reported and stopped will not restart on its own, and with
several running in parallel that is the state easiest to lose track of. The session this pane is
holding carries a `▸` and its name in cyan — worth a glance, because the pane deliberately stays on
it while other rows move.

`── ФАЙЛИ 6 1–2 ──` means the block holds six rows and is showing the first two of them — scroll it
to see the rest. `ФАЙЛИ 6+` with a plus is a different thing: the count comes from the newest slice
of a long transcript rather than the whole of it. Greyed-out file rows are temp paths. The МЕДІА and
ЛІНКИ rows are clickable — see [Mouse](#mouse).

ФАЙЛИ holds only what a person opens and looks at: notes, pages, screenshots, PDFs. A session touches
far more than that, and a list of sources, configs and probe scripts, each carrying the number of
times it was written to, records the work instead of offering anything to click. One file arriving
under two names — absolute from an `Edit`, relative from a shell line — is one row.

ЗАЛІЗО is the machine rather than the session: one sample a second, the newest at the right edge and
the history reaching back as far as the pane is wide. A column is one of those seconds, drawn as tall
as the heaviest reading that has a ceiling to be a share of — processor, memory, video memory — and
coloured by how close that came to the ceiling. Green while there is room, amber once the machine is
working for it, red at the wall, so the moment a build took the box is a red stretch you find without
reading a number. Eighth-blocks give a seven-row chart fifty-six levels, which is enough that an idle
machine draws a floor rather than an empty frame. Traffic stays out of the height, having no ceiling
to be measured against, and keeps its rate in the numbers above; those numbers are the current
reading of every series. VRAM comes from `nvidia-smi`, and where that is not on PATH it is absent
from both. Under about two dozen rows the pane keeps the numbers and drops the chart, which would be
squeezed into its own empty ceiling.

`V`, or a click anywhere on the chart, switches how it is drawn, and the rule says which of the five
is up. **Колонки** is the default above, and the only one that answers how loaded the machine was
rather than which part of it was busy. **Лінії** puts all four series on one grid — CPU yellow, RAM
cyan, VRAM green, NET magenta — in box drawing: a run along a row where a reading holds, a corner
where it turns, a stem down the rows it jumped. That is one level per row against braille's four, and
it is what makes a series a line rather than a column of marks — the same trade every console chart
from asciichart down makes, and the shape is the part being read. **Брайль** takes the finer grid
instead, which is what to reach for when two series sit a few percent apart and their lines land on
the same row. **Тепло** drops position altogether: a row per series, a column per sample, dark blue
idle through to red pinned — three rows instead of nine, and no series can hide under another.
**Тепло ×2** paints two samples into every cell, upper half over lower, so the same three rows carry
twice the history. The choice lives as long as the pane does; a restart comes back on columns.

Under the chart is what is holding the machine, grouped by program rather than listed by process: a
browser is thirty-odd processes and not one of them is ever heavy on its own, which is how a pane can
report four hundred megabytes while the machine is using seventeen gigabytes. The columns are memory
and processor share, the `×` is how many processes the group holds, and решта sums everything below the
cut so the numbers add up to the machine. `claude` marks the ones inside Claude Code's own tree — a
dev server it started, a headless browser a test left behind — with a count when only some of the
group is: `claude ×8` of twenty-four browser processes is a test suite, not your tabs. A node process
is named by the script it runs, because `node.exe` names nothing.

NET is the fourth line on the chart and the odd one out: traffic has no ceiling to be a percentage of,
so the line is scaled to the busiest moment on show and the legend carries the actual rate. It is
read from the same poll as the processes, five seconds apart, so it steps where the other three flow.
The disk figure beside it is free space on the system drive, which moves slowly enough not to need a
line of its own.

АГЕНТИ appears when a session has handed work to subagents: what it dispatched, whether the answer
has come back, and how long it has been out. `▸` is still running, `✓` came back and the time beside
it is how long it took. A session waiting on three agents shows nothing about them in its own last
line, which is exactly when you want to know.

**The spend screen** opens on `A`, and answers where a session's tokens and minutes went.

```
── ВИТРАТИ · Сайдбар ──────────────────────────
  контекст   437k  токенів у промті останнього ходу
  кеш        99% зчитано  809k записано в кеш
  вихід      484k  думання 253k  ·  ходів 479
  час        2 год  транскрипт 5M  ·  opus-5
  з них      18 хв в інструментах  ·  1 год 42 хв модель і очікування
  ⏱ Bash висить 6 хв

── КОНТЕКСТ ────────────────────────────────
  437k┤                              ╭──────
      │                ╭────────────╯
      │   ╭─────────╯
     0┤───╯

── ПЕРЕБІГ ─────────────────────────────────
  вихід ███▓▓▒░░▒▓██▓▒░░░▒▓███▓▒░
  збої  ░░░░█░░░░░░░░░██░░░░░░░░░
  09:00                        11:00

── ІНСТРУМЕНТИ ─────────────────────────────
                     виклики   вихід     час   збої
  Bash                   179     36k   12 хв      7
  Edit                    98      4k    1 хв      2
  WebSearch                2      1k    14 с      ·

── ЦІНА ───────────────────────────────────
  разом             18.7M  еквівалентних токенів входу
  кеш перечитано    14.8M  ████████████████░░░░  79%
  вихід і думання    2.8M  ███░░░░░░░░░░░░░░░░░  15%
  запис у кеш        1.1M  █░░░░░░░░░░░░░░░░░░░  6%
  один хід            50k  на початку 6k  ·  дорожче в 7.7 раза
  намарно          10 викликів впало намарно

── СКЛАД КОНТЕКСТУ ──────────────────────
  база          65k  ███░░░░░░░░░  системний промт, інструменти, пам'ять
  розмова      433k  ██████████░░  за 20 запитів
  з неї         51k  ██░░░░░░░░░░  відповіді інструментів, приблизно

── ЗБОЇ ──────────────────────────────────
  виняток у скрипті   4  ████░░░░░░  SyntaxWarning: invalid escape sequence…
  якір Edit не знайдено  2  ██░░░░░░░░  String to replace not found in file…
  синтаксис у команді   1  █░░░░░░░░░  unexpected EOF while looking for matching…

── НАЙДОРОЖЧІ ЗАПИТИ ──────────────────
  10:40   170k 63 х   14 хв  думаю що ще корисного додати
  09:28   119k 54 х    6 хв  ось тут відображаються всі файли — мене ціка…
  медіана запиту 92k токенів  ·  87k у середньому
```

Four numbers say most of it. **Контекст** is the prompt of the newest turn — everything the model was
handed on that one call, which is what fills up and what a compaction resets. **Кеш** is the share of
those tokens that came out of the prompt cache rather than being written into it; a session sitting at
99% is being extended, one that keeps dropping to the fifties is having its prefix rebuilt, which is
where money goes without anything looking wrong. **Думання** is how much of the output was reasoning
rather than answer. And a `⏱` row appears for a call that was dispatched and never came back — the
difference between a session working and a session hung.

The tool table is ranked by what came back, not by how often it was called: a tool used twice that
returns a megabyte each time is the leak, and every list sorted by call count buries it under
something called three hundred times. **Вихід** is the result size in tokens, four characters to one,
near enough to rank on. **Час** is wall clock spent inside that tool, which is where a session's hours
actually go. **Збої** counts results that came back as errors; a tool with a high count there is a
retry loop nobody noticed.

The bands are colour rather than shading — dark where the session was quiet, bright where it burned.

КОНТЕКСТ is that first number drawn across the session, against its own peak. A staircase climbing
to the right is a session carrying everything it has ever read; a cliff is a compaction. ПЕРЕБІГ puts
the same span underneath as two bands — what was generated, and where results came back as errors —
cut into as many slices as the pane is wide, so an hour of nothing looks like an hour of nothing. A
bright patch in the lower band is a retry loop, sitting directly under the minutes that produced it.

ЦІНА is the bill, in one unit. A prompt token read out of cache costs a tenth of a fresh one, a token
written into the cache a quarter more, and output five times input — the ratios every Claude model is
priced on — so adding them up in input-token equivalents shows the shape of what was spent. On a long
session that shape surprises people: four fifths of it is the same prompt being re-read on every
single turn, and none of it is the answers. That is what the ОДИН ХІД line is for — the context times
the cache rate, which is what the next turn will cost before it does anything. Seven times what it
cost at the start is not a session going wrong; it is a session that should have been two.

ЗБОЇ sorts failures by what they are rather than by which tool reported them. Six failed Bash calls
say nothing; four of them being the same missing path says where the session was going wrong, and an
Edit that lost its anchor twice says the file moved under it. Every pattern was read out of real
transcripts on this machine.

СКЛАД КОНТЕКСТУ is as far as a transcript can answer what the window is made of. The base is
measured rather than guessed: it is the prompt of the very first turn, before anything had been
said, so it is the system prompt, every tool definition and the memory files, together. Everything
above it is the conversation, and the share of that which came back from tools is an estimate at
four characters to the token — enough to tell a window full of talk from a window full of output
nobody read.

НАЙДОРОЖЧІ ЗАПИТИ ranks rounds rather than tools: one thing asked and everything the model did
about it, by what it wrote plus what it had to write into the cache. The columns are that cost, how
many turns it took and how long it ran, and the line is what was asked — which is how a round is
remembered, rather than by which tools it happened to use. The median and the mean under the table
say whether one round was expensive or the whole session runs that way.

Reading all of it costs a pass over the whole transcript, which for a hundred-megabyte file is about
six hundred milliseconds — taken eight megabytes at a time so the pane keeps painting, and only while
this screen is open.

**The session list** opens on `Tab`. Every Claude session on the machine, newest first, titled by what
the session was actually about. Move the highlight and the blocks below it switch to that session's
project, media, files and links, so you can find a conversation by what it touched rather than by its
id.

ПРОЄКТ is the repo the session is working in, what it weighs and what git thinks of it, and ДЕПЛОЙ
under it is where that repo is deployed — both clickable, and on both screens: the live view shows
them for the session it is following, the list for the one under the highlight. The addresses are a
block of their own because losing one is the reason they are on the pane at all, and the bottom of a
block holding half a year of commits is exactly what scrolls out of sight.

```
── ПРОЄКТ 17 ─────────────────────────────────────────
  github.com/Moonkeemoo/reef            1.2G
    з них node_modules  840M

  пн ██████████████████████████
  вт ██████████████████████████
  ср ██████████████████████████
  чт ██████████████████████████
  пт ██████████████████████████
  сб ██████████████████████████
  нд ██████████████████████████

  feature/waves  ● змінено 3  ↑2 не запушено
    від master  ↓12 відстала  ↑4 своїх
    * 33b0a63   4 хв  Hold one session per pane
    * 8a72738  2 год  Round the line count
    * 41ccca4   1 дн  Weigh the project and report git
    * 2be87de   2 дн  Show which repo a session is in
```

```
── ДЕПЛОЙ ─────────────────────────────────────────
  reef-money-dev.vercel.app
  reef-money.vercel.app
```

Sessions are usually started in the directory that holds every repo and cd into the one they actually
work in, so it is the newest cwd in the transcript that names the project and the first one that names
nothing; from there the pane walks up to the nearest `.git`. A session that never moved out of the
container is placed by the files it touched instead, by their first path segment under it. The
deployments come from the repo's own markdown, one level down at most, plus any `*.vercel.app` the
conversation itself mentioned; preview URLs are left out, they are dead within days and there are far
more of them than real ones. An address inside a fenced block does not count: the frame above is a
picture of another project's pane, and while it counted, every session working in this repo was
reported as deployed to reef. The weight names a child directory only when that child is most of the
answer, which is the only case you can act on.

Between the repo and its branch sits half a year of commits: a row per weekday, a column per week, the
current one last, shaded the way GitHub shades a contribution graph. It belongs to the repo rather
than to the branch, and it answers what no single commit can — not when work last happened here, but
whether it has been happening at all. Shade is relative to the busiest day on show, so a quiet fortnight
in a busy repo still reads as quiet.

Under the branch come its last four commits, oldest at the bottom, each with how long ago it landed —
which is what says whether the branch is still warm without opening a terminal to ask. The column in
front of the hash is `git log --graph`, so a merge shows as one. Clicking a commit opens it on GitHub.
When the branch is not the remote's default, the row above the commits says how far it has drifted
from that default: `↓12 відстала` is twelve commits on master that this branch has never seen, and
`свіжа` is a branch that has seen all of them.

СИРОТИ appears in the live view when a test run walked away from a headless browser. Nothing else
puts a row there — a browser you opened yourself carries no `--headless` and is never counted, and
one younger than ten minutes is still somebody's running test. An empty machine shows no block at
all. Windows only.

```
── СЕСІЇ 88 1–4 ─────────────────────────────────────
 ● сьогодні 21:45  Status line modification and warp
 ◐ сьогодні 21:44  Reef сессія - варп закрився
 ◑ сьогодні 20:27  Пошук інструменту для гуманізації
 ○ вчора    18:02  Mono card API balance tracking

── ФАЙЛИ 6 1–2 ──────────────────────────────────────
  21:45 claude-sidebar/README.md
  …
 ↑↓ вибір · клік перемикає панель · Enter відкриває табом · Tab назад
```

The pane's own labels are Ukrainian.

## Fitting the window

The whole pane always fits: it paints exactly as many rows as the window has and never wraps a line.
Blocks are handed the room they ask for while there is enough, and share what is left evenly when
there is not — so two images never cost a long file list a quarter of the pane. Anything that does
not fit scrolls inside its own block instead of pushing the footer off the bottom.

Every block but the first carries a blank row above its rule, which is a row it takes from the same budget: a short window spends its space on separation before it spends it on content, and the blocks start scrolling sooner than they used to.

That is why nothing here reflows when you drag the divider. Make the pane narrower and rows get
clipped with an `…`; make it shorter and blocks give up rows to each other and start scrolling.

## Install

```bash
git clone https://github.com/Moonkeemoo/claude-sidebar.git
cd claude-sidebar
node sidebar.js --install ~/Documents/GitHub    # the folder your projects live in
```

Nothing to build, no dependencies, nothing installed into `~/.claude`. The pane runs from where it
landed; the one thing `--install` writes is a terminal tab that opens Claude and this pane side by
side — see [Starting Claude and the pane together](#starting-claude-and-the-pane-together), which is
also where to look if your terminal is not Warp.

You need Node 18 or newer and a terminal that supports the alternate screen and SGR mouse reporting —
Warp, Ghostty, Windows Terminal, iTerm2, kitty, WezTerm and GNOME Terminal all do. Without mouse
support the keyboard still drives everything.

### What differs between machines

Everything about sessions — the list, the files, the links, the media, the project and its commits —
is the same everywhere: it is transcripts and git, and both read the same on any machine. The
ЗАЛІЗО block is where the operating system shows through.

| | Windows | macOS | Linux |
|---|---|---|---|
| CPU | node's own tick counters | same | same |
| RAM | free pages | `vm_stat`: held, wired and compressed | free pages |
| VRAM | `nvidia-smi`, when it is on PATH | absent, and no per-process figure exists on any OS | `nvidia-smi` |
| heaviest programs | `Win32_Process` over CIM | `ps` | `ps` |
| СИРОТИ (stranded browsers) | yes | no | no |
| opening a session in its own tab | Warp | Warp, Ghostty | no |

A Mac reads its memory differently on purpose. `os.freemem()` there counts only pages that are free
this instant, which on a Mac awake for an hour is almost none of them — a pane reporting 97% forever
reports nothing. `vm_stat` is asked instead, and the three numbers added up are the ones Activity
Monitor calls Memory Used.

### If you are a Claude setting this up on a Mac

The Mac paths in this file were written on Windows and have never been run on a Mac. They fail
quietly when they are wrong: `slow()` swallows a throw, so a parser that matches nothing looks
exactly like a quiet machine — an empty block, no error. Check them rather than trusting them.

Everything platform-specific is four small functions in `sidebar.js`: `psRows` and `cpuTicks100ns`
parse `ps`, `vmUsed` parses `vm_stat`, and `unixProcesses` is what calls them. `PROC_Q` and
`orphans` are the Windows halves and never run on a Mac.

```bash
node sidebar.test.js                              # the parsers are checked against real samples
ps -Ao pid=,ppid=,rss=,time=,comm= | head -3      # compare with what psRows expects
vm_stat | head -6                                 # and vmUsed with this
SIDEBAR_ONCE=1 COLUMNS=100 LINES=44 node sidebar.js
```

The last one prints a single frame. ЗАЛІЗО should carry a memory figure close to Activity Monitor's,
and after a few seconds of running the pane for real, four rows of the heaviest programs under the
chart. An empty spot where those rows belong means a parser missed — fix it in `psRows` or `vmUsed`,
and add the line that broke it to `sidebar.test.js`, where the samples for both already live.

Three things not to undo while fixing it: no dependencies and one file, the alternate screen (a
block terminal accumulates frames without it and takes the terminal down with it), and
`sidebar.test.js` green. `CLAUDE.md` in this repo has the rest, including an editing hazard on
Windows that does not apply on a Mac but explains the odd-looking code.

Handing this to someone else is one message to their Claude:

> Clone `https://github.com/Moonkeemoo/claude-sidebar`, read its README, and set it up so I get a
> terminal tab with Claude Code on the left and the sidebar on the right. My projects live in
> `~/Documents/GitHub` and my terminal is Ghostty.

## Run it

Split your terminal — `Ctrl+Shift+D` in Warp — narrow the new pane, and run one of these in it:

```bash
node ~/Documents/GitHub/claude-sidebar/sidebar.js
```

```powershell
node $HOME\Documents\GitHub\claude-sidebar\sidebar.js
```

With no argument it pins itself to the first session that takes a turn after it starts — the one in
its own tab. Give it a session id, or any unique prefix of one, and it pins to that instead, before
any turn is taken:

```bash
node sidebar.js 9de93e09
```

## What to press

| Press | What happens |
|---|---|
| `Tab` or `S` | open the session list, and press it again to close it |
| `V` | switch how ЗАЛІЗО draws the load — columns, lines, braille, heat, dense heat |
| `A` | the spend screen — context, cache, and where the tokens and minutes went; again to leave |
| `↑` `↓`, or `k` `j` | move the highlight; the blocks below follow it |
| `g` / `G` | jump to the newest / oldest session |
| `Enter` | open the highlighted session in a new terminal tab, resumed |
| click on a row | move this pane onto that session and stay there |
| `Esc` | leave the list, back to the live view |
| `Q` | quit |
| `Ctrl+C` | quit |

`Tab` and the arrow keys work in any keyboard layout, and so do the letters — the pane accepts them in
their Ukrainian and Russian positions too (`і`/`ы` for `S`, `й` for `Q`, `м` for `V`, `ф` for `A`, `л` and `о` for `k` and `j`).
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
however empty it is. In the list itself, **a click on a session row moves this pane onto that
session** and closes the list — the pane then holds it the way it held the one before, until you
pick another. Opening a session in a tab of its own is `Enter`.

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

`Enter` opens the session in its own working directory running `claude --resume <id>`. You are back
in that conversation with its history intact. A click on the row does the other thing — it moves this
pane onto that session without opening anything.

In Warp that is a new tab, split the same way this one is, with a pane of this program beside it — so
the resumed session comes with its own companion rather than sending you back here to change what this
one watches. In Ghostty it is a split of the window you are already in, because Ghostty has no tab
config to write and nothing to fire a URI at; see [Ghostty](#ghostty) for why.

It works by writing a Warp tab config and then firing `warp://tab_config/claude-resume`. The config is
rewritten immediately before the URI fires, because a `warp://` link carries no parameters of its own.
The file lands in:

| Platform | Directory |
|---|---|
| Windows | `%APPDATA%\warp\Warp\data\tab_configs\` |
| macOS | `~/.warp/tab_configs/` |
| Linux | `${XDG_DATA_HOME:-$HOME/.local/share}/warp-terminal/tab_configs/` |

Warp and Ghostty are wired up; the pane tells them apart by `TERM_PROGRAM`. Anywhere else the keypress
writes the Warp config and nothing opens.

To see what it would have launched without launching it, run the pane with `SIDEBAR_NO_LAUNCH=1` — the
config gets written, the URI does not fire and no split opens.

## Starting Claude and the pane together

A shell cannot split the pane it is running in, and neither can a Claude Code `SessionStart` hook — a
hook is a child process with no say over the terminal's layout. So there is no way to make typing
`claude` grow a sidebar next to itself. What works instead is opening a tab that is already split.

### Warp

In Warp that tab is a tab config, and the pane writes its own:

```bash
node sidebar.js --install                     # Claude starts one directory up
node sidebar.js --install ~/Documents/GitHub  # or wherever you keep your work
```

The paths inside a tab config are absolute, which is why this is a command rather than a file to copy:
one committed to the repo would carry someone else's home directory. `--install` fills in where this
copy of the repo actually landed and where you want Claude to start, and writes `claude.toml` into the
tab config directory for your platform.

Then click the `+` at the right of Warp's tab bar. `Claude + sidebar` is in that menu — click it and
the tab opens with both halves already running. Optionally mark it as the default tab in Warp's
sidecar panel, and `Ctrl+T` opens the pair every time.

What it wrote, for reference:

```toml
name = 'Claude + sidebar'

[[panes]]
id = 'root'
split = 'horizontal'
children = ['claude', 'sidebar']

[[panes]]
id = 'claude'
type = 'terminal'
directory = '/Users/you/Documents/GitHub'
commands = ['claude']
is_focused = true

[[panes]]
id = 'sidebar'
type = 'terminal'
directory = '/Users/you/Documents/GitHub/claude-sidebar'
commands = ['node sidebar.js']
```

Panes in a Warp split are always equally sized, so the tab opens half and half. Drag the divider once
to narrow the pane and Warp remembers it for that config.

### Ghostty

Run the same command, but run it **from inside Ghostty** — the installer works out which terminal it
is in and writes accordingly, so doing this in another one gets you a Warp config instead:

```bash
node sidebar.js --install ~/Documents/GitHub
```

It writes `~/.local/bin/claude-sidebar` and prints the path. If that directory is not on your `PATH`,
either add it or say where to put the launcher instead:

```bash
node sidebar.js --install ~/Documents/GitHub ~/bin/claude-sidebar
```

After that the pair is one command. Open a Ghostty tab and run it:

```bash
claude-sidebar
```

The window splits, Claude starts on the left in the directory you named, and the shell you ran it from
becomes the pane on the right. Nothing is installed and nothing runs in the background: closing the
window closes both halves. Rerun `--install` after moving the repo — the launcher holds absolute paths
and will not follow it.

This needs **Ghostty 1.3 or newer**, which is where AppleScript arrived. Ghostty's About window has the
version; `ghostty +version` also works if the binary is on your `PATH`, which the app does not do for
you.

The pane works out which terminal it is in from `TERM_PROGRAM` and from the variables a terminal
stamps on its own shells. If it ever guesses wrong the symptom is specific: the session list says
`цей термінал сесій не відкриває` along the bottom, or `Enter` opens nothing. Settle it by hand —
`SIDEBAR_TERMINAL=ghostty` in the environment, or in front of any single command:

```bash
SIDEBAR_TERMINAL=ghostty node sidebar.js --install ~/Documents/GitHub
```

#### The permission it asks for once

The first `claude-sidebar` raises a macOS dialog asking to control "Ghostty". That is Automation
permission, and this does not work without it — allow it once and it never asks again.

Decline it, or dismiss it by reflex, and you get the worst kind of failure: the launcher opens no
split, reports nothing, and Claude never starts. Two ways back:

- System Settings → Privacy & Security → Automation, find the app that asked, and switch Ghostty on
  underneath it.
- Or clear every answer you have given and be asked again: `tccutil reset AppleEvents`.

One switch defeats all of this: `macos-applescript = false` in `~/.config/ghostty/config` turns
AppleScript off wholesale, and then no permission helps. It is on by default; you would know if you
had turned it off.

#### When a click opens nothing

Run this, in the Ghostty pane, and paste back what it prints:

```bash
node sidebar.js --check
```

It says which terminal it thinks it is in and why, then actually asks Ghostty to
open a split saying `sidebar ok`, and prints osascript's exit code and error
verbatim. Three answers, three different problems:

| What it prints | What is wrong |
|---|---|
| `розпізнано  нічого` | the terminal was not identified — set `SIDEBAR_TERMINAL=ghostty` |
| a non-zero code with `Not authorized to send Apple events` | the Automation permission above |
| code `0`, but no split appears | AppleScript ran and Ghostty ignored it — check the version is 1.3+ |

The pane reports the same failure on its own: when osascript refuses, the reason
replaces the session list's footer instead of vanishing.

#### Why a script and not a config

Ghostty has nowhere to put a layout. Its config has no session or workspace key, `new_split` takes a
direction and nothing else, and a chained keybind cannot type into a split it just made — every action
in a chain runs against the pane that had focus when the chain started. There is no `ghostty://`
scheme either, and the CLI's "open a window in a running instance" is GTK-only; the macOS version of
that was prototyped and closed as not planned.

What is left is the AppleScript support added in 1.3: `split` a terminal, `input text` into the result.
That is the whole mechanism, and it is why this is a script you run rather than a file you drop
somewhere. Ghostty's maintainers still label AppleScript a preview feature with breaking changes
expected in 1.4, so of everything here this is the part most likely to want revisiting.

## Which session a pane holds

A pane holds one session. Which tab has the focus is not something a terminal will tell a program
running inside it, so the pane infers it from when it started: it and its Claude open together, the
tab config hands the focus to Claude, and the first turn taken after that is therefore this tab's.
The pane pins to that session and stops looking. Two panes open at once end up on two different
sessions, which is the whole point — before this they both read one machine-wide file and showed the
same session in every tab.

Until that first turn the pane shows whatever moved last, so it has something to show rather than an
empty frame. Type into another tab before your own and it pins there instead: press `Tab`, click the
session you meant, and it re-pins to that one for good.

Knowing which session took a turn needs a hand from your status line. Claude Code runs the status
line command only for the session taking the turn, so what it writes is authoritative rather than
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

Without that file the pane never gets its pairing signal and falls back to the transcript with the
newest modification time, re-checked once a second — a guess that goes wrong the moment a second
session takes a turn in parallel. It ignores the file entirely when you pinned a session with an
argument. Nothing breaks if you skip this; clicking the session you want in the list still pins it.

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
| `SIDEBAR_TERMINAL=ghostty` \| `warp` | say which terminal this is instead of working it out |
| `SIDEBAR_HITS=1` | dump the row-to-click and row-to-block maps to stderr on every frame |
| `COLUMNS`, `LINES` | the pane size to lay out for when stdout is not a terminal |

The `SIDEBAR_ONCE` modes skip the alternate screen and the mouse, so their output pipes cleanly into
`grep` and friends.
