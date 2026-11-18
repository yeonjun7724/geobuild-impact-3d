/* Generates the HyperFrames project (index.html + compositions/*.html) and the subtitle/timeline files
 * from the narration timings, so every cut follows the voice-over.
 *
 *   node video/hf/build.mjs        (after video/tts/synth.py and video/capture/record.mjs)
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HF = dirname(fileURLToPath(import.meta.url));
const T = JSON.parse(readFileSync(join(HF, "assets/vo/timings.json"), "utf8"));
const CTX = JSON.parse(readFileSync(join(HF, "assets/rec/context.json"), "utf8"));
mkdirSync(join(HF, "compositions"), { recursive: true });
mkdirSync(join(HF, "assets/fonts"), { recursive: true });
if (!existsSync(join(HF, "assets/fonts/PretendardVariable.woff2"))) copyFileSync(join(HF, "../../frontend/node_modules/pretendard/dist/web/variable/woff2/PretendardVariable.woff2"), join(HF, "assets/fonts/PretendardVariable.woff2"));

const LEAD = 0.55, GAP = 0.32, TAIL = 0.75, MAXRATE = 1.7, MINRATE = 0.85;
const probe = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(HF, f)]).toString());
const r1 = (x) => Math.round(x * 1000) / 1000;

/* ---------------------------------------------------------------- scene plan */
const REC = { s04_edit: "edit", s06_facade: "facade", s07_shadow: "timelapse", s08_verdict: "verdict" };
const MIN = { s01_title: 8.5, s11_end: 11 };
let t = 0;
const plan = Object.entries(T).map(([id, lines]) => {
  let c = LEAD;
  const L = lines.map((l) => { const o = { ...l, at: r1(c) }; c += l.dur + GAP; return o; });
  let dur = c - GAP + TAIL;
  let rec = null;
  if (REC[id]) {
    const src = `assets/rec/${REC[id]}.mp4`, len = probe(src);
    dur = Math.max(dur, len / MAXRATE);
    rec = { src, len, rate: r1(Math.min(MAXRATE, Math.max(MINRATE, len / dur))) };
  }
  dur = r1(Math.max(dur, MIN[id] ?? 0));
  const s = { id, start: r1(t), dur, lines: L, rec };
  t += dur;
  return s;
});
const TOTAL = r1(t);

/* ---------------------------------------------------------------- shared look */
const FONT = `@font-face { font-family: "Pretendard"; src: url("assets/fonts/PretendardVariable.woff2") format("woff2"); font-weight: 100 900; font-display: block; }`;
const BASE = `
  ${FONT}
  #root { position: absolute; inset: 0; font-family: "Pretendard", sans-serif; color: #0b1220; letter-spacing: -0.02em; overflow: hidden; }
  .eyebrow { display: inline-flex; align-items: center; gap: 14px; font-size: 28px; font-weight: 700; color: #2f7de1; letter-spacing: 0.02em; }
  .eyebrow b { display: inline-grid; place-items: center; width: 48px; height: 48px; border-radius: 14px; background: #2f7de1; color: #fff; font-size: 28px; }
  .h1 { font-size: 46px; font-weight: 800; line-height: 1.22; letter-spacing: -0.035em; }
  .muted { color: #5b6678; }
  .card { background: #fff; border: 1px solid #dfe6ef; border-radius: 22px; box-shadow: 0 18px 50px -24px rgba(16, 38, 74, .28); }
  .pill { display: inline-flex; align-items: center; gap: 10px; padding: 10px 18px; border-radius: 999px; background: #fff; border: 1px solid #dfe6ef; font-weight: 600; font-size: 28px; box-shadow: 0 10px 30px -18px rgba(16, 38, 74, .35); }
  .blue { color: #2f7de1; } .red { color: #e2373c; } .sun { color: #f2a516; }
`;
const LOGO = (s = 64) => `<svg width="${s}" height="${s}" viewBox="0 0 32 32"><defs><linearGradient id="lg${s}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6cb2ff"/><stop offset="1" stop-color="#2f7de1"/></linearGradient></defs><rect x="2" y="2" width="28" height="28" rx="8" fill="url(#lg${s})"/><path d="M9 22V13l5-3v12M15 22V9l4-2v15M20 22v-8l3 1.5V22" stroke="#fff" stroke-width="1.8" fill="none" stroke-linejoin="round"/><circle cx="24" cy="8.5" r="2.4" fill="#ffd36b"/></svg>`;

/** Scene file: content fades/rises in at the start and out at the end; `js` adds the scene's own tweens to `tl`. */
function sceneFile(s, css, html, js = "") {
  return `<template>
  <style>
${BASE}
${css}
  </style>
  <div id="root" data-composition-id="${s.id}" data-width="1920" data-height="1080">
    <div id="${s.id}-wrap" style="position:absolute;inset:0">
      <div id="${s.id}-drift" style="position:absolute;inset:0">
${html}
      </div>
    </div>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    const D = ${s.dur}, L = ${JSON.stringify(s.lines.map((l) => l.at))};
    ${s.id === "s01_title" ? "" : `tl.fromTo("#${s.id}-wrap", { opacity: 0 }, { opacity: 1, duration: 0.45, ease: "power2.out" }, 0);`}
    ${s.id === "s11_end" ? "" : `tl.to("#${s.id}-wrap", { opacity: 0, duration: 0.4, ease: "power2.in" }, D - 0.42);`}
    ${s.rec ? "" : `tl.fromTo("#${s.id}-drift", { scale: 1 }, { scale: 1.03, duration: D, ease: "none" }, 0);`}
    const num = (sel, to, at, dur = 1.2, fmt = (v) => Math.round(v).toLocaleString("en-US")) => {
      const o = { v: 0 }, el = document.querySelector(sel);
      tl.fromTo(o, { v: 0 }, { v: to, duration: dur, ease: "power2.out", onUpdate: () => { el.textContent = fmt(o.v); } }, at);
    };
${js}
    window.__timelines["${s.id}"] = tl;
  </script>
</template>
`;
}

/** Recording scene: eyebrow + headline on top, the app capture in a rounded browser frame, optional callouts. */
function recScene(s, n, eyebrow, title, callouts = []) {
  const FW = 1376, FH = 774, FX = (1920 - FW) / 2, FY = 168, k = FW / 1920;
  const co = callouts.map((c, i) => `<div id="${s.id}-co${i}" class="pill co" style="left:${FX + c.x * k}px;top:${FY + c.y * k}px">${c.dot ? `<i style="background:${c.dot}"></i>` : ""}${c.text}</div>`).join("\n");
  const css = `
  .head { position: absolute; left: ${FX}px; top: 46px; display: flex; align-items: center; gap: 22px; }
  .head .h1 { font-size: 40px; }
  .frame { position: absolute; left: ${FX}px; top: ${FY}px; width: ${FW}px; height: ${FH}px; border-radius: 20px; overflow: hidden; background: #0b1220;
           box-shadow: 0 40px 90px -40px rgba(10, 30, 70, .55), 0 0 0 1px rgba(15, 35, 70, .12); }
  .frame video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .co { position: absolute; transform-origin: 0 50%; font-size: 28px; padding: 10px 20px; border-color: #2f7de1; box-shadow: 0 14px 34px -14px rgba(47,125,225,.6); }
  .co i { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }`;
  const html = `
      <div class="head" id="${s.id}-head"><span class="eyebrow"><b>${n}</b>${eyebrow}</span><span class="h1">${title}</span></div>
      <div class="frame" id="${s.id}-frame">
        <video id="${s.id}-vid" class="clip" src="${s.rec.src}" muted playsinline data-start="0" data-duration="${s.dur}" data-media-start="0" data-playback-rate="${s.rec.rate}" data-track-index="0"></video>
      </div>
${co}`;
  const js = `
    tl.fromTo("#${s.id}-frame", { y: 40, scale: 0.97 }, { y: 0, scale: 1, duration: 0.8, ease: "power3.out" }, 0);
    tl.fromTo("#${s.id}-head", { x: -30, opacity: 0 }, { x: 0, opacity: 1, duration: 0.6, ease: "power3.out" }, 0.1);
${callouts.map((c, i) => `    tl.fromTo("#${s.id}-co${i}", { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 0.35, ease: "back.out(2)" }, ${c.at});
    tl.to("#${s.id}-co${i}", { opacity: 0, duration: 0.3 }, ${c.until ?? "D - 0.8"});`).join("\n")}`;
  return sceneFile(s, css, html, js);
}

/* ---------------------------------------------------------------- scenes */
const S = Object.fromEntries(plan.map((s) => [s.id, s]));
const files = {};

files.s01_title = (s) => {
  // seven slabs of the virtual estate; the orange one is the changed block
  const blocks = [[0, 210, 250], [150, 250, 300], [300, 200, 230], [450, 270, 330], [600, 190, 220], [750, 240, 280], [900, 210, 250]];
  const svgB = blocks.map(([x, h, w], i) => `<g id="s01-b${i}"><rect x="${x}" y="${560 - h}" width="86" height="${h}" rx="6" fill="${i === 3 ? "#ff9f43" : "#ffffff"}" stroke="${i === 3 ? "#f08a24" : "#cfd9e6"}" stroke-width="2"/>${Array.from({ length: Math.floor(h / 26) }, (_, r) => `<line x1="${x + 10}" x2="${x + 76}" y1="${560 - h + 18 + r * 26}" y2="${560 - h + 18 + r * 26}" stroke="${i === 3 ? "#ffd2a3" : "#e3e9f1"}" stroke-width="3"/>`).join("")}</g>`).join("");
  return sceneFile(s, `
  .brand { position: absolute; left: 140px; top: 120px; display: flex; align-items: center; gap: 18px; }
  .brand span { font-size: 24px; font-weight: 800; letter-spacing: .28em; color: #0b1220; }
  .q { position: absolute; left: 140px; top: 330px; font-size: 76px; font-weight: 800; letter-spacing: -0.045em; line-height: 1.15; }
  .p { position: absolute; left: 140px; top: 560px; display: flex; align-items: baseline; gap: 22px; }
  .p .name { font-size: 64px; font-weight: 900; color: #2f7de1; letter-spacing: -0.04em; }
  .p .tag { font-size: 30px; font-weight: 600; color: #5b6678; }
  .art { position: absolute; right: 30px; top: 300px; width: 860px; height: 533px; }
  .chips { position: absolute; left: 140px; top: 720px; display: flex; gap: 14px; }`, `
      <div class="brand" id="s01-brand">${LOGO(58)}<span>JIRISO DATA STUDIO</span></div>
      <div class="q" id="s01-q">공동주택 설계변경,<br>승인해도 될까요?</div>
      <div class="p" id="s01-p"><span class="name">GeoBuild Impact 3D</span><span class="tag">설계변경 전후 영향 분석</span></div>
      <div class="chips" id="s01-chips"><span class="pill"><span class="sun">●</span> 직사일조</span><span class="pill"><span style="color:#5b6678">●</span> 그림자</span><span class="pill"><span class="blue">●</span> 동간 이격</span></div>
      <svg class="art" viewBox="-60 0 1100 620" data-layout-allow-overflow>
        <path id="s01-arc" d="M -20 520 Q 480 -120 1020 520" fill="none" stroke="#f2c14e" stroke-width="3" stroke-dasharray="8 12" opacity=".8"/>
        <circle id="s01-sun" cx="-20" cy="520" r="30" fill="#ffd36b" stroke="#f2a516" stroke-width="3"/>
        <ellipse cx="490" cy="566" rx="560" ry="16" fill="#dfe6ef"/>
        ${svgB}
      </svg>`, `
    tl.fromTo("#s01-brand", { y: -12 }, { y: 0, duration: 0.8, ease: "power3.out" }, 0);
    tl.fromTo("#s01-q", { y: 24 }, { y: 0, duration: 0.9, ease: "power3.out" }, 0);
    tl.fromTo("#s01-p", { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.7, ease: "power3.out" }, L[1] - 0.1);
    tl.fromTo("#s01-chips .pill", { y: 20, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, stagger: 0.12, ease: "power2.out" }, L[1] + 0.5);
    ${blocks.map((_, i) => `tl.fromTo("#s01-b${i}", { scaleY: 0.25, transformOrigin: "50% 100%" }, { scaleY: 1, transformOrigin: "50% 100%", duration: 0.9, ease: "power3.out" }, ${0.3 + i * 0.09});`).join("\n    ")}
    tl.to("#s01-b3", { x: -46, rotation: -4, transformOrigin: "50% 100%", duration: 1.4, ease: "power2.inOut" }, 2.6);
    const sun = { p: 0 }, el = document.querySelector("#s01-sun");
    tl.fromTo(sun, { p: 0 }, { p: 1, duration: D - 0.6, ease: "none", onUpdate: () => {
      const u = 0.12 + sun.p * 0.62, x = (1 - u) * (1 - u) * -20 + 2 * (1 - u) * u * 480 + u * u * 1020, y = (1 - u) * (1 - u) * 520 + 2 * (1 - u) * u * -120 + u * u * 520;
      el.setAttribute("cx", x); el.setAttribute("cy", y);
    } }, 0);`);
};

files.s02_problem = (s) => sceneFile(s, `
  .top { position: absolute; left: 160px; top: 110px; }
  .grid3 { position: absolute; left: 160px; right: 160px; top: 330px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 36px; }
  .grid3 .card { padding: 40px 40px 36px; height: 360px; display: flex; flex-direction: column; gap: 14px; }
  .k { font-size: 26px; font-weight: 700; color: #5b6678; display: flex; align-items: center; gap: 12px; }
  .v { font-size: 74px; font-weight: 900; letter-spacing: -0.04em; }
  .d { font-size: 28px; color: #5b6678; line-height: 1.4; margin-top: auto; }
  .guess { position: absolute; left: 0; right: 0; margin: 0 auto; width: fit-content; top: 770px; font-size: 34px; font-weight: 700; padding: 18px 34px; border-radius: 18px; background: #0b1220; color: #fff; display: flex; gap: 18px; align-items: center; }
  .guess s { text-decoration-thickness: 4px; text-decoration-color: #e2373c; color: #9fb0c8; }`, `
      <div class="top" id="s02-top"><div class="eyebrow">설계변경의 파급</div><div class="h1" style="font-size:58px;margin-top:14px">동 하나가 움직이면, 단지 전체가 달라집니다</div></div>
      <div class="grid3">
        <div class="card" id="s02-c0"><div class="k"><span class="sun">☀</span>외벽 직사일조</div><div class="v red"><span id="s02-n0">0</span>분</div><div class="d">한 수광점의 동지 하루 일조가<br>가장 크게 줄어든 폭</div></div>
        <div class="card" id="s02-c1"><div class="k"><span style="color:#5b6678">◼</span>새로 생긴 그늘</div><div class="v"><span id="s02-n1">0</span>m²</div><div class="d">변경안에서 음영 시간이 늘어난<br>단지 지표면 면적</div></div>
        <div class="card" id="s02-c2"><div class="k"><span class="blue">↔</span>동간 이격</div><div class="v"><span id="s02-n2">0</span>m</div><div class="d">107동 ↔ 105동 채광창 벽면 거리<br><b class="red">기준 65.0 m 미달</b></div></div>
      </div>
      <div class="guess" id="s02-g"><s>도면과 경험으로 짐작</s><span>→</span><span class="blue" style="color:#6cb2ff">계산으로 확인</span></div>`, `
    tl.fromTo("#s02-top", { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out" }, 0.1);
    [0, 1, 2].forEach((i) => tl.fromTo("#s02-c" + i, { y: 50, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out" }, L[1] + i * 0.55));
    num("#s02-n0", -205, L[1] + 0.2, 1.3, (v) => "−" + Math.abs(Math.round(v)));
    num("#s02-n1", 22560, L[1] + 0.75, 1.3);
    num("#s02-n2", 63.4, L[1] + 1.3, 1.3, (v) => v.toFixed(1));
    tl.fromTo("#s02-g", { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out" }, L[2]);`);

files.s03_flow = (s) => {
  const steps = [["도면 입력", "DXF · GeoJSON · SHP"], ["3D 확인·조정", "드래그 · 회전 · 층수"], ["전후 계산", "A 일조 · B 그림자 · C 이격"], ["검토 판정", "승인 가능 여부와 근거"], ["보고서", "PDF · 증거 패키지"]];
  return sceneFile(s, `
  .top { position: absolute; left: 160px; top: 140px; }
  .rail { position: absolute; left: 260px; right: 260px; top: 520px; height: 6px; border-radius: 3px; background: #dfe6ef; }
  .rail i { position: absolute; inset: 0; border-radius: 3px; background: linear-gradient(90deg, #6cb2ff, #2f7de1); transform-origin: 0 50%; }
  .st { position: absolute; top: 470px; width: 300px; margin-left: -150px; text-align: center; }
  .st .dot { width: 104px; height: 104px; margin: 0 auto; border-radius: 30px; display: grid; place-items: center; font-size: 40px; font-weight: 900; background: #fff; color: #2f7de1; border: 3px solid #2f7de1; box-shadow: 0 16px 40px -18px rgba(47,125,225,.7); }
  .st .t { margin-top: 26px; font-size: 32px; font-weight: 800; }
  .st .s { margin-top: 8px; font-size: 26px; color: #5b6678; }`, `
      <div class="top" id="s03-top"><div class="eyebrow">작업 흐름</div><div class="h1" style="font-size:58px;margin-top:14px">다섯 단계, 한 화면에서</div></div>
      <div class="rail"><i id="s03-fill"></i></div>
      ${steps.map(([a, b], i) => `<div class="st" id="s03-s${i}" style="left:${260 + i * 350}px"><div class="dot">${i + 1}</div><div class="t">${a}</div><div class="s">${b}</div></div>`).join("\n      ")}`, `
    tl.fromTo("#s03-top", { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out" }, 0.1);
    const step = (L[1] + ${S.s03_flow.lines[1].dur} - 0.6 - L[1]) / 5;
    tl.fromTo("#s03-fill", { scaleX: 0 }, { scaleX: 1, duration: step * 4 + 0.3, ease: "none" }, L[1]);
    for (let i = 0; i < 5; i++) tl.fromTo("#s03-s" + i, { y: 40, opacity: 0, scale: 0.9 }, { y: 0, opacity: 1, scale: 1, duration: 0.5, ease: "back.out(1.8)" }, L[1] - 0.25 + i * step);`);
};

files.s04_edit = (s) => recScene(s, "2", "3D 확인·조정", "끌어서 옮기면, 영향이 바로 계산됩니다", [
  { x: 1585, y: 120, text: "실시간 영향 미리보기", dot: "#2f7de1", at: s.lines[1].at + 0.4 },
  { x: 830, y: 470, text: "동간 거리 · 기준안 대비 변화", dot: "#e2373c", at: s.lines[2].at },
]);

files.s05_engine = (s) => {
  const pts = [0, 1, 2, 3, 4].map((i) => [610, 440 - i * 62]);
  return sceneFile(s, `
  .top { position: absolute; left: 160px; top: 90px; }
  .dia { position: absolute; left: 160px; top: 250px; width: 900px; height: 520px; }
  .cards { position: absolute; left: 1120px; right: 160px; top: 250px; display: flex; flex-direction: column; gap: 22px; }
  .cards .card { padding: 26px 32px; }
  .cards .k { font-size: 28px; font-weight: 800; color: #2f7de1; }
  .cards .v { font-size: 52px; font-weight: 900; letter-spacing: -0.04em; margin-top: 4px; }
  .cards .d { font-size: 26px; color: #5b6678; margin-top: 2px; }
  .lab { font-family: "Pretendard"; font-size: 26px; font-weight: 700; fill: #5b6678; }`, `
      <div class="top" id="s05-top"><div class="eyebrow">분석 엔진</div><div class="h1" style="font-size:54px;margin-top:12px">태양 위치 × 3D 광선추적, 실제로 계산합니다</div></div>
      <svg class="dia" viewBox="0 0 900 520" id="s05-dia">
        <rect x="0" y="0" width="900" height="520" rx="22" fill="#fff" stroke="#dfe6ef"/>
        <path d="M 40 470 Q 300 40 860 300" fill="none" stroke="#f2c14e" stroke-width="3" stroke-dasharray="8 10"/>
        <circle id="s05-sun" cx="200" cy="170" r="30" fill="#ffd36b" stroke="#f2a516" stroke-width="3"/>
        <text x="120" y="110" class="lab">NREL SPA · 동지 08–16시</text>
        ${pts.map(([x, y], i) => `<line id="s05-r${i}" x1="${x}" y1="${y}" x2="200" y2="170" stroke="${i < 2 ? "#e2373c" : "#2f7de1"}" stroke-width="3" stroke-dasharray="${i < 2 ? "6 6" : "0"}"/>`).join("")}
        <rect x="360" y="290" width="120" height="190" rx="6" fill="#ff9f43" stroke="#f08a24" stroke-width="2"/>
        <text x="420" y="400" class="lab" text-anchor="middle" style="fill:#fff">변경 동</text>
        <rect x="610" y="150" width="150" height="330" rx="6" fill="#f3f6fa" stroke="#9fb0c8" stroke-width="2"/>
        <text x="640" y="140" class="lab">수광 동</text>
        <line x1="20" x2="880" y1="480" y2="480" stroke="#9fb0c8" stroke-width="3"/>
        ${pts.map(([x, y], i) => `<circle id="s05-p${i}" cx="${x}" cy="${y}" r="9" fill="${i < 2 ? "#e2373c" : "#2f7de1"}" stroke="#fff" stroke-width="3"/>`).join("")}
        <text x="500" y="505" class="lab" id="s05-legend"><tspan fill="#2f7de1">━ 일조</tspan>   <tspan fill="#e2373c">┅ 가려짐 (원인 동 기록)</tspan></text>
      </svg>
      <div class="cards">
        <div class="card" id="s05-c0"><div class="k">A · 외벽 직사일조</div><div class="v"><span id="s05-n0">0</span></div><div class="d">수광점 2,698개 × 5분 간격 96시각 광선</div></div>
        <div class="card" id="s05-c1"><div class="k">B · 지표면 그림자</div><div class="v"><span id="s05-n1">0</span></div><div class="d">2 m 격자 20,774칸 × 96시각 광선</div></div>
        <div class="card" id="s05-c2"><div class="k">C · 동간 이격</div><div class="v"><span id="s05-n2">0</span>쌍</div><div class="d">주동 footprint 사이 수평 최단거리</div></div>
      </div>`, `
    tl.fromTo("#s05-top", { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out" }, 0.1);
    tl.fromTo("#s05-dia", { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.7, ease: "power3.out" }, 0.3);
    for (let i = 0; i < 5; i++) {
      tl.fromTo("#s05-r" + i, { opacity: 0 }, { opacity: 1, duration: 0.3 }, L[2] + i * 0.18);
      tl.fromTo("#s05-p" + i, { scale: 0, transformOrigin: "50% 50%" }, { scale: 1, duration: 0.35, ease: "back.out(2)" }, L[2] + i * 0.18);
    }
    tl.fromTo("#s05-legend", { opacity: 0 }, { opacity: 1, duration: 0.4 }, L[2] + 1.1);
    const sun = { p: 0 }, sel = document.querySelector("#s05-sun"), rays = [0, 1, 2, 3, 4].map((i) => document.querySelector("#s05-r" + i));
    tl.fromTo(sun, { p: 0 }, { p: 1, duration: L[2] - L[1] + 0.2, ease: "power1.inOut", onUpdate: () => {
      const u = 0.12 + sun.p * 0.28, x = (1 - u) * (1 - u) * 40 + 2 * (1 - u) * u * 300 + u * u * 860, y = (1 - u) * (1 - u) * 470 + 2 * (1 - u) * u * 40 + u * u * 300;
      sel.setAttribute("cx", x); sel.setAttribute("cy", y); rays.forEach((r) => { r.setAttribute("x2", x); r.setAttribute("y2", y); });
    } }, L[1]);
    [0, 1, 2].forEach((i) => tl.fromTo("#s05-c" + i, { x: 40, opacity: 0 }, { x: 0, opacity: 1, duration: 0.55, ease: "power3.out" }, (i < 2 ? L[2] : L[3]) + (i === 1 ? 0.9 : 0.1)));
    num("#s05-n0", 267648, L[2] + 0.3, 1.6);
    num("#s05-n1", 3988608, L[2] + 1.0, 1.8);
    num("#s05-n2", 21, L[3] + 0.3, 0.8);`);
};

files.s06_facade = (s) => recScene(s, "A", "외벽 직사일조", "붉을수록 일조가 줄어든 외벽입니다", [
  { x: 1580, y: 840, text: "시간대별 일조 0/1 · 차폐 원인 동", dot: "#2f7de1", at: s.lines[1].at + 1.2 },
]);
files.s07_shadow = (s) => recScene(s, "B", "지표면 그림자", "시간대별 그늘 변화를 재생합니다", [
  { x: 380, y: 140, text: "새로 생긴 그늘", dot: "#e2373c", at: s.lines[1].at },
  { x: 380, y: 196, text: "사라진 그늘", dot: "#2f7de1", at: s.lines[1].at + 0.5 },
]);
files.s08_verdict = (s) => recScene(s, "4", "검토 판정", "승인할 수 있는지, 근거와 함께", [
  { x: 1170, y: 70, text: "판정 한 문장", dot: "#e2373c", at: s.lines[0].at + 0.6, until: s.lines[1].at + 0.8 },
  { x: 1060, y: 140, text: "법정 이격 기준 검토", dot: "#2f7de1", at: s.lines[1].at + 2.0 },
]);

files.s09_report = (s) => {
  const pages = ["p01", "p02", "p06", "p17", "p21", "p25"];
  return sceneFile(s, `
  .top { position: absolute; left: 160px; top: 110px; width: 640px; }
  .pg { position: absolute; left: 1060px; top: 160px; width: 520px; border-radius: 10px; box-shadow: 0 30px 60px -28px rgba(10,30,70,.55), 0 0 0 1px rgba(15,35,70,.1); transform-origin: 50% 110%; }
  .dl { position: absolute; left: 160px; width: 640px; display: flex; align-items: center; gap: 22px; padding: 26px 30px; }
  .dl .ic { width: 64px; height: 64px; border-radius: 18px; display: grid; place-items: center; font-weight: 900; font-size: 20px; color: #fff; }
  .dl .t { font-size: 30px; font-weight: 800; }
  .dl .s { font-size: 26px; color: #5b6678; margin-top: 4px; }`, `
      <div class="top" id="s09-top"><div class="eyebrow"><b>5</b>보고서</div><div class="h1" style="font-size:56px;margin-top:14px">판정 근거가 그대로<br>기술보고서가 됩니다</div></div>
      <div class="card dl" id="s09-d0" style="top:470px"><div class="ic" style="background:#2f7de1">PDF</div><div><div class="t">상세 기술보고서 39쪽</div><div class="s">검토 의견서 · 표 · 지도 · 3D 캡처 · 재현 정보</div></div></div>
      <div class="card dl" id="s09-d1" style="top:640px"><div class="ic" style="background:#0b1220">ZIP</div><div><div class="t">증거 패키지</div><div class="s">CSV · GeoJSON · JSON 원자료, 해시로 재현 확인</div></div></div>
      ${pages.map((p, i) => `<img id="s09-p${i}" class="pg" src="assets/pdf/${p}.png" style="z-index:${10 - i}">`).join("\n      ")}`, `
    tl.fromTo("#s09-top", { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out" }, 0.1);
    for (let i = 0; i < 6; i++) tl.fromTo("#s09-p" + i, { y: 500, rotation: 0, x: 0, opacity: 0 }, { y: 0, opacity: 1, rotation: (i - 2.5) * 6, x: (i - 2.5) * 70, duration: 0.9, ease: "power3.out" }, 0.4 + i * 0.12);
    tl.fromTo("#s09-p0", { scale: 1 }, { scale: 1.06, duration: 2, ease: "power1.inOut" }, L[1]);
    tl.fromTo("#s09-d0", { x: -40, opacity: 0 }, { x: 0, opacity: 1, duration: 0.55, ease: "power3.out" }, L[1] - 0.1);
    tl.fromTo("#s09-d1", { x: -40, opacity: 0 }, { x: 0, opacity: 1, duration: 0.55, ease: "power3.out" }, L[1] + 0.9);`);
};

files.s10_verify = (s) => sceneFile(s, `
  .top { position: absolute; left: 160px; top: 120px; }
  .g { position: absolute; left: 160px; right: 160px; top: 360px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 30px; }
  .g .card { padding: 36px 32px; height: 330px; display: flex; flex-direction: column; }
  .g .v { font-size: 76px; font-weight: 900; letter-spacing: -0.045em; color: #2f7de1; }
  .g .k { font-size: 26px; font-weight: 800; margin-top: 10px; }
  .g .d { font-size: 26px; color: #5b6678; margin-top: auto; line-height: 1.4; }
  .ok { display: inline-flex; gap: 8px; align-items: center; font-size: 26px; font-weight: 800; color: #12a150; }`, `
      <div class="top" id="s10-top"><div class="eyebrow">독립 검증</div><div class="h1" style="font-size:58px;margin-top:14px">숫자를 믿을 수 있도록</div></div>
      <div class="g">
        <div class="card" id="s10-c0"><span class="ok">✔ PASS</span><div class="v"><span id="s10-n0">0</span> cm</div><div class="k">기둥 그림자 해석해</div><div class="d">L = H / tan α 와 광선 결과<br>55.55 m vs 55.54 m</div></div>
        <div class="card" id="s10-c1"><span class="ok">✔ PASS</span><div class="v">&lt;<span id="s10-n1">0</span>°</div><div class="k">태양 위치</div><div class="d">NREL SPA와 별도 구현 NOAA<br>1년 비교 최대 차이</div></div>
        <div class="card" id="s10-c2"><span class="ok">✔ PASS</span><div class="v"><span id="s10-n2">0</span>%</div><div class="k">엔진 교차검증</div><div class="d">Open3D vs 독립 float64 엔진<br>차폐 여부·원인 동 일치율</div></div>
        <div class="card" id="s10-c3"><span class="ok">✔ PASS</span><div class="v"><span id="s10-n3">0</span></div><div class="k">자동 테스트</div><div class="d">단위·기하·API·보고서<br>83개 모두 통과</div></div>
      </div>`, `
    tl.fromTo("#s10-top", { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out" }, 0.1);
    [0, 1, 2, 3].forEach((i) => tl.fromTo("#s10-c" + i, { y: 50, opacity: 0 }, { y: 0, opacity: 1, duration: 0.55, ease: "power3.out" }, [L[1], L[1] + 2.6, L[1] + 4.6, L[2]][i]));
    num("#s10-n0", 1, L[1] + 0.2, 0.6);
    num("#s10-n1", 0.05, L[1] + 2.8, 0.8, (v) => v.toFixed(2));
    num("#s10-n2", 100, L[1] + 4.8, 0.9);
    num("#s10-n3", 83, L[2] + 0.2, 1.0);`);

files.s11_end = (s) => sceneFile(s, `
  .c { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 30px; }
  .mark { display: flex; align-items: center; gap: 28px; }
  .mark span { font-size: 64px; font-weight: 900; letter-spacing: .2em; }
  .tag { font-size: 34px; font-weight: 600; color: #5b6678; }
  .url { font-size: 30px; font-weight: 700; color: #2f7de1; padding: 14px 28px; border-radius: 999px; background: #fff; border: 1px solid #dfe6ef; }
  .disc { position: absolute; left: 0; right: 0; bottom: 170px; text-align: center; font-size: 26px; color: #7b889b; }`, `
      <div class="c">
        <div class="tag" id="s11-tag">설계변경 검토, 이제 계산으로 판단하세요</div>
        <div class="mark" id="s11-mark">${LOGO(104)}<span>JIRISO DATA STUDIO</span></div>
        <div class="url" id="s11-url">GeoBuild Impact 3D · github.com/yeonjun7724/geobuild-impact-3d</div>
      </div>
      <div class="disc" id="s11-disc">가상 PoC · 인천계양 A2블록 주변을 배경으로 한 가상 단지이며 실제 LH 설계안·인허가 검토가 아닙니다</div>`, `
    tl.fromTo("#s11-tag", { y: 20, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out" }, 0.2);
    tl.fromTo("#s11-mark", { scale: 0.92, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.9, ease: "power3.out" }, L[1] - 0.4);
    tl.fromTo("#s11-url", { y: 20, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out" }, L[1] + 0.6);
    tl.fromTo("#s11-disc", { opacity: 0 }, { opacity: 1, duration: 0.6 }, L[1] + 1.0);`);

for (const s of plan) writeFileSync(join(HF, "compositions", `${s.id}.html`), files[s.id](s));

/* ---------------------------------------------------------------- root */
const hosts = plan.map((s) => `      <div id="${s.id}" data-composition-id="${s.id}" data-composition-src="compositions/${s.id}.html" data-start="${s.start}" data-duration="${s.dur}" data-track-index="1" data-track-kind="graphics" data-width="1920" data-height="1080"></div>`).join("\n");
const vo = plan.flatMap((s) => s.lines.map((l, i) => `      <audio id="vo-${s.id}-${i}" src="${l.file}" data-start="${r1(s.start + l.at)}" data-duration="${l.dur}" data-track-index="3" data-volume="1"></audio>`)).join("\n");
writeFileSync(join(HF, "index.html"), `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
    <style>
      ${FONT}
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #f3f6fa; }
      #root { width: 100%; height: 100%; font-family: "Pretendard", sans-serif;
              background: radial-gradient(1200px 700px at 85% -10%, #e3eefc 0%, rgba(227,238,252,0) 60%), radial-gradient(900px 600px at -5% 110%, #e8f3ee 0%, rgba(232,243,238,0) 60%), #f3f6fa; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${TOTAL}" data-width="1920" data-height="1080">
${hosts}
${vo}
    </div>
    <script>
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`);

/* ---------------------------------------------------------------- subtitles + timeline for post */
const ts = (x) => { const h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60), s = x % 60; return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`; };
const ev = plan.flatMap((s) => s.lines.map((l) => {
  const a = s.start + l.at - 0.08, b = s.start + l.at + l.dur + 0.12;
  return `Dialogue: 0,${ts(a)},${ts(b)},Sub,,0,0,0,,{\\fad(120,120)}${l.sub.replace(/\|/g, "\\N")}`;
}));
mkdirSync(join(HF, "../post"), { recursive: true });
writeFileSync(join(HF, "../post/subs.ass"), `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,Pretendard SemiBold,40,&H00FFFFFF,&H00FFFFFF,&H00201208,&HB0201208,0,0,0,0,100,100,0,0,3,14,0,2,200,200,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${ev.join("\n")}
`);
writeFileSync(join(HF, "../post/timeline.json"), JSON.stringify({ total: TOTAL, context: CTX, scenes: plan.map(({ id, start, dur, rec }) => ({ id, start, dur, rec })) }, null, 1));
console.log(plan.map((s) => `${s.id.padEnd(12)} ${s.start.toFixed(2).padStart(7)} +${s.dur.toFixed(2)}${s.rec ? `  rec x${s.rec.rate}` : ""}`).join("\n"), `\nTOTAL ${TOTAL}s`);
