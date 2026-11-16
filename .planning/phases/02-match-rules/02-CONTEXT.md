# Phase 2 context

A match is a saved profile only. A skipped profile and a missing profile match nothing.

A genre matches when it is the book's primary genre or one of its secondary genres.

A quiz match uses the title the person preferred. The title they passed over does not count. Title agreement is the same main-title rule the live labels already use, including the rule that a sequel does not match. A missing canonical title is not a match by itself. `titleAgrees` returns true in that case so a rating can still show, and the match rule does not reuse that result.
