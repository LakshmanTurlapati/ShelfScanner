# Requirements

## v0.13 Walk the shelf

- [x] REQ-01: A new session is stamped `contract: 1` with mode `still` or `walk`. A session already in IndexedDB stays unstamped, and writers drop `pin` and `coverId` on it.
- [x] REQ-02: A walk keeps the first pin. A still photo can keep a cover id and does not get a pin. A re-read does not store `coverId` as its own property when neither book has one.
- [x] REQ-03: The taste profile lives at IndexedDB key `shelf-scanner-profile`. Absent, skipped, and saved stay distinct. Clear wipes scans only.
- [x] REQ-04: `POST /api/covers` resolves Open Library cover ids for ISBN-13s, caches the id or a checked miss, and returns JSON only.
- [x] REQ-05: After a book has a valid ISBN-13, the phone stores `coverId` as a positive integer or `null`. A failed lookup leaves the field unset.
- [x] REQ-06: After the splash, a skippable screen asks for a name, preferred genres, and 3 to 5 book pairs. The answers stay on this phone.
- [x] REQ-07: Camera reads in one visit share one walk session. Books that leave the frame stay, with the pin from the first sighting. A homography shift moves the shelf origin before the next read.
- [x] REQ-08: The camera shows Open Shelf. The shelf shows Back to Live View.
- [ ] REQ-09: The Shelf tab is a cover grid in walk order. A tap opens the book. A missing cover is a title and author tile.

## Next milestone

- Highlight a live label and a cover when the book matches the saved genres or quiz picks. Rating order stays as it is.
