# State

## Current position

Phase 1 — Data and contracts: verified. Next is Phase 2, cover lookup.

## Decisions

- D-01: Unstamped sessions stay frozen. No migration.
- D-02: `coverId: null` is a checked miss. A missing property means not looked up.
- D-03: Profile key is `shelf-scanner-profile`. Clear uses the session key only.
- D-04: Cover images load in the browser from `covers.openlibrary.org`. The server stores the numeric id.
- D-05: One walk session per camera visit. A new frame id tags detections so off-screen books are not drawn on the live labels.
- D-06: Highlight wiring waits for the next milestone.
