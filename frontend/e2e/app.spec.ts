/* Full user workflow in a real browser: create project -> Cesium scene -> edit variant B -> A/B/C job -> compare -> report -> PDF. */
import { expect, test } from "@playwright/test";

const SHOTS = "../docs/screenshots";

test("GeoBuild Impact 3D end-to-end", async ({ page, request }) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  // 1. project list + create (virtual sample loader)
  await page.goto("/projects");
  await expect(page.getByText("프로젝트", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("system-status")).toContainText("Chromium OK", { timeout: 60_000 });
  await page.getByTestId("create-project").click();
  await page.waitForURL(/\/projects\/[0-9a-f]{12}$/, { timeout: 120_000 });
  const projectId = page.url().split("/").pop()!;

  // 2. Cesium scene renders (WebGL canvas, no fallback message)
  const canvas = page.locator(".cesium-widget canvas").first();
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("WebGL을 사용할 수 없어")).toHaveCount(0);
  await expect(page.getByText("합성 30m DEM (실제 지형 아님)").first()).toBeVisible();
  await expect(page.getByText("실제 LH 설계안, 인허가 검토, 공식 성능평가 결과가 아님").first()).toBeVisible();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${SHOTS}/01_workspace_overlay.png` });

  // 3. edit variant B (building 101: move east 8 m) -> saved with new revision; A stays locked
  await page.getByRole("button", { name: "101", exact: true }).click();
  const dx = page.getByRole("spinbutton", { name: /동서 이동/ });
  await dx.fill("8");
  await expect(page.getByText(/B 저장됨/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "좌우 분할 (동기화)" }).click();
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${SHOTS}/02_workspace_split_after_edit.png` });
  const proj = await (await request.get(`/api/projects/${projectId}`)).json();
  const b = proj.scenarios.find((s: any) => s.code === "B");
  expect(b.transforms["101"].dx).toBe(8);
  expect(proj.scenarios.find((s: any) => s.code === "A").locked).toBe(true);

  // 4. analysis job (A/B/C) through the job queue
  await page.getByTestId("go-analysis").click();
  await page.waitForURL(/analysis$/);
  await page.getByTestId("run-analysis").click();
  const status = page.getByTestId("run-status");
  await expect(status).toContainText("SUCCEEDED", { timeout: 10 * 60_000 });
  await page.screenshot({ path: `${SHOTS}/03_analysis_succeeded.png` });
  const backend = await status.textContent();
  console.log("job backend line:", backend?.match(/작업 백엔드: \S+/)?.[0]);

  // 5. compare view A / B / C
  await page.getByTestId("open-compare").click();
  await page.waitForURL(/compare\//);
  const runId = page.url().split("/").pop()!;
  await expect(page.locator(".cesium-widget canvas").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("일조 감소 상위 수광점")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(6000);
  await page.locator("table.tbl tbody tr").first().click();
  await expect(page.getByText(/B에서 잃은 구간/)).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/04_compare_A_sunlight_split.png` });
  await page.getByRole("tab", { name: "B 그림자" }).click();
  await page.getByRole("button", { name: "오버레이" }).click();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${SHOTS}/05_compare_B_shadow_delta.png` });
  await page.getByRole("combobox", { name: /격자 표시 지표/ }).selectOption("12:00");
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${SHOTS}/06_compare_B_snapshot_1200.png` });
  await page.getByRole("tab", { name: "C 이격" }).click();
  await page.getByRole("button", { name: "좌우 분할" }).click();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${SHOTS}/07_compare_C_clearance.png` });

  // 6. persistence across reload
  await page.reload();
  await expect(page.getByText("일조 감소 상위 수광점")).toBeVisible({ timeout: 60_000 });

  // 7. report generation + downloads
  await page.getByTestId("go-report").click();
  await page.waitForURL(/\/reports\//);
  await page.getByTestId("generate-report").click();
  await expect(page.getByTestId("dl-pdf")).toBeVisible({ timeout: 10 * 60_000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${SHOTS}/08_report_view.png` });
  const href = await page.getByTestId("dl-pdf").getAttribute("href");
  const pdf = await request.get(href!);
  expect(pdf.status()).toBe(200);
  const body = await pdf.body();
  expect(body.subarray(0, 4).toString()).toBe("%PDF");
  expect(body.length).toBeGreaterThan(100_000);
  const zhref = await page.getByTestId("dl-zip").getAttribute("href");
  const zip = await request.get(zhref!);
  expect(zip.status()).toBe(200);
  console.log(`E2E OK project=${projectId} run=${runId} pdf_bytes=${body.length} zip_bytes=${(await zip.body()).length}`);
  expect(consoleErrors.filter((e) => !/ResizeObserver/.test(e))).toEqual([]);
});
