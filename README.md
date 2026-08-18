# Oh No! More Agents

![Oh No! More Agents](preview.png)

Not a game. A level carves itself out of solid earth, a hatch opens, and a
dozen-odd small creatures with green hair have to work out for themselves how
to get from there to the exit — bashing through what's in the way, bridging
what isn't there, climbing what's too tall, and putting an umbrella up when
the drop is too far.

They are agents in the strict sense. No supervisor, no plan beyond the next two
body-lengths, no memory of the last wall, no idea where the exit is. Each one
looks at what's in front of it, picks the cheapest tool that fits, and commits
completely. About three quarters of them make it. The rest are a learning
experience for nobody in particular.

You don't play it. You watch it. That's the whole thing.

The build is compiling, the *other* agent is
still thinking, and staring at a progress bar is worse for you than staring at
this. 

A self-contained `bar-widget` plugin for [Omarchy](https://omarchy.org)'s
shell, in the same style as the built-in Audio, Network and Bluetooth widgets:
one bar icon, one popup panel.

## Install

```sh
omarchy plugin add https://github.com/jhgundersen/omarchy-oh-no-more-agents-plugin.git --enable
```

Or clone it straight into your plugins directory to hack on it:

```sh
git clone https://github.com/jhgundersen/omarchy-oh-no-more-agents-plugin.git ~/.config/omarchy/plugins/jhgundersen.oh-no-more-agents
omarchy plugin enable jhgundersen.oh-no-more-agents
```

Remove it with `omarchy plugin remove jhgundersen.oh-no-more-agents`, or keep
the files and just `disable` it.

## Watching

Click the umbrella in the bar. A level generates, the hatch opens, and it runs.
When everybody who's getting home is home, it pauses on the result for a few
seconds and the next level carves itself. Left open, it keeps going.

- **Space**, or clicking the board — pause and resume
- **`←` / `→`** (or `h` / `l`) — step back and forward through levels
- **`n`** / **`p`** — next / previous level
- **`r`** — regenerate the current level
- **`s`** — Calm, Steady or Brisk
- **`w`** — float a label over each agent: what it's doing when it's doing
  something, and who it is the rest of the time
- **Esc** — close the panel

Each level asks for a number rather than for everyone — two thirds to four
fifths of the colony, shown in the header. That's how the original did it, and
it's what leaves room for an agent to sacrifice itself.

A level that misses its target is attempted again, up to three times, with the
same ground, a different colony and a little more in the toolbar. The header
shows which try you're watching.

Nothing in here assigns a skill. There's no cursor and no way to help. The
toolbar under the board is a read-out, not a control: it shows what the level
was issued and what's left, and flashes when one goes out. When it reads 0 it
means 0 — everything that hands out a skill draws from the same budget.

A level gets 110 seconds. If they haven't made it by then the nuke goes off:
every agent still out there gets a five-second fuse, a few frames apart, and the
level ends in a ripple of small explosions. The countdown appears in the header
for the last thirty seconds.

## How they work it out

Each agent senses only the terrain within a couple of body-lengths — is there a
wall, how thick, how tall, is there floor ahead, how far down, is there anything
to land on within a bridge's reach — and picks the cheapest tool that fits:

| What it runs into | What it does |
| --- | --- |
| A wall thin enough to see daylight through | **Bash** through it |
| A wall too thick to bash, with a clear top | **Climb** over it |
| A gap with the far side in reach | **Build** a bridge |
| A drop too far to survive | **Float** down |
| A drop with nothing at the bottom at all | **Block** — and stay there, so nobody else walks in |
| Steel | Turn around. Nothing gets through steel |
| Nothing, for long enough | **Dig** a shaft or plant a **Mine** and retreat |

An agent only ever turns round at a wall, at a blocker, or at an edge it won't
step off. Landing doesn't turn it — it keeps whatever way it was facing, same as
the original.

Every one of the eight costs one out of the level's budget **every time it is
used**, and when a budget runs dry the rule falls through to the next option,
which is where the improvisation comes from. A level bridged on one run gets
bashed through on the next once the builders are gone.

That includes climbing and floating, which is a deliberate break with the
original. There, an agent made a climber stays one for life — but there a
*player* picks which one gets it, so the permanence is a resource being spent.
With nobody choosing, the first agent to meet a wall took a climber and then had
every wall on the level for free. Paying per climb puts the decision back.

The only thing they know that isn't in front of their faces is whether home is
on this floor, above or below — which is what decides between digging down and
climbing up. There is no horizontal sense of where the exit is at all.

**Mine** and **Bomb** are deliberately different. Mine plants a visible charge
in the floor, turns the agent away, counts down 3–2–1, then opens a six-cell
crater. Bomb puts a five-second fuse on the agent itself; that agent is lost and
the blast is slightly smaller. The old diagonal mining action is gone, so a
miner can no longer chew through a builder's bridge and strand itself below it.

## Personalities

Every agent gets one for life, drawn when it steps out of the hatch. They don't
change what an agent *can* do — the senses and the rules are identical for all
of them — only which answer it reaches for when more than one would work.

| | |
| --- | --- |
| **steady** | No strong opinions. Most of the colony |
| **brave** | Walks off drops the others bridge, and puts a shoulder into a wall rather than going over it |
| **cautious** | Bridges gaps it could have jumped and gets its umbrella out with cells to spare, but stops after two bridges. Nearly two umbrellas each |
| **curious** | Bored of a corridor soonest, so it's usually first to decide the way on is *down* |
| **stubborn** | Works the same wall long after the others have turned back |
| **tinkerer** | Cuts its way out sideways where the others drop a shaft |
| **engineer** | Would rather build a way across than fall down one. Builds fourteen times more often than it climbs |
| **sentinel** | Blocks at the first excuse, and plants itself for good once a wall has beaten it three times — so everyone behind it has to dig |
| **burrower** | Decides the way on is down long before anybody else |

On top of that each one carries a small variation, so two cautious agents aren't
the same agent twice, and one in five reverses its instinct at a wall outright.

The interesting part is watching two of them arrive at the same ledge and
disagree about it. Turn labels on with `w` to see who's who.

## Special agents

Three levels in four have exactly one. A special **cannot touch the toolbar at
all** — nothing from the budget the others are sharing — and in exchange it has
one move it can make forever, rationed by a cooldown rather than by a meter.
Give it the move *and* the toolbar and it solves the level on its own.

| | |
| --- | --- |
| **Max Tokens** | Empties the magazine into the wall. A basher's tunnel, in one shot |
| **Vector Van Damme** | Does not destroy the wall. Picks it up and puts it down further along |
| **Web Crawler** | Up the wall and across the ceiling upside down — but only where the roof leads past the thing in the way |
| **Random Forrest** | Fells the wall: everything above knee height comes down, and what's left is a step |
| **Sim Anneal** | Melts a disc, the roundest hole on the board |
| **Prompt Injection** | Plants a charge in the rock, and the rock does as it's told |
| **Gradient Descent** | Straight down, and only when down is where home is |
| **Context Window** | Needed one cell of room and opens two hundred |
| **Guard Rails** | The only one that adds: a slab laid straight out |
| **Hal Lucination** | Steps through the wall, reports it solved, helps nobody |
| **Grid Search** | Fires at everything. A burst the full height of the corridor, and the rounds that get through keep going |
| **Beam Search** | Picks a firing position and stays there for the rest of the level, working at range |

You know it by its colour — every other agent is the same green and blue on
purpose — with a pip on its shoulder, its name over its head with labels on, and
a card up in the sky saying who is down there and one line about them.

Those last two are the only things on the board that can do anything about a
danger. Everybody else treats one as weather — you learn it, you time it, you
live with it. Grid Search wrecks it if it is anywhere in the burst, which is
why it opens fire the moment it has one in view rather than waiting for a wall.
Beam Search takes up a position it can *see* the danger from and shoots it at
any distance, provided the line is clear; failing that it takes a couple of
cells out of whatever is in everybody's way, at whatever range that turns out
to be. It doesn't go home, and it isn't pretending it might.

None of them commits to a move that cannot work: a block too big to shift is
walked away from rather than kicked and missed. And every one keeps a shovel for
when the wall was never the problem, since most of the moves cut sideways. It
will open at most one rescue shaft on each floor, and travels down as it digs;
it cannot stand at the rim cutting hole after hole into the same corridor. If
it is trapped on the exit's floor, it cuts one plain body-height escape through
the thinner wall instead. Rescue decisions are spaced out, so a failed one
cannot leave it flickering left and right in the same pixel every frame.

## Levels

![Umbrellas out](screenshot-floaters.png)

Levels are a pure function of their number — level 42 is always level 42, same
ground, same colony, same line on the card — so `←` and `→` walk a fixed
catalogue rather than reshuffling. The board starts as one solid mass and the
level is *carved* out of it: three, four or five corridors, each walked in the
opposite direction to the one above, with each floor stopping at the handoff so
the way on is over the edge.

How many floors, and how far apart, varies per level. The spacing is not a free
choice — the handoff at the end of a corridor is a drop of exactly one gap, and
a drop past the safe limit kills — so a five-floor level packs them closer
rather than reaching further down, and a three-floor one can afford to spread. Which way the serpentine runs is a coin toss, so about half
of levels mirror.

Two or three obstacles sit along each corridor, every one a shape with a known
answer:

| | |
| --- | --- |
| **wall** | A plug spanning the corridor. Bash through it |
| **collapse** | The same answer with a better shape: debris ramping up to a full-height plug |
| **pillars** | Narrow columns, each its own separate bash |
| **towers** | Columns of two minds — some reach the ceiling, some are stubs you stride over |
| **chasm** | Floor gone, far side at the same height. The builder's |
| **gap** / **pit** | Floor removed, with a soft landing or steep sides |
| **step** | The floor rises more than a stride, ceiling lifted to match. The climber's |
| **cliff** | A drop past two floors. Umbrellas |

Every level is guaranteed a chasm, because left to the dice the most distinctive
thing any of them does turned up in barely half of levels. The last corridor is
deliberately lighter than the others — every other one has a way onward, so
failing something there costs a detour, while the last has only the exit.

Dirt, rock and ore all give way to tools; steel never does. The earth is built
as strata — five or six layers with wavy boundaries, seams of ore, and a
crumbled scatter along every boundary so no two layers meet on a clean line.
All of it is free, because those three materials are one material to everything
that makes a decision.

Seven biomes cycle with the level number — **Cavern**, **Ruins**, **Frost**,
**Foundry**, **Jungle**, **Ice Cave** and **Spaceship** — each pulling the
earth, sky and portal toward a different tone of the active Omarchy theme, and
each furnishing its corridors with its own scenery: stalagmites and grass,
fallen columns, ice needles, pipes and sparks, trees with canopies. The first
four are mixed purely out of theme colours; a jungle has to be green and an ice
cave has to be blue whatever your theme is, so those pull part of the way
toward a fixed hue and keep the rest. Change your theme and the board changes
with it.

The three new ones are built differently as well as coloured differently, since
a recolour on its own still reads as the same cave:

| | |
| --- | --- |
| **Jungle** | Overgrown rather than layered — root runners and blobs of moss through the soil instead of strata, vines hanging into the corridors, trees, and an uneven floor that rises and falls under your feet |
| **Ice Cave** | One mass rather than layers, because strata read as sedimentary rock and a glacier is the opposite of that. Cracks run through it, the bottom is compressed harder, and the ceilings are thick with icicles |
| **Spaceship** | Not geology at all: a grid of hull panels with seams, structural ribs running floor to ceiling, and a few plates missing. Fitted rather than furnished — strip lights along the ceilings, grating underfoot, and viewports looking out at a starfield. Its floors stay machined flat, which is the point of it |

The uneven floors never move by more than a stride between one column and the
next, so they are walked over without anyone noticing and no route is affected.
They cost about a point of levels cleared, which is the price of a jungle floor
not being a ruler. The agents are the one
deliberately un-themed thing on it: green hair, blue robe, orange umbrella.

### Dangers

About half of levels have one, and never more than one — a hanging machine gun,
a sniper with a laser sight, plates that bring spikes up under you, a sweeping
beam, a crusher, a steam vent, an electric fence. Twenty-seven of them, built
out of five mechanisms:

| | |
| --- | --- |
| **watch** | Dormant until somebody comes within reach, then winds up and fires |
| **snipe** | Picks one target it has line of sight to, anywhere down the corridor |
| **beam** | Fires on its own schedule whether or not anyone is there |
| **plate** | Armed by being stood on, and goes off a moment later |
| **cycle** | Never triggers and never stops — just keeps its own time |
| **field** | Always live, and the only kind with no safe moment at all |

Six of them belong to one biome and turn up nowhere else: a **snake** and a
**spore bloom** in the jungle, an **icicle fall** and a **frost jet** in the ice
cave, an **airlock** and a **servo arm** on the spaceship. A few of the others
are kept out of where they'd read wrong — no open flame or steam in an ice cave,
no industrial machinery in a jungle.

Everything but `field` rests between firings for long enough to walk through,
and everything winds up first, visibly, for long enough to read. Both are what
make a danger sitting on the route fair rather than arbitrary. They are placed
just past an obstacle, in the direction of travel — the densest traffic on the
corridor, and the only spot where the timing is funny.

The colony knows nothing about it. A danger is scenery until somebody is present
when it goes off, and that first death is the only thing in this whole
simulation that is *learned* rather than sensed. After it, an agent walking
toward the danger **while it is live** treats it exactly like a drop with no
bottom: the first to arrive stands and blocks, the rest turn around, and they
walk through once it goes quiet.

### The blocker

Most levels have a hole cut clean through the bedrock at the near end of the
last corridor — dead ground, on the opposite side from the exit. Agents land
facing away from it, so the only ones who ever meet it are those who turned back
from something, and for them it is lethal. The first to reach it stands and
turns the rest around, which costs the level nothing because the way on was
always the other way.

A blocker never stands down. It has given up going home so the ones behind it
don't walk into a hole, and that cost is the whole point of the skill. When
everyone who was going to get home has, the blockers still standing light their
own fuses — which is exactly what a player does at the end of a level, and the
honest end of the bargain they made.

If it plants itself while another agent is already shoulder-to-shoulder with
it, that agent may move outward until they separate. Only movement toward a
blocker is refused; otherwise the new blocker would catch its neighbour inside
the exclusion radius and make it turn left and right in the same pixel forever.

That is also why a level has a *target* rather than asking for everyone: a
blocker doesn't come home, so on any level that posts one, "everyone home" isn't
a target, it's a contradiction.

### Gravity applies to everybody

Standing still is a decision about walking, not a suspension of gravity. A
blocker holding a gap, a sniper camped in position, an agent with a lit fuse and
a planted charge counting down all come down if the ground under them is
removed — usually by somebody else's explosion. The fuse keeps burning on the
way, and goes off wherever it lands.

## When it goes wrong

![Eleven of thirteen home](screenshot-complete.png)

A brain this local can paint itself into a corner, so four things watch for it.

A **director** notices when a level has gone a stretch with nobody saved, nobody
lost and not a cell of earth moved, and quietly hands the agent nearest the exit
whatever tool would get it moving. An agent that has gone twenty seconds without
getting closer to home stops waiting for the budget and digs. An agent stuck
inside a single cell **hops** — three cells of lift, free, no skill, which is
under the height of everything the level puts in the way on purpose, so it only
ever gets an agent out of somewhere it should never have been stuck. If the hop
and the rescue tool both fail, an ordinary agent is condemned immediately
rather than occupying the same pixel until the general timeout.

A builder also checks the space its next course will occupy. Somebody caught at
foot height rides the new brick upward; a deeper overlap makes the builder wait,
then abandon the bridge after three seconds rather than masonry an agent into it
or deadlock with another builder. Once somebody starts at a ledge, the rest give
that site eight seconds before trying their own version of the same bridge.

Hazards may claim blockers, but never the final one in the toolbar. That last
blocker is reserved for a genuinely bottomless edge, where one permanent guard
can turn the rest of the colony around instead of feeding a timed trap more
sacrifices.

And an agent that re-treads the same few cells five times over with no progress
between them is condemned and handed a bomb. A bomb rather than simply deleting
it, because the explosion is the useful part: an agent only paces somewhere it
could not get past, so the hole it leaves is in exactly the wall that stopped
it. Nobody is told; the others walk into that place later and find it different.

None of it is a script. They don't know the route either — they just refuse to
let you sit watching something that has stopped happening.

Measured over 200 levels played the way the panel plays them, retries and all:
**96% reach their target**, 88% of every agent released gets home, over an
average attempt of under a minute.

## Persistence

Which level you're on, how many agents you have got home across every session,
levels cleared, total watching time, and your speed and label settings survive
shell restarts — kept as JSON in
`~/.local/state/omarchy/plugins/jhgundersen.oh-no-more-agents/state.json`.

## Files

- `manifest.json` — plugin manifest (`bar-widget` kind)
- `Panel.qml` — bar icon, panel chrome, the clock that drives the sim, and
  persistence. The only file here that knows what Omarchy is
- `Sim.js` — terrain, level generation, personalities, and the brain. Pure JS,
  knows no colors
- `Draw.js` — pixels. Never mutates the world
- `Palette.js` — five theme colors in, canvas colors out
- `LICENSE` — MIT

## Name

It's a parody, and the lineage is the point: this is *Lemmings*, the 1991
Psygnosis game, with the player removed. The title is the sequel's — *Oh No!
More Lemmings* — with the noun updated to the one currently being applied to
software that acts without supervision and mostly gets away with it.

No affiliation with anybody who owns anything.

## License

MIT — see [LICENSE](LICENSE). No external dependencies beyond the Omarchy shell
APIs (`qs.Ui`, `qs.Commons`) it runs inside.
