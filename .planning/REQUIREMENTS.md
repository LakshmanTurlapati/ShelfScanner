# Requirements

## v0.14 Android and highlights

- [x] REQ-10: A debug APK installs the current Shelf Scanner UI without a rewrite.
- [x] REQ-11: The packaged app opens the device camera for the live view.
- [x] REQ-12: Packaged API calls go to https://shelf-scanner.fly.dev. Browser dev and tests keep same-origin `/api` paths.
- [ ] REQ-13: A saved profile matches a book when a chosen genre is on the book, or when a quiz pick's preferred title agrees with the book. A skipped or absent profile matches nothing.
- [ ] REQ-14: A matching book shows "For you" on its live label and on its cover tile. The grid stays in walk order. The rated tab stays in rating order.

## Decisions

- D-07: Capacitor wraps the Vite build. `@capacitor/camera` is not used, because that plugin returns a still photo and the tracker needs a live frame stream. The WebView `getUserMedia` call uses the Android camera after the CAMERA permission.
- D-08: `CapacitorHttp` is enabled so those Fly calls are native HTTP. The packaged origin does not depend on a CORS change, and this milestone does not deploy the server.
