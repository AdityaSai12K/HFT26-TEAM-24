import { describe, expect, it } from "vitest";
import { detectHazards, hazardConfidence, HazardMonitor } from "./hazards";
import { hoveringWire, looseWire, part, scene, uno, wire } from "./testing";
import type { Hazard } from "./types";

const noPrev = new Map<string, number>();

describe("detectHazards", () => {
  it("reports an active 5V to GND short", () => {
    const { hazards } = detectHazards(scene([wire("pin:5V", "pin:GND1")]), uno, noPrev);
    expect(hazards.map((h) => h.kind)).toEqual(["active"]);
  });

  it("reports an LED across the supply with no resistor", () => {
    const s = scene([wire("pin:5V", "bb:1:top"), wire("pin:GND1", "bb:2:top")], [part("led", "bb:1:top", "bb:2:top")]);
    expect(detectHazards(s, uno, noPrev).hazards[0].title).toBe("LED current limiting");
  });

  it("raises nothing for a safe circuit", () => {
    expect(detectHazards(scene([wire("pin:D2", "bb:1:top")]), uno, noPrev).hazards).toEqual([]);
  });

  it("warns as a 5V wire closes on a GND pin", () => {
    const first = detectHazards(scene([looseWire("pin:5V", "pin:GND1", 2.8)]), uno, noPrev);
    expect(first.hazards).toEqual([]);
    const second = detectHazards(scene([looseWire("pin:5V", "pin:GND1", 2.2)]), uno, first.distances);
    expect(second.hazards[0]).toMatchObject({ kind: "approaching" });
    expect(second.hazards[0].message).toContain("5V to GND");
  });

  it("warns immediately when the end is almost on the pin", () => {
    expect(detectHazards(scene([looseWire("pin:5V", "pin:GND1", 1)]), uno, noPrev).hazards).toHaveLength(1);
  });

  it("follows the target through a rail already wired to ground", () => {
    const s = scene([wire("pin:GND1", "rail:top-"), looseWire("pin:5V", "rail:top-", 1)]);
    expect(detectHazards(s, uno, noPrev).hazards[0].kind).toBe("approaching");
  });

  it("ignores a 5V wire heading for a harmless row", () => {
    expect(detectHazards(scene([looseWire("pin:5V", "bb:4:top", 1)]), uno, noPrev).hazards).toEqual([]);
  });

  it("ignores a wire moving away", () => {
    const first = detectHazards(scene([looseWire("pin:5V", "pin:GND1", 2)]), uno, noPrev);
    const second = detectHazards(scene([looseWire("pin:5V", "pin:GND1", 2.6)]), uno, first.distances);
    expect(second.hazards).toEqual([]);
  });

  it("warns as a wire hovering over the breadboard closes on a ground column", () => {
    const ground = wire("pin:GND1", "bb:12:top");
    const first = detectHazards(scene([ground, hoveringWire("pin:5V", "bb:9:top", "bb:12:top", 2.6)]), uno, noPrev);
    const second = detectHazards(scene([ground, hoveringWire("pin:5V", "bb:10:top", "bb:12:top", 1.8)]), uno, first.distances);
    expect(second.hazards.map((h) => h.kind)).toEqual(["approaching"]);
  });

  it("stays quiet for a wire plugged in beside a ground column", () => {
    const ground = wire("pin:GND1", "bb:12:top");
    const held = () => hoveringWire("pin:5V", "bb:11:top", "bb:12:top", 1);
    const first = detectHazards(scene([ground, held()]), uno, noPrev);
    expect(first.hazards).toEqual([]);
    expect(detectHazards(scene([ground, held()]), uno, first.distances).hazards).toEqual([]);
  });

  it("ignores tracing jitter", () => {
    const ground = wire("pin:GND1", "bb:12:top");
    const first = detectHazards(scene([ground, hoveringWire("pin:5V", "bb:11:top", "bb:12:top", 1.1)]), uno, noPrev);
    const second = detectHazards(scene([ground, hoveringWire("pin:5V", "bb:11:top", "bb:12:top", 1.0)]), uno, first.distances);
    expect(second.hazards).toEqual([]);
  });

  it("includes hazards a display threshold would have hidden", () => {
    const s = scene([wire("pin:5V", "pin:GND1", 0.12)]);
    expect(detectHazards(s, uno, noPrev).hazards).toHaveLength(1);
  });
});

describe("HazardMonitor", () => {
  const active: Hazard = { key: "a", kind: "active", title: "t", message: "m", involves: [] };
  const approaching: Hazard = { ...active, key: "b", kind: "approaching" };

  it("fires a confident active short on the first frame", () => {
    expect(new HazardMonitor().update([active], () => 0.9)).toEqual([active]);
  });

  it("waits one more frame for a weak detection", () => {
    const m = new HazardMonitor();
    expect(m.update([active], () => 0.4)).toEqual([]);
    expect(m.update([active], () => 0.4)).toEqual([active]);
  });

  it("fires an approach at once, because a hand only takes a few frames to arrive", () => {
    expect(new HazardMonitor().update([approaching], () => 0.1)).toEqual([approaching]);
  });

  it("holds through a dropped frame", () => {
    const m = new HazardMonitor();
    m.update([active], () => 0.9);
    expect(m.update([], () => 0.9)).toEqual([active]);
  });

  it("clears after the hazard stays gone", () => {
    const m = new HazardMonitor();
    m.update([active], () => 0.9);
    m.update([], () => 0.9);
    m.update([], () => 0.9);
    expect(m.update([], () => 0.9)).toEqual([]);
  });

  it("stays quiet after acknowledge, then alarms again if the hazard returns", () => {
    const m = new HazardMonitor();
    m.update([active], () => 0.9);
    m.acknowledge("a");
    expect(m.update([active], () => 0.9)).toEqual([]);
    for (let i = 0; i < 3; i++) m.update([], () => 0.9);
    expect(m.update([active], () => 0.9)).toEqual([active]);
  });
});

describe("hazardConfidence", () => {
  it("is limited by the weakest wire", () => {
    const a = wire("pin:5V", "bb:1:top", 0.9);
    const b = wire("bb:1:top", "pin:GND1", 0.3);
    const hazard: Hazard = { key: "k", kind: "active", title: "t", message: "m", involves: [a.id, b.id] };
    expect(hazardConfidence(hazard, scene([a, b]))).toBe(0.3);
  });
});
