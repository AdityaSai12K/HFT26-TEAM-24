"use client";

import { Crosshair, Eye, EyeOff, RotateCcw } from "lucide-react";
import { COMPONENTS, KIND_OPTIONS } from "@/lib/knowledge";
import { PINOUTS } from "@/lib/pinouts";
import type { BoardEstimate, BoardId, ComponentKind, Detection } from "@/lib/types";
import { Select } from "./ui";

const ADDABLE: ComponentKind[] = ["led", "resistor", "button", "capacitor"];

interface Props {
  estimate: BoardEstimate | null;
  boardId: BoardId | null;
  override: BoardId | null;
  aligned: boolean;
  showPins: boolean;
  selected: Detection | null;
  canAddPart: boolean;
  onAddPart: (kind: ComponentKind) => void;
  onBoard: (board: BoardId | null) => void;
  onAlign: () => void;
  onClearAlign: () => void;
  onTogglePins: () => void;
  onKind: (kind: ComponentKind) => void;
}

export function BoardBar(props: Props) {
  const { estimate, boardId, override, aligned, showPins, selected } = props;
  const detected = estimate?.id ? PINOUTS[estimate.id].name : "No board identified";

  return (
    <div className="panel flex flex-wrap items-center gap-x-3 gap-y-2 p-2">
      <span className="field inline-flex items-center gap-1.5 px-2 py-1 text-xs" data-testid="board-badge" title={estimate?.evidence.join(". ")}>
        <span className={`size-2 ${estimate?.id ? "bg-ok" : "bg-muted"}`} />
        {detected}
        {estimate?.id && <span className="font-mono text-muted">{Math.round(estimate.confidence * 100)}%</span>}
      </span>

      <Select label="Board" value={override ?? ""} onChange={(value) => props.onBoard((value || null) as BoardId | null)}>
        <option value="">Auto</option>
        {Object.values(PINOUTS).map((pinout) => (
          <option key={pinout.id} value={pinout.id}>
            {pinout.name}
          </option>
        ))}
      </Select>

      <button type="button" className="btn" onClick={props.onAlign} disabled={!boardId}>
        <Crosshair size={13} aria-hidden />
        {aligned ? "Realign pins" : "Align pins"}
      </button>
      {aligned && (
        <>
          <button type="button" className="btn" onClick={props.onTogglePins} aria-pressed={showPins}>
            {showPins ? <EyeOff size={13} aria-hidden /> : <Eye size={13} aria-hidden />}
            Pin labels
          </button>
          <button type="button" className="btn" onClick={props.onClearAlign}>
            <RotateCcw size={13} aria-hidden />
            Clear
          </button>
        </>
      )}

      <Select label="Add part" value="" disabled={!props.canAddPart} onChange={(value) => value && props.onAddPart(value as ComponentKind)}>
        <option value="">{props.canAddPart ? "Missed by the camera?" : "Needs a breadboard"}</option>
        {ADDABLE.map((kind) => (
          <option key={kind} value={kind}>
            {COMPONENTS[kind].name}
          </option>
        ))}
      </Select>

      <div className="ml-auto">
        <Select label={selected ? `Selected: ${COMPONENTS[selected.kind].name}` : "Component"} value={selected?.kind ?? ""} disabled={!selected} onChange={(value) => props.onKind(value as ComponentKind)}>
          {!selected && <option value="">Select a box first</option>}
          {KIND_OPTIONS.map((option) => (
            <option key={option.kind} value={option.kind}>
              {option.name}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}
