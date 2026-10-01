import { existsSync } from "node:fs";
import { defineConfig, devices, webkit } from "@playwright/test";

const webkitPath = process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE ?? webkit.executablePath();

export default defineConfig({
  testDir: "tests/e2e",
  use: { baseURL: "http://127.0.0.1:5173" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "android-chrome", use: { ...devices["Pixel 7"] } },
    ...(process.env.CI || existsSync(webkitPath) ? [{ name: "iphone-safari", use: {
      ...devices["iPhone 13"],
      ...(process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE ? { launchOptions: { executablePath: webkitPath } } : {}),
    } }] : []),
  ],
  webServer: {
    command: "npm run dev:web",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
  },
});
