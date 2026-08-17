# Lemmings

![Lemmings](preview.png)

Not a game. A level carves itself out of solid earth, a hatch opens, and
twenty small creatures with green hair have to work out for themselves how
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
- **`l`**, or the `labels(l)` label — float a label over each lemming saying
  what it's currently doing
- **Esc** — close the panel

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

Levels are generated to only ever pose questions those rules can answer. The
lemmings are never handed the route; the route is just never something they
have no answer to.

Watched over 400 generated levels, that gets everybody home on about 9 in 10,
loses about one lemming in 200, and takes just under a minute a level.

### The blocker

Of the eight, the blocker is the one you'll rarely see. It wants a drop with
no bottom, and a level whose route is sound doesn't present one — the
bottomless shafts are off in the dead ends past each descent, which lemmings
following a working route never reach. Moving the hazards somewhere they'd
be met was tried and is much worse: all-home levels fall from 90% to 65%,
because a lemming that meets a void has already solved its own problem by
turning round, and standing there mostly just walls off the ones behind it.
It's implemented and it fires when the conditions genuinely occur. They
mostly don't.

## Levels

![All seventeen home](screenshot-complete.png)

Levels are a pure function of their number — level 42 always generates the
same level, the same way Snake's obstacle layouts do — so `←` and `→` walk a
fixed catalogue rather than reshuffling. The board starts as one solid mass
of earth and the level is *carved* out of it: four corridors, each walked in
the opposite direction to the one above, joined end to end by a descent.
Starting solid rather than placing platforms means a digger or basher always
has real material to work in, wherever a lemming decides to improvise.

Along each corridor sit one to three obstacles, each one a shape with a known
answer — a plug wall for the basher, a raised face for the climber, a gap for
the builder, a drop past two floors for the floater. Dirt and rock both give
way to tools; steel never does.

Four biomes cycle with the level number — **Cavern**, **Ruins**, **Frost**,
**Foundry** — each pulling the earth, sky and portal toward a different tone
of the active Omarchy theme. Change your theme and the board changes with it.

![Umbrellas out](screenshot-floaters.png)

The lemmings themselves are the one deliberately un-themed thing on the
board: green hair, blue robe, orange umbrella, fixed. At sixteen pixels tall
that silhouette is the only thing making them read as lemmings rather than as
animated debris.

## When it goes wrong

A brain this local can occasionally paint itself into a corner, so two things
watch for it. A **director** notices when a level has gone a stretch with no
lemming saved, none lost, and not a cell of earth moved, and quietly hands
the lemming nearest the exit whatever tool would get it moving. And any
individual lemming that has walked for twenty seconds without getting
anywhere stops waiting for the budget to allow it and digs.

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
- `Sim.js` — terrain, level generation, and the brain. Pure JS, knows no colors
- `Draw.js` — pixels. Never mutates the world
- `preview.png`, `screenshot-complete.png`, `screenshot-floaters.png`
- `LICENSE` — MIT

## License

MIT — see [LICENSE](LICENSE). No external dependencies beyond the Omarchy
shell APIs (`qs.Ui`, `qs.Commons`) it runs inside.
