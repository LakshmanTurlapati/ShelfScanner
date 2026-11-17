# Shelf Scanner privacy policy

**Effective 16 November 2026**

Shelf Scanner reads book spines from your camera, looks the books up, and shows them as labels and a cover grid. This policy explains what leaves your phone, where it goes, and what stays on the phone. It covers the Android app and the web app at shelf-scanner.fly.dev.

## The short version

- There are no accounts, no ads, no analytics, and no tracking SDKs.
- Pictures of the shelf are sent to our server, and from there to third-party AI models, so the spines can be read.
- Some camera frames are kept on our server to improve recognition. See [Stored camera frames](#stored-camera-frames).
- Your taste quiz answers and your saved shelves stay on your phone.
- The app explains this and asks you to agree before it opens the camera for the first time.

## What leaves your phone

| Data | Why | Where it goes |
|------|-----|---------------|
| Strips of a camera frame, or of a photo you pick (JPEG) | To read the titles on the spines | Our server, then [OpenRouter](https://openrouter.ai/privacy), which passes them to a third-party vision model. The server does not keep these strips. |
| Titles, authors, and library call numbers read from spines | To find ratings, genres, summaries, and covers | Our server, then OpenRouter (including a web search limited to Goodreads, Open Library, Google Books, and Wikipedia), Goodreads, Open Library, and Google Books |
| A question you type into Ask the shelf, with the titles, authors, genres, summaries, and ratings of the current shelf | To answer the question | Our server, then OpenRouter |
| An answer you report, with the question that produced it | To review answers reported as offensive or wrong | Our server |
| Your phone's IP address | Every network request carries it | Our server and our host, [Fly.io](https://fly.io/legal/privacy-policy). Cover images load straight from Open Library or Google Books, so those sites see it too. |

The AI models only receive what is listed above. They never receive your taste quiz answers.

## Stored camera frames

After each read of the shelf, the app uploads the full camera frame to our server. While labels are showing on the live camera, it also uploads a frame with the labels drawn on it about every three seconds. With each frame it sends the labels shown (titles and ratings), whether each label was marked **For you**, timings, and the screen and camera size.

We keep the most recent 2,000 frames to measure and improve how well the app reads spines. Older frames are deleted automatically. Frames are not linked to an account or a name, but a frame shows whatever the camera saw, so point it at shelves rather than people.

## What stays on your phone

- **Taste quiz.** Your genres and preferred titles are stored on the phone only. They are not sent with any request. The server only receives the For you marks described above.
- **Saved shelves.** The books from each scan are stored on the phone. The app keeps the 20 newest.
- **Settings.** Whether auto-read is on, and that you agreed to the camera notice.

Android backup is turned off for the app, so none of this is copied to a cloud backup or a new phone. **Clear** in the Sessions panel deletes saved shelves. Clearing the app's storage in Android settings, or uninstalling the app, deletes everything, including the quiz.

## What our server keeps

- **Book lookups.** Facts, cover ids, ratings, and text embeddings, keyed by title, author, ISBN, or the text itself, for up to 30 days. These describe books, not people.
- **Stored camera frames**, as above.
- **Reported answers.** The question, the answer, and the reason you picked. We keep the most recent 5,000.
- **Request logs.** The address requested, the response code, and how long it took. Logs do not contain images, questions, or answers.
- **Rate limits.** IP addresses are held in memory for up to a day, to limit how often one address can call the server. They are not written to disk.

## Permissions

- **Camera**, for the live view. If you say no, you can still pick a photo from your phone.
- **Internet and network state**, to reach our server and to tell you when you are offline.

## Children

Shelf Scanner is not directed at children under 13, and we do not knowingly collect their personal information.

## Changes

If this policy changes, the new version will be posted here with a new effective date. The history of this file shows every earlier version.

## Contact

For questions, or to ask us to delete stored frames or reports, open an issue at [github.com/LakshmanTurlapati/ShelfScanner/issues](https://github.com/LakshmanTurlapati/ShelfScanner/issues).
