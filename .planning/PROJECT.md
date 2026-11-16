# Shelf Scanner

A phone web app for walking a library shelf. The camera reads spines, the phone keeps what it has already seen, and the shelf tab shows those books as covers.

## Current state

v0.14 is implemented on this branch and tagged `v0.14.0`. It is not merged and it is not deployed.

The same TypeScript app is packaged as an Android debug APK. The live camera is the device camera through the WebView. Packaged calls go to https://shelf-scanner.fly.dev. A saved taste profile highlights a matching live label and cover with "For you". The profile still stays on the phone.

## Next milestone

Not scoped yet.

## Constraints

- The taste profile stays on this phone. It is not sent to the API and it is not stored inside a scan session.
- The server caches an Open Library cover id. It does not proxy cover JPEG bytes.
- Sessions saved before v0.13 stay unstamped.
- The Android app reuses this TypeScript app.
- The packaged app calls https://shelf-scanner.fly.dev. Shipping this milestone does not deploy the server.
- Rating order stays as it is when a book is highlighted.
