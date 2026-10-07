# Connecting TrailSync to Supabase

You'll need about 10 minutes and a free Supabase account.

## 1. Create the project
1. Sign in at https://supabase.com and click **New project**. The free tier is enough to start.
2. Pick a region close to your riders and save the database password somewhere safe.

## 2. Create the tables
1. In the dashboard, open **SQL Editor → New query**.
2. Paste the whole of `schema.sql` and click **Run**.

This creates two tables:
- `profiles` holds one bike profile per rider.
- `rides` holds one row per ride, with each trail's condition and surface tags inside it.

Row Level Security is switched on, so a logged-in rider can only read or change their own rows. It's safe to run the script again later.

Then run `schema-stripe.sql` (who has paid) and `schema-pro.sql` (multiple bikes and ride ratings) the same way. Both are safe to run again.

## 3. Add your keys to the app
1. Open **Project Settings → API** (in newer dashboards: **Project Settings → API Keys** and **Data API**).
2. Copy the **Project URL** and the **anon / public** key.
3. In `index.html` (or `4-js-panel.js` if you use CodePen), fill in:
   ```js
   const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
   const SUPABASE_ANON_KEY = 'your-anon-key';
   ```

The anon key is designed to be public, and Row Level Security is what protects the data. **Never** put the `service_role` key in the page.

If you leave both values empty, the app runs in local mode just like before.

## 4. Set up the email links
Open **Authentication → URL Configuration**:
- Set **Site URL** to the address where you host the app, for example `https://trailsync.netlify.app`.
- Add the same address under **Redirect URLs**.

This makes the "confirm your email" and "reset password" links open your app.

**Authentication → Sign In / Providers → Email** has **Confirm email** turned on by default. You can turn it off while you test so new accounts can log in straight away.

## 5. Host it on HTTPS
Logging in needs a real web address. Any static host works:
- **Netlify Drop** (https://app.netlify.com/drop): drag the `trailsync` folder onto the page.
- Cloudflare Pages, Vercel and GitHub Pages also work.

On your phone, open the address and use **Share → Add to Home Screen** so it opens like an app.

## How offline works
- Rides and profile changes are saved on the phone instantly and queued.
- When signal returns, the queue uploads by itself. The bar under the header shows "Synced", "Offline" or "N waiting to sync".
- If someone was logged in before, the app opens straight to their data with no signal, as long as the page itself loads. A browser can only reload a page with no signal if the page is cached by a service worker, which is the next step for a full offline app.
- Rides saved in local mode on a device are offered for upload the first time someone logs in there.

## Before launch
- Supabase's built-in email sender is heavily rate-limited, so set up custom SMTP (for example Resend or Postmark) under **Authentication → Emails**.
- Free projects pause after about a week with no activity. Upgrade, or ping the project, once you have real users.
