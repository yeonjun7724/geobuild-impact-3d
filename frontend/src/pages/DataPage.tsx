import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import { ClassBadge, DataBadges, Disclaimer, ErrorBox, Loading, TopBar, useProject } from "../components/Chrome";

export default function DataPage() {
  const { id = "" } = useParams();
  const { p, reload } = useProject(id);
  const [ds, setDs] = useState<any[]>([]);
  const [prov, setProv] = useState<any[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [bfile, setBfile] = useState<File | null>(null);
  const [vd, setVd] = useState("");
  const [acq, setAcq] = useState("");
  const [lic, setLic] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => {
    api.datasets(id).then(setDs).catch((e) => setErr(e.message));
    api.provenance(id).then(setProv).catch(() => {});
    reload();
  };
  useEffect(load, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const upTerrain = async () => {
    if (!file) return;
    setErr(null);
    try {
      const r = await api.uploadTerrain(id, file, vd, acq, lic);
      setMsg(r.message + (r.qa?.warnings?.length ? ` · 경고: ${r.qa.warnings.join(" / ")}` : "") + (r.qa?.errors?.length ? ` · 오류: ${r.qa.errors.join(" / ")}` : ""));
      load();
    } catch (e: any) { setErr(e.message); }
  };
  const upB = async () => {
    if (!bfile) return;
    setErr(null);
    try {
      const r = await api.uploadBuildings(id, bfile);
      setMsg(`건물 GeoJSON ${r.status}: 채택 ${r.qa.accepted ?? 0}개${r.qa.errors?.length ? " · 오류: " + r.qa.errors.join(" / ") : ""}`);
      load();
    } catch (e: any) { setErr(e.message); }
  };
  if (!p) return <Loading />;
  return (
    <div className="flex h-full flex-col">
      <TopBar project={p} latestRunId={p.latest_run?.status === "SUCCEEDED" ? p.latest_run.id : null} />
      <div className="mx-auto w-full max-w-6xl flex-1 overflow-auto p-5">
        <h1 className="mb-2 text-[18px] font-bold text-brand">데이터 · 품질 · 출처</h1>
        <Disclaimer className="mb-3" />
        <div className="mb-4"><DataBadges b={p.data_badges} /></div>
        {msg && <div className="mb-3 rounded border border-blue-200 bg-blue-50 p-2 text-[12px]" role="status">{msg}</div>}
        {err && <ErrorBox msg={err} />}
        <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <section className="panel p-4">
            <h2 className="mb-1 text-[14px] font-bold">30 m DEM GeoTIFF 업로드</h2>
            <p className="mb-2 text-[12px] text-ink-2">CRS·NoData·셀 크기·고도 범위·급경사·커버리지·수직기준·DSM 여부를 검사합니다. 검사 실패 시 기존 지형(DEMO 합성)이 유지됩니다. 30 m보다 정밀한 DEM은 필수가 아닙니다.</p>
            <input aria-label="DEM 파일" type="file" accept=".tif,.tiff" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <div className="mt-2 grid grid-cols-3 gap-2">
              <label className="fld">수직기준(신고값)<input type="text" placeholder="예: EGM2008" value={vd} onChange={(e) => setVd(e.target.value)} /></label>
              <label className="fld">취득일<input type="text" placeholder="YYYY-MM-DD" value={acq} onChange={(e) => setAcq(e.target.value)} /></label>
              <label className="fld">라이선스<input type="text" value={lic} onChange={(e) => setLic(e.target.value)} /></label>
            </div>
            <div className="mt-1 text-[10.5px] text-muted">신고된 수직기준은 파일로 검증할 수 없으면 UNRESOLVED로 기록되며 지오이드/타원체고 상수 환산을 하지 않습니다.</div>
            <button className="btn btn-primary mt-2" disabled={!file} onClick={upTerrain}>업로드 및 검사</button>
          </section>
          <section className="panel p-4">
            <h2 className="mb-1 text-[14px] font-bold">건물 footprint GeoJSON 업로드</h2>
            <p className="mb-2 text-[12px] text-ink-2">FeatureCollection (Polygon, 속성 id·floors 또는 height_m). CRS 미지정 시 RFC 7946 WGS84로 해석, <code>crs</code> 멤버로 EPSG:5179 등 지정 가능. GeometryCollection·무효 도형·단위 오류·멀티파트는 거부됩니다. 채택 시 주동이 교체되고 B 변경이 초기화됩니다.</p>
            <input aria-label="GeoJSON 파일" type="file" accept=".geojson,.json" onChange={(e) => setBfile(e.target.files?.[0] ?? null)} />
            <button className="btn btn-primary mt-2" disabled={!bfile} onClick={upB}>업로드 및 검증</button>
          </section>
        </div>
        <section className="panel mb-4 p-4">
          <h2 className="mb-2 text-[14px] font-bold">데이터셋 및 품질 검사</h2>
          <table className="tbl">
            <thead><tr><th>종류</th><th>분류</th><th>파일</th><th>상태</th><th>CRS / 셀</th><th>수직기준</th><th>경고·오류</th><th /></tr></thead>
            <tbody>
              {ds.map((d) => (
                <tr key={d.id}>
                  <td>{d.kind}</td><td><ClassBadge c={d.data_class} /></td><td className="max-w-[220px] truncate" title={d.filename}>{d.filename}</td>
                  <td className={d.status === "REJECTED" ? "text-red-700" : d.status === "WARN" ? "text-amber-700" : "text-emerald-700"}>{d.status}</td>
                  <td>{d.qa.crs ?? d.meta?.crs ?? "-"} {d.qa.cell_size_x ? `/ ${Number(d.qa.cell_size_x).toFixed(1)} m` : ""}</td>
                  <td>{d.qa.vertical_datum_status ?? "-"}</td>
                  <td className="max-w-[320px] text-[11px]">{[...(d.qa.errors ?? []), ...(d.qa.warnings ?? [])].join(" / ") || "-"}</td>
                  <td>{d.kind === "TERRAIN" && d.status !== "REJECTED" && <button className="btn px-2 py-0.5" onClick={() => api.activateTerrain(id, d.id).then(load)}>활성화</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="panel p-4">
          <h2 className="mb-2 text-[14px] font-bold">출처 기록 (Provenance)</h2>
          <table className="tbl">
            <thead><tr><th>대상</th><th>분류</th><th>출처</th><th>접근일</th><th>라이선스</th><th>비고</th></tr></thead>
            <tbody>{prov.map((r, i) => <tr key={i}><td>{r.subject}</td><td><ClassBadge c={r.data_class} /></td><td className="text-[11.5px]">{r.source}{r.url && <><br /><a className="break-all text-brand-2 underline" href={r.url} target="_blank" rel="noreferrer">{r.url.slice(0, 80)}</a></>}</td><td>{r.accessed ?? "-"}</td><td>{r.license ?? "-"}</td><td className="text-[11px]">{r.note}</td></tr>)}</tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
