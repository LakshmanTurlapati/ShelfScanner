# Shelf Scanner

A phone web app for walking a library shelf. The camera reads spines, the phone keeps what it has already seen, and the shelf tab shows those books as covers.

## Current state

v0.13 is implemented on this branch and tagged `v0.13.0`. It is not merged and it is not deployed.

A new scan is stamped. A walk keeps books that leave the frame, on the pin from the first sighting. The taste profile is optional and stays on the phone. Cover ids are cached on the server. The Shelf tab is a cover grid in walk order. The camera control says Open Shelf, and the shelf says Back to Live View.

## Next milestone

Highlight a live label and a cover when the book matches the saved genres or quiz picks. Rating order stays as it is.

## Constraints

- The taste profile stays on this phone. It is not sent to the API and it is not stored inside a scan session.
- The server caches an Open Library cover id. It does not proxy cover JPEG bytes.
- Sessions saved before this milestone stay unstamped. Writers do not add pins or cover ids to them.
