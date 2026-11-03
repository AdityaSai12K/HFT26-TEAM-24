"use client";

import { Camera, CameraOff, Siren, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Select } from "./ui";

export interface SampleInfo {
  id: string;
  title: string;
}

interface Props {
  samples: SampleInfo[];
  sample: string;
  threshold: number;
  webcamOn: boolean;
  replaying: boolean;
  onFile: (file: File) => void;
  onWebcam: () => void;
  onSample: (id: string) => void;
  onReplay: () => void;
  onThreshold: (value: number) => void;
}

export function InputBar(props: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <div className="panel flex flex-wrap items-center gap-2 p-2">
      <button
        type="button"
        onClick={() => fileInput.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files[0];
          if (file) props.onFile(file);
        }}
        className={`label inline-flex flex-1 items-center justify-center gap-2 border border-dashed px-3 py-1 text-muted hover:border-accent hover:text-ink sm:min-w-56 ${dragging ? "border-accent bg-accent/10" : "border-line"}`}
      >
        <Upload size={14} aria-hidden />
        Drop a board photo or video, or browse
      </button>
      <input
        ref={fileInput}
        type="file"
        accept="image/*,video/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) props.onFile(file);
          event.target.value = "";
        }}
      />
      <button type="button" className="btn" onClick={props.onWebcam} aria-pressed={props.webcamOn}>
        {props.webcamOn ? <CameraOff size={14} aria-hidden /> : <Camera size={14} aria-hidden />}
        {props.webcamOn ? "Stop camera" : "Live camera"}
      </button>
      <Select label="Sample" value={props.sample} onChange={props.onSample}>
        <option value="">Choose</option>
        {props.samples.map((s) => (
          <option key={s.id} value={s.id}>
            {s.title}
          </option>
        ))}
      </Select>
      <button type="button" className="btn" onClick={props.onReplay} disabled={props.replaying} title="Plays rendered frames of a wire moving onto GND, through the real alarm logic">
        <Siren size={14} aria-hidden />
        {props.replaying ? "Replaying" : "Hazard demo"}
      </button>
      <label className="label ml-auto flex items-center gap-2 text-muted">
        Confidence
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={props.threshold}
          onChange={(event) => props.onThreshold(Number(event.target.value))}
          className="meter w-28"
          aria-label="Minimum detection confidence"
        />
        <span className="w-9 text-right tabular-nums text-ink">{Math.round(props.threshold * 100)}%</span>
      </label>
    </div>
  );
}
