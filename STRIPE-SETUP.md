# Setting up Stripe payments for TrailSync

**Plans:** Monthly at $3.99 (a subscription) and Lifetime at $42.99 (a one-time payment that unlocks Pro for good).

**How it works:** a rider taps **Continue to secure checkout**. The checkout function creates a Stripe Checkout page for their account, and the rider pays on Stripe. Stripe then calls the webhook function, which marks the rider as Pro in Supabase, and the app shows **Pro ✓**.

Do everything in Stripe's **test mode / sandbox** first; the toggle is at the top of the dashboard. Nothing real is charged until you switch to live mode.

---

## Part 1: Stripe dashboard

### 1. Create the product and prices
1. Go to **Product catalog → + Add product**. Typing "Product catalog" in the dashboard search bar also gets you there.
2. Name: `TrailSync Pro`.
3. Pricing: **Recurring**, `$3.99`, billing period **Monthly**. Save.
4. On the product page, click **+ Add another price**: **One-off**, `$42.99`. Save.
5. Click each price and copy its **Price ID**, which starts with `price_` (not the `prod_` product ID). You need both:
   - Monthly → `STRIPE_PRICE_MONTHLY`
   - Lifetime (one-off) → `STRIPE_PRICE_LIFETIME`

### 2. Copy your secret key
**Developers → API keys** → **Secret key** (`sk_test_…`) → `STRIPE_SECRET_KEY`. If you create a restricted key instead, choose **Full access, except sensitive operations**.

⚠️ This key can charge cards and issue refunds. It goes **only** into Netlify's environment variables. Never put it in `index.html`, CodePen, or a chat.

### 3. Turn on the customer portal (lets Pro members cancel)
1. Search the dashboard for **Customer portal**, turn on **Cancel subscriptions**, and save.
2. Copy the portal **login link** (`https://billing.stripe.com/p/login/…`).
3. Paste it into `STRIPE_PORTAL_URL` near the top of the script in `index.html`. Pro members then get a **Manage subscription** button.

The webhook (Part 3) comes after the site is online, because it needs your site's address.

---

## Part 2: Supabase

1. **SQL Editor → New query**: paste `supabase/schema-stripe.sql` → **Run**. This creates the `subscriptions` table. Riders can read their own row, but only the webhook can write to it.
2. **Settings → API Keys → Secret keys**: copy the `sb_secret_…` key → `SUPABASE_SECRET_KEY`. Like the Stripe secret key, it goes only into Netlify.

---

## Part 3: Put it online with Netlify

The checkout runs as a server function, so the site must be deployed with the Netlify CLI. Netlify Drop (drag and drop) can't run functions.

1. Install **Node.js LTS** from https://nodejs.org.
2. Unzip `trailsync.zip`, open a terminal in the `trailsync` folder, and run:
   ```
   npm install
   npx netlify-cli login
   npx netlify-cli deploy --build --prod
   ```
   When asked, choose **Create & configure a new project** and give it a name (e.g. `trailsync`). You'll get an address like `https://trailsync.netlify.app`.
3. Add the secrets. Either use **Netlify → your site → Project configuration → Environment variables**, or run these from the same folder:
   ```
   npx netlify-cli env:set STRIPE_SECRET_KEY     sk_test_...
   npx netlify-cli env:set STRIPE_PRICE_MONTHLY  price_...
   npx netlify-cli env:set STRIPE_PRICE_LIFETIME price_...
   npx netlify-cli env:set SUPABASE_URL          https://nljclmmkovewbdxgbshd.supabase.co
   npx netlify-cli env:set SUPABASE_SECRET_KEY   sb_secret_...
   ```
4. Add the webhook:
   1. In Stripe, search for **Webhooks** (under Developers / Workbench) → **Add destination / Add endpoint**.
   2. Endpoint URL: `https://YOUR-SITE.netlify.app/api/stripe-webhook`
   3. Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`.
   4. Save, then reveal the **Signing secret** (`whsec_…`) and run:
      ```
      npx netlify-cli env:set STRIPE_WEBHOOK_SECRET whsec_...
      ```
5. Deploy again so the functions pick up the variables:
   ```
   npx netlify-cli deploy --build --prod
   ```
6. In Supabase, go to **Authentication → URL Configuration**, set **Site URL** to your Netlify address, and add it to **Redirect URLs**. This also fixes the "site can't be reached" email link.

---

## Part 4: Test a payment
1. Open your Netlify address, log in, tap **Unlock Premium**, pick a plan, and tap **Continue to secure checkout**.
2. On Stripe's page, use card `4242 4242 4242 4242`, any future expiry date, any CVC and any ZIP code.
3. You'll land back in TrailSync with "Payment received. Unlocking Pro…". Within a few seconds the button changes to **Pro ✓**.
4. Check **Supabase → Table Editor → subscriptions**: there should be a row with status `active` (Monthly) or `lifetime`.
5. To test a refund, refund the Lifetime payment in full in Stripe. Within seconds the row changes to `refunded` and Pro switches off.

If Pro doesn't unlock, look at **Stripe → Webhooks → your endpoint → event deliveries** for errors. Netlify's **Logs → Functions** shows the function side.

## Going live
1. Switch Stripe to live mode, then recreate the product and prices, the webhook and the portal there. Live mode has its own keys and IDs.
2. Replace the Stripe values: in Netlify, `STRIPE_SECRET_KEY`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_LIFETIME` and `STRIPE_WEBHOOK_SECRET`; in `index.html`, `STRIPE_PORTAL_URL`. Then redeploy.
3. Before charging real riders, add Terms and a Privacy Policy. Stripe also asks you to activate your account with business and bank details.
