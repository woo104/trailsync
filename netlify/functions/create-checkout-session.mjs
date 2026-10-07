// POST /api/create-checkout-session
// Body: { "plan": "monthly" | "lifetime" }
// Header: Authorization: Bearer <Supabase access token of the logged-in rider>
// Returns: { "url": "https://checkout.stripe.com/..." } for the browser to redirect to.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Names only (never values), so a missing setting shows up as a clear message instead of a crash.
const REQUIRED_ENV = ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_MONTHLY', 'STRIPE_PRICE_LIFETIME', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY'];
const missingEnv = () => REQUIRED_ENV.filter((name) => !process.env[name]);

let stripe, supabaseAdmin;
function connect() {
  stripe ??= new Stripe(process.env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
  supabaseAdmin ??= createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

// Prices live in Stripe; the browser only picks a plan name, never a price or amount.
const PLANS = {
  monthly: { price: process.env.STRIPE_PRICE_MONTHLY, mode: 'subscription' }, // recurring
  lifetime: { price: process.env.STRIPE_PRICE_LIFETIME, mode: 'payment' }     // one-time
};
const PRO_STATUSES = ['active', 'trialing', 'past_due', 'lifetime'];

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default async (req) => {
  const missing = missingEnv();
  if (missing.length) {
    console.error('Missing Netlify environment variables:', missing.join(', '));
    return json(500, { error: 'Checkout is not set up yet.', missing });
  }
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  connect();

  // Who is paying? Verify the rider's Supabase session server-side.
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Please log in first.' });
  const { data: auth, error: authError } = await supabaseAdmin.auth.getUser(token);
  const user = auth?.user;
  if (authError || !user) return json(401, { error: 'Your session expired. Log in again.' });

  let plan;
  try { ({ plan } = await req.json()); } catch { /* handled below */ }
  const selected = PLANS[plan];
  if (!selected?.price) return json(400, { error: 'Unknown plan.' });

  // Don't sell a second subscription to someone who already has one; reuse their Stripe customer.
  const { data: existing, error: dbError } = await supabaseAdmin
    .from('subscriptions')
    .select('status, stripe_customer_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (dbError) {
    console.error('subscriptions lookup failed', dbError);
    return json(500, { error: 'Could not start checkout. Try again.' });
  }
  if (existing && PRO_STATUSES.includes(existing.status)) {
    return json(409, {
      error: existing.status === 'lifetime' || plan === 'monthly'
        ? 'You already have TrailSync Pro.'
        : 'You already have TrailSync Pro. To switch to Lifetime, cancel your monthly plan first.'
    });
  }

  const site = (process.env.URL || new URL(req.url).origin).replace(/\/$/, '');

  try {
    const session = await stripe.checkout.sessions.create({
      mode: selected.mode,
      line_items: [{ price: selected.price, quantity: 1 }],
      client_reference_id: user.id,
      metadata: { supabase_user_id: user.id, plan },
      ...(existing?.stripe_customer_id
        ? { customer: existing.stripe_customer_id }
        : { customer_email: user.email }),
      ...(selected.mode === 'subscription'
        // Copied onto the subscription so every later webhook can find the rider.
        ? { subscription_data: { metadata: { supabase_user_id: user.id } } }
        // One-time: still create a Stripe customer so receipts and refunds tie back to the rider.
        : {
            payment_intent_data: { metadata: { supabase_user_id: user.id, plan } },
            ...(existing?.stripe_customer_id ? {} : { customer_creation: 'always' })
          }),
      allow_promotion_codes: true,
      success_url: `${site}/?checkout=success`,
      cancel_url: `${site}/?checkout=cancelled`
    });
    return json(200, { url: session.url });
  } catch (err) {
    console.error('Stripe checkout error', err);
    return json(500, { error: 'Could not start checkout. Try again.' });
  }
};

export const config = { path: '/api/create-checkout-session' };
