# Kitchen Order Book

A simple ordering app for a small kitchen/tiffin business: customers pick
menu items and quantities from a link you send them, and you see everything
aggregated in a "Kitchen" view so you know what to prepare.

This version stores its data in [Firebase Firestore](https://firebase.google.com/docs/firestore)
instead of Claude, so it can be hosted anywhere — GitHub Pages, Netlify,
Vercel, or any static file host.

## 1. Create a Firebase project (free)

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and sign in with a Google account.
2. Click **Add project**, give it a name (e.g. `nandus-kitchen`), and finish the wizard (you can skip Google Analytics — not needed).
3. In the left sidebar, click **Build → Firestore Database**, then **Create database**. Choose a location close to your customers, and start in **production mode** (we'll paste in our own rules next).
4. Once created, click the **Rules** tab and replace the contents with what's in `firestore.rules` in this repo, then click **Publish**.

## 2. Get your web app config

1. In the Firebase console, click the gear icon next to **Project Overview → Project settings**.
2. Scroll to **Your apps**, click the **</>** (web) icon to register a new web app. Give it any nickname (Firebase Hosting isn't needed — skip that step).
3. Firebase shows you a `firebaseConfig` object with keys like `apiKey`, `authDomain`, `projectId`, etc.
4. Open `firebase-config.js` in this repo and paste those values in, replacing the placeholders. These values are **not secret** — they identify your project the way a URL does. What actually protects your data is the Firestore rules from step 1.

## 3. Try it locally (optional but recommended)

Because the app loads its JavaScript as an ES module, opening `index.html`
directly from disk (`file://...`) won't work in most browsers — you need to
serve it over `http://`. From this folder, run:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000` in your browser. The first time it loads,
it will create a `config/main` document in Firestore automatically, seeded
with your existing menu (Veg Thali, Chicken Curry Meal, Curd Rice, Chapati,
Today's Sweet) and an open "Today's Orders" round. **The prices are
placeholders — open Kitchen Staff → Menu and update them to your real
prices before sharing the link with customers.**

## 4. Push to GitHub

```
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

(If `git init` was already run for you, skip straight to `git remote add`.)

## 5. Put it on the web

The simplest option, since this is a plain static site with no build step:

**GitHub Pages** — in your repo on GitHub, go to **Settings → Pages**, set
**Source** to your `main` branch and `/ (root)`, save, and GitHub gives you
a URL like `https://<your-username>.github.io/<your-repo>/` within a
minute or two.

**Netlify / Vercel** — both let you connect a GitHub repo and deploy it
with no configuration (no build command needed, since there's nothing to
build); either gives you a URL immediately and redeploys automatically
whenever you push.

## 6. Share the links

- **Customers**: send them the site's root URL (e.g.
  `https://<your-username>.github.io/<your-repo>/`). This is the same link
  for everyone, every day — the "open ordering" state is controlled from
  the Kitchen view, not the URL.
- **You (Kitchen Staff)**: the same URL with `#kitchen` at the end (e.g.
  `https://<your-username>.github.io/<your-repo>/#kitchen`), protected by
  the PIN set in Settings (default `1234` — please change it). This link
  is never shown anywhere in the customer-facing pages; keep it private.

## How data is stored

- `config/main` — one document holding your business name, closed message,
  PIN, and menu (items, active/inactive, prices), plus the list of order
  rounds (label, date, open/closed) — but not the orders themselves.
- `orders/{roundId}_{phone}` — one document per customer per round, so two
  customers submitting at the same moment never overwrite each other.

## A security note

There's no real login system here — the "Kitchen PIN" is just a check
inside the app, not something Firestore itself enforces. The included
`firestore.rules` deliberately allow anyone to read and write, because
otherwise anonymous customers couldn't submit orders. In practice this
means someone who goes looking for your Firebase project's config (visible
in your page's source) could write to your database directly, bypassing
the app and the PIN — a small step up in risk from the Claude-hosted
version, where only people you explicitly invited as editors could publish
changes. For a small ordering app this is usually an acceptable trade-off,
but two ways to tighten it later if you want to:

- Restrict the `orders` collection's writes with rules that check the
  shape of the data (e.g. require `items` to be a map, `submittedAt` to be
  a recent number) so at least malformed or wildly out-of-scope writes are
  rejected.
- Add Firebase Anonymous Authentication and require `request.auth != null`
  in the rules — this stops casual drive-by writes without requiring
  customers to create accounts, at the cost of a bit more setup.

## Text message to customers

Each order in the Kitchen "Today's Orders" tab has a **Message customer**
button. Since this is a static site with no backend server, it can't send
a text automatically — the button opens your phone's Messages app with the
confirmation text and the customer's number already filled in, so it's one
tap to send. If you ever want a fully automatic, zero-tap text the moment
an order comes in, that needs a paid SMS provider (Twilio is the standard
choice) plus a small backend service to hold the API key safely — a
separate project from this one.
