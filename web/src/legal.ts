// The privacy policy lives in the repository (PRIVACY.md). GitHub serves it at a public URL,
// which is also the address given to the Play Console.
export const PRIVACY_URL = "https://github.com/LakshmanTurlapati/ShelfScanner/blob/main/PRIVACY.md";

// Bump the version when what the app sends changes, so everyone sees the notice again.
export const DATA_NOTICE_KEY = "shelf-scanner-data-notice";
export const DATA_NOTICE_VERSION = "1";

export function noticeAccepted() {
  try {
    return localStorage.getItem(DATA_NOTICE_KEY) === DATA_NOTICE_VERSION;
  } catch {
    return false;
  }
}

export function acceptNotice() {
  try {
    localStorage.setItem(DATA_NOTICE_KEY, DATA_NOTICE_VERSION);
  } catch {
    // Without storage the notice shows again on the next launch.
  }
}
