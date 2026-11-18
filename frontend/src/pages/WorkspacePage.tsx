import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, kstToUtcIso, type GroundMesh, type SceneBuilding, type SceneResp, type Transform } from "../api";
import { ClassBadge, DataBadges, Disclaimer, ErrorBox, Loading, PlanView, TimeSlider, TopBar, useProject } from "../components/Chrome";
import SyncedViewers, { type ViewMode } from "../components/SyncedViewers";
import type { PickResult } from "../components/CesiumScene";

const ZERO: Transform = { dx: 0, dy: 0, rot_deg: 0, floors_delta: 0 };

export default function WorkspacePage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { p, err, reload } = useProject(id);
  const [sa, setSa] = useState<SceneResp | null>(null);
  const [sb, setSb] = useState<SceneResp | null>(null);
  const [ground, setGround] = useState<GroundMesh | null>(null);
  const [sel, setSel] = useState<string | null>("105");
  const [mode, setMode] = useState<ViewMode>("OVERLAY");
  const [time, setTime] = useState("12:00");
  const [date, setDate] = useState("2026-12-22");
  const [shadows, setShadows] = useState(true);
  const [imagery, setImagery] = useState(true);
  const [showContext, setShowContext] = useState(true);
  const [showOS, setShowOS] = useState(true);
  const [draft, setDraft] = useState<Transform>(ZERO);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const timer = useRef<number | undefined>(undefined);

  const loadScenes = useCallback(async () => {
    const [a, b] = await Promise.all([api.scene(id, "A"), api.scene(id, "B")]);
    setSa(a);
    setSb(b);
  }, [id]);
  useEffect(() => {
    loadScenes().catch((e) => setMsg(e.message));
    api.ground(id).then(setGround).catch((e) => setMsg(e.message));
    api.runs(id).then(setRuns).catch(() => {});
  }, [id, loadScenes]);

  const scB = p?.scenarios.find((s) => s.code === "B");
  const changed = useMemo(() => new Set(Object.keys(scB?.transforms ?? {})), [scB]);
  useEffect(() => { if (sel && scB) setDraft({ ...ZERO, ...(scB.transforms[sel] ?? {}) }); }, [sel, scB?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (t: Transform) => {
    setDraft(t);
    if (!scB || !sel) return;
    window.clearTimeout(timer.current);
    setSaving("saving");
    timer.current = window.setTimeout(async () => {
      try {
        const r = await api.patchBuilding(scB.id, sel, t);
        setWarnings(r.warnings);
        await loadScenes();
        reload();
        setSaving("saved");
      } catch (e: any) {
        setSaving("error");
        setMsg(e.message);
      }
    }, 350);
  };
  const resetB = async () => {
    if (!confirm("변경안 B의 모든 변경을 지우고 기준안 A와 동일하게 초기화할까요? (기존 분석·보고서는 보존됩니다)")) return;
    await api.resetB(id);
    await loadScenes();
    reload();
  };
  const onPick = (pk: PickResult) => {
    if (pk.type === "building") {
      const b = sb?.buildings.find((x) => x.id === pk.id);
      if (b?.kind === "MAIN") setSel(pk.id);
      else setMsg(`${pk.id}: 주변 참고건물 (편집 대상 아님)`);
    }
  };
  const latestOk = runs.find((r) => r.status === "SUCCEEDED");
  if (err) return <ErrorBox msg={err} />;
  if (!p || !sa || !sb) return <div className="flex h-full flex-col"><TopBar project={p} /><Loading text="3D 장면·지형 메쉬 불러오는 중…" /></div>;
  const bA = sa.buildings.find((x) => x.id === sel);
  const bB = sb.buildings.find((x) => x.id === sel);
  const rings = showOS ? [
    ...sb.open_spaces.map((o) => ({ ring: o.polygon, z: sb.pad_z, color: "#1baf7a", label: o.name.replace(" (DEMO 가상)", "") + " (가상)" })),
    { ring: sb.site_boundary, z: sb.pad_z, color: "#6b6a66", width: 1.5 },
  ] : [];

  return (
    <div className="flex h-full flex-col">
      <TopBar project={p} latestRunId={latestOk?.id} right={
        <>
          <span className="text-[11.5px] text-white/80" aria-live="polite">
            {saving === "saving" ? "B 저장 중…" : saving === "saved" ? `B 저장됨 (rev ${scB?.revision})` : saving === "error" ? "저장 실패" : `B rev ${scB?.revision}`}
          </span>
          <button className="btn" onClick={() => nav(`/projects/${id}/analysis`)} data-testid="go-analysis">분석 실행 ▶</button>
          <button className="btn" disabled={!latestOk} onClick={() => latestOk && nav(`/reports/${latestOk.id}`)} title={latestOk ? "" : "성공한 분석이 있어야 보고서를 생성할 수 있습니다"}>보고서 생성</button>
        </>
      } />
      <div className="flex min-h-0 flex-1">
        {/* ---------------- left panel */}
        <aside className="w-[290px] shrink-0 overflow-y-auto border-r border-line bg-white p-3">
          <Section title="보기 방식">
            <div className="grid grid-cols-2 gap-1">
              {([["A", "A 기준안"], ["B", "B 변경안"], ["OVERLAY", "전후 오버레이"], ["SPLIT", "좌우 분할 (동기화)"]] as [ViewMode, string][]).map(([m, l]) => (
                <button key={m} className={`btn justify-center ${mode === m ? "btn-primary" : ""}`} onClick={() => setMode(m)} aria-pressed={mode === m}>{l}</button>
              ))}
            </div>
          </Section>
          <Section title="레이어">
            <Toggle v={shadows} set={setShadows} label="3D 그림자 프리뷰 (시각용)" />
            <Toggle v={showContext} set={setShowContext} label="주변 참고건물 (가상)" />
            <Toggle v={showOS} set={setShowOS} label="가상 놀이터·휴게공간·대지경계" />
            <Toggle v={imagery} set={setImagery} label="배경지도 (OpenStreetMap)" />
          </Section>
          <Section title="주동 선택">
            <div className="grid grid-cols-4 gap-1">
              {sb.buildings.filter((b) => b.kind === "MAIN").map((b) => (
                <button key={b.id} className={`btn justify-center px-1 ${sel === b.id ? "btn-primary" : ""} ${changed.has(b.id) ? "border-scen-b" : ""}`} onClick={() => setSel(b.id)} aria-pressed={sel === b.id}>
                  {b.id}{changed.has(b.id) ? "*" : ""}
                </button>
              ))}
            </div>
            <div className="mt-1 text-[10.5px] text-muted">* = B에서 변경됨 · 지도에서 주동 클릭으로도 선택</div>
          </Section>
          {sel && bB && (
            <Section title={`${sel}동 변경안 B 편집`}>
              <div className="mb-2 rounded bg-stone-50 px-2 py-1 text-[11px] text-ink-2">기준안 A는 잠금(불변). 변경은 B에만 저장되며 새 해시로 관리됩니다.</div>
              <Slider label="동서 이동 X (m, 동+)" min={-60} max={60} step={0.5} v={draft.dx} on={(v) => commit({ ...draft, dx: v })} />
              <Slider label="남북 이동 Y (m, 북+)" min={-60} max={60} step={0.5} v={draft.dy} on={(v) => commit({ ...draft, dy: v })} />
              <Slider label="회전 (°, 반시계+)" min={-45} max={45} step={0.5} v={draft.rot_deg} on={(v) => commit({ ...draft, rot_deg: v })} />
              <Slider label={`높이 (층 증감, 1층=2.9 m) → ${bA ? bA.floors + draft.floors_delta : "-"}층 / ${bA ? ((bA.floors + draft.floors_delta) * 2.9 + 1.2).toFixed(1) : "-"} m`} min={-10} max={10} step={1} v={draft.floors_delta} on={(v) => commit({ ...draft, floors_delta: v })} />
              <div className="mt-2 flex gap-1">
                <button className="btn" onClick={() => commit(ZERO)}>이 주동 되돌리기</button>
                <button className="btn" onClick={resetB}>B 전체 초기화</button>
              </div>
              {warnings.length > 0 && <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900">{warnings.map((w) => <div key={w}>⚠ {w}</div>)}</div>}
            </Section>
          )}
          <Section title="태양 시각 (프리뷰)">
            <label className="fld">분석일 (기본: 2026-12-22 동지, 한국천문연구원)<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
            <div className="mt-1 text-[10.5px] text-muted">시간대 Asia/Seoul (KST, UTC+9) · Cesium Clock에 동일 UTC 순간 전달</div>
          </Section>
          <Section title="2D 평면 (WebGL 대체)">
            <PlanView a={sa.buildings} b={sb.buildings} changed={changed} selected={sel} onSelect={setSel} />
          </Section>
        </aside>

        {/* ---------------- center */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <SyncedViewers mode={mode} a={sa.buildings} b={sb.buildings} modelMatrix={sb.model_matrix} padZ={sb.pad_z} ground={ground}
              timeUtc={kstToUtcIso(date, time)} shadows={shadows} imagery={imagery} showContext={showContext} selected={sel} changed={changed}
              onPick={onPick} rings={rings} />
          </div>
          <div className="border-t border-line bg-white px-4 py-2">
            <TimeSlider date={date} value={time} onChange={setTime} />
            <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-ink-2">
              <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-[#f2a06b]" />B 변경 주동</span>
              <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-scen-a/40" />A 위치(오버레이)</span>
              <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-scen-a" />선택 주동</span>
              <span className="text-muted">3D 그림자는 Cesium 렌더링 프리뷰이며 보고서 수치는 서버 레이캐스팅 결과만 사용합니다.</span>
              {msg && <span className="ml-auto text-red-700" role="status">{msg} <button className="underline" onClick={() => setMsg(null)}>닫기</button></span>}
            </div>
          </div>
        </main>

        {/* ---------------- right panel */}
        <aside className="w-[300px] shrink-0 overflow-y-auto border-l border-line bg-white p-3">
          <Section title="데이터 상태 (고정 표기)">
            <DataBadges b={p.data_badges} />
            <Disclaimer className="mt-2" />
          </Section>
          {bA && bB && (
            <Section title={`선택 주동 ${sel}동`}>
              <table className="tbl">
                <thead><tr><th>항목</th><th className="num">A</th><th className="num">B</th></tr></thead>
                <tbody>
                  <Row k="층수" a={bA.floors} b={bB.floors} />
                  <Row k="높이 (m)" a={bA.height_m.toFixed(1)} b={bB.height_m.toFixed(1)} />
                  <Row k="지반고 z (m)" a={bA.base_z.toFixed(2)} b={bB.base_z.toFixed(2)} />
                  <Row k="최고 z (m)" a={bA.top_z.toFixed(2)} b={bB.top_z.toFixed(2)} />
                  <Row k="중심 E (m)" a={bA.centroid[0].toFixed(1)} b={bB.centroid[0].toFixed(1)} />
                  <Row k="중심 N (m)" a={bA.centroid[1].toFixed(1)} b={bB.centroid[1].toFixed(1)} />
                  <Row k="footprint (m²)" a={bA.footprint_area_m2.toFixed(0)} b={bB.footprint_area_m2.toFixed(0)} />
                  <Row k="수광점 수" a={bA.n_receivers ?? "-"} b={bB.n_receivers ?? "-"} />
                </tbody>
              </table>
              <div className="mt-2 flex items-center gap-1 text-[11px]"><ClassBadge c={bB.data_class} /> <span className="text-muted">수광점 = 외벽 대리지점(facade_proxy)</span></div>
            </Section>
          )}
          <Section title="최근 분석 실행">
            {runs.length === 0 ? <div className="text-[12px] text-ink-2">아직 분석이 없습니다. [분석 실행]에서 A/B/C를 계산하세요.</div> : (
              <ul className="space-y-1">
                {runs.slice(0, 6).map((r) => (
                  <li key={r.id} className="flex items-center justify-between text-[12px]">
                    <span className="font-mono">{r.id}</span>
                    <span className={r.status === "SUCCEEDED" ? "text-emerald-700" : r.status === "FAILED" ? "text-red-700" : "text-ink-2"}>{r.status}</span>
                    {r.status === "SUCCEEDED" ? <button className="btn px-2 py-0.5" onClick={() => nav(`/projects/${id}/compare/${r.id}`)}>결과</button> : <span />}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="지반·좌표">
            <div className="space-y-0.5 text-[11.5px] text-ink-2">
              <div>원점: {p.frame.lat0}N, {p.frame.lon0}E (LH 공고 대표점)</div>
              <div>계산 좌표: local ENU (m) · 교환 EPSG:5179</div>
              <div>가상 계획지반 pad_z = {sb.pad_z.toFixed(2)} m</div>
              {ground && <div>지면 메쉬 {ground.n_vertices.toLocaleString()}정점 · z {ground.z_min.toFixed(1)}~{ground.z_max.toFixed(1)} m (분석과 동일 메쉬)</div>}
            </div>
          </Section>
        </aside>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="mb-4"><h3 className="mb-1.5 text-[12px] font-bold text-brand">{title}</h3>{children}</section>;
}
function Toggle({ v, set, label }: { v: boolean; set: (b: boolean) => void; label: string }) {
  return <label className="flex cursor-pointer items-center gap-2 py-0.5 text-[12px]"><input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} />{label}</label>;
}
function Slider({ label, min, max, step, v, on }: { label: string; min: number; max: number; step: number; v: number; on: (v: number) => void }) {
  return (
    <label className="fld mb-2">
      <span className="flex justify-between"><span>{label}</span></span>
      <span className="flex items-center gap-2">
        <input type="range" min={min} max={max} step={step} value={v} onChange={(e) => on(Number(e.target.value))} />
        <input aria-label={label} type="number" className="w-[64px]" min={min} max={max} step={step} value={v} onChange={(e) => on(Number(e.target.value))} />
      </span>
    </label>
  );
}
function Row({ k, a, b }: { k: string; a: React.ReactNode; b: React.ReactNode }) {
  return <tr><td>{k}</td><td className="num">{a}</td><td className={`num ${String(a) !== String(b) ? "font-bold text-scen-b" : ""}`}>{b}</td></tr>;
}

export type { SceneBuilding };
