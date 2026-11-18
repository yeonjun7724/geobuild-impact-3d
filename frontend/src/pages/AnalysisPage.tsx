import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type Run } from "../api";
import { DataBadges, Disclaimer, ErrorBox, Kpi, Loading, TopBar, useProject } from "../components/Chrome";

export default function AnalysisPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { p, err } = useProject(id);
  const [form, setForm] = useState({ analysis_type: "ALL", date: "2026-12-22", start: "08:00", end: "16:00", interval_min: 5, timezone: "Asia/Seoul",
    grid_spacing_m: 2, include_sensitivity: true, reuse_cache: true });
  const [runs, setRuns] = useState<Run[]>([]);
  const [cur, setCur] = useState<Run | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const poll = useRef<number | undefined>(undefined);
  const [results, setResults] = useState<any>(null);

  const refresh = () => api.runs(id).then(setRuns).catch(() => {});
  useEffect(() => { refresh(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!cur || cur.status === "SUCCEEDED" || cur.status === "FAILED") {
      if (cur?.status === "SUCCEEDED") api.results(cur.id).then(setResults).catch(() => {});
      return;
    }
    poll.current = window.setTimeout(async () => {
      try { setCur(await api.run(cur.id)); } catch (e: any) { setMsg(e.message); }
      refresh();
    }, 1000);
    return () => window.clearTimeout(poll.current);
  }, [cur]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setMsg(null);
    setResults(null);
    try {
      const r = await api.startAnalysis(id, form);
      setCur(r);
      refresh();
      if (r.reused) setMsg("동일 입력·조건의 기존 성공 결과를 재사용했습니다 (cache key 일치). 재계산하려면 '캐시 재사용'을 끄세요.");
    } catch (e: any) { setMsg(e.message); }
  };
  if (err) return <ErrorBox msg={err} />;
  if (!p) return <Loading />;
  const scB = p.scenarios.find((s) => s.code === "B");
  const nChanged = Object.keys(scB?.transforms ?? {}).length;
  const latestOk = runs.find((r) => r.status === "SUCCEEDED");
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  const running = cur && (cur.status === "PENDING" || cur.status === "RUNNING");

  return (
    <div className="flex h-full flex-col">
      <TopBar project={p} latestRunId={latestOk?.id} />
      <div className="flex min-h-0 flex-1 gap-4 overflow-auto p-4">
        <section className="panel w-[380px] shrink-0 self-start p-4">
          <h2 className="mb-1 text-[15px] font-bold text-brand">A/B/C 분석 조건</h2>
          <div className="mb-3 text-[11.5px] text-ink-2">기준안 A(잠금) vs 변경안 B (rev {scB?.revision}, 변경 주동 {nChanged}개). 실행 시 입력이 불변 스냅샷으로 고정됩니다.</div>
          <div className="grid grid-cols-2 gap-2">
            <label className="fld col-span-2">분석 항목
              <select value={form.analysis_type} onChange={(e) => set("analysis_type", e.target.value)}>
                <option value="ALL">ALL — A 직사일조 + B 그림자 + C 이격</option>
                <option value="A">A — 직사일조시간</option>
                <option value="B">B — 그림자 변화</option>
                <option value="C">C — 건축물 이격거리</option>
              </select>
            </label>
            <label className="fld">분석일<input type="date" value={form.date} onChange={(e) => set("date", e.target.value)} /></label>
            <label className="fld">시간대 (고정)<input type="text" value={form.timezone} readOnly aria-readonly title="3D 시간 슬라이더와 동일 순간을 쓰기 위해 Asia/Seoul(KST, UTC+9)로 고정" /></label>
            <label className="fld">시작 (KST)<input type="time" value={form.start} onChange={(e) => set("start", e.target.value)} /></label>
            <label className="fld">종료 (KST)<input type="time" value={form.end} onChange={(e) => set("end", e.target.value)} /></label>
            <label className="fld">샘플 간격 (분)<input type="number" min={1} max={60} value={form.interval_min} onChange={(e) => set("interval_min", Number(e.target.value))} /></label>
            <label className="fld">그림자 격자 (m)<input type="number" min={1} max={10} step={0.5} value={form.grid_spacing_m} onChange={(e) => set("grid_spacing_m", Number(e.target.value))} /></label>
          </div>
          <label className="mt-2 flex items-center gap-2 text-[12px]"><input type="checkbox" checked={form.include_sensitivity} onChange={(e) => set("include_sensitivity", e.target.checked)} />민감도 시험 포함 (Δt=1분, 가상 지반 ±1/±3 m, 미세 이동)</label>
          <label className="mt-1 flex items-center gap-2 text-[12px]"><input type="checkbox" checked={form.reuse_cache} onChange={(e) => set("reuse_cache", e.target.checked)} />동일 입력이면 기존 결과 재사용 (cache key)</label>
          <div className="mt-2 rounded bg-stone-50 p-2 text-[11px] text-ink-2">
            기본 분석일 2026-12-22(동지)는 한국천문연구원 2026 월력요항 기준입니다. 격자 간격은 샘플링 간격일 뿐 30 m DEM의 정확도가 아닙니다. 직사일조는 기하학적 직사일조 가능 시간입니다.
          </div>
          <button className="btn btn-primary mt-3 w-full justify-center py-2" disabled={!!running} onClick={start} data-testid="run-analysis">
            {running ? "계산 중…" : "분석 실행"}
          </button>
          {msg && <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-[11.5px] text-amber-900" role="status">{msg}</div>}
          <div className="mt-3"><DataBadges b={p.data_badges} /></div>
        </section>

        <section className="flex min-w-0 flex-1 flex-col gap-4">
          <Disclaimer />
          {cur && (
            <div className="panel p-4" data-testid="run-status">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-[14px] font-bold">실행 <span className="font-mono">{cur.id}</span> — <StatusText s={cur.status} /></div>
                <div className="text-[11px] text-muted">작업 백엔드: <b>{cur.job_backend || "-"}</b>{cur.job_id ? ` · job ${cur.job_id.slice(0, 8)}` : ""}</div>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded bg-stone-200" role="progressbar" aria-valuenow={cur.progress} aria-valuemin={0} aria-valuemax={100}>
                <div className={`h-full ${cur.status === "FAILED" ? "bg-red-600" : "bg-brand-2"} transition-all`} style={{ width: `${cur.status === "SUCCEEDED" ? 100 : cur.progress}%` }} />
              </div>
              <div className="mt-1 text-[12px] text-ink-2">{cur.progress.toFixed(0)}% · {cur.stage}{cur.processing_seconds ? ` · ${cur.processing_seconds}s` : ""}</div>
              {cur.error && <div className="mt-2 rounded bg-red-50 p-2 font-mono text-[11px] text-red-800">{cur.error}</div>}
              <div className="mt-2 max-h-[180px] overflow-auto rounded bg-stone-900 p-2 font-mono text-[11px] text-stone-200">
                {cur.logs.map((l, i) => <div key={i}>{l.elapsed_s !== undefined ? `[${l.elapsed_s.toFixed(1)}s ${l.pct ?? ""}%] ` : ""}{l.stage}: {l.msg.length > 300 ? l.msg.slice(-300) : l.msg}</div>)}
              </div>
              {cur.status === "SUCCEEDED" && (
                <div className="mt-3 flex gap-2">
                  <button className="btn btn-primary" onClick={() => nav(`/projects/${id}/compare/${cur.id}`)} data-testid="open-compare">결과 비교 화면</button>
                  <button className="btn" onClick={() => nav(`/reports/${cur.id}`)}>보고서 생성/열기</button>
                </div>
              )}
            </div>
          )}
          {results && <ResultKpis r={results} />}
          <div className="panel p-4">
            <h3 className="mb-2 text-[13px] font-bold">분석 이력 (새로고침·서버 재시작 후에도 유지)</h3>
            <div className="max-h-[320px] overflow-auto">
              <table className="tbl">
                <thead><tr><th>Run</th><th>항목</th><th>상태</th><th>분석일·간격</th><th className="num">처리(s)</th><th>QA</th><th>생성</th><th /></tr></thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} className={cur?.id === r.id ? "sel" : ""}>
                      <td className="font-mono"><button className="underline" onClick={() => setCur(r)}>{r.id}</button></td>
                      <td>{r.analysis_type}</td><td><StatusText s={r.status} /></td>
                      <td>{r.params.date} · {r.params.interval_min}분 · {r.params.grid_spacing_m}m</td>

                      <td className="num">{r.processing_seconds ?? "-"}</td>
                      <td>{r.quality_overview ? `${r.quality_overview.n_pass}✓ ${r.quality_overview.n_fail}✗` : "-"}</td>
                      <td>{new Date(r.created_at).toLocaleString("ko-KR")}</td>
                      <td>{r.status === "SUCCEEDED" && <Link className="underline" to={`/projects/${id}/compare/${r.id}`}>결과</Link>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function StatusText({ s }: { s: string }) {
  const c = s === "SUCCEEDED" ? "text-emerald-700" : s === "FAILED" ? "text-red-700" : s === "RUNNING" ? "text-blue-700" : "text-ink-2";
  return <b className={c}>{s}</b>;
}

function ResultKpis({ r }: { r: any }) {
  const s = r.summary;
  return (
    <div className="grid grid-cols-3 gap-2 xl:grid-cols-6">
      {s.A && <Kpi label="A. 일조 감소 수광점" value={s.A.n_decreased.toLocaleString()} sub={`비교 ${s.A.n_common.toLocaleString()} · 증가 ${s.A.n_increased}`} tone="neg" />}
      {s.A && <Kpi label="A. 최대 감소" value={`${s.A.delta_total_min_min}분`} sub={`평균 ${s.A.mean_total_min_a} → ${s.A.mean_total_min_b}분`} tone="neg" />}
      {s.B && <Kpi label="B. 최대 신규 음영" value={`${Math.round(s.B.max_new_shade_area_m2).toLocaleString()} m²`} sub={`${s.B.max_new_shade_time} KST`} tone="neg" />}
      {s.B && <Kpi label="B. 음영 증가 면적" value={`${Math.round(s.B.area_more_shade_m2).toLocaleString()} m²`} sub={`감소 ${Math.round(s.B.area_less_shade_m2).toLocaleString()} m²`} />}
      {s.C?.min_pair_a && <Kpi label="C. 최소 이격 A→B" value={`${s.C.min_pair_a.distance_m.toFixed(1)}→${s.C.min_pair_b.distance_m.toFixed(1)} m`} sub={s.C.min_pair_b.pair_id.replace("|", "↔")} />}
      <Kpi label="자동 QA" value={`${r.quality.n_pass}✓ / ${r.quality.n_fail}✗`} sub={r.quality.critical_fail.length ? `치명: ${r.quality.critical_fail.join(", ")}` : "치명 실패 없음"} tone={r.quality.critical_fail.length ? "neg" : "pos"} />
    </div>
  );
}
