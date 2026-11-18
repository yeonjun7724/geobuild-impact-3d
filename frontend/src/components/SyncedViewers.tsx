/* View modes: single A, single B, overlay (B solid + A ghost of changed blocks), split A|B with camera sync. */
import { useEffect, useRef } from "react";
import type { Viewer } from "cesium";
import CesiumScene, { type BuildingLayer, type GridImage, type Line, type PickResult, type ReceiverPt, type Ring } from "./CesiumScene";
import type { GroundMesh, SceneBuilding } from "../api";

export type ViewMode = "A" | "B" | "OVERLAY" | "SPLIT";

type Common = {
  modelMatrix: number[];
  padZ: number;
  ground: GroundMesh | null;
  timeUtc: string;
  shadows: boolean;
  imagery: boolean;
  showContext: boolean;
  selected?: string | null;
  changed: Set<string>;
  onPick?: (p: PickResult, side: "A" | "B") => void;
  rings?: Ring[];
};
type Side = { receivers?: ReceiverPt[]; grid?: GridImage | null; lines?: Line[] };

export default function SyncedViewers({ mode, a, b, sideA = {}, sideB = {}, onReady, ...c }: Common & { mode: ViewMode; a: SceneBuilding[]; b: SceneBuilding[]; sideA?: Side; sideB?: Side; onReady?: () => void }) {
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
      { key: "A-ghost", buildings: a.filter((x) => c.changed.has(x.id)), style: "ghost", color: () => "#2a78d6" },
    ];
  };
  const scene = (which: "A" | "B" | "OVERLAY", side: Side, ref?: React.MutableRefObject<Viewer | null>, label?: string) => (
    <div className="relative h-full w-full">
      <CesiumScene
        className="h-full w-full"
        modelMatrix={c.modelMatrix} padZ={c.padZ} ground={c.ground} layers={layersFor(which)} timeUtc={c.timeUtc} shadows={c.shadows} imagery={c.imagery}
        receivers={side.receivers} grid={side.grid} lines={side.lines} rings={c.rings}
        onPick={(p) => c.onPick?.(p, which === "A" ? "A" : "B")}
        onViewer={(v) => { if (ref) ref.current = v; }}
        onReady={onReady}
      />
      {label && <div className={`pointer-events-none absolute left-2 top-2 rounded px-2 py-0.5 text-[12px] font-bold text-white ${label.startsWith("A") ? "bg-scen-a" : "bg-scen-b"}`}>{label}</div>}
    </div>
  );
  if (mode === "SPLIT") {
    return (
      <div className="grid h-full w-full grid-cols-2 gap-[2px] bg-stone-300">
        {scene("A", sideA, left, "A 기준안")}
        {scene("B", sideB, right, "B 변경안 (카메라 동기화)")}
      </div>
    );
  }
  if (mode === "A") return scene("A", sideA, left, "A 기준안");
  if (mode === "B") return scene("B", sideB, left, "B 변경안");
  return scene("OVERLAY", sideB, left, "B 변경안 + A 위치(파란 반투명)");
}
