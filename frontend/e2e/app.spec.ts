/* Full user workflow in a real browser: create project -> 3D editing (live preview) -> A/B/C job -> compare (time-lapse) -> report -> PDF. */
import { expect, test } from "@playwright/test";

const SHOTS = "../docs/screenshots";

test("GeoBuild Impact 3D end-to-end", async ({ page, request }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  // 1. project list + create (virtual sample loader)
  await page.goto("/projects");
  await expect(page.getByTestId("system-status")).toContainText("Chromium OK", { timeout: 60_000 });
  await page.screenshot({ path: `${SHOTS}/01_projects.png` });
  await page.getByTestId("create-project").click();
  await page.waitForURL(/\/projects\/[0-9a-f]{12}$/, { timeout: 120_000 });
  const projectId = page.url().split("/").pop()!;

  // 2. Cesium scene + live impact preview + data status / disclaimer
  await expect(page.locator(".cesium-widget canvas").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("WebGL을 사용할 수 없어")).toHaveCount(0);
  await expect(page.getByTestId("live-preview")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText("실제 LH 설계안, 인허가 검토, 공식 성능평가 결과가 아님").first()).toBeVisible();
  await page.waitForTimeout(8000);
  await page.screenshot({ path: `${SHOTS}/02_workspace_edit.png` });

  // 3. edit variant B (building 101: move east 8 m) -> saved; A stays locked; preview refreshes
  await page.getByRole("button", { name: "101", exact: true }).click();
  const dx = page.getByRole("spinbutton", { name: /동서 이동/ });
  await dx.fill("8");
  await dx.press("Enter");
  await expect.poll(async () => (await (await request.get(`/api/projects/${projectId}`)).json()).scenarios.find((s: any) => s.code === "B").transforms["101"]?.dx, { timeout: 30_000 }).toBe(8);
  const proj = await (await request.get(`/api/projects/${projectId}`)).json();
  expect(proj.scenarios.find((s: any) => s.code === "A").locked).toBe(true);
  // keyboard nudge + undo
  await page.keyboard.press("ArrowUp");
  await expect.poll(async () => (await (await request.get(`/api/projects/${projectId}`)).json()).scenarios.find((s: any) => s.code === "B").transforms["101"]?.dy, { timeout: 30_000 }).toBe(1);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await (await request.get(`/api/projects/${projectId}`)).json()).scenarios.find((s: any) => s.code === "B").transforms["101"]?.dy ?? 0, { timeout: 30_000 }).toBe(0);
  await page.getByRole("button", { name: "좌우 분할" }).click();
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${SHOTS}/03_workspace_split.png` });

  // 4. analysis job (A/B/C) through the job queue
  await page.getByTestId("go-analysis").click();
  await page.waitForURL(/analysis$/);
  await page.getByTestId("run-analysis").click();
  const status = page.getByTestId("run-status");
  await expect(status).toContainText("SUCCEEDED", { timeout: 10 * 60_000 });
  await page.screenshot({ path: `${SHOTS}/04_analysis_succeeded.png` });
  console.log("job backend:", (await status.textContent())?.match(/작업 백엔드 \S+/)?.[0]);

  // 5. compare: summary -> A facade tiles + receiver drill-down -> B time-lapse -> C clearance
  await page.getByTestId("open-compare").click();
  await page.waitForURL(/compare\//);
  const runId = page.url().split("/").pop()!;
  await expect(page.getByTestId("summary-kpis")).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(8000);
  await page.screenshot({ path: `${SHOTS}/05_compare_summary.png` });
  await page.getByRole("button", { name: "A 일조" }).click();
  await page.getByTestId("toggle-tables").click();
  await page.locator("table.tbl tbody tr").first().click();
  await expect(page.getByTestId("receiver-detail")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("toggle-tables").click();
  await page.getByRole("button", { name: "오버레이" }).click();
  await page.waitForTimeout(8000);
  await page.screenshot({ path: `${SHOTS}/06_compare_A_facade.png` });
  await page.getByRole("button", { name: "B 그림자" }).click();
  await expect(page.getByTestId("live-shadow")).toBeVisible({ timeout: 60_000 });
  const before = await page.getByTestId("live-shadow").textContent();
  await page.getByRole("button", { name: "30분 앞으로" }).click();
  await page.getByRole("button", { name: "30분 앞으로" }).click();
  await expect.poll(async () => page.getByTestId("live-shadow").textContent(), { timeout: 15_000 }).not.toBe(before);
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${SHOTS}/07_compare_B_timelapse.png` });
  await page.getByRole("button", { name: "C 이격" }).click();
  await page.getByRole("button", { name: "분할" }).click();
  await page.waitForTimeout(7000);
  await page.screenshot({ path: `${SHOTS}/08_compare_C_clearance.png` });

  // 6. persistence across reload
  await page.reload();
  await expect(page.getByTestId("summary-kpis")).toBeVisible({ timeout: 60_000 });

  // 7. report generation + downloads
  await page.getByTestId("go-report").click();
  await page.waitForURL(/\/reports\//);
  await page.getByTestId("generate-report").click();
  await expect(page.getByTestId("dl-pdf")).toBeVisible({ timeout: 10 * 60_000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${SHOTS}/09_report.png` });
  const pdf = await request.get((await page.getByTestId("dl-pdf").getAttribute("href"))!);
  expect(pdf.status()).toBe(200);
  const body = await pdf.body();
  expect(body.subarray(0, 4).toString()).toBe("%PDF");
  expect(body.length).toBeGreaterThan(100_000);
  const zip = await request.get((await page.getByTestId("dl-zip").getAttribute("href"))!);
  expect(zip.status()).toBe(200);
  console.log(`E2E OK project=${projectId} run=${runId} pdf_bytes=${body.length} zip_bytes=${(await zip.body()).length}`);
  expect(pageErrors.filter((e) => !/ResizeObserver/.test(e))).toEqual([]);
});
