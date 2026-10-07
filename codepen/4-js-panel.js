(function () {
  'use strict';

  // ---------- Supabase config ----------
  // Paste your project's values from the Supabase dashboard: Project Settings -> API.
  // The anon key is meant to be public; Row Level Security in schema.sql keeps each rider's data private.
  // Leave both empty to run in local mode (data stays in this browser only).
  const SUPABASE_URL = 'https://nljclmmkovewbdxgbshd.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_5Qo69b0X2fdmAehJjqqEDg_caaUz9Rs';

  // Stripe: the checkout function's address once deployed (see STRIPE-SETUP.md), and optionally
  // your no-code Stripe customer portal link so Pro members can manage or cancel.
  const CHECKOUT_ENDPOINT = '/api/create-checkout-session';
  const STRIPE_PORTAL_URL = '';

  const CLOUD = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
  const sb = (CLOUD && window.supabase) ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

  // ---------- Storage ----------
  const KEYS = {
    profile: 'trailsync.profile.v1',   // local mode
    logs: 'trailsync.logs.v1',         // local mode
    lastUser: 'trailsync.lastUser.v1', // cloud mode: lets the app open offline
    cache: (id) => `trailsync.cache.v1.${id}`,
    outbox: (id) => `trailsync.outbox.v1.${id}`,
    imported: (id) => `trailsync.imported.v1.${id}`
  };

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; }
      catch (e) { toast('Could not save (storage unavailable)'); return false; }
    }
  };

  let user = null;   // { id, email } when signed in (cloud mode)
  let isPro = false;       // active subscription or lifetime purchase, written by the webhook
  let proStatus = null;    // 'active', 'lifetime', ...
  let profile = {};
  let logs = [];

  // ---------- Helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
  const fmt = (v, suffix = '') => v == null ? '–' : `${v}${suffix}`;
  const uid = () => {
    if (window.crypto?.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };

  // Moisture / grip scale, driest to wettest
  const CONDITIONS = [
    { id: 'moondust', label: 'Moon dust',             short: 'Moon dust', icon: '🌕', badge: 'bg-orange-300/10 text-orange-200 border-orange-300/30',  bar: 'from-orange-200 to-orange-400' },
    { id: 'dusty',    label: 'Dusty / loose',         short: 'Dusty',     icon: '💨', badge: 'bg-amber-400/10 text-amber-300 border-amber-400/30',     bar: 'from-amber-300 to-amber-500' },
    { id: 'hardpack', label: 'Hardpack',              short: 'Hardpack',  icon: '🧱', badge: 'bg-yellow-200/10 text-yellow-100 border-yellow-200/30',  bar: 'from-yellow-100 to-yellow-400' },
    { id: 'hero',     label: 'Hero dirt / tacky',     short: 'Hero dirt', icon: '🤘', badge: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30', bar: 'from-emerald-300 to-emerald-600' },
    { id: 'greasy',   label: 'Damp / greasy',         short: 'Greasy',    icon: '💧', badge: 'bg-teal-400/10 text-teal-300 border-teal-400/30',        bar: 'from-teal-300 to-teal-600' },
    { id: 'wet',      label: 'Wet',                   short: 'Wet',       icon: '🌧️', badge: 'bg-sky-400/10 text-sky-300 border-sky-400/30',           bar: 'from-sky-400 to-blue-600' },
    { id: 'muddy',    label: 'Muddy / peanut butter', short: 'Muddy',     icon: '🟤', badge: 'bg-amber-700/20 text-amber-500 border-amber-600/40',     bar: 'from-amber-600 to-amber-900' },
    { id: 'snow',     label: 'Snow / frozen',         short: 'Snow',      icon: '❄️', badge: 'bg-indigo-200/10 text-indigo-100 border-indigo-200/30',  bar: 'from-indigo-100 to-indigo-400' }
  ];
  const COND = Object.fromEntries(CONDITIONS.map(c => [c.id, c]));
  const DEFAULT_COND = 'hero';

  // Surface / terrain tags (pick any)
  const SURFACES = [
    { id: 'rocky',   label: 'Rocky / chunky' },
    { id: 'rooty',   label: 'Rooty' },
    { id: 'loamy',   label: 'Loamy' },
    { id: 'marbles', label: 'Loose over hard' },
    { id: 'bumps',   label: 'Braking bumps' },
    { id: 'blown',   label: 'Blown out' },
    { id: 'leaves',  label: 'Leaf litter' }
  ];
  const SURF = Object.fromEntries(SURFACES.map(s => [s.id, s]));

  // Upgrade entries saved by the first prototype (single trail + Dry/Muddy/Rocky)
  const LEGACY = { Dry: ['dusty', []], Muddy: ['muddy', []], Rocky: ['hardpack', ['rocky']] };
  function migrate(l) {
    if (Array.isArray(l.trails)) return l;
    const [condition, surfaces] = LEGACY[l.condition] || [DEFAULT_COND, []];
    return { ...l, trailSystem: l.trailName || 'Unknown', trails: [{ name: l.trailName || '', condition, surfaces }] };
  }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('opacity-0', 'translate-y-2');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('opacity-0', 'translate-y-2'), 2200);
  }

  // ---------- Bike Profile ----------
  const profileForm = $('#profileForm');
  function loadProfile() {
    ['bikeName', 'forkModel', 'shockModel', 'riderWeight'].forEach(k => {
      profileForm.elements[k].value = profile[k] ?? '';
    });
  }
  profileForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = profileForm.elements;
    profile = {
      bikeName: f.bikeName.value.trim(),
      forkModel: f.forkModel.value.trim(),
      shockModel: f.shockModel.value.trim(),
      riderWeight: f.riderWeight.value
    };
    if (persist()) {
      enqueue({ op: 'saveProfile', row: toProfileRow(profile) });
      const s = $('#profileSaved');
      s.classList.remove('opacity-0');
      setTimeout(() => s.classList.add('opacity-0'), 1800);
      toast('Bike profile saved');
      renderHistory();
    }
  });

  // ---------- Log Entry: trail system + trails ----------
  const logForm = $('#logForm');
  const trailRows = $('#trailRows');
  let rowSeq = 0;

  const condOptions = CONDITIONS.map(c => `<option value="${c.id}">${c.icon} ${c.label}</option>`).join('');

  function addTrailRow(prefill = {}) {
    const n = ++rowSeq;
    const row = document.createElement('div');
    row.className = 'trail-row card-enter rounded-xl border border-white/10 bg-ink-850/60 p-3 space-y-3';
    row.innerHTML = `
      <div class="flex items-center gap-2">
        <input data-field="name" type="text" list="trailList" placeholder="Trail name, e.g. A-Line" class="flex-1 min-w-0 rounded-lg bg-ink-850 border border-white/10 px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-trail-500/60 focus:border-transparent" />
        <button type="button" data-remove class="h-9 w-9 shrink-0 grid place-items-center rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-400/10 transition" aria-label="Remove trail">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <label class="block">
        <span class="text-[11px] font-medium uppercase tracking-wider text-slate-500">Condition</span>
        <select data-field="condition" class="mt-1 w-full rounded-lg bg-ink-850 border border-white/10 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-trail-500/60">${condOptions}</select>
      </label>
      <div>
        <span class="text-[11px] font-medium uppercase tracking-wider text-slate-500">Surface</span>
        <div class="mt-1 flex flex-wrap gap-1.5">
          ${SURFACES.map(s => `
            <label class="cursor-pointer">
              <input type="checkbox" data-surface value="${s.id}" id="s${n}-${s.id}" class="peer sr-only" />
              <span class="inline-block rounded-full border border-white/10 bg-ink-850 px-2.5 py-1 text-xs text-slate-400 peer-checked:border-trail-400 peer-checked:bg-trail-500/10 peer-checked:text-trail-400 peer-focus-visible:ring-2 peer-focus-visible:ring-trail-500/60 transition">${s.label}</span>
            </label>`).join('')}
        </div>
      </div>`;
    row.querySelector('[data-field=name]').value = prefill.name || '';
    row.querySelector('[data-field=condition]').value = prefill.condition || DEFAULT_COND;
    (prefill.surfaces || []).forEach(id => {
      const box = row.querySelector(`[data-surface][value="${id}"]`);
      if (box) box.checked = true;
    });
    trailRows.appendChild(row);
    syncRows();
    return row;
  }

  function syncRows() {
    const rows = trailRows.querySelectorAll('.trail-row');
    rows.forEach(r => r.querySelector('[data-remove]').classList.toggle('invisible', rows.length === 1));
    $('#trailCount').textContent = rows.length > 1 ? `${rows.length} trails` : '';
  }

  function readTrails() {
    return [...trailRows.querySelectorAll('.trail-row')].map(r => ({
      name: r.querySelector('[data-field=name]').value.trim(),
      condition: r.querySelector('[data-field=condition]').value,
      surfaces: [...r.querySelectorAll('[data-surface]:checked')].map(b => b.value)
    })).filter(t => t.name);
  }

  $('#addTrailBtn').addEventListener('click', () => {
    // New trail starts with the previous trail's condition: conditions usually match within a park
    const last = trailRows.querySelector('.trail-row:last-child [data-field=condition]');
    addTrailRow({ condition: last ? last.value : DEFAULT_COND }).querySelector('[data-field=name]').focus();
  });
  trailRows.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    btn.closest('.trail-row').remove();
    syncRows();
  });

  // Suggestions: past trail systems, and past trails within the chosen system
  function fillDatalist(el, values) {
    el.innerHTML = [...new Set(values)].sort().map(v => `<option value="${esc(v)}"></option>`).join('');
  }
  function refreshSuggestions() {
    fillDatalist($('#systemList'), logs.map(l => l.trailSystem).filter(Boolean));
    const sys = logForm.elements.trailSystem.value.trim().toLowerCase();
    const trails = logs.filter(l => (l.trailSystem || '').toLowerCase() === sys).flatMap(l => l.trails.map(t => t.name));
    fillDatalist($('#trailList'), trails.filter(Boolean));
  }
  logForm.elements.trailSystem.addEventListener('input', refreshSuggestions);

  logForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = logForm.elements;
    const trailSystem = f.trailSystem.value.trim();
    if (!trailSystem) { f.trailSystem.focus(); return; }
    const trails = readTrails();
    if (!trails.length) {
      toast('Add at least one trail name');
      trailRows.querySelector('[data-field=name]').focus();
      return;
    }
    const entry = {
      id: uid(),
      createdAt: new Date().toISOString(),
      trailSystem,
      trails,
      frontPsi: num(f.frontPsi.value),
      rearPsi: num(f.rearPsi.value),
      frontClickers: num(f.frontClickers.value),
      rearClickers: num(f.rearClickers.value),
      notes: f.notes.value.trim(),
      bikeName: profile.bikeName || ''
    };
    logs.unshift(entry);
    if (persist()) {
      enqueue({ op: 'upsertRide', row: toRideRow(entry) });
      logForm.reset();
      trailRows.innerHTML = '';
      addTrailRow();
      toast(`Logged ${trails.length} trail${trails.length > 1 ? 's' : ''} at ${trailSystem}`);
      render();
    }
  });

  function deleteLog(id) {
    logs = logs.filter(l => l.id !== id);
    persist();
    enqueue({ op: 'deleteRide', id });
    render();
    toast('Entry deleted');
  }

  // ---------- Render ----------
  function renderStats() {
    const allTrails = logs.flatMap(l => l.trails);
    $('#statRides').textContent = `${logs.length} · ${allTrails.length}`;
    const avg = (key) => {
      const vals = logs.map(l => l[key]).filter(v => v != null);
      return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : null;
    };
    $('#statFront').textContent = fmt(avg('frontPsi'));
    $('#statRear').textContent = fmt(avg('rearPsi'));
    const counts = allTrails.reduce((m, t) => (m[t.condition] = (m[t.condition] || 0) + 1, m), {});
    const top = COND[Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]];
    $('#statCond').textContent = top ? `${top.icon} ${top.short}` : '–';
  }

  function trailHTML(t) {
    const c = COND[t.condition] || COND[DEFAULT_COND];
    const tags = (t.surfaces || []).map(id => SURF[id]).filter(Boolean)
      .map(s => `<span class="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-slate-400">${s.label}</span>`).join('');
    return `
      <li class="flex flex-wrap items-center gap-x-2 gap-y-1.5 py-2.5 first:pt-0 last:pb-0">
        <span class="font-medium text-slate-100 mr-auto min-w-0 truncate">${esc(t.name)}</span>
        <span class="flex flex-wrap items-center gap-1.5">
          ${tags}
          <span class="rounded-full border px-2.5 py-0.5 text-xs font-medium ${c.badge}">${c.icon} ${c.short}</span>
        </span>
      </li>`;
  }

  function cardHTML(l) {
    const lead = COND[l.trails[0]?.condition] || COND[DEFAULT_COND];
    const d = new Date(l.createdAt);
    const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const metric = (label, value, unit) => `
      <div class="rounded-xl bg-ink-850 border border-white/5 px-3 py-2.5">
        <p class="text-[10px] uppercase tracking-wider text-slate-500">${label}</p>
        <p class="mt-0.5 text-lg font-bold text-white">${esc(fmt(value))}${value != null && unit ? `<span class="text-xs font-medium text-slate-500 ml-0.5">${unit}</span>` : ''}</p>
      </div>`;
    return `
      <article class="card-enter group relative overflow-hidden rounded-2xl bg-ink-900 border border-white/5 hover:border-white/10 transition shadow-lg shadow-black/20">
        <div class="absolute inset-y-0 left-0 w-1 bg-gradient-to-b ${lead.bar}"></div>
        <div class="p-5 pl-6">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h3 class="font-semibold text-white truncate">${esc(l.trailSystem)}</h3>
              <p class="text-xs text-slate-500 mt-0.5">${date} · ${time} · ${l.trails.length} trail${l.trails.length === 1 ? '' : 's'}${l.bikeName ? ` · ${esc(l.bikeName)}` : ''}</p>
            </div>
            <button data-delete="${esc(l.id)}" class="h-7 w-7 shrink-0 grid place-items-center rounded-lg text-slate-600 hover:text-rose-400 hover:bg-rose-400/10 opacity-60 group-hover:opacity-100 transition" aria-label="Delete entry">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
            </button>
          </div>
          <ul class="mt-4 rounded-xl bg-ink-850/60 border border-white/5 px-3.5 py-3 divide-y divide-white/5 text-sm">
            ${l.trails.map(trailHTML).join('')}
          </ul>
          <div class="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
            ${metric('Front PSI', l.frontPsi, 'psi')}
            ${metric('Rear PSI', l.rearPsi, 'psi')}
            ${metric('Front Clicks', l.frontClickers, '')}
            ${metric('Rear Clicks', l.rearClickers, '')}
          </div>
          ${l.notes ? `<p class="mt-4 text-sm text-slate-300 leading-relaxed whitespace-pre-line border-l-2 border-white/10 pl-3">${esc(l.notes)}</p>` : ''}
        </div>
      </article>`;
  }

  function renderHistory() {
    const filter = $('#filterCond').value;
    const list = filter === 'All' ? logs : logs.filter(l => l.trails.some(t => t.condition === filter));
    $('#historyFeed').innerHTML = list.map(cardHTML).join('');
    const empty = $('#emptyState');
    empty.classList.toggle('hidden', list.length > 0);
    empty.querySelector('p.font-semibold').textContent =
      (!list.length && logs.length) ? `No ${COND[filter].short.toLowerCase()} rides yet` : 'No rides logged yet';
  }

  function render() { renderStats(); renderHistory(); refreshSuggestions(); }

  $('#filterCond').addEventListener('change', renderHistory);
  $('#historyFeed').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-delete]');
    if (btn && confirm('Delete this ride log?')) deleteLog(btn.dataset.delete);
  });

  // ---------- Persistence: local mode vs. Supabase ----------
  // Cloud mode is offline-first: every change is applied on the device right away,
  // queued in an outbox, and pushed to Supabase as soon as there is signal.
  function persist() {
    if (!CLOUD) return store.set(KEYS.profile, profile) && store.set(KEYS.logs, logs);
    return user ? store.set(KEYS.cache(user.id), { profile, logs, isPro, proStatus }) : false;
  }

  const toRideRow = (l) => ({
    id: l.id,
    created_at: l.createdAt,
    trail_system: l.trailSystem,
    trails: l.trails,
    front_psi: l.frontPsi,
    rear_psi: l.rearPsi,
    front_clickers: l.frontClickers,
    rear_clickers: l.rearClickers,
    notes: l.notes || null,
    bike_name: l.bikeName || null
  });
  const fromRideRow = (r) => ({
    id: r.id,
    createdAt: r.created_at,
    trailSystem: r.trail_system,
    trails: Array.isArray(r.trails) ? r.trails : [],
    frontPsi: r.front_psi,
    rearPsi: r.rear_psi,
    frontClickers: r.front_clickers,
    rearClickers: r.rear_clickers,
    notes: r.notes || '',
    bikeName: r.bike_name || ''
  });
  const toProfileRow = (p) => ({
    user_id: user?.id,
    bike_name: p.bikeName || null,
    fork_model: p.forkModel || null,
    shock_model: p.shockModel || null,
    rider_weight: num(p.riderWeight),
    updated_at: new Date().toISOString()
  });
  const fromProfileRow = (r) => ({
    bikeName: r.bike_name || '',
    forkModel: r.fork_model || '',
    shockModel: r.shock_model || '',
    riderWeight: r.rider_weight ?? ''
  });

  const outbox = () => user ? store.get(KEYS.outbox(user.id), []) : [];
  const setOutbox = (items) => user && store.set(KEYS.outbox(user.id), items);

  function enqueue(item) {
    if (!CLOUD || !user) return;
    setOutbox([...outbox(), { ...item, key: uid() }]);
    flush();
  }

  // Network trouble, an expired token or a server hiccup: keep the change and retry later.
  const isRetryable = (res) => !res.status || res.status === 401 || res.status === 408 || res.status === 429 || res.status >= 500;

  let flushing = false;
  async function flush() {
    updateSync();
    if (!sb || !user || flushing || !navigator.onLine) return;
    flushing = true;
    updateSync();
    try {
      let item;
      while ((item = outbox()[0])) {
        let res;
        try {
          if (item.op === 'upsertRide') res = await sb.from('rides').upsert(item.row);
          else if (item.op === 'deleteRide') res = await sb.from('rides').delete().eq('id', item.id);
          else if (item.op === 'saveProfile') res = await sb.from('profiles').upsert({ ...item.row, user_id: user.id });
          else res = { error: null };
        } catch (e) {
          res = { error: e, status: 0 };
        }
        if (res.error && isRetryable(res)) break;
        if (res.error) {
          console.error('TrailSync sync error', res.error);
          toast(`A change couldn't be saved: ${res.error.message}`);
        }
        setOutbox(outbox().filter(i => i.key !== item.key));
      }
    } finally {
      flushing = false;
      updateSync();
    }
  }

  // Pull the latest from Supabase (e.g. rides logged on another device) and merge in unsynced local changes.
  async function pull() {
    if (!sb || !user || !navigator.onLine) return;
    const forUser = user.id;
    const [r, p, sub] = await Promise.all([
      sb.from('rides').select('*').order('created_at', { ascending: false }),
      sb.from('profiles').select('*').eq('user_id', forUser).maybeSingle(),
      sb.from('subscriptions').select('status').eq('user_id', forUser).maybeSingle()
    ]);
    if (!user || user.id !== forUser) return;
    if (!sub.error) { proStatus = sub.data?.status ?? null; isPro = PRO_STATUSES.includes(proStatus); renderPro(); }
    if (r.error || p.error) { console.warn('TrailSync pull failed', r.error || p.error); return; }

    const box = outbox();
    const pendingDeletes = new Set(box.filter(i => i.op === 'deleteRide').map(i => i.id));
    const pendingRides = box.filter(i => i.op === 'upsertRide').map(i => fromRideRow(i.row));
    const server = r.data.map(fromRideRow).filter(l => !pendingDeletes.has(l.id));
    const serverIds = new Set(server.map(l => l.id));
    logs = [...pendingRides.filter(l => !serverIds.has(l.id)), ...server]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const pendingProfile = box.filter(i => i.op === 'saveProfile').pop();
    profile = pendingProfile ? fromProfileRow(pendingProfile.row) : (p.data ? fromProfileRow(p.data) : {});

    persist();
    loadProfile();
    render();
  }

  function updateSync() {
    if (!CLOUD || !user) return;
    const pending = outbox().length;
    let text, dot;
    if (!navigator.onLine || !sb) { text = pending ? `Offline · ${pending} waiting to sync` : 'Offline · saved on this phone'; dot = 'bg-slate-500'; }
    else if (flushing) { text = 'Syncing…'; dot = 'bg-sky-400 animate-pulse'; }
    else if (pending) { text = `${pending} waiting to sync`; dot = 'bg-amber-400'; }
    else { text = 'Synced'; dot = 'bg-trail-400'; }
    $('#syncText').textContent = text;
    $('#syncDot').className = `h-2 w-2 shrink-0 rounded-full ${dot}`;
  }

  // ---------- Session ----------
  async function startSession(u) {
    const same = user && user.id === u.id;
    user = { id: u.id, email: u.email };
    store.set(KEYS.lastUser, user);
    if (!same) {
      const cached = store.get(KEYS.cache(user.id), { profile: {}, logs: [] });
      profile = cached.profile || {};
      logs = (cached.logs || []).map(migrate);
      isPro = Boolean(cached.isPro);
      proStatus = cached.proStatus ?? null;
      renderPro();
      loadProfile();
      render();
    }
    showApp();
    offerLocalImport();
    await flush();
    await pull();
  }

  function endSession() {
    user = null;
    profile = {};
    logs = [];
    isPro = false;
    proStatus = null;
    renderPro();
    store.set(KEYS.lastUser, null);
    loadProfile();
    render();
    showAuth('login');
  }

  // Rides saved in local mode (or the first prototype) can be moved into the account once.
  function offerLocalImport() {
    if (store.get(KEYS.imported(user.id), false)) return;
    const localLogs = store.get(KEYS.logs, []).map(migrate);
    const localProfile = store.get(KEYS.profile, null);
    store.set(KEYS.imported(user.id), true);
    if (!localLogs.length) return;
    const n = localLogs.length;
    if (!confirm(`Upload ${n} ride${n === 1 ? '' : 's'} saved on this device to ${user.email}?`)) return;
    const items = localLogs.map(l => ({ ...l, id: uid(), createdAt: l.createdAt || new Date().toISOString() }));
    logs = [...items, ...logs].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (localProfile && !profile.bikeName) profile = localProfile;
    persist();
    setOutbox([
      ...outbox(),
      ...items.map(l => ({ op: 'upsertRide', row: toRideRow(l), key: uid() })),
      ...(localProfile && profile === localProfile ? [{ op: 'saveProfile', row: toProfileRow(profile), key: uid() }] : [])
    ]);
    loadProfile();
    render();
    toast(`Imported ${n} ride${n === 1 ? '' : 's'}`);
  }

  // ---------- Auth screen ----------
  let authMode = 'login';
  const SUBMIT_LABELS = { login: 'Log in', signup: 'Create account', forgot: 'Send reset link', reset: 'Save new password' };
  const authForm = $('#authForm');
  const redirectTo = location.protocol.startsWith('http') ? location.origin + location.pathname : undefined;

  function showApp() {
    $('#authScreen').classList.add('hidden');
    $('#accountBar').classList.remove('hidden');
    $('#userEmail').textContent = user.email || '';
    $('#footerNote').textContent = 'TrailSync · Rides sync to your account and stay available offline on this device.';
    document.body.style.overflow = '';
    updateSync();
  }

  function showAuth(mode) {
    setAuthMode(mode);
    $('#accountBar').classList.add('hidden');
    $('#authScreen').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function authMessage(text, kind = 'error') {
    const el = $('#authMsg');
    el.textContent = text;
    el.className = `mt-4 rounded-lg px-3 py-2 text-sm ${kind === 'error'
      ? 'bg-rose-500/10 text-rose-300 border border-rose-500/20'
      : 'bg-trail-500/10 text-trail-400 border border-trail-500/20'}`;
    el.classList.toggle('hidden', !text);
  }

  function setAuthMode(mode) {
    authMode = mode;
    const tabbed = mode === 'login' || mode === 'signup';
    $('#authTabs').classList.toggle('hidden', !tabbed);
    document.querySelectorAll('[data-auth-tab]').forEach(b => {
      const on = b.dataset.authTab === mode;
      b.classList.toggle('bg-ink-700', on);
      b.classList.toggle('text-white', on);
      b.classList.toggle('text-slate-400', !on);
    });
    const titles = { forgot: ['Reset your password', 'We\'ll email you a link to choose a new one.'], reset: ['Choose a new password', 'You\'ll be logged in once it\'s saved.'] };
    $('#authTitle').classList.toggle('hidden', tabbed);
    $('#authHint').classList.toggle('hidden', tabbed);
    if (!tabbed) { $('#authTitle').textContent = titles[mode][0]; $('#authHint').textContent = titles[mode][1]; }
    $('#emailField').classList.toggle('hidden', mode === 'reset');
    $('#passwordField').classList.toggle('hidden', mode === 'forgot');
    $('#passwordLabel').textContent = mode === 'reset' ? 'New password' : 'Password';
    authForm.elements.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('#authSubmit').textContent = SUBMIT_LABELS[mode];
    $('#forgotLink').classList.toggle('hidden', mode !== 'login');
    $('#backLink').classList.toggle('hidden', tabbed || mode === 'reset');
    authMessage('');
  }

  document.querySelectorAll('[data-auth-tab]').forEach(b => b.addEventListener('click', () => setAuthMode(b.dataset.authTab)));
  $('#forgotLink').addEventListener('click', () => setAuthMode('forgot'));
  $('#backLink').addEventListener('click', () => setAuthMode('login'));

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!sb) return authMessage('Can\'t reach the sign-in service. Check your connection and reload.');
    const email = authForm.elements.email.value.trim();
    const password = authForm.elements.password.value;
    if (authMode !== 'reset' && !/^\S+@\S+\.\S+$/.test(email)) return authMessage('Enter a valid email address.');
    if (authMode !== 'forgot' && password.length < 6) return authMessage('Password must be at least 6 characters.');

    const btn = $('#authSubmit');
    const label = btn.textContent;
    const mode = authMode;
    btn.disabled = true;
    btn.textContent = { login: 'Logging in…', signup: 'Creating account…', forgot: 'Sending…', reset: 'Saving…' }[authMode];
    authMessage('');
    try {
      if (authMode === 'login') {
        const { data, error } = await withTimeout(sb.auth.signInWithPassword({ email, password }));
        if (error) throw error;
        await startSession(data.user);
      } else if (authMode === 'signup') {
        const { data, error } = await withTimeout(sb.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } }));
        if (error) throw error;
        if (data.session) {
          await startSession(data.user);
        } else {
          setAuthMode('login');
          authForm.elements.email.value = email;
          authMessage('Check your inbox and tap the confirmation link, then log in here.', 'ok');
        }
      } else if (authMode === 'forgot') {
        const { error } = await withTimeout(sb.auth.resetPasswordForEmail(email, { redirectTo }));
        if (error) throw error;
        authMessage('If that email has an account, a reset link is on its way.', 'ok');
      } else if (authMode === 'reset') {
        const { data, error } = await withTimeout(sb.auth.updateUser({ password }));
        if (error) throw error;
        recovering = false;
        toast('Password updated');
        await startSession(data.user);
      }
    } catch (err) {
      console.error('TrailSync auth error', err);
      authMessage(friendlyAuthError(err));
    } finally {
      btn.disabled = false;
      btn.textContent = authMode === mode ? label : SUBMIT_LABELS[authMode];
      authForm.elements.password.value = '';
    }
  });

  // Never leave the rider staring at a button that does nothing.
  function withTimeout(promise, ms = 15000) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]);
  }

  function friendlyAuthError(err) {
    const msg = String(err?.message || err || '');
    if (msg === 'timeout') return 'Supabase didn\'t answer. Check your connection, and if you\'re viewing this inside a preview window, open it in a normal browser tab instead.';
    if (/failed to fetch|networkerror|load failed|fetch/i.test(msg)) return 'Couldn\'t reach Supabase. Check your connection, and if you\'re viewing this inside a preview window, open it in a normal browser tab instead.';
    if (/invalid api key|no api key|apikey/i.test(msg)) return 'Supabase rejected the app\'s key. Check SUPABASE_URL and SUPABASE_ANON_KEY at the top of the script.';
    return msg || 'Something went wrong. Try again.';
  }

  $('#logoutBtn').addEventListener('click', async () => {
    const pending = outbox().length;
    if (pending && !confirm(`${pending} change${pending === 1 ? ' hasn\'t' : 's haven\'t'} synced yet. They'll stay on this device and upload next time you log in. Log out anyway?`)) return;
    if (sb) await sb.auth.signOut({ scope: 'local' }).catch(() => {});
    endSession();
  });

  window.addEventListener('unhandledrejection', (e) => {
    if (!$('#authScreen').classList.contains('hidden')) authMessage(friendlyAuthError(e.reason));
  });

  // ---------- Startup ----------
  let recovering = false;

  function init() {
    if (!CLOUD) {
      // Local mode: no accounts, everything stays in this browser.
      $('#localBar').classList.remove('hidden');
      profile = store.get(KEYS.profile, {});
      logs = store.get(KEYS.logs, []).map(migrate);
      loadProfile();
      render();
      return;
    }

    if (!sb) {
      // Supabase library didn't load (no signal). Open the last account from this device's cache.
      const last = store.get(KEYS.lastUser, null);
      if (last) startSession(last);
      else { showAuth('login'); authMessage('Can\'t reach the sign-in service. Check your connection and reload.'); }
      return;
    }

    // Show the cached account immediately so the app opens at a trailhead with no signal.
    const last = store.get(KEYS.lastUser, null);
    if (last) startSession(last);

    sb.auth.onAuthStateChange((event, session) => {
      // Defer: Supabase recommends not awaiting other Supabase calls inside this callback.
      setTimeout(() => {
        if (event === 'PASSWORD_RECOVERY') { recovering = true; showAuth('reset'); return; }
        if (recovering) return;
        if (session?.user) {
          if (!user || user.id !== session.user.id) startSession(session.user);
        } else if (event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') {
          if (event === 'INITIAL_SESSION' && user && !navigator.onLine) return; // no signal: keep the cached account
          if (user) endSession(); else showAuth('login');
        }
      }, 0);
    });

    window.addEventListener('online', () => flush().then(pull));
    window.addEventListener('offline', updateSync);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && user) flush().then(pull);
    });
  }

  // ---------- Premium Modal ----------
  const modal = $('#premiumModal');
  let lastFocus = null;
  function openModal() {
    lastFocus = document.activeElement;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    checkoutMessage('Payments powered by Stripe · Cancel anytime', 'info');
    renderPro();
    setTimeout(() => $('#checkoutBtn').focus(), 50);
  }
  function closeModal() {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    if (lastFocus) lastFocus.focus();
  }
  $('#premiumBtn').addEventListener('click', openModal);
  modal.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal(); });

  const PRO_STATUSES = ['active', 'trialing', 'past_due', 'lifetime'];

  function renderPro() {
    $('#premiumLabelLong').textContent = isPro ? 'TrailSync Pro ✓' : 'Unlock Premium Insights with Stripe';
    $('#premiumLabelShort').textContent = isPro ? 'Pro ✓' : 'Premium';
    $('#premiumTitle').textContent = !isPro ? 'Unlock Premium Insights'
      : proStatus === 'lifetime' ? 'TrailSync Pro for life' : 'You\'re on TrailSync Pro';
    $('#premiumDesc').textContent = isPro
      ? 'Thanks for supporting TrailSync. Here\'s what your membership includes.'
      : 'Turn your ride logs into a perfectly dialed setup for every trail and condition.';
    $('#planGroup').classList.toggle('hidden', isPro);
    $('#checkoutBtn').classList.toggle('hidden', isPro);
    $('#checkoutMsg').classList.toggle('hidden', isPro);
    const portal = $('#portalLink');
    portal.classList.toggle('hidden', !(isPro && proStatus !== 'lifetime' && STRIPE_PORTAL_URL));
    if (STRIPE_PORTAL_URL) portal.href = STRIPE_PORTAL_URL + (user?.email ? `?prefilled_email=${encodeURIComponent(user.email)}` : '');
  }

  function checkoutMessage(text, kind = 'error') {
    const msg = $('#checkoutMsg');
    msg.textContent = text;
    msg.className = `mt-3 text-center text-xs ${kind === 'error' ? 'text-amber-300' : 'text-slate-500'}`;
  }

  $('#checkoutBtn').addEventListener('click', async () => {
    const plan = document.querySelector('input[name=plan]:checked')?.value || 'lifetime';
    if (!CLOUD) return checkoutMessage('Demo mode: add your Supabase keys to enable accounts and payments.');
    if (!user || !sb) return checkoutMessage('Log in to upgrade.');
    if (!location.protocol.startsWith('http')) return checkoutMessage('Checkout works once the app is deployed to the web. See STRIPE-SETUP.md.');
    if (!navigator.onLine) return checkoutMessage('You need signal to check out. Your rides are still saving offline.');

    const btn = $('#checkoutBtn');
    const label = btn.querySelector('span');
    btn.disabled = true;
    label.textContent = 'Opening secure checkout…';
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error('Your session expired. Log in again.');
      const res = await withTimeout(fetch(CHECKOUT_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ plan })
      }));
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.url) throw new Error(body.error || `Checkout isn't available right now (error ${res.status}).`);
      location.assign(body.url); // Stripe-hosted payment page
    } catch (err) {
      console.error('TrailSync checkout error', err);
      checkoutMessage(err.message === 'timeout' ? 'Checkout didn\'t respond. Try again.' : err.message);
      btn.disabled = false;
      label.textContent = 'Continue to secure checkout';
    }
  });

  // Back from Stripe: ?checkout=success or ?checkout=cancelled
  function handleCheckoutReturn() {
    const params = new URLSearchParams(location.search);
    const result = params.get('checkout');
    if (!result) return;
    params.delete('checkout');
    history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : '') + location.hash);
    if (result === 'cancelled') return toast('Checkout cancelled. You weren\'t charged.');
    if (result !== 'success') return;
    toast('Payment received. Unlocking Pro…');
    // The webhook usually lands within seconds; check a few times.
    [2000, 5000, 10000, 20000].forEach(ms => setTimeout(async () => {
      if (isPro || !user) return;
      await pull();
      if (isPro) toast('Welcome to TrailSync Pro! 🤘');
    }, ms));
  }

  // ---------- Init ----------
  $('#filterCond').insertAdjacentHTML('beforeend', condOptions);
  addTrailRow();
  init();
  renderPro();
  handleCheckoutReturn();
})();
