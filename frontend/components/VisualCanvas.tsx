"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import { nodeName } from "@/lib/alignment";
import { COMPONENTS } from "@/lib/knowledge";
import { canvasFont, drawOverlay, fitView, hitTest, STATE_COLOURS, toImage, toScreen, type Target, type View } from "@/lib/overlay";
import type { DiagnosticState, Pinout, Point, Scene } from "@/lib/types";

export interface MediaSource {
  kind: "image" | "video" | "camera";
  url?: string;
}

interface Props {
  media: MediaSource | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  scene: Scene | null;
  pinout: Pinout | null;
  states: Map<string, DiagnosticState>;
  showPins: boolean;
  selected: Target | null;
  /** While set, clicks pick a point for this prompt instead of selecting. */
  capture: { prompt: string; points: Point[] } | null;
  busy: boolean;
  onHover: (target: Target | null) => void;
  onSelect: (target: Target | null) => void;
  onCapture: (point: Point) => void;
}

export function VisualCanvas(props: Props) {
  const { media, videoRef, scene, pinout, states, showPins, selected, capture, busy } = props;
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hovered, setHovered] = useState<Target | null>(null);
  const [cursor, setCursor] = useState<Point>([0, 0]);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const view: View | null = scene ? fitView(scene.imageSize, size.width, size.height) : null;
  const active = hovered ?? selected;

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    if (!element || !ctx) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = size.width * ratio;
    element.height = size.height * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    if (!scene || !view) return;
    drawOverlay(ctx, scene, pinout, view, { states, active, showPins });
    for (const [index, point] of (capture?.points ?? []).entries()) {
      const [x, y] = toScreen(view, point);
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.strokeStyle = "#0d0d0c";
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.strokeStyle = "#eadbce";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#0d0d0c";
      ctx.fillRect(x + 8, y - 20, 13, 16);
      ctx.fillStyle = "#eadbce";
      ctx.font = canvasFont("700 11px", "--font-plex-mono");
      ctx.fillText(String(index + 1), x + 11, y - 8);
    }
  }, [scene, pinout, states, active, showPins, size, view, capture]);

  const imagePoint = useCallback(
    (event: MouseEvent): Point | null => {
      if (!view || !box.current) return null;
      const rect = box.current.getBoundingClientRect();
      return toImage(view, [event.clientX - rect.left, event.clientY - rect.top]);
    },
    [view],
  );

  const onMove = (event: MouseEvent) => {
    const point = imagePoint(event);
    if (!point || !scene || !view || !box.current) return;
    const rect = box.current.getBoundingClientRect();
    setCursor([event.clientX - rect.left, event.clientY - rect.top]);
    const target = capture ? null : hitTest(point, scene, pinout, view, showPins);
    setHovered(target);
    props.onHover(target);
  };

  const onClick = (event: MouseEvent) => {
    const point = imagePoint(event);
    if (!point || !scene || !view) return;
    if (capture) props.onCapture(point);
    else props.onSelect(hitTest(point, scene, pinout, view, showPins));
  };

  return (
    <div
      ref={box}
      data-testid="visual-canvas"
      className={`relative min-h-[320px] flex-1 overflow-hidden border border-canvas bg-black ${capture ? "cursor-crosshair" : ""}`}
      onMouseMove={onMove}
      onMouseLeave={() => {
        setHovered(null);
        props.onHover(null);
      }}
      onClick={onClick}
    >
      {media?.kind === "image" && media.url && (
        // eslint-disable-next-line @next/next/no-img-element -- A blob URL, which next/image cannot optimise.
        <img src={media.url} alt="Inspected hardware" className="absolute inset-0 size-full object-contain" />
      )}
      <video
        ref={videoRef}
        muted
        playsInline
        loop={media?.kind === "video"}
        className={`absolute inset-0 size-full object-contain ${media?.kind === "video" || media?.kind === "camera" ? "" : "hidden"}`}
      />
      <canvas ref={canvas} className="pointer-events-none absolute inset-0 size-full" />

      {!media && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted">
          {/* eslint-disable-next-line @next/next/no-img-element -- A static SVG, which next/image cannot optimise. */}
          <img src="/crt-reach.svg" alt="" className="min-h-0 w-full max-w-xl flex-1" />
          <p className="font-display text-3xl leading-none tracking-wide text-ink uppercase">Nothing to inspect yet</p>
          <p className="max-w-sm text-xs">Upload a straight-down photo of your circuit, start the camera, or load a sample scene.</p>
        </div>
      )}

      {capture && (
        <div className="label absolute top-2 left-1/2 -translate-x-1/2 bg-accent px-3 py-1 text-canvas">
          {capture.prompt}
        </div>
      )}
      {busy && <div className="label cursor-blink absolute top-2 right-2 bg-canvas/80 px-2 py-1 text-muted">Analysing</div>}

      {hovered && scene && <Tooltip target={hovered} scene={scene} pinout={pinout} states={states} at={cursor} bounds={size} />}
    </div>
  );
}

function Tooltip({ target, scene, pinout, states, at, bounds }: { target: Target; scene: Scene; pinout: Pinout | null; states: Map<string, DiagnosticState>; at: Point; bounds: { width: number; height: number } }) {
  const body = tooltipBody(target, scene, pinout, states);
  if (!body) return null;
  const width = 256;
  const left = Math.min(at[0] + 14, bounds.width - width - 8);
  const top = Math.min(at[1] + 14, bounds.height - 120);
  return (
    <div role="tooltip" className="pointer-events-none absolute z-10 border border-accent bg-panel/95 p-2 text-xs" style={{ left, top, width }}>
      <p className="flex items-center gap-1.5 font-semibold text-ink">
        {body.colour && <span className="size-2" style={{ background: body.colour }} />}
        {body.title}
      </p>
      {body.lines.map((line) => (
        <p key={line} className="mt-1 text-muted">
          {line}
        </p>
      ))}
    </div>
  );
}

function tooltipBody(target: Target, scene: Scene, pinout: Pinout | null, states: Map<string, DiagnosticState>) {
  if (target.type === "pin") {
    return { title: `Pin ${target.pin.label}`, colour: undefined, lines: [target.pin.functions.join(", ") || "No function", `Header ${target.pin.header}, position ${target.pin.position}`] };
  }
  const colour = STATE_COLOURS[states.get(target.id) ?? "warning"];
  if (target.type === "wire") {
    const wire = scene.wires.find((w) => w.id === target.id);
    if (!wire) return null;
    return {
      title: `${wire.color[0].toUpperCase()}${wire.color.slice(1)} wire`,
      colour,
      lines: [`${nodeName(wire.ends[0].node, pinout, scene.breadboard)} to ${nodeName(wire.ends[1].node, pinout, scene.breadboard)}`, `Trace confidence ${Math.round(wire.confidence * 100)}%`],
    };
  }
  const detection = scene.detections.find((d) => d.id === target.id);
  if (!detection) return null;
  const facts = COMPONENTS[detection.kind];
  return { title: facts.name, colour, lines: [`Confidence ${Math.round(detection.confidence * 100)}%`, facts.role, `Tip: ${facts.tip}`] };
}
