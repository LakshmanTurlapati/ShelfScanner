---
phase: 04-walk-wiring
plan: 01
requirements-completed: [REQ-07, REQ-08]
completed: 2026-11-12
---

# Summary 04-01

Each camera read keeps a frame id for live labels and writes into one walk session. Books missing from the new frame stay. The first pin is kept. Before a later read, the homography's horizontal shift is added to that session's shelf origin, or one frame width when tracking has already given up.

The header button reads Open Shelf while the camera is up and Back to Live View on the shelf. A repeated camera read no longer deletes the previous session.
