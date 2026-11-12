---
phase: 01-android-app
plan: 01
requirements-completed: [REQ-10, REQ-11, REQ-12]
completed: 2026-11-12
---

# Summary 01-01

The debug APK is the existing Vite app inside Capacitor. A native rewrite was rejected because the scanner, tracker, and shelf already run in the browser.

The live view still calls `getUserMedia`. `@capacitor/camera` returns a still photo and cannot feed the homography tracker, so it is not a dependency. The manifest requests `CAMERA`, and the WebView permission handler asks the person before the stream starts.

Packaged calls use `https://shelf-scanner.fly.dev` through `VITE_API_BASE`. Browser dev and Playwright keep relative `/api` paths. `CapacitorHttp` is on, so those calls do not need a CORS change or a Fly deploy. A plain Blob body was dropped by that native client, so camera frames are sent as `File` objects. The emulator log then showed a JPEG body (`/9j/4AAQ…`) and HTTP 200 from Fly for `/api/read-strip`, plus the later quick-facts, enrich, embed, and frame calls.

Ask-the-shelf still reads `res.body`. CapacitorHttp returns the finished body in one response, so the packaged app does not stream that answer token by token.
