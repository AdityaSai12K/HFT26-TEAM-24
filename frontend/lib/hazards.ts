import { nodeName } from "./alignment";
import type { Hazard, Pinout, Scene } from "./types";
import { evaluateRules } from "./rules/engine";
import { CircuitGraph, MIN_NODE_CONFIDENCE, type NetInfo } from "./rules/graph";

const DESTRUCTIVE_RULES = ["short-power-gnd", "supply-conflict", "rails-joined", "esp32-5v-gpio", "led-no-resistor"];

/** A wire end this close to a dangerous net (in header pitches) is watched for movement. */
export const APPROACH_PITCHES = 3;
/** An end that has not landed inside this distance alarms without waiting to see it move. */
const IMMINENT_PITCHES = 1.5;
/** Tracing jitter is smaller than this, so only a bigger drop counts as real movement. */
const MIN_CLOSING_PITCHES = 0.25;
const CONFIRM_FRAMES = 2;
const CLEAR_FRAMES = 3;
/** A resolved wire this certain fires on the first frame. */
const INSTANT_CONFIDENCE = 0.75;

function conflicts(a: NetInfo, b: NetInfo): string | null {
  if (a.root === b.root) return null;
  if (a.ground && b.supplies.length) return `${b.supplies[0]} to GND`;
  if (b.ground && a.supplies.length) return `${a.supplies[0]} to GND`;
  if (a.supplies.length && b.supplies.length) return `${a.supplies[0]} to ${b.supplies[0]}`;
  if (a.ground && b.railPositive) return "GND to the + rail";
  if (b.ground && a.railPositive) return "GND to the + rail";
  if (a.supplies.length && b.railNegative) return `${a.supplies[0]} to the - rail`;
  if (b.supplies.length && a.railNegative) return `${b.supplies[0]} to the - rail`;
  if ((a.railPositive && b.railNegative) || (a.railNegative && b.railPositive)) return "the + rail to the - rail";
  return null;
}

function nodeLabel(g: CircuitGraph, node: string): string {
  return g.net(node).pins[0]?.label ?? nodeName(node, g.pinout, g.scene.breadboard);
}

/**
 * Must receive the scene before the confidence slider is applied: a safety
 * alarm cannot be silenced by a display filter.
 */
export function detectHazards(
  scene: Scene,
  pinout: Pinout | null,
  previousDistances: Map<string, number>,
): { hazards: Hazard[]; distances: Map<string, number> } {
  const { graph, results } = evaluateRules(scene, pinout);
  const hazards: Hazard[] = results
    .filter((r) => r.status === "fail" && r.severity === "critical" && DESTRUCTIVE_RULES.includes(r.rule))
    .map((r) => ({ key: `active:${r.rule}:${[...r.involves].sort().join(",")}`, kind: "active", title: r.title, message: r.reason, involves: r.involves }));

  const distances = new Map<string, number>();
  for (const wire of scene.wires) {
    for (const [fixed, moving] of [wire.ends, [wire.ends[1], wire.ends[0]]] as const) {
      if (!fixed.node || fixed.confidence < MIN_NODE_CONFIDENCE) continue;
      const landed = moving.node !== null && moving.confidence >= MIN_NODE_CONFIDENCE;

      for (const [node, pitches] of moving.nearby ?? []) {
        if (pitches > APPROACH_PITCHES || node === moving.node) continue;
        const danger = conflicts(graph.net(fixed.node), graph.net(node));
        if (!danger) continue;

        const key = `${wire.color}:${fixed.node}:${node}`;
        distances.set(key, pitches);
        const previous = previousDistances.get(key);
        // A wire plugged in beside a GND column holds still, so it must not alarm.
        const closing = previous !== undefined && previous - pitches >= MIN_CLOSING_PITCHES;
        if (closing || (!landed && pitches <= IMMINENT_PITCHES)) {
          hazards.push({
            key: `approach:${key}`,
            kind: "approaching",
            title: "Wire moving toward a short",
            message: `The ${wire.color} wire from ${nodeLabel(graph, fixed.node)} is closing on ${nodeLabel(graph, node)}. That would connect ${danger}.`,
            involves: [wire.id],
          });
        }
      }
    }
  }
  return { hazards, distances };
}

interface Track {
  hazard: Hazard;
  seen: number;
  missed: number;
  acknowledged: boolean;
}

/**
 * Frame-to-frame debounce. One noisy frame should not sound the alarm, but a
 * confident active short must not wait, and a hazard stays up until it has
 * really gone so the alarm does not flap.
 */
export class HazardMonitor {
  private tracks = new Map<string, Track>();

  update(hazards: Hazard[], confidenceOf: (hazard: Hazard) => number): Hazard[] {
    const current = new Set(hazards.map((h) => h.key));
    for (const hazard of hazards) {
      const track = this.tracks.get(hazard.key) ?? { hazard, seen: 0, missed: 0, acknowledged: false };
      track.hazard = hazard;
      track.seen += 1;
      track.missed = 0;
      this.tracks.set(hazard.key, track);
    }
    for (const [key, track] of this.tracks) {
      if (current.has(key)) continue;
      track.missed += 1;
      if (track.missed >= CLEAR_FRAMES) this.tracks.delete(key);
    }
    return [...this.tracks.values()]
      .filter((t) => !t.acknowledged)
      .filter((t) => this.confirmed(t, confidenceOf))
      .map((t) => t.hazard);
  }

  private confirmed(track: Track, confidenceOf: (hazard: Hazard) => number): boolean {
    // An approach is measured across two frames already, and at a few frames per
    // second a hand reaches the pin in two or three, so it cannot wait for more.
    if (track.hazard.kind === "approaching") return true;
    return track.seen >= CONFIRM_FRAMES || confidenceOf(track.hazard) >= INSTANT_CONFIDENCE;
  }

  /** Silences a hazard until it clears; if it reappears later it alarms again. */
  acknowledge(key: string) {
    const track = this.tracks.get(key);
    if (track) track.acknowledged = true;
  }

  reset() {
    this.tracks.clear();
  }
}

/** Weakest wire in the hazard: the alarm is only as certain as its worst link. */
export function hazardConfidence(hazard: Hazard, scene: Scene): number {
  const wires = scene.wires.filter((w) => hazard.involves.includes(w.id));
  return wires.length ? Math.min(...wires.map((w) => w.confidence)) : 0;
}
