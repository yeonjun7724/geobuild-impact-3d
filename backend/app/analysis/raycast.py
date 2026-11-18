"""Ray casting engines behind one interface.

* Open3DEngine - primary: open3d.t.geometry.RaycastingScene (BVH, float32).
* NumpyEngine  - independent Möller–Trumbore implementation (float64, brute force). Slow; used by tests and
                 by the in-run QA to cross-check Open3D on a subset of rays.

Each added mesh gets a geometry id that maps back to an object label (building id / "TERRAIN") so the
blocking object of an occluded ray can be reported.
"""
from __future__ import annotations

from typing import Protocol

import numpy as np

INVALID = -1


class Engine(Protocol):
    name: str

    def add_mesh(self, label: str, vertices: np.ndarray, triangles: np.ndarray) -> None: ...

    def first_hit(self, origins: np.ndarray, dirs: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Return (t_hit [inf if none], label_index [-1 if none]) for each ray."""
        ...

    @property
    def labels(self) -> list[str]: ...


class Open3DEngine:
    name = "open3d.t.geometry.RaycastingScene"

    def __init__(self):
        import open3d as o3d

        self._o3d = o3d
        self._scene = o3d.t.geometry.RaycastingScene()
        self._labels: list[str] = []
        self._gid_to_label: dict[int, int] = {}

    @property
    def labels(self) -> list[str]:
        return self._labels

    def add_mesh(self, label, vertices, triangles):
        o3d = self._o3d
        v = o3d.core.Tensor(np.ascontiguousarray(vertices, dtype=np.float32))
        t = o3d.core.Tensor(np.ascontiguousarray(triangles, dtype=np.uint32))
        gid = int(self._scene.add_triangles(v, t))
        self._labels.append(label)
        self._gid_to_label[gid] = len(self._labels) - 1

    def first_hit(self, origins, dirs, batch: int = 2_000_000):
        o3d = self._o3d
        n = len(origins)
        t_out = np.full(n, np.inf, dtype=np.float64)
        lab_out = np.full(n, INVALID, dtype=np.int32)
        lut = np.full(max(self._gid_to_label.keys(), default=0) + 2, INVALID, dtype=np.int32)
        for g, li in self._gid_to_label.items():
            lut[g] = li
        for s in range(0, n, batch):
            rays = np.hstack([origins[s:s + batch], dirs[s:s + batch]]).astype(np.float32)
            ans = self._scene.cast_rays(o3d.core.Tensor(rays))
            t = ans["t_hit"].numpy().astype(np.float64)
            gid = ans["geometry_ids"].numpy().astype(np.int64)
            hit = np.isfinite(t)
            t_out[s:s + batch] = t
            g = np.where(hit, gid, len(lut) - 1)
            g = np.clip(g, 0, len(lut) - 1)
            lab_out[s:s + batch] = np.where(hit, lut[g], INVALID)
        return t_out, lab_out


class NumpyEngine:
    name = "numpy Möller–Trumbore (reference)"

    def __init__(self):
        self._tris: list[np.ndarray] = []
        self._tri_label: list[np.ndarray] = []
        self._labels: list[str] = []

    @property
    def labels(self) -> list[str]:
        return self._labels

    def add_mesh(self, label, vertices, triangles):
        v = np.asarray(vertices, dtype=np.float64)
        self._tris.append(v[np.asarray(triangles)])
        self._labels.append(label)
        self._tri_label.append(np.full(len(triangles), len(self._labels) - 1, dtype=np.int32))

    def first_hit(self, origins, dirs, chunk: int = 256):
        T = np.concatenate(self._tris)  # (M,3,3)
        L = np.concatenate(self._tri_label)
        v0, e1, e2 = T[:, 0], T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]
        n = len(origins)
        t_out = np.full(n, np.inf)
        lab_out = np.full(n, INVALID, dtype=np.int32)
        eps = 1e-12
        for s in range(0, n, chunk):
            o = origins[s:s + chunk][:, None, :]
            d = dirs[s:s + chunk][:, None, :]
            p = np.cross(d, e2[None])
            det = np.einsum("ijk,jk->ij", p, e1)
            ok = np.abs(det) > eps
            inv = np.where(ok, 1.0 / np.where(ok, det, 1.0), 0.0)
            tv = o - v0[None]
            u = np.einsum("ijk,ijk->ij", tv, p) * inv
            q = np.cross(tv, e1[None])
            v = np.einsum("ijk,ijk->ij", d, q) * inv
            t = np.einsum("jk,ijk->ij", e2, q) * inv
            hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-9)
            t = np.where(hit, t, np.inf)
            j = np.argmin(t, axis=1)
            tm = t[np.arange(len(j)), j]
            t_out[s:s + chunk] = tm
            lab_out[s:s + chunk] = np.where(np.isfinite(tm), L[j], INVALID)
        return t_out, lab_out


def make_engine(prefer: str = "open3d") -> Engine:
    if prefer == "open3d":
        try:
            return Open3DEngine()
        except ImportError:
            pass
    return NumpyEngine()


def self_offset(scene_extent_m: float) -> float:
    """Ray-origin offset along the surface normal, scaled with the model size (float32 BVH precision)."""
    return max(0.02, 2e-5 * scene_extent_m)
