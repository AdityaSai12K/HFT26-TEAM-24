import type { ComponentKind, Detection, Pinout, Scene, Wire, WireEnd } from "./types";
import unoJson from "../data/pinouts/arduino_uno.json";
import espJson from "../data/pinouts/esp32_devkitc.json";

export const uno = unoJson as unknown as Pinout;
export const esp = espJson as unknown as Pinout;

let nextId = 0;

const end = (node: string | null, confidence = 0.9): WireEnd => ({
  point: [0, 0],
  node,
  confidence,
  near: node,
  nearPitches: node ? 0 : null,
  nearby: node ? [[node, 0]] : [],
});

export function wire(a: string | null, b: string | null, confidence = 0.9): Wire {
  return { id: `wire-${nextId++}`, color: "red", confidence, path: [], ends: [end(a), end(b)] };
}

export function looseWire(fixed: string, near: string, nearPitches: number): Wire {
  const w = wire(fixed, null);
  w.ends[1] = { ...end(null), near, nearPitches, nearby: [[near, nearPitches]] };
  return w;
}

/** A wire end sitting on `landed` while `target` is `pitches` away, as when hovering over the breadboard. */
export function hoveringWire(fixed: string, landed: string, target: string, pitches: number): Wire {
  const w = wire(fixed, landed);
  w.ends[1].nearby = [[landed, 0.1], [target, pitches]];
  return w;
}

export function part(kind: ComponentKind, a: string | null, b: string | null): Detection {
  return {
    id: `${kind}-${nextId++}`,
    kind,
    label: kind,
    confidence: 0.9,
    box: [0, 0, 10, 10],
    source: "yolo-world",
    terminals: [a, b].filter(Boolean).map((node) => ({ point: [0, 0], node, confidence: 0.9 })),
  };
}

export function scene(wires: Wire[], detections: Detection[] = []): Scene {
  return {
    imageSize: [640, 480],
    detections,
    wires,
    board: { id: null, confidence: 0, evidence: [], quad: null },
    breadboard: null,
    warnings: [],
  };
}
