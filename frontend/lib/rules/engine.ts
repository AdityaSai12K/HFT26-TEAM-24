import type { Detection, Pinout, RuleResult, Scene, Severity } from "../types";
import { CircuitGraph, type NetInfo, type PartEdge } from "./graph";

type Result = Omit<RuleResult, "rule" | "title" | "severity"> & { severity?: Severity };

interface Rule {
  id: string;
  title: string;
  severity: Severity;
  boards?: Pinout["id"][];
  run: (g: CircuitGraph) => Result[];
}

const pinNames = (net: NetInfo) => net.pins.map((p) => p.label).join(", ");
const partIds = (parts: PartEdge[]) => parts.map((p) => p.detection.id);

/** A clean result only counts as a pass when nothing relevant went unresolved. */
function clean(g: CircuitGraph, passReason: string): Result {
  const gap = g.wiringGap;
  return gap
    ? { status: "unclear", reason: `No problem found, but ${gap}.`, involves: unresolvedWireIds(g) }
    : { status: "pass", reason: passReason, involves: [] };
}

function unresolvedWireIds(g: CircuitGraph): string[] {
  return [...g.unresolvedWires.map((w) => w.id), ...g.untracedWireDetections.map((d) => d.id)];
}

function connectedPins(g: CircuitGraph, tag: string): { net: NetInfo; pin: string }[] {
  return g
    .nets()
    .filter((net) => net.nodes.length > 1)
    .flatMap((net) => net.pins.filter((p) => p.tags?.includes(tag)).map((p) => ({ net, pin: p.id })));
}

function partsOnNet(g: CircuitGraph, net: NetInfo): PartEdge[] {
  return g.parts.filter((p) => g.netOf(p.a) === net.root || g.netOf(p.b) === net.root);
}

const shortPowerGnd: Rule = {
  id: "short-power-gnd",
  title: "Power-to-ground short",
  severity: "critical",
  run: (g) => {
    const shorted = g.nets().filter((n) => n.supplies.length > 0 && n.ground);
    if (!shorted.length) return [clean(g, `No supply is tied to ground across ${g.wireCount} traced wire(s).`)];
    return shorted.map((n) => ({
      status: "fail",
      reason: `${n.supplies.join(" and ")} and GND are joined on the same net by ${n.wires.length} wire(s).`,
      fix: `Unplug power now. Remove the wire joining ${n.supplies.join("/")} to GND, then check that no breadboard row or rail holds both.`,
      involves: n.wires,
    }));
  },
};

const supplyConflict: Rule = {
  id: "supply-conflict",
  title: "Two supplies tied together",
  severity: "critical",
  run: (g) => {
    const tied = g.nets().filter((n) => n.supplies.length > 1);
    if (!tied.length) return [clean(g, "No two supply pins share a net.")];
    return tied.map((n) => ({
      status: "fail",
      reason: `${n.supplies.join(" and ")} are joined. Different supply rails will fight each other through the regulator.`,
      fix: `Unplug power and separate ${n.supplies.join(" from ")}.`,
      involves: n.wires,
    }));
  },
};

const railsJoined: Rule = {
  id: "rails-joined",
  title: "Plus and minus rails joined",
  severity: "critical",
  run: (g) => {
    if (!g.railsKnown) return [];
    const joined = g.nets().filter((n) => n.railPositive && n.railNegative);
    if (!joined.length) return [clean(g, "No wire joins a + rail to a - rail.")];
    return joined.map((n) => ({
      status: "fail",
      reason: `A + rail and a - rail are joined by ${n.wires.length} wire(s), which shorts the supply as soon as power is on.`,
      fix: "Unplug power and remove the wire joining the two rails.",
      involves: n.wires,
    }));
  },
};

const railPolarity: Rule = {
  id: "rail-polarity",
  title: "Power on the wrong rail",
  severity: "warning",
  run: (g) => {
    if (!g.railsKnown || !g.pinout) return [];
    const swapped = g.nets().filter((n) => (n.supplies.length > 0 && n.railNegative && !n.railPositive) || (n.ground && n.railPositive && !n.railNegative));
    if (!swapped.length) return [clean(g, "Supply and ground are on the rails printed for them.")];
    return swapped.map((n) => ({
      status: "fail",
      reason: `${pinNames(n)} is wired to the rail printed ${n.railPositive ? "+" : "-"}, so anything placed by the printed signs will be reversed.`,
      fix: "Unplug power and swap the two rail wires.",
      involves: n.wires,
    }));
  },
};

const ledResistor: Rule = {
  id: "led-no-resistor",
  title: "LED current limiting",
  severity: "critical",
  run: (g) => {
    const leds = g.parts.filter((p) => p.detection.kind === "led");
    const unresolved = g.unresolvedParts.filter((d) => d.kind === "led");
    const results: Result[] = unresolved.map((d) => ({
      status: "unclear",
      reason: "Could not tell which rows this LED's legs are in.",
      fix: "Check by eye that a 220 ohm to 1 k resistor is in series with this LED.",
      involves: [d.id],
    }));
    for (const led of leds) {
      const a = g.net(led.a);
      const b = g.net(led.b);
      const self = led.detection.id;
      if (a.root === b.root) {
        results.push({
          status: "fail",
          severity: "warning",
          reason: "Both LED legs are on the same net, so the LED is shorted out and cannot light.",
          fix: "Move one leg to a different breadboard column.",
          involves: [self],
        });
        continue;
      }
      // Direct drive goes first: a resistor elsewhere on these nets does not limit this LED.
      const driven = (n: NetInfo) => n.supplies.length > 0 || n.railPositive || n.pins.some((p) => p.role === "gpio");
      const sinks = (n: NetInfo) => n.ground || n.railNegative;
      if ((driven(a) && sinks(b)) || (driven(b) && sinks(a))) {
        const [source, sink] = sinks(a) ? [b, a] : [a, b];
        results.push({
          status: "fail",
          reason: `LED runs directly from ${pinNames(source) || "the + rail"} to ${sink.ground ? "GND" : "the - rail"} with no resistor, which can burn out the LED or the pin.`,
          fix: "Unplug power and add a 220 ohm to 1 k resistor in series with the LED.",
          involves: [self, ...a.wires, ...b.wires],
        });
        continue;
      }
      // A resistor joining both LED nets is in parallel, which limits nothing.
      const onLedNet = (node: string) => g.netOf(node) === a.root || g.netOf(node) === b.root;
      const series = g.parts.filter((p) => p.detection.kind === "resistor" && onLedNet(p.a) !== onLedNet(p.b));
      if (series.length) {
        results.push({
          status: "pass",
          reason: "A resistor is in series with this LED. Its value was not read from the photo.",
          involves: [self, ...partIds(series)],
        });
        continue;
      }
      results.push({
        status: "unclear",
        reason: "This LED has no resistor beside it, but its circuit is not complete in the photo.",
        fix: "Finish the circuit with a series resistor before applying power.",
        involves: [self],
      });
    }
    return results;
  },
};

const gpioHardTied: Rule = {
  id: "gpio-hard-tied",
  title: "GPIO tied directly to a supply or ground",
  severity: "warning",
  run: (g) => {
    const tied = g
      .nets()
      .filter((n) => n.pins.some((p) => p.role === "gpio") && (n.ground || n.supplies.length > 0))
      .filter((n) => !(n.ground && n.supplies.length > 0));
    if (!tied.length) return [clean(g, "No GPIO is wired straight to a supply or to ground.")];
    return tied.map((n) => ({
      status: "fail",
      reason: `${pinNames(n)} share a net, so a GPIO has no current limit if it is driven against that level.`,
      fix: "Keep this pin as an input, or put a resistor between it and the supply.",
      involves: n.wires,
    }));
  },
};

const floatingWire: Rule = {
  id: "floating-wire",
  title: "Wires with unresolved ends",
  severity: "warning",
  run: (g) => {
    if (g.wireCount === 0 && !g.untracedWireDetections.length) return [];
    const ids = unresolvedWireIds(g);
    if (!ids.length) return [{ status: "pass", reason: `All ${g.wireCount} traced wire(s) land on a known pin or row.`, involves: [] }];
    return [
      {
        status: "unclear",
        reason: `${ids.length} wire(s) could not be followed to a pin or row at both ends.`,
        fix: "Check where each amber wire goes. Better lighting or a straight-down photo helps tracing.",
        involves: ids,
      },
    ];
  },
};

const unoSerial: Rule = {
  id: "uno-serial-pins",
  title: "D0/D1 in use",
  severity: "warning",
  boards: ["arduino_uno"],
  run: (g) => {
    const used = g.nets().filter((n) => n.nodes.length > 1 && n.pins.some((p) => p.id === "D0" || p.id === "D1"));
    if (!used.length) return [clean(g, "D0 and D1 are free for USB serial.")];
    return used.map((n) => ({
      status: "fail",
      reason: `${pinNames(n)} is wired, and D0/D1 are shared with the USB bridge, so uploads and Serial can fail.`,
      fix: "Move this connection to D2 or higher.",
      involves: n.wires,
    }));
  },
};

const esp32Flash: Rule = {
  id: "esp32-flash-pins",
  title: "Reserved flash pins GPIO6-11",
  severity: "critical",
  boards: ["esp32_devkitc"],
  run: (g) => {
    const used = connectedPins(g, "flash");
    if (!used.length) return [clean(g, "GPIO6-11 are not wired.")];
    return used.map(({ net, pin }) => ({
      status: "fail",
      reason: `${pin} is connected to the SPI flash, so wiring it can stop the ESP32 from booting.`,
      fix: "Move this connection to an unreserved pin such as GPIO23 or GPIO22.",
      involves: net.wires,
    }));
  },
};

const esp32FiveVolt: Rule = {
  id: "esp32-5v-gpio",
  title: "5 V on a 3.3 V GPIO",
  severity: "critical",
  boards: ["esp32_devkitc"],
  run: (g) => {
    const hit = g.nets().filter((n) => n.pins.some((p) => p.role === "gpio") && n.supplies.includes("5V"));
    if (!hit.length) return [clean(g, "No GPIO shares a net with 5 V.")];
    return hit.map((n) => ({
      status: "fail",
      reason: `${pinNames(n)} share a net. ESP32 GPIOs are 3.3 V only and are not 5 V tolerant.`,
      fix: "Unplug power and remove the connection. Use a level shifter for 5 V signals.",
      involves: n.wires,
    }));
  },
};

const esp32InputOnly: Rule = {
  id: "esp32-input-only",
  title: "Input-only pin driving a load",
  severity: "warning",
  boards: ["esp32_devkitc"],
  run: (g) => {
    const hit = connectedPins(g, "input_only").filter(({ net }) =>
      partsOnNet(g, net).some((p) => p.detection.kind === "led" || p.detection.kind === "resistor"),
    );
    if (!hit.length) return [clean(g, "GPIO34-39 are not driving a load.")];
    return hit.map(({ net, pin }) => ({
      status: "fail",
      reason: `${pin} is input-only, so it cannot drive this load.`,
      fix: "Move the load to an output-capable pin such as GPIO23.",
      involves: [...net.wires, ...partIds(partsOnNet(g, net))],
    }));
  },
};

const esp32Strapping: Rule = {
  id: "esp32-strapping",
  title: "Strapping pins in use",
  severity: "warning",
  boards: ["esp32_devkitc"],
  run: (g) => {
    const used = connectedPins(g, "strapping");
    if (!used.length) return [clean(g, "Strapping pins are free.")];
    return used.map(({ net, pin }) => ({
      status: "unclear",
      reason: `${pin} sets boot behaviour, so this connection may stop the board booting or flashing.`,
      fix: `If boot fails, move this connection off ${pin}.`,
      involves: net.wires,
    }));
  },
};

export const RULES: Rule[] = [
  shortPowerGnd,
  supplyConflict,
  railsJoined,
  railPolarity,
  ledResistor,
  gpioHardTied,
  floatingWire,
  unoSerial,
  esp32Flash,
  esp32FiveVolt,
  esp32InputOnly,
  esp32Strapping,
];

export function evaluateRules(scene: Scene, pinout: Pinout | null): { graph: CircuitGraph; results: RuleResult[] } {
  const graph = new CircuitGraph(scene, pinout);
  const results: RuleResult[] = [];
  if (!pinout) {
    results.push({
      rule: "board-unknown",
      title: "Board not identified",
      status: "unclear",
      severity: "warning",
      reason: "Pin-level checks need a board profile.",
      fix: "Choose the board from the selector under the image.",
      involves: [],
    });
  }
  for (const rule of RULES) {
    if (rule.boards && !(pinout && rule.boards.includes(pinout.id))) continue;
    for (const r of rule.run(graph)) {
      results.push({ rule: rule.id, title: rule.title, severity: r.severity ?? rule.severity, ...r });
    }
  }
  return { graph, results };
}

export function visibleScene(scene: Scene, threshold: number, detections: Detection[]): Scene {
  return {
    ...scene,
    detections: detections.filter((d) => d.confidence >= threshold),
    wires: scene.wires.filter((w) => w.confidence >= threshold),
  };
}
