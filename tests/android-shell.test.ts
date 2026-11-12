import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apiUrl, jpegFile } from "../web/src/api.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("android shell", () => {
  it("keeps browser calls on the same origin and points a packaged build at Fly", () => {
    expect(apiUrl("/api/enrich")).toBe("/api/enrich");
    expect(apiUrl("/api/covers", "https://shelf-scanner.fly.dev/")).toBe("https://shelf-scanner.fly.dev/api/covers");
  });

  it("keeps a camera frame as a File so the native HTTP body is the JPEG", () => {
    const file = jpegFile(new Blob([Uint8Array.from([255, 216, 255])], { type: "image/jpeg" }), "strip.jpg");
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("strip.jpg");
    expect(file.type).toBe("image/jpeg");
    expect(file.size).toBe(3);
  });

  it("wraps the web app, uses the device camera through the WebView, and skips CORS", () => {
    const config = read("../capacitor.config.ts");
    const scripts = read("../package.json");
    const manifest = read("../android/app/src/main/AndroidManifest.xml");
    expect(config).toContain('webDir: "dist/web"');
    expect(config).toContain("CapacitorHttp");
    expect(config).toContain("enabled: true");
    expect(scripts).not.toContain('"@capacitor/camera"');
    expect(scripts).toContain("VITE_API_BASE=https://shelf-scanner.fly.dev");
    expect(manifest).toContain("android.permission.CAMERA");
    expect(manifest).toContain("android.permission.INTERNET");
  });
});
