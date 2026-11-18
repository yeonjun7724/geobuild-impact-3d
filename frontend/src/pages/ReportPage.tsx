import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type ReportT, type Run } from "../api";
import { Disclaimer, ErrorBox, Loading, TopBar, useProject } from "../components/Chrome";

export default function ReportPage() {
  const { runId = "" } = useParams();
  const [run, setRun] = useState<Run | null>(null);
  const [reports, setReports] = useState<ReportT[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { p } = useProject(run?.project_id);
  const t = useRef<number | undefined>(undefined);

  const load = async () => {
    try {
      const r = await api.run(runId);
      setRun(r);
      if (r.status === "SUCCEEDED") setReports(await api.reports(runId));
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps
  const pending = reports.some((r) => r.status === "PENDING" || r.status === "RUNNING");
  useEffect(() => {
    if (!pending) return;
    t.current = window.setTimeout(load, 1500);
    return () => window.clearTimeout(t.current);
  }, [reports]); // eslint-disable-line react-hooks/exhaustive-deps

  const generate = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.createReport(runId);
      await load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  if (err && !run) return <ErrorBox msg={err} />;
  if (!run) return <Loading />;
  const ok = reports.find((r) => r.status === "SUCCEEDED");
  const canGenerate = run.status === "SUCCEEDED" && !pending;
  return (
    <div className="flex h-full flex-col">
      <TopBar project={p} latestRunId={runId} />
      <div className="flex min-h-0 flex-1">
        <aside className="w-[340px] shrink-0 overflow-y-auto border-r border-line bg-white p-4">
          <h1 className="mb-1 text-[16px] font-bold text-brand">상세 기술보고서</h1>
          <div className="mb-3 text-[12px] text-ink-2">분석 run <span className="font-mono">{runId}</span> ({run.analysis_type}, {run.params.date}) — <b>{run.status}</b></div>
          <Disclaimer className="mb-3" />
          <button className="btn btn-primary w-full justify-center py-2" disabled={!canGenerate || busy} onClick={generate} data-testid="generate-report">
            {pending ? "보고서 생성 중…" : run.status !== "SUCCEEDED" ? "분석 완료 후 생성 가능" : ok ? "새 버전으로 다시 생성" : "보고서 생성 (HTML + PDF + ZIP)"}
          </button>
          <div className="mt-2 text-[11px] text-muted">보고서는 분석 결과 JSON과 QA 기록에서 결정론적으로 생성되며, 서버에 실제 파일이 만들어진 뒤에만 다운로드가 활성화됩니다.</div>
          {err && <ErrorBox msg={err} />}
          <h2 className="mb-1 mt-4 text-[13px] font-bold">생성 이력</h2>
          {reports.length === 0 && <div className="text-[12px] text-ink-2">아직 생성된 보고서가 없습니다.</div>}
          {reports.map((r) => (
            <div key={r.id} className="panel mb-2 p-2 text-[12px]" data-testid="report-item">
              <div className="flex justify-between"><span className="font-mono">{r.id}</span><b className={r.status === "SUCCEEDED" ? "text-emerald-700" : r.status === "FAILED" ? "text-red-700" : "text-blue-700"}>{r.status}</b></div>
              <div className="text-ink-2">v{r.version} · {r.stage}</div>
              {r.error && <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-[10px] text-red-700">{r.error}</pre>}
              {r.status === "SUCCEEDED" && (
                <>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <a className="btn px-2 py-0.5" href={r.files.pdf?.url} data-testid="dl-pdf">PDF ({(r.files.pdf.size_bytes / 1024 / 1024).toFixed(2)} MB, {r.files.pdf.pages}쪽)</a>
                    <a className="btn px-2 py-0.5" href={r.files.html?.url}>HTML</a>
                    <a className="btn px-2 py-0.5" href={r.files.zip?.url} data-testid="dl-zip">증거 ZIP ({(r.files.zip.size_bytes / 1024 / 1024).toFixed(1)} MB)</a>
                  </div>
                  <ul className="mt-1 space-y-0.5 text-[11px] text-ink-2">
                    <li>PDF 검증: {r.quality.ok ? <b className="text-emerald-700">통과</b> : <b className="text-red-700">경고</b>} · 한글 추출 {r.quality.hangul_chars_extracted?.toLocaleString()}자 · 첫 쪽 제목 {String(r.quality.first_page_has_title)}</li>
                    <li>보고서 수치 ↔ analysis_summary.json 대조: {r.quality.all_key_numbers_found ? "일치" : "불일치 항목 있음"}</li>
                    <li>목차 쪽번호 안정화: {String(r.quality.toc_consistent_after_rerender)} ({r.quality.render_passes}회 렌더)</li>
                    <li>3D 캡처: {r.quality.cesium_capture?.ok ? "포함" : `미포함 → 정적 분석지도로 대체 (${(r.quality.cesium_capture?.reason ?? "").slice(0, 60)})`}</li>
                  </ul>
                </>
              )}
            </div>
          ))}
        </aside>
        <main className="min-w-0 flex-1 bg-stone-300">
          {ok ? <iframe title="보고서 HTML 미리보기" src={`/api/reports/${ok.id}/view`} className="h-full w-full border-0" /> : (
            <div className="flex h-full items-center justify-center text-ink-2">{pending ? <Loading text="정적 지도·차트 생성 및 Chromium PDF 렌더링 중… (약 1분)" /> : "보고서를 생성하면 여기에 읽기 전용 HTML 스냅샷이 표시됩니다."}</div>
          )}
        </main>
      </div>
    </div>
  );
}
