import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui
import qs.Commons
import "Sim.js" as Sim
import "Draw.js" as Draw

// Lemmings, but nobody is playing. A level is carved out of solid earth, a
// hatch opens, and twenty small creatures with green hair have to work out for
// themselves how to get from there to the exit — bashing through what's in the
// way, bridging what isn't there, climbing what's too tall, and putting up an
// umbrella when the drop is too far. You just watch. That's the whole thing.
//
// It lives in the bar next to Snake for the same reason Snake does: the build
// is compiling, the agent is still thinking, and staring at a progress bar is
// worse for you than staring at this.
//
// The three files split cleanly and none of them reaches into another's job:
//
//   Sim.js    terrain, level generation, and the brain. Pure JS, no colors.
//   Draw.js   pixels. Never mutates the world.
//   Panel.qml this: bar button, panel chrome, the clock that drives the sim,
//             the theme-derived palette, and what persists between sessions.
//
// The lemmings are genuinely not told the route. Each one senses only the
// terrain within a couple of body-lengths — is there a wall, how thick, how
// tall, is there floor ahead, how far down, is there anything to land on — and
// picks the cheapest tool that fits (see decide-time helpers in Sim.js). The
// only thing they know that isn't local is roughly which way the exit lies,
// which breaks ties after a landing and nothing else. Level generation is
// constrained to shapes those rules can answer, and a `director` in Sim.js
// tops up a skill if a level genuinely stalls, so watching this never turns
// into watching something fail.
Panel {
  id: root
  moduleName: "jhgundersen.lemmings"
  ipcTarget: "jhgundersen.lemmings"

  readonly property int boardWidth: Sim.WIDTH
  readonly property int boardHeight: Sim.HEIGHT

  // The live world, mutated in place by Sim.step(). Deliberately NOT something
  // bindings read every frame: QML would re-evaluate half the panel thirty
  // times a second for a handful of numbers. The canvases are repainted by
  // hand and `stats` below carries the few values the chrome actually shows.
  property var world: null
  property var stats: ({ level: 1, biome: "", saved: 0, out: 0, total: 0, lost: 0, active: 0, skills: {}, used: {}, done: false })

  property int level: 1
  property bool running: false
  property bool showLabels: false
  property int speedIndex: 1
  readonly property var speedNames: ["Calm", "Steady", "Brisk"]
  readonly property var speedIntervals: [45, 33, 22]
  readonly property int tickInterval: speedIntervals[speedIndex % speedIntervals.length]

  property int lifetimeSaved: 0
  property int levelsCleared: 0
  property int totalSeconds: 0
  property bool stateLoaded: false

  property string completionLine: ""

  // Calm on purpose. Snake's game-over lines needle you; there is nothing to
  // lose here, so these just note what happened and get out of the way.
  readonly property var completionLines: [
    "Everyone home. The earth will keep.",
    "All accounted for. Nobody had to be told twice.",
    "They worked it out. They usually do.",
    "Home, every one. The tunnels stay behind.",
    "A tidy job. Not a brick wasted.",
    "That one took some digging.",
    "The long way round, but they got there.",
    "Umbrellas up, and down they went.",
    "Somebody had to stand still so the rest could pass.",
    "No plan, no map, no fuss."
  ]
  readonly property var partialLines: [
    "Most of them made it. That's how it goes.",
    "A few stayed behind in the rock.",
    "Not everyone finds the way out.",
    "Some tunnels only go one direction.",
    "The ones who made it made it."
  ]

  // ---------------------------------------------------------------------
  // Palette
  //
  // Earth, sky and portal are mixed from the active theme so the board never
  // fights the rest of the desktop, with each biome pulling toward a different
  // theme tone. The lemmings are the exception: green hair, blue robe, fixed.
  // Theme-tinting them would make them read as animated debris rather than as
  // the thing everybody recognizes.
  // ---------------------------------------------------------------------

  readonly property color themeForeground: bar ? bar.foreground : Color.foreground

  function mix(a, b, t) {
    return Qt.rgba(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t, 1)
  }

  // Canvas gradients want CSS strings, and passing QML color values straight
  // into addColorStop is the kind of thing that works until a theme has an
  // alpha channel. Convert once, here.
  function css(c, alpha) {
    var a = alpha === undefined ? c.a : alpha
    return "rgba(" + Math.round(c.r * 255) + "," + Math.round(c.g * 255) + "," + Math.round(c.b * 255) + "," + a + ")"
  }

  readonly property var biomeTints: [
    Color.accent,                        // Cavern
    Color.urgent,                        // Ruins
    Qt.lighter(Color.accent, 1.7),       // Frost
    Color.muted                          // Foundry
  ]

  readonly property var palette: {
    var bg = Color.background
    var fg = root.themeForeground
    var tint = biomeTints[(root.level - 1) % biomeTints.length]

    return {
      // The carved-out space has to read as clearly empty and the earth as
      // clearly solid, or the whole board turns into one dark slab with a few
      // lemmings on it — which is what a gentler set of these looked like.
      // Corridors are the darkest thing on the board; every material sits well
      // above them, and the lit top edge well above that again.
      skyTop: css(mix(bg, tint, 0.02)),
      skyLow: css(mix(bg, tint, 0.10)),

      // Dirt carries the biome's tint; rock is deliberately pulled off it
      // toward neutral. Shading both with the same hue made the whole board one
      // flat wash of colour in which the two materials were indistinguishable —
      // and the material tiers are the only thing telling you how deep you're
      // looking.
      dirt: css(mix(bg, tint, 0.46)),
      dirtEdge: css(mix(bg, tint, 0.86)),
      dirtShade: css(mix(bg, tint, 0.30)),
      rock: css(mix(bg, fg, 0.19)),
      rockEdge: css(mix(bg, fg, 0.38)),
      rockShade: css(mix(bg, fg, 0.12)),
      steel: css(mix(bg, fg, 0.34)),
      steelEdge: css(mix(bg, fg, 0.72)),
      steelShade: css(mix(bg, fg, 0.22)),

      // Just enough to say "deeper", not enough to grey the lower half out.
      washTop: css(bg, 0.0),
      washLow: css(bg, 0.18),

      exitDeep: css(mix(bg, Color.accent, 0.35)),
      exitGlow: css(mix(bg, Color.accent, 0.95)),
      exitLight: css(Qt.lighter(Color.accent, 1.4)),
      exitFrame: css(mix(bg, fg, 0.55)),

      hatchBody: css(mix(bg, fg, 0.42)),
      hatchLip: css(mix(bg, Color.accent, 0.8)),
      hatchMouth: css(bg),

      dust: css(mix(bg, fg, 0.7)),
      label: css(mix(bg, fg, 0.85)),
      // Personality names sit behind action names: with labels on, every
      // lemming carries one, so at full strength the board is a wall of text.
      labelFaint: css(mix(bg, fg, 0.45)),
      urgent: css(Color.urgent),

      // The one deliberately un-themed corner of the board.
      hair: "#00b04a",
      robe: "#3a5cd8",
      skin: "#f0c8a0",
      eye: "#101014",
      umbrella: "#e8582c",
      umbrellaStem: "#f0c8a0"
    }
  }

  // ---------------------------------------------------------------------
  // Level lifecycle
  // ---------------------------------------------------------------------

  function newLevel(n) {
    level = Math.max(1, n)
    world = Sim.generate(level)
    completionLine = ""
    publish()
    terrainCanvas.requestPaint()
    actorCanvas.requestPaint()
  }

  function advance(delta) {
    newLevel(level + delta)
    saveState()
  }

  function publish() {
    if (!world) return
    stats = {
      level: world.level,
      biome: world.biome,
      saved: world.saved,
      out: world.released,
      total: world.toRelease,
      lost: world.lost,
      active: world.active || 0,
      done: world.done,
      ticks: world.ticks,
      skills: world.skills,
      used: world.lastUsed
    }
  }

  property int lastTerrainVersion: 0

  function tick() {
    if (!world) return
    Sim.step(world)

    if (world.terrainVersion !== lastTerrainVersion) {
      lastTerrainVersion = world.terrainVersion
      terrainCanvas.requestPaint()
    }
    actorCanvas.requestPaint()
    publish()

    if (world.done && completionLine === "") {
      var pool = world.saved >= world.toRelease ? completionLines : partialLines
      completionLine = pool[Math.floor(Math.random() * pool.length)]
      lifetimeSaved += world.saved
      if (world.saved > 0) levelsCleared += 1
      saveState()
    }

    // A pause on the finished level long enough to read the result, then the
    // next one carves itself. The loop is the point: this is meant to be left
    // open in the corner of a screen.
    if (world.done && world.doneTicks > 110) advance(1)
  }

  function togglePause() { running = !running }

  function cycleSpeed() {
    speedIndex = (speedIndex + 1) % speedIntervals.length
    saveState()
  }

  function toggleLabels() {
    showLabels = !showLabels
    actorCanvas.requestPaint()
    saveState()
  }

  // ---------------------------------------------------------------------
  // Persistence — same shape and same merge-against-disk discipline as the
  // Snake plugin next door, under this plugin's own state directory so two
  // third-party plugins can never land on each other's file.
  // ---------------------------------------------------------------------

  readonly property string stateDir: Quickshell.env("HOME") + "/.local/state/omarchy/plugins/" + root.moduleName + "/"
  readonly property string statePath: stateDir + "state.json"

  // Last snapshot known to be on disk. Every save merges against this rather
  // than against live values alone, so an instance on a second monitor can't
  // roll back a number this one already wrote.
  property var diskState: null

  function extractState(parsed) {
    var d = parsed || {}
    return {
      level: typeof d.level === "number" ? Math.max(1, Math.floor(d.level)) : 1,
      lifetimeSaved: typeof d.lifetimeSaved === "number" ? d.lifetimeSaved : 0,
      levelsCleared: typeof d.levelsCleared === "number" ? d.levelsCleared : 0,
      totalSeconds: typeof d.totalSeconds === "number" ? d.totalSeconds : 0,
      speedIndex: typeof d.speedIndex === "number" ? Math.floor(d.speedIndex) : 1,
      showLabels: d.showLabels === true
    }
  }

  function recordDiskState(raw) {
    var parsed = null
    try { parsed = JSON.parse(raw) } catch (e) { parsed = null }
    diskState = extractState(parsed)
    // onLoaded can fire more than once during startup; only the first one may
    // seed live state, or a later reload could stomp a session in progress.
    if (stateLoaded) return
    if (diskState.lifetimeSaved > lifetimeSaved) lifetimeSaved = diskState.lifetimeSaved
    if (diskState.levelsCleared > levelsCleared) levelsCleared = diskState.levelsCleared
    if (diskState.totalSeconds > totalSeconds) totalSeconds = diskState.totalSeconds
    if (diskState.speedIndex >= 0 && diskState.speedIndex < speedIntervals.length)
      speedIndex = diskState.speedIndex
    showLabels = diskState.showLabels
    level = diskState.level
    stateLoaded = true
  }

  function saveState() {
    if (!stateLoaded) return
    var d = diskState || extractState(null)
    lifetimeSaved = Math.max(lifetimeSaved, d.lifetimeSaved)
    levelsCleared = Math.max(levelsCleared, d.levelsCleared)
    totalSeconds = Math.max(totalSeconds, d.totalSeconds)
    var payload = {
      version: 1,
      level: root.level,
      lifetimeSaved: root.lifetimeSaved,
      levelsCleared: root.levelsCleared,
      totalSeconds: root.totalSeconds,
      speedIndex: root.speedIndex,
      showLabels: root.showLabels
    }
    diskState = extractState(payload)
    stateFile.setText(JSON.stringify(payload, null, 2) + "\n")
  }

  Process {
    id: ensureStateDirProc
    command: ["mkdir", "-p", root.stateDir]
  }

  FileView {
    id: stateFile
    path: root.statePath
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.recordDiskState(text())
    // First run: no file yet. Without this, stateLoaded never flips and
    // saveState() is a permanent no-op.
    onLoadFailed: root.recordDiskState("")
  }

  Component.onCompleted: {
    ensureStateDirProc.running = true
    Qt.callLater(function () { stateFile.reload() })
  }

  onOpenedChanged: {
    if (opened) {
      if (!world) newLevel(level)
      else { terrainCanvas.requestPaint(); actorCanvas.requestPaint() }
      running = true
    } else {
      running = false
      saveState()
    }
  }

  // A theme swap changes every color the board is drawn from, and the terrain
  // layer only repaints when the earth moves — so it needs telling.
  onPaletteChanged: terrainCanvas.requestPaint()

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  Timer {
    interval: root.tickInterval
    repeat: true
    running: root.opened && root.running
    onTriggered: root.tick()
  }

  Timer {
    interval: 1000
    repeat: true
    running: root.opened && root.running
    onTriggered: root.totalSeconds += 1
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    // Nerd Font umbrella (nf-fa-umbrella). Written as an escape rather than
    // the literal glyph so the source survives any tooling that doesn't handle
    // private-use codepoints — pasted literally it can arrive as an empty
    // string, which renders as a bar slot with nothing in it.
    text: ""
    onPressed: root.toggle()
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(root.boardWidth + Style.space(24))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onActivateRequested: root.togglePause()
      onCloseRequested: root.close()
      onTabRequested: function (direction) { root.switchPanel(direction) }
      // Left/right step through levels; they're a pure function of the level
      // number, so going back always finds the same one again.
      onMoveRequested: function (dx, dy) { if (dx !== 0) root.advance(dx) }
      onTextKey: function (t) {
        var k = t.toLowerCase()
        if (k === "n") root.advance(1)
        else if (k === "p") root.advance(-1)
        else if (k === "r") root.newLevel(root.level)
        else if (k === "s") root.cycleSpeed()
        else if (k === "l") root.toggleLabels()
      }

      Column {
        id: column
        anchors.fill: parent
        spacing: Style.space(8)

        // --- header -----------------------------------------------------
        Item {
          width: parent.width
          implicitHeight: title.implicitHeight

          Text {
            id: title
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: "Level " + root.stats.level + "  ·  " + root.stats.biome
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.title
            font.bold: true
          }

          Text {
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: "Home " + root.stats.saved + "/" + root.stats.total
                  + (root.stats.lost > 0 ? "  ·  Lost " + root.stats.lost : "")
            color: Qt.darker(root.bar.foreground, 1.4)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
          }
        }

        // --- how many are home ------------------------------------------
        Item {
          width: parent.width
          height: Style.space(6)

          Rectangle {
            width: parent.width
            height: Style.space(5)
            radius: height / 2
            anchors.verticalCenter: parent.verticalCenter
            color: Qt.darker(root.bar.foreground, 3.5)

            Rectangle {
              width: parent.width * (root.stats.total > 0 ? root.stats.saved / root.stats.total : 0)
              height: parent.height
              radius: height / 2
              color: Color.accent

              Behavior on width {
                NumberAnimation { duration: 220; easing.type: Easing.OutCubic }
              }
            }
          }
        }

        // --- the board ---------------------------------------------------
        Rectangle {
          id: board
          width: root.boardWidth
          height: root.boardHeight
          anchors.horizontalCenter: parent.horizontalCenter
          color: Color.background
          border.color: Qt.darker(root.bar.foreground, 2.2)
          border.width: 1
          radius: Style.cornerRadius > 0 ? 4 : 0
          clip: true

          // Terrain repaints only when a lemming actually removes or lays a
          // cell; the actors repaint every tick. Splitting them is what makes
          // a boardful of diggers affordable.
          Canvas {
            id: terrainCanvas
            anchors.fill: parent
            onPaint: {
              if (!root.world) return
              Draw.drawTerrain(getContext("2d"), root.world, root.palette)
            }
          }

          Canvas {
            id: actorCanvas
            anchors.fill: parent
            onPaint: {
              if (!root.world) return
              Draw.drawActors(getContext("2d"), root.world, root.palette, { labels: root.showLabels })
            }
          }

          MouseArea {
            anchors.fill: parent
            onClicked: root.togglePause()
          }

          // Paused / finished wash. Kept low-contrast: this is an overlay on
          // something you're looking at to relax, not an alert.
          Rectangle {
            anchors.fill: parent
            visible: !root.running || root.stats.done
            color: Qt.rgba(0, 0, 0, 0.5)

            Column {
              anchors.centerIn: parent
              spacing: Style.space(4)

              Text {
                anchors.horizontalCenter: parent.horizontalCenter
                text: root.stats.done
                      ? (root.stats.saved + " of " + root.stats.total + " home")
                      : "PAUSED"
                color: "#ffffff"
                font.family: root.bar.fontFamily
                font.pixelSize: Style.font.heading
                font.bold: true
              }

              Text {
                anchors.horizontalCenter: parent.horizontalCenter
                visible: text !== ""
                text: root.stats.done ? root.completionLine : "Space or click to resume"
                color: "#ffffff"
                opacity: 0.75
                width: board.width - Style.space(40)
                horizontalAlignment: Text.AlignHCenter
                wrapMode: Text.WordWrap
                font.family: root.bar.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }
        }

        // --- the toolbar --------------------------------------------------
        // The original's eight skills in the original's order, showing what
        // this level was issued and what's left. Nothing here is clickable:
        // deciding is the lemmings' job, and the row is how you watch them
        // spend it.
        Row {
          anchors.horizontalCenter: parent.horizontalCenter
          spacing: Style.space(3)

          Repeater {
            model: Sim.SKILL_ORDER

            Rectangle {
              required property var modelData
              readonly property int count: root.stats.skills[modelData] || 0
              // Flashes for two thirds of a second after a lemming takes one,
              // so you can catch which skill just went out.
              readonly property bool recent: {
                var t = root.stats.used[modelData]
                return t !== undefined && (root.stats.ticks - t) < 20
              }

              width: Math.floor((root.boardWidth - Style.space(3) * 7) / 8)
              height: Style.space(30)
              radius: Style.cornerRadius > 0 ? 3 : 0
              color: recent ? Style.selectedFillFor(root.bar.foreground, Color.accent)
                            : Style.normalFillFor(root.bar.foreground, Color.accent)
              opacity: count > 0 || recent ? 1.0 : 0.35

              Behavior on color { ColorAnimation { duration: 140 } }

              Column {
                anchors.centerIn: parent
                spacing: 0

                Text {
                  anchors.horizontalCenter: parent.horizontalCenter
                  text: Sim.SKILL_LABELS[parent.parent.modelData]
                  color: parent.parent.recent ? Color.accent : Qt.darker(root.bar.foreground, 1.5)
                  font.family: root.bar.fontFamily
                  font.pixelSize: Style.font.caption
                }

                Text {
                  anchors.horizontalCenter: parent.horizontalCenter
                  text: parent.parent.count
                  color: root.bar.foreground
                  font.family: root.bar.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  font.bold: true
                }
              }
            }
          }
        }

        // --- hints --------------------------------------------------------
        Text {
          width: parent.width
          text: "Nobody is driving. Every one of them has its own mind."
          color: Qt.darker(root.bar.foreground, 1.6)
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.caption
          horizontalAlignment: Text.AlignHCenter
        }

        Row {
          anchors.horizontalCenter: parent.horizontalCenter
          spacing: Style.space(14)

          HintLabel {
            text: "speed(s): " + root.speedNames[root.speedIndex]
            onClicked: root.cycleSpeed()
          }
          HintLabel {
            text: "who(l): " + (root.showLabels ? "On" : "Off")
            onClicked: root.toggleLabels()
          }
          HintLabel {
            text: "level(←/→)"
            onClicked: root.advance(1)
          }
          HintLabel {
            text: "saved: " + root.lifetimeSaved
            onClicked: root.newLevel(root.level)
          }
        }
      }
    }
  }

  // Clickable status label for the bottom row, brightening on hover — the
  // same component and the same behavior as the Snake panel's, so the two
  // plugins feel like they came from the same hand.
  component HintLabel: Item {
    id: hintLabel
    required property string text
    signal clicked()

    implicitWidth: label.implicitWidth
    implicitHeight: label.implicitHeight

    Text {
      id: label
      text: hintLabel.text
      color: mouseArea.containsMouse ? root.bar.foreground : Qt.darker(root.bar.foreground, 1.6)
      font.family: root.bar.fontFamily
      font.pixelSize: Style.font.caption

      Behavior on color { ColorAnimation { duration: 100 } }
    }

    MouseArea {
      id: mouseArea
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: hintLabel.clicked()
    }
  }
}
