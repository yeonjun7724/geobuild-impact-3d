/* Small design-system primitives used across pages. */
import { useState, type ReactNode } from "react";
import { ChevronDown, Loader2 } from "lucide-react";

export function Panel({ title, icon, actions, children, className = "", collapsible = false, defaultOpen = true, pad = true }: {
  title?: ReactNode; icon?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; collapsible?: boolean; defaultOpen?: boolean; pad?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`glass rise ${className}`}>
      {title && (
        <header className="flex items-center gap-2 px-3.5 pt-3 pb-2">
          {icon && <span className="text-accent">{icon}</span>}
          <h3 className="h-section flex-1">{title}</h3>
          {actions}
          {collapsible && (
            <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="접기/펼치기">
              <ChevronDown size={14} style={{ transform: open ? "none" : "rotate(-90deg)", transition: "transform .15s" }} />
            </button>
          )}
        </header>
      )}
      {open && <div className={pad ? "px-3.5 pb-3.5" : ""}>{children}</div>}
    </section>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size = "md", ariaLabel }: {
  value: T; options: { value: T; label: ReactNode; title?: string; disabled?: boolean }[]; onChange: (v: T) => void; size?: "sm" | "md"; ariaLabel?: string;
}) {
  return (
    <div className="seg" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} aria-pressed={value === o.value} title={o.title} disabled={o.disabled} onClick={() => onChange(o.value)}
          className={`${size === "sm" ? "!h-6 !px-2 !text-[11.5px]" : ""} disabled:opacity-35`}>{o.label}</button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (b: boolean) => void; label: ReactNode; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-1 text-[12.5px] text-ink-2 hover:text-ink" title={hint}>
      <span>{label}</span>
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors ${checked ? "bg-accent-2" : "bg-[#2a3a56]"}`}>
        <span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-all ${checked ? "left-[16px]" : "left-[2px]"}`} />
      </button>
    </label>
  );
}

export function SliderField({ label, value, min, max, step, unit, onChange, onCommit, format }: {
  label: ReactNode; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void; onCommit?: () => void; format?: (v: number) => string;
}) {
  return (
    <div className="mb-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="label">{label}</span>
        <span className="flex items-center gap-1">
          <input aria-label={typeof label === "string" ? label : undefined} type="number" className="!h-6 w-[64px] text-right tnum" min={min} max={max} step={step} value={value}
            onChange={(e) => onChange(Number(e.target.value))} onBlur={onCommit} onKeyDown={(e) => { if (e.key === "Enter") { onCommit?.(); e.currentTarget.blur(); } }} />
          {unit && <span className="w-5 text-[11px] text-muted">{unit}</span>}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} onPointerUp={onCommit} onKeyUp={onCommit} />
      {format && <div className="mt-1 text-[11px] text-muted">{format(value)}</div>}
    </div>
  );
}

export function Stat({ label, value, sub, tone, icon, delta }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: "bad" | "good" | "warn"; icon?: ReactNode; delta?: number | null }) {
  const color = tone === "bad" ? "text-bad" : tone === "good" ? "text-good" : tone === "warn" ? "text-warn" : "text-ink";
  return (
    <div className="card-2 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted">{icon}{label}</div>
      <div className={`mt-0.5 text-[20px] font-bold leading-tight tnum ${color}`}>{value}</div>
      {(sub || delta !== undefined) && (
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-2">
          {delta !== undefined && delta !== null && <span className={delta < 0 ? "text-bad" : delta > 0 ? "text-good" : ""}>{delta > 0 ? "▲" : delta < 0 ? "▼" : "■"} {Math.abs(delta).toLocaleString()}</span>}
          {sub}
        </div>
      )}
    </div>
  );
}

const CLS: Record<string, string> = { SYNTHETIC: "chip-syn", REAL_OFFICIAL: "chip-real", DERIVED: "chip-der", USER_UPLOADED: "chip-up" };
export function ClassChip({ c, label }: { c: string; label?: string }) {
  return <span className={`chip ${CLS[c] ?? ""}`}>{label ?? c}</span>;
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <Loader2 size={size} className="animate-spin text-accent" />;
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center text-ink-2">
      {icon && <div className="text-muted">{icon}</div>}
      <div className="text-[13px] font-semibold text-ink">{title}</div>
      {children && <div className="max-w-[300px] text-[12px] text-muted">{children}</div>}
    </div>
  );
}

export function Progress({ value, tone = "accent" }: { value: number; tone?: "accent" | "bad" | "good" }) {
  const bg = tone === "bad" ? "bg-bad" : tone === "good" ? "bg-good" : "bg-accent";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#1e2c45]" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full ${bg} transition-all duration-500`} style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
    </div>
  );
}

export function Legend({ title, stops, lo, mid = "0", hi, note }: { title: string; stops: string[]; lo: string; mid?: string; hi: string; note?: string }) {
  return (
    <div>
      <div className="mb-1 text-[11.5px] font-semibold text-ink-2">{title}</div>
      <div className="h-2 rounded-full" style={{ background: `linear-gradient(90deg, ${stops.join(",")})` }} />
      <div className="mt-1 flex justify-between text-[10.5px] text-muted tnum"><span>{lo}</span><span>{mid}</span><span>{hi}</span></div>
      {note && <div className="mt-1.5 text-[10.5px] leading-snug text-muted">{note}</div>}
    </div>
  );
}
