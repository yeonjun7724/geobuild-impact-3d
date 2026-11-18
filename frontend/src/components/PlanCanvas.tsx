/* 2D plan canvas (world coordinates, y up / north up) with wheel zoom, drag pan and click picking.
   Used to show drawings (DXF linework in metres, PDF/image pixels) and the site reference plan side by side. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Maximize } from "lucide-react";

export type PlanRing = { id: string; pts: number[][]; stroke: string; fill?: string; label?: string; dash?: boolean; width?: number; closed?: boolean };
export type PlanMarker = { pt: number[]; label: string; color: string };

type VB = { x: number; y: number; w: number; h: number };

export default function PlanCanvas({ rings, image, markers = [], draft, onClick, onRingClick, fitKey, className = "", children, cursor = "default", northUp = true }: {
  rings: PlanRing[]; image?: { url: string; w: number; h: number } | null; markers?: PlanMarker[]; draft?: number[][] | null;
  onClick?: (p: [number, number], e: React.MouseEvent) => void; onRingClick?: (id: string) => void; fitKey?: string; className?: string;
  children?: ReactNode; cursor?: string; northUp?: boolean;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [vb, setVb] = useState<VB>({ x: 0, y: 0, w: 100, h: 100 });
  const drag = useRef<{ sx: number; sy: number; vb: VB; moved: boolean } | null>(null);

  const bounds = useMemo(() => {
    const xs: number[] = [], ys: number[] = [];
    rings.forEach((r) => r.pts.forEach((p) => { xs.push(p[0]); ys.push(-p[1]); }));
    if (image) { xs.push(0, image.w); ys.push(0, image.h); }
    if (!xs.length) return { x: -100, y: -100, w: 200, h: 200 };
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pad = Math.max(x1 - x0, y1 - y0, 10) * 0.06;
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
  }, [rings, image]);
  const fit = useCallback(() => setVb(bounds), [bounds]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fit(); }, [fitKey]);

  const toSvg = (cx: number, cy: number) => {
    const el = svg.current!;
    const pt = el.createSVGPoint();
    pt.x = cx; pt.y = cy;
    const m = el.getScreenCTM();
    return m ? pt.matrixTransform(m.inverse()) : pt;
  };
  const onWheel = (e: React.WheelEvent) => {
    const p = toSvg(e.clientX, e.clientY);
    const f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    setVb((v) => ({ x: p.x - (p.x - v.x) * f, y: p.y - (p.y - v.y) * f, w: v.w * f, h: v.h * f }));
  };
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", stop, { passive: false });
    return () => el.removeEventListener("wheel", stop);
  }, []);
  const drag2 = useRef(1);
  const onDown = (e: React.MouseEvent) => {
    const el = svg.current!;
    drag2.current = Math.max(vb.w / el.clientWidth, vb.h / el.clientHeight); // svg units per screen px (meet)
    drag.current = { sx: e.clientX, sy: e.clientY, vb, moved: false };
  };
  const onMove = (e: React.MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
    d.moved = true;
    const k = drag2.current;
    setVb({ ...d.vb, x: d.vb.x - (e.clientX - d.sx) * k, y: d.vb.y - (e.clientY - d.sy) * k });
  };
  const onUp = (e: React.MouseEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved && onClick) { const p = toSvg(e.clientX, e.clientY); onClick([p.x, -p.y], e); }
  };
  const fs = vb.w / 55;
  const path = (r: PlanRing) => r.pts.map((q, i) => `${i ? "L" : "M"}${q[0]},${-q[1]}`).join("") + (r.closed === false ? "" : "Z");
  return (
    <div className={`relative overflow-hidden rounded-lg bg-[#0a1322] ${className}`}>
      <svg ref={svg} className="h-full w-full select-none" viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} preserveAspectRatio="xMidYMid meet"
        onWheel={onWheel} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={() => (drag.current = null)} style={{ cursor }}>
        {image && <image href={image.url} x={0} y={0} width={image.w} height={image.h} opacity={0.85} />}
        {rings.map((r) => (
          <g key={r.id} onMouseUp={() => { if (drag.current && !drag.current.moved && onRingClick && !onClick) onRingClick(r.id); }}
            style={{ cursor: onRingClick && !onClick ? "pointer" : undefined }}>
            <path d={path(r)} fill={r.fill ?? "none"} stroke={r.stroke} strokeWidth={r.width ?? 1.4} vectorEffect="non-scaling-stroke" strokeDasharray={r.dash ? "5 4" : undefined} />
            {r.label && r.pts.length > 2 && (() => {
              const cx = r.pts.reduce((s, p) => s + p[0], 0) / r.pts.length, cy = r.pts.reduce((s, p) => s + p[1], 0) / r.pts.length;
              return <text x={cx} y={-cy} fontSize={fs} textAnchor="middle" dominantBaseline="middle" fill="#fff" stroke="#0a1322" strokeWidth={fs / 6} paintOrder="stroke" fontWeight={700}>{r.label}</text>;
            })()}
          </g>
        ))}
        {draft && draft.length > 0 && <path d={draft.map((q, i) => `${i ? "L" : "M"}${q[0]},${-q[1]}`).join("")} fill="none" stroke="#ffd166" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
        {draft?.map((q, i) => <circle key={i} cx={q[0]} cy={-q[1]} r={fs / 4} fill={i === 0 ? "#ffd166" : "#fff"} />)}
        {markers.map((m) => (
          <g key={m.label}>
            <circle cx={m.pt[0]} cy={-m.pt[1]} r={fs / 2.6} fill="none" stroke={m.color} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
            <text x={m.pt[0] + fs / 1.8} y={-m.pt[1] - fs / 1.8} fontSize={fs * 1.1} fill={m.color} fontWeight={800} stroke="#0a1322" strokeWidth={fs / 6} paintOrder="stroke">{m.label}</text>
          </g>
        ))}
        {children}
      </svg>
      {northUp && <div className="pointer-events-none absolute right-2 top-2 flex flex-col items-center text-[10px] text-muted"><svg width="14" height="16" viewBox="-7 -10 14 16"><polygon points="0,-10 5,4 0,1 -5,4" fill="#ff6b6b" /></svg>N</div>}
      <button className="btn btn-sm btn-icon absolute bottom-2 right-2" onClick={fit} title="전체 보기" aria-label="전체 보기"><Maximize size={13} /></button>
    </div>
  );
}
