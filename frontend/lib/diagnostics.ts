import type { ComponentKind, DiagnosticState, Detection, HealthStatus, Override, RuleResult, Scene, Box } from "./types";

const PASSIVE: ComponentKind[] = ["arduino_uno", "esp32", "microcontroller", "pin_header", "usb_port", "breadboard"];
const LOW_CONFIDENCE = 0.35;

export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (areaA + areaB - inter || 1);
}

/** Overrides match by box overlap because ids are not stable across live frames. */
export function applyOverrides(detections: Detection[], overrides: Override[]): Detection[] {
  const corrections = overrides.filter((o) => !o.added);
  const corrected = detections.map((d) => {
    const hit = corrections.find((o) => iou(o.box, d.box) >= 0.5);
    return hit ? { ...d, kind: hit.kind, terminals: hit.terminals ?? d.terminals } : d;
  });
  const added = overrides
    .filter((o) => o.added)
    .map((o, index): Detection => ({ id: `added-${o.kind}-${index}`, kind: o.kind, label: "Added by you", confidence: 1, box: o.box, source: "manual", terminals: o.terminals ?? [] }));
  return [...corrected, ...added];
}

/** Colour for each detection and wire: red beats amber beats green. */
export function diagnosticStates(scene: Scene, results: RuleResult[]): Map<string, DiagnosticState> {
  const states = new Map<string, DiagnosticState>();
  const verified = new Set<string>();
  const rank: Record<DiagnosticState, number> = { ok: 0, warning: 1, critical: 2 };
  const raise = (id: string, s: DiagnosticState) => {
    if (rank[s] > rank[states.get(id) ?? "ok"]) states.set(id, s);
  };

  for (const r of results) {
    for (const id of r.involves) {
      if (r.status === "pass") verified.add(id);
      else if (r.status === "fail" && r.severity === "critical") raise(id, "critical");
      else raise(id, "warning");
    }
  }

  for (const d of scene.detections) {
    if (states.has(d.id)) continue;
    const trusted = PASSIVE.includes(d.kind) ? d.confidence >= LOW_CONFIDENCE : verified.has(d.id);
    states.set(d.id, trusted ? "ok" : "warning");
  }
  for (const w of scene.wires) {
    if (states.has(w.id)) continue;
    states.set(w.id, w.ends.every((e) => e.node) ? "ok" : "warning");
  }
  return states;
}

export function overallHealth(scene: Scene, results: RuleResult[]): HealthStatus {
  if (!scene.detections.length && !scene.wires.length) return "unknown";
  if (results.some((r) => r.status === "fail" && r.severity === "critical")) return "critical";
  if (results.some((r) => r.status !== "pass")) return "warning";
  return results.length ? "ok" : "unknown";
}

/** Numbered repair steps, most dangerous first. Deterministic, so it survives LLM outages. */
export function buildGuide(results: RuleResult[]): string[] {
  const order = (r: RuleResult) => (r.status === "fail" ? 0 : 1) + (r.severity === "critical" ? 0 : 2);
  const open = results.filter((r) => r.status !== "pass").sort((a, b) => order(a) - order(b));
  const steps: string[] = [];
  if (open.some((r) => r.status === "fail" && r.severity === "critical")) {
    steps.push("Disconnect USB and any external power before touching the wiring.");
  }
  const seen = new Set<string>();
  for (const r of open.filter((item) => item.fix)) {
    const line = `${r.title}: ${r.fix}`;
    if (!seen.has(line)) steps.push(line);
    seen.add(line);
  }
  // Checks held back by the same missing evidence need only one instruction.
  const blocked = open.filter((item) => !item.fix);
  if (blocked.length) {
    steps.push(`Check by eye: ${[...new Set(blocked.map((r) => r.title.toLowerCase()))].join(", ")}. The camera could not confirm these.`);
  }
  if (steps.length) steps.push("Take a new photo and re-run the checks before powering up.");
  return steps;
}
