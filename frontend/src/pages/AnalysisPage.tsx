import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { BarChart3, CheckCircle2, Circle, Clock, FileText, Loader2, Play, Settings2, XCircle } from "lucide-react";
import { api, type Run } from "../api";
import { DataBadges, Disclaimer, ErrorBox, Loading, TopBar, useProject } from "../components/Chrome";
import { Panel, Progress, Segmented, Stat, Switch } from "../ui";

const STAGES = [
  { key: "입력 검증", label: "입력 스냅샷 · 해시 검증" }, { key: "지반 메쉬", label: "30m DEM 지면 + 가상 계획지반" },
  { key: "C.", label: "C 이격거리" }, { key: "A.", label: "A 직사일조 레이캐스팅" }, { key: "B.", label: "B 그림자 격자" },
  { key: "QA", label: "해석해·round-trip·교차검증 QA" }, { key: "민감도", label: "민감도 (Δt·지반고·미세이동)" }, { key: "완료", label: "결과 저장" },
];

export default function AnalysisPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { p, err } = useProject(id);
  const [form, setForm] = useState({ analysis_type: "ALL", date: "2026-12-22", start: "08:00", end: "16:00", interval_min: 5, timezone: "Asia/Seoul", grid_spacing_m: 2, include_sensitivity: true, reuse_cache: true });
  const [runs, setRuns] = useState<Run[]>([]);
  const [cur, setCur] = useState<Run | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [results, setResults] = useState<any>(null);
  const poll = useRef<number | undefined>(undefined);
  const refresh = () => api.runs(id).then(setRuns).catch(() => {});
  useEffect(() => { refresh(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!cur || cur.status === "SUCCEEDED" || cur.status === "FAILED") {
      if (cur?.status === "SUCCEEDED") api.results(cur.id).then(setResults).catch(() => {});
      return;
    }
    poll.current = window.setTimeout(async () => { try { setCur(await api.run(cur.id)); } catch (e: any) { setMsg(e.message); } refresh(); }, 1000);
    return () => window.clearTimeout(poll.current);
  }, [cur]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async () => {
    setMsg(null);
    setResults(null);
    try {
      const r = await api.startAnalysis(id, form);
      setCur(r);
      refresh();
      if (r.reused) setMsg("동일 입력·조건의 기존 성공 결과를 재사용했습니다 (cache key 일치). 다시 계산하려면 '캐시 재사용'을 끄세요.");
    } catch (e: any) { setMsg(e.message); }
  };
  if (err) return <ErrorBox msg={err} />;
  if (!p) return <Loading />;
  const scB = p.scenarios.find((s) => s.code === "B");
  const nChanged = Object.keys(scB?.transforms ?? {}).length;
  const latestOk = runs.find((r) => r.status === "SUCCEEDED");
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  const running = !!cur && (cur.status === "PENDING" || cur.status === "RUNNING");
  const mm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const nInt = (mm(form.end) - mm(form.start)) / form.interval_min;
  const stageIdx = cur ? (cur.status === "SUCCEEDED" ? STAGES.length : Math.max(0, STAGES.findIndex((s) => cur.stage.startsWith(s.key)))) : -1;

  return (
    <div className="flex h-full flex-col">
      <TopBar project={p} latestRunId={latestOk?.id} />
      <main className="flex-1 overflow-auto">
        <div className="mx-auto grid max-w-7xl gap-5 px-6 py-6 lg:grid-cols-[400px_1fr]">
          <div className="flex flex-col gap-4">
            <Panel title="정밀 분석 조건" icon={<Settings2 size={14} />}>
              <div className="mb-3 rounded-lg bg-black/25 p-2.5 text-[12px] text-ink-2">기준안 A(잠금) vs 변경안 B <b className="text-scen-b">rev {scB?.revision}</b> · 변경 주동 <b className="text-ink">{nChanged}개</b>. 실행 시점의 입력이 불변 스냅샷으로 고정됩니다.</div>
              <div className="label mb-1.5">분석 항목</div>
              <Segmented ariaLabel="분석 항목" value={form.analysis_type} onChange={(v) => set("analysis_type", v)} options={[{ value: "ALL", label: "A+B+C 전체" }, { value: "A", label: "A 일조" }, { value: "B", label: "B 그림자" }, { value: "C", label: "C 이격" }]} />
              <div className="mt-3 grid grid-cols-2 gap-2.5">
                <Field label="분석일"><input type="date" value={form.date} onChange={(e) => set("date", e.target.value)} className="w-full" /></Field>
                <Field label="시간대 (고정)"><input type="text" value={form.timezone} readOnly className="w-full" title="3D 시간 슬라이더와 같은 순간을 쓰도록 Asia/Seoul로 고정" /></Field>
                <Field label="시작 (KST)"><input type="time" value={form.start} onChange={(e) => set("start", e.target.value)} className="w-full" /></Field>
                <Field label="종료 (KST)"><input type="time" value={form.end} onChange={(e) => set("end", e.target.value)} className="w-full" /></Field>
                <Field label="시간 간격 (분)"><input type="number" min={1} max={60} value={form.interval_min} onChange={(e) => set("interval_min", Number(e.target.value))} className="w-full" /></Field>
                <Field label="그림자 격자 (m)"><input type="number" min={1} max={10} step={0.5} value={form.grid_spacing_m} onChange={(e) => set("grid_spacing_m", Number(e.target.value))} className="w-full" /></Field>
              </div>
              <div className={`mt-2 text-[11px] ${Number.isInteger(nInt) && nInt > 0 ? "text-muted" : "text-bad"}`}>{Number.isInteger(nInt) && nInt > 0 ? `${nInt}개 구간 (구간 중점 규칙)` : "분석 시간이 간격으로 나누어 떨어져야 합니다"}</div>
              <div className="mt-2 border-t border-line pt-2">
                <Switch checked={form.include_sensitivity} onChange={(b) => set("include_sensitivity", b)} label="민감도 시험 포함" hint="Δt=1분, 가상 지반 ±1/±3 m, 변경 주동 0.5 m 미세이동" />
                <Switch checked={form.reuse_cache} onChange={(b) => set("reuse_cache", b)} label="동일 입력이면 기존 결과 재사용" />
              </div>
              <div className="mt-2 text-[11px] leading-snug text-muted">기본 분석일 2026-12-22(동지)는 한국천문연구원 월력요항 기준. 격자 간격은 샘플링 간격일 뿐 DEM 정확도가 아니며, 직사일조는 기하학적 직사일조 가능 시간입니다.</div>
              <button className="btn btn-primary mt-3 w-full !h-10" disabled={running} onClick={start} data-testid="run-analysis">
                {running ? <><Loader2 size={15} className="animate-spin" />계산 중…</> : <><Play size={15} />분석 실행</>}
              </button>
              {msg && <div className="mt-2 rounded-lg bg-warn/10 p-2 text-[11.5px] text-[#f3d9a0]" role="status">{msg}</div>}
            </Panel>
            <Panel title="데이터 상태" collapsible><DataBadges b={p.data_badges} /></Panel>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <Disclaimer />
            {cur && (
              <Panel title={<span>실행 <span className="font-mono">{cur.id}</span></span>} icon={<Clock size={14} />} actions={<StatusChip s={cur.status} />}>
                <div data-testid="run-status">
                  <div className="mb-1 flex justify-between text-[11.5px] text-ink-2"><span>{cur.stage}</span><span className="tnum">{(cur.status === "SUCCEEDED" ? 100 : cur.progress).toFixed(0)}%{cur.processing_seconds ? ` · ${cur.processing_seconds}s` : ""}</span></div>
                  <Progress value={cur.status === "SUCCEEDED" ? 100 : cur.progress} tone={cur.status === "FAILED" ? "bad" : cur.status === "SUCCEEDED" ? "good" : "accent"} />
                  <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 md:grid-cols-4">
                    {STAGES.map((s, i) => {
                      const done = i < stageIdx, now = i === stageIdx && running;
                      return <div key={s.key} className={`flex items-center gap-1.5 text-[11.5px] ${done ? "text-good" : now ? "text-white" : "text-muted"}`}>
                        {done ? <CheckCircle2 size={13} /> : now ? <Loader2 size={13} className="animate-spin text-accent" /> : <Circle size={13} />}{s.label}</div>;
                    })}
                  </div>
                  <div className="mt-2 text-[11px] text-muted">작업 백엔드 <b className="text-ink-2">{cur.job_backend || "-"}</b>{cur.job_id ? ` · job ${cur.job_id.slice(0, 8)}` : ""} · 상태 {cur.status}</div>
                  {cur.error && <div className="mt-2 rounded-lg bg-bad/10 p-2 font-mono text-[11px] text-[#ffb4b4]">{cur.error}</div>}
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[11.5px] text-ink-2">작업 로그 ({cur.logs.length})</summary>
                    <div className="mt-1 max-h-[180px] overflow-auto rounded-lg bg-black/40 p-2 font-mono text-[11px] text-ink-2">
                      {cur.logs.map((l, i) => <div key={i}>{l.elapsed_s !== undefined ? `[${l.elapsed_s.toFixed(1)}s] ` : ""}{l.stage}: {l.msg.length > 300 ? l.msg.slice(-300) : l.msg}</div>)}
                    </div>
                  </details>
                  {cur.status === "SUCCEEDED" && (
                    <div className="mt-3 flex gap-2">
                      <button className="btn btn-primary" onClick={() => nav(`/projects/${id}/compare/${cur.id}`)} data-testid="open-compare"><BarChart3 size={14} />3D 결과 비교</button>
                      <button className="btn" onClick={() => nav(`/reports/${cur.id}`)}><FileText size={14} />보고서 생성</button>
                    </div>
                  )}
                </div>
              </Panel>
            )}
            {results && <ResultKpis r={results} />}
            <Panel title="분석 이력 (서버 저장 · 새로고침 후에도 유지)" pad={false}>
              <div className="max-h-[340px] overflow-auto">
                <table className="tbl">
                  <thead><tr><th>Run</th><th>항목</th><th>상태</th><th>조건</th><th className="num">처리(s)</th><th>QA</th><th>생성</th><th /></tr></thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.id} className={cur?.id === r.id ? "sel" : ""} onClick={() => setCur(r)} style={{ cursor: "pointer" }}>
                        <td className="font-mono">{r.id}</td><td>{r.analysis_type}</td><td><StatusChip s={r.status} /></td>
                        <td className="text-ink-2">{r.params.date} · {r.params.interval_min}분 · {r.params.grid_spacing_m}m</td>
                        <td className="num">{r.processing_seconds ?? "-"}</td>
                        <td>{r.quality_overview ? `${r.quality_overview.n_pass}✓ ${r.quality_overview.n_fail}✗` : "-"}</td>
                        <td className="text-ink-2">{new Date(r.created_at).toLocaleString("ko-KR")}</td>
                        <td>{r.status === "SUCCEEDED" && <Link className="text-accent" to={`/projects/${id}/compare/${r.id}`} onClick={(e) => e.stopPropagation()}>결과 →</Link>}</td>
                      </tr>
                    ))}
                    {runs.length === 0 && <tr><td colSpan={8} className="py-6 text-center text-muted">아직 실행 이력이 없습니다</td></tr>}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
        </div>
      </main>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1"><span className="label">{label}</span>{children}</label>;
}

function StatusChip({ s }: { s: string }) {
  const m: Record<string, [string, React.ReactNode]> = {
    SUCCEEDED: ["chip-ok", <CheckCircle2 size={11} key="s" />], FAILED: ["chip-bad", <XCircle size={11} key="f" />],
    RUNNING: ["chip-up", <Loader2 size={11} className="animate-spin" key="r" />], PENDING: ["", <Clock size={11} key="p" />],
  };
  const [cls, icon] = m[s] ?? ["", null];
  return <span className={`chip ${cls}`}>{icon}{s}</span>;
}

function ResultKpis({ r }: { r: any }) {
  const s = r.summary;
  return (
    <div className="rise grid grid-cols-2 gap-2.5 xl:grid-cols-5">
      {s.A && <Stat label="A 일조 감소 수광점" value={s.A.n_decreased.toLocaleString()} tone="bad" sub={`비교 ${s.A.n_common.toLocaleString()} · 증가 ${s.A.n_increased}`} />}
      {s.A && <Stat label="A 최대 감소" value={`${s.A.delta_total_min_min}분`} sub={`평균 ${s.A.mean_total_min_a}→${s.A.mean_total_min_b}분`} />}
      {s.B && <Stat label="B 최대 신규 음영" value={`${Math.round(s.B.max_new_shade_area_m2).toLocaleString()}m²`} tone="warn" sub={`${s.B.max_new_shade_time} KST`} />}
      {s.C?.min_pair_a && <Stat label="C 최소 이격 A→B" value={`${s.C.min_pair_b.distance_m.toFixed(1)}m`} sub={`A ${s.C.min_pair_a.distance_m.toFixed(1)}m`} />}
      <Stat label="자동 QA" value={`${r.quality.n_pass}✓ / ${r.quality.n_fail}✗`} tone={r.quality.critical_fail.length ? "bad" : "good"} sub={r.quality.critical_fail.length ? "치명 실패 있음" : "치명 실패 없음"} />
    </div>
  );
}
