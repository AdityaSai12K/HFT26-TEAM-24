// Shared data model. The vision backend returns a Scene; everything downstream
// (rules, overlays, chat context) is a pure function of the Scene plus user overrides.

export type BoardId = "arduino_uno" | "esp32_devkitc";

export type ComponentKind =
  | "arduino_uno"
  | "esp32"
  | "microcontroller"
  | "pin_header"
  | "usb_port"
  | "led"
  | "resistor"
  | "capacitor"
  | "button"
  | "jumper_wire"
  | "breadboard"
  | "unknown";

export type Point = [number, number];
export type Box = [number, number, number, number];
export type Quad = [Point, Point, Point, Point];

export interface Detection {
  id: string;
  kind: ComponentKind;
  /** The prompt text or heuristic that produced this detection. */
  label: string;
  confidence: number;
  box: Box;
  source: "yolo-world" | "opencv" | "manual";
  /** Electrical nodes this part's legs land on. Empty when they could not be resolved. */
  terminals: Terminal[];
}

export interface Terminal {
  point: Point;
  node: string | null;
  confidence: number;
}

export interface WireEnd {
  point: Point;
  /** Resolved electrical node ("pin:5V", "bb:12:top", "rail:top+"), null when the end landed nowhere certain. */
  node: string | null;
  confidence: number;
  /** Closest node even when the end has not landed on it. Drives the "moving toward" hazard check. */
  near: string | null;
  /** Distance to `near`, in header pitches (2.54 mm). */
  nearPitches: number | null;
  /**
   * Every node within a few pitches, closest first. A wire hovering over the
   * breadboard looks plugged in, so hazards check all of these, not just `node`.
   */
  nearby?: [string, number][];
}

export interface Wire {
  id: string;
  color: string;
  confidence: number;
  path: Point[];
  ends: [WireEnd, WireEnd];
}

export interface BoardEstimate {
  id: BoardId | null;
  confidence: number;
  evidence: string[];
  /** Corners in pinout order: (u0,v0), (u1,v0), (u1,v1), (u0,v1). */
  quad: Quad | null;
}

export interface Breadboard {
  columns: number;
  quad: Quad;
  /** Image pixels to board coordinates in pitches, used to read a clicked hole. */
  toBoard: number[][];
  rails: Record<"top" | "bottom", Record<"inner" | "outer", number>>;
  /** Rails whose sign was read from the printed lines. A rail missing here is unknown, not neutral. */
  railMarks?: RailMark[];
}

export interface RailMark {
  node: string;
  sign: "+" | "-";
  from: Point;
  to: Point;
}

export interface Scene {
  imageSize: [number, number];
  detections: Detection[];
  wires: Wire[];
  board: BoardEstimate;
  breadboard: Breadboard | null;
  /** Backend notes, e.g. model unavailable. Shown to the user. */
  warnings: string[];
  timings?: Record<string, number>;
}

export type PinRole = "power" | "ground" | "gpio" | "reset" | "reference" | "nc";

export interface Pin {
  id: string;
  header: string;
  position: number;
  label: string;
  role: PinRole;
  u: number;
  v: number;
  /** Pins sharing a net value are the same electrical node. */
  net: string;
  functions: string[];
  tags?: string[];
  notes?: string;
}

export interface Pinout {
  id: BoardId;
  name: string;
  mcu: string;
  logicVoltage: number;
  pitchMm: number;
  tolerant5V: boolean;
  outlineMm: { width: number; height: number };
  orientation: string;
  usbEnd: string;
  /** Pins the user clicks to align the map, far apart and on both headers. */
  alignPins: [string, string, string];
  variantNote?: string;
  specs: Record<string, string>;
  sources: { what: string; ref: string; url: string }[];
  pins: Pin[];
}

export type RuleStatus = "pass" | "fail" | "unclear";
export type Severity = "critical" | "warning" | "info";

export interface RuleResult {
  rule: string;
  title: string;
  status: RuleStatus;
  severity: Severity;
  reason: string;
  fix?: string;
  /** Detection and wire ids implicated, so overlays can colour them. */
  involves: string[];
}

export type HealthStatus = "ok" | "warning" | "critical" | "unknown";

export interface ProjectStep {
  id: string;
  text: string;
  check:
    | { type: "part_present"; kind: ComponentKind; count: number }
    | { type: "series_path"; from: "gpio"; via: ComponentKind[]; to: "GND" }
    | { type: "rules_clear"; rules: string[] };
}

export interface Project {
  id: string;
  name: string;
  summary: string;
  steps: ProjectStep[];
}

export interface StepResult {
  id: string;
  text: string;
  status: RuleStatus;
  reason: string;
}

export type DiagnosticState = "ok" | "warning" | "critical";

export interface Hazard {
  key: string;
  kind: "active" | "approaching";
  title: string;
  message: string;
  involves: string[];
}

export interface Override {
  box: Box;
  kind: ComponentKind;
  /** Nodes the user marked for this part's legs. */
  terminals?: Terminal[];
  /** A part the detector missed, so there is no detection to correct. */
  added?: boolean;
}
