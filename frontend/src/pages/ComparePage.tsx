import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertTriangle, BarChart3, ChevronDown, ChevronUp, CircleCheck, CircleAlert, ClipboardList, Download, FileText, Gavel, Lightbulb, ListChecks, OctagonAlert, MousePointerClick, Ruler, Sun, Table2, TreePine } from "lucide-react";
import { api, b64ToU8, downloadText, kstToUtcIso, toCsv, type SceneBuilding, type SunPathData } from "../api";
import { Disclaimer, ErrorBox, Loading, PlanView, TopBar, divColor, useProject } from "../components/Chrome";
import SyncedViewers, { type ViewMode } from "../components/SyncedViewers";
import type { Basemap, GridImage, Line as L3, PickResult, ReceiverPt, TerrainGrid } from "../components/CesiumScene";
import { SunPath, TimelineDock, toMin } from "../components/Timeline";
import { Empty, Legend, Panel, Segmented, Spinner, Stat } from "../ui";

type Tab = "S" | "L" | "A" | "B" | "C";
type GridMetric = "live" | "delta" | "shadeA" | "shadeB";
const STATE_RGBA = ["rgba(255,247,214,0.0)", "rgba(70,78,96,0.55)", "rgba(240,72,72,0.92)", "rgba(64,140,255,0.92)"]; // sun→sun, shade→shade, new, relieved
const tooltipStyle = { background: "#0f1a2c", border: "1px solid #2a3c5b", borderRadius: 8, fontSize: 11 };

export default function ComparePage({ captureMode = false }: { captureMode?: boolean }) {
  const { id = "", runId = "" } = useParams();
  const nav = useNavigate();
  const { p } = useProject(captureMode ? undefined : id);
  const [res, setRes] = useState<any>(null);
  const [scene, setScene] = useState<{ model_matrix: number[]; pad_z: number; site: any; scenarios: Record<"A" | "B", SceneBuilding[]> } | null>(null);
  const [grid3d, setGrid3d] = useState<TerrainGrid | null>(null);
  const [sunData, setSunData] = useState<SunPathData | null>(null);
  const [sun, setSun] = useState<any>(null);
  const [shadow, setShadow] = useState<any>(null);
  const [tl, setTl] = useState<null | { times: string[]; bpt: number; a: Uint8Array; b: Uint8Array; n: number }>(null);
  const [clr, setClr] = useState<any>(null);
  const [tab, setTab] = useState<Tab>(captureMode ? "B" : "S");
  const [mode, setMode] = useState<ViewMode>(captureMode ? "B" : "SPLIT");
  const [basemap, setBasemap] = useState<Basemap>("light");
  const [time, setTime] = useState("12:00");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [shadows, setShadows] = useState(true);
  const [metric, setMetric] = useState<GridMetric>(captureMode ? "delta" : "live");
  const [selRec, setSelRec] = useState<string | null>(null);
  const [recSeries, setRecSeries] = useState<any>(null);
  const [cell, setCell] = useState<any>(null);
  const [selBld, setSelBld] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.results(runId);
        setRes(r);
        const [sc, g] = await Promise.all([api.runScene(runId), api.runTerrainGrid(runId).catch(() => null)]);
        setScene(sc);
        setGrid3d(g);
        const s = r.summary;
        if (s.A) api.sunlight(runId).then(setSun);
        if (s.B) api.shadow(runId).then(setShadow);
        if (s.C) api.clearance(runId).then(setClr);
        if (s.B && !captureMode) api.shadowTimeline(runId).then((t) => setTl({ times: t.times_local, bpt: t.bytes_per_time, a: b64ToU8(t.shade_a_b64), b: b64ToU8(t.shade_b_b64), n: t.n_cells })).catch(() => {});
      } catch (e: any) { setErr(e.message); }
    })();
  }, [runId, captureMode]);
  const sm = res?.summary;
  const date = sm?.params?.date ?? "2026-12-22";
  useEffect(() => {
    if (sm && !captureMode) api.sun(date, 37.5559943, 126.7545222).then(setSunData).catch(() => {});
  }, [sm, date, captureMode]);
  useEffect(() => { if (selRec) api.receiver(runId, selRec).then(setRecSeries).catch((e) => setErr(e.message)); }, [selRec, runId]);
  const changed = useMemo(() => new Set<string>(sm?.changed_buildings ?? []), [sm]);

  // ---- A: facade heat tiles
  const recLim = useMemo(() => (sun ? Math.max(30, ...sun.receivers.map((r: any) => Math.abs(r.delta_total_min))) : 30), [sun]);
  const facade = useMemo(() => {
    if (!sun || tab !== "A") return { a: undefined, b: undefined };
    const rows = selBld ? sun.receivers.filter((r: any) => r.building_id === selBld) : sun.receivers;
    const mk = (s: "a" | "b"): ReceiverPt[] => rows.map((r: any) => ({ id: r.receiver_id, x: r[`x_${s}`], y: r[`y_${s}`], z: r[`z_${s}`], nx: r[`nx_${s}`] ?? 0, ny: r[`ny_${s}`] ?? 0, w: r.patch_w,
      color: r.receiver_id === selRec ? "#ffffff" : r.delta_total_min === 0 ? "#d6d9de" : divColor(r.delta_total_min, recLim * 0.7) }));
    return { a: mk("a"), b: mk("b") };
  }, [sun, tab, selRec, selBld, recLim]);

  // ---- B: grid image (static metrics or time-lapse of computed states)
  const validIdx = useMemo(() => (shadow ? shadow.grid.exclusion.map((e: number, i: number) => (e === 0 ? i : -1)).filter((i: number) => i >= 0) as number[] : []), [shadow]);
  const tIdx = useMemo(() => {
    if (!tl) return -1;
    const m = toMin(time);
    let best = 0;
    tl.times.forEach((t, i) => { if (toMin(t) <= m) best = i; });
    return best;
  }, [tl, time]);
  const liveStats = useMemo(() => {
    if (!tl || tIdx < 0) return null;
    let nw = 0, rl = 0, sa = 0, sb = 0;
    const off = tIdx * tl.bpt;
    for (let k = 0; k < tl.n; k++) {
      const by = off + (k >> 3), bit = 7 - (k & 7);
      const A = (tl.a[by] >> bit) & 1, B = (tl.b[by] >> bit) & 1;
      sa += A; sb += B;
      if (!A && B) nw++; else if (A && !B) rl++;
    }
    const ca = shadow?.summary.cell_area_m2 ?? 4;
    return { newArea: nw * ca, relieved: rl * ca, shadeA: sa * ca, shadeB: sb * ca, t: tl.times[tIdx] };
  }, [tl, tIdx, shadow]);
  const gridImg = useMemo<GridImage | null>(() => {
    if (!shadow || tab !== "B") return null;
    const g = shadow.grid;
    const S = 3;
    const cv = document.createElement("canvas");
    cv.width = g.nx * S;
    cv.height = g.ny * S;
    const ctx = cv.getContext("2d")!;
    const put = (i: number, c: string) => { const x = i % g.nx, y = Math.floor(i / g.nx); ctx.fillStyle = c; ctx.fillRect(x * S, (g.ny - 1 - y) * S, S, S); };
    if (metric === "live" && tl && tIdx >= 0) {
      const off = tIdx * tl.bpt;
      validIdx.forEach((cellI, k) => {
        const by = off + (k >> 3), bit = 7 - (k & 7);
        const A = (tl.a[by] >> bit) & 1, B = (tl.b[by] >> bit) & 1;
        const st = A && B ? 1 : !A && B ? 2 : A && !B ? 3 : 0;
        if (st) put(cellI, STATE_RGBA[st]);
      });
    } else {
      const vals: (number | null)[] = metric === "shadeA" ? g.shade_min_a : metric === "shadeB" ? g.shade_min_b : g.delta_min;
      const nz = vals.filter((v) => v !== null && v !== 0).map((v) => Math.abs(v as number)).sort((x, y) => x - y);
      const lim = metric === "shadeA" || metric === "shadeB" ? shadow.summary.analysed_minutes : Math.max(10, nz.length ? nz[Math.floor(nz.length * 0.9)] : 10);
      vals.forEach((v, i) => {
        if (v === null || v === undefined) return;
        if (metric === "shadeA" || metric === "shadeB") { const t = v / lim; put(i, `rgba(${Math.round(40 + 20 * t)},${Math.round(70 + 40 * t)},${Math.round(120 + 100 * t)},${0.15 + 0.7 * t})`); }
        else if (v !== 0) put(i, divColor(v, lim, true, 0.9));
      });
    }
    const h = g.spacing / 2;
    return { url: cv.toDataURL("image/png"), x0: g.x0 - h, y0: g.y0 - h, x1: g.x0 - h + g.nx * g.spacing, y1: g.y0 - h + g.ny * g.spacing, z: scene?.pad_z ?? 0 };
  }, [shadow, tab, metric, tl, tIdx, validIdx, scene?.pad_z]);

  // ---- L: statutory checks (finding lines + site boundary edges)
  const legalLines = useMemo(() => {
    const lg = res?.legal;
    if (!lg || lg.error || tab !== "L") return { a: undefined, b: undefined };
    const z = scene?.pad_z ?? 0;
    const bnd: L3[] = (lg.boundary ?? []).map((p: number[], i: number, arr: number[][]) => ({ a: p, b: arr[(i + 1) % arr.length], z, color: "#3ee39a", width: 2, label: `경계 ${i + 1}` }));
    const mk = (side: "A" | "B"): L3[] => [...bnd, ...lg[side].findings.filter((f: any) => !f.ok || f.margin_m < 3).map((f: any) => ({
      a: f.from, b: f.to, z, color: f.ok ? "#f6bf4f" : "#e5484d", width: f.ok ? 2 : 4,
      label: `${f.check === "N" ? "정북" : f.check === "W" ? "채광" : "동간"} ${f.actual_m.toFixed(1)}m / 기준 ${f.required_m.toFixed(1)}m`,
    }))];
    return { a: mk("A"), b: mk("B") };
  }, [res, tab, scene?.pad_z]);

  // ---- C: nearest-point lines
  const lines = useMemo(() => {
    if (tab === "L") return legalLines;
    if (!clr || tab !== "C") return { a: undefined, b: undefined };
    const closest = [...clr.pairs].sort((x: any, y: any) => x.distance_b_m - y.distance_b_m)[0]?.pair_id;
    const sel = new Set([closest, ...clr.worsened_top.slice(0, 3).map((x: any) => x.pair_id)].filter(Boolean));
    const z = scene?.pad_z ?? 0;
    const mk = (side: "A" | "B"): L3[] => clr.pairs.filter((r: any) => sel.has(r.pair_id)).map((r: any) => {
      const d = side === "A" ? r.distance_a_m : r.distance_b_m;
      const worse = side === "B" && r.delta_m < 0;
      return { a: r[`p_a_${side}`], b: r[`p_b_${side}`], z, color: worse ? "#e5484d" : side === "A" ? "#3b82f6" : "#475569", width: worse ? 4 : 3,
        label: `${r.pair_id.replace("|", "↔")} ${d.toFixed(1)}m${side === "B" && Math.abs(r.delta_m) > 1e-6 ? ` (${r.delta_m > 0 ? "+" : ""}${r.delta_m.toFixed(1)})` : ""}` };
    });
    return { a: mk("A"), b: mk("B") };
  }, [clr, tab, scene?.pad_z, legalLines]);

  const onPick = (pk: PickResult) => {
    if (pk.type === "receiver") { setSelRec(pk.id); setTab("A"); }
    else if (pk.type === "building") setSelBld(pk.id === selBld ? null : pk.id);
    else if (pk.type === "ground" && tab === "B") api.shadowCell(runId, pk.x, pk.y).then(setCell).catch(() => {});
  };

  if (err) return <ErrorBox msg={err} />;
  if (!res || !scene) return <div className="flex h-full flex-col">{!captureMode && <TopBar project={p} />}<Loading text="분석 결과·스냅샷 불러오는 중…" /></div>;
  const viewers = (
    <SyncedViewers mode={mode} a={scene.scenarios.A} b={scene.scenarios.B} modelMatrix={scene.model_matrix} padZ={scene.pad_z} ground={null} terrainGrid={grid3d}
      basemap={captureMode ? "light" : basemap} timeUtc={kstToUtcIso(date, time)} shadows={shadows} showContext changed={changed} selected={selBld}
      sideA={{ facade: facade.a, grid: tab === "B" && metric !== "live" ? gridImg : null, lines: lines.a }} sideB={{ facade: facade.b, grid: gridImg, lines: lines.b }}
      onPick={onPick} onReady={() => setReady(true)} labels={!captureMode}
      rings={(scene.site.open_spaces ?? []).map((o: any) => ({ ring: o.polygon, z: scene.pad_z, color: "#3ee39a" }))} />
  );
  if (captureMode) return <div className="h-screen w-screen" data-capture-ready={ready ? "1" : "0"}>{viewers}</div>;

  const meta = [`run ${runId}`, `분석일 ${date} ${sm.params.start}-${sm.params.end} ${sm.params.timezone}, 간격 ${sm.params.interval_min}분`, `지형 ${sm.terrain.data_class} (${sm.terrain.filename})`, "가상 PoC - 실제 LH 설계안 아님"];
  const curve = sm.B ? sm.B.curve.time_local.map((t: string, i: number) => ({ t, 신규음영: sm.B.curve.new_shade_area_m2[i], 음영해소: sm.B.curve.relieved_area_m2[i] })) : null;
  const tabs = [
    { value: "S" as Tab, label: <span className="flex items-center gap-1"><Lightbulb size={13} />요약</span> },
    { value: "L" as Tab, label: <span className="flex items-center gap-1"><Gavel size={13} />법정</span>, disabled: !res.legal },
    { value: "A" as Tab, label: <span className="flex items-center gap-1"><Sun size={13} />A 일조</span>, disabled: !sm.A },
    { value: "B" as Tab, label: <span className="flex items-center gap-1"><TreePine size={13} />B 그림자</span>, disabled: !sm.B },
    { value: "C" as Tab, label: <span className="flex items-center gap-1"><Ruler size={13} />C 이격</span>, disabled: !sm.C },
  ];
  const sideBottom = drawer ? "46%" : 132;

  return (
    <div className="flex h-full flex-col">
      <TopBar project={p} latestRunId={runId} right={<button className="btn btn-primary" onClick={() => nav(`/reports/${runId}`)} data-testid="go-report"><FileText size={14} />보고서 생성</button>} />
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0">{viewers}</div>

        <div className="glass absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 px-2 py-1.5" role="tablist">
          <Segmented ariaLabel="분석 탭" value={tab} onChange={setTab} options={tabs} />
          <div className="h-5 w-px bg-line" />
          <Segmented ariaLabel="비교 보기" size="sm" value={mode} onChange={setMode} options={[{ value: "SPLIT", label: "분할" }, { value: "OVERLAY", label: "오버레이" }, { value: "A", label: "A" }, { value: "B", label: "B" }]} />
          <select aria-label="배경지도" value={basemap} onChange={(e) => setBasemap(e.target.value as Basemap)} className="!h-7 text-[12px]">
            <option value="light">라이트</option><option value="dark">다크</option><option value="osm">OSM 컬러</option><option value="none">없음</option>
          </select>
          <button className={`btn btn-sm btn-icon !h-7 !w-7 ${shadows ? "!bg-accent/20 !border-accent/50" : "btn-ghost text-muted"}`} onClick={() => setShadows(!shadows)} aria-pressed={shadows} title="3D 그림자 프리뷰 (시각용)"><Sun size={14} /></button>
        </div>

        <div className="absolute left-3 top-3 z-10 flex w-[268px] flex-col gap-3 overflow-y-auto" style={{ bottom: sideBottom }}>
          <Panel title="결과 레이어" icon={<BarChart3 size={14} />}>
            {tab === "S" && <div className="text-[12px] leading-relaxed text-ink-2">오른쪽 <b className="text-ink">검토 판정</b>이 이 변경안을 승인해도 되는지에 대한 답입니다. 각 항목의 <b className="text-ink">3D에서 보기</b>를 누르면 근거(외벽 일조 변화, 시간별 그늘, 동간 최단거리)가 3D 위에 표시됩니다. 주황색 동이 변경된 동입니다.</div>}
            {tab === "A" && <Legend title="Δ 총 직사일조 (분, B−A) · 외벽 타일" stops={["#e2373c", "#ececE8", "#2878e6"]} lo={`−${Math.round(recLim * 0.7)} 감소`} hi={`+${Math.round(recLim * 0.7)} 증가`}
              note="타일 1장 = 수광점 1개(외벽 대리지점, 층 × 외벽 구간). 클릭하면 시간별 0/1과 차폐 원인. 주동을 클릭하면 그 동만 표시." />}
            {tab === "B" && shadow && (
              <>
                <Segmented ariaLabel="격자 지표" size="sm" value={metric} onChange={setMetric} options={[{ value: "live", label: "시간별" }, { value: "delta", label: "누적 Δ" }, { value: "shadeA", label: "A 누적" }, { value: "shadeB", label: "B 누적" }]} />
                <div className="mt-3">
                  {metric === "live" ? (
                    <div className="space-y-1 text-[11.5px]">
                      {[["SUN→SHADE 신규 음영", STATE_RGBA[2]], ["SHADE→SUN 음영 해소", STATE_RGBA[3]], ["SHADE→SHADE (변화 없음)", STATE_RGBA[1]], ["SUN→SUN (투명)", "rgba(255,255,255,0.15)"]].map(([l, c]) => (
                        <div key={l} className="flex items-center gap-2 text-ink-2"><span className="h-3 w-3 rounded-sm" style={{ background: c }} />{l}</div>))}
                      <div className="pt-1 text-[10.5px] text-muted">{tl ? `재생하면 Open3D로 계산한 해당 구간(${liveStats?.t ?? "-"} 중점) 상태가 표시됩니다. 3D 그림자는 같은 순간의 시각 프리뷰.` : "시간별 데이터 불러오는 중…"}</div>
                    </div>
                  ) : metric === "delta" ? <Legend title="Δ 누적 음영시간 (분, B−A)" stops={["#2878e6", "#ececE8", "#e2373c"]} lo="음영 감소" hi="음영 증가" note="색 범위 = |Δ| 90백분위. 격자는 샘플링 간격(DEM 정확도 아님). 지면 클릭 → 셀 시계열." />
                    : <Legend title="누적 음영시간 (분)" stops={["#28466e00", "#3c6eb4", "#9fd0ff"]} lo="0" mid="" hi={`${shadow.summary.analysed_minutes}`} />}
                </div>
              </>
            )}
            {tab === "L" && <div className="text-[11.5px] leading-relaxed text-ink-2"><span className="text-bad">빨강</span> = 기준 미달, <span className="text-warn">노랑</span> = 여유 3 m 미만. 선은 측정한 최단 지점(정북·벽면 직각 방향)이고 라벨은 실제 거리 / 법정 기준입니다. <span className="text-good">초록</span> = 대지경계선(번호는 오른쪽 설정의 경계 번호).</div>}
            {tab === "C" && <div className="text-[11.5px] leading-relaxed text-ink-2">선 = 최단 수평 이격 연결선(양 끝 최근접점). <span className="text-bad">빨강</span> = B에서 감소. 라벨 = 거리(괄호 Δm). 법정 이격 적합성은 판정하지 않습니다.</div>}
          </Panel>
          <Panel title="2D 배치" icon={<MousePointerClick size={14} />} collapsible defaultOpen={false}>
            <PlanView a={scene.scenarios.A} b={scene.scenarios.B} changed={changed} selected={selBld} onSelect={(b) => setSelBld(b === selBld ? null : b)} size={230} />
          </Panel>
          <Panel title="계산 근거 · 데이터 출처" icon={<ListChecks size={14} />} collapsible defaultOpen={false}>
            <div className="text-[11px] leading-relaxed text-muted">
              분석일 {date} {sm.params.start}–{sm.params.end} KST · {sm.params.interval_min}분 간격<br />
              자동 검증 {res.quality.n_pass}건 통과 / {res.quality.n_fail}건 실패 ({res.quality.verification_status})<br />
              지형 {sm.terrain.data_class} · 수직기준 {sm.terrain.vertical_datum_status}<br />실행 ID {runId}
            </div>
          </Panel>
        </div>

        <div className="absolute right-3 top-16 z-10 flex w-[350px] flex-col gap-3 overflow-y-auto pl-0.5" style={{ bottom: sideBottom }}>
          {tab === "S" && <SummaryPanel res={res} onGo={setTab} />}
          {tab === "L" && <LegalPanel res={res} projectId={id} onChanged={() => api.results(runId).then(setRes).catch((e) => setErr(e.message))} />}
          {tab === "A" && sm.U && <DwellingPanel u={sm.U} onBuilding={(b) => setSelBld(b)} />}
          {tab === "A" && sm.NB && <NeighborPanel nb={sm.NB} />}
          {tab === "A" && <ReceiverPanel s={recSeries} id={selRec} sm={sm} />}
          {tab === "B" && <ShadowPanel sm={sm} cell={cell} live={metric === "live" ? liveStats : null} />}
          {tab === "C" && clr && <ClearPanel c={clr} />}
          {sunData && tab !== "B" && <Panel title="태양 궤적" icon={<Sun size={14} />} collapsible defaultOpen={tab === "S"}><SunPath sun={sunData} time={time} /></Panel>}
        </div>

        <div className="absolute bottom-3 left-3 right-3 z-10 flex flex-col gap-2" style={{ top: drawer ? "55%" : undefined }}>
          <button className="btn btn-sm absolute -top-9 left-1/2 -translate-x-1/2" onClick={() => setDrawer(!drawer)} data-testid="toggle-tables">
            <Table2 size={13} />데이터 표{drawer ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          </button>
          <TimelineDock date={date} time={time} onTime={setTime} playing={playing} onPlaying={setPlaying} speed={speed} onSpeed={setSpeed} sun={sunData}
            title={tab === "B" && curve ? "시각별 신규 음영 / 음영 해소 면적 (m², 구간 중점)" : undefined}
            chart={tab === "B" && curve ? curve : undefined} unit={tab === "B" ? " m²" : undefined}
            series={tab === "B" && curve ? [{ key: "신규음영", label: "신규 음영", color: "#f04848" }, { key: "음영해소", label: "음영 해소", color: "#408cff" }] : undefined} />
          {drawer && (
            <div className="glass rise min-h-0 flex-1 overflow-auto p-3">
              {(tab === "S" || tab === "A") && sun && <SunTables sun={sun} meta={meta} onPick={(r) => { setSelRec(r); setTab("A"); }} sel={selRec} />}
              {tab === "B" && shadow && <ShadowTables s={shadow.summary} meta={meta} />}
              {tab === "C" && clr && <ClearTables c={clr} meta={meta} />}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {res.files.map((f: any) => <a key={f.name} className="chip hover:text-ink" href={f.url}><Download size={11} />{f.name} · {(f.size / 1024).toFixed(0)}KB</a>)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryPanel({ res, onGo }: { res: any; onGo: (t: Tab) => void }) {
  const sm = res.summary;
  const ins = res.insights ?? { exec: [], recs: [] };
  const groups: [Tab, string, React.ReactNode][] = [["A", "[A", <Sun size={13} key="a" />], ["B", "[B", <TreePine size={13} key="b" />], ["C", "[C", <Ruler size={13} key="c" />]];
  const lvl = (l: string) => (l.includes("재검토") ? "chip-bad" : l.includes("정밀") ? "chip-syn" : "chip-up");
  return (
    <>
      {res.review && <ReviewPanel rv={res.review} onGo={onGo} />}
      <Panel title="핵심 수치 (계산값)" icon={<Lightbulb size={14} />} collapsible defaultOpen={false}>
        <div className="mb-3 grid grid-cols-2 gap-2" data-testid="summary-kpis">
          {sm.A && <Stat label="일조 감소 수광점" value={sm.A.n_decreased.toLocaleString()} tone="bad" sub={`최대 ${sm.A.delta_total_min_min}분`} />}
          {sm.A && <Stat label="평균 직사일조" value={`${sm.A.mean_total_min_b.toFixed(0)}분`} sub={`A ${sm.A.mean_total_min_a.toFixed(0)}분`} delta={Math.round((sm.A.mean_total_min_b - sm.A.mean_total_min_a) * 10) / 10} />}
          {sm.B && <Stat label="최대 신규 음영" value={`${Math.round(sm.B.max_new_shade_area_m2).toLocaleString()}m²`} tone="warn" sub={sm.B.max_new_shade_time} />}
          {sm.C?.min_pair_b && <Stat label="최소 이격 (B)" value={`${sm.C.min_pair_b.distance_m.toFixed(1)}m`} sub={`A ${sm.C.min_pair_a.distance_m.toFixed(1)}m · ${sm.C.min_pair_b.pair_id.replace("|", "↔")}`} />}
        </div>
        <div className="space-y-2">
          {groups.map(([t, pre, icon]) => {
            const items = ins.exec.filter((s: string) => s.startsWith(pre));
            if (!items.length) return null;
            return (
              <button key={t} onClick={() => onGo(t)} className="card-2 block w-full p-2.5 text-left transition hover:border-accent/50">
                <div className="mb-1 flex items-center gap-1.5 text-[11.5px] font-bold text-accent">{icon}{t === "A" ? "직사일조" : t === "B" ? "그림자" : "이격거리"}<span className="ml-auto text-[10.5px] font-medium text-muted">3D에서 보기 →</span></div>
                {items.map((s: string, i: number) => <p key={i} className="text-[12px] leading-relaxed text-ink-2">{s.replace(/^\[[^\]]+\]\s*/, "")}</p>)}
              </button>
            );
          })}
        </div>
      </Panel>
      <Panel title="세부 권고 · 추가 자료" icon={<ClipboardList size={14} />} collapsible defaultOpen={false}>
        <div className="space-y-1.5">
          {ins.recs.map((r: any, i: number) => (
            <div key={i} className="card-2 p-2.5">
              <div className="mb-0.5 flex items-center gap-1.5"><span className={`chip ${lvl(r.level)}`}>{r.level}</span><span className="truncate text-[12px] font-semibold text-ink">{r.target}</span></div>
              <div className="text-[11.5px] text-ink-2">{r.basis}</div>
              {r.cause && r.cause !== "-" && <div className="text-[11px] text-muted">{r.cause}</div>}
            </div>
          ))}
        </div>
        <div className="mt-2 flex gap-1.5 text-[10.5px] leading-snug text-muted"><AlertTriangle size={12} className="mt-0.5 shrink-0 text-warn" />분류 기준은 PoC 검토 우선순위용 임의 기준이며 법적 기준이 아닙니다. 법적 위반·침해를 판정하지 않습니다.</div>
      </Panel>
      <Disclaimer />
    </>
  );
}

const LV: Record<string, { cls: string; ring: string; icon: React.ReactNode; label: string }> = {
  red: { cls: "text-bad", ring: "border-bad/50 bg-bad/[0.08]", icon: <OctagonAlert size={15} />, label: "보완 요청" },
  amber: { cls: "text-warn", ring: "border-warn/50 bg-warn/[0.08]", icon: <CircleAlert size={15} />, label: "확인 필요" },
  green: { cls: "text-good", ring: "border-good/40 bg-good/[0.06]", icon: <CircleCheck size={15} />, label: "특이사항 없음" },
};

function ReviewPanel({ rv, onGo }: { rv: any; onGo: (t: Tab) => void }) {
  const top = LV[rv.level] ?? LV.amber;
  return (
    <Panel title="검토 판정 · 이 변경안, 승인해도 되나?" icon={<Gavel size={14} />}>
      <div className={`mb-3 rounded-lg border p-3 ${top.ring}`} data-testid="review-verdict">
        <div className={`flex items-center gap-1.5 text-[11px] font-bold ${top.cls}`}>{top.icon}{top.label}</div>
        <div className="mt-1 text-[14px] font-bold leading-snug text-white">{rv.verdict.split(":").slice(1).join(":").trim() || rv.verdict}</div>
      </div>
      {rv.changes?.length > 0 && (
        <div className="mb-3">
          <div className="label mb-1">변경안(B)에서 바뀐 것</div>
          <ul className="space-y-0.5 text-[12px] text-ink-2">{rv.changes.map((c: any) => <li key={c.building_id}>• {c.text}</li>)}</ul>
        </div>
      )}
      <div className="label mb-1">검토 항목</div>
      <div className="space-y-1.5" data-testid="review-items">
        {rv.items.map((it: any) => {
          const l = LV[it.level] ?? LV.amber;
          return (
            <button key={it.key} onClick={() => onGo(it.tab)} className="card-2 block w-full p-2.5 text-left transition hover:border-accent/50">
              <div className="mb-0.5 flex items-center gap-1.5 text-[11.5px] font-bold">
                <span className={l.cls}>{l.icon}</span><span className="text-ink">{it.title}</span><span className={`ml-1 ${l.cls}`}>{l.label}</span>
                <span className="ml-auto text-[10.5px] font-medium text-muted">3D에서 보기 →</span>
              </div>
              <div className="text-[12.5px] font-semibold leading-snug text-white">{it.headline}</div>
              {it.detail && <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-2">{it.detail}</div>}
              {it.reference && <div className="mt-1 text-[10.5px] text-muted">판단선: {it.reference}</div>}
            </button>
          );
        })}
      </div>
      {rv.caveat && <div className="mt-2 flex gap-1.5 text-[10.5px] leading-snug text-muted"><AlertTriangle size={12} className="mt-0.5 shrink-0 text-warn" />{rv.caveat}</div>}
    </Panel>
  );
}

const CHECK_LABEL: Record<string, string> = { N: "정북방향 일조", W: "채광창 → 대지경계", D: "동간 이격" };

function LegalPanel({ res, projectId, onChanged }: { res: any; projectId: string; onChanged: () => void }) {
  const lg = res.legal;
  const [opt, setOpt] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [side, setSide] = useState<"B" | "A">("B");
  useEffect(() => { api.legalOptions().then(setOpt).catch(() => {}); }, []);
  if (!lg || lg.error) return <Panel title="법정 검토" icon={<Gavel size={14} />}><div className="text-[12px] text-bad">{lg?.error ?? "계산 결과 없음"}</div></Panel>;
  const P = lg.B.params;
  const save = async (patch: Record<string, unknown>) => {
    setBusy(true); setMsg(null);
    try { await api.putLegalParams(projectId, patch); onChanged(); } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };
  const cmp = lg.compare;
  const fs = lg[side].findings as any[];
  const groups = ["N", "W", "D"].map((c) => [c, fs.filter((f) => f.check === c)] as const).filter(([, l]) => l.length)
    .sort((x, y) => y[1].filter((f) => !f.ok).length - x[1].filter((f) => !f.ok).length);
  const status = (f: any) => side === "B" ? cmp.violations_b.find((v: any) => v.check === f.check && v.subject === f.subject && v.basis === f.basis)?.status : undefined;
  return (
    <>
      <Panel title="법정 이격 · 일조 사선 검토" icon={<Gavel size={14} />}>
        <div className="mb-2 grid grid-cols-3 gap-1.5">
          <Stat label="변경안 신규 미달" value={cmp.n_new} tone={cmp.n_new ? "bad" : "good"} />
          <Stat label="기존안부터 미달" value={cmp.n_existing} tone={cmp.n_existing ? "warn" : undefined} />
          <Stat label="검토 항목" value={lg.B.findings.length} />
        </div>
        <Segmented ariaLabel="안 선택" size="sm" value={side} onChange={setSide} options={[{ value: "B", label: "변경안 B" }, { value: "A", label: "기존안 A" }]} />
        <div className="mt-2 space-y-2" data-testid="legal-findings">
          {groups.map(([c, list]) => (
            <div key={c}>
              <div className="label mb-1">{CHECK_LABEL[c]} · {list.filter((f) => !f.ok).length}건 미달 / {list.length}</div>
              {[...list].sort((x, y) => x.margin_m - y.margin_m).slice(0, 8).map((f: any, i: number) => {
                const st = status(f);
                return (
                  <div key={i} className={`card-2 mb-1 p-2 ${f.ok ? "" : "!border-bad/50"}`}>
                    <div className="flex items-center gap-1.5 text-[12px] font-semibold">
                      <span className={f.ok ? "text-good" : "text-bad"}>{f.ok ? "충족" : "미달"}</span>
                      <span className="truncate text-ink">{f.subject}</span>
                      {st && <span className={`chip ml-auto ${st === "NEW" ? "chip-bad" : "chip-syn"}`}>{st === "NEW" ? "변경으로 발생" : "기존부터"}</span>}
                    </div>
                    <div className="text-[11.5px] text-ink-2">실제 <b className="text-ink tnum">{f.actual_m.toFixed(2)} m</b> / 기준 {f.required_m.toFixed(2)} m <span className={f.ok ? "text-good" : "text-bad"}>({f.margin_m >= 0 ? "+" : ""}{f.margin_m.toFixed(2)})</span></div>
                    <div className="text-[10.5px] text-muted">{f.clause} · {f.basis}</div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="mt-2 space-y-0.5 text-[10.5px] leading-snug text-muted">
          <div>정북: {lg.B.north_rule}</div>
          <div>동간 계수 {lg.B.coefficient_k} · {lg.B.coefficient_source}</div>
          {lg.B.notes.map((n: string) => <div key={n}>· {n}</div>)}
        </div>
      </Panel>
      <Panel title="검토 조건 설정" icon={<ListChecks size={14} />} collapsible defaultOpen={false}>
        {!opt ? <Spinner /> : (
          <div className="space-y-2 text-[12px]" data-testid="legal-settings">
            <label className="block"><span className="label">적용 기준일 (허가·변경 신청일)</span>
              <input type="date" className="mt-0.5 w-full" defaultValue={P.ref_date} onBlur={(e) => e.target.value && e.target.value !== P.ref_date && save({ ref_date: e.target.value })} />
              <span className="text-[10.5px] text-muted">{opt.north_rule_change}부터 정북 기준이 3단계(10 m / 17 m)로 바뀝니다.</span></label>
            <label className="block"><span className="label">용도지역</span>
              <select className="mt-0.5 w-full" value={P.zoning} onChange={(e) => save({ zoning: e.target.value })}>{Object.entries(opt.zonings).map(([k, v]) => <option key={k} value={k}>{v as string}</option>)}</select></label>
            <label className="block"><span className="label">정북방향 일조 적용</span>
              <select className="mt-0.5 w-full" value={P.north_mode} onChange={(e) => save({ north_mode: e.target.value })}>
                <option value="APPLY">적용</option><option value="EXEMPT">적용 제외 (영 86조② 각 호)</option><option value="NOTICE">정남방향 고시 높이 적용 (법 61조③)</option></select></label>
            <label className="block"><span className="label">조례</span>
              <select className="mt-0.5 w-full" value={P.preset} onChange={(e) => save({ preset: e.target.value })}>{Object.entries(opt.presets).map(([k, v]: any) => <option key={k} value={k}>{v.label}</option>)}</select></label>
            <label className="block"><span className="label">사업 유형</span>
              <select className="mt-0.5 w-full" value={P.project_type} onChange={(e) => save({ project_type: e.target.value })}>{Object.entries(opt.project_types).map(([k, v]) => <option key={k} value={k}>{v as string}</option>)}</select></label>
            <label className="block"><span className="label">동간 계수 직접 지정 (지구단위계획 등, 비우면 조례값)</span>
              <input type="number" step="0.05" min="0" max="3" className="mt-0.5 w-full" defaultValue={P.k_override ?? ""} placeholder={`${lg.B.coefficient_k}`}
                onBlur={(e) => save({ k_override: e.target.value === "" ? null : Number(e.target.value) })} /></label>
            <div>
              <span className="label">대지경계 밖 도로·공원·하천 폭 (m, 영 86조⑥ 중심선 적용)</span>
              <div className="mt-1 grid grid-cols-4 gap-1">
                {(lg.boundary ?? []).map((_: any, i: number) => (
                  <label key={i} className="text-[10.5px] text-muted">경계 {i + 1}
                    <input type="number" min="0" step="1" className="w-full" defaultValue={P.boundary_beyond_m?.[i] ?? ""} placeholder="0"
                      onBlur={(e) => save({ boundary_beyond_m: { ...(P.boundary_beyond_m ?? {}), [i]: e.target.value === "" ? 0 : Number(e.target.value) } })} /></label>
                ))}
              </div>
            </div>
            <FacadeEditor lg={lg} P={P} save={save} labels={opt.facade_roles} />
            {busy && <div className="flex items-center gap-2 text-muted"><Spinner />재계산 중…</div>}
            {msg && <div className="text-bad">{msg}</div>}
          </div>
        )}
      </Panel>
    </>
  );
}

function FacadeEditor({ lg, P, save, labels }: { lg: any; P: any; save: (p: Record<string, unknown>) => void; labels: Record<string, string> }) {
  const [bid, setBid] = useState<string>(Object.keys(lg.B.facade_roles)[0] ?? "");
  const fr = lg.B.facade_roles[bid];
  if (!fr) return null;
  const setRole = (i: number, r: string) => { const roles = [...fr.roles]; roles[i] = r; save({ facades: { ...(P.facades ?? {}), [bid]: roles } }); };
  return (
    <div>
      <span className="label">벽면 유형 (채광창 벽면 / 창 없는 벽면 / 측벽)</span>
      <select className="mt-0.5 w-full" value={bid} onChange={(e) => setBid(e.target.value)}>{Object.keys(lg.B.facade_roles).map((b) => <option key={b} value={b}>{b}동</option>)}</select>
      <div className="mt-1 space-y-1">
        {fr.roles.map((r: string, i: number) => (
          <div key={i} className="flex items-center gap-1.5 text-[11px]">
            <span className="w-12 text-muted">{i + 1}번 벽</span>
            <select className="!h-7 flex-1 text-[11px]" value={r} onChange={(e) => setRole(i, e.target.value)}>{Object.entries(labels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <label className="flex items-center gap-1 text-muted"><input type="radio" name={`main-${bid}`} checked={fr.main === i} onChange={() => save({ main_facade: { ...(P.main_facade ?? {}), [bid]: i } })} />주개구부</label>
          </div>
        ))}
      </div>
    </div>
  );
}

const DW_STATUS: Record<string, { c: string; l: string }> = {
  NEWLY_BELOW: { c: "#e5484d", l: "변경으로 미달" }, ONLY_B_BELOW: { c: "#ff8a8a", l: "새 세대·미달" }, STILL_BELOW: { c: "#6b7280", l: "기존부터 미달" },
  IMPROVED: { c: "#408cff", l: "개선(충족)" }, OK: { c: "#2f7d5b", l: "충족" }, ONLY_B_OK: { c: "#3fbf8a", l: "새 세대·충족" }, ONLY_A: { c: "#1f2937", l: "B에 없음" },
};

function DwellingPanel({ u, onBuilding }: { u: any; onBuilding: (b: string) => void }) {
  const worst = [...u.by_building].sort((a: any, b: any) => b.newly_below.length - a.newly_below.length)[0]?.building_id;
  const [bid, setBid] = useState<string>(worst ?? u.by_building[0]?.building_id);
  const [cell, setCell] = useState<any>(null);
  const rows = u.rows.filter((r: any) => r.building_id === bid);
  const floors = Math.max(0, ...rows.map((r: any) => r.floor));
  const units = Math.max(0, ...rows.map((r: any) => r.unit));
  const at = new Map(rows.map((r: any) => [`${r.floor}-${r.unit}`, r]));
  const fmt = (m: number | null) => (m === null || m === undefined ? "-" : `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, "0")}`);
  return (
    <Panel title="세대별 일조표 (동지)" icon={<Sun size={14} />}>
      <div className="mb-2 grid grid-cols-3 gap-1.5">
        <Stat label="변경으로 미달" value={u.n_newly_below + u.n_only_b_below} tone={u.n_newly_below + u.n_only_b_below ? "bad" : "good"} />
        <Stat label="기존부터 미달" value={u.n_still_below} tone={u.n_still_below ? "warn" : undefined} />
        <Stat label="B 충족" value={`${u.n_meet_b}/${u.n_b}`} />
      </div>
      <div className="mb-2 flex flex-wrap gap-1">
        {u.by_building.map((g: any) => (
          <button key={g.building_id} onClick={() => { setBid(g.building_id); setCell(null); onBuilding(g.building_id); }}
            className={`chip ${bid === g.building_id ? "!border-accent !text-white" : ""} ${g.newly_below.length ? "!text-[#ff9a9a]" : ""}`}>
            {g.building_id}동{g.newly_below.length ? ` ·${g.newly_below.length}` : ""}
          </button>))}
      </div>
      <div className="overflow-auto" style={{ maxHeight: 300 }} data-testid="dwelling-grid">
        <table className="w-full border-separate" style={{ borderSpacing: 2 }}>
          <tbody>
            {Array.from({ length: floors }, (_, i) => floors - i).map((f) => (
              <tr key={f}>
                <td className="pr-1 text-right text-[10px] text-muted tnum">{f}F</td>
                {Array.from({ length: units }, (_, k) => k + 1).map((k) => {
                  const r: any = at.get(`${f}-${k}`);
                  const st = r ? DW_STATUS[r.status] : null;
                  return (
                    <td key={k} title={r ? `${r.ho}호 · A 연속 ${fmt(r.cont_a)} / 총 ${fmt(r.total_a)} → B 연속 ${fmt(r.cont_b)} / 총 ${fmt(r.total_b)}` : ""}
                      onClick={() => r && setCell(r)} className="h-[18px] cursor-pointer rounded-[3px] text-center text-[9.5px] font-semibold text-white/90"
                      style={{ background: st?.c ?? "transparent", outline: cell?.id === r?.id ? "2px solid #fff" : undefined }}>
                      {r ? r.ho : ""}
                    </td>);
                })}
              </tr>))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-[10.5px] text-ink-2">
        {Object.entries(DW_STATUS).filter(([k]) => rows.some((r: any) => r.status === k)).map(([k, v]) => <span key={k} className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: v.c }} />{v.l}</span>)}
      </div>
      {cell && (
        <div className="card-2 mt-2 p-2 text-[12px]" data-testid="dwelling-detail">
          <div className="font-bold text-white">{bid}동 {cell.ho}호 · {DW_STATUS[cell.status].l}</div>
          <div className="text-ink-2">09~15시 연속: {fmt(cell.cont_a)} → <b className="text-ink">{fmt(cell.cont_b)}</b> · 08~16시 총: {fmt(cell.total_a)} → <b className="text-ink">{fmt(cell.total_b)}</b></div>
          {cell.cause_b && <div className="text-[11px] text-muted">변경안에서 햇빛을 가장 많이 가리는 건물: {cell.cause_b}동</div>}
        </div>)}
      <div className="mt-2 text-[10.5px] leading-snug text-muted">기준: {u.rule}. 측정점: {u.receiver}. 모서리 세대의 측면 창은 반영하지 않습니다.</div>
    </Panel>
  );
}

function NeighborPanel({ nb }: { nb: any }) {
  return (
    <Panel title="주변 기존 건물 일조" icon={<Sun size={14} />} collapsible defaultOpen={nb.n_buildings_affected > 0}>
      <div className="mb-1.5 text-[11.5px] text-ink-2">검토 {nb.n_buildings}동 · 외벽 {nb.n_points}개 지점 · <b className={nb.n_points_newly_below ? "text-bad" : "text-good"}>새로 미달 {nb.n_points_newly_below}곳</b></div>
      <div className="space-y-1" data-testid="neighbor-list">
        {nb.buildings.slice(0, 10).map((g: any) => (
          <div key={g.building_id} className={`card-2 p-2 text-[11.5px] ${g.n_newly_below ? "!border-bad/50" : ""}`}>
            <div className="flex items-center gap-1.5"><b className="truncate text-ink">{g.name}</b><span className="text-muted">{g.building_id}</span>
              <span className="ml-auto chip">{g.use ?? "용도 미상"}</span></div>
            <div className="text-ink-2">{g.n_newly_below ? <span className="text-bad">새로 미달 {g.n_newly_below}곳 ({g.floors[0]}~{g.floors[1]}층 {g.facades.join("/")}면){Object.keys(g.causes).length ? ` · 원인 ${Object.keys(g.causes)[0]}동` : ""}</span> : "새로 미달 없음"} · 최대 일조 감소 {Math.round(g.max_loss_min)}분</div>
          </div>))}
      </div>
      <div className="mt-1.5 text-[10.5px] text-muted">{nb.receiver}. 세대 위치를 알면 해당 세대 창 기준으로 다시 확인하세요.</div>
    </Panel>
  );
}

function ReceiverPanel({ s, id, sm }: { s: any; id: string | null; sm: any }) {
  const per = sm.A?.per_building ?? [];
  return (
    <>
      <Panel title="수광점 상세" icon={<MousePointerClick size={14} />}>
        {!id ? <Empty icon={<MousePointerClick size={22} />} title="외벽 타일을 클릭하세요">시간별 직사일조(0/1), 차폐 원인 건물, 태양 고도·방위를 보여줍니다.</Empty>
          : !s || s.receiver_id !== id ? <div className="flex items-center gap-2 py-6 text-muted"><Spinner />불러오는 중</div> : <ReceiverChart s={s} />}
      </Panel>
      <Panel title="주동별 평균 직사일조 (분)" icon={<BarChart3 size={14} />} collapsible>
        <div style={{ height: 170 }}>
          <ResponsiveContainer>
            <BarChart data={per} margin={{ left: -18, right: 4, top: 4 }}>
              <CartesianGrid stroke="#1d2b44" vertical={false} />
              <XAxis dataKey="building_id" tick={{ fontSize: 10, fill: "#a9b7c9" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: "#6f8098" }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "#ffffff08" }} />
              <Bar dataKey="mean_total_min_a" name="A" fill="#4a94ff" radius={[3, 3, 0, 0]} />
              <Bar dataKey="mean_total_min_b" name="B" fill="#ff8a3d" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>
    </>
  );
}

function ReceiverChart({ s }: { s: any }) {
  const data = s.times_local.map((t: string, i: number) => ({ t: t.slice(11, 16), A: s.A ? s.A.sun[i] + 0.03 : null, B: s.B ? s.B.sun[i] - 0.03 : null, blkB: s.B?.blocker[i] ?? "-", blkA: s.A?.blocker[i] ?? "-", el: s.elevation_deg[i].toFixed(1), az: s.azimuth_deg[i].toFixed(0) }));
  const lost = data.filter((d: any) => d.A > 0.5 && d.B !== null && d.B < 0.5);
  const causes = [...new Set(lost.map((d: any) => d.blkB))].filter((x) => x && x !== "-");
  const dlt = s.A && s.B ? s.B.total_min - s.A.total_min : 0;
  return (
    <div data-testid="receiver-detail">
      <div className="mb-1 font-mono text-[12.5px] font-bold text-white">{s.receiver_id}</div>
      <div className="mb-2 grid grid-cols-3 gap-1.5">
        <Stat label="A" value={`${s.A?.total_min ?? "-"}분`} /><Stat label="B" value={`${s.B?.total_min ?? "-"}분`} />
        <Stat label="Δ" value={`${dlt > 0 ? "+" : ""}${dlt}분`} tone={dlt < 0 ? "bad" : dlt > 0 ? "good" : undefined} />
      </div>
      <div className="mb-1 text-[11.5px] text-ink-2">B에서 잃은 구간 {lost.length}개{causes.length ? ` · 차폐 원인 ${causes.join(", ")}동` : ""}</div>
      <div style={{ height: 150 }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ left: -26, right: 4, top: 6 }}>
            <CartesianGrid stroke="#1d2b44" vertical={false} />
            <XAxis dataKey="t" tick={{ fontSize: 9.5, fill: "#6f8098" }} interval={11} axisLine={false} tickLine={false} />
            <YAxis domain={[-0.15, 1.15]} ticks={[0, 1]} tick={{ fontSize: 9.5, fill: "#6f8098" }} axisLine={false} tickLine={false} />
            <Tooltip content={({ active, payload }) => active && payload?.length ? (
              <div style={tooltipStyle} className="p-2">
                <div className="text-ink"><b>{payload[0].payload.t}</b> · 고도 {payload[0].payload.el}° · 방위 {payload[0].payload.az}°</div>
                <div className="text-scen-a">A: {payload[0].payload.A > 0.5 ? "직사일조" : `없음 (${payload[0].payload.blkA ?? "-"})`}</div>
                <div className="text-scen-b">B: {payload[0].payload.B !== null && payload[0].payload.B > 0.5 ? "직사일조" : `없음 (${payload[0].payload.blkB ?? "-"})`}</div>
              </div>) : null} />
            <Line type="stepAfter" dataKey="A" stroke="#4a94ff" strokeWidth={2} dot={false} isAnimationActive={false} name="A" />
            <Line type="stepAfter" dataKey="B" stroke="#ff8a3d" strokeWidth={2} dot={false} isAnimationActive={false} name="B" />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="text-[10.5px] text-muted">1 = 기하학적 직사일조 가능 · 0 = 차폐/배면/지평선 아래 · 구간 중점 규칙</div>
    </div>
  );
}

function ShadowPanel({ sm, cell, live }: { sm: any; cell: any; live: any }) {
  const b = sm.B;
  return (
    <>
      {live && (
        <Panel title={`이 시각의 음영 변화 · ${live.t.slice(0, 5)} 구간`} icon={<TreePine size={14} />}>
          <div className="grid grid-cols-2 gap-2" data-testid="live-shadow">
            <Stat label="신규 음영" value={`${Math.round(live.newArea).toLocaleString()}m²`} tone="bad" />
            <Stat label="음영 해소" value={`${Math.round(live.relieved).toLocaleString()}m²`} tone="good" />
            <Stat label="A 음영면적" value={`${Math.round(live.shadeA).toLocaleString()}m²`} />
            <Stat label="B 음영면적" value={`${Math.round(live.shadeB).toLocaleString()}m²`} delta={Math.round(live.shadeB - live.shadeA)} />
          </div>
        </Panel>
      )}
      <Panel title="지면 셀 상세" icon={<MousePointerClick size={14} />}>
        {!cell ? <Empty icon={<MousePointerClick size={20} />} title="지면을 클릭하세요">해당 셀의 A/B 음영 시계열과 누적 음영시간 증감을 보여줍니다.</Empty>
          : cell.excluded ? <div className="text-[12px] text-ink-2">셀 ({cell.x.toFixed(1)}, {cell.y.toFixed(1)}) — 분석 제외: {cell.reason}</div> : (
            <div>
              <div className="mb-2 grid grid-cols-3 gap-1.5">
                <Stat label="A 음영" value={`${cell.shade_min_a}분`} /><Stat label="B 음영" value={`${cell.shade_min_b}분`} />
                <Stat label="Δ" value={`${cell.delta_min > 0 ? "+" : ""}${cell.delta_min}분`} tone={cell.delta_min > 0 ? "bad" : cell.delta_min < 0 ? "good" : undefined} />
              </div>
              <div style={{ height: 110 }}>
                <ResponsiveContainer>
                  <LineChart data={cell.times_local.map((t: string, i: number) => ({ t: t.slice(11, 16), A: cell.shade_a[i] + 0.03, B: cell.shade_b[i] - 0.03 }))} margin={{ left: -26, right: 4, top: 6 }}>
                    <CartesianGrid stroke="#1d2b44" vertical={false} />
                    <XAxis dataKey="t" tick={{ fontSize: 9.5, fill: "#6f8098" }} interval={11} axisLine={false} tickLine={false} />
                    <YAxis domain={[-0.15, 1.15]} ticks={[0, 1]} tick={{ fontSize: 9.5, fill: "#6f8098" }} axisLine={false} tickLine={false} />
                    <Line type="stepAfter" dataKey="A" stroke="#4a94ff" strokeWidth={2} dot={false} isAnimationActive={false} />
                    <Line type="stepAfter" dataKey="B" stroke="#ff8a3d" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="text-[10.5px] text-muted">셀 E {cell.x.toFixed(1)} / N {cell.y.toFixed(1)} m · 1 = 음영</div>
            </div>)}
      </Panel>
      <Panel title="가상 놀이터 · 휴게공간 (DEMO)" icon={<TreePine size={14} />} collapsible>
        {b.open_spaces.filter((o: any) => o.n_cells).map((o: any) => (
          <div key={o.id} className="card-2 mb-1.5 p-2.5">
            <div className="text-[12px] font-semibold">{o.name}</div>
            <div className="mt-1 flex items-baseline gap-2 text-[12px] text-ink-2">평균 음영 {o.mean_shade_min_a}→{o.mean_shade_min_b}분
              <b className={o.mean_delta_min > 0 ? "text-bad" : "text-good"}>{o.mean_delta_min > 0 ? "+" : ""}{o.mean_delta_min}</b></div>
            <div className="text-[11px] text-muted">최대 신규 음영 {o.peak_new_shade_area_m2} m² · 면적 {o.area_m2} m²</div>
          </div>
        ))}
      </Panel>
    </>
  );
}

function ClearPanel({ c }: { c: any }) {
  const rows = [...c.pairs].sort((a: any, b: any) => a.delta_m - b.delta_m).filter((r: any) => Math.abs(r.delta_m) > 1e-6).slice(0, 10);
  return (
    <Panel title="이격거리 변화 (B−A, m)" icon={<Ruler size={14} />}>
      {rows.length === 0 ? <Empty title="이격이 바뀐 건물 쌍이 없습니다" /> : (
        <div style={{ height: 26 * rows.length + 20 }}>
          <ResponsiveContainer>
            <BarChart data={rows.map((r: any) => ({ k: `${r.pair_id.replace("|", "↔")}  ${r.delta_m > 0 ? "+" : ""}${r.delta_m.toFixed(1)}`, d: r.delta_m, b: r.distance_b_m }))} layout="vertical" margin={{ left: 4, right: 12, top: 2 }}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="k" width={112} tick={{ fontSize: 10.5, fill: "#a9b7c9" }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: any, _n: any, it: any) => [`${Number(v).toFixed(2)} m (B ${it.payload.b.toFixed(2)} m)`, "Δ"]} cursor={{ fill: "#ffffff08" }} />
              <Bar dataKey="d" radius={3}>
                {rows.map((r: any) => <Cell key={r.pair_id} fill={r.delta_m < 0 ? "#f04848" : "#408cff"} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <div className="mt-2 text-[10.5px] text-muted">{c.legal_note}</div>
    </Panel>
  );
}

function TableBox({ title, rows, meta, file, children }: { title: string; rows: any[]; meta: string[]; file: string; children: React.ReactNode }) {
  return (
    <div className="card mb-3 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2">
        <h4 className="text-[12.5px] font-bold">{title}</h4>
        <button className="btn btn-sm" onClick={() => downloadText(file, toCsv(rows, meta))}><Download size={12} />CSV</button>
      </div>
      <div className="px-3 pb-1 text-[10.5px] text-muted">{meta.join(" · ")}</div>
      <div className="max-h-[300px] overflow-auto">{children}</div>
    </div>
  );
}

function SunTables({ sun, meta, onPick, sel }: { sun: any; meta: string[]; onPick: (id: string) => void; sel: string | null }) {
  const s = sun.summary;
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      <TableBox title="일조 감소 상위 수광점" rows={s.worst_receivers} meta={meta} file="A_worst_receivers.csv">
        <table className="tbl"><thead><tr><th>수광점</th><th className="num">층</th><th>면</th><th className="num">A</th><th className="num">B</th><th className="num">Δ분</th><th>원인</th></tr></thead>
          <tbody>{s.worst_receivers.map((r: any) => (
            <tr key={r.receiver_id} className={sel === r.receiver_id ? "sel" : ""} onClick={() => onPick(r.receiver_id)} style={{ cursor: "pointer" }}>
              <td className="font-mono">{r.receiver_id}</td><td className="num">{r.floor}</td><td>{r.facade}</td><td className="num">{r.sun_total_min_a}</td><td className="num">{r.sun_total_min_b}</td>
              <td className="num neg">{r.delta_total_min}</td><td>{r.main_cause_b ?? "-"}</td></tr>))}</tbody></table>
      </TableBox>
      <TableBox title={`전체 수광점 (${sun.receivers.length.toLocaleString()}개)`} rows={sun.receivers} meta={meta} file="A_all_receivers.csv">
        <table className="tbl"><thead><tr><th>수광점</th><th className="num">A</th><th className="num">B</th><th className="num">Δ</th><th className="num">연속 A→B</th></tr></thead>
          <tbody>{sun.receivers.slice(0, 400).map((r: any) => <tr key={r.receiver_id} onClick={() => onPick(r.receiver_id)} style={{ cursor: "pointer" }} className={sel === r.receiver_id ? "sel" : ""}><td className="font-mono">{r.receiver_id}</td><td className="num">{r.sun_total_min_a}</td><td className="num">{r.sun_total_min_b}</td><td className={`num ${r.delta_total_min < 0 ? "neg" : r.delta_total_min > 0 ? "pos" : ""}`}>{r.delta_total_min}</td><td className="num">{r.max_cont_min_a}→{r.max_cont_min_b}</td></tr>)}</tbody></table>
      </TableBox>
    </div>
  );
}

function ShadowTables({ s, meta }: { s: any; meta: string[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      <TableBox title="대표 시각 4상태 면적 (m²)" rows={s.snapshots} meta={meta} file="B_snapshots.csv">
        <table className="tbl"><thead><tr><th>시각</th><th className="num">A 음영</th><th className="num">B 음영</th><th className="num">신규 음영</th><th className="num">해소</th></tr></thead>
          <tbody>{s.snapshots.map((r: any) => <tr key={r.time_local}><td>{r.time_local}</td><td className="num">{r.shade_area_a_m2}</td><td className="num">{r.shade_area_b_m2}</td><td className="num neg">{r.new_shade_area_m2}</td><td className="num pos">{r.relieved_area_m2}</td></tr>)}</tbody></table>
      </TableBox>
      <TableBox title="누적 음영시간 증가 상위 셀" rows={s.top_cells} meta={meta} file="B_top_cells.csv">
        <table className="tbl"><thead><tr><th>#</th><th className="num">E</th><th className="num">N</th><th className="num">A</th><th className="num">B</th><th className="num">Δ분</th><th>원인</th></tr></thead>
          <tbody>{s.top_cells.map((t: any, i: number) => <tr key={i}><td>T{i + 1}</td><td className="num">{t.x}</td><td className="num">{t.y}</td><td className="num">{t.shade_min_a}</td><td className="num">{t.shade_min_b}</td><td className="num neg">+{t.delta_min}</td><td>{t.main_cause_b ?? "-"}</td></tr>)}</tbody></table>
      </TableBox>
    </div>
  );
}

function ClearTables({ c, meta }: { c: any; meta: string[] }) {
  const rows = [...c.pairs].sort((a: any, b: any) => a.delta_m - b.delta_m);
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      <TableBox title="건물 쌍별 최단 수평 이격거리" rows={rows} meta={meta} file="C_pairs.csv">
        <table className="tbl"><thead><tr><th>쌍</th><th className="num">A m</th><th className="num">B m</th><th className="num">Δ m</th><th>상태</th></tr></thead>
          <tbody>{rows.map((r: any) => <tr key={r.pair_id}><td>{r.pair_id.replace("|", "↔")}</td><td className="num">{r.distance_a_m.toFixed(2)}</td><td className="num">{r.distance_b_m.toFixed(2)}</td><td className={`num ${r.delta_m < 0 ? "neg" : r.delta_m > 0 ? "pos" : ""}`}>{r.delta_m.toFixed(2)}</td><td>{r.status_b}</td></tr>)}</tbody></table>
      </TableBox>
      <TableBox title="외벽 법선 방향 거리 (별도 지표)" rows={c.facade_normals} meta={meta} file="C_facade_normals.csv">
        <table className="tbl"><thead><tr><th>외벽</th><th className="num">A</th><th>대상</th><th className="num">B</th><th>대상</th><th className="num">Δ</th></tr></thead>
          <tbody>{c.facade_normals.map((f: any) => <tr key={f.facade_id}><td className="font-mono">{f.facade_id}</td><td className="num">{f.distance_a_m ?? "교차 없음"}</td><td>{f.target_a ?? "-"}</td><td className="num">{f.distance_b_m ?? "교차 없음"}</td><td>{f.target_b ?? "-"}</td><td className={`num ${(f.delta_m ?? 0) < 0 ? "neg" : ""}`}>{f.delta_m ?? "-"}</td></tr>)}</tbody></table>
      </TableBox>
    </div>
  );
}
