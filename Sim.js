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
var RAPPEL_SPEED = 0.18
var WEB_ASCEND_SPEED = 0.24

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
var SPRAY_BURST = 12
var SPRAY_SHOT_TICKS = 2
var SPRAY_SLOPES = [-0.16, 0.10, -0.06, 0.14, 0, -0.12, 0.06, -0.18, 0.12, -0.03, 0.17, -0.09]
var ENEMY_WALK_SPEED = 0.24
var GUN_AIM = 24
var GUN_RELOAD = 80
var ENEMY_JET_SPEED = 0.30
var ENEMY_JET_SINK = 0.10

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

// Sliding folds one cell out of the standing silhouette. Anything tighter is
// a wall, not a passage an agent can plausibly squeeze through.
function crouchroom(w, x, footY) {
  for (var k = 1; k < AGENT_H - 1; k++)
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
  EMPTY: EMPTY, DIRT: DIRT, ROCK: ROCK, STEEL: STEEL, ORE: ORE,
  AGENT_H: AGENT_H
}

// `attempt` re-runs the SAME level with a different colony. The layout stays a
// pure function of the level number — level 42 is always level 42 — but the
// personalities and the skill budget come off the attempt as well, because a
// retry that reproduces the run exactly is not a retry: everything here is
// deterministic, so replaying a failed level unchanged fails it again, tick for
// tick. Same problem, different agents, and a little more to work with each
// time round.
function generate(level, attempt, colonySeed) {
  attempt = attempt || 0
  var rng = makeRng(level)

  // The layout is the level's, the colony is this playthrough's.
  //
  // Everything below used to be a pure function of (level, attempt), the
  // personalities included, so watching level 12 twice was watching the same
  // recording twice: the same agent hesitated at the same ledge on the same
  // tick. The ground should be the same — that is what makes a level a place
  // you can come back to — but the fifteen who walk into it should not be.
  //
  // Callers that need a repeatable run pass the seed in; simcheck does, or its
  // paired-run checks would compare two different colonies and blame the
  // terrain for the difference.
  if (colonySeed === undefined || colonySeed === null)
    colonySeed = Math.floor(Math.random() * 2147483647)
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
    hazards: [],
    hazardKnown: false,
    hazardKills: 0,
    terrain: new Uint8Array(COLS * ROWS),
    terrainVersion: 1,
    carved: 0,
    agents: [],
    enemies: [],
    enemyHatch: null,
    enemyRoster: [],
    enemyReleased: 0,
    enemyReleaseTimer: 0,
    enemiesKilled: 0,
    nextEnemyId: 1,
    mines: [],
    ladders: [],
    // The hole in the bottom of the world, and whatever is at the bottom of
    // it. A list because the shape is rolled per level and one roll cuts two;
    // `pit` is the first, kept for the same reason `hazard` is.
    pits: [],
    pit: null,
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
    // The seed is kept so a run that did something worth seeing again can be
    // replayed exactly: generate(level, attempt, w.colonySeed).
    colonySeed: colonySeed,
    traitRng: makeRng(colonySeed),
    traitCounts: {},

    // Stall detection: the director watches these three numbers and steps in
    // if none of them has moved for a while (see runDirector).
    progressMark: 0,
    stallTicks: 0,
    rescues: 0,
    bombsUsed: 0,
    collapseCopies: 0,

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

  // Zero to three dangers, weighted toward one. Corridors are unique so even
  // the busiest roll distributes them through the level instead of stacking
  // three machines into one unavoidable knot.
  var hazardRoll = rng()
  var hazardCount = hazardRoll < 0.28 ? 0 : (hazardRoll < 0.68 ? 1 : (hazardRoll < 0.91 ? 2 : 3))
  var hazardCandidates = []
  for (var hc = 1; hc < corridors.length - 1; hc++) hazardCandidates.push(hc)
  for (var hs = hazardCandidates.length - 1; hs > 0; hs--) {
    var hj2 = irand(rng, 0, hs)
    var ht = hazardCandidates[hs]; hazardCandidates[hs] = hazardCandidates[hj2]; hazardCandidates[hj2] = ht
  }
  var hazardCorridors = hazardCandidates.slice(0, Math.min(hazardCount, hazardCandidates.length))

  for (var j = 0; j < corridors.length; j++) {
    var cur = corridors[j]
    placeObstacles(w, rng, cur, j, corridors)
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

  // A separate deterministic stream keeps the red team optional without
  // reshuffling the established terrain, hazards, specials or personalities.
  var enemyRng = makeRng(level * 65537 + 4049)
  var guardPlan = null
  if (level >= 12 && enemyRng() < 0.22) {
    // Hide the post on a deeper corridor. Its exact depth and position use a
    // separate stream, so neither the established map nor the enemy roster is
    // reshuffled. Starting down-route means the guards must patrol and fly to
    // meet the colony instead of opening fire beside the friendly hatch.
    var guardIndex = irand(enemyRng, 1, Math.max(1, corridors.length - 2))
    if (hazardCorridors.indexOf(guardIndex) >= 0 && corridors.length > 3) {
      var foundGuardCorridor = false
      for (var gci = 1; gci < corridors.length - 1; gci++)
        if (hazardCorridors.indexOf(gci) < 0) { guardIndex = gci; foundGuardCorridor = true; break }
      if (!foundGuardCorridor) guardIndex = corridors.length - 1
    }
    var guardCorridor = corridors[guardIndex]
    var guardFraction = 0.35 + enemyRng() * 0.30
    var desiredEnemyX = Math.round(guardCorridor.startX
      + (guardCorridor.handoffX - guardCorridor.startX) * guardFraction)
    guardPlan = { corridor: guardCorridor, index: guardIndex, desiredX: desiredEnemyX }
    // One threat model per post: a single Drone Operator sending replacements,
    // one sniper establishing a permanent position, or one to two Trigger
    // Warnings patrolling in person. Mixing them stacks ranged pressure in a
    // way the colony cannot read or answer cleanly.
    var enemyKindRoll = enemyRng()
    if (enemyKindRoll < 0.32) w.enemyRoster.push("operator")
    else if (enemyKindRoll < 0.57) w.enemyRoster.push("sniper")
    else {
      var enemyCount = irand(enemyRng, 1, 2)
      for (var er = 0; er < enemyCount; er++) w.enemyRoster.push("gun")
    }
  }

  // A roaming armed squad is already the level's threat. Mixing it with up to
  // three fixed hazards made the board unreadable and turned freezing effects
  // into effortless executions, so enemy and hazard encounters alternate.
  if (guardPlan) hazardCorridors = []

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

  // The hole in the bottom of the world. It goes in here, after the exit and
  // the wall in front of it are settled — a crossing has to be placed relative
  // to both — and before the floors are roughened.
  placeBottomPit(w, rng, last, corridors.length > 1 ? corridors[corridors.length - 2] : null, sealFrom)
  w.pit = w.pits.length ? w.pits[0] : null

  // A hole the whole colony has to get over is a bridge the whole colony
  // depends on, and it is unlike every other obstacle on the board in having
  // exactly one answer: no climb tops it, no bash goes through it, and nobody
  // walks round it. Pay for it here rather than letting the colony discover at
  // the last corridor that the bricks went on a chasm three floors up.
  for (var bp = 0; bp < w.pits.length; bp++) if (w.pits[bp].crossing) w.skills.builder += 6

  // Last, once every wall, shaft and doorway is where it is going to be, so
  // nothing gets furnished and then carved away before anyone sees it.
  // Roughen the floors last of all. Doing it while the corridor was carved put
  // the bumps in before the obstacles, so a chasm cut afterwards took the floor
  // out from under them and left a shelf of raised dirt hanging across the hole
  // — a bridge nobody built, over the one obstacle that is supposed to need
  // one. Jungle levels lost sixteen points of clear rate to it.
  for (var rf = 0; rf < corridors.length; rf++) roughFloor(w, corridors[rf], rng, w.biome)

  placeDecor(w, rng, corridors)
  for (var hpi = 0; hpi < hazardCorridors.length; hpi++) {
    var placedHazard = placeHazard(w, rng, corridors, hazardCorridors[hpi])
    if (placedHazard) w.hazards.push(placedHazard)
  }
  w.hazard = w.hazards.length ? w.hazards[0] : null

  // Place the booth only after terrain roughening, decoration and hazards are
  // final. Earlier placement could pass a clear-space test and then have a
  // grate, hanging prop or hazard drawn straight through its roof.
  if (guardPlan) {
    var gc = guardPlan.corridor
    // A sniper house needs a clear run to the shaft above; unlike patrols it
    // has a deliberate deployment route. Put its booth near that shaft rather
    // than behind a full-height obstacle it cannot fly through.
    var enemyDesired = guardPlan.desiredX
    if (w.enemyRoster.length === 1 && w.enemyRoster[0] === "sniper"
        && guardPlan.index > 0) {
      var sniperShaft = corridors[guardPlan.index - 1].handoffX
      enemyDesired = sniperShaft + (gc.dir > 0 ? 6 : -6)
    }
    var enemyX = enemyDesired, enemyBest = Infinity
    for (var egx = gc.x0 + 4; egx <= gc.x1 - 4; egx++) {
      var guardClear = true
      // Seven cells wide and eight high covers even the Ice Cave roof spikes
      // and the Spaceship booth's side antennae.
      for (var ewx = egx - 3; ewx <= egx + 3 && guardClear; ewx++) {
        if (!solid(w, ewx, gc.floorY)) guardClear = false
        for (var ehy = 1; ehy <= 8 && guardClear; ehy++)
          if (solid(w, ewx, gc.floorY - ehy)) guardClear = false
      }
      for (var edi = 0; edi < w.decor.length && guardClear; edi++) {
        var ed = w.decor[edi]
        if (Math.abs(ed.x - egx) <= 4 && ed.y >= gc.floorY - 10 && ed.y <= gc.floorY + 2)
          guardClear = false
      }
      for (var ghi = 0; ghi < w.hazards.length && guardClear; ghi++) {
        var gh = w.hazards[ghi]
        if (Math.abs(gh.floorY - gc.floorY) < 3
            && egx + 5 >= gh.zx0 && egx - 5 <= gh.zx1) guardClear = false
      }
      if (gc === last && egx + 5 >= w.exit.x - 2 && egx - 5 <= w.exit.x + w.exit.w + 2)
        guardClear = false
      var enemyDistance = Math.abs(egx - enemyDesired)
      if (guardClear && enemyDistance < enemyBest) { enemyX = egx; enemyBest = enemyDistance }
    }
    if (enemyBest === Infinity) {
      enemyX = Math.max(gc.x0 + 4, Math.min(gc.x1 - 4, enemyDesired))
      // Absolute fallback: cut a booth-sized alcove. A rare tiny terrain edit
      // is preferable to ever drawing a building inside solid earth.
      for (var ecx = enemyX - 3; ecx <= enemyX + 3; ecx++)
        for (var ecy = gc.floorY - 8; ecy < gc.floorY; ecy++) clearCell(w, ecx, ecy)
    }
    // There is normally ample room; if a particularly furnished corridor has
    // none, remove only overlapping decor at the best terrain-safe fallback.
    w.decor = w.decor.filter(function(ed) {
      return !(Math.abs(ed.x - enemyX) <= 4 && ed.y >= gc.floorY - 10 && ed.y <= gc.floorY + 2)
    })
    w.enemyHatch = {
      x: enemyX, y: gc.floorY - 1, biome: w.biome,
      corridor: guardPlan.index, dir: -gc.dir
    }
    for (var epadY = gc.floorY; epadY < gc.floorY + 2; epadY++)
      for (var epadX = enemyX - 2; epadX <= enemyX + 2; epadX++) setCell(w, epadX, epadY, STEEL)
  }

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
    // Keep the current height while crossing a missing stretch. Resetting it
    // here made the two lips of a gap drift to different levels, even though
    // the same rough-floor run visually continues on both sides. A builder
    // approaching from the high lip then laid a flat bridge that the colony
    // could not step onto from the low lip (level 13's Ice Cave crossing).
    // The run counter still advances above, preserving the generation RNG.
    if (!solid(w, x, c.floorY)) continue
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
  // signature move either. The roster is deliberately smaller than the old
  // grab bag, all visible, all rationed by time instead of by budget.
  //
  // `cool` is ticks before it can do it again. While it is cooling it turns at
  // a wall like anybody else, so the move is something you wait for.

  // Works like a basher, except it happens all at once: a tunnel the height of
  // an agent, punched through in a single shot.
  { id: "buckshot",  name: "Max Tokens",   act: "blast",  height: "recoil", cool: 150, robe: "#b83232", hair: "#e8d24a" },

  // Does not destroy the wall. Moves it. The block ahead is picked up and put
  // down four cells further on, which can open a way through, seal one, or
  // shunt a lump of the level into a hole — and the colony has to deal with
  // wherever it ended up.
  { id: "roundhouse",name: "Vector Van Damme", act: "kick",   height: "cyclone", cool: 130, robe: "#d1621f", hair: "#3a2a18" },

  // Goes up the wall, onto the ceiling, and keeps walking upside down until the
  // roof runs out from under it.
  { id: "spider",    name: "Web Crawler",     act: "ceiling",height: "web", cool: 90,  robe: "#8f2bbf", hair: "#e04a8a" },

  { id: "pyro",      name: "Sim Anneal",       act: "melt",   height: "balloon", cool: 160, robe: "#c4341c", hair: "#f0a03c" },
  { id: "sapper",    name: "Prompt Injection",     act: "sap",    height: "promptchute", cool: 200, robe: "#6b6b28", hair: "#c8c8b0" },
  { id: "piledriver",name: "Gradient Descent", act: "stomp",  height: "piledrive", cool: 140, robe: "#4a4f59", hair: "#d8dde5" },
  { id: "quarryman", name: "Context Window",  act: "quarry", height: "helicopter", cool: 220, robe: "#a8843c", hair: "#5a4426" },

  // The only one that adds instead of taking away.
  { id: "glazier",   name: "Guard Rails",    act: "slab",   height: "glasswing", cool: 120, robe: "#4a9ec4", hair: "#dff2ff" },

  // Steps through the wall rather than removing it, which leaves the level
  // exactly as it found it and gets nobody else anywhere.
  { id: "wraith",    name: "Hal Lucination",     act: "phase",  height: "ghost", cool: 110, robe: "#8e8ea8", hair: "#e8e8f4" },

  // The two that can do something about the level's danger. Everybody else
  // treats a danger as weather — you learn it, you time it, you live with it.
  // These two shoot it.
  { id: "gridsearch",name: "RAMbo Search",   act: "spray",  height: "gunwing", cool: 70,  robe: "#4a5d23", hair: "#b03a2e" },
  { id: "beamsearch",name: "Beam Search",    act: "camp",   height: "tractor", cool: 120, robe: "#37474f", hair: "#8fd0e8" }

  // Finishes whatever shape the level appears to have started, then keeps
  // going because stopping at the requested boundary would require judgment.
  ,{ id: "autocomplete", name: "Auto Complete", act: "complete", height: "steps", cool: 125, robe: "#176b87", hair: "#7de3ff" }

  // Takes nearby agents through an obstacle as one linked conclusion. Whether
  // any of them agreed to the premise is outside the context window.
  ,{ id: "chainthought", name: "Chain of Thought", act: "chain", height: "chain", cool: 165, robe: "#713f98", hair: "#dfb7ff" }

  // Renders several possible futures, discards the embarrassing ones, and
  // commits to the first candidate that has somewhere solid to stand.
  ,{ id: "specdecoder", name: "Speculative Decoder", act: "speculate", height: "jetpack", cool: 115, robe: "#146c5c", hair: "#74f0cf" }

  // Every solution produces a cheaper copy of the model. The copies inherit
  // the confidence and progressively less of the sprite.
  ,{ id: "collapse", name: "Model Collapse", act: "collapse", height: "cushion", cool: 190, robe: "#7a3154", hair: "#f19ac2" }

  // Stops a crowd, then grudgingly returns one token at a time. It is the only
  // special whose signature move is making everybody else do less.
  ,{ id: "ratelimit", name: "Rate Limiter", act: "limit", height: "elevator", cool: 145, robe: "#315b8a", hair: "#f0c75e" }

  // Leaves the wall exactly where it is and makes it free. Everything else on
  // this roster solves a wall for itself; a ladder is still there twenty
  // seconds later for whoever arrives next, and it climbs walls too tall for
  // anybody to have climbed at all. The only special whose work outlives it.
  ,{ id: "ladder", name: "Stack Overflow", act: "stack", height: "extender", cool: 150, robe: "#b5651d", hair: "#ffe9a8" }

  // Answers a danger by walking into it. Everybody else treats a live hazard
  // as a wall and turns round; this one raises a plate and keeps going, and
  // whoever is in its lee comes through with it. The only defensive move on
  // the board, and the only one that is worth more to the queue behind it than
  // to the agent doing it.
  ,{ id: "bulwark", name: "Ada Blocker", act: "shield", height: "shieldglider", cool: 150, robe: "#7b8794", hair: "#ffd23f" }
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

function specialLanding(w, ag, reach) {
  var fx = Math.floor(ag.x)
  var fy = Math.floor(ag.y)
  for (var i = 2; i <= reach; i++) {
    var tx = fx + ag.dir * i
    if (at(w, tx, fy) === STEEL) return null
    if (!solid(w, tx, fy) && !solid(w, tx, fy - 1)
        && solid(w, tx, fy + 1) && headroom(w, tx, fy))
      return { x: tx + 0.5, y: fy }
  }
  return null
}

function freezeNearby(w, ag, count) {
  var held = 0
  for (var i = 0; i < w.agents.length && held < count; i++) {
    var other = w.agents[i]
    if (other === ag || other.gone || other.state === "saved"
        || other.state === "bomb" || other.state === "block"
        || other.state === "camp" || other.state === "limited") continue
    if (Math.abs(other.x - ag.x) > 12 || Math.abs(other.y - ag.y) > 3) continue
    other.state = "limited"
    other.limitedFor = 35 + held * 24
    other.limitedBy = ag.id
    held++
  }
  return held
}

function collapseCopy(w, ag) {
  if ((ag.modelGen || 0) >= 3 || w.collapseCopies >= 12) return false
  var copy = {}
  for (var key in ag) if (ag.hasOwnProperty(key)) copy[key] = ag[key]
  copy.id = w.nextId++
  copy.x = ag.x - ag.dir * (1.2 + ag.modelGen * 0.3)
  copy.dir = -ag.dir
  copy.state = "walk"
  copy.modelGen = (ag.modelGen || 0) + 1
  copy.cool = specialSpec("collapse").cool + copy.modelGen * 35
  copy.timer = 0
  copy.turns = 0
  copy.idle = 0
  copy.passes = {}
  copy.bucket = ""
  copy.cell = ""
  copy.still = 0
  copy.escapeFloors = {}
  copy.escapeTunnels = {}
  copy.markD = Infinity
  copy.gone = false
  copy.fade = 0
  w.agents.push(copy)
  w.collapseCopies++
  return true
}

function sprayBullet(w, ag, shot, dry) {
  var fx = Math.floor(ag.x)
  var fy = Math.floor(ag.y)
  var d = ag.dir
  var slope = SPRAY_SLOPES[shot % SPRAY_SLOPES.length]

  for (var i = 1; i <= 30; i++) {
    var bx = fx + d * i
    var by = Math.round(fy - 2 + slope * i)

    for (var rei = 0; rei < w.enemies.length; rei++) {
      var red = w.enemies[rei]
      if (red.gone || Math.abs(red.x - (bx + 0.5)) >= 0.9 || Math.abs((red.y - 2) - by) >= 2.5) continue
      if (dry) return true
      ag.shotTo = red.x; ag.shotY = red.y - 2; ag.shotFor = SPRAY_SHOT_TICKS
      killEnemy(w, red)
      return true
    }

    // Hazards are targets in the same ray, not a separate magical range
    // check. Terrain in front absorbs the round before it can reach them.
    for (var hi = 0; hi < w.hazards.length; hi++) {
      var h = w.hazards[hi]
      if (h.wrecked || bx < h.zx0 || bx > h.zx1 || by < h.zy0 || by > h.zy1) continue
      if (dry) return true
      ag.shotTo = bx
      ag.shotY = by
      ag.shotFor = SPRAY_SHOT_TICKS
      wreckHazard(w, h)
      addDust(w, bx, by, 8)
      return true
    }

    var mat = at(w, bx, by)
    if (mat === EMPTY) continue
    if (!dry) {
      ag.shotTo = bx
      ag.shotY = by
      ag.shotFor = SPRAY_SHOT_TICKS
    }
    if (mat === STEEL) return false
    if (dry) return true
    if (clearCell(w, bx, by)) {
      addDust(w, bx, by, 4)
      return true
    }
    return false
  }
  if (!dry) {
    ag.shotTo = fx + d * 30
    ag.shotY = Math.round(fy - 2 + slope * 30)
    ag.shotFor = SPRAY_SHOT_TICKS
  }
  return false
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

  } else if (act === "complete") {
    // A tunnel completed from the first blocked token through the wall and a
    // few cells past the far side. The extra cursor travel is deliberate: the
    // joke has to survive even when there was only one cell left to remove.
    var seenWall = false
    var seenAirAfter = 0
    for (i = 1; i <= 16; i++) {
      var completeX = fx + d * i
      for (j = -AGENT_H; j <= 0; j++) {
        if (at(w, completeX, fy + j) === STEEL) return moved
        if (dry && workable(w, completeX, fy + j)) return true
        if (!dry && clearCell(w, completeX, fy + j)) { moved = true; seenWall = true }
      }
      if (!dry && seenWall) {
        if (!solid(w, completeX, fy) && !solid(w, completeX, fy - 1)) seenAirAfter++
        else seenAirAfter = 0
        if (seenAirAfter >= 4) break
      }
    }
    if (!dry && moved) {
      ag.specialX = fx + d * Math.min(i, 16)
      ag.specialY = fy
      ag.shotFor = 12
    }

  } else if (act === "chain") {
    var chainLand = specialLanding(w, ag, 12)
    if (!chainLand) return false
    if (dry) return true
    ag.specialX = chainLand.x
    ag.specialY = chainLand.y
    var linked = []
    for (i = 0; i < w.agents.length && linked.length < 4; i++) {
      var link = w.agents[i]
      if (link === ag || link.gone || link.state === "saved" || link.state === "bomb"
          || link.state === "block" || link.state === "camp") continue
      if (Math.abs(link.x - ag.x) <= 9 && Math.abs(link.y - ag.y) <= 3) linked.push(link)
    }
    ag.x = chainLand.x
    ag.y = chainLand.y
    for (i = 0; i < linked.length; i++) {
      linked[i].x = chainLand.x - d * (i + 1) * 0.8
      linked[i].y = chainLand.y
      linked[i].dir = d
      linked[i].state = "walk"
      linked[i].fall = 0
    }
    moved = true

  } else if (act === "speculate") {
    var specLand = specialLanding(w, ag, 14)
    if (!specLand) return false
    if (dry) return true
    ag.specialX = specLand.x
    ag.specialY = specLand.y
    ag.x = specLand.x
    ag.y = specLand.y
    moved = true

  } else if (act === "collapse") {
    var collapseLand = specialLanding(w, ag, 11)
    if (!collapseLand) return false
    if (dry) return true
    ag.specialX = collapseLand.x
    ag.specialY = collapseLand.y
    collapseCopy(w, ag)
    ag.x = collapseLand.x
    ag.y = collapseLand.y
    moved = true

  } else if (act === "limit") {
    var limitLand = specialLanding(w, ag, 11)
    if (!limitLand) return false
    if (dry) return true
    freezeNearby(w, ag, 5)
    ag.specialX = limitLand.x
    ag.specialY = limitLand.y
    ag.x = limitLand.x
    ag.y = limitLand.y
    moved = true

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
    if (!dry && moved) {
      // The payload is an instruction, not merely a charge: everyone close
      // enough to read it adopts the injector's direction with total confidence.
      for (var pi = 0; pi < w.agents.length; pi++) {
        var prompted = w.agents[pi]
        if (prompted === ag || prompted.gone || prompted.state !== "walk") continue
        if (Math.abs(prompted.x - ag.x) <= 11 && Math.abs(prompted.y - ag.y) <= 3)
          prompted.dir = d
      }
    }

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

  } else if (act === "stack") {
    // Adds nothing to the level and takes nothing out of it. The wall is left
    // standing; what it leaves is a way up the outside of it, which is the one
    // thing here that is worth more to the colony than to the special.
    var ladX = fx + d
    if (!solid(w, ladX, fy)) return false
    var ladH = wallHeight(w, ladX, fy)
    // Under two courses is a stride, not a climb. Over LADDER_MAX — or 99,
    // which is wallHeight's way of saying it never found a top with room to
    // stand on — is a wall that wants a different answer.
    if (ladH < 2 || ladH > LADDER_MAX) return false
    if (fy - ladH < SKY) return false
    if (ladderAt(w, ladX, d, fy)) return false
    if (dry) return true
    w.ladders.push({ x: ladX, side: d, bottom: fy, top: fy - ladH, t: 0 })
    w.lastEvent = "ladder up"
    return true

  } else if (act === "spray") {
    // Twelve independent angled rays. stepTrick feeds these out over time for
    // the visible burst; keeping the full operation here as well makes direct
    // and rescue calls obey the same collision rules.
    var hit = false
    for (i = 0; i < SPRAY_BURST; i++) {
      if (sprayBullet(w, ag, i, dry)) {
        if (dry) return true
        hit = true
      }
    }
    return hit

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
// Zero to three per level, weighted toward one — a board that always has a
// machine gun on it is a board with a machine gun on it, where a board that
// might contain a whole unfortunate security stack is a board you watch.
//
// Every danger is built out of one of six mechanisms and differs in where it
// mounts, how far it reaches, how long it telegraphs before it fires and how
// long it rests afterwards. That is deliberate: twenty separate pieces of
// clockwork would be twenty separate ways for a level to become unwinnable,
// where twenty settings of the same five are twenty things to look at.
//
//   watch    dormant until somebody comes within reach, then winds up and fires
//   snipe    selects one visible target, holds a sight, then takes one shot
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
  { id: "gun",      name: "Token Sprayer", mech: "watch", mount: "ceiling", reach: 13, charge: 16, fire: 24, rest: 66, w: 5, h: 6 },
  { id: "sentry",   name: "Hall Monitor", mech: "watch", mount: "wall", reach: 16, charge: 34, fire: 14, rest: 74, w: 3, h: 4 },
  { id: "darts",    name: "Sharp Prompt", mech: "watch", mount: "wall", reach: 11, charge: 18, fire: 10, rest: 52, w: 3, h: 3 },
  { id: "flame",    name: "Thermal Throttler", mech: "watch", mount: "ceiling", reach: 9, charge: 30, fire: 26, rest: 70, w: 4, h: 6 },
  { id: "tesla",    name: "Power User", mech: "watch", mount: "floor", reach: 10, charge: 24, fire: 18, rest: 62, w: 5, h: 5 },
  { id: "turret",   name: "Auto Moderator", mech: "watch", mount: "ceiling", reach: 15, charge: 18, fire: 20, rest: 68, w: 4, h: 5 },

  // snipe: picks a target it can actually see, anywhere down the corridor
  { id: "sniper",   name: "Long Context", mech: "snipe", mount: "wall", reach: 46, charge: 44, fire: 10, rest: 150, w: 3, h: 3 },

  // beam: keeps its own schedule, telegraphs with a sight line
  { id: "lasergrid",name: "Neural Net", mech: "beam", mount: "ceiling", reach: 6, charge: 30, fire: 30, rest: 60, w: 6, h: 6 },
  { id: "sweeper",  name: "Garbage Collector", mech: "beam", mount: "ceiling", reach: 10, charge: 26, fire: 34, rest: 56, w: 8, h: 6 },
  { id: "tripwire", name: "Dependency Trap", mech: "beam", mount: "floor", reach: 7, charge: 20, fire: 16, rest: 58, w: 7, h: 2 },

  // plate: armed by being stood on
  { id: "spikes",   name: "Edge Cases", mech: "plate", mount: "floor", reach: 3, charge: 16, fire: 22, rest: 46, w: 5, h: 3 },
  { id: "beartrap", name: "Catch Block", mech: "plate", mount: "floor", reach: 2, charge: 8, fire: 18, rest: 40, w: 3, h: 2 },
  { id: "sawblade", name: "Circular Reference", mech: "plate", mount: "floor", reach: 3, charge: 20, fire: 26, rest: 50, w: 4, h: 3 },
  { id: "grinder",  name: "Fine-Tuner", mech: "plate", mount: "floor", reach: 4, charge: 24, fire: 30, rest: 54, w: 6, h: 3 },

  // cycle: never triggers, never stops
  { id: "crusher",  name: "Context Compressor", mech: "cycle", mount: "ceiling", reach: 0, charge: 34, fire: 20, rest: 62, w: 5, h: 6 },
  { id: "pendulum", name: "Mood Swing", mech: "cycle", mount: "ceiling", reach: 0, charge: 28, fire: 24, rest: 48, w: 6, h: 6 },
  { id: "geyser",   name: "Vaporware", mech: "cycle", mount: "floor", reach: 0, charge: 30, fire: 26, rest: 64, w: 4, h: 6 },
  { id: "rockfall", name: "Stack Overflow", mech: "cycle", mount: "ceiling", reach: 0, charge: 36, fire: 18, rest: 72, w: 5, h: 6 },
  { id: "piston",   name: "Push Notification", mech: "cycle", mount: "wall", reach: 0, charge: 18, fire: 24, rest: 56, w: 5, h: 4 },

  // field: always live. Narrow, because there is no moment when it isn't.
  { id: "brazier",  name: "Hot Take", mech: "field", mount: "floor", reach: 0, charge: 0, fire: 1, rest: 0, w: 2, h: 4 },
  { id: "fence",    name: "Access Denied", mech: "field", mount: "floor", reach: 0, charge: 0, fire: 1, rest: 0, w: 2, h: 5 },

  // Biome-only. `only` keeps a thing where it belongs — a snake in a foundry
  // is a snake in the wrong story — and `not` keeps open flame out of the ice.
  { id: "echobat",  name: "Echo Location", mech: "watch", mount: "ceiling", reach: 15, charge: 24, fire: 18, rest: 64, w: 5, h: 4, only: ["Cavern"] },
  { id: "scarab",   name: "Legacy Daemon", mech: "watch", mount: "floor", reach: 10, charge: 18, fire: 20, rest: 58, w: 5, h: 3, only: ["Ruins"] },
  { id: "snowball", name: "Cold Cache", mech: "cycle", mount: "ceiling", reach: 0, charge: 28, fire: 24, rest: 62, w: 6, h: 5, only: ["Frost"] },
  { id: "molten",   name: "Memory Leak", mech: "cycle", mount: "ceiling", reach: 0, charge: 26, fire: 26, rest: 58, w: 5, h: 6, only: ["Foundry"] },
  { id: "snake",    name: "Python", mech: "watch", mount: "floor", reach: 9, charge: 20, fire: 16, rest: 60, w: 4, h: 3, only: ["Jungle"] },
  { id: "spores",   name: "Cloud Distribution", mech: "cycle", mount: "ceiling", reach: 0, charge: 30, fire: 28, rest: 60, w: 6, h: 6, only: ["Jungle"] },
  { id: "vinelock", name: "Root Access", mech: "plate", mount: "floor", reach: 3, charge: 14, fire: 24, rest: 50, w: 5, h: 4, only: ["Jungle"] },
  { id: "icicle",   name: "Frozen Model", mech: "cycle", mount: "ceiling", reach: 0, charge: 32, fire: 16, rest: 70, w: 5, h: 6, only: ["Ice Cave"] },
  { id: "frostjet", name: "Cold Start", mech: "watch", mount: "wall", reach: 12, charge: 22, fire: 20, rest: 64, w: 4, h: 4, only: ["Ice Cave"] },
  { id: "blackice", name: "Frozen State", mech: "plate", mount: "floor", reach: 3, charge: 12, fire: 22, rest: 48, w: 6, h: 2, only: ["Ice Cave"] },
  { id: "airlock",  name: "Forced Logout", mech: "cycle", mount: "floor", reach: 0, charge: 34, fire: 24, rest: 66, w: 6, h: 6, only: ["Spaceship"] },
  { id: "servo",    name: "ARM64", mech: "watch", mount: "ceiling", reach: 14, charge: 18, fire: 18, rest: 62, w: 4, h: 5, only: ["Spaceship"] },
  { id: "packetloss", name: "Packet Loss", mech: "beam", mount: "ceiling", reach: 8, charge: 24, fire: 26, rest: 58, w: 7, h: 6, only: ["Spaceship"] }
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
  var pool = hazardsFor(w.biome).filter(function(candidate) {
    for (var hi = 0; hi < w.hazards.length; hi++) if (w.hazards[hi].kind === candidate.id) return false
    return true
  })
  if (!pool.length) pool = hazardsFor(w.biome)
  var localPool = pool.filter(function(candidate) { return candidate.only && candidate.only.indexOf(w.biome) >= 0 })
  // Biome hazards would be drowned out by the large shared roster under a
  // flat draw. Nearly half the time, prefer the local story when one exists.
  var spec = pick(rng, localPool.length && rng() < 0.45 ? localPool : pool)

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
    dir: -c.dir,
    known: false,
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
  var spec = hazardSpec(h.kind)
  var mid = (h.zx0 + h.zx1) / 2
  var sameCorridor = Math.abs(ay - h.floorY) <= CORR_H

  // These attacks leave the fixture instead of magically filling its box.
  if (h.kind === "sentry" || h.kind === "frostjet")
    return sameCorridor && (ag.x - mid) * h.dir >= 0 && (ag.x - mid) * h.dir <= spec.reach
  if (h.kind === "darts" || h.kind === "scarab") {
    var projectileCount = h.kind === "scarab" ? 5 : 3
    for (var projectile = 0; projectile < projectileCount; projectile++) {
      var travelPx = h.kind === "scarab"
        ? (projectile * 7 + w.ticks * 2) % (spec.reach * CELL)
        : (h.t * 4 + projectile * 13) % (spec.reach * CELL)
      var projectileX = mid + h.dir * travelPx / CELL
      if (sameCorridor && Math.abs(ag.x - projectileX) <= (h.kind === "scarab" ? 1.2 : 0.9)) return true
    }
    return false
  }
  if (h.kind === "snake")
    return sameCorridor && (ag.x - mid) * h.dir >= 0 && (ag.x - mid) * h.dir <= 3.5
  if (h.kind === "echobat")
    return sameCorridor && Math.abs(ag.x - mid) <= spec.reach * Math.min(1, h.t / Math.max(1, spec.fire))
  if (h.kind === "sweeper") {
    var sweepX = h.zx0 + (h.zx1 - h.zx0) * (0.5 + 0.5 * Math.sin(w.ticks * 0.05))
    return sameCorridor && Math.abs(ag.x - sweepX) <= 1.2
  }
  if (h.kind === "rockfall" || h.kind === "snowball" || h.kind === "molten") {
    for (var drop = 0; drop < 4; drop++) {
      var dropX = h.zx0 + 0.5 + ((drop * 2.3 + h.fired) % Math.max(1, h.zx1 - h.zx0 + 1))
      var dropY = h.zy0 + ((h.t * 0.55 + drop * 3.1) % Math.max(1, h.zy1 - h.zy0 + 1))
      if (Math.abs(ag.x - dropX) <= 1 && ay >= dropY && ay - (AGENT_H - 1) <= dropY + 1) return true
    }
    return false
  }
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

function hazardPressed(w, h) {
  for (var i = 0; i < w.agents.length; i++) {
    var ag = w.agents[i]
    if (!ag.gone && ag.state !== "saved" && Math.abs(ag.y - h.floorY) <= 2
        && ag.x >= h.zx0 - 0.5 && ag.x <= h.zx1 + 0.5) return true
  }
  for (var ei = 0; ei < w.enemies.length; ei++) {
    var en = w.enemies[ei]
    if (!en.gone && Math.abs(en.y - h.floorY) <= 2
        && en.x >= h.zx0 - 0.5 && en.x <= h.zx1 + 0.5) return true
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
function wreckHazard(w, h) {
  h = h || w.hazard
  if (!h || h.wrecked) return false
  h.wrecked = true
  h.phase = "rest"
  h.lineTo = -1
  addDust(w, (h.zx0 + h.zx1) / 2, (h.zy0 + h.zy1) / 2, 26)
  w.lastEvent = "wrecked"
  return true
}

function hazardMid(h) { return { x: (h.zx0 + h.zx1) / 2, y: (h.zy0 + h.zy1) / 2 } }

function stepOneHazard(w, h) {
  if (!h || h.wrecked) return
  var spec = hazardSpec(h.kind)
  h.t++

  if (spec.mech === "field") {
    hazardStrike(w, h)
    return
  }

  if (spec.mech === "snipe") { stepSniper(w, h, spec); return }

  if (h.phase === "idle") {
    var wake = spec.mech === "watch" ? hazardWatching(w, h, spec)
      : (spec.mech === "plate" ? hazardPressed(w, h) : h.t >= spec.rest)
    if (wake) {
      h.phase = "charge"; h.t = 0
      // A visible wind-up is enough to learn from; discovery no longer always
      // demands that the first agent donate its body to science.
      if (hazardWitnessed(w, h)) { h.known = true; w.hazardKnown = true }
    }

  } else if (h.phase === "charge") {
    // The wind-up is the whole reason a danger is fair. It is drawn, it is
    // long enough to read, and anything with the sense to be somewhere else
    // has that long to get there.
    if (h.t >= spec.charge) {
      h.phase = "fire"
      h.t = 0
      h.fired++
      if (hazardWitnessed(w, h)) { h.known = true; w.hazardKnown = true }
    }

  } else if (h.phase === "fire") {
    hazardStrike(w, h)
    if (h.t >= spec.fire) { h.phase = "rest"; h.t = 0 }

  } else {
    if (h.t >= spec.rest) { h.phase = "idle"; h.t = 0 }
  }
}

function stepHazard(w) {
  for (var hi = 0; hi < w.hazards.length; hi++) stepOneHazard(w, w.hazards[hi])
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
      if (hazardWitnessed(w, h)) { h.known = true; w.hazardKnown = true }
    }

  } else if (h.phase === "fire") {
    var hit = sniperTarget(w, h)
    if (hit && lineClear(w, sx, sy, Math.floor(hit.x), Math.floor(hit.y) - 1)) {
      h.lineTo = hit.x
      h.lineY = hit.y - 1
      // The one shot on the board that can be caught on a plate. It still
      // counts as the danger being seen to work: the colony learns the corridor
      // is lethal from the agent who stopped it, not only from a body.
      if (shieldStops(w, hit, h.zx0 <= hit.x ? h.zx0 - 1 : h.zx1 + 1)) {
        h.known = true; w.hazardKnown = true
        h.phase = "rest"; h.t = 0; h.lineTo = -1; h.targetId = undefined
        return
      }
      addBlood(w, hit.x, hit.y - 1.5, 16)
      hit.gone = true
      hit.state = "dead"
      w.lost++
      h.known = true
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
  var hmid = hazardMid(h)
  for (var i = 0; i < w.agents.length; i++) {
    var ag = w.agents[i]
    if (!hazardCatches(w, h, ag)) continue
    if (shieldStops(w, ag, hmid.x)) { h.known = true; w.hazardKnown = true; continue }
    if (h.kind === "frostjet") {
      if (ag.hazardGrace > 0) continue
      ag.chilledFor = 70
      ag.hazardGrace = 55
      h.known = true
      w.hazardKnown = true
      w.lastEvent = "cold start"
      continue
    }
    addBlood(w, ag.x, ag.y - 1.5, 14)
    ag.gone = true
    ag.state = "dead"
    w.lost++
    h.known = true
    w.hazardKnown = true
    w.hazardKills++
    w.lastEvent = "hazard"
  }
  for (var ei = 0; ei < w.enemies.length; ei++) {
    var en = w.enemies[ei]
    if (!en.gone && hazardCatches(w, h, en)) killEnemy(w, en)
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
// The ground one danger can reach. Geometry only — no phase, no memory — so
// that the two questions the colony actually asks can share it.
function hazardCovers(w, h, ax, footY) {
  var hspec = hazardSpec(h.kind)
  // The sniper's dangerous ground is its current sight line.
  if (h.kind === "sniper") {
    if (h.lineTo === undefined || h.lineTo < 0 || Math.abs(footY - h.zy1) > CORR_H) return false
    var a = Math.min(h.zx0, h.lineTo)
    var b = Math.max(h.zx1, h.lineTo)
    return ax >= a - 1 && ax <= b + 1
  }
  if (h.kind === "sentry" || h.kind === "darts" || h.kind === "frostjet"
      || h.kind === "scarab" || h.kind === "snake") {
    var along = (ax - hazardMid(h).x) * h.dir
    return Math.abs(footY - h.floorY) <= CORR_H && along >= -1 && along <= hspec.reach + 1
  }
  if (h.kind === "echobat")
    return Math.abs(footY - h.floorY) <= CORR_H
        && Math.abs(ax - hazardMid(h).x) <= hspec.reach + 1
  if (footY < h.zy0 - 2 || footY > h.zy1 + 2) return false
  return ax >= h.zx0 - 2 && ax <= h.zx1 + 2
}

// How many ticks this agent would spend inside the reach if it kept walking
// the way it is facing, measured to the far lip rather than to the fixture.
function hazardExposure(w, h, ag) {
  var spec = hazardSpec(h.kind)
  var mid = hazardMid(h).x
  var near = h.dir > 0 ? mid - 1 : mid - spec.reach - 1
  var far = h.dir > 0 ? mid + spec.reach + 1 : mid + 1
  var edge = ag.dir > 0 ? far : near
  return Math.abs(edge - ag.x) / WALK_SPEED
}

// Crossing a `watch` danger is a timing problem rather than a wall, and this is
// the piece of judgement the colony did not have.
//
// One of these sleeps until somebody is inside its reach, takes about a second
// to wind up, fires, and then reloads for two or three. Its reach is eleven to
// sixteen cells and crossing that takes forty to sixty ticks — longer than the
// wind-up and shorter than the reload. So walking in while it sleeps is death
// on a delay, and walking in the moment it has fired is free. Every level with
// one of these across the only corridor was being solved by the colony walking
// in one at a time forever; the answer was always to wait for the shot and then
// leg it, which is what a person does at the same fixture without being told.
var HAZARD_WAIT = 260    // ticks of waiting before somebody tries it regardless

function canCrossHazard(w, h, ag) {
  var spec = hazardSpec(h.kind)
  var need = hazardExposure(w, h, ag) * 1.15
  // Reloading: the window is what is left of the reload.
  if (h.phase === "rest") return (spec.rest - h.t) > need
  // Asleep: only worth it where the whole crossing fits inside a wind-up,
  // which is true of the short-reach fixtures and never of the long ones.
  if (h.phase === "idle") return spec.charge > need
  return false
}

// Home, seen rather than known.
//
// The agents carry no map and no compass: the one non-local thing they have is
// whether the exit is on this floor, above or below, and that is deliberate —
// most of what makes them fun to watch is that they are working it out. But it
// produced one genuinely silly thing. An agent that drops onto the last
// corridor three cells from the exit, facing away, walks eighty cells to the
// dead end, turns, and walks eighty cells back, and on level 4 that is most of
// the clock: the colony lands next to the door and goes for a walk.
//
// A lit doorway at the end of an open corridor is not a map. It is the same
// kind of local sense as "there is a wall two body-lengths ahead", so this is
// eyesight, with the range and the clear line to prove it, and it only ever
// applies on the floor the exit is actually on.
var EXIT_SIGHT = 30

function exitInSight(w, ag) {
  var e = w.exit
  var footY = Math.floor(ag.y)
  if (Math.abs(footY - exitFloor(w)) > 1) return 0
  var ex = e.x + e.w / 2
  var gap = ex - ag.x
  if (Math.abs(gap) > EXIT_SIGHT || Math.abs(gap) < 1) return 0
  if (!lineClear(w, Math.floor(ag.x), footY - 1, Math.floor(ex), footY - 1)) return 0
  return gap > 0 ? 1 : -1
}

function hazardPerceptive(ag) {
  return ag.trait === "cautious" || ag.trait === "tinkerer"
}

// Is the next step into somewhere lethal RIGHT NOW: known about, and winding
// up or firing. This is the question for a decision an agent can take back on
// the following tick, which is what a step is.
function hazardAhead(w, ag, nx) {
  var ax = Math.floor(nx)
  var footY = Math.floor(ag.y)
  for (var hi = 0; hi < w.hazards.length; hi++) {
    var h = w.hazards[hi]
    if (h.wrecked || (!h.known && !hazardPerceptive(ag))
        || (h.phase !== "charge" && h.phase !== "fire")) continue
    if (hazardCovers(w, h, ax, footY)) return true
  }
  return false
}

// Is this spot inside the reach of something the colony has watched kill
// somebody — resting or not.
//
// This is the question nothing was asking, and levels 15 and 19 are what that
// costs. A `watch` danger sleeps until somebody is inside its reach and then
// takes about a second to wind up, and its reach is eleven to sixteen cells —
// wider than an agent can walk out of in that second. So every decision that
// leaves an agent standing inside one is fatal on a delay: a blocker posted at
// the mouth of the zone, a shaft sunk in the middle of it, a drop taken into
// it from the corridor above. The colony was reading the danger correctly and
// then walking round it into the same ground from a different direction, over
// and over, because "is it firing this instant" is the wrong question to ask
// about a place you intend to stay.
function hazardZoneAt(w, x, y, perceptive) {
  for (var i = 0; i < w.hazards.length; i++) {
    var h = w.hazards[i]
    if (h.wrecked || (!h.known && !perceptive)) continue
    if (hazardCovers(w, h, x, y)) return h
  }
  return null
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

// ---------------------------------------------------------------------------
// The bottom of the world
//
// The last corridor gets the one drop on the board with nothing underneath it.
// It cannot go anywhere else. A shaft cut through the bedrock from a higher
// corridor runs through the floor of every corridor beneath it on its way
// down, at whatever column it happened to start at: on level 298 that column
// was where the last corridor starts and where the colony lands, sixteen out
// of sixteen walked straight into it on two attempts running, and the level
// was not winnable at all. Anywhere it CAN be bottomless it is also underneath
// somewhere the colony has to walk — except here, where there is nothing below
// to ruin.
//
// It has to be cut through the bedrock rather than merely deep, because
// dropDepth() scans real terrain and stops at the first solid cell, and
// "nothing down there" is what the whole decision at the lip keys off.
//
// What has changed is the shape. It used to be one hole in one place — three
// cells wide, hard at the near end, on 85% of levels — which is a fine hazard
// and a poor thing to keep meeting, because by the second level you know where
// it is before the board is drawn. Now the level rolls one of:
//
//   none       no hole at all
//   shaft      the old one: narrow, at the near end, on dead ground
//   crossing   on the route between the landing and the exit, anything from a
//              slot the bold step over to a lake nobody crosses without bricks
//
// and a crossing level may get a shaft behind the colony as well.
//
// `crossing` is the one with teeth, and it only works because of the rule that
// went in with it — see edgeAhead, where a bottomless drop with ground on the
// far side now gets bricks instead of a blocker. Putting a hole on the route
// under the OLD rule was tried and measured, and cost twenty-five points of
// all-home: the first agent to reach it planted itself in the only doorway on
// the level and the other fourteen queued up politely behind it.

// What is at the bottom, by biome. Three of the seven stay dry, which is the
// point of doing it per biome at all: a crevasse in the ice and a black hole in
// the rock are the right answer for those, and flooding all seven would make
// this read as a texture swap rather than as somewhere else.
//
// Nothing about the fall changes. The shaft is cut through the bedrock either
// way and an agent that goes in is gone either way — the liquid gives it a
// surface to be gone AT, which is the difference between an event and a sprite
// sliding quietly out of the bottom of the board. It is also what lets the
// Jungle have something living in it.
function pitLiquid(biome) {
  if (biome === "Jungle" || biome === "Ruins") return "water"
  if (biome === "Foundry") return "lava"
  if (biome === "Spaceship") return "coolant"
  return null
}

// Cut the shaft and record it. `openAbove` clears the corridor's headroom over
// the hole and a few cells past each lip as well: a crossing is placed without
// regard for the last corridor's obstacle, and half a bashable wall left
// standing on the very lip of a bottomless drop is an agent that goes through
// it and straight over the edge without ever getting to look.
function cutPit(w, rng, c, x0, x1, openAbove) {
  x0 = Math.max(1, x0)
  x1 = Math.min(COLS - 2, x1)
  if (x1 < x0) return null

  if (openAbove)
    for (var ax = x0 - 4; ax <= x1 + 4; ax++)
      for (var ay = c.floorY - CORR_H; ay < c.floorY; ay++) clearCell(w, ax, ay)

  // setCell rather than clearCell: the bedrock is STEEL and clearCell will not
  // touch it, which is exactly right for every skill and exactly wrong here.
  for (var x = x0; x <= x1; x++)
    for (var y = c.floorY; y < ROWS; y++) setCell(w, x, y, EMPTY)

  var pit = {
    x0: x0,
    x1: x1,
    floorY: c.floorY,
    liquid: pitLiquid(w.biome),
    // Deep enough to be something at the bottom of a hole rather than a lid on
    // it, and never so deep it falls off the board.
    surfaceY: Math.min(ROWS - 3, c.floorY + irand(rng, 7, 12)),
    // Something lives in the swamp. Purely a thing to look at — the water is
    // what kills, and it kills whether or not anyone is home.
    croc: w.biome === "Jungle",
    seed: irand(rng, 0, 9973),
    ripple: -999
  }
  w.pits.push(pit)
  return pit
}

// Rolled after the exit and the wall in front of it are final, because a
// crossing has to know where both of them ended up, and before the floors are
// roughened, which declines to hang dirt over a cell with no floor under it
// and so can never bridge one of these by accident.
function placeBottomPit(w, rng, c, prev, sealFrom) {
  var landing = prev ? prev.handoffX : (c.dir > 0 ? c.x1 : c.x0)
  var roll = rng()
  if (roll < 0.12) return

  var crossing = roll >= 0.52
  if (crossing) crossing = cutCrossing(w, rng, c, landing, sealFrom) !== null

  // A shaft on its own on the levels that rolled one, and behind the colony as
  // well on some of the levels that rolled a crossing — so a level can have
  // both the hole they have to get over and the hole they have to be stopped
  // from walking into.
  if (!crossing || rng() < 0.4) cutShaft(w, rng, c, landing)
}

// The old hole, with two differences. Its width is rolled rather than fixed at
// three, and it runs hard into the side wall instead of leaving a couple of
// cells of floor beyond it.
//
// That last one is not cosmetic. The rule at the lip now asks whether there is
// anything on the far side within a bridge's reach, and a two-cell shelf
// against the wall is an answer to that question: agents would bridge out to
// it, one after another, and the blocker — the one skill whose whole point is
// that somebody gives up going home — would never be posted again. Ending the
// corridor at the wall makes the far side genuinely nothing.
function cutShaft(w, rng, c, landing) {
  // Stop well short of where the colony comes down. The descent from the
  // corridor above lands them near here, and a hole under the landing is not a
  // hazard, it is the level refusing to start.
  var edge = c.dir > 0 ? c.x0 - 1 : c.x1 + 1
  var limit = landing - c.dir * 7
  var room = (limit - edge) * c.dir + 1
  if (room < 3) return null

  var wide = Math.min(room, irand(rng, 3, 9))
  var lo = c.dir > 0 ? edge : edge - wide + 1
  return cutPit(w, rng, c, lo, lo + wide - 1, false)
}

// The hole on the route. Anywhere between the landing and the wall in front of
// the exit, at any width from a stride to a third of the corridor — which is
// the whole of the variety being asked for here, since the two ends of that
// range produce completely different levels: the narrow one splits the colony
// by personality at the lip, and the wide one stops all of them dead until
// somebody lays bricks.
//
// Capped at seventeen because a builder lays twelve bricks two cells apart and
// BUILD_REACH is what that spans. A gap it cannot cross is not a harder level,
// it is an unwinnable one.
function cutCrossing(w, rng, c, landing, sealFrom) {
  var lo, hi
  if (c.dir > 0) { lo = landing + 10; hi = sealFrom - 6 }
  else { lo = sealFrom + 9; hi = landing - 10 }
  lo = Math.max(lo, c.x0 + 2)
  hi = Math.min(hi, c.x1 - 2)
  if (hi - lo + 1 < 9) return null

  // Only where the ceiling above it is intact, and this is the whole ball game.
  //
  // Every chasm, gap and cliff on the corridor ABOVE is cut down to exactly
  // this floor: that floor is what makes them survivable, and an agent that
  // walks into one up there is taking a shortcut, not dying. Cut the floor out
  // from under one and the shortcut becomes a fall out of the world — a second
  // bottomless drop, three floors up, in the middle of a route, which is the
  // one thing the whole placement rule exists to prevent.
  //
  // Level 1 is the worked example. Its crossing landed at 31-40, directly
  // beneath the chasm on the corridor above, and every agent that met that
  // chasm walked into a hole that now went to the bedrock. Across two hundred
  // levels this on its own cost thirty-two points of home.
  //
  // The roof row of a corridor is the one cell above its carved headroom, and
  // if that cell is solid nothing above can come through.
  var roof = c.floorY - CORR_H - 1
  var runs = []
  var open = lo - 1
  for (var x = lo; x <= hi + 1; x++) {
    if (x <= hi && solid(w, x, roof)) continue
    if (x - open > 9) runs.push([open + 1, x - 1])
    open = x
  }
  if (!runs.length) return null

  var span = runs[irand(rng, 0, runs.length - 1)]
  var room = span[1] - span[0] + 1
  var wide = Math.min(irand(rng, 5, 17), room - 2)
  var x0 = irand(rng, span[0] + 1, span[1] - wide)
  var pit = cutPit(w, rng, c, x0, x0 + wide - 1, true)
  if (pit) pit.crossing = true
  return pit
}

// The surface of whatever is in the pit under this column, or null. Only the
// surface matters: the shaft below it is cut through the bedrock, so nothing
// that reaches the liquid was ever going to reach anything else.
function liquidAt(w, x) {
  for (var i = 0; i < w.pits.length; i++) {
    var p = w.pits[i]
    if (p.liquid && x >= p.x0 && x <= p.x1) return p
  }
  return null
}

// The shaft occupying this column, whether flooded or dry. Terrain inside a
// recorded pit is not a landing: builders can reach the board's solid lower
// boundary and pile bricks on it, but that must not turn a bottomless hole
// into a room. Bridges remain valid because their walking surface is above the
// original floorY lip.
function pitAt(w, x) {
  for (var i = 0; i < w.pits.length; i++) {
    var p = w.pits[i]
    if (x >= p.x0 && x <= p.x1) return p
  }
  return null
}

function sink(w, ag, pool) {
  ag.y = pool.surfaceY
  ag.gone = true
  w.lost++
  pool.ripple = w.ticks
  addDust(w, ag.x, pool.surfaceY, 12)
  w.lastEvent = pool.liquid === "lava" ? "slag" : "splash"
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
//
// The floor() is not tidying. `x` arrives as `ag.x`, which is a position and
// almost never a whole number, and `at()` indexes a Uint8Array: a fractional
// index reads `undefined`, `undefined !== EMPTY` is true, so every cell this
// scanned came back solid and the answer was -1 essentially always. That is
// three separate build rules — the one at a gap, the one at a bottomless drop
// and the engineer's whole character — silently switched off, which is why
// bridges were rare enough to look like a personality quirk rather than the
// answer to a hole in the floor. Everything that lays bricks in the game got
// noticeably keener the moment this line changed.
function landingAhead(w, x, footY, dir) {
  x = Math.floor(x)
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

// Is there an actual corridor under this column, rather than merely an exit
// somewhere lower in the level? This is the useful version of "down": a shaft
// here will open onto traversable floor instead of making an arbitrary hole.
function corridorBelow(w, ag) {
  var x = Math.floor(ag.x)
  var footY = Math.floor(ag.y)
  for (var i = 0; i < w.corridors.length; i++) {
    var c = w.corridors[i]
    if (c.floorY <= footY + 2 || x < c.x0 || x > c.x1) continue
    if (solid(w, x, c.floorY)) return c
  }
  return null
}

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
  var footY = Math.floor(ag.y)
  var ax = Math.floor(ag.x) + ag.dir

  // A ladder is the one thing on the board that every agent treats identically
  // — special or not, cautious or brave, climbers left or none. It is also the
  // only way up a wall taller than MAX_CLIMB, and it costs the toolbar
  // nothing, which is the whole of what Stack Overflow contributes.
  if (ladderAt(w, ax, ag.dir, footY)) { startClimb(w, ag); return }

  if (ag.special) { specialAtWall(w, ag); return }
  var mat = at(w, ax, footY)

  // Steel is the one honest "no". Nothing to try, so don't waste a skill on it.
  if (mat === STEEL) { turnAround(w, ag); return }

  var h = wallHeight(w, ax, footY)
  var t = wallThickness(w, ax, footY, ag.dir)
  var trait = traitOf(ag)
  var bashFirst = ag.contrary ? !trait.bashFirst : trait.bashFirst
  // Climbable means: short enough to be worth it, and the top is somewhere
  // inside the level rather than out on the open surface above the earth.
  //
  // "Worth it" depends on where home is. A wall is normally an obstacle, and
  // eight courses is as much of one as an agent will pay a climber for. For an
  // agent BELOW the exit the same wall is not an obstacle at all — it is the
  // only way back to the floor the exit is on — and it is worth every course
  // wallHeight can see. This is the one place the whole colony gets the taller
  // climb, and it is deliberately here, at the wall, rather than in the rescue
  // paths: an agent pacing the bottom of a pit is not next to anything to climb
  // when the director asks, and by the time it is, it has already decided what
  // to do with the wall.
  var wantUp = exitAbove(w, ag)
  var reach = wantUp ? RESCUE_CLIMB : MAX_CLIMB
  var climbable = h <= reach && footY - h >= SKY

  // Bashing is a way THROUGH a wall, and for an agent under the exit there is
  // nothing on the other side of this one worth reaching: the floor it needs is
  // overhead. Left to their traits the brave and the stubborn shoulder into it
  // anyway and tunnel a horizontal gallery along the bottom of the world — the
  // exact behaviour that made a colony dropped below the exit by a runaway
  // charge look like it was digging its own catacomb. Below the exit, over
  // beats through for everybody.
  if (wantUp) bashFirst = false

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
    // Climbers are the scarcest thing on the board and a pit will empty them.
    // A staircase is the other way up, and the one the level has plenty of —
    // so under the exit it comes before the bash rather than after it, and
    // brings its own allowance with it (see willBuild).
    if (wantUp && canStartBuild(w, ag) && take(w, "builder")) { startBuild(w, ag); return }
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

  // The top of a ladder is approached from the wall it rests on, facing out
  // over its drop. It is a route for everybody in both directions, so take it
  // before personality, special moves or the usual judgement about the fall.
  var ladder = ladderDownAt(w, Math.floor(ag.x), ag.dir, footY)
  if (ladder) { startLadderDown(ag, ladder); return }

  // Nothing down there at all. This case has to come first: an umbrella is no
  // help over a shaft with no floor, and checking the floater branch ahead of
  // it is exactly how a floater ends up drifting serenely out of the world.
  var trait = traitOf(ag)

  if (ag.special) { specialAtEdge(w, ag, nx, depth, far); return }

  // Do not drop into something that shoots. A step can be taken back on the
  // next tick and a fall cannot: an agent that goes over the lip lands inside
  // the reach with no say in where, and on levels 15 and 19 that was the
  // single biggest way the colony fed the hazard — the ones that had learned
  // to walk round it at floor level came down into it from the corridor above
  // instead, one after another, all afternoon.
  if (depth !== Infinity
      && hazardZoneAt(w, ax, footY + depth, hazardPerceptive(ag))) {
    // The landing is lethal, but the landing is not necessarily the route. If
    // there is still ground at this height on the far side, stay above the
    // danger and bridge to it. Level 15 is the worked example: every engineer
    // saw both the sentry below and a ledge sixteen cells ahead, but this early
    // return happened before any builder rule could consider the ledge.
    if (far > 2 && canStartBuild(w, ag) && take(w, "builder")) {
      startBuild(w, ag, true)
      return
    }
    turnAround(w, ag)
    return
  }


  if (depth === Infinity) {
    // Two different holes, told apart by the one thing an agent standing at the
    // lip can actually see: whether there is anything on the far side.
    //
    // Nothing within a bridge's reach means this is the end of the world as far
    // as this agent is concerned, and the blocker is the right answer — stand
    // in it, turn the rest around, and cost the level nothing, because a hole
    // like that is only ever cut into ground the route does not use.
    //
    // Ground on the far side means it is a gap, and a gap is something to get
    // over. The blocker is the WORST answer there: it is permanent, it plants
    // itself in the doorway, and the level ends with fourteen agents queued
    // politely behind one of their own. So bricks come first now, and the
    // blocker is kept for the drop that has no far side at all.
    //
    // The old rule reached for the blocker first either way. That was safe only
    // while the one bottomless hole on the board was always behind the colony;
    // it is not any more — see placeBottomPit.
    if (far > 2 && canStartBuild(w, ag, true) && take(w, "builder")) { startBuild(w, ag, true); return }
    if (far <= 2 && countComing(w, ag) >= 2 - trait.blockBias && take(w, "blocker")) { ag.state = "block"; return }
    turnAround(w, ag)
    return
  }

  // A gap with the far side in reach is what a builder is for. Where the line
  // sits between "bridge this" and "just step off" is the clearest thing
  // personality does to an agent's behaviour: a cautious one bridges a drop a
  // brave one walks straight off, and you can watch them disagree about the
  // same ledge, one after the other.
  //
  // But only where down is not the way on. On every corridor above the last,
  // the drop in front is a floor gained — an agent that bridges it has spent a
  // builder to stay exactly where it was, and left a ledge and a wall behind
  // for the next one to get stuck on. Measured over two hundred levels that is
  // eight points of home and a third again on the clock, for a bridge that
  // achieves nothing. On the exit's own floor there is nothing below to gain
  // and a drop is pure loss, which is where bricks earn their keep.
  if (far > 2 && !exitBelow(w, ag) && depth > trait.bridgeAt + ag.bridgeBias
      && canStartBuild(w, ag) && take(w, "builder")) { startBuild(w, ag); return }

  // The umbrella comes out early for the ones who like a margin. It can only
  // ever come out EARLIER than the lethal limit, never later — a personality
  // that gets its owner killed isn't a personality, it's a bug.
  // The engineer's whole character. Anyone else facing a drop this deep reaches
  // for the umbrella; it looks for something to build to first, and only takes
  // the chute when there is nothing on the far side worth reaching.
  //
  // "This deep" is the point, and it was missing: with no depth test at all
  // this fired at every ledge on the board, and an engineer lays five. One or
  // two per colony spent the level paving the corridors they were supposed to
  // be descending. The test is the same one the umbrella is about to make, so
  // the two really are alternatives to the same problem.
  if (trait.noFloat && far > 2 && depth > SAFE_FALL - trait.fallMargin
      && canStartBuild(w, ag) && take(w, "builder")) { startBuild(w, ag); return }

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
// The way on is up.
//
// Every other escape in this file is horizontal or downward, because that is
// what the level normally asks for: the serpentine descends, and the exit sits
// on the last corridor. An agent BELOW that floor has fallen into a pit, ridden
// a shaft to the bedrock, or been dropped there by somebody else's charge, and
// for it every rule in the brain points the wrong way.
//
// What it had was a climb of eight courses or less, which is the height of an
// ordinary obstacle and never the height of a pit — so the rescue offered
// nothing and the agent paced the bottom of the hole until the level timed out.
// This will take a wall as tall as wallHeight can see, on either side, and it
// looks both ways for one: the wall that gets an agent out is rarely the one it
// happens to be facing.
//
// Only ever from a rescue path. An ordinary agent still turns at anything over
// MAX_CLIMB, or the whole colony would scale every wall on the board and the
// obstacles would stop meaning anything.
var RESCUE_CLIMB = 16    // as far up as wallHeight looks; past that there is no top

function climbOut(w, ag, spend) {
  if (!exitAbove(w, ag)) return false
  var footY = Math.floor(ag.y)
  for (var side = 0; side < 2; side++) {
    var dir = side === 0 ? ag.dir : -ag.dir
    var ax = Math.floor(ag.x) + dir
    if (!solid(w, ax, footY)) continue
    if (wallHeight(w, ax, footY) > RESCUE_CLIMB) continue
    if (!spend(w, "climber")) return false
    ag.dir = dir
    ag.idle = 0
    startClimb(w, ag)
    return true
  }
  return false
}

function considerEscape(w, ag) {
  // A corridor immediately below is stronger evidence than ordinary pacing.
  // Try down one turnaround sooner instead of asking every personality to walk
  // the whole gallery quite as many times before considering its shovel.
  var below = exitBelow(w, ag) && corridorBelow(w, ag)
  var turnLimit = below ? Math.max(1, traitOf(ag).turnLimit - 1) : traitOf(ag).turnLimit
  if (ag.turns < turnLimit) return false
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
    if (charge && canPlantMine(w, ag) && take(w, "miner")) { plantMine(w, ag); return true }
    if (take(w, "digger")) { ag.state = "dig"; ag.timer = 0; return true }
    if (canPlantMine(w, ag) && take(w, "miner")) { plantMine(w, ag); return true }
    return false
  }

  // Up the wall if there is one worth taking, and build a way up if there is
  // not. The climb comes first: it costs one skill and gains sixteen courses,
  // where a build costs one and gains four.
  if (climbOut(w, ag, take)) return true
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
  ag.climbDown = false
  ag.timer = 0
}

function startLadderDown(ag, ladder) {
  ag.state = "climb"
  ag.climbDown = true
  ag.dir = ladder.side
  ag.x = ladder.x - ladder.side + 0.5
  // Get the feet just below the top surface so ladderAt can identify the face
  // on the first descending tick without a visible jump.
  ag.y = ladder.top + CLIMB_SPEED
  ag.timer = 0
}

function startBuild(w, ag, flat) {
  // Below a raised exit, a build is a staircase home rather than a bridge over
  // whatever happens to be in front. Every caller means the same thing here,
  // so settle the direction once instead of letting wall, pacing and director
  // paths disagree about it.
  if (exitAbove(w, ag)) {
    var exitMid = w.exit.x + w.exit.w / 2
    if (Math.abs(exitMid - ag.x) > 1) ag.dir = exitMid > ag.x ? 1 : -1
  }
  ag.state = "build"
  ag.bricks = 12
  ag.buildWait = 0
  ag.timer = 0
  // Lay level rather than climbing. A bridge normally gains a course every
  // third brick, which is what gives a build its staircase look — and over a
  // hole with the far side at the same height it is exactly wrong: twelve
  // bricks gain four courses, a corridor has six, and the build ends with the
  // builder's head in the ceiling a few cells short of the far lip. That was a
  // quarter of every bridge started at a crossing.
  ag.buildFlat = !!flat
  ag.built++
  w.buildSites.push({ x: ag.x, y: ag.y, tick: w.ticks })
}

// An agent that has already laid two bridges has stopped solving anything and
// started building on its own brickwork: every bridge leaves a new ledge and a
// new wall, which reads to the next decision as another obstacle worth
// bridging. Left uncapped, the keen ones spend a whole level constructing a
// private folly, and the earth they add is what the ones behind them then get
// stuck on.
// The cap is there because every bridge leaves a new ledge and a new wall for
// the next agent to treat as an obstacle, and two per agent is where that stops
// paying. An agent under the exit is the exception: it is not bridging a gap it
// could have walked round, it is building the only staircase out of a hole, and
// one build gains six courses where the hole is twelve deep. Two more, and only
// while it is down there.
function willBuild(ag, wantUp) {
  return ag.built < traitOf(ag).buildCap + (wantUp ? 2 : 0)
}

// Let one builder finish (or visibly fail) before another edits the same
// ledge. This is intentionally short-lived shared evidence, not a route plan:
// after eight seconds the colony is free to disagree and try the site again.
// Without it, a queue can spend a dozen builders on the same few cells before
// the first bridge has even settled into terrain.
// `urgent` is for the one place where a half-finished bridge is worse than no
// bridge at all: the lip of a drop with nothing at the bottom of it. Everywhere
// else a build that stops short is a ledge somebody walks round, and the lock
// below is what stops a queue spending a dozen builders on the same few cells.
// At a bottomless gap there is nothing to walk round — the agent that arrives
// eight seconds too early to be allowed to add the last two bricks turns away,
// paces, and gets written off with the gap still open in front of it.
//
// So the lip gets a shorter rule rather than no rule. The eight-second memory
// is what has to go; "somebody is laying bricks here RIGHT NOW" does not, and
// dropping that too was visible on level 5, where two agents arriving together
// started the same bridge four ticks apart and one of the two builders was
// simply thrown away. A queue at a lip should watch the first one work and then
// pick up wherever it stopped.
function canStartBuild(w, ag, urgent) {
  if (!willBuild(ag, exitAbove(w, ag))) return false
  if (urgent) return !someoneBuildingNear(w, ag)
  for (var i = w.buildSites.length - 1; i >= 0; i--) {
    var site = w.buildSites[i]
    if (w.ticks - site.tick > 240) break
    if (Math.abs(site.y - ag.y) < 4 && Math.abs(site.x - ag.x) < 8) return false
  }
  return true
}

// Is one of the others putting bricks down within sight of here, this tick?
// Unlike the site list this forgets the moment they stop, which is the whole
// point of it: the ledge is evidence while it is being worked on and nothing at
// all afterwards.
function someoneBuildingNear(w, ag) {
  for (var i = 0; i < w.agents.length; i++) {
    var O = w.agents[i]
    if (O === ag || O.gone || O.state !== "build") continue
    if (Math.abs(O.y - ag.y) < 5 && Math.abs(O.x - ag.x) < 12) return true
  }
  return false
}

function spawn(w) {
  // Drawn from the world's own stream, which is seeded per playthrough: level
  // 42 is the same level every time and never the same colony twice. Which one
  // is the stubborn one, and how far down the queue it is, is the difference
  // between watching a level again and watching a recording of it.
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
    ropeY: 0,
    heightMode: "",
    heightTick: 0,
    heightTicks: 0,
    heightFromX: 0,
    heightFromY: 0,
    heightToX: 0,
    heightToY: 0,
    heightUp: false,
    specialX: 0,
    specialY: 0,
    modelGen: 0,
    limitedFor: 0,
    limitedBy: 0,
    flipTicks: 0,
    wounds: 0,
    stunFor: 0,
    shoveCool: 0,
    hazardGrace: 0,
    chilledFor: 0,
    shotTo: 0,        // where a camped sniper's last shot went, for the tracer
    shotY: 0,
    shotFor: 0,
    escapeFloors: {},  // a special may cut one rescue shaft per corridor
    escapeTunnels: {}, // and one body-height rescue tunnel per corridor
    rescueCool: 0,     // do not reconsider the same escape every simulation tick
    markD: Infinity,   // closest it has ever been; see goalDist()
    fuse: 0,
    waitFor: 0,       // holding at a danger for its reload, rather than pacing
    mineCool: 0,      // one charge at a time, and not again until it has gone off
    shieldFor: 0,     // ticks left on the plate; renewed while a threat is in front
    shieldHeld: 0,    // how long it has been up for, which is what tires it out
    blockFor: 0,      // ticks of the spark from the last thing it stopped
    coveredFor: 0,    // ticks since it was last inside somebody's cover
    blocked: 0,
    anim: Math.floor(Math.random() * 8),
    gone: false,
    fade: 0
  }
}

// ---------------------------------------------------------------------------
// Per-state updates
// ---------------------------------------------------------------------------

function stepWalk(w, ag) {
  var nx = ag.x + ag.dir * WALK_SPEED * (ag.chilledFor > 0 ? 0.48 : 1)
  var cx = Math.floor(nx)
  var footY = Math.floor(ag.y)

  // Turn toward a door it can see. Only when it is walking away from one, so
  // this steers rather than drives: everything else about the crossing — walls,
  // drops, dangers, personality — is decided exactly as before.
  var seen = exitInSight(w, ag)
  if (seen && seen !== ag.dir) {
    ag.dir = seen
    ag.turns = 0
    nx = ag.x + ag.dir * WALK_SPEED * (ag.chilledFor > 0 ? 0.48 : 1)
    cx = Math.floor(nx)
  }

  if (anyBlockerNear(w, ag, nx)) { turnAround(w, ag); return }

  // About to step from clear ground into something it has watched kill
  // somebody. This is not the same question as hazardAhead's — the fixture is
  // resting, so nothing is firing — it is whether the crossing can be finished
  // before it wakes up. Wait at the lip if it cannot, and take the window when
  // it comes.
  //
  // Somebody still has to find out, and a sleeping fixture never reloads on its
  // own: after HAZARD_WAIT of nobody getting anywhere, the one at the front
  // walks in regardless. It usually dies, the rest cross in the reload it just
  // bought them, and that is as close to a plan as this colony gets.
  var crossPerceptive = hazardPerceptive(ag)
  var stepInto = hazardZoneAt(w, cx, footY, crossPerceptive)
  if (stepInto && stepInto.known && !ag.special
      && !hazardZoneAt(w, Math.floor(ag.x), footY, crossPerceptive)
      && !shieldCovering(w, ag, nx)
      && !canCrossHazard(w, stepInto, ag)) {
    // Once the danger has proved itself, use the safe floor directly below
    // when there is one. Previously the queue waited at the scarab on level
    // 254 until HAZARD_WAIT expired, then deliberately repeated the first
    // agent's mistake; some arrived as hops or umbrella falls, which made the
    // shared knowledge look especially fake. A shaft is both safer and the
    // shortest honest route onward through a descending level.
    if (exitBelow(w, ag) && corridorBelow(w, ag)
        && solid(w, Math.floor(ag.x), footY + 1)
        && at(w, Math.floor(ag.x), footY + 1) !== STEEL
        && take(w, "digger")) {
      ag.state = "dig"
      ag.timer = 0
      ag.idle = 0
      ag.still = 0
      return
    }
    ag.waitFor = 12
    turnAround(w, ag)
    return
  }
  if (stepInto && !ag.special && ag.idle < HAZARD_WAIT
      && !hazardZoneAt(w, Math.floor(ag.x), footY, crossPerceptive)
      && !shieldCovering(w, ag, nx)
      && !canCrossHazard(w, stepInto, ag)) {
    // Waiting is not pacing. Both look like an agent walking back and forth in
    // one place, and the loop detector cannot tell them apart — so on level 15
    // the colony stopped dying to the sentry and started being written off as
    // stuck instead, bombed one at a time at the lip of the zone it was
    // correctly refusing to enter. This says: it knows why it is here.
    ag.waitFor = 12
    turnAround(w, ag)
    return
  }

  // Somewhere it has learned is lethal. Treated exactly like a drop with no
  // bottom, because to an agent it is the same problem: a place ahead that
  // ends you, and others behind you walking towards it. The first one to
  // arrive stands and turns the rest around, and it costs the level nothing,
  // because a danger is only ever put on ground the route does not need.
  //
  // Before anyone has seen the thing fire this is all inert and they walk in
  // as confidently as they walk anywhere. Somebody has to find out.
  if (hazardAhead(w, ag, nx)) {
    // Two ways past a live danger that are not "turn round". Ada Blocker
    // raises the plate and keeps walking; anybody already in its lee walks on
    // because the thing ahead cannot reach them, which is the only time in
    // this game a colony crosses known-lethal ground on purpose.
    // The margin matters more than the cover does. An agent that follows a
    // shield into a danger zone and is still inside it when the plate comes
    // down has been led into exactly the place it spent the whole level
    // avoiding — so nobody steps in on the strength of a shield that is nearly
    // out of hold, the one holding it included.
    var mine = ag.special && specOf(ag).act === "shield"
    if (mine && ag.shieldHeld < SHIELD_MAX - SHIELD_MARGIN
        && (ag.shieldFor > 0 || raiseShield(w, ag))) return advanceWalk(w, ag, nx, cx, footY)
    var cover = mine ? null : shieldCovering(w, ag, nx)
    if (cover && cover.shieldHeld < SHIELD_MAX - SHIELD_MARGIN) return advanceWalk(w, ag, nx, cx, footY)

    var htrait = traitOf(ag)
    var perceptive = hazardPerceptive(ag)

    // Already inside its reach. Turning round is the answer at a wall, and
    // here it is a coin toss between walking out of the zone and walking
    // further into it — and since the reach is wider than the wind-up is long,
    // walking further in is fatal. Head away from the fixture, whichever way
    // that is, and keep going until the ground is clear.
    var inside = hazardZoneAt(w, Math.floor(ag.x), footY, perceptive)
    if (inside) {
      // Out by the nearer lip, which is not always the way it came in: an
      // agent four fifths of the way across a sixteen-cell reach should finish
      // the crossing, not turn round and re-run the whole thing.
      var hspec = hazardSpec(inside.kind)
      var hmid = hazardMid(inside).x
      var lipBack = inside.dir > 0 ? hmid - 1 : hmid + 1
      var lipOn = inside.dir > 0 ? hmid + hspec.reach + 1 : hmid - hspec.reach - 1
      var out = Math.abs(lipOn - ag.x) < Math.abs(lipBack - ag.x) ? lipOn : lipBack
      var away = out > ag.x ? 1 : -1
      if (ag.dir !== away) { ag.dir = away; ag.turns++ }
      var outX = ag.x + ag.dir * WALK_SPEED
      return advanceWalk(w, ag, outX, Math.floor(outX), footY)
    }

    // A timed hazard may consume several blockers as each sacrifice is
    // eventually killed. Keep the final one for a true bottomless edge, where
    // a single permanent blocker protects everyone who follows. Level 92's
    // bear trap used to empty the toolbar just before its last-floor void.
    //
    // And never inside the reach itself. A blocker cannot move, so one posted
    // in the zone is a body on a timer: it turns the queue back for a few
    // seconds, gets shot, and the level pays another blocker for the same few
    // seconds. Standing one step outside does the same job and survives it.
    if ((w.skills.blocker || 0) > 1
        && countComing(w, ag) >= 2 - htrait.blockBias
        && !hazardZoneAt(w, Math.floor(ag.x), footY, perceptive)
        && take(w, "blocker")) { ag.state = "block"; return }
    turnAround(w, ag)
    return
  }

  advanceWalk(w, ag, nx, cx, footY)
}

// The step itself, once the decisions above have let it happen. Split out so
// that walking on under cover takes the same route through the ground rules as
// walking on anywhere else — a shielded agent still meets walls, steps and
// edges exactly like everybody, it just no longer treats the danger as one.
function advanceWalk(w, ag, nx, cx, footY) {
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

  if (!headroom(w, cx, targetY)) {
    // A low roof is different from a wall. If feet and shoulders fit, duck
    // into it with a short forward skid and stand as soon as the roof opens.
    if (targetY === footY && !solid(w, cx, footY) && crouchroom(w, cx, footY)) {
      ag.state = "slide"
      ag.timer = 0
      ag.still = 0
      return
    }
    hitWall(w, ag)
    return
  }

  ag.x = nx
  ag.y = targetY
  ag.anim++
}

function stepFall(w, ag) {
  var speed = ag.floater && ag.fall > 2 ? FLOAT_SPEED : FALL_SPEED
  var cx = Math.floor(ag.x)
  var ny = ag.y + speed

  // Several agents can already be in the air when the first one lands in a
  // trap and teaches the colony about it. An ordinary fall is committed, but
  // an open umbrella is steerable: drift out of newly-known reach instead of
  // serenely floating into the same place after the warning has arrived.
  if (ag.floater) {
    var airDanger = hazardZoneAt(w, cx, Math.floor(ny), false)
    if (airDanger) {
      var away = ag.x < hazardMid(airDanger).x ? -1 : 1
      var driftX = ag.x + away * WALK_SPEED * 0.7
      if (!solid(w, Math.floor(driftX), Math.floor(ag.y) - 1)) {
        ag.x = driftX
        cx = Math.floor(ag.x)
      }
    }
  }

  // Into the water, the coolant or the slag. This changes nothing about who
  // survives — the shaft under the surface is cut through the bedrock, and an
  // umbrella was never any use over it — it changes where they stop, which is
  // the entire point of putting a surface down there.
  var pool = liquidAt(w, cx)
  if (pool && ny >= pool.surfaceY) { sink(w, ag, pool); return }

  var shaft = pitAt(w, cx)

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
    // Bricks or moved terrain below a pit's lip are debris in a bottomless
    // shaft, not a floor. Without this, level 13's agents built off the board
    // boundary, landed on row 61, and paced around inside the pit.
    if (shaft && yy >= shaft.floorY) continue
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
  var ladder = ag.climbDown
    ? ladderRideAt(w, wallX, ag.dir, footY)
    : ladderAt(w, wallX, ag.dir, footY)

  if (ag.climbDown) {
    // If somebody removes the supporting wall, stepLadders will take the
    // ladder down too. Let go rather than descending an object that is no
    // longer there.
    if (!ladder) { ag.climbDown = false; beginUncontrolledFall(w, ag); return }
    ag.y += CLIMB_SPEED
    ag.anim++
    if (ag.y >= ladder.bottom) {
      ag.y = ladder.bottom
      ag.state = "walk"
      ag.climbDown = false
      ag.dir = -ladder.side
      ag.turns = 0
    }
    return
  }

  // Head into a ceiling: nothing above to climb onto, so let go. Counts as a
  // failed attempt — an agent that keeps trying the same wall should end up
  // concluding the way on is somewhere else. A ladder is the exception: its
  // whole promise is a route up this face, including through an overhang on
  // the approach side. The top still needs headroom before the agent can haul
  // over, so this only permits the climb itself through the obstruction.
  if (!ladder && solid(w, Math.floor(ag.x), footY - AGENT_H)) {
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
  //
  // Steeper when the exit is overhead. Every third brick is the right pitch for
  // crossing a gap, which is what a bridge is normally for; for an agent under
  // the exit the bridge IS the way up, and at that pitch a whole build gains
  // four courses and the cap allows two builds. That is not a way out of a pit.
  var ny = ag.y
  var rise = exitAbove(w, ag) ? 2 : 3
  if (!ag.buildFlat && (ag.bricks % rise) === 0
      && headroom(w, Math.floor(nx), Math.floor(ag.y) - 1)) ny = ag.y - 1

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

// Would a charge here achieve anything a charge is for?
//
// Two ways it does not, and level 9 found both at once. A sentinel pinned in
// one cell between a piston and a wall turned round every tick, and every turn
// asked for an escape: it planted six charges on the same cell inside twenty
// ticks, which is the level's entire miner budget spent on one hole. And each
// one after the first had no floor left to sit on — it fell down the shaft the
// last one opened and detonated wherever it landed, so the six of them chewed
// a chimney from the corridor floor to the bedrock and dropped the colony
// twenty cells below the exit, where nothing in the brain knows how to get
// back up.
//
// A charge is a decision about the floor under an agent, so: one at a time,
// nowhere near a live one, and not again from the same agent until the last
// one has gone off and the dust has settled.
function canPlantMine(w, ag) {
  if (ag.mineCool > 0) return false
  var cx = Math.floor(ag.x)
  var cy = Math.floor(ag.y) + 1
  if (!solid(w, cx, cy) || at(w, cx, cy) === STEEL) return false
  for (var i = 0; i < w.mines.length; i++) {
    var m = w.mines[i]
    if (Math.abs(m.x - cx) <= MINE_RADIUS && Math.abs(m.y - cy) <= MINE_RADIUS) return false
  }
  return true
}

function plantMine(w, ag) {
  var cx = Math.floor(ag.x)
  var cy = Math.floor(ag.y) + 1
  ag.mineCool = MINE_FUSE + 60
  w.mines.push({ x: cx, y: cy, fuse: MINE_FUSE })
  w.lastUsed.miner = w.ticks
  w.lastEvent = "mine planted"
  ag.state = "walk"
  ag.timer = 0
  ag.idle = 0
  ag.turns = 0
  ag.dir = -ag.dir
}

// ---------------------------------------------------------------------------
// Ladders
//
// A ladder is not terrain. It is a note pinned to one face of one wall saying
// "this one is free", which is why it can exist at all: the three earth
// materials have to stay interchangeable (see check-core-refs and `sim inert`),
// and a fourth that changed behaviour would end that. Nothing about the wall
// changes. What changes is what an agent decides when it meets it.
// ---------------------------------------------------------------------------

function ladderAt(w, x, side, footY) {
  for (var i = 0; i < w.ladders.length; i++) {
    var l = w.ladders[i]
    if (l.x === x && l.side === side && footY <= l.bottom && footY > l.top) return l
  }
  return null
}

function ladderRideAt(w, x, side, footY) {
  for (var i = 0; i < w.ladders.length; i++) {
    var l = w.ladders[i]
    if (l.x === x && l.side === side && footY >= l.top && footY <= l.bottom) return l
  }
  return null
}

function ladderDownAt(w, x, dir, footY) {
  for (var i = 0; i < w.ladders.length; i++) {
    var l = w.ladders[i]
    if (l.x === x && dir === -l.side && footY === l.top) return l
  }
  return null
}

function stepLadders(w) {
  for (var i = w.ladders.length - 1; i >= 0; i--) {
    var l = w.ladders[i]
    if (l.t < 14) l.t++

    // The face it leans on can be bashed through, dug out or blown away by
    // somebody working on the other side of it. A ladder up a wall that is no
    // longer there is a ladder to nowhere, and worse than nowhere: the agents
    // reading it would queue at a hole to climb something.
    var broken = false
    for (var y = l.top + 1; y <= l.bottom; y++) if (!solid(w, l.x, y)) { broken = true; break }
    if (broken) w.ladders.splice(i, 1)
  }
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
    for (var ei = 0; ei < w.enemies.length; ei++) {
      var en = w.enemies[ei]
      if (!en.gone && Math.abs(en.x - mine.x) <= MINE_RADIUS
          && Math.abs(en.y - mine.y) <= MINE_RADIUS) killEnemy(w, en)
    }
    for (var hi = 0; hi < w.hazards.length; hi++) {
      var hm = hazardMid(w.hazards[hi])
      if (Math.abs(hm.x - mine.x) <= MINE_RADIUS && Math.abs(hm.y - mine.y) <= MINE_RADIUS)
        wreckHazard(w, w.hazards[hi])
    }
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
    var pool = liquidAt(w, Math.floor(ag.x))
    if (pool && ny >= pool.surfaceY) { sink(w, ag, pool); return }
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

  for (var ei = 0; ei < w.enemies.length; ei++) {
    var enemy = w.enemies[ei]
    if (!enemy.gone && Math.abs(enemy.x - ag.x) <= BOMB_RADIUS
        && Math.abs(enemy.y - ag.y) <= BOMB_RADIUS) killEnemy(w, enemy)
  }
  for (var hi = 0; hi < w.hazards.length; hi++) {
    var hm = hazardMid(w.hazards[hi])
    if (Math.abs(hm.x - ag.x) <= BOMB_RADIUS && Math.abs(hm.y - ag.y) <= BOMB_RADIUS)
      wreckHazard(w, w.hazards[hi])
  }

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

// Stack Overflow's rungs, and how tall a wall is still worth leaning them on.
// Past this the wall is somebody else's problem: a ladder to the ceiling is a
// long climb to a place with nothing on it.
var LADDER_MAX = 16

// Ada Blocker's plate: how long it stays up, and how far the cover behind it
// reaches. Four cells is about three agents in a queue, which is the point —
// the shield is worth more to the ones following than to the one holding it.
var SHIELD_HOLD = 60     // ticks the plate stays up after the last sight of a threat
var SHIELD_MAX = 380     // and the longest it can be held before its arms give out
var SHIELD_COVER = 4
var SHIELD_MARGIN = 120  // hold that must be left before anybody steps in behind it

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
  var fy = Math.floor(ag.y)
  for (var hi = 0; hi < w.hazards.length; hi++) {
    var h = w.hazards[hi]
    if (h.wrecked) continue
    var hm = hazardMid(h)
    if (Math.abs(hm.y - fy) <= CORR_H + 2
        && lineClear(w, Math.floor(ag.x), fy - 2, Math.round(hm.x), Math.round(hm.y))) return true
  }
  return false
}

// Is the danger in front of it, within range?
function hazardIsAhead(w, ag, reach) {
  for (var hi = 0; hi < w.hazards.length; hi++) {
    var h = w.hazards[hi]
    if (h.wrecked) continue
    var ahead = (hazardMid(h).x - ag.x) * ag.dir
    if (ahead > 0 && ahead <= reach) return true
  }
  return false
}

function specialCountersHazard(w, ag, act) {
  if (ag.cool > 0) return false
  var electronic = ["gun", "sentry", "darts", "tesla", "turret", "sniper", "lasergrid",
    "sweeper", "tripwire", "fence", "servo", "packetloss"]
  var frozen = ["snowball", "icicle", "frostjet", "blackice"]
  for (var hi = 0; hi < w.hazards.length; hi++) {
    var h = w.hazards[hi]
    if (h.wrecked) continue
    var hm = hazardMid(h)
    if (Math.abs(hm.y - ag.y) > CORR_H + 2 || Math.abs(hm.x - ag.x) > 7) continue
    var counters = (act === "sap" && electronic.indexOf(h.kind) >= 0)
      || (act === "melt" && frozen.indexOf(h.kind) >= 0)
      || (act === "slab" && hazardSpec(h.kind).mech === "field")
    if (!counters) continue
    ag.dir = hm.x >= ag.x ? 1 : -1
    wreckHazard(w, h)
    ag.cool = specOf(ag).cool
    w.lastEvent = act === "sap" ? "prompt accepted" : (act === "melt" ? "thawed" : "contained")
    return true
  }
  return false
}

function stepCamp(w, ag) {
  // Shot out from under. It comes down, and picks a new position from wherever
  // it lands rather than hanging in the air where the deck used to be.
  if (unsupported(w, ag)) { beginUncontrolledFall(w, ag); return }

  if (ag.cool > 0) return
  var spec = specOf(ag)
  var fx = Math.floor(ag.x)
  var fy = Math.floor(ag.y)

  // Red-team agents are live targets just like machinery, but bodies are
  // nearer and smaller: take the closest visible one before returning to the
  // slow work of opening terrain.
  var redTarget = null, redDist = Infinity
  for (var rei = 0; rei < w.enemies.length; rei++) {
    var red = w.enemies[rei]
    if (red.gone || Math.abs(red.y - ag.y) > (red.kind === "drone" ? 14 : 3)) continue
    var rd = Math.abs(red.x - ag.x)
    if (rd >= redDist || !lineClear(w, fx, fy - 2, Math.floor(red.x), Math.floor(red.y) - 2)) continue
    redTarget = red; redDist = rd
  }
  if (redTarget) {
    ag.dir = redTarget.x >= ag.x ? 1 : -1
    ag.shotTo = redTarget.x
    ag.shotY = redTarget.y - 2
    ag.shotFor = 12
    killEnemy(w, redTarget)
    ag.cool = spec.cool
    return
  }

  // The danger, at any distance, provided the line is clear.
  var visibleHazard = null, visibleHazardDist = Infinity
  for (var hi = 0; hi < w.hazards.length; hi++) {
    var h = w.hazards[hi]
    if (h.wrecked) continue
    var hm = hazardMid(h)
    var hd = Math.abs(hm.x - ag.x)
    if (hd < visibleHazardDist && Math.abs(hm.y - fy) <= CORR_H + 2
        && lineClear(w, fx, fy - 2, Math.round(hm.x), Math.round(hm.y))) {
      visibleHazard = h; visibleHazardDist = hd
    }
  }
  if (visibleHazard) {
    var vhm = hazardMid(visibleHazard)
    ag.dir = vhm.x >= ag.x ? 1 : -1
    ag.shotTo = vhm.x
    ag.shotY = vhm.y
    ag.shotFor = 12
    wreckHazard(w, visibleHazard)
    ag.cool = spec.cool
    return
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

  // Ada Blocker has no move for a wall — its move is for what a wall cannot
  // help with. Turning at one must not spend the cooldown, or it arrives at
  // the danger it exists for with the plate still on its back.
  if (spec.act === "shield") { turnAround(w, ag); return }

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

// Let go without falling: the crawler leaves a web fixed to the last piece of
// roof it held and lowers itself from there. Ceiling movement stores `y` as
// the top of the hanging body; every other vertical state stores the feet, so
// convert between the two here once rather than teaching the rest of the
// simulation a second coordinate convention.
function startRappel(w, ag) {
  ag.ropeY = Math.floor(ag.y) - 1
  ag.y = Math.floor(ag.y) + AGENT_H - 1
  ag.state = "rappel"
  ag.timer = 0
}

function stepRappel(w, ag) {
  var cx = Math.floor(ag.x)
  var ny = ag.y + RAPPEL_SPEED

  // A web needs an anchor. If somebody removes the roof while the crawler is
  // descending, it becomes an ordinary fall from its current position.
  if (!solid(w, cx, ag.ropeY)) {
    beginUncontrolledFall(w, ag)
    return
  }

  if (ny >= ROWS) {
    ag.gone = true
    w.lost++
    w.lastEvent = "fell"
    return
  }

  for (var yy = Math.floor(ag.y) + 1; yy <= Math.floor(ny) + 1; yy++) {
    if (!solid(w, cx, yy)) continue
    ag.y = yy - 1
    ag.state = "walk"
    ag.timer = 0
    return
  }

  ag.y = ny
  ag.timer++
  ag.anim++
}

// A crawler trapped below a usable ledge does not reach for the communal
// shovel. It fires a web at the nearest clear landing above and reels itself
// up the line. Searching by rise first favours the lip of the current hole
// over an unrelated platform near the top of the board.
function startWebEscape(w, ag) {
  var fx = Math.floor(ag.x)
  var fy = Math.floor(ag.y)
  for (var rise = 4; rise <= 30; rise++) {
    var ty = fy - rise
    for (var side = 0; side <= 10; side++) {
      for (var sign = -1; sign <= 1; sign += 2) {
        if (side === 0 && sign > -1) continue
        var tx = fx + side * sign
        if (!solid(w, tx, ty + 1) || solid(w, tx, ty) || !headroom(w, tx, ty)) continue
        if (!lineClear(w, fx, fy - 2, tx, ty - 2)) continue
        ag.specialX = tx + 0.5
        ag.specialY = ty
        ag.dir = ag.specialX >= ag.x ? 1 : -1
        ag.state = "webup"
        ag.timer = 0
        ag.cool = specOf(ag).cool
        ag.still = 0
        return true
      }
    }
  }
  return false
}

function stepWebEscape(w, ag) {
  var dx = ag.specialX - ag.x
  var dy = ag.specialY - ag.y
  var dist = Math.sqrt(dx * dx + dy * dy)
  if (dist <= WEB_ASCEND_SPEED) {
    ag.x = ag.specialX
    ag.y = ag.specialY
    ag.state = "walk"
    ag.timer = 0
    ag.turns = 0
    ag.idle = 0
    return
  }
  ag.x += dx / dist * WEB_ASCEND_SPEED
  ag.y += dy / dist * WEB_ASCEND_SPEED
  ag.timer++
  ag.anim++
}

// Cast a line from the lip of a drop to the roof directly above the open
// column. This is separate from startCeiling(): rappelling is how the crawler
// goes down, not another terrain-crossing trick, so an earlier roof walk must
// not leave it stranded at a shaft while that move's cooldown expires.
function rappelAtEdge(w, ag, nx, depth) {
  if (depth === Infinity || depth <= SAFE_FALL) return false
  var cx = Math.floor(nx)
  var footY = Math.floor(ag.y)

  for (var cy = footY - AGENT_H; cy > SKY; cy--) {
    if (!solid(w, cx, cy)) continue

    // The web needs a clear vertical line from its anchor to the crawler and
    // the crawler needs a clear body-width column over the drop.
    for (var y = cy + 1; y <= footY; y++)
      if (solid(w, cx, y)) return false

    ag.x = nx
    ag.ropeY = cy
    ag.state = "rappel"
    ag.timer = 0
    ag.cool = specOf(ag).cool
    return true
  }
  return false
}

function stepCeiling(w, ag) {
  var nx = ag.x + ag.dir * WALK_SPEED
  var cx = Math.floor(nx)
  var y = Math.floor(ag.y)

  ag.timer++
  if (ag.timer > CEILING_GRIP) {
    startRappel(w, ag)
    return
  }

  if (!solid(w, cx, y - 1)) {
    // Roof gone ahead. The current cell is still an anchor, so lower from it
    // instead of dropping off the far side of the crossing.
    startRappel(w, ag)
    return
  }
  for (var b = 0; b < AGENT_H; b++) {
    if (solid(w, cx, y + b)) { turnAround(w, ag); return }
  }

  // Over the landing it set off for, with ground under it: down.
  var arrived = ag.dir > 0 ? ag.x >= ag.ceilTo : ag.x <= ag.ceilTo
  if (arrived) {
    for (var d2 = AGENT_H; d2 < ROWS - y; d2++) {
      if (!solid(w, cx, y + d2)) continue
      startRappel(w, ag)
      return
    }
  }

  ag.x = nx
  ag.anim++
}

// A precise landing at the far side of a gap. landingAhead() deliberately
// returns only a distance because builders do not care about the row; flying
// specials do, or they would finish their move embedded in the ledge.
function specialHeightLanding(w, ag, far) {
  if (far < 2) return null
  var x = Math.floor(ag.x + ag.dir * far)
  var footY = Math.floor(ag.y)
  for (var dy = -1; dy <= 3; dy++)
    if (solid(w, x, footY + dy + 1) && !solid(w, x, footY + dy)
        && headroom(w, x, footY + dy)) return { x: x + 0.5, y: footY + dy }
  return null
}

// Find a safe spot on the floor below, offset according to the machine. A
// lethal drop used to send nineteen different props down the same plumb line;
// this is what lets a glider actually glide, a recoil kick backwards and the
// helicopter go somewhere before it lands. Work back toward the guaranteed
// vertical landing if the preferred patch is obstructed.
function specialDropLanding(w, ag, nx, depth, mode) {
  var drift = {
    recoil: -3, cyclone: 4, web: 0, logchute: 3, balloon: -4,
    promptchute: 2, piledrive: 0, helicopter: 7, glasswing: 5,
    ghost: -3, gunwing: 4, tractor: 1, steps: 3, chain: 5,
    jetpack: 7, cushion: 2, elevator: 0, extender: 0, shieldglider: 5
  }[mode] || 0
  var footY = Math.floor(ag.y) + depth
  var baseX = Math.floor(nx)
  var sign = drift < 0 ? -ag.dir : ag.dir
  for (var n = Math.abs(drift); n >= 0; n--) {
    var x = baseX + sign * n
    if (x <= 1 || x >= COLS - 2) continue
    if (solid(w, x, footY + 1) && !solid(w, x, footY) && headroom(w, x, footY))
      return { x: x + 0.5, y: footY }
  }
  return { x: nx, y: footY }
}

// Every special has its own answer to a lethal height. These are personal,
// temporary pieces of theatre rather than toolbar skills: none leave a generic
// umbrella behind, and only Stack Overflow's ordinary wall move makes a route
// the rest of the colony can reuse.
function startSpecialHeight(w, ag, nx, depth, far) {
  var spec = specOf(ag)
  var landing = specialHeightLanding(w, ag, far)
  if (depth === Infinity && !landing) return false

  var cross = ["recoil", "cyclone", "logchute", "helicopter", "glasswing",
    "ghost", "gunwing", "tractor", "steps", "chain", "jetpack", "shieldglider"]
  var target = landing && cross.indexOf(spec.height) >= 0 ? landing : null
  if (!target) {
    if (depth === Infinity) return false
    target = specialDropLanding(w, ag, nx, depth, spec.height)
  }

  ag.state = "height"
  ag.heightMode = spec.height
  ag.heightFromX = ag.x
  ag.heightFromY = ag.y
  ag.heightToX = target.x
  ag.heightToY = target.y
  ag.heightUp = false
  ag.heightTick = 0
  var dx = Math.abs(target.x - ag.x)
  var dy = Math.abs(target.y - ag.y)
  ag.heightTicks = Math.max(24, Math.ceil(Math.max(dx / 0.24, dy / 0.25)))
  // Model Collapse spends the opening beat visibly assembling the stunt pad.
  if (spec.height === "cushion") ag.heightTicks += 18
  if (spec.height === "helicopter") ag.heightTicks += 60
  if (spec.height === "balloon") ag.heightTicks += 25
  ag.x = nx
  ag.timer = 0
  w.lastEvent = spec.height === "cushion" ? "copies, cushion!" : spec.height
  return true
}

// Powered, buoyant and anchored devices work both ways. Find a real ledge
// above before launching: this keeps a jetpack from solving solid ceilings and
// gives chains and tractor beams something visible to attach to. Hal Lucination
// alone may phase through the obstruction on the way there.
function startSpecialAscent(w, ag) {
  var mode = specOf(ag).height
  var upward = ["recoil", "balloon", "helicopter", "ghost", "gunwing",
    "tractor", "chain", "jetpack"]
  if (upward.indexOf(mode) < 0) return false

  var fx = Math.floor(ag.x)
  var fy = Math.floor(ag.y)
  var target = null
  for (var rise = 4; rise <= 30 && !target; rise++) {
    var ty = fy - rise
    for (var side = 0; side <= 12 && !target; side++) {
      for (var turn = 0; turn < 2; turn++) {
        if (side === 0 && turn === 1) continue
        var sign = turn === 0 ? ag.dir : -ag.dir
        var tx = fx + side * sign
        if (!solid(w, tx, ty + 1) || solid(w, tx, ty) || !headroom(w, tx, ty)) continue
        if (mode !== "ghost" && !lineClear(w, fx, fy - 2, tx, ty - 2)) continue
        target = { x: tx + 0.5, y: ty }
        break
      }
    }
  }
  if (!target) return false

  ag.state = "height"
  ag.heightMode = mode
  ag.heightFromX = ag.x
  ag.heightFromY = ag.y
  ag.heightToX = target.x
  ag.heightToY = target.y
  ag.heightUp = true
  ag.heightTick = 0
  ag.heightTicks = Math.max(30, Math.ceil(Math.max(
    Math.abs(target.x - ag.x) / 0.22, Math.abs(target.y - ag.y) / 0.22)))
  if (mode === "helicopter") ag.heightTicks += 45
  if (mode === "balloon") ag.heightTicks += 20
  ag.dir = target.x >= ag.x ? 1 : -1
  ag.timer = 0
  ag.still = 0
  w.lastEvent = mode + " up"
  return true
}

function stepSpecialHeight(w, ag) {
  ag.heightTick++
  var p = Math.min(1, ag.heightTick / ag.heightTicks)
  var moveP = p

  // The copy pile is in place before the stunt begins; hold for that readable
  // beat, then jump. The other machines leave immediately.
  if (ag.heightMode === "cushion") moveP = Math.max(0, (p - 0.18) / 0.82)

  ag.x = ag.heightFromX + (ag.heightToX - ag.heightFromX) * moveP
  ag.y = ag.heightFromY + (ag.heightToY - ag.heightFromY) * moveP

  // Even when the only safe landing is directly below, these devices travel
  // through the air instead of wearing nineteen costumes for the same fall.
  var sway = {
    recoil: -2, cyclone: 3, web: 0.4, logchute: 2, balloon: -3,
    promptchute: 1.5, piledrive: 0, helicopter: 5, glasswing: 3,
    ghost: -2, gunwing: 2.5, tractor: 0.8, steps: 1.5, chain: 3,
    jetpack: 4, cushion: 1.5, elevator: 0, extender: 0, shieldglider: 3
  }[ag.heightMode] || 0
  ag.x += ag.dir * sway * Math.sin(moveP * Math.PI)
  if (ag.heightMode === "helicopter") {
    // A lazy circuit rather than a rotor-assisted fall: out, back across its
    // own line, then around to the selected landing.
    ag.x += ag.dir * 2.5 * Math.sin(moveP * Math.PI * 2)
    ag.y -= 2 * Math.sin(moveP * Math.PI) + 1.2 * Math.sin(moveP * Math.PI * 2)
  }

  // Crossing devices describe different silhouettes even though all arrive at
  // the same deterministic safe landing. The rotor and jet climb, the chain
  // swings, and the rest make shallower arcs.
  var horizontal = Math.abs(ag.heightToX - ag.heightFromX) > 1
  if (horizontal && moveP > 0 && moveP < 1) {
    var lift = (ag.heightMode === "helicopter" || ag.heightMode === "jetpack") ? 4
      : (ag.heightMode === "chain" ? 3 : 1.5)
    ag.y -= Math.sin(moveP * Math.PI) * lift
  }
  ag.anim++
  if (p < 1) return

  ag.x = ag.heightToX
  ag.y = ag.heightToY
  ag.state = "walk"
  ag.turns = 0
  ag.heightTick = 0
  if (ag.heightMode === "piledrive") addDust(w, ag.x, ag.y, 18)
  if (ag.heightMode === "cushion") addDust(w, ag.x, ag.y, 8)
}

// And at a drop. Every special owns a signature height move for a lethal one;
// survivable steps still use the ordinary fall so the machines only come out
// when they mean something.
function specialAtEdge(w, ag, nx, depth, far) {
  var spec = specOf(ag)

  // A crawler uses a real roof when there is one. Its fallback is still a web,
  // cast back to the lip, so it shares the universal promise without borrowing
  // anybody else's umbrella or machine.
  if (depth > SAFE_FALL) {
    if (spec.act === "ceiling" && rappelAtEdge(w, ag, nx, depth)) return
    if (startSpecialHeight(w, ag, nx, depth, far)) return
  }

  if (spec.act === "complete" && ag.cool <= 0 && far > 2) {
    var foot = Math.floor(ag.y) + 1
    var span = Math.min(BUILD_REACH, far + 4)
    var added = false
    for (var ac = 1; ac <= span; ac++) {
      var acx = Math.floor(ag.x) + ag.dir * ac
      if (at(w, acx, foot) !== EMPTY || agentOccupiesCell(w, acx, foot, ag)) continue
      setCell(w, acx, foot, ROCK)
      added = true
    }
    if (added) {
      ag.specialX = ag.x + ag.dir * span
      ag.specialY = ag.y
      ag.shotFor = 12
      ag.cool = spec.cool
      ag.x = nx
      return
    }
  }

  // These agents resolve gaps the same way they resolve walls: commit a group,
  // a prediction, a degraded copy, or a queue to the first valid candidate on
  // the far side. The wind-up makes the choice visible before it happens.
  if ((spec.act === "chain" || spec.act === "speculate"
       || spec.act === "collapse" || spec.act === "limit")
      && ag.cool <= 0 && far > 1 && specialLanding(w, ag, 14)) {
    ag.state = "trick"
    ag.timer = 0
    return
  }

  // A deep shaft with a roof over it is a rappel, even if the crawler has
  // only just used its horizontal ceiling walk. Treating both movements as
  // one cooldown is what made level 55's crawler turn away from the central
  // drop and eventually dig itself through several floors instead.
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
  if (specOf(ag).act === "ceiling" && startWebEscape(w, ag)) return
  if (exitAbove(w, ag) && startSpecialAscent(w, ag)) return
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
  var perceptive = hazardPerceptive(ag)
  for (var up = 1; up <= JUMP_UP; up++) {
    var ly = fy - up
    if (solid(w, fx + d, ly) || solid(w, fx + d * 2, ly)) continue
    if (!solid(w, fx + d * 2, ly + 1)) continue      // nothing to land on
    if (!headroom(w, fx + d * 2, ly)) continue
    // A hop is an escape from a terrain pocket, not permission to override a
    // danger the colony has already learned. Level 254's agents turned away
    // from the scarab correctly, stood at its lip until JUMP_STILL, then hopped
    // straight into the same known kill zone because this terrain-only test
    // never asked what occupied the landing.
    if (hazardZoneAt(w, fx + d, ly, perceptive)
        || hazardZoneAt(w, fx + d * 2, ly, perceptive)) continue
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

function stepSlide(w, ag) {
  ag.timer++
  var footY = Math.floor(ag.y)
  var nx = ag.x + ag.dir * WALK_SPEED * 1.35
  var cx = Math.floor(nx)

  // Sliding is movement, not immunity: do not squeeze into a learned trap or
  // through another agent who is deliberately holding the line.
  if (hazardZoneAt(w, cx, footY, hazardPerceptive(ag))
      || anyBlockerNear(w, ag, nx)) {
    ag.state = "walk"
    turnAround(w, ag)
    return
  }

  // Keep the move for flat, supported low passages. At a wall or an edge,
  // reverse while still crouched; the normal walker takes over once clear.
  if (solid(w, cx, footY) || !solid(w, cx, footY + 1)
      || !crouchroom(w, cx, footY)) {
    ag.dir = -ag.dir
    ag.turns++
    return
  }

  ag.x = nx
  ag.anim++
  if (headroom(w, cx, footY)) {
    ag.state = "walk"
    ag.timer = 0
  }
}

function stepTrick(w, ag) {
  ag.timer++

  var spec = specOf(ag)
  if (spec.act === "spray") {
    // One visible round at a time. Two ticks per round is just slow enough to
    // read as a burst rather than a rectangle blinking out of the terrain.
    if ((ag.timer - 1) % SPRAY_SHOT_TICKS === 0)
      sprayBullet(w, ag, Math.floor((ag.timer - 1) / SPRAY_SHOT_TICKS), false)
    if (ag.timer < SPRAY_BURST * SPRAY_SHOT_TICKS) return
    ag.timer = 0
    ag.state = "walk"
    ag.cool = spec.cool
    return
  }

  if (ag.timer < TRICK_WINDUP) return
  ag.timer = 0

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

function stepLimited(w, ag) {
  ag.limitedFor--
  if (ag.limitedFor > 0) return
  ag.limitedFor = 0
  ag.limitedBy = 0
  if (unsupported(w, ag)) beginUncontrolledFall(w, ag)
  else ag.state = "walk"
}

function stepStunned(w, ag) {
  ag.stunFor--
  if (ag.stunFor > 0) return
  ag.stunFor = 0
  if (unsupported(w, ag)) beginUncontrolledFall(w, ag)
  else ag.state = "walk"
}

// ---------------------------------------------------------------------------
// Red team — deliberately much simpler than the colony. They cannot edit the
// level or use skills; they only patrol, acquire a visible target and attack.
// ---------------------------------------------------------------------------

function spawnEnemy(w, kind) {
  var dropOffsets = [-0.7, 0.7]
  var offset = dropOffsets[w.enemyReleased % dropOffsets.length]
  return {
    id: w.nextEnemyId++, kind: kind,
    x: w.enemyHatch.x + 0.5 + offset, y: w.enemyHatch.y,
    dir: w.enemyHatch.dir || (w.startDir > 0 ? -1 : 1),
    state: kind === "operator" ? "deploy" : (kind === "sniper" ? "seekpost" : "walk"),
    deployLeft: kind === "operator" ? 6 : (kind === "sniper" ? 9 : 0),
    timer: 0, fall: 0, anim: 0, shoves: 0,
    targetId: 0, lineTo: 0, lineY: 0, shotFor: 0,
    gone: false
  }
}

function settleEnemyPost(en) {
  en.state = en.kind === "operator" ? "operate" : "camp"
  en.timer = 0
}

function stepEnemyDeploy(w, en) {
  var speed = ENEMY_WALK_SPEED * 0.7
  var nx = en.x + en.dir * speed
  var cx = Math.floor(nx), fy = Math.floor(en.y)
  var targetY = fy
  if (solid(w, cx, fy)) {
    var rise = 1
    while (rise <= MAX_STEP && solid(w, cx, fy - rise)) rise++
    if (rise > MAX_STEP || !headroom(w, cx, fy - rise)) { settleEnemyPost(en); return }
    targetY = fy - rise
  } else if (!solid(w, cx, fy + 1)) {
    if (solid(w, cx, fy + 2)) targetY = fy + 1
    else { settleEnemyPost(en); return }
  }
  if (!headroom(w, cx, targetY)) { settleEnemyPost(en); return }
  en.x = nx
  en.y = targetY
  en.deployLeft -= speed
  en.anim++
  if (en.deployLeft <= 0) settleEnemyPost(en)
}

function droneTarget(w, drone) {
  var best = null, score = Infinity
  for (var i = 0; i < w.agents.length; i++) {
    var ag = w.agents[i]
    if (ag.gone || ag.state === "saved" || ag.state === "bomb") continue
    var dx = ag.x - drone.x, dy = (ag.y - 2) - drone.y
    var d = dx * dx + dy * dy
    if (d < score) { best = ag; score = d }
  }
  return best
}

function operatorHasDrone(w, en) {
  for (var i = 0; i < w.enemies.length; i++) {
    var drone = w.enemies[i]
    if (!drone.gone && drone.kind === "drone" && drone.ownerId === en.id) return true
  }
  return false
}

function launchDrone(w, en) {
  w.enemies.push({
    id: w.nextEnemyId++, kind: "drone", ownerId: en.id,
    x: en.x, y: en.y - 3, dir: en.dir,
    state: "fly", timer: 0, fall: 0, anim: 0, shoves: 0,
    targetId: 0, lineTo: 0, lineY: 0, shotFor: 0, gone: false
  })
  en.timer = 0
  w.lastEvent = "drone launched"
}

function explodeDrone(w, drone, ag) {
  drone.gone = true
  drone.state = "dead"
  addDust(w, drone.x, drone.y, 18)
  w.lastEvent = "drone strike"
  if (!ag || ag.gone || ag.state === "saved") return
  ag.gone = true
  ag.state = "dead"
  w.lost++
}

function stepDrone(w, drone) {
  var target = droneTarget(w, drone)
  if (!target) { drone.anim++; return }
  drone.targetId = target.id
  var tx = target.x, ty = target.y - 2
  var dx = tx - drone.x, dy = ty - drone.y
  var dist = Math.sqrt(dx * dx + dy * dy)
  if (dist < 1.35) { explodeDrone(w, drone, target); return }

  var speed = 0.16
  var nx = drone.x + dx / Math.max(1, dist) * speed
  var ny = drone.y + dy / Math.max(1, dist) * speed
  var openBoth = !solid(w, Math.floor(nx), Math.floor(ny))
    && !solid(w, Math.floor(nx), Math.floor(ny) - 1)
  // Slide along walls rather than flying through them. Vertical movement first
  // lets a drone follow the colony down a handoff shaft; horizontal movement
  // keeps it hunting along the corridor once it gets there.
  if (openBoth) { drone.x = nx; drone.y = ny }
  else if (!solid(w, Math.floor(drone.x), Math.floor(ny))
           && !solid(w, Math.floor(drone.x), Math.floor(ny) - 1)) drone.y = ny
  else if (!solid(w, Math.floor(nx), Math.floor(drone.y))
           && !solid(w, Math.floor(nx), Math.floor(drone.y) - 1)) drone.x = nx
  drone.dir = dx >= 0 ? 1 : -1
  drone.anim++
}

function enemyTarget(w, en, reach) {
  var best = null, bestScore = Infinity
  for (var i = 0; i < w.agents.length; i++) {
    var ag = w.agents[i]
    if (ag.gone || ag.state === "saved" || ag.state === "bomb") continue
    if (Math.abs(ag.y - en.y) > 3) continue
    var d = Math.abs(ag.x - en.x)
    if (d > reach) continue
    if (!lineClear(w, Math.floor(en.x), Math.floor(en.y) - 2,
                   Math.floor(ag.x), Math.floor(ag.y) - 2)) continue
    var claimed = 0
    for (var ei = 0; ei < w.enemies.length; ei++) {
      var other = w.enemies[ei]
      if (other !== en && !other.gone && other.targetId === ag.id) claimed++
    }
    // Distance still matters, but an already-pursued target is expensive.
    // The small id preference breaks ties deterministically so a red team
    // spreads across the approaching queue instead of sharing one victim.
    // Once selected, keep a victim unless somebody clearly better appears.
    // Without this hysteresis two equally placed agents can trade scores every
    // frame, making the pursuer swivel in place instead of committing.
    var loyalty = en.targetId === ag.id ? 7 : 0
    var score = d + claimed * 10 + Math.abs((ag.id % 4) - (en.id % 4)) * 1.5 - loyalty
    if (score >= bestScore) continue
    best = ag; bestScore = score
  }
  return best
}

function enemyTargetById(w, id) {
  for (var i = 0; i < w.agents.length; i++)
    if (w.agents[i].id === id && !w.agents[i].gone && w.agents[i].state !== "saved") return w.agents[i]
  return null
}

function enemyTargetAbove(w, en) {
  var best = null, bestRise = Infinity
  for (var i = 0; i < w.agents.length; i++) {
    var ag = w.agents[i]
    if (ag.gone || ag.state === "saved" || ag.state === "bomb" || ag.y >= en.y - 5) continue
    var rise = en.y - ag.y
    if (rise < bestRise) { best = ag; bestRise = rise }
  }
  return best
}

function enemyCorridorIndex(w, en) {
  var best = -1, bestD = Infinity
  for (var i = 0; i < w.corridors.length; i++) {
    var d = Math.abs((w.corridors[i].floorY - 1) - en.y)
    if (d < bestD) { best = i; bestD = d }
  }
  return bestD <= w.corrGap ? best : -1
}

function seekEnemyJetUp(w, en) {
  var above = enemyTargetAbove(w, en)
  if (!above) return false
  var ci = enemyCorridorIndex(w, en)
  if (ci <= 0) return false
  var upper = w.corridors[ci - 1]
  // The handoff column is guaranteed open for both straight shafts and the
  // diagonal ramp variant. Staying on that column avoids flying through the
  // ramp's solid underside on the way back up.
  var shaftX = upper.handoffX
  en.dir = shaftX >= en.x ? 1 : -1
  en.targetId = above.id
  if (Math.abs(en.x - shaftX) > 1.1) return true
  en.x = shaftX
  en.state = "jet"
  en.jetMode = "rise"
  en.jetTargetY = upper.floorY - 2
  en.jetLandDir = -upper.dir
  en.jetShaftX = shaftX
  en.timer = 0
  return true
}

// A sniper takes the guaranteed handoff shaft one corridor upward before
// choosing its permanent firing position. One ascent is enough to put it above
// its house without racing the colony all the way back to the hatch.
function seekSniperPost(w, en) {
  var ci = enemyCorridorIndex(w, en)
  if (ci <= 0) { en.state = "deploy"; en.deployLeft = 5; return }
  var upper = w.corridors[ci - 1]
  var shaftX = upper.handoffX
  en.dir = shaftX >= en.x ? 1 : -1
  // The carved handoff is several cells wide. Launch from its safe lip rather
  // than insisting on the centre column, which is already beyond the floor on
  // short-ended corridors (level 64).
  if (Math.abs(en.x - shaftX) > 4) {
    // Reuse the safe ground walker, but do not let its distance budget settle
    // the sniper before it reaches the launch shaft.
    en.deployLeft = 999
    stepEnemyDeploy(w, en)
    if (en.state === "camp") {
      // A full corridor obstacle can cut the launch shaft off from the enemy
      // house (level 67). That is still useful elevation: boost onto its top
      // and establish there instead of giving up at its foot.
      var fy = Math.floor(en.y)
      var wallX = Math.floor(en.x) + en.dir
      var h = wallHeight(w, wallX, fy)
      if (h > 1 && h <= RESCUE_CLIMB) {
        en.state = "jet"
        en.jetMode = "rise"
        en.jetTargetY = fy - h
        en.jetLandDir = en.dir
        en.jetShaftX = en.x
        en.timer = 0
      }
    }
    return
  }
  en.x = shaftX
  en.state = "jet"
  en.jetMode = "rise"
  en.jetTargetY = upper.floorY - 2
  en.jetLandDir = -upper.dir
  en.jetShaftX = shaftX
  en.timer = 0
}

function visibleEnemyAhead(w, ag, reach) {
  for (var i = 0; i < w.enemies.length; i++) {
    var en = w.enemies[i]
    if (en.gone || Math.abs(en.y - ag.y) > (en.kind === "drone" ? 12 : 3)) continue
    var ahead = (en.x - ag.x) * ag.dir
    if (ahead > 0 && ahead <= reach
        && lineClear(w, Math.floor(ag.x), Math.floor(ag.y) - 2,
                     Math.floor(en.x), Math.floor(en.y) - 2)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// The plate
//
// Cover, not immortality. An agent is covered while it is holding the plate
// itself, or while it is walking in the lee of somebody who is: within four
// cells behind them, on the same floor, on the side the plate is not facing.
// Step out in front and you are as mortal as anybody.
// ---------------------------------------------------------------------------

function shieldCovering(w, ag, fromX) {
  for (var i = 0; i < w.agents.length; i++) {
    var s = w.agents[i]
    if (s.gone || s.shieldFor <= 0) continue
    if (Math.abs(s.y - ag.y) > 1.6) continue
    var behind = (ag.x - s.x) * s.dir
    if (behind > 0.6 || behind < -SHIELD_COVER) continue
    // The plate faces one way. Something arriving from the other side of it
    // arrives at the back of an agent holding a shield, which is exactly as
    // useful as it sounds.
    if (fromX !== undefined && (fromX - s.x) * s.dir <= 0) continue
    // Marked for the label. Being in cover is the whole of what the shield
    // does for anybody else, and it is otherwise completely invisible: an
    // agent strolling through a sentry's reach looks like an agent that has
    // not noticed the sentry.
    ag.coveredFor = 4
    return s
  }
  return null
}

// Stopped it. The counter is on the shield rather than the level because it is
// the one number that says what this special was worth on this board.
function shieldStops(w, ag, fromX) {
  var s = shieldCovering(w, ag, fromX)
  if (!s) return false
  s.blocked++
  s.blockFor = 10
  w.lastEvent = "request declined"
  return true
}

// Held, rather than flashed. A shield that goes up for four seconds and comes
// down on a timer is a special effect; one that stays up while there is
// something in front of it to stay up for is cover, and the whole point of it
// is the stretch of corridor it makes crossable for the queue behind.
// SHIELD_MAX is what stops that becoming permanent: arms tire, and then it is
// as mortal as anybody until it has had a rest.
function raiseShield(w, ag) {
  if (ag.shieldHeld >= SHIELD_MAX) return false
  if (ag.shieldFor > 0) { ag.shieldFor = SHIELD_HOLD; return true }
  if (ag.cool > 0) return false
  ag.shieldFor = SHIELD_HOLD
  w.lastEvent = "shields up"
  return true
}

// What the plate goes up for. Deliberately laxer than hazardAhead: that one
// answers "is the colony about to walk into something it has watched kill
// somebody", and this one answers "is there a thing up there that shoots".
// The difference is the character — everybody else learns a danger by losing
// somebody to it, and this one is already behind the shield.
function threatAhead(w, ag, reach) {
  for (var i = 0; i < w.hazards.length; i++) {
    var h = w.hazards[i]
    if (h.wrecked) continue
    var mid = hazardMid(h)
    var along = (mid.x - ag.x) * ag.dir
    if (Math.abs(mid.y - ag.y) > CORR_H) continue
    if (along > -2 && along <= reach) return true
  }
  // Red team counts without a clear line to it. Everything else in this file
  // asks whether an agent can *see* the thing; a plate goes up because there
  // is shooting in the neighbourhood, which is a lower bar on purpose and the
  // reason the shield is ever up on a level whose hazard sits off the route.
  for (var e = 0; e < w.enemies.length; e++) {
    var en = w.enemies[e]
    if (en.gone || Math.abs(en.y - ag.y) > CORR_H) continue
    var gap = (en.x - ag.x) * ag.dir
    if (gap > -3 && gap <= reach + 8) return true
  }
  return false
}

function woundFriendly(w, ag, fromX) {
  if (!ag || ag.gone || ag.state === "saved") return
  if (shieldStops(w, ag, fromX)) return
  ag.wounds = (ag.wounds || 0) + 1
  addBlood(w, ag.x, ag.y - 1.5, ag.wounds >= 2 ? 16 : 7)
  if (ag.wounds >= 2) {
    ag.gone = true
    ag.state = "dead"
    w.lost++
    w.lastEvent = "red team"
    return
  }
  ag.dir = ag.x >= fromX ? 1 : -1
  ag.x += ag.dir * 0.8
  ag.state = "stunned"
  ag.stunFor = 18
  w.lastEvent = "wounded"
}

function killEnemy(w, en) {
  if (!en || en.gone) return
  en.gone = true
  en.state = "dead"
  w.enemiesKilled++
  addBlood(w, en.x, en.y - 1.5, 12)
  w.lastEvent = "red team down"
}

function stepEnemyFall(w, en) {
  var ny = en.y + FALL_SPEED
  if (ny >= ROWS) { en.gone = true; return }
  var cx = Math.floor(en.x)
  for (var yy = Math.floor(en.y) + 1; yy <= Math.floor(ny) + 1; yy++) {
    if (!solid(w, cx, yy)) continue
    en.y = yy - 1
    en.state = en.kind === "operator" ? "operate" : (en.kind === "sniper" ? "camp" : "walk")
    en.fall = 0
    return
  }
  en.y = ny
  en.fall += FALL_SPEED
}

function stepEnemyWalk(w, en) {
  en.seekingUp = false
  // Give each hostile a little personal space. Later arrivals otherwise catch
  // the first patrol and merge into one red blob even though they left the
  // hatch separately.
  for (var pi = 0; pi < w.enemies.length; pi++) {
    var peer = w.enemies[pi]
    if (peer === en || peer.gone || Math.abs(peer.y - en.y) > 1.5
        || Math.abs(peer.x - en.x) >= 1) continue
    en.dir = en.x !== peer.x ? (en.x > peer.x ? 1 : -1) : (en.id > peer.id ? 1 : -1)
    en.state = "recover"
    en.timer = 45
    en.targetId = 0
    return
  }

  var target = enemyTarget(w, en, 24)
  if (target) {
    en.targetId = target.id
    var delta = target.x - en.x
    en.dir = delta >= 0 ? 1 : -1
    if (target.state === "walk" && Math.abs(delta) < 7) target.dir = -en.dir

    if (Math.abs(delta) >= 6) {
      en.state = "aim"
      en.timer = 0
      en.targetId = target.id
      en.lineTo = target.x
      en.lineY = target.y - 2
      return
    }
    if (Math.abs(delta) < 6) {
      // A gunner retreats for a beat when rushed. Simply reversing its walk
      // direction let two moving bodies cross every frame and made it twitch
      // left/right on exactly the same patch of floor.
      en.dir = delta >= 0 ? -1 : 1
      en.state = "recover"
      en.timer = 40
      return
    }
  } else {
    en.targetId = 0
    if (seekEnemyJetUp(w, en)) {
      en.seekingUp = true
      if (en.state === "jet") return
      // Continue walking toward the shaft selected above.
    }
  }

  var speed = ENEMY_WALK_SPEED
  var nx = en.x + en.dir * speed
  var cx = Math.floor(nx), fy = Math.floor(en.y)
  var targetY = fy
  if (solid(w, cx, fy)) {
    var rise = 1
    while (rise <= MAX_STEP && solid(w, cx, fy - rise)) rise++
    if (rise > MAX_STEP || !headroom(w, cx, fy - rise)) { en.dir = -en.dir; return }
    targetY = fy - rise
  } else if (!solid(w, cx, fy + 1)) {
    if (solid(w, cx, fy + 2)) targetY = fy + 1
    else {
      // Gaps are launch ramps. The red team crosses them under power instead
      // of gathering at the lip or blindly falling behind the colony.
      en.x = nx; en.state = "jet"; en.jetMode = en.seekingUp ? "cross" : "sink"
      en.timer = 0; en.jetVy = 0; return
    }
  }
  if (!headroom(w, cx, targetY)) { en.dir = -en.dir; return }
  en.x = nx
  en.y = targetY
  en.anim++
}

function fireEnemyGun(w, en) {
  var fy = Math.floor(en.y) - 2
  var gunReach = en.kind === "sniper" ? 55 : 28
  for (var step = 1; step <= gunReach; step++) {
    var x = Math.floor(en.x) + en.dir * step
    for (var ai = 0; ai < w.agents.length; ai++) {
      var ag = w.agents[ai]
      if (ag.gone || ag.state === "saved") continue
      if (Math.abs(ag.x - (x + 0.5)) < 0.8 && Math.abs((ag.y - 2) - fy) < 2.5) {
        en.lineTo = ag.x; en.lineY = ag.y - 2; en.shotFor = 8
        woundFriendly(w, ag, en.x)
        return
      }
    }
    // Friendly fire is intentional: the first body in the ray owns the shot.
    for (var ei = 0; ei < w.enemies.length; ei++) {
      var other = w.enemies[ei]
      if (other === en || other.gone) continue
      if (Math.abs(other.x - (x + 0.5)) < 0.8 && Math.abs((other.y - 2) - fy) < 2.5) {
        en.lineTo = other.x; en.lineY = other.y - 2; en.shotFor = 8
        killEnemy(w, other)
        return
      }
    }
    if (solid(w, x, fy)) { en.lineTo = x; en.lineY = fy; en.shotFor = 8; return }
  }
  en.lineTo = en.x + en.dir * gunReach
  en.lineY = fy
  en.shotFor = 8
}

function stepEnemy(w, en) {
  if (en.gone) return
  if (en.shotFor > 0) en.shotFor--
  if (en.kind === "drone") { stepDrone(w, en); return }
  if (en.kind === "sniper" && en.state === "seekpost") { seekSniperPost(w, en); return }
  if ((en.kind === "operator" || en.kind === "sniper") && en.state === "deploy") {
    stepEnemyDeploy(w, en)
    return
  }
  if (en.kind === "operator" && en.state === "operate") {
    if (unsupported(w, en)) { en.state = "fall"; en.fall = 0; return }
    en.anim++
    // The cooldown begins when the previous drone is gone, not while it is in
    // flight. Otherwise a successful strike was followed by a replacement on
    // the very next tick because the timer had already filled in the air.
    if (operatorHasDrone(w, en)) en.timer = 0
    else if (++en.timer >= 180) launchDrone(w, en)
    return
  }
  if (en.state === "fall") { stepEnemyFall(w, en); return }
  if (en.state === "walk") { stepEnemyWalk(w, en); return }

  if (en.kind === "sniper" && en.state === "camp") {
    if (unsupported(w, en)) { en.state = "fall"; en.fall = 0; return }
    var sniperTarget = enemyTarget(w, en, 55)
    if (!sniperTarget) { en.targetId = 0; return }
    en.targetId = sniperTarget.id
    en.dir = sniperTarget.x >= en.x ? 1 : -1
    en.lineTo = sniperTarget.x
    en.lineY = sniperTarget.y - 2
    en.state = "aim"
    en.timer = 0
    return
  }

  if (en.state === "jet") {
    en.timer++
    if (en.jetMode === "rise") {
      en.x += (en.jetShaftX - en.x) * 0.18
      en.y -= 0.22
      en.anim++
      if (en.y <= en.jetTargetY) {
        en.y = en.jetTargetY
        en.jetMode = "land"
        en.dir = en.jetLandDir
      }
      return
    }
    var jetX = en.x + en.dir * ENEMY_JET_SPEED
    var jetY = en.y + (en.jetMode === "land" ? 0.06 : (en.jetMode === "cross" ? 0.02 : ENEMY_JET_SINK))
    var jetCellX = Math.floor(jetX)
    if (solid(w, jetCellX, Math.floor(en.y)) || !headroom(w, jetCellX, Math.floor(en.y))) {
      en.dir = -en.dir
    } else en.x = jetX
    // Touching any lower platform cuts the thrusters and resumes the patrol.
    var oldFeet = Math.floor(en.y)
    var newFeet = Math.floor(jetY)
    for (var jy = oldFeet + 1; jy <= newFeet + 1; jy++) {
      if (!solid(w, Math.floor(en.x), jy)) continue
      en.y = jy - 1
      en.state = en.kind === "sniper" ? "deploy" : "walk"
      if (en.kind === "sniper") en.deployLeft = 5
      en.timer = 0; en.jetVy = 0; en.jetMode = ""; return
    }
    en.y = jetY
    en.anim++
    if (en.y >= ROWS - 1 || en.timer > 360) { en.state = "fall"; en.fall = 0 }
    return
  }

  en.timer++

  if (en.state === "aim") {
    var aimed = enemyTargetById(w, en.targetId)
    if (!aimed || Math.abs(aimed.y - en.y) > 3
        || (aimed.x - en.x) * en.dir <= 0
        || !lineClear(w, Math.floor(en.x), Math.floor(en.y) - 2,
                      Math.floor(aimed.x), Math.floor(aimed.y) - 2)) {
      // Do not reacquire the same impossible shot on the next tick and pivot
      // forever. Move on after half a reload instead.
      en.state = "reload"; en.timer = Math.round(GUN_RELOAD / 2); return
    }
    en.lineTo = aimed.x; en.lineY = aimed.y - 2
    if (en.timer >= (en.kind === "sniper" ? GUN_AIM + 12 : GUN_AIM)) {
      fireEnemyGun(w, en)
      en.state = "reload"; en.timer = 0
    }
    return
  }

  if (en.state === "reload" && en.timer >= GUN_RELOAD) {
    en.state = en.kind === "sniper" ? "camp" : "walk"; en.timer = 0
  }
  if (en.state === "recover") {
    var retreatX = en.x + en.dir * ENEMY_WALK_SPEED * 0.55
    var retreatCell = Math.floor(retreatX)
    var retreatY = Math.floor(en.y)
    var peerBlocked = false
    for (var ri = 0; ri < w.enemies.length; ri++) {
      var retreatPeer = w.enemies[ri]
      if (retreatPeer !== en && !retreatPeer.gone
          && Math.abs(retreatPeer.y - en.y) < 1.5
          && Math.abs(retreatPeer.x - retreatX) < 1
          // Two overlapping guards are deliberately sent in opposite
          // directions above. Let that separating step happen even while
          // their sprites still overlap; treating the peer as a wall until
          // they were already apart left both waiting forever.
          && Math.abs(retreatPeer.x - retreatX) <= Math.abs(retreatPeer.x - en.x)) {
        peerBlocked = true
        break
      }
    }
    if (!peerBlocked && !solid(w, retreatCell, retreatY)
        && solid(w, retreatCell, retreatY + 1) && headroom(w, retreatCell, retreatY)) en.x = retreatX
    // At an edge or another body, hold the pose. Flipping on every blocked
    // retreat tick looked like indecision and achieved no movement anyway.
    en.anim++
    if (en.timer >= 75) { en.state = "walk"; en.timer = 0; en.targetId = 0 }
  }
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
    // Below the exit: the only useful direction is up. Climb if there is a
    // wall and a climber left for it, build the staircase if there is not, and
    // in particular do NOT fall through to the horizontal rescues below.
    if (climbOut(w, ag, grant)) return
    if (ag.state === "walk" && canStartBuild(w, ag) && grant(w, "builder")) {
      // A staircase gains height in whichever direction the agent is already
      // facing. Pacing below a raised exit makes that direction arbitrary: on
      // level 257 the rescue fired while agents faced left, so they spent their
      // builders climbing away from the exit on the right. Once the decision
      // is explicitly "up to home", its horizontal half must point home too.
      var exitMid = w.exit.x + w.exit.w / 2
      if (Math.abs(exitMid - ag.x) > 1) ag.dir = exitMid > ag.x ? 1 : -1
      ag.idle = 0
      startBuild(w, ag)
    }
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
    var charge = (traitOf(ag).mineFirst === true || ag.id % 2 === 0) && canPlantMine(w, ag)
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
  var wantsMine = best.id % 2 === 0 && canPlantMine(w, best)
  if (wantUp && climbOut(w, best, grant)) {
    // climbOut has already turned it to face whichever wall it is taking.
  } else if (wantUp && best.state === "walk" && canStartBuild(w, best) && grant(w, "builder")) {
    // No climb available — usually because a pit has emptied the climbers —
    // so build the way up instead. This has to come before the bash below: the
    // director was handing a stranded agent a basher, which drove a horizontal
    // gallery along the bottom of the world while home sat directly overhead.
    // With the climb gone that bash was the only branch that ever matched, so
    // an agent under the exit tunnelled sideways until the clock ran out.
    var exitMid = w.exit.x + w.exit.w / 2
    if (Math.abs(exitMid - best.x) > 1) best.dir = exitMid > best.x ? 1 : -1
    best.idle = 0
    startBuild(w, best)
  } else if (!wantUp && solid(w, ahead, footY) && at(w, ahead, footY) !== STEEL && grant(w, "basher")) {
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
  // Nor is holding at the lip of a danger for its reload. That is the plan.
  if (ag.waitFor > 0) return
  var key = Math.floor(ag.x / LOOP_BUCKET) + "@" + Math.floor((ag.y + 1) / (w.corrGap || CORR_GAP))
  if (key === ag.bucket) return
  ag.bucket = key
  ag.passes[key] = (ag.passes[key] || 0) + 1
  // Fire once when the threshold is crossed, not on every later visit. A
  // special cooling down answers specialEscape() by turning around; when its
  // two-cell pace straddles a bucket boundary, calling that rescue forever
  // flips it on every tick and manufactures the exact loop this detects.
  // PATIENCE and STUCK_LIMIT remain the later fallbacks if the first rescue
  // did not get it anywhere.
  if (ag.passes[key] !== LOOP_PASSES) return
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
  if (ag.waitFor > 0) return

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

  // Four or five friendlies are already on the board when the guard-house
  // door opens, but the leading group has not yet left the top corridor.
  if (w.enemyHatch && w.ticks >= 75 && w.enemyReleased < w.enemyRoster.length) {
    w.enemyReleaseTimer++
    if (w.enemyReleaseTimer >= 55) {
      w.enemyReleaseTimer = 0
      w.enemies.push(spawnEnemy(w, w.enemyRoster[w.enemyReleased]))
      w.enemyReleased++
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

    // A skill may have built a false floor inside a pit before another agent
    // arrived. Anyone already standing below the recorded lip resumes falling
    // instead of treating that debris as ordinary corridor ground.
    var insidePit = pitAt(w, Math.floor(ag.x))
    if (insidePit && ag.y >= insidePit.floorY && ag.state !== "fall") {
      ag.floater = false
      startFall(w, ag)
    }

    // Closer to home than this agent has ever been? Then whatever it's
    // doing is working: clear both counters and let it get on with it.
    w.acting = ag
    if (ag.cool > 0) ag.cool--
    if (ag.blockFor > 0) ag.blockFor--
    if (ag.coveredFor > 0) ag.coveredFor--
    if (ag.mineCool > 0) ag.mineCool--
    if (ag.waitFor > 0) ag.waitFor--
    if (ag.shieldFor > 0) {
      ag.shieldHeld++
      if (--ag.shieldFor === 0) {
        ag.shieldHeld = 0
        var sspec = specOf(ag)
        ag.cool = sspec ? sspec.cool : 0
      }
    }
    if (ag.shotFor > 0) ag.shotFor--
    if (ag.shoveCool > 0) ag.shoveCool--
    if (ag.hazardGrace > 0) ag.hazardGrace--
    if (ag.chilledFor > 0) ag.chilledFor--

    // A sniper takes a position it can see something from. Camping at the first
    // wall it happened to meet put it on a different floor from the danger on
    // nearly every level, where it could never see the one thing it is for.
    if (ag.special && ag.state === "walk") {
      var sact = specOf(ag).act
      specialCountersHazard(w, ag, sact)
      var seesDanger = sightsHazard(w, ag)
      var seesRed = visibleEnemyAhead(w, ag, 30)
      // Sees the danger, or sees the red team, or is simply getting close to
      // one: same answer either way, and the last of those is the one that
      // matters — cover is worth nothing raised after the first shot.
      if (sact === "shield" && (seesDanger || seesRed || threatAhead(w, ag, 14))) raiseShield(w, ag)

      if (sact === "camp" && (seesDanger || seesRed)) {
        ag.state = "camp"
        ag.cool = 0
      } else if (sact === "spray" && ag.cool <= 0
                 && ((seesDanger && hazardIsAhead(w, ag, 30)) || seesRed)) {
        // It opens up the moment it has the thing in view. Waiting for a wall
        // meant it fired once or twice a level, always at the map edge, and
        // never once at the danger — which is half of what it is for.
        ag.state = "trick"
        ag.timer = 0
      }
    }
    if (ag.rescueCool > 0) ag.rescueCool--

    // Rate Limiter does not wait for terrain. A sufficiently dense queue is
    // already an incident: stop the nearest requests and let them resume one
    // by one. The stagger is stored on each victim, so removing the limiter
    // does not release the whole thundering herd at once.
    if (ag.special && ag.state === "walk" && specOf(ag).act === "limit" && ag.cool <= 0) {
      var rateHeld = freezeNearby(w, ag, 5)
      if (rateHeld >= 2) {
        ag.cool = specOf(ag).cool
        ag.timer = 10
      }
    }

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

    var dirBeforeStep = ag.dir
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
      case "rappel": stepRappel(w, ag); break
      case "height": stepSpecialHeight(w, ag); break
      case "webup": stepWebEscape(w, ag); break
      case "limited": stepLimited(w, ag); break
      case "stunned": stepStunned(w, ag); break
      case "jump":  stepJump(w, ag); break
      case "slide": stepSlide(w, ag); break
      case "camp":  stepCamp(w, ag); break
    }

    // A one-cell trap can evade both stuck detectors: the agent technically
    // changes cells and directions every tick, so it is neither stationary nor
    // completing another full pacing bucket. Eighteen uninterrupted reversals
    // is not navigation. End a special's loop with its usual condemned blast,
    // which also has a chance to open the trap for everyone behind it.
    if (ag.special && ag.state === "walk" && ag.dir !== dirBeforeStep) ag.flipTicks++
    else ag.flipTicks = 0
    if (ag.special && ag.flipTicks >= 18) {
      ag.idle = Math.max(ag.idle, STUCK_LIMIT)
      condemn(w, ag)
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


  for (var red = 0; red < w.enemies.length; red++) stepEnemy(w, w.enemies[red])

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
  stepLadders(w)
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
