import { describe, expect, it } from "vitest";
import { nodeName } from "./alignment";
import { applyOverrides } from "./diagnostics";
import { detectHazards } from "./hazards";
import { evaluateRules } from "./rules/engine";
import { looseWire, part, scene, uno, wire } from "./testing";
import type { Breadboard, Scene } from "./types";

const POSITIVE = "rail:top-outer";
const NEGATIVE = "rail:top-inner";

const board = (signed: boolean): Breadboard => ({
  columns: 30,
  quad: [[0, 0], [1, 0], [1, 1], [0, 1]],
  toBoard: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  rails: { top: { inner: 8.4, outer: 9.4 }, bottom: { inner: 8.4, outer: 9.4 } },
  railMarks: signed
    ? [
        { node: POSITIVE, sign: "+", from: [0, 0], to: [1, 0] },
        { node: NEGATIVE, sign: "-", from: [0, 1], to: [1, 1] },
      ]
    : [],
});

const onBoard = (base: Scene, signed = true): Scene => ({ ...base, breadboard: board(signed) });
const result = (s: Scene, rule: string, pinout = uno) => evaluateRules(s, pinout).results.find((r) => r.rule === rule);

describe("rails read from the printed lines", () => {
  it("fails a wire across the two rails with no board or alignment at all", () => {
    expect(evaluateRules(onBoard(scene([wire(POSITIVE, NEGATIVE)])), null).results.find((r) => r.rule === "rails-joined")?.status).toBe("fail");
  });

  it("fails rails joined through a column", () => {
    const s = onBoard(scene([wire(POSITIVE, "bb:5:top"), wire("bb:5:top", NEGATIVE)]));
    expect(result(s, "rails-joined")?.status).toBe("fail");
  });

  it("stays quiet when the signs could not be read", () => {
    const s = onBoard(scene([wire(POSITIVE, NEGATIVE)]), false);
    expect(result(s, "rails-joined")).toBeUndefined();
    expect(detectHazards(s, uno, new Map()).hazards).toEqual([]);
  });

  it("does not pass the rails while a wire is unresolved", () => {
    expect(result(onBoard(scene([wire(POSITIVE, null)])), "rails-joined")?.status).toBe("unclear");
  });

  it("sounds the alarm on joined rails", () => {
    const { hazards } = detectHazards(onBoard(scene([wire(POSITIVE, NEGATIVE)])), null, new Map());
    expect(hazards.map((h) => h.kind)).toEqual(["active"]);
  });

  it("warns about a wire closing on the opposite rail", () => {
    const { hazards } = detectHazards(onBoard(scene([looseWire(POSITIVE, NEGATIVE, 1)])), null, new Map());
    expect(hazards.map((h) => h.message)).toEqual([expect.stringContaining("the + rail to the - rail")]);
  });

  it("flags supply and ground on the wrong rails", () => {
    expect(result(onBoard(scene([wire("pin:5V", NEGATIVE)])), "rail-polarity")?.status).toBe("fail");
    expect(result(onBoard(scene([wire("pin:GND1", POSITIVE)])), "rail-polarity")?.status).toBe("fail");
  });

  it("passes supply and ground on the rails printed for them", () => {
    expect(result(onBoard(scene([wire("pin:5V", POSITIVE), wire("pin:GND1", NEGATIVE)])), "rail-polarity")?.status).toBe("pass");
  });

  it("fails an LED across the rails with no resistor", () => {
    const s = onBoard(scene([wire(POSITIVE, "bb:5:top"), wire("bb:8:top", NEGATIVE)], [part("led", "bb:5:top", "bb:8:top")]));
    const led = result(s, "led-no-resistor");
    expect(led?.status).toBe("fail");
    expect(led?.reason).toContain("the + rail to the - rail");
  });

  it("names the sign when it is known", () => {
    expect(nodeName(POSITIVE, null, board(true))).toBe("top outer + rail");
    expect(nodeName(POSITIVE, null, board(false))).toBe("top outer rail");
  });
});

describe("parts the detector missed", () => {
  const box: [number, number, number, number] = [0, 0, 10, 10];
  const terminals = [
    { point: [0, 0] as [number, number], node: "bb:5:top", confidence: 1 },
    { point: [0, 0] as [number, number], node: "bb:8:top", confidence: 1 },
  ];

  it("adds a detection the rules can use", () => {
    const [added] = applyOverrides([], [{ box, kind: "led", terminals, added: true }]);
    expect(added).toMatchObject({ kind: "led", source: "manual", terminals });
    const s = scene([wire("pin:D13", "bb:5:top"), wire("bb:8:top", "pin:GND1")], [added]);
    expect(result(s, "led-no-resistor")?.status).toBe("fail");
  });

  it("does not rewrite a real detection it happens to overlap", () => {
    const real = { ...part("resistor", null, null), box };
    const [first, second] = applyOverrides([real], [{ box, kind: "led", terminals, added: true }]);
    expect(first.kind).toBe("resistor");
    expect(second.kind).toBe("led");
  });
});
