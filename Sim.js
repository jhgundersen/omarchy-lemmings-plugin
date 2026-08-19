// Shared, dependency-free simulation. All mutable state belongs to the world.
// Coordinates: terrain is a cell grid (COLS x ROWS). Agents carry *float*
// coordinates; ag.x is the center and ag.y is the feet row.

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

var AGENT_H = 4

// Tuning. Everything is per-tick at 30 ticks/second.

var WALK_SPEED = 0.28    // ~34 px/s — a stroll, not a sprint
var FALL_SPEED = 0.55
var FLOAT_SPEED = 0.22
var CLIMB_SPEED = 0.16
var RAPPEL_SPEED = 0.18
var WEB_ASCEND_SPEED = 0.24

var MAX_STEP = 2         // cells of rise a walker takes in stride
var SAFE_FALL = 14       // cells; beyond this an unprotected landing splats
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
var GUNWING_SHOTS = 12    // rounds RAMbo puts into the floor on the way past
var ENEMY_WALK_SPEED = 0.24
var GUN_AIM = 8           // regular shooter: a short visible tell, about a quarter-second
var SNIPER_AIM = 36       // the planted sniper keeps its deliberate long sight picture
var GUN_RELOAD = 80
var ENEMY_JET_SPEED = 0.30
var ENEMY_JET_SINK = 0.10

// Longer limits delayed stuck runs without rescuing additional agents in sweeps.
var LEVEL_LIMIT = 30 * 110
var NUKE_STAGGER = 5     // ticks between arming one agent and the next
var BLOCK_PATIENCE = 600 // ticks a blocker will hold having stopped nobody
var BLOCK_MAX = 900      // and the longest it will hold whatever happens

// Infection. The incubation is long on purpose: the whole point is that an
// infected agent is indistinguishable from the rest of the colony for most of
// it — same trait, same label, same decisions, and the followers still take
// their cue from it. The tell arrives late and small.
//
// The length is what splits the event's two outcomes, and it was tuned for
// that rather than for realism: at 300 ticks about two in five carriers turn
// and the rest reach the door still carrying it. Longer and the event mostly
// evaporates; shorter and it stops being a story and becomes a casualty.
var INCUBATION = 300     // ~10s from the touch to the turn
var INCUBATION_TELL = 90 // ticks of visible wrongness before it happens
var XENO_CAP = 3         // agents that may turn on one level, ever
var XENO_REACH = 1.3     // how close it has to get to pass it on
var XENO_COOL = 120      // and how long before it can do so again


var SKILL_ORDER = ["climber", "floater", "bomber", "blocker", "builder", "basher", "miner", "digger"]
var SKILL_LABELS = {
  climber: "Climb", floater: "Float", bomber: "Bomb", blocker: "Block",
  builder: "Build", basher: "Bash", miner: "Mine", digger: "Dig"
}

// Appended rather than inserted: the biome is picked by level number, so
// putting a new one anywhere but the end would re-skin every level above it.
// Palette.js derives the same index with the same rule and must be kept in
// step — see the note over poolTint there.
var BIOMES = ["Cavern", "Ruins", "Frost", "Foundry", "Jungle", "Ice Cave", "Spaceship", "Factory"]

var TRAITS = {
  steady:   { label: "steady",   turnLimit: 3, fallMargin: 0, bridgeAt: 8,  bashFirst: false, blockBias: 0, buildCap: 2, noFloat: false, standDown: 0, digBias: 0, pace: 1 },
  brave:    { label: "brave",    turnLimit: 5, fallMargin: 0, bridgeAt: 15, bashFirst: true,  blockBias: -1, buildCap: 1, noFloat: false, standDown: 0, digBias: 0, pace: 1.08 },
  cautious: { label: "cautious", turnLimit: 2, fallMargin: 3, bridgeAt: 3,  bashFirst: false, blockBias: 2, buildCap: 2, noFloat: false, standDown: 0, digBias: 0, pace: 0.9, wary: true },
  curious:  { label: "curious",  turnLimit: 2, fallMargin: 1, bridgeAt: 9,  bashFirst: false, blockBias: 0, buildCap: 2, noFloat: false, standDown: 0, digBias: 220, pace: 0.94 },
  stubborn: { label: "stubborn", turnLimit: 8, fallMargin: 0, bridgeAt: 9,  bashFirst: true,  blockBias: -1, buildCap: 2, noFloat: false, standDown: 0, digBias: -160, pace: 1.05 },
  tinkerer: { label: "tinkerer", turnLimit: 3, fallMargin: 2, bridgeAt: 7,  bashFirst: false, blockBias: 1, buildCap: 2, noFloat: false, standDown: 0, digBias: 150, pace: 0.92, wary: true, mineFirst: true },

  engineer: { label: "engineer", turnLimit: 3, fallMargin: 1, bridgeAt: 1,  bashFirst: false, blockBias: 0, buildCap: 5, noFloat: true,  standDown: 0, digBias: 0, pace: 0.96 },

  // standDown has to come in UNDER turnLimit: considerEscape zeroes `turns`
  // the moment it hits the limit, so a stand-down count above it can never be
  // reached and the sentinel blocked no more often than anybody else.
  sentinel: { label: "sentinel", turnLimit: 4, fallMargin: 1, bridgeAt: 7,  bashFirst: false, blockBias: 3, buildCap: 1, noFloat: false, standDown: 3, digBias: 0, pace: 1 },

  burrower: { label: "burrower", turnLimit: 2, fallMargin: 1, bridgeAt: 11, bashFirst: false, blockBias: 0, buildCap: 1, noFloat: false, standDown: 0, digBias: 340, pace: 0.9 },

  // The three below are the ones that reason about something other than the
  // ground in front of them, which is what `reserve`, `herd` and `wary` are
  // for. A trait built only out of the numeric dials is a relabelling of a
  // trait that already exists; these each needed a rule of their own.

  // Will not spend the last of a skill while anybody behind it might still
  // need it. Every other trait treats the toolbar as infinite until the moment
  // it isn't, which is how a colony arrives at the last wall with nothing left.
  hoarder:  { label: "hoarder",  turnLimit: 4, fallMargin: 1, bridgeAt: 10, bashFirst: false, blockBias: 1, buildCap: 1, noFloat: false, standDown: 0, digBias: 0, pace: 0.95, reserve: 3 },

  // Lands facing whichever way the nearest of its own is already walking. The
  // sim dropped its horizontal beacon on purpose (see exitFloor) because it
  // overrode what an agent could see; this is the one that still wants one,
  // and it asks a neighbour rather than the level.
  follower: { label: "follower", turnLimit: 3, fallMargin: 1, bridgeAt: 8,  bashFirst: false, blockBias: 0, buildCap: 2, noFloat: false, standDown: 0, digBias: 0, pace: 1.02, herd: 14 },

  // Sees a hazard's reach from outside it, like cautious, reaches for the
  // umbrella four cells before anybody else does, bridges rather than drops,
  // and never volunteers to stand in the way. The fast walk is the tell: it is
  // the one that is always somewhere else already.
  skittish: { label: "skittish", turnLimit: 2, fallMargin: 4, bridgeAt: 4,  bashFirst: false, blockBias: -2, buildCap: 2, noFloat: false, standDown: 0, digBias: 60, pace: 1.14, wary: true }
}

// Who turns up is a cast, not a uniform draw. A colony picks CAST_SIZE of the
// distinctive traits and fills the rest of its ranks with the ordinary three,
// so two or three agents share each oddity and it reads as character; fifteen
// different oddities read as noise. It also means a new trait widens the range
// of colonies you can meet instead of thinning every one of them — under the
// old flat pool, every trait added made all the others rarer.
var TRAIT_COMMON = ["steady", "steady", "steady", "brave", "cautious"]

// Only traits that are worth building a colony around. brave and cautious are
// deliberately absent: they are already in the common fill, so casting one
// would spend a slot on a personality that was turning up anyway.
var TRAIT_DISTINCT = [
  "curious", "stubborn", "tinkerer", "engineer", "sentinel",
  "burrower", "hoarder", "follower", "skittish"
]

var CAST_SIZE = 3

// Share of a colony drawn from the ordinary three. The rest is the cast.
var COMMON_SHARE = 0.55

var TRAIT_ORDER = [
  "steady", "brave", "cautious", "curious", "stubborn", "tinkerer",
  "engineer", "sentinel", "burrower", "hoarder", "follower", "skittish"
]

// Fisher-Yates on the world's own stream, so a pinned colonySeed still
// reproduces the colony exactly.
function shuffleWith(rng, list) {
  for (var i = list.length - 1; i > 0; i--) {
    var j = Math.floor(rng() * (i + 1))
    var t = list[i]; list[i] = list[j]; list[j] = t
  }
  return list
}

// The whole colony's traits, decided up front and dealt out one per release.
// Dealing from a bag rather than rolling per agent is what makes the cast a
// promise: pick sentinel for this colony and sentinels actually turn up.
function traitBag(w, n) {
  var cast = shuffleWith(w.traitRng, TRAIT_DISTINCT.slice()).slice(0, CAST_SIZE)
  var bag = []
  var commons = Math.round(n * COMMON_SHARE)
  for (var i = 0; i < commons && bag.length < n; i++)
    bag.push(TRAIT_COMMON[Math.floor(w.traitRng() * TRAIT_COMMON.length) % TRAIT_COMMON.length])
  for (var j = 0; bag.length < n; j++) bag.push(cast[j % cast.length])
  return shuffleWith(w.traitRng, bag)
}

function traitOf(ag) { return TRAITS[ag.trait] || TRAITS.steady }

// How fast this one walks. The only dial that is on show the whole time an
// agent is on its feet rather than only at the moment it meets an obstacle,
// which is what makes the rest of a personality readable: you can tell the
// dawdler from the strider before either of them reaches the ledge they are
// going to disagree about. It is not decoration — hazardExposure asks the
// same question, so a quick walker really can take a crossing a slow one
// correctly refuses.
function walkStep(ag) {
  return WALK_SPEED * (traitOf(ag).pace || 1) * (ag.chilledFor > 0 ? 0.48 : 1)
}

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

// terrainVersion tracks every cell change for rendering; carved tracks shape
// changes only, because the stall detector must ignore material recoloring.
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

// Level geometry is a pure function of the level number.

function makeRng(seed) {
  var s = ((seed + 1) * 2654435761) >>> 0
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length) % arr.length] }
function irand(rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)) }


var SKY = 7              // rows of open air above the earth
var CORR_H = 6           // carved headroom above a corridor floor
var CORR_GAP = 12        // default vertical distance between corridor floors
var N_CORR = 4           // default number of corridors

function corridorPlan(rng) {
  var n = irand(rng, 3, 5)
  var gap = n === 5 ? 10 : (n === 3 ? 13 : 12)
  var top = 9 + irand(rng, 0, 2)
  return { n: n, gap: gap, top: top }
}

// Draw.js cannot import Sim.js; shared constants travel on the world instead.
var K = {
  COLS: COLS, ROWS: ROWS, CELL: CELL, SKY: SKY,
  EMPTY: EMPTY, DIRT: DIRT, ROCK: ROCK, STEEL: STEEL, ORE: ORE,
  AGENT_H: AGENT_H,
  // Draw.js needs this one to know how much of an incubation is left to show.
  INCUBATION_TELL: INCUBATION_TELL,
  // RAMbo's burst pattern: twelve rounds, none going quite where the last one
  // did. Draw.js drew the tracers from its own copy of these numbers, which
  // is a duplicate that only stays correct by luck. Both of his moves fan by
  // it now — the wall he lays into an obstacle and the fan he rides down on —
  // because they are the same gun.
  SPRAY_SLOPES: SPRAY_SLOPES,
  // Rounds in RAMbo's flight. Draw.js paces the sweep by it and the recoil
  // kicks below are paced by the same number, so the shove always lands on
  // the frame the shot leaves the barrel.
  GUNWING_SHOTS: GUNWING_SHOTS
}

// `attempt` remains for deterministic tools and compatibility; hosts pass zero.
function generate(level, attempt, colonySeed) {
  attempt = attempt || 0
  var rng = makeRng(level)

  // The layout belongs to the level; the colony is random unless tests pass a seed.
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
    liquidVersion: -1,
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
    // Events draw from their own stream, off the same seed. Sharing traitRng
    // did two things wrong: the cast and the event schedule came out of the
    // same run of draws and so were correlated — the same mistake the whims
    // used to make — and eventSite consuming mid-level shifted the whims of
    // every agent still waiting at the hatch, so an event that fired changed
    // the personality of agents it had not met yet.
    eventRng: makeRng(colonySeed + 7919),
    traitCounts: {},

    // Events: what may happen to this level while it is being played, and the
    // modifiers a live one has switched on. See the block above stepEvents.
    events: [],
    eventLog: [],
    eventMechs: {},
    infections: 0,
    carrierHome: false,
    eventWarn: "",
    eventWarnFor: 0,
    eventFlash: 0,
    eventDrift: 0,
    driftWhat: "",
    eventBoost: 0,
    eventMult: 1,

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

  // Every agent counts and the run continues either way, so there is no
  // second, smaller number to reach: the bar is the whole colony. Anything
  // that needs a pass/fail line for tuning sets its own — see tools/simcheck.
  w.traitBag = traitBag(w, w.toRelease)

  w.skills = {
    climber: irand(rng, 12, 18) + attempt * 2,
    floater: w.toRelease + 2 + attempt * 2,
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
  biomeSkin(w, rng)

  // Last, because an event needs the corridors, the pits, the exit and the
  // hatch all settled before it can be told where it is not allowed to go.
  rollEvents(w, rng, w.eventRng)
}

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

  } else if (w.biome === "Factory") {
    // Machinery bolted into concrete. The Spaceship is a uniform grid because
    // a hull is manufactured all at once; a factory is not. Here the concrete
    // is the ground and the machines are lumps set into it at a spacing that
    // was decided by what fits, so the regularity is in the shapes and the
    // mezzanine decks rather than in where anything sits.
    // DIRT is the one material Palette tints; ROCK is derived from the theme
    // foreground and comes out the same cold grey in every biome. So the room
    // is DIRT and the machinery in it is ROCK, which is also the right way
    // round to look at: warm concrete with cold metal set into it.
    for (y = SKY; y < ROWS - 2; y++)
      for (x = 3; x < COLS - 3; x++)
        if (at(w, x, y) !== STEEL) setCell(w, x, y, DIRT)

    // Housings: rectangles, never blobs. Nothing in here grew. A handful of
    // big ones rather than a scatter of small ones — the first version had
    // twenty-odd and they stopped reading as machines and started reading as
    // texture, which is the failure this whole biome had to be pulled back
    // from. A machine room is a few large things you walk around.
    var housings = irand(rng, 5, 8)
    for (var hs2 = 0; hs2 < housings; hs2++) {
      var hx = irand(rng, 4, COLS - 16), hy = irand(rng, SKY + 1, ROWS - 12)
      var hw2 = irand(rng, 8, 14), hh2 = irand(rng, 5, 9)
      for (y = hy; y < hy + hh2; y++)
        for (x = hx; x < hx + hw2; x++) {
          if (at(w, x, y) === STEEL) continue
          // Hollow-ish: a shell of ORE with DIRT innards, so a bash through a
          // machine looks like it opened something rather than chipped a rock.
          var shell = y === hy || y === hy + hh2 - 1 || x === hx || x === hx + hw2 - 1
          setCell(w, x, y, shell ? ORE : ROCK)
        }
    }

    // Mezzanine decks: thin horizontal plate at a regular pitch, the one thing
    // in the room that was surveyed.
    for (y = SKY + irand(rng, 4, 8); y < ROWS - 4; y += irand(rng, 13, 19)) {
      for (x = 3; x < COLS - 3; x++) {
        if (at(w, x, y) === STEEL) continue
        if (rng() < 0.08) continue          // a missing plate here and there
        setCell(w, x, y, ORE)
      }
    }

    // Pipe runs dropping between the decks.
    var pipes = irand(rng, 3, 5)
    for (var pi2 = 0; pi2 < pipes; pi2++) {
      var px2 = irand(rng, 5, COLS - 6), py2 = SKY + irand(rng, 0, 5)
      var plen = irand(rng, 8, 26)
      for (var ps2 = 0; ps2 < plen; ps2++) {
        py2++
        if (py2 >= ROWS - 3) break
        if (at(w, px2, py2) !== STEEL) setCell(w, px2, py2, ORE)
      }
    }

  } else if (w.biome === "Jungle") {
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
  } else if (w.biome === "Factory") {
    // The lowest rates of any biome. The fittings below carry this room's
    // character on their own, and the general scatter was competing with them.
    floorRate = 0.07; ceilRate = 0.05; gap = 7
    floorKinds = ["spire", "spire", "clump"]
  }

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

  if (w.biome === "Factory") {
    for (var fi = 0; fi < corridors.length; fi++) {
      var fc = corridors[fi]
      // One flywheel per corridor at most, and a big one. Seventeen small
      // cogs at random heights read as stickers on the level rather than as
      // machinery in it; one large wheel on a bracket reads as a machine room.
      var cgy = fc.floorY - CORR_H - 4
      for (var cgTry = 0; cgTry < 8; cgTry++) {
        var cgx = fc.x0 + 6 + irand(rng, 0, Math.max(1, (fc.x1 - fc.x0) - 16))
        if (!solid(w, cgx, cgy) || !solid(w, cgx + 4, cgy)) continue
        w.decor.push({ x: cgx, y: cgy, kind: "cog", size: irand(rng, 4, 6), seed: Math.floor(rng() * 1000) })
        break
      }

      // Vents in the floor, breathing smoke up into the corridor.
      for (var vx = fc.x0 + 6; vx < fc.x1 - 5; vx += irand(rng, 26, 42)) {
        if (solid(w, vx, fc.floorY) && !solid(w, vx, fc.floorY - 1))
          w.decor.push({ x: vx, y: fc.floorY - 1, kind: "vent", size: 2, seed: Math.floor(rng() * 1000) })
      }

      // A pressure gauge or two, set into the wall over the walkway. Ornament
      // rather than repetition: this is the detail that says the place runs on
      // steam and somebody is supposed to be reading it.
      for (var gx3 = fc.x0 + 14; gx3 < fc.x1 - 8; gx3 += irand(rng, 46, 74)) {
        var gy3 = fc.floorY - CORR_H - 2
        // Two cells of backing, not one: a gauge is drawn wider than the cell
        // it is anchored to, and on a single solid cell it hangs out over the
        // dark and goes back to looking like a sticker on the level.
        if (solid(w, gx3, gy3) && solid(w, gx3 + 1, gy3) && solid(w, gx3, gy3 - 1))
          w.decor.push({ x: gx3, y: gy3, kind: "gauge", size: 2, seed: Math.floor(rng() * 1000) })
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

function roughFloor(w, c, rng, biome) {
  var amp, lumpy
  if (biome === "Jungle") { amp = 2; lumpy = 0.55 }        // roots, hollows, undergrowth
  else if (biome === "Ice Cave") { amp = 2; lumpy = 0.20 } // long smooth drifts
  else return   // everything else keeps the floor it had


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

  var lastOne = index === corridors.length - 1
  var kinds = lastOne
    ? ["wall", "collapse", "pillars", "towers", "step"]
    : ["wall", "collapse", "collapse", "pillars", "towers", "towers",
       "chasm", "chasm", "gap", "gap", "pit", "pit", "step"]
  // The floater needs a drop taller than SAFE_FALL, and the only landing far
  // enough down to be one is the corridor TWO floors below — see the cliff
  // case for why it has to be a real corridor and not just a deep hole.
  if (index < corridors.length - 2 && !lastOne) kinds.push("cliff")

  var count = lastOne ? irand(rng, 0, 1) : irand(rng, 2, 3)
  if (count === 0) return

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

      for (var apx = x - 3; apx < x; apx++)
        for (var apy = topCeil; apy < c.floorY; apy++) clearCell(w, apx, apy)
      for (var bpx = x + len; bpx < x + len + 3; bpx++)
        for (var bpy = topCeil; bpy < c.floorY; bpy++) clearCell(w, bpx, bpy)

      for (var sx = x; sx < x + len && sx <= hi; sx++) {
        for (var fy = c.floorY - rise; fy < c.floorY; fy++) setCell(w, sx, fy, DIRT)
        for (var cy = topCeil; cy < c.floorY - rise; cy++) clearCell(w, sx, cy)
      }

    } else if (kind === "chasm") {
      var span2 = irand(rng, 10, 17)
      var floorBelow = index + 1 < corridors.length ? corridors[index + 1].floorY : ROWS - 3
      for (var gx2 = x; gx2 < x + span2 && gx2 <= hi; gx2++)
        for (var gy2 = c.floorY; gy2 < floorBelow; gy2++) clearCell(w, gx2, gy2)

    } else if (kind === "collapse") {
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


var SPECIALS = [

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

function specialTraverse(w, ag, act, dry) {
  var reach = act === "speculate" ? 14 : (act === "chain" ? 12 : 11)
  var land = specialLanding(w, ag, reach)
  if (!land) return false
  if (dry) return true

  var d = ag.dir
  var fromX = Math.floor(ag.x), fromY = Math.floor(ag.y)
  ag.specialX = land.x
  ag.specialY = land.y
  if (act === "chain") {
    var linked = []
    for (var i = 0; i < w.agents.length && linked.length < 4; i++) {
      var link = w.agents[i]
      if (link === ag || link.gone || link.state === "saved" || link.state === "bomb"
          || link.state === "block" || link.state === "camp") continue
      if (Math.abs(link.x - ag.x) <= 9 && Math.abs(link.y - ag.y) <= 3) linked.push(link)
    }
    for (i = 0; i < linked.length; i++) {
      linked[i].x = land.x - d * (i + 1) * 0.8
      linked[i].y = land.y
      linked[i].dir = d
      linked[i].state = "walk"
      linked[i].fall = 0
    }
  } else if (act === "collapse") collapseCopy(w, ag)

  ag.x = land.x
  ag.y = land.y
  // Preserve the old action signal even though these moves do not carve. The
  // director has always treated a completed special traversal as world
  // progress, so terrainVersion doubles as an intentional activity version.
  w.terrainVersion++
  addDust(w, fromX + d * 2, fromY - 2, 8)
  return true
}

function specialShapeCut(w, ag, act, dry) {
  var fx = Math.floor(ag.x), fy = Math.floor(ag.y), d = ag.dir
  var moved = false
  var i, j, x, y
  if (act === "melt") {
    for (i = -5; i <= 5; i++) for (j = -5; j <= 5; j++) {
      if (i * i + j * j > 26) continue
      x = fx + d * 4 + i; y = fy - 2 + j
      if (y > fy) continue
      if (dry ? workable(w, x, y) : clearCell(w, x, y)) { if (dry) return true; moved = true }
    }
  } else if (act === "stomp") {
    for (i = -1; i <= 1; i++) for (j = 1; j <= 6; j++)
      if (dry ? workable(w, fx + i, fy + j) : clearCell(w, fx + i, fy + j)) {
        if (dry) return true; moved = true
      }
  } else if (act === "quarry") {
    for (i = 1; i <= 7; i++) for (j = -7; j <= 0; j++)
      if (dry ? workable(w, fx + d * i, fy + j) : clearCell(w, fx + d * i, fy + j)) {
        if (dry) return true; moved = true
      }
  } else if (act === "slab") {
    for (i = 1; i <= 6; i++) for (j = 1; j <= 3; j++) {
      x = fx + d * i; y = fy + j
      if (at(w, x, y) !== EMPTY || agentOccupiesCell(w, x, y, ag)) continue
      if (dry) return true
      setCell(w, x, y, ROCK); moved = true
    }
  }
  if (moved) {
    w.terrainVersion++
    addDust(w, fx + d * 2, fy - 2, 8)
  }
  return moved
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

  } else if (act === "chain" || act === "speculate" || act === "collapse") {
    return specialTraverse(w, ag, act, dry)

  } else if (act === "kick") {
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

  } else if (act === "melt" || act === "stomp" || act === "quarry" || act === "slab") {
    return specialShapeCut(w, ag, act, dry)

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


var HAZARDS = [
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
  { id: "packetloss", name: "Packet Loss", mech: "beam", mount: "ceiling", reach: 8, charge: 24, fire: 26, rest: 58, w: 7, h: 6, only: ["Spaceship"] },

  // Factory. One of each of the three mechanisms that suit a machine room: a
  // press that never stops, a wheel that reacts, and a vent that vents.
  { id: "stamper",  name: "Batch Process", mech: "cycle", mount: "ceiling", reach: 0, charge: 30, fire: 22, rest: 54, w: 5, h: 7, only: ["Factory"] },
  { id: "flywheel", name: "Spin Up", mech: "watch", mount: "wall", reach: 11, charge: 26, fire: 22, rest: 60, w: 4, h: 5, only: ["Factory"] },
  { id: "steamvent",name: "Memory Dump", mech: "cycle", mount: "floor", reach: 0, charge: 26, fire: 28, rest: 58, w: 4, h: 6, only: ["Factory"] }
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

  var x = -1
  for (var tryN = 0; tryN < spots.length; tryN++) {
    var cand = spots[tryN]
    if (cand + spec.w >= hi || cand <= lo) continue
    var ok = true
    for (var q = 0; q < spec.w; q++) {
      var qx = cand + q
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

function lineClear(w, x0, y0, x1, y1) {
  var steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
  if (steps === 0) return true
  for (var i = 1; i < steps; i++) {
    var t = i / steps
    if (solid(w, Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t))) return false
  }
  return true
}

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
  // A live blackout event stops every fixture where it stands; an overclock
  // runs them all twice as often. Both are the same dial, and both are the
  // reason a corridor the colony had learned to time stops behaving.
  var mult = w.eventBoost > 0 ? w.eventMult : 1
  if (mult === 0) return
  for (var pass = 0; pass < mult; pass++)
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
  return Math.abs(edge - ag.x) / walkStep(ag)
}

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

var EXIT_SIGHT = 30

function exitInSight(w, ag) {
  var e = w.exit
  var footY = Math.floor(ag.y)
  if (Math.abs(footY - exitFloor(w)) > 1) return 0
  var ex = e.x + e.w / 2
  var gap = ex - ag.x
  // A sight drift — a swarm, a whiteout, a storm — shortens how far the door
  // can be seen from. It is the only modifier that makes the wary traits worth
  // having, because everybody else is now navigating by what is underfoot.
  var sight = w.driftWhat === "sight" && w.eventDrift > 0 ? EXIT_SIGHT * 0.35 : EXIT_SIGHT
  if (Math.abs(gap) > sight || Math.abs(gap) < 1) return 0
  if (!lineClear(w, Math.floor(ag.x), footY - 1, Math.floor(ex), footY - 1)) return 0
  return gap > 0 ? 1 : -1
}

// Sees a hazard's reach from outside it instead of discovering it by walking
// in. Was a hardcoded pair of trait names; it is a dial now because it is the
// most consequential thing a personality can differ about, and a new trait
// should be able to have it without editing this function.
function hazardPerceptive(ag) {
  return traitOf(ag).wary === true
}

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

function hazardZoneAt(w, x, y, perceptive) {
  for (var i = 0; i < w.hazards.length; i++) {
    var h = w.hazards[i]
    if (h.wrecked || (!h.known && !perceptive)) continue
    if (hazardCovers(w, h, x, y)) return h
  }
  return null
}

function carveDescent(w, rng, c, next) {
  var x = c.handoffX
  var farX = c.dir > 0 ? c.x1 + 1 : c.x0 - 1

  if (rng() < 0.6) {
    for (var sx = Math.min(x, farX); sx <= Math.max(x, farX); sx++)
      for (var sy = c.floorY; sy < next.floorY; sy++) clearCell(w, sx, sy)
  } else {
    for (var i = 0; i <= Math.abs(farX - x); i++) {
      var mx = x + c.dir * i
      var top = Math.min(c.floorY + i, next.floorY)
      for (var my = top; my < next.floorY; my++) clearCell(w, mx, my)
    }
  }
}


function pitLiquid(biome) {
  if (biome === "Jungle" || biome === "Ruins") return "water"
  if (biome === "Foundry") return "lava"
  if (biome === "Spaceship") return "coolant"
  if (biome === "Factory") return "oil"
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

function cutCrossing(w, rng, c, landing, sealFrom) {
  var lo, hi
  if (c.dir > 0) { lo = landing + 10; hi = sealFrom - 6 }
  else { lo = sealFrom + 9; hi = landing - 10 }
  lo = Math.max(lo, c.x0 + 2)
  hi = Math.min(hi, c.x1 - 2)
  if (hi - lo + 1 < 9) return null

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

function liquidAt(w, x, y) {
  for (var i = 0; i < w.pits.length; i++) {
    var p = w.pits[i]
    if (!p.liquid) continue
    if (y !== undefined && p.wet) {
      var wx = Math.floor(x), wy = Math.floor(y)
      if (wx >= 0 && wx < COLS && wy >= 0 && wy < ROWS && p.wet[wy * COLS + wx]) return p
    } else if (x >= p.x0 && x <= p.x1) return p
  }
  return null
}

function updateLiquidFlow(w) {
  if (w.liquidVersion === w.terrainVersion) return
  w.liquidVersion = w.terrainVersion
  for (var pi = 0; pi < w.pits.length; pi++) {
    var p = w.pits[pi]
    if (!p.liquid) continue
    var wet = new Uint8Array(COLS * ROWS)
    var queue = []
    for (var x = p.x0; x <= p.x1; x++) {
      var seed = p.surfaceY * COLS + x
      if (!solid(w, x, p.surfaceY)) { wet[seed] = 1; queue.push(seed) }
    }
    for (var qi = 0; qi < queue.length; qi++) {
      var atIndex = queue[qi]
      var cx = atIndex % COLS
      var cy = Math.floor(atIndex / COLS)
      var near = [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]
      for (var ni = 0; ni < near.length; ni++) {
        var nx = near[ni][0], ny = near[ni][1]
        if (nx < 0 || nx >= COLS || ny < p.surfaceY || ny >= ROWS) continue
        var next = ny * COLS + nx
        if (wet[next] || solid(w, nx, ny)) continue
        wet[next] = 1
        queue.push(next)
      }
    }
    p.wet = wet
  }
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
  w.lastEvent = pool.liquid === "lava" ? "slag" : (pool.liquid === "oil" ? "sump" : "splash")
}


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
    if (next < 1.8 && next < now) {
      B.blockIdle = 0        // it just did its job, so it keeps standing
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Skill budget
// ---------------------------------------------------------------------------

function take(w, skill) {
  if (w.acting && w.acting.special) return false
  if ((w.skills[skill] || 0) <= 0) return false
  w.skills[skill]--
  w.lastUsed[skill] = w.ticks
  return true
}

// take(), but the agent gets an opinion about whether it should be the one
// spending this. Only a hoarder has one: it will not draw a skill down to its
// last unit while anybody behind it might still need that unit, and gives way
// the moment it is the last one walking. Everybody else treats the toolbar as
// infinite until the moment it isn't, which is how a colony reaches the final
// wall having spent its climbers on a ledge it could have walked around.
//
// Used only where a trait is already making the choice — the wall and the
// edge. A rescue, a director top-up or a special's move is not somewhere an
// agent's thrift gets a say.
function spend(w, ag, skill) {
  var reserve = traitOf(ag).reserve || 0
  if (reserve > 0) {
    // How many agents one unit of this skill has to serve. A flat "don't take
    // the last one" almost never fired: the toolbar starts with a dozen of
    // most things, so the stock only reaches one on levels that were already
    // lost. Measured against the queue instead, the thrift shows up when
    // supplies get tight, which is the only time it is worth anything.
    var coming = countComing(w, ag)
    var want = Math.ceil(coming / reserve)
    if (coming > 0 && (w.skills[skill] || 0) - 1 < want) return false
  }
  return take(w, skill)
}


// What an agent knows that isn't in front of its face: which way home is,
// vertically. That's it — there is no horizontal beacon any more. There used
// to be one, steering them on landing, and dropping it took the last thing
// that could override what an agent could actually see.

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

function canDescendHere(w, ag, requireWorkable) {
  var x = Math.floor(ag.x)
  var footY = Math.floor(ag.y)
  return exitBelow(w, ag) && corridorBelow(w, ag)
      && solid(w, x, footY + 1)
      && (!requireWorkable || at(w, x, footY + 1) !== STEEL)
}

// Every ordinary downward rescue uses this gate. Keeping the corridor, steel,
// preference and fallback rules together prevents one caller from rediscovering
// the level-255 bug where an agent dug repeatedly outside the corridor.
function startDescent(w, ag, pay, allowMine, traitPreference, fallback, requireWorkable) {
  if (!canDescendHere(w, ag, requireWorkable)) return false
  var preferMine = allowMine && ((traitPreference && traitOf(ag).mineFirst === true) || ag.id % 2 === 0)
  if (!fallback) {
    var mine = preferMine && canPlantMine(w, ag)
    if (!pay(w, mine ? "miner" : "digger")) return false
    if (mine) plantMine(w, ag)
    else { ag.state = "dig"; ag.timer = 0 }
    return true
  }
  if (preferMine && canPlantMine(w, ag) && pay(w, "miner")) {
    plantMine(w, ag)
    return true
  }
  if (pay(w, "digger")) {
    ag.state = "dig"
    ag.timer = 0
    return true
  }
  if (allowMine && canPlantMine(w, ag) && pay(w, "miner")) {
    plantMine(w, ag)
    return true
  }
  return false
}

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
  var wantUp = exitAbove(w, ag)
  var reach = wantUp ? RESCUE_CLIMB : MAX_CLIMB
  var climbable = h <= reach && footY - h >= SKY

  if (wantUp) bashFirst = false

  if (trait.bridgeAt <= 3 && h <= 6 && canStartBuild(w, ag) && spend(w, ag, "builder")) { startBuild(w, ag); return }

  if (bashFirst) {
    if (t <= BASH_REACH && spend(w, ag, "basher")) { ag.state = "bash"; ag.timer = 0; return }
    if (climbable && spend(w, ag, "climber")) { startClimb(w, ag); return }
  } else {
    if (climbable && spend(w, ag, "climber")) { startClimb(w, ag); return }
    // Climbers are the scarcest thing on the board and a pit will empty them.
    // A staircase is the other way up, and the one the level has plenty of —
    // so under the exit it comes before the bash rather than after it, and
    // brings its own allowance with it (see willBuild).
    if (wantUp && canStartBuild(w, ag) && spend(w, ag, "builder")) { startBuild(w, ag); return }
    if (t <= BASH_REACH && spend(w, ag, "basher")) { ag.state = "bash"; ag.timer = 0; return }
  }

  if (h <= MAX_CLIMB && canStartBuild(w, ag) && spend(w, ag, "builder")) { startBuild(w, ag); return }

  if (trait.standDown > 0 && ag.turns >= trait.standDown &&
      countComing(w, ag) >= 1 && spend(w, ag, "blocker")) {
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

  if (depth !== Infinity
      && hazardZoneAt(w, ax, footY + depth, hazardPerceptive(ag))) {
    // The landing is lethal, but the landing is not necessarily the route. If
    // there is still ground at this height on the far side, stay above the
    // danger and bridge to it. Level 15 is the worked example: every engineer
    // saw both the sentry below and a ledge sixteen cells ahead, but this early
    // return happened before any builder rule could consider the ledge.
    if (far > 2 && canStartBuild(w, ag) && spend(w, ag, "builder")) {
      startBuild(w, ag, true)
      return
    }
    turnAround(w, ag)
    return
  }


  if (depth === Infinity) {
    if (far > 2 && crossingHelps(w, ag) && canStartBuild(w, ag, true) && spend(w, ag, "builder")) { startBuild(w, ag, true); return }
    // Not when the way home is above: a blocker's job is to stop the colony
    // walking into a hole on its route, and a hole below an agent that is
    // already under the exit is not on anybody's route. Level 509 drops a
    // third of its colony into a pocket at the bottom, and the ones that met
    // the shaft down there planted their hands for a colony that could never
    // arrive — x50,y55 held seven times as many blocker-ticks as the whole of
    // the rest of that level. Turning round leaves them to the climb and dig
    // rules, which are at least trying to get them out.
    if (far <= 2 && !exitAbove(w, ag) && comingHere(w, ag) >= 2 - trait.blockBias
        && spend(w, ag, "blocker")) { ag.state = "block"; return }
    turnAround(w, ag)
    return
  }

  if (far > 2 && !exitBelow(w, ag) && depth > trait.bridgeAt + ag.bridgeBias
      && canStartBuild(w, ag) && spend(w, ag, "builder")) { startBuild(w, ag); return }

  if (trait.noFloat && far > 2 && depth > SAFE_FALL - trait.fallMargin
      && canStartBuild(w, ag) && spend(w, ag, "builder")) { startBuild(w, ag); return }

  var wantsChute = depth > SAFE_FALL - trait.fallMargin

  if (!wantsChute) { ag.x = nx; startFall(w, ag); return }

  if (spend(w, ag, "floater")) {
    ag.floater = true
    ag.x = nx
    startFall(w, ag)
    return
  }

  // Survivable after all, just not comfortably. Better than turning back.
  if (depth <= SAFE_FALL) { ag.x = nx; startFall(w, ag); return }

  turnAround(w, ag)
}

// How many others could actually walk into this spot. countComing below counts
// everybody still alive anywhere on the board, which is the right question for
// "is the level finished" and the wrong one for "is a blocker here worth an
// agent". An agent that has wandered into a pocket at the bottom of level 509,
// or out to the left board edge on 519, sees a dozen colleagues coming and
// plants its hands for them — and they were never going to arrive, so it
// stands there until the clock nukes it. Blocking is the only decision in the
// game an agent cannot undo, so it is worth asking the narrower question.
//
// Unreleased agents count only near the hatch, which is the one place they are
// genuinely on their way to.
function comingHere(w, ag) {
  var n = 0
  if (w.released < w.toRelease && w.hatch && Math.abs(w.hatch.x - ag.x) < 34)
    n += w.toRelease - w.released
  for (var i = 0; i < w.agents.length; i++) {
    var O = w.agents[i]
    if (O === ag || O.gone || O.state === "saved" || O.state === "block") continue
    if (Math.abs(O.y - ag.y) > 6 || Math.abs(O.x - ag.x) > 30) continue
    n++
  }
  return n
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

var RESCUE_CLIMB = 16    // as far up as wallHeight looks; past that there is no top

function climbOut(w, ag, pay) {
  if (!exitAbove(w, ag)) return false
  var footY = Math.floor(ag.y)
  for (var side = 0; side < 2; side++) {
    var dir = side === 0 ? ag.dir : -ag.dir
    var ax = Math.floor(ag.x) + dir
    if (!solid(w, ax, footY)) continue
    if (wallHeight(w, ax, footY) > RESCUE_CLIMB) continue
    if (!pay(w, "climber")) return false
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
  ag.turns = 0

  if (below) {
    return startDescent(w, ag, take, true, true, true, false)
  }

  // Up the wall if there is one worth taking, and build a way up if there is
  // not. The climb comes first: it costs one skill and gains sixteen courses,
  // where a build costs one and gains four.
  if (climbOut(w, ag, take)) return true
  if (canStartBuild(w, ag) && spend(w, ag, "builder")) { startBuild(w, ag); return true }
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
  ag.y = ladder.top + CLIMB_SPEED
  ag.timer = 0
}

// Is crossing this bottomless gap worth a builder, or is turning round the
// better answer? Bricks over a shaft are for a crossing that is on the way
// somewhere — the bottom pit between the landing and the exit is the case the
// rule was written for. An agent that has wandered past the exit and met a
// hole on the far side is not crossing toward anything, and the bridge it
// builds leads further from home than the ground it is standing on.
function crossingHelps(w, ag) {
  // Vertical business overrides horizontal: if the door is above or below,
  // which side of the shaft it is on tells you nothing useful.
  if (exitBelow(w, ag) || exitAbove(w, ag)) return true
  var exitMid = w.exit.x + w.exit.w / 2
  if (Math.abs(exitMid - ag.x) <= 2) return true
  return (exitMid > ag.x ? 1 : -1) === ag.dir
}

function buildDirection(w, ag) {
  // A bridge that answers a hole goes across that hole. The exit steer below
  // is for builds that are a free choice — a stalled agent, a director grant,
  // a wall met on open ground — and it must never turn a crossing round.
  //
  // Level 359 is the worked example: its pit sits to the left of the exit, so
  // an agent that walked left, met the lip and correctly decided to bridge a
  // bottomless gap had its direction flipped to face the exit, and laid the
  // bricks rightward along the floor it was already standing on. Seven agents
  // spent a builder each on that floor. It looked like a build in the wrong
  // place because it was one: the decision and the direction were being made
  // by two rules that never consulted each other.
  //
  // canStartBuild cannot catch this on its own — it tests the cells at foot
  // height, which are the open air above any floor, so building along solid
  // ground always looks possible.
  if (!solid(w, Math.floor(ag.x) + ag.dir, Math.floor(ag.y) + 1)) return ag.dir

  if (!exitBelow(w, ag)) {
    var exitMid = w.exit.x + w.exit.w / 2
    if (Math.abs(exitMid - ag.x) > 1) return exitMid > ag.x ? 1 : -1
  }
  return ag.dir
}

function startBuild(w, ag, flat) {
  ag.dir = buildDirection(w, ag)
  ag.state = "build"
  ag.bricks = 12
  ag.buildWait = 0
  ag.timer = 0
  ag.buildFlat = !!flat
  ag.built++
  w.buildSites.push({ x: ag.x, y: ag.y, tick: w.ticks })
}

function willBuild(ag, wantUp) {
  return ag.built < traitOf(ag).buildCap + (wantUp ? 2 : 0)
}

function canStartBuild(w, ag, urgent) {
  if (!willBuild(ag, exitAbove(w, ag))) return false
  var footY = Math.floor(ag.y)
  var fx = Math.floor(ag.x)
  var dir = buildDirection(w, ag)
  // A builder needs open body space for its first stride. Bricks answer empty
  // ground, not solid terrain: spending one against a wall made the agent walk
  // into the wall, abort, turn, and often buy another builder for the same
  // impossible move. Walls belong to climbers and bashers for every trait.
  for (var stride = 1; stride <= 2; stride++) {
    var bx = fx + dir * stride
    if (solid(w, bx, footY) || !headroom(w, bx, footY)) return false
  }
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
  var trait = w.traitBag && w.traitBag.length ? w.traitBag.pop() : "steady"
  return {
    id: w.nextId++,
    trait: trait,
    // Individual variation inside the personality, so two cautious agents
    // aren't the same agent twice. Shifts where its bridge-or-jump line
    // sits, and one in five reverses its instinct at a wall outright.
    //
    // Two draws, not one. Deriving both from a single number tied them
    // together: `whim < 0.2` forces the rounding below to -2 or -1, so every
    // contrary agent was also an eager bridger and no contrary agent could
    // ever be a reluctant one. Half the combinations did not exist.
    bridgeBias: Math.round(w.traitRng() * 5) - 2,
    contrary: w.traitRng() < 0.2,
    x: w.hatch.x + 0.5,
    y: w.hatch.y + AGENT_H,
    dir: w.startDir,
    state: "fall",
    // Not a flag an agent keeps. `floater` means "umbrella is out for THIS
    // fall" and is folded away on landing; there is no climber flag at all,
    // because every climb is paid for when it happens.
    floater: false,
    // Ticks until it turns, or 0. Deliberately affects nothing else: an
    // infected agent walks, builds, blocks and reads to the rest of the
    // colony exactly as it did before, which is the entire joke.
    infected: 0,
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
// Events
// ---------------------------------------------------------------------------
// A hazard is decided at generation and then runs on a timer. An event changes
// the level's premise while it is being played: the colony agreed on a route,
// and now the route is somewhere else. That re-decision is the thing worth
// watching, and it is why every event here moves terrain, water or the rules
// rather than simply dealing damage — damage is what the hazards are for.
//
// Each event is a row in a table over five mechanisms, in the same way every
// hazard is a row over six. Twenty-four bespoke events would be twenty-four
// sets of bugs; twenty-four rows over five mechanisms are five.
//
// Which events a level may see comes from the level seed, so level 42 is still
// recognisably level 42 — it is always the one that can flood. Whether and
// when they actually fire comes from the colony stream, so a retry is not a
// recording of the last attempt.

var EVENT_TELEGRAPH = 75    // ticks of warning before one lands
var EVENT_EARLIEST = 300    // nothing in the first ten seconds: let them commit
var EVENT_GAP = 450         // ticks between the two on a level that gets two

var EVENTS = [
  // --- Cavern ---
  { id: "cavein",   name: "Cache Eviction",   biome: "Cavern", mech: "collapse", at: "ceiling", span: 9, deep: 4 },
  { id: "spring",   name: "Data Leak",        biome: "Cavern", mech: "spill",    rise: 2 },
  { id: "bats",     name: "Swarm Intelligence",biome: "Cavern", mech: "drift",   what: "sight", ticks: 420 },

  // --- Ruins ---
  { id: "givesway", name: "Legacy Collapse",  biome: "Ruins",  mech: "collapse", at: "floor",   span: 7, deep: 2 },
  { id: "sandfall", name: "Backfill",         biome: "Ruins",  mech: "growth",   span: 12, high: 2 },
  { id: "waking",   name: "Daemon Restart",   biome: "Ruins",  mech: "blackout", mult: 2, ticks: 420 },

  // --- Frost ---
  { id: "whiteout", name: "Signal Loss",      biome: "Frost",  mech: "drift",    what: "sight", ticks: 480 },
  { id: "thaw",     name: "Thermal Throttle", biome: "Frost",  mech: "collapse", at: "floor",   span: 6, deep: 2 },
  { id: "avalanche",name: "Snowball Effect",  biome: "Frost",  mech: "growth",   span: 16, high: 2 },

  // --- Foundry ---
  { id: "pour",     name: "Hot Deploy",       biome: "Foundry",mech: "spill",    rise: 3 },
  { id: "surge",    name: "Overclock",        biome: "Foundry",mech: "blackout", mult: 2, ticks: 360 },
  { id: "cooling",  name: "Cold Storage",     biome: "Foundry",mech: "growth",   span: 10, high: 1 },

  // --- Jungle ---
  { id: "overgrow", name: "Dependency Hell",  biome: "Jungle", mech: "growth",   span: 14, high: 2 },
  { id: "downpour", name: "Cloud Burst",      biome: "Jungle", mech: "spill",    rise: 2 },
  { id: "forkbomb", name: "Fork Bomb",        biome: "Jungle", mech: "spawn",    kind: "gun", count: 2 },

  // --- Ice Cave ---
  { id: "freezeover",name: "Frozen Snapshot", biome: "Ice Cave", mech: "growth", span: 12, high: 1 },
  { id: "thecrack", name: "Breaking Change",  biome: "Ice Cave", mech: "collapse", at: "floor", span: 8, deep: 3 },
  { id: "blizzard", name: "Packet Storm",     biome: "Ice Cave", mech: "drift",  what: "sight", ticks: 450 },

  // --- Spaceship ---
  { id: "breach",   name: "Buffer Overflow",  biome: "Spaceship", mech: "collapse", at: "ceiling", span: 8, deep: 5 },
  { id: "nullgrav", name: "Null Gravity",     biome: "Spaceship", mech: "drift",  what: "fall",  ticks: 400 },
  { id: "xeno",     name: "Adversarial Input",biome: "Spaceship", mech: "infect" },

  // --- Factory ---
  { id: "scaleup",  name: "Scale Up",         biome: "Factory", mech: "blackout", mult: 2, ticks: 380 },
  { id: "oilspill", name: "Technical Debt",   biome: "Factory", mech: "spill",   rise: 3 },
  { id: "hardfault",name: "Hard Fault",       biome: "Factory", mech: "collapse", at: "ceiling", span: 7, deep: 4 }
]

function eventsFor(biome) {
  var out = []
  for (var i = 0; i < EVENTS.length; i++) if (EVENTS[i].biome === biome) out.push(EVENTS[i])
  return out
}

// Rolled at generation. `rng` is the level's stream and picks which of the
// biome's three are on the card; `trng` is the colony's and decides whether
// either of them actually happens, and when.
function rollEvents(w, rng, trng) {
  w.events = []
  w.eventLog = []
  w.eventMechs = {}
  var card = eventsFor(w.biome)
  if (!card.length) return
  card = shuffleWith(rng, card.slice())

  // A third of levels get one, and a twelfth of those get a second. Rare
  // enough to stay an event, often enough that you meet the whole table.
  var roll = trng()
  var count = roll < 0.08 ? 2 : (roll < 0.35 ? 1 : 0)
  if (count === 0) return

  var last = EVENT_EARLIEST
  for (var n = 0; n < count && n < card.length; n++) {
    var at = last + Math.floor(trng() * 420)
    if (at > LEVEL_LIMIT - 240) break
    w.events.push({ spec: card[n], at: at, fired: false })
    last = at + EVENT_GAP
  }
}

// Everything an event may not touch. The way home and the way in are the two
// places where a change of premise stops being drama and starts being a level
// that cannot be finished.
function eventSafeX(w, x) {
  if (w.exit && x >= w.exit.x - 6 && x <= w.exit.x + w.exit.w + 6) return false
  if (w.hatch && x >= w.hatch.x - 5 && x <= w.hatch.x + 5) return false
  return x > 3 && x < COLS - 4
}

function stepEvents(w) {
  if (!w.events || w.nuking || w.done) return
  w.eventDrift = Math.max(0, (w.eventDrift || 0) - 1)
  w.eventBoost = Math.max(0, (w.eventBoost || 0) - 1)
  if (w.eventDrift === 0) w.driftWhat = ""

  for (var i = 0; i < w.events.length; i++) {
    var e = w.events[i]
    if (e.fired) continue
    // The telegraph: named on the board before anything moves, so a level that
    // changes under the colony is never a level that changed without warning.
    if (w.ticks === e.at - EVENT_TELEGRAPH) {
      w.eventWarn = e.spec.name
      w.eventWarnFor = EVENT_TELEGRAPH
      w.lastEvent = e.spec.name
    }
    if (w.ticks >= e.at) { e.fired = true; fireEvent(w, e.spec) }
  }
  if (w.eventWarnFor > 0) w.eventWarnFor--
  if (w.eventFlash > 0) w.eventFlash--
  stepSpill(w)
}

function fireEvent(w, ev) {
  w.lastEvent = ev.name
  w.eventLog.push(ev.id)
  // The mechanism travels on the world, because Outcome.js needs it and the
  // core files cannot call each other. See the note in check-core-refs.
  w.eventMechs[ev.mech] = true
  w.eventFlash = 40
  if (ev.mech === "collapse") eventCollapse(w, ev)
  else if (ev.mech === "growth") eventGrowth(w, ev)
  else if (ev.mech === "spill") eventSpill(w, ev)
  else if (ev.mech === "blackout") { w.eventBoost = ev.ticks; w.eventMult = ev.mult }
  else if (ev.mech === "drift") { w.eventDrift = ev.ticks; w.driftWhat = ev.what }
  else if (ev.mech === "spawn") eventSpawn(w, ev)
  else if (ev.mech === "infect") eventInfect(w)
}

// Pick a corridor stretch the event is allowed to work on.
function eventSite(w, span) {
  if (!w.corridors || !w.corridors.length) return null
  for (var tries = 0; tries < 24; tries++) {
    var c = w.corridors[Math.floor(w.eventRng() * w.corridors.length) % w.corridors.length]
    var x = c.x0 + 3 + Math.floor(w.eventRng() * Math.max(1, (c.x1 - c.x0) - span - 6))
    if (!eventSafeX(w, x) || !eventSafeX(w, x + span)) continue
    return { c: c, x: x }
  }
  return null
}

function eventCollapse(w, ev) {
  var site = eventSite(w, ev.span)
  if (!site) return
  var top = ev.at === "ceiling" ? site.c.floorY - CORR_H - 1 - ev.deep : site.c.floorY
  for (var x = site.x; x < site.x + ev.span; x++)
    for (var y = top; y < top + ev.deep; y++) clearCell(w, x, y)
  addDust(w, site.x + ev.span / 2, top + ev.deep, 26)
}

function eventGrowth(w, ev) {
  var site = eventSite(w, ev.span)
  if (!site) return
  for (var x = site.x; x < site.x + ev.span; x++) {
    if (!solid(w, x, site.c.floorY)) continue
    for (var h = 0; h < ev.high; h++) {
      var y = site.c.floorY - 1 - h
      if (agentAt(w, x, y)) continue      // never close terrain over somebody
      setCell(w, x, y, DIRT)
    }
  }
  addDust(w, site.x + ev.span / 2, site.c.floorY - 1, 18)
}

// Is anybody standing in this cell? Growth that ignores this buries an agent
// in the ground it is walking on, which reads as the sim eating people.
function agentAt(w, x, y) {
  for (var i = 0; i < w.agents.length; i++) {
    var a = w.agents[i]
    if (a.gone || a.state === "saved") continue
    if (Math.floor(a.x) === x && (Math.floor(a.y) === y || Math.floor(a.y) - 1 === y)) return true
  }
  return false
}

function eventSpill(w, ev) {
  if (!w.pits || !w.pits.length) return
  for (var i = 0; i < w.pits.length; i++) {
    var p = w.pits[i]
    if (!p.liquid) continue
    // Never above the lip: a pool that climbs into the corridor is a level
    // that drowns everybody standing still, which is not a re-decision.
    p.rising = (p.rising || 0) + ev.rise
    p.floor2 = p.floorY + 2
    p.ripple = w.ticks
  }
}

function stepSpill(w) {
  if (!w.pits) return
  for (var i = 0; i < w.pits.length; i++) {
    var p = w.pits[i]
    if (!p.rising || p.rising <= 0) continue
    if (w.ticks % 26 !== 0) continue
    var to = Math.max(p.floor2 || p.floorY + 2, p.surfaceY - 1)
    if (to === p.surfaceY) { p.rising = 0; continue }
    p.surfaceY = to
    p.rising--
    p.ripple = w.ticks
    w.liquidVersion = -1     // the flood map is cached on terrainVersion
  }
}

// Something came aboard. There is nothing to see when it lands: the event
// names itself, one agent is quietly carrying it, and the level goes on
// looking exactly as it did.
function eventInfect(w) {
  var pool = []
  for (var i = 0; i < w.agents.length; i++) {
    var a = w.agents[i]
    if (a.gone || a.state === "saved" || a.infected > 0) continue
    pool.push(a)
  }
  if (!pool.length) return
  // Somewhere in the middle of the queue. The one out in front is too easy to
  // watch and the one at the back turns after everybody else is already home.
  infectAgent(w, pool[Math.floor(w.eventRng() * pool.length) % pool.length])
}

function infectAgent(w, ag) {
  if (!ag || ag.gone || ag.state === "saved" || ag.infected > 0) return false
  if (w.infections >= XENO_CAP) return false
  ag.infected = INCUBATION
  w.infections++
  w.lastEvent = "carrier"
  return true
}

// The turn. The agent is lost to the colony and something else is standing
// where it was — which is the one threat in this game that arrives from
// inside the fifteen rather than out of the guard house.
function turnAgent(w, ag) {
  ag.gone = true
  ag.state = "dead"
  w.lost++
  w.lastEvent = "turned"
  addBlood(w, ag.x, ag.y - 1.5, 18)
  w.enemies.push(makeXeno(w, ag.x, ag.y, ag.dir))
}

// Built here rather than by spawnEnemy, which always starts things at the
// enemy hatch. This one starts wherever the colony was standing, and a level
// with no guard house at all can still have one.
function makeXeno(w, x, y, dir) {
  return {
    id: w.nextEnemyId++, kind: "xeno",
    x: x, y: y, dir: dir || 1,
    state: "walk", deployLeft: 0,
    timer: 0, fall: 0, anim: 0, shoves: 0,
    targetId: 0, lineTo: 0, lineY: 0, shotFor: 0,
    touchCool: 0,
    gone: false
  }
}

function eventSpawn(w, ev) {
  if (!w.enemyHatch) return
  for (var n = 0; n < ev.count; n++) w.enemies.push(spawnEnemy(w, ev.kind))
}

// ---------------------------------------------------------------------------
// Per-state updates
// ---------------------------------------------------------------------------

function stepWalk(w, ag) {
  var nx = ag.x + ag.dir * walkStep(ag)
  var cx = Math.floor(nx)
  var footY = Math.floor(ag.y)

  // Turn toward a door it can see. Only when it is walking away from one, so
  // this steers rather than drives: everything else about the crossing — walls,
  // drops, dangers, personality — is decided exactly as before.
  var seen = exitInSight(w, ag)
  if (seen && seen !== ag.dir) {
    ag.dir = seen
    ag.turns = 0
    nx = ag.x + ag.dir * walkStep(ag)
    cx = Math.floor(nx)
  }

  if (anyBlockerNear(w, ag, nx)) { turnAround(w, ag); return }

  var crossPerceptive = hazardPerceptive(ag)
  var stepInto = hazardZoneAt(w, cx, footY, crossPerceptive)
  if (stepInto && stepInto.known && !ag.special
      && !hazardZoneAt(w, Math.floor(ag.x), footY, crossPerceptive)
      && !shieldCovering(w, ag, nx)
      && !canCrossHazard(w, stepInto, ag)) {
    if (startDescent(w, ag, take, false, false, false, true)) {
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

  if (hazardAhead(w, ag, nx)) {
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
      var outX = ag.x + ag.dir * walkStep(ag)
      return advanceWalk(w, ag, outX, Math.floor(outX), footY)
    }

    if ((w.skills.blocker || 0) > 1
        && countComing(w, ag) >= 2 - htrait.blockBias
        && !hazardZoneAt(w, Math.floor(ag.x), footY, perceptive)
        && take(w, "blocker")) { ag.state = "block"; return }
    turnAround(w, ag)
    return
  }

  advanceWalk(w, ag, nx, cx, footY)
}

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

// A follower lands facing whichever of its own is nearest and still on its
// feet. This is the horizontal beacon the simulation deliberately dropped —
// see the note above exitFloor — handed back to exactly one personality and
// sourced from a neighbour rather than from the level, so it steers one agent
// in the colony without overriding anything the others can see for themselves.
//
// Landing is the only moment it applies, and that is not a shortcut: a steer
// that ran every tick would be two followers turning to face each other for
// the rest of the level. Vertical distance counts double so it picks somebody
// on its own floor rather than somebody directly overhead.
function herdSteer(w, ag) {
  var reach = traitOf(ag).herd || 0
  if (reach <= 0) return
  var best = null
  var bestD = reach
  for (var i = 0; i < w.agents.length; i++) {
    var O = w.agents[i]
    if (O === ag || O.gone || O.state !== "walk") continue
    var d = Math.abs(O.x - ag.x) + Math.abs(O.y - ag.y) * 2
    if (d < bestD) { bestD = d; best = O }
  }
  if (best) ag.dir = best.dir
}

function stepFall(w, ag) {
  var speed = ag.floater && ag.fall > 2 ? FLOAT_SPEED : FALL_SPEED
  // Null gravity. Everything falls at umbrella speed for the duration, which
  // does not change what is survivable — SAFE_FALL is a distance, not a speed
  // — but does change how long everybody spends in the air deciding.
  if (w.driftWhat === "fall" && w.eventDrift > 0) speed = Math.min(speed, FLOAT_SPEED)
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
  var pool = liquidAt(w, cx, ny)
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
      herdSteer(w, ag)
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

  var ny = ag.y
  var rise = exitAbove(w, ag) ? 2 : 3
  if (!ag.buildFlat && (ag.bricks % rise) === 0
      && headroom(w, Math.floor(nx), Math.floor(ag.y) - 1)) ny = ag.y - 1

  if (solid(w, Math.floor(nx), Math.floor(ny))
      || !headroom(w, Math.floor(nx), Math.floor(ny))) {
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

// A blocker is the only thing on the board that chooses never to move again,
// and until now nothing ever released one. That is fine where the queue keeps
// arriving, and a disaster where it does not: on level 509 a third of the
// colony drops into a pocket at the bottom of the level, and the ones that
// meet the shaft lip down there plant their hands to protect a colony that
// cannot reach them, then stand in a dead end until the clock nukes them.
// x50,y55 accounted for seven times as many blocker-ticks as everywhere else
// on that level put together.
//
// So a blocker that has stopped nobody for BLOCK_PATIENCE gives up and walks.
// A blocker on a route anybody is actually using gets its counter reset long
// before that and stands as long as it is needed. Nothing is refunded: the
// skill was spent, and standing down only gets the agent its legs back.
function stepBlock(w, ag) {
  if (unsupported(w, ag)) { beginUncontrolledFall(w, ag); return }
  ag.anim++
  ag.blockIdle = (ag.blockIdle || 0) + 1
  ag.blockHeld = (ag.blockHeld || 0) + 1

  // The ceiling is not redundant with the patience above it. A blocker that
  // has trapped a handful of agents against itself gets its patience reset by
  // every one of them bouncing off it, so the pocket keeps the blocker
  // standing and the blocker keeps the pocket full — the counter that was
  // meant to release it is fed by the very thing it is causing.
  if (ag.blockIdle > BLOCK_PATIENCE || ag.blockHeld > BLOCK_MAX) {
    ag.blockIdle = 0
    ag.blockHeld = 0
    ag.state = "walk"
    ag.turns = 0
    ag.idle = 0
    w.lastEvent = "stood down"
  }
}

function stepBomb(w, ag) {
  ag.fuse--

  if (unsupported(w, ag)) {
    ag.fall += FALL_SPEED
    var ny = ag.y + FALL_SPEED
    var pool = liquidAt(w, Math.floor(ag.x), ny)
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
  if (unsupported(w, ag)) { beginUncontrolledFall(w, ag); return }

  if (ag.cool > 0) return
  var spec = specOf(ag)
  var fx = Math.floor(ag.x)
  var fy = Math.floor(ag.y)

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

var CEILING_GRIP = 260

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

function specialDropLanding(w, ag, nx, depth, mode) {
  var drift = {
    recoil: -3, cyclone: 4, web: 0, logchute: 3, balloon: -4,
    promptchute: 2, piledrive: 0, helicopter: 7, glasswing: 5,
    ghost: -3, gunwing: 4, tractor: 1, steps: 3, chain: 5,
    jetpack: 7, cushion: 2, extender: 0, shieldglider: 5
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
    jetpack: 4, cushion: 1.5, extender: 0, shieldglider: 3
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
      : (ag.heightMode === "chain" || ag.heightMode === "gunwing" ? 3 : 1.5)
    ag.y -= Math.sin(moveP * Math.PI) * lift
  }

  // RAMbo is not carrying the gun across, he is being pushed by it: he fires
  // at the floor and rides the recoil. So his climb arrives in kicks rather
  // than as one smooth arc — five shots, each a shove upward that sags before
  // the next one. The sine envelope is what keeps the trick honest: it goes to
  // zero at both ends, so the landing is still exactly where it was computed.
  if (ag.heightMode === "gunwing") {
    var kick = 1 - ((moveP * GUNWING_SHOTS) % 1)
    ag.y -= Math.sin(moveP * Math.PI) * kick * 0.55
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

  if ((spec.act === "chain" || spec.act === "speculate"
       || spec.act === "collapse")
      && ag.cool <= 0 && far > 1 && specialLanding(w, ag, 14)) {
    ag.state = "trick"
    ag.timer = 0
    return
  }

  if (spec.act === "ceiling" && ag.cool <= 0 && depth > SAFE_FALL) {
    var before = ag.state
    startCeiling(w, ag)
    if (ag.state === "ceil") return
    ag.state = before
  }

  if (spec.act === "slab" && ag.cool <= 0 && depth > 2) {
    if (specialCut(w, ag, "slab")) { ag.cool = spec.cool; return }
  }
  if (depth === Infinity) { turnAround(w, ag); return }

  if (depth <= SAFE_FALL) { ag.x = nx; startFall(w, ag); return }
  turnAround(w, ag)
}

function specialEscape(w, ag) {
  var fx = Math.floor(ag.x)
  var fy = Math.floor(ag.y)
  var floor = Math.floor((fy + 1) / (w.corrGap || CORR_GAP))
  if (specOf(ag).act === "ceiling" && startWebEscape(w, ag)) return
  if (exitAbove(w, ag) && startSpecialAscent(w, ag)) return
  if (canDescendHere(w, ag, true) && !ag.escapeFloors[floor]) {
    ag.escapeFloors[floor] = true
    ag.state = "dig"
    ag.timer = 0
    ag.still = 0
  } else if (!ag.escapeTunnels[floor]) {
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

  if (solid(w, cx, footY) || !solid(w, cx, footY + 1)
      || !crouchroom(w, cx, footY)) {
    ag.dir = -ag.dir
    ag.turns++
    // Reversing is only an answer if the other way is open. Wedged in a crouch
    // pocket with both ends shut, this flipped the agent's direction every
    // tick on the same spot for the rest of the level — and nothing came for
    // it, because the stuck detector only ever considers agents in `walk`.
    // Level 509 drops about a third of its colony into a pocket at the bottom
    // and that is where they stayed. Hand it back to walking after both ends
    // have been tried: a wall is something bashers and diggers have answers to,
    // and forceEscape can see it again.
    ag.slideStuck = (ag.slideStuck || 0) + 1
    if (ag.slideStuck >= 3) {
      ag.slideStuck = 0
      ag.state = "walk"
      ag.timer = 0
    }
    return
  }
  ag.slideStuck = 0

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
    ag.coveredFor = 4
    return s
  }
  return null
}

function shieldStops(w, ag, fromX) {
  var s = shieldCovering(w, ag, fromX)
  if (!s) return false
  s.blocked++
  s.blockFor = 10
  w.lastEvent = "request declined"
  return true
}

function raiseShield(w, ag) {
  if (ag.shieldHeld >= SHIELD_MAX) return false
  if (ag.shieldFor > 0) { ag.shieldFor = SHIELD_HOLD; return true }
  if (ag.cool > 0) return false
  ag.shieldFor = SHIELD_HOLD
  w.lastEvent = "shields up"
  return true
}

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

function woundFriendly(w, ag, fromX, lethal) {
  if (!ag || ag.gone || ag.state === "saved") return
  if (shieldStops(w, ag, fromX)) return
  ag.wounds = lethal ? 2 : (ag.wounds || 0) + 1
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
  if (ny >= ROWS) {
    en.gone = true
    en.state = "dead"
    w.enemiesKilled++
    w.lastEvent = "red team fell"
    return
  }
  var cx = Math.floor(en.x)
  var pool = liquidAt(w, cx, ny)
  if (pool && ny >= pool.surfaceY) {
    en.y = pool.surfaceY
    en.gone = true
    en.state = "dead"
    w.enemiesKilled++
    pool.ripple = w.ticks
    addDust(w, en.x, pool.surfaceY, 12)
    w.lastEvent = pool.liquid === "lava" ? "red team slag" : "red team splash"
    return
  }
  var shaft = pitAt(w, cx)
  for (var yy = Math.floor(en.y) + 1; yy <= Math.floor(ny) + 1; yy++) {
    // A pit stays bottomless for hostiles too. They previously landed on the
    // solid out-of-bounds row and patrolled the same impossible floor agents
    // were correctly falling through.
    if (shaft && yy >= shaft.floorY) continue
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

  // A xeno does not shoot, so it never enters the aim-and-retreat branch
  // below. It closes, and what it does on contact is not damage.
  if (en.kind === "xeno") {
    if (en.touchCool > 0) en.touchCool--
    var prey = enemyTarget(w, en, 26)
    if (prey) {
      en.targetId = prey.id
      en.dir = prey.x >= en.x ? 1 : -1
      if (Math.abs(prey.x - en.x) < XENO_REACH && Math.abs(prey.y - en.y) < 2.2) {
        // Past the cap it stops passing it on and is simply hostile, so a bad
        // roll cannot turn the whole colony into the thing hunting it.
        if (en.touchCool === 0 && infectAgent(w, prey)) en.touchCool = XENO_COOL
        else woundFriendly(w, prey, en.x, false)
        return
      }
    } else en.targetId = 0
  }

  var target = en.kind === "xeno" ? null : enemyTarget(w, en, 24)
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
        woundFriendly(w, ag, en.x, en.kind === "gun")
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
      // A moving queue can invalidate a shot during its tell. On level 282 the
      // regular gunner then paid half a reload, reacquired, aimed, lost that
      // target too, and spent the level displaying red dots without firing.
      // Keep the elapsed aim and transfer it to another clear target. The
      // planted sniper remains deliberate and pays the old reset penalty.
      var replacement = en.kind === "sniper" ? null : enemyTarget(w, en, 28)
      if (replacement) {
        aimed = replacement
        en.targetId = aimed.id
        en.dir = aimed.x >= en.x ? 1 : -1
      } else {
        en.state = "reload"
        en.timer = en.kind === "sniper" ? Math.round(GUN_RELOAD / 2) : GUN_RELOAD - 8
        return
      }
    }
    en.lineTo = aimed.x; en.lineY = aimed.y - 2
    if (en.timer >= (en.kind === "sniper" ? SNIPER_AIM : GUN_AIM)) {
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
          && Math.abs(retreatPeer.x - retreatX) <= Math.abs(retreatPeer.x - en.x)) {
        peerBlocked = true
        break
      }
    }
    if (!peerBlocked && !solid(w, retreatCell, retreatY)
        && solid(w, retreatCell, retreatY + 1) && headroom(w, retreatCell, retreatY)) en.x = retreatX
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

function grant(w, skill) {
  if (!take(w, skill)) return false
  w.granted[skill] = (w.granted[skill] || 0) + 1
  w.rescues++
  return true
}

var PATIENCE = 600

var LOOP_BUCKET = 5
var LOOP_PASSES = 5

var STUCK_LIMIT = PATIENCE + 240

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
      ag.idle = 0
      startBuild(w, ag)
    }
    return
  }

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
  if (startDescent(w, ag, grant, true, true, false, true)) {
    ag.idle = 0
    return
  }
  // The cap applies to director help too. Without it, the one mechanism meant
  // to rescue a stuck agent happily hands the keenest builder its eighteenth
  // bridge, and the pile of brickwork is what the rest then get stuck on.
  if (canStartBuild(w, ag) && grant(w, "builder")) {
    ag.idle = 0
    startBuild(w, ag)
    return
  }

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
  if (wantUp && climbOut(w, best, grant)) {
    // climbOut has already turned it to face whichever wall it is taking.
  } else if (wantUp && best.state === "walk" && canStartBuild(w, best) && grant(w, "builder")) {
    best.idle = 0
    startBuild(w, best)
  } else if (!wantUp && solid(w, ahead, footY) && at(w, ahead, footY) !== STEEL && grant(w, "basher")) {
    best.state = "bash"
    best.timer = 0
  } else if (startDescent(w, best, grant, true, false, false, true)) {
  } else if (best.state === "walk" && canStartBuild(w, best) && grant(w, "builder")) {
    startBuild(w, best)
  } else if (w.bombsUsed < 1 && w.rescues > 6 && boxedIn(w, best) && grant(w, "bomber")) {
    w.bombsUsed++
    best.state = "bomb"
    best.fuse = BOMB_FUSE
  }
  w.acting = null
}

// ---------------------------------------------------------------------------
// Main step
// ---------------------------------------------------------------------------

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
  if (ag.passes[key] !== LOOP_PASSES) return
  condemn(w, ag)
}

function condemn(w, ag) {
  if (ag.state === "bomb" || ag.state === "block" || ag.state === "camp" || ag.state === "saved") return
  if (ag.waitFor > 0) return

  if (ag.special && ag.idle < STUCK_LIMIT) { specialEscape(w, ag); return }
  // A special is barred from the toolbar, bombs included, so without this the
  // one agent that cannot be given a way out also cannot be cleared away — and
  // it would pace until the nuke on every level it got stuck on.
  if (!ag.special && !take(w, "bomber")) return
  ag.state = "bomb"
  ag.fuse = BOMB_FUSE
  ag.condemned = true
}

function stepAgents(w) {
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
    if (ag.infected > 0 && --ag.infected === 0) { turnAgent(w, ag); continue }
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

    // Stuck inside one cell. Not "getting nowhere" in the goalDist sense — the
    // literal same cell, tick after tick, which is what pacing in a pocket
    // looks like and what the bucket counter can never see.
    var cell = Math.floor(ag.x) + "," + Math.floor(ag.y)
    if (ag.state !== "walk") { ag.cell = cell; ag.still = 0 }
    else if (cell === ag.cell) ag.still++
    else { ag.cell = cell; ag.still = 0 }
    if (ag.still > JUMP_STILL && ag.state === "walk" && canJump(w, ag)) startJump(w, ag)

    if (ag.still > STILL_ESCAPE && ag.state === "walk") {
      ag.still = 0
      forceEscape(w, ag)
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
      // A carrier that beats its own incubation to the door goes home with it
      // and counts, like everybody else, as a rescue. It is the best outcome
      // this event has and the colony has no idea it happened.
      if (ag.infected > 0) { w.carrierHome = true; w.lastEvent = "carrier home" }
      else w.lastEvent = "saved"
      continue
    }

    active++
    // A camped sniper counts with the blockers here: it is standing somewhere
    // on purpose and it is never coming home either. Without this the level
    // waits for it and every Beam Search level runs to the nuke.
    if (ag.state === "block" || ag.state === "camp") blockers++
    if (ag.state !== "walk" || ag.idle < 300) moving++
  }
  return { active: active, blockers: blockers, moving: moving }
}
function finishWorldStep(w, active, blockers, moving) {
  for (var red = 0; red < w.enemies.length; red++) stepEnemy(w, w.enemies[red])

  if (active > 0 && active === blockers) {
    for (var b = 0; b < w.agents.length; b++) {
      var B2 = w.agents[b]
      if (B2.state === "block" || B2.state === "camp") {
        B2.state = "bomb"
        B2.fuse = BOMB_FUSE
      }
    }
  }

  stepEvents(w)
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

  // Terrain may have opened beside a pool during this tick. Update before the
  // host paints the frame so the spill appears with the bash or explosion.
  updateLiquidFlow(w)

  // A level nobody can finish still has to end, and it should end while it's
  // still worth looking at. Two cutoffs: a hard ceiling, and a much earlier
  // one for the common case where everybody bar a straggler or two is home and
  // the rest is going to be one agent pacing a ledge.
  if (!w.done) {
    var settled = w.saved + w.lost
    var nearlyDone = settled >= w.toRelease - 2 && w.released >= w.toRelease
    var allStuck = w.movingCount === 0
    if (w.stallTicks > 900
        || (nearlyDone && allStuck && w.stallTicks > 210)
        || (nearlyDone && w.stallTicks > 600)) {
      w.done = true
      w.doneTicks = 0
    }
  }
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
    w.released = w.toRelease
  }

  var counts = stepAgents(w)
  var active = counts.active
  var blockers = counts.blockers
  var moving = counts.moving


  finishWorldStep(w, active, blockers, moving)

  return w
}
