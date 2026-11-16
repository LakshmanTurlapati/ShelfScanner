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
    expect(config).toContain('style: "DARK"');
    expect(scripts).not.toContain('"@capacitor/camera"');
    expect(scripts).toContain("VITE_API_BASE=https://shelf-scanner.fly.dev");
    expect(manifest).toContain("android.permission.CAMERA");
    expect(manifest).toContain("android.permission.INTERNET");
    expect(manifest).toContain("android.permission.ACCESS_NETWORK_STATE");
    expect(manifest).not.toContain("RECORD_AUDIO");
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:fullBackupContent="@xml/backup_rules"');
    expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
    expect(manifest).toContain('android:usesCleartextTraffic="false"');
    expect(read("../android/app/src/main/res/values/strings.xml")).toContain("Shelf Scanner");
    expect(read("../android/app/build.gradle")).toContain('versionName "0.14.1"');
    expect(read("../android/app/build.gradle")).toContain("versionCode 2");
    expect(read("../android/app/build.gradle")).toContain("minifyEnabled true");
    expect(read("../android/app/build.gradle")).toContain("SHELF_KEYSTORE");
  });

  it("uses the resting shelf mark instead of the Capacitor launcher", () => {
    const logo = read("../web/public/logo.svg");
    const foreground = read("../android/app/src/main/res/drawable/ic_launcher_foreground.xml");
    const adaptive = read("../android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml");
    for (const color of ["#2f5d3a", "#a58e5f", "#8a3b2c", "#3b5b6b", "#ff6b35", "#5a4632"]) {
      expect(logo).toContain(color);
      expect(foreground.toLowerCase()).toContain(color);
    }
    expect(logo).not.toContain("Shelf Scanner");
    expect(foreground).not.toContain("#26A69A");
    expect(read("../android/app/src/main/res/values/ic_launcher_background.xml")).toContain("#141110");
    expect(adaptive).toContain("@drawable/ic_launcher_foreground");
    expect(adaptive).toContain("@drawable/ic_launcher_monochrome");
    expect(read("../web/index.html")).toContain('href="/logo.svg"');
  });
});
