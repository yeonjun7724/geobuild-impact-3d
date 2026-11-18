import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 25 * 60 * 1000,
  reporter: [["list"], ["json", { outputFile: "../docs/qa/playwright-results.json" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173",
    viewport: { width: 1600, height: 960 },
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] },
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  },
});
