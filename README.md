# Our Week

Everyone in a circle seals a week of photos. Nobody sees anyone else's until everyone who posted taps "reveal", and then a synced slideshow plays on every phone at once.

Anyone can sign up, start a circle, and invite people with a 6-character code or a link like `yourapp.vercel.app/join/ABC123`. Each circle picks its own reveal day.

Looks and feels like a native iPhone app: system font, standard tab bar, Dark / Light / Auto with a choice of accent color under Me > Appearance.

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

## Push notifications

They work on iPhone from the home-screen version of the app (iOS 16.4 or newer), and in Chrome/Android/desktop browsers. Each person turns them on under **Me > Notifications** and can switch individual events on or off, or mute a whole circle from its People tab.

Sending them needs two things set up once:

**1. Vercel environment variables** (Project > Settings > Environment Variables, then redeploy)

| Name | Value |
|---|---|
| `SUPABASE_URL` | Your project URL, same as in config.js |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase > Project Settings > API Keys > the **secret** key (`sb_secret_...`). This one bypasses privacy rules, so it lives only here, never in config.js |
| `VAPID_PUBLIC_KEY` | The same value as `VAPID_PUBLIC_KEY` in config.js |
| `VAPID_PRIVATE_KEY` | The private half of the pair (Claude gave you this with the update) |
| `VAPID_SUBJECT` | `mailto:you@example.com` (your real email) |
| `WEBHOOK_SECRET` | Any long random string you make up, e.g. from a password generator |

**2. Supabase Database Webhooks** (Database > Webhooks > Create a new hook)

Create one hook per line below. For each: type **HTTP Request**, method **POST**, URL `https://YOUR-DOMAIN/api/push`, and under HTTP Headers add `x-webhook-secret` with the same value as `WEBHOOK_SECRET`.

| Table | Events |
|---|---|
| `photos` | Insert |
| `reveal_ready` | Insert |
| `reveal_force` | Insert |
| `comments` | Insert |
| `reactions` | Insert |
| `circle_members` | Insert |
| `circles` | Update |

The reveal-night reminder is sent by a daily job (`api/remind.js`, scheduled in `vercel.json`) that needs no extra setup.

To test: turn notifications on for yourself on one phone, then have someone else add a photo. You should get "Katelyn added a photo. Sealed until reveal."

## Optional: AI captions

Vercel > your project > **Settings > Environment Variables** > add `ANTHROPIC_API_KEY` (from [console.anthropic.com](https://console.anthropic.com)). Redeploy. The "Write one for me" button then works, at a fraction of a cent per caption.

## How the privacy actually works

The database function `week_revealed(circle, week)` returns true only when every member who posted that week has a row in `reveal_ready`. Captions, locations, and the photo files themselves are gated on that function, at the database and storage level. Until then, other members receive only that a photo exists, when it was taken, and a 24-pixel blurred thumbnail. Someone who isn't in the circle receives nothing at all, including your name.

## Updating an existing project

When a new version adds database changes, there's a numbered file in `supabase/` for it. Run it once in SQL Editor on your existing project, then replace the changed app files in GitHub. Photos and accounts are never touched. Always run the SQL first, then swap the files. Phones pick up new versions on their own the next time the app is opened; nobody needs to clear anything. (For Claude: bump `VERSION` in `sw.js` with every release so that happens.)

- `migration-3-quality.sql`: time zones, "start a new week now", opening a stuck week, comments, reports. (Includes migration 2.)
- `migration-4-social.sql`: push notifications, profile photos, blocking, per-circle mute, per-circle prompts. Run after 3.

## Everyday features

- **Home** button top-left inside any circle, and tap the circle's name to switch to another one.
- **Center + button** takes a photo or picks from the library.
- **Feed view** once a week is open: full-width photos with captions, reactions, and comments. Switch to Grid with the toggle.
- **Profile photo** under Me (tap your avatar).
- **Block** someone from the ••• next to their name in People. Their photos, comments, and reactions disappear for you. They aren't told.
- **Auto-advance** in the slideshow for reveal night, so nobody has to tap.
- **Share a recap**: a story-sized collage of the week for Instagram or iMessage.
- **Custom prompts** per circle (owner, in Settings), or turn prompts off.
- **First-launch walkthrough** for new people.
- **Privacy policy** at `/privacy.html`. Edit the contact email in that file before submitting to the App Store.

- **Edit or delete your photo** from the ••• menu on it. Save any open photo to your camera roll from the same menu.
- **Comments and reactions** on every photo once the week is open, in the slideshow and in the full-screen view.
- **Swipe** between photos in the full-screen view.
- **Adding a lot of photos:** the first sheet has "Add this and the other N without details" so you don't caption each one.
- **"3 new"** on the home screen means photos posted since you last opened that circle.
- **Stuck week:** if someone never taps ready, the owner can open the week once the scheduled reveal time has passed, and anyone can after 24 hours.
- **Time zones:** each circle has one (set from the creator's phone). The week and reveal time follow it, so two people in different places always agree on what "this week" is. Change it in circle settings.
- **Report a photo** from its ••• menu. It hides for you, and the report lands in the `reports` table in Supabase for you to review.
- **Change password** and **Delete account** under Me. Owners can **transfer ownership** from People and **delete the circle** from settings.

## Rules of a circle

- Up to 25 people. The creator is the owner and can rename it, change the reveal day, lock it to new members, get a fresh invite code, and remove people.
- The week runs from the day after reveal day through reveal day, in each person's local time.
- Members with no photos that week don't block the reveal.
- Once a week is open, anyone can tap "Start a new week now" so new photos go into a fresh sealed week instead of the open one. It can't be used on a week that's still sealed.
- Leaving a circle removes your photos from it. If the owner leaves, the longest-standing member takes over. The last person to leave deletes the circle.
- Deleting your account removes you from every circle and deletes your photos.

## Costs as it grows

Free tiers hold roughly 2,500 photos and 50,000 monthly users. Photo storage is what eventually costs money: Supabase Pro is $25/month with 100GB. Before opening it to strangers you'll also want a privacy policy and a way to report content, and Apple requires both plus account deletion (already built) for an App Store version.

## Ideas for later

Push notifications when someone in your circle posts, voice-note captions, a "guess whose photo" round during the reveal, a yearly recap, and an App Store version (same code wrapped with Capacitor).
