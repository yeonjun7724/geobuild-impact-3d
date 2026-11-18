/* 배치도 입력: DXF / PDF / 이미지 도면을 기존안(A) 또는 변경안(B)으로 등록.
   1) 파일 올리기  2) DXF는 레이어 선택 → 자동 추출, PDF·이미지는 외곽선을 클릭으로 따라 그리기
   3) 동 번호·층수·층당 세대수 확인  4) 위치 맞추기(도면 좌표계 또는 기준점 2개)  5) 저장 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Check, FileUp, MapPin, MousePointer2, PenLine, Trash2, Undo2 } from "lucide-react";
import { api, type SceneResp } from "../api";
import { ErrorBox, Loading, TopBar, useProject } from "../components/Chrome";
import PlanCanvas, { type PlanMarker, type PlanRing } from "../components/PlanCanvas";
import { Panel, Segmented, Spinner } from "../ui";

type Row = { key: string; id: string; floors: string; units: string; ring: number[][]; include: boolean };
type Pick = null | "s1" | "d1" | "s2" | "d2";

const sim = (src: number[][], dst: number[][], allowScale: boolean) => {
  const [[x1, y1], [x2, y2]] = src, [[u1, v1], [u2, v2]] = dst;
  const sx = x2 - x1, sy = y2 - y1, dx = u2 - u1, dy = v2 - v1;
  const n = sx * sx + sy * sy;
  let a = (dx * sx + dy * sy) / n, b = (dy * sx - dx * sy) / n;
  const sc = Math.hypot(a, b);
  if (!allowScale) { a /= sc; b /= sc; }
  const tx = u1 - (a * x1 - b * y1), ty = v1 - (b * x1 + a * y1);
  return { f: (p: number[]) => [a * p[0] - b * p[1] + tx, b * p[0] + a * p[1] + ty], scale: sc, rot: (Math.atan2(b, a) * 180) / Math.PI };
};

export default function LayoutPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { p, reload } = useProject(id);
  const [code, setCode] = useState<"A" | "B">("B");
  const [ref, setRef] = useState<SceneResp | null>(null);
  const [up, setUp] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bLayers, setBLayers] = useState<string[]>([]);
  const [siteLayer, setSiteLayer] = useState<string>("");
  const [unit, setUnit] = useState(1);
  const [rows, setRows] = useState<Row[]>([]);
  const [boundary, setBoundary] = useState<number[][] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [tool, setTool] = useState<"select" | "building" | "boundary">("select");
  const [draft, setDraft] = useState<number[][]>([]);
  const [placeMode, setPlaceMode] = useState<"crs" | "points">("points");
  const [crs, setCrs] = useState("");
  const [pick, setPick] = useState<Pick>(null);
  const [cp, setCp] = useState<{ s1?: number[]; d1?: number[]; s2?: number[]; d2?: number[] }>({});
  const [saved, setSaved] = useState<any>(null);
  const [ctxRes, setCtxRes] = useState<any>(null);
  const [radius, setRadius] = useState(400);
  const onContext = async (f: File) => {
    setBusy("주변 건물 읽는 중…"); setErr(null);
    try {
      const fd = new FormData(); fd.append("file", f); fd.append("radius_m", String(radius));
      const r = await fetch(`/api/projects/${id}/context-buildings`, { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail));
      setCtxRes(j); api.scene(id, "A").then(setRef); reload();
    } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };

  useEffect(() => { api.scene(id, "A").then(setRef).catch((e) => setErr(e.message)); }, [id]);
  const isImg = up && up.kind !== "DXF";
  const scen = p?.scenarios.find((s) => s.code === code) as any;

  const onFile = async (f: File) => {
    setBusy("도면 읽는 중…"); setErr(null); setRows([]); setBoundary(null); setCp({}); setSaved(null);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await fetch(`/api/projects/${id}/drawings`, { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail ?? r.statusText);
      setUp(j);
      if (j.kind === "DXF") {
        setUnit(j.unit_guess_m);
        setBLayers(j.layers.filter((l: any) => l.hint === "BUILDING" && l.closed + l.lines > 0).map((l: any) => l.name));
        setSiteLayer(j.layers.find((l: any) => l.hint === "SITE")?.name ?? "");
        setTool("select");
      } else setTool("building");
      if (j.crs_candidates?.length) { setPlaceMode("crs"); setCrs(j.crs_candidates[0].crs); } else setPlaceMode("points");
    } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };

  const extract = async () => {
    setBusy("외곽선 추출 중…"); setErr(null);
    try {
      const r = await fetch(`/api/projects/${id}/drawings/${up.drawing_id}/extract`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ building_layers: bLayers, boundary_layer: siteLayer || null, unit_m: unit }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail ?? r.statusText);
      setRows(j.buildings.map((b: any, i: number) => ({ key: `d${i}`, id: b.id ?? "", floors: b.floors ? String(b.floors) : "", units: "", ring: b.ring, include: true })));
      setBoundary(j.boundary);
      if (j.crs_candidates?.length) { setPlaceMode("crs"); setCrs(j.crs_candidates[0].crs); setUp({ ...up, crs_candidates: j.crs_candidates }); }
    } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };

  // drawing-side click: tracing or control points
  const onSrcClick = (pt: [number, number]) => {
    if (pick === "s1" || pick === "s2") { setCp({ ...cp, [pick]: pt }); setPick(pick === "s1" ? "d1" : "d2"); return; }
    if (tool === "select") return;
    if (draft.length >= 3) {
      const f = draft[0], px = Math.hypot(pt[0] - f[0], pt[1] - f[1]);
      const span = Math.max(...draft.map((q) => Math.hypot(q[0] - f[0], q[1] - f[1])));
      if (px < Math.max(span * 0.04, 3)) { closeDraft(); return; }
    }
    setDraft([...draft, pt]);
  };
  const closeDraft = () => {
    if (draft.length < 3) return;
    if (tool === "boundary") { setBoundary([...draft, draft[0]]); setTool("building"); }
    else {
      const k = `t${Date.now()}`;
      setRows((r) => [...r, { key: k, id: "", floors: "", units: "", ring: [...draft, draft[0]], include: true }]);
      setSel(k);
    }
    setDraft([]);
  };
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "Enter") closeDraft();
      if (e.key === "Escape") { setDraft([]); setPick(null); }
      if (e.key === "Backspace") setDraft((d) => d.slice(0, -1));
    };
    window.addEventListener("keydown", kd);
    return () => window.removeEventListener("keydown", kd);
  });
  const onRefClick = (pt: [number, number]) => {
    if (pick === "d1" || pick === "d2") { setCp({ ...cp, [pick]: pt }); setPick(pick === "d1" ? "s2" : null); }
  };

  const srcRings: PlanRing[] = useMemo(() => [
    ...(boundary ? [{ id: "bnd", pts: boundary, stroke: "#3ee39a", dash: true, width: 2 }] : []),
    ...rows.map((r) => ({ id: r.key, pts: r.ring, stroke: !r.include ? "#5b6b84" : sel === r.key ? "#ffffff" : "#ff8a3d", fill: r.include ? "#ff8a3d33" : "none",
      label: r.include ? `${r.id || "?"}${r.floors ? ` · ${r.floors}F` : ""}` : undefined, width: sel === r.key ? 3 : 1.6 })),
  ], [rows, boundary, sel]);

  const placed = useMemo(() => {
    if (placeMode !== "points" || !cp.s1 || !cp.d1 || !cp.s2 || !cp.d2) return null;
    try { return sim([cp.s1, cp.s2], [cp.d1, cp.d2], !!isImg); } catch { return null; }
  }, [placeMode, cp, isImg]);
  const refRings: PlanRing[] = useMemo(() => {
    if (!ref) return [];
    const out: PlanRing[] = [
      { id: "site", pts: ref.site_boundary, stroke: "#3ee39a", dash: true, width: 1.6 },
      ...ref.buildings.map((b) => ({ id: b.id, pts: b.footprint, stroke: b.kind === "MAIN" ? "#4a94ff" : "#6f8098", fill: b.kind === "MAIN" ? "#4a94ff22" : "#6f809822", label: b.kind === "MAIN" ? b.id : undefined })),
    ];
    if (placed) rows.filter((r) => r.include).forEach((r) => out.push({ id: "p" + r.key, pts: r.ring.map(placed.f), stroke: "#ff8a3d", fill: "#ff8a3d33", label: r.id || "?" }));
    if (saved) saved.buildings.forEach((b: any) => out.push({ id: "s" + b.id, pts: b.footprint, stroke: "#ff8a3d", fill: "#ff8a3d55", label: `${b.id}·${b.floors}F` }));
    return out;
  }, [ref, placed, rows, saved]);
  const mk = (k: "s1" | "s2" | "d1" | "d2", lab: string, c: string): PlanMarker[] => (cp[k] ? [{ pt: cp[k]!, label: lab, color: c }] : []);

  const problems = [
    ...(rows.filter((r) => r.include).length ? [] : ["건물이 없습니다"]),
    ...rows.filter((r) => r.include && !r.id.trim()).map(() => "동 번호가 빈 건물이 있습니다").slice(0, 1),
    ...rows.filter((r) => r.include && !(Number(r.floors) >= 1)).map(() => "층수가 빈 건물이 있습니다").slice(0, 1),
    ...(placeMode === "crs" && !crs ? ["좌표계를 고르세요"] : []),
    ...(placeMode === "points" && !(cp.s1 && cp.d1 && cp.s2 && cp.d2) ? ["기준점 2쌍을 찍으세요"] : []),
  ];
  const save = async () => {
    setBusy("저장 중…"); setErr(null);
    try {
      const body = {
        buildings: rows.filter((r) => r.include).map((r) => ({ id: r.id.trim(), floors: Number(r.floors), units_per_floor: r.units ? Number(r.units) : undefined, ring: r.ring })),
        boundary, placement: placeMode === "crs" ? { mode: "crs", crs } : { mode: "points", src: [cp.s1, cp.s2], dst: [cp.d1, cp.d2], allow_scale: !!isImg },
        source: { drawing_id: up.drawing_id, filename: up.filename, kind: up.kind, sha256: up.sha256 },
      };
      const r = await fetch(`/api/projects/${id}/scenarios/${code}/layout`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail));
      setSaved(j); reload();
    } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };
  const clearLayout = async () => {
    if (!confirm(`${code === "A" ? "기존안 A" : "변경안 B"}의 도면 입력을 해제하고 기본 배치로 되돌릴까요?`)) return;
    await fetch(`/api/projects/${id}/scenarios/${code}/layout`, { method: "DELETE" });
    reload(); setSaved(null);
  };

  if (!p) return <div className="flex h-full flex-col"><TopBar /><Loading /></div>;
  const pickHint = pick === "s1" ? "도면에서 기준점 1을 클릭" : pick === "d1" ? "오른쪽 현장 평면에서 같은 위치(기준점 1)를 클릭" : pick === "s2" ? "도면에서 기준점 2를 클릭" : pick === "d2" ? "현장 평면에서 기준점 2를 클릭" : null;
  return (
    <div className="flex h-full flex-col">
      <TopBar project={p} latestRunId={p.latest_run?.status === "SUCCEEDED" ? p.latest_run.id : undefined} />
      <main className="grid min-h-0 flex-1 grid-cols-[340px_1fr] gap-3 p-3">
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          <Panel title="① 어느 안의 배치도인가요?" icon={<FileUp size={14} />}>
            <Segmented ariaLabel="대상 안" value={code} onChange={(v) => { setCode(v); setSaved(null); }} options={[{ value: "A", label: "기존안 A (승인안)" }, { value: "B", label: "변경안 B (요청안)" }]} />
            <div className="mt-2 text-[11.5px] text-ink-2">
              현재: {scen?.layout ? <><b className="text-ink">도면 입력됨</b> · {scen.layout.n_buildings}개 동 · {scen.layout.source?.filename}
                <button className="btn btn-sm btn-ghost ml-1" onClick={clearLayout}><Trash2 size={12} />해제</button></> : "기본 배치(예시 단지)"}
            </div>
            <label className="btn btn-primary mt-3 w-full cursor-pointer" data-testid="drawing-input">
              <FileUp size={14} />도면 파일 선택 (DXF · PDF · PNG/JPG)
              <input type="file" accept=".dxf,.pdf,.png,.jpg,.jpeg" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            </label>
            <div className="mt-1.5 text-[10.5px] leading-snug text-muted">DWG는 CAD에서 DXF로 저장해 올려 주세요. 기존안과 변경안은 같은 좌표로 작성된 도면이면 위치가 자동으로 맞습니다.</div>
            {up && <div className="mt-2 text-[11.5px] text-ink-2">{up.filename} · {up.kind}{up.kind === "DXF" ? ` · 단위 ${up.unit_m ? `${up.unit_m} m` : "미지정"}` : ` · ${up.width}×${up.height}px`}</div>}
          </Panel>

          {up?.kind === "DXF" && (
            <Panel title="② 레이어 고르기" icon={<PenLine size={14} />}>
              <div className="max-h-56 overflow-auto">
                <table className="tbl"><thead><tr><th>레이어</th><th className="num">닫힌선</th><th className="num">글자</th><th>건물</th><th>대지</th></tr></thead>
                  <tbody>{up.layers.map((l: any) => (
                    <tr key={l.name}><td className="max-w-[120px] truncate" title={l.name}>{l.name}</td><td className="num">{l.closed}</td><td className="num">{l.texts}</td>
                      <td><input type="checkbox" checked={bLayers.includes(l.name)} onChange={(e) => setBLayers(e.target.checked ? [...bLayers, l.name] : bLayers.filter((x) => x !== l.name))} /></td>
                      <td><input type="radio" name="site" checked={siteLayer === l.name} onChange={() => setSiteLayer(l.name)} /></td></tr>))}</tbody></table>
              </div>
              <label className="mt-2 flex items-center gap-2 text-[12px]"><span className="label">도면 단위</span>
                <select value={unit} onChange={(e) => setUnit(Number(e.target.value))} className="flex-1"><option value={0.001}>mm</option><option value={0.01}>cm</option><option value={1}>m</option></select></label>
              <button className="btn btn-primary mt-2 w-full" disabled={!bLayers.length || !!busy} onClick={extract} data-testid="extract">외곽선·동번호·층수 추출</button>
            </Panel>
          )}

          {isImg && (
            <Panel title="② 외곽선 따라 그리기" icon={<PenLine size={14} />}>
              <Segmented ariaLabel="도구" size="sm" value={tool} onChange={(v) => { setTool(v); setDraft([]); }} options={[{ value: "select", label: <span className="flex items-center gap-1"><MousePointer2 size={12} />선택</span> }, { value: "building", label: "동 외곽" }, { value: "boundary", label: "대지경계" }]} />
              <div className="mt-2 text-[11px] leading-relaxed text-muted">꼭짓점을 차례로 클릭하고 첫 점을 다시 누르거나 Enter로 닫습니다. Backspace = 마지막 점 취소, Esc = 취소. 휠 = 확대, 끌기 = 이동.</div>
              {draft.length > 0 && <div className="mt-2 flex gap-1.5"><button className="btn btn-sm" onClick={closeDraft} disabled={draft.length < 3}><Check size={12} />닫기</button><button className="btn btn-sm btn-ghost" onClick={() => setDraft((d) => d.slice(0, -1))}><Undo2 size={12} />점 취소</button></div>}
            </Panel>
          )}

          {rows.length > 0 && (
            <Panel title={`③ 동 정보 확인 (${rows.filter((r) => r.include).length}개 동)`} icon={<Check size={14} />}>
              <table className="tbl"><thead><tr><th></th><th>동</th><th>층수</th><th>층당 세대</th><th></th></tr></thead>
                <tbody>{rows.map((r, i) => (
                  <tr key={r.key} className={sel === r.key ? "sel" : ""} onClick={() => setSel(r.key)}>
                    <td><input type="checkbox" checked={r.include} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))} aria-label="포함" /></td>
                    <td><input className="!h-7 w-16" value={r.id} placeholder="101" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, id: e.target.value.replace(/동$/, "") } : x)))} /></td>
                    <td><input className="!h-7 w-14" type="number" min={1} max={80} value={r.floors} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, floors: e.target.value } : x)))} /></td>
                    <td><input className="!h-7 w-14" type="number" min={1} max={20} value={r.units} placeholder="자동" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, units: e.target.value } : x)))} /></td>
                    <td>{isImg && <button className="btn btn-sm btn-icon btn-ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="삭제"><Trash2 size={12} /></button>}</td>
                  </tr>))}</tbody></table>
              <div className="mt-1.5 text-[10.5px] text-muted">글자에서 읽은 값은 미리 채워져 있습니다. 회색(제외) 외곽선은 저장하지 않습니다. 층당 세대수는 세대별 일조 계산에 쓰이며, 비우면 외벽 길이로 추정합니다.</div>
            </Panel>
          )}

          {rows.length > 0 && (
            <Panel title="④ 현장 위치 맞추기" icon={<MapPin size={14} />}>
              <Segmented ariaLabel="위치 맞춤 방법" size="sm" value={placeMode} onChange={setPlaceMode}
                options={[{ value: "crs", label: "도면 좌표계", disabled: !up?.crs_candidates?.length }, { value: "points", label: "기준점 2개" }]} />
              {placeMode === "crs" ? (
                <div className="mt-2 space-y-1 text-[12px]">
                  {up.crs_candidates.map((c: any) => (
                    <label key={c.crs} className="flex items-center gap-2"><input type="radio" checked={crs === c.crs} onChange={() => setCrs(c.crs)} />{c.crs} <span className="text-muted">현장까지 {c.distance_to_site_m} m</span></label>))}
                  <div className="text-[10.5px] text-muted">도면이 측량 좌표(중부원점 등)로 그려져 있어 그대로 놓을 수 있습니다.</div>
                </div>
              ) : (
                <div className="mt-2 space-y-1.5 text-[12px]">
                  <div className="text-[11px] text-muted">도면과 오른쪽 현장 평면에서 같은 지점(예: 대지 모서리, 기존 동 모서리)을 두 쌍 찍습니다.{isImg ? " PDF·이미지는 축척도 함께 맞춥니다." : ""}</div>
                  <button className="btn btn-sm w-full" onClick={() => { setCp({}); setPick("s1"); setTool("select"); setDraft([]); }}><MapPin size={12} />기준점 찍기 시작</button>
                  {pickHint && <div className="rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-[11.5px] text-accent">{pickHint}</div>}
                  {placed && <div className="text-[11px] text-ink-2">회전 {placed.rot.toFixed(1)}° · 축척 {placed.scale.toFixed(4)}{!isImg && Math.abs(placed.scale - 1) > 0.02 ? <span className="text-warn"> (도면 단위를 확인하세요)</span> : null}</div>}
                </div>
              )}
            </Panel>
          )}

          {rows.length > 0 && (
            <Panel title="⑤ 저장" icon={<Check size={14} />}>
              {problems.length > 0 && <ul className="mb-2 text-[11.5px] text-warn">{problems.map((x) => <li key={x}>• {x}</li>)}</ul>}
              <button className="btn btn-primary w-full" disabled={problems.length > 0 || !!busy} onClick={save} data-testid="save-layout">{code === "A" ? "기존안 A" : "변경안 B"}로 저장</button>
              {saved && <div className="mt-2 space-y-1.5 text-[12px] text-good">저장했습니다 ({saved.buildings.length}개 동). 오른쪽 평면에서 위치를 확인하세요.
                <button className="btn btn-sm w-full" onClick={() => nav(`/projects/${id}/analysis`)}>전후 계산으로 →</button></div>}
            </Panel>
          )}
          <Panel title="주변 기존 건물 (실제 데이터)" icon={<MapPin size={14} />} collapsible defaultOpen={!p.site_meta?.context_source}>
            <div className="text-[11.5px] leading-relaxed text-ink-2">
              현재: {p.site_meta?.context_source ? <b className="text-ink">{p.site_meta.context_source.filename} · {Object.keys(p.site_meta.context_attrs ?? {}).length}동</b> : "예시 건물 5동 (가상)"}
            </div>
            <div className="mt-1 text-[10.5px] leading-snug text-muted">국가공간정보포털·V-World의 <b>GIS건물통합정보</b> SHP(.shp/.dbf/.shx/.prj를 zip으로 묶음) 또는 GeoJSON. 지상층수·높이·용도를 읽어 주변 공동주택의 일조 피해를 함께 검토합니다. 대지 안 건물은 제외됩니다.</div>
            <label className="mt-2 flex items-center gap-2 text-[12px]"><span className="label">반경</span>
              <select value={radius} onChange={(e) => setRadius(Number(e.target.value))} className="flex-1">{[200, 300, 400, 600, 800].map((r) => <option key={r} value={r}>{r} m</option>)}</select></label>
            <label className="btn mt-2 w-full cursor-pointer" data-testid="context-input">
              <FileUp size={14} />주변 건물 파일 선택 (zip · geojson)
              <input type="file" accept=".zip,.geojson,.json" className="hidden" onChange={(e) => e.target.files?.[0] && onContext(e.target.files[0])} />
            </label>
            {ctxRes && <div className="mt-2 text-[11.5px] text-good">{ctxRes.accepted}동 반영 (공동주택 {ctxRes.n_residential}동, 용도 미상 {ctxRes.n_use_unknown}동) · 좌표계 {ctxRes.crs}
              <div className="text-muted">속성: {Object.entries(ctxRes.fields).map(([k, v]) => `${k}=${v}`).join(", ")} · 제외: 반경 밖 {ctxRes.skipped.far}, 대지 안 {ctxRes.skipped.in_site}, 높이 없음 {ctxRes.skipped.no_height}</div>
              {ctxRes.warnings?.map((w: string) => <div key={w} className="text-warn">{w}</div>)}</div>}
          </Panel>
          {busy && <div className="flex items-center gap-2 text-[12px] text-muted"><Spinner />{busy}</div>}
          {err && <ErrorBox msg={err} />}
        </div>

        <div className="grid min-h-0 grid-cols-2 gap-3">
          <div className="flex min-h-0 flex-col">
            <div className="label mb-1">도면 {up ? `· ${up.filename}` : ""}</div>
            {up ? (
              <PlanCanvas className="min-h-0 flex-1" rings={srcRings} fitKey={`${up.drawing_id}-${rows.length > 0}`} northUp={false}
                image={isImg ? { url: up.image_url, w: up.width, h: up.height } : null}
                draft={tool !== "select" ? draft : null} cursor={pick?.startsWith("s") || tool !== "select" ? "crosshair" : "grab"}
                onClick={pick?.startsWith("s") || (isImg && tool !== "select") ? (pt) => onSrcClick(isImg ? pt : pt) : undefined}
                onRingClick={(k) => setSel(k)} markers={[...mk("s1", "1", "#ffd166"), ...mk("s2", "2", "#ff6bd5")]} />
            ) : <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-line text-[12px] text-muted">도면을 올리면 여기에 표시됩니다</div>}
          </div>
          <div className="flex min-h-0 flex-col">
            <div className="label mb-1">현장 평면 (북쪽 위 · 파랑 = 현재 기존안, 주황 = 올린 도면)</div>
            <PlanCanvas className="min-h-0 flex-1" rings={refRings} fitKey={ref ? "ref" : "none"} cursor={pick?.startsWith("d") ? "crosshair" : "grab"}
              onClick={pick?.startsWith("d") ? onRefClick : undefined} markers={[...mk("d1", "1", "#ffd166"), ...mk("d2", "2", "#ff6bd5")]} />
          </div>
        </div>
      </main>
    </div>
  );
}
