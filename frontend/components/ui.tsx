import { Check, CircleHelp, X } from "lucide-react";
import type { ReactNode } from "react";
import type { RuleStatus } from "@/lib/types";

export function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5">
        <h2 className="panel-title">{title}</h2>
        {action}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

const BADGES: Record<RuleStatus, { label: string; style: string; icon: typeof Check }> = {
  pass: { label: "Pass", style: "border-ok/50 bg-ok/10 text-ok", icon: Check },
  fail: { label: "Fail", style: "border-bad bg-bad/15 text-bad", icon: X },
  unclear: { label: "Unclear", style: "border-warn/60 bg-warn/10 text-warn", icon: CircleHelp },
};

export function StatusBadge({ status }: { status: RuleStatus }) {
  const { label, style, icon: Icon } = BADGES[status];
  return (
    <span className={`label inline-flex shrink-0 items-center gap-1 border px-1.5 ${style}`}>
      <Icon size={12} aria-hidden />
      {label}
    </span>
  );
}

export function Select({ label, value, onChange, children, disabled }: { label: string; value: string; onChange: (value: string) => void; children: ReactNode; disabled?: boolean }) {
  return (
    <label className="flex min-w-0 items-center gap-2 text-xs text-muted">
      <span className="label shrink-0">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="field min-w-0 py-1 pl-2 text-xs disabled:opacity-50"
      >
        {children}
      </select>
    </label>
  );
}

export function CrtMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="miter" aria-hidden>
      <path d="M9 11 28 5l6 3v21l-19 7-6-4z" />
      <path d="M15 14 34 8M15 14v22M9 11l6 3" />
      <path d="m18 16 13-4v13l-13 5z" />
      <path d="m20 32 3-1M26 30l5-2" />
    </svg>
  );
}
