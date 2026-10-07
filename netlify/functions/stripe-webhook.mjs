// POST /api/stripe-webhook  (called by Stripe, not by the browser)
// Keeps public.subscriptions in Supabase in step with Stripe, which is what unlocks Pro in the app.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  httpClient: Stripe.createFetchHttpClient()
});

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const toIso = (seconds) => (seconds ? new Date(seconds * 1000).toISOString() : null);

async function currentStatus(userId) {
  const { data, error } = await supabaseAdmin
    .from('subscriptions').select('status').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(`Supabase read failed: ${error.message}`);
  return data?.status;
}

async function saveSubscription(subscriptionId, fallbackUserId) {
  // Always re-read from Stripe so out-of-order webhooks can't store a stale status.
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const userId = sub.metadata?.supabase_user_id || fallbackUserId;
  if (!userId) {
    console.warn('Subscription has no supabase_user_id; skipping', sub.id);
    return;
  }
  // A lifetime member keeps Pro no matter what happens to an old monthly subscription.
  if ((await currentStatus(userId)) === 'lifetime') return;
  const item = sub.items?.data?.[0];
  const { error } = await supabaseAdmin.from('subscriptions').upsert({
    user_id: userId,
    stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
    stripe_subscription_id: sub.id,
    status: sub.status,
    price_id: item?.price?.id ?? null,
    current_period_end: toIso(item?.current_period_end ?? sub.current_period_end),
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
    updated_at: new Date().toISOString()
  });
  if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
}

async function saveLifetime(session) {
  const userId = session.client_reference_id || session.metadata?.supabase_user_id;
  if (!userId) {
    console.warn('Lifetime purchase has no user id; skipping', session.id);
    return;
  }
  const { error } = await supabaseAdmin.from('subscriptions').upsert({
    user_id: userId,
    stripe_customer_id: typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null,
    stripe_subscription_id: null,
    status: 'lifetime',
    price_id: process.env.STRIPE_PRICE_LIFETIME ?? null,
    current_period_end: null,
    cancel_at_period_end: false,
    updated_at: new Date().toISOString()
  });
  if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
}

// A fully refunded lifetime purchase removes Pro.
async function revokeLifetimeOnRefund(charge) {
  if (!charge.refunded) return; // partial refund: keep access
  const customer = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
  if (!customer) return;
  // Only lifetime rows change here; subscription refunds arrive as subscription events.
  const { error } = await supabaseAdmin.from('subscriptions')
    .update({ status: 'refunded', updated_at: new Date().toISOString() })
    .eq('stripe_customer_id', customer)
    .eq('status', 'lifetime');
  if (error) throw new Error(`Supabase update failed: ${error.message}`);
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let event;
  try {
    // The raw body is required for the signature check.
    event = stripe.webhooks.constructEvent(
      await req.text(),
      req.headers.get('stripe-signature'),
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return new Response(`Webhook signature check failed: ${err.message}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object;
        if (session.mode === 'subscription' && session.subscription) {
          await saveSubscription(session.subscription, session.client_reference_id);
        } else if (session.mode === 'payment' && session.payment_status === 'paid') {
          await saveLifetime(session);
        }
        break;
      }
      case 'charge.refunded':
        await revokeLifetimeOnRefund(event.data.object);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await saveSubscription(event.data.object.id);
        break;
      default:
        // Other events aren't needed; acknowledge so Stripe stops sending them.
        break;
    }
  } catch (err) {
    // A 500 makes Stripe retry the event later.
    console.error('Webhook handling failed', event.type, err);
    return new Response('Webhook handler failed', { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
};

export const config = { path: '/api/stripe-webhook' };
