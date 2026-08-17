// Theme colors in, canvas colors out. Pure, and the third file the bar plugin
// and the web version share: given the same five inputs both render the same
// board, which is the only way the web version is worth developing against.
//
// It lived inside Panel.qml as QML bindings over `Color.*` until the web
// version needed the same mixing rules. Nothing here knows about QML or the
// DOM — inputs are {r, g, b} in 0..1 and outputs are CSS color strings, which
// is what a canvas 2D context wants in both places.
//
// Earth, sky and portal are all mixed from the theme so the board never fights
// whatever it sits on. The agents are the exception: green hair, blue robe,
// fixed. Theme-tinting them would make them read as animated debris rather
// than as the thing everybody recognizes.

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

// Which theme tone each biome pulls toward. Four biomes cycling with the level
// number is what stops a long watch looking like one level over and over.
function biomeTint(theme, level) {
  switch ((level - 1) % 4) {
    case 0: return theme.accent                  // Cavern
    case 1: return theme.urgent                  // Ruins
    case 2: return lighter(theme.accent, 1.7)    // Frost
    default: return theme.muted                  // Foundry
  }
}

// theme: {background, foreground, accent, urgent, muted} as {r, g, b} 0..1.
function build(theme, level) {
  var bg = theme.background
  var fg = theme.foreground
  var tint = biomeTint(theme, level)

  return {
    // The carved-out space has to read as clearly empty and the earth as
    // clearly solid, or the whole board turns into one dark slab with a few
    // agents on it — which is what a gentler set of these looked like.
    // Corridors are the darkest thing on the board; every material sits well
    // above them, and the lit top edge well above that again.
    skyTop: css(mix(bg, tint, 0.02)),
    skyLow: css(mix(bg, tint, 0.10)),

    // Dirt carries the biome's tint; rock is deliberately pulled off it toward
    // neutral. Shading both with the same hue made the whole board one flat
    // wash of colour in which the two materials were indistinguishable — and
    // the material tiers are the only thing telling you how deep you're looking.
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

    dust: css(mix(bg, fg, 0.7)),
    label: css(mix(bg, fg, 0.85)),
    // Personality names sit behind action names: with labels on, every agent
    // carries one, so at full strength the board is a wall of text.
    labelFaint: css(mix(bg, fg, 0.45)),
    urgent: css(theme.urgent),

    // The one deliberately un-themed corner of the board.
    hair: "#00b04a",
    robe: "#3a5cd8",
    skin: "#f0c8a0",
    eye: "#101014",
    umbrella: "#e8582c",
    umbrellaStem: "#f0c8a0"
  }
}
