/* CesiumJS scene.
   - Ground: the analysis ground height field (same grid the ray caster meshes) is served to a
     CustomHeightmapTerrainProvider so basemaps drape over it; or the exact analysis mesh can be shown ("mesh" mode).
   - Buildings / facade tiles / overlays use the backend ENU geometry placed with the ENU->ECEF model matrix.
   - Display height = z − pad_z (uniform shift; relative geometry unchanged). Rendered shadows are a visual preview only. */
import { useEffect, useRef, useState } from "react";
import {
  BoundingSphere, Cartesian2, Cartesian3, Color, ColorGeometryInstanceAttribute, ComponentDatatype, CustomHeightmapTerrainProvider,
  EllipsoidTerrainProvider, Geometry, GeometryAttribute, GeometryInstance, GeometryPipeline, HorizontalOrigin, Ion, JulianDate, LabelCollection,
  LabelStyle, Material, MaterialAppearance, Math as CMath, Matrix4, NearFarScalar, OpenStreetMapImageryProvider, PerInstanceColorAppearance,
  PointPrimitiveCollection, PolylineCollection, Primitive, PrimitiveType, SceneTransforms, ShadowMode, VerticalOrigin, Viewer, defined,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { b64ToF32, b64ToU32, type GroundMesh, type SceneBuilding } from "../api";
import { FLOOR_H, ringOpen, type Pt } from "../geometry";

Ion.defaultAccessToken = ""; // no Cesium ion dependency

export type Basemap = "light" | "dark" | "osm" | "none";
export type BuildingLayer = { key: string; buildings: SceneBuilding[]; style: "solid" | "ghost"; color?: (b: SceneBuilding) => string; selected?: string | null; highlight?: Set<string> };
export type ReceiverPt = { id: string; x: number; y: number; z: number; nx: number; ny: number; color: string; w?: number };
export type GridImage = { url: string; x0: number; y0: number; x1: number; y1: number; z: number };
export type Line = { a: number[]; b: number[]; z: number; label?: string; color: string; width?: number };
export type Ring = { ring: number[][]; z: number; color: string; width?: number; label?: string };
export type TerrainGrid = { x0: number; y0: number; dx: number; dy: number; nx: number; ny: number; pad_z: number; z_f32_b64: string };
export type PickResult = { type: "building"; id: string; layer: string } | { type: "receiver"; id: string } | { type: "ground"; x: number; y: number; z: number };
export type EditConfig = { ids: Set<string>; centroids: Record<string, Pt>; onDrag: (id: string, d: { dx: number; dy: number; drot: number }, phase: "move" | "end") => void };

type Props = {
  modelMatrix: number[];
  padZ: number;
  ground?: GroundMesh | null;
  terrainGrid?: TerrainGrid | null;
  groundMode?: "terrain" | "mesh";
  basemap?: Basemap;
  layers: BuildingLayer[];
  timeUtc: string;
  shadows: boolean;
  floorLines?: boolean;
  labels?: boolean;
  facade?: ReceiverPt[];
  receivers?: ReceiverPt[];
  grid?: GridImage | null;
  lines?: Line[];
  rings?: Ring[];
  edit?: EditConfig | null;
  onPick?: (p: PickResult) => void;
  onViewer?: (v: Viewer | null) => void;
  onReady?: () => void;
  className?: string;
};

function geometryFrom(pos: Float64Array, nor: Float32Array, idx: Uint16Array | Uint32Array, st?: Float32Array): Geometry {
  const attributes: Record<string, GeometryAttribute> = {
    position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos }),
    normal: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: nor }),
  };
  if (st) attributes.st = new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: st });
  return new Geometry({ attributes: attributes as any, indices: idx, primitiveType: PrimitiveType.TRIANGLES, boundingSphere: BoundingSphere.fromVertices(Array.from(pos)) });
}

/** Un-indexed (flat shaded) prism geometry from an indexed mesh. */
function flatGeometry(verts: number[], idx: number[], dz: number): Geometry {
  const n = idx.length;
  const pos = new Float64Array(n * 3);
  const nor = new Float32Array(n * 3);
  for (let t = 0; t < n; t += 3) {
    const P = [idx[t], idx[t + 1], idx[t + 2]].map((k) => [verts[k * 3], verts[k * 3 + 1], verts[k * 3 + 2] + dz]);
    const [a, b, c] = P;
    let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
    for (let k = 0; k < 3; k++) {
      pos.set(P[k], (t + k) * 3);
      nor.set([nx, ny, nz], (t + k) * 3);
    }
  }
  const ind = n < 65535 ? new Uint16Array(n) : new Uint32Array(n);
  for (let i = 0; i < n; i++) ind[i] = i;
  return geometryFrom(pos, nor, ind);
}

/** Facade tile (one receiver = one window-band patch: patch width × floor height, slightly inset). */
function facadeTile(r: ReceiverPt, dz: number): Geometry {
  // normals arrive rounded (CSV): re-normalise, Cesium oct-encoding requires unit vectors
  const L = Math.hypot(r.nx, r.ny);
  const nx = L > 1e-6 ? r.nx / L : 0, ny = L > 1e-6 ? r.ny / L : -1;
  const w = (r.w ?? 7.5) * 0.92, tx = -ny, ty = nx, off = 0.12;
  const cx = r.x + nx * off, cy = r.y + ny * off;
  const z0 = r.z - 1.5 + 0.18 + dz, z1 = r.z - 1.5 + FLOOR_H - 0.18 + dz;
  const h = w / 2;
  const pos = new Float64Array([cx - tx * h, cy - ty * h, z0, cx + tx * h, cy + ty * h, z0, cx + tx * h, cy + ty * h, z1, cx - tx * h, cy - ty * h, z1]);
  const nor = new Float32Array([nx, ny, 0, nx, ny, 0, nx, ny, 0, nx, ny, 0]);
  return geometryFrom(pos, nor, new Uint16Array([0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2]));
}

function makeTerrainProvider(g: TerrainGrid, mm: Matrix4) {
  const z = b64ToF32(g.z_f32_b64);
  const inv = Matrix4.inverseTransformation(mm, new Matrix4());
  const W = 33;
  const scratch = new Cartesian3();
  const sample = (x: number, y: number) => {
    let fx = (x - g.x0) / g.dx, fy = (y - g.y0) / g.dy;
    fx = Math.max(0, Math.min(g.nx - 1.0001, fx));
    fy = Math.max(0, Math.min(g.ny - 1.0001, fy));
    const i = Math.floor(fx), j = Math.floor(fy), a = fx - i, b = fy - j;
    const z00 = z[j * g.nx + i], z01 = z[j * g.nx + i + 1], z10 = z[(j + 1) * g.nx + i], z11 = z[(j + 1) * g.nx + i + 1];
    return (z00 * (1 - a) + z01 * a) * (1 - b) + (z10 * (1 - a) + z11 * a) * b - g.pad_z;
  };
  const provider: CustomHeightmapTerrainProvider = new CustomHeightmapTerrainProvider({
    width: W, height: W,
    callback: (tx: number, ty: number, level: number) => {
      const rect = provider.tilingScheme.tileXYToRectangle(tx, ty, level);
      const out = new Float32Array(W * W);
      for (let r = 0; r < W; r++) {
        const lat = rect.north - (rect.north - rect.south) * (r / (W - 1));
        for (let c = 0; c < W; c++) {
          const lon = rect.west + (rect.east - rect.west) * (c / (W - 1));
          const l = Matrix4.multiplyByPoint(inv, Cartesian3.fromRadians(lon, lat, 0, undefined, scratch), scratch);
          out[r * W + c] = Math.abs(l.x) < 20000 && Math.abs(l.y) < 20000 ? sample(l.x, l.y) : 0;
        }
      }
      return out;
    },
  });
  return provider;
}

export default function CesiumScene(p: Props) {
  const el = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const mmRef = useRef<Matrix4>(Matrix4.IDENTITY);
  const prims = useRef<Record<string, any>>({});
  const pickRef = useRef(p.onPick);
  pickRef.current = p.onPick;
  const editRef = useRef(p.edit);
  editRef.current = p.edit;
  const [err, setErr] = useState<string | null>(null);
  const [imgErr, setImgErr] = useState(false);
  const [heading, setHeading] = useState(0);
  const dz = -p.padZ;

  const swap = (key: string, prim: any | null) => {
    const v = viewerRef.current;
    if (!v || v.isDestroyed()) return;
    if (prims.current[key]) v.scene.primitives.remove(prims.current[key]);
    prims.current[key] = prim;
    if (prim) v.scene.primitives.add(prim);
  };

  // ---- viewer lifecycle
  useEffect(() => {
    if (!el.current) return;
    let v: Viewer;
    try {
      v = new Viewer(el.current, {
        baseLayer: false, baseLayerPicker: false, geocoder: false, timeline: false, animation: false, homeButton: false, sceneModePicker: false,
        navigationHelpButton: false, fullscreenButton: false, infoBox: false, selectionIndicator: false, scene3DOnly: true,
        shadows: false, terrainShadows: ShadowMode.RECEIVE_ONLY, contextOptions: { webgl: { preserveDrawingBuffer: true } },
      });
    } catch (e) {
      setErr(String(e));
      p.onViewer?.(null);
      return;
    }
    viewerRef.current = v;
    const sc = v.scene;
    // Read-only helper for automated demos/tests: site ENU display coords (x, y, z above the pad) -> screen pixels.
    const hook = { toScreen: (x: number, y: number, z = 0) => {
      const w = Matrix4.multiplyByPoint(mmRef.current, new Cartesian3(x, y, z), new Cartesian3());
      const s = SceneTransforms.worldToWindowCoordinates(sc, w);
      if (!s) return null;
      const r = sc.canvas.getBoundingClientRect(); // page coordinates, ready for mouse input
      return { x: r.left + s.x, y: r.top + s.y };
    } };
    const g = window as unknown as { __geobuild?: { viewers: typeof hook[] } };
    (g.__geobuild ??= { viewers: [] }).viewers.push(hook);
    sc.globe.baseColor = Color.fromCssColorString("#1b2433");
    sc.globe.depthTestAgainstTerrain = true;
    sc.globe.showGroundAtmosphere = true;
    sc.fog.enabled = true;
    sc.postProcessStages.fxaa.enabled = true;
    if (sc.skyAtmosphere) sc.skyAtmosphere.show = true;
    v.shadowMap.softShadows = true;
    v.shadowMap.size = 4096;
    v.shadowMap.maximumDistance = 3000;
    v.shadowMap.darkness = 0.42;
    v.clock.shouldAnimate = false;
    const canvas = sc.canvas as HTMLCanvasElement;
    const groundAt = (x: number, y: number): Pt | null => {
      const ray = v.camera.getPickRay(new Cartesian2(x, y));
      if (!ray) return null;
      const m = Matrix4.inverseTransformation(mmRef.current, new Matrix4());
      const o = Matrix4.multiplyByPoint(m, ray.origin, new Cartesian3());
      const d = Matrix4.multiplyByPointAsVector(m, ray.direction, new Cartesian3());
      if (Math.abs(d.z) < 1e-9) return null;
      const t = -o.z / d.z;
      return t > 0 ? [o.x + d.x * t, o.y + d.y * t] : null;
    };
    const pickId = (x: number, y: number) => {
      const picked = sc.pick(new Cartesian2(x, y));
      return defined(picked) && picked.id && typeof picked.id === "object" ? (picked.id as { kind: string; id: string; layer?: string }) : null;
    };
    // ---- direct manipulation (drag = move, Shift+drag = rotate)
    let drag: null | { id: string; start: Pt; c: Pt; moved: boolean; rotate: boolean; last: { dx: number; dy: number; drot: number } } = null;
    let lastHover = 0;
    let suppressClick = false;
    const onDown = (e: PointerEvent) => {
      const ed = editRef.current;
      if (!ed || e.button !== 0) return;
      const id = pickId(e.offsetX, e.offsetY);
      if (!id || id.kind !== "building" || !ed.ids.has(id.id)) return;
      const g = groundAt(e.offsetX, e.offsetY);
      if (!g) return;
      drag = { id: id.id, start: g, c: ed.centroids[id.id] ?? g, moved: false, rotate: e.shiftKey, last: { dx: 0, dy: 0, drot: 0 } };
      sc.screenSpaceCameraController.enableInputs = false;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = e.shiftKey ? "alias" : "grabbing";
    };
    const onMove = (e: PointerEvent) => {
      const ed = editRef.current;
      if (drag && ed) {
        const g = groundAt(e.offsetX, e.offsetY);
        if (!g) return;
        let d = { dx: 0, dy: 0, drot: 0 };
        if (drag.rotate) {
          const a0 = Math.atan2(drag.start[1] - drag.c[1], drag.start[0] - drag.c[0]);
          const a1 = Math.atan2(g[1] - drag.c[1], g[0] - drag.c[0]);
          const deg = ((((a1 - a0) * 180) / Math.PI + 540) % 360) - 180;
          d = { dx: 0, dy: 0, drot: Math.round(deg * 2) / 2 };
        } else {
          d = { dx: Math.round((g[0] - drag.start[0]) * 2) / 2, dy: Math.round((g[1] - drag.start[1]) * 2) / 2, drot: 0 };
        }
        if (d.dx !== drag.last.dx || d.dy !== drag.last.dy || d.drot !== drag.last.drot) {
          drag.last = d;
          drag.moved = true;
          ed.onDrag(drag.id, d, "move");
        }
        return;
      }
      if (ed && performance.now() - lastHover > 90) {
        lastHover = performance.now();
        const id = pickId(e.offsetX, e.offsetY);
        canvas.style.cursor = id && id.kind === "building" && ed.ids.has(id.id) ? "grab" : "";
      }
    };
    const onUp = (e: PointerEvent) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      sc.screenSpaceCameraController.enableInputs = true;
      canvas.releasePointerCapture?.(e.pointerId);
      canvas.style.cursor = "";
      suppressClick = true;
      if (d.moved) editRef.current?.onDrag(d.id, d.last, "end");
      else pickRef.current?.({ type: "building", id: d.id, layer: "B" });
    };
    const onClick = (e: MouseEvent) => {
      if (suppressClick) { suppressClick = false; return; }
      const id = pickId(e.offsetX, e.offsetY);
      if (id && id.kind === "building") return pickRef.current?.({ type: "building", id: id.id, layer: id.layer ?? "" });
      if (id && id.kind === "receiver") return pickRef.current?.({ type: "receiver", id: id.id });
      const g = groundAt(e.offsetX, e.offsetY);
      if (g) pickRef.current?.({ type: "ground", x: g[0], y: g[1], z: 0 });
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("click", onClick);
    let frames = 0;
    const onPost = () => {
      frames++;
      if (frames === 10) p.onReady?.();
      if (frames % 15 === 0) setHeading(CMath.toDegrees(v.camera.heading));
    };
    sc.postRender.addEventListener(onPost);
    p.onViewer?.(v);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("click", onClick);
      if (g.__geobuild) g.__geobuild.viewers = g.__geobuild.viewers.filter((h) => h !== hook);
      p.onViewer?.(null);
      if (!v.isDestroyed()) v.destroy();
      viewerRef.current = null;
      prims.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- model matrix + initial camera
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    mmRef.current = Matrix4.fromColumnMajorArray(p.modelMatrix);
    const target = Matrix4.multiplyByPoint(mmRef.current, new Cartesian3(0, -20, 20), new Cartesian3());
    v.camera.lookAt(target, new Cartesian3(260, -430, 330));
    v.camera.lookAtTransform(Matrix4.IDENTITY);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.modelMatrix.join(",")]);

  // ---- terrain (analysis ground height field) or ellipsoid + exact mesh
  const groundMode = p.groundMode ?? "terrain";
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    v.terrainProvider = groundMode === "terrain" && p.terrainGrid ? makeTerrainProvider(p.terrainGrid, mmRef.current) : new EllipsoidTerrainProvider();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.terrainGrid, groundMode, p.modelMatrix.join(",")]);

  useEffect(() => {
    if (groundMode !== "mesh" || !p.ground) return swap("ground", null);
    const vf = b64ToF32(p.ground.vertices_f32_b64);
    const ix = b64ToU32(p.ground.indices_u32_b64);
    const pos = new Float64Array(vf.length);
    for (let i = 0; i < vf.length; i += 3) { pos[i] = vf[i]; pos[i + 1] = vf[i + 1]; pos[i + 2] = vf[i + 2] + dz; }
    let g = new Geometry({ attributes: { position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos }) } as any,
      indices: ix, primitiveType: PrimitiveType.TRIANGLES, boundingSphere: new BoundingSphere(new Cartesian3(0, 0, 0), 1) });
    g = GeometryPipeline.computeNormal(g);
    g.boundingSphere = new BoundingSphere(new Cartesian3(0, 0, 0), ((p.ground as any).region_half_m ?? 1200) * 1.5);
    swap("ground", new Primitive({
      geometryInstances: new GeometryInstance({ geometry: g, id: { kind: "ground" }, attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString("#c9c3b1")) } }),
      appearance: new PerInstanceColorAppearance({ flat: false }), modelMatrix: mmRef.current, asynchronous: false, shadows: ShadowMode.RECEIVE_ONLY,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.ground, groundMode, p.padZ]);

  // ---- basemap
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    v.imageryLayers.removeAll();
    setImgErr(false);
    const b = p.basemap ?? "light";
    if (b === "none") return;
    // Keyless OpenStreetMap tiles; light/dark themes are produced with imagery-layer colour adjustments
    // (CARTO basemaps now require an API key, which must not be hard-coded). OSM attribution stays visible.
    const prov = new OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" });
    prov.errorEvent.addEventListener(() => setImgErr(true));
    const layer = v.imageryLayers.addImageryProvider(prov);
    if (b === "light") { layer.saturation = 0.0; layer.brightness = 1.18; layer.contrast = 0.62; layer.gamma = 1.1; }
    else if (b === "dark") { layer.saturation = 0.15; layer.brightness = 0.32; layer.contrast = 1.25; layer.gamma = 0.9; }
    else { layer.saturation = 0.6; layer.brightness = 0.97; }
  }, [p.basemap]);

  // ---- buildings (+ floor lines, edges, labels)
  const layerKey = p.layers.map((l) => l.key + l.style + (l.selected ?? "") + [...(l.highlight ?? [])].join("") + l.buildings.map((b) => b.id + b.top_z + b.footprint.flat().join(",")).join("|")).join("#");
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    Object.keys(prims.current).filter((k) => k.startsWith("layer:")).forEach((k) => swap(k, null));
    const lines = new PolylineCollection({ modelMatrix: mmRef.current });
    const labels = new LabelCollection({ modelMatrix: mmRef.current });
    for (const L of p.layers) {
      if (!L.buildings.length) continue;
      const inst = L.buildings.map((b) => {
        let css = L.color ? L.color(b) : b.kind === "MAIN" ? "#eeeae2" : "#8e97a3";
        if (L.highlight?.has(b.id)) css = "#ffb27a";
        if (L.selected === b.id) css = "#6cb2ff";
        return new GeometryInstance({ geometry: flatGeometry(b.mesh.vertices, b.mesh.indices, dz), id: { kind: "building", id: b.id, layer: L.key },
          attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(css).withAlpha(L.style === "ghost" ? 0.26 : 1)) } });
      });
      swap(`layer:${L.key}`, new Primitive({
        geometryInstances: inst, appearance: new PerInstanceColorAppearance({ flat: false, translucent: L.style === "ghost", closed: true }),
        modelMatrix: mmRef.current, asynchronous: false, shadows: L.style === "ghost" ? ShadowMode.DISABLED : ShadowMode.CAST_ONLY,
      }));
      if (L.style !== "solid") continue;
      for (const b of L.buildings) {
        const ring = ringOpen(b.footprint);
        const z0 = b.base_z + dz, z1 = b.top_z + dz;
        // one Material per polyline: a PolylineCollection destroys each polyline's material, so sharing one throws on teardown
        const edgeCol = () => Material.fromType("Color", { color: Color.fromCssColorString(b.kind === "MAIN" ? "#3a4252" : "#4b535f").withAlpha(0.55) });
        lines.add({ positions: [...ring, ring[0]].map((q) => new Cartesian3(q[0], q[1], z1 + 0.02)), width: 1.2, material: edgeCol() });
        for (const q of ring) lines.add({ positions: [new Cartesian3(q[0], q[1], z0), new Cartesian3(q[0], q[1], z1)], width: 1, material: edgeCol() });
        if (p.floorLines !== false && b.kind === "MAIN") {
          const fl = () => Material.fromType("Color", { color: Color.fromCssColorString("#5b6578").withAlpha(0.33) });
          for (let k = 1; k < b.floors; k++) {
            const z = z0 + k * FLOOR_H;
            lines.add({ positions: [...ring, ring[0]].map((q) => new Cartesian3(q[0], q[1], z)), width: 1, material: fl() });
          }
        }
        if (p.labels !== false && b.kind === "MAIN") {
          labels.add({ position: new Cartesian3(b.centroid[0], b.centroid[1], z1 + 4), text: `${b.id}동 · ${b.floors}F`, font: "700 15px 'Pretendard Variable', 'Malgun Gothic', 'Noto Sans KR', 'Noto Sans CJK KR', 'Apple SD Gothic Neo', sans-serif",
            fillColor: Color.WHITE, outlineColor: Color.fromCssColorString("#0b1220"), outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE,
            horizontalOrigin: HorizontalOrigin.CENTER, verticalOrigin: VerticalOrigin.BOTTOM, scaleByDistance: new NearFarScalar(150, 1.15, 1600, 0.7),
            disableDepthTestDistance: Number.POSITIVE_INFINITY });
        }
      }
    }
    swap("layer:lines", lines);
    swap("layer:labels", labels);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerKey, p.padZ, p.floorLines, p.labels]);

  // ---- time + shadows (Cesium clock receives the same UTC instant as pvlib)
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    v.clock.currentTime = JulianDate.fromIso8601(p.timeUtc);
    v.shadows = p.shadows;
  }, [p.timeUtc, p.shadows]);

  // ---- facade heat tiles
  useEffect(() => {
    if (!p.facade?.length) return swap("facade", null);
    const inst = p.facade.map((r) => new GeometryInstance({ geometry: facadeTile(r, dz), id: { kind: "receiver", id: r.id },
      attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(r.color)) } }));
    swap("facade", new Primitive({ geometryInstances: inst, appearance: new PerInstanceColorAppearance({ flat: true, translucent: false }),
      modelMatrix: mmRef.current, asynchronous: false, shadows: ShadowMode.DISABLED }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.facade, p.padZ]);

  // ---- receiver points (fallback)
  useEffect(() => {
    if (!p.receivers?.length) return swap("points", null);
    const pts = new PointPrimitiveCollection({ modelMatrix: mmRef.current });
    for (const r of p.receivers) pts.add({ position: new Cartesian3(r.x + r.nx * 0.45, r.y + r.ny * 0.45, r.z + dz), color: Color.fromCssColorString(r.color),
      pixelSize: 6, outlineColor: Color.WHITE.withAlpha(0.8), outlineWidth: 1, id: { kind: "receiver", id: r.id } });
    swap("points", pts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.receivers, p.padZ]);

  // ---- analysis grid image (same bounds -> only swap the texture: smooth time-lapse)
  const gridBounds = p.grid ? [p.grid.x0, p.grid.y0, p.grid.x1, p.grid.y1, p.grid.z, p.padZ].join(",") : "";
  useEffect(() => {
    const g = p.grid;
    if (!g) return swap("grid", null);
    const z = g.z + dz + 0.15;
    const pos = new Float64Array([g.x0, g.y0, z, g.x1, g.y0, z, g.x1, g.y1, z, g.x0, g.y1, z]);
    const geo = geometryFrom(pos, new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), new Uint16Array([0, 1, 2, 0, 2, 3]), new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]));
    swap("grid", new Primitive({ geometryInstances: new GeometryInstance({ geometry: geo, id: { kind: "grid" } }),
      appearance: new MaterialAppearance({ material: Material.fromType("Image", { image: g.url }), translucent: true, flat: true, faceForward: true }),
      modelMatrix: mmRef.current, asynchronous: false, shadows: ShadowMode.DISABLED }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridBounds]);
  useEffect(() => {
    const prim = prims.current.grid;
    if (prim && p.grid) prim.appearance.material.uniforms.image = p.grid.url;
  }, [p.grid?.url]);

  // ---- lines + labels (clearance)
  useEffect(() => {
    if (!p.lines?.length) { swap("clr", null); return swap("clrLabels", null); }
    const lines = new PolylineCollection({ modelMatrix: mmRef.current });
    const labels = new LabelCollection({ modelMatrix: mmRef.current });
    p.lines.forEach((l, k) => {
      const z = l.z + dz + 1.2;
      const mat = () => Material.fromType("Color", { color: Color.fromCssColorString(l.color) });
      lines.add({ positions: [new Cartesian3(l.a[0], l.a[1], z), new Cartesian3(l.b[0], l.b[1], z)], width: l.width ?? 3, material: mat() });
      for (const q of [l.a, l.b]) lines.add({ positions: [new Cartesian3(q[0], q[1], z - 1.2), new Cartesian3(q[0], q[1], z + 0.6)], width: 2, material: mat() });
      if (l.label) labels.add({ pixelOffset: new Cartesian2(0, -(k % 3) * 18), position: new Cartesian3((l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2, z + 1.5), text: l.label,
        font: "700 13px 'Pretendard Variable', 'Malgun Gothic', 'Noto Sans KR', 'Noto Sans CJK KR', 'Apple SD Gothic Neo', sans-serif", fillColor: Color.WHITE, showBackground: true, backgroundColor: Color.fromCssColorString(l.color).withAlpha(0.88),
        horizontalOrigin: HorizontalOrigin.CENTER, verticalOrigin: VerticalOrigin.BOTTOM, disableDepthTestDistance: Number.POSITIVE_INFINITY });
    });
    swap("clr", lines);
    swap("clrLabels", labels);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.lines, p.padZ]);

  // ---- rings (site boundary / open spaces)
  useEffect(() => {
    if (!p.rings?.length) { swap("rings", null); return swap("ringLabels", null); }
    const rings = new PolylineCollection({ modelMatrix: mmRef.current });
    const labels = new LabelCollection({ modelMatrix: mmRef.current });
    for (const r of p.rings) {
      rings.add({ positions: [...r.ring, r.ring[0]].map((q) => new Cartesian3(q[0], q[1], r.z + dz + 0.3)), width: r.width ?? 2, material: Material.fromType("Color", { color: Color.fromCssColorString(r.color) }) });
      if (r.label) {
        const cx = r.ring.reduce((s, q) => s + q[0], 0) / r.ring.length, cy = r.ring.reduce((s, q) => s + q[1], 0) / r.ring.length;
        labels.add({ position: new Cartesian3(cx, cy, r.z + dz + 1), text: r.label, font: "600 12px 'Pretendard Variable', 'Malgun Gothic', 'Noto Sans KR', 'Noto Sans CJK KR', 'Apple SD Gothic Neo', sans-serif", fillColor: Color.fromCssColorString("#d9fbe9"),
          showBackground: true, backgroundColor: Color.fromCssColorString("#0f5c3d").withAlpha(0.85), disableDepthTestDistance: Number.POSITIVE_INFINITY, horizontalOrigin: HorizontalOrigin.CENTER,
          scaleByDistance: new NearFarScalar(200, 1, 1500, 0.6) });
      }
    }
    swap("rings", rings);
    swap("ringLabels", labels);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.rings, p.padZ]);

  if (err) {
    return (
      <div className={`flex items-center justify-center bg-bg-2 ${p.className ?? ""}`}>
        <div className="max-w-md p-6 text-center">
          <div className="mb-2 font-semibold text-bad">WebGL을 사용할 수 없어 3D 장면을 표시하지 못했습니다.</div>
          <div className="text-ink-2">분석 결과 표·차트·2D 평면도와 보고서는 서버 계산값으로 계속 사용할 수 있습니다.</div>
          <div className="mt-2 font-mono text-[10px] text-muted">{err.slice(0, 160)}</div>
        </div>
      </div>
    );
  }
  return (
    <div className={`relative overflow-hidden ${p.className ?? ""}`}>
      <div ref={el} className="absolute inset-0" data-capture-root />
      {imgErr && <div className="absolute bottom-10 left-3 rounded-md bg-[#3a2a10]/90 px-2.5 py-1 text-[11px] text-warn">배경지도 타일 접근 실패 – 3D 메쉬·분석 시각화는 정상</div>}
      <Compass heading={heading} onReset={() => {
        const v = viewerRef.current;
        if (!v) return;
        const target = Matrix4.multiplyByPoint(mmRef.current, new Cartesian3(0, -20, 20), new Cartesian3());
        v.camera.flyToBoundingSphere(new BoundingSphere(target, 260), { duration: 0.8 });
      }} />
    </div>
  );
}

function Compass({ heading, onReset }: { heading: number; onReset: () => void }) {
  return (
    <button onClick={onReset} title="북쪽 방향 · 클릭하면 단지 전체 보기" aria-label="단지 전체 보기"
      className="glass absolute right-3 top-3 z-10 flex h-11 w-11 items-center justify-center !rounded-full">
      <svg viewBox="0 0 40 40" width="32" height="32" style={{ transform: `rotate(${-heading}deg)`, transition: "transform .2s" }}>
        <polygon points="20,4 25.5,21 20,17.5 14.5,21" fill="#ff6b6b" />
        <polygon points="20,36 25.5,21 20,24.5 14.5,21" fill="#8aa0bd" />
        <text x="20" y="13.5" textAnchor="middle" fontSize="7" fill="#fff" fontWeight="800">N</text>
      </svg>
    </button>
  );
}
