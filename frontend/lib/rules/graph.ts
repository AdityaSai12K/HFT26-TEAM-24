import { railSign } from "../alignment";
import type { ComponentKind, Detection, Pin, Pinout, Scene, Wire } from "../types";

/** Below this, an endpoint is treated as unresolved rather than as evidence. */
export const MIN_NODE_CONFIDENCE = 0.5;

const TWO_TERMINAL: ComponentKind[] = ["led", "resistor", "capacitor", "button"];

export interface PartEdge {
  detection: Detection;
  a: string;
  b: string;
}

export interface NetInfo {
  root: string;
  nodes: string[];
  pins: Pin[];
  supplies: string[];
  ground: boolean;
  /** This net holds a rail printed + or -. That says what it is for, not that it is powered. */
  railPositive: boolean;
  railNegative: boolean;
  wires: string[];
}

/** Canonical node id: pins that share a net on the board collapse to one node. */
export function canonicalNode(node: string, pinout: Pinout | null): string {
  if (!node.startsWith("pin:") || !pinout) return node;
  const pin = pinout.pins.find((p) => p.id === node.slice(4));
  return pin ? `net:${pin.net}` : node;
}

/**
 * Connectivity graph. Wires merge nodes into nets; two-terminal parts stay as
 * edges because a resistor or LED between two nets does not make them one net.
 */
export class CircuitGraph {
  readonly parts: PartEdge[] = [];
  readonly unresolvedWires: Wire[] = [];
  readonly unresolvedParts: Detection[] = [];
  /** Detector saw a wire the tracer could not follow, so connectivity is incomplete. */
  readonly untracedWireDetections: Detection[] = [];
  readonly wireCount: number;
  private parent = new Map<string, string>();
  private wiresByNode = new Map<string, string[]>();

  constructor(
    readonly scene: Scene,
    readonly pinout: Pinout | null,
  ) {
    pinout?.pins.forEach((p) => this.root(canonicalNode(`pin:${p.id}`, pinout)));

    for (const wire of scene.wires) {
      const nodes = wire.ends.map((end) =>
        end.node && end.confidence >= MIN_NODE_CONFIDENCE ? canonicalNode(end.node, pinout) : null,
      );
      if (!nodes[0] || !nodes[1]) {
        this.unresolvedWires.push(wire);
        continue;
      }
      this.union(nodes[0], nodes[1]);
      for (const node of nodes as string[]) {
        this.wiresByNode.set(node, [...(this.wiresByNode.get(node) ?? []), wire.id]);
      }
    }
    this.wireCount = scene.wires.length;

    for (const det of scene.detections) {
      if (TWO_TERMINAL.includes(det.kind)) {
        const nodes = det.terminals
          .filter((t) => t.node && t.confidence >= MIN_NODE_CONFIDENCE)
          .map((t) => canonicalNode(t.node as string, pinout));
        if (nodes.length >= 2) this.parts.push({ detection: det, a: nodes[0], b: nodes[1] });
        else this.unresolvedParts.push(det);
      }
      if (det.kind === "jumper_wire" && !scene.wires.some((w) => overlapsWire(det, w))) {
        this.untracedWireDetections.push(det);
      }
    }
  }

  private root(node: string): string {
    if (!this.parent.has(node)) this.parent.set(node, node);
    let cur = node;
    while (this.parent.get(cur) !== cur) cur = this.parent.get(cur) as string;
    this.parent.set(node, cur);
    return cur;
  }

  private union(a: string, b: string) {
    this.parent.set(this.root(a), this.root(b));
  }

  netOf(node: string): string {
    return this.root(canonicalNode(node, this.pinout));
  }

  nets(): NetInfo[] {
    const groups = new Map<string, string[]>();
    for (const node of this.parent.keys()) {
      const root = this.root(node);
      groups.set(root, [...(groups.get(root) ?? []), node]);
    }
    return [...groups.entries()].map(([root, nodes]) => this.describe(root, nodes));
  }

  net(node: string): NetInfo {
    return this.nets().find((n) => n.root === this.netOf(node)) ?? this.describe(node, [node]);
  }

  private describe(root: string, nodes: string[]): NetInfo {
    const pins = (this.pinout?.pins ?? []).filter((p) => nodes.includes(`net:${p.net}`));
    const signs = nodes.map((n) => railSign(n, this.scene.breadboard));
    return {
      root,
      nodes,
      pins,
      supplies: [...new Set(pins.filter((p) => p.role === "power").map((p) => p.net))],
      ground: pins.some((p) => p.role === "ground"),
      railPositive: signs.includes("+"),
      railNegative: signs.includes("-"),
      wires: [...new Set(nodes.flatMap((n) => this.wiresByNode.get(n) ?? []))],
    };
  }

  /** The photo showed which rail is which, so wiring can be checked without any pin alignment. */
  get railsKnown(): boolean {
    return Boolean(this.scene.breadboard?.railMarks?.length);
  }

  /** True when something in the picture could change the answer but was not resolved. */
  get incomplete(): boolean {
    return (
      this.unresolvedWires.length > 0 ||
      this.unresolvedParts.length > 0 ||
      this.untracedWireDetections.length > 0
    );
  }

  /**
   * What stops a wiring verdict, or null when there is nothing. Unresolved part
   * legs do not count: a resistor or LED cannot create a dead short or tie two
   * supplies together, so they must not hold back those checks.
   */
  get wiringGap(): string | null {
    const gaps: string[] = [];
    if (this.wireCount === 0) gaps.push("no wires were traced");
    if (this.unresolvedWires.length) gaps.push(`${this.unresolvedWires.length} wire(s) have an unresolved end`);
    if (this.untracedWireDetections.length) gaps.push(`${this.untracedWireDetections.length} wire(s) were seen but not traced`);
    return gaps.length ? gaps.join(", ") : null;
  }

  /** What stops a whole-circuit verdict, which also needs to know where the parts sit. */
  get incompleteReason(): string | null {
    const parts = this.unresolvedParts.length ? `${this.unresolvedParts.length} part(s) have unresolved legs` : null;
    return [this.wiringGap, parts].filter(Boolean).join(", ") || null;
  }
}

function overlapsWire(det: Detection, wire: Wire): boolean {
  const [x1, y1, x2, y2] = det.box;
  const hits = wire.path.filter(([x, y]) => x >= x1 && x <= x2 && y >= y1 && y <= y2).length;
  return wire.path.length > 0 && hits / wire.path.length >= 0.25;
}
