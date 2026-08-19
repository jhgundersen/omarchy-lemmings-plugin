import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui
import qs.Commons
import "Sim.js" as Sim
import "Draw.js" as Draw
import "Palette.js" as Palette
import "Outcome.js" as Outcome

// Lemmings, but nobody is playing. A level is carved out of solid earth, a
// hatch opens, and a dozen-odd small creatures with green hair have to work out
// for themselves how to get from there to the exit — bashing through what's in
// the way, bridging what isn't there, climbing what's too tall, and putting up
// an umbrella when the drop is too far. You just watch. That's the whole thing.
//
// They're called agents because the joke writes itself: no supervisor, no plan
// beyond the next two body-lengths, enormous confidence, and a success rate of
// about two thirds. It lives in the bar next to Snake for the same reason Snake
// does — the build is compiling, the *other* agent is still thinking, and
// staring at a progress bar is worse for you than staring at this.
//
// The three files split cleanly and none of them reaches into another's job:
//
//   Sim.js    terrain, level generation, and the brain. Pure JS, no colors.
//   Draw.js   pixels. Never mutates the world.
//   Panel.qml this: bar button, panel chrome, the clock that drives the sim,
//             the theme-derived palette, and what persists between sessions.
//
// The agents are genuinely not told the route. Each one senses only the
// terrain within a couple of body-lengths — is there a wall, how thick, how
// tall, is there floor ahead, how far down, is there anything to land on — and
// picks the cheapest tool that fits (see decide-time helpers in Sim.js). The
// only thing they know that isn't local is whether home is on this floor,
// above, or below — no horizontal sense of it at all. Level generation is
// constrained to shapes those rules can answer, and a `director` in Sim.js
// tops up a skill if a level genuinely stalls, so watching this never turns
// into watching something fail.
Panel {
  id: root
  moduleName: "jhgundersen.oh-no-more-agents"
  ipcTarget: "jhgundersen.oh-no-more-agents"

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

  // Palette
  //
  // The mixing rules live in Palette.js, shared verbatim with the web version
  // so both render the same board from the same five theme colors. All this
  // end has to do is hand over the theme: Palette.js works in plain {r, g, b}
  // and knows nothing about QML, which is the only reason it can also be a
  // <script> tag on a web page.
  // ---------------------------------------------------------------------

  readonly property color themeForeground: bar ? bar.foreground : Color.foreground

  // A QML color already carries r/g/b as 0..1 floats, but it is a QColor and
  // not a plain object; Palette.js does arithmetic on the fields and hands the
  // results to a canvas, so it gets a plain one.
  function rgb(c) { return { r: c.r, g: c.g, b: c.b } }

  // Reading each Color.* inside the binding is what makes the whole palette
  // rebuild when the theme swaps, and root.level is what rotates the biome.
  readonly property var palette: Palette.build({
    background: rgb(Color.background),
    foreground: rgb(root.themeForeground),
    accent: rgb(Color.accent),
    urgent: rgb(Color.urgent),
    muted: rgb(Color.muted)
  }, root.level)

  // ---------------------------------------------------------------------
  // Level lifecycle
  // ---------------------------------------------------------------------

  function newLevel(n) {
    level = Math.max(1, n)
    world = Sim.generate(level, 0)
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
      nuking: world.nuking === true,
      secondsLeft: Math.max(0, Math.ceil((world.timeLimit - world.ticks) / 30)),
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
      completionLine = Outcome.outcomeLine(world)
      lifetimeSaved += world.saved
      if (world.saved > 0) levelsCleared += 1
      saveState()
    }

    // One colony, one story, then onward. A failed level no longer repeats with
    // a replacement cast before the loop is allowed to continue.
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
      // Arrows and hjkl both step through levels; they're a pure function of
      // the level number, so going back always finds the same one again.
      onMoveRequested: function (dx, dy) { if (dx !== 0) root.advance(dx) }
      // NB: h/j/k/l never reach here. PanelKeyCatcher reads them as vim
      // navigation, accepts the event and returns, so textKey is only emitted
      // for keys it doesn't already own — which is why the labels toggle sat
      // on `l` doing nothing while `l` quietly advanced the level instead.
      // Same goes for x/X, which it takes as delete.
      onTextKey: function (t) {
        var k = t.toLowerCase()
        if (k === "n") root.advance(1)
        else if (k === "p") root.advance(-1)
        else if (k === "r") root.newLevel(root.level)
        else if (k === "s") root.cycleSpeed()
        else if (k === "w") root.toggleLabels()
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
            // The clock only appears in the last thirty seconds. Running it the
            // whole way turns something you're watching to unwind into
            // something with a deadline, which is the opposite of the point —
            // but the nuke arriving out of a clear sky is worse.
            text: "Home " + root.stats.saved + "/" + root.stats.total
                  + (root.stats.lost > 0 ? "  ·  Lost " + root.stats.lost : "")
                  + (root.stats.nuking ? "  ·  NUKE"
                     : ((root.stats.secondsLeft !== undefined && root.stats.secondsLeft <= 30)
                        ? "  ·  " + root.stats.secondsLeft + "s" : ""))
            color: root.stats.nuking ? Color.urgent : Qt.darker(root.bar.foreground, 1.4)
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
              width: parent.width * (root.stats.total > 0
                                     ? Math.min(1, root.stats.saved / root.stats.total) : 0)
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

          // Terrain repaints only when an agent actually removes or lays a
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
        // deciding is the agents' job, and the row is how you watch them
        // spend it.
        Row {
          anchors.horizontalCenter: parent.horizontalCenter
          spacing: Style.space(3)

          Repeater {
            model: Sim.SKILL_ORDER

            Rectangle {
              required property var modelData
              readonly property int count: root.stats.skills[modelData] || 0
              // Flashes for two thirds of a second after an agent takes one,
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
            text: "who(w): " + (root.showLabels ? "On" : "Off")
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
