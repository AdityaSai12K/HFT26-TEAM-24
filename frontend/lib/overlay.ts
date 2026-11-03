import { projectUv } from "./alignment";
import { COMPONENTS } from "./knowledge";
import type { Box, DiagnosticState, Pin, Pinout, Point, Scene, Wire } from "./types";

export const STATE_COLOURS: Record<DiagnosticState, string> = {
  ok: "#5fdcbc",
  warning: "#ffb938",
  critical: "#ff3b30",
};

/** A canvas font string cannot use var(), so the family is read out of the page. */
export function canvasFont(style: string, variable: string): string {
  return `${style} ${getComputedStyle(document.documentElement).getPropertyValue(variable)}, ui-monospace, monospace`;
}

export interface View {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** How an image of `size` fits a box with object-contain, so overlays stay on the hardware. */
export function fitView(size: [number, number], boxWidth: number, boxHeight: number): View {
  const scale = Math.min(boxWidth / size[0], boxHeight / size[1]);
  return { scale, offsetX: (boxWidth - size[0] * scale) / 2, offsetY: (boxHeight - size[1] * scale) / 2 };
}

export const toScreen = (view: View, [x, y]: Point): Point => [x * view.scale + view.offsetX, y * view.scale + view.offsetY];
export const toImage = (view: View, [x, y]: Point): Point => [(x - view.offsetX) / view.scale, (y - view.offsetY) / view.scale];

export type Target = { type: "detection"; id: string } | { type: "wire"; id: string } | { type: "pin"; pin: Pin };

export function pinPoints(scene: Scene, pinout: Pinout | null): { pin: Pin; point: Point }[] {
  const quad = scene.board.quad;
  if (!quad || !pinout) return [];
  return pinout.pins.map((pin) => ({ pin, point: projectUv(quad, pin.u, pin.v) }));
}

function distanceToSegment([px, py]: Point, [ax, ay]: Point, [bx, by]: Point): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function wireDistance(point: Point, wire: Wire): number {
  let best = Infinity;
  for (let i = 1; i < wire.path.length; i++) best = Math.min(best, distanceToSegment(point, wire.path[i - 1], wire.path[i]));
  return best;
}

/** Topmost thing under an image point: pins, then wires, then the smallest box. */
export function hitTest(point: Point, scene: Scene, pinout: Pinout | null, view: View, showPins: boolean): Target | null {
  if (showPins) {
    const reach = 7 / view.scale;
    const pin = pinPoints(scene, pinout).find((p) => Math.hypot(p.point[0] - point[0], p.point[1] - point[1]) <= reach);
    if (pin) return { type: "pin", pin: pin.pin };
  }
  const wire = scene.wires.find((w) => wireDistance(point, w) <= 6 / view.scale);
  if (wire) return { type: "wire", id: wire.id };
  const inside = scene.detections
    .filter(({ box: [x1, y1, x2, y2] }) => point[0] >= x1 && point[0] <= x2 && point[1] >= y1 && point[1] <= y2)
    .sort((a, b) => area(a.box) - area(b.box));
  return inside[0] ? { type: "detection", id: inside[0].id } : null;
}

const area = ([x1, y1, x2, y2]: Box) => (x2 - x1) * (y2 - y1);

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, colour: string) {
  ctx.font = canvasFont("600 11px", "--font-plex-mono");
  const width = ctx.measureText(text).width + 10;
  const top = Math.max(0, y - 18);
  ctx.fillStyle = colour;
  ctx.fillRect(x, top, width, 17);
  ctx.fillStyle = "#0d0d0c";
  ctx.fillText(text, x + 5, top + 12.5);
}

export interface DrawState {
  states: Map<string, DiagnosticState>;
  active: Target | null;
  showPins: boolean;
}

export function drawOverlay(ctx: CanvasRenderingContext2D, scene: Scene, pinout: Pinout | null, view: View, state: DrawState) {
  const isActive = (type: string, id: string) => state.active?.type === type && "id" in state.active && state.active.id === id;

  drawRails(ctx, scene, view);

  // Large parts first, so a board's box never paints over what sits on it.
  for (const d of [...scene.detections].sort((a, b) => area(b.box) - area(a.box))) {
    const colour = STATE_COLOURS[state.states.get(d.id) ?? "warning"];
    const [x, y] = toScreen(view, [d.box[0], d.box[1]]);
    const width = (d.box[2] - d.box[0]) * view.scale;
    const height = (d.box[3] - d.box[1]) * view.scale;
    const focused = isActive("detection", d.id);
    ctx.lineWidth = focused ? 3 : 2;
    ctx.strokeStyle = colour;
    ctx.fillStyle = `${colour}${focused ? "26" : "0d"}`;
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.fill();
    ctx.stroke();
    label(ctx, `${COMPONENTS[d.kind].name} ${Math.round(d.confidence * 100)}%`, x, y, colour);
  }

  for (const wire of scene.wires) {
    const colour = STATE_COLOURS[state.states.get(wire.id) ?? "warning"];
    const focused = isActive("wire", wire.id);
    ctx.strokeStyle = colour;
    ctx.lineWidth = focused ? 5 : 3;
    ctx.lineJoin = "round";
    ctx.beginPath();
    wire.path.forEach((point, i) => {
      const [x, y] = toScreen(view, point);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.stroke();
    for (const end of wire.ends) {
      const [x, y] = toScreen(view, end.point);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = end.node ? colour : "#0d0d0c";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = colour;
      ctx.stroke();
    }
  }

  if (state.showPins) drawPins(ctx, scene, pinout, view, state.active);
}

/** Same colours as the power and ground pins. Neither is a status. */
const RAIL_COLOURS = { "+": "#ff6f61", "-": "#8ea6ad" };

function drawRails(ctx: CanvasRenderingContext2D, scene: Scene, view: View) {
  for (const mark of scene.breadboard?.railMarks ?? []) {
    const [ax, ay] = toScreen(view, mark.from);
    const [bx, by] = toScreen(view, mark.to);
    ctx.strokeStyle = `${RAIL_COLOURS[mark.sign]}99`;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, mark.sign, ax, ay, RAIL_COLOURS[mark.sign]);
    label(ctx, mark.sign, bx, by, RAIL_COLOURS[mark.sign]);
  }
}

function drawPins(ctx: CanvasRenderingContext2D, scene: Scene, pinout: Pinout | null, view: View, active: Target | null) {
  const pins = pinPoints(scene, pinout);
  if (pins.length < 2) return;
  const quad = scene.board.quad!;
  const [a, b] = [toScreen(view, quad[0]), toScreen(view, quad[1])];
  const along = Math.atan2(b[1] - a[1], b[0] - a[0]);
  ctx.font = canvasFont("600 10px", "--font-plex-mono");
  for (const { pin, point } of pins) {
    const [x, y] = toScreen(view, point);
    const focused = active?.type === "pin" && active.pin.id === pin.id;
    const colour = pin.role === "power" ? "#ff6f61" : pin.role === "ground" ? "#8ea6ad" : pin.tags?.includes("flash") ? "#ffb938" : "#eadbce";
    ctx.beginPath();
    ctx.arc(x, y, focused ? 5 : 3, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();

    // Labels stand off the header, pointing away from the board.
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(along + (pin.v < 0.5 ? -Math.PI / 2 : Math.PI / 2));
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const width = ctx.measureText(pin.label).width;
    ctx.fillStyle = "#0d0d0ccc";
    ctx.fillRect(6, -6, width + 4, 12);
    ctx.fillStyle = focused ? "#ffffff" : colour;
    ctx.fillText(pin.label, 8, 0.5);
    ctx.restore();
  }
}
