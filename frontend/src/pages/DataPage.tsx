import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Building2, Database, FileUp, Mountain, ScrollText } from "lucide-react";
import { api } from "../api";
import { DataBadges, Disclaimer, ErrorBox, Loading, TopBar, useProject } from "../components/Chrome";
import { ClassChip, Panel, Spinner } from "../ui";

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
  const [busy, setBusy] = useState<string | null>(null);
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
    setErr(null); setBusy("dem");
    try {
      const r = await api.uploadTerrain(id, file, vd, acq, lic);
      setMsg(r.message + (r.clipped ? " · 대용량 원본에서 대상지 ±6 km를 추출해 등록" : "") + (r.qa?.warnings?.length ? ` · 경고: ${r.qa.warnings.join(" / ")}` : "") + (r.qa?.errors?.length ? ` · 오류: ${r.qa.errors.join(" / ")}` : ""));
      load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };
  const upB = async () => {
    if (!bfile) return;
    setErr(null); setBusy("bld");
    try {
      const r = await api.uploadBuildings(id, bfile);
      setMsg(`건물 GeoJSON ${r.status}: 채택 ${r.qa.accepted ?? 0}개${r.qa.errors?.length ? " · 오류: " + r.qa.errors.join(" / ") : ""}`);
      load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };
  if (!p) return <Loading />;
  return (
    <div className="flex h-full flex-col">
      <TopBar project={p} latestRunId={p.latest_run?.status === "SUCCEEDED" ? p.latest_run.id : null} />
      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-6xl px-6 py-6">
          <h1 className="mb-1 flex items-center gap-2 text-[20px] font-bold text-white"><Database size={20} className="text-accent" />데이터 · 품질 · 출처</h1>
          <p className="mb-3 text-[12.5px] text-ink-2">실제 30 m DEM과 건물 footprint로 교체하면 같은 분석·보고서 파이프라인이 그대로 동작합니다.</p>
          <div className="mb-3"><DataBadges b={p.data_badges} /></div>
          <Disclaimer className="mb-4" />
          {msg && <div className="mb-3 rounded-lg border border-accent/30 bg-accent/10 p-2.5 text-[12px]" role="status">{msg}</div>}
          {err && <ErrorBox msg={err} />}
          <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="30 m DEM GeoTIFF 업로드" icon={<Mountain size={14} />}>
              <p className="mb-3 text-[12px] leading-relaxed text-ink-2">CRS·NoData·셀 크기·고도 범위·급경사·커버리지·수직기준·DSM 여부를 검사합니다. 검사 실패 시 기존 지형이 유지됩니다. 2,500만 셀을 넘는 원본은 대상지 ±6 km만 추출(재표본화 없음)하고 원본 해시를 기록합니다.</p>
              <FilePick accept=".tif,.tiff" file={file} onFile={setFile} label="GeoTIFF 선택" />
              <div className="mt-2 grid grid-cols-3 gap-2">
                <label className="flex flex-col gap-1"><span className="label">수직기준(신고)</span><input type="text" placeholder="예: EGM2008" value={vd} onChange={(e) => setVd(e.target.value)} /></label>
                <label className="flex flex-col gap-1"><span className="label">취득일</span><input type="text" placeholder="YYYY-MM-DD" value={acq} onChange={(e) => setAcq(e.target.value)} /></label>
                <label className="flex flex-col gap-1"><span className="label">라이선스</span><input type="text" value={lic} onChange={(e) => setLic(e.target.value)} /></label>
              </div>
              <div className="mt-1.5 text-[10.5px] text-muted">신고된 수직기준은 파일로 검증할 수 없으면 UNRESOLVED로 기록되며 지오이드/타원체고 상수 환산을 하지 않습니다.</div>
              <button className="btn btn-primary mt-3" disabled={!file || !!busy} onClick={upTerrain}>{busy === "dem" ? <Spinner /> : <FileUp size={14} />}업로드 및 검사</button>
            </Panel>
            <Panel title="건물 footprint GeoJSON 업로드" icon={<Building2 size={14} />}>
              <p className="mb-3 text-[12px] leading-relaxed text-ink-2">FeatureCollection(Polygon, 속성 id·floors 또는 height_m). CRS 미지정 시 RFC 7946 WGS84, <code className="text-accent">crs</code> 멤버로 EPSG:5179 등 지정 가능. GeometryCollection·무효 도형·중정·단위 오류·멀티파트·중복/충돌 ID는 거부합니다.</p>
              <FilePick accept=".geojson,.json" file={bfile} onFile={setBfile} label="GeoJSON 선택" />
              <button className="btn btn-primary mt-3" disabled={!bfile || !!busy} onClick={upB}>{busy === "bld" ? <Spinner /> : <FileUp size={14} />}업로드 및 검증</button>
            </Panel>
          </div>
          <Panel title="데이터셋 및 품질 검사" icon={<Database size={14} />} pad={false} className="mb-4">
            <div className="overflow-auto">
              <table className="tbl">
                <thead><tr><th>종류</th><th>분류</th><th>파일</th><th>상태</th><th>CRS / 셀</th><th>수직기준</th><th>경고·오류</th><th /></tr></thead>
                <tbody>
                  {ds.map((d) => (
                    <tr key={d.id}>
                      <td>{d.kind}</td><td><ClassChip c={d.data_class} /></td><td className="max-w-[220px] truncate" title={d.filename}>{d.filename}</td>
                      <td className={d.status === "REJECTED" ? "text-bad" : d.status === "WARN" ? "text-warn" : "text-good"}>{d.status}</td>
                      <td>{d.qa.crs ?? d.meta?.crs ?? "-"} {d.qa.cell_size_x ? `/ ${Number(d.qa.cell_size_x).toFixed(1)} m` : ""}</td>
                      <td>{d.qa.vertical_datum_status ?? "-"}</td>
                      <td className="max-w-[360px] text-[11px] text-ink-2">{[...(d.qa.errors ?? []), ...(d.qa.warnings ?? [])].join(" / ") || "-"}</td>
                      <td>{d.kind === "TERRAIN" && d.status !== "REJECTED" && <button className="btn btn-sm" onClick={() => api.activateTerrain(id, d.id).then(load)}>활성화</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel title="출처 기록 (Provenance)" icon={<ScrollText size={14} />} pad={false}>
            <div className="overflow-auto">
              <table className="tbl">
                <thead><tr><th>대상</th><th>분류</th><th>출처</th><th>접근일</th><th>라이선스</th><th>비고</th></tr></thead>
                <tbody>{prov.map((r, i) => <tr key={i}><td>{r.subject}</td><td><ClassChip c={r.data_class} /></td><td className="text-[11.5px]">{r.source}{r.url && <><br /><a className="break-all text-accent" href={r.url} target="_blank" rel="noreferrer">{r.url.slice(0, 80)}</a></>}</td><td>{r.accessed ?? "-"}</td><td>{r.license ?? "-"}</td><td className="text-[11px] text-ink-2">{r.note}</td></tr>)}</tbody>
              </table>
            </div>
          </Panel>
        </div>
      </main>
    </div>
  );
}

function FilePick({ accept, file, onFile, label }: { accept: string; file: File | null; onFile: (f: File | null) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-[#35507a] bg-black/20 p-3 hover:border-accent">
      <FileUp size={18} className="text-accent" />
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">{file ? `${file.name} · ${(file.size / 1048576).toFixed(2)} MB` : label}</span>
      <input aria-label={label} type="file" accept={accept} className="hidden" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
    </label>
  );
}
