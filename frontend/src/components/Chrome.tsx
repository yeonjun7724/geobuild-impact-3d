/* App shell (top bar + workflow stepper) and shared helpers. */
import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { AlertTriangle, Check, ChevronRight, Database, FileText, LayoutGrid, PenTool, Play, BarChart3 } from "lucide-react";
import { api, type Badges, type Project, type SceneBuilding } from "../api";
import { ClassChip, Spinner } from "../ui";

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

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
      <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#6cb2ff" /><stop offset="1" stopColor="#2f7de1" /></linearGradient></defs>
      <rect x="2" y="2" width="28" height="28" rx="8" fill="url(#lg)" />
      <path d="M9 22V13l5-3v12M15 22V9l4-2v15M20 22v-8l3 1.5V22" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinejoin="round" />
      <circle cx="24" cy="8.5" r="2.4" fill="#ffd36b" />
    </svg>
  );
}

export function TopBar({ project, right, latestRunId }: { project?: Project | null; right?: ReactNode; latestRunId?: string | null }) {
  const loc = useLocation();
  const path = loc.pathname;
  const steps = project ? [
    { to: `/projects/${project.id}`, label: "변경안 입력", icon: <PenTool size={13} />, active: path === `/projects/${project.id}`, enabled: true },
    { to: `/projects/${project.id}/analysis`, label: "전후 계산", icon: <Play size={13} />, active: path.endsWith("/analysis"), enabled: true },
    { to: latestRunId ? `/projects/${project.id}/compare/${latestRunId}` : "", label: "검토 판정", icon: <BarChart3 size={13} />, active: path.includes("/compare/"), enabled: !!latestRunId },
    { to: latestRunId ? `/reports/${latestRunId}` : "", label: "보고서", icon: <FileText size={13} />, active: path.startsWith("/reports/"), enabled: !!latestRunId },
  ] : [];
  const activeIdx = steps.findIndex((s) => s.active);
  return (
    <header className="relative z-20 flex h-[52px] shrink-0 items-center gap-3 border-b border-line bg-[#080f1d]/95 px-4 backdrop-blur">
      <Link to="/projects" className="flex items-center gap-2.5" title="프로젝트 목록">
        <Logo />
        <div className="leading-tight">
          <div className="text-[13.5px] font-bold tracking-tight text-white">GeoBuild Impact 3D</div>
          <div className="text-[9.5px] font-semibold tracking-[0.2em] text-muted">JIRISO DATA STUDIO</div>
        </div>
      </Link>
      {project && (
        <>
          <div className="mx-1 h-6 w-px bg-line" />
          <div className="min-w-0 max-w-[260px]">
            <div className="truncate text-[12.5px] font-semibold text-ink" title={project.name}>{project.name}</div>
            <div className="truncate text-[10.5px] text-muted">인천계양 A2 인근 · 대표점(경계 미검증)</div>
          </div>
          <nav className="ml-3 flex items-center" aria-label="작업 단계">
            {steps.map((s, i) => (
              <div key={s.label} className="flex items-center">
                {i > 0 && <ChevronRight size={14} className="mx-0.5 text-[#33476a]" />}
                {s.enabled ? (
                  <Link to={s.to} aria-current={s.active ? "step" : undefined}
                    className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-semibold transition-colors ${s.active ? "bg-accent/15 text-white ring-1 ring-accent/45" : "text-ink-2 hover:bg-white/5 hover:text-ink"}`}>
                    <span className={`flex h-[18px] w-[18px] items-center justify-center rounded-full text-[10px] ${s.active ? "bg-accent text-white" : i < activeIdx ? "bg-good/20 text-good" : "bg-white/10"}`}>
                      {i < activeIdx ? <Check size={11} /> : i + 1}
                    </span>
                    {s.label}
                  </Link>
                ) : (
                  <span className="flex h-8 cursor-not-allowed items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-semibold text-[#45577a]" title="분석이 성공적으로 완료되어야 열립니다">
                    <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-white/5 text-[10px]">{i + 1}</span>{s.label}
                  </span>
                )}
              </div>
            ))}
            <div className="mx-1 h-5 w-px bg-line" />
            <Link to={`/projects/${project.id}/data`} className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-semibold ${path.endsWith("/data") ? "bg-white/10 text-white" : "text-ink-2 hover:text-ink"}`}>
              <Database size={13} />데이터
            </Link>
          </nav>
        </>
      )}
      {!project && (
        <nav className="ml-4"><Link to="/projects" className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-semibold text-ink-2 hover:text-ink"><LayoutGrid size={13} />프로젝트</Link></nav>
      )}
      <div className="ml-auto flex items-center gap-2">
        <span className="chip chip-syn" title={DISCLAIMER}><AlertTriangle size={11} />가상 PoC · 실제 LH 설계안 아님</span>
        {right}
      </div>
    </header>
  );
}

export function DataBadges({ b }: { b: Badges }) {
  const t = b.terrain;
  return (
    <div className="flex flex-wrap gap-1.5">
      <span className={`chip ${b.mode === "DEMO" ? "chip-syn" : "chip-up"}`}>{b.mode === "DEMO" ? "DEMO 모드" : "업로드 데이터"}</span>
      <ClassChip c="REAL_OFFICIAL" label="위치: LH 공고 대표점" />
      {t && <ClassChip c={t.class} label={t.class === "SYNTHETIC" ? "합성 30m DEM (실제 지형 아님)" : `DEM ${t.native_cell_m?.toFixed(0)}m`} />}
      {t && <span className={`chip ${t.vertical_datum_status === "UNRESOLVED" ? "chip-bad" : ""}`}>수직기준 {t.vertical_datum_status}</span>}
      {b.ground && <ClassChip c="DERIVED" label={`가상 지반 pad ${b.ground.pad_z.toFixed(1)}m`} />}
      <ClassChip c={b.buildings.classes.includes("USER_UPLOADED") ? "USER_UPLOADED" : "SYNTHETIC"} label={`건물: ${b.buildings.label}`} />
    </div>
  );
}

export function Disclaimer({ className = "" }: { className?: string }) {
  return <div className={`flex gap-2 rounded-lg border border-warn/30 bg-warn/[0.07] px-3 py-2 text-[11.5px] leading-snug text-[#f3d9a0] ${className}`}><AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />{DISCLAIMER}</div>;
}

/** Diverging colour: negative = red (worse), positive = blue (better) unless invert. Neutral midpoint. */
export function divColor(v: number, lim: number, invert = false, alpha = 1): string {
  const t = Math.max(-1, Math.min(1, (invert ? -v : v) / (lim || 1)));
  const lerp = (c1: number[], c2: number[], k: number) => c1.map((c, i) => Math.round(c + (c2[i] - c) * k));
  const mid = [236, 236, 232], neg = [226, 55, 60], pos = [40, 120, 230];
  const c = t < 0 ? lerp(mid, neg, Math.pow(-t, 0.75)) : lerp(mid, pos, Math.pow(t, 0.75));
  return alpha >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

/** 2D SVG plan (WebGL fallback / mini-map). */
export function PlanView({ a, b, changed, selected, onSelect, size = 260 }: { a?: SceneBuilding[]; b: SceneBuilding[]; changed?: Set<string>; selected?: string | null; onSelect?: (id: string) => void; size?: number }) {
  const R = 270;
  const sx = (x: number) => ((x + R) / (2 * R)) * size;
  const sy = (y: number) => size - ((y + R) / (2 * R)) * size;
  const path = (fp: number[][]) => fp.map((q, i) => `${i ? "L" : "M"}${sx(q[0]).toFixed(1)},${sy(q[1]).toFixed(1)}`).join("") + "Z";
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width="100%" role="img" aria-label="2D 배치 평면도 (북쪽 위)" className="rounded-lg bg-[#0a1322]">
      <rect x={sx(-150)} y={sy(150)} width={sx(150) - sx(-150)} height={sy(-150) - sy(150)} fill="#0f1b2e" stroke="#2c4065" strokeDasharray="4 3" />
      {a?.filter((x) => changed?.has(x.id)).map((x) => <path key={"a" + x.id} d={path(x.footprint)} fill="none" stroke="#4a94ff" strokeDasharray="3 2" />)}
      {b.map((x) => (
        <g key={x.id} onClick={() => x.kind === "MAIN" && onSelect?.(x.id)} style={{ cursor: x.kind === "MAIN" ? "pointer" : "default" }}>
          <path d={path(x.footprint)} fill={selected === x.id ? "#4a94ff" : x.kind === "MAIN" ? (changed?.has(x.id) ? "#ff8a3d55" : "#2a3a56") : "#1c2840"} stroke={changed?.has(x.id) ? "#ff8a3d" : "#6f8098"} strokeWidth={changed?.has(x.id) ? 1.4 : 0.7} />
          {x.kind === "MAIN" && <text x={sx(x.centroid[0])} y={sy(x.centroid[1]) + 3} fontSize="8.5" textAnchor="middle" fill="#e8eef7" fontWeight={600}>{x.id}</text>}
        </g>
      ))}
      <g transform={`translate(${size - 16},16)`}><polygon points="0,-10 5,4 0,1 -5,4" fill="#ff6b6b" /><text y="14" fontSize="8" textAnchor="middle" fill="#a9b7c9">N</text></g>
      <g transform={`translate(10,${size - 10})`}><rect width={sx(-220) - sx(-270)} height="2.5" fill="#a9b7c9" /><text y="-4" fontSize="7.5" fill="#a9b7c9">50 m</text></g>
    </svg>
  );
}

export function Loading({ text = "불러오는 중…" }: { text?: string }) {
  return <div className="flex h-full items-center justify-center gap-2 p-8 text-ink-2"><Spinner />{text}</div>;
}

export function ErrorBox({ msg }: { msg: string }) {
  return <div role="alert" className="m-3 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-[12px] text-[#ffb4b4]">오류: {msg}</div>;
}
