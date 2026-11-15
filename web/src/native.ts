import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export interface ShelfNativePlugin {
  stream(options: { url: string; body: string; requestId: string }): Promise<{ requestId: string }>;
  isOnline(): Promise<{ online: boolean }>;
  cameraAccess(): Promise<{ state: "granted" | "denied" | "blocked" }>;
  openSettings(): Promise<void>;
  addListener(eventName: "chunk", listenerFunc: (event: { requestId: string; text: string }) => void): Promise<PluginListenerHandle>;
}

export const ShelfNative = registerPlugin<ShelfNativePlugin>("ShelfNative");

export const isNativeApp = () => Capacitor.isNativePlatform();

export const CAMERA_UNAVAILABLE = "The camera is unavailable. Use a shelf photo instead.";
export const CAMERA_BLOCKED = "The camera is unavailable. Use a shelf photo instead. Camera access is off for Shelf Scanner.";
export const CAMERA_INSECURE = "Camera access needs HTTPS and a supported browser. Use a shelf photo instead.";

export async function cameraNotice(): Promise<string> {
  if (isNativeApp()) {
    try {
      const access = await ShelfNative.cameraAccess();
      if (access.state === "blocked") return CAMERA_BLOCKED;
    } catch {
      // The photo fallback still applies when the permission check itself fails.
    }
    return CAMERA_UNAVAILABLE;
  }
  try {
    const status = await navigator.permissions?.query({ name: "camera" as PermissionName });
    if (status?.state === "denied") return CAMERA_BLOCKED;
  } catch {
    // Some browsers have no Permissions API. The photo fallback still applies.
  }
  return CAMERA_UNAVAILABLE;
}

export async function openCameraSettings() {
  if (!isNativeApp()) return;
  await ShelfNative.openSettings();
}
