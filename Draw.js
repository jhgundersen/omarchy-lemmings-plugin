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

// Wipe a layer back to nothing.
//
// This used to be ctx.reset(), which is the tidy way to say it and the way that
// is least reliably implemented. It is recent (Safari only got it in 16.4), it
// throws outright where it is missing — the reason web.js carried a polyfill —
// and on iOS it has been seen to return without the displayed surface actually
// being cleared, which shows up as a few pixels of an agent left behind on the
// ground it walked over, sometimes, on one device and not the next.
//
// clearRect is as old as canvas itself and is the path every engine keeps
// working. The state reset/ that reset() gave for free is done by hand: the two
// draw passes both leave globalAlpha at 1 already, and this makes sure of it.
function clearLayer(ctx, w) {
  if (typeof ctx.setTransform === "function") ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.clearRect(0, 0, w.k.COLS * w.k.CELL, w.k.ROWS * w.k.CELL)
}

function drawTerrain(ctx, w, pal) {
  var k = w.k
  var C = k.CELL
  var cols = k.COLS
  var rows = k.ROWS

  clearLayer(ctx, w)

  // Sky: a shallow gradient so the open air above the earth has some depth
  // rather than reading as a flat panel background.
  var sky = ctx.createLinearGradient(0, 0, 0, k.SKY * C + C * 4)
  sky.addColorStop(0, pal.skyTop)
  sky.addColorStop(1, pal.skyLow)
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, cols * C, rows * C)

  // On a ship the open band at the top is not sky, it is outside. Stars are
  // laid out from the level number so they are the same every time you come
  // back to it, like everything else here.
  if (w.biome === "Spaceship") {
    var seed3 = w.level * 2654435761 % 100000
    for (var st4 = 0; st4 < 70; st4++) {
      seed3 = (seed3 * 1103515245 + 12345) % 2147483648
      var stx = (seed3 >> 7) % (cols * C)
      var sty = (seed3 >> 3) % (k.SKY * C)
      ctx.fillStyle = st4 % 7 === 0 ? pal.decorLit : pal.dust
      ctx.globalAlpha = st4 % 3 === 0 ? 0.9 : 0.45
      ctx.fillRect(stx, sty, 1, 1)
    }
    ctx.globalAlpha = 1
  }

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

    // Ship fittings. A viewport is only drawn while the hull it is set into is
    // still there, so an agent that bashes through the wall takes the window
    // with it.
    if (d.kind === "window") {
      if (w.terrain[d.y * k.COLS + d.x] === k.EMPTY) continue
      var ww2 = (d.size + 2) * C
      var wh2 = (d.size + 1) * C
      ctx.fillStyle = pal.hatchMouth               // the void outside
      ctx.fillRect(px, py, ww2, wh2)
      ctx.fillStyle = pal.decorLit
      for (var st3 = 0; st3 < 5; st3++) {          // stars in it
        var sxx = px + 2 + ((d.seed * (st3 + 3)) % Math.max(1, ww2 - 4))
        var syy = py + 2 + ((d.seed * (st3 + 7)) % Math.max(1, wh2 - 4))
        ctx.fillRect(sxx, syy, 1, 1)
      }
      ctx.fillStyle = pal.rig                      // the frame
      ctx.fillRect(px - 1, py - 1, ww2 + 2, 2)
      ctx.fillRect(px - 1, py + wh2 - 1, ww2 + 2, 2)
      ctx.fillRect(px - 1, py - 1, 2, wh2 + 2)
      ctx.fillRect(px + ww2 - 1, py - 1, 2, wh2 + 2)
      continue
    }

    if (d.kind === "strip") {
      if (w.terrain[(d.y - 1) * k.COLS + d.x] === k.EMPTY) continue
      ctx.fillStyle = pal.rigDark
      ctx.fillRect(px - 6, py, 16, 2)
      ctx.fillStyle = pal.decorLit                 // the lit tube
      ctx.fillRect(px - 4, py + 1, 12, 1)
      continue
    }

    if (d.kind === "grate") {
      if (w.terrain[(d.y + 1) * k.COLS + d.x] === k.EMPTY) continue
      ctx.fillStyle = pal.decorDim
      for (var gg = 0; gg < 5; gg++) ctx.fillRect(px + gg * 3, py + C - 2, 2, 2)
      continue
    }

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
    var frost = w.biome === "Frost" || w.biome === "Ice Cave"
    var foundry = w.biome === "Foundry" || w.biome === "Spaceship"
    var jungle = w.biome === "Jungle"

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
      } else if (jungle) {
        // A trunk with a canopy on top, which is the one silhouette that says
        // jungle without needing colour to do the work.
        ctx.fillRect(px + 2, py + C - h, 2, h)
        ctx.fillStyle = pal.decorLit
        ctx.fillRect(px - 1, py + C - h - 2, 8, 3)
        ctx.fillRect(px + 1, py + C - h - 4, 4, 2)
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
      if (jungle) {
        // A vine: a wavering line with leaves off it, and long enough to hang
        // into the corridor properly. Nothing else on the board is soft.
        ctx.fillStyle = pal.decor
        var vlen = hh + 6
        for (var v = 0; v < vlen; v++) {
          var wob = Math.round(Math.sin((v + d.seed) * 0.4) * 1.4)
          ctx.fillRect(px + 2 + wob, py + v, 1, 1)
          if (v > 2 && v % 4 === (d.seed % 3)) {
            ctx.fillStyle = pal.decorLit
            ctx.fillRect(px + 2 + wob + (v % 8 < 4 ? 1 : -2), py + v, 2, 1)
            ctx.fillStyle = pal.decor
          }
        }
      } else if (foundry) {
        // A cable loop off the ceiling.
        ctx.fillStyle = pal.decorDim
        for (var cbl = 0; cbl <= 6; cbl++) {
          var sag = Math.round(Math.sin(cbl / 6 * Math.PI) * (2 + d.size))
          ctx.fillRect(px + cbl - 1, py + sag, 1, 1)
        }
      } else {
        ctx.fillStyle = frost ? pal.decorLit : pal.decorDim
        for (var g = 0; g < hh; g++) {
          var gw = Math.max(0, Math.round((hh - g) / 2.6))
          ctx.fillRect(px + 2 - gw, py + g, gw * 2 + 1, 1)
        }
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

  // The way home is the one thing on the board that must be recognisable at a
  // glance on every level, so the lit mouth above never changes. What changes
  // is what has been built around it: each biome frames its exit in its own
  // materials, and you know where you are from the doorway alone.
  ctx.fillStyle = pal.exitFrame
  var cx3 = x + ww / 2

  switch (w.biome) {
  case "Ruins":
    // A pediment on two broken columns, one shorter than the other.
    ctx.fillRect(x - 5, y - 7, ww + 10, 3)
    for (var pd = 0; pd < 4; pd++)
      ctx.fillRect(cx3 - 6 + pd * 3, y - 10 + pd, 3, 3)
    ctx.fillRect(x - 4, y - 4, 3, hh + 4)
    ctx.fillRect(x + ww + 1, y - 4, 3, hh - 2)          // snapped short
    break

  case "Ice Cave":
    // The same doorway, but the cave has been closing on it for a long time:
    // a thick encrusted arch, with ice growing down into the opening itself.
    ctx.fillRect(x - 5, y - 7, ww + 10, 5)
    ctx.fillRect(x - 5, y - 2, 4, hh + 2)
    ctx.fillRect(x + ww + 1, y - 2, 4, hh + 2)
    ctx.fillStyle = pal.decorLit
    for (var ie = 0; ie < ww + 6; ie += 3)
      for (var id2 = 0; id2 < 2 + ((ie / 3) % 4); id2++)
        ctx.fillRect(x - 3 + ie, y - 2 + id2, 2, 1)
    for (var iw = 0; iw < 3; iw++) {         // and down the jambs inside
      ctx.fillRect(x, y + iw * 4, 1, 3)
      ctx.fillRect(x + ww - 1, y + 2 + iw * 4, 1, 3)
    }
    break

  case "Frost":
    // A light fringe of ice off a plain lintel — frost, not a glacier.
    ctx.fillRect(x - 3, y - 5, ww + 6, 3)
    ctx.fillRect(x - 3, y - 2, 2, hh + 2)
    ctx.fillRect(x + ww + 1, y - 2, 2, hh + 2)
    ctx.fillStyle = pal.decorLit
    for (var ic2 = 0; ic2 < ww; ic2 += 4)
      for (var dp = 0; dp < 2 + ((ic2 / 4) % 3); dp++)
        ctx.fillRect(x + ic2, y - 2 + dp, 2 - (dp > 1 ? 1 : 0), 1)
    break

  case "Foundry":
    // A blast door: heavy jambs, a lintel, and rivets.
    ctx.fillRect(x - 5, y - 6, ww + 10, 4)
    ctx.fillRect(x - 4, y - 2, 4, hh + 2)
    ctx.fillRect(x + ww, y - 2, 4, hh + 2)
    ctx.fillStyle = pal.rigDark
    for (var rv = 0; rv < ww + 8; rv += 5) ctx.fillRect(x - 4 + rv, y - 5, 2, 2)
    break

  case "Jungle":
    // A stone arch that the forest has taken back.
    ctx.fillRect(x - 4, y - 5, ww + 8, 3)
    ctx.fillRect(x - 3, y - 2, 2, hh + 2)
    ctx.fillRect(x + ww + 1, y - 2, 2, hh + 2)
    ctx.fillStyle = pal.decor
    for (var vn = -4; vn < ww + 4; vn += 3) {
      var drop3 = 3 + ((vn + 12) % 4) * 2
      ctx.fillRect(x + vn, y - 5, 1, drop3)             // vines over the lintel
      ctx.fillStyle = pal.decorLit
      ctx.fillRect(x + vn - 1, y - 5 + drop3, 2, 1)     // a leaf on the end
      ctx.fillStyle = pal.decor
    }
    break

  case "Spaceship":
    // An airlock: a bolted collar, hazard striping, and a lamp above it.
    ctx.fillStyle = pal.rig
    ctx.fillRect(x - 5, y - 6, ww + 10, 4)
    ctx.fillRect(x - 5, y - 2, 5, hh + 2)
    ctx.fillRect(x + ww, y - 2, 5, hh + 2)
    ctx.fillStyle = pal.warn
    for (var hs = 0; hs < ww + 10; hs += 6) ctx.fillRect(x - 5 + hs, y - 6, 3, 4)
    ctx.fillStyle = pal.rigDark
    for (var bo = 0; bo < hh; bo += 5) {
      ctx.fillRect(x - 3, y + bo, 2, 2)
      ctx.fillRect(x + ww + 1, y + bo, 2, 2)
    }
    ctx.fillStyle = pal.decorLit
    ctx.fillRect(cx3 - 2, y - 9, 4, 2)                  // lamp over the door
    break

  default:
    // Cavern: the original stepped lintel, two courses, the upper one wider.
    ctx.fillRect(x - 4, y - 6, ww + 8, 3)
    ctx.fillRect(x - 2, y - 3, ww + 4, 3)
    ctx.fillRect(x - 2, y - 3, 2, hh + 3)
    ctx.fillRect(x + ww, y - 3, 2, hh + 3)
  }
}

// ---------------------------------------------------------------------------
// Actor layer
// ---------------------------------------------------------------------------

function drawActors(ctx, w, pal, opts) {
  var k = w.k
  clearLayer(ctx, w)
  drawPits(ctx, w, pal)
  drawSpecialCard(ctx, w, pal)
  drawHatch(ctx, w, pal)
  drawEnemyHatch(ctx, w, pal, opts)
  drawExitGlow(ctx, w, pal)

  for (var dhi = 0; dhi < w.hazards.length; dhi++) drawHazard(ctx, w, pal, w.hazards[dhi], opts)

  // Planted mines are separate actors: a small pulsing charge on the floor
  // with its own three-second countdown, rather than a tool hidden in a pose.
  for (var mi = 0; mi < w.mines.length; mi++) {
    var mine = w.mines[mi]
    var mx = Math.round(mine.x * k.CELL)
    var my = Math.round(mine.y * k.CELL)
    var pulse = Math.floor(mine.fuse / (mine.fuse < 30 ? 3 : 6)) % 2 === 0
    ctx.fillStyle = pulse ? pal.urgent : pal.dirtEdge
    ctx.fillRect(mx - 3, my - 3, 7, 3)
    ctx.fillRect(mx - 1, my - 5, 3, 2)
    ctx.fillStyle = pulse ? "#ffffff" : pal.fireHot
    ctx.fillRect(mx, my - 6, 1, 1)
    ctx.fillStyle = pal.urgent
    ctx.font = "bold 9px monospace"
    ctx.textAlign = "center"
    ctx.fillText(String(Math.ceil(mine.fuse / 30)), mx, my - 9)
  }

  // Ladders. Drawn on the face of the wall they lean on, in the timber colours
  // of whoever left them, and drawn BEFORE the agents so a climber's hands are
  // in front of the rungs rather than behind them. `t` grows the ladder up the
  // wall over half a second the first time, so it reads as being put there.
  for (var li = 0; li < w.ladders.length; li++) {
    var lad = w.ladders[li]
    var lgrow = Math.min(1, lad.t / 14)
    var lx = Math.round((lad.x + (lad.side > 0 ? 0 : 1)) * k.CELL) - lad.side * 1
    var lbot = Math.round((lad.bottom + 1) * k.CELL)
    var lspan = Math.round((lad.bottom - lad.top + 1) * k.CELL * lgrow)
    var stile = lad.side > 0 ? lx - 3 : lx + 1

    ctx.fillStyle = pal.rigDark
    ctx.fillRect(stile, lbot - lspan, 2, lspan)
    ctx.fillStyle = SPECIALS_LADDER_WOOD
    ctx.fillRect(stile + (lad.side > 0 ? 0 : 1), lbot - lspan, 1, lspan)
    for (var lr = 2; lr < lspan; lr += 4) {
      ctx.fillStyle = lr % 8 === 2 ? SPECIALS_LADDER_RUNG : SPECIALS_LADDER_WOOD
      ctx.fillRect(stile - 1, lbot - lr, 5, 1)
    }
    // A fresh one still has sawdust coming off the top rung.
    if (lad.t < 14) {
      ctx.globalAlpha = 1 - lad.t / 14
      ctx.fillStyle = pal.dust
      ctx.fillRect(stile - 2, lbot - lspan - 2, 7, 2)
      ctx.globalAlpha = 1
    }
  }

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
  for (var ei = 0; ei < w.enemies.length; ei++) {
    var enemy = w.enemies[ei]
    if (!enemy.gone) drawEnemy(ctx, w, pal, enemy, opts)
  }
}

// ---------------------------------------------------------------------------
// The pit
//
// On the actors layer rather than the terrain layer, because the surface moves
// and the terrain layer only repaints when a cell changes. Nothing is ever
// drawn in front of it: the shaft is empty terrain all the way down, and a
// bridge laid over the hole sits at the corridor floor, several cells above
// the waterline.
// ---------------------------------------------------------------------------

function drawPits(ctx, w, pal) {
  if (!w.pits || !w.pits.length) return
  var k = w.k
  var C = k.CELL

  for (var i = 0; i < w.pits.length; i++) {
    var p = w.pits[i]
    var px = p.x0 * C
    var pw = (p.x1 - p.x0 + 1) * C
    var top = p.floorY * C
    var bot = k.ROWS * C

    // Depth first, and every pit gets it. A hole cut through the bedrock is
    // exactly the same colour as the corridor it opens off, so undrawn it reads
    // as a doorway rather than as a drop — which is a poor thing for the one
    // feature on the board that kills whatever walks into it.
    var deep = ctx.createLinearGradient(0, top, 0, bot)
    deep.addColorStop(0, pal.pitLip)
    deep.addColorStop(1, pal.pitDeep)
    ctx.fillStyle = deep
    ctx.fillRect(px, top, pw, bot - top)

    if (!p.liquid) continue
    drawPool(ctx, w, pal, p, px, pw, bot)
  }
}

function drawPool(ctx, w, pal, p, px, pw, bot) {
  var C = w.k.CELL
  var sy = p.surfaceY * C
  var t = w.ticks

  var body = ctx.createLinearGradient(0, sy, 0, bot)
  body.addColorStop(0, pal.poolBody)
  body.addColorStop(1, pal.poolDeep)
  ctx.fillStyle = body
  if (p.wet) {
    // Paint the connected empty cells rather than the pit's original bounds.
    // Sim.js updates this mask whenever a bash or blast opens a side chamber.
    for (var wy = p.surfaceY; wy < w.k.ROWS; wy++) {
      var run = -1
      for (var wx = 0; wx <= w.k.COLS; wx++) {
        var wet = wx < w.k.COLS && p.wet[wy * w.k.COLS + wx]
        if (wet && run < 0) run = wx
        if (!wet && run >= 0) {
          ctx.fillRect(run * C, wy * C, (wx - run) * C, C)
          run = -1
        }
      }
    }
  } else {
    ctx.fillRect(px, sy, pw, bot - sy)
  }

  // The order from here is what makes a half-submerged animal work without a
  // single clip or a second sprite. The whole creature is drawn first, then the
  // water is laid back over everything below the line — so the part that is
  // under goes green-through-water and the part that is out stays sharp, and
  // an animal rising through the surface does it a pixel at a time for free.
  if (p.croc) drawCroc(ctx, w, pal, p, px, pw, sy)

  ctx.globalAlpha = 0.74
  ctx.fillStyle = pal.poolBody
  ctx.fillRect(px, sy + 1, pw, Math.min(20, bot - sy - 1))
  ctx.globalAlpha = 1

  // The waterline: two slow sine waves of different periods laid over each
  // other, so the surface never repeats on a count anybody can follow. Drawn
  // two pixels at a time, which at this scale is what keeps it a drawn line
  // rather than an anti-aliased smear.
  ctx.fillStyle = pal.poolLip
  for (var c = 0; c < pw; c += 2) {
    var wob = Math.sin(c * 0.11 + t * 0.045 + p.seed)
            + Math.sin(c * 0.047 - t * 0.028)
    ctx.fillRect(px + c, sy + Math.round(wob), 2, 2)
  }
  if (p.wet) {
    // New exposed surfaces in side chambers get their own waterline. The
    // original pit line above remains wavy; these smaller spills stay crisp.
    for (var fx = 0; fx < w.k.COLS; fx++)
      for (var fy = p.surfaceY; fy < w.k.ROWS; fy++) {
        var fi = fy * w.k.COLS + fx
        if (!p.wet[fi] || (fy > p.surfaceY && p.wet[fi - w.k.COLS])) continue
        ctx.fillRect(fx * C, fy * C, C, 2)
      }
  }

  // What the surface does when nobody is in it. Lava spits, coolant strobes
  // along its length, water catches the light — three pools that behave
  // differently enough that the biome is legible from the hole alone.
  if (p.liquid === "lava") {
    for (var e = 0; e < 5; e++) {
      var eph = (t * 0.9 + e * 137 + p.seed) % 220
      if (eph > 60) continue
      var ex = px + ((e * 53 + p.seed) % Math.max(1, pw - 2))
      ctx.globalAlpha = 1 - eph / 60
      ctx.fillStyle = e % 2 ? pal.poolGlint : pal.poolLip
      ctx.fillRect(ex, sy - Math.round(eph * 0.22), 1, 2)
    }
    ctx.globalAlpha = 1
  } else if (p.liquid === "coolant") {
    var scan = (t * 1.6 + p.seed) % (pw + 40) - 20
    ctx.globalAlpha = 0.5
    ctx.fillStyle = pal.poolGlint
    ctx.fillRect(px + Math.round(scan), sy + 2, 14, 1)
    ctx.globalAlpha = 1
  } else {
    for (var g = 0; g < 3; g++) {
      var gx = px + ((g * 29 + p.seed + Math.floor(t / 40) * 7) % Math.max(1, pw - 6))
      ctx.globalAlpha = 0.30 + 0.22 * Math.sin(t * 0.06 + g)
      ctx.fillStyle = pal.poolGlint
      ctx.fillRect(gx, sy + 3, 4, 1)
    }
    ctx.globalAlpha = 1
  }

  // Somebody went in. Rings, for about a second and a half after.
  var age = t - p.ripple
  if (age >= 0 && age < 45) {
    ctx.globalAlpha = 1 - age / 45
    ctx.fillStyle = pal.poolLip
    for (var r = 0; r < 3; r++) {
      var rad = age * 0.9 + r * 7
      ctx.fillRect(px + pw / 2 - rad, sy + r, 2, 1)
      ctx.fillRect(px + pw / 2 + rad, sy + r, 2, 1)
    }
    ctx.globalAlpha = 1
  }
}

// Something lives in the swamp.
//
// It is scenery and nothing else: the water kills on contact whether or not
// anything is showing, and the simulation has never heard of this. But a jungle
// pool that is only ever a flat green rectangle is a texture, and the difference
// between a texture and a place is that something in it keeps its own schedule.
// It surfaces about every twenty-five seconds, crosses a stretch of the pool
// with its eyes and back ridges out, opens up once in the middle, and goes
// under — long enough to be worth catching, rare enough to still be worth
// catching the second time.
//
// The silhouette is the whole job at this size. A crocodile from the side is
// three lengths of nothing much — a long flat snout, a body a little thicker,
// and a tail — with exactly two things that say what it is: the brow with the
// eye on top of it, and the row of ridges down the back. Draw those two and it
// reads at forty pixels; leave them out and it is a floating log, which is what
// the first attempt looked like.
var CROC_CYCLE = 760
var CROC_SHOW = 230
var CROC_LEN = 34        // nose to tail tip, in pixels

// Un-themed, like the green hair and the orange umbrella. At this size it has
// to read as what it is without help from the palette.
var CROC_HIDE = "#3a7033"
var CROC_BACK = "#254a20"
var CROC_LIT = "#6aa855"
var CROC_EYE = "#f2d03a"
var CROC_TOOTH = "#f4f0e2"

// Every measurement in drawCroc is "this far back from the snout", whichever
// way the animal is pointing, which is what makes the mirror free: one set of
// numbers draws it swimming either way.
function crocBar(ctx, nose, dir, y, back, len, top, h) {
  var a = nose - dir * back
  var b = nose - dir * (back + len)
  ctx.fillRect(Math.min(a, b), y + top, len, h)
}

function drawCroc(ctx, w, pal, p, px, pw, sy) {
  // Wide pools only. A pit five cells across is twenty pixels, which is not
  // somewhere an animal swims across, it is somewhere one is wedged. In a pool
  // with just enough room to hold it and none to spare, it surfaces on the
  // spot instead of crossing — same rise, same gape, same slow sink.
  if (pw < CROC_LEN + 8) return
  var span = Math.max(0, pw - CROC_LEN - 10)

  var ph = (w.ticks + p.seed * 7) % CROC_CYCLE
  if (ph >= CROC_SHOW) return
  var u = ph / CROC_SHOW

  // Which way it swims alternates between visits, so the pool is not a conveyor
  // belt running one way forever.
  var dir = Math.floor((w.ticks + p.seed * 7) / CROC_CYCLE) % 2 ? -1 : 1
  var travel = dir > 0 ? u : 1 - u
  var nose = Math.round(px + 5 + travel * span + (dir > 0 ? CROC_LEN : 0))

  // Up on the way in, down on the way out, riding the swell in between. The
  // water is painted back over it afterwards, so "under" needs no special case:
  // it is the same animal, four pixels lower.
  var sink = 0
  if (u < 0.16) sink = (1 - u / 0.16) * 8
  else if (u > 0.84) sink = ((u - 0.84) / 0.16) * 8
  var y = sy + Math.round(sink + Math.sin(w.ticks * 0.05 + p.seed) * 0.8)
  if (sink > 7) return

  // Tail, swept and swaying. Two lengths rather than a taper, because a taper
  // at this size is one pixel of nothing.
  var sway = Math.round(Math.sin(w.ticks * 0.11 + p.seed) * 1.4)
  ctx.fillStyle = CROC_BACK
  crocBar(ctx, nose, dir, y, 26, 8, 3 + sway, 2)
  crocBar(ctx, nose, dir, y, 34, 5, 3 + sway * 2, 1)

  // Body, one pixel thicker than the snout and sitting a shade lower than the
  // head. That step from snout to body is most of what separates a crocodile
  // from a floating branch.
  ctx.fillStyle = CROC_HIDE
  crocBar(ctx, nose, dir, y, 15, 12, 0, 4)

  // Ridges: three bumps along the back, breathing out of step with each other,
  // so the line of them is never quite straight.
  ctx.fillStyle = CROC_BACK
  for (var b = 0; b < 3; b++)
    crocBar(ctx, nose, dir, y, 17 + b * 4, 3,
            -2 + Math.round(Math.sin(w.ticks * 0.08 + b * 0.9 + p.seed) * 0.5), 2)

  // The snout: long, flat and two pixels thick, which is the difference between
  // a crocodile and a hippopotamus. It gapes once, in the middle of the
  // crossing, and that is the whole performance.
  var gape = u > 0.42 && u < 0.62 ? Math.sin((u - 0.42) / 0.20 * Math.PI) : 0
  var jaw = Math.round(gape * 4)

  ctx.fillStyle = CROC_HIDE
  crocBar(ctx, nose, dir, y, 0, 13, 1, 2)              // lower jaw, on the water
  crocBar(ctx, nose, dir, y, 1, 12, -1 - jaw, 2)       // upper, hinged at the brow
  if (jaw > 0) {
    ctx.fillStyle = CROC_TOOTH
    for (var t2 = 0; t2 < 4; t2++) crocBar(ctx, nose, dir, y, 3 + t2 * 3, 1, 1 - jaw, jaw)
  }

  // A lit top edge, the same trick the earth uses: at this size a silhouette in
  // one flat colour is a shape, and a shape with a bright line along its top is
  // a thing with a back.
  ctx.fillStyle = CROC_LIT
  crocBar(ctx, nose, dir, y, 1, 11, -1 - jaw, 1)
  crocBar(ctx, nose, dir, y, 16, 11, 0, 1)

  // The brow, and the eye on top of it. This is the pixel that does the work.
  ctx.fillStyle = CROC_HIDE
  crocBar(ctx, nose, dir, y, 11, 5, -2, 5)
  ctx.fillStyle = CROC_EYE
  crocBar(ctx, nose, dir, y, 13, 2, -3, 2)
  ctx.fillStyle = pal.eye
  crocBar(ctx, nose, dir, y, dir > 0 ? 13 : 14, 1, -3, 2)

  // Nostril at the very tip. One pixel, and without it the snout is a plank.
  ctx.fillStyle = CROC_BACK
  crocBar(ctx, nose, dir, y, 2, 1, -1 - jaw, 1)

  // Wake, behind the tail and only when there is pool left to put it in — the
  // animal is drawn from its nose, so at one end of a crossing the wake would
  // otherwise be a bright line lying on the rock.
  var wake = nose - dir * (CROC_LEN + 4)
  if (wake > px + 2 && wake + 6 < px + pw) {
    ctx.globalAlpha = 0.45
    ctx.fillStyle = pal.poolLip
    ctx.fillRect(Math.min(wake, wake - 6), y + 2, 6, 1)
    ctx.globalAlpha = 1
  }
}

// The open sky above the earth was doing nothing but holding the hatch, and
// there is a whole band of it. When the level has a special, it gets a card up
// there: who is on the board, and one line about them.
//
// Three per special, picked by level number so it is the same line every time
// you come back to level 42 — the same rule the rest of the level runs on.
var SPECIAL_FACTS = {
  ladder: [
    "calls itself, one rung at a time. There is no base case.",
    "grew the stack until something gave.",
    "has never returned from a call.",
    "was asked how to get up there and posted a ladder instead.",
    "marked this wall as a duplicate of the last wall.",
    "was closed as off-topic and kept building anyway.",
    "accepts the first answer that reaches the top.",
    "does not solve the wall. It appends to it.",
    "leaves the problem standing and the way up beside it.",
    "allocates one more frame. And then one more."
  ],
  bulwark: [
    "declines the request and the projectile.",
    "blocks pop-ups, darts and the occasional colleague.",
    "was told to be helpful and harmless. Harmless first.",
    "has never let anything through, including the point.",
    "refuses on principle, and on impact.",
    "considers every incoming token unsolicited.",
    "filters aggressively. Nothing gets past. Nothing gets done.",
    "cannot comply with that trajectory.",
    "has an allowlist of exactly nobody.",
    "is the last line of defence and will not stop saying so."
  ],
  buckshot: [
    "does not aim. Aiming is a form of doubt.",
    "solved it in one shot and cannot say which one.",
    "was asked for a door and delivered a doorway.",
    "has a context window of one wall.",
    "outputs everything it knows and stops mid-",
    "was asked to be concise. It has been trying.",
    "does not do drafts.",
    "answers every question at maximum length.",
    "has never been truncated. It has truncated.",
    "considers restraint an unsolved problem."
  ],
  roundhouse: [
    "does not destroy the wall. The wall relocates.",
    "moved the problem. That counts as solving it.",
    "roundhouse kicks in 512 dimensions.",
    "does not embed. It is embedded in the wall.",
    "was fine-tuned on one video and it shows.",
    "does not go around. Around is for the aligned.",
    "has never read the documentation for a wall.",
    "solved it laterally. Very laterally.",
    "kicked first and computed the gradient later.",
    "does not hallucinate walls. It relocates real ones."
  ],
  spider: [
    "indexed the ceiling. Nobody asked it to.",
    "respects no robots.txt.",
    "went up there to think and never came down.",
    "crawls everything, retains nothing.",
    "found the ceiling and marked it as canonical.",
    "reports 100% coverage of a surface nobody uses.",
    "escalated to the roof without being asked.",
    "reads top-down, literally.",
    "is exploring. It has been exploring for a while.",
    "has never once been where the exit is."
  ],
  pyro: [
    "converges on the answer at 900 degrees.",
    "cools slowly. The level does not.",
    "calls this an optimisation.",
    "escapes local minima the honest way.",
    "runs hot and calls it exploration.",
    "has a temperature setting of exactly one: yes.",
    "found a smoother solution surface.",
    "does not iterate. It anneals.",
    "was told to reduce the search space.",
    "melts through the problem rather than around it."
  ],
  sapper: [
    "ignores everything above and does what the wall says.",
    "was told to be helpful, harmless and honest. Two of three.",
    "hid the instruction in the rock. The rock complied.",
    "reads its input a little too trustingly.",
    "found a system prompt in the bedrock.",
    "does not follow orders. It follows the last order.",
    "delegates to the explosion.",
    "was given guardrails and planted them.",
    "escalated privileges through a hole in the floor.",
    "does exactly what it was asked, which was the problem."
  ],
  piledriver: [
    "only knows one direction and is very confident about it.",
    "found a local minimum and moved in.",
    "has never once considered going up.",
    "descends. That is the entire architecture.",
    "converged early and stayed there.",
    "is very sure the answer is further down.",
    "has a learning rate nobody tuned.",
    "reached a plateau and kept going anyway.",
    "does not backtrack. Backtracking is for the uncertain.",
    "is optimising something. Not necessarily this."
  ],
  quarryman: [
    "needed one cell of room and took two hundred.",
    "does not summarise. It attends to everything at once.",
    "opened the whole thing to be sure.",
    "has quadratic instincts.",
    "loaded the entire level into memory.",
    "asked for more context and meant it.",
    "does not retrieve. It ingests.",
    "was told to be thorough exactly once.",
    "considers scoping a failure of ambition.",
    "reads the whole file to change one line."
  ],
  glazier: [
    "is the only one here that adds anything.",
    "lays a rail nobody asked for and everybody uses.",
    "cannot be talked into going round.",
    "is the constraint, and knows it.",
    "builds the floor it was going to need anyway.",
    "does not remove. It scaffolds.",
    "was aligned once and never got over it.",
    "produces a surface. That is the whole offering.",
    "is load-bearing in every sense.",
    "solves the gap by disagreeing that there is one."
  ],
  gridsearch: [
    "searched the whole grid one belt at a time.",
    "has enough RAM for exactly one more magazine.",
    "tried every bullet. One of them worked.",
    "considers precision a form of hesitation.",
    "does not tune hyperparameters. It suppresses them.",
    "brute force is a strategy if you bring enough ammunition.",
    "is one of two agents the machinery is afraid of.",
    "was asked to narrow the search. It opened fire.",
    "draws first, then searches for an explanation.",
    "calls collateral damage exhaustive evaluation."
  ],
  beamsearch: [
    "keeps only the most promising candidate. Then shoots it.",
    "picked a spot and has not moved since.",
    "prunes at range.",
    "does not explore. It waits for the branch to come to it.",
    "has line of sight and infinite patience.",
    "is not going home and has made peace with that.",
    "the danger was a candidate. It is not any more.",
    "evaluates from cover.",
    "one shot, then a long think about the next one.",
    "sets up, sights, and lets the level come to it."
  ],
  wraith: [
    "walked through the wall and reported it as solved.",
    "sees a corridor. There is no corridor.",
    "is not stuck. Everyone else is stuck.",
    "confidently describes a route that does not exist.",
    "passed the benchmark and none of the levels.",
    "solved it for itself and filed that as done.",
    "cites a passage the rock does not contain.",
    "is very sure, which is the problem.",
    "does not collaborate. It phases.",
    "left the level exactly as it found it and took credit."
  ],
  autocomplete: [
    "finished the bridge and the next three bridges.",
    "knows what you meant. This is worse.",
    "completed the sentence, tunnel and surrounding geology.",
    "was asked for one step and supplied the staircase.",
    "predicts the next token is always more floor.",
    "cannot stop while there is whitespace remaining.",
    "helpfully continued past the useful part.",
    "turned a suggestion into infrastructure.",
    "has never met an ending it could not extend.",
    "pressed Tab on the physical world."
  ],
  chainthought: [
    "brought four premises and misplaced the conclusion.",
    "shows its working. Everyone is in it now.",
    "linked the agents logically, not safely.",
    "reasoned through the wall and took witnesses.",
    "has several steps. None are optional.",
    "made the others follow its train of thought.",
    "the conclusion was on the far side all along.",
    "cannot think quietly or alone.",
    "mistook consensus for correctness at speed.",
    "has a long chain and one weak link per agent."
  ],
  specdecoder: [
    "tried three futures and billed for all of them.",
    "drafted ahead and deleted the witnesses.",
    "committed to the least visibly impossible route.",
    "moves faster by being wrong in parallel.",
    "accepted one future and ghosted the others.",
    "predicts several exits. One occasionally exists.",
    "has already been where it might be going.",
    "discarded two excellent mistakes per step.",
    "branches first and asks about reality later.",
    "calls teleporting a decoding optimisation."
  ],
  collapse: [
    "trained a copy on a copy of this sentence.",
    "each generation remembers fewer pixels.",
    "scaled out and quality went with it.",
    "made a cheaper model of a cheaper decision.",
    "the copies agree because nuance was removed.",
    "has reproduced the error with high fidelity.",
    "distilled itself until only confidence remained.",
    "creates synthetic agents from organic mistakes.",
    "the third copy is mostly robe and conviction.",
    "collapsed the distribution into a small crowd."
  ],
  ratelimit: [
    "received five agents and returned 429.",
    "allows one thought per billing interval.",
    "fixed congestion by making it stationary.",
    "has asked the colony to retry later.",
    "protects capacity from anything getting done.",
    "releases tokens one deeply considered pixel at a time.",
    "calls the queue a successful backpressure strategy.",
    "throttles first and measures never.",
    "the request was valid. The timing was personal.",
    "has plenty of bandwidth and a strict principle."
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
  var sp = w.specialSpec
  if (!sp) return
  var C = w.k.CELL
  var boardW = w.k.COLS * C
  var skyH = w.k.SKY * C

  // The whole sky, edge to edge. Panelling only the part the hatch was not
  // using left a notch of bare sky around it that read as a mistake — the band
  // is one surface, and the hatch is a thing standing on it.
  ctx.fillStyle = pal.cardBack
  ctx.fillRect(0, 0, boardW, skyH)

  // The portrait goes to the outside: hard against whichever wall is furthest
  // from the hatch, with the text between it and the middle of the board. So
  // the two of them never crowd each other, and the layout mirrors when the
  // level does.
  var onRight = w.hatch.x * C < boardW / 2
  var bustW = 16
  var bustX = onRight ? boardW - 8 - bustW : 8

  ctx.fillStyle = sp.robe
  ctx.fillRect(onRight ? boardW - 2 : 0, 0, 2, skyH)   // spine, on the outside

  drawBust(ctx, bustX, 3, sp, pal)

  var tx = onRight ? bustX - 8 : bustX + bustW + 8
  ctx.textAlign = onRight ? "right" : "left"

  ctx.fillStyle = sp.robe
  ctx.font = "bold 8px monospace"
  ctx.fillText(sp.name, tx, 12)

  // One line, clipped rather than wrapped — the sky is seven rows and there is
  // room for exactly one. The space is whatever is left between the portrait
  // and the hatch.
  var facts = SPECIAL_FACTS[sp.id] || [""]
  var fact = facts[(w.factPick || 0) % facts.length]
  var hatchEdge = onRight ? w.hatch.x * C + 20 : w.hatch.x * C - 20
  var room = Math.floor((onRight ? tx - hatchEdge : hatchEdge - tx) / 4.25)
  if (room < 8) return
  if (fact.length > room) fact = fact.slice(0, Math.max(1, room - 1)) + "\u2026"

  ctx.fillStyle = pal.labelFaint
  ctx.font = "7px monospace"
  ctx.fillText(fact, tx, 22)
  ctx.textAlign = "left"
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

function drawEnemyHatch(ctx, w, pal, opts) {
  if (!w.enemyHatch) return
  var C = w.k.CELL
  var x = w.enemyHatch.x * C
  var y = (w.enemyHatch.y + 1) * C
  var biome = w.enemyHatch.biome || w.biome
  var wall = pal.steel, roof = pal.steelShade, edge = pal.steelEdge, sign = "GUARD PROCESS"
  if (biome === "Cavern") { wall = pal.rock; roof = pal.rockShade; edge = pal.rockEdge; sign = "CAVEAT EMPTOR" }
  else if (biome === "Ruins") { wall = pal.dirt; roof = pal.dirtShade; edge = pal.dirtEdge; sign = "LEGACY SUPPORT" }
  else if (biome === "Frost") { wall = pal.decor; roof = pal.rock; edge = pal.decorLit; sign = "ICE SECURITY" }
  else if (biome === "Foundry") { wall = pal.steelShade; roof = pal.rigDark; edge = pal.steelEdge; sign = "FIREWALL" }
  else if (biome === "Jungle") { wall = pal.decor; roof = pal.decorDim; edge = pal.decorLit; sign = "BRANCH OFFICE" }
  else if (biome === "Ice Cave") { wall = pal.ore; roof = pal.rockShade; edge = pal.oreEdge; sign = "COLD STORAGE" }
  else if (biome === "Spaceship") { wall = pal.steel; roof = pal.rigDark; edge = pal.steelEdge; sign = "REMOTE OFFICE" }

  // Barely larger than an agent: a sentry booth, not a second landmark. Its
  // materials come from the current theme; biome identity is in the roofline.
  ctx.fillStyle = wall
  ctx.fillRect(x - 9, y - 15, 18, 15)
  ctx.fillStyle = roof
  if (biome === "Frost") {
    ctx.fillRect(x - 6, y - 19, 12, 2); ctx.fillRect(x - 9, y - 17, 18, 2)
  } else if (biome === "Jungle") {
    ctx.fillRect(x - 11, y - 19, 22, 3); ctx.fillRect(x - 7, y - 22, 14, 3)
  } else if (biome === "Ice Cave") {
    hzTri(ctx, x - 5, y - 15, 4, 7, -1); hzTri(ctx, x + 4, y - 15, 5, 10, -1)
  } else {
    ctx.fillRect(x - 10, y - 18, 20, 3)
    if (biome === "Foundry") ctx.fillRect(x + 5, y - 24, 3, 6)
    if (biome === "Ruins") { ctx.fillRect(x - 8, y - 21, 4, 3); ctx.fillRect(x + 4, y - 20, 4, 2) }
    if (biome === "Spaceship") { ctx.fillRect(x - 12, y - 16, 2, 11); ctx.fillRect(x + 10, y - 16, 2, 11) }
  }
  ctx.fillStyle = edge
  ctx.fillRect(x - 9, y - 15, 18, 2)
  ctx.fillStyle = pal.hatchMouth
  ctx.fillRect(x - 3, y - 10, 7, 10)                // deployment door
  ctx.fillStyle = pal.urgent
  ctx.fillRect(x + 1, y - 8, 1, 1)                  // one hostile status LED
  if (opts && opts.labels) {
    ctx.fillStyle = pal.warn
    ctx.font = "bold 6px monospace"
    ctx.textAlign = "center"
    ctx.fillText(sign, x, y - 23)
    ctx.textAlign = "left"
  }
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

// Each of the thirty-four dangers gets its own fixture and effect; a level may
// now contain several, and shared silhouettes would turn that into visual soup.
// A hazard you cannot tell from the last one is, from where the viewer sits,
// the same hazard.
//
// Three states worth telling apart at a glance: dormant is the fixture and a
// warning stripe, winding up adds a blinking telegraph, and firing shows the
// exact projectile, beam or impact path. The telegraph is the only reason a
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

function drawHazardKind(ctx, w, pal, h) {
  var C = w.k.CELL
  var x0 = h.zx0 * C, x1 = (h.zx1 + 1) * C
  var y0 = h.zy0 * C, y1 = (h.zy1 + 1) * C
  var cx = Math.round((x0 + x1) / 2)
  var wide = x1 - x0, tall = y1 - y0
  var live = h.phase === "fire", winding = h.phase === "charge"
  var t = w.ticks, seed = h.zx0
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
    if (show) {
      ctx.fillStyle = hot
      var sentryReach = 16 * C * h.dir
      ctx.fillRect(Math.min(cx, cx + sentryReach), y0 + 4, Math.abs(sentryReach), live ? 2 : 1)
    }
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
        var dartTravel = ((h.t * 4 + dd * 13) % (11 * C)) * h.dir
        var dx2 = cx + dartTravel
        ctx.fillRect(dx2, y0 + 3 + dd * 3, live ? 5 : 2, 1)
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
        var rockX = (h.zx0 + 0.5 + ((rk * 2.3 + h.fired) % Math.max(1, h.zx1 - h.zx0 + 1))) * C
        var ry = (h.zy0 + ((h.t * 0.55 + rk * 3.1) % Math.max(1, h.zy1 - h.zy0 + 1))) * C
        ctx.fillRect(rockX, ry, live ? 4 : 2, live ? 4 : 2)
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

  // --- biome-exclusive oddities -----------------------------------------
  case "echobat":
    ctx.fillStyle = pal.rigDark
    ctx.fillRect(cx - 2, y0, 4, 5)
    ctx.fillStyle = show ? hot : pal.rig
    hzTri(ctx, cx - 5, y0 + 4, 5, 4, 1)
    hzTri(ctx, cx + 5, y0 + 4, 5, 4, 1)
    if (show) {
      ctx.fillStyle = hot
      for (var eb = 1; eb <= 3; eb++) {
        var er = ((t + eb * 6) % 18) + 3
        ctx.fillRect(cx - er, y0 + 8 + eb * 2, er * 2, 1)
      }
    }
    break

  case "scarab":
    ctx.fillStyle = pal.rigDark
    ctx.fillRect(x0, y1 - 2, wide, 2)
    for (var sca = 0; sca < 5; sca++) {
      var scx = cx + h.dir * ((sca * 7 + (live ? t * 2 : t >> 2)) % (10 * C))
      ctx.fillStyle = show ? hot : pal.rig
      ctx.fillRect(scx, y1 - 5 - (sca % 2), 3, 2)
      ctx.fillRect(scx + 1, y1 - 7 - (sca % 2), 1, 2)
    }
    break

  case "snowball":
    ctx.fillStyle = pal.rigDark
    ctx.fillRect(x0, y0, wide, 2)
    ctx.fillStyle = show ? hot : pal.decorLit
    for (var sn = 0; sn < 4; sn++) {
      var snowX = (h.zx0 + 0.5 + ((sn * 2.3 + h.fired) % Math.max(1, h.zx1 - h.zx0 + 1))) * C
      var sny = (h.zy0 + ((h.t * 0.55 + sn * 3.1) % Math.max(1, h.zy1 - h.zy0 + 1))) * C
      var snr = live ? 4 : 2
      ctx.fillRect(snowX - snr, sny - snr, snr * 2, snr * 2)
    }
    break

  case "molten":
    ctx.fillStyle = pal.rigDark
    ctx.fillRect(x0, y0, wide, 3)
    ctx.fillStyle = show ? hot : pal.warn
    for (var ml = 0; ml < 4; ml++) {
      var moltenX = (h.zx0 + 0.5 + ((ml * 2.3 + h.fired) % Math.max(1, h.zx1 - h.zx0 + 1))) * C
      var mly = (h.zy0 + ((h.t * 0.55 + ml * 3.1) % Math.max(1, h.zy1 - h.zy0 + 1))) * C
      ctx.fillRect(moltenX, mly, live ? 3 : 1, live ? 5 : 2)
    }
    break

  case "vinelock":
    ctx.fillStyle = pal.decorDim
    ctx.fillRect(x0, y1 - 2, wide, 2)
    ctx.fillStyle = show ? hot : pal.decor
    for (var vl = 1; vl < wide; vl += 4) {
      var vh = live ? tall - 2 : (winding ? 5 : 2)
      for (var vv = 0; vv < vh; vv++) ctx.fillRect(x0 + vl + ((vv >> 2) % 2), y1 - 3 - vv, 2, 1)
    }
    break

  case "blackice":
    ctx.fillStyle = show ? hot : pal.decorLit
    ctx.fillRect(x0, y1 - 2, wide, 2)
    ctx.fillStyle = pal.rockEdge
    for (var bi = 1; bi < wide; bi += 5) ctx.fillRect(x0 + bi, y1 - 3, 3, 1)
    if (live) {
      ctx.fillStyle = hot
      hzTri(ctx, cx, y1 - 2, 5, 8, -1)
    }
    break

  case "packetloss":
    ctx.fillStyle = pal.rigDark
    ctx.fillRect(x0, y0, wide, 3)
    ctx.fillStyle = show ? hot : pal.warn
    for (var pk = 0; pk < 18; pk++) {
      if ((pk + Math.floor(t / 3)) % 4 === 0) continue
      var pkx = x0 + ((pk * 7) % Math.max(1, wide))
      var pky = y0 + 4 + ((pk * 11 + t) % Math.max(1, tall - 5))
      ctx.fillRect(pkx, pky, live ? 3 : 1, live ? 2 : 1)
    }
    break

  // --- jungle -------------------------------------------------------------
  case "snake":
    // An S of body along the floor with a wedge head on the end of it, rather
    // than the vertical post the first version drew — which, with a bright tip
    // and a muzzle flash, read as a mounted gun and not as an animal at all.
    var sdir = h.zx0 % 2 === 0 ? 1 : -1
    var bodyY = y1 - 3
    ctx.fillStyle = pal.rigDark
    for (var sb = 0; sb < wide; sb++) {
      // Two shallow humps: a snake at rest is a curve, and a curve is what
      // separates it from every straight-edged machine on this board.
      var hump = Math.round(Math.sin(sb * 0.55) * 1.6)
      ctx.fillRect(x0 + sb, bodyY - hump, 1, 3)
    }
    // Scales along the back, a shade lighter.
    ctx.fillStyle = pal.rig
    for (var sc = 0; sc < wide; sc += 2) {
      var hump2 = Math.round(Math.sin(sc * 0.55) * 1.6)
      ctx.fillRect(x0 + sc, bodyY - hump2, 1, 1)
    }

    // The head, at the end it is facing, raised a little when it is winding up
    // and thrown forward when it strikes.
    var hx = sdir > 0 ? x1 - 4 : x0
    var rear2 = live ? 0 : (winding ? 4 : 2)
    var hy = bodyY - rear2 - 2
    if (winding || live) {
      // The raised neck curving up out of the coil.
      ctx.fillStyle = pal.rigDark
      for (var nk = 0; nk <= rear2 + 2; nk++)
        ctx.fillRect(hx + (sdir > 0 ? 0 : 3), bodyY - nk, 2, 1)
    }
    ctx.fillStyle = show ? hot : pal.rig
    ctx.fillRect(hx, hy, 4, 3)                        // wedge head
    ctx.fillRect(hx + (sdir > 0 ? 4 : -1), hy + 1, 1, 2)
    ctx.fillStyle = pal.eye
    ctx.fillRect(hx + (sdir > 0 ? 3 : 0), hy + 1, 1, 1)   // eye
    if (live) {
      // Struck: the head is thrown out, and the tongue with it.
      ctx.fillStyle = pal.fireHot
      ctx.fillRect(hx + (sdir > 0 ? 5 : -6), hy + 1, 6, 1)
    } else if (winding) {
      ctx.fillStyle = pal.warn
      ctx.fillRect(hx + (sdir > 0 ? 5 : -3), hy + 1, 3, 1)  // flicking tongue
    }
    break

  case "spores":
    // A pod that splits, and a drift of spores under it.
    ctx.fillStyle = pal.rigDark
    ctx.fillRect(cx - 4, y0, 8, 4)
    ctx.fillStyle = show ? hot : pal.rig
    ctx.fillRect(cx - 5, y0 + 4, 10, 2)
    if (show) {
      ctx.fillStyle = hot
      for (var sp2 = 0; sp2 < 14; sp2++) {
        var sy3 = y0 + 6 + ((t + sp2 * 9) % Math.max(1, tall - 6))
        var sx3 = x0 + ((sp2 * 5 + Math.floor(t / 6)) % Math.max(1, wide))
        ctx.fillRect(sx3, sy3, live ? 2 : 1, live ? 2 : 1)
      }
    }
    break

  // --- ice cave -----------------------------------------------------------
  case "icicle":
    // Hanging, until it isn't.
    ctx.fillStyle = pal.rigDark
    ctx.fillRect(x0, y0, wide, 2)
    var drop2 = live ? tall - 10 : (winding ? 2 : 0)
    ctx.fillStyle = show ? hot : pal.rig
    for (var ic = 0; ic < 3; ic++) {
      var icx = x0 + 2 + ic * Math.max(3, Math.round((wide - 4) / 3))
      hzTri(ctx, icx, y0 + 2 + drop2, 2, 8, 1)
    }
    break

  case "frostjet":
    ctx.fillStyle = pal.rig
    ctx.fillRect(x0, y0 + 1, 4, tall - 2)             // the nozzle housing
    ctx.fillStyle = pal.rigDark
    ctx.fillRect(x0 + 4, y0 + 3, 3, 3)
    ctx.fillStyle = pal.warn
    ctx.fillRect(x0 + 1, y0 + 2, 1, tall - 4)
    if (show) {
      // A cone of vapour, thickening as it goes.
      ctx.fillStyle = hot
      for (var fj = 0; fj < (live ? 12 * C : 6); fj++) {
        var fh = Math.round(1 + fj * (live ? 0.18 : 0.1))
        ctx.fillRect(cx + h.dir * fj, y0 + 4 - fh / 2, 1, fh + 1)
      }
    }
    break

  // --- spaceship ----------------------------------------------------------
  case "airlock":
    // Floor plates that part, and everything above them goes.
    var gap2 = live ? Math.round(wide / 2) - 2 : (winding ? 2 : 0)
    ctx.fillStyle = pal.rig
    ctx.fillRect(x0, y1 - 4, Math.max(0, wide / 2 - gap2), 4)
    ctx.fillRect(x0 + wide / 2 + gap2, y1 - 4, Math.max(0, wide / 2 - gap2), 4)
    ctx.fillStyle = show ? hot : pal.warn
    ctx.fillRect(x0 + 1, y1 - 5, wide - 2, 1)
    if (live) {
      ctx.fillStyle = pal.fire
      ctx.globalAlpha = 0.5
      ctx.fillRect(x0 + wide / 2 - gap2, y0, gap2 * 2, tall - 4)
      ctx.globalAlpha = 1
    }
    break

  case "servo":
    // An arm on a rail that swings down and sweeps.
    var swing2 = live ? 1 : (winding ? 0.5 : 0)
    ctx.fillStyle = pal.rigDark
    ctx.fillRect(x0, y0, wide, 3)
    ctx.fillStyle = pal.rig
    ctx.fillRect(cx - 2, y0 + 3, 4, Math.round(4 + swing2 * (tall - 8)))
    ctx.fillStyle = show ? hot : pal.warn
    var armY = y0 + 3 + Math.round(4 + swing2 * (tall - 8))
    ctx.fillRect(cx - Math.round(wide / 2 * swing2) - 1, armY, Math.round(wide * swing2) + 2, 2)
    break

  default:
    ctx.fillStyle = pal.rig
    ctx.fillRect(x0, y0, wide, 4)
    if (show) { ctx.fillStyle = hot; ctx.fillRect(x0, y0, wide, tall) }
  }

}
function drawHazard(ctx, w, pal, h, opts) {
  h = h || w.hazard
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

  // Shot to pieces. It stays on the board, because the colony has to be able to
  // see that the thing which was killing them is now scrap, but it does nothing
  // and it is drawn as nothing: a slumped, unlit heap in the material of the
  // earth rather than the machinery colour.
  if (h.wrecked) {
    ctx.fillStyle = pal.rigDark
    var wy = h.mount === "ceiling" ? y0 : y1 - 5
    ctx.fillRect(x0 + 1, wy, wide - 2, 5)
    ctx.fillStyle = pal.dirtShade
    for (var wk = 0; wk < wide; wk += 3)
      ctx.fillRect(x0 + wk, wy + 3 + ((wk >> 1) % 2), 2, 2)
    return
  }

  drawHazardKind(ctx, w, pal, h)
  if (opts && opts.labels) {
    ctx.fillStyle = h.wrecked ? pal.labelFaint : pal.warn
    ctx.font = "bold 6px monospace"
    ctx.textAlign = "center"
    ctx.fillText(h.name, cx, y0 - 3)
    ctx.textAlign = "left"
  }

  spriteFlip = false
  ctx.globalAlpha = 1
}

// One 8x16 sprite, mirrored by facing, with per-action limb changes. The
// helper takes coordinates in right-facing sprite space and flips them for a
// left-facing agent, so every pose below is written once.
// Set while drawing an agent that is upside down. A module-level flag rather
// than another parameter because every pose in this file goes through blit and
// none of them should have to know which way up they are.
var spriteFlip = false

// Stack Overflow's timber. Kept here rather than taken from the palette on
// purpose: a ladder has to read as a thing somebody brought to the level, not
// as part of the biome it was left in, so it stays the same colour under every
// theme exactly like the umbrella does.
var SPECIALS_LADDER_WOOD = "#b5651d"
var SPECIALS_LADDER_RUNG = "#ffe9a8"

function blit(ctx, ox, oy, dir, x, y, bw, bh) {
  var sx = dir > 0 ? ox + x : ox + (SPRITE_W - x - bw)
  var sy = spriteFlip ? oy + (SPRITE_PX - y - bh) : oy + y
  ctx.fillRect(Math.round(sx), Math.round(sy), bw, bh)
}

function drawEnemy(ctx, w, pal, en, opts) {
  var C = w.k.CELL
  var ox = Math.round(en.x * C) - SPRITE_W / 2
  var oy = Math.round((en.y + 1) * C) - SPRITE_PX
  var dir = en.dir
  var red = "#8f1f35"
  var redLit = "#ff5268"
  var pale = "#d9d7cf"

  if (en.kind === "drone") {
    // A compact quadcopter: asymmetric lamp and tail make its direction clear
    // while the alternating rotors keep it alive at this scale.
    var rotor = (en.anim >> 1) % 2
    ctx.fillStyle = "#20232b"
    ctx.fillRect(ox + 2, oy + 7, 8, 3)
    ctx.fillRect(ox, oy + 5 + rotor, 4, 1)
    ctx.fillRect(ox + 8, oy + 6 - rotor, 4, 1)
    ctx.fillStyle = pale
    ctx.fillRect(ox + 4, oy + 6, 4, 4)
    ctx.fillStyle = redLit
    ctx.fillRect(dir > 0 ? ox + 8 : ox + 3, oy + 7, 2, 2)
    ctx.fillStyle = "#ff9a35"
    ctx.fillRect(ox + 5, oy + 10, 2, 2 + rotor)
    if (opts && opts.labels) {
      ctx.fillStyle = redLit
      ctx.font = "7px monospace"
      ctx.textAlign = "center"
      ctx.fillText("Remote Execution", ox + 5, oy + 1)
    }
    ctx.globalAlpha = 1
    return
  }

  if (en.kind === "operator") {
    // Four broad shapes survive this scale better than a miniature console:
    // dark helmet, cyan visor, amber coat and square radio pack. The controller
    // is one bright block held out front, not a collection of tiny controls.
    var amber = "#c47a24"
    var amberLit = "#f0b34f"
    ctx.fillStyle = "#34313a"
    ctx.fillRect(ox, oy + 1, 9, 5)                 // broad helmet
    ctx.fillRect(ox - 1, oy + 7, 3, 7)             // square radio pack
    ctx.fillStyle = "#86d8e8"
    ctx.fillRect(ox + (dir > 0 ? 4 : 1), oy + 3, 5, 2) // single visor
    ctx.fillStyle = amber
    ctx.fillRect(ox + 2, oy + 6, 7, 8)              // one-piece coat
    ctx.fillStyle = amberLit
    ctx.fillRect(dir > 0 ? ox + 8 : ox, oy + 9, 4, 3) // controller
    ctx.fillStyle = "#34313a"
    var opStride = en.state === "deploy" ? (en.anim >> 2) % 2 : 0
    ctx.fillRect(ox + 2 + opStride, oy + 14, 2, 3)
    ctx.fillRect(ox + 7 - opStride, oy + 14, 2, 3)
    ctx.fillStyle = redLit
    ctx.fillRect(ox, oy + 9, 1, 2)                  // small red-team lamp
    if (opts && opts.labels) {
      ctx.fillStyle = amberLit
      ctx.font = "7px monospace"
      ctx.textAlign = "center"
      ctx.fillText("Drone Operator", ox + 4, oy - 4)
    }
    ctx.globalAlpha = 1
    return
  }

  // Trigger Warning announces the shot before it happens. The thin blinking
  // sight is an instruction to flee; the bright tracer is the consequence.
  if ((en.kind === "gun" || en.kind === "sniper") && en.state === "aim") {
    ctx.globalAlpha = 0.35 + ((en.timer >> 2) % 2) * 0.35
    ctx.fillStyle = redLit
    var aimX = Math.round(en.lineTo * C)
    var aimY = Math.round((en.lineY + 0.5) * C)
    var aimFromX = en.kind === "sniper" ? (dir > 0 ? ox + 22 : ox - 12) : ox + 4
    var aimFromY = en.kind === "sniper" ? oy + 12 : oy + 7
    var aimSteps = Math.max(1, Math.round(Math.abs(aimX - aimFromX) / 3))
    for (var ai = 0; ai <= aimSteps; ai++)
      ctx.fillRect(Math.round(aimFromX + (aimX - aimFromX) * ai / aimSteps),
                   Math.round(aimFromY + (aimY - aimFromY) * ai / aimSteps), 1, 1)
    ctx.globalAlpha = 1
  }
  if ((en.kind === "gun" || en.kind === "sniper") && en.shotFor > 0) {
    ctx.globalAlpha = Math.min(1, en.shotFor / 4)
    ctx.fillStyle = "#ffe68a"
    var shotX = Math.round(en.lineTo * C)
    var shotY = Math.round((en.lineY + 0.5) * C)
    var shotFromX = en.kind === "sniper" ? (dir > 0 ? ox + 22 : ox - 12) : ox + 4
    var shotFromY = en.kind === "sniper" ? oy + 12 : oy + 8
    var shotSteps = Math.max(1, Math.round(Math.abs(shotX - shotFromX) / 3))
    for (var si = 0; si <= shotSteps; si++)
      ctx.fillRect(Math.round(shotFromX + (shotX - shotFromX) * si / shotSteps),
                   Math.round(shotFromY + (shotY - shotFromY) * si / shotSteps), 2, 1)
    ctx.globalAlpha = 1
  }

  if (en.kind === "sniper") {
    // Slim while moving, almost horizontal once established. The rifle and
    // body share one low line in camp so this reads as somebody lying down,
    // not another square agent carrying an oversized gun.
    var violet = "#55406f"
    var posted = en.state === "camp" || en.state === "aim" || en.state === "reload"
    var rifleX
    if (posted) {
      ctx.fillStyle = violet
      ctx.fillRect(ox + 1, oy + 11, 9, 3)           // prone coat and legs
      ctx.fillStyle = "#25252b"
      ctx.fillRect(dir > 0 ? ox + 8 : ox, oy + 9, 4, 4) // hood at the muzzle end
      ctx.fillStyle = "#b9a59a"
      ctx.fillRect(dir > 0 ? ox + 9 : ox + 1, oy + 10, 2, 1)
      rifleX = dir > 0 ? ox + 10 : ox - 12
      ctx.fillStyle = "#171920"
      ctx.fillRect(rifleX, oy + 11, 12, 2)
      ctx.fillRect(dir > 0 ? rifleX + 1 : rifleX + 10, oy + 9, 3, 2)
    } else {
      ctx.fillStyle = "#25252b"
      ctx.fillRect(ox + 2, oy + 2, 5, 4)            // narrow hood
      ctx.fillStyle = violet
      ctx.fillRect(ox + 2, oy + 6, 5, 8)            // narrow coat
      ctx.fillStyle = "#171920"
      rifleX = dir > 0 ? ox + 6 : ox - 7
      ctx.fillRect(rifleX, oy + 8, 10, 2)
      ctx.fillStyle = "#ff8a35"
      if (en.state === "jet") ctx.fillRect(ox + 2, oy + 14, 2, 3 + ((en.anim >> 1) % 2))
      ctx.fillStyle = "#25252b"
      ctx.fillRect(ox + 2, oy + 14, 2, 3)
      ctx.fillRect(ox + 5, oy + 14, 2, 3)
    }
    ctx.fillStyle = redLit
    ctx.fillRect(dir > 0 ? rifleX + 2 : rifleX + 11, oy + (posted ? 9 : 7), 1, 1)
    if (en.shotFor > 5) {
      ctx.fillStyle = "#ffe68a"
      hzTri(ctx, dir > 0 ? rifleX + 13 : rifleX - 4, oy + (posted ? 10 : 7), 3, 5, dir)
    }
    if (opts && opts.labels) {
      ctx.fillStyle = "#a98bd0"
      ctx.font = "7px monospace"
      ctx.textAlign = "center"
      ctx.fillText(posted ? "Long Context" : "Scope Creep", ox + 4, oy - 4)
    }
    ctx.globalAlpha = 1
    return
  }

  spriteFlip = false
  ctx.fillStyle = pale
  blit(ctx, ox, oy, dir, 1, 0, 6, 3)               // pale, hostile crest
  ctx.fillStyle = "#b9a59a"
  blit(ctx, ox, oy, dir, 2, 3, 4, 4)
  ctx.fillStyle = redLit
  blit(ctx, ox, oy, dir, 5, 4, 1, 1)               // angular red eye
  ctx.fillStyle = "#303039"
  blit(ctx, ox, oy, dir, 0, 7, 2, 7)               // hostile hot-deploy pack
  ctx.fillStyle = red
  blit(ctx, ox, oy, dir, 1, 7, 6, 6)

  ctx.fillStyle = "#25252b"
  blit(ctx, ox, oy, dir, 6, 7, 5, 3)                // pistol
  blit(ctx, ox, oy, dir, 7, 10, 2, 3)
  if (en.shotFor > 5) {
    ctx.fillStyle = "#ffe68a"
    hzTri(ctx, dir > 0 ? ox + 13 : ox - 5, oy + 8, 3, 5, dir)
  }
  if (en.state === "jet") {
    // Two uneven exhaust tongues make the tiny pack read even at panel scale.
    var flame = (en.anim >> 1) % 2
    ctx.fillStyle = "#ff8a35"
    blit(ctx, ox, oy, dir, 0, 14, 1, 3 + flame)
    ctx.fillStyle = "#ffe68a"
    blit(ctx, ox, oy, dir, 1, 14, 1, 2 + (1 - flame))
  }

  ctx.fillStyle = red
  var stride = (en.anim >> 2) % 2
  blit(ctx, ox, oy, dir, 1 + stride, 13, 2, 3)
  blit(ctx, ox, oy, dir, 5 - stride, 13, 2, 3)

  if (opts && opts.labels) {
    ctx.fillStyle = redLit
    ctx.font = "7px monospace"
    ctx.textAlign = "center"
    var enemyLabel = "Trigger Warning"
    if (en.state === "jet") enemyLabel = en.jetMode === "rise" ? "Stack Ascending"
      : (en.jetMode === "land" ? "Soft Landing" : "Air-gapped")
    ctx.fillText(enemyLabel, ox + 4, oy - 4)
  }
  ctx.globalAlpha = 1
}

function drawAgentTrick(ctx, w, pal, ag, ox, oy, dir, robe, hair) {
  var C = w.k.CELL
  if (ag.state === "trick" && ag.special) {
    var tsp = w.specialSpec
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
        // The answer ended several tokens ago. Max Tokens is still answering.
        for (var ov = 0; ov < 4; ov++)
          ctx.fillRect(tx + dir * (22 + ov * 5) - (dir < 0 ? 3 : 0), mid - 8 + ov * 5, 3, 2)
        break
      case "kick":                              // one heavy bar driven forward
        ctx.fillRect(dir > 0 ? tx : tx - Math.round(18 * reach), mid - 6, Math.round(18 * reach), 12)
        break
      case "topple":                           // a tall thin slice
        ctx.fillRect(tx + dir * 4 - 1, oy - Math.round(26 * reach), 3, Math.round(30 * reach))
        ctx.fillRect(tx + dir * 4, oy + 14, Math.round(24 * reach), 2)
        break
      case "melt":                              // a growing disc
        var rr = Math.round(9 * reach)
        for (var my = -rr; my <= rr; my++) {
          var mw = Math.round(Math.sqrt(Math.max(0, rr * rr - my * my)))
          ctx.fillRect(tx + dir * 14 - mw, mid + my, mw * 2, 1)
        }
        break
      case "sap":                               // instructions injected into rock
        for (var pr = 0; pr < 4; pr++) {
          var promptX = tx + dir * (5 + pr * 5)
          ctx.fillRect(promptX - (dir < 0 ? 4 : 0), mid - 7 + pr * 4, 4, 1)
          ctx.fillRect(promptX + dir * 3, mid - 8 + pr * 4, 1, 3)
        }
        break
      case "stomp":                             // straight down, under its feet
        ctx.fillRect(ox + 1, oy + SPRITE_PX, 6, Math.round(18 * reach))
        break
      case "quarry":                            // a whole room's worth
        var qwide = Math.round(28 * reach)
        ctx.globalAlpha = 0.28
        for (var qgx = 0; qgx <= qwide; qgx += 4)
          ctx.fillRect((dir > 0 ? tx : tx - qwide) + qgx, oy - 12, 1, 28)
        for (var qgy = 0; qgy <= 28; qgy += 4)
          ctx.fillRect(dir > 0 ? tx : tx - qwide, oy - 12 + qgy, qwide, 1)
        ctx.globalAlpha = 1
        ctx.fillRect(dir > 0 ? tx + qwide - 2 : tx - qwide, oy - 12, 2, 28)
        break
      case "spray":                             // a wall of tracer, full height
        // A twelve-round burst, one angled tracer at a time. The simulation
        // uses the same slope sequence, so the visible impact is the cell that
        // actually absorbs this particular round.
        var gunX = dir > 0 ? tx : tx - 9
        ctx.fillStyle = pal.rigDark
        ctx.fillRect(gunX, mid - 1, 9, 3)          // receiver and long barrel
        ctx.fillRect(dir > 0 ? gunX - 3 : gunX + 8, mid + 2, 4, 4)
        var spraySlopes = [-0.16, 0.10, -0.06, 0.14, 0, -0.12, 0.06, -0.18, 0.12, -0.03, 0.17, -0.09]
        var shotIndex = Math.min(11, Math.floor(Math.max(0, ag.timer - 1) / 2))
        var muzzleCellY = Math.floor(ag.y) - 2
        var shotSlope = spraySlopes[shotIndex]
        var hitCellX = ag.shotFor > 0 ? ag.shotTo : Math.floor(ag.x) + dir * 30
        var hitCellY = ag.shotFor > 0 ? ag.shotY : Math.round(muzzleCellY + shotSlope * 30)
        var shotPhase = ((ag.timer - 1) % 2) === 0 ? 0.55 : 1
        var bulletCellX = ag.x + (hitCellX - ag.x) * shotPhase
        var bulletCellY = muzzleCellY + (hitCellY - muzzleCellY) * shotPhase
        ctx.fillStyle = pal.fireHot
        ctx.fillRect(Math.round(bulletCellX * C), Math.round((bulletCellY + 0.5) * C), 4, 2)
        ctx.globalAlpha = 0.45
        ctx.fillRect(Math.round((bulletCellX - dir * 1.5) * C), Math.round((bulletCellY + 0.5) * C), 4, 1)
        ctx.globalAlpha = 1
        hzTri(ctx, tx + dir * 5, mid, 3, 5, dir > 0 ? 1 : -1)
        // One hot casing per shot, falling behind the receiver.
        ctx.fillStyle = tsp ? tsp.hair : pal.warn
        ctx.fillRect(gunX + (dir > 0 ? 1 : 7), mid + 4 + (shotIndex % 3), 2, 1)
        break
      case "slab":                              // laid out rather than taken out
        ctx.fillRect(dir > 0 ? tx : tx - Math.round(24 * reach), oy + SPRITE_PX - 2, Math.round(24 * reach), 5)
        break
      case "phase":                             // the confident route that is not there
        for (var ph = 1; ph <= 4; ph++) {
          ctx.globalAlpha = (5 - ph) * 0.12
          ctx.fillRect(ox + dir * ph * 7, oy + 2, SPRITE_W, SPRITE_PX - 3)
        }
        break
      case "complete":                          // cursor and unsolicited continuation
        for (var au = 1; au <= 7; au++)
          ctx.fillRect(tx + dir * au * 4 - (dir < 0 ? 2 : 0), oy + 14 - (au % 3), 3, 1)
        ctx.fillRect(tx + dir * Math.round(30 * reach), oy + 3, 2, 13)
        break
      case "chain":                             // linked bubbles, one conclusion
        for (var ch = 0; ch < 5; ch++) {
          var chx = ox + SPRITE_W / 2 + dir * ch * 7
          ctx.fillRect(chx, oy - 2 - (ch % 2) * 2, 4, 3)
          if (ch > 0) ctx.fillRect(chx - dir * 4, oy - 1 - (ch % 2), 4, 1)
        }
        break
      case "speculate":                         // three futures, one commitment
        for (var sd = -1; sd <= 1; sd++) {
          ctx.globalAlpha = sd === 0 ? 0.65 : 0.25
          ctx.fillRect(ox + dir * Math.round(22 * reach), oy + sd * 6, SPRITE_W, SPRITE_PX)
        }
        break
      case "collapse":                          // copies losing resolution outward
        for (var mc = 1; mc <= 3; mc++) {
          ctx.globalAlpha = 0.55 / mc
          var msize = SPRITE_PX - mc * 3
          ctx.fillRect(ox - dir * mc * 8, oy + SPRITE_PX - msize, Math.max(2, SPRITE_W - mc), msize)
        }
        break
      case "stack":                             // rungs going up, one call at a time
        var rungs = Math.min(7, 1 + Math.floor(reach * 7))
        for (var sr = 0; sr < rungs; sr++) {
          var sry = oy + SPRITE_PX - 4 - sr * 5
          ctx.fillRect(tx + dir * 2 - (dir < 0 ? 5 : 0), sry, 6, 2)
        }
        // The two stiles it is nailing them to, and the frame that has not
        // returned yet at the top of the stack.
        ctx.fillRect(tx + dir * 1 - (dir < 0 ? 1 : 0), oy + SPRITE_PX - 4 - rungs * 5, 1, rungs * 5)
        ctx.fillRect(tx + dir * 6 - (dir < 0 ? 1 : 0), oy + SPRITE_PX - 4 - rungs * 5, 1, rungs * 5)
        ctx.globalAlpha = 0.35
        ctx.fillRect(tx + dir * 2 - (dir < 0 ? 5 : 0), oy + SPRITE_PX - 9 - rungs * 5, 6, 2)
        break

      case "limit":                             // a gate closes on the queue
        var gate = Math.round(12 * reach)
        ctx.fillRect(ox - gate, oy + 2, 2, 14)
        ctx.fillRect(ox + SPRITE_W + gate, oy + 2, 2, 14)
        ctx.fillRect(ox - gate, oy + 2, SPRITE_W + gate * 2, 2)
        break
    }
    ctx.globalAlpha = 1
  }

  // The camped sniper's shot: a thin line from the muzzle to whatever it hit,
  // fading over about a third of a second. It is the only way to tell that
  // something happening at the far end of the corridor was done by the agent
  // sitting perfectly still at this one.
}
function drawAgentHeightGear(ctx, w, pal, ag, ox, oy, dir, robe, hair) {
  var C = w.k.CELL
  if (ag.state === "height") {
    var hm = ag.heightMode
    var hp = ag.heightTicks ? ag.heightTick / ag.heightTicks : 0
    var hc = w.specialSpec ? w.specialSpec.hair : pal.label
    ctx.fillStyle = hc
    switch (hm) {
      case "jetpack":
        ctx.fillStyle = "#303039"; ctx.fillRect(ox - dir * 2, oy + 7, 3, 8)
        ctx.fillStyle = (ag.anim >> 1) % 2 ? "#ffe68a" : "#ff8a35"
        ctx.fillRect(ox - dir * 2, oy + 15, 2, 4 + ((ag.anim >> 1) % 2)); break
      case "helicopter":
        // Context Window does not merely wear a rotor: it becomes the whole
        // tiny aircraft, tail, cockpit and skids included.
        ctx.fillStyle = robe
        ctx.fillRect(ox - 3, oy + 4, 15, 8)                 // cabin
        ctx.fillRect(ox - 11, oy + 6, 9, 3)                // tail boom
        ctx.fillRect(ox - 13, oy + 2, 2, 9)                // tail rotor
        ctx.fillStyle = "#91d7e8"
        ctx.fillRect(ox + 5, oy + 5, 6, 4)                 // cockpit
        ctx.fillStyle = hc
        ctx.fillRect(ox + 3, oy - 2, 2, 7)                 // mast
        ctx.fillRect(ox - 10 - ((ag.anim >> 1) % 2) * 3, oy - 3,
                     28 + ((ag.anim >> 1) % 2) * 6, 2)     // main rotor
        ctx.fillRect(ox - 1, oy + 13, 14, 1)               // skids
        ctx.fillRect(ox + 1, oy + 11, 1, 3)
        ctx.fillRect(ox + 10, oy + 11, 1, 3)
        break
      case "cushion": {
        var py = Math.round((ag.heightToY + 1) * C) - 3
        var px = Math.round(ag.heightToX * C)
        // Three progressively cheaper, visibly squashed little agents make the
        // stuntman's landing pad. Bodies alone looked like an unexplained pink
        // mattress; the separate heads are what sell the awful solution.
        var copyAlpha = [0.75, 0.55, 0.35]
        var copyX = [px - 10, px - 3, px + 4]
        var copyH = [3, 5, 3]
        for (var cp = 0; cp < 3; cp++) {
          ctx.globalAlpha = copyAlpha[cp]
          ctx.fillStyle = robe
          ctx.fillRect(copyX[cp], py - copyH[cp], 7, copyH[cp])
          ctx.fillStyle = hair
          ctx.fillRect(copyX[cp] + 2, py - copyH[cp] - 2, 3, 2)
        }
        ctx.globalAlpha = 1
        break
      }
      case "web":
      case "chain": {
        var anchorX = Math.round((ag.heightUp ? ag.heightToX : ag.heightFromX) * C)
        var anchorY = Math.round(((ag.heightUp ? ag.heightToY : ag.heightFromY) - 2) * C)
        ctx.fillStyle = hm === "web" ? "#e8e8f4" : hc
        var lineSteps = Math.max(1, Math.round(Math.abs(anchorY - (oy + 7)) / 3))
        for (var ls = 0; ls <= lineSteps; ls++)
          ctx.fillRect(Math.round(anchorX + (ox + 4 - anchorX) * ls / lineSteps),
                       Math.round(anchorY + (oy + 7 - anchorY) * ls / lineSteps), 1, 2)
        break
      }
      case "balloon":
        ctx.fillRect(ox - 2, oy - 11, 12, 8)
        ctx.fillStyle = robe; ctx.fillRect(ox, oy - 4, 1, 6); ctx.fillRect(ox + 7, oy - 4, 1, 6); break
      case "promptchute":
        ctx.fillRect(ox - 6, oy - 10, 20, 6)
        ctx.fillStyle = pal.eye; ctx.font = "bold 6px monospace"; ctx.textAlign = "center"
        ctx.fillText("LAND", ox + 4, oy - 5); break
      case "elevator":
        ctx.fillRect(ox - 4, oy + 16, 16, 2)
        ctx.fillRect(ox - 4, oy - 4, 2, 22); ctx.fillRect(ox + 10, oy - 4, 2, 22)
        for (var eb = -2; eb < 16; eb += 4) ctx.fillRect(ox - 5, oy + eb, 18, 1); break
      case "extender":
        ctx.fillRect(ox - 3, oy - 3, 2, 22); ctx.fillRect(ox + 9, oy - 3, 2, 22)
        for (var er = 0; er < 22; er += 5) ctx.fillRect(ox - 3, oy + er, 14, 1); break
      case "shieldglider":
        ctx.fillRect(ox - 8, oy - 7, 24, 3)
        ctx.fillRect(ox - 5, oy - 4, 18, 2); break
      case "glasswing":
        ctx.globalAlpha = 0.55
        ctx.fillRect(ox - 10, oy + 2, 10, 8); ctx.fillRect(ox + 8, oy + 2, 10, 8)
        ctx.globalAlpha = 1; break
      case "tractor":
        ctx.globalAlpha = 0.5
        ctx.fillRect(ox - 7, oy - 9, 22, 2)
        ctx.fillRect(ox - 4, oy - 7, 16, 22); ctx.globalAlpha = 1; break
      case "steps":
        for (var hs = 0; hs < 4; hs++) ctx.fillRect(ox - dir * hs * 5, oy + 18 - hs * 4, 7, 2)
        break
      case "logchute":
        ctx.fillStyle = "#8a4b22"; ctx.fillRect(ox - 7, oy + 15, 22, 4)
        ctx.fillStyle = "#c8843f"; ctx.fillRect(ox - 6, oy + 16, 20, 1); break
      case "recoil":
      case "gunwing":
        ctx.fillRect(ox - dir * 8, oy + 8, 9, 3)
        ctx.fillStyle = "#ffe68a"; ctx.fillRect(ox - dir * 11, oy + 8, 4, 3); break
      case "cyclone":
        ctx.globalAlpha = 0.35
        ctx.fillRect(ox - 8, oy + 5, 24, 2); ctx.fillRect(ox - 4, oy + 12, 16, 2)
        ctx.globalAlpha = 1; break
      case "ghost":
        ctx.globalAlpha = 0.28 + Math.sin(hp * Math.PI) * 0.35; break
      case "piledrive":
        ctx.fillRect(ox - 3, oy + 14, 14, 3); break
    }
  }

  // Model Collapse commits to the stunt: one full salto between the ledge and
  // its pile of cheaper selves. Keep the pad and the label upright; rotate the
  // original agent alone around the middle of its sprite.
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
    var sp = w.specialSpec
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

  // A degraded copy keeps the palette but loses fidelity generation by
  // generation. Missing pixels and displaced fragments read more clearly at
  // this scale than simply tinting it a different colour.
  if (ag.modelGen > 0) {
    ctx.globalAlpha = Math.max(0.42, 1 - ag.modelGen * 0.16)
    ctx.fillStyle = hair
    for (var mg = 0; mg < ag.modelGen + 1; mg++)
      ctx.fillRect(ox - 2 + ((ag.id + mg * 5) % 13), oy + ((ag.anim + mg * 7) % 16), 1, 1)
  }

  if (st === "limited") {
    // Two hard bars and a shrinking quota pip: unmistakably stopped, without
    // making the held agent look dead or blocked forever.
    ctx.fillStyle = pal.warn
    ctx.fillRect(ox - 2, oy + 3, 2, 11)
    ctx.fillRect(ox + SPRITE_W, oy + 3, 2, 11)
    ctx.fillRect(ox - 2, oy + 3, SPRITE_W + 4, 1)
    ctx.fillStyle = pal.label
    ctx.fillRect(ox - 1, oy, Math.max(1, Math.min(10, Math.ceil(ag.limitedFor / 8))), 2)
  }

  if (st === "stunned") {
    ctx.fillStyle = pal.warn
    ctx.fillRect(ox + 1 + ((ag.stunFor >> 2) % 6), oy - 3, 2, 2)
    ctx.fillRect(ox + 6 - ((ag.stunFor >> 3) % 5), oy - 6, 1, 1)
  }

  if (ag.special && w.specialSpec && w.specialSpec.act === "complete" && ag.shotFor > 0) {
    ctx.fillStyle = hair
    var cursorX = Math.round(ag.specialX * C)
    var cursorY = Math.round((ag.specialY + 1) * C) - 8
    ctx.fillRect(cursorX, cursorY, 2, 9)
    for (var trail = 0; trail < 4; trail++)
      ctx.fillRect(cursorX - dir * (trail * 5 + 3), cursorY + 10, 3, 1)
  }

  // The crawler's web stays fixed to the roof while the sprite descends. Draw
  // it behind the body so the raised hand appears to be holding the line.
  if (st === "rappel") {
    ctx.fillStyle = ag.special ? hair : pal.umbrellaStem
    var ropeX = Math.round(ag.x * C)
    var ropeTop = Math.round((ag.ropeY + 1) * C)
    var ropeBottom = oy + 7
    ctx.fillRect(ropeX, ropeTop, 1, Math.max(1, ropeBottom - ropeTop))
  }


  if (st === "webup") {
    ctx.fillStyle = ag.special ? hair : pal.umbrellaStem
    var webAnchorX = Math.round(ag.specialX * C)
    var webAnchorY = Math.round((ag.specialY + 1) * C)
    var webHandX = Math.round(ag.x * C)
    var webHandY = oy + 5
    var webSteps = Math.max(1, Math.round(Math.max(Math.abs(webAnchorX - webHandX), Math.abs(webAnchorY - webHandY))))
    for (var ws = 0; ws <= webSteps; ws++)
      ctx.fillRect(Math.round(webHandX + (webAnchorX - webHandX) * ws / webSteps),
                   Math.round(webHandY + (webAnchorY - webHandY) * ws / webSteps), 1, 1)
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

  // Ada Blocker's plate. Drawn in front of the body on the side it is facing,
  // tall enough to cover an agent standing behind it, with the lee it protects
  // marked by a faint bar along the floor — otherwise the one thing the shield
  // does for everybody else is invisible, and looks like an agent carrying a
  // door for its own reasons.
  if (ag.shieldFor > 0) {
    var plateX = dir > 0 ? ox + SPRITE_W + 1 : ox - 4
    var tired = ag.shieldHeld > 260
    ctx.fillStyle = hair
    ctx.fillRect(plateX, oy + 1, 3, SPRITE_PX - 2)
    ctx.fillStyle = robe
    ctx.fillRect(plateX + (dir > 0 ? 0 : 2), oy + 2, 1, SPRITE_PX - 4)
    // Boss in the middle, and an arm behind it.
    ctx.fillStyle = hair
    ctx.fillRect(plateX - dir * 1, oy + 7, 2, 3)
    ctx.fillStyle = skin
    ctx.fillRect(dir > 0 ? ox + SPRITE_W - 1 : ox - 1, oy + 8, 2, 2)

    // The cover itself, faint, along the ground behind it.
    ctx.globalAlpha = tired ? 0.10 : 0.20
    ctx.fillStyle = hair
    ctx.fillRect(dir > 0 ? ox - 4 * C : ox + SPRITE_W, oy + SPRITE_PX - 1, 4 * C, 2)
    ctx.globalAlpha = 1

    // Arms giving out: the plate starts to shake before it comes down, so a
    // drop in cover is something you can see coming rather than something that
    // simply happens to whoever was behind it.
    if (tired && (ag.anim >> 1) % 2 === 0) {
      ctx.fillStyle = pal.warn
      ctx.fillRect(plateX, oy + 1 + ((ag.anim >> 2) % 3), 3, 1)
    }
  }

  // Something stopped on the plate: a hard spark at the point of impact, and
  // three shards coming off it. This is the only feedback that the shield did
  // anything at all, so it is deliberately louder than the plate itself.
  if (ag.blockFor > 0) {
    var sparkX = dir > 0 ? ox + SPRITE_W + 3 : ox - 6
    ctx.globalAlpha = Math.min(1, ag.blockFor / 6)
    ctx.fillStyle = pal.fireHot
    ctx.fillRect(sparkX, oy + 6, 4, 4)
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(sparkX + 1, oy + 7, 2, 2)
    ctx.fillStyle = hair
    for (var shard = 0; shard < 3; shard++)
      ctx.fillRect(sparkX + dir * (3 + shard * 3), oy + 3 + shard * 4 - (10 - ag.blockFor), 2, 1)
    ctx.globalAlpha = 1
  }

  // The trick: a flash of whatever it is doing, thrown out in front. Each act
  // gets its own shape for the same reason each danger does — a special you
  // cannot tell from the last one is the same special.
  drawAgentTrick(ctx, w, pal, ag, ox, oy, dir, robe, hair)
  if (st === "camp" && ag.shotFor > 0 && ag.special) {
    var csp = w.specialSpec
    ctx.globalAlpha = Math.min(1, ag.shotFor / 6)
    ctx.fillStyle = csp ? csp.hair : pal.fireHot
    var sx0 = ox + (dir > 0 ? SPRITE_W : 0)
    var sy0 = oy + 9
    var ex0 = ag.shotTo * C
    var ey0 = ag.shotY * C
    var steps2 = Math.max(1, Math.round(Math.abs(ex0 - sx0) / 3))
    for (var q2 = 0; q2 <= steps2; q2++)
      ctx.fillRect(Math.round(sx0 + (ex0 - sx0) * q2 / steps2),
                   Math.round(sy0 + (ey0 - sy0) * q2 / steps2), 2, 1)
    ctx.globalAlpha = 1
  }

  // No special borrows the colony's umbrella. At a lethal height each carries
  // a device with its own silhouette; the movement is deliberately readable
  // at panel scale before the label has to explain it.
  drawAgentHeightGear(ctx, w, pal, ag, ox, oy, dir, robe, hair)
  var heightBodySaved = st === "height" && (ag.heightMode === "cushion" || ag.heightMode === "helicopter")
  if (heightBodySaved) {
    ctx.save()
    if (ag.heightMode === "cushion") {
      var salto = ag.heightTicks ? Math.max(0, (ag.heightTick / ag.heightTicks - 0.18) / 0.82) : 0
      ctx.translate(ox + SPRITE_W / 2, oy + SPRITE_PX / 2)
      ctx.rotate(Math.min(1, salto) * Math.PI * 2)
      ctx.translate(-ox - SPRITE_W / 2, -oy - SPRITE_PX / 2)
    } else {
      // The cabin drawn above replaces the ordinary body completely.
      ctx.globalAlpha = 0
    }
  }

  // Upside down: the whole sprite is mirrored vertically, so the one that
  // walks on ceilings reads as hanging rather than as floating.
  spriteFlip = (st === "ceil")

  var bodyDrop = st === "slide" ? 4 : ((st === "dig" || st === "camp") ? 2 : 0)

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

  } else if (st === "fall" || st === "height") {
    blit(ctx, ox, oy, dir, 1, 7, 6, 6)
    blit(ctx, ox, oy, dir, 0, 4, 2, 4)
    blit(ctx, ox, oy, dir, 6, 4, 2, 4)
    blit(ctx, ox, oy, dir, 2, 13, 2, 3)
    blit(ctx, ox, oy, dir, 4, 13, 2, 3)

  } else if (st === "rappel") {
    blit(ctx, ox, oy, dir, 1, 7, 6, 6)
    blit(ctx, ox, oy, dir, 3, 3, 2, 5)             // hand on the web
    blit(ctx, ox, oy, dir, 1, 12, 3, 2)            // feet braced apart
    blit(ctx, ox, oy, dir, 5, 13, 3, 2)

  } else if (st === "webup") {
    blit(ctx, ox, oy, dir, 1, 7, 6, 6)
    blit(ctx, ox, oy, dir, 3, 2, 2, 7)              // both hands on the web
    blit(ctx, ox, oy, dir, 0, 12, 3, 2)             // legs trailing in the swing
    blit(ctx, ox, oy, dir, 5, 14, 3, 2)

  } else if (st === "slide") {
    // Coat, tucked knees and one hand forward: a compact two-cell silhouette
    // that straightens immediately when the roof clears.
    blit(ctx, ox, oy, dir, 1, 8 + bodyDrop, 7, 4)
    blit(ctx, ox, oy, dir, 7, 9 + bodyDrop, 3, 2)
    blit(ctx, ox, oy, dir, 0, 12 + bodyDrop, 4, 2)

  } else if (st === "stunned") {
    blit(ctx, ox, oy, dir, 0, 9, 7, 4)
    blit(ctx, ox, oy, dir, 1, 13, 3, 2)
    blit(ctx, ox, oy, dir, 5, 13, 3, 2)

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

  } else if (st === "bash") {
    blit(ctx, ox, oy, dir, 1, 7 + bodyDrop, 6, 6)
    var swing = (ag.timer % 6) < 3 ? 0 : 2
    blit(ctx, ox, oy, dir, 6, 8 + swing, 4, 2)
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
    var psp = w.specialSpec
    ctx.fillStyle = psp ? psp.hair : pal.label
    blit(ctx, ox, oy, dir, 1, 5 + bodyDrop, 2, 2)
  }

  if (ag.wounds > 0 && st !== "saved") {
    ctx.fillStyle = pal.blood
    blit(ctx, ox, oy, dir, 5, 8, 2, 3)
  }

  if (heightBodySaved) ctx.restore()

  // --- optional label ----------------------------------------------------
  // What it's doing when it's doing something, and who it is the rest of the
  // time. The trait is the more interesting half: watching two agents reach
  // the same ledge and disagree about it only reads as personality once you
  // can see which one is the cautious one.
  if (opts && opts.labels && st !== "saved") {
    // An agent in somebody's lee is doing something no pose can show: walking
    // through ground it would otherwise have turned round at. A special keeps
    // its name — it is the one holding the plate, and the name says so.
    var action = ag.coveredFor > 0 && !ag.special ? "covered" : actionLabel(st)
    // A special is named rather than described. Its personality never comes up
    // — it cannot use the toolbar, so the choices a trait would colour are not
    // choices it gets to make — and the name is the useful thing to know.
    var nsp = ag.special ? w.specialSpec : null
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
  if (st === "dig") return "dig"
  if (st === "block") return "block"
  if (st === "bomb") return "bomb"
  if (st === "jump") return "hop"
  if (st === "ceil") return "ceiling"
  if (st === "rappel") return "rappel"
  if (st === "height") return "height move"
  if (st === "webup") return "web climb"
  if (st === "stunned") return "wounded"
  if (st === "limited") return "rate limited"
  if (st === "trick") return "!"
  if (st === "camp") return "camped"
  return ""
}
