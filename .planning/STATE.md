# State

## Current position

v0.14 phase 2 is done. Next is phase 3, the highlights. The branch stacks on `cursor/phase-1-data-contracts-c651`.

## Decisions

- D-01: Unstamped sessions stay frozen. No migration.
- D-02: `coverId: null` is a checked miss. A missing property means not looked up.
- D-03: Profile key is `shelf-scanner-profile`. Clear uses the session key only.
- D-04: Cover images load in the browser from `covers.openlibrary.org`. The server stores the numeric id.
- D-05: One walk session per camera visit. A new frame id tags detections so off-screen books are not drawn on the live labels.
- D-06: Highlight wiring is phase 3 of this milestone.
- D-09: A match uses `sameTitle`. It does not call `titleAgrees`, because a missing canonical title would match every preferred title.
- D-07: Capacitor wraps the existing app. The live camera stays `getUserMedia`. `@capacitor/camera` is a still-photo API and does not feed the tracker.
- D-08: CapacitorHttp calls https://shelf-scanner.fly.dev without a server deploy.
