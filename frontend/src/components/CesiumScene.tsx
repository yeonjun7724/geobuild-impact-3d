/* CesiumJS scene. Geometry = the backend analysis meshes (local ENU, metres) placed with the ENU->ECEF model
   matrix returned by the API (identical to Transforms.eastNorthUpToFixedFrame at the AOI origin).
   Display height = z − pad_z + 0.5 m (uniform shift so the virtual pad sits on the ellipsoid where the
   background map is drawn); relative geometry is unchanged. Rendered shadows are a visual preview only. */
import { useEffect, useRef, useState } from "react";
import {
  BoundingSphere, Cartesian2, Cartesian3, Color, ColorGeometryInstanceAttribute, ComponentDatatype, Geometry, GeometryAttribute,
  GeometryInstance, GeometryPipeline, HorizontalOrigin, Ion, JulianDate, LabelCollection, LabelStyle, Material, MaterialAppearance,
  Math as CMath, Matrix4, OpenStreetMapImageryProvider, PerInstanceColorAppearance, PointPrimitiveCollection, PolylineCollection,
  Primitive, PrimitiveType, ScreenSpaceEventHandler, ScreenSpaceEventType, ShadowMode, VerticalOrigin, Viewer, defined,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { b64ToF32, b64ToU32, type GroundMesh, type SceneBuilding } from "../api";

Ion.defaultAccessToken = ""; // no Cesium ion dependency

export type BuildingLayer = {
  key: string;
  buildings: SceneBuilding[];
  style: "solid" | "ghost";
  color?: (b: SceneBuilding) => string;
  selected?: string | null;
  highlight?: Set<string>;
};
export type ReceiverPt = { id: string; x: number; y: number; z: number; nx: number; ny: number; color: string };
export type GridImage = { url: string; x0: number; y0: number; x1: number; y1: number; z: number };
export type Line = { a: number[]; b: number[]; z: number; label?: string; color: string; width?: number };
export type Ring = { ring: number[][]; z: number; color: string; width?: number; label?: string };
export type PickResult =
  | { type: "building"; id: string; layer: string }
  | { type: "receiver"; id: string }
  | { type: "ground"; x: number; y: number; z: number };

type Props = {
  modelMatrix: number[];
  padZ: number;
  ground?: GroundMesh | null;
  layers: BuildingLayer[];
  timeUtc: string;
  shadows: boolean;
  imagery: boolean;
  receivers?: ReceiverPt[];
  grid?: GridImage | null;
  lines?: Line[];
  rings?: Ring[];
  onPick?: (p: PickResult) => void;
  onViewer?: (v: Viewer | null) => void;
  onReady?: () => void;
  interactive?: boolean;
  className?: string;
};

const DZ_PAD = 0.5;

function flatGeometry(verts: number[], idx: number[], dz: number): Geometry {
  const n = idx.length;
  const pos = new Float64Array(n * 3);
  const nor = new Float32Array(n * 3);
  for (let t = 0; t < n; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ax = verts[a], ay = verts[a + 1], az = verts[a + 2] + dz;
    const bx = verts[b], by = verts[b + 1], bz = verts[b + 2] + dz;
    const cx = verts[c], cy = verts[c + 1], cz = verts[c + 2] + dz;
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
    const P = [ax, ay, az, bx, by, bz, cx, cy, cz];
    for (let k = 0; k < 9; k++) pos[t * 3 + k] = P[k];
    for (let k = 0; k < 3; k++) { nor[(t + k) * 3] = nx; nor[(t + k) * 3 + 1] = ny; nor[(t + k) * 3 + 2] = nz; }
  }
  const indices = new Uint16Array(n);
  for (let i = 0; i < n; i++) indices[i] = i;
  return new Geometry({
    attributes: {
      position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos }),
      normal: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: nor }),
    } as any,
    indices,
    primitiveType: PrimitiveType.TRIANGLES,
    boundingSphere: BoundingSphere.fromVertices(Array.from(pos)),
  });
}

export default function CesiumScene(p: Props) {
  const el = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const mmRef = useRef<Matrix4>(Matrix4.IDENTITY);
  const groundPrim = useRef<Primitive | null>(null);
  const layerPrims = useRef<Primitive[]>([]);
  const overlay = useRef<{ pts?: PointPrimitiveCollection; grid?: Primitive; lines?: PolylineCollection; labels?: LabelCollection; rings?: PolylineCollection; ringLabels?: LabelCollection }>({});
  const pickRef = useRef(p.onPick);
  pickRef.current = p.onPick;
  const [err, setErr] = useState<string | null>(null);
  const [imgErr, setImgErr] = useState(false);
  const dz = -p.padZ + DZ_PAD;

  // ---- viewer lifecycle
  useEffect(() => {
    if (!el.current) return;
    let v: Viewer;
    try {
      v = new Viewer(el.current, {
        baseLayer: false, baseLayerPicker: false, geocoder: false, timeline: false, animation: false, homeButton: false,
        sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false, infoBox: false, selectionIndicator: false,
        shadows: false, terrainShadows: ShadowMode.DISABLED, scene3DOnly: true,
        contextOptions: { webgl: { preserveDrawingBuffer: true } },
      });
    } catch (e) {
      setErr(String(e));
      p.onViewer?.(null);
      return;
    }
    viewerRef.current = v;
    v.scene.globe.baseColor = Color.fromCssColorString("#e7e5de");
    v.scene.globe.depthTestAgainstTerrain = true;
    if (v.scene.skyAtmosphere) v.scene.skyAtmosphere.show = true;
    v.shadowMap.softShadows = true;
    v.shadowMap.size = 4096;
    v.shadowMap.maximumDistance = 2500;
    v.shadowMap.darkness = 0.45;
    v.clock.shouldAnimate = false;
    (v.cesiumWidget.creditContainer as HTMLElement).style.fontSize = "10px";
    const handler = new ScreenSpaceEventHandler(v.scene.canvas);
    handler.setInputAction((ev: { position: Cartesian2 }) => {
      const picked = v.scene.pick(ev.position);
      if (defined(picked) && picked.id && typeof picked.id === "object" && picked.id.kind) {
        const id = picked.id as { kind: string; id: string; layer?: string };
        if (id.kind === "building") pickRef.current?.({ type: "building", id: id.id, layer: id.layer ?? "" });
        else if (id.kind === "receiver") pickRef.current?.({ type: "receiver", id: id.id });
        return;
      }
      const w = v.scene.pickPosition(ev.position);
      if (defined(w)) {
        const inv = Matrix4.inverseTransformation(mmRef.current, new Matrix4());
        const l = Matrix4.multiplyByPoint(inv, w, new Cartesian3());
        pickRef.current?.({ type: "ground", x: l.x, y: l.y, z: l.z - dz });
      }
    }, ScreenSpaceEventType.LEFT_CLICK);
    if (p.interactive === false) {
      const c = v.scene.screenSpaceCameraController;
      c.enableInputs = false;
    }
    let frames = 0;
    const onPost = () => {
      frames++;
      if (frames === 10) p.onReady?.();
    };
    v.scene.postRender.addEventListener(onPost);
    p.onViewer?.(v);
    return () => {
      handler.destroy();
      p.onViewer?.(null);
      if (!v.isDestroyed()) v.destroy();
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- model matrix + initial camera
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    mmRef.current = Matrix4.fromColumnMajorArray(p.modelMatrix);
    const target = Matrix4.multiplyByPoint(mmRef.current, new Cartesian3(0, 0, 0), new Cartesian3());
    v.camera.lookAt(target, new Cartesian3(210, -360, 300));
    v.camera.lookAtTransform(Matrix4.IDENTITY);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.modelMatrix.join(",")]);

  // ---- imagery (optional OSM background, attribution shown by Cesium credits)
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    v.imageryLayers.removeAll();
    setImgErr(false);
    if (p.imagery) {
      const prov = new OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" });
      prov.errorEvent.addEventListener(() => setImgErr(true));
      const layer = v.imageryLayers.addImageryProvider(prov);
      layer.alpha = 0.75;
      layer.saturation = 0.4;
    }
  }, [p.imagery]);

  // ---- ground mesh (same mesh as the ray caster)
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || !p.ground) return;
    const vf = b64ToF32(p.ground.vertices_f32_b64);
    const ix = b64ToU32(p.ground.indices_u32_b64);
    const pos = new Float64Array(vf.length);
    for (let i = 0; i < vf.length; i += 3) { pos[i] = vf[i]; pos[i + 1] = vf[i + 1]; pos[i + 2] = vf[i + 2] + dz; }
    let g = new Geometry({
      attributes: { position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos }) } as any,
      indices: ix, primitiveType: PrimitiveType.TRIANGLES, boundingSphere: BoundingSphere.fromVertices(Array.from(pos.subarray(0, Math.min(pos.length, 30000)))),
    });
    g = GeometryPipeline.computeNormal(g);
    g.boundingSphere = new BoundingSphere(new Cartesian3(0, 0, 0), ((p.ground as any).region_half_m ?? 1200) * 1.5);
    const prim = new Primitive({
      geometryInstances: new GeometryInstance({ geometry: g, id: { kind: "ground" },
        attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString("#d8d4c4").withAlpha(0.92)) } }),
      appearance: new PerInstanceColorAppearance({ flat: false, translucent: true }),
      modelMatrix: mmRef.current, asynchronous: false, shadows: ShadowMode.RECEIVE_ONLY,
    });
    v.scene.primitives.add(prim);
    groundPrim.current = prim;
    return () => { if (!v.isDestroyed()) v.scene.primitives.remove(prim); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.ground, p.padZ]);

  // ---- building layers
  const layerKey = p.layers.map((l) => l.key + l.style + (l.selected ?? "") + [...(l.highlight ?? [])].join("") + l.buildings.map((b) => b.id + b.top_z + b.centroid.join(",") + b.footprint.flat().join(",")).join("|")).join("#");
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    layerPrims.current.forEach((pr) => v.scene.primitives.remove(pr));
    layerPrims.current = [];
    for (const L of p.layers) {
      if (!L.buildings.length) continue;
      const inst = L.buildings.map((b) => {
        let css = L.color ? L.color(b) : b.kind === "MAIN" ? "#f4f2ec" : "#b9b6ab";
        if (L.highlight?.has(b.id)) css = "#f2a06b";
        if (L.selected === b.id) css = "#2a78d6";
        const alpha = L.style === "ghost" ? 0.28 : 1.0;
        return new GeometryInstance({
          geometry: flatGeometry(b.mesh.vertices, b.mesh.indices, dz),
          id: { kind: "building", id: b.id, layer: L.key },
          attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(css).withAlpha(alpha)) },
        });
      });
      const prim = new Primitive({
        geometryInstances: inst,
        appearance: new PerInstanceColorAppearance({ flat: false, translucent: L.style === "ghost", closed: true }),
        modelMatrix: mmRef.current, asynchronous: false,
        shadows: L.style === "ghost" ? ShadowMode.DISABLED : ShadowMode.CAST_ONLY, // cast onto ground; avoids self-shadow acne on walls
      });
      v.scene.primitives.add(prim);
      layerPrims.current.push(prim);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerKey, p.padZ]);

  // ---- time + shadows (Cesium clock receives the same UTC instant as pvlib)
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    v.clock.currentTime = JulianDate.fromIso8601(p.timeUtc);
    v.shadows = p.shadows;
  }, [p.timeUtc, p.shadows]);

  // ---- overlays
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    const o = overlay.current;
    if (o.pts) v.scene.primitives.remove(o.pts);
    o.pts = undefined;
    if (p.receivers?.length) {
      const pts = new PointPrimitiveCollection({ modelMatrix: mmRef.current });
      for (const r of p.receivers) {
        pts.add({ position: new Cartesian3(r.x + r.nx * 0.45, r.y + r.ny * 0.45, r.z + dz), color: Color.fromCssColorString(r.color), pixelSize: 6,
          outlineColor: Color.WHITE.withAlpha(0.8), outlineWidth: 1, id: { kind: "receiver", id: r.id } });
      }
      v.scene.primitives.add(pts);
      o.pts = pts;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.receivers, p.padZ]);

  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    const o = overlay.current;
    if (o.grid) v.scene.primitives.remove(o.grid);
    o.grid = undefined;
    const gI = p.grid;
    if (gI) {
      const z = gI.z + dz + 0.12;
      const pos = new Float64Array([gI.x0, gI.y0, z, gI.x1, gI.y0, z, gI.x1, gI.y1, z, gI.x0, gI.y1, z]);
      const geo = new Geometry({
        attributes: {
          position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos }),
          normal: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]) }),
          st: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]) }),
        } as any,
        indices: new Uint16Array([0, 1, 2, 0, 2, 3]), primitiveType: PrimitiveType.TRIANGLES,
        boundingSphere: BoundingSphere.fromVertices(Array.from(pos)),
      });
      const prim = new Primitive({
        geometryInstances: new GeometryInstance({ geometry: geo, id: { kind: "grid" } }),
        appearance: new MaterialAppearance({ material: Material.fromType("Image", { image: gI.url }), translucent: true, flat: true, faceForward: true }),
        modelMatrix: mmRef.current, asynchronous: false, shadows: ShadowMode.DISABLED,
      });
      v.scene.primitives.add(prim);
      o.grid = prim;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.grid, p.padZ]);

  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    const o = overlay.current;
    if (o.lines) v.scene.primitives.remove(o.lines);
    if (o.labels) v.scene.primitives.remove(o.labels);
    o.lines = o.labels = undefined;
    if (p.lines?.length) {
      const lines = new PolylineCollection({ modelMatrix: mmRef.current });
      const labels = new LabelCollection({ modelMatrix: mmRef.current });
      for (const l of p.lines) {
        const z = l.z + dz + 1.5;
        lines.add({ positions: [new Cartesian3(l.a[0], l.a[1], z), new Cartesian3(l.b[0], l.b[1], z)], width: l.width ?? 3,
          material: Material.fromType("Color", { color: Color.fromCssColorString(l.color) }) });
        if (l.label) {
          const k = labels.length;
          labels.add({ pixelOffset: new Cartesian2(0, -(k % 3) * 16), position: new Cartesian3((l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2, z + 2), text: l.label, font: "600 13px 'Noto Sans KR', sans-serif",
            fillColor: Color.fromCssColorString("#0b0b0b"), showBackground: true, backgroundColor: Color.WHITE.withAlpha(0.88),
            horizontalOrigin: HorizontalOrigin.CENTER, verticalOrigin: VerticalOrigin.BOTTOM, disableDepthTestDistance: Number.POSITIVE_INFINITY,
            style: LabelStyle.FILL });
        }
      }
      v.scene.primitives.add(lines);
      v.scene.primitives.add(labels);
      o.lines = lines;
      o.labels = labels;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.lines, p.padZ]);

  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    const o = overlay.current;
    if (o.rings) v.scene.primitives.remove(o.rings);
    if (o.ringLabels) v.scene.primitives.remove(o.ringLabels);
    o.rings = o.ringLabels = undefined;
    if (p.rings?.length) {
      const rings = new PolylineCollection({ modelMatrix: mmRef.current });
      const labels = new LabelCollection({ modelMatrix: mmRef.current });
      for (const r of p.rings) {
        const pts = [...r.ring, r.ring[0]].map((q) => new Cartesian3(q[0], q[1], r.z + dz + 0.3));
        rings.add({ positions: pts, width: r.width ?? 2, material: Material.fromType("Color", { color: Color.fromCssColorString(r.color) }) });
        if (r.label) {
          const cx = r.ring.reduce((s, q) => s + q[0], 0) / r.ring.length;
          const cy = r.ring.reduce((s, q) => s + q[1], 0) / r.ring.length;
          labels.add({ position: new Cartesian3(cx, cy, r.z + dz + 1), text: r.label, font: "12px 'Noto Sans KR', sans-serif",
            fillColor: Color.fromCssColorString("#0b6b48"), showBackground: true, backgroundColor: Color.WHITE.withAlpha(0.8),
            disableDepthTestDistance: Number.POSITIVE_INFINITY, horizontalOrigin: HorizontalOrigin.CENTER });
        }
      }
      v.scene.primitives.add(rings);
      v.scene.primitives.add(labels);
      o.rings = rings;
      o.ringLabels = labels;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.rings, p.padZ]);

  if (err) {
    return (
      <div className={`flex items-center justify-center bg-stone-100 text-sm text-stone-600 ${p.className ?? ""}`}>
        <div className="max-w-md p-6 text-center">
          <div className="mb-2 font-semibold text-red-700">WebGL을 사용할 수 없어 3D 장면을 표시하지 못했습니다.</div>
          <div>분석 결과 표·차트·2D 평면도와 보고서는 서버 계산값으로 계속 사용할 수 있습니다.</div>
          <div className="mt-2 font-mono text-[10px] text-stone-400">{err.slice(0, 160)}</div>
        </div>
      </div>
    );
  }
  return (
    <div className={`relative ${p.className ?? ""}`}>
      <div ref={el} className="absolute inset-0" data-capture-root />
      {imgErr && (
        <div className="absolute left-2 top-2 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800 shadow">
          배경지도 타일 접근 실패 – 자체 3D 메쉬·분석 시각화는 정상 동작
        </div>
      )}
      <NorthArrow viewer={viewerRef} />
    </div>
  );
}

function NorthArrow({ viewer }: { viewer: React.MutableRefObject<Viewer | null> }) {
  const [deg, setDeg] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => {
      const v = viewer.current;
      if (v && !v.isDestroyed()) setDeg(CMath.toDegrees(v.camera.heading));
    }, 250);
    return () => window.clearInterval(id);
  }, [viewer]);
  return (
    <div className="pointer-events-none absolute right-3 top-3 flex h-11 w-11 items-center justify-center rounded-full bg-white/90 shadow" title="북쪽 방향">
      <svg viewBox="0 0 40 40" width="34" height="34" style={{ transform: `rotate(${-deg}deg)` }}>
        <polygon points="20,4 26,22 20,18 14,22" fill="#0d366b" />
        <polygon points="20,36 26,22 20,26 14,22" fill="#c3c2b7" />
        <text x="20" y="13" textAnchor="middle" fontSize="7" fill="#fff" fontWeight="700">N</text>
      </svg>
    </div>
  );
}
