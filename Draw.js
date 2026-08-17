.pragma library
.import "Sim.js" as Sim

// Everything the simulation looks like. Sim.js owns state and never knows a
// color; this file owns pixels and never changes one.
//
// Two canvases share this: the terrain layer repaints only when the earth
// actually moves (Sim bumps terrainVersion), the actor layer every tick. That
// split is what keeps a boardful of diggers cheap — the expensive redraw only
// happens when someone removes a cell.
//
// The palette arrives from Panel.qml, derived from the active Omarchy theme,
// so the earth, sky and portal all shift with the theme. The lemmings
// themselves keep the green hair and blue robe: that silhouette IS the joke,
// and at sixteen pixels tall it's the only thing making them read as lemmings
// rather than as pixels.

var LEM_W = 8
var LEM_PX = 16

// ---------------------------------------------------------------------------
// Terrain layer
// ---------------------------------------------------------------------------

function materialFill(pal, m) {
  if (m === Sim.DIRT) return pal.dirt
  if (m === Sim.ROCK) return pal.rock
  return pal.steel
}

function materialEdge(pal, m) {
  if (m === Sim.DIRT) return pal.dirtEdge
  if (m === Sim.ROCK) return pal.rockEdge
  return pal.steelEdge
}

function materialShade(pal, m) {
  if (m === Sim.DIRT) return pal.dirtShade
  if (m === Sim.ROCK) return pal.rockShade
  return pal.steelShade
}

function drawTerrain(ctx, w, pal) {
  var C = Sim.CELL
  var cols = Sim.COLS
  var rows = Sim.ROWS

  ctx.reset()

  // Sky: a shallow gradient so the open air above the earth has some depth
  // rather than reading as a flat panel background.
  var sky = ctx.createLinearGradient(0, 0, 0, Sim.SKY * C + C * 4)
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
      if (m === Sim.EMPTY) { x++; continue }
      var start = x
      while (x < cols && w.terrain[base + x] === m) x++
      ctx.fillStyle = materialFill(pal, m)
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
      if (sm === Sim.EMPTY || sy2 + 1 >= rows || w.terrain[sbase + cols + sx2] !== Sim.EMPTY) { sx2++; continue }
      var sstart = sx2
      while (sx2 < cols && w.terrain[sbase + sx2] === sm
             && sy2 + 1 < rows && w.terrain[sbase + cols + sx2] === Sim.EMPTY) sx2++
      ctx.fillStyle = materialShade(pal, sm)
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
      if (em === Sim.EMPTY || (ey > 0 && w.terrain[ebase - cols + ex] !== Sim.EMPTY)) { ex++; continue }
      var estart = ex
      while (ex < cols && w.terrain[ebase + ex] === em
             && (ey === 0 || w.terrain[ebase - cols + ex] === Sim.EMPTY)) ex++
      ctx.fillStyle = materialEdge(pal, em)
      ctx.fillRect(estart * C, ey * C, (ex - estart) * C, Math.max(1, C - 2))
    }
  }

  // Depth wash: the deeper the earth, the darker. One pass, cheap, and it
  // stops the lower half of the board looking like the upper half.
  var wash = ctx.createLinearGradient(0, Sim.SKY * C, 0, rows * C)
  wash.addColorStop(0, pal.washTop)
  wash.addColorStop(1, pal.washLow)
  ctx.fillStyle = wash
  ctx.fillRect(0, Sim.SKY * C, cols * C, (rows - Sim.SKY) * C)

  drawExitBack(ctx, w, pal)
}

// The portal's static half sits on the terrain layer so the pulsing light on
// top of it (see drawExitGlow) is the only part paying the per-tick cost.
function drawExitBack(ctx, w, pal) {
  var C = Sim.CELL
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
  ctx.reset()
  drawHatch(ctx, w, pal)
  drawExitGlow(ctx, w, pal)

  ctx.globalAlpha = 0.55
  ctx.fillStyle = pal.dust
  for (var p = 0; p < w.particles.length; p++) {
    var d = w.particles[p]
    ctx.fillRect(Math.round(d.x * Sim.CELL), Math.round(d.y * Sim.CELL), 2, 2)
  }
  ctx.globalAlpha = 1

  for (var i = 0; i < w.lemmings.length; i++) {
    var L = w.lemmings[i]
    if (L.gone) continue
    drawLemming(ctx, w, pal, L, opts)
  }
}

function drawHatch(ctx, w, pal) {
  var C = Sim.CELL
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
  var C = Sim.CELL
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

// One 8x16 sprite, mirrored by facing, with per-action limb changes. The
// helper takes coordinates in right-facing sprite space and flips them for a
// left-facing lemming, so every pose below is written once.
function blit(ctx, ox, oy, dir, x, y, bw, bh) {
  var sx = dir > 0 ? ox + x : ox + (LEM_W - x - bw)
  ctx.fillRect(Math.round(sx), Math.round(oy + y), bw, bh)
}

function drawLemming(ctx, w, pal, L, opts) {
  var C = Sim.CELL
  var ox = Math.round(L.x * C) - LEM_W / 2
  var oy = Math.round((L.y + 1) * C) - LEM_PX
  var dir = L.dir
  var st = L.state

  if (st === "saved") {
    // A short rise and fade into the portal, so getting home reads as an
    // arrival rather than a lemming simply blinking out.
    ctx.globalAlpha = Math.max(0, 1 - L.fade / 14)
    oy -= L.fade
  }

  var robe = pal.robe
  var hair = pal.hair
  var skin = pal.skin

  if (st === "bomb") {
    // Flash between the theme's urgent color and white on the last seconds.
    var fast = L.fuse < 40
    var on = Math.floor(L.fuse / (fast ? 3 : 7)) % 2 === 0
    robe = on ? pal.urgent : pal.robe
    hair = on ? pal.urgent : pal.hair
    skin = on ? "#ffffff" : pal.skin
  }

  // --- umbrella, drawn behind nothing and above everything --------------
  if (L.floater && st === "fall" && L.fall > 2) {
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
    blit(ctx, ox, oy, dir, 5, 3 + (L.anim >> 3) % 2, 2, 4)   // hand over hand
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
    var swing = (L.timer % 6) < 3 ? 0 : 2
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
    var f = (L.anim >> 2) % 4
    var lead = [0, 1, 0, -1][f]
    blit(ctx, ox, oy, dir, 2 + lead, 13, 2, 3)
    blit(ctx, ox, oy, dir, 4 - lead, 13, 2, 3)
  }

  // --- bomber countdown --------------------------------------------------
  if (st === "bomb") {
    ctx.fillStyle = pal.urgent
    ctx.font = "bold 9px monospace"
    ctx.textAlign = "center"
    ctx.fillText(String(Math.ceil(L.fuse / 30)), ox + LEM_W / 2, oy - 3)
  }

  // --- optional label ----------------------------------------------------
  // What it's doing when it's doing something, and who it is the rest of the
  // time. The trait is the more interesting half: watching two lemmings reach
  // the same ledge and disagree about it only reads as personality once you
  // can see which one is the cautious one.
  if (opts && opts.labels && st !== "saved") {
    var action = actionLabel(st)
    var text = action !== "" ? action : (L.trait || "")
    if (text !== "") {
      ctx.fillStyle = action !== "" ? pal.label : pal.labelFaint
      ctx.font = "7px monospace"
      ctx.textAlign = "center"
      ctx.fillText(text, ox + LEM_W / 2, oy - 4)
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
