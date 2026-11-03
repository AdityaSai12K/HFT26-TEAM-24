import { describe, expect, it } from "vitest";
import { evaluateRules } from "./engine";
import { evaluateProject } from "./project";
import { esp, part, scene, uno, wire } from "../testing";
import type { Project, RuleResult } from "../types";
import blink from "../../data/projects/led-blink.json";
import buttonLed from "../../data/projects/button-led.json";

const find = (results: RuleResult[], rule: string) => results.filter((r) => r.rule === rule);
const one = (results: RuleResult[], rule: string) => find(results, rule)[0];

describe("pinout data", () => {
  it("has every Uno pin at a unique position on the verified grid", () => {
    expect(uno.pins).toHaveLength(32);
    const at = (id: string) => uno.pins.find((p) => p.id === id)!;
    expect(at("D0").u).toBeCloseTo(2500 / 2700);
    expect(at("D8").u).toBeCloseTo(1640 / 2700);
    expect(at("SCL").u).toBeCloseTo(740 / 2700);
    expect(at("A5").u).toBeCloseTo(2500 / 2700);
    expect(at("VIN").u).toBeCloseTo(1800 / 2700);
    expect(new Set(uno.pins.map((p) => `${p.u},${p.v}`)).size).toBe(32);
  });

  it("maps the duplicated I2C header pins onto the analog nets", () => {
    expect(uno.pins.find((p) => p.id === "SDA")!.net).toBe("A4");
    expect(uno.pins.find((p) => p.id === "SCL")!.net).toBe("A5");
  });

  it("marks exactly GPIO6-11 as flash on the ESP32", () => {
    const flash = esp.pins.filter((p) => p.tags?.includes("flash")).map((p) => p.id).sort();
    expect(flash).toEqual(["GPIO10", "GPIO11", "GPIO6", "GPIO7", "GPIO8", "GPIO9"]);
    expect(esp.pins).toHaveLength(38);
  });
});

describe("power shorts", () => {
  it("fails a direct 5V to GND wire", () => {
    const { results } = evaluateRules(scene([wire("pin:5V", "pin:GND1")]), uno);
    expect(one(results, "short-power-gnd")).toMatchObject({ status: "fail", severity: "critical" });
  });

  it("follows a short through a breadboard rail and a second wire", () => {
    const s = scene([wire("pin:5V", "rail:top+"), wire("rail:top+", "bb:10:top"), wire("bb:10:top", "pin:GND3")]);
    expect(one(evaluateRules(s, uno).results, "short-power-gnd").status).toBe("fail");
  });

  it("treats every GND header pin as the same net", () => {
    const s = scene([wire("pin:GND1", "bb:1:top"), wire("bb:1:top", "pin:5V")]);
    expect(one(evaluateRules(s, uno).results, "short-power-gnd").status).toBe("fail");
  });

  it("flags 5V tied to 3V3", () => {
    expect(one(evaluateRules(scene([wire("pin:5V", "pin:3V3")]), uno).results, "supply-conflict").status).toBe("fail");
  });

  it("passes only when every wire is resolved", () => {
    const clean = scene([wire("pin:5V", "bb:1:top")]);
    expect(one(evaluateRules(clean, uno).results, "short-power-gnd").status).toBe("pass");
  });

  it("never passes when a wire end is unknown", () => {
    const s = scene([wire("pin:5V", null)]);
    expect(one(evaluateRules(s, uno).results, "short-power-gnd").status).toBe("unclear");
  });

  it("does not trust a low-confidence end", () => {
    const w = wire("pin:5V", "pin:GND1");
    w.ends[1].confidence = 0.3;
    expect(one(evaluateRules(scene([w]), uno).results, "short-power-gnd").status).toBe("unclear");
  });

  it("is unclear, not pass, when no wires were traced", () => {
    expect(one(evaluateRules(scene([]), uno).results, "short-power-gnd").status).toBe("unclear");
  });

  it("is unclear when the detector saw a wire the tracer missed", () => {
    const s = scene([wire("pin:5V", "bb:1:top")], [part("jumper_wire", null, null)]);
    expect(one(evaluateRules(s, uno).results, "short-power-gnd").status).toBe("unclear");
  });

  it("still gives a wiring verdict when a part's legs are unknown", () => {
    const s = scene([wire("pin:D2", "bb:1:top")], [part("led", null, null)]);
    const { results } = evaluateRules(s, uno);
    expect(one(results, "short-power-gnd").status).toBe("pass");
    expect(one(results, "led-no-resistor").status).toBe("unclear");
  });

  it("does not treat a resistor between 5V and GND as a short", () => {
    const s = scene(
      [wire("pin:5V", "bb:1:top"), wire("pin:GND1", "bb:2:top")],
      [part("resistor", "bb:1:top", "bb:2:top")],
    );
    expect(one(evaluateRules(s, uno).results, "short-power-gnd").status).toBe("pass");
  });
});

describe("LED resistor", () => {
  const wires = () => [wire("pin:D13", "bb:1:top"), wire("pin:GND1", "bb:3:top")];

  it("fails an LED directly from a pin to ground", () => {
    const s = scene(wires(), [part("led", "bb:1:top", "bb:3:top")]);
    expect(one(evaluateRules(s, uno).results, "led-no-resistor")).toMatchObject({ status: "fail", severity: "critical" });
  });

  it("fails an LED across 5V and GND", () => {
    const s = scene([wire("pin:5V", "bb:1:top"), wire("pin:GND1", "bb:3:top")], [part("led", "bb:1:top", "bb:3:top")]);
    expect(one(evaluateRules(s, uno).results, "led-no-resistor").status).toBe("fail");
  });

  it("passes with a resistor in series", () => {
    const s = scene(wires(), [part("resistor", "bb:1:top", "bb:2:top"), part("led", "bb:2:top", "bb:3:top")]);
    expect(one(evaluateRules(s, uno).results, "led-no-resistor").status).toBe("pass");
  });

  it("still fails when a resistor shares a net but is not in series", () => {
    const s = scene(wires(), [part("led", "bb:1:top", "bb:3:top"), part("resistor", "bb:1:top", "bb:9:top")]);
    expect(one(evaluateRules(s, uno).results, "led-no-resistor").status).toBe("fail");
  });

  it("does not count a parallel resistor as current limiting", () => {
    const s = scene([wire("pin:D13", "bb:1:top")], [part("led", "bb:1:top", "bb:3:top"), part("resistor", "bb:1:top", "bb:3:top")]);
    expect(one(evaluateRules(s, uno).results, "led-no-resistor").status).toBe("unclear");
  });

  it("is unclear when the legs cannot be resolved", () => {
    const s = scene(wires(), [part("led", null, null)]);
    expect(one(evaluateRules(s, uno).results, "led-no-resistor").status).toBe("unclear");
  });

  it("warns when both legs share a net", () => {
    const s = scene(wires(), [part("led", "bb:1:top", "bb:1:top")]);
    expect(one(evaluateRules(s, uno).results, "led-no-resistor")).toMatchObject({ status: "fail", severity: "warning" });
  });
});

describe("board-specific rules", () => {
  it("flags D0 and D1 on the Uno only", () => {
    const wires = [wire("pin:D0", "bb:1:top")];
    expect(one(evaluateRules(scene(wires), uno).results, "uno-serial-pins").status).toBe("fail");
    expect(find(evaluateRules(scene(wires), esp).results, "uno-serial-pins")).toHaveLength(0);
  });

  it.each(["GPIO6", "GPIO7", "GPIO8", "GPIO9", "GPIO10", "GPIO11"])("flags %s as reserved flash", (pin) => {
    expect(one(evaluateRules(scene([wire(`pin:${pin}`, "bb:1:top")]), esp).results, "esp32-flash-pins").status).toBe("fail");
  });

  it("does not flag an ordinary ESP32 pin", () => {
    expect(one(evaluateRules(scene([wire("pin:GPIO23", "bb:1:top")]), esp).results, "esp32-flash-pins").status).toBe("pass");
  });

  it("flags 5 V reaching an ESP32 GPIO", () => {
    const s = scene([wire("pin:5V", "bb:1:top"), wire("bb:1:top", "pin:GPIO23")]);
    expect(one(evaluateRules(s, esp).results, "esp32-5v-gpio").status).toBe("fail");
  });

  it("allows 5 V on a Uno GPIO in the ESP32 rule set", () => {
    expect(find(evaluateRules(scene([wire("pin:5V", "pin:D2")]), uno).results, "esp32-5v-gpio")).toHaveLength(0);
  });

  it("flags input-only pins driving a load", () => {
    const s = scene([wire("pin:GPIO34", "bb:1:top")], [part("resistor", "bb:1:top", "bb:2:top")]);
    expect(one(evaluateRules(s, esp).results, "esp32-input-only").status).toBe("fail");
  });

  it("asks for a manual check on strapping pins", () => {
    expect(one(evaluateRules(scene([wire("pin:GPIO12", "bb:1:top")]), esp).results, "esp32-strapping").status).toBe("unclear");
  });

  it("asks for a board when none is selected", () => {
    expect(one(evaluateRules(scene([]), null).results, "board-unknown").status).toBe("unclear");
  });
});

describe("expected circuit checks", () => {
  const steps = (s: ReturnType<typeof scene>, project: unknown) => {
    const { graph, results } = evaluateRules(s, uno);
    return Object.fromEntries(evaluateProject(project as Project, graph, results).map((r) => [r.id, r.status]));
  };

  it("passes a correct LED blink", () => {
    const s = scene(
      [wire("pin:D13", "bb:1:top"), wire("pin:GND1", "bb:3:top")],
      [part("resistor", "bb:1:top", "bb:2:top"), part("led", "bb:2:top", "bb:3:top")],
    );
    expect(steps(s, blink)).toEqual({ "led-present": "pass", "resistor-present": "pass", "series-path": "pass", "no-shorts": "pass" });
  });

  it("fails the path when everything is resolved but the path is absent", () => {
    const s = scene(
      [wire("pin:D13", "bb:1:top"), wire("pin:GND1", "bb:9:top")],
      [part("resistor", "bb:1:top", "bb:2:top"), part("led", "bb:2:top", "bb:3:top")],
    );
    expect(steps(s, blink)["series-path"]).toBe("fail");
  });

  it("is unclear when a wire is unresolved", () => {
    const s = scene(
      [wire("pin:D13", "bb:1:top"), wire("pin:GND1", null)],
      [part("resistor", "bb:1:top", "bb:2:top"), part("led", "bb:2:top", "bb:3:top")],
    );
    expect(steps(s, blink)["series-path"]).toBe("unclear");
  });

  it("requires the button and LED to use different pins", () => {
    const wires = [wire("pin:D2", "bb:1:top"), wire("pin:GND1", "bb:3:top")];
    const parts = [
      part("resistor", "bb:1:top", "bb:2:top"),
      part("led", "bb:2:top", "bb:3:top"),
      part("button", "bb:1:top", "bb:3:top"),
    ];
    expect(steps(scene(wires, parts), buttonLed)["button-path"]).toBe("fail");
    const fixed = [...wires, wire("pin:D3", "bb:5:top")];
    const fixedParts = [...parts.slice(0, 2), part("button", "bb:5:top", "bb:3:top")];
    expect(steps(scene(fixed, fixedParts), buttonLed)["button-path"]).toBe("pass");
  });
});
