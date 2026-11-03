"use client";

import { Activity, CircleAlert, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { alignFromClicks, breadboardNodeAt } from "@/lib/alignment";
import { detect, loadSample, visionHealthy } from "@/lib/api";
import { Alarm } from "@/lib/audio";
import { buildContext } from "@/lib/chat/context";
import { applyOverrides, buildGuide, diagnosticStates, overallHealth } from "@/lib/diagnostics";
import { detectHazards, hazardConfidence, HazardMonitor } from "@/lib/hazards";
import type { Target } from "@/lib/overlay";
import { PINOUTS, PROJECTS } from "@/lib/pinouts";
import { evaluateRules, visibleScene } from "@/lib/rules/engine";
import { evaluateProject } from "@/lib/rules/project";
import type { BoardId, Box, ComponentKind, Detection, Hazard, Override, Point, Quad, Scene, Terminal } from "@/lib/types";
import { useLiveStream } from "@/lib/useLiveStream";
import { BoardBar } from "./BoardBar";
import { ChatDrawer } from "./ChatDrawer";
import { GuidePanel, HealthCard, Inspector, TracePanel } from "./Diagnostics";
import { HazardOverlay } from "./HazardOverlay";
import { InputBar, type SampleInfo } from "./InputBar";
import { CrtMark } from "./ui";
import { VisualCanvas, type MediaSource } from "./VisualCanvas";

const DEFAULT_THRESHOLD = 0.3;
const REPLAY_FRAMES = ["approach-far", "approach-near", "approach-near", "approach-touch", "approach-touch"];
const REPLAY_FRAME_MS = 900;
// Decoration only. Kept free of pin and voltage names so it cannot be read as a reading.
const DATA_STREAM = "data stream // VISION FF--;---A8-R-frame: --> 2M-S--GUARD--/ --_BFR-P-0xB4-----";

/** Half the size of the box drawn around a part the user adds, in image pixels. */
const ADDED_PART_MARGIN = 14;

type Capture = { mode: "align" | "legs" | "add"; points: Point[]; detection?: Detection; kind?: ComponentKind };

export function Dashboard() {
  const [media, setMedia] = useState<MediaSource | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [rawScene, setRawScene] = useState<Scene | null>(null);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [boardOverride, setBoardOverride] = useState<BoardId | null>(null);
  const [quad, setQuad] = useState<Quad | null>(null);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [showPins, setShowPins] = useState(true);
  const [hovered, setHovered] = useState<Target | null>(null);
  const [selected, setSelected] = useState<Target | null>(null);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [project, setProject] = useState("");
  const [samples, setSamples] = useState<SampleInfo[]>([]);
  const [sample, setSample] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [hazards, setHazards] = useState<Hazard[]>([]);
  const [alarmSilent, setAlarmSilent] = useState(false);
  const [inspection, setInspection] = useState(0);

  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const alarm = useRef<Alarm | null>(null);
  const monitor = useRef(new HazardMonitor());
  const distances = useRef(new Map<string, number>());
  const requestId = useRef(0);

  useEffect(() => {
    void fetch("/samples/index.json").then((r) => r.json()).then(setSamples).catch(() => setSamples([]));
    void visionHealthy().then(setOnline);
  }, []);

  const boardId = boardOverride ?? rawScene?.board.id ?? null;
  const pinout = boardId ? PINOUTS[boardId] : null;

  /** Corrected by the user, but not filtered by the slider. The alarm reads this. */
  const fullScene = useMemo<Scene | null>(
    () => (rawScene ? { ...rawScene, detections: applyOverrides(rawScene.detections, overrides), board: { ...rawScene.board, quad: rawScene.board.quad ?? quad } } : null),
    [rawScene, overrides, quad],
  );
  const scene = useMemo(() => (fullScene ? visibleScene(fullScene, threshold, fullScene.detections) : null), [fullScene, threshold]);
  const evaluation = useMemo(() => (scene ? evaluateRules(scene, pinout) : null), [scene, pinout]);
  const results = useMemo(() => evaluation?.results ?? [], [evaluation]);
  const states = useMemo(() => (scene ? diagnosticStates(scene, results) : new Map()), [scene, results]);
  const health = scene ? overallHealth(scene, results) : "unknown";
  const guide = useMemo(() => buildGuide(results), [results]);
  const steps = useMemo(() => {
    const chosen = PROJECTS.find((p) => p.id === project);
    return chosen && evaluation ? evaluateProject(chosen, evaluation.graph, results) : [];
  }, [project, evaluation, results]);
  const context = useMemo(() => buildContext(scene, boardId, pinout, results), [scene, boardId, pinout, results]);

  /** Feeds a frame through the alarm. It always gets the scene before the slider. */
  const watchHazards = useCallback((frame: Scene, board: BoardId | null, frameOverrides: Override[]) => {
    const corrected = { ...frame, detections: applyOverrides(frame.detections, frameOverrides) };
    const { hazards: found, distances: next } = detectHazards(corrected, board ? PINOUTS[board] : null, distances.current);
    distances.current = next;
    const firing = monitor.current.update(found, (h) => hazardConfidence(h, corrected));
    setHazards(firing);
    if (firing.length) {
      alarm.current?.start();
      setAlarmSilent(!alarm.current?.ready);
    } else {
      alarm.current?.stop();
    }
  }, []);

  const onLiveScene = useCallback(
    (frame: Scene) => {
      setRawScene(frame);
      watchHazards(frame, boardOverride ?? frame.board.id, overrides);
    },
    [boardOverride, overrides, watchHazards],
  );

  const live = useLiveStream(video, { board: boardOverride, quad }, onLiveScene);

  const clearInspection = useCallback(() => {
    requestId.current += 1;
    setInspection((value) => value + 1);
    setOverrides([]);
    setQuad(null);
    setHovered(null);
    setSelected(null);
    setCapture(null);
    setError(null);
    setNotice(null);
    setHazards([]);
    alarm.current?.stop();
    monitor.current.reset();
    distances.current = new Map();
  }, []);

  const stopSources = useCallback(() => {
    live.stop();
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (video.current) {
      video.current.pause();
      video.current.srcObject = null;
      video.current.removeAttribute("src");
    }
  }, [live]);

  const runDetection = useCallback(async (image: Blob, board: BoardId | null, corners: Quad | null) => {
    const id = ++requestId.current;
    setBusy(true);
    setError(null);
    try {
      const result = await detect(image, { board, quad: corners });
      if (id === requestId.current) setRawScene(result);
      setOnline(true);
    } catch (failure) {
      if (id === requestId.current) setError((failure as Error).message);
      setOnline(false);
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }, []);

  const onFile = useCallback(
    (file: File) => {
      stopSources();
      clearInspection();
      setSample("");
      setRawScene(null);
      const url = URL.createObjectURL(file);
      if (file.type.startsWith("video/")) {
        setBlob(null);
        setMedia({ kind: "video", url });
        const element = video.current;
        if (element) {
          element.src = url;
          void element.play();
        }
        alarm.current ??= new Alarm();
        alarm.current.arm();
        live.start();
      } else {
        setBlob(file);
        setMedia({ kind: "image", url });
        void runDetection(file, boardOverride, null);
      }
    },
    [boardOverride, clearInspection, live, runDetection, stopSources],
  );

  const onSample = useCallback(
    async (id: string) => {
      stopSources();
      clearInspection();
      setSample(id);
      setBlob(null);
      if (!id) {
        setMedia(null);
        setRawScene(null);
        return;
      }
      const loaded = await loadSample(id);
      setRawScene(loaded.scene);
      setMedia({ kind: "image", url: loaded.url });
    },
    [clearInspection, stopSources],
  );

  const toggleWebcam = useCallback(async () => {
    if (media?.kind === "camera") {
      stopSources();
      clearInspection();
      setMedia(null);
      setRawScene(null);
      return;
    }
    stopSources();
    clearInspection();
    setSample("");
    setBlob(null);
    setRawScene(null);
    // Armed here because the browser only unlocks audio inside a click.
    alarm.current ??= new Alarm();
    alarm.current.arm();
    try {
      const media_ = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      stream.current = media_;
      setMedia({ kind: "camera" });
      if (video.current) {
        video.current.srcObject = media_;
        await video.current.play();
      }
      live.start();
    } catch (failure) {
      setError(`The camera could not start: ${(failure as Error).message}`);
    }
  }, [clearInspection, live, media, stopSources]);

  const replayHazard = useCallback(async () => {
    stopSources();
    clearInspection();
    alarm.current ??= new Alarm();
    alarm.current.arm();
    setSample("");
    setBlob(null);
    setReplaying(true);
    for (const id of REPLAY_FRAMES) {
      const loaded = await loadSample(id);
      setRawScene(loaded.scene);
      setMedia({ kind: "image", url: loaded.url });
      watchHazards(loaded.scene, loaded.scene.board.id, []);
      await new Promise((resolve) => setTimeout(resolve, REPLAY_FRAME_MS));
    }
    setReplaying(false);
  }, [clearInspection, stopSources, watchHazards]);

  const onBoard = useCallback(
    (board: BoardId | null) => {
      setBoardOverride(board);
      setQuad(null); // A map made for one board is meaningless on another.
      if (blob) void runDetection(blob, board, null);
    },
    [blob, runDetection],
  );

  const onCapturePoint = useCallback(
    (point: Point) => {
      if (!capture) return;
      const points = [...capture.points, point];

      if (capture.mode === "align" && pinout) {
        if (points.length < 3) return setCapture({ ...capture, points });
        setCapture(null);
        const result = alignFromClicks(pinout, points as [Point, Point, Point]);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setError(null);
        setNotice("Pins aligned. Wires reaching the board are now checked.");
        setQuad(result.quad);
        if (blob) void runDetection(blob, boardId, result.quad);
        return;
      }

      if (capture.mode === "legs" || capture.mode === "add") {
        if (points.length < 2) return setCapture({ ...capture, points });
        setCapture(null);
        const board = rawScene?.breadboard;
        const terminals: Terminal[] = points.map((p) => ({ point: p, node: board ? breadboardNodeAt(board, p) : null, confidence: 1 }));
        if (terminals.some((t) => !t.node)) {
          setError("One of those clicks was not on a breadboard hole. Try again.");
          return;
        }
        setError(null);
        if (capture.mode === "legs" && capture.detection) {
          const { box, kind } = capture.detection;
          setOverrides((list) => [...list.filter((o) => o.box !== box), { ...list.find((o) => o.box === box), box, kind, terminals }]);
        } else if (capture.kind) {
          const [[ax, ay], [bx, by]] = points;
          const box: Box = [Math.min(ax, bx) - ADDED_PART_MARGIN, Math.min(ay, by) - ADDED_PART_MARGIN, Math.max(ax, bx) + ADDED_PART_MARGIN, Math.max(ay, by) + ADDED_PART_MARGIN];
          const { kind } = capture;
          setOverrides((list) => [...list, { box, kind, terminals, added: true }]);
        }
      }
    },
    [blob, boardId, capture, pinout, rawScene, runDetection],
  );

  const onKind = useCallback(
    (kind: ComponentKind) => {
      const detection = selected?.type === "detection" ? scene?.detections.find((d) => d.id === selected.id) : null;
      if (detection) setOverrides((list) => [...list.filter((o) => o.box !== detection.box), { ...list.find((o) => o.box === detection.box), box: detection.box, kind, terminals: detection.terminals }]);
    },
    [scene, selected],
  );

  const capturePrompt = useMemo(() => {
    if (!capture) return null;
    if (capture.mode !== "align") return { prompt: `Click the hole for leg ${capture.points.length + 1} of 2`, points: capture.points };
    const pin = pinout?.pins.find((p) => p.id === pinout.alignPins[capture.points.length]);
    return { prompt: `Click pin ${pin?.label} (${capture.points.length + 1} of 3)`, points: capture.points };
  }, [capture, pinout]);

  const liveNow = media?.kind === "camera" || media?.kind === "video";
  const selectedDetection = selected?.type === "detection" ? (scene?.detections.find((d) => d.id === selected.id) ?? null) : null;

  return (
    <div className="flex h-dvh flex-col gap-2 overflow-y-auto p-2 xl:overflow-hidden">
      <div aria-hidden className="ticker hidden tall:block">
        {DATA_STREAM.repeat(4)}
      </div>
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-1 pb-1.5">
        <div className="flex min-w-0 items-center gap-4">
          <h1 aria-label="ELECTRO VISION" className="flex items-center gap-3">
            <span className="text-salmon">
              <CrtMark size={32} />
            </span>
            <span className="font-pixel text-2xl leading-none font-bold whitespace-nowrap text-accent sm:text-[32px]">ELECTRO VISION</span>
          </h1>
          <p className="label hidden truncate text-ink lg:block">Circuit inspection // Wiring hazard alerts</p>
        </div>
        <div className="label flex shrink-0 items-center gap-3 text-muted">
          {liveNow && (
            <span className="inline-flex items-center gap-1.5" data-testid="live-status">
              <Activity size={13} className={live.status === "running" ? "text-ok" : "text-warn"} aria-hidden />
              {live.status === "running" ? `Monitoring at ${live.fps.toFixed(1)} fps` : live.status === "stalled" ? "Not monitoring" : "Starting"}
            </span>
          )}
          {online === false && (
            <span className="inline-flex items-center gap-1.5 text-warn">
              <WifiOff size={13} aria-hidden />
              Vision service offline
            </span>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 xl:flex-row">
        <main className="flex min-h-[560px] min-w-0 flex-1 flex-col gap-2">
          <InputBar samples={samples} sample={sample} threshold={threshold} webcamOn={media?.kind === "camera"} replaying={replaying} onFile={onFile} onWebcam={() => void toggleWebcam()} onSample={(id) => void onSample(id)} onReplay={() => void replayHazard()} onThreshold={setThreshold} />
          {(error || live.error) && (
            <p role="alert" className="flex items-start gap-2 border border-bad bg-bad/15 px-3 py-2 text-xs text-ink">
              <CircleAlert size={14} className="mt-px shrink-0 text-bad" aria-hidden />
              {live.status === "stalled" ? `Hazard monitoring has stopped. ${live.error}` : (error ?? live.error)}
            </p>
          )}
          {notice && !error && <p className="border border-ok/60 bg-ok/10 px-3 py-1.5 text-xs text-ink">{notice}</p>}
          {(sample || replaying) && (
            <p className="border border-line bg-raised px-3 py-1.5 text-xs text-ink" data-testid="simulated-notice">
              Simulated bench: a rendered image with scripted parts. Drop in a real photo or start the camera for a real inspection.
            </p>
          )}
          {!error && rawScene?.warnings.filter((w) => !w.startsWith("Align") || !quad).map((warning) => (
            <p key={warning} className="border border-warn/60 bg-warn/10 px-3 py-1.5 text-xs text-ink">
              {warning}
            </p>
          ))}
          {/* The bezel is padding here, not a border on the canvas, which measures clicks from its own edge. */}
          <div className="crt-bezel relative flex min-h-0 flex-1 p-1.5">
            <VisualCanvas
              media={media}
              videoRef={video}
              scene={scene}
              pinout={pinout}
              states={states}
              showPins={showPins && Boolean(scene?.board.quad)}
              selected={selected}
              capture={capturePrompt}
              busy={busy}
              onHover={setHovered}
              onSelect={setSelected}
              onCapture={onCapturePoint}
            />
            <HazardOverlay
              hazards={hazards}
              silent={alarmSilent}
              onAcknowledge={(key) => {
                monitor.current.acknowledge(key);
                setHazards((list) => {
                  const rest = list.filter((h) => h.key !== key);
                  if (!rest.length) alarm.current?.stop();
                  return rest;
                });
              }}
            />
          </div>
          <BoardBar
            estimate={rawScene?.board ?? null}
            boardId={boardId}
            override={boardOverride}
            aligned={Boolean(quad ?? rawScene?.board.quad)}
            showPins={showPins}
            selected={selectedDetection}
            canAddPart={Boolean(rawScene?.breadboard) && !liveNow}
            onAddPart={(kind) => setCapture({ mode: "add", points: [], kind })}
            onBoard={onBoard}
            onAlign={() => setCapture({ mode: "align", points: [] })}
            onClearAlign={() => {
              setQuad(null);
              if (blob) void runDetection(blob, boardId, null);
              else if (rawScene) setRawScene({ ...rawScene, board: { ...rawScene.board, quad: null } });
            }}
            onTogglePins={() => setShowPins((value) => !value)}
            onKind={onKind}
          />
        </main>

        <div className="flex shrink-0 flex-col gap-2 xl:w-80 xl:overflow-y-auto">
          <HealthCard health={health} scene={scene} results={results} />
          <TracePanel scene={scene} pinout={pinout} onSelect={setSelected} />
          <Inspector
            target={hovered ?? selected}
            scene={scene}
            pinout={pinout}
            states={states}
            results={results}
            canMarkLegs={Boolean(rawScene?.breadboard) && !liveNow}
            onMarkLegs={(detection) => setCapture({ mode: "legs", points: [], detection })}
            onRemovePart={(detection) => {
              setOverrides((list) => list.filter((o) => o.box !== detection.box));
              setSelected(null);
            }}
          />
          <GuidePanel guide={guide} results={results} project={project} steps={steps} onProject={setProject} />
        </div>

        {/* Keyed so an old "all passed" answer cannot sit beside a new circuit. */}
        <ChatDrawer key={inspection} context={context} pinout={pinout} />
      </div>

      <footer aria-hidden className="hidden items-center justify-between border-t border-line px-1 pt-1.5 sm:tall:flex">
        <span className="label text-accent">ELECTRO VISION // Automated checks only</span>
        <span className="label text-accent">Human // Machine // Hardware</span>
      </footer>
    </div>
  );
}
