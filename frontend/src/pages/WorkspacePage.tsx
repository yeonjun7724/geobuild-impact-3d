import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Building2, Eye, Grid3x3, Keyboard, Layers, Map as MapIcon, Mountain, Redo2, RotateCcw, Sparkles, Sun, Tag, Undo2, Users, Zap } from "lucide-react";
import { api, kstToUtcIso, type Preview, type SceneBuilding, type SceneResp, type SunPathData, type Transform } from "../api";
import { DISCLAIMER, DataBadges, Disclaimer, ErrorBox, Loading, TopBar, useProject } from "../components/Chrome";
import SyncedViewers, { type ViewMode } from "../components/SyncedViewers";
import type { Basemap, EditConfig, Line, PickResult, TerrainGrid } from "../components/CesiumScene";
import { SunPath, TimelineDock } from "../components/Timeline";
import { draftBuilding, ringDistance, ringOpen, type Pt } from "../geometry";
import { Panel, Segmented, SliderField, Spinner, Stat } from "../ui";

const ZERO: Transform = { dx: 0, dy: 0, rot_deg: 0, floors_delta: 0 };
const LIM = { dx: 60, dy: 60, rot_deg: 45, floors_delta: 10 };
const clampT = (t: Transform): Transform => ({
  dx: Math.max(-LIM.dx, Math.min(LIM.dx, Math.round(t.dx * 2) / 2)), dy: Math.max(-LIM.dy, Math.min(LIM.dy, Math.round(t.dy * 2) / 2)),
  rot_deg: Math.max(-LIM.rot_deg, Math.min(LIM.rot_deg, Math.round(t.rot_deg * 2) / 2)), floors_delta: Math.max(-LIM.floors_delta, Math.min(LIM.floors_delta, Math.round(t.floors_delta))),
});
const same = (a?: Transform, b?: Transform) => JSON.stringify(clampT(a ?? ZERO)) === JSON.stringify(clampT(b ?? ZERO));
type Drafts = Record<string, Transform>;

export default function WorkspacePage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { p, err, reload } = useProject(id);
  const [sa, setSa] = useState<SceneResp | null>(null);
  const [sb, setSb] = useState<SceneResp | null>(null);
  const [grid, setGrid] = useState<TerrainGrid | null>(null);
  const [sun, setSun] = useState<SunPathData | null>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("OVERLAY");
  const [basemap, setBasemap] = useState<Basemap>("light");
  const [shadows, setShadows] = useState(true);
  const [ctx, setCtx] = useState(true);
  const [floorLines, setFloorLines] = useState(true);
  const [labels, setLabels] = useState(true);
  const [rings, setRings] = useState(true);
  const [time, setTime] = useState("12:00");
  const [date, setDate] = useState("2026-12-22");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [live, setLive] = useState<Drafts | null>(null); // during drag
  const [past, setPast] = useState<Drafts[]>([]);
  const [future, setFuture] = useState<Drafts[]>([]);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pvBusy, setPvBusy] = useState(false);
  const dragBase = useRef<{ id: string; t: Transform } | null>(null);
  const pvTimer = useRef<number | undefined>(undefined);

  const loadScenes = useCallback(async () => {
    const [a, b] = await Promise.all([api.scene(id, "A"), api.scene(id, "B")]);
    setSa(a);
    setSb(b);
    const d: Drafts = {};
    for (const x of b.buildings) if (x.kind === "MAIN") d[x.id] = { ...ZERO, ...x.transform };
    setDrafts(d);
    setSel((s) => s ?? (Object.keys(b.scenario.transforms)[0] ?? b.buildings.find((x) => x.kind === "MAIN")?.id ?? null));
    return d;
  }, [id]);
  const runPreview = useCallback((d: Drafts) => {
    window.clearTimeout(pvTimer.current);
    pvTimer.current = window.setTimeout(async () => {
      setPvBusy(true);
      try { setPreview(await api.preview(id, Object.fromEntries(Object.entries(d).filter(([, t]) => !same(t, ZERO))), date)); }
      catch (e: any) { setMsg(e.message); } finally { setPvBusy(false); }
    }, 450);
  }, [id, date]);
  useEffect(() => {
    loadScenes().then(runPreview).catch((e) => setMsg(e.message));
    api.terrainGrid(id).then(setGrid).catch(() => setGrid(null));
    api.runs(id).then(setRuns).catch(() => {});
  }, [id, loadScenes, runPreview]);
  useEffect(() => {
    if (p) api.sun(date, p.frame.lat0, p.frame.lon0).then(setSun).catch(() => {});
  }, [date, p]);

  const scB = p?.scenarios.find((s) => s.code === "B");
  const shown = live ?? drafts;
  const bBuildings: SceneBuilding[] = useMemo(() => (sb ? sb.buildings.map((b) => (b.kind === "MAIN" && shown[b.id] && !same(shown[b.id], b.transform) ? draftBuilding(b, shown[b.id]) : b)) : []), [sb, shown]);
  const changed = useMemo(() => new Set(Object.entries(shown).filter(([, t]) => !same(t, ZERO)).map(([k]) => k)), [shown]);
  const dirty = useMemo(() => sb ? sb.buildings.some((b) => b.kind === "MAIN" && drafts[b.id] && !same(drafts[b.id], b.transform)) : false, [sb, drafts]);

  /** Persist drafts that differ from the saved scenario (only changed buildings are PATCHed). */
  const commit = useCallback(async (next: Drafts, record = true) => {
    if (!sb || !scB) return;
    if (record) { setPast((h) => [...h.slice(-49), drafts]); setFuture([]); }
    setDrafts(next);
    setLive(null);
    runPreview(next);
    const todo = sb.buildings.filter((b) => b.kind === "MAIN" && !same(next[b.id], b.transform));
    if (!todo.length) return;
    setSaving("saving");
    try {
      for (const b of todo) await api.patchBuilding(scB.id, b.id, clampT(next[b.id] ?? ZERO));
      const [bScene] = await Promise.all([api.scene(id, "B")]);
      setSb(bScene);
      reload();
      setSaving("saved");
      const w = [...new Set(bScene.buildings.flatMap((x) => x.warnings))];
      setMsg(w.length ? `⚠ ${w.join(" · ")}` : null);
    } catch (e: any) { setSaving("error"); setMsg(e.message); }
  }, [sb, scB, drafts, id, reload, runPreview]);

  const setOne = (bid: string, t: Transform, record = true) => commit({ ...drafts, [bid]: clampT(t) }, record);
  const undo = () => { if (!past.length) return; const prev = past[past.length - 1]; setPast(past.slice(0, -1)); setFuture((f) => [drafts, ...f]); commit(prev, false); };
  const redo = () => { if (!future.length) return; const nxt = future[0]; setFuture(future.slice(1)); setPast((h) => [...h, drafts]); commit(nxt, false); };

  // keyboard: arrows move (Shift ×5), Q/E rotate, [ ] floors, Ctrl+Z / Ctrl+Shift+Z
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); return redo(); }
      if (e.key === " ") { e.preventDefault(); return setPlaying((x) => !x); }
      if (!sel || mode === "A" || mode === "SPLIT") return;
      const t = drafts[sel] ?? ZERO, k = e.shiftKey ? 5 : 1;
      const map: Record<string, Transform> = {
        ArrowLeft: { ...t, dx: t.dx - k }, ArrowRight: { ...t, dx: t.dx + k }, ArrowUp: { ...t, dy: t.dy + k }, ArrowDown: { ...t, dy: t.dy - k },
        q: { ...t, rot_deg: t.rot_deg + k }, e: { ...t, rot_deg: t.rot_deg - k }, "]": { ...t, floors_delta: t.floors_delta + 1 }, "[": { ...t, floors_delta: t.floors_delta - 1 },
      };
      const nt = map[e.key] ?? map[e.key.toLowerCase()];
      if (nt) { e.preventDefault(); setOne(sel, nt); }
      if (e.key === "Escape") setSel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const edit: EditConfig | null = useMemo(() => sb ? {
    ids: new Set(sb.buildings.filter((b) => b.kind === "MAIN").map((b) => b.id)),
    centroids: Object.fromEntries(bBuildings.map((b) => [b.id, b.centroid as Pt])),
    onDrag: (bid, d, phase) => {
      if (!dragBase.current || dragBase.current.id !== bid) { dragBase.current = { id: bid, t: drafts[bid] ?? ZERO }; setSel(bid); }
      const b0 = dragBase.current.t;
      const nt = clampT({ ...b0, dx: b0.dx + d.dx, dy: b0.dy + d.dy, rot_deg: b0.rot_deg + d.drot });
      if (phase === "move") setLive({ ...drafts, [bid]: nt });
      else { dragBase.current = null; commit({ ...drafts, [bid]: nt }); }
    },
  } : null, [sb, bBuildings, drafts, commit]);

  // live clearance lines for the selected building (client-side, ENU metres)
  const clrLines: Line[] = useMemo(() => {
    if (!sel || !sa) return [];
    const me = bBuildings.find((b) => b.id === sel);
    const meA = sa.buildings.find((b) => b.id === sel);
    if (!me || !meA) return [];
    const R = ringOpen(me.footprint), RA = ringOpen(meA.footprint);
    return bBuildings.filter((o) => o.id !== sel && o.kind === "MAIN").map((o) => {
      const r = ringDistance(R, ringOpen(o.footprint));
      const oA = sa.buildings.find((x) => x.id === o.id);
      const dA = oA ? ringDistance(RA, ringOpen(oA.footprint)).d : r.d;
      return { r, dA, o };
    }).sort((x, y) => x.r.d - y.r.d).slice(0, 2).map(({ r, dA, o }) => {
      const delta = r.d - dA;
      const col = r.overlap ? "#ff3b3b" : delta < -0.05 ? "#ff6464" : delta > 0.05 ? "#4a94ff" : "#5d6b82";
      return { a: r.pa, b: r.pb, z: sb?.pad_z ?? 0, color: col, width: 3,
        label: r.overlap ? `${sel}↔${o.id} 중첩!` : `${sel}↔${o.id} ${r.d.toFixed(1)}m${Math.abs(delta) > 0.05 ? ` (${delta > 0 ? "+" : ""}${delta.toFixed(1)})` : ""}` };
    });
  }, [sel, bBuildings, sa, sb]);

  const onPick = (pk: PickResult) => {
    if (pk.type !== "building") return;
    const b = sb?.buildings.find((x) => x.id === pk.id);
    if (b?.kind === "MAIN") setSel(pk.id);
    else setMsg(`${pk.id}: 주변 참고건물 (편집 대상 아님)`);
  };
  const latestOk = runs.find((r) => r.status === "SUCCEEDED");
  if (err) return <ErrorBox msg={err} />;
  if (!p || !sa || !sb) return <div className="flex h-full flex-col"><TopBar project={p} /><Loading text="3D 장면·분석 지형 불러오는 중…" /></div>;
  const bA = sa.buildings.find((x) => x.id === sel);
  const bB = bBuildings.find((x) => x.id === sel);
  const t = sel ? (shown[sel] ?? ZERO) : ZERO;
  const ringsData = rings ? [
    ...sb.open_spaces.map((o) => ({ ring: o.polygon, z: sb.pad_z, color: "#3ee39a", label: o.name.replace(" (DEMO 가상)", "") + " · 가상" })),
    { ring: sb.site_boundary, z: sb.pad_z, color: "#7d8ba3", width: 1.5 },
  ] : [];
  const pv = preview;
  const dA = pv ? pv.A.mean_total_min_b - pv.A.mean_total_min_a : 0;

  return (
    <div className="flex h-full flex-col">
      <TopBar project={p} latestRunId={latestOk?.id} right={
        <>
          <span className="flex items-center gap-1.5 text-[11.5px] text-ink-2" aria-live="polite">
            {saving === "saving" ? <><Spinner size={12} />저장 중</> : saving === "error" ? <span className="text-bad">저장 실패</span> : <><span className="live-dot" />B rev {scB?.revision} 저장됨</>}
          </span>
          <button className="btn btn-primary" onClick={() => nav(`/projects/${id}/analysis`)} data-testid="go-analysis"><Zap size={14} />정밀 분석 실행</button>
        </>
      } />
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0">
          <SyncedViewers mode={mode} a={sa.buildings} b={bBuildings} modelMatrix={sb.model_matrix} padZ={sb.pad_z} ground={null} terrainGrid={grid}
            basemap={basemap} timeUtc={kstToUtcIso(date, time)} shadows={shadows} showContext={ctx} floorLines={floorLines} labels={labels}
            selected={sel} changed={changed} onPick={onPick} rings={ringsData} edit={edit} sideB={{ lines: clrLines }} />
        </div>

        {/* top toolbar */}
        <div className="glass absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 px-2 py-1.5">
          <Segmented ariaLabel="보기 방식" value={mode} onChange={setMode} options={[
            { value: "A", label: "A 기준안" }, { value: "B", label: "B 변경안" }, { value: "OVERLAY", label: "전후 오버레이" }, { value: "SPLIT", label: "좌우 분할" }]} />
          <div className="h-5 w-px bg-line" />
          <ToolToggle on={shadows} set={setShadows} icon={<Sun size={15} />} label="3D 그림자 프리뷰 (시각용)" />
          <ToolToggle on={ctx} set={setCtx} icon={<Users size={15} />} label="주변 참고건물" />
          <ToolToggle on={floorLines} set={setFloorLines} icon={<Layers size={15} />} label="층 구분선" />
          <ToolToggle on={labels} set={setLabels} icon={<Tag size={15} />} label="동 라벨" />
          <ToolToggle on={rings} set={setRings} icon={<Grid3x3 size={15} />} label="가상 놀이터·휴게공간·대지경계" />
          <div className="h-5 w-px bg-line" />
          <MapIcon size={14} className="text-muted" />
          <select aria-label="배경지도" value={basemap} onChange={(e) => setBasemap(e.target.value as Basemap)} className="!h-7 text-[12px]">
            <option value="light">라이트 지도</option><option value="dark">다크 지도</option><option value="osm">OSM 컬러</option><option value="none">지도 없음</option>
          </select>
        </div>

        {/* left: editor */}
        <div className="absolute bottom-[132px] left-3 top-3 z-10 flex w-[300px] flex-col gap-3 overflow-y-auto pr-0.5">
          <Panel title="설계 편집 · 변경안 B" icon={<Building2 size={14} />} actions={
            <div className="flex gap-1">
              <button className="btn btn-sm btn-icon btn-ghost" onClick={undo} disabled={!past.length} title="되돌리기 (Ctrl+Z)" aria-label="되돌리기"><Undo2 size={14} /></button>
              <button className="btn btn-sm btn-icon btn-ghost" onClick={redo} disabled={!future.length} title="다시하기 (Ctrl+Shift+Z)" aria-label="다시하기"><Redo2 size={14} /></button>
            </div>}>
            <div className="mb-3 grid grid-cols-4 gap-1.5">
              {sb.buildings.filter((b) => b.kind === "MAIN").map((b) => (
                <button key={b.id} onClick={() => setSel(b.id)} aria-pressed={sel === b.id}
                  className={`relative h-9 rounded-lg border text-[12.5px] font-bold transition ${sel === b.id ? "border-accent bg-accent/20 text-white" : "border-line bg-white/[0.03] text-ink-2 hover:text-ink"}`}>
                  {b.id}
                  {changed.has(b.id) && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-scen-b" />}
                </button>
              ))}
            </div>
            {sel && bA && bB ? (
              <div className="rise" key={sel}>
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-[13px] font-bold">{sel}동 <span className="ml-1 text-[11px] font-medium text-muted">{bA.floors}F → <b className={bB.floors !== bA.floors ? "text-scen-b" : ""}>{bB.floors}F</b> · {bB.height_m.toFixed(1)} m</span></div>
                  <button className="btn btn-sm btn-ghost" onClick={() => setOne(sel, ZERO)} title="이 주동을 기준안 위치로"><RotateCcw size={12} />되돌리기</button>
                </div>
                <SliderField label="동서 이동 (동 +)" unit="m" min={-60} max={60} step={0.5} value={t.dx} onChange={(v) => setLive({ ...drafts, [sel]: clampT({ ...t, dx: v }) })} onCommit={() => setOne(sel, shown[sel])} />
                <SliderField label="남북 이동 (북 +)" unit="m" min={-60} max={60} step={0.5} value={t.dy} onChange={(v) => setLive({ ...drafts, [sel]: clampT({ ...t, dy: v }) })} onCommit={() => setOne(sel, shown[sel])} />
                <SliderField label="회전 (반시계 +)" unit="°" min={-45} max={45} step={0.5} value={t.rot_deg} onChange={(v) => setLive({ ...drafts, [sel]: clampT({ ...t, rot_deg: v }) })} onCommit={() => setOne(sel, shown[sel])} />
                <SliderField label="층수 증감 (1층 = 2.9 m)" unit="층" min={-10} max={10} step={1} value={t.floors_delta} onChange={(v) => setLive({ ...drafts, [sel]: clampT({ ...t, floors_delta: v }) })} onCommit={() => setOne(sel, shown[sel])} />
              </div>
            ) : <div className="py-3 text-center text-[12px] text-muted">3D 화면이나 위 목록에서 주동을 선택하세요</div>}
            <div className="mt-2 rounded-lg bg-black/25 p-2.5 text-[11px] leading-relaxed text-ink-2">
              <div className="mb-1 flex items-center gap-1 font-semibold text-ink"><Keyboard size={12} />직접 편집</div>
              <div>드래그 <span className="text-muted">이동</span> · <kbd>Shift</kbd>+드래그 <span className="text-muted">회전</span></div>
              <div><kbd>←↑↓→</kbd> 1 m (<kbd>Shift</kbd> 5 m) · <kbd>Q</kbd>/<kbd>E</kbd> 회전 · <kbd>[</kbd>/<kbd>]</kbd> 층수</div>
              <div><kbd>Ctrl</kbd>+<kbd>Z</kbd> 되돌리기 · <kbd>Space</kbd> 시간 재생</div>
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px] text-muted">
              <span>기준안 A는 잠금 · 변경은 B에 즉시 저장{dirty ? " (저장 대기)" : ""}</span>
              <button className="btn btn-sm btn-ghost" onClick={async () => { if (confirm("변경안 B를 기준안 A와 동일하게 초기화할까요? (기존 분석·보고서는 보존)")) { await api.resetB(id); const d = await loadScenes(); reload(); setPast([]); setFuture([]); runPreview(d); } }}>B 초기화</button>
            </div>
            <p className="mt-2 border-t border-line pt-2 text-[10.5px] leading-snug text-[#d9c08a]">⚠ {DISCLAIMER}</p>
          </Panel>
        </div>

        {/* right: impact + inspector */}
        <div className="absolute bottom-[132px] right-3 top-16 z-10 flex w-[320px] flex-col gap-3 overflow-y-auto pl-0.5">
          <Panel title="실시간 영향 미리보기" icon={<Sparkles size={14} />} actions={pvBusy ? <Spinner size={13} /> : pv ? <span className="text-[10.5px] text-muted">{pv.elapsed_s.toFixed(2)}s</span> : null}>
            {pv ? (
              <div data-testid="live-preview">
                <div className="grid grid-cols-2 gap-2">
                  <Stat label="일조 감소 수광점" value={pv.A.n_decreased.toLocaleString()} tone={pv.A.n_decreased ? "bad" : undefined} sub={`증가 ${pv.A.n_increased}`} />
                  <Stat label="평균 직사일조 Δ" value={`${dA > 0 ? "+" : ""}${dA.toFixed(1)}분`} tone={dA < -0.05 ? "bad" : dA > 0.05 ? "good" : undefined} sub={`${pv.A.mean_total_min_b.toFixed(0)}분/일`} />
                  <Stat label="최대 신규 음영" value={`${Math.round(pv.B.max_new_shade_m2).toLocaleString()}m²`} tone={pv.B.max_new_shade_m2 > 0 ? "warn" : undefined}
                    sub={pv.B.snapshots.map((s) => `${s.time.slice(0, 2)}시 ${Math.round(s.new_shade_m2 / 100) / 10}k`).join(" · ")} />
                  <Stat label="최소 이격 (B)" value={pv.C.min_pair_b ? `${pv.C.min_pair_b.distance_m.toFixed(1)}m` : "-"}
                    tone={pv.C.min_pair_b && pv.C.min_pair_a && pv.C.min_pair_b.distance_m < pv.C.min_pair_a.distance_m - 0.01 ? "bad" : undefined}
                    sub={pv.C.min_pair_b ? `${pv.C.min_pair_b.pair_id.replace("|", "↔")} · A ${pv.C.min_pair_a?.distance_m.toFixed(1)}m` : ""} />
                </div>
                {Object.keys(pv.A.per_building_mean_delta).length > 0 && (
                  <div className="mt-2.5">
                    <div className="label mb-1">주동별 평균 직사일조 변화 (분)</div>
                    {Object.entries(pv.A.per_building_mean_delta).map(([bid, v]) => {
                      const w = Math.min(100, Math.abs(v) / 40 * 100);
                      return (
                        <div key={bid} className="flex items-center gap-2 py-[2px] text-[11.5px]">
                          <span className={`w-9 font-semibold ${changed.has(bid) ? "text-scen-b" : "text-ink-2"}`}>{bid}</span>
                          <div className="relative h-2 flex-1 rounded bg-white/5">
                            <div className={`absolute top-0 h-2 rounded ${v < 0 ? "right-1/2 bg-bad" : "left-1/2 bg-accent"}`} style={{ width: `${w / 2}%` }} />
                            <div className="absolute left-1/2 top-[-2px] h-3 w-px bg-white/30" />
                          </div>
                          <span className={`w-12 text-right tnum ${v < 0 ? "text-bad" : v > 0 ? "pos" : "text-muted"}`}>{v > 0 ? "+" : ""}{v.toFixed(1)}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {pv.C.warnings.length > 0 && <div className="mt-2 rounded-md bg-bad/10 px-2 py-1.5 text-[11px] text-[#ffb4b4]">⚠ {pv.C.warnings.join(" · ")}</div>}
                <div className="mt-2 text-[10.5px] leading-snug text-muted">{pv.rule}</div>
                <button className="btn btn-primary mt-2.5 w-full" onClick={() => nav(`/projects/${id}/analysis`)}><Zap size={14} />이 변경안으로 정밀 분석 → 보고서</button>
              </div>
            ) : <div className="flex items-center gap-2 py-4 text-[12px] text-muted"><Spinner />영향 계산 중…</div>}
          </Panel>
          {sel && bA && bB && (
            <Panel title={`선택 주동 ${sel}동 · A ↔ B`} icon={<Eye size={14} />} collapsible pad={false}>
              <table className="tbl"><thead><tr><th>항목</th><th className="num">A</th><th className="num">B</th></tr></thead><tbody>
                <Row k="층수" a={bA.floors} b={bB.floors} /><Row k="높이 (m)" a={bA.height_m.toFixed(1)} b={bB.height_m.toFixed(1)} />
                <Row k="지반고 z (m)" a={bA.base_z.toFixed(2)} b={bB.base_z.toFixed(2)} /><Row k="중심 E (m)" a={bA.centroid[0].toFixed(1)} b={bB.centroid[0].toFixed(1)} />
                <Row k="중심 N (m)" a={bA.centroid[1].toFixed(1)} b={bB.centroid[1].toFixed(1)} /><Row k="회전 (°)" a="0" b={t.rot_deg.toFixed(1)} />
              </tbody></table>
            </Panel>
          )}
          {sun && (
            <Panel title="태양 궤적 · 분석일" icon={<Sun size={14} />} collapsible actions={<input type="date" aria-label="분석일" value={date} onChange={(e) => setDate(e.target.value)} className="!h-6 !text-[11px]" />}>
              <SunPath sun={sun} time={time} />
              <div className="mt-1 flex justify-between text-[11px] text-ink-2"><span>일출 ≈ {sun.sunrise_approx}</span><span>남중고도 {sun.noon_elevation_max.toFixed(1)}°</span><span>일몰 ≈ {sun.sunset_approx}</span></div>
            </Panel>
          )}
          <Panel title="데이터 상태" icon={<Mountain size={14} />} collapsible defaultOpen={false}>
            <DataBadges b={p.data_badges} />
            <Disclaimer className="mt-2" />
            <div className="mt-2 space-y-0.5 text-[11px] text-muted">
              <div>원점 {p.frame.lat0}N, {p.frame.lon0}E (LH 공고 대표점) · 계산 local ENU · 교환 EPSG:5179</div>
              <div>3D 지형 = 분석 지면 높이장(pad {sb.pad_z.toFixed(1)} m 기준 표시) · 그림자는 시각용 프리뷰</div>
            </div>
          </Panel>
        </div>

        {/* bottom timeline */}
        <div className="absolute bottom-3 left-3 right-3 z-10">
          <TimelineDock date={date} time={time} onTime={setTime} playing={playing} onPlaying={setPlaying} speed={speed} onSpeed={setSpeed} sun={sun} />
        </div>
        {msg && <div className="glass absolute bottom-[140px] left-1/2 z-20 -translate-x-1/2 px-3 py-2 text-[12px]" role="status">{msg} <button className="ml-2 text-accent underline" onClick={() => setMsg(null)}>닫기</button></div>}
      </div>
    </div>
  );
}

function ToolToggle({ on, set, icon, label }: { on: boolean; set: (b: boolean) => void; icon: React.ReactNode; label: string }) {
  return <button className={`btn btn-sm btn-icon !h-7 !w-7 ${on ? "!bg-accent/20 !text-white !border-accent/50" : "btn-ghost text-muted"}`} onClick={() => set(!on)} aria-pressed={on} title={label} aria-label={label}>{icon}</button>;
}
function Row({ k, a, b }: { k: string; a: React.ReactNode; b: React.ReactNode }) {
  return <tr><td className="text-ink-2">{k}</td><td className="num">{a}</td><td className={`num ${String(a) !== String(b) ? "font-bold text-scen-b" : ""}`}>{b}</td></tr>;
}
