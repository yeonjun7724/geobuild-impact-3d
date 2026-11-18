import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Project } from "../api";
import { DataBadges, Disclaimer, ErrorBox, Loading, TopBar } from "../components/Chrome";

export default function ProjectsPage() {
  const [list, setList] = useState<Project[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("인천계양 A2 인근 가상단지 설계변경 검토");
  const [health, setHealth] = useState<any>(null);
  const nav = useNavigate();
  useEffect(() => {
    api.projects().then(setList).catch((e) => setErr(e.message));
    api.health().then(setHealth).catch(() => setHealth({ status: "down" }));
  }, []);
  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const p = await api.createProject(name);
      nav(`/projects/${p.id}`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <main className="mx-auto w-full max-w-6xl flex-1 overflow-auto p-6">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-[22px] font-bold text-brand">프로젝트</h1>
            <p className="text-ink-2">공동주택 설계변경 전후 직사일조(A) · 그림자 변화(B) · 이격거리(C) 분석과 기술보고서 생성</p>
          </div>
          <SystemStatus h={health} />
        </div>
        <Disclaimer className="mb-4" />
        <section className="panel mb-6 p-4">
          <h2 className="mb-2 text-[14px] font-bold">새 프로젝트 (가상 샘플 로드)</h2>
          <p className="mb-3 text-[12px] text-ink-2">
            인천계양 A2블록 LH 공고 대표점을 원점으로 가상 단지(주동 7개, 주변 참고건물 5개)와 <b>합성 30 m DEM</b>을 생성합니다. 실제 DEM·건물 footprint는 생성 후 [데이터] 탭에서 업로드할 수 있습니다.
          </p>
          <div className="flex gap-2">
            <input aria-label="프로젝트명" type="text" className="flex-1" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={create} data-testid="create-project">
              {busy ? "생성 중…" : "프로젝트 생성 + 가상 단지 로드"}
            </button>
          </div>
        </section>
        {err && <ErrorBox msg={err} />}
        {!list ? <Loading /> : list.length === 0 ? (
          <div className="panel p-8 text-center text-ink-2">프로젝트가 없습니다. 위에서 새 프로젝트를 생성하세요.</div>
        ) : (
          <div className="grid gap-3">
            {list.map((p) => (
              <Link key={p.id} to={`/projects/${p.id}`} className="panel block p-4 hover:border-brand-2">
                <div className="mb-1 flex items-center justify-between">
                  <div className="text-[15px] font-bold">{p.name}</div>
                  <div className="text-[11px] text-muted">{new Date(p.created_at).toLocaleString("ko-KR")} · {p.id}</div>
                </div>
                <div className="mb-2 text-[12px] text-ink-2">{p.site_meta.district}</div>
                <div className="flex flex-wrap items-center gap-3">
                  <DataBadges b={p.data_badges} compact />
                  {p.latest_run && (
                    <span className="text-[11.5px] text-ink-2">최근 분석: <b className={p.latest_run.status === "SUCCEEDED" ? "text-emerald-700" : p.latest_run.status === "FAILED" ? "text-red-700" : ""}>{p.latest_run.status}</b> ({p.latest_run.analysis_type})</span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function SystemStatus({ h }: { h: any }) {
  if (!h) return <span className="text-[11px] text-muted">시스템 상태 확인 중…</span>;
  if (h.status === "down") return <span className="badge text-red-700">API 연결 실패</span>;
  const r = h.redis ?? {};
  return (
    <div className="flex flex-wrap gap-1.5 text-[11px]" data-testid="system-status">
      <span className="badge text-emerald-700">API {h.engine_version}</span>
      <span className="badge text-stone-600">DB {h.database?.url_scheme}</span>
      <span className={`badge ${r.ok ? "text-emerald-700" : "text-amber-700"}`}>
        작업큐 {h.job_backend === "rq" ? `Redis(${r.provider ?? "-"}) ${r.ok ? "연결" : "실패"} · worker ${r.workers ?? 0}` : "스레드(로컬)"}
      </span>
      <span className={`badge ${h.chromium?.ok ? "text-emerald-700" : "text-red-700"}`}>PDF {h.chromium?.ok ? "Chromium OK" : "Chromium 없음"}</span>
    </div>
  );
}
