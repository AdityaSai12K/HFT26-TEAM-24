import { nodeName } from "../alignment";
import type { BoardId, Pinout, RuleResult, Scene } from "../types";

/** The only facts the assistant may use. Sent with every question. */
export interface ChatContext {
  boardId: BoardId | null;
  aligned: boolean;
  detections: { id: string; kind: string; confidence: number; box: number[]; legs: (string | null)[] }[];
  wires: { id: string; color: string; from: string; to: string }[];
  rules: Pick<RuleResult, "rule" | "title" | "status" | "severity" | "reason" | "fix">[];
}

export function buildContext(scene: Scene | null, boardId: BoardId | null, pinout: Pinout | null, results: RuleResult[]): ChatContext {
  return {
    boardId,
    aligned: Boolean(scene?.board.quad),
    detections: (scene?.detections ?? []).slice(0, 40).map((d) => ({
      id: d.id,
      kind: d.kind,
      confidence: Number(d.confidence.toFixed(2)),
      box: d.box.map(Math.round),
      legs: d.terminals.map((t) => t.node),
    })),
    wires: (scene?.wires ?? []).slice(0, 40).map((w) => ({
      id: w.id,
      color: w.color,
      from: nodeName(w.ends[0].node, pinout, scene?.breadboard),
      to: nodeName(w.ends[1].node, pinout, scene?.breadboard),
    })),
    rules: results.map(({ rule, title, status, severity, reason, fix }) => ({ rule, title, status, severity, reason, fix })),
  };
}
