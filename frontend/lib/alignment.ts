import type { Breadboard, Pinout, Point, Quad } from "./types";

/** Allowed disagreement between the two scales the three clicks imply. */
const MAX_SCALE_RATIO = 1.25;

export type AlignResult = { ok: true; quad: Quad } | { ok: false; error: string };

/**
 * Board corners from three clicked pins. The clicks are checked against the
 * board's real geometry, so a mis-click is rejected instead of producing a
 * confidently wrong pin map.
 */
export function alignFromClicks(pinout: Pinout, clicks: [Point, Point, Point]): AlignResult {
  const { width, height } = pinout.outlineMm;
  const mm = pinout.alignPins.map((id) => {
    const pin = pinout.pins.find((p) => p.id === id);
    if (!pin) throw new Error(`Alignment pin ${id} is not in the ${pinout.id} pinout`);
    return [pin.u * width, pin.v * height] as Point;
  });

  const handedness = cross(sub(mm[1], mm[0]), sub(mm[2], mm[0]));
  const clicked = cross(sub(clicks[1], clicks[0]), sub(clicks[2], clicks[0]));
  if (Math.abs(clicked) < 1) return { ok: false, error: "Those points are in a line. Click the three pins as prompted." };
  if (Math.sign(handedness) !== Math.sign(clicked)) {
    return { ok: false, error: "That order is mirrored, so one of the pins is wrong. Try again." };
  }

  const scales = [0, 1].map((i) => {
    const a = i === 0 ? 1 : 2;
    return dist(clicks[0], clicks[a]) / dist(mm[0], mm[a]);
  });
  const ratio = Math.max(...scales) / Math.min(...scales);
  if (ratio > MAX_SCALE_RATIO) {
    return { ok: false, error: "Those clicks do not fit this board's shape. Check the board selection and try again." };
  }

  const toImage = (x: number, y: number): Point => {
    const determinant = handedness;
    const [dx1, dy1] = sub(mm[1], mm[0]);
    const [dx2, dy2] = sub(mm[2], mm[0]);
    const s = ((x - mm[0][0]) * dy2 - (y - mm[0][1]) * dx2) / determinant;
    const t = ((y - mm[0][1]) * dx1 - (x - mm[0][0]) * dy1) / determinant;
    return [
      clicks[0][0] + s * (clicks[1][0] - clicks[0][0]) + t * (clicks[2][0] - clicks[0][0]),
      clicks[0][1] + s * (clicks[1][1] - clicks[0][1]) + t * (clicks[2][1] - clicks[0][1]),
    ];
  };
  return { ok: true, quad: [toImage(0, 0), toImage(width, 0), toImage(width, height), toImage(0, height)] };
}

const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0];
const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Image position of a board-space (u, v) point, for drawing pin labels. */
export function projectUv(quad: Quad, u: number, v: number): Point {
  const [a, b, c, d] = quad;
  const top: Point = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  const bottom: Point = [d[0] + (c[0] - d[0]) * u, d[1] + (c[1] - d[1]) * u];
  return [top[0] + (bottom[0] - top[0]) * v, top[1] + (bottom[1] - top[1]) * v];
}

const ROWS = [1.5, 5.5] as const;

/** Breadboard node under an image point, or null when it is not close to a hole. */
export function breadboardNodeAt(board: Breadboard, point: Point): string | null {
  const m = board.toBoard;
  const w = m[2][0] * point[0] + m[2][1] * point[1] + m[2][2];
  const x = (m[0][0] * point[0] + m[0][1] * point[1] + m[0][2]) / w;
  const y = (m[1][0] * point[0] + m[1][1] * point[1] + m[1][2]) / w;
  const side = y < 0 ? "top" : "bottom";
  const across = Math.abs(y);
  for (const [name, offset] of Object.entries(board.rails[side])) {
    if (Math.abs(across - offset) <= 0.5) return `rail:${side}-${name}`;
  }
  const column = Math.round(x + (board.columns - 1) / 2);
  if (column < 0 || column >= board.columns || across < ROWS[0] - 0.75 || across > ROWS[1] + 0.75) return null;
  return `bb:${column + 1}:${side}`;
}

/** The sign printed beside a rail, when the photo showed it. */
export function railSign(node: string, board: Breadboard | null | undefined): "+" | "-" | null {
  return board?.railMarks?.find((mark) => mark.node === node)?.sign ?? null;
}

/** Readable name for an electrical node. */
export function nodeName(node: string | null, pinout: Pinout | null, board?: Breadboard | null): string {
  if (!node) return "unresolved";
  const [kind, a, b] = node.split(":");
  if (kind === "pin") return pinout?.pins.find((p) => p.id === a)?.label ?? a;
  if (kind === "bb") return `column ${a} (${b} half)`;
  if (kind === "rail") {
    const sign = railSign(node, board);
    return `${a.replace("-", " ")}${sign ? ` ${sign}` : ""} rail`;
  }
  return node;
}
