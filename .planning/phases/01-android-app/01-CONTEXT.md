# Phase 1 context

The installable app is the current web UI. A native rewrite was rejected because the scanner, tracker, and shelf already run in the browser, and Capacitor can host that build.

The live view needs a camera stream. `@capacitor/camera` captures a still image, so the WebView keeps `getUserMedia` and the manifest requests CAMERA.

API calls in the APK use `https://shelf-scanner.fly.dev`. Local `npm run dev` and Playwright keep relative `/api` paths.
