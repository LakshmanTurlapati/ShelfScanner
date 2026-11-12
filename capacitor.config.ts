import type { CapacitorConfig } from "@capacitor/cli";

// The Android app is the existing web build inside a WebView. Live tracking keeps
// getUserMedia, which the WebView satisfies from the device camera. @capacitor/camera
// only returns a still photo, so it cannot feed the homography tracker.
// CapacitorHttp performs the Fly calls outside the WebView so the packaged origin
// does not need a CORS change on the server.
const config: CapacitorConfig = {
  appId: "app.shelfscanner.phone",
  appName: "Shelf Scanner",
  webDir: "dist/web",
  android: {
    allowMixedContent: false,
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
