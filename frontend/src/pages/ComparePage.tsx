import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, downloadText, kstToUtcIso, toCsv, type GroundMesh, type SceneBuilding } from "../api";
import { DataBadges, Disclaimer, ErrorBox, Kpi, Loading, PlanView, TimeSlider, TopBar, divColor, useProject } from "../components/Chrome";
import SyncedViewers, { type ViewMode } from "../components/SyncedViewers";
import type { GridImage, Line as L3, PickResult, ReceiverPt } from "../components/CesiumScene";

type Tab = "A" | "B" | "C";
type GridMetric = "delta" | "shadeA" | "shadeB" | string; // string = snapshot time

export default function ComparePage({ captureMode = false }: { captureMode?: boolean }) {
  const { id = "", runId = "" } = useParams();
  const nav = useNavigate();
  const { p } = useProject(captureMode ? undefined : id);
  const [res, setRes] = useState<any>(null);
  const [scene, setScene] = useState<{ model_matrix: number[]; pad_z: number; site: any; scenarios: Record<"A" | "B", SceneBuilding[]> } | null>(null);
  const [ground, setGround] = useState<GroundMesh | null>(null);
  const [sun, setSun] = useState<any>(null);
  const [shadow, setShadow] = useState<any>(null);
  const [clr, setClr] = useState<any>(null);
  const [tab, setTab] = useState<Tab>("A");
  const [mode, setMode] = useState<ViewMode>(captureMode ? "B" : "SPLIT");
  const [time, setTime] = useState("12:00");
  const [shadows, setShadows] = useState(true);
  const [imagery, setImagery] = useState(!captureMode);
  const [metric, setMetric] = useState<GridMetric>("delta");
  const [selRec, setSelRec] = useState<string | null>(null);
  const [recSeries, setRecSeries] = useState<any>(null);
  const [cell, setCell] = useState<any>(null);
  const [selBld, setSelBld] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.results(runId);
        setRes(r);
        const [sc, g] = await Promise.all([api.runScene(runId), fetch(`/api/analyses/${runId}/ground-mesh`).then(async (x) => { if (!x.ok) throw new Error(`지면 메쉬 로드 실패 (${x.status}): ${(await x.json().catch(() => ({}))).detail ?? ""}`); return x.json(); })]);
        setScene(sc);
        setGround(g);
        if (r.summary.A) api.sunlight(runId).then(setSun);
        if (r.summary.B) api.shadow(runId).then(setShadow);
        if (r.summary.C) api.clearance(runId).then(setClr);
        setTab(captureMode && r.summary.B ? "B" : r.summary.A ? "A" : r.summary.B ? "B" : "C");
      } catch (e: any) { setErr(e.message); }
    })();
  }, [runId]);
  useEffect(() => {
    if (!selRec) return;
    api.receiver(runId, selRec).then(setRecSeries).catch((e) => setErr(e.message));
  }, [selRec, runId]);

  const sm = res?.summary;
  const date = sm?.params?.date ?? "2026-12-22";
  const changed = useMemo(() => new Set<string>(sm?.changed_buildings ?? []), [sm]);

  // --- overlays (all from server results)
  const recPts = useMemo(() => {
    if (!sun || tab !== "A") return { a: undefined, b: undefined, lim: 0 };
    const rows = selBld ? sun.receivers.filter((r: any) => r.building_id === selBld) : sun.receivers;
    const lim = Math.max(30, ...sun.receivers.map((r: any) => Math.abs(r.delta_total_min)));
    const mk = (side: "a" | "b"): ReceiverPt[] => rows.map((r: any) => ({
      id: r.receiver_id, x: r[`x_${side}`], y: r[`y_${side}`], z: r[`z_${side}`], nx: r[`nx_${side}`] ?? 0, ny: r[`ny_${side}`] ?? 0,
      color: r.receiver_id === selRec ? "#111111" : divColor(r.delta_total_min, lim),
    }));
    return { a: mk("a"), b: mk("b"), lim };
  }, [sun, tab, selRec, selBld]);

  const gridImg = useMemo<GridImage | null>(() => {
    if (!shadow || tab !== "B") return null;
    const g = shadow.grid;
    const vals: (number | null)[] = metric === "delta" ? g.delta_min : metric === "shadeA" ? g.shade_min_a : metric === "shadeB" ? g.shade_min_b : g.snapshot_states[metric];
    if (!vals) return null;
    const S = 3;
    const cv = document.createElement("canvas");
    cv.width = g.nx * S;
    cv.height = g.ny * S;
    const ctx = cv.getContext("2d")!;
    const nz = vals.filter((v) => v !== null && v !== 0).map((v) => Math.abs(v as number)).sort((x, y) => x - y);
    const lim = metric === "delta" ? Math.max(10, nz.length ? nz[Math.floor(nz.length * 0.9)] : 10) : shadow.summary.analysed_minutes;
    const STATE = ["rgba(247,241,212,0.55)", "rgba(120,118,110,0.65)", "rgba(227,73,72,0.9)", "rgba(42,120,214,0.9)"];
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
      const v = vals[j * g.nx + i];
      if (v === null || v === undefined) continue;
      let c: string;
      if (metric === "delta") c = v === 0 ? "rgba(240,239,236,0.30)" : divColor(v, lim, true);
      else if (metric === "shadeA" || metric === "shadeB") { const t = v / lim; c = `rgba(${Math.round(240 - 200 * t)},${Math.round(240 - 170 * t)},${Math.round(236 - 110 * t)},0.85)`; }
      else c = STATE[v];
      ctx.fillStyle = c;
      ctx.fillRect(i * S, (g.ny - 1 - j) * S, S, S);
    }
    const h = g.spacing / 2;
    return { url: cv.toDataURL("image/png"), x0: g.x0 - h, y0: g.y0 - h, x1: g.x0 - h + g.nx * g.spacing, y1: g.y0 - h + g.ny * g.spacing, z: scene?.pad_z ?? 0 };
  }, [shadow, tab, metric, scene?.pad_z]);

  const lines = useMemo(() => {
    if (!clr || tab !== "C") return { a: undefined, b: undefined };
    const keep = [...clr.pairs].sort((x: any, y: any) => x.distance_b_m - y.distance_b_m).slice(0, 8).map((x: any) => x.pair_id);
    const sel = new Set([...keep, ...clr.worsened_top.map((x: any) => x.pair_id)]);
    const z = scene?.pad_z ?? 0;
    const mk = (side: "A" | "B"): L3[] => clr.pairs.filter((r: any) => sel.has(r.pair_id)).map((r: any) => {
      const d = side === "A" ? r.distance_a_m : r.distance_b_m;
      const worse = side === "B" && r.delta_m < 0;
      return { a: r[`p_a_${side}`], b: r[`p_b_${side}`], z, color: worse ? "#c0392b" : side === "A" ? "#2a78d6" : "#3b3a37", width: worse ? 4 : 2.5,
        label: `${r.pair_id.replace("|", "↔")} ${d.toFixed(1)}m${side === "B" && Math.abs(r.delta_m) > 1e-6 ? ` (${r.delta_m > 0 ? "+" : ""}${r.delta_m.toFixed(1)})` : ""}` };
    });
    return { a: mk("A"), b: mk("B") };
  }, [clr, tab, scene?.pad_z]);

  const onPick = (pk: PickResult) => {
    if (pk.type === "receiver") { setSelRec(pk.id); setTab("A"); }
    else if (pk.type === "building") setSelBld(pk.id === selBld ? null : pk.id);
    else if (pk.type === "ground" && tab === "B") api.shadowCell(runId, pk.x, pk.y).then(setCell).catch(() => {});
  };

  if (err) return <ErrorBox msg={err} />;
  if (!res || !scene) return <div className="flex h-full flex-col">{!captureMode && <TopBar project={p} />}<Loading text="분석 결과·스냅샷 불러오는 중…" /></div>;

  const viewers = (
    <SyncedViewers mode={mode} a={scene.scenarios.A} b={scene.scenarios.B} modelMatrix={scene.model_matrix} padZ={scene.pad_z} ground={ground}
      timeUtc={kstToUtcIso(date, time)} shadows={shadows} imagery={imagery} showContext changed={changed} selected={selBld}
      sideA={{ receivers: recPts.a, grid: gridImg, lines: lines.a }} sideB={{ receivers: recPts.b, grid: gridImg, lines: lines.b }}
      onPick={onPick} onReady={() => setReady(true)}
      rings={(scene.site.open_spaces ?? []).map((o: any) => ({ ring: o.polygon, z: scene.pad_z, color: "#1baf7a" }))} />
  );
  if (captureMode) return <div className="h-screen w-screen" data-capture-ready={ready ? "1" : "0"}>{viewers}</div>;

  const meta = [`run ${runId}`, `분석일 ${date} ${sm.params.start}-${sm.params.end} ${sm.params.timezone}, 간격 ${sm.params.interval_min}분`,
    `지형 ${sm.terrain.data_class} (${sm.terrain.filename})`, "가상 PoC - 실제 LH 설계안 아님"];

  return (
    <div className="flex h-full flex-col">
      <TopBar project={p} latestRunId={runId} right={<button className="btn" onClick={() => nav(`/reports/${runId}`)} data-testid="go-report">보고서 생성 ▶</button>} />
      <div className="flex min-h-0 flex-1">
        <aside className="w-[270px] shrink-0 overflow-y-auto border-r border-line bg-white p-3">
          <div className="mb-3 grid grid-cols-3 gap-1" role="tablist">
            {(["A", "B", "C"] as Tab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} disabled={!sm[t]} className={`btn justify-center ${tab === t ? "btn-primary" : ""}`} onClick={() => setTab(t)}>
                {t === "A" ? "A 일조" : t === "B" ? "B 그림자" : "C 이격"}
              </button>
            ))}
          </div>
          <h3 className="mb-1 text-[12px] font-bold text-brand">비교 보기</h3>
          <div className="mb-3 grid grid-cols-2 gap-1">
            {([["SPLIT", "좌우 분할"], ["OVERLAY", "오버레이"], ["A", "A만"], ["B", "B만"]] as [ViewMode, string][]).map(([m, l]) => (
              <button key={m} className={`btn justify-center ${mode === m ? "btn-primary" : ""}`} onClick={() => setMode(m)}>{l}</button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={shadows} onChange={(e) => setShadows(e.target.checked)} />3D 그림자 프리뷰</label>
          <label className="mb-3 flex items-center gap-2 text-[12px]"><input type="checkbox" checked={imagery} onChange={(e) => setImagery(e.target.checked)} />배경지도 (OSM)</label>
          {tab === "A" && (
            <Legend3 title="Δ 총 직사일조 (분, B−A)" lo={`-${recPts.lim.toFixed(0)} 감소`} hi={`+${recPts.lim.toFixed(0)} 증가`} lc="#c0292b" hc="#1c5cab"
              note="점 = 외벽 대리지점(facade_proxy). 클릭하면 시간별 0/1과 차폐 원인. 주동을 클릭하면 해당 동만 표시." />
          )}
          {tab === "B" && shadow && (
            <>
              <label className="fld mb-2">격자 표시 지표
                <select value={metric} onChange={(e) => setMetric(e.target.value)}>
                  <option value="delta">Δ 누적 음영시간 (B−A, 분)</option>
                  <option value="shadeA">A 누적 음영시간</option>
                  <option value="shadeB">B 누적 음영시간</option>
                  {Object.keys(shadow.grid.snapshot_states).map((t) => <option key={t} value={t}>{t} 4상태 (신규 음영/해소)</option>)}
                </select>
              </label>
              {metric === "delta" ? <Legend3 title="Δ 누적 음영 (분, 색 범위 = |Δ| 90백분위, 초과값 포화)" lo="음영 감소" hi="음영 증가" lc="#1c5cab" hc="#c0292b" note="격자 2 m = 샘플링 간격(DEM 정확도 아님). 제외 셀(건물 내부)은 투명. 지면 클릭 → 셀 시계열." />
                : metric.includes(":") ? <div className="mb-2 space-y-0.5 text-[11px]">{["SUN→SUN", "SHADE→SHADE", "SUN→SHADE 신규 음영", "SHADE→SUN 음영 해소"].map((s, i) => <div key={s}><span className="mr-1 inline-block h-2.5 w-2.5" style={{ background: ["#f7f1d4", "#78766e", "#e34948", "#2a78d6"][i] }} />{s}</div>)}<div className="text-muted">결과 시각 {metric} KST (정시 순간 계산)</div></div>
                : <div className="mb-2 text-[11px] text-ink-2">0 ~ {shadow.summary.analysed_minutes}분 (진할수록 음영 지속)</div>}
            </>
          )}
          {tab === "C" && <div className="mb-2 text-[11px] text-ink-2">선 = 최단 수평 이격 연결선(양 끝 최근접점). 빨강 = B에서 감소한 쌍. 라벨 = 거리(괄호 Δm). 법정 이격 적합성은 판정하지 않음.</div>}
          <h3 className="mb-1 mt-3 text-[12px] font-bold text-brand">2D 평면 (WebGL 대체)</h3>
          <PlanView a={scene.scenarios.A} b={scene.scenarios.B} changed={changed} selected={selBld} onSelect={(b) => setSelBld(b === selBld ? null : b)} size={240} />
          <div className="mt-3"><DataBadges b={p?.data_badges ?? ({ location: { class: "", label: "", approximate: false, boundary_verified: false }, terrain: null, ground: null, buildings: { classes: [], label: "" }, mode: "DEMO", disclaimer: "" } as any)} /></div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-[3]">{viewers}</div>
          <div className="border-t border-line bg-white px-4 py-1.5"><TimeSlider date={date} value={time} onChange={setTime} /></div>
          <div className="min-h-0 flex-[2] overflow-auto border-t border-line bg-plane p-3">
            {tab === "A" && sun && <SunTables sun={sun} meta={meta} onPick={setSelRec} sel={selRec} />}
            {tab === "B" && shadow && <ShadowTables s={shadow.summary} meta={meta} />}
            {tab === "C" && clr && <ClearTables c={clr} meta={meta} />}
          </div>
        </main>

        <aside className="w-[340px] shrink-0 overflow-y-auto border-l border-line bg-white p-3">
          <Disclaimer className="mb-2" />
          <div className="mb-3 grid grid-cols-2 gap-2">
            {sm.A && <Kpi label="A 감소 수광점" value={sm.A.n_decreased.toLocaleString()} sub={`최대 ${sm.A.delta_total_min_min}분`} tone="neg" />}
            {sm.A && <Kpi label="A 평균 직사일조" value={`${sm.A.mean_total_min_b}분`} sub={`A ${sm.A.mean_total_min_a}분`} />}
            {sm.B && <Kpi label="B 최대 신규 음영" value={`${Math.round(sm.B.max_new_shade_area_m2).toLocaleString()}m²`} sub={`${sm.B.max_new_shade_time}`} tone="neg" />}
            {sm.C?.min_pair_b && <Kpi label="C 최소 이격 B" value={`${sm.C.min_pair_b.distance_m.toFixed(2)}m`} sub={`A ${sm.C.min_pair_a.distance_m.toFixed(2)}m`} />}
          </div>
          <div className="mb-3 text-[11px] text-ink-2">QA {res.quality.n_pass}✓ / {res.quality.n_fail}✗ · {res.quality.verification_status} · 지형 {sm.terrain.data_class} · 수직기준 {sm.terrain.vertical_datum_status}</div>
          {tab === "A" && <ReceiverDetail s={recSeries} id={selRec} />}
          {tab === "B" && <CellDetail c={cell} openSpaces={shadow?.summary.open_spaces} />}
          {tab === "C" && clr && <div className="text-[12px]"><h3 className="mb-1 font-bold text-brand">이격 감소 상위</h3>
            {clr.worsened_top.length === 0 ? "이격이 감소한 쌍 없음" : clr.worsened_top.map((r: any) => <div key={r.pair_id} className="flex justify-between border-b border-line py-1"><span>{r.pair_id.replace("|", "↔")}</span><span>{r.distance_a_m.toFixed(2)} → {r.distance_b_m.toFixed(2)} m <b className="neg">{r.delta_m.toFixed(2)}</b></span></div>)}
            <div className="mt-2 text-[11px] text-muted">{clr.legal_note}</div></div>}
          <h3 className="mb-1 mt-4 text-[12px] font-bold text-brand">원자료 내려받기</h3>
          <ul className="space-y-0.5 text-[12px]">
            {res.files.map((f: any) => <li key={f.name}><a className="text-brand-2 underline" href={f.url}>{f.name}</a> <span className="text-muted">({(f.size / 1024).toFixed(0)} KB)</span></li>)}
          </ul>
        </aside>
      </div>
    </div>
  );
}

function Legend3({ title, lo, hi, lc, hc, note }: { title: string; lo: string; hi: string; lc: string; hc: string; note: string }) {
  return (
    <div className="mb-2">
      <div className="text-[11.5px] font-semibold">{title}</div>
      <div className="my-1 h-2.5 rounded" style={{ background: `linear-gradient(90deg, ${lc}, #f0efec, ${hc})` }} />
      <div className="flex justify-between text-[10.5px] text-ink-2"><span>{lo}</span><span>0</span><span>{hi}</span></div>
      <div className="mt-1 text-[10.5px] text-muted">{note}</div>
    </div>
  );
}

function ReceiverDetail({ s, id }: { s: any; id: string | null }) {
  if (!id) return <div className="text-[12px] text-ink-2">3D 화면의 수광점 또는 아래 표의 행을 선택하면 시간별 직사일조(0/1)와 차폐 원인을 표시합니다.</div>;
  if (!s || s.receiver_id !== id) return <Loading />;
  const data = s.times_local.map((t: string, i: number) => ({ t: t.slice(11, 16), A: s.A ? s.A.sun[i] : null, B: s.B ? s.B.sun[i] + 0.04 : null,
    blkB: s.B?.blocker[i] ?? "-", blkA: s.A?.blocker[i] ?? "-", el: s.elevation_deg[i].toFixed(1), az: s.azimuth_deg[i].toFixed(1) }));
  const lost = data.filter((d: any) => d.A === 1 && d.B !== null && d.B < 0.5);
  const causes = [...new Set(lost.map((d: any) => d.blkB))].filter((x) => x && x !== "-");
  return (
    <div>
      <h3 className="mb-1 font-mono text-[12.5px] font-bold">{id}</h3>
      <div className="mb-1 text-[12px]">총 직사일조 A <b>{s.A?.total_min ?? "-"}</b>분 → B <b>{s.B?.total_min ?? "-"}</b>분 {s.A && s.B && <b className={s.B.total_min < s.A.total_min ? "neg" : "pos"}>({s.B.total_min - s.A.total_min > 0 ? "+" : ""}{s.B.total_min - s.A.total_min})</b>}</div>
      <div className="mb-1 text-[11.5px] text-ink-2">B에서 잃은 구간 {lost.length}개{causes.length ? ` · 차폐 원인: ${causes.join(", ")}동` : ""}</div>
      <div style={{ height: 170 }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ left: -24, right: 6, top: 6 }}>
            <CartesianGrid stroke="#e1e0d9" vertical={false} />
            <XAxis dataKey="t" tick={{ fontSize: 10 }} interval={11} />
            <YAxis domain={[-0.1, 1.2]} ticks={[0, 1]} tick={{ fontSize: 10 }} />
            <Tooltip content={({ active, payload }) => active && payload?.length ? (
              <div className="rounded border border-line bg-white p-1.5 text-[11px] shadow">
                <div><b>{payload[0].payload.t}</b> KST · 고도 {payload[0].payload.el}° · 방위 {payload[0].payload.az}°</div>
                <div className="text-scen-a">A: {payload[0].payload.A === 1 ? "직사일조" : `없음 (${payload[0].payload.blkA ?? "-"})`}</div>
                <div className="text-scen-b">B: {payload[0].payload.B !== null && payload[0].payload.B > 0.5 ? "직사일조" : `없음 (${payload[0].payload.blkB ?? "-"})`}</div>
              </div>) : null} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="stepAfter" dataKey="A" stroke="#2a78d6" strokeWidth={2} dot={false} isAnimationActive={false} name="A 기준안" />
            <Line type="stepAfter" dataKey="B" stroke="#eb6834" strokeWidth={2} dot={false} isAnimationActive={false} name="B 변경안" />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="text-[10.5px] text-muted">1 = 기하학적 직사일조 가능, 0 = 차폐/배면/지평선 아래 · 구간 중점 규칙</div>
    </div>
  );
}

function CellDetail({ c, openSpaces }: { c: any; openSpaces?: any[] }) {
  return (
    <div>
      {!c ? <div className="mb-3 text-[12px] text-ink-2">3D 화면에서 지면을 클릭하면 해당 2 m 셀의 A/B 음영 시계열과 누적 음영시간 증감을 표시합니다.</div>
        : c.excluded ? <div className="mb-3 text-[12px]">셀 ({c.x.toFixed(1)}, {c.y.toFixed(1)}) — 분석 제외: {c.reason}</div> : (
          <div className="mb-3">
            <h3 className="mb-1 text-[12.5px] font-bold">셀 E {c.x.toFixed(1)} / N {c.y.toFixed(1)} m (z {c.z.toFixed(2)})</h3>
            <div className="mb-1 text-[12px]">누적 음영 A <b>{c.shade_min_a}</b>분 → B <b>{c.shade_min_b}</b>분 <b className={c.delta_min > 0 ? "neg" : c.delta_min < 0 ? "pos" : ""}>({c.delta_min > 0 ? "+" : ""}{c.delta_min})</b></div>
            <div style={{ height: 140 }}>
              <ResponsiveContainer>
                <LineChart data={c.times_local.map((t: string, i: number) => ({ t: t.slice(11, 16), A: c.shade_a[i], B: c.shade_b[i] + 0.04 }))} margin={{ left: -24, right: 6, top: 6 }}>
                  <CartesianGrid stroke="#e1e0d9" vertical={false} />
                  <XAxis dataKey="t" tick={{ fontSize: 10 }} interval={11} />
                  <YAxis domain={[-0.1, 1.2]} ticks={[0, 1]} tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(v: any) => (Number(v) > 0.5 ? "음영" : "일조")} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="stepAfter" dataKey="A" stroke="#2a78d6" strokeWidth={2} dot={false} isAnimationActive={false} name="A 음영(1)" />
                  <Line type="stepAfter" dataKey="B" stroke="#eb6834" strokeWidth={2} dot={false} isAnimationActive={false} name="B 음영(1)" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>)}
      {openSpaces && (
        <>
          <h3 className="mb-1 text-[12px] font-bold text-brand">가상 놀이터·휴게공간 (DEMO)</h3>
          {openSpaces.map((o: any) => o.n_cells ? (
            <div key={o.id} className="mb-1 text-[12px]"><b>{o.name}</b><br />평균 음영 {o.mean_shade_min_a} → {o.mean_shade_min_b}분 <b className={o.mean_delta_min > 0 ? "neg" : "pos"}>({o.mean_delta_min > 0 ? "+" : ""}{o.mean_delta_min})</b> · 최대 신규 음영 {o.peak_new_shade_area_m2} m²</div>
          ) : null)}
        </>
      )}
    </div>
  );
}

function TableBox({ title, rows, meta, file, children }: { title: string; rows: any[]; meta: string[]; file: string; children: React.ReactNode }) {
  return (
    <div className="panel mb-3 p-2">
      <div className="mb-1 flex items-center justify-between">
        <h4 className="text-[12.5px] font-bold">{title}</h4>
        <button className="btn px-2 py-0.5" onClick={() => downloadText(file, toCsv(rows, meta))}>CSV</button>
      </div>
      <div className="mb-1 text-[10.5px] text-muted">{meta.join(" · ")}</div>
      <div className="max-h-[260px] overflow-auto">{children}</div>
    </div>
  );
}

function SunTables({ sun, meta, onPick, sel }: { sun: any; meta: string[]; onPick: (id: string) => void; sel: string | null }) {
  const s = sun.summary;
  return (
    <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
      <TableBox title="일조 감소 상위 수광점" rows={s.worst_receivers} meta={meta} file="A_worst_receivers.csv">
        <table className="tbl"><thead><tr><th>수광점</th><th className="num">층</th><th>면</th><th className="num">A</th><th className="num">B</th><th className="num">Δ분</th><th>원인</th><th>유형</th></tr></thead>
          <tbody>{s.worst_receivers.map((r: any) => (
            <tr key={r.receiver_id} className={sel === r.receiver_id ? "sel" : ""} onClick={() => onPick(r.receiver_id)} style={{ cursor: "pointer" }}>
              <td className="font-mono">{r.receiver_id}</td><td className="num">{r.floor}</td><td>{r.facade}</td><td className="num">{r.sun_total_min_a}</td><td className="num">{r.sun_total_min_b}</td>
              <td className="num neg">{r.delta_total_min}</td><td>{r.main_cause_b ?? "-"}</td><td>{r.impact_type === "SELF_MODIFIED" ? "변경동" : "타동"}</td></tr>))}</tbody></table>
      </TableBox>
      <TableBox title="주동별 직사일조" rows={s.per_building} meta={meta} file="A_per_building.csv">
        <div style={{ height: 150 }}>
          <ResponsiveContainer>
            <BarChart data={s.per_building} margin={{ left: -18, right: 6, top: 6 }}>
              <CartesianGrid stroke="#e1e0d9" vertical={false} />
              <XAxis dataKey="building_id" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} />
              <Tooltip /><Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="mean_total_min_a" name="A 평균(분)" fill="#2a78d6" radius={[3, 3, 0, 0]} />
              <Bar dataKey="mean_total_min_b" name="B 평균(분)" fill="#eb6834" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <table className="tbl"><thead><tr><th>동</th><th>변경</th><th className="num">평균Δ</th><th className="num">최소Δ</th><th className="num">감소</th><th className="num">증가</th></tr></thead>
          <tbody>{s.per_building.map((b: any) => <tr key={b.building_id}><td>{b.building_id}</td><td>{b.changed_in_b ? "●" : ""}</td><td className={`num ${b.mean_delta_min < 0 ? "neg" : ""}`}>{b.mean_delta_min}</td><td className="num">{b.min_delta_min}</td><td className="num">{b.n_decreased}</td><td className="num">{b.n_increased}</td></tr>)}</tbody></table>
      </TableBox>
      <TableBox title={`전체 수광점 (${sun.receivers.length.toLocaleString()}개)`} rows={sun.receivers} meta={meta} file="A_all_receivers.csv">
        <table className="tbl"><thead><tr><th>수광점</th><th className="num">A</th><th className="num">B</th><th className="num">Δ</th><th className="num">연속 A→B</th></tr></thead>
          <tbody>{sun.receivers.slice(0, 400).map((r: any) => <tr key={r.receiver_id} onClick={() => onPick(r.receiver_id)} style={{ cursor: "pointer" }} className={sel === r.receiver_id ? "sel" : ""}><td className="font-mono">{r.receiver_id}</td><td className="num">{r.sun_total_min_a}</td><td className="num">{r.sun_total_min_b}</td><td className={`num ${r.delta_total_min < 0 ? "neg" : r.delta_total_min > 0 ? "pos" : ""}`}>{r.delta_total_min}</td><td className="num">{r.max_cont_min_a}→{r.max_cont_min_b}</td></tr>)}</tbody></table>
        {sun.receivers.length > 400 && <div className="p-1 text-[11px] text-muted">상위 400행 표시 · 전체는 CSV</div>}
      </TableBox>
    </div>
  );
}

function ShadowTables({ s, meta }: { s: any; meta: string[] }) {
  const curve = s.curve.time_local.map((t: string, i: number) => ({ t: t.slice(0, 5), 신규음영: s.curve.new_shade_area_m2[i], 음영해소: s.curve.relieved_area_m2[i] }));
  return (
    <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
      <TableBox title="시각별 신규 음영 / 음영 해소 면적 (m²)" rows={curve} meta={meta} file="B_area_curve.csv">
        <div style={{ height: 190 }}>
          <ResponsiveContainer>
            <LineChart data={curve} margin={{ left: -6, right: 8, top: 6 }}>
              <CartesianGrid stroke="#e1e0d9" vertical={false} />
              <XAxis dataKey="t" tick={{ fontSize: 10 }} interval={11} /><YAxis tick={{ fontSize: 10 }} />
              <Tooltip /><Legend wrapperStyle={{ fontSize: 11 }} />
              <Line dataKey="신규음영" stroke="#e34948" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line dataKey="음영해소" stroke="#2a78d6" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="text-[11px] text-ink-2">유효격자 {s.n_cells_valid.toLocaleString()}셀 ({s.valid_area_m2.toLocaleString()} m², A·B 공통 분모) · 제외 건물 {s.n_cells_excluded_building} / NoData {s.n_cells_excluded_nodata} · 분석 {s.analysed_minutes}분</div>
      </TableBox>
      <TableBox title="대표 시각 4상태 면적" rows={s.snapshots} meta={meta} file="B_snapshots.csv">
        <table className="tbl"><thead><tr><th>시각</th><th className="num">A 음영</th><th className="num">B 음영</th><th className="num">신규 음영</th><th className="num">해소</th></tr></thead>
          <tbody>{s.snapshots.map((r: any) => <tr key={r.time_local}><td>{r.time_local}</td><td className="num">{r.shade_area_a_m2}</td><td className="num">{r.shade_area_b_m2}</td><td className="num neg">{r.new_shade_area_m2}</td><td className="num pos">{r.relieved_area_m2}</td></tr>)}</tbody></table>
      </TableBox>
      <TableBox title="가상 놀이터·휴게공간 영향 (DEMO)" rows={s.open_spaces} meta={meta} file="B_open_spaces.csv">
        <table className="tbl"><thead><tr><th>공간</th><th className="num">면적</th><th className="num">평균 A→B</th><th className="num">Δ</th><th className="num">최대 신규</th></tr></thead>
          <tbody>{s.open_spaces.map((o: any) => <tr key={o.id}><td>{o.name}</td><td className="num">{o.area_m2}</td><td className="num">{o.mean_shade_min_a}→{o.mean_shade_min_b}</td><td className={`num ${o.mean_delta_min > 0 ? "neg" : "pos"}`}>{o.mean_delta_min}</td><td className="num">{o.peak_new_shade_area_m2}</td></tr>)}</tbody></table>
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
    <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
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
