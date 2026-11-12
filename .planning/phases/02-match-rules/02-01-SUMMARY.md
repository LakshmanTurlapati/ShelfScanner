---
phase: 02-match-rules
plan: 01
requirements-completed: [REQ-13]
completed: 2026-11-12
---

# Summary 02-01

`bookMatchesProfile` is true for a saved profile when a chosen genre is the book's primary or a secondary genre, or when the preferred quiz title agrees with the canonical title. If the canonical title is still missing, the spine reading can agree instead. The title that was passed over never matches. A skipped profile and a missing profile match nothing.

`sameTitle` is the shared main-title check. `titleAgrees` still returns true when the canonical title is missing, so a rating can show, and the match rule does not use that result.
