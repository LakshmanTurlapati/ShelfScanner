# Shelf Scanner

A phone web app for walking a library shelf. The camera reads spines, the phone keeps what it has already seen, and the shelf tab shows those books as covers.

## Current milestone

v0.14 — Android, then highlights. Phase 1 ships an installable debug APK of the current app. Later phases highlight a live label and a cover when the book matches the taste profile saved on the phone.

## Current state

v0.13 is on the parent branch and is not merged. This branch stacks on it.

## Constraints

- The taste profile stays on this phone. It is not sent to the API and it is not stored inside a scan session.
- The server caches an Open Library cover id. It does not proxy cover JPEG bytes.
- Sessions saved before v0.13 stay unstamped.
- The Android app reuses this TypeScript app. It does not rewrite the scanner.
- The packaged app calls https://shelf-scanner.fly.dev. This milestone does not deploy to Fly.
- Rating order stays as it is when highlights land.
