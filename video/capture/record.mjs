/* Screen recordings of the real app for the explainer video.
 *
 * - Chrome (installed channel) headless with GPU (D3D11) -> smooth Cesium rendering.
 * - Frames come from the DevTools screencast (JPEG q92 with timestamps), not Playwright's recordVideo,
 *   then FFmpeg assembles them into constant-30 fps H.264 clips.
 * - Headless captures have no pointer, so a visible cursor is injected and follows real input events.
 *
 * Usage (from repo root, app running on :5173 / API on :8000):
 *   node video/capture/record.mjs            # prepares demo projects, records all clips
 *   node video/capture/record.mjs edit facade # only some clips
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, "../../frontend/package.json"));
const { chromium } = require("@playwright/test");

const WEB = process.env.WEB ?? "http://127.0.0.1:5173";
const API = process.env.API ?? "http://127.0.0.1:8000";
const OUT = resolve(here, "../hf/assets/rec");
const FRAMES = resolve(here, "frames");
const W = 1920, H = 1080;
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, body) {
  const r = await fetch(API + path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`);
  return j;
}
async function waitStatus(path) {
  for (;;) { const j = await api("GET", path); if (["SUCCEEDED", "FAILED"].includes(j.status)) return j; await sleep(3000); }
}

/** Two fresh demo projects: one to edit on camera, one analysed + reported for the result clips. */
async function prepare() {
  const edit = await api("POST", "/api/projects", { name: "인천계양 A2 인근 가상단지 · 설계변경 요청 검토", seed_demo: true });
  const res = await api("POST", "/api/projects", { name: "인천계양 A2 인근 가상단지 · 설계변경 요청 검토 (결과)", seed_demo: true });
  let run = await api("POST", `/api/projects/${res.id}/analyses`, { analysis_type: "ALL", reuse_cache: false });
  run = await waitStatus(`/api/analyses/${run.id}`);
  if (run.status !== "SUCCEEDED") throw new Error("analysis failed: " + run.error);
  let rp = await api("POST", `/api/analyses/${run.id}/reports`);
  rp = await waitStatus(`/api/reports/${rp.id}`);
  if (rp.status !== "SUCCEEDED") throw new Error("report failed: " + rp.error);
  const ctx = { editProject: edit.id, resultProject: res.id, run: run.id, report: rp.id };
  writeFileSync(join(OUT, "context.json"), JSON.stringify(ctx, null, 2));
  console.log("prepared", ctx);
  return ctx;
}

const CURSOR = () => {
  const install = () => {
    if (document.getElementById("__demo_cursor")) return;
    const c = document.createElement("div");
    c.id = "__demo_cursor";
    c.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24"><path d="M4 2.5 L4 19 L8.6 14.8 L11.6 21.5 L14.4 20.3 L11.4 13.7 L17.6 13.7 Z" fill="#fff" stroke="#0b1220" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: "fixed", left: "-100px", top: "-100px", zIndex: 2147483647, pointerEvents: "none", transition: "transform .08s", filter: "drop-shadow(0 2px 3px rgba(0,0,0,.5))" });
    const ring = document.createElement("div");
    Object.assign(ring.style, { position: "fixed", width: "34px", height: "34px", borderRadius: "50%", border: "3px solid #5aa6ff", zIndex: 2147483646, pointerEvents: "none", opacity: "0", transform: "translate(-50%,-50%) scale(.4)", transition: "opacity .25s, transform .25s" });
    document.body.append(ring, c);
    addEventListener("mousemove", (e) => { c.style.left = e.clientX - 4 + "px"; c.style.top = e.clientY - 2 + "px"; ring.style.left = e.clientX + "px"; ring.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => { c.style.transform = "scale(.85)"; ring.style.opacity = "1"; ring.style.transform = "translate(-50%,-50%) scale(1)"; }, true);
    addEventListener("mouseup", () => { c.style.transform = ""; ring.style.opacity = "0"; ring.style.transform = "translate(-50%,-50%) scale(.4)"; }, true);
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", install); else install();
};

async function withRecording(page, name, fn) {
  if (process.env.NOREC) return fn();
  const dir = join(FRAMES, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const file = join(dir, `f${String(frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, t: metadata.timestamp });
    try { await cdp.send("Page.screencastFrameAck", { sessionId }); } catch { /* page closing */ }
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  const t0 = Date.now() / 1000;
  await fn();
  const t1 = Date.now() / 1000;
  await cdp.send("Page.stopScreencast");
  await sleep(300);
  // concat list with real frame durations; the last frame holds until the end of the action
  const lines = ["ffconcat version 1.0"];
  for (let i = 0; i < frames.length; i++) {
    const end = i + 1 < frames.length ? frames[i + 1].t : Math.max(frames[i].t + 0.04, t1 - t0 + frames[0].t);
    lines.push(`file '${frames[i].file.replace(/\\/g, "/")}'`, `duration ${Math.max(0.001, end - frames[i].t).toFixed(4)}`);
  }
  lines.push(`file '${frames[frames.length - 1].file.replace(/\\/g, "/")}'`);
  const list = join(dir, "list.ffconcat");
  writeFileSync(list, lines.join("\n"));
  const out = join(OUT, `${name}.mp4`);
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
    "-vf", `fps=30,scale=${W}:${H}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", "15", "-movflags", "+faststart", out]);
  const dur = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]).toString().trim();
  console.log(`recorded ${name}: ${frames.length} frames -> ${out} (${Number(dur).toFixed(1)} s)`);
}

/** Smooth human-like pointer path. */
async function glide(page, from, to, ms = 900, steps = 45) {
  for (let i = 1; i <= steps; i++) {
    const k = i / steps, e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    await page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
    await sleep(ms / steps);
  }
}
const toScreen = (page, x, y, z, viewer = 0) => page.evaluate(([x, y, z, i]) => window.__geobuild.viewers[i].toScreen(x, y, z), [x, y, z, viewer]);

const CLIPS = {
  /** 3D direct editing: select, drag, live clearance + impact preview, rotate, undo. */
  async edit(page, ctx) {
    // always start from the untouched seeded design
    try { await api("DELETE", `/api/projects/${ctx.editProject}`); } catch { /* already gone */ }
    ctx.editProject = (await api("POST", "/api/projects", { name: "인천계양 A2 인근 가상단지 · 설계변경 요청 검토", seed_demo: true })).id;
    writeFileSync(join(OUT, "context.json"), JSON.stringify(ctx, null, 2));
    const scene = await api("GET", `/api/projects/${ctx.editProject}/scene?scenario=B`);
    const b = scene.buildings.find((x) => x.id === "104");
    await page.goto(`${WEB}/projects/${ctx.editProject}`);
    await page.getByTestId("live-preview").waitFor({ timeout: 90000 });
    await sleep(7000);
    await page.mouse.move(W / 2, H / 2);
    await withRecording(page, "edit", async () => {
      await sleep(1200);
      const p0 = await toScreen(page, b.centroid[0], b.centroid[1], (b.height_m * 0.45));
      await glide(page, { x: W / 2, y: H / 2 }, p0, 1000);
      await sleep(400);
      await page.mouse.move(p0.x + 1, p0.y); await sleep(300);
      await page.mouse.down();
      const p1 = await toScreen(page, b.centroid[0] - 14, b.centroid[1] - 10, (b.height_m * 0.45));
      await glide(page, p0, p1, 2600, 80);
      await page.mouse.up();
      await sleep(2600); // live preview recomputes
      await page.keyboard.press("Shift+Q"); await sleep(500);
      await page.keyboard.press("Shift+Q"); await sleep(1800);
      await page.keyboard.press("]"); await sleep(2600);
      await glide(page, p1, { x: 1600, y: 300 }, 900);
      await sleep(2500);
    });
  },
  /** A: facade sunlight tiles, click a receiver for its hourly 0/1 + cause. */
  async facade(page, ctx) {
    const sun = await api("GET", `/api/analyses/${ctx.run}/sunlight`);
    const pad = (await api("GET", `/api/analyses/${ctx.run}/scene`)).pad_z;
    const w = sun.summary.worst_receivers[0];
    const r = sun.receivers.find((x) => x.receiver_id === w.receiver_id);
    await page.goto(`${WEB}/projects/${ctx.resultProject}/compare/${ctx.run}`);
    await page.getByTestId("review-verdict").waitFor({ timeout: 90000 });
    await page.getByRole("button", { name: "A 일조", exact: true }).click();
    await page.getByRole("group", { name: "비교 보기" }).getByRole("button", { name: "B", exact: true }).click();
    await sleep(9000);
    await page.mouse.move(W / 2, H * 0.7);
    await withRecording(page, "facade", async () => {
      await sleep(1500);
      const p = await toScreen(page, r.x_b + r.nx_b * 0.3, r.y_b + r.ny_b * 0.3, r.z_b - pad);
      await glide(page, { x: W / 2, y: H * 0.7 }, p, 1200);
      await sleep(300);
      await page.mouse.click(p.x, p.y);
      await page.getByTestId("receiver-detail").waitFor({ timeout: 20000 });
      await sleep(1200);
      await glide(page, p, { x: 1560, y: 520 }, 1100);
      await sleep(4000);
    });
  },
  /** B: computed shade time-lapse synced with the timeline. */
  async timelapse(page, ctx) {
    await page.goto(`${WEB}/projects/${ctx.resultProject}/compare/${ctx.run}`);
    await page.getByTestId("review-verdict").waitFor({ timeout: 90000 });
    await page.getByRole("button", { name: "B 그림자", exact: true }).click();
    await page.getByRole("group", { name: "비교 보기" }).getByRole("button", { name: "오버레이", exact: true }).click();
    await page.getByTestId("live-shadow").waitFor({ timeout: 60000 });
    const slider = page.getByRole("slider", { name: "시각 (KST)" });
    await slider.fill("540"); // 09:00
    await page.getByRole("combobox", { name: "재생 속도" }).selectOption("2");
    await sleep(9000);
    await page.mouse.move(W / 2, H / 2);
    await withRecording(page, "timelapse", async () => {
      await sleep(800);
      const play = await page.getByTestId("play").boundingBox();
      await glide(page, { x: W / 2, y: H / 2 }, { x: play.x + play.width / 2, y: play.y + play.height / 2 }, 900);
      await page.mouse.click(play.x + play.width / 2, play.y + play.height / 2);
      await page.mouse.move(W * 0.62, H * 0.45);
      await sleep(13000);
      await page.getByTestId("play").click();
      await sleep(1200);
    });
  },
  /** Review verdict: expand a finding, then the statutory tab. */
  async verdict(page, ctx) {
    await page.goto(`${WEB}/projects/${ctx.resultProject}/compare/${ctx.run}`);
    await page.getByTestId("review-verdict").waitFor({ timeout: 90000 });
    await sleep(8000);
    await page.mouse.move(W / 2, H / 2);
    await withRecording(page, "verdict", async () => {
      await sleep(1500);
      const card = page.getByTestId("review-items").getByRole("button", { expanded: false }).first();
      const bb = await card.boundingBox();
      await glide(page, { x: W / 2, y: H / 2 }, { x: bb.x + bb.width * 0.4, y: bb.y + 18 }, 1100);
      await card.click();
      await sleep(3200);
      const legal = page.getByRole("button", { name: "법정", exact: true });
      const lb = await legal.boundingBox();
      await glide(page, { x: bb.x + bb.width * 0.4, y: bb.y + 18 }, { x: lb.x + lb.width / 2, y: lb.y + lb.height / 2 }, 1100);
      await legal.click();
      await sleep(5000);
    });
  },
  /** Report: the HTML snapshot scrolling, download cards. */
  async report(page, ctx) {
    await page.goto(`${WEB}/reports/${ctx.run}`);
    await page.getByTestId("dl-pdf").waitFor({ timeout: 60000 });
    await sleep(5000);
    await page.mouse.move(1200, 540);
    await withRecording(page, "report", async () => {
      await sleep(1200);
      for (let i = 0; i < 22; i++) { await page.mouse.wheel(0, 260); await sleep(260); }
      await sleep(600);
      const pdf = await page.getByTestId("dl-pdf").boundingBox();
      await glide(page, { x: 1200, y: 540 }, { x: pdf.x + pdf.width / 2, y: pdf.y + pdf.height / 2 }, 1200);
      await sleep(2500);
    });
  },
};

const wanted = process.argv.slice(2).filter((a) => CLIPS[a]);
let ctx;
try { ctx = JSON.parse((await import("node:fs")).readFileSync(join(OUT, "context.json"), "utf8")); } catch { ctx = null; }
if (!ctx || process.argv.includes("--prepare")) ctx = await prepare();
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1, locale: "ko-KR", timezoneId: "Asia/Seoul" });
if (!process.env.NOCURSOR) await page.addInitScript(CURSOR);
for (const name of wanted.length ? wanted : Object.keys(CLIPS)) {
  try { await CLIPS[name](page, ctx); } catch (e) { console.error(`clip ${name} failed:`, e.message); }
}
await browser.close();
