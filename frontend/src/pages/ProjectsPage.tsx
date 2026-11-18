import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowRight, BarChart3, Building2, FileText, Gavel, PencilRuler, Plus, Scale, Trash2, X } from "lucide-react";
import { api, type Project } from "../api";
import { DataBadges, Disclaimer, ErrorBox, Loading, TopBar } from "../components/Chrome";
import { Spinner } from "../ui";

export default function ProjectsPage() {
  const [list, setList] = useState<Project[] | null>(null);
  const [del, setDel] = useState<Project | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("인천계양 A2 인근 가상단지 · 설계변경 요청 검토");
  const [health, setHealth] = useState<any>(null);
  const nav = useNavigate();
  useEffect(() => {
    api.projects().then(setList).catch((e) => setErr(e.message));
    api.health().then(setHealth).catch(() => setHealth({ status: "down" }));
  }, []);
  const create = async () => {
    setBusy(true);
    setErr(null);
    try { const p = await api.createProject(name); nav(`/projects/${p.id}`); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <main className="flex-1 overflow-auto">
        <section className="relative overflow-hidden border-b border-line">
          <div className="pointer-events-none absolute inset-0 opacity-60" style={{ background: "radial-gradient(900px 380px at 15% -10%, #1e4f9a55, transparent 60%), radial-gradient(700px 300px at 90% 0%, #ff8a3d22, transparent 60%)" }} />
          <div className="relative mx-auto grid max-w-6xl gap-8 px-6 py-10 lg:grid-cols-[1.25fr_1fr]">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-[11.5px] font-semibold text-accent">LH 공동주택 설계변경 검토 지원</div>
              <h1 className="text-[34px] font-extrabold leading-[1.15] tracking-tight text-white">설계변경 요청, 승인해도 될까?<br /><span className="bg-gradient-to-r from-[#6cb2ff] to-[#ffb27a] bg-clip-text text-transparent">근거를 계산해서</span> 답합니다</h1>
              <p className="mt-3 max-w-xl text-[14px] leading-relaxed text-ink-2">설계사가 동 위치·층수 변경을 요청하면, 변경안(B)을 기존안(A)과 같은 조건(동지 08–16시)으로 계산합니다. 그 결과 <b className="text-ink">어느 동 몇 층이 일조 기준선 아래로 떨어지는지</b>, 놀이터 그늘과 동간거리가 어떻게 바뀌는지를 <b className="text-ink">검토 판정</b>과 보고서로 정리합니다.</p>
              <div className="mt-5 grid max-w-xl grid-cols-3 gap-2.5">
                {[[<PencilRuler size={16} key="a" />, "① 변경안 입력", "요청된 동 이동·회전·층수를 3D에 반영"], [<Scale size={16} key="b" />, "② 전후 비교 계산", "일조 · 그림자 · 동간거리를 같은 조건으로"], [<Gavel size={16} key="c" />, "③ 판정 · 보고서", "보완 요청 / 확인 필요 / 특이사항 없음"]].map(([i, t, s]) => (
                  <div key={t as string} className="card-2 p-3"><div className="mb-1 text-accent">{i}</div><div className="text-[12.5px] font-bold">{t}</div><div className="text-[11px] text-muted">{s}</div></div>
                ))}
              </div>
            </div>
            <div className="glass self-center p-5">
              <div className="mb-1 flex items-center gap-2 text-[14px] font-bold"><Plus size={16} className="text-accent" />새 검토 시작</div>
              <p className="mb-3 text-[12px] leading-relaxed text-ink-2">예시 단지(인천계양 A2 주변, 가상 주동 7개)를 불러옵니다. 다음 화면에서 <b className="text-ink">요청된 변경 내용</b>을 B안에 입력하면 됩니다. 지형은 <b className="text-ink">합성 30 m DEM</b>이며 [데이터]에서 실제 DEM으로 바꿀 수 있습니다.</p>
              <input aria-label="프로젝트명" type="text" className="mb-2 w-full" value={name} onChange={(e) => setName(e.target.value)} />
              <button className="btn btn-primary w-full !h-10" disabled={busy || !name.trim()} onClick={create} data-testid="create-project">
                {busy ? <><Spinner />생성 중…</> : <>검토 시작 (예시 단지 불러오기)<ArrowRight size={15} /></>}
              </button>
              <SystemStatus h={health} />
            </div>
          </div>
        </section>
        <section className="mx-auto max-w-6xl px-6 py-7">
          <Disclaimer className="mb-5" />
          {err && <ErrorBox msg={err} />}
          <div className="mb-3 flex items-baseline justify-between"><h2 className="text-[16px] font-bold">검토 건</h2><span className="text-[12px] text-muted">{list?.length ?? 0}개</span></div>
          {!list ? <Loading /> : list.length === 0 ? (
            <div className="card p-10 text-center text-ink-2">아직 검토 건이 없습니다. 위에서 새 검토를 시작하세요.</div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {list.map((p) => <ProjectCard key={p.id} p={p} onDelete={() => setDel(p)} />)}
            </div>
          )}
        </section>
      </main>
      {del && <DeleteDialog p={del} onClose={() => setDel(null)} onDeleted={(id) => { setDel(null); setList((l) => (l ?? []).filter((x) => x.id !== id)); }} />}
    </div>
  );
}

function ProjectCard({ p, onDelete }: { p: Project; onDelete: () => void }) {
  const run = p.latest_run;
  const ok = run?.status === "SUCCEEDED";
  return (
    <div className="card group overflow-hidden transition hover:border-accent/50">
      <Link to={ok ? `/projects/${p.id}/compare/${run!.id}` : `/projects/${p.id}`} className="relative block h-40 overflow-hidden bg-[#0a1322]">
        {p.thumbnail ? <img src={p.thumbnail.url} alt="3D 장면 미리보기" className="h-full w-full object-cover opacity-90 transition group-hover:scale-[1.03] group-hover:opacity-100" loading="lazy" />
          : <div className="flex h-full items-center justify-center text-muted"><Building2 size={36} /></div>}
        <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[#0b1424] to-transparent" />
        <span className={`chip absolute left-2.5 top-2.5 !bg-[#0b1424]/85 backdrop-blur ${ok ? "chip-ok" : run?.status === "FAILED" ? "chip-bad" : ""}`}>{run ? `${run.status === "SUCCEEDED" ? "분석 완료" : run.status} · ${run.analysis_type}` : "분석 전"}</span>
      </Link>
      <div className="p-3.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 truncate text-[13.5px] font-bold" title={p.name}>{p.name}</div>
          <button className="btn btn-sm btn-icon btn-ghost -mr-1 -mt-1 text-muted hover:!text-bad" onClick={onDelete} title="검토 건 삭제"
            aria-label={`검토 건 삭제: ${p.name}`} data-testid="delete-project"><Trash2 size={14} /></button>
        </div>
        <div className="mb-2 text-[11px] text-muted">{new Date(p.created_at).toLocaleString("ko-KR")} · {p.id}</div>
        <DataBadges b={p.data_badges} />
        <div className="mt-3 flex gap-1.5">
          <Link to={`/projects/${p.id}`} className="btn btn-sm flex-1"><Building2 size={12} />변경안 입력</Link>
          {ok ? <Link to={`/projects/${p.id}/compare/${run!.id}`} className="btn btn-sm flex-1"><BarChart3 size={12} />검토 판정</Link> : <Link to={`/projects/${p.id}/analysis`} className="btn btn-sm flex-1">분석 실행</Link>}
          {ok && <Link to={`/reports/${run!.id}`} className="btn btn-sm flex-1"><FileText size={12} />보고서</Link>}
        </div>
      </div>
    </div>
  );
}

function SystemStatus({ h }: { h: any }) {
  if (!h) return <div className="mt-3 text-[11px] text-muted">시스템 상태 확인 중…</div>;
  if (h.status === "down") return <div className="mt-3"><span className="chip chip-bad">API 연결 실패</span></div>;
  const r = h.redis ?? {};
  return (
    <div className="mt-3 flex flex-wrap gap-1.5" data-testid="system-status">
      <span className="chip chip-ok"><span className="live-dot !h-1.5 !w-1.5" />API {h.engine_version}</span>
      <span className={`chip ${r.ok ? "chip-ok" : "chip-syn"}`}>{h.job_backend === "rq" ? `작업큐 Redis · worker ${r.workers ?? 0}` : "작업큐 로컬 스레드"}</span>
      <span className={`chip ${h.chromium?.ok ? "chip-ok" : "chip-bad"}`}>PDF {h.chromium?.ok ? "Chromium OK" : "Chromium 없음"}</span>
    </div>
  );
}

function DeleteDialog({ p, onClose, onDeleted }: { p: Project; onClose: () => void; onDeleted: (id: string) => void }) {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.deletePreview>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.deletePreview(p.id).then(setInfo).catch((e) => setErr(e.message)); }, [p.id]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [busy, onClose]);
  const go = async () => {
    setBusy(true);
    setErr(null);
    try { await api.deleteProject(p.id); onDeleted(p.id); } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  const blocked = !!info?.active_jobs.length;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="del-title" onClick={() => !busy && onClose()}>
      <div className="glass rise w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bad/15 text-bad"><Trash2 size={17} /></div>
          <div className="min-w-0 flex-1">
            <h3 id="del-title" className="text-[15px] font-bold text-white">검토 건을 삭제할까요?</h3>
            <div className="truncate text-[12.5px] text-ink-2" title={p.name}>{p.name}</div>
            <div className="font-mono text-[10.5px] text-muted">{p.id}</div>
          </div>
          <button className="btn btn-sm btn-icon btn-ghost" onClick={onClose} disabled={busy} aria-label="닫기"><X size={15} /></button>
        </div>
        <div className="card-2 mb-3 p-3 text-[12.5px] text-ink-2">
          {!info ? (err ? null : <div className="flex items-center gap-2"><Spinner />삭제 범위 확인 중…</div>) : (
            <ul className="space-y-1">
              <li>분석 실행 <b className="text-ink">{info.n_runs}건</b>과 결과 파일(CSV·GeoJSON·격자)</li>
              <li>보고서 <b className="text-ink">{info.n_reports}건</b> (PDF·HTML·증거 ZIP)</li>
              <li>업로드·생성 데이터 <b className="text-ink">{info.n_datasets}건</b> (DEM·건물·도면)</li>
              <li>설계안 A/B, 검토 판정, 출처 기록 · 디스크 약 <b className="text-ink">{(info.bytes / 1048576).toFixed(1)} MB</b></li>
            </ul>
          )}
        </div>
        <div className="mb-4 flex gap-2 text-[12px] text-[#ffb4b4]"><AlertTriangle size={14} className="mt-0.5 shrink-0" />삭제하면 되돌릴 수 없습니다. 이미 내려받은 PDF·ZIP 파일은 남지만, 이 앱에서는 다시 열 수 없습니다.</div>
        {blocked && <div className="mb-3 rounded-lg bg-warn/10 p-2 text-[12px] text-[#f3d9a0]">실행 중인 작업이 있어 지금은 삭제할 수 없습니다 ({info!.active_jobs.join(", ")}). 끝난 뒤 다시 시도하세요.</div>}
        {err && <div className="mb-3 rounded-lg bg-bad/10 p-2 text-[12px] text-[#ffb4b4]">{err}</div>}
        <div className="flex justify-end gap-2">
          <button className="btn" onClick={onClose} disabled={busy}>취소</button>
          <button className="btn !border-bad/60 !bg-bad/90 !text-white hover:!bg-bad" onClick={go} disabled={busy || !info || blocked} data-testid="confirm-delete">
            {busy ? <><Spinner />삭제 중…</> : <><Trash2 size={14} />영구 삭제</>}
          </button>
        </div>
      </div>
    </div>
  );
}
