
function mix(a, b, t) {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t }
}

// Qt.lighter's rule, reimplemented so the web matches the plugin exactly:
// convert to HSV, scale the value by the factor, convert back.
//
// The part worth copying carefully is the overflow. Qt does not simply clamp a
// value past maximum — it takes the excess out of the *saturation*, so a color
// that is already bright goes on toward white instead of stopping dead at its
// own hue. The Frost biome lightens the accent by 1.7, which overflows on most
// themes, so clamping instead would leave the web version a visibly more
// saturated blue than the bar plugin on exactly the levels you'd compare.
function lighter(c, f) {
  var max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b)
  var v = max, d = max - min
  var s = max === 0 ? 0 : d / max

  var h = 0
  if (d !== 0) {
    if (max === c.r) h = ((c.g - c.b) / d + (c.g < c.b ? 6 : 0)) / 6
    else if (max === c.g) h = ((c.b - c.r) / d + 2) / 6
    else h = ((c.r - c.g) / d + 4) / 6
  }

  v = v * f
  if (v > 1) { s = Math.max(0, s - (v - 1)); v = 1 }

  var i = Math.floor(h * 6), fr = h * 6 - i
  var p = v * (1 - s), q = v * (1 - fr * s), t = v * (1 - (1 - fr) * s)
  switch (i % 6) {
    case 0: return { r: v, g: t, b: p }
    case 1: return { r: q, g: v, b: p }
    case 2: return { r: p, g: v, b: t }
    case 3: return { r: p, g: q, b: v }
    case 4: return { r: t, g: p, b: v }
    default: return { r: v, g: p, b: q }
  }
}

// Canvas gradients want CSS strings, and passing a color object straight into
// addColorStop is the kind of thing that works until something has an alpha
// channel. Convert once, here.
function css(c, alpha) {
  var a = alpha === undefined ? (c.a === undefined ? 1 : c.a) : alpha
  return "rgba(" + Math.round(c.r * 255) + "," + Math.round(c.g * 255) + "," +
         Math.round(c.b * 255) + "," + a + ")"
}

// #rrggbb -> {r, g, b}, so the web side can write a theme as hex.
function hex(s) {
  var n = parseInt(s.replace("#", ""), 16)
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }
}

function toward(c, hue, t) { return mix(c, hue, t) }

var JUNGLE = { r: 0.24, g: 0.52, b: 0.20 }
var GLACIER = { r: 0.55, g: 0.78, b: 0.92 }
var HULL = { r: 0.46, g: 0.52, b: 0.60 }

// Copper rather than the yellower brass it started as: redder, and further
// from the Ruins' urgent red only because that biome is pink-red where this
// one is orange-brown. Steampunk lives in the warm half of the wheel.
var BRASS = { r: 0.80, g: 0.46, b: 0.14 }

var WATER = { r: 0.13, g: 0.42, b: 0.52 }
var LAVA = { r: 0.88, g: 0.26, b: 0.06 }
var COOLANT = { r: 0.20, g: 0.80, b: 0.76 }
// Not a colour anything is: near-black with a green-violet bias, so the sheen
// drawn on top of it reads as a film on the surface rather than as the depth.
var OIL = { r: 0.10, g: 0.12, b: 0.09 }
var VOID = { r: 0, g: 0, b: 0 }

// Which one this level's biome floods with. Sim.js decides the same thing from
// the biome name and the two must agree — they are derived from the same level
// number by the same rule, which is how every other per-biome difference in
// this game stays in step across two files that cannot call each other.
function poolTint(level) {
  switch ((level - 1) % 8) {
    case 1: return WATER      // Ruins: a flooded cistern
    case 3: return LAVA       // Foundry: what the place is for
    case 4: return WATER      // Jungle: the swamp, and what lives in it
    case 6: return COOLANT    // Spaceship: something leaking
    case 7: return OIL        // Factory: what has been draining out for years
    default: return WATER     // dry biomes; unused, but never undefined
  }
}

function biomeTint(theme, level) {
  switch ((level - 1) % 8) {
    case 0: return theme.accent                              // Cavern
    case 1: return theme.urgent                              // Ruins
    case 2: return lighter(theme.accent, 1.7)                // Frost
    case 3: return theme.muted                               // Foundry
    case 4: return toward(theme.accent, JUNGLE, 0.72)        // Jungle
    case 5: return toward(lighter(theme.accent, 1.4), GLACIER, 0.66)  // Ice Cave
    case 6: return toward(theme.muted, HULL, 0.6)            // Spaceship
    // Factory has to sit apart from both of the other industrial biomes: the
    // Foundry is the theme's own muted grey and the Spaceship is pulled toward
    // hull, so this one goes warm. Brass and old machine paint, not heat.
    default: return toward(theme.accent, BRASS, 0.88)        // Factory
  }
}

// theme: {background, foreground, accent, urgent, muted} as {r, g, b} 0..1.
function build(theme, level) {
  var bg = theme.background
  var fg = theme.foreground
  var tint = biomeTint(theme, level)
  var pool = poolTint(level)

  return {
    skyTop: css(mix(bg, tint, 0.02)),
    skyLow: css(mix(bg, tint, 0.10)),

    dirt: css(mix(bg, tint, 0.46)),
    dirtEdge: css(mix(bg, tint, 0.86)),
    dirtShade: css(mix(bg, tint, 0.30)),
    // Ore is the one material pulled off both of the others: brighter than
    // dirt and warmer than rock, because it appears as thin seams and a seam
    // that doesn't separate from what it runs through isn't a seam.
    ore: css(mix(mix(bg, tint, 0.58), fg, 0.22)),
    oreEdge: css(mix(mix(bg, tint, 0.95), fg, 0.30)),
    oreShade: css(mix(mix(bg, tint, 0.40), fg, 0.14)),
    rock: css(mix(bg, fg, 0.19)),
    rockEdge: css(mix(bg, fg, 0.38)),
    rockShade: css(mix(bg, fg, 0.12)),
    steel: css(mix(bg, fg, 0.34)),
    steelEdge: css(mix(bg, fg, 0.72)),
    steelShade: css(mix(bg, fg, 0.22)),

    // Just enough to say "deeper", not enough to grey the lower half out.
    washTop: css(bg, 0.0),
    washLow: css(bg, 0.18),

    exitDeep: css(mix(bg, theme.accent, 0.35)),
    exitGlow: css(mix(bg, theme.accent, 0.95)),
    exitLight: css(lighter(theme.accent, 1.4)),
    exitFrame: css(mix(bg, fg, 0.55)),

    hatchBody: css(mix(bg, fg, 0.42)),
    hatchLip: css(mix(bg, theme.accent, 0.8)),
    hatchMouth: css(bg),

    // Decor sits a little above the earth it stands on, so a stalagmite reads
    // as a thing in the room rather than as a bump in the floor, but stays
    // well under the agents — it is scenery and must never compete with them.
    decor: css(mix(mix(bg, tint, 0.52), fg, 0.18)),
    decorLit: css(mix(mix(bg, tint, 0.80), fg, 0.34)),
    decorDim: css(mix(bg, tint, 0.34)),

    rig: css(mix(bg, fg, 0.52)),
    rigDark: css(mix(bg, fg, 0.30)),
    warn: css(mix(bg, theme.urgent, 0.55)),
    fire: css(theme.urgent),
    fireHot: css(lighter(theme.urgent, 1.45)),
    blood: "#b3121b",

    cardBack: css(mix(bg, fg, 0.10)),

    // The inside of a hole with nothing at the bottom of it. The corridors are
    // already the darkest thing on the board, so "deeper than a corridor" cannot
    // come from the earth palette at all — it fades toward black instead, and
    // the top of the fade is transparent so the lip is not a drawn line.
    pitLip: css(VOID, 0.0),
    pitDeep: css(VOID, 0.62),

    poolBody: css(mix(bg, pool, 0.62)),
    poolDeep: css(mix(bg, mix(pool, VOID, 0.7), 0.75)),
    poolLip: css(mix(bg, lighter(pool, 1.45), 0.92)),
    poolGlint: css(mix(lighter(pool, 1.7), fg, 0.35)),

    dust: css(mix(bg, fg, 0.7)),
    label: css(mix(bg, fg, 0.85)),
    // Personality names sit behind action names: with labels on, every agent
    // carries one, so at full strength the board is a wall of text.
    labelFaint: css(mix(bg, fg, 0.45)),
    urgent: css(theme.urgent),

    // The one deliberately un-themed corner of the board.
    //
    // They started as Lemmings, which is where the green hair and blue robe
    // came from, and the joke has moved on: they are agents now. So they are
    // dressed as agents — dark suit, white shirt, shades.
    //
    // The suit is charcoal rather than black on purpose. Every biome on this
    // board is dark, and a genuinely black suit is an agent you cannot see;
    // what carries the silhouette instead is the pale face above the collar
    // and the white shirt under it, with the suit as the mass between them.
    hair: "#2b2d38",
    robe: "#3d4356",
    lapel: "#6b7488",
    skin: "#f0c8a0",
    eye: "#0a0a0e",
    shirt: "#e9edf7",
    lens: "#6f7688",
    // Black, now they are dressed for it. Same lesson as the suit: dark on a
    // dark board has to bring its own edge, so what you actually read is the
    // lit rim and the canopy is the mass hanging under it.
    umbrella: "#333947",

    // Everybody's suit is the same; the umbrella is the one thing that is
    // theirs. Deep colours rather than bright ones, so a sky full of floaters
    // still reads as a company of agents and not a bag of sweets — and plain
    // charcoal appears twice, the same way steady is common in the trait pool,
    // so the varied ones stay worth noticing.
    umbrellas: [
      "#333947",   // charcoal
      "#6e2230",   // ox blood
      "#26503a",   // forest
      "#333947",   // charcoal
      "#2f3c72",   // navy
      "#5a2a5e",   // plum
      "#1f5158",   // teal
      "#6b4a1c"    // tobacco
    ],
    // The rim is brighter than the canopy needs to be pretty, because who has
    // an umbrella out is information: it says that one is not going to die of
    // this fall. The old orange announced it from across the board; a black
    // umbrella has to say the same thing with an edge.
    umbrellaRim: "#a8b2c8",
    umbrellaStem: "#9aa2b4"
  }
}
