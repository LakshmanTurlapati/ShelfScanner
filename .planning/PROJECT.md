# Shelf Scanner

A phone web app for walking a library shelf. The camera reads spines, the phone keeps what it has already seen, and the shelf tab shows those books as covers.

## Current milestone

v0.13 — Walk the shelf. Phases 1 through 5. Highlighting books that match a saved taste profile is the next milestone.

## Core value

A person can walk along shelves and still find every book the camera already saw, with a cover, without creating an account.

## Constraints

- The taste profile stays on this phone. It is not sent to the API and it is not stored inside a scan session.
- The server caches an Open Library cover id. It does not proxy cover JPEG bytes.
- Sessions saved before this milestone stay unstamped. Writers do not add pins or cover ids to them.
