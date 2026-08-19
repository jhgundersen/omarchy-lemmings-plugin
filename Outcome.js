// End-of-level copy shared by the browser and the Omarchy panel. Keeping the
// selection here means a new joke or event rule cannot quietly appear in only
// one host. This file reads the finished world but never mutates it.

var COMPLETION_LINES = [
  "Everyone home. The acceptance tests are suspiciously green.",
  "All agents accounted for. Even the edge cases.",
  "The colony has achieved warp factor: eventually.",
  "Perfect run. Please do not ask about the technical debt underground.",
  "They boldly went where several agents had just gone before.",
  "Achievement unlocked: distributed consensus without a network.",
  "No casualties. The redshirts would like this level reviewed.",
  "The exit returned HTTP 200 for everyone.",
  "All home. The simulation insists this was emergent behavior.",
  "Flawless victory, powered by tiny feet and questionable priorities."
]

var NUKED_LINES = [
  "Time. Everybody out, the hard way.", "The clock won that one.",
  "Out of time, and out of options.", "Some levels don't get solved.",
  "That's what the last skill is for.", "The SLA expired. So did everybody else.",
  "TimeoutError: colony did not converge.",
  "The final countdown was less Europe, more incident response.",
  "Game over. Insert coin, or just wait for the next level.",
  "The clock applied a hard deadline. Very enterprise."
]

var PARTIAL_LINES = [
  "Some made it home. The rest became legacy infrastructure.",
  "Partial success is still success in cloud billing.",
  "The exit scaled horizontally. The agents did not.",
  "A mixed result, like every sequel after the second one.",
  "The survivors have merged to main. The others had conflicts.",
  "Some tunnels only go one direction. Like production migrations.",
  "Enough got home to ship it on a Friday.",
  "The away team returned with fewer redshirts than it started.",
  "Not a wipeout, not a triumph: the cinematic middle chapter.",
  "The colony calls this eventual consistency."
]

var EVENT_LINES = {
  ai: [
    "The AI produced a confident route with no supporting evidence.",
    "Hallucination detected: the floor was not actually there.",
    "The agents requested more context. They received more rocks.",
    "Artificial intelligence met natural consequences.",
    "The model reasoned for 30 seconds and selected walking left.",
    "The benchmark says superhuman. The pit says otherwise.",
    "No training data was harmed. The agents were less fortunate.",
    "The chain of thought led directly into a wall.",
    "They aligned on a plan. It was the wrong plan, but beautifully aligned.",
    "The AI safety team recommends adding a railing.",
    "The colony passed the vibe check and failed navigation.",
    "A larger model would have fallen into a larger pit.",
    "The agents generated a bridge with several factual inaccuracies.",
    "Human feedback was unavailable. Human laughter was not.",
    "The neural network had many layers. The level had more.",
    "They asked the cloud for guidance. It sent an umbrella.",
    "Autonomy achieved. Accountability remains in beta.",
    "The AI explained the failure clearly after causing it.",
    "Tokens were spent. Lessons were allegedly learned.",
    "The prompt said reach the exit, not preserve dignity."
  ],
  hazard: ["The hazard documentation arrived one agent too late.", "They found the trap by unit testing it in production.", "One does not simply walk into a hazard. Several did.", "The danger was known. The pathfinding had other tabs open."],
  builder: ["The bridge passed code review. Gravity left comments.", "They built a stairway to heaven, or at least the next corridor.", "Brick by brick: infrastructure as actual code.", "The builders raised the uptime and several eyebrows."],
  digger: ["They dug through the stack until they found the root cause.", "The shovel performed a successful deep-dive.", "Dig first, ask questions at the postmortem.", "The lower corridor was discovered by downward compatibility."],
  miner: ["The miner deployed a breaking change. It broke the ground.", "That blast had excellent cache invalidation.", "They solved the obstacle with explosive refactoring."],
  floater: ["Cloud computing was taken unusually literally.", "The umbrellas provided a soft landing and zero vendor lock-in.", "They floated the proposal. Gravity reluctantly approved."],
  blocker: ["A blocker finally lived up to the ticket status.", "Somebody stood their ground. The ground filed a dependency.", "Traffic control was one agent in a robe saying no."],
  bomber: ["The rollback plan was mostly outward in every direction.", "They went with the nuclear option. It had excellent blast radius.", "A bomb fixed the bug and several neighboring features."],
  rescue: ["The director autoscaled the skill budget during the incident.", "An emergency tool arrived from the management plane.", "The rescue system achieved artificial helpfulness."],
  pit: ["The floor returned 404. Several agents followed the link.", "That pit had more depth than the plot.", "They stared into the abyss. The abyss had pixel graphics."],
  drone: ["The drone delivered same-day disruption.", "Air support arrived with a very hostile privacy policy.", "The operator chose remote work. The drone chose violence."],
  sniper: ["Long Context found a very short argument.", "The sniper established a position and declined all pull requests.", "Phasers were set to extremely inconvenient."]
}

function outcomeLine(w) {
  var target = w.target || w.toRelease
  var outcome = w.saved >= target ? COMPLETION_LINES : (w.nuking ? NUKED_LINES : PARTIAL_LINES)
  var facts = EVENT_LINES.ai.slice()
  function used(name) { return Object.prototype.hasOwnProperty.call(w.lastUsed, name) }
  function add(name, yes) { if (yes) facts = facts.concat(EVENT_LINES[name]) }
  add("hazard", w.hazardKills > 0); add("builder", used("builder"))
  add("digger", used("digger")); add("miner", used("miner"))
  add("floater", used("floater")); add("blocker", used("blocker"))
  add("bomber", used("bomber") || w.bombsUsed > 0); add("rescue", w.rescues > 0)
  add("pit", w.pits && w.pits.length > 0 && w.lost > 0)
  add("drone", w.enemyRoster && w.enemyRoster.indexOf("operator") >= 0)
  add("sniper", w.enemyRoster && w.enemyRoster.indexOf("sniper") >= 0)
  var pool = facts.length && Math.random() < 0.78 ? facts : outcome
  return pool[Math.floor(Math.random() * pool.length)]
}
