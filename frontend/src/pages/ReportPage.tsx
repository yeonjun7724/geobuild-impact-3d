import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { CheckCircle2, Download, FileArchive, FileCode2, FileText, Loader2, RefreshCw, XCircle } from "lucide-react";
import { api, type ReportT, type Run } from "../api";
import { Disclaimer, ErrorBox, Loading, TopBar, useProject } from "../components/Chrome";
import { Panel } from "../ui";

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
    try { await api.createReport(runId); await load(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  if (err && !run) return <ErrorBox msg={err} />;
  if (!run) return <Loading />;
  const ok = reports.find((r) => r.status === "SUCCEEDED");
  const canGenerate = run.status === "SUCCEEDED" && !pending;
  const q = ok?.quality ?? {};
  return (
    <div className="flex h-full flex-col">
      <TopBar project={p} latestRunId={runId} />
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[360px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-line bg-bg-2 p-4">
          <div>
            <h1 className="text-[18px] font-bold text-white">상세 기술보고서</h1>
            <div className="mt-0.5 text-[12px] text-ink-2">run <span className="font-mono">{runId}</span> · {run.analysis_type} · {run.params.date} · {run.status}</div>
          </div>
          <button className="btn btn-primary !h-11 w-full" disabled={!canGenerate || busy} onClick={generate} data-testid="generate-report">
            {pending ? <><Loader2 size={16} className="animate-spin" />정적 지도·PDF 생성 중…</> : run.status !== "SUCCEEDED" ? "분석 완료 후 생성 가능" : ok ? <><RefreshCw size={15} />새 버전으로 다시 생성</> : <><FileText size={15} />보고서 생성 (HTML · PDF · ZIP)</>}
          </button>
          {err && <ErrorBox msg={err} />}
          {ok && (
            <>
              <div className="grid grid-cols-1 gap-2">
                <DlCard href={ok.files.pdf?.url} icon={<FileText size={18} />} title="PDF 보고서" sub={`${ok.files.pdf.pages}쪽 · ${(ok.files.pdf.size_bytes / 1048576).toFixed(2)} MB · A4`} testid="dl-pdf" primary />
                <DlCard href={ok.files.zip?.url} icon={<FileArchive size={18} />} title="증거 패키지 ZIP" sub={`CSV·GeoJSON·JSON·지도 · ${(ok.files.zip.size_bytes / 1048576).toFixed(1)} MB`} testid="dl-zip" />
                <DlCard href={ok.files.html?.url} icon={<FileCode2 size={18} />} title="HTML 보고서" sub="같은 내용의 단일 HTML" />
              </div>
              <Panel title="자동 검증">
                <Check ok={!!q.ok} label="PDF 산출물 검증 통과" />
                <Check ok={!!q.first_page_has_title} label="첫 쪽 제목 포함" />
                <Check ok={!!q.korean_text_extractable} label={`한글 텍스트 추출 (${(q.hangul_chars_extracted ?? 0).toLocaleString()}자)`} />
                <Check ok={!!q.all_key_numbers_found} label="보고서 수치 = analysis_summary.json" />
                <Check ok={!!q.toc_consistent_after_rerender} label={`목차 쪽번호 안정 (${q.render_passes}회 렌더)`} />
                <Check ok={!!q.cesium_capture?.ok} label={q.cesium_capture?.ok ? "3D 장면 캡처 포함" : "3D 캡처 없음 → 정적 지도로 대체"} soft />
              </Panel>
            </>
          )}
          <Panel title={`생성 이력 (${reports.length})`} collapsible defaultOpen={!ok}>
            {reports.length === 0 && <div className="text-[12px] text-muted">아직 생성된 보고서가 없습니다.</div>}
            {reports.map((r) => (
              <div key={r.id} className="flex items-center justify-between border-b border-line py-1.5 text-[12px] last:border-0" data-testid="report-item">
                <span className="font-mono">{r.id}</span><span className="text-muted">v{r.version}</span>
                <span className={r.status === "SUCCEEDED" ? "text-good" : r.status === "FAILED" ? "text-bad" : "text-accent"}>{r.status}</span>
              </div>
            ))}
            {reports.find((r) => r.error) && <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-[10px] text-bad">{reports.find((r) => r.error)?.error}</pre>}
          </Panel>
          <Disclaimer />
        </aside>
        <main className="min-w-0 flex-1 bg-[#2a3142]">
          {ok ? <iframe title="보고서 HTML 미리보기" src={`/api/reports/${ok.id}/view`} className="h-full w-full border-0" />
            : <div className="flex h-full flex-col items-center justify-center gap-2 text-ink-2">{pending ? <><Loader2 size={22} className="animate-spin text-accent" />정적 지도·차트 생성 및 Chromium PDF 렌더링 중… (약 1분)</> : <><FileText size={30} className="text-muted" />보고서를 생성하면 읽기 전용 HTML 스냅샷이 여기에 표시됩니다.</>}</div>}
        </main>
      </div>
    </div>
  );
}

function DlCard({ href, icon, title, sub, testid, primary }: { href?: string; icon: React.ReactNode; title: string; sub: string; testid?: string; primary?: boolean }) {
  return (
    <a href={href} data-testid={testid} className={`flex items-center gap-3 rounded-xl border p-3 transition ${primary ? "border-accent/50 bg-accent/10 hover:bg-accent/20" : "border-line bg-panel hover:border-accent/40"}`}>
      <span className={primary ? "text-accent" : "text-ink-2"}>{icon}</span>
      <span className="min-w-0 flex-1"><span className="block text-[13px] font-bold text-ink">{title}</span><span className="block text-[11px] text-muted">{sub}</span></span>
      <Download size={15} className="text-muted" />
    </a>
  );
}

function Check({ ok, label, soft }: { ok: boolean; label: string; soft?: boolean }) {
  return <div className="flex items-center gap-2 py-0.5 text-[12px] text-ink-2">{ok ? <CheckCircle2 size={14} className="text-good" /> : <XCircle size={14} className={soft ? "text-warn" : "text-bad"} />}{label}</div>;
}
