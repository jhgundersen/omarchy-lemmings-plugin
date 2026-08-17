# Lemmings

![Lemmings](preview.png)

Not a game. A level carves itself out of solid earth, a hatch opens, and a
dozen-odd small creatures with green hair have to work out for themselves how
to get from there to the exit — bashing through what's in the way, bridging
what isn't there, climbing what's too tall, and putting an umbrella up when
the drop is too far.

You don't play it. You watch it. That's the whole thing.

It lives in the bar next to [Snake](https://github.com/jhgundersen/omarchy-snake-plugin)
for the same reason Snake does: the build is compiling, the agent is still
thinking, and staring at a progress bar is worse for you than staring at
this. Snake is for when you want something to do. This is for when you
don't.

It's a self-contained `bar-widget` plugin for [Omarchy](https://omarchy.org)'s
shell, in the same style as the built-in Audio, Network, and Bluetooth
widgets: one bar icon, one popup panel.

## Install

```sh
omarchy plugin add https://github.com/jhgundersen/omarchy-lemmings-plugin.git --enable
```

Or, to hack on it locally, clone it straight into your plugins directory:

```sh
git clone https://github.com/jhgundersen/omarchy-lemmings-plugin.git ~/.config/omarchy/plugins/jhgundersen.lemmings
omarchy plugin enable jhgundersen.lemmings
```

## Uninstall

```sh
omarchy plugin remove jhgundersen.lemmings
```

Or disable it without removing the files:

```sh
omarchy plugin disable jhgundersen.lemmings
```

## Watching

Click the umbrella in the bar. A level generates, the hatch opens, and it
runs. When everybody who's getting home is home, it pauses on the result for
a few seconds and the next level carves itself. Left open, it just keeps
going.

- **Space**, or clicking the board — pause and resume
- **`←` / `→`**, or the `level` label — step back and forward through levels
- **`n`** / **`p`** — next / previous level
- **`r`** — regenerate the current level from scratch
- **`s`**, or the `speed(s)` label — Calm, Steady, or Brisk
- **`l`**, or the `who(l)` label — float a label over each lemming: what it's
  doing when it's doing something, and who it is the rest of the time
- **Esc** — close the panel

A level that doesn't get everyone home is attempted again, up to three times,
before it moves on. A retry keeps the same ground and sends a different colony
at it, with a little more in the toolbar — replaying it unchanged would be
pointless, since everything here is deterministic and the run would fail again
tick for tick. Roughly two in five failed levels come good on a second or third
go; the header shows which try you're watching.

Nothing in here assigns a skill. There's no cursor, no toolbar you can click,
no way to help. The toolbar under the board is a read-out, not a control: it
shows what this level was issued and what's left of it, and flashes when one
of them goes out.

## How they work it out

Each lemming senses only the terrain within a couple of body-lengths of
itself — is there a wall, how thick is it, how tall, is there floor ahead,
how far down, is there anything to land on within a bridge's reach — and
picks the cheapest tool that fits what it found:

| What it runs into | What it does |
| --- | --- |
| A wall thin enough to see daylight through | **Bash** through it |
| A wall too thick to bash, with a clear top | **Climb** over it |
| A gap with the far side in reach | **Build** a bridge |
| A drop too far to survive | **Float** down |
| A drop with nothing at the bottom at all | **Block**, so nobody else walks in |
| Steel | Turn around. Nothing gets through steel |
| Nothing, for long enough | **Dig** or **Mine** downward and find out |

Two of those are permanent: a lemming that becomes a climber or a floater
stays one for the rest of its life, exactly as in the original. The other six
are one-shot, come out of a per-level budget, and when a budget runs dry the
rule falls through to the next option — which is where the improvisation
comes from. A level bridged on one run gets bashed through on the next once
the builders are gone.

The one thing they know that isn't local is roughly where the exit is, and
that only settles which way to set off after a landing — and only from the
floor the exit is actually on. Above that, the corridors zigzag and the exit
lies back the way they came, so following it there would walk the whole
colony to the wrong end of the level.

## Personalities

Every lemming gets one for life, drawn when it steps out of the hatch. They
don't change what a lemming can do — the senses and the rules are identical
for all of them — only which answer it reaches for when more than one would
work:

| | |
| --- | --- |
| **steady** | No strong opinions. Most of the colony. |
| **brave** | Walks off drops the others bridge, and puts a shoulder into a wall rather than going over it. |
| **cautious** | Bridges gaps it could have jumped, gets its umbrella out with cells to spare, and is the one most likely to stand and block. |
| **curious** | Bored of a corridor soonest, so it's usually the first to decide the way on is *down* and start digging. |
| **stubborn** | Works the same wall long after the others have turned back. |
| **tinkerer** | Reaches for bricks first, even where a bash would do. |

On top of the personality each one carries its own small variation, so two
cautious lemmings aren't the same lemming twice: where its bridge-or-jump line
sits shifts a little either way, and one in five reverses its instinct at a
wall outright.

The interesting part is watching two of them arrive at the same ledge and
disagree about it — the cautious one laying a bridge across a drop the brave
one has already walked off. Turn labels on with `l` to see who's who.

Nothing here makes a lemming less safe: a personality only ever brings an
umbrella out *earlier* than the point where a landing would kill, never
later. Bravery buys a longer walk, not a longer fall.

## Levels

![All of them home](screenshot-complete.png)

Levels are a pure function of their number — level 42 always generates the
same level, with the same lemmings in the same order — so `←` and `→` walk a
fixed catalogue rather than reshuffling. The board starts as one solid mass of
earth and the level is *carved* out of it: four corridors, each walked in the
opposite direction to the one above. Each corridor's floor simply stops at the
handoff, so the way on is over the edge.

Two or three obstacles sit along each corridor, every one a shape with a known
answer — a plug wall for the basher, a raised face for the climber, a run of
pillars that has to be bashed through one at a time, a drop past two floors for
the floater, and a chasm with the far side at the same height, which is the
builder's. The mix is weighted rather than even, and every level is guaranteed
a chasm: climber is a trait a lemming keeps for life, so one climbable face
early turns every wall after it into another climb, and left to the dice the
most distinctive thing any of them does turned up in barely half of levels.

Dirt and rock both give way to tools; steel never does. The last few paces to
the exit are walled off with plain dirt, so every level ends with something to
get through — and that wall stops two rows short of the ceiling, so it has two
answers rather than one.

The last corridor is deliberately lighter than the others — at most one
obstacle besides that wall. Every other corridor has a way onward, so failing
something there costs a detour; the last one has only the exit, so failures
there compound into a level where nobody gets home at all.

Four biomes cycle with the level number — **Cavern**, **Ruins**, **Frost**,
**Foundry** — each pulling the earth, sky and portal toward a different tone
of the active Omarchy theme. Change your theme and the board changes with it.

![Umbrellas out](screenshot-floaters.png)

The lemmings themselves are the one deliberately un-themed thing on the
board: green hair, blue robe, orange umbrella, fixed. At sixteen pixels tall
that silhouette is the only thing making them read as lemmings rather than as
animated debris.

Measured over 200 levels played the way the panel plays them, retries and all:
**83% end with everyone home, 90% of all lemmings get home, nothing dies at
all**, and an attempt takes about 50 seconds. Across those, you'd see a bridge
built in three quarters of them, a blocker standing in over half, and something
bashed through in every single one.

### The blocker

Most corridors have a hole cut clean through the bedrock at the near end —
behind where the colony drops in, on the opposite side from the handoff
they're walking towards. Lemmings land facing away from it, so the only ones
who ever meet it are those who turned back from an obstacle, and for them it
is genuinely lethal. The first to reach it stands and turns the rest around,
which costs the level nothing because the way on was always the other way.

It took two goes to get right. Putting the same hazard *on* the route is much
worse — a blocker at a void the colony has to cross walls off the only way
forward, and all-home fell from 90% to 65%. And for a long time it couldn't
fire at all: the rule keys off a drop with no bottom, but out-of-bounds reads
as solid steel to everything else in the simulation, so a hole through the
bedrock still reported a floor at the bottom of it and the drop was never
bottomless. One line, and the skill went from never appearing to standing in
about half of all levels.

## When it goes wrong

A brain this local can occasionally paint itself into a corner, so two things
watch for it. A **director** notices when a level has gone a stretch with no
lemming saved, none lost, and not a cell of earth moved, and quietly hands the
lemming nearest the exit whatever tool would get it moving. And any individual
lemming that has gone twenty seconds without getting any closer to home stops
waiting for the budget to allow it and digs.

Neither is a script. They don't know the route either — they just refuse to
let you sit watching something that has stopped happening.

## Persistence

Which level you're on, how many lemmings you've got home across every session,
levels cleared, total watching time, and your speed and label settings survive
shell restarts — kept as JSON in
`~/.local/state/omarchy/plugins/jhgundersen.lemmings/state.json`, written when
a level finishes, when a setting changes, and when the panel closes.

## Files

- `manifest.json` — plugin manifest (`bar-widget` kind)
- `Panel.qml` — bar icon, panel chrome, the clock that drives the sim, the
  theme-derived palette, and persistence
- `Sim.js` — terrain, level generation, personalities, and the brain. Pure JS,
  knows no colors
- `Draw.js` — pixels. Never mutates the world
- `preview.png`, `screenshot-complete.png`, `screenshot-floaters.png`
- `LICENSE` — MIT

## License

MIT — see [LICENSE](LICENSE). No external dependencies beyond the Omarchy
shell APIs (`qs.Ui`, `qs.Commons`) it runs inside.
