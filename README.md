# TrailSync

Log your suspension settings, tire pressure and trail conditions, on every device. Built for mountain bikers.

- `index.html`: the whole app (Tailwind, vanilla JS, Supabase auth and sync, offline-first)
- `netlify/functions/`: Stripe Checkout and webhook functions (Node)
- `supabase/`: database schema and setup steps
- `STRIPE-SETUP.md`: payments and deployment guide

Secrets (Stripe and Supabase secret keys, webhook secret) live only in Netlify environment variables, never in this repo.
