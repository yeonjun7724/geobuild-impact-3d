/* API client. All analysis numbers come from the backend; the UI never computes report values. */

export type Transform = { dx: number; dy: number; rot_deg: number; floors_delta: number };
export type Scenario = { id: string; code: "A" | "B"; name: string; locked: boolean; revision: number; content_hash: string; transforms: Record<string, Transform> };
export type Badges = {
  location: { class: string; label: string; approximate: boolean; boundary_verified: boolean };
  terrain: null | { class: string; label: string; native_cell_m: number; vertical_datum: string; vertical_datum_status: string; surface_type: string; sha256: string; acquired: string | null; license: string | null };
  ground: null | { class: string; label: string; pad_z: number; assumption: string; qa: Record<string, unknown> };
  buildings: { classes: string[]; label: string };
  mode: "DEMO" | "UPLOADED";
  disclaimer: string;
};
export type Project = {
  id: string; name: string; status: string; site_meta: Record<string, any>; frame: { lat0: number; lon0: number; h0: number };
  site_rect: number[]; created_at: string; data_badges: Badges; scenarios: Scenario[]; latest_run: null | { id: string; status: string; analysis_type: string; created_at: string };
  thumbnail?: null | { url: string; run_id: string; report_id: string };
};
export type SceneBuilding = {
  id: string; name: string; kind: "MAIN" | "CONTEXT"; data_class: string; footprint: number[][]; footprint_baseline: number[][];
  floors: number; height_m: number; base_z: number; top_z: number; transform: Transform; centroid: number[]; footprint_area_m2: number;
  warnings: string[]; n_receivers?: number; mesh: { vertices: number[]; indices: number[] };
};
export type SceneResp = {
  scenario: Scenario; frame: Project["frame"]; model_matrix: number[]; pad_z: number; site_rect: number[];
  site_boundary: number[][]; open_spaces: { id: string; name: string; kind: string; polygon: number[][] }[]; buildings: SceneBuilding[];
};
export type GroundMesh = { vertices_f32_b64: string; indices_u32_b64: string; n_vertices: number; n_triangles: number; pad_z: number; z_min: number; z_max: number; terrain_class: string };
export type Run = {
  id: string; project_id: string; analysis_type: string; status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED"; stage: string; progress: number;
  logs: { t?: string; elapsed_s?: number; pct?: number; stage: string; msg: string }[]; error: string | null; params: Record<string, any>; cache_key: string;
  job_backend: string; job_id: string | null; processing_seconds: number | null; created_at: string; finished_at: string | null; reused: boolean;
  quality_overview: null | { n_pass: number; n_fail: number; critical_fail: string[]; verification_status: string };
};
export type ReportT = { id: string; run_id: string; status: string; stage: string; error: string | null; version: string; files: Record<string, any>; quality: Record<string, any>; created_at: string; finished_at: string | null };

export type Preview = { rule: string; elapsed_s: number; changed: string[];
  A: { n_decreased: number; n_increased: number; n_common: number; mean_total_min_a: number; mean_total_min_b: number; delta_total_min_min: number; worst: string | null; per_building_mean_delta: Record<string, number> };
  B: { snapshots: { time: string; new_shade_m2: number; relieved_m2: number }[]; max_new_shade_m2: number };
  C: { min_pair_a: null | { pair_id: string; distance_m: number }; min_pair_b: null | { pair_id: string; distance_m: number }; n_worsened: number; worst: any; warnings: string[] } };
export type SunCurve = { time: string[]; utc: string[]; az: number[]; el: number[] };
export type SunPathData = { date: string; day: SunCurve; sunrise_approx: string | null; sunset_approx: string | null; noon_elevation_max: number; reference: Record<string, SunCurve> };

async function req<T>(method: string, url: string, body?: unknown, form?: FormData): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: form ? undefined : body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const j = await r.json();
      msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
    } catch { /* not json */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

export const api = {
  health: () => req<any>("GET", "/api/health"),
  projects: () => req<Project[]>("GET", "/api/projects"),
  project: (id: string) => req<Project>("GET", `/api/projects/${id}`),
  createProject: (name: string) => req<Project>("POST", "/api/projects", { name, seed_demo: true }),
  provenance: (id: string) => req<any[]>("GET", `/api/projects/${id}/provenance`),
  datasets: (id: string) => req<any[]>("GET", `/api/projects/${id}/datasets`),
  uploadTerrain: (id: string, f: File, vd: string, acquired: string, license: string) => {
    const fd = new FormData();
    fd.append("file", f);
    if (vd) fd.append("vertical_datum", vd);
    if (acquired) fd.append("acquired", acquired);
    if (license) fd.append("license", license);
    return req<any>("POST", `/api/projects/${id}/datasets/terrain`, undefined, fd);
  },
  activateTerrain: (id: string, ds: string) => req<any>("POST", `/api/projects/${id}/datasets/terrain/activate/${ds}`),
  uploadBuildings: (id: string, f: File) => {
    const fd = new FormData();
    fd.append("file", f);
    return req<any>("POST", `/api/projects/${id}/datasets/buildings`, undefined, fd);
  },
  scene: (id: string, code: "A" | "B") => req<SceneResp>("GET", `/api/projects/${id}/scene?scenario=${code}`),
  ground: (id: string) => req<GroundMesh>("GET", `/api/projects/${id}/ground-mesh`),
  patchBuilding: (sid: string, bid: string, t: Partial<Transform>) => req<Scenario & { warnings: string[] }>("PATCH", `/api/scenarios/${sid}/buildings/${bid}`, t),
  resetB: (id: string) => req<Scenario>("POST", `/api/projects/${id}/scenarios`, { code: "B", name: "변경안 B (가상 설계변경)", copy_from: "A" }),
  startAnalysis: (id: string, body: Record<string, unknown>) => req<Run>("POST", `/api/projects/${id}/analyses`, body),
  runs: (id: string) => req<Run[]>("GET", `/api/projects/${id}/analyses`),
  run: (rid: string) => req<Run>("GET", `/api/analyses/${rid}`),
  results: (rid: string) => req<{ run: Run; summary: any; quality: any; files: { name: string; size: number; url: string }[]; insights: { exec: string[]; recs: { level: string; target: string; basis: string; cause: string }[] } }>("GET", `/api/analyses/${rid}/results`),
  preview: (id: string, transforms: Record<string, Transform> | null, date: string) => req<Preview>("POST", `/api/projects/${id}/preview`, { transforms, date }),
  terrainGrid: (id: string) => req<any>("GET", `/api/projects/${id}/terrain-grid`),
  runTerrainGrid: (rid: string) => req<any>("GET", `/api/analyses/${rid}/terrain-grid`),
  runGround: (rid: string) => req<GroundMesh>("GET", `/api/analyses/${rid}/ground-mesh`),
  sun: (date: string, lat: number, lon: number) => req<SunPathData>("GET", `/api/sun?date=${date}&lat=${lat}&lon=${lon}`),
  shadowTimeline: (rid: string) => req<{ n_cells: number; times_local: string[]; times_utc: string[]; bytes_per_time: number; shade_a_b64: string; shade_b_b64: string }>("GET", `/api/analyses/${rid}/shadow/timeline`),
  runScene: (rid: string) => req<{ model_matrix: number[]; pad_z: number; site: any; scenarios: Record<"A" | "B", SceneBuilding[]> }>("GET", `/api/analyses/${rid}/scene`),
  sunlight: (rid: string) => req<{ summary: any; receivers: any[]; sun: any }>("GET", `/api/analyses/${rid}/sunlight`),
  receiver: (rid: string, rec: string) => req<any>("GET", `/api/analyses/${rid}/sunlight/receivers/${encodeURIComponent(rec)}`),
  shadow: (rid: string) => req<any>("GET", `/api/analyses/${rid}/shadow`),
  shadowCell: (rid: string, x: number, y: number) => req<any>("GET", `/api/analyses/${rid}/shadow/cell?x=${x}&y=${y}`),
  clearance: (rid: string) => req<any>("GET", `/api/analyses/${rid}/clearance`),
  createReport: (rid: string) => req<ReportT>("POST", `/api/analyses/${rid}/reports`),
  reports: (rid: string) => req<ReportT[]>("GET", `/api/analyses/${rid}/reports`),
  report: (id: string) => req<ReportT>("GET", `/api/reports/${id}`),
};

export function b64ToF32(b64: string): Float32Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float32Array(u8.buffer);
}
export function b64ToU8(b64: string): Uint8Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
export function b64ToU32(b64: string): Uint32Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Uint32Array(u8.buffer);
}

/** KST wall time -> UTC ISO (identical rule to the backend: Asia/Seoul has no DST, UTC+9). */
export function kstToUtcIso(date: string, hhmm: string): string {
  return new Date(`${date}T${hhmm}:00+09:00`).toISOString();
}

export function toCsv(rows: Record<string, unknown>[], meta: string[]): string {
  if (!rows.length) return meta.map((m) => `# ${m}`).join("\n");
  const keys = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + meta.map((m) => `# ${m}`).join("\n") + "\n" + keys.join(",") + "\n" + rows.map((r) => keys.map((k) => esc(r[k])).join(",")).join("\n");
}

export function downloadText(name: string, text: string, mime = "text/csv;charset=utf-8") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
