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
var MINE_INTERVAL = 7
var DIG_INTERVAL = 7
var BOMB_FUSE = 150      // 5 seconds, same as the original
var BOMB_RADIUS = 5

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

var BIOMES = ["Cavern", "Ruins", "Frost", "Foundry"]

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
var TRAITS = {
  steady:   { label: "steady",   turnLimit: 3, fallMargin: 0, bridgeAt: 8,  bashFirst: false, blockBias: 0 },
  brave:    { label: "brave",    turnLimit: 4, fallMargin: 0, bridgeAt: 13, bashFirst: true,  blockBias: 0 },
  cautious: { label: "cautious", turnLimit: 3, fallMargin: 2, bridgeAt: 4,  bashFirst: false, blockBias: 2 },
  curious:  { label: "curious",  turnLimit: 2, fallMargin: 1, bridgeAt: 9,  bashFirst: false, blockBias: 0 },
  stubborn: { label: "stubborn", turnLimit: 6, fallMargin: 0, bridgeAt: 9,  bashFirst: true,  blockBias: 0 },
  tinkerer: { label: "tinkerer", turnLimit: 3, fallMargin: 2, bridgeAt: 3,  bashFirst: false, blockBias: 1 }
}

// Weighted so most of the colony is unremarkable and the characters stand out.
// An even split just reads as noise.
var TRAIT_POOL = [
  "steady", "steady", "steady", "steady", "steady", "steady",
  "brave", "brave", "brave",
  "cautious", "cautious", "cautious",
  "curious", "curious",
  "stubborn", "stubborn",
  "tinkerer", "tinkerer"
]

var TRAIT_ORDER = ["steady", "brave", "cautious", "curious", "stubborn", "tinkerer"]

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

function setCell(w, x, y, v) {
  if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return
  var i = y * COLS + x
  if (w.terrain[i] === v) return
  w.terrain[i] = v
  w.terrainVersion++
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
var CORR_GAP = 12        // vertical distance between corridor floors
var N_CORR = 4

// Everything Draw.js needs to know about geometry and materials, stamped onto
// every world by generate(). Draw.js used to reach for these through a QML
// `.import`, which is the one line that stopped it loading in a browser — and
// the dependency was never real, since it only ever wanted constants and not a
// single function. Going through the world keeps one definition of each number:
// change COLS above and the renderer follows, which a copy in Draw.js wouldn't.
var K = {
  COLS: COLS, ROWS: ROWS, CELL: CELL, SKY: SKY,
  EMPTY: EMPTY, DIRT: DIRT, ROCK: ROCK, STEEL: STEEL
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
    terrain: new Uint8Array(COLS * ROWS),
    terrainVersion: 1,
    agents: [],
    particles: [],
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
  var corridors = []
  for (var k = 0; k < N_CORR; k++) {
    var dir = (k % 2 === 0) ? 1 : -1
    corridors.push({
      floorY: SKY + 9 + k * CORR_GAP,
      dir: dir,
      x0: 4,
      x1: COLS - 5
    })
  }

  // Where each corridor hands off to the one below: the far end in its walking
  // direction. The overshoot past it is the stretch where blocker-worthy
  // hazards go, since nothing on the route depends on it.
  for (var i = 0; i < corridors.length; i++) {
    var c = corridors[i]
    c.startX = c.dir > 0 ? c.x0 + 3 : c.x1 - 3
    c.handoffX = c.dir > 0 ? c.x1 - 10 : c.x0 + 10
    carveCorridor(w, c)
  }

  for (var j = 0; j < corridors.length; j++) {
    var cur = corridors[j]
    placeObstacles(w, rng, cur, j, corridors)
    // Middle corridors only: not the first (its near end is the hatch's
    // landing pad) and not the last (its near end is where the exit goes).
    if (j > 0 && j < corridors.length - 1 && rng() < 0.85) placeVoid(w, cur, corridors[j - 1])
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
  var hx = first.startX
  for (var sy = SKY - 2; sy < first.floorY; sy++)
    for (var sx = hx - 2; sx <= hx + 2; sx++) clearCell(w, sx, sy)
  w.hatch = { x: hx, y: 3 }

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
    climber: irand(rng, 5, 9) + attempt * 2,
    floater: w.toRelease + 2 + attempt * 2,
    bomber: irand(rng, 1, 2),
    blocker: irand(rng, 2, 4) + attempt,
    builder: irand(rng, 10, 16) + attempt * 3,
    basher: irand(rng, 6, 12) + attempt * 3,
    miner: irand(rng, 4, 8) + attempt * 2,
    digger: irand(rng, 6, 10) + attempt * 2
  }
  for (var s = 0; s < SKILL_ORDER.length; s++) w.granted[SKILL_ORDER[s]] = 0

  return w
}

// Solid everywhere below the sky: a dirt crust over rock, with a wavy boundary
// and a scatter of pockets so a cross-section doesn't read as two flat bands.
function fillEarth(w, rng) {
  var phase = rng() * 6.28
  var phase2 = rng() * 6.28
  for (var y = 0; y < ROWS; y++) {
    for (var x = 0; x < COLS; x++) {
      var t
      if (y < SKY) t = EMPTY
      else if (y >= ROWS - 2) t = STEEL          // bedrock
      else if (x < 3 || x >= COLS - 3) t = STEEL // side walls: nothing leaves the board
      else {
        var crust = SKY + 20 + Math.round(5 * Math.sin(x * 0.11 + phase) + 3 * Math.sin(x * 0.27 + phase2))
        t = y < crust ? DIRT : ROCK
      }
      w.terrain[y * COLS + x] = t
    }
  }

  // Texture: rock blobs riding in the dirt and dirt pockets down in the rock.
  // Fewer and bigger than they were — a scatter of small ones just reads as
  // noise at this scale, where a handful of large ones read as strata.
  for (var b = 0; b < 15; b++) {
    var bx = irand(rng, 5, COLS - 6)
    var by = irand(rng, SKY + 2, ROWS - 5)
    var br = irand(rng, 3, 6)
    var mat = at(w, bx, by) === DIRT ? ROCK : DIRT
    for (var dy = -br; dy <= br; dy++) {
      for (var dx = -br; dx <= br; dx++) {
        if (dx * dx + dy * dy > br * br) continue
        if (at(w, bx + dx, by + dy) === STEEL) continue
        setCell(w, bx + dx, by + dy, mat)
      }
    }
  }
}

function carveCorridor(w, c) {
  for (var x = c.x0; x <= c.x1; x++)
    for (var y = c.floorY - CORR_H; y < c.floorY; y++) clearCell(w, x, y)
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
  var lastOne = index === N_CORR - 1
  var kinds = lastOne
    ? ["wall", "pillars", "pillars", "step"]
    : ["wall", "wall", "pillars", "pillars", "chasm", "chasm", "gap", "pit", "step"]
  // The floater needs a drop taller than SAFE_FALL, and the only landing far
  // enough down to be one is the corridor TWO floors below — see the cliff
  // case for why it has to be a real corridor and not just a deep hole.
  if (index < N_CORR - 2 && !lastOne) kinds.push("cliff")

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
      var floorBelow = index + 1 < N_CORR ? corridors[index + 1].floorY : ROWS - 3
      for (var gx2 = x; gx2 < x + span2 && gx2 <= hi; gx2++)
        for (var gy2 = c.floorY; gy2 < floorBelow; gy2++) clearCell(w, gx2, gy2)

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
function placeVoid(w, c, prev) {
  // Hard against the side wall. There is less room back here than it looks —
  // the drop from the corridor above lands about ten cells off the wall, and
  // the hole has to sit beyond that without being where anyone arrives.
  var nearX = c.dir > 0 ? c.x0 + 3 : c.x1 - 3
  var landing = prev ? prev.handoffX : (c.dir > 0 ? c.x1 : c.x0)
  if (Math.abs(landing - nearX) < 4) return

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
function placeHazard(w, rng, c) {
  var x = c.dir > 0 ? c.x1 - 5 : c.x0 + 5
  if (rng() < 0.5) {
    // Cut through the bedrock too, so this really has no bottom. Stopping at
    // the bedrock instead makes a five-cell-wide oubliette: survivable to fall
    // into, walled too high to climb, and the single most reliable way to
    // strand an agent for the rest of the level. Open at the bottom, it reads
    // as Infinity to dropDepth(), which is what the blocker rule looks for.
    for (var sx = x - 2; sx <= x + 2; sx++)
      for (var sy = c.floorY; sy < ROWS; sy++) setCell(w, sx, sy, EMPTY)
  } else {
    for (var px = x; px < x + 2; px++)
      for (var py = c.floorY - CORR_H; py < c.floorY; py++) setCell(w, px, py, STEEL)
  }
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
    if (Math.abs(nx - B.x) < 1.8) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Skill budget
// ---------------------------------------------------------------------------

function take(w, skill) {
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
  if (trait.bridgeAt <= 3 && h <= 6 && willBuild(ag) && take(w, "builder")) { startBuild(w, ag); return }

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
  if (h <= MAX_CLIMB && willBuild(ag) && take(w, "builder")) { startBuild(w, ag); return }

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

  if (depth === Infinity) {
    // Someone should stand here. Worth a blocker while there are still others
    // on their way to walk into it — which is the whole job of the skill.
    if (countComing(w, ag) >= 2 - trait.blockBias && take(w, "blocker")) { ag.state = "block"; return }
    if (far > 2 && take(w, "builder")) { startBuild(w, ag); return }
    turnAround(w, ag)
    return
  }

  // A gap with the far side in reach is what a builder is for. Where the line
  // sits between "bridge this" and "just step off" is the clearest thing
  // personality does to an agent's behaviour: a cautious one bridges a drop a
  // brave one walks straight off, and you can watch them disagree about the
  // same ledge, one after the other.
  if (far > 2 && depth > trait.bridgeAt + ag.bridgeBias && willBuild(ag) && take(w, "builder")) { startBuild(w, ag); return }

  // The umbrella comes out early for the ones who like a margin. It can only
  // ever come out EARLIER than the lethal limit, never later — a personality
  // that gets its owner killed isn't a personality, it's a bug.
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
    // Half of them cut a diagonal ramp instead of sinking a shaft.
    // Keyed off the agent's own id so it's a settled trait rather than a
    // coin flip, and so both skills actually get used — ordering digger first
    // for everyone meant the miner was a number on the toolbar that never
    // moved, because the digger budget almost never ran out.
    var ramp = ag.id % 2 === 0
    if (ramp && take(w, "miner")) { ag.state = "mine"; ag.timer = 0; return true }
    if (take(w, "digger")) { ag.state = "dig"; ag.timer = 0; return true }
    if (take(w, "miner")) { ag.state = "mine"; ag.timer = 0; return true }
    return false
  }

  // Nothing to climb from here, so the only way up is to build one.
  if (take(w, "builder")) { startBuild(w, ag); return true }
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
  ag.timer = 0
  ag.built++
}

// An agent that has already laid two bridges has stopped solving anything and
// started building on its own brickwork: every bridge leaves a new ledge and a
// new wall, which reads to the next decision as another obstacle worth
// bridging. Left uncapped, the keen ones spend a whole level constructing a
// private folly, and the earth they add is what the ones behind them then get
// stuck on.
function willBuild(ag) { return ag.built < 2 }

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
    dir: 1,
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

  // A brick is three cells laid at foot level; the agent then steps along it.
  for (var i = 0; i < 3; i++) setCell(w, bx + ag.dir * i, footY + 1, DIRT)

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
    // Even level is blocked. Turn and walk back along what's been laid.
    ag.dir = -ag.dir
    ag.state = "walk"
    return
  }

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

function stepMine(w, ag) {
  ag.timer++
  if (ag.timer < MINE_INTERVAL) return
  ag.timer = 0

  var footY = Math.floor(ag.y)
  var ax = Math.floor(ag.x) + ag.dir

  if (hitsSteel(w, Math.min(ax, ax + ag.dir), footY, Math.max(ax, ax + ag.dir), footY + 2)) {
    ag.state = "walk"
    turnAround(w, ag)
    return
  }

  for (var dx = 0; dx < 2; dx++)
    for (var dy = -AGENT_H; dy <= 2; dy++) clearCell(w, ax + ag.dir * dx, footY + dy)

  addDust(w, ax, footY, 3)
  ag.x += ag.dir
  ag.y += 1
  ag.anim++

  // Stop on reaching the exit's own level. Starting a shaft because the exit
  // is below you is right; carrying on once you're level with it is how a
  // agent ends up on the bedrock under the room it was digging towards, and
  // the ones who follow it down the shaft end up there too.
  if (!exitBelow(w, ag)) { ag.state = "walk"; return }

  if (!solid(w, Math.floor(ag.x), Math.floor(ag.y) + 1)) beginUncontrolledFall(w, ag)
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

function stepBlock(w, ag) {
  // A blocker with nothing under it stops blocking — the ground it was holding
  // has been dug out from beneath, usually by whoever it turned back.
  if (!solid(w, Math.floor(ag.x), Math.floor(ag.y) + 1)) { beginUncontrolledFall(w, ag); return }
  ag.anim++

  // It does not stand down, ever. A blocker is an agent that has given up
  // going home so the ones behind it don't walk into a hole, and letting it
  // wander off after a decent interval — which is what this used to do — takes
  // the cost out of the only skill whose whole point is the cost.
}

function stepBomb(w, ag) {
  ag.fuse--
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
  ag.idle = 0
  var footY = Math.floor(ag.y)
  var ahead = Math.floor(ag.x) + ag.dir

  if (exitAbove(w, ag)) {
    // Below the exit: the only useful direction is up.
    if (solid(w, ahead, footY) && wallHeight(w, ahead, footY) <= MAX_CLIMB
        && grant(w, "climber")) { startClimb(w, ag); return }
    if (willBuild(ag) && grant(w, "builder")) startBuild(w, ag)
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
    ag.state = "bash"
    ag.timer = 0
    return
  }
  if (solid(w, behind, footY) && at(w, behind, footY) !== STEEL && grant(w, "basher")) {
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
    var ramp = ag.id % 2 === 0
    if (grant(w, ramp ? "miner" : "digger")) {
      ag.state = ramp ? "mine" : "dig"
      ag.timer = 0
      return
    }
  }
  // The cap applies to director help too. Without it, the one mechanism meant
  // to rescue a stuck agent happily hands the keenest builder its eighteenth
  // bridge, and the pile of brickwork is what the rest then get stuck on.
  if (willBuild(ag) && grant(w, "builder")) {
    startBuild(w, ag)
    return
  }

  // Nothing applied. Don't hand back a full patience timer for having done
  // nothing — come round again in half the time.
  ag.idle = PATIENCE / 2
}

function runDirector(w) {
  var mark = w.saved * 1000 + w.lost * 100 + w.terrainVersion
  if (mark !== w.progressMark) {
    w.progressMark = mark
    w.stallTicks = 0
    return
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

  var footY = Math.floor(best.y)
  var ahead = Math.floor(best.x) + best.dir
  var wantUp = exitAbove(w, best)

  // Below the exit and pacing: nothing horizontal helps, and digging only
  // makes it worse. Hand them a climb.
  var rampy = best.id % 2 === 0
  if (wantUp && solid(w, ahead, footY) && wallHeight(w, ahead, footY) <= MAX_CLIMB
      && grant(w, "climber")) {
    startClimb(w, best)
  } else if (solid(w, ahead, footY) && at(w, ahead, footY) !== STEEL && grant(w, "basher")) {
    best.state = "bash"
    best.timer = 0
  } else if (exitBelow(w, best) && solid(w, Math.floor(best.x), footY + 1)
             && at(w, Math.floor(best.x), footY + 1) !== STEEL
             && grant(w, rampy ? "miner" : "digger")) {
    best.state = rampy ? "mine" : "dig"
    best.timer = 0
  } else if (best.state === "walk" && willBuild(best) && grant(w, "builder")) {
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
}

// ---------------------------------------------------------------------------
// Main step
// ---------------------------------------------------------------------------

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
    var dist = goalDist(w, ag)
    if (dist < ag.markD - 2) {
      ag.markD = dist
      ag.idle = 0
      ag.turns = 0
    } else {
      ag.idle++
    }

    // Getting nowhere for long enough: stop waiting for the budget to allow it
    // (see forceEscape). Only from a walk, so it never interrupts work already
    // under way.
    if (ag.state === "walk" && ag.idle > PATIENCE) forceEscape(w, ag)

    switch (ag.state) {
      case "walk": stepWalk(w, ag); break
      case "fall": stepFall(w, ag); break
      case "climb": stepClimb(w, ag); break
      case "build": stepBuild(w, ag); break
      case "bash": stepBash(w, ag); break
      case "mine": stepMine(w, ag); break
      case "dig": stepDig(w, ag); break
      case "block": stepBlock(w, ag); break
      case "bomb": stepBomb(w, ag); break
    }

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
    if (ag.state === "block") blockers++
    if (ag.state !== "walk" || ag.idle < 300) moving++
  }

  // Everyone who was going to get home has, and the only ones left standing are
  // the ones holding the door. They light their own fuses — which is exactly
  // what a player does at the end of a level, and the honest end to the bargain
  // they made. They don't walk away from it.
  if (active > 0 && active === blockers) {
    for (var b = 0; b < w.agents.length; b++) {
      var B2 = w.agents[b]
      if (B2.state === "block") {
        B2.state = "bomb"
        B2.fuse = BOMB_FUSE
      }
    }
  }

  stepParticles(w)
  if (!w.done) runDirector(w)

  w.active = active
  w.movingCount = moving

  if (!w.done && w.released >= w.toRelease && active === 0) {
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
