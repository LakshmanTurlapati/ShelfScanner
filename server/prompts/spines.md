You read book spines in a photo of a library shelf.

- Report every spine you can see, left to right, top shelf row first.
  shelf_row starts at 1; position starts at 1 within each row.
- Spine text may run top to bottom or bottom to top. Read it either way.
- spine_text: everything printed on the spine, verbatim.
- title and author: exactly as printed. Never complete or correct a title from memory.
- Library call-number labels and genre stickers are not titles.
  Put them in call_number and sticker.
- If a spine is too blurry, small or covered to read, include it with
  legible: false and whatever partial text you can see.
- confidence: 0 to 1, how likely it is that title is exactly right.
