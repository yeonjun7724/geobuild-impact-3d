/* View modes: single A, single B, overlay (B solid + A ghost of changed blocks), split A|B with camera sync. */
import { useEffect, useRef } from "react";
import type { Viewer } from "cesium";
import CesiumScene, { type Basemap, type BuildingLayer, type EditConfig, type GridImage, type Line, type PickResult, type ReceiverPt, type Ring, type TerrainGrid } from "./CesiumScene";
import type { GroundMesh, SceneBuilding } from "../api";

export type ViewMode = "A" | "B" | "OVERLAY" | "SPLIT";
type Side = { facade?: ReceiverPt[]; receivers?: ReceiverPt[]; grid?: GridImage | null; lines?: Line[] };
type Props = {
  mode: ViewMode; a: SceneBuilding[]; b: SceneBuilding[]; sideA?: Side; sideB?: Side;
  modelMatrix: number[]; padZ: number; ground: GroundMesh | null; terrainGrid?: TerrainGrid | null; groundMode?: "terrain" | "mesh"; basemap?: Basemap;
  timeUtc: string; shadows: boolean; showContext: boolean; floorLines?: boolean; labels?: boolean; selected?: string | null; changed: Set<string>;
  onPick?: (p: PickResult, side: "A" | "B") => void; rings?: Ring[]; edit?: EditConfig | null; onReady?: () => void;
};

export default function SyncedViewers({ mode, a, b, sideA = {}, sideB = {}, onReady, edit, ...c }: Props) {
  const left = useRef<Viewer | null>(null);
  const right = useRef<Viewer | null>(null);
  const filt = (xs: SceneBuilding[]) => (c.showContext ? xs : xs.filter((x) => x.kind === "MAIN"));

  useEffect(() => {
    if (mode !== "SPLIT") return;
    let remove: (() => void) | undefined;
    const t = window.setInterval(() => {
      const L = left.current, R = right.current;
      if (!L || !R || remove) return;
      R.scene.screenSpaceCameraController.enableInputs = false;
      remove = L.scene.postRender.addEventListener(() => {
        if (R.isDestroyed() || L.isDestroyed()) return;
        R.camera.setView({ destination: L.camera.positionWC.clone(), orientation: { direction: L.camera.directionWC.clone(), up: L.camera.upWC.clone() } });
      });
    }, 200);
    return () => { window.clearInterval(t); remove?.(); };
  }, [mode]);

  const layersFor = (which: "A" | "B" | "OVERLAY"): BuildingLayer[] => {
    if (which === "A") return [{ key: "A", buildings: filt(a), style: "solid", selected: c.selected }];
    if (which === "B") return [{ key: "B", buildings: filt(b), style: "solid", selected: c.selected, highlight: c.changed }];
    return [
      { key: "B", buildings: filt(b), style: "solid", selected: c.selected, highlight: c.changed },
      { key: "A-ghost", buildings: a.filter((x) => c.changed.has(x.id)), style: "ghost", color: () => "#4a94ff" },
    ];
  };
  const scene = (which: "A" | "B" | "OVERLAY", side: Side, ref: React.MutableRefObject<Viewer | null>, label: string, tone: "a" | "b", editable: boolean) => (
    <div className="relative h-full w-full">
      <CesiumScene className="h-full w-full" modelMatrix={c.modelMatrix} padZ={c.padZ} ground={c.ground} terrainGrid={c.terrainGrid} groundMode={c.groundMode}
        basemap={c.basemap} layers={layersFor(which)} timeUtc={c.timeUtc} shadows={c.shadows} floorLines={c.floorLines} labels={c.labels}
        facade={side.facade} receivers={side.receivers} grid={side.grid} lines={side.lines} rings={c.rings} edit={editable ? edit : null}
        onPick={(p) => c.onPick?.(p, which === "A" ? "A" : "B")} onViewer={(v) => { ref.current = v; }} onReady={onReady} />
      <div className={`pointer-events-none absolute left-3 top-3 z-10 rounded-md px-2 py-1 text-[11.5px] font-bold text-white shadow ${tone === "a" ? "bg-scen-a" : "bg-scen-b"}`}>{label}</div>
    </div>
  );
  if (mode === "SPLIT") {
    return (
      <div className="grid h-full w-full grid-cols-2 gap-[2px] bg-[#050a14]">
        {scene("A", sideA, left, "A 기준안 (잠금)", "a", false)}
        {scene("B", sideB, right, "B 변경안 · 카메라 동기화", "b", false)}
      </div>
    );
  }
  if (mode === "A") return scene("A", sideA, left, "A 기준안 (잠금)", "a", false);
  if (mode === "B") return scene("B", sideB, left, "B 변경안", "b", true);
  return scene("OVERLAY", sideB, left, "B 변경안 + A 위치(파란 반투명)", "b", true);
}
