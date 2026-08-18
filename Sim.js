// The simulation: terrain, level generation, and the agent brain. All mutable
// state lives on the `world` object returned by generate() — nothing
// module-level changes after load.
//
// Plain JavaScript with no directives, deliberately, so the same file runs in
// two places: QML imports it as `import "Sim.js" as Sim`, and a browser loads
// it with a plain <script> tag. It carried `.pragma library` until the web
// version needed it; that pragma is also what made the QML side cache this
// file forever and ignore plugin hot-reloads, so losing it is no loss at all.
//
// Rendering lives in Draw.js; the panel chrome in Panel.qml. This file never
// knows what anything looks like.
//
// Coordinates: terrain is a cell grid (COLS x ROWS). Agents carry *float*
// cell coordinates so they move smoothly across a chunky grid — `ag.x` is the
// horizontal center, `ag.y` is the FEET row, meaning the agent stands on
// whatever is solid at (ag.x, ag.y + 1) and its body occupies rows ag.y-3..ag.y.

// ---------------------------------------------------------------------------
// Geometry and materials
// ---------------------------------------------------------------------------

var COLS = 100
var ROWS = 62
var CELL = 4

var WIDTH = COLS * CELL
var HEIGHT = ROWS * CELL

var EMPTY = 0
var DIRT = 1   // soft: bashable, minable, diggable
var ROCK = 2   // hard-looking but still workable; purely a visual tier
var STEEL = 3  // permanent: every skill refuses it and the agent turns back
var ORE = 4    // another visual tier, worked exactly like dirt and rock

// DIRT, ROCK and ORE are the same material as far as anything that thinks is
// concerned. Nothing in the brain ever compares a cell against one of them:
// solid() asks whether a cell is not EMPTY, and every skill asks only whether
// it is STEEL. That is what makes the strata in fillEarth free — the board can
// be given as much geology as it can carry without moving a single decision.

// An agent is 4 cells (16px) tall and ~2 cells wide.
var AGENT_H = 4

// K, the constants Draw.js needs, is defined further down with the layout
// numbers — it has to come after SKY, which is one of them.

// ---------------------------------------------------------------------------
// Tuning. Everything is per-tick at 30 ticks/second.
// ---------------------------------------------------------------------------

var WALK_SPEED = 0.28    // ~34 px/s — a stroll, not a sprint
var FALL_SPEED = 0.55
var FLOAT_SPEED = 0.22
var CLIMB_SPEED = 0.16

var MAX_STEP = 2         // cells of rise a walker takes in stride
var SAFE_FALL = 14       // cells; beyond this an unprotected landing splats
// Taller than this and a wall isn't worth climbing even when something clear
// sits on top of it — on this layout that "something" is either the open sky
// above the earth or a corridor two floors up, and both are off the route.
// Without the cap a plug wall spanning a corridor reads as climbable, and the
// level turns into everybody scaling it, braining themselves on the ceiling,
// and dropping back where they started, forever.
var MAX_CLIMB = 8
var BUILD_REACH = 24     // cells a full 12-brick bridge spans
var BASH_REACH = 10      // cells of wall a basher will commit to

var BUILD_INTERVAL = 6   // ticks per brick
var BASH_INTERVAL = 6
var DIG_INTERVAL = 7
var BOMB_FUSE = 150      // 5 seconds, same as the original
var BOMB_RADIUS = 5
var MINE_FUSE = 90       // a planted, visible 3-2-1 countdown
var MINE_RADIUS = 6      // just wider than the carried bomb

// How long a level gets before the nuke goes off. Levels that are going to
// work are usually done well inside this; the ones that trip it are stuck for
// good, not slow — raising the limit to 140s or 170s nukes exactly the same
// attempts and only makes you wait longer to watch it happen. So it is set to
// the shortest value that does not cut short a level still making progress.
var LEVEL_LIMIT = 30 * 110
var NUKE_STAGGER = 5     // ticks between arming one agent and the next


// Skills, in the order the original's toolbar showed them.
var SKILL_ORDER = ["climber", "floater", "bomber", "blocker", "builder", "basher", "miner", "digger"]
var SKILL_LABELS = {
  climber: "Climb", floater: "Float", bomber: "Bomb", blocker: "Block",
  builder: "Build", basher: "Bash", miner: "Mine", digger: "Dig"
}

// Seven, cycling with the level number. Each one retints the earth, sky and
// portal, furnishes its corridors with its own scenery, and draws from its own
// set of dangers — a snake belongs in the jungle and nowhere else.
var BIOMES = ["Cavern", "Ruins", "Frost", "Foundry", "Jungle", "Ice Cave", "Spaceship"]

// ---------------------------------------------------------------------------
// Personalities
//
// Every agent gets one for life. They don't change what an agent is capable
// of — the sensing and the rules are the same for all of them — only which
// answer it reaches for when more than one would work. Put twenty of them on
// the same ledge and they'll deal with it differently, which is the whole
// point: a colony that solves an obstacle six ways is worth watching, and one
// that files through it identically is a conveyor belt.
//
// Nothing here makes an agent less safe. `fallMargin` only ever brings an
// umbrella out EARLIER than the physical limit — bravery buys a longer walk,
// not a longer fall, because the alternative is personality that kills them.
//
//   turnLimit   turnarounds before it stops pacing and starts digging
//   fallMargin  cells below the lethal limit at which it wants an umbrella
//   bridgeAt    drop depth at which it prefers building over stepping off
//   bashFirst   reaches for the basher before the climber at a wall
//   blockBias   extra willingness to stand in the way of a bottomless drop
// bridgeAt      how deep a drop has to be before it lays bricks instead
// fallMargin     how many cells early the umbrella comes out
// turnLimit      how long it keeps working the same wall before giving up
// bashFirst      shoulder into a wall, or go over it
// blockBias      how readily it stands and blocks
// buildCap       bridges it will lay in a lifetime
// noFloat        would rather build a way across than come down under a chute
// standDown      gives up on itself and becomes furniture once it is this stuck
// digBias        how much sooner than the others it decides the way on is down
// mineFirst      plants a timed charge rather than dropping a shaft
var TRAITS = {
  steady:   { label: "steady",   turnLimit: 3, fallMargin: 0, bridgeAt: 8,  bashFirst: false, blockBias: 0, buildCap: 2, noFloat: false, standDown: 0, digBias: 0 },
  brave:    { label: "brave",    turnLimit: 5, fallMargin: 0, bridgeAt: 15, bashFirst: true,  blockBias: -1, buildCap: 1, noFloat: false, standDown: 0, digBias: 0 },
  cautious: { label: "cautious", turnLimit: 2, fallMargin: 3, bridgeAt: 3,  bashFirst: false, blockBias: 2, buildCap: 2, noFloat: false, standDown: 0, digBias: 0 },
  curious:  { label: "curious",  turnLimit: 2, fallMargin: 1, bridgeAt: 9,  bashFirst: false, blockBias: 0, buildCap: 2, noFloat: false, standDown: 0, digBias: 220 },
  stubborn: { label: "stubborn", turnLimit: 8, fallMargin: 0, bridgeAt: 9,  bashFirst: true,  blockBias: -1, buildCap: 2, noFloat: false, standDown: 0, digBias: -160 },
  tinkerer: { label: "tinkerer", turnLimit: 3, fallMargin: 2, bridgeAt: 7,  bashFirst: false, blockBias: 1, buildCap: 2, noFloat: false, standDown: 0, digBias: 150, mineFirst: true },

  // Would rather build a way across than fall down one. Bridges almost any
  // gap, lays twice as many as anyone else, and reaches for the umbrella only
  // when there is nothing on the far side to reach. Watching one bridge a drop
  // that three others have already stepped off is the clearest thing a
  // personality does on this board.
  engineer: { label: "engineer", turnLimit: 3, fallMargin: 1, bridgeAt: 1,  bashFirst: false, blockBias: 0, buildCap: 5, noFloat: true,  standDown: 0, digBias: 0 },

  // Stands. Blocks at the first excuse, and when it has been beaten by the
  // same wall long enough it stops trying and plants itself where it stands —
  // which is a problem for everyone behind it, and the reason somebody is
  // about to have to dig.
  // standDown has to come in UNDER turnLimit: considerEscape zeroes `turns`
  // the moment it hits the limit, so a stand-down count above it can never be
  // reached and the sentinel blocked no more often than anybody else.
  sentinel: { label: "sentinel", turnLimit: 4, fallMargin: 1, bridgeAt: 7,  bashFirst: false, blockBias: 3, buildCap: 1, noFloat: false, standDown: 3, digBias: 0 },

  // Decides the way on is down long before anybody else does.
  burrower: { label: "burrower", turnLimit: 2, fallMargin: 1, bridgeAt: 11, bashFirst: false, blockBias: 0, buildCap: 1, noFloat: false, standDown: 0, digBias: 340 }
}

// Weighted so most of the colony is unremarkable and the characters stand out.
// An even split just reads as noise.
// Weighted. Steady is still most of any colony — a board where everyone is a
// character is a board with no characters on it — but the rarer ones are rare
// enough to be worth spotting and common enough to turn up most levels.
var TRAIT_POOL = [
  "steady", "steady", "steady", "steady", "steady",
  "brave", "brave", "brave",
  "cautious", "cautious", "cautious",
  "curious", "curious",
  "stubborn", "stubborn",
  "tinkerer", "tinkerer",
  "engineer", "engineer",
  "sentinel",
  "burrower"
]

var TRAIT_ORDER = ["steady", "brave", "cautious", "curious", "stubborn", "tinkerer", "engineer", "sentinel", "burrower"]

function traitOf(ag) { return TRAITS[ag.trait] || TRAITS.steady }

// ---------------------------------------------------------------------------
// Terrain access
// ---------------------------------------------------------------------------

// Out of bounds reads as STEEL to the sides and below, EMPTY above. That way
// every "can I walk/dig here" test gets a sane answer at the edges without
// each caller re-checking bounds, and nothing can tunnel off the board.
function at(w, x, y) {
  if (x < 0 || x >= COLS) return STEEL
  if (y >= ROWS) return STEEL
  if (y < 0) return EMPTY
  return w.terrain[y * COLS + x]
}

function solid(w, x, y) {
  return at(w, x, y) !== EMPTY
}

// Two counters, because two different things want to know about a change and
// they do not want the same answer. `terrainVersion` drives the repaint and so
// has to move whenever a stored cell moves, colour included. `carved` is the
// director's evidence that anything is actually happening, and so must move
// only when solid becomes empty or empty becomes solid.
//
// They used to be one counter, and with strata in the ground that quietly
// stopped being harmless: laying a brick of dirt over a cell of rock changes
// nothing about the shape of the level, but it changed the byte, which read to
// the stall detector as earth being moved and bought a going-nowhere level
// another twenty seconds before anyone stepped in.
function setCell(w, x, y, v) {
  if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return
  var i = y * COLS + x
  var was = w.terrain[i]
  if (was === v) return
  w.terrain[i] = v
  w.terrainVersion++
  if ((was === EMPTY) !== (v === EMPTY)) w.carved++
}

// Every skill routes its terrain removal through here, so "steel is forever"
// is enforced in exactly one place rather than in each of the four diggers.
function clearCell(w, x, y) {
  if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return false
  var i = y * COLS + x
  if (w.terrain[i] === EMPTY) return false
  if (w.terrain[i] === STEEL) return false
  w.terrain[i] = EMPTY
  w.terrainVersion++
  w.carved++
  return true
}

function hitsSteel(w, x0, y0, x1, y1) {
  for (var y = y0; y <= y1; y++)
    for (var x = x0; x <= x1; x++)
      if (at(w, x, y) === STEEL) return true
  return false
}

// The agent's body needs three clear cells above its feet to stand somewhere.
function headroom(w, x, footY) {
  for (var k = 1; k < AGENT_H; k++)
    if (solid(w, x, footY - k)) return false
  return true
}

// Terrain that is being ADDED must not appear inside an agent. Destructive
// skills are allowed to remove the ground under somebody; builders and slabs
// have the opposite responsibility. Agents are about two cells wide, so test
// the cell centre against their horizontal centre rather than only floor(x).
function agentOccupiesCell(w, x, y, except) {
  for (var i = 0; i < w.agents.length; i++) {
    var ag = w.agents[i]
    if (ag === except || ag.gone || ag.state === "saved") continue
    var footY = Math.floor(ag.y)
    if (Math.abs((x + 0.5) - ag.x) >= 1) continue
    if (y >= footY - AGENT_H + 1 && y <= footY) return true
  }
  return false
}

// A rising bridge meeting somebody's feet should carry them up, not wait for
// them to walk through the brick and not entomb them. Work out every lift
// before moving anybody so the operation is all-or-nothing. Deeper body hits,
// active workers and blocked headroom are not safe to rearrange; the builder
// waits for those in stepBuild instead.
function makeBuildRoom(w, cells, builder) {
  var lifts = {}
  for (var ci = 0; ci < cells.length; ci++) {
    var cell = cells[ci]
    for (var i = 0; i < w.agents.length; i++) {
      var ag = w.agents[i]
      if (ag === builder || ag.gone || ag.state === "saved") continue
      var footY = Math.floor(ag.y)
      if (Math.abs((cell.x + 0.5) - ag.x) >= 1) continue
      if (cell.y < footY - AGENT_H + 1 || cell.y > footY) continue
      var newFoot = cell.y - 1
      var rise = footY - newFoot
      if (rise < 1 || rise > MAX_STEP) return false
      if (ag.state !== "walk" && ag.state !== "fall") return false
      var ax = Math.floor(ag.x)
      if (solid(w, ax, newFoot) || !headroom(w, ax, newFoot)) return false
      if (!lifts[ag.id] || newFoot < lifts[ag.id].y) lifts[ag.id] = { ag: ag, y: newFoot }
    }
  }
  for (var id in lifts) {
    var lift = lifts[id]
    lift.ag.y = lift.y
    lift.ag.state = "walk"
    lift.ag.fall = 0
    lift.ag.floater = false
    lift.ag.still = 0
  }
  return true
}

// ---------------------------------------------------------------------------
// Deterministic RNG. Level N always generates the same level, the same way
// the Snake plugin's obstacle layouts are a pure function of the level number
// — so "that one with the long drop" stays findable.
// ---------------------------------------------------------------------------

function makeRng(seed) {
  var s = ((seed + 1) * 2654435761) >>> 0
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length) % arr.length] }
function irand(rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)) }

// ---------------------------------------------------------------------------
// Level generation
//
// The board starts as one solid mass of earth and the level is *carved* out of
// it: a serpentine of corridors, each walked in the opposite direction to the
// one above, joined end to end by a descent. Starting solid rather than
// placing platforms means a digger or basher always has real material to work
// in, wherever an agent decides to improvise — the level isn't a set of thin
// ledges floating in a void.
//
// Obstacles are never arbitrary: each one is a shape the brain in decide()
// below is known to handle (a plug wall for the basher, a raised face for the
// climber, a gap for the builder, a long drop for the floater). The agents
// still work it out locally from what they can sense — they're never handed
// the route — but the level can't pose a question they have no answer to.
// ---------------------------------------------------------------------------

var SKY = 7              // rows of open air above the earth
var CORR_H = 6           // carved headroom above a corridor floor
var CORR_GAP = 12        // default vertical distance between corridor floors
var N_CORR = 4           // default number of corridors

// How many corridors a level gets, and how far apart. Both vary per level now,
// because four floors at a fixed spacing meant every level had the same shape
// however different the ground looked.
//
// The gap is the constraint, not a free choice: the handoff at the end of each
// corridor is a drop of exactly one gap, and a drop past SAFE_FALL kills. So it
// can only be nudged, and a five-floor level has to pack them closer rather
// than reach further down.
function corridorPlan(rng) {
  var n = irand(rng, 3, 5)
  var gap = n === 5 ? 10 : (n === 3 ? 13 : 12)
  var top = 9 + irand(rng, 0, 2)
  return { n: n, gap: gap, top: top }
}

// Everything Draw.js needs to know about geometry and materials, stamped onto
// every world by generate(). Draw.js used to reach for these through a QML
// `.import`, which is the one line that stopped it loading in a browser — and
// the dependency was never real, since it only ever wanted constants and not a
// single function. Going through the world keeps one definition of each number:
// change COLS above and the renderer follows, which a copy in Draw.js wouldn't.
var K = {
  COLS: COLS, ROWS: ROWS, CELL: CELL, SKY: SKY,
  EMPTY: EMPTY, DIRT: DIRT, ROCK: ROCK, STEEL: STEEL, ORE: ORE
}

// `attempt` re-runs the SAME level with a different colony. The layout stays a
// pure function of the level number — level 42 is always level 42 — but the
// personalities and the skill budget come off the attempt as well, because a
// retry that reproduces the run exactly is not a retry: everything here is
// deterministic, so replaying a failed level unchanged fails it again, tick for
// tick. Same problem, different agents, and a little more to work with each
// time round.
function generate(level, attempt) {
  attempt = attempt || 0
  var rng = makeRng(level)
  var w = {
    level: level,
    attempt: attempt,
    biome: BIOMES[(level - 1) % BIOMES.length],
    k: K,
    decor: [],
    corrGap: CORR_GAP,
    acting: null,
    special: null,
    specialSpec: null,
    factPick: 0,
    hazard: null,
    hazardKnown: false,
    hazardKills: 0,
    terrain: new Uint8Array(COLS * ROWS),
    terrainVersion: 1,
    carved: 0,
    agents: [],
    mines: [],
    particles: [],
    buildSites: [],
    ticks: 0,
    nextId: 1,

    toRelease: 0,
    released: 0,
    saved: 0,
    lost: 0,
    releaseInterval: 0,
    releaseTimer: 0,

    skills: {},
    granted: {},         // director top-ups, shown apart from the level's own
    lastUsed: {},        // skill -> tick, so the toolbar can flash on use
    lastEvent: "",

    hatch: null,
    exit: null,
    done: false,
    doneTicks: 0,

    // Personalities are drawn from their own stream, kept separate from the
    // generator's so that changing level layout doesn't reshuffle who is who.
    traitRng: makeRng(level * 7919 + 13 + attempt * 104729),
    traitCounts: {},

    // Stall detection: the director watches these three numbers and steps in
    // if none of them has moved for a while (see runDirector).
    progressMark: 0,
    stallTicks: 0,
    rescues: 0,
    bombsUsed: 0,

    timeLimit: LEVEL_LIMIT,
    nuking: false,
    nukeTimer: 0
  }

  fillEarth(w, rng)

  // Corridor floors, top to bottom. floorY is the topmost SOLID row, so a
  // agent standing on it has its feet at floorY - 1.
  // Which way the serpentine runs. It was fixed, which put the hatch in the
  // top-left corner and the exit in the bottom-left of every level ever
  // generated — the one thing a viewer would notice was always the same.
  var flip = rng() < 0.5 ? 1 : -1
  var plan = corridorPlan(rng)
  w.corrGap = plan.gap
  var corridors = []
  for (var k = 0; k < plan.n; k++) {
    var dir = ((k % 2 === 0) ? 1 : -1) * flip
    corridors.push({
      floorY: SKY + plan.top + k * plan.gap,
      dir: dir,
      x0: 4,
      x1: COLS - 5,
      obstacles: []
    })
  }

  // Where each corridor hands off to the one below: the far end in its walking
  // direction. The overshoot past it is the stretch where blocker-worthy
  // hazards go, since nothing on the route depends on it.
  for (var i = 0; i < corridors.length; i++) {
    var c = corridors[i]
    c.startX = c.dir > 0 ? c.x0 + 3 : c.x1 - 3
    // Where the floor stops varies, so corridors aren't all the same length
    // and the obstacles along them aren't all at the same three positions.
    var hj = irand(rng, 0, 7)
    c.handoffX = c.dir > 0 ? c.x1 - 10 - hj : c.x0 + 10 + hj
    carveCorridor(w, c)
  }

  // At most one danger, and only on about half of levels. It takes over that
  // corridor's bottomless drop rather than sitting alongside it — one piece of
  // dead ground, one thing on it.
  var hazardCorridor = rng() < 0.6 ? irand(rng, 1, corridors.length - 2) : -1

  for (var j = 0; j < corridors.length; j++) {
    var cur = corridors[j]
    placeObstacles(w, rng, cur, j, corridors)
    // Middle corridors only: not the first (its near end is the hatch's
    // landing pad) and not the last (its near end is where the exit goes).
    // Last corridor only — see placeVoid for why anywhere else holes the
    // floors underneath it.
    if (j === corridors.length - 1 && j !== hazardCorridor && rng() < 0.85)
      placeVoid(w, cur, corridors[j - 1])
    if (j < corridors.length - 1) {
      carveDescent(w, rng, cur, corridors[j + 1])
      // (No hazard call: carveDescent now takes the whole stretch past the
      // handoff, so there is no dead end left to put one in.)
    }
  }

  // The hatch sits in the open sky and drops into the first corridor through
  // a short shaft — 12 cells, comfortably inside SAFE_FALL, so the opening
  // moments are never a scramble.
  var first = corridors[0]
  var hx = first.dir > 0 ? first.startX + irand(rng, 0, 6) : first.startX - irand(rng, 0, 6)
  for (var sy = SKY - 2; sy < first.floorY; sy++)
    for (var sx = hx - 2; sx <= hx + 2; sx++) clearCell(w, sx, sy)
  w.hatch = { x: hx, y: 3 }
  w.startDir = first.dir

  // Steel under the landing pad. The hatch goes on dropping agents onto this
  // spot for the whole level, so it's the one piece of floor that must still
  // be there in two minutes' time — and without this it reliably isn't: the
  // first agent to decide the way on is *down* digs a shaft right where it
  // landed, and every agent after it falls through the hole, through the two
  // corridors below, and splats.
  for (var py = first.floorY; py < first.floorY + 2; py++)
    for (var px = hx - 2; px <= hx + 2; px++) setCell(w, px, py, STEEL)

  // The exit closes out the last corridor, at the end the route arrives from.
  var last = corridors[corridors.length - 1]
  var ex = last.dir > 0 ? Math.min(COLS - 10, last.handoffX + 4) : Math.max(6, last.handoffX - 8)
  w.exit = { x: ex, y: last.floorY - 5, w: 6, h: 5 }
  // setCell rather than clearCell: the mouth of the exit is cleared
  // unconditionally, steel included. Nothing that ran before this gets to make
  // the one square on the board that has to be reachable unreachable.
  for (var ey = w.exit.y; ey < last.floorY; ey++)
    for (var exx = w.exit.x - 2; exx < w.exit.x + w.exit.w + 2; exx++) setCell(w, exx, ey, EMPTY)

  // And then a wall of plain dirt across the last few paces to it. Every level
  // ends with something to dig through, which is the difference between a
  // level and a corridor: without it a third of them are solved by walking to
  // the end and falling off things, and the toolbar may as well not be there.
  //
  // Dirt, never steel, and thinner than a basher's reach — so it always yields,
  // to a basher or to whatever forceEscape hands over if the budget is gone.
  //
  // It stops two rows short of the ceiling on purpose. A wall spanning the full
  // corridor has exactly one answer, and since every agent on the level meets
  // this one, a level where that answer doesn't come off is a level where
  // nobody gets home at all — the difference between a bad result and no
  // result. Leaving a lip to climb gives it a second, independent answer, and
  // splits the colony at the last obstacle besides: some go through it, some go
  // over.
  var sealFrom = last.dir > 0 ? w.exit.x - 8 : w.exit.x + w.exit.w + 3
  for (var sx2 = sealFrom; sx2 < sealFrom + 3; sx2++)
    for (var sy2 = last.floorY - CORR_H + 2; sy2 < last.floorY; sy2++)
      setCell(w, sx2, sy2, DIRT)

  w.corridors = corridors
  // Fewer and quicker out of the hatch than before. Denser levels take longer
  // per agent, and a slow trickle of twenty spent half the level's clock
  // just getting everybody onto the board.
  w.toRelease = irand(rng, 12, 18)
  w.releaseInterval = irand(rng, 24, 34)

  // How many have to get home for the level to count, as a number rather than
  // all of them. The original set a percentage per level and this needs one for
  // the same reason it did: a blocker never goes home, so on any level that
  // posts one, "everyone home" is not a target, it's a contradiction. Asking
  // for all of them made 86% of levels unwinnable the moment an agent stood
  // in a gap to save the others.
  w.target = Math.max(1, Math.round(w.toRelease * (0.65 + rng() * 0.15)))

  // Deliberately generous. This is something to watch, not a puzzle to ration
  // — a level that stalls for want of one more builder is the opposite of
  // relaxing. The counts still vary enough that no two levels get solved the
  // same way.
  //
  // Climber and floater are sized off the population rather than given a flat
  // count, because unlike the other six they are permanent traits: an agent
  // that takes one holds it for the rest of its life. A fixed handful gets
  // consumed by the first few to meet the first cliff, and every one after
  // that arrives at the same cliff with nothing — which is a stranded level,
  // or a heap of splats, depending on the cliff.
  w.skills = {
    // Climber is now the scarcest thing on the board, and that's the point.
    // Both of these used to be permanent traits, faithfully to the original —
    // but in the original a player picks which agent gets one, for which
    // wall, and the permanence is a resource being spent. With nobody
    // choosing, the first agent to meet a wall took a climber and then had
    // every wall on the level for free, which quietly deleted the decision
    // from everything downstream. Paying per climb puts it back: run out, and
    // the wall in front of you is a problem again.
    //
    // Floater stays roomier, because a cliff obstacle has to be crossed by the
    // whole colony and an agent with no umbrella at one simply turns back.
    //
    // Five to nine looks brutal for a colony of fifteen and measures out fine:
    // between three and eighteen climbers a level, the share of levels that end
    // with everyone home doesn't move off 85%, because what strands a colony
    // isn't the shortage of climbs. Climbing still turns up in about seven
    // attempts in ten — it just can't carry one agent from the hatch to the
    // exit any more.
    // Dry in half of all attempts, which is where a good share of the pacing
    // came from: an agent at a wall it cannot climb, cannot bash and cannot
    // bridge has nothing left to do but walk away and come back and walk away.
    climber: irand(rng, 12, 18) + attempt * 2,
    floater: w.toRelease + 2 + attempt * 2,
    // One per agent, which is the only number that makes sense once bombs are
    // what clears a stuck agent off the board. Anything less and the budget
    // runs out with someone still wearing a hole in a corridor — and a level
    // where the thing that ends the pacing has itself run out is precisely the
    // level you sit and watch nothing happen on.
    bomber: w.toRelease,
    blocker: irand(rng, 3, 5) + attempt,
    builder: irand(rng, 13, 19) + attempt * 3,
    basher: irand(rng, 9, 15) + attempt * 3,
    miner: irand(rng, 4, 8) + attempt * 2,
    digger: irand(rng, 6, 10) + attempt * 2
  }
  // At most one special, on a bit over half of levels, and a fixed place in the
  // release order — so level 42 always sends the same one out in the same slot.
  // Never first: the colony should be under way before the odd one turns up.
  // Most levels get one. It was a bit over half, which combined with a move
  // that fires once or twice a visit meant a given special was a rare sight.
  if (rng() < 0.75) {
    w.special = pick(rng, SPECIALS).id
    // Resolved here and carried on the world, exactly like `w.k`. Draw.js has
    // no imports and no way to reach into this file — in a browser both are in
    // one global scope so calling specialSpec() from there appeared to work,
    // and in QML each .js is its own scope, where it threw a ReferenceError
    // inside drawActors and took every agent on the board down with it.
    w.specialSpec = specialSpec(w.special)
    // Which line about it gets shown. Drawn here rather than derived from the
    // level number so it reads as random, and stored so it is stable for the
    // level — level 42 is always level 42, down to the joke.
    w.factPick = Math.floor(rng() * 997)
    w.specialAt = irand(rng, 1, Math.max(1, w.toRelease - 2))
  }

  for (var s = 0; s < SKILL_ORDER.length; s++) w.granted[SKILL_ORDER[s]] = 0

  // Last, once every wall, shaft and doorway is where it is going to be, so
  // nothing gets furnished and then carved away before anyone sees it.
  // Roughen the floors last of all. Doing it while the corridor was carved put
  // the bumps in before the obstacles, so a chasm cut afterwards took the floor
  // out from under them and left a shelf of raised dirt hanging across the hole
  // — a bridge nobody built, over the one obstacle that is supposed to need
  // one. Jungle levels lost sixteen points of clear rate to it.
  for (var rf = 0; rf < corridors.length; rf++) roughFloor(w, corridors[rf], rng, w.biome)

  placeDecor(w, rng, corridors)
  if (hazardCorridor >= 0) w.hazard = placeHazard(w, rng, corridors, hazardCorridor)

  return w
}

// Solid everywhere below the sky: a dirt crust over rock, with a wavy boundary
// and a scatter of pockets so a cross-section doesn't read as two flat bands.
// The earth before anything is carved out of it. This is the whole of the
// board's texture: five or six strata with wavy boundaries, veins of ore
// running through them, lenses of the wrong material, and a gritty scatter
// along every boundary so no two layers meet on a clean line.
//
// All of it is free. DIRT, ROCK and ORE are one material to everything that
// makes a decision (see the note where they're declared), so this can be as
// busy as it likes without changing what any agent does — which is worth
// knowing, because a corridor cut through six layers is dramatically more
// interesting to watch than the same corridor cut through one.
function fillEarth(w, rng) {
  // Each stratum gets its own thickness, its own material and its own pair of
  // sine waves, so boundaries roll independently instead of the whole stack
  // undulating together like a stretched accordion.
  var bands = []
  var y0 = SKY
  var seq = [DIRT, ROCK, DIRT, ORE, ROCK, DIRT, ROCK]
  var seqAt = irand(rng, 0, seq.length - 1)
  while (y0 < ROWS) {
    // Ore turns up as a seam, never as a stratum in its own right: a band of it
    // several cells thick reads as a third kind of ground, where a thin one
    // reads as something running through the ground.
    var mat = seq[seqAt % seq.length]
    seqAt++
    var thick = mat === ORE ? irand(rng, 1, 2) : irand(rng, 6, 12)
    bands.push({
      top: y0,
      mat: mat,
      amp1: 1 + rng() * 3.5, freq1: 0.05 + rng() * 0.1, phase1: rng() * 6.28,
      amp2: rng() * 2, freq2: 0.17 + rng() * 0.2, phase2: rng() * 6.28
    })
    y0 += thick
  }

  // A cell belongs to the last band whose (wavy) top edge is above it.
  function bandAt(x, y) {
    var found = bands[0]
    for (var i = 0; i < bands.length; i++) {
      var b = bands[i]
      var edge = b.top + b.amp1 * Math.sin(x * b.freq1 + b.phase1)
                       + b.amp2 * Math.sin(x * b.freq2 + b.phase2)
      if (y >= edge) found = b
      else break
    }
    return found
  }

  for (var y = 0; y < ROWS; y++) {
    for (var x = 0; x < COLS; x++) {
      var t
      if (y < SKY) t = EMPTY
      else if (y >= ROWS - 2) t = STEEL          // bedrock
      else if (x < 3 || x >= COLS - 3) t = STEEL // side walls: nothing leaves the board
      else t = bandAt(x, y).mat
      w.terrain[y * COLS + x] = t
    }
  }

  // Lenses: a pocket of one material sitting inside another, which is what
  // stops the strata reading as a layer cake. Fewer and bigger than a scatter
  // of small ones, which at this scale is just noise.
  for (var b2 = 0; b2 < 12; b2++) {
    var bx = irand(rng, 5, COLS - 6)
    var by = irand(rng, SKY + 2, ROWS - 5)
    var br = irand(rng, 3, 6)
    var here = at(w, bx, by)
    var lens = here === DIRT ? ROCK : (here === ROCK ? DIRT : ROCK)
    for (var dy = -br; dy <= br; dy++) {
      for (var dx = -br; dx <= br; dx++) {
        // Squashed flat: a lens in rock is a lens, not a ball.
        if (dx * dx + (dy * 2.2) * (dy * 2.2) > br * br) continue
        if (at(w, bx + dx, by + dy) === STEEL) continue
        setCell(w, bx + dx, by + dy, lens)
      }
    }
  }

  // Ore veins: a wandering one-cell line, occasionally two, drawn as a walk
  // rather than a curve so it kinks the way a real seam does.
  var veins = irand(rng, 3, 6)
  for (var v = 0; v < veins; v++) {
    var vx = irand(rng, 6, COLS - 7)
    var vy = irand(rng, SKY + 4, ROWS - 6)
    var len = irand(rng, 18, 44)
    var slope = rng() < 0.5 ? -1 : 1
    // Thickness is held for a stretch rather than rerolled per cell. Rerolling
    // it gives a dotted line — the seam reads as speckle instead of as one
    // continuous thing running through the rock.
    var thickRun = 0
    var vthick = 1
    for (var s = 0; s < len; s++) {
      vx += 1
      if (rng() < 0.3) vy += slope
      if (rng() < 0.08) slope = -slope
      if (thickRun-- <= 0) { vthick = rng() < 0.4 ? 2 : 1; thickRun = irand(rng, 3, 7) }
      if (vx >= COLS - 4 || vy < SKY + 1 || vy + vthick >= ROWS - 3) break
      for (var vt = 0; vt < vthick; vt++)
        if (at(w, vx, vy + vt) !== STEEL) setCell(w, vx, vy + vt, ORE)
    }
  }

  // Grit along the boundaries. Every cell that sits directly under a different
  // material has a chance of taking that material instead, which frays the
  // seam between two layers into something granular. This is the cheapest line
  // in the function and the one that does the most: without it every stratum
  // meets the next on a clean sine wave and the earth looks printed.
  // Flipped in short runs, never cell by cell. A per-cell coin toss along a
  // diagonal boundary produces a checkerboard, which is a very legible way of
  // announcing that a random number generator was here; runs of two or three
  // crumble instead.
  for (var gy = SKY + 1; gy < ROWS - 2; gy++) {
    for (var gx = 3; gx < COLS - 3; gx++) {
      var above = at(w, gx, gy - 1)
      var self = at(w, gx, gy)
      if (above === self || above === STEEL || self === STEEL || above === EMPTY) continue
      if (rng() >= 0.34) continue
      var run = irand(rng, 2, 4)
      for (var gr = 0; gr < run && gx < COLS - 3; gr++, gx++) {
        if (at(w, gx, gy) === STEEL) break
        setCell(w, gx, gy, above)
      }
    }
  }
  // Last, so it has the final say. It used to run before the grit pass, which
  // then frayed every panel edge back into rock — which is precisely why the
  // spaceship still read as a cavern with a pattern on it.
  biomeSkin(w, rng)
}

// Things standing on the floor and hanging from the ceiling. Purely something
// to look at: decor lives in its own list and never touches the terrain grid,
// so an agent walks straight through a stalagmite and nothing in the brain can
// see one. That is the only reason it can be scattered this freely — anything
// put in the grid is a wall to somebody.
//
// Draw.js checks the cell underneath is still solid before drawing each one,
// so a corridor that gets dug out loses its furniture on the way.
// What the earth is made of, biome by biome. All of this is material only, and
// the three workable materials are identical to everything that makes a
// decision, so a spaceship hull and a jungle can be as different as they like
// without moving a single agent.
function biomeSkin(w, rng) {
  var x, y

  if (w.biome === "Spaceship") {
    // Not geology at all: plating. A regular grid of panels with seams between
    // them, which is the one pattern on this board that could not possibly have
    // formed by itself.
    var pw = 9, ph = 5
    for (y = SKY; y < ROWS - 2; y++) {
      for (x = 3; x < COLS - 3; x++) {
        if (at(w, x, y) === STEEL) continue
        var seam = (x % pw === 0) || (y % ph === 0)
        var plate = (Math.floor(x / pw) + Math.floor(y / ph)) % 3 === 0
        setCell(w, x, y, seam ? ORE : (plate ? DIRT : ROCK))
      }
    }
    // A few panels missing entirely, exposing the frame underneath.
    for (var b = 0; b < 10; b++) {
      var bx = irand(rng, 5, COLS - 12), by = irand(rng, SKY + 3, ROWS - 8)
      for (y = by; y < by + ph - 1; y++)
        for (x = bx; x < bx + pw - 1; x++)
          if (at(w, x, y) !== STEEL) setCell(w, x, y, DIRT)
    }

    // Structural ribs: full-height frames at a regular pitch, running through
    // everything. A ship is a frame with plating on it, and the frame is what
    // stops the grid reading as wallpaper.
    for (x = 3 + (irand(rng, 0, 3)); x < COLS - 3; x += 17) {
      for (y = SKY; y < ROWS - 2; y++) {
        if (at(w, x, y) === STEEL) continue
        setCell(w, x, y, ORE)
        if (at(w, x + 1, y) !== STEEL) setCell(w, x + 1, y, ORE)
      }
    }

  } else if (w.biome === "Ice Cave") {
    // One mass of ice rather than layers. Strata read as sedimentary rock,
    // which is the opposite of what a glacier looks like.
    for (y = SKY; y < ROWS - 2; y++)
      for (x = 3; x < COLS - 3; x++)
        if (at(w, x, y) !== STEEL) setCell(w, x, y, DIRT)

    var cracks = irand(rng, 14, 22)
    for (var cr = 0; cr < cracks; cr++) {
      var cx2 = irand(rng, 5, COLS - 6), cy2 = irand(rng, SKY + 2, ROWS - 5)
      var len2 = irand(rng, 6, 20)
      var slope2 = rng() < 0.5 ? -1 : 1
      for (var st2 = 0; st2 < len2; st2++) {
        cy2 += rng() < 0.55 ? slope2 : 0
        cx2 += rng() < 0.7 ? 1 : 0
        if (cx2 >= COLS - 4 || cy2 < SKY + 1 || cy2 >= ROWS - 3) break
        if (at(w, cx2, cy2) !== STEEL) setCell(w, cx2, cy2, ORE)
      }
    }
    // Denser, brighter ice toward the bottom, where it has been compressed.
    for (y = ROWS - 14; y < ROWS - 2; y++)
      for (x = 3; x < COLS - 3; x++)
        if (at(w, x, y) === DIRT && rng() < 0.35) setCell(w, x, y, ROCK)

  } else if (w.biome === "Jungle") {
    // Overgrown. Roots and moss running everywhere through the soil, in blobs
    // and runners rather than bands — nothing here should look like it settled
    // quietly over millennia.
    for (var bl = 0; bl < 26; bl++) {
      var mx = irand(rng, 5, COLS - 6), my = irand(rng, SKY + 1, ROWS - 5)
      var mr = irand(rng, 2, 5)
      for (var dy2 = -mr; dy2 <= mr; dy2++)
        for (var dx2 = -mr; dx2 <= mr; dx2++) {
          if (dx2 * dx2 + dy2 * dy2 > mr * mr) continue
          if (at(w, mx + dx2, my + dy2) === STEEL) continue
          setCell(w, mx + dx2, my + dy2, rng() < 0.6 ? ORE : DIRT)
        }
    }
    // Runners: long thin roots that wander down through everything.
    var roots = irand(rng, 8, 14)
    for (var rt = 0; rt < roots; rt++) {
      var rx = irand(rng, 5, COLS - 6), ry = SKY + irand(rng, 0, 4)
      for (var rs = 0; rs < 30; rs++) {
        ry += rng() < 0.8 ? 1 : 0
        rx += rng() < 0.4 ? (rng() < 0.5 ? -1 : 1) : 0
        if (rx < 4 || rx >= COLS - 4 || ry >= ROWS - 3) break
        if (at(w, rx, ry) !== STEEL) setCell(w, rx, ry, ORE)
      }
    }
  }
}

function placeDecor(w, rng, corridors) {
  // How thickly furnished, and with what. A jungle is defined by there being
  // too much of everything; an ice cave by the ceiling; a spaceship by regular
  // fittings rather than growth. The original four keep the sparse scatter they
  // were tuned with.
  var floorRate = 0.13, ceilRate = 0.07, gap = 4
  var floorKinds = ["spire", "clump", "tuft", "tuft"]

  if (w.biome === "Jungle") {
    floorRate = 0.34; ceilRate = 0.26; gap = 2
    floorKinds = ["spire", "spire", "tuft", "tuft", "tuft", "clump"]
  } else if (w.biome === "Ice Cave") {
    floorRate = 0.20; ceilRate = 0.30; gap = 3
    floorKinds = ["spire", "spire", "clump", "tuft"]
  } else if (w.biome === "Spaceship") {
    floorRate = 0.18; ceilRate = 0.16; gap = 5
    floorKinds = ["spire", "clump", "clump", "tuft"]
  }

  // A ship's corridor is fitted, not furnished: a strip light overhead, grating
  // underfoot, and a viewport looking out at nothing. The viewports do most of
  // the work — a window onto space is the one thing on this board that cannot
  // be read as a cave.
  //
  // All of it is decor, so none of it is in the terrain grid and none of it is
  // an obstacle. A viewport is painted onto solid hull; the renderer only draws
  // one where the wall is still there, so bashing through a window removes it.
  if (w.biome === "Spaceship") {
    for (var si = 0; si < corridors.length; si++) {
      var sc = corridors[si]
      for (var sx2 = sc.x0 + 4; sx2 < sc.x1 - 6; sx2 += irand(rng, 9, 16)) {
        // Set into the wall above the corridor, where there is wall to set it
        // into.
        var wy = sc.floorY - CORR_H - 4
        if (solid(w, sx2, wy) && solid(w, sx2 + 3, wy)) {
          w.decor.push({ x: sx2, y: wy, kind: "window", size: irand(rng, 2, 3), seed: Math.floor(rng() * 1000) })
        }
      }
      // Strip lights along the ceiling and grating along the floor, on a
      // regular pitch, because nothing on a ship is where it fell.
      for (var lx = sc.x0 + 3; lx < sc.x1 - 3; lx += 11) {
        var lceil = sc.floorY - CORR_H - 1
        if (solid(w, lx, lceil)) w.decor.push({ x: lx, y: lceil + 1, kind: "strip", size: 2, seed: 0 })
      }
      for (var gx2 = sc.x0 + 2; gx2 < sc.x1 - 3; gx2 += 6) {
        if (solid(w, gx2, sc.floorY) && !solid(w, gx2, sc.floorY - 1))
          w.decor.push({ x: gx2, y: sc.floorY - 1, kind: "grate", size: 1, seed: gx2 })
      }
    }
  }

  for (var i = 0; i < corridors.length; i++) {
    var c = corridors[i]
    for (var x = c.x0 + 2; x < c.x1 - 2; x++) {
      // Standing on the floor, where there is floor and room above it.
      if (solid(w, x, c.floorY) && !solid(w, x, c.floorY - 1) && rng() < floorRate) {
        w.decor.push({
          x: x, y: c.floorY - 1, kind: pick(rng, floorKinds),
          size: irand(rng, 1, 3), seed: Math.floor(rng() * 1000)
        })
        x += irand(rng, 1, gap)
        continue
      }
      // Hanging from the ceiling, which is what makes a corridor read as cut
      // through rock rather than as a shelf with things on it — and in a jungle
      // or an ice cave it is most of the character.
      var ceil = c.floorY - CORR_H - 1
      if (solid(w, x, ceil) && !solid(w, x, ceil + 1) && rng() < ceilRate) {
        w.decor.push({
          x: x, y: ceil + 1, kind: "hang",
          size: irand(rng, 1, w.biome === "Jungle" ? 3 : 2), seed: Math.floor(rng() * 1000)
        })
        x += irand(rng, 1, gap + 1)
      }
    }
  }
}

function carveCorridor(w, c) {
  for (var x = c.x0; x <= c.x1; x++)
    for (var y = c.floorY - CORR_H; y < c.floorY; y++) clearCell(w, x, y)
}

// The floor of a corridor, per biome. A perfectly flat floor across a hundred
// cells is the single thing that makes every level read as the same level, and
// it is the right look for exactly one of the seven: a spaceship, where flat is
// the point.
//
// Everything here moves the floor by at most MAX_STEP between adjacent columns
// and never raises it more than a stride above the original level, so it is
// walked over in stride and no route is affected. It cannot make a level harder;
// it can only make it look like somewhere.
function roughFloor(w, c, rng, biome) {
  var amp, lumpy
  if (biome === "Jungle") { amp = 2; lumpy = 0.55 }        // roots, hollows, undergrowth
  else if (biome === "Ice Cave") { amp = 2; lumpy = 0.20 } // long smooth drifts
  else return   // everything else keeps the floor it had

  // Cavern was given a gentle version of this and measured as the worst biome
  // on the board for it — it is also the one people see first, and the one the
  // original four were tuned flat against. It stays flat.

  var h = 0
  var run = 0
  for (var x = c.x0; x <= c.x1; x++) {
    if (run-- <= 0) {
      // A new target height, held for a stretch. Rerolling every column gives
      // a comb rather than ground.
      var step = rng() < lumpy ? (rng() < 0.5 ? -1 : 1) : 0
      h = Math.max(0, Math.min(amp, h + step))
      run = irand(rng, biome === "Ice Cave" ? 4 : 1, biome === "Ice Cave" ? 11 : 5)
    }
    // Only where there is still floor to build on. Everything the obstacles
    // took away stays taken away.
    if (!solid(w, x, c.floorY)) { h = 0; continue }
    for (var d = 0; d < h; d++) setCell(w, x, c.floorY - 1 - d, DIRT)
  }
}

// Between the corridor's start and its handoff point sit one to three
// obstacles. Each shape below maps to exactly one reaction in decide().
function placeObstacles(w, rng, c, index, corridors) {
  var lo = Math.min(c.startX, c.handoffX)
  var hi = Math.max(c.startX, c.handoffX)
  var span = hi - lo
  if (span < 24) return

  // On the last corridor, only obstacles that sit ON the floor. The exit is on
  // that floor, and gap/pit/cliff all work by carving it away — which on every
  // corridor above just opens an early way down, and on this one digs a pocket
  // underneath the only room that matters. An agent that falls in has the exit
  // overhead and no corridor below to move on to, and that hole held every
  // stranded agent in a 120-level run.
  // Weighted, not uniform. A flat list put a climbable face in the mix as often
  // as anything else, and climbing used to be free after the first wall.
  // Bashing and bridging have to be the common answers or the whole level reads
  // as walking, climbing and falling.
  var lastOne = index === corridors.length - 1
  var kinds = lastOne
    ? ["wall", "collapse", "pillars", "towers", "step"]
    : ["wall", "collapse", "collapse", "pillars", "towers", "towers",
       "chasm", "chasm", "gap", "gap", "pit", "pit", "step"]
  // The floater needs a drop taller than SAFE_FALL, and the only landing far
  // enough down to be one is the corridor TWO floors below — see the cliff
  // case for why it has to be a real corridor and not just a deep hole.
  if (index < corridors.length - 2 && !lastOne) kinds.push("cliff")

  // Two or three. At one to three, spaced across eighty cells, a corridor could
  // easily come out as a stroll with a single thing in the way.
  //
  // The last corridor gets at most one, plus the wall sealing the exit. Every
  // other corridor has a way onward, so failing an obstacle there costs a
  // detour; this one has only the exit, so failures compound — a colony that
  // can't get past the second of three obstacles here doesn't get a worse
  // result, it gets no result. Corridors 0-2 carry the difficulty; the last
  // stretch is the pay-off.
  var count = lastOne ? irand(rng, 0, 1) : irand(rng, 2, 3)
  if (count === 0) return

  // One corridor per level is guaranteed a chasm. Left to the dice, a bridge
  // being built — the most distinctive thing any of them does — turned up on
  // barely half of levels, which is easily few enough to watch for a while and
  // conclude the builder doesn't exist.
  var forced = (lastOne || index > 1) ? -1 : 1
  var slot = span / (count + 1)

  for (var n = 1; n <= count; n++) {
    var x = Math.round(lo + slot * n)
    var kind = n === forced ? "chasm" : pick(rng, kinds)
    // Kept so the level's danger can be put where the traffic is densest and
    // the timing is funniest — see placeHazard().
    c.obstacles.push(x)

    if (kind === "wall") {
      // A plug spanning the full corridor height: climbing it just buries the
      // agent's head in the ceiling, so the only way on is through it.
      var t = irand(rng, 3, 6)
      for (var wx = x; wx < x + t; wx++)
        for (var wy = c.floorY - CORR_H; wy < c.floorY; wy++) setCell(w, wx, wy, DIRT)

    } else if (kind === "step") {
      // The floor rises by more than a stride, with the ceiling lifted to
      // match so there IS a way over: a climber's obstacle.
      var rise = irand(rng, 4, 7)
      var len = irand(rng, 12, 20)
      var topCeil = c.floorY - rise - CORR_H

      // Open the approach at both ends across BOTH ceiling heights first. A
      // climber goes up hugging the column it's standing in, not the face, so
      // without this it has the original corridor's roof directly over its
      // head: it climbs two cells, brains itself, drops, and tries again from
      // the same spot until the level runs out of clock.
      for (var apx = x - 3; apx < x; apx++)
        for (var apy = topCeil; apy < c.floorY; apy++) clearCell(w, apx, apy)
      for (var bpx = x + len; bpx < x + len + 3; bpx++)
        for (var bpy = topCeil; bpy < c.floorY; bpy++) clearCell(w, bpx, bpy)

      for (var sx = x; sx < x + len && sx <= hi; sx++) {
        for (var fy = c.floorY - rise; fy < c.floorY; fy++) setCell(w, sx, fy, DIRT)
        for (var cy = topCeil; cy < c.floorY - rise; cy++) clearCell(w, sx, cy)
      }

    } else if (kind === "chasm") {
      // Floor gone, far side at the same height, and the bottom of it is the
      // corridor below. Whoever bridges it stays on this floor; whoever walks
      // in carries on a storey down. Both are fine outcomes, which is what
      // makes it the clearest showcase of who's who on the board — and the
      // reason there's now a build to watch on nearly every level.
      var span2 = irand(rng, 10, 17)
      var floorBelow = index + 1 < corridors.length ? corridors[index + 1].floorY : ROWS - 3
      for (var gx2 = x; gx2 < x + span2 && gx2 <= hi; gx2++)
        for (var gy2 = c.floorY; gy2 < floorBelow; gy2++) clearCell(w, gx2, gy2)

    } else if (kind === "collapse") {
      // A cave-in: the same answer as `wall` — bash through it — with a shape
      // worth looking at. A full-height plug with a spill of debris ramping up
      // to it on both sides.
      //
      // The shoulders are capped at two cells, and that cap is load-bearing
      // rather than cosmetic. An agent standing on debris h high has its head
      // in the ceiling once h > 2 (CORR_H is 6 and it needs 4), so anything
      // taller stops being a slope it walks up and becomes more wall to chew
      // through — and the width it would then have to bash through is the
      // shoulders plus the core, which runs past BASH_REACH and turns the
      // whole corridor into something the colony gives up on and paces.
      var core = irand(rng, 3, 5)
      var spill = irand(rng, 3, 6)
      var debris = [ROCK, ORE, ROCK, DIRT]

      for (var kx = x; kx < x + core && kx <= hi; kx++)
        for (var ky = c.floorY - CORR_H; ky < c.floorY; ky++)
          setCell(w, kx, ky, debris[(kx + ky) % debris.length])

      for (var sp = 1; sp <= spill; sp++) {
        var hgt = sp <= spill / 2 ? 2 : 1
        for (var lx = 0; lx < 1; lx++) {
          for (var sh = 0; sh < hgt; sh++) {
            setCell(w, x - sp, c.floorY - 1 - sh, debris[(x + sp + sh) % debris.length])
            setCell(w, x + core - 1 + sp, c.floorY - 1 - sh, debris[(x + sp + sh + 1) % debris.length])
          }
        }
      }

    } else if (kind === "towers") {
      // Pillars of two minds: some reach the ceiling and have to be bashed,
      // some are stubs low enough to walk over in stride. One obstacle, two
      // answers, and which is which changes every level — where a run of
      // identical pillars is the same decision made four times.
      var tn = irand(rng, 4, 6)
      var tpitch = irand(rng, 5, 8)
      var tthick = irand(rng, 2, 3)
      var solidCount = 0
      for (var tc = 0; tc < tn; tc++) {
        var tx = x + tc * tpitch
        if (tx + tthick > hi) break
        // At least two of them are real, so this never degenerates into a
        // decorative row of bumps the colony strolls over.
        var full = solidCount < 2 || rng() < 0.5
        if (full) solidCount++
        var top = full ? c.floorY - CORR_H : c.floorY - irand(rng, 1, 2)
        for (var tw = tx; tw < tx + tthick; tw++)
          for (var th = top; th < c.floorY; th++)
            setCell(w, tw, th, full ? (tc % 2 === 0 ? DIRT : ROCK) : ORE)
      }

    } else if (kind === "pillars") {
      // A run of narrow columns rather than one thick wall. Each is only a few
      // cells through, so each is a separate bash — the single obstacle that
      // reliably produces a burst of work instead of one decision, and the one
      // that makes a corridor look inhabited rather than empty.
      var cols = irand(rng, 3, 5)
      var pitch = irand(rng, 5, 8)
      var thick = irand(rng, 2, 3)
      for (var pc = 0; pc < cols; pc++) {
        var colX = x + pc * pitch
        if (colX + thick > hi) break
        for (var pw = colX; pw < colX + thick; pw++)
          for (var ph = c.floorY - CORR_H; ph < c.floorY; ph++) setCell(w, pw, ph, pc % 2 === 0 ? DIRT : ROCK)
      }

    } else if (kind === "gap") {
      // Floor removed with the far side back at the same height — a bridge is
      // the obvious answer, and the pocket below is a soft landing if a
      // agent walks in before anyone thinks to build.
      var g = irand(rng, 7, 13)
      for (var gx = x; gx < x + g; gx++)
        for (var gy = c.floorY; gy < c.floorY + 9; gy++) clearCell(w, gx, gy)

    } else if (kind === "pit") {
      // Steep-sided and too deep to climb out of: whoever falls in builds out.
      var pw = irand(rng, 7, 11)
      for (var px = x; px < x + pw; px++)
        for (var py = c.floorY; py < c.floorY + 8; py++) clearCell(w, px, py)
      for (var ry = c.floorY; ry < c.floorY + 8; ry++) {
        setCell(w, x - 1, ry, ROCK)
        setCell(w, x + pw, ry, ROCK)
      }

    } else if (kind === "cliff") {
      // The corridor floor falls away for the rest of its run, far enough that
      // an unprotected landing would splat. Umbrellas out.
      //
      // It drops all the way to the floor of the corridor two below, which is
      // the point: a trench of its own with a fresh floor laid at the bottom
      // looks the same and is an agent trap, because the thing that floats
      // down into it lands in a sealed box with earth on both sides and no
      // route out. Landing in a real corridor makes the same drop a shortcut
      // — a floor skipped — instead of a dead end.
      var below = corridors[index + 2]
      var drop = below.floorY - c.floorY
      // Kept inside [lo, hi] — the stretch between the corridor's start and
      // its handoff. Everything past the handoff belongs to placeHazard(), and
      // an obstacle that carves into it deletes the one bottomless drop on the
      // level along with the only chance of ever seeing a blocker.
      var from = c.dir > 0 ? x : lo
      var to = c.dir > 0 ? hi : x
      for (var cxx = from; cxx <= to; cxx++)
        for (var dy2 = c.floorY - CORR_H; dy2 < below.floorY; dy2++) clearCell(w, cxx, dy2)
    }
  }
}

// ---------------------------------------------------------------------------
// Special agents
//
// One per colony at most, and not in every colony. A special cannot touch the
// level's toolbar at all — no climbs, no bridges, no umbrella, nothing from the
// budget the other fourteen are sharing — and in exchange it has one thing it
// can do forever. Where everybody else is rationed, it is inexhaustible and
// one-dimensional, which is a different kind of creature to watch: the colony
// works the level, and this one just does its trick at whatever is in the way
// until the level gives up.
//
// That trade is the whole design. Give it its trick AND the toolbar and it
// simply solves the level on its own, and the other fourteen become scenery.
//
// `act` is what it does to anything blocking it, free and repeatable. Most are
// a shape cut out of the terrain over a few ticks; a handful are just the
// ordinary skill with no meter on it. The passives change how it moves rather
// than what it removes.
// ---------------------------------------------------------------------------

var SPECIALS = [
  // Every one of these does something you can see it do, on a cooldown long
  // enough that it reads as a decision rather than a tic. The first version had
  // twenty, twelve of which had no animation at all — "that one is slightly
  // teal and walks a bit quicker" is not a character at this size — and the
  // eight that did have one fired it seventy times a level, which is not a
  // signature move either. Ten, all visible, all rationed by time instead of
  // by budget.
  //
  // `cool` is ticks before it can do it again. While it is cooling it turns at
  // a wall like anybody else, so the move is something you wait for.

  // Works like a basher, except it happens all at once: a tunnel the height of
  // an agent, punched through in a single shot.
  { id: "buckshot",  name: "Max Tokens",   act: "blast",  cool: 150, robe: "#b83232", hair: "#e8d24a" },

  // Does not destroy the wall. Moves it. The block ahead is picked up and put
  // down four cells further on, which can open a way through, seal one, or
  // shunt a lump of the level into a hole — and the colony has to deal with
  // wherever it ended up.
  { id: "roundhouse",name: "Vector Van Damme", act: "kick",   cool: 130, robe: "#d1621f", hair: "#3a2a18" },

  // Goes up the wall, onto the ceiling, and keeps walking upside down until the
  // roof runs out from under it.
  { id: "spider",    name: "Web Crawler",     act: "ceiling",cool: 90,  robe: "#8f2bbf", hair: "#e04a8a" },

  // Topples the column rather than deleting it: what was a wall lies down and
  // becomes a floor to walk out on.
  { id: "lumberjack",name: "Random Forrest", act: "topple", cool: 170, robe: "#2f6b3a", hair: "#8a4b22" },

  { id: "pyro",      name: "Sim Anneal",       act: "melt",   cool: 160, robe: "#c4341c", hair: "#f0a03c" },
  { id: "sapper",    name: "Prompt Injection",     act: "sap",    cool: 200, robe: "#6b6b28", hair: "#c8c8b0" },
  { id: "piledriver",name: "Gradient Descent", act: "stomp",  cool: 140, robe: "#4a4f59", hair: "#d8dde5" },
  { id: "quarryman", name: "Context Window",  act: "quarry", cool: 220, robe: "#a8843c", hair: "#5a4426" },

  // The only one that adds instead of taking away.
  { id: "glazier",   name: "Guard Rails",    act: "slab",   cool: 120, robe: "#4a9ec4", hair: "#dff2ff" },

  // Steps through the wall rather than removing it, which leaves the level
  // exactly as it found it and gets nobody else anywhere.
  { id: "wraith",    name: "Hal Lucination",     act: "phase",  cool: 110, robe: "#8e8ea8", hair: "#e8e8f4" },

  // The two that can do something about the level's danger. Everybody else
  // treats a danger as weather — you learn it, you time it, you live with it.
  // These two shoot it.
  { id: "gridsearch",name: "Grid Search",    act: "spray",  cool: 70,  robe: "#4a5d23", hair: "#b03a2e" },
  { id: "beamsearch",name: "Beam Search",    act: "camp",   cool: 120, robe: "#37474f", hair: "#8fd0e8" }
]

function specialSpec(id) {
  for (var i = 0; i < SPECIALS.length; i++) if (SPECIALS[i].id === id) return SPECIALS[i]
  return null
}

function specOf(ag) { return ag.special ? specialSpec(ag.special) : null }

// What each move does. Everything refuses steel, so no move can open the side
// of the board or the floor of the world — the same rule the ordinary skills
// live under. A move that shifts nothing returns false and the special turns
// round instead, which is the only thing standing between a trick and a
// special firing into bedrock until the level times out.
// `dry` asks the question without doing anything: would this move achieve
// anything from here? A special checks before it commits, so it never winds up
// for half a second in front of a block it was never going to shift — which is
// the difference between a character with a signature move and one that keeps
// swinging at things and missing.
// Is there anything here a move could actually take out?
function workable(w, x, y) {
  var m = at(w, x, y)
  return m !== EMPTY && m !== STEEL
}

function specialCut(w, ag, act, dry) {
  var fx = Math.floor(ag.x)
  var fy = Math.floor(ag.y)
  var d = ag.dir
  var moved = false
  var i, j

  if (act === "blast") {
    // A basher's tunnel, opened in one shot instead of over ten seconds.
    for (i = 1; i <= 8; i++)
      for (j = -AGENT_H; j <= 0; j++)
        if (dry ? workable(w, fx + d * i, fy + j) : clearCell(w, fx + d * i, fy + j)) {
          if (dry) return true
          moved = true
        }

  } else if (act === "kick") {
    // The wall is not destroyed. It is moved.
    //
    // Three columns of it are lifted out and set down further along, which can
    // open a way through, seal one, or drop a lump of the level into a hole
    // somebody was going to have to bridge. Nobody is told; they just find the
    // level rearranged.
    //
    // It tries four cells first and settles for less rather than refusing
    // outright — against anything thicker than about three cells the far side
    // is still solid, and insisting on the full shove meant the signature move
    // fired about once every two levels.
    var W = 3
    var block = []
    for (i = 0; i < W; i++) {
      block[i] = []
      for (j = 0; j <= AGENT_H; j++) {
        var m = at(w, fx + d * (1 + i), fy - AGENT_H + j)
        if (m === STEEL) return false          // steel is nobody's to move
        block[i][j] = m
      }
    }

    var shove = 0
    for (var trySh = 4; trySh >= 1; trySh--) {
      var fits = true
      for (i = 0; i < W && fits; i++)
        for (j = 0; j <= AGENT_H; j++) {
          if (block[i][j] === EMPTY) continue
          var dx = fx + d * (1 + i + trySh)
          // Landing on itself is fine; landing on anything else is not.
          if (i + trySh < W) continue
          if (at(w, dx, fy - AGENT_H + j) !== EMPTY) { fits = false; break }
        }
      if (fits) { shove = trySh; break }
    }
    if (shove === 0) return false
    if (dry) return true

    for (i = W - 1; i >= 0; i--)
      for (j = 0; j <= AGENT_H; j++) {
        var m2 = block[i][j]
        if (m2 === EMPTY) continue
        clearCell(w, fx + d * (1 + i), fy - AGENT_H + j)
        setCell(w, fx + d * (1 + i + shove), fy - AGENT_H + j, m2)
        moved = true
      }

  } else if (act === "topple") {
    // Fells the wall rather than tunnelling through it: everything above knee
    // height comes down across the whole thickness, and what is left is a step
    // anyone can stride over. Some of it lands as rubble on both sides, which
    // is what makes it read as a wall coming down rather than a wall being
    // deleted.
    //
    // The first version toppled a single column into the space beyond, which
    // is a fine idea and works against free-standing pillars — of which this
    // level generator makes almost none. It refused ninety-seven times out of a
    // hundred and the Lumberjack never did anything at all.
    var thick = 0
    while (thick < 8 && solid(w, fx + d * (1 + thick), fy)) thick++
    if (thick === 0) return false

    var tallest = 0
    for (i = 0; i < thick; i++) {
      var col = 0
      while (col < 14 && solid(w, fx + d * (1 + i), fy - col)) col++
      if (col > tallest) tallest = col
    }
    if (tallest < 3) return false                 // already a stride

    // Steel does not come down for anybody.
    for (i = 0; i < thick; i++)
      for (j = 0; j < tallest; j++)
        if (at(w, fx + d * (1 + i), fy - j) === STEEL) return false
    if (dry) return true

    for (i = 0; i < thick; i++)
      for (j = 2; j < tallest; j++)
        if (clearCell(w, fx + d * (1 + i), fy - j)) moved = true

    // The rubble it leaves, on the near side and the far.
    setCell(w, fx, fy, ROCK)
    setCell(w, fx + d * (1 + thick), fy, ROCK)

  } else if (act === "melt") {
    for (i = -5; i <= 5; i++)
      for (j = -5; j <= 5; j++) {
        if (i * i + j * j > 26) continue
        var meltY = fy - 2 + j
        // A sideways move may open the wall down to foot height, but not the
        // floor under it. Cutting lower leaves a crater rather than a tunnel;
        // level 1's whole colony used to collect on its one-cell shelves.
        if (meltY > fy) continue
        if (dry ? workable(w, fx + d * 4 + i, meltY) : clearCell(w, fx + d * 4 + i, meltY)) {
          if (dry) return true
          moved = true
        }
      }

  } else if (act === "sap") {
    for (i = -BOMB_RADIUS; i <= BOMB_RADIUS; i++)
      for (j = -BOMB_RADIUS; j <= BOMB_RADIUS; j++) {
        if (i * i + j * j > BOMB_RADIUS * BOMB_RADIUS) continue
        var sapY = fy - 2 + j
        if (sapY > fy) continue
        if (dry ? workable(w, fx + d * 5 + i, sapY) : clearCell(w, fx + d * 5 + i, sapY)) {
          if (dry) return true
          moved = true
        }
      }
    addDust(w, fx + d * 5, fy - 2, 18)

  } else if (act === "stomp") {
    for (i = -1; i <= 1; i++)
      for (j = 1; j <= 6; j++)
        if (dry ? workable(w, fx + i, fy + j) : clearCell(w, fx + i, fy + j)) {
          if (dry) return true
          moved = true
        }

  } else if (act === "quarry") {
    for (i = 1; i <= 7; i++)
      // Context Window is enormous sideways, not downward. The floor is the
      // one row its opening must leave alone.
      for (j = -7; j <= 0; j++)
        if (dry ? workable(w, fx + d * i, fy + j) : clearCell(w, fx + d * i, fy + j)) {
          if (dry) return true
          moved = true
        }

  } else if (act === "slab") {
    for (i = 1; i <= 6; i++)
      for (j = 1; j <= 3; j++)
        if (at(w, fx + d * i, fy + j) === EMPTY
            && !agentOccupiesCell(w, fx + d * i, fy + j, ag)) {
          if (dry) return true
          setCell(w, fx + d * i, fy + j, ROCK); moved = true
        }

  } else if (act === "spray") {
    // Fires at everything. A wide burst — the full height of the corridor and a
    // good way down it — and then the rounds that got through keep going.
    //
    // The danger is checked AFTER the terrain is cut, along a line from the
    // muzzle: the burst opens the tunnel and the same burst goes down it. The
    // first version tested a fixed box before cutting, which never reached,
    // because a danger is placed just past an obstacle and the obstacle is
    // exactly what Grid Search is standing in front of.
    var hit = false
    for (i = 1; i <= 10; i++)
      for (j = -AGENT_H - 2; j <= 1; j++)
        if (dry ? workable(w, fx + d * i, fy + j) : clearCell(w, fx + d * i, fy + j)) {
          if (dry) return true
          hit = true
        }

    var hz = w.hazard
    if (hz && !hz.wrecked) {
      var hm = hazardMid(hz)
      var ahead = (hm.x - fx) * d
      if (ahead > 0 && ahead <= 20 && Math.abs(hm.y - fy) <= CORR_H) {
        if (dry) return true
        if (lineClear(w, fx, fy - 2, Math.round(hm.x), Math.round(hm.y))) {
          wreckHazard(w)
          hit = true
        }
      }
    }
    moved = hit

  } else if (act === "phase") {
    // Steps through instead of removing. It gets itself past and leaves the
    // level exactly as it found it, which helps precisely nobody else.
    for (i = 1; i <= 10; i++) {
      var tx = fx + d * i
      if (at(w, tx, fy) === STEEL) return false
      if (!solid(w, tx, fy) && !solid(w, tx, fy - 1) && solid(w, tx, fy + 1)) {
        if (!dry) ag.x = tx + 0.5
        return true
      }
    }
    return false
  }

  if (moved) {
    w.terrainVersion++
    addDust(w, fx + d * 2, fy - 2, 8)
  }
  return moved
}

// ---------------------------------------------------------------------------
// Dangers
//
// At most one per level, and not on every level — a board that always has a
// machine gun on it is a board with a machine gun on it, where a board that
// might have one is a board you watch.
//
// Every danger is built out of one of five mechanisms and differs in where it
// mounts, how far it reaches, how long it telegraphs before it fires and how
// long it rests afterwards. That is deliberate: twenty separate pieces of
// clockwork would be twenty separate ways for a level to become unwinnable,
// where twenty settings of the same five are twenty things to look at.
//
//   watch    dormant until somebody comes within reach, then winds up and fires
//   beam     fires on its own schedule whether or not anyone is there
//   plate    armed by being stood on, and goes off a moment later
//   cycle    never stops, never triggers — just keeps its own time
//   field    always live, and the only kind with no safe moment at all
//
// Every mechanism except `field` has a rest between firings long enough to walk
// through, so a danger is a risk rather than a wall. That matters more than it
// sounds: the colony's answer to a danger is a blocker, and a blocker never
// stands down, so anything that had to be sealed rather than timed would take
// the route with it.
// ---------------------------------------------------------------------------

var HAZARDS = [
  // watch: mounted, dormant, wakes when somebody walks into reach
  { id: "gun",      name: "machine gun",  mech: "watch", mount: "ceiling", reach: 13, charge: 16, fire: 24, rest: 66, w: 5, h: 6 },
  { id: "sentry",   name: "sentry",       mech: "watch", mount: "wall",    reach: 16, charge: 34, fire: 14, rest: 74, w: 3, h: 4 },
  { id: "darts",    name: "dart trap",    mech: "watch", mount: "wall",    reach: 11, charge: 18, fire: 10, rest: 52, w: 3, h: 3 },
  { id: "flame",    name: "flame vent",   mech: "watch", mount: "ceiling", reach: 9,  charge: 30, fire: 26, rest: 70, w: 4, h: 6 },
  { id: "tesla",    name: "tesla coil",   mech: "watch", mount: "floor",   reach: 10, charge: 24, fire: 18, rest: 62, w: 5, h: 5 },
  { id: "turret",   name: "turret",       mech: "watch", mount: "ceiling", reach: 15, charge: 18, fire: 20, rest: 68, w: 4, h: 5 },

  // snipe: picks a target it can actually see, anywhere down the corridor
  { id: "sniper",   name: "sniper",       mech: "snipe", mount: "wall",    reach: 46, charge: 44, fire: 10, rest: 150, w: 3, h: 3 },

  // beam: keeps its own schedule, telegraphs with a sight line
  { id: "lasergrid",name: "laser grid",   mech: "beam",  mount: "ceiling", reach: 6,  charge: 30, fire: 30, rest: 60, w: 6, h: 6 },
  { id: "sweeper",  name: "sweeper",      mech: "beam",  mount: "ceiling", reach: 10, charge: 26, fire: 34, rest: 56, w: 8, h: 6 },
  { id: "tripwire", name: "tripwire",     mech: "beam",  mount: "floor",   reach: 7,  charge: 20, fire: 16, rest: 58, w: 7, h: 2 },

  // plate: armed by being stood on
  { id: "spikes",   name: "floor spikes", mech: "plate", mount: "floor",   reach: 3, charge: 16, fire: 22, rest: 46, w: 5, h: 3 },
  { id: "beartrap", name: "bear trap",    mech: "plate", mount: "floor",   reach: 2, charge: 8,  fire: 18, rest: 40, w: 3, h: 2 },
  { id: "sawblade", name: "saw blade",    mech: "plate", mount: "floor",   reach: 3, charge: 20, fire: 26, rest: 50, w: 4, h: 3 },
  { id: "grinder",  name: "grinder",      mech: "plate", mount: "floor",   reach: 4, charge: 24, fire: 30, rest: 54, w: 6, h: 3 },

  // cycle: never triggers, never stops
  { id: "crusher",  name: "crusher",      mech: "cycle", mount: "ceiling", reach: 0, charge: 34, fire: 20, rest: 62, w: 5, h: 6 },
  { id: "pendulum", name: "pendulum",     mech: "cycle", mount: "ceiling", reach: 0, charge: 28, fire: 24, rest: 48, w: 6, h: 6 },
  { id: "geyser",   name: "steam vent",   mech: "cycle", mount: "floor",   reach: 0, charge: 30, fire: 26, rest: 64, w: 4, h: 6 },
  { id: "rockfall", name: "rockfall",     mech: "cycle", mount: "ceiling", reach: 0, charge: 36, fire: 18, rest: 72, w: 5, h: 6 },
  { id: "piston",   name: "piston",       mech: "cycle", mount: "wall",    reach: 0, charge: 18, fire: 24, rest: 56, w: 5, h: 4 },

  // field: always live. Narrow, because there is no moment when it isn't.
  { id: "brazier",  name: "brazier",      mech: "field", mount: "floor",   reach: 0, charge: 0, fire: 1, rest: 0, w: 2, h: 4 },
  { id: "fence",    name: "electric fence", mech: "field", mount: "floor", reach: 0, charge: 0, fire: 1, rest: 0, w: 2, h: 5 },

  // Biome-only. `only` keeps a thing where it belongs — a snake in a foundry
  // is a snake in the wrong story — and `not` keeps open flame out of the ice.
  { id: "snake",    name: "snake",        mech: "watch", mount: "floor",   reach: 9,  charge: 20, fire: 16, rest: 60, w: 4, h: 3, only: ["Jungle"] },
  { id: "spores",   name: "spore bloom",  mech: "cycle", mount: "ceiling", reach: 0,  charge: 30, fire: 28, rest: 60, w: 6, h: 6, only: ["Jungle"] },
  { id: "icicle",   name: "icicle fall",  mech: "cycle", mount: "ceiling", reach: 0,  charge: 32, fire: 16, rest: 70, w: 5, h: 6, only: ["Ice Cave"] },
  { id: "frostjet", name: "frost jet",    mech: "watch", mount: "wall",    reach: 12, charge: 22, fire: 20, rest: 64, w: 4, h: 4, only: ["Ice Cave"] },
  { id: "airlock",  name: "airlock",      mech: "cycle", mount: "floor",   reach: 0,  charge: 34, fire: 24, rest: 66, w: 6, h: 6, only: ["Spaceship"] },
  { id: "servo",    name: "servo arm",    mech: "watch", mount: "ceiling", reach: 14, charge: 18, fire: 18, rest: 62, w: 4, h: 5, only: ["Spaceship"] }
]

// Open flame and steam have no business in an ice cave, and the industrial
// machinery reads wrong in a jungle.
var HAZARD_NOT = {
  brazier: ["Ice Cave"],
  flame: ["Ice Cave"],
  pyro: ["Ice Cave"],
  geyser: ["Ice Cave", "Spaceship"],
  grinder: ["Jungle"],
  piston: ["Jungle"],
  crusher: ["Jungle"],
  tesla: ["Jungle"],
  fence: ["Jungle"]
}

// Which of them may turn up on this level.
function hazardsFor(biome) {
  var out = []
  for (var i = 0; i < HAZARDS.length; i++) {
    var spec = HAZARDS[i]
    if (spec.only && spec.only.indexOf(biome) < 0) continue
    var banned = HAZARD_NOT[spec.id]
    if (banned && banned.indexOf(biome) >= 0) continue
    out.push(spec)
  }
  return out
}

function hazardSpec(id) {
  for (var i = 0; i < HAZARDS.length; i++) if (HAZARDS[i].id === id) return HAZARDS[i]
  return HAZARDS[0]
}

// Placed at the near end of a corridor — behind where the colony drops in, on
// the opposite side from the handoff they are walking towards. That is the same
// dead ground the bottomless drop uses, and for the same reason: agents land
// facing away from it, so the only ones who ever meet it are those who turned
// back from something, and walling it off later costs the level nothing.
//
// Putting one on the route instead reads as more exciting and is not, because
// the colony's answer is a blocker and a blocker is forever. A danger you have
// to seal is a level you cannot finish.
function placeHazard(w, rng, corridors, ci) {
  var c = corridors[ci]
  var spec = pick(rng, hazardsFor(w.biome))

  // On the route, between where the colony arrives and where it hands off.
  //
  // Two earlier attempts put it on the dead ground at the far end, on the
  // reasoning that a danger the colony walls off must not be on the way. Both
  // were wasted: counting where agents actually spend their time showed the
  // outer five columns of a middle corridor get essentially no traffic at all,
  // so twenty kinds of trap produced a kill in one attempt out of ten. A
  // danger nobody meets is scenery with extra steps.
  //
  // What makes it safe to put on the route instead is that a danger rests. The
  // colony's answer below is to back off while it is live, not to seal it, so
  // the way through is still there — it just has to be timed.
  var lo = Math.min(c.startX, c.handoffX)
  var hi = Math.max(c.startX, c.handoffX)
  if (hi - lo < 30) return null

  // Candidates, best first: just past an obstacle in the direction of travel.
  // Everyone who gets through a wall arrives at the same few cells on the far
  // side of it, which makes that the densest traffic on the corridor and the
  // only spot where the timing is funny — you spend nine seconds bashing
  // through and step straight into the machine gun.
  var spots = []
  for (var oi = 0; oi < c.obstacles.length; oi++) {
    var past = c.obstacles[oi] + c.dir * (8 + irand(rng, 0, 5))
    if (past > lo + 4 && past < hi - spec.w - 2) spots.push(past)
  }
  // Failing that, anywhere along the middle of the run.
  for (var f = 0; f < 12; f++) spots.push(Math.round(lo + (hi - lo) * (0.3 + rng() * 0.45)))

  // Somewhere along the middle of the run with the room to actually mount it.
  // The first version trusted the corridor's nominal geometry and put a fence
  // in mid-air on any level where an obstacle had already carved the floor out
  // from under that spot — placeObstacles runs first and is free to remove any
  // of this. So the spot is checked rather than assumed: open corridor for the
  // whole width of the zone, and something solid to bolt it to.
  var x = -1
  for (var tryN = 0; tryN < spots.length; tryN++) {
    var cand = spots[tryN]
    if (cand + spec.w >= hi || cand <= lo) continue
    var ok = true
    for (var q = 0; q < spec.w; q++) {
      var qx = cand + q
      // Open air where it fires, so it is visible and reaches somebody.
      if (solid(w, qx, c.floorY - 1) || solid(w, qx, c.floorY - 2)) { ok = false; break }
      // And something to hang it from.
      var anchor = spec.mount === "ceiling" ? c.floorY - CORR_H - 1 : c.floorY
      if (!solid(w, qx, anchor)) { ok = false; break }
    }
    if (ok) { x = cand; break }
  }
  if (x < 0) return null


  var h = {
    kind: spec.id,
    name: spec.name,
    mount: spec.mount,
    corridor: ci,
    x: x,
    floorY: c.floorY,
    ceilY: c.floorY - CORR_H,
    phase: spec.mech === "field" ? "fire" : "idle",
    t: 0,
    fired: 0,
    lineTo: -1,
    lineY: 0,
    wrecked: false
  }

  // The zone that is lethal while it is firing. Anchored to whatever it hangs
  // from, and never taller than the corridor — a danger that reaches through
  // the floor into the level below is a danger in two places.
  h.zx0 = x
  h.zx1 = x + spec.w - 1
  if (spec.mount === "ceiling") { h.zy0 = c.floorY - CORR_H; h.zy1 = Math.min(c.floorY - 1, h.zy0 + spec.h - 1) }
  else if (spec.mount === "floor") { h.zy1 = c.floorY - 1; h.zy0 = Math.max(c.floorY - CORR_H, h.zy1 - spec.h + 1) }
  else { h.zy1 = c.floorY - 1; h.zy0 = Math.max(c.floorY - CORR_H, h.zy1 - spec.h + 1) }

  return h
}

// Anything alive inside the zone right now.
function hazardCatches(w, h, ag) {
  if (ag.gone || ag.state === "saved") return false
  var ax = Math.floor(ag.x)
  var ay = Math.floor(ag.y)
  // Its feet are at ay and its body reaches AGENT_H-1 above, so a beam across
  // its chest counts even when it is standing below the beam's own row.
  return ax >= h.zx0 && ax <= h.zx1 && ay >= h.zy0 && ay - (AGENT_H - 1) <= h.zy1
}

function hazardWatching(w, h, spec) {
  for (var i = 0; i < w.agents.length; i++) {
    var ag = w.agents[i]
    if (ag.gone || ag.state === "saved") continue
    if (Math.abs(ag.y - h.floorY) > CORR_H) continue
    if (Math.abs(ag.x - (h.zx0 + h.zx1) / 2) <= spec.reach) return true
  }
  return false
}

// Somebody has to be there to learn anything. Knowledge of a danger spreads
// only by being present when it goes off — which is the one and only thing the
// colony knows that it did not read off the terrain in front of its face.
function hazardWitnessed(w, h) {
  for (var i = 0; i < w.agents.length; i++) {
    var ag = w.agents[i]
    if (ag.gone || ag.state === "saved") continue
    if (Math.abs(ag.y - h.floorY) > CORR_H + 4) continue
    if (Math.abs(ag.x - (h.zx0 + h.zx1) / 2) <= 22) return true
  }
  return false
}

// Nothing solid between two points. Walked rather than done properly with a
// Bresenham line — at this grid size the difference is invisible and the loop
// is read far more often than it runs.
function lineClear(w, x0, y0, x1, y1) {
  var steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
  if (steps === 0) return true
  for (var i = 1; i < steps; i++) {
    var t = i / steps
    if (solid(w, Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t))) return false
  }
  return true
}

// The sniper is the one danger that reaches past its own fixture. It picks the
// nearest agent it can actually see — a long way off, but only in a straight
// unobstructed line — holds a sight on it while it winds up, and fires once.
// Then it reloads for five seconds, which is the whole reason it isn't simply
// a corridor nobody may enter: it gets one, and then everyone else has a
// window.
//
// Nearest rather than furthest, because a sight line drawn across half the
// board to somebody behind three other agents reads as a bug.
function sniperAcquire(w, h, spec) {
  var sx = (h.zx0 + h.zx1) / 2
  var sy = (h.zy0 + h.zy1) / 2
  var best = null
  var bestD = Infinity
  for (var i = 0; i < w.agents.length; i++) {
    var ag = w.agents[i]
    if (ag.gone || ag.state === "saved") continue
    var d = Math.abs(ag.x - sx)
    if (d > spec.reach || d < 4) continue
    if (Math.abs(ag.y - sy) > CORR_H) continue
    if (!lineClear(w, Math.round(sx), Math.round(sy), Math.floor(ag.x), Math.floor(ag.y) - 1)) continue
    if (d < bestD) { bestD = d; best = ag }
  }
  return best
}

function sniperTarget(w, h) {
  if (h.targetId === undefined) return null
  for (var i = 0; i < w.agents.length; i++) {
    if (w.agents[i].id === h.targetId) {
      var ag = w.agents[i]
      return (ag.gone || ag.state === "saved") ? null : ag
    }
  }
  return null
}

// Shot to pieces. It stays on the board as wreckage — the colony has to be
// able to see that the thing which was killing them is now scrap — but it never
// fires again and never turns anybody around.
function wreckHazard(w) {
  var h = w.hazard
  if (!h || h.wrecked) return false
  h.wrecked = true
  h.phase = "rest"
  h.lineTo = -1
  addDust(w, (h.zx0 + h.zx1) / 2, (h.zy0 + h.zy1) / 2, 26)
  w.lastEvent = "wrecked"
  return true
}

function hazardMid(h) { return { x: (h.zx0 + h.zx1) / 2, y: (h.zy0 + h.zy1) / 2 } }

function stepHazard(w) {
  var h = w.hazard
  if (!h || h.wrecked) return
  var spec = hazardSpec(h.kind)
  h.t++

  if (spec.mech === "field") {
    hazardStrike(w, h)
    return
  }

  if (spec.mech === "snipe") { stepSniper(w, h, spec); return }

  if (h.phase === "idle") {
    var wake = (spec.mech === "watch") ? hazardWatching(w, h, spec) : h.t >= spec.rest
    if (wake) { h.phase = "charge"; h.t = 0 }

  } else if (h.phase === "charge") {
    // The wind-up is the whole reason a danger is fair. It is drawn, it is
    // long enough to read, and anything with the sense to be somewhere else
    // has that long to get there.
    if (h.t >= spec.charge) {
      h.phase = "fire"
      h.t = 0
      h.fired++
      if (hazardWitnessed(w, h)) w.hazardKnown = true
    }

  } else if (h.phase === "fire") {
    hazardStrike(w, h)
    if (h.t >= spec.fire) { h.phase = "rest"; h.t = 0 }

  } else {
    if (h.t >= spec.rest) { h.phase = "idle"; h.t = 0 }
  }
}

function stepSniper(w, h, spec) {
  var sx = Math.round((h.zx0 + h.zx1) / 2)
  var sy = Math.round((h.zy0 + h.zy1) / 2)

  if (h.phase === "idle") {
    var mark = sniperAcquire(w, h, spec)
    if (!mark) { h.lineTo = -1; return }
    h.targetId = mark.id
    h.phase = "charge"
    h.t = 0

  } else if (h.phase === "charge") {
    var tgt = sniperTarget(w, h)
    // The sight follows while it winds up, and drops if the target gets behind
    // something. Walking out of the line is a real escape, which is what makes
    // a shot from off-screen survivable rather than simply unfair.
    if (!tgt || !lineClear(w, sx, sy, Math.floor(tgt.x), Math.floor(tgt.y) - 1)) {
      h.phase = "idle"; h.t = 0; h.lineTo = -1; h.targetId = undefined
      return
    }
    h.lineTo = tgt.x
    h.lineY = tgt.y - 1
    if (h.t >= spec.charge) {
      h.phase = "fire"
      h.t = 0
      h.fired++
      if (hazardWitnessed(w, h)) w.hazardKnown = true
    }

  } else if (h.phase === "fire") {
    var hit = sniperTarget(w, h)
    if (hit && lineClear(w, sx, sy, Math.floor(hit.x), Math.floor(hit.y) - 1)) {
      h.lineTo = hit.x
      h.lineY = hit.y - 1
      addBlood(w, hit.x, hit.y - 1.5, 16)
      hit.gone = true
      hit.state = "dead"
      w.lost++
      w.hazardKnown = true
      w.hazardKills++
      w.lastEvent = "hazard"
      h.targetId = undefined
    }
    if (h.t >= spec.fire) { h.phase = "rest"; h.t = 0; h.lineTo = -1; h.targetId = undefined }

  } else {
    // Reloading. Long, deliberately: one shot then a window for everybody else.
    if (h.t >= spec.rest) { h.phase = "idle"; h.t = 0 }
  }
}

function hazardStrike(w, h) {
  for (var i = 0; i < w.agents.length; i++) {
    var ag = w.agents[i]
    if (!hazardCatches(w, h, ag)) continue
    addBlood(w, ag.x, ag.y - 1.5, 14)
    ag.gone = true
    ag.state = "dead"
    w.lost++
    w.hazardKnown = true
    w.hazardKills++
    w.lastEvent = "hazard"
  }
}

// Is the next step into somewhere known to be lethal *right now*? Two things
// have to be true, and both matter.
//
// The colony has to have seen the thing work. Before that it is scenery and
// they walk in exactly as confidently as they walk anywhere — somebody has to
// find out, and that first death is the only way anything here is ever learned.
//
// And the danger has to be live. Backing off from something that is resting
// would be backing off forever, and since the response is a blocker and a
// blocker never stands down, that would wall off the route for good. Winding
// up or firing is a reason to be elsewhere; resting is not.
function hazardAhead(w, ag, nx) {
  var h = w.hazard
  if (!h || h.wrecked || !w.hazardKnown) return false
  if (h.phase !== "charge" && h.phase !== "fire") return false
  var ax = Math.floor(nx)
  var footY = Math.floor(ag.y)

  // The sniper's dangerous ground is the sight line, which can be most of a
  // corridor, so what gets avoided is the stretch it is currently covering
  // rather than the box the rifle sits in.
  if (h.kind === "sniper") {
    if (h.lineTo === undefined || h.lineTo < 0) return false
    if (Math.abs(footY - h.zy1) > CORR_H) return false
    var a = Math.min(h.zx0, h.lineTo)
    var b = Math.max(h.zx1, h.lineTo)
    return ax >= a - 1 && ax <= b + 1
  }

  if (footY < h.zy0 - 2 || footY > h.zy1 + 2) return false
  return ax >= h.zx0 - 2 && ax <= h.zx1 + 2
}

// The link down to the next corridor, always carved open — either as a plain
// shaft or as a diagonal ramp, which reads as a continuation of the corridor
// rather than a hole in it.
//
// This used to leave the floor intact most of the time, on the theory that
// working out the way on is *down* is the most satisfying thing the brain
// does. It is — but it's also the least reliable, because it runs on the
// frustration counter and a digger from a shared budget, and when either falls
// short the colony paces a corridor until the level times out. Since it gates
// EVERY descent, one shortfall costs the whole level.
//
// So the descent is a given and the obstacles carry the puzzle instead. The
// improvisation is still there and still unscripted — it just happens where
// failing it costs a detour rather than the level.
//
// The corridor floor STOPS at the handoff and does not resume: everything from
// there to the far wall is open air. That matters more than it looks. A narrow
// shaft with the floor continuing on the other side is, to an agent's senses,
// indistinguishable from an ordinary gap in a floor — same drop, same landing
// at the same height a few cells along — so the ones inclined to bridge a gap
// bridge the descent instead, walk over the only way down, and the level
// stalls with a tidy brick path over the hole. Ending the floor for good
// removes the far side, and with it the ambiguity.
function carveDescent(w, rng, c, next) {
  var x = c.handoffX
  var farX = c.dir > 0 ? c.x1 + 1 : c.x0 - 1

  // Always open. Leaving two in five sealed, so the colony had to work out that
  // the way on was down, sounded like the cure for how much of this is falling
  // and measured out as the opposite: frustration is counted in turnarounds,
  // a corridor is ninety cells long, and a round trip is twenty seconds — so
  // a sealed end bought pacing, not digging, and cost a tenth of all levels.
  if (rng() < 0.6) {
    for (var sx = Math.min(x, farX); sx <= Math.max(x, farX); sx++)
      for (var sy = c.floorY; sy < next.floorY; sy++) clearCell(w, sx, sy)
  } else {
    // A ramp instead of a hole — same effect, but it reads as the corridor
    // sloping away rather than being cut off.
    for (var i = 0; i <= Math.abs(farX - x); i++) {
      var mx = x + c.dir * i
      var top = Math.min(c.floorY + i, next.floorY)
      for (var my = top; my < next.floorY; my++) clearCell(w, mx, my)
    }
  }
}

// A hole with no bottom at the corridor's NEAR end — the short stretch behind
// where agents drop in, on the opposite side from the handoff they're headed
// for. This is the one place a blocker earns its keep.
//
// Everything about the placement is about not standing on the route. Agents
// land facing away from it and walk off toward the handoff, so the only ones
// who ever meet it are those who turned back from an obstacle — and for them
// it is genuinely lethal, being open all the way through the bedrock. The
// first one to reach it stands and turns the rest around, which costs the
// level nothing because the way on was always the other way.
//
// Putting the same hazard on the route was tried and is much worse: a blocker
// at a void the colony has to cross walls off the only way forward, and
// all-home fell from 90% to 65%.
// The one drop on the board with nothing at the bottom of it, which is what the
// blocker rule keys off. It has to be cut through the bedrock to read as
// bottomless — dropDepth() scans real terrain and stops at the first solid cell
// — and that is precisely what made it dangerous to put anywhere but here.
//
// It used to go on a middle corridor. A shaft from corridor one runs through
// corridors two and three on its way to the bedrock, so it punched a hole in
// the floor of every corridor beneath it, at whatever column happened to be
// three cells off the side wall. On level 298 that column was where the last
// corridor starts and where the colony lands: sixteen agents out of sixteen
// walked straight into it on two attempts running, and the level was not
// winnable at all. Anywhere it can be bottomless, it is also underneath
// somewhere the colony has to walk.
//
// So it goes on the last corridor, where there is nothing below to ruin. Its
// near end is dead ground — the exit is at the far end — so a blocker posted
// here still costs the level nothing, which was the whole point of it.
function placeVoid(w, c, prev) {
  var nearX = c.dir > 0 ? c.x0 + 3 : c.x1 - 3
  var landing = prev ? prev.handoffX : (c.dir > 0 ? c.x1 : c.x0)
  if (Math.abs(landing - nearX) < 6) return

  for (var vx = nearX - 1; vx <= nearX + 1; vx++)
    for (var vy = c.floorY; vy < ROWS; vy++) setCell(w, vx, vy, EMPTY)
}

// A steel pillar (a wall no skill touches, so they simply turn back) or a shaft
// with no floor at all, out past the handoff where nothing on the route depends
// on it. Level texture, and the one thing a blocker is for if an agent ever
// does wander out here.
//
// It was worth trying this at the corridor's near end instead — behind where
// agents drop in — on the theory that a hazard nobody reaches is a hazard
// that may as well not exist, and that a blocker posted there would protect
// the stragglers. It reads well and it is much worse: agents land next to
// it, and the ones that turn back from an obstacle walk into it rather than
// past it. All-home levels fell from 269/300 to 195, and the blocker still
// never fired, because an agent that turns around at a void has already
// solved its own problem and doesn't need to stand there. Left where it is.

// ---------------------------------------------------------------------------
// Sensing. Everything the brain knows about the world it learns through these
// — an agent reads the terrain immediately around it and nothing else.
// ---------------------------------------------------------------------------

// How far up the obstruction in front goes, capped: past the cap it may as
// well be infinite as far as any decision is concerned.
function wallHeight(w, x, footY) {
  for (var k = 0; k <= 16; k++)
    if (!solid(w, x, footY - k) && headroom(w, x, footY - k)) return k
  return 99
}

function wallThickness(w, x, footY, dir) {
  var t = 0
  for (var i = 0; i < BASH_REACH + 4; i++) {
    if (!solid(w, x + dir * i, footY)) break
    t++
  }
  return t
}

// Distance straight down to the first solid cell, or Infinity for a shaft
// that runs off the bottom of the world.
function dropDepth(w, x, footY) {
  // Only rows that exist. at() reports everything below the world as STEEL —
  // which is right for walking and digging, and wrong here: it meant a hole cut
  // clean through the bedrock still reported a floor at the bottom of it, so
  // this never once returned Infinity and the blocker rule, which is the only
  // thing that reads it, could never fire in the first place.
  for (var d = 1; footY + d < ROWS; d++) {
    if (solid(w, x, footY + d)) return d - 1
  }
  return Infinity
}

// Is there ground to land on at roughly this height within a bridge's reach?
// Returns the distance, or -1.
function landingAhead(w, x, footY, dir) {
  for (var i = 2; i <= BUILD_REACH; i++) {
    var px = x + dir * i
    for (var dy = -1; dy <= 3; dy++) {
      if (solid(w, px, footY + dy + 1) && !solid(w, px, footY + dy) && headroom(w, px, footY + dy))
        return i
    }
  }
  return -1
}

function anyBlockerNear(w, ag, nx) {
  for (var i = 0; i < w.agents.length; i++) {
    var B = w.agents[i]
    if (B === ag || B.state !== "block" || B.gone) continue
    if (Math.abs(B.y - ag.y) > 3) continue
    var now = Math.abs(ag.x - B.x)
    var next = Math.abs(nx - B.x)
    // A blocker stops agents approaching it; it must not imprison somebody
    // who was already inside the radius when the blocker planted its hands.
    // That agent may move only outward until it has separated. The old
    // absolute-distance test rejected both directions and made it alternate
    // left/right forever in the same pixel.
    if (next < 1.8 && next < now) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Skill budget
// ---------------------------------------------------------------------------

// `w.acting` is whichever agent's decision is being made right now, set by the
// step loop around each agent and by the director around its rescues. It exists
// for one reason: a special agent may not touch the toolbar, and threading that
// through the thirty-odd places a skill gets spent would be thirty-odd chances
// to miss one. One gate, and every route to the budget passes through it.
function take(w, skill) {
  if (w.acting && w.acting.special) return false
  if ((w.skills[skill] || 0) <= 0) return false
  w.skills[skill]--
  w.lastUsed[skill] = w.ticks
  return true
}

// ---------------------------------------------------------------------------
// The brain
//
// Two triggers, both purely local: something is in the way, or the ground
// isn't. Each picks the cheapest tool that actually fits what's being sensed,
// falling through to the next when a skill has run out — which is where the
// improvisation comes from. A level solved with builders on one run gets
// bashed through on another once the bridge budget is gone.
// ---------------------------------------------------------------------------

// What an agent knows that isn't in front of its face: which way home is,
// vertically. That's it — there is no horizontal beacon any more. There used
// to be one, steering them on landing, and dropping it took the last thing
// that could override what an agent could actually see.

// The row an agent standing in the exit's mouth has its feet on. Every
// "is the exit above/below me" test has to use this and not `exit.y`, which is
// the TOP of the doorway five rows higher: measured from there, an agent
// standing on the exit's own floor concludes the exit is above it and starts
// trying to climb. In the last corridor, where that is every agent, they
// climb, fall, walk, climb again, and the level times out with the exit a few
// paces away.
function exitFloor(w) { return w.exit.y + w.exit.h }

function exitBelow(w, ag) { return exitFloor(w) > ag.y + 2 }

// How far this agent still is from home, with height weighted because a
// corridor down is worth more than a corridor along. This is the ONLY thing
// that counts as progress: both the frustration counter and the patience timer
// reset on it and nothing else.
//
// They used to reset on proxies — turning round, changing state — and the
// proxies were wrong in the same way. An agent oscillating between walking,
// climbing a wall it can't top, and falling off it again cleared its patience
// timer on every state change, so the one mechanism meant to rescue a stuck
// agent never fired for the agents that were most stuck.
// Depth is the only thing that counts until they're on the exit's own floor.
//
// Counting horizontal distance everywhere sounds more informative and is
// actively misleading on a serpentine: the exit sits at the bottom of the last,
// leftward corridor, so in the top corridor "closer to the exit" means the left
// wall — the dead end — while the only way down is the far right. Every
// leftward leg of an agent pacing that corridor therefore looked like progress
// and cleared the frustration it had built up, so it never reached the count
// that makes it dig, and a corridor with no open descent simply stalled.
function goalDist(w, ag) {
  var dy = Math.abs(ag.y - exitFloor(w))
  if (dy <= 3) return Math.abs(ag.x - (w.exit.x + w.exit.w / 2))
  return 1000 + dy * 4
}
function exitAbove(w, ag) { return exitFloor(w) < ag.y - 2 }

function hitWall(w, ag) {
  if (ag.special) { specialAtWall(w, ag); return }
  var footY = Math.floor(ag.y)
  var ax = Math.floor(ag.x) + ag.dir
  var mat = at(w, ax, footY)

  // Steel is the one honest "no". Nothing to try, so don't waste a skill on it.
  if (mat === STEEL) { turnAround(w, ag); return }

  var h = wallHeight(w, ax, footY)
  var t = wallThickness(w, ax, footY, ag.dir)
  var trait = traitOf(ag)
  var bashFirst = ag.contrary ? !trait.bashFirst : trait.bashFirst
  // Climbable means: short enough to be worth it, and the top is somewhere
  // inside the level rather than out on the open surface above the earth.
  var climbable = h <= MAX_CLIMB && footY - h >= SKY

  // Over, or through. Both work on a short wall, and which one an agent
  // reaches for first is most of what its personality looks like from outside:
  // the brave and the stubborn put a shoulder into it, everyone else goes
  // round. A tinkerer would rather lay bricks than do either.
  if (trait.bridgeAt <= 3 && h <= 6 && canStartBuild(w, ag) && take(w, "builder")) { startBuild(w, ag); return }

  if (bashFirst) {
    if (t <= BASH_REACH && take(w, "basher")) { ag.state = "bash"; ag.timer = 0; return }
    if (climbable && take(w, "climber")) { startClimb(w, ag); return }
  } else {
    if (climbable && take(w, "climber")) { startClimb(w, ag); return }
    if (t <= BASH_REACH && take(w, "basher")) { ag.state = "bash"; ag.timer = 0; return }
  }

  // Bricks as the last answer to anything a climb could have handled. The
  // threshold used to be lower than the climbable height, which was harmless
  // while climbing was free and is not now: a raised face just past it, met by
  // an agent with no climbers left, had no answer at all and simply turned the
  // whole colony back.
  if (h <= MAX_CLIMB && canStartBuild(w, ag) && take(w, "builder")) { startBuild(w, ag); return }

  // Some of them stop trying. A sentinel beaten by the same wall this many
  // times gives up on getting home and plants itself where it stands, which is
  // a genuine problem for everybody behind it — they now have a wall in front
  // and one of their own colleagues behind, and the only way out of a corridor
  // with both ends shut is down. It is also, unlike every other blocker, a
  // sacrifice nobody asked for.
  if (trait.standDown > 0 && ag.turns >= trait.standDown &&
      countComing(w, ag) >= 1 && take(w, "blocker")) {
    ag.state = "block"
    return
  }

  turnAround(w, ag)
}

function edgeAhead(w, ag, nx) {
  var footY = Math.floor(ag.y)
  var ax = Math.floor(nx)
  var depth = dropDepth(w, ax, footY)
  var far = landingAhead(w, ag.x, footY, ag.dir)

  // Nothing down there at all. This case has to come first: an umbrella is no
  // help over a shaft with no floor, and checking the floater branch ahead of
  // it is exactly how a floater ends up drifting serenely out of the world.
  var trait = traitOf(ag)

  if (ag.special) { specialAtEdge(w, ag, nx, depth, far); return }

  if (depth === Infinity) {
    // Someone should stand here. Worth a blocker while there are still others
    // on their way to walk into it — which is the whole job of the skill.
    if (countComing(w, ag) >= 2 - trait.blockBias && take(w, "blocker")) { ag.state = "block"; return }
    if (far > 2 && canStartBuild(w, ag) && take(w, "builder")) { startBuild(w, ag); return }
    turnAround(w, ag)
    return
  }

  // A gap with the far side in reach is what a builder is for. Where the line
  // sits between "bridge this" and "just step off" is the clearest thing
  // personality does to an agent's behaviour: a cautious one bridges a drop a
  // brave one walks straight off, and you can watch them disagree about the
  // same ledge, one after the other.
  if (far > 2 && depth > trait.bridgeAt + ag.bridgeBias && canStartBuild(w, ag) && take(w, "builder")) { startBuild(w, ag); return }

  // The umbrella comes out early for the ones who like a margin. It can only
  // ever come out EARLIER than the lethal limit, never later — a personality
  // that gets its owner killed isn't a personality, it's a bug.
  // The engineer's whole character. Anyone else facing a drop this deep reaches
  // for the umbrella; it looks for something to build to first, and only takes
  // the chute when there is nothing on the far side worth reaching.
  if (trait.noFloat && far > 2 && canStartBuild(w, ag) && take(w, "builder")) { startBuild(w, ag); return }

  var wantsChute = depth > SAFE_FALL - trait.fallMargin

  if (!wantsChute) { ag.x = nx; startFall(w, ag); return }

  if (take(w, "floater")) {
    ag.floater = true
    ag.x = nx
    startFall(w, ag)
    return
  }

  // Survivable after all, just not comfortably. Better than turning back.
  if (depth <= SAFE_FALL) { ag.x = nx; startFall(w, ag); return }

  // A drop that would kill, and no umbrella left to answer it with. Turning
  // round is enough here — this agent has solved its own problem, and a
  // blocker is not the answer.
  //
  // It used to post one, which was fine while blockers stood down after a
  // while and is not now they're permanent: an edge like this can sit on the
  // route, and a blocker that never moves off one walls the level shut for
  // good. Blockers are for bottomless drops, which the generator only ever
  // puts somewhere nothing depends on.
  turnAround(w, ag)
}

// How many others are still unaccounted for and might yet arrive here. Used
// to decide whether posting a blocker actually protects anybody.
function countComing(w, ag) {
  var n = w.toRelease - w.released
  for (var i = 0; i < w.agents.length; i++) {
    var O = w.agents[i]
    if (O === ag || O.gone || O.state === "saved" || O.state === "block") continue
    n++
  }
  return n
}

// Walking a stretch end to end and back with nothing to show for it. Pacing is
// the signal that horizontal has been exhausted, and the way out of that is
// whichever direction the exit actually lies in.
//
// The downward half of this is the interesting one — it's what makes an agent
// stop at a dead end and start a shaft rather than pace forever. The upward
// half exists because an agent that has dropped into a pit or ridden a shaft
// to the bedrock has the exit ABOVE it, and without this there is no rule in
// the whole brain that ever says "go up": it paces the floor until the level
// times out.
function considerEscape(w, ag) {
  if (ag.turns < traitOf(ag).turnLimit) return false
  var footY = Math.floor(ag.y)
  ag.turns = 0

  if (exitBelow(w, ag)) {
    if (!solid(w, Math.floor(ag.x), footY + 1)) return false
    // Some agents plant a charge instead of sinking a shaft. They turn away
    // immediately, leaving three seconds to get clear of the new opening.
    // Keyed off the agent's own id so it's a settled trait rather than a
    // coin flip, and so both skills actually get used — ordering digger first
    // for everyone meant the miner was a number on the toolbar that never
    // moved, because the digger budget almost never ran out.
    // Tinkerers prefer the planted charge; the id split keeps both downward
    // tools in circulation for everyone else.
    var charge = traitOf(ag).mineFirst === true || ag.id % 2 === 0
    if (charge && take(w, "miner")) { plantMine(w, ag); return true }
    if (take(w, "digger")) { ag.state = "dig"; ag.timer = 0; return true }
    if (take(w, "miner")) { plantMine(w, ag); return true }
    return false
  }

  // Nothing to climb from here, so the only way up is to build one.
  if (canStartBuild(w, ag) && take(w, "builder")) { startBuild(w, ag); return true }
  return false
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

function turnAround(w, ag) {
  ag.dir = -ag.dir
  ag.turns++
  considerEscape(w, ag)
}

function startFall(w, ag) {
  ag.state = "fall"
  ag.fall = 0
}

// A fall nobody chose: the floor bashed out from under an agent, a shaft
// breaking through into open air, a bridge ending over nothing. Unlike
// edgeAhead() there was no chance to look first, so check on the way out and
// get an umbrella open if the landing would otherwise be fatal.
function beginUncontrolledFall(w, ag) {
  if (!ag.floater) {
    var d = dropDepth(w, Math.floor(ag.x), Math.floor(ag.y))
    if (d > SAFE_FALL && take(w, "floater")) ag.floater = true
  }
  startFall(w, ag)
}

function startClimb(w, ag) {
  ag.state = "climb"
  ag.timer = 0
}

function startBuild(w, ag) {
  ag.state = "build"
  ag.bricks = 12
  ag.buildWait = 0
  ag.timer = 0
  ag.built++
  w.buildSites.push({ x: ag.x, y: ag.y, tick: w.ticks })
}

// An agent that has already laid two bridges has stopped solving anything and
// started building on its own brickwork: every bridge leaves a new ledge and a
// new wall, which reads to the next decision as another obstacle worth
// bridging. Left uncapped, the keen ones spend a whole level constructing a
// private folly, and the earth they add is what the ones behind them then get
// stuck on.
function willBuild(ag) { return ag.built < traitOf(ag).buildCap }

// Let one builder finish (or visibly fail) before another edits the same
// ledge. This is intentionally short-lived shared evidence, not a route plan:
// after eight seconds the colony is free to disagree and try the site again.
// Without it, a queue can spend a dozen builders on the same few cells before
// the first bridge has even settled into terrain.
function canStartBuild(w, ag) {
  if (!willBuild(ag)) return false
  for (var i = w.buildSites.length - 1; i >= 0; i--) {
    var site = w.buildSites[i]
    if (w.ticks - site.tick > 240) break
    if (Math.abs(site.y - ag.y) < 4 && Math.abs(site.x - ag.x) < 8) return false
  }
  return true
}

function spawn(w) {
  // Drawn from the world's own stream so a given level always sends the same
  // agents out in the same order — level 42 has the same stubborn one at the
  // same point in the queue every time you come back to it.
  var trait = TRAIT_POOL[Math.floor(w.traitRng() * TRAIT_POOL.length) % TRAIT_POOL.length]
  var whim = w.traitRng()
  return {
    id: w.nextId++,
    trait: trait,
    // Individual variation inside the personality, so two cautious agents
    // aren't the same agent twice. Shifts where its bridge-or-jump line
    // sits, and one in five reverses its instinct at a wall outright.
    bridgeBias: Math.round(whim * 5) - 2,
    contrary: whim < 0.2,
    x: w.hatch.x + 0.5,
    y: w.hatch.y + AGENT_H,
    // Facing the way the first corridor runs. Levels mirror now, so a fixed
    // facing sent half of every colony marching at the nearest wall.
    dir: w.startDir,
    state: "fall",
    // Not a flag an agent keeps. `floater` means "umbrella is out for THIS
    // fall" and is folded away on landing; there is no climber flag at all,
    // because every climb is paid for when it happens.
    floater: false,
    fall: 0,
    timer: 0,
    bricks: 0,
    built: 0,          // bridges laid; see willBuild()
    turns: 0,
    idle: 0,           // ticks since it last got closer to home
    // At most one of these exists at a time, and it is barred from the toolbar
    // for its whole life; see SPECIALS.
    special: (w.special && w.released === w.specialAt) ? w.special : null,
    passes: {},        // cells re-tread since then; see countPass()
    bucket: "",
    condemned: false,
    cool: 0,          // ticks before a special may use its move again
    cell: "",         // last integer cell, for the stuck-on-the-spot check
    still: 0,
    jvy: 0,
    ceilX: 0,
    ceilTo: 0,
    shotTo: 0,        // where a camped sniper's last shot went, for the tracer
    shotY: 0,
    shotFor: 0,
    escapeFloors: {},  // a special may cut one rescue shaft per corridor
    escapeTunnels: {}, // and one body-height rescue tunnel per corridor
    rescueCool: 0,     // do not reconsider the same escape every simulation tick
    markD: Infinity,   // closest it has ever been; see goalDist()
    fuse: 0,
    anim: Math.floor(Math.random() * 8),
    gone: false,
    fade: 0
  }
}

// ---------------------------------------------------------------------------
// Per-state updates
// ---------------------------------------------------------------------------

function stepWalk(w, ag) {
  var nx = ag.x + ag.dir * WALK_SPEED
  var cx = Math.floor(nx)
  var footY = Math.floor(ag.y)

  if (anyBlockerNear(w, ag, nx)) { turnAround(w, ag); return }

  // Somewhere it has learned is lethal. Treated exactly like a drop with no
  // bottom, because to an agent it is the same problem: a place ahead that
  // ends you, and others behind you walking towards it. The first one to
  // arrive stands and turns the rest around, and it costs the level nothing,
  // because a danger is only ever put on ground the route does not need.
  //
  // Before anyone has seen the thing fire this is all inert and they walk in
  // as confidently as they walk anywhere. Somebody has to find out.
  if (hazardAhead(w, ag, nx)) {
    var htrait = traitOf(ag)
    // A timed hazard may consume several blockers as each sacrifice is
    // eventually killed. Keep the final one for a true bottomless edge, where
    // a single permanent blocker protects everyone who follows. Level 92's
    // bear trap used to empty the toolbar just before its last-floor void.
    if ((w.skills.blocker || 0) > 1
        && countComing(w, ag) >= 2 - htrait.blockBias
        && take(w, "blocker")) { ag.state = "block"; return }
    turnAround(w, ag)
    return
  }

  var targetY = footY

  if (solid(w, cx, footY)) {
    // Ground rising. A stride covers MAX_STEP; anything taller is an obstacle.
    var k = 1
    while (k <= MAX_STEP && solid(w, cx, footY - k)) k++
    if (k > MAX_STEP || !headroom(w, cx, footY - k)) { hitWall(w, ag); return }
    targetY = footY - k
  } else if (!solid(w, cx, footY + 1)) {
    // Ground falling away. One cell is a step down; more is a fall, and a fall
    // is a decision.
    if (solid(w, cx, footY + 2)) targetY = footY + 1
    else { edgeAhead(w, ag, nx); return }
  }

  if (!headroom(w, cx, targetY)) { hitWall(w, ag); return }

  ag.x = nx
  ag.y = targetY
  ag.anim++
}

function stepFall(w, ag) {
  var speed = ag.floater && ag.fall > 2 ? FLOAT_SPEED : FALL_SPEED
  var cx = Math.floor(ag.x)
  var ny = ag.y + speed

  // Out through the bottom of the world. Has to be caught before the landing
  // scan below, which would otherwise find the out-of-bounds STEEL that at()
  // reports and land them on nothing.
  if (ny >= ROWS) {
    ag.gone = true
    w.lost++
    w.lastEvent = "fell"
    return
  }

  // Last-moment umbrella. A drop that was measured as survivable at the edge
  // can stop being survivable while an agent is still in the air — the floor
  // it was aiming at gets dug out from underneath by somebody else working
  // below. Re-checking on the way down catches every version of that without
  // having to anticipate each one, and a late umbrella is a better thing to
  // watch than a splat anyway.
  // The test has to be on the drop that's LEFT, not just on there being no
  // floor in the very next cell: an ordinary corridor-to-corridor drop passes
  // that weaker test a cell or two before landing, which had every agent in
  // the level opening an umbrella on a fall they were always going to walk
  // away from.
  if (!ag.floater && ag.fall > SAFE_FALL - 6) {
    var remaining = dropDepth(w, cx, Math.floor(ny))
    if (ag.fall + remaining > SAFE_FALL && take(w, "floater")) ag.floater = true
  }

  for (var yy = Math.floor(ag.y) + 1; yy <= Math.floor(ny) + 1; yy++) {
    if (solid(w, cx, yy)) {
      ag.y = yy - 1
      if (ag.fall > SAFE_FALL && !ag.floater) { splat(w, ag); return }
      ag.state = "walk"
      ag.fall = 0
      ag.floater = false
      // Landing does NOT turn an agent round. It keeps whatever way it was
      // facing, as in the original — an agent only ever turns at a wall, at a
      // blocker, or at an edge it won't step off.
      //
      // Picking a direction here instead (toward the exit, or away from the
      // nearest wall) routed them through the serpentine very tidily and was
      // wrong twice over. It reads as bizarre — the whole colony pirouetting
      // on landing — and it closes a loop: a climber that bumps a ceiling
      // turns away and drops, and if landing then points it back at the wall
      // it just failed to climb, it climbs it again, forever. That was every
      // agent found pinned in a six-cell box cycling walk-climb-fall.
      //
      // The serpentine still works without it. An agent stepping off the end
      // of one corridor lands near the start of the next still facing the way
      // it was going, walks the short way to that end, and turns at the wall
      // like anything else.
      return
    }
  }
  ag.fall += speed
  ag.y = ny
}

function stepClimb(w, ag) {
  var wallX = Math.floor(ag.x) + ag.dir
  var footY = Math.floor(ag.y)

  // Head into a ceiling: nothing above to climb onto, so let go. Counts as a
  // failed attempt — an agent that keeps trying the same wall should end up
  // concluding the way on is somewhere else.
  if (solid(w, Math.floor(ag.x), footY - AGENT_H)) {
    ag.dir = -ag.dir
    ag.turns++
    beginUncontrolledFall(w, ag)
    return
  }

  if (!solid(w, wallX, footY)) {
    // Feet clear the wall's top course — haul over onto it.
    if (headroom(w, wallX, footY)) {
      ag.x = wallX + 0.5
      ag.state = "walk"
      ag.turns = 0
    } else {
      ag.dir = -ag.dir
      beginUncontrolledFall(w, ag)
    }
    return
  }

  ag.y -= CLIMB_SPEED
  ag.anim++
  if (ag.y < 1) { ag.dir = -ag.dir; startFall(w, ag) }
}

function stepBuild(w, ag) {
  ag.timer++
  if (ag.timer < BUILD_INTERVAL) return
  ag.timer = 0

  var footY = Math.floor(ag.y)
  var bx = Math.floor(ag.x) + ag.dir

  // Wait for traffic to clear instead of laying a bridge through somebody's
  // body. This is not theoretical: sloping and crossing bridges put the
  // builder's floor row through the head or feet of agents on the path below.
  // Give them three seconds to move; if they do not, abandon this bridge so
  // two opposing builders cannot wait on each other forever.
  var cells = []
  for (var oi = 0; oi < 3; oi++) cells.push({ x: bx + ag.dir * oi, y: footY + 1 })
  if (!makeBuildRoom(w, cells, ag)) {
    ag.buildWait++
    if (ag.buildWait >= 15) {
      ag.dir = -ag.dir
      ag.state = "walk"
      ag.turns++
    }
    return
  }
  ag.buildWait = 0

  var nx = ag.x + ag.dir * 2

  // Gain a course every third brick, and only when there's headroom for it —
  // otherwise keep laying level. The original's builders climb a course per
  // brick, which is fine on an open hillside and useless in a corridor with two
  // cells of clearance over an agent's head: the bridge hits the ceiling after
  // three bricks, the builder turns round, and the gap it was called for is
  // still there. Sloping where it can and running flat where it can't gets the
  // staircase look wherever there's room for one, and a bridge everywhere else.
  var ny = ag.y
  if ((ag.bricks % 3) === 0 && headroom(w, Math.floor(nx), Math.floor(ag.y) - 1)) ny = ag.y - 1

  if (!headroom(w, Math.floor(nx), Math.floor(ny))) {
    // Even level is blocked. Check this BEFORE laying anything: the old order
    // left a three-cell stub from a step the builder could never occupy, and a
    // queue of agents repeated it into the little brick heaps seen on level 19.
    ag.dir = -ag.dir
    ag.state = "walk"
    return
  }

  // A brick is three cells laid at foot level; the agent then steps along it.
  for (var i = 0; i < 3; i++) setCell(w, bx + ag.dir * i, footY + 1, DIRT)

  ag.x = nx
  ag.y = ny
  ag.bricks--
  addDust(w, ag.x, ag.y, 1)

  if (ag.bricks <= 0) {
    ag.state = "walk"
    ag.turns = 0
  }
}

function stepBash(w, ag) {
  ag.timer++
  if (ag.timer < BASH_INTERVAL) return
  ag.timer = 0

  var footY = Math.floor(ag.y)
  var ax = Math.floor(ag.x) + ag.dir

  if (hitsSteel(w, Math.min(ax, ax + ag.dir), footY - AGENT_H, Math.max(ax, ax + ag.dir), footY)) {
    // Order matters: turnAround() may itself pick a new action (see
    // considerEscape), so the reset to walking has to happen first or it
    // silently throws away the skill that was just spent.
    ag.state = "walk"
    turnAround(w, ag)
    return
  }

  var removed = 0
  for (var dx = 0; dx < 2; dx++)
    for (var dy = -AGENT_H; dy <= 0; dy++)
      if (clearCell(w, ax + ag.dir * dx, footY + dy)) removed++

  addDust(w, ax, footY - 2, 3)
  ag.x += ag.dir
  ag.anim++

  // Broken through into open air: stop chewing and walk.
  if (removed === 0 && !solid(w, ax + ag.dir * 2, footY)) {
    ag.state = "walk"
    ag.turns = 0
  }
  // Bashed the floor out from under itself.
  if (!solid(w, Math.floor(ag.x), footY + 1)) beginUncontrolledFall(w, ag)
}

function plantMine(w, ag) {
  var cx = Math.floor(ag.x)
  var cy = Math.floor(ag.y) + 1
  w.mines.push({ x: cx, y: cy, fuse: MINE_FUSE })
  w.lastUsed.miner = w.ticks
  w.lastEvent = "mine planted"
  ag.state = "walk"
  ag.timer = 0
  ag.idle = 0
  ag.turns = 0
  ag.dir = -ag.dir
}

function stepMines(w) {
  for (var i = w.mines.length - 1; i >= 0; i--) {
    var mine = w.mines[i]
    mine.fuse--

    // A charge sitting on ground that gets removed drops down the hole. It is
    // still armed on the way, which is the entertaining part.
    while (!solid(w, mine.x, mine.y + 1) && mine.y < ROWS - 1) mine.y++
    if (mine.y >= ROWS - 1) { w.mines.splice(i, 1); continue }

    if (mine.fuse > 0) continue
    for (var dy = -MINE_RADIUS; dy <= MINE_RADIUS; dy++)
      for (var dx = -MINE_RADIUS; dx <= MINE_RADIUS; dx++)
        if (dx * dx + dy * dy <= MINE_RADIUS * MINE_RADIUS)
          clearCell(w, mine.x + dx, mine.y + dy)
    addDust(w, mine.x, mine.y, 28)
    w.mines.splice(i, 1)
    w.lastEvent = "mine boom"
  }
}

function stepDig(w, ag) {
  ag.timer++
  if (ag.timer < DIG_INTERVAL) return
  ag.timer = 0

  var footY = Math.floor(ag.y)
  var cx = Math.floor(ag.x)

  if (hitsSteel(w, cx - 1, footY + 1, cx + 1, footY + 1)) {
    ag.state = "walk"
    turnAround(w, ag)
    return
  }

  for (var dx = -1; dx <= 1; dx++) clearCell(w, cx + dx, footY + 1)
  addDust(w, cx, footY + 1, 3)
  ag.y += 1
  ag.anim++

  // Stop on reaching the exit's own level. Starting a shaft because the exit
  // is below you is right; carrying on once you're level with it is how a
  // agent ends up on the bedrock under the room it was digging towards, and
  // the ones who follow it down the shaft end up there too.
  if (!exitBelow(w, ag)) { ag.state = "walk"; return }

  if (!solid(w, cx, Math.floor(ag.y) + 1)) beginUncontrolledFall(w, ag)
}

// Nothing under it. Anything that has planted itself — a blocker, a camped
// sniper, an agent with a lit fuse — is still subject to the floor being taken
// out from underneath it, usually by somebody else's explosion. Standing still
// is a decision about walking, not a suspension of gravity.
function unsupported(w, ag) {
  return !solid(w, Math.floor(ag.x), Math.floor(ag.y) + 1)
}

function stepBlock(w, ag) {
  // A blocker with nothing under it stops blocking — the ground it was holding
  // has been dug out from beneath, usually by whoever it turned back.
  if (unsupported(w, ag)) { beginUncontrolledFall(w, ag); return }
  ag.anim++

  // It does not stand down, ever. A blocker is an agent that has given up
  // going home so the ones behind it don't walk into a hole, and letting it
  // wander off after a decent interval — which is what this used to do — takes
  // the cost out of the only skill whose whole point is the cost.
}

function stepBomb(w, ag) {
  ag.fuse--

  // Falling with the fuse still burning. It keeps counting on the way down and
  // goes off wherever it lands, or in the air if it runs out first — which is
  // the honest outcome and a much better one to watch than a bomb hanging in
  // the space its floor used to occupy.
  if (unsupported(w, ag)) {
    ag.fall += FALL_SPEED
    var ny = ag.y + FALL_SPEED
    if (Math.floor(ny) >= ROWS - 1) { ag.gone = true; w.lost++; return }
    ag.y = ny
  } else {
    ag.fall = 0
  }

  if (ag.fuse > 0) return

  var cx = Math.floor(ag.x)
  var cy = Math.floor(ag.y) - 1
  for (var dy = -BOMB_RADIUS; dy <= BOMB_RADIUS; dy++)
    for (var dx = -BOMB_RADIUS; dx <= BOMB_RADIUS; dx++)
      if (dx * dx + dy * dy <= BOMB_RADIUS * BOMB_RADIUS) clearCell(w, cx + dx, cy + dy)

  addDust(w, ag.x, ag.y - 1, 22)
  ag.gone = true
  w.lost++
  w.lastEvent = "boom"
}

function splat(w, ag) {
  ag.gone = true
  w.lost++
  addDust(w, ag.x, ag.y, 10)
  w.lastEvent = "splat"
}

// ---------------------------------------------------------------------------
// Particles — dust from every stroke of every tool. Purely decorative, capped
// so a level-wide bomb can't leave a thousand of them on the heap.
// ---------------------------------------------------------------------------

// Blood. Thrown harder and lasting longer than dust, and the one thing on the
// board besides the agents themselves that never takes the theme — the same
// reasoning as the green hair: it has to read as what it is at four pixels.
function addBlood(w, x, y, n) {
  for (var i = 0; i < n; i++) {
    if (w.particles.length > 180) return
    w.particles.push({
      x: x + (Math.random() - 0.5) * 1.2,
      y: y + (Math.random() - 0.5) * 1.2,
      vx: (Math.random() - 0.5) * 0.62,
      vy: -Math.random() * 0.45,
      life: 34 + Math.random() * 40,
      blood: true
    })
  }
}

function addDust(w, x, y, n) {
  for (var i = 0; i < n; i++) {
    if (w.particles.length > 140) return
    w.particles.push({
      x: x + (Math.random() - 0.5) * 1.5,
      y: y + (Math.random() - 0.5) * 1.5,
      vx: (Math.random() - 0.5) * 0.22,
      vy: -Math.random() * 0.16,
      life: 12 + Math.random() * 22
    })
  }
}

// A special doing its one trick. The wind-up is deliberate and a little longer
// than a bash stroke: these are supposed to be worth stopping to watch, and an
// instant hole would read as the level glitching rather than as somebody doing
// something.
var TRICK_WINDUP = 14

// What a special does when something is in the way. It never consults the
// toolbar — take() would refuse it anyway — so this is the entire decision.
// Four of them just do an ordinary skill with no meter on it; the rest go to
// the trick state and cut a shape out of whatever is there.
// The sniper's whole game. It picks a spot, stays there for the rest of the
// level, and works at range: the danger first if it can see one, and otherwise
// a few cells taken out of whatever is in front of everybody else.
//
// It does not go home, and it is not pretending it might. That is the trade —
// unlimited range and the only reliable answer to a danger, in exchange for the
// one agent on the board that was never going to be counted.
// Can it see the level's danger from where it is standing?
function sightsHazard(w, ag) {
  var h = w.hazard
  if (!h || h.wrecked) return false
  var fy = Math.floor(ag.y)
  var hm = hazardMid(h)
  if (Math.abs(hm.y - fy) > CORR_H + 2) return false
  return lineClear(w, Math.floor(ag.x), fy - 2, Math.round(hm.x), Math.round(hm.y))
}

// Is the danger in front of it, within range?
function hazardIsAhead(w, ag, reach) {
  var h = w.hazard
  if (!h || h.wrecked) return false
  var ahead = (hazardMid(h).x - ag.x) * ag.dir
  return ahead > 0 && ahead <= reach
}

function stepCamp(w, ag) {
  // Shot out from under. It comes down, and picks a new position from wherever
  // it lands rather than hanging in the air where the deck used to be.
  if (unsupported(w, ag)) { beginUncontrolledFall(w, ag); return }

  if (ag.cool > 0) return
  var spec = specOf(ag)
  var fx = Math.floor(ag.x)
  var fy = Math.floor(ag.y)

  // The danger, at any distance, provided the line is clear.
  var h = w.hazard
  if (h && !h.wrecked) {
    var hm = hazardMid(h)
    if (Math.abs(hm.y - fy) <= CORR_H + 2 &&
        lineClear(w, fx, fy - 2, Math.round(hm.x), Math.round(hm.y))) {
      ag.dir = hm.x >= ag.x ? 1 : -1
      ag.shotTo = hm.x
      ag.shotY = hm.y
      ag.shotFor = 12
      wreckHazard(w)
      ag.cool = spec.cool
      return
    }
  }

  // Otherwise it shoots the first thing in the way, at whatever range that
  // turns out to be, and takes a couple of cells out of it.
  //
  // It must NOT require a clear line to what it is shooting: it camps because
  // it met a wall, so there is a wall directly in front of it, and demanding an
  // unobstructed line meant it could never fire at anything ever — not the
  // blocks, and not the danger behind them either. Shooting the near face is
  // the point, and it is also what eventually opens the line to something
  // further off.
  for (var r = 2; r <= 34; r++) {
    var tx = fx + ag.dir * r
    if (at(w, tx, fy - 2) === STEEL) break
    if (!workable(w, tx, fy - 2) && !workable(w, tx, fy - 1)) continue
    var cut = false
    for (var j = -AGENT_H + 1; j <= 0; j++)
      if (clearCell(w, tx, fy + j)) cut = true
    if (cut) {
      w.terrainVersion++
      addDust(w, tx, fy - 2, 6)
      ag.shotTo = tx
      ag.shotY = fy - 2
      ag.shotFor = 8
      ag.cool = spec.cool
      return
    }
  }

  // Nothing in that direction worth a bullet. Face the other way and wait.
  ag.dir = -ag.dir
  ag.cool = Math.round(spec.cool / 2)
}

function specialAtWall(w, ag) {
  var spec = specOf(ag)

  // Digs in where it stands and stays there.
  if (spec.act === "camp") {
    ag.state = "camp"
    ag.cool = 0
    return
  }

  // Cooling down. It turns at the wall like anybody else and comes back to it,
  // which is the entire point of the cooldown: the move is something you wait
  // for rather than something it does every half second.
  if (ag.cool > 0) { turnAround(w, ag); return }

  if (spec.act === "ceiling") { startCeiling(w, ag); return }

  // Drilling downward is only ever the answer when down is where home is.
  if (spec.act === "stomp" && !exitBelow(w, ag)) { turnAround(w, ag); return }

  // Ask first. A block too big to shift, a column too short to topple, a wall
  // with nothing but steel behind it — it turns and tries somewhere else
  // rather than winding up and whiffing.
  if (!specialCut(w, ag, spec.act, true)) {
    ag.cool = Math.round(spec.cool / 3)
    turnAround(w, ag)
    return
  }

  ag.state = "trick"
  ag.timer = 0
}

// Up the wall and onto the roof — but only if the roof goes somewhere. It went
// up at any wall at all before, which is how you get something that appears to
// be on the ceiling for its own entertainment. Now it wants a run of ceiling
// ahead of it: the point of being up there is to cross a thing, so if the roof
// stops before the obstacle does, there is no point leaving the floor.
function startCeiling(w, ag) {
  var fx = Math.floor(ag.x)
  for (var cy = Math.floor(ag.y) - AGENT_H; cy > SKY; cy--) {
    if (!solid(w, fx, cy)) continue

    // Room to hang from it.
    var room = true
    for (var b = 1; b <= AGENT_H; b++) if (solid(w, fx, cy + b)) { room = false; break }
    if (!room) return turnAround(w, ag)

    // And somewhere to go along it. Five cells of continuous ceiling with
    // clear air beneath, which is the shortest crossing worth the climb.
    var run = 0
    for (var q = 1; q <= 10; q++) {
      var qx = fx + ag.dir * q
      if (!solid(w, qx, cy)) break
      if (solid(w, qx, cy + 1)) break
      run++
    }
    if (run < 5) return turnAround(w, ag)

    // Where it intends to come down: the first place ahead, at the height it
    // set off from, that is actually standable. That is the far side of
    // whatever it went up to cross.
    //
    // Coming down after a fixed few cells instead — which is what the first
    // attempt did — meant it dropped straight back onto the near side of the
    // obstacle and was up there for under a second. Aiming at a landing is the
    // difference between crossing something and popping up for a look.
    var fy = Math.floor(ag.y)
    ag.ceilTo = fx + ag.dir * 14
    for (var t2 = 3; t2 <= 22; t2++) {
      var tx = fx + ag.dir * t2
      if (solid(w, tx, fy + 1) && !solid(w, tx, fy) && !solid(w, tx, fy - 1)) { ag.ceilTo = tx; break }
    }

    ag.y = cy + 1
    ag.state = "ceil"
    ag.timer = 0
    ag.ceilX = ag.x
    ag.cool = specOf(ag).cool
    return
  }
  turnAround(w, ag)
}

// Walking upside down. The roof is the floor: it holds on as long as there is
// something solid directly above, turns at anything solid in front, and drops
// the moment the ceiling runs out from under — which is usually the point,
// because the ceiling runs out over the far side of whatever stopped it.
// How long it can hang on. Without a limit a long ceiling is somewhere to pace
// for a minute and a half, which is what the longest run measured before this.
var CEILING_GRIP = 260

function stepCeiling(w, ag) {
  var nx = ag.x + ag.dir * WALK_SPEED
  var cx = Math.floor(nx)
  var y = Math.floor(ag.y)

  ag.timer++
  if (ag.timer > CEILING_GRIP) {
    ag.y = y + AGENT_H - 1
    beginUncontrolledFall(w, ag)
    return
  }

  if (!solid(w, cx, y - 1)) {
    // Roof gone. Let go, and fall from where its feet actually are.
    ag.y = y + AGENT_H - 1
    beginUncontrolledFall(w, ag)
    return
  }
  for (var b = 0; b < AGENT_H; b++) {
    if (solid(w, cx, y + b)) { turnAround(w, ag); return }
  }

  // Over the landing it set off for, with ground under it: down.
  var arrived = ag.dir > 0 ? ag.x >= ag.ceilTo : ag.x <= ag.ceilTo
  if (arrived) {
    for (var d2 = AGENT_H; d2 <= AGENT_H + SAFE_FALL; d2++) {
      if (!solid(w, cx, y + d2)) continue
      ag.y = y + AGENT_H - 1
      beginUncontrolledFall(w, ag)
      return
    }
  }

  ag.x = nx
  ag.anim++
}

// And at a drop. The passives do most of the work here: one of them is immune
// to landing, one always has the umbrella, and the builders lay their own way
// across. Anything else takes a survivable drop and turns back from a lethal
// one, exactly like everybody else.
function specialAtEdge(w, ag, nx, depth, far) {
  var spec = specOf(ag)

  // The crossing it is actually for. A gap with a roof over it is exactly what
  // walking upside down solves, and going over one is a great deal more useful
  // than turning round at it.
  if (spec.act === "ceiling" && ag.cool <= 0 && depth > SAFE_FALL) {
    var before = ag.state
    startCeiling(w, ag)
    if (ag.state === "ceil") return
    ag.state = before
  }

  if (spec.act === "slab" && ag.cool <= 0 && depth > 2) {
    if (specialCut(w, ag, "slab")) { ag.cool = spec.cool; return }
  }
  // A hole with no bottom is the one thing neither toughness nor an umbrella
  // answers — the anvil takes any landing there is, and a drop with nothing to
  // land on has none. Checked before both, because getting this order wrong is
  // how the two hardiest specials on the board were walking off the world.
  if (depth === Infinity) { turnAround(w, ag); return }

  if (depth <= SAFE_FALL) { ag.x = nx; startFall(w, ag); return }
  turnAround(w, ag)
}

// A special that has got nowhere for a while digs itself out, whatever its
// trick is. Every trick but two cuts sideways, so a special boxed into a pocket
// with the way on underneath it could fire into the same steel wall until the
// level timed out — which is what the first version did, and why two thirds of
// them ended up condemned rather than home.
//
// This must use the ordinary dig state rather than clearing a pocket here. An
// instant 3x5 cut leaves the special standing on the lip of the hole it just
// made; on its next step it quite correctly reads that shaft as a dangerous
// drop, turns away, and eventually cuts another one. That was the specials'
// characteristic failure: they escaped nothing and honeycombed the corridor.
// A digger travels down with its cut and stops on the exit's floor, so the hole
// is a route rather than another obstacle.
//
// The trick stays for walls, which is where its character is. This is the
// shovel every one of them keeps for when the wall was never the problem.
function specialEscape(w, ag) {
  var fx = Math.floor(ag.x)
  var fy = Math.floor(ag.y)
  var floor = Math.floor((fy + 1) / (w.corrGap || CORR_GAP))
  if (exitBelow(w, ag) && solid(w, fx, fy + 1)
      && at(w, fx, fy + 1) !== STEEL && !ag.escapeFloors[floor]) {
    ag.escapeFloors[floor] = true
    ag.state = "dig"
    ag.timer = 0
    // Deliberately does NOT reset the patience counter. Digging is not progress
    // — getting closer to home is — and zeroing it here meant a special that
    // dug, fell, walked, got stuck and dug again never accumulated any idle
    // time at all, so it never reached the point of being written off. It could
    // loop like that for the whole level, which is the one agent on the board
    // you would definitely notice doing it.
    ag.still = 0
  } else if (!ag.escapeTunnels[floor]) {
    // Same floor as home, or below it, and boxed into a pocket: digging is the
    // wrong axis. Cut one plain body-height escape through the thinner side.
    // This is intentionally not the special's signature shape; repeating the
    // shape that made the pocket (notably Melt's disc) only remodels the same
    // cell. The cut never reaches below the feet, so it cannot make a new pit.
    // Count the whole body-height tunnel, not just the cell beside its feet.
    // Melt's level-1 pocket was open at ankle height and blocked at the head,
    // so a foot-only test declared both exits clear while stepWalk quite
    // correctly refused both of them.
    var left = 0, right = 0
    for (var ex = 1; ex <= 8; ex++)
      for (var ey = -AGENT_H; ey <= 0; ey++) {
        if (workable(w, fx - ex, fy + ey)) left++
        if (workable(w, fx + ex, fy + ey)) right++
      }
    var canLeft = left > 0
    var canRight = right > 0
    var dir = left <= right ? -1 : 1
    if (!canLeft && canRight) dir = 1
    if (!canRight && canLeft) dir = -1
    if (canLeft || canRight) {
      ag.dir = dir
      ag.escapeTunnels[floor] = true
      specialCut(w, ag, "blast")
      ag.still = 0
      return
    }
    specialAtWall(w, ag)
  } else {
    specialAtWall(w, ag)
  }
}

// Can it hop onto something from here? Only worth trying if there is a floor
// to land on within the hop's reach and headroom over it.
function canJump(w, ag) {
  var fx = Math.floor(ag.x)
  var fy = Math.floor(ag.y)
  var d = ag.dir
  for (var up = 1; up <= JUMP_UP; up++) {
    var ly = fy - up
    if (solid(w, fx + d, ly) || solid(w, fx + d * 2, ly)) continue
    if (!solid(w, fx + d * 2, ly + 1)) continue      // nothing to land on
    if (!headroom(w, fx + d * 2, ly)) continue
    return true
  }
  return false
}

function startJump(w, ag) {
  ag.state = "jump"
  ag.jvy = JUMP_RISE
  ag.timer = 0
  ag.still = 0
}

function stepJump(w, ag) {
  ag.timer++
  ag.jvy += JUMP_GRAV
  var ny = ag.y + ag.jvy
  var nx = ag.x + ag.dir * WALK_SPEED * 0.9
  var cx = Math.floor(nx)

  // Head into a ceiling: stop rising, but keep going forward.
  if (ag.jvy < 0 && solid(w, cx, Math.floor(ny) - AGENT_H)) { ag.jvy = 0; ny = ag.y }

  if (!solid(w, cx, Math.floor(ny))) ag.x = nx

  if (ag.jvy > 0) {
    var fy2 = Math.floor(ny)
    if (solid(w, Math.floor(ag.x), fy2 + 1)) {
      ag.y = fy2
      ag.state = "walk"
      ag.fall = 0
      ag.anim++
      return
    }
    // Coming down with nothing under it: this is a fall now, and falls can
    // kill, which is the only thing keeping the hop honest.
    if (ag.timer > 10) { ag.y = ny; beginUncontrolledFall(w, ag); return }
  }
  ag.y = ny
  ag.anim++
}

function stepTrick(w, ag) {
  ag.timer++
  if (ag.timer < TRICK_WINDUP) return
  ag.timer = 0

  var spec = specOf(ag)
  var cut = specialCut(w, ag, spec.act)
  ag.state = "walk"

  // The cooldown runs whether or not anything moved. Charging it only on
  // success left a special that was swinging at steel free to swing again
  // immediately, which is how the Piledriver managed eighty-five moves in a
  // level that should allow about a dozen — the cooldown was real and it was
  // simply never reached.
  ag.cool = cut ? spec.cool : Math.round(spec.cool / 2)

  // Nothing shifted, so whatever is in the way is steel and always will be.
  // Turning is the only honest answer.
  if (!cut) turnAround(w, ag)
}

function stepParticles(w) {
  for (var i = w.particles.length - 1; i >= 0; i--) {
    var p = w.particles[i]
    p.x += p.vx
    p.y += p.vy
    p.vy += 0.016
    p.life--
    if (p.life <= 0) w.particles.splice(i, 1)
  }
}

// ---------------------------------------------------------------------------
// The director
//
// The brain is local by design, which means it can occasionally paint itself
// into a corner — every agent pacing a sealed pocket, or the one skill that
// would open the way already spent. Rather than let the level sit there, the
// director watches for a stretch with no saves, no losses, and no terrain
// moved, then quietly tops up whichever skill the stuck agent could actually
// use. It's the invisible hand that keeps this something to relax to.
// ---------------------------------------------------------------------------

// One extra of `skill`, handed over and spent in the same breath. Adding to
// the budget without also taking from it leaves the toolbar counting UP every
// time the director steps in, and the skill never registers as used at all.
// Walled in on both sides by something no tool touches, with no floor worth
// digging. The only honest use for a bomb.
function boxedIn(w, ag) {
  var footY = Math.floor(ag.y)
  var cx = Math.floor(ag.x)
  var leftHard = at(w, cx - 1, footY) === STEEL || at(w, cx - 2, footY) === STEEL
  var rightHard = at(w, cx + 1, footY) === STEEL || at(w, cx + 2, footY) === STEEL
  return leftHard && rightHard
}

// The director takes from the same budget as everyone else, and is refused
// when it's empty. It used to top the budget up by one and spend it in the same
// breath, which meant a skill reading 0 on the toolbar carried on being used —
// the count was a decoration rather than a number. If the level has none left
// it has none left; the nuke timer and the retry are what stop that becoming a
// dead end.
function grant(w, skill) {
  if (!take(w, skill)) return false
  w.granted[skill] = (w.granted[skill] || 0) + 1
  w.rescues++
  return true
}

// How long an agent may walk without getting anywhere before it stops asking
// permission. Twenty seconds of pacing the same ledge is well past the point
// where a watcher has noticed it's stuck — but not shorter: at fifteen they
// start sinking shafts through corridors they were still perfectly capable of
// walking out of, which wrecks the route for everyone behind them and costs
// more levels than it saves.
var PATIENCE = 600

// Going round in circles. An agent's recent positions are counted into buckets
// this many cells wide, and re-treading one this many times condemns it.
//
// The counter is wiped every time the agent gets closer to home, which is what
// makes it safe: reaching the threshold means five passes over the same few
// cells with no progress at all between them, not five passes in the course of
// a long level. A tight pace between two walls trips it in about six seconds;
// a wide lap of a whole corridor takes nearer twenty-five, by which time
// PATIENCE has usually already offered it a shovel.
var LOOP_BUCKET = 5
var LOOP_PASSES = 5

// Pacing is not the only way to be stuck. Counting buckets only ever notices an
// agent that MOVES between them, so one wearing a hole in a single five-cell
// stretch — turning on the spot between a wall and a blocker, say — re-tread
// nothing, counted nothing, and stood there until the level timed out. Which is
// exactly the one everybody notices, because it never goes anywhere at all.
//
// So there is a second way to be condemned: walking, and no closer to home for
// this long. It sits past PATIENCE, so forceEscape has already had its go with
// a shovel and failed before anything gets written off.
var STUCK_LIMIT = PATIENCE + 240

// A hop. Agents can stride two cells and climb with a skill, and between those
// two there was nothing at all — so a two-cell pocket, a ledge three high, or a
// blocker with a wall a stride behind it were all places to bounce back and
// forth in forever. Measured, four percent of all agent-time was spent frozen
// inside a single cell, and specials were hitting a wall a hundred and fifty
// times a level without ever getting anywhere.
//
// It is free and needs no skill, because it is not a solution to anything: it
// clears three cells, which is under the height of everything the level puts in
// the way on purpose. It only gets an agent out of somewhere it should never
// have been trapped in.
var JUMP_UP = 3          // cells of lift
var JUMP_STILL = 40      // ticks stuck in one cell before it tries
var JUMP_RISE = -0.42    // starting vertical speed
var JUMP_GRAV = 0.055

// Stuck in one cell for this long and the hop did not answer it: dig instead.
var STILL_ESCAPE = 130

// The other half of the director, and the more important one. The global stall
// check can't see this case: one agent bashing away keeps terrainVersion
// moving, so the level looks busy while fifteen others tramp a corridor they
// have no way out of.
//
// The deeper reason they get stranded is that skill budgets are per-agent
// but a tunnel is shared — the first few to meet an obstacle spend the level's
// diggers opening a way down, and everyone who doesn't happen to find that
// shaft needs a digger of their own that no longer exists. Rather than inflate
// every budget until that can't happen (which just makes levels solve
// themselves instantly), this hands a tool to the specific agent that has
// demonstrably been getting nowhere.
function forceEscape(w, ag) {
  if (ag.special) {
    // specialEscape deliberately leaves `idle` alone so a failed rescue can
    // still reach condemnation. Without a separate throttle that also calls
    // it on every subsequent tick; a fallback turn then makes the special
    // alternate directions in one pixel thirty times a second.
    if (ag.rescueCool > 0) return
    ag.rescueCool = 90
    specialEscape(w, ag)
    return
  }
  var footY = Math.floor(ag.y)
  var ahead = Math.floor(ag.x) + ag.dir

  if (exitAbove(w, ag)) {
    // Below the exit: the only useful direction is up.
    if (solid(w, ahead, footY) && wallHeight(w, ahead, footY) <= MAX_CLIMB
        && grant(w, "climber")) { ag.idle = 0; startClimb(w, ag); return }
    if (canStartBuild(w, ag) && grant(w, "builder")) { ag.idle = 0; startBuild(w, ag) }
    return
  }

  // What's in FRONT comes first. Checking the floor first looks equivalent and
  // is not: an agent is almost always standing on something, so the floor test
  // always won and an agent stopped dead against a wall would sink a shaft
  // beneath its own feet rather than go through the thing actually blocking it.
  // At the wall sealing the exit — which every agent on the level meets, and
  // meets last — that put the whole colony underground a few paces short of
  // home.
  // Look BOTH ways for something worth going through, and turn to face it.
  // Checking only what's in front makes the rescue a coin toss: an agent that
  // happens to have just turned away from the wall it's stuck behind is offered
  // nothing, and since this resets its patience either way, it can bounce off
  // the same wall indefinitely while help arrives for the direction it isn't
  // facing.
  var behind = Math.floor(ag.x) - ag.dir
  if (solid(w, ahead, footY) && at(w, ahead, footY) !== STEEL && grant(w, "basher")) {
    ag.idle = 0
    ag.state = "bash"
    ag.timer = 0
    return
  }
  if (solid(w, behind, footY) && at(w, behind, footY) !== STEEL && grant(w, "basher")) {
    ag.idle = 0
    ag.dir = -ag.dir
    ag.state = "bash"
    ag.timer = 0
    return
  }
  // Only ever downward when the exit really is below. On the last corridor it
  // is not — it's on this very floor — and an agent that sinks a shaft there
  // drops itself into the earth beneath the only room that matters, with the
  // way back up costing a climber nobody has left. Ungated, this was every
  // stranded agent in the run: the colony tunnelling out through the floor
  // of the room it was standing in.
  if (exitBelow(w, ag) && solid(w, Math.floor(ag.x), footY + 1)
      && at(w, Math.floor(ag.x), footY + 1) !== STEEL) {
    var charge = traitOf(ag).mineFirst === true || ag.id % 2 === 0
    if (grant(w, charge ? "miner" : "digger")) {
      ag.idle = 0
      if (charge) plantMine(w, ag)
      else { ag.state = "dig"; ag.timer = 0 }
      return
    }
  }
  // The cap applies to director help too. Without it, the one mechanism meant
  // to rescue a stuck agent happily hands the keenest builder its eighteenth
  // bridge, and the pile of brickwork is what the rest then get stuck on.
  if (canStartBuild(w, ag) && grant(w, "builder")) {
    ag.idle = 0
    startBuild(w, ag)
    return
  }

  // Nothing applied. Leave patience untouched: pretending a refused rescue
  // was progress lets an agent wedged between a blocker and a wall request the
  // same unavailable tool forever without ever reaching condemnation.
}

function runDirector(w) {
  var mark = w.saved * 1000 + w.lost * 100 + w.carved
  if (mark !== w.progressMark) {
    w.progressMark = mark
    w.stallTicks = 0
    w.acting = null; return
  }

  w.stallTicks++
  if (w.stallTicks < 300) return // ten seconds of genuinely nothing happening
  w.stallTicks = 0

  // Help whoever is closest to the exit — they're the one most likely to
  // finish the level if they can just get moving again.
  var best = null
  var bestD = Infinity
  for (var i = 0; i < w.agents.length; i++) {
    var ag = w.agents[i]
    if (ag.gone || ag.state === "saved") continue
    var d = Math.abs(ag.x - w.exit.x) + Math.abs(ag.y - w.exit.y) * 2
    if (d < bestD) { bestD = d; best = ag }
  }
  if (!best) return

  // The director reaches into the same budget as everyone else, so it has to
  // go through the same gate — otherwise the one agent that is barred from the
  // toolbar gets handed a climber by the thing that rescues stalled levels,
  // which is exactly the kind of exception that quietly undoes a rule.
  w.acting = best

  var footY = Math.floor(best.y)
  var ahead = Math.floor(best.x) + best.dir
  var wantUp = exitAbove(w, best)

  // Below the exit and pacing: nothing horizontal helps, and digging only
  // makes it worse. Hand them a climb.
  var wantsMine = best.id % 2 === 0
  if (wantUp && solid(w, ahead, footY) && wallHeight(w, ahead, footY) <= MAX_CLIMB
      && grant(w, "climber")) {
    startClimb(w, best)
  } else if (solid(w, ahead, footY) && at(w, ahead, footY) !== STEEL && grant(w, "basher")) {
    best.state = "bash"
    best.timer = 0
  } else if (exitBelow(w, best) && solid(w, Math.floor(best.x), footY + 1)
             && at(w, Math.floor(best.x), footY + 1) !== STEEL
             && grant(w, wantsMine ? "miner" : "digger")) {
    if (wantsMine) plantMine(w, best)
    else { best.state = "dig"; best.timer = 0 }
  } else if (best.state === "walk" && canStartBuild(w, best) && grant(w, "builder")) {
    startBuild(w, best)
  } else if (w.bombsUsed < 1 && w.rescues > 6 && boxedIn(w, best) && grant(w, "bomber")) {
    // Genuinely walled in by steel with every tool refused. One goes up, and
    // the rest walk out through the hole.
    //
    // Strictly last-ditch, and capped at one a level. As a plain `else` it is
    // not a rescue but an execution: whenever the branches above it stopped
    // applying — a build cap reached, say — the director quietly worked its
    // way down to blowing agents up as routine maintenance, and the loss
    // rate went from one in three hundred to one in sixteen.
    w.bombsUsed++
    best.state = "bomb"
    best.fuse = BOMB_FUSE
  }
  w.acting = null
}

// ---------------------------------------------------------------------------
// Main step
// ---------------------------------------------------------------------------

// Counting where an agent has been since it last made progress. Buckets are
// keyed by corridor as well as by column, so walking the same stretch of two
// different floors doesn't read as pacing one of them.
function countPass(w, ag) {
  // Only walking can be pacing. A climber, builder or digger may cross the
  // same bucket repeatedly while doing useful work; condemning it here turns
  // the rescue itself into a bomb and leaves everyone behind in its crater.
  if (ag.state !== "walk") return
  var key = Math.floor(ag.x / LOOP_BUCKET) + "@" + Math.floor((ag.y + 1) / (w.corrGap || CORR_GAP))
  if (key === ag.bucket) return
  ag.bucket = key
  ag.passes[key] = (ag.passes[key] || 0) + 1
  if (ag.passes[key] < LOOP_PASSES) return
  condemn(w, ag)
}

function condemn(w, ag) {
  // Condemned. A bomb rather than simply deleting it, because the explosion is
  // the useful part: it takes a bite out of the level, and an agent only ever
  // paces somewhere it could not get past, so the hole it leaves is in exactly
  // the wall that stopped it. Nobody is told about it — the others just find
  // the terrain different next time they walk into it, which is the whole
  // premise working in its favour for once.
  //
  // It costs a bomber from the level's budget like everything else. When that
  // budget is empty the agent goes on pacing, and PATIENCE handles it with a
  // shovel instead.
  if (ag.state === "bomb" || ag.state === "block" || ag.state === "camp" || ag.state === "saved") return

  // A special gets the shovel before it gets written off. Pacing trips the
  // bucket count in about two hundred ticks, where the forced escape does not
  // come round until six hundred — so a special boxed into a pocket was being
  // condemned well before anything had offered it a way down, and two thirds
  // of them ended up bombed rather than home. It digs instead, as often as it
  // needs to, and is only written off if it is still going nowhere long after
  // the point where an ordinary agent would have been.
  if (ag.special && ag.idle < STUCK_LIMIT) { specialEscape(w, ag); return }
  // A special is barred from the toolbar, bombs included, so without this the
  // one agent that cannot be given a way out also cannot be cleared away — and
  // it would pace until the nuke on every level it got stuck on.
  if (!ag.special && !take(w, "bomber")) return
  ag.state = "bomb"
  ag.fuse = BOMB_FUSE
  ag.condemned = true
}

function step(w) {
  w.ticks++
  w.lastEvent = ""

  if (w.released < w.toRelease) {
    w.releaseTimer++
    if (w.releaseTimer >= w.releaseInterval) {
      w.releaseTimer = 0
      w.released++
      w.agents.push(spawn(w))
    }
  }

  // Out of time. Everybody left gets a fuse, a few ticks apart so they go up
  // in a ripple rather than all at once — the original's nuke, and the only
  // ending that reads as deliberate rather than as the simulation giving up.
  if (!w.done && !w.nuking && w.ticks > w.timeLimit) w.nuking = true
  if (w.nuking) {
    w.nukeTimer++
    if (w.nukeTimer >= NUKE_STAGGER) {
      w.nukeTimer = 0
      for (var n = 0; n < w.agents.length; n++) {
        var N = w.agents[n]
        if (N.gone || N.state === "saved" || N.state === "bomb") continue
        N.state = "bomb"
        N.fuse = BOMB_FUSE
        break
      }
    }
    // Nothing left in the hatch once the nuke is on.
    w.released = w.toRelease
  }

  var active = 0
  var blockers = 0
  var moving = 0

  for (var i = 0; i < w.agents.length; i++) {
    var ag = w.agents[i]
    if (ag.gone) continue

    if (ag.state === "saved") {
      ag.fade++
      if (ag.fade > 14) ag.gone = true
      continue
    }

    // Closer to home than this agent has ever been? Then whatever it's
    // doing is working: clear both counters and let it get on with it.
    w.acting = ag
    if (ag.cool > 0) ag.cool--
    if (ag.shotFor > 0) ag.shotFor--

    // A sniper takes a position it can see something from. Camping at the first
    // wall it happened to meet put it on a different floor from the danger on
    // nearly every level, where it could never see the one thing it is for.
    if (ag.special && ag.state === "walk" && sightsHazard(w, ag)) {
      var sact = specOf(ag).act
      if (sact === "camp") {
        ag.state = "camp"
        ag.cool = 0
      } else if (sact === "spray" && ag.cool <= 0 && hazardIsAhead(w, ag, 20)) {
        // It opens up the moment it has the thing in view. Waiting for a wall
        // meant it fired once or twice a level, always at the map edge, and
        // never once at the danger — which is half of what it is for.
        ag.state = "trick"
        ag.timer = 0
      }
    }
    if (ag.rescueCool > 0) ag.rescueCool--

    // Stuck inside one cell. Not "getting nowhere" in the goalDist sense — the
    // literal same cell, tick after tick, which is what pacing in a pocket
    // looks like and what the bucket counter can never see.
    var cell = Math.floor(ag.x) + "," + Math.floor(ag.y)
    // Count only walking. Wind-ups, building, climbing and falling can all
    // occupy one cell for a long time while doing exactly what they should.
    // Carrying those ticks back into `walk` makes a completed action look
    // instantly stuck and can launch a hop or rescue on its very next frame.
    if (ag.state !== "walk") { ag.cell = cell; ag.still = 0 }
    else if (cell === ag.cell) ag.still++
    else { ag.cell = cell; ag.still = 0 }
    if (ag.still > JUMP_STILL && ag.state === "walk" && canJump(w, ag)) startJump(w, ag)

    // Still in the same cell long after a hop would have been tried and either
    // worked or been impossible. Nothing about this agent's situation is going
    // to change on its own, so it stops waiting for the patience timer — which
    // is twenty-eight seconds away — and digs. Most of what is left after the
    // hop is an agent pinned between a drop it will not take and something it
    // will not pass, and neither of those resolves by standing there.
    if (ag.still > STILL_ESCAPE && ag.state === "walk") {
      ag.still = 0
      forceEscape(w, ag)
      // An ordinary agent that is literally stationary and was offered no
      // usable rescue is finished. The hop has already failed or been refused
      // by this point; consulting a second timer only leaves it displayed in
      // the same pixel. Level 19 exposed that gap after its builders and
      // blocker closed both sides of one cell.
      if (!ag.special && ag.state === "walk") condemn(w, ag)
    }

    var dist = goalDist(w, ag)
    if (dist < ag.markD - 2) {
      ag.markD = dist
      ag.idle = 0
      ag.turns = 0
      // Progress wipes the pacing record. Everything the loop check knows is
      // about the stretch since the agent last got anywhere.
      ag.passes = {}
      ag.bucket = ""
    } else {
      ag.idle++
    }

    // Getting nowhere for long enough: stop waiting for the budget to allow it
    // (see forceEscape). Only from a walk, so it never interrupts work already
    // under way.
    if (ag.state === "walk" && ag.idle > PATIENCE - traitOf(ag).digBias) forceEscape(w, ag)

    // Recovery gets first refusal. On a long corridor the fifth pass and the
    // patience limit can land on the same tick; counting first condemned the
    // agent before forceEscape could hand it the tool this counter exists to
    // lead up to. If recovery started work, countPass ignores it above.
    countPass(w, ag)

    // Still nowhere, well after the shovel. Stuck on the spot rather than
    // pacing between two places, which the bucket count above cannot see.
    if (ag.state === "walk" && ag.idle > STUCK_LIMIT) condemn(w, ag)

    switch (ag.state) {
      case "walk": stepWalk(w, ag); break
      case "fall": stepFall(w, ag); break
      case "climb": stepClimb(w, ag); break
      case "build": stepBuild(w, ag); break
      case "bash": stepBash(w, ag); break
      case "dig": stepDig(w, ag); break
      case "block": stepBlock(w, ag); break
      case "bomb": stepBomb(w, ag); break
      case "trick": stepTrick(w, ag); break
      case "ceil":  stepCeiling(w, ag); break
      case "jump":  stepJump(w, ag); break
      case "camp":  stepCamp(w, ag); break
    }

    w.acting = null

    if (ag.gone) continue

    // Home. The exit's mouth is a rectangle; walking into it is all it takes.
    var e = w.exit
    if (ag.x > e.x && ag.x < e.x + e.w && ag.y > e.y && ag.y < e.y + e.h + 1) {
      ag.state = "saved"
      ag.fade = 0
      w.saved++
      w.lastEvent = "saved"
      continue
    }

    active++
    // A camped sniper counts with the blockers here: it is standing somewhere
    // on purpose and it is never coming home either. Without this the level
    // waits for it and every Beam Search level runs to the nuke.
    if (ag.state === "block" || ag.state === "camp") blockers++
    if (ag.state !== "walk" || ag.idle < 300) moving++
  }

  // Everyone who was going to get home has, and the only ones left standing are
  // the ones holding the door. They light their own fuses — which is exactly
  // what a player does at the end of a level, and the honest end to the bargain
  // they made. They don't walk away from it.
  if (active > 0 && active === blockers) {
    for (var b = 0; b < w.agents.length; b++) {
      var B2 = w.agents[b]
      if (B2.state === "block" || B2.state === "camp") {
        B2.state = "bomb"
        B2.fuse = BOMB_FUSE
      }
    }
  }

  stepHazard(w)
  stepMines(w)
  stepParticles(w)
  if (!w.done) runDirector(w)

  w.active = active
  w.movingCount = moving

  if (!w.done && w.released >= w.toRelease && active === 0 && w.mines.length === 0) {
    w.done = true
    w.doneTicks = 0
  }
  if (w.done) w.doneTicks++

  // A level nobody can finish still has to end, and it should end while it's
  // still worth looking at. Two cutoffs: a hard ceiling, and a much earlier
  // one for the common case where everybody bar a straggler or two is home and
  // the rest is going to be one agent pacing a ledge.
  if (!w.done) {
    var settled = w.saved + w.lost
    var nearlyDone = settled >= w.toRelease - 2 && w.released >= w.toRelease
    // `stallTicks` alone is the wrong test for the straggler case: it only
    // watches saves, losses and terrain, so an agent quietly walking or
    // climbing its way home counts as nothing happening, and the level gets
    // called at 14 of 16 while the last two are most of the way there. Ending
    // early is only right when everyone left has genuinely stopped getting
    // anywhere, which is exactly what each agent's own idle counter knows.
    var allStuck = w.movingCount === 0
    // Twenty seconds in which nothing was saved, nothing was lost and not one
    // cell of earth moved is a finished level whatever the stragglers look
    // like they're doing — `stallTicks` resets on any of the three, so it can
    // only run up while genuinely nothing is happening.
    // Thirty seconds in which nothing at all happened ends the level whether
    // or not most of them got home. `stallTicks` resets on any save, any loss
    // and any cell of earth moved, so it can only reach this while the board
    // is genuinely static — and a static board is the one thing worth cutting
    // short in something meant to be left running in the corner of a screen.
    if (w.stallTicks > 900
        || (nearlyDone && allStuck && w.stallTicks > 210)
        || (nearlyDone && w.stallTicks > 600)) {
      w.done = true
      w.doneTicks = 0
    }
  }

  return w
}
