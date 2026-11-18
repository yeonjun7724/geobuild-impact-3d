/* Timeline dock (play/pause, speed, synced mini chart) and polar sun-path diagram. */
import { useEffect, useMemo, useRef } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Pause, Play, SkipBack, SkipForward, Sun } from "lucide-react";
import type { SunPathData } from "../api";

export const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
export const fmtMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export type Series = { key: string; label: string; color: string };

export function TimelineDock({ date, time, onTime, playing, onPlaying, speed, onSpeed, sun, chart, series, unit, start = "08:00", end = "16:00", step = 5, title }: {
  date: string; time: string; onTime: (t: string) => void; playing: boolean; onPlaying: (b: boolean) => void; speed: number; onSpeed: (n: number) => void;
  sun?: SunPathData | null; chart?: Record<string, number | string>[]; series?: Series[]; unit?: string; start?: string; end?: string; step?: number; title?: string;
}) {
  const a = toMin(start), b = toMin(end);
  const timeRef = useRef(time);
  timeRef.current = time;
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const m = toMin(timeRef.current) + step;
      onTime(fmtMin(m > b ? a : m));
    }, 260 / speed);
    return () => window.clearInterval(id);
  }, [playing, speed, a, b, step, onTime]);
  const utc = new Date(`${date}T${time}:00+09:00`).toISOString().slice(11, 16);
  const sunNow = useMemo(() => {
    if (!sun) return null;
    const i = sun.day.time.indexOf(time);
    return i >= 0 ? { az: sun.day.az[i], el: sun.day.el[i] } : null;
  }, [sun, time]);
  const data = chart ?? (sun ? sun.day.time.map((t, i) => ({ t, 태양고도: sun.day.el[i] })).filter((d) => toMin(d.t) >= a && toMin(d.t) <= b) : []);
  const ser = series ?? [{ key: "태양고도", label: "태양 고도(°)", color: "#ffd36b" }];
  return (
    <div className="glass flex items-stretch gap-3 px-3 py-2.5" data-testid="timeline">
      <div className="flex shrink-0 flex-col justify-center gap-1.5">
        <div className="flex items-center gap-1">
          <button className="btn btn-sm btn-icon btn-ghost" onClick={() => onTime(fmtMin(Math.max(a, toMin(time) - 30)))} aria-label="30분 뒤로"><SkipBack size={14} /></button>
          <button className="btn btn-primary btn-icon !h-9 !w-9 !rounded-full" onClick={() => onPlaying(!playing)} aria-label={playing ? "일시정지" : "재생"} data-testid="play">
            {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
          </button>
          <button className="btn btn-sm btn-icon btn-ghost" onClick={() => onTime(fmtMin(Math.min(b, toMin(time) + 30)))} aria-label="30분 앞으로"><SkipForward size={14} /></button>
          <select aria-label="재생 속도" className="!h-7 !w-[58px] !px-1 text-[11.5px]" value={speed} onChange={(e) => onSpeed(Number(e.target.value))}>
            {[0.5, 1, 2, 4].map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
        </div>
        <div className="flex items-baseline gap-2 pl-1">
          <span className="font-mono text-[19px] font-bold text-white">{time}</span>
          <span className="text-[11px] text-ink-2">KST</span>
          <span className="font-mono text-[11px] text-muted">{utc} UTC</span>
        </div>
        {sunNow && <div className="flex items-center gap-1.5 pl-1 text-[11px] text-ink-2"><Sun size={12} className="text-[#ffd36b]" />고도 {sunNow.el.toFixed(1)}° · 방위 {sunNow.az.toFixed(0)}°</div>}
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center justify-between text-[11px]">
          <span className="font-semibold text-ink-2">{title ?? "태양 고도 (pvlib NREL SPA)"}</span>
          <span className="flex gap-3">{ser.map((s) => <span key={s.key} className="flex items-center gap-1 text-muted"><span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />{s.label}</span>)}</span>
        </div>
        <div style={{ height: 66 }}>
          <ResponsiveContainer>
            <AreaChart data={data} margin={{ left: 0, right: 4, top: 4, bottom: 0 }} onClick={(e: any) => e?.activeLabel && onTime(String(e.activeLabel).slice(0, 5))}>
              <defs>{ser.map((s) => <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={s.color} stopOpacity={0.45} /><stop offset="1" stopColor={s.color} stopOpacity={0.02} /></linearGradient>)}</defs>
              <CartesianGrid stroke="#1d2b44" vertical={false} />
              <XAxis dataKey="t" tick={{ fontSize: 9.5, fill: "#6f8098" }} tickFormatter={(v) => String(v).slice(0, 5)} interval={Math.max(1, Math.floor(data.length / 9))} axisLine={false} tickLine={false} />
              <YAxis width={34} tick={{ fontSize: 9.5, fill: "#6f8098" }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ background: "#0f1a2c", border: "1px solid #2a3c5b", borderRadius: 8, fontSize: 11 }} labelStyle={{ color: "#a9b7c9" }}
                formatter={(v: any, n: any) => [`${Number(v).toLocaleString()}${unit ?? ""}`, n]} />
              {ser.map((s) => <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={1.8} fill={`url(#g-${s.key})`} isAnimationActive={false} />)}
              <ReferenceLine x={data.find((d) => String(d.t).slice(0, 5) >= time)?.t as any} stroke="#fff" strokeDasharray="3 2" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <input aria-label="시각 (KST)" type="range" min={a} max={b} step={step} value={toMin(time)} onChange={(e) => onTime(fmtMin(Number(e.target.value)))} className="mt-1" />
      </div>
    </div>
  );
}

/** Polar sun path: centre = zenith, rim = horizon, north up. Reference solstice/equinox curves + selected day + current sun. */
export function SunPath({ sun, time, size = 210 }: { sun: SunPathData; time: string; size?: number }) {
  const R = size / 2 - 16, c = size / 2;
  const P = (az: number, el: number) => {
    const r = R * (1 - Math.max(0, el) / 90), a = (az * Math.PI) / 180;
    return [c + r * Math.sin(a), c - r * Math.cos(a)];
  };
  const path = (az: number[], el: number[]) => az.map((z, i) => (el[i] > 0 ? P(z, el[i]) : null)).filter(Boolean).map((q, i) => `${i ? "L" : "M"}${q![0].toFixed(1)},${q![1].toFixed(1)}`).join("");
  const refs: Record<string, string> = { 하지: "#ff9b6b", "춘·추분": "#9aa9c0", 동지: "#6cb2ff" };
  const i = sun.day.time.indexOf(time);
  const now = i >= 0 && sun.day.el[i] > 0 ? P(sun.day.az[i], sun.day.el[i]) : null;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width="100%" role="img" aria-label="태양 궤적도 (천정 중심, 북쪽 위)">
      {[0, 30, 60].map((e) => <circle key={e} cx={c} cy={c} r={R * (1 - e / 90)} fill="none" stroke="#22324d" strokeDasharray={e ? "2 3" : undefined} />)}
      {[0, 90, 180, 270].map((az) => { const [x, y] = P(az, 0); return <line key={az} x1={c} y1={c} x2={x} y2={y} stroke="#1b2a42" />; })}
      {[["N", 0], ["E", 90], ["S", 180], ["W", 270]].map(([t, az]) => { const [x, y] = P(Number(az), -8); return <text key={t as string} x={x} y={y + 3} fontSize="9.5" textAnchor="middle" fill={t === "N" ? "#ff8080" : "#6f8098"} fontWeight={700}>{t}</text>; })}
      {[30, 60].map((e) => <text key={e} x={c + 3} y={c - R * (1 - e / 90) + 9} fontSize="8" fill="#4e6080">{e}°</text>)}
      {Object.entries(sun.reference).map(([k, v]) => <path key={k} d={path(v.az, v.el)} fill="none" stroke={refs[k] ?? "#888"} strokeWidth={1} strokeOpacity={0.55} strokeDasharray="3 2" />)}
      <path d={path(sun.day.az, sun.day.el)} fill="none" stroke="#ffd36b" strokeWidth={2.2} />
      {now && <><circle cx={now[0]} cy={now[1]} r={9} fill="#ffd36b" opacity={0.18} /><circle cx={now[0]} cy={now[1]} r={4.5} fill="#ffd36b" stroke="#fff" strokeWidth={1.2} /></>}
      <g transform={`translate(6,${size - 30})`} fontSize="8.5" fill="#8a9bb3">
        {Object.entries(refs).map(([k, col], j) => <g key={k} transform={`translate(${j * 50},0)`}><line x1="0" x2="10" y1="-3" y2="-3" stroke={col} strokeDasharray="3 2" /><text x="13">{k}</text></g>)}
        <g transform="translate(0,13)"><line x1="0" x2="10" y1="-3" y2="-3" stroke="#ffd36b" strokeWidth="2" /><text x="13">분석일 {sun.date}</text></g>
      </g>
    </svg>
  );
}
