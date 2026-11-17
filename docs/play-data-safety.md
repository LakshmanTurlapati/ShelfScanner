# Play Console answers

Answers for the **App content** pages in the Play Console, matched to what version 0.14.2 sends and keeps. They must agree with [`PRIVACY.md`](../PRIVACY.md); if one changes, change the other.

Two Play definitions decide most of the answers:

- **Collected** means the data leaves the phone. Data the server only holds in memory for one request still counts, but is marked *processed ephemerally*.
- **Shared** means it goes to a third party for that party's own use. OpenRouter and its model providers, Goodreads, Open Library, and Google Books process requests on the app's behalf, so they count as service providers. That makes the data collected, not shared.

## Data safety: overview

| Question | Answer |
|----------|--------|
| Does your app collect or share any of the required user data types? | **Yes** |
| Is all of the user data collected by your app encrypted in transit? | **Yes.** The app only uses HTTPS, and cleartext traffic is blocked in the manifest. |
| Which of the following methods of account creation does your app support? | **None.** The app has no accounts, so no account deletion URL is needed. |
| Do you provide a way for users to request that their data is deleted? | **Yes.** Users open an issue on the GitHub repository, as listed under Contact in the privacy policy. Frames have no account or name attached, so a request is matched by the time and what the frame shows. Frames also roll off after the newest 2,000. |

## Data types to declare

| Category → type | What it is in this app | Collected | Shared | Ephemeral | Required or optional | Purposes |
|---|---|---|---|---|---|---|
| **Photos and videos → Photos** | Strips of each camera frame or picked photo, sent to be read. Read frames and labelled frames are also kept on the server, the newest 2,000. | Yes | No | **No**, because frames are stored | Required | App functionality, Analytics |
| **App activity → Other user-generated content** | Questions typed into Ask the shelf, and the question and answer in a report the user sends | Yes | No | **No**, because reports are stored (the newest 5,000) | Optional | App functionality; Fraud prevention, security, and compliance |
| **App activity → App interactions** | Data sent with each stored frame: the labels on screen, their ratings, and whether each was marked For you. The For you marks exist only if the user saved the taste quiz. | Yes | No | No | Required | Analytics |
| **App info and performance → Other app performance data** | Timings and the screen and camera size sent with each stored frame | Yes | No | No | Required | Analytics |

The purpose behind each Analytics answer is measuring and improving how well the app reads spines.

## Not declared, and why

| Data | Why it is left out |
|------|--------------------|
| The taste quiz (name, genres, preferred titles) | It never leaves the phone. It is stored in IndexedDB and is not in any request body. |
| Saved shelves and settings | They stay on the phone, and Android backup is off. |
| Book titles, authors, and call numbers read from spines | They describe books, not the user, and are derived from the photo declared above. |
| IP address | Play has no IP address data type. The server keeps addresses in memory for up to a day for rate limiting and does not log them. Nothing derives a location from them. |
| Location, contacts, identifiers, financial, health, messages, audio, files, calendar, web history, installed apps, crash logs | None of these are collected. |

## Data safety: security practices

| Question | Answer |
|----------|--------|
| Has your app been independently validated against a global security standard? | **No** |
| Committed to Play Families Policy? | **No.** The app is not for children; see Target audience below. |

## Other App content pages

| Page | Answer |
|------|--------|
| Privacy policy | `https://github.com/LakshmanTurlapati/ShelfScanner/blob/main/PRIVACY.md` |
| App access | All functionality is available without special access. There is no login. |
| Ads | **No**, the app has no ads. |
| Content rating | Fill in the IARC questionnaire. The app has no violence, sex, gambling, purchases, or user-to-user chat. It does have AI-generated text answers, and users can report them in the app. |
| Target audience | 13 and older. The privacy policy says the app is not for children under 13. |
| News app | No |
| Government app | No |
| Financial features | None |
| Health | None |

## When something changes

- The app starts sending, storing, or sharing something new → update this file, `PRIVACY.md`, and the camera notice (`web/src/DataNotice.tsx`), and bump `DATA_NOTICE_VERSION` in `web/src/legal.ts`.
- Frame uploads are turned off → change Photos to *Ephemeral: Yes*, and remove the App interactions and Other app performance data rows.
- OpenRouter is set up to route to a provider that trains on prompts → that becomes **sharing**. Change the Shared column for Photos and Other user-generated content, and say so in the privacy policy.
