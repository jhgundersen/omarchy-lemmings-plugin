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

// The level's one danger, if it has one. Four looks cover twenty-odd kinds:
// what changes between a machine gun and a bear trap is mostly where it is
// bolted and how long it takes to go off, and those are Sim.js's business.
//
// Three states worth telling apart at a glance: dormant is just the fixture,
// winding up is the fixture plus a telegraph, and firing fills the zone it
// kills in. The telegraph is not decoration — it is the only reason a danger
// on the route is fair, so it is drawn to be unmissable.
function drawHazard(ctx, w, pal) {
  var h = w.hazard
  if (!h) return
  var C = w.k.CELL
  var x0 = h.zx0 * C
  var x1 = (h.zx1 + 1) * C
  var y0 = h.zy0 * C
  var y1 = (h.zy1 + 1) * C
  var live = h.phase === "fire"
  var winding = h.phase === "charge"

  // The mounting: a bracket on whatever it hangs from.
  ctx.fillStyle = pal.rig
  if (h.mount === "ceiling") {
    ctx.fillRect(x0, y0 - 1, x1 - x0, 4)
    ctx.fillStyle = pal.rigDark
    ctx.fillRect(x0 + 2, y0 + 3, x1 - x0 - 4, 2)
  } else if (h.mount === "floor") {
    ctx.fillRect(x0, y1 - 4, x1 - x0, 4)
    ctx.fillStyle = pal.rigDark
    ctx.fillRect(x0 + 1, y1 - 6, x1 - x0 - 2, 2)
  } else {
    ctx.fillRect(x0, y0, 4, y1 - y0)
    ctx.fillStyle = pal.rigDark
    ctx.fillRect(x0 + 4, y0 + 2, 2, y1 - y0 - 4)
  }

  // A hazard stripe on the fixture even while it sleeps. A trap you cannot see
  // until it fires is not a danger, it is a coin toss — and the whole appeal
  // of these is watching the colony walk up to one.
  ctx.fillStyle = pal.warn
  if (h.mount === "ceiling") ctx.fillRect(x0 + 1, y0 + 1, x1 - x0 - 2, 1)
  else if (h.mount === "floor") ctx.fillRect(x0 + 1, y1 - 3, x1 - x0 - 2, 1)
  else ctx.fillRect(x0 + 1, y0 + 2, 1, y1 - y0 - 4)

  if (!live && !winding) return

  // Winding up blinks; firing is solid. A steady glow for both would make the
  // moment it becomes lethal impossible to see coming.
  var blink = winding ? (Math.floor(w.ticks / 4) % 2 === 0) : true
  if (!blink) return
  ctx.globalAlpha = winding ? 0.55 : 1

  if (h.look === "beam") {
    // A line across the zone: a sight line while it winds up, the shot itself
    // when it fires.
    ctx.fillStyle = live ? pal.fireHot : pal.warn
    var my = h.mount === "wall" ? Math.round((y0 + y1) / 2) : y0 + 4
    if (h.mount === "wall") {
      ctx.fillRect(x0, my, x1 - x0, live ? 3 : 1)
    } else {
      ctx.fillRect(Math.round((x0 + x1) / 2) - (live ? 2 : 0), y0, live ? 4 : 1, y1 - y0)
    }

  } else if (h.look === "spikes") {
    // Teeth coming up out of the plate, taller once they are actually out.
    ctx.fillStyle = live ? pal.fireHot : pal.warn
    var tall = live ? 9 : 3
    for (var sx = x0; sx < x1; sx += 4) {
      for (var t = 0; t < tall; t++) {
        var half = Math.max(0, Math.round((tall - t) / 3))
        ctx.fillRect(sx + 1 - half, y1 - 5 - t, half * 2 + 1, 1)
      }
    }

  } else if (h.look === "flame") {
    // A tapering cone away from the nozzle.
    ctx.fillStyle = live ? pal.fireHot : pal.warn
    var span = y1 - y0
    var down = h.mount !== "floor"
    for (var f = 0; f < span; f++) {
      var t2 = f / span
      var wide = Math.round((x1 - x0) * (live ? (0.5 + t2 * 0.5) : 0.25))
      var fy = down ? y0 + f : y1 - 1 - f
      ctx.fillRect(Math.round((x0 + x1) / 2) - wide / 2, fy, wide, 1)
    }

  } else {
    // burst: the whole zone goes, with a couple of brighter bands rolling
    // through it so it reads as firing rather than as a lit rectangle.
    ctx.fillStyle = live ? pal.fire : pal.warn
    ctx.globalAlpha = winding ? 0.35 : 0.72
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
    if (live) {
      ctx.globalAlpha = 1
      ctx.fillStyle = pal.fireHot
      for (var b = 0; b < 3; b++) {
        var by = y0 + ((w.ticks * 3 + b * 13) % Math.max(1, y1 - y0))
        ctx.fillRect(x0, by, x1 - x0, 2)
      }
    }
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

  // --- optional label ----------------------------------------------------
  // What it's doing when it's doing something, and who it is the rest of the
  // time. The trait is the more interesting half: watching two agents reach
  // the same ledge and disagree about it only reads as personality once you
  // can see which one is the cautious one.
  if (opts && opts.labels && st !== "saved") {
    var action = actionLabel(st)
    var text = action !== "" ? action : (ag.trait || "")
    if (text !== "") {
      ctx.fillStyle = action !== "" ? pal.label : pal.labelFaint
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
