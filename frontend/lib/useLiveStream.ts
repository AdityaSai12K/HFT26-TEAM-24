"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { detect } from "./api";
import type { BoardId, Detection, Quad, Scene } from "./types";

const MAX_FRAME_WIDTH = 960;
const MIN_FRAME_MS = 150;
const RETRY_MS = 1000;
/** Naming parts is slow on CPU, so it runs on every Nth frame. Wires and hazards run on all of them. */
const FULL_FRAME_EVERY = 8;

export interface LiveOptions {
  board: BoardId | null;
  quad: Quad | null;
}

export type LiveStatus = "idle" | "starting" | "running" | "stalled";

const isPart = (d: Detection) => !["breadboard", "arduino_uno", "esp32"].includes(d.kind);

/** Captures frames from a <video> and analyses them one at a time, dropping any that arrive meanwhile. */
export function useLiveStream(video: React.RefObject<HTMLVideoElement | null>, options: LiveOptions, onScene: (scene: Scene) => void) {
  const [status, setStatus] = useState<LiveStatus>("idle");
  const [fps, setFps] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef({ options, onScene });
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    latest.current = { options, onScene };
  });

  const start = useCallback(() => {
    stopRef.current?.();
    const controller = new AbortController();
    let running = true;
    stopRef.current = () => {
      running = false;
      controller.abort();
    };
    setStatus("starting");
    setError(null);

    const canvas = document.createElement("canvas");
    let parts: Detection[] = [];

    void (async () => {
      let frame = 0;
      while (running) {
        const element = video.current;
        if (!element || element.readyState < 2 || !element.videoWidth) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        const began = performance.now();
        const scale = Math.min(1, MAX_FRAME_WIDTH / element.videoWidth);
        canvas.width = Math.round(element.videoWidth * scale);
        canvas.height = Math.round(element.videoHeight * scale);
        canvas.getContext("2d")?.drawImage(element, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
        if (!blob) continue;

        const full = frame % FULL_FRAME_EVERY === 0;
        try {
          const { board, quad } = latest.current.options;
          const scene = await detect(blob, { board, quad, full, signal: controller.signal });
          if (!running) return;
          if (full) parts = scene.detections.filter(isPart);
          else scene.detections = [...scene.detections, ...parts];
          latest.current.onScene(scene);
          setStatus("running");
          setError(null);
          setFps(1000 / Math.max(1, performance.now() - began));
          frame += 1;
        } catch (failure) {
          if ((failure as Error).name === "AbortError") return;
          // The UI must say monitoring has stopped. Silence here would read as "no hazards".
          setStatus("stalled");
          setError((failure as Error).message);
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
          continue;
        }
        const spare = MIN_FRAME_MS - (performance.now() - began);
        if (spare > 0) await new Promise((resolve) => setTimeout(resolve, spare));
      }
    })();
  }, [video]);

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    setStatus("idle");
    setError(null);
  }, []);

  useEffect(() => () => stopRef.current?.(), []);

  return { status, fps, error, start, stop };
}
