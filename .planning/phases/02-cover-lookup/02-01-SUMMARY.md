---
phase: 02-cover-lookup
plan: 01
requirements-completed: [REQ-04, REQ-05]
completed: 2026-11-12
---

# Summary 02-01

`POST /api/covers` accepts up to 40 ISBN strings, checks the ISBN-13 checksum, and reads Open Library's books API. The SQLite `covers` table stores the numeric id or null. Hits last 30 days and misses last a day. The response is JSON ids only.

`fillCovers` runs at the end of a scan and after a manual enrich. It patches `coverId` on stamped sessions. A network failure leaves the property absent.
