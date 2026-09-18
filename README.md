# Our Week

Everyone in a circle seals a week of photos. Nobody sees anyone else's until everyone who posted taps "reveal", and then a synced slideshow plays on every phone at once.

Anyone can sign up, start a circle, and invite people with a 6-character code or a link like `yourapp.vercel.app/join/ABC123`. Each circle picks its own reveal day.

Runs on free tiers: Supabase (accounts, database, photo storage) and Vercel (hosting). Installable on iPhone from Safari's "Add to Home Screen".

## What's in the box

| File | What it does |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app. `index.html` includes an error reporter, so if something breaks you see why on screen instead of a blank page |
| `config.js` | The only file you edit: Supabase URL and publishable key |
| `supabase/schema.sql` | Creates every table, the invite-code functions, the reveal rule, the storage bucket, and the privacy policies. Tested against Postgres with simulated users |
| `api/caption.js` | Optional AI captions (needs an Anthropic API key in Vercel) |
| `vercel.json` | Makes `/join/CODE` links work |
| `manifest.json`, `sw.js`, `icons/` | Phone install support |

## Setup

### 1. Supabase (about 10 minutes)

1. At [supabase.com](https://supabase.com) create a new project. Any name, any strong database password, US East.
2. **SQL Editor > New query.** Paste the entire contents of `supabase/schema.sql` and click **Run**. You should see "Success. No rows returned."
3. **Authentication > Sign In / Providers > Email.** Turn **Confirm email** OFF for now. With it on, every new person has to click a link in an email, and Supabase's built-in mailer only sends a couple per hour, which will block your friends from signing up. (Turn it back on later once you've connected a real email service like Resend.)
4. **Authentication > URL Configuration.** Set **Site URL** to your Vercel URL once you have it (step 2 below), for example `https://our-week.vercel.app`. This is what password-reset emails link back to.
5. **Project Settings > Data API.** Copy the **Project URL** (looks like `https://abcdefghijklmnopqrst.supabase.co`).
6. **Project Settings > API Keys.** Copy the key that starts with `sb_publishable_`. Never use the `sb_secret_` one anywhere.

### 2. config.js

Open `config.js` in any text editor. Paste the URL into `SUPABASE_URL` and the key into `SUPABASE_PUBLISHABLE_KEY`. Save.

### 3. Vercel

1. Make a new repository at [github.com/new](https://github.com/new). On the empty-repo page, click the **uploading an existing file** link.
2. Unzip the project. Open the unzipped folder, select everything **inside** it (not the folder itself), drag it into GitHub, and commit. The `api`, `icons`, and `supabase` folders come along automatically.
3. At [vercel.com](https://vercel.com), **Add New > Project**, pick the repo, **Deploy**. Nothing to configure.
4. Go back to Supabase step 4 and paste your new URL into Site URL.

Any later change you push to GitHub redeploys on its own.

### 4. Try it

Open the URL, create an account, start a circle, and share the code. Add the app to your home screen from Safari's Share menu.

## If you see "Something didn't load"

That's the built-in error reporter. Copy the text it shows and send it to Claude; it names the exact problem. The most common ones:

- **404 on app.js or config.js**: the files went into a subfolder in the repo. In Vercel, Project > Settings > General > Root Directory, enter that folder's name.
- **"config.js still has the placeholder values"**: step 2 didn't get saved or uploaded.
- **"Invalid API key"**: you pasted the secret key or a legacy key. Use `sb_publishable_`.

## Optional: AI captions

Vercel > your project > **Settings > Environment Variables** > add `ANTHROPIC_API_KEY` (from [console.anthropic.com](https://console.anthropic.com)). Redeploy. The "Write one for me" button then works, at a fraction of a cent per caption.

## How the privacy actually works

The database function `week_revealed(circle, week)` returns true only when every member who posted that week has a row in `reveal_ready`. Captions, locations, and the photo files themselves are gated on that function, at the database and storage level. Until then, other members receive only that a photo exists, when it was taken, and a 24-pixel blurred thumbnail. Someone who isn't in the circle receives nothing at all, including your name.

## Rules of a circle

- Up to 25 people. The creator is the owner and can rename it, change the reveal day, lock it to new members, get a fresh invite code, and remove people.
- The week runs from the day after reveal day through reveal day, in each person's local time.
- Members with no photos that week don't block the reveal.
- Leaving a circle removes your photos from it. If the owner leaves, the longest-standing member takes over. The last person to leave deletes the circle.
- Deleting your account removes you from every circle and deletes your photos.

## Costs as it grows

Free tiers hold roughly 2,500 photos and 50,000 monthly users. Photo storage is what eventually costs money: Supabase Pro is $25/month with 100GB. Before opening it to strangers you'll also want a privacy policy and a way to report content, and Apple requires both plus account deletion (already built) for an App Store version.

## Ideas for later

Push notifications when someone in your circle posts, voice-note captions, a "guess whose photo" round during the reveal, a yearly recap, and an App Store version (same code wrapped with Capacitor).
