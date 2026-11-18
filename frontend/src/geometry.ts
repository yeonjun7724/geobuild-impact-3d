/* Client-side geometry mirroring backend rules (scene/geometry.py) for instant drag feedback.
   Footprints are ENU metre rings. Display only - authoritative numbers always come from the server. */
import type { SceneBuilding, Transform } from "./api";

export type Pt = [number, number];
export const FLOOR_H = 2.9;
export const PARAPET = 1.2;

export function ringOpen(fp: number[][]): Pt[] {
  const r = fp.map((p) => [p[0], p[1]] as Pt);
  const a = r[0], b = r[r.length - 1];
  return a[0] === b[0] && a[1] === b[1] ? r.slice(0, -1) : r;
}

export function centroid(ring: Pt[]): Pt {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-9) return [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
  return [cx / (3 * a), cy / (3 * a)];
}

/** Same rule as backend transform_footprint: rotate CCW about the baseline centroid, then translate. */
export function transformRing(baseline: Pt[], t: Transform): Pt[] {
  const [cx, cy] = centroid(baseline);
  const r = (t.rot_deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return baseline.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s + t.dx, cy + (x - cx) * s + (y - cy) * c + t.dy] as Pt);
}

function earClip(pts: Pt[]): number[] {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) area += pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1];
  const idx = [...Array(n).keys()];
  if (area < 0) idx.reverse();
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const out: number[] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 5000) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
      const a = pts[i0], b = pts[i1], c = pts[i2];
      if (cross(a, b, c) <= 1e-12) continue;
      if (idx.some((j) => j !== i0 && j !== i1 && j !== i2 && cross(a, b, pts[j]) >= 0 && cross(b, c, pts[j]) >= 0 && cross(c, a, pts[j]) >= 0)) continue;
      out.push(i0, i1, i2);
      idx.splice(k, 1);
      cut = true;
      break;
    }
    if (!cut) break;
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

/** Closed prism mesh (same layout as backend extrude) for a ring at [z0, z1]. */
export function extrude(ring: Pt[], z0: number, z1: number): { vertices: number[]; indices: number[] } {
  let area = 0;
  for (let i = 0; i < ring.length; i++) area += ring[i][0] * ring[(i + 1) % ring.length][1] - ring[(i + 1) % ring.length][0] * ring[i][1];
  const r = area < 0 ? [...ring].reverse() : ring;
  const n = r.length;
  const vertices: number[] = [];
  for (const [x, y] of r) vertices.push(x, y, z0);
  for (const [x, y] of r) vertices.push(x, y, z1);
  const indices: number[] = [];
  const tri = earClip(r);
  for (let k = 0; k < tri.length; k += 3) {
    indices.push(n + tri[k], n + tri[k + 1], n + tri[k + 2]);
    indices.push(tri[k], tri[k + 2], tri[k + 1]);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(i, j, n + j, i, n + j, n + i);
  }
  return { vertices, indices };
}

/** Building as it would look with draft transform t (relative to its baseline). */
export function draftBuilding(b: SceneBuilding, t: Transform): SceneBuilding {
  const base = ringOpen(b.footprint_baseline);
  const ring = transformRing(base, t);
  const baseFloors = b.floors - (b.transform?.floors_delta ?? 0);
  const floors = Math.max(1, baseFloors + t.floors_delta);
  const height = floors * FLOOR_H + PARAPET;
  const c = centroid(ring);
  return { ...b, footprint: [...ring, ring[0]], floors, height_m: height, top_z: b.base_z + height, centroid: c, transform: t, mesh: extrude(ring, b.base_z, b.base_z + height) };
}

function segDist(p: Pt, a: Pt, b: Pt): { d: number; q: Pt } {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  const q: Pt = [a[0] + t * dx, a[1] + t * dy];
  return { d: Math.hypot(p[0] - q[0], p[1] - q[1]), q };
}

function inside(p: Pt, ring: Pt[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function segIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

/** Shortest horizontal distance between two rings + nearest points; 0 when touching/overlapping. */
export function ringDistance(A: Pt[], B: Pt[]): { d: number; pa: Pt; pb: Pt; overlap: boolean } {
  for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++)
    if (segIntersect(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])) return { d: 0, pa: A[i], pb: A[i], overlap: true };
  if (inside(A[0], B) || inside(B[0], A)) return { d: 0, pa: A[0], pb: A[0], overlap: true };
  let best = { d: Infinity, pa: A[0], pb: B[0], overlap: false };
  for (const [P, Q, swap] of [[A, B, false], [B, A, true]] as [Pt[], Pt[], boolean][]) {
    for (const p of P) for (let j = 0; j < Q.length; j++) {
      const r = segDist(p, Q[j], Q[(j + 1) % Q.length]);
      if (r.d < best.d) best = swap ? { d: r.d, pa: r.q, pb: p, overlap: false } : { d: r.d, pa: p, pb: r.q, overlap: false };
    }
  }
  return best;
}
