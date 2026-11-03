"use client";

import { AlertOctagon, Check, VolumeX } from "lucide-react";
import type { Hazard } from "@/lib/types";

export function HazardOverlay({ hazards, silent, onAcknowledge }: { hazards: Hazard[]; silent: boolean; onAcknowledge: (key: string) => void }) {
  if (!hazards.length) return null;
  const primary = hazards.find((h) => h.kind === "active") ?? hazards[0];
  const active = primary.kind === "active";

  return (
    <div role="alertdialog" aria-labelledby="hazard-title" aria-describedby="hazard-message" data-testid="hazard-modal" data-kind={primary.kind} className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-4">
      <div className={`absolute inset-0 animate-pulse ring-8 ring-inset ${active ? "bg-bad/25 ring-bad" : "bg-warn/20 ring-warn"}`} />
      <div className={`pointer-events-auto relative w-full max-w-md border-2 bg-canvas ${active ? "border-bad text-bad shadow-[8px_8px_0_0_var(--bad)]" : "border-warn text-warn shadow-[8px_8px_0_0_var(--warn)]"}`}>
        <div aria-hidden className="hazard-stripes h-3" />
        <div className="flex items-start gap-3 p-4 pb-0">
          <AlertOctagon size={32} className="shrink-0" aria-hidden />
          <div>
            <p id="hazard-title" className="font-display text-3xl leading-none tracking-wide uppercase">
              {active ? "Disconnect power now" : "Stop: possible short ahead"}
            </p>
            <p className="mt-1.5 text-sm font-semibold text-ink">{primary.title}</p>
            <p id="hazard-message" className="mt-1 text-sm text-ink">
              {primary.message}
            </p>
            {silent && (
              <p className="mt-2 flex items-center gap-1 text-xs text-warn">
                <VolumeX size={13} aria-hidden />
                The browser blocked the sound. Restart the camera to enable it.
              </p>
            )}
          </div>
        </div>
        <div className="p-4">
          <button type="button" onClick={() => hazards.forEach((h) => onAcknowledge(h.key))} className="btn w-full justify-center py-1">
            <Check size={14} aria-hidden />
            Acknowledge
          </button>
        </div>
      </div>
    </div>
  );
}
