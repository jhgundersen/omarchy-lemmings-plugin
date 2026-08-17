// Everything the simulation looks like. Sim.js owns state and never knows a
// color; this file owns pixels and never changes one.
//
// It has no imports of any kind, which is deliberate: it draws onto a canvas
// 2D context, and that API is the same in QML and in a browser, so the same
// file serves the bar plugin and the web version with nothing swapped out. The
// geometry and material constants it needs arrive on the world as `w.k` rather
// than through an import — see the note on K in Sim.js.
//
// Two canvases share this: the terrain layer repaints only when the earth
// actually moves (Sim bumps terrainVersion), the actor layer every tick. That
// split is what keeps a boardful of diggers cheap — the expensive redraw only
// happens when someone removes a cell.
//
// The palette arrives from the caller — Panel.qml from the Omarchy theme, the
// web page from a theme it picks — so the earth, sky and portal shift with it.
// The agents themselves keep the green hair and blue robe: that silhouette IS
// the joke, and at sixteen pixels tall it's the only thing making them read as
// a doomed colony rather than as pixels.

var SPRITE_W = 8
var SPRITE_PX = 16

// ---------------------------------------------------------------------------
// Terrain layer
// ---------------------------------------------------------------------------

function materialFill(k, pal, m) {
  if (m === k.DIRT) return pal.dirt
  if (m === k.ROCK) return pal.rock
  if (m === k.ORE) return pal.ore
  return pal.steel
}

function materialEdge(k, pal, m) {
  if (m === k.DIRT) return pal.dirtEdge
  if (m === k.ROCK) return pal.rockEdge
  if (m === k.ORE) return pal.oreEdge
  return pal.steelEdge
}

function materialShade(k, pal, m) {
  if (m === k.DIRT) return pal.dirtShade
  if (m === k.ROCK) return pal.rockShade
  if (m === k.ORE) return pal.oreShade
  return pal.steelShade
}

function drawTerrain(ctx, w, pal) {
  var k = w.k
  var C = k.CELL
  var cols = k.COLS
  var rows = k.ROWS

  ctx.reset()

  // Sky: a shallow gradient so the open air above the earth has some depth
  // rather than reading as a flat panel background.
  var sky = ctx.createLinearGradient(0, 0, 0, k.SKY * C + C * 4)
  sky.addColorStop(0, pal.skyTop)
  sky.addColorStop(1, pal.skyLow)
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, cols * C, rows * C)

  // Body of the earth, drawn as horizontal runs of like material. A level is
  // a few hundred runs where it would be several thousand cells, which is the
  // difference between this repainting comfortably mid-dig and not.
  for (var y = 0; y < rows; y++) {
    var x = 0
    var base = y * cols
    while (x < cols) {
      var m = w.terrain[base + x]
      if (m === k.EMPTY) { x++; continue }
      var start = x
      while (x < cols && w.terrain[base + x] === m) x++
      ctx.fillStyle = materialFill(k, pal, m)
      ctx.fillRect(start * C, y * C, (x - start) * C, C)
    }
  }

  // Undersides first: a cell with open air BELOW it gets a darker lip, so
  // ceilings and overhangs read as receding rather than as more floor.
  for (var sy2 = 0; sy2 < rows; sy2++) {
    var sx2 = 0
    var sbase = sy2 * cols
    while (sx2 < cols) {
      var sm = w.terrain[sbase + sx2]
      if (sm === k.EMPTY || sy2 + 1 >= rows || w.terrain[sbase + cols + sx2] !== k.EMPTY) { sx2++; continue }
      var sstart = sx2
      while (sx2 < cols && w.terrain[sbase + sx2] === sm
             && sy2 + 1 < rows && w.terrain[sbase + cols + sx2] === k.EMPTY) sx2++
      ctx.fillStyle = materialShade(k, pal, sm)
      ctx.fillRect(sstart * C, sy2 * C + C - 2, (sx2 - sstart) * C, 2)
    }
  }

  // Lit top surfaces. Every cell with open air above it gets a bright lip,
  // which is what turns a mass of flat color into something with a shape —
  // and makes a freshly bashed tunnel legible the moment it opens.
  for (var ey = 0; ey < rows; ey++) {
    var ex = 0
    var ebase = ey * cols
    while (ex < cols) {
      var em = w.terrain[ebase + ex]
      if (em === k.EMPTY || (ey > 0 && w.terrain[ebase - cols + ex] !== k.EMPTY)) { ex++; continue }
      var estart = ex
      while (ex < cols && w.terrain[ebase + ex] === em
             && (ey === 0 || w.terrain[ebase - cols + ex] === k.EMPTY)) ex++
      ctx.fillStyle = materialEdge(k, pal, em)
      ctx.fillRect(estart * C, ey * C, (ex - estart) * C, Math.max(1, C - 2))
    }
  }

  // Depth wash: the deeper the earth, the darker. One pass, cheap, and it
  // stops the lower half of the board looking like the upper half.
  var wash = ctx.createLinearGradient(0, k.SKY * C, 0, rows * C)
  wash.addColorStop(0, pal.washTop)
  wash.addColorStop(1, pal.washLow)
  ctx.fillStyle = wash
  ctx.fillRect(0, k.SKY * C, cols * C, (rows - k.SKY) * C)

  drawDecor(ctx, w, pal)
  drawExitBack(ctx, w, pal)
}

// Scenery: things standing on the floor and hanging from the ceiling. Drawn on
// the terrain layer, because it changes exactly when the terrain does and
// there is no reason to pay for it every tick.
//
// Each piece checks the cell it stands on is still there. Sim.js keeps decor
// out of the terrain grid entirely so it can never be an obstacle, which means
// nothing removes a stalagmite when the floor under it is dug away — so the
// renderer simply stops drawing one that is standing on nothing.
function drawDecor(ctx, w, pal) {
  var k = w.k
  var C = k.CELL
  for (var i = 0; i < w.decor.length; i++) {
    var d = w.decor[i]
    var px = d.x * C
    var py = d.y * C

    if (d.kind === "hang") {
      if (w.terrain[(d.y - 1) * k.COLS + d.x] === k.EMPTY) continue
      if (w.terrain[d.y * k.COLS + d.x] !== k.EMPTY) continue
    } else {
      if (w.terrain[(d.y + 1) * k.COLS + d.x] === k.EMPTY) continue
      if (w.terrain[d.y * k.COLS + d.x] !== k.EMPTY) continue
    }

    // The biome decides what the same four shapes are made of. A spire is a
    // stalagmite in a cavern, a fallen column in ruins, an ice needle in the
    // frost and a length of pipe in the foundry — same silhouette, and the
    // palette plus a detail or two does the rest.
    var ruins = w.biome === "Ruins"
    var frost = w.biome === "Frost"
    var foundry = w.biome === "Foundry"

    if (d.kind === "spire") {
      var h = 3 + d.size * 3
      ctx.fillStyle = pal.decor
      if (foundry) {
        // A pipe: straight sides, a collar near the top.
        ctx.fillRect(px + 1, py + C - h, 3, h)
        ctx.fillStyle = pal.decorLit
        ctx.fillRect(px, py + C - h + 2, 5, 2)
      } else if (ruins) {
        // A broken column: parallel sides, snapped off at an angle.
        ctx.fillRect(px, py + C - h, 5, h)
        ctx.fillStyle = pal.decorDim
        ctx.fillRect(px + 3, py + C - h, 2, 2)
        ctx.fillStyle = pal.decorLit
        ctx.fillRect(px, py + C - h, 3, 1)
      } else {
        // A cone, drawn as courses that narrow toward the tip.
        for (var r = 0; r < h; r++) {
          var half = Math.max(0, Math.round((h - r) / (frost ? 3.2 : 2.4)))
          ctx.fillRect(px + 2 - half, py + C - 1 - r, half * 2 + 1, 1)
        }
        ctx.fillStyle = pal.decorLit
        ctx.fillRect(px + 2, py + C - h, 1, Math.min(3, h))
      }

    } else if (d.kind === "hang") {
      var hh = 2 + d.size * 3
      ctx.fillStyle = frost ? pal.decorLit : pal.decorDim
      for (var g = 0; g < hh; g++) {
        var gw = Math.max(0, Math.round((hh - g) / 2.6))
        ctx.fillRect(px + 2 - gw, py + g, gw * 2 + 1, 1)
      }

    } else if (d.kind === "clump") {
      // A mound of loose material: rubble, a snow drift, a heap of slag.
      var cw = 3 + d.size * 2
      ctx.fillStyle = pal.decorDim
      ctx.fillRect(px, py + C - 2, cw, 2)
      ctx.fillStyle = pal.decor
      ctx.fillRect(px + 1, py + C - 3, cw - 2, 1)
      if (d.seed % 3 === 0) {
        ctx.fillStyle = pal.decorLit
        ctx.fillRect(px + 1 + (d.seed % 2), py + C - 4, 1, 1)
      }

    } else {
      // Tufts: grass in a cavern, crystals in the frost, weeds in ruins,
      // a spray of sparks in the foundry. Three blades at different heights.
      ctx.fillStyle = foundry ? pal.decorLit : pal.decor
      var blades = 2 + (d.seed % 2)
      for (var bl = 0; bl <= blades; bl++) {
        var bh = 2 + ((d.seed >> bl) % 3) + d.size
        var bxo = bl * 2
        ctx.fillRect(px + bxo, py + C - bh, 1, bh)
        if (frost) ctx.fillRect(px + bxo, py + C - bh, 1, 1)
      }
    }
  }
}

// The portal's static half sits on the terrain layer so the pulsing light on
// top of it (see drawExitGlow) is the only part paying the per-tick cost.
function drawExitBack(ctx, w, pal) {
  var k = w.k
  var C = k.CELL
  var e = w.exit
  var x = e.x * C
  var y = e.y * C
  var ww = e.w * C
  var hh = e.h * C

  // Dark at the top, bright at the floor: the way in reads as a mouth with
  // something lit at the bottom of it rather than as a pane of glass.
  var g = ctx.createLinearGradient(0, y, 0, y + hh)
  g.addColorStop(0, pal.exitDeep)
  g.addColorStop(1, pal.exitGlow)
  ctx.fillStyle = g
  ctx.fillRect(x, y, ww, hh)

  // A stepped lintel over the opening — two courses, the upper one wider —
  // so the portal carries a bit of built structure and stands out from the
  // carved earth around it as the one made thing on the board.
  ctx.fillStyle = pal.exitFrame
  ctx.fillRect(x - 4, y - 6, ww + 8, 3)
  ctx.fillRect(x - 2, y - 3, ww + 4, 3)
  ctx.fillRect(x - 2, y - 3, 2, hh + 3)
  ctx.fillRect(x + ww, y - 3, 2, hh + 3)
}

// ---------------------------------------------------------------------------
// Actor layer
// ---------------------------------------------------------------------------

function drawActors(ctx, w, pal, opts) {
  var k = w.k
  ctx.reset()
  drawHatch(ctx, w, pal)
  drawSpecialCard(ctx, w, pal)
  drawExitGlow(ctx, w, pal)

  drawHazard(ctx, w, pal)

  for (var p = 0; p < w.particles.length; p++) {
    var d = w.particles[p]
    // Blood is bigger, redder and fades slower than dust, because it is the
    // one particle on the board that is meant to be noticed.
    if (d.blood) {
      ctx.globalAlpha = Math.min(1, d.life / 24)
      ctx.fillStyle = pal.blood
      ctx.fillRect(Math.round(d.x * k.CELL), Math.round(d.y * k.CELL), 3, 3)
    } else {
      ctx.globalAlpha = 0.55
      ctx.fillStyle = pal.dust
      ctx.fillRect(Math.round(d.x * k.CELL), Math.round(d.y * k.CELL), 2, 2)
    }
  }
  ctx.globalAlpha = 1

  for (var i = 0; i < w.agents.length; i++) {
    var ag = w.agents[i]
    if (ag.gone) continue
    drawAgent(ctx, w, pal, ag, opts)
  }
}

// The open sky above the earth was doing nothing but holding the hatch, and
// there is a whole band of it. When the level has a special, it gets a card up
// there: who is on the board, and one line about them.
//
// Three per special, picked by level number so it is the same line every time
// you come back to level 42 — the same rule the rest of the level runs on.
var SPECIAL_FACTS = {
  buckshot: [
    "does not clear a path. It suggests one, loudly.",
    "reloads out of spite.",
    "has never bashed a wall twice."
  ],
  roundhouse: [
    "does not destroy the wall. The wall relocates.",
    "counted to infinity. Twice.",
    "does not do push-ups. It pushes the level down."
  ],
  spider: [
    "considers the ceiling a floor with better views.",
    "has never once looked down.",
    "walks upside down out of principle."
  ],
  lumberjack: [
    "does not remove the wall. It lies it down.",
    "shouts nothing. The wall knows.",
    "turns a problem into a floor."
  ],
  pyro: [
    "solves geometry with heat.",
    "leaves the roundest holes on the board.",
    "has opinions about dirt."
  ],
  sapper: [
    "plants it, walks away, does not look back.",
    "reads the room, then removes it.",
    "is the only one here who survives the bang."
  ],
  piledriver: [
    "only ever knows one direction, and it is down.",
    "has never taken a staircase.",
    "considers the floor a suggestion."
  ],
  quarryman: [
    "does not dig tunnels. It opens rooms.",
    "takes the biggest single bite on the board.",
    "measures twice, removes everything."
  ],
  glazier: [
    "is the only one here who adds anything.",
    "lays a bridge nobody has to ration.",
    "builds where the others break."
  ],
  wraith: [
    "walks through the wall and helps nobody.",
    "leaves the level exactly as it found it.",
    "is not stuck. Everyone else is."
  ]
}

// A bust of the special, drawn at double size so it reads as a portrait rather
// than as an agent that wandered into the sky.
function drawBust(ctx, x, y, sp, pal) {
  var P = 2
  function px(bx, by, bw, bh, fill) { ctx.fillStyle = fill; ctx.fillRect(x + bx * P, y + by * P, bw * P, bh * P) }
  px(1, 0, 6, 3, sp.hair)          // hair
  px(0, 1, 1, 2, sp.hair)
  px(2, 3, 4, 3, pal.skin)         // face
  px(3, 4, 1, 1, pal.eye)          // eye
  px(1, 6, 6, 5, sp.robe)          // shoulders
  px(0, 7, 1, 4, sp.robe)
  px(7, 7, 1, 4, sp.robe)
  px(1, 8, 2, 2, sp.hair)          // the shoulder pip, same as on the board
}

function drawSpecialCard(ctx, w, pal) {
  if (!w.special) return
  var sp = specialSpec(w.special)
  if (!sp) return
  var C = w.k.CELL
  var skyH = w.k.SKY * C

  // Everything here has to fit inside the open sky, which is seven rows — 28
  // pixels — and not a pixel more. The first version laid the fact out over two
  // lines and the second one came out underneath the earth.
  var cardW = 232
  var right = w.hatch.x < w.k.COLS / 2
  var x = right ? w.k.COLS * C - cardW - 5 : 5
  var y = 2
  var h = skyH - 5

  ctx.fillStyle = pal.cardBack
  ctx.fillRect(x, y, cardW, h)
  ctx.fillStyle = sp.robe
  ctx.fillRect(x, y, 2, h)          // a spine in the special's own colour

  drawBust(ctx, x + 6, y + 1, sp, pal)

  var tx = x + 28
  ctx.textAlign = "left"
  ctx.fillStyle = sp.robe
  ctx.font = "bold 8px monospace"
  ctx.fillText(sp.name, tx, y + 10)

  // One line, clipped rather than wrapped — there is room for exactly one.
  var facts = SPECIAL_FACTS[sp.id] || [""]
  var fact = facts[w.level % facts.length]
  var room = Math.floor((cardW - 34) / 4.25)
  if (fact.length > room) fact = fact.slice(0, room - 1) + "\u2026"
  ctx.fillStyle = pal.labelFaint
  ctx.font = "7px monospace"
  ctx.fillText(fact, tx, y + 20)
}

function drawHatch(ctx, w, pal) {
  var k = w.k
  var C = k.CELL
  var x = w.hatch.x * C
  var y = w.hatch.y * C
  ctx.fillStyle = pal.hatchBody
  ctx.fillRect(x - 14, y - 10, 28, 10)
  ctx.fillStyle = pal.hatchLip
  ctx.fillRect(x - 16, y - 2, 32, 4)
  ctx.fillStyle = pal.hatchMouth
  ctx.fillRect(x - 9, y + 2, 18, 3)
}

function drawExitGlow(ctx, w, pal) {
  var k = w.k
  var C = k.CELL
  var e = w.exit
  var pulse = 0.45 + 0.3 * Math.sin(w.ticks * 0.06)
  var x = e.x * C
  var y = e.y * C
  var ww = e.w * C
  var hh = e.h * C

  ctx.globalAlpha = pulse
  ctx.fillStyle = pal.exitLight
  ctx.fillRect(x + 2, y + hh - 6, ww - 4, 5)
  ctx.globalAlpha = pulse * 0.45
  ctx.fillRect(x - 3, y - 5, ww + 6, hh + 6)
  ctx.globalAlpha = 1
}

// The level's one danger, if it has one — and each of the twenty-one gets its
// own fixture and its own effect, because they were built on four shared looks
// and eight of them came out as the same beam. A hazard you cannot tell from
// the last one is, from where the viewer sits, the same hazard.
//
// Three states worth telling apart at a glance: dormant is the fixture and a
// warning stripe, winding up adds a blinking telegraph, and firing fills the
// ground it kills on. The telegraph is not decoration — it is the only reason a
// danger sitting on the route is fair, so it is drawn to be unmissable.

// A triangle standing on its base, or hanging from it. Teeth, spikes, jaws and
// stalactite-shaped things are all this.
function hzTri(ctx, cx, baseY, halfW, height, dir) {
  for (var i = 0; i < height; i++) {
    var hw = Math.max(0, Math.round(halfW * (1 - i / height)))
    ctx.fillRect(cx - hw, baseY + dir * i, hw * 2 + 1, 1)
  }
}

// A jagged line between two points: arcs, sparks, lightning.
function hzBolt(ctx, x0, y0, x1, y1, seed, amp) {
  var steps = 6
  var px = x0, py = y0
  for (var i = 1; i <= steps; i++) {
    var t = i / steps
    var nx = x0 + (x1 - x0) * t
    var ny = y0 + (y1 - y0) * t
    if (i < steps) {
      var j = ((seed + i * 37) % 7) - 3
      if (Math.abs(x1 - x0) > Math.abs(y1 - y0)) ny += j * amp
      else nx += j * amp
    }
    var dx = nx - px, dy = ny - py
    var n = Math.max(1, Math.round(Math.max(Math.abs(dx), Math.abs(dy))))
    for (var k2 = 0; k2 <= n; k2++) ctx.fillRect(Math.round(px + dx * k2 / n), Math.round(py + dy * k2 / n), 1, 1)
    px = nx; py = ny
  }
}

function drawHazard(ctx, w, pal) {
  var h = w.hazard
  if (!h) return
  var C = w.k.CELL
  var x0 = h.zx0 * C
  var x1 = (h.zx1 + 1) * C
  var y0 = h.zy0 * C
  var y1 = (h.zy1 + 1) * C
  var cx = Math.round((x0 + x1) / 2)
  var wide = x1 - x0
  var tall = y1 - y0
  var live = h.phase === "fire"
  var winding = h.phase === "charge"
  var t = w.ticks
  var seed = h.zx0

  // Winding up blinks, firing is solid. A steady glow for both would make the
  // moment it becomes lethal impossible to see coming.
  var show = live || (winding && Math.floor(t / 4) % 2 === 0)
  var hot = live ? pal.fireHot : pal.warn

  switch (h.kind) {

  // --- watch: mounted, dormant, wakes when somebody walks into reach -------
  case "gun":
    ctx.fillStyle = pal.rig
    ctx.fillRect(x0 + 2, y0, wide - 4, 5)          // mount
    ctx.fillRect(cx - 2, y0 + 5, 4, 6)             // barrel
    ctx.fillStyle = pal.rigDark
    ctx.fillRect(cx - 6, y0 + 2, 4, 4)             // drum magazine
    ctx.fillStyle = pal.warn
    ctx.fillRect(x0 + 2, y0 + 1, wide - 4, 1)
    if (show) {
      ctx.fillStyle = hot
      if (live) {
        hzTri(ctx, cx, y0 + 11, 3, 4, 1)           // muzzle flash
        for (var g = 0; g < tall; g += 5) ctx.fillRect(cx - 1, y0 + 13 + ((t * 4 + g) % tall), 2, 3)
      } else ctx.fillRect(cx - 1, y0 + 11, 2, 2)
    }
    break

  case "sentry":
    ctx.fillStyle = pal.rig
    ctx.fillRect(x0, y0, wide, 6)
    ctx.fillStyle = pal.rigDark
    ctx.fillRect(x0 + 1, y0 + 6, wide - 2, 2)
    ctx.fillStyle = show ? hot : pal.warn
    ctx.fillRect(cx - 2, y0 + 2, 4, 3)             // lens
    if (show) { ctx.fillStyle = hot; ctx.fillRect(cx - (live ? 2 : 0), y0 + 6, live ? 4 : 1, tall - 6) }
    break

  case "turret":
    ctx.fillStyle = pal.rig
    ctx.fillRect(x0 + 1, y0, wide - 2, 4)
    ctx.fillRect(cx - 4, y0 + 4, 3, 5)             // twin barrels
    ctx.fillRect(cx + 2, y0 + 4, 3, 5)
    ctx.fillStyle = pal.warn
    ctx.fillRect(x0 + 1, y0 + 1, wide - 2, 1)
    if (show) {
      ctx.fillStyle = hot
      ctx.fillRect(cx - 3, y0 + 9, live ? 2 : 1, tall - 9)
      ctx.fillRect(cx + 3, y0 + 9, live ? 2 : 1, tall - 9)
    }
    break

  case "darts":
    ctx.fillStyle = pal.rig
    ctx.fillRect(x0, y0, 5, tall)                  // wall plate
    ctx.fillStyle = pal.rigDark
    for (var dh = 0; dh < 3; dh++) ctx.fillRect(x0 + 5, y0 + 3 + dh * 5, 2, 2)
    ctx.fillStyle = pal.warn
    ctx.fillRect(x0 + 1, y0 + 2, 1, tall - 4)
    if (show) {
      ctx.fillStyle = hot
      // Darts in flight: short dashes marching away from the plate.
      for (var dd = 0; dd < 3; dd++) {
        var dx2 = x0 + 7 + ((t * 5 + dd * 11) % Math.max(1, wide))
        ctx.fillRect(dx2, y0 + 3 + dd * 5, live ? 5 : 2, 1)
      }
    }
    break

  case "flame":
    ctx.fillStyle = pal.rig
    ctx.fillRect(cx - 4, y0, 8, 3)
    hzTri(ctx, cx, y0 + 3, 3, 4, 1)                // flared nozzle
    ctx.fillStyle = pal.warn
    ctx.fillRect(cx - 3, y0 + 1, 6, 1)
    if (show) {
      // A cone that widens as it falls, with a hotter core.
      for (var f = 0; f < (live ? tall - 7 : 5); f++) {
        var fw = Math.round((wide / 2) * (0.25 + (f / tall) * (live ? 1.5 : 0.5)))
        ctx.fillStyle = f % 3 === Math.floor(t / 3) % 3 ? pal.fireHot : pal.fire
        ctx.fillRect(cx - fw, y0 + 7 + f, fw * 2, 1)
      }
    }
    break

  case "tesla":
    ctx.fillStyle = pal.rig
    ctx.fillRect(cx - 2, y1 - tall + 4, 4, tall - 4)   // post
    ctx.fillRect(x0 + 1, y1 - 3, wide - 2, 3)          // base
    ctx.fillStyle = show ? hot : pal.rigDark
    ctx.fillRect(cx - 4, y0, 8, 4)                     // ball on top
    if (show) {
      ctx.fillStyle = hot
      hzBolt(ctx, cx, y0 + 2, x0, y1 - 4, seed + t, live ? 2 : 1)
      hzBolt(ctx, cx, y0 + 2, x1, y1 - 4, seed + t + 3, live ? 2 : 1)
    }
    break

  // --- snipe: one target, a long way off, one shot then a long reload -----
  case "sniper":
    ctx.fillStyle = pal.rig
    ctx.fillRect(x0, y0 + 2, 4, tall - 4)              // housing
    ctx.fillRect(x0 + 4, y0 + 4, 7, 3)                 // barrel
    ctx.fillStyle = pal.rigDark
    ctx.fillRect(x0 + 4, y0 + 1, 4, 3)                 // scope
    ctx.fillStyle = h.phase === "rest" ? pal.rigDark : pal.warn
    ctx.fillRect(x0 + 1, y0 + 3, 1, tall - 6)
    if (show && h.lineTo >= 0) {
      // The sight, then the shot. One pixel high while it is only looking, and
      // it reaches all the way to whoever it has picked out.
      var tx = h.lineTo * C
      var ty = h.lineY * C
      var sy = y0 + 5
      ctx.fillStyle = hot
      var n2 = Math.max(1, Math.round(Math.abs(tx - (x0 + 11))))
      for (var q = 0; q <= n2; q += live ? 1 : 3) {
        var qx = (x0 + 11) + (tx - (x0 + 11)) * (q / n2)
        var qy = sy + (ty - sy) * (q / n2)
        ctx.fillRect(Math.round(qx), Math.round(qy), live ? 2 : 1, live ? 2 : 1)
      }
    }
    break

  // --- beam: keeps its own schedule ---------------------------------------
  case "lasergrid":
    ctx.fillStyle = pal.rig
    ctx.fillRect(x0, y0, wide, 3)
    ctx.fillStyle = pal.rigDark
    for (var e = x0 + 2; e < x1 - 1; e += 8) ctx.fillRect(e, y0 + 3, 3, 2)
    ctx.fillStyle = pal.warn
    ctx.fillRect(x0, y0 + 1, wide, 1)
    if (show) {
      ctx.fillStyle = hot
      for (var b2 = x0 + 3; b2 < x1 - 1; b2 += 8) ctx.fillRect(b2, y0 + 5, live ? 2 : 1, tall - 5)
    }
    break

  case "sweeper":
    // A head that travels along a rail, with the beam raking after it.
    var rail = x0 + Math.round((wide - 8) * (0.5 + 0.5 * Math.sin(t * 0.05)))
    ctx.fillStyle = pal.rigDark
    ctx.fillRect(x0, y0, wide, 2)                      // the rail
    ctx.fillStyle = pal.rig
    ctx.fillRect(rail, y0, 8, 5)                       // the head
    ctx.fillStyle = pal.warn
    ctx.fillRect(rail + 1, y0 + 1, 6, 1)
    if (show) {
      ctx.fillStyle = hot
      for (var sv = 0; sv < tall - 5; sv++) {
        var lean = Math.round(sv * Math.sin(t * 0.05) * 0.5)
        ctx.fillRect(rail + 3 + lean, y0 + 5 + sv, live ? 3 : 1, 1)
      }
    }
    break

  case "tripwire":
    ctx.fillStyle = pal.rig
    ctx.fillRect(x0, y1 - 8, 2, 8)                     // posts
    ctx.fillRect(x1 - 2, y1 - 8, 2, 8)
    ctx.fillStyle = show ? hot : pal.warn
    ctx.fillRect(x0, y1 - 7, wide, 1)                  // the wire itself
    if (show && live) {
      ctx.fillStyle = pal.fireHot
      for (var tw = 0; tw < wide; tw += 3) ctx.fillRect(x0 + tw, y1 - 9 - ((t + tw) % 4), 2, 2)
    }
    break

  // --- plate: armed by being stood on -------------------------------------
  case "spikes":
    ctx.fillStyle = pal.rig
    ctx.fillRect(x0, y1 - 3, wide, 3)                  // the plate
    ctx.fillStyle = pal.warn
    ctx.fillRect(x0 + 1, y1 - 2, wide - 2, 1)
    if (show) {
      ctx.fillStyle = hot
      for (var sp = x0 + 2; sp < x1 - 1; sp += 4) hzTri(ctx, sp, y1 - 3, 2, live ? 10 : 3, -1)
    }
    break

  case "beartrap":
    // Jaws: open and waiting, or shut.
    ctx.fillStyle = pal.rig
    ctx.fillRect(cx - 1, y1 - 2, 2, 2)                 // the plate between them
    ctx.fillStyle = show && live ? hot : pal.rigDark
    if (show && live) {
      hzTri(ctx, cx - 3, y1 - 2, 3, 7, -1)
      hzTri(ctx, cx + 3, y1 - 2, 3, 7, -1)
    } else {
      for (var jw = 0; jw < 5; jw++) {
        ctx.fillRect(x0 + jw, y1 - 3 - jw, 2, 1)       // open, leaning out
        ctx.fillRect(x1 - 2 - jw, y1 - 3 - jw, 2, 1)
      }
      ctx.fillStyle = pal.warn
      ctx.fillRect(cx - 2, y1 - 3, 4, 1)
    }
    break

  case "sawblade":
    ctx.fillStyle = pal.rig
    ctx.fillRect(x0 + 2, y1 - 3, wide - 4, 3)          // slot
    ctx.fillStyle = pal.warn
    ctx.fillRect(x0 + 3, y1 - 2, wide - 6, 1)
    if (show) {
      // A disc rising out of the slot, teeth turning.
      var rise = live ? 9 : 3
      var rad = Math.min(rise, 8)
      ctx.fillStyle = hot
      for (var a2 = 0; a2 < 12; a2++) {
        var ang = (a2 / 12) * Math.PI * 2 + t * 0.25
        ctx.fillRect(Math.round(cx + Math.cos(ang) * rad), Math.round(y1 - 3 - rise / 2 + Math.sin(ang) * rad * 0.6), 2, 2)
      }
      ctx.fillRect(cx - 1, y1 - 4 - rise / 2, 2, 2)
    }
    break

  case "grinder":
    // Two toothed rollers side by side, turning inward.
    ctx.fillStyle = pal.rig
    ctx.fillRect(x0, y1 - 6, wide, 6)
    ctx.fillStyle = pal.rigDark
    ctx.fillRect(cx - 1, y1 - 6, 2, 6)
    ctx.fillStyle = show ? hot : pal.warn
    for (var gr = 0; gr < wide; gr += 4) {
      var off = (t * 2 + gr) % 4
      ctx.fillRect(x0 + gr + (gr < wide / 2 ? off : 3 - off), y1 - 7, 2, live ? 4 : 2)
    }
    break

  // --- cycle: never triggers, never stops ---------------------------------
  case "crusher":
    // A block on two rams, hanging high or driven down.
    var drop = live ? tall - 8 : (winding ? 3 : 0)
    ctx.fillStyle = pal.rigDark
    ctx.fillRect(x0 + 3, y0, 2, 4 + drop)
    ctx.fillRect(x1 - 5, y0, 2, 4 + drop)
    ctx.fillStyle = live ? hot : pal.rig
    ctx.fillRect(x0, y0 + 4 + drop, wide, 7)
    ctx.fillStyle = pal.warn
    ctx.fillRect(x0 + 1, y0 + 5 + drop, wide - 2, 1)
    break

  case "pendulum":
    // A blade on an arm, swinging from a pivot.
    var sw = Math.sin(t * 0.06) * (wide / 2 - 2)
    ctx.fillStyle = pal.rigDark
    ctx.fillRect(cx - 2, y0, 4, 3)                     // pivot
    ctx.fillStyle = pal.rig
    var bx = Math.round(cx + sw)
    var by = y0 + tall - 6
    var an = Math.max(1, Math.round(Math.max(Math.abs(bx - cx), by - y0)))
    for (var pa = 0; pa <= an; pa++)
      ctx.fillRect(Math.round(cx + (bx - cx) * pa / an), Math.round(y0 + 3 + (by - y0 - 3) * pa / an), 2, 2)
    ctx.fillStyle = show ? hot : pal.warn
    hzTri(ctx, bx, by + 5, 4, 6, -1)                   // the blade
    break

  case "geyser":
    ctx.fillStyle = pal.rig
    ctx.fillRect(x0, y1 - 3, wide, 3)                  // grate
    ctx.fillStyle = pal.rigDark
    for (var gg = x0 + 1; gg < x1 - 1; gg += 3) ctx.fillRect(gg, y1 - 3, 1, 3)
    if (show) {
      // A plume that billows wider the higher it gets.
      for (var pu = 0; pu < (live ? tall - 4 : 4); pu++) {
        var pw = Math.round((wide / 2) * (0.3 + (pu / tall) * (live ? 1.4 : 0.4)))
        ctx.fillStyle = (pu + Math.floor(t / 2)) % 4 === 0 ? pal.fireHot : hot
        ctx.fillRect(cx - pw, y1 - 4 - pu, pw * 2, 1)
      }
    }
    break

  case "rockfall":
    ctx.fillStyle = pal.rigDark
    ctx.fillRect(x0, y0, wide, 3)                      // cracked slab
    ctx.fillStyle = pal.rig
    for (var cr = 0; cr < wide; cr += 5) ctx.fillRect(x0 + cr, y0 + 3, 3, 1)
    ctx.fillStyle = pal.warn
    ctx.fillRect(x0 + 2, y0 + 1, wide - 4, 1)
    if (show) {
      // Rocks on their way down, at staggered heights.
      ctx.fillStyle = live ? pal.rig : pal.warn
      for (var rk = 0; rk < 4; rk++) {
        var ry = y0 + 4 + ((t * 3 + rk * 17) % Math.max(1, tall - 6))
        ctx.fillRect(x0 + 2 + rk * 5, ry, live ? 4 : 2, live ? 4 : 2)
      }
    }
    break

  case "piston":
    // A ram in a housing, driven out sideways.
    var ext = live ? wide - 6 : (winding ? 3 : 0)
    ctx.fillStyle = pal.rig
    ctx.fillRect(x0, y0, 5, tall)                      // housing
    ctx.fillStyle = pal.rigDark
    ctx.fillRect(x0 + 5, y0 + 2, ext, tall - 4)        // the ram
    ctx.fillStyle = show ? hot : pal.warn
    ctx.fillRect(x0 + 5 + ext, y0 + 1, 3, tall - 2)    // the head
    break

  // --- field: always live -------------------------------------------------
  case "brazier":
    ctx.fillStyle = pal.rig
    ctx.fillRect(cx - 4, y1 - 4, 8, 4)                 // bowl
    ctx.fillRect(cx - 1, y1 - 6, 2, 2)
    // Flames, flickering on their own clock.
    for (var fl = 0; fl < tall - 5; fl++) {
      var fw2 = Math.max(1, Math.round((3 - fl * 0.35) + Math.sin((t + fl * 3) * 0.3)))
      ctx.fillStyle = fl < 2 ? pal.fireHot : pal.fire
      ctx.fillRect(cx - fw2, y1 - 6 - fl, fw2 * 2, 1)
    }
    break

  case "fence":
    ctx.fillStyle = pal.rig
    ctx.fillRect(x0, y0 + 2, 2, tall - 2)              // posts
    ctx.fillRect(x1 - 2, y0 + 2, 2, tall - 2)
    ctx.fillStyle = pal.rigDark
    ctx.fillRect(x0, y1 - 2, wide, 2)
    // Wires, with a charge running between them.
    for (var wi = 0; wi < 3; wi++) {
      var wy = y0 + 4 + wi * Math.max(2, Math.round((tall - 6) / 3))
      ctx.fillStyle = pal.rigDark
      ctx.fillRect(x0, wy, wide, 1)
      if ((Math.floor(t / 3) + wi) % 3 === 0) {
        ctx.fillStyle = pal.fireHot
        hzBolt(ctx, x0 + 1, wy, x1 - 1, wy, seed + wi + t, 1)
      }
    }
    break

  default:
    ctx.fillStyle = pal.rig
    ctx.fillRect(x0, y0, wide, 4)
    if (show) { ctx.fillStyle = hot; ctx.fillRect(x0, y0, wide, tall) }
  }

  ctx.globalAlpha = 1
}

// One 8x16 sprite, mirrored by facing, with per-action limb changes. The
// helper takes coordinates in right-facing sprite space and flips them for a
// left-facing agent, so every pose below is written once.
function blit(ctx, ox, oy, dir, x, y, bw, bh) {
  var sx = dir > 0 ? ox + x : ox + (SPRITE_W - x - bw)
  ctx.fillRect(Math.round(sx), Math.round(oy + y), bw, bh)
}

function drawAgent(ctx, w, pal, ag, opts) {
  var k = w.k
  var C = k.CELL
  var ox = Math.round(ag.x * C) - SPRITE_W / 2
  var oy = Math.round((ag.y + 1) * C) - SPRITE_PX
  var dir = ag.dir
  var st = ag.state

  if (st === "saved") {
    // A short rise and fade into the portal, so getting home reads as an
    // arrival rather than an agent simply blinking out.
    ctx.globalAlpha = Math.max(0, 1 - ag.fade / 14)
    oy -= ag.fade
  }

  var robe = pal.robe
  var hair = pal.hair
  var skin = pal.skin

  // A special wears its own colours. Every other agent on the board is the same
  // green and blue on purpose — the silhouette is the joke — so the one that
  // isn't reads as the one that isn't from across the room, which is the entire
  // requirement. It also carries a bright pip on the shoulder, because at this
  // size a robe colour alone is a few pixels and easy to miss on a busy board.
  if (ag.special) {
    var sp = specialSpec(ag.special)
    if (sp) { robe = sp.robe; hair = sp.hair }
  }

  if (st === "bomb") {
    // Flash between the theme's urgent color and white on the last seconds.
    var fast = ag.fuse < 40
    var on = Math.floor(ag.fuse / (fast ? 3 : 7)) % 2 === 0
    robe = on ? pal.urgent : pal.robe
    hair = on ? pal.urgent : pal.hair
    skin = on ? "#ffffff" : pal.skin
  }

  // --- umbrella, drawn behind nothing and above everything --------------
  if (ag.floater && st === "fall" && ag.fall > 2) {
    ctx.fillStyle = pal.umbrella
    blit(ctx, ox, oy, 1, -3, -9, 14, 2)
    blit(ctx, ox, oy, 1, -4, -7, 3, 2)
    blit(ctx, ox, oy, 1, 9, -7, 3, 2)
    ctx.fillStyle = pal.umbrellaStem
    blit(ctx, ox, oy, 1, 3, -7, 2, 8)
  }

  // The trick: a flash of whatever it is doing, thrown out in front. Each act
  // gets its own shape for the same reason each danger does — a special you
  // cannot tell from the last one is the same special.
  if (st === "trick" && ag.special) {
    var tsp = specialSpec(ag.special)
    var reach = ag.timer / 14
    var tx = ox + (dir > 0 ? SPRITE_W : 0)
    var mid = oy + 8
    ctx.fillStyle = tsp ? tsp.robe : pal.urgent
    ctx.globalAlpha = 0.45 + 0.55 * reach
    switch (tsp && tsp.act) {
      case "blast":                             // a widening cone of shot
        for (var bi = 1; bi <= 6; bi++) {
          var bs = Math.round(bi * 1.6 * reach)
          ctx.fillRect(tx + dir * bi * 3 - (dir < 0 ? 2 : 0), mid - bs, 2, bs * 2 + 1)
        }
        break
      case "kick":                              // one heavy bar driven forward
        ctx.fillRect(dir > 0 ? tx : tx - Math.round(18 * reach), mid - 6, Math.round(18 * reach), 12)
        break
      case "fell":                              // a tall thin slice
        ctx.fillRect(tx + dir * 4 - 1, oy - Math.round(26 * reach), 3, Math.round(30 * reach))
        break
      case "melt":                              // a growing disc
        var rr = Math.round(9 * reach)
        for (var my = -rr; my <= rr; my++) {
          var mw = Math.round(Math.sqrt(Math.max(0, rr * rr - my * my)))
          ctx.fillRect(tx + dir * 14 - mw, mid + my, mw * 2, 1)
        }
        break
      case "sap":                               // a charge, then the blast
        ctx.fillRect(tx + dir * 18 - 2, mid - 2, 4, 4)
        if (reach > 0.75) { ctx.globalAlpha = 0.8; ctx.fillRect(tx + dir * 18 - 10, mid - 10, 20, 20) }
        break
      case "stomp":                             // straight down, under its feet
        ctx.fillRect(ox + 1, oy + SPRITE_PX, 6, Math.round(18 * reach))
        break
      case "quarry":                            // a whole room's worth
        ctx.fillRect(dir > 0 ? tx : tx - Math.round(26 * reach), oy - 12, Math.round(26 * reach), 28)
        break
      case "slab":                              // laid out rather than taken out
        ctx.fillRect(dir > 0 ? tx : tx - Math.round(24 * reach), oy + SPRITE_PX - 2, Math.round(24 * reach), 5)
        break
    }
    ctx.globalAlpha = 1
  }

  var bodyDrop = (st === "dig" || st === "mine") ? 2 : 0

  // --- hair + head -------------------------------------------------------
  ctx.fillStyle = hair
  blit(ctx, ox, oy, dir, 2, 0 + bodyDrop, 4, 3)
  if (st === "walk" || st === "climb") blit(ctx, ox, oy, dir, 1, 1 + bodyDrop, 1, 2)

  ctx.fillStyle = skin
  blit(ctx, ox, oy, dir, 2, 3 + bodyDrop, 4, 4)
  ctx.fillStyle = pal.eye
  blit(ctx, ox, oy, dir, 5, 4 + bodyDrop, 1, 1)

  // --- body + limbs ------------------------------------------------------
  ctx.fillStyle = robe

  if (st === "climb") {
    blit(ctx, ox, oy, dir, 2, 7, 4, 6)
    blit(ctx, ox, oy, dir, 5, 3 + (ag.anim >> 3) % 2, 2, 4)   // hand over hand
    blit(ctx, ox, oy, dir, 3, 13, 3, 3)

  } else if (st === "fall") {
    blit(ctx, ox, oy, dir, 1, 7, 6, 6)
    blit(ctx, ox, oy, dir, 0, 4, 2, 4)
    blit(ctx, ox, oy, dir, 6, 4, 2, 4)
    blit(ctx, ox, oy, dir, 2, 13, 2, 3)
    blit(ctx, ox, oy, dir, 4, 13, 2, 3)

  } else if (st === "block") {
    blit(ctx, ox, oy, dir, 1, 7, 6, 6)
    blit(ctx, ox, oy, dir, -2, 8, 3, 2)
    blit(ctx, ox, oy, dir, 7, 8, 3, 2)
    blit(ctx, ox, oy, dir, 1, 13, 6, 3)

  } else if (st === "build") {
    blit(ctx, ox, oy, dir, 1, 7, 6, 6)
    blit(ctx, ox, oy, dir, 6, 8, 3, 2)
    ctx.fillStyle = pal.dirtEdge
    blit(ctx, ox, oy, dir, 8, 9, 5, 2)                        // the brick
    ctx.fillStyle = robe
    blit(ctx, ox, oy, dir, 2, 13, 2, 3)
    blit(ctx, ox, oy, dir, 4, 13, 2, 3)

  } else if (st === "bash" || st === "mine") {
    blit(ctx, ox, oy, dir, 1, 7 + bodyDrop, 6, 6)
    var swing = (ag.timer % 6) < 3 ? 0 : 2
    blit(ctx, ox, oy, dir, 6, (st === "bash" ? 8 : 10) + swing, 4, 2)
    blit(ctx, ox, oy, dir, 2, 13, 2, 3)
    blit(ctx, ox, oy, dir, 4, 13, 2, 3)

  } else if (st === "dig") {
    blit(ctx, ox, oy, dir, 1, 7 + bodyDrop, 6, 5)
    blit(ctx, ox, oy, dir, 0, 11 + bodyDrop, 2, 3)
    blit(ctx, ox, oy, dir, 6, 11 + bodyDrop, 2, 3)
    blit(ctx, ox, oy, dir, 2, 14, 4, 2)

  } else {
    // Walking (and the saved fade-out, which keeps the walk pose).
    blit(ctx, ox, oy, dir, 1, 7, 6, 6)
    var f = (ag.anim >> 2) % 4
    var lead = [0, 1, 0, -1][f]
    blit(ctx, ox, oy, dir, 2 + lead, 13, 2, 3)
    blit(ctx, ox, oy, dir, 4 - lead, 13, 2, 3)
  }

  // --- bomber countdown --------------------------------------------------
  if (st === "bomb") {
    ctx.fillStyle = pal.urgent
    ctx.font = "bold 9px monospace"
    ctx.textAlign = "center"
    ctx.fillText(String(Math.ceil(ag.fuse / 30)), ox + SPRITE_W / 2, oy - 3)
  }

  // A pip on the shoulder in the special's second colour. The robe alone is a
  // handful of pixels on a board that already has a lot going on.
  if (ag.special && st !== "saved") {
    var psp = specialSpec(ag.special)
    ctx.fillStyle = psp ? psp.hair : pal.label
    blit(ctx, ox, oy, dir, 1, 5 + bodyDrop, 2, 2)
  }

  // --- optional label ----------------------------------------------------
  // What it's doing when it's doing something, and who it is the rest of the
  // time. The trait is the more interesting half: watching two agents reach
  // the same ledge and disagree about it only reads as personality once you
  // can see which one is the cautious one.
  if (opts && opts.labels && st !== "saved") {
    var action = actionLabel(st)
    // A special is named rather than described. Its personality never comes up
    // — it cannot use the toolbar, so the choices a trait would colour are not
    // choices it gets to make — and the name is the useful thing to know.
    var nsp = ag.special ? specialSpec(ag.special) : null
    var text = nsp ? nsp.name : (action !== "" ? action : (ag.trait || ""))
    if (text !== "") {
      ctx.fillStyle = nsp ? nsp.robe : (action !== "" ? pal.label : pal.labelFaint)
      ctx.font = "7px monospace"
      ctx.textAlign = "center"
      ctx.fillText(text, ox + SPRITE_W / 2, oy - 4)
    }
  }

  ctx.globalAlpha = 1
}

function actionLabel(st) {
  if (st === "climb") return "climb"
  if (st === "build") return "build"
  if (st === "bash") return "bash"
  if (st === "mine") return "mine"
  if (st === "dig") return "dig"
  if (st === "block") return "block"
  if (st === "bomb") return "bomb"
  return ""
}
