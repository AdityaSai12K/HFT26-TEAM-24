import type { ComponentKind, Project, RuleResult, StepResult } from "../types";
import { CircuitGraph, type PartEdge } from "./graph";

/** Depth-first walk from `net` through parts of the remaining kinds, in any order, ending at ground. */
function reachesGround(g: CircuitGraph, net: string, remaining: ComponentKind[], used: Set<PartEdge>): boolean {
  if (!remaining.length) return g.net(net).ground;
  for (const part of g.parts) {
    if (used.has(part) || !remaining.includes(part.detection.kind)) continue;
    const a = g.netOf(part.a);
    const b = g.netOf(part.b);
    if (a !== net && b !== net) continue;
    const rest = [...remaining];
    rest.splice(rest.indexOf(part.detection.kind), 1);
    if (reachesGround(g, a === net ? b : a, rest, new Set(used).add(part))) return true;
  }
  return false;
}

export function evaluateProject(project: Project, graph: CircuitGraph, results: RuleResult[]): StepResult[] {
  const usedPins = new Set<string>();
  return project.steps.map((step) => {
    const base = { id: step.id, text: step.text };
    const check = step.check;

    if (check.type === "part_present") {
      const found = graph.scene.detections.filter((d) => d.kind === check.kind).length;
      return found >= check.count
        ? { ...base, status: "pass" as const, reason: `Found ${found}.` }
        : { ...base, status: "fail" as const, reason: `Found ${found}, expected at least ${check.count}. Lower the confidence slider if it is hidden.` };
    }

    if (check.type === "rules_clear") {
      const relevant = results.filter((r) => check.rules.includes(r.rule));
      const failed = relevant.find((r) => r.status === "fail");
      if (failed) return { ...base, status: "fail" as const, reason: failed.reason };
      const unclear = relevant.find((r) => r.status === "unclear");
      if (unclear || !relevant.length) {
        return { ...base, status: "unclear" as const, reason: unclear?.reason ?? "Not evaluated." };
      }
      return { ...base, status: "pass" as const, reason: "Clear." };
    }

    const starts = graph.nets().flatMap((net) =>
      net.pins
        .filter((p) => p.role === "gpio" && !net.ground && net.supplies.length === 0)
        .map((pin) => ({ pin, net })),
    );
    const hit = starts.find(({ pin, net }) => !usedPins.has(pin.net) && reachesGround(graph, net.root, check.via, new Set()));
    if (hit) {
      usedPins.add(hit.pin.net);
      return { ...base, status: "pass" as const, reason: `Traced from ${hit.pin.label} to GND.` };
    }
    return graph.incomplete || !graph.pinout
      ? { ...base, status: "unclear" as const, reason: `Path not confirmed: ${graph.incompleteReason ?? "board not identified"}.` }
      : { ...base, status: "fail" as const, reason: "All connections were resolved and this path does not exist." };
  });
}
