/* Shared chrome: top bar, data badges, disclaimer, time slider, 2D plan fallback, colour helpers. */
import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { api, type Badges, type Project, type SceneBuilding } from "../api";

export const DISCLAIMER = "인천계양 A2블록 주변을 배경으로 한 가상 공동주택 설계변경 검증 PoC. 실제 LH 설계안, 인허가 검토, 공식 성능평가 결과가 아님.";

export function useProject(id?: string) {
  const [p, setP] = useState<Project | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = () => {
    if (id) api.project(id).then(setP).catch((e) => setErr(String(e.message ?? e)));
  };
  useEffect(reload, [id]);
  return { p, err, reload, setP };
}

export function TopBar({ project, right, latestRunId }: { project?: Project | null; right?: ReactNode; latestRunId?: string | null }) {
  const nav = (to: string, label: string, end = false) => (
    <NavLink end={end} to={to} className={({ isActive }) => `rounded px-2.5 py-1 text-[12.5px] font-semibold ${isActive ? "bg-white/15 text-white" : "text-white/75 hover:text-white"}`}>
      {label}
    </NavLink>
  );
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 bg-brand px-4 text-white">
      <Link to="/projects" className="flex items-baseline gap-2">
        <span className="text-[11px] font-bold tracking-[0.18em] text-white/70">JIRISO DATA STUDIO</span>
        <span className="text-[14px] font-bold">GeoBuild Impact 3D</span>
      </Link>
      {project && (
        <>
          <span className="text-white/30">|</span>
          <span className="max-w-[260px] truncate text-[12.5px]" title={project.name}>{project.name}</span>
          <span className="badge border-white/50 text-white/90" title={project.site_meta.official_address}>
            📍 인천계양 A2 인근 · {project.data_badges.location.boundary_verified ? "경계 확인" : "대표점(경계 미검증)"}
          </span>
          <span className="flex items-center gap-1 text-[12px]">
            <span className="rounded bg-scen-a px-1.5 font-bold">A 기준안</span>
            <span className="text-white/60">vs</span>
            <span className="rounded bg-scen-b px-1.5 font-bold">B 변경안</span>
          </span>
          <nav className="ml-2 flex items-center gap-1">
            {nav(`/projects/${project.id}`, "설계 편집", true)}
            {nav(`/projects/${project.id}/analysis`, "분석 실행")}
            {latestRunId ? nav(`/projects/${project.id}/compare/${latestRunId}`, "결과 비교") : <span className="px-2.5 text-[12.5px] text-white/35">결과 비교</span>}
            {latestRunId ? nav(`/reports/${latestRunId}`, "보고서") : <span className="px-2.5 text-[12.5px] text-white/35">보고서</span>}
            {nav(`/projects/${project.id}/data`, "데이터")}
          </nav>
        </>
      )}
      <div className="ml-auto flex items-center gap-2">{right}</div>
    </header>
  );
}

const CLS: Record<string, string> = { SYNTHETIC: "text-amber-700", REAL_OFFICIAL: "text-emerald-700", DERIVED: "text-violet-700", USER_UPLOADED: "text-blue-700" };
export function ClassBadge({ c, label }: { c: string; label?: string }) {
  return <span className={`badge ${CLS[c] ?? "text-stone-600"}`}>{label ?? c}</span>;
}

export function DataBadges({ b, compact = false }: { b: Badges; compact?: boolean }) {
  const t = b.terrain;
  return (
    <div className={`flex flex-wrap gap-1.5 ${compact ? "" : "text-[11px]"}`}>
      <span className={`badge ${b.mode === "DEMO" ? "text-amber-700" : "text-blue-700"}`}>{b.mode === "DEMO" ? "DEMO 모드" : "업로드 데이터 모드"}</span>
      <ClassBadge c="REAL_OFFICIAL" label="위치: LH 공고 대표점" />
      {t && <ClassBadge c={t.class} label={t.class === "SYNTHETIC" ? "지형: 합성 30m DEM (실제 지형 아님)" : `지형: 업로드 DEM ${t.native_cell_m?.toFixed(0)}m`} />}
      {t && <span className={`badge ${t.vertical_datum_status === "UNRESOLVED" ? "text-red-700" : "text-stone-600"}`}>수직기준: {t.vertical_datum_status}</span>}
      {b.ground && <ClassBadge c="DERIVED" label={`가상 지반 가정 pad ${b.ground.pad_z.toFixed(1)}m`} />}
      <ClassBadge c={b.buildings.classes.includes("USER_UPLOADED") ? "USER_UPLOADED" : "SYNTHETIC"} label={`건물: ${b.buildings.label}`} />
    </div>
  );
}

export function Disclaimer({ className = "" }: { className?: string }) {
  return <div className={`rounded border border-amber-300 bg-amber-50 px-3 py-1.5 text-[11.5px] text-amber-900 ${className}`}>⚠ {DISCLAIMER}</div>;
}

export function TimeSlider({ date, value, onChange, start = "08:00", end = "16:00", step = 5 }: { date: string; value: string; onChange: (hhmm: string) => void; start?: string; end?: string; step?: number }) {
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const [a, b] = [toMin(start), toMin(end)];
  const utc = new Date(`${date}T${value}:00+09:00`).toISOString().slice(11, 16);
  return (
    <div className="flex items-center gap-3">
      <span className="w-[150px] shrink-0 font-mono text-[12px]"><b>{value} KST</b> <span className="text-muted">({utc} UTC)</span></span>
      <input aria-label="시각 (KST)" type="range" min={a} max={b} step={step} value={toMin(value)} onChange={(e) => onChange(fmt(Number(e.target.value)))} />
      <div className="flex shrink-0 gap-1">
        {["09:00", "12:00", "15:00"].map((t) => (
          <button key={t} className="btn px-2 py-0.5" onClick={() => onChange(t)}>{t}</button>
        ))}
      </div>
    </div>
  );
}

/** Diverging colour: negative = red (worse), positive = blue (better) unless invert. Grey midpoint. */
export function divColor(v: number, lim: number, invert = false): string {
  const t = Math.max(-1, Math.min(1, (invert ? -v : v) / (lim || 1)));
  const lerp = (c1: number[], c2: number[], k: number) => c1.map((c, i) => Math.round(c + (c2[i] - c) * k));
  const mid = [240, 239, 236], neg = [192, 41, 43], pos = [28, 92, 171];
  const c = t < 0 ? lerp(mid, neg, -t) : lerp(mid, pos, t);
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** 2D SVG plan (used as WebGL fallback and mini-map). */
export function PlanView({ a, b, changed, selected, onSelect, size = 300 }: { a?: SceneBuilding[]; b: SceneBuilding[]; changed?: Set<string>; selected?: string | null; onSelect?: (id: string) => void; size?: number }) {
  const R = 270;
  const sx = (x: number) => ((x + R) / (2 * R)) * size;
  const sy = (y: number) => size - ((y + R) / (2 * R)) * size;
  const path = (fp: number[][]) => fp.map((q, i) => `${i ? "L" : "M"}${sx(q[0]).toFixed(1)},${sy(q[1]).toFixed(1)}`).join("") + "Z";
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width="100%" role="img" aria-label="2D 배치 평면도 (북쪽 위)" className="rounded bg-white">
      <rect x={sx(-150)} y={sy(150)} width={sx(150) - sx(-150)} height={sy(-150) - sy(150)} fill="#f6f5f1" stroke="#c3c2b7" strokeDasharray="4 3" />
      {a?.filter((x) => changed?.has(x.id)).map((x) => <path key={"a" + x.id} d={path(x.footprint)} fill="none" stroke="#2a78d6" strokeDasharray="3 2" />)}
      {b.map((x) => (
        <g key={x.id} onClick={() => x.kind === "MAIN" && onSelect?.(x.id)} style={{ cursor: x.kind === "MAIN" ? "pointer" : "default" }}>
          <path d={path(x.footprint)} fill={selected === x.id ? "#2a78d6" : x.kind === "MAIN" ? (changed?.has(x.id) ? "#fbd5bd" : "#ecebe6") : "#d1cec4"} stroke={changed?.has(x.id) ? "#eb6834" : "#52514e"} strokeWidth={changed?.has(x.id) ? 1.6 : 0.8} />
          <text x={sx(x.centroid[0])} y={sy(x.centroid[1]) + 3} fontSize="8" textAnchor="middle" fill={selected === x.id ? "#fff" : "#0b0b0b"}>{x.id}</text>
        </g>
      ))}
      <g transform={`translate(${size - 18},18)`}><polygon points="0,-11 5,4 0,1 -5,4" fill="#0d366b" /><text y="14" fontSize="8" textAnchor="middle">N</text></g>
      <g transform={`translate(10,${size - 10})`}><rect width={sx(-220) - sx(-270)} height="3" fill="#0b0b0b" /><text y="-3" fontSize="7">50 m</text></g>
    </svg>
  );
}

export function Kpi({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "neg" | "pos" }) {
  return (
    <div className="panel px-3 py-2">
      <div className="text-[11px] text-ink-2">{label}</div>
      <div className={`text-[19px] font-bold tabular-nums ${tone === "neg" ? "text-bad" : tone === "pos" ? "text-brand-2" : ""}`}>{value}</div>
      {sub && <div className="text-[10.5px] text-muted">{sub}</div>}
    </div>
  );
}

export function Loading({ text = "불러오는 중…" }: { text?: string }) {
  return <div className="flex h-full items-center justify-center p-8 text-ink-2"><span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-brand border-t-transparent" />{text}</div>;
}

export function ErrorBox({ msg }: { msg: string }) {
  return <div role="alert" className="m-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-[12px] text-red-800">오류: {msg}</div>;
}
