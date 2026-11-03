"use client";

import { AlertTriangle, CheckCircle2, CircleHelp, CircleSlash, MousePointerClick, ShieldAlert } from "lucide-react";
import { nodeName } from "@/lib/alignment";
import { COMPONENTS } from "@/lib/knowledge";
import type { Target } from "@/lib/overlay";
import { PROJECTS } from "@/lib/pinouts";
import type { Detection, DiagnosticState, HealthStatus, Pinout, RuleResult, Scene, StepResult } from "@/lib/types";
import { Panel, Select, StatusBadge } from "./ui";

const HEALTH = {
  ok: { label: "All checks passed", detail: "Automated checks only. Inspect the wiring yourself before powering up.", style: "text-ok border-ok/60 bg-ok/10", icon: CheckCircle2 },
  warning: { label: "Needs a manual check", detail: "Some connections could not be confirmed.", style: "text-warn border-warn/60 bg-warn/10", icon: AlertTriangle },
  critical: { label: "Critical issue", detail: "Disconnect power before changing the wiring.", style: "text-bad border-bad bg-bad/15", icon: ShieldAlert },
  unknown: { label: "Not inspected", detail: "Load an image or start the camera.", style: "text-muted border-line bg-raised", icon: CircleSlash },
} as const;

export function HealthCard({ health, scene, results }: { health: HealthStatus; scene: Scene | null; results: RuleResult[] }) {
  const { label, detail, style, icon: Icon } = HEALTH[health];
  const fails = results.filter((r) => r.status === "fail").length;
  const unclear = results.filter((r) => r.status === "unclear").length;
  const parts = (scene?.detections.length ?? 0) + (scene?.wires.length ?? 0);
  return (
    <section className={`border p-3 ${style}`} data-testid="health-card" data-health={health}>
      <div className="flex items-center gap-2">
        <Icon size={20} aria-hidden />
        <p className="font-display text-2xl leading-none tracking-wide uppercase">{label}</p>
      </div>
      <p className="mt-1 text-xs text-ink">{detail}</p>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
        <Stat label="Detected" value={parts} />
        <Stat label="Failed" value={fails} />
        <Stat label="To check" value={unclear} />
      </dl>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-current/25 bg-canvas/60 py-1">
      <dd className="font-display text-3xl leading-none text-ink tabular-nums">{value}</dd>
      <dt className="label text-muted">{label}</dt>
    </div>
  );
}

/** What this frame produced, so it is plain that the result came from the image. */
export function TracePanel({ scene, pinout, onSelect }: { scene: Scene | null; pinout: Pinout | null; onSelect: (target: Target) => void }) {
  if (!scene) return null;
  const board = scene.breadboard;
  const rails = board?.railMarks?.length ? "rails read from the print" : "rail signs not readable";
  const facts = [board ? `${board.columns} columns, ${rails}` : "No breadboard found", `${scene.wires.length} wire(s)`];
  if (scene.timings?.total) facts.push(`${Math.round(scene.timings.total)} ms`);
  const placed = scene.detections.filter((d) => d.terminals.length >= 2);

  return (
    <Panel title="Traced from this image">
      <p className="text-xs text-muted" data-testid="trace-facts">
        {facts.join(" // ")}
      </p>
      {(scene.wires.length > 0 || placed.length > 0) && (
        <ul className="mt-2 space-y-1 text-xs" data-testid="trace-list">
          {scene.wires.map((wire) => (
            <li key={wire.id}>
              <button type="button" onClick={() => onSelect({ type: "wire", id: wire.id })} className="w-full text-left text-ink hover:text-accent">
                <span className="text-muted">{wire.color}:</span> {nodeName(wire.ends[0].node, pinout, board)} to {nodeName(wire.ends[1].node, pinout, board)}
              </button>
            </li>
          ))}
          {placed.map((part) => (
            <li key={part.id}>
              <button type="button" onClick={() => onSelect({ type: "detection", id: part.id })} className="w-full text-left text-ink hover:text-accent">
                <span className="text-muted">{COMPONENTS[part.kind].name.toLowerCase()}:</span> {part.terminals.map((t) => nodeName(t.node, pinout, board)).join(" to ")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

interface InspectorProps {
  target: Target | null;
  scene: Scene | null;
  pinout: Pinout | null;
  states: Map<string, DiagnosticState>;
  results: RuleResult[];
  canMarkLegs: boolean;
  onMarkLegs: (detection: Detection) => void;
  onRemovePart: (detection: Detection) => void;
}

const DIAGNOSTIC_TEXT: Record<DiagnosticState, string> = { ok: "OK", warning: "Check manually", critical: "Issue detected" };
const DIAGNOSTIC_STYLE: Record<DiagnosticState, string> = { ok: "text-ok", warning: "text-warn", critical: "text-bad" };

export function Inspector({ target, scene, pinout, states, results, canMarkLegs, onMarkLegs, onRemovePart }: InspectorProps) {
  return (
    <Panel title="Inspector">
      {!target || !scene ? (
        <p className="flex items-center gap-2 text-xs text-muted">
          <MousePointerClick size={14} aria-hidden />
          Hover or click a box, wire or pin.
        </p>
      ) : target.type === "pin" ? (
        <PinDetails target={target} pinout={pinout} />
      ) : (
        <ItemDetails target={target} scene={scene} pinout={pinout} states={states} results={results} canMarkLegs={canMarkLegs} onMarkLegs={onMarkLegs} onRemovePart={onRemovePart} />
      )}
    </Panel>
  );
}

function PinDetails({ target, pinout }: { target: Extract<Target, { type: "pin" }>; pinout: Pinout | null }) {
  const { pin } = target;
  return (
    <div className="space-y-1 text-xs">
      <p className="font-display text-xl leading-none tracking-wide text-ink uppercase">Pin {pin.label}</p>
      <p className="text-muted">{pin.functions.join(", ") || "No function"}</p>
      <p className="text-muted">
        {pinout?.name}, header {pin.header}, position {pin.position}
      </p>
      {pin.tags?.includes("flash") && <p className="text-bad">Reserved for the SPI flash. Do not connect.</p>}
      {pin.tags?.includes("strapping") && <p className="text-warn">Strapping pin. It can affect boot.</p>}
      {pin.tags?.includes("input_only") && <p className="text-warn">Input only, with no internal pull resistors.</p>}
    </div>
  );
}

function ItemDetails({ target, scene, pinout, states, results, canMarkLegs, onMarkLegs, onRemovePart }: Omit<InspectorProps, "target" | "scene"> & { target: Exclude<Target, { type: "pin" }>; scene: Scene }) {
  const state = states.get(target.id) ?? "warning";
  const related = results.filter((r) => r.involves.includes(target.id));
  const wire = target.type === "wire" ? scene.wires.find((w) => w.id === target.id) : undefined;
  const detection = target.type === "detection" ? scene.detections.find((d) => d.id === target.id) : undefined;
  if (!wire && !detection) return null;
  const facts = detection ? COMPONENTS[detection.kind] : COMPONENTS.jumper_wire;
  const isPart = detection && ["led", "resistor", "capacitor", "button"].includes(detection.kind);

  return (
    <div className="space-y-2 text-xs" data-testid="inspector-details">
      <div>
        <p className="font-display text-xl leading-none tracking-wide text-ink uppercase">{wire ? `${wire.color} wire` : facts.name}</p>
        <p className={DIAGNOSTIC_STYLE[state]}>{DIAGNOSTIC_TEXT[state]}</p>
      </div>
      <p className="text-muted">{facts.role}</p>
      {facts.features.length > 0 && (
        <ul className="list-inside list-disc text-muted">
          {facts.features.map((feature) => (
            <li key={feature}>{feature}</li>
          ))}
        </ul>
      )}
      {facts.ratings && <p className="text-muted">Rating: {facts.ratings}</p>}
      {detection && (
        <p className="text-muted">
          Confidence {Math.round(detection.confidence * 100)}%, from {detection.source}
        </p>
      )}
      {wire && (
        <p className="text-muted">
          {nodeName(wire.ends[0].node, pinout, scene.breadboard)} to {nodeName(wire.ends[1].node, pinout, scene.breadboard)}
        </p>
      )}
      {isPart && detection && (
        <>
          <p className="text-muted">Legs: {detection.terminals.length ? detection.terminals.map((t) => nodeName(t.node, pinout, scene.breadboard)).join(" and ") : "not resolved"}</p>
          {canMarkLegs && (
            <button type="button" onClick={() => onMarkLegs(detection)} className="btn">
              Mark legs on the image
            </button>
          )}
          {detection.id.startsWith("added-") && (
            <button type="button" onClick={() => onRemovePart(detection)} className="btn">
              Remove this part
            </button>
          )}
        </>
      )}
      {related.length > 0 && (
        <ul className="space-y-1.5 border-t border-line pt-2">
          {related.map((r) => (
            <li key={`${r.rule}${r.reason}${r.involves.join()}`} className="flex items-start gap-2">
              <StatusBadge status={r.status} />
              <span className="text-muted">{r.reason}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted">Tip: {facts.tip}</p>
    </div>
  );
}

interface GuideProps {
  guide: string[];
  results: RuleResult[];
  project: string;
  steps: StepResult[];
  onProject: (id: string) => void;
}

export function GuidePanel({ guide, results, project, steps, onProject }: GuideProps) {
  return (
    <>
      <Panel title="Rule checks">
        {results.length === 0 ? (
          <p className="text-xs text-muted">No checks have run.</p>
        ) : (
          <ul className="space-y-2">
            {[...results]
              .sort((a, b) => rank(a) - rank(b))
              .map((r) => (
                <li key={`${r.rule}${r.reason}${r.involves.join()}`} className="text-xs" data-testid="rule-result" data-rule={r.rule} data-status={r.status}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium text-ink">{r.title}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <p className="mt-0.5 text-muted">{r.reason}</p>
                </li>
              ))}
          </ul>
        )}
      </Panel>

      <Panel title="Repair guide">
        {guide.length === 0 ? (
          <p className="flex items-center gap-2 text-xs text-muted">
            <CircleHelp size={14} aria-hidden />
            No repair steps needed from the automated checks.
          </p>
        ) : (
          <ol className="list-inside list-decimal space-y-1.5 text-xs text-ink marker:text-muted" data-testid="repair-guide">
            {guide.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel
        title="Expected circuit"
        action={
          <Select label="" value={project} onChange={onProject}>
            <option value="">None</option>
            {PROJECTS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        }
      >
        {steps.length === 0 ? (
          <p className="text-xs text-muted">Choose a project to verify it step by step.</p>
        ) : (
          <ol className="space-y-2" data-testid="project-steps">
            {steps.map((step, index) => (
              <li key={step.id} className="text-xs" data-status={step.status}>
                <div className="flex items-start justify-between gap-2">
                  <span className="text-ink">
                    {index + 1}. {step.text}
                  </span>
                  <StatusBadge status={step.status} />
                </div>
                {step.status !== "pass" && <p className="mt-0.5 text-muted">{step.reason}</p>}
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </>
  );
}

function rank(r: RuleResult): number {
  const status = { fail: 0, unclear: 1, pass: 2 }[r.status];
  return status * 2 + (r.severity === "critical" ? 0 : 1);
}
