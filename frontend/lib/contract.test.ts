import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alignFromClicks, breadboardNodeAt, nodeName, projectUv } from "./alignment";
import { buildContext } from "./chat/context";
import { fallbackAnswer } from "./chat/fallback";
import { systemPrompt, ungroundedPins } from "./chat/grounding";
import { applyOverrides, buildGuide, diagnosticStates, overallHealth } from "./diagnostics";
import { detectHazards, HazardMonitor, hazardConfidence } from "./hazards";
import { evaluateRules, visibleScene } from "./rules/engine";
import { evaluateProject } from "./rules/project";
import { esp, scene as emptyScene, uno } from "./testing";
import type { Hazard, Point, Project, Scene } from "./types";
import blink from "../data/projects/led-blink.json";

// Scenes written by the real Python pipeline. This is where the two halves could silently disagree.
const sample = (id: string): Scene => JSON.parse(readFileSync(join(__dirname, "../public/samples", `${id}.json`), "utf8"));
const status = (scene: Scene, rule: string) => evaluateRules(scene, uno).results.find((r) => r.rule === rule)?.status;

describe("pipeline output through the rule engine", () => {
  it("passes the correctly wired blink", () => {
    const { graph, results } = evaluateRules(sample("blink-ok"), uno);
    expect(results.filter((r) => r.status !== "pass")).toEqual([]);
    expect(overallHealth(sample("blink-ok"), results)).toBe("ok");
    const steps = evaluateProject(blink as Project, graph, results);
    expect(steps.map((s) => s.status)).toEqual(["pass", "pass", "pass", "pass"]);
  });

  it("fails the LED with no resistor", () => {
    expect(status(sample("no-resistor"), "led-no-resistor")).toBe("fail");
  });

  it("fails the short through a rail", () => {
    const scene = sample("short");
    const { results } = evaluateRules(scene, uno);
    expect(status(scene, "short-power-gnd")).toBe("fail");
    expect(overallHealth(scene, results)).toBe("critical");
  });

  it("fails a wire across the rails from the signs the pipeline read", () => {
    const scene = sample("rails-joined");
    expect(status(scene, "rails-joined")).toBe("fail");
    expect(detectHazards(scene, uno, new Map()).hazards.map((h) => h.kind)).toEqual(["active"]);
  });

  it("colours the wires in a short red", () => {
    const scene = sample("short");
    const states = diagnosticStates(scene, evaluateRules(scene, uno).results);
    expect(scene.wires.map((w) => states.get(w.id))).toEqual(["critical", "critical", "critical"]);
  });

  it("alarms through the live sequence, from approach to short", () => {
    const monitor = new HazardMonitor();
    let distances = new Map<string, number>();
    const fired: Hazard[][] = [];
    for (const id of ["approach-far", "approach-near", "approach-near", "approach-touch"]) {
      const scene = sample(id);
      const { hazards, distances: next } = detectHazards(scene, uno, distances);
      distances = next;
      fired.push(monitor.update(hazards, (h) => hazardConfidence(h, scene)));
    }
    expect(fired[0]).toEqual([]);
    expect(fired.flat().some((h) => h.kind === "approaching")).toBe(true);
    expect(fired[3].some((h) => h.kind === "active")).toBe(true);
  });

  it("keeps the alarm independent of the confidence slider", () => {
    const scene = sample("short");
    const hidden = visibleScene(scene, 1, scene.detections);
    expect(hidden.wires).toEqual([]);
    expect(detectHazards(scene, uno, new Map()).hazards.length).toBeGreaterThan(0);
  });
});

describe("alignment", () => {
  const at = (id: string, pinout = uno, scale = 5, ox = 40, oy = 30): Point => {
    const pin = pinout.pins.find((p) => p.id === id)!;
    return [ox + pin.u * pinout.outlineMm.width * scale, oy + pin.v * pinout.outlineMm.height * scale];
  };
  const clicks = (pinout = uno) => pinout.alignPins.map((id) => at(id, pinout)) as [Point, Point, Point];

  it.each([["Uno", uno], ["ESP32", esp]])("recovers the board from three correct clicks on the %s", (_, pinout) => {
    const result = alignFromClicks(pinout, clicks(pinout));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const pin of pinout.pins) {
      const [x, y] = projectUv(result.quad, pin.u, pin.v);
      const [ex, ey] = at(pin.id, pinout);
      expect(Math.hypot(x - ex, y - ey)).toBeLessThan(0.01);
    }
  });

  it("works with the board rotated", () => {
    const rotate = ([x, y]: Point): Point => [300 + x * Math.cos(1) - y * Math.sin(1), 300 + x * Math.sin(1) + y * Math.cos(1)];
    const result = alignFromClicks(uno, clicks().map(rotate) as [Point, Point, Point]);
    expect(result.ok).toBe(true);
  });

  it("rejects mirrored clicks", () => {
    const [a, b, c] = clicks();
    const mirrored = [a, b, [c[0], 2 * a[1] - c[1]]] as [Point, Point, Point];
    expect(alignFromClicks(uno, mirrored)).toMatchObject({ ok: false });
  });

  it("rejects clicks that do not fit the board's shape", () => {
    const [a, b, c] = clicks();
    expect(alignFromClicks(uno, [a, b, [c[0], c[1] + 400]])).toMatchObject({ ok: false });
  });

  it("rejects points in a line", () => {
    expect(alignFromClicks(uno, [[0, 0], [10, 10], [20, 20]])).toMatchObject({ ok: false });
  });
});

describe("marking part legs", () => {
  const board = sample("blink-ok").breadboard!;
  it("reads a clicked hole as the same node the pipeline uses", () => {
    const scene = sample("blink-ok");
    const wireEnd = scene.wires.flatMap((w) => w.ends).find((e) => e.node?.startsWith("bb:"))!;
    expect(breadboardNodeAt(board, wireEnd.point)).toBe(wireEnd.node);
  });

  it("returns null away from the holes", () => {
    expect(breadboardNodeAt(board, [5, 5])).toBeNull();
  });

  it("lets an override supply legs, which the rules then use", () => {
    const scene = sample("blink-ok");
    const led = scene.detections.find((d) => d.kind === "led")!;
    const stripped = scene.detections.map((d) => (d.id === led.id ? { ...d, terminals: [] } : d));
    expect(status({ ...scene, detections: stripped }, "led-no-resistor")).toBe("unclear");
    const fixed = applyOverrides(stripped, [{ box: led.box, kind: "led", terminals: led.terminals }]);
    expect(status({ ...scene, detections: fixed }, "led-no-resistor")).toBe("pass");
  });
});

describe("overrides and guide", () => {
  it("corrects a part's kind by box overlap", () => {
    const scene = sample("blink-ok");
    const led = scene.detections.find((d) => d.kind === "led")!;
    const box = led.box.map((v) => v + 1) as typeof led.box;
    expect(applyOverrides(scene.detections, [{ box, kind: "capacitor" }]).find((d) => d.id === led.id)?.kind).toBe("capacitor");
  });

  it("puts the power warning first for a critical fault", () => {
    const steps = buildGuide(evaluateRules(sample("short"), uno).results);
    expect(steps[0]).toMatch(/Disconnect/);
    expect(steps.length).toBeGreaterThan(2);
  });

  it("has nothing to repair on a clean circuit", () => {
    expect(buildGuide(evaluateRules(sample("blink-ok"), uno).results)).toEqual([]);
  });

  it("names nodes for people", () => {
    expect(nodeName("pin:GND1", uno)).toBe("GND");
    expect(nodeName("bb:12:top", uno)).toBe("column 12 (top half)");
    expect(nodeName(null, uno)).toBe("unresolved");
  });
});

describe("LLM grounding", () => {
  it("accepts real pins", () => {
    expect(ungroundedPins("Move it to D13 or A0.", uno, "")).toEqual([]);
    expect(ungroundedPins("Use GPIO23 instead.", esp, "")).toEqual([]);
  });

  it("catches invented pins", () => {
    expect(ungroundedPins("Connect it to D20.", uno, "")).toEqual(["D20"]);
    expect(ungroundedPins("Use GPIO40.", esp, "")).toEqual(["GPIO40"]);
  });

  it("catches pins from the wrong board", () => {
    expect(ungroundedPins("Use GPIO23.", uno, "")).toEqual(["GPIO23"]);
  });

  it("treats every pin as invented when no board is known", () => {
    expect(ungroundedPins("Use D13.", null, "")).toEqual(["D13"]);
  });

  it("allows a pin the user asked about", () => {
    expect(ungroundedPins("D20 does not exist on this board.", uno, "What does D20 do?")).toEqual([]);
  });

  it("puts the verified pinout and rule status in the prompt", () => {
    const context = buildContext(sample("short"), "arduino_uno", uno, evaluateRules(sample("short"), uno).results);
    const prompt = systemPrompt(context, uno);
    expect(prompt).toContain("short-power-gnd");
    expect(prompt).toContain('"id":"D13"');
    expect(prompt).toContain("Never name a pin that is not in PINOUT");
  });
});

describe("rule-engine fallback", () => {
  const context = (scene: Scene) => buildContext(scene, "arduino_uno", uno, evaluateRules(scene, uno).results);

  it("reports failures with their fixes", () => {
    const answer = fallbackAnswer("Is this safe?", context(sample("short")), uno);
    expect(answer).toContain("Power-to-ground short");
    expect(answer).toContain("Unplug power");
  });

  it("answers a pin question from the pinout", () => {
    expect(fallbackAnswer("What does D13 do?", context(sample("blink-ok")), uno)).toContain("On-board LED");
  });

  it("says a pin does not exist", () => {
    expect(fallbackAnswer("What about D20?", context(sample("blink-ok")), uno)).toContain("D20 is not a pin");
  });

  it("works with nothing inspected yet", () => {
    expect(fallbackAnswer("hello", buildContext(null, null, null, []), null)).toContain("Nothing has been inspected");
  });

  it("does not claim all clear when checks are unclear", () => {
    const answer = fallbackAnswer("ok?", context(emptyScene([])), uno);
    expect(answer).not.toContain("All automated checks passed");
    expect(answer).toContain("Check by eye");
  });
});
