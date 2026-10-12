# Virasat — setup notes (mentor only)

The team only ever changes `index.html` at the top of the repo. Everything in `api/` is setup.

## Putting a new version live (send this to whoever manages GitHub)
1. Rename the newest HTML file to **`index.html`**.
2. On github.com, open the repo → **Add file → Upload files** → drop `index.html` → **Commit changes**.
3. About a minute later it's live. GitHub keeps every old version (open the file → **History**).

Always start from the newest `index.html`: older copies don't have sign-in, leaderboards or the new Heritage AI code.

## What's where
| Path | What |
|---|---|
| `index.html` | The whole site, including Firebase settings (public, not secret) |
| `api/heritage-chat.js` | Heritage AI on Vercel; adds the Groq key on the server |
| `api/_setup/firestore.rules` | Who can read/write profiles and leaderboards |
| `api/_setup/firestore.indexes.json` | Leaderboard sorting |
| `api/_setup/tests/` | Checks for the rules and the chat function |

Vercel ignores folders starting with `_`, so nothing here runs on the site.

## Vercel → Settings → Environment Variables
- `GROQ_API_KEY`: tick **Sensitive**; Production + Preview
- `FIREBASE_API_KEY`: the `apiKey` from the Firebase settings in `index.html`

## Database rules and indexes (after changing them)
```bash
cd api/_setup && npx firebase-tools deploy --only firestore --project virasat-93d40
```

## Run the checks (local Firebase emulators; needs Java)
```bash
cd api/_setup && npm --prefix tests install && npm --prefix tests test
```

## Good to know
- Scores are worked out in the browser. The rules block impossible scores, but someone determined could still fake a believable one.
- Free Firestore limits: 50,000 reads and 20,000 writes a day.
- Delete the Groq key after the hackathon.
