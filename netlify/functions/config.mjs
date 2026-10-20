import { getStore } from '@netlify/blobs';

const respond = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const publicCfg = (cfg) => {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  const { pin, ...safe } = cfg;
  return safe;
};

async function handleOrders(d) {
  try {
    const store = getStore('ladha-orders');
    const cfgStore = getStore('ladha-config');

    if (d.action === 'create') {
      if (!['Sur place', 'À emporter'].includes(d.svc) || !Array.isArray(d.items) || !d.items.length || d.items.length > 60) {
        return respond({ error: 'Commande invalide' }, 400);
      }
      // Prix de référence enregistrés par l'administrateur (si disponibles)
      const site = await cfgStore.get('site', { type: 'json' });
      const ref = new Map();
      if (site && site.cfg) {
        (site.cfg.pots || []).forEach((p) => ref.set('Pot ' + p.n, Number(p.p)));
        (site.cfg.produits || []).forEach((p) => ref.set(p.n, Number(p.p)));
      }
      const items = d.items.map((i) => {
        const nom = String(i.nom || '').slice(0, 100);
        const p = ref.has(nom) ? ref.get(nom) : Number(i.p);
        return {
          nom,
          q: Math.floor(Number(i.q)),
          pf: Array.isArray(i.pf) ? i.pf.map((x) => String(x).slice(0, 60)).slice(0, 8) : [],
          p,
        };
      });
      if (items.some((i) => !i.nom || !Number.isInteger(i.q) || i.q < 1 || i.q > 100 || !Number.isFinite(i.p) || i.p < 0)) {
        return respond({ error: 'Articles invalides' }, 400);
      }
      const t = items.reduce((sum, i) => sum + i.q * i.p, 0);
      if (t > 10000000) return respond({ error: 'Montant invalide' }, 400);
      const id = crypto.randomUUID();
      const n = Number((await store.get('counter')) || '0') + 1;
      await store.set('counter', String(n));
      const h = new Date().toLocaleString('fr-FR', { timeZone: 'Indian/Comoro', dateStyle: 'short', timeStyle: 'short' });
      const o = { id, n, svc: d.svc, items, t, h, s: 'À préparer' };
      await store.set('order-' + id, JSON.stringify(o));
      return respond({ n, t, id, h });
    }

    const kitchenPin = process.env.KITCHEN_PIN || (await cfgStore.get('kitchenpin')) || '4321';
    if (String(d.pin || '') !== kitchenPin) return respond({ error: 'Code cuisine incorrect' }, 403);

    if (d.action === 'list') {
      const { blobs } = await store.list({ prefix: 'order-' });
      const orders = (
        await Promise.all(
          blobs.slice(-200).map(async (b) => {
            try { return JSON.parse(await store.get(b.key)); } catch { return null; }
          })
        )
      ).filter(Boolean).sort((a, b) => a.n - b.n);
      return respond({ orders });
    }

    if (d.action === 'status') {
      if (!['À préparer', 'En préparation', 'Prête', 'Terminée'].includes(d.s)) return respond({ error: 'Statut invalide' }, 400);
      const { blobs } = await store.list({ prefix: 'order-' });
      for (const b of blobs) {
        const x = JSON.parse(await store.get(b.key));
        if (x.n === Number(d.n)) {
          x.s = d.s;
          await store.set(b.key, JSON.stringify(x));
          return respond({ ok: true });
        }
      }
      return respond({ error: 'Commande introuvable' }, 404);
    }
    return respond({ error: 'Action inconnue' }, 400);
  } catch (e) {
    return respond({ error: 'Erreur serveur : ' + e.message }, 500);
  }
}

export default async (req) => {
  try {
    const s = getStore('ladha-config');
    const adminPin = async () => process.env.ADMIN_PIN || (await s.get('adminpin')) || '1234';

    if (req.method === 'GET') {
      const d = await s.get('site', { type: 'json' });
      if (new URL(req.url).searchParams.get('rev')) return respond({ revision: d ? d.revision || 0 : 0 });
      return respond(d ? { ...d, cfg: publicCfg(d.cfg) } : { revision: 0, cfg: null, events: null, payments: null });
    }
    if (req.method !== 'POST') return respond({ error: 'Méthode interdite' }, 405);

    const d = await req.json();
    if (['create', 'list', 'status'].includes(d.action)) return handleOrders(d);
    if (typeof d.pin !== 'string' || d.pin !== (await adminPin())) {
      return respond({ error: 'Code administrateur incorrect' }, 403);
    }

    if (d.action === 'auth') {
      const isDefault = !process.env.ADMIN_PIN && !(await s.get('adminpin'));
      return respond({ ok: true, defaultPin: isDefault });
    }

    if (d.action === 'setpin') {
      const np = String(d.newpin || '');
      if (np.length < 4 || np.length > 32) return respond({ error: 'Le code doit avoir au moins 4 caractères' }, 400);
      if (d.which === 'kitchen') {
        if (process.env.KITCHEN_PIN) return respond({ error: 'Le code cuisine est défini dans Netlify (KITCHEN_PIN)' }, 400);
        await s.set('kitchenpin', np);
        return respond({ ok: true });
      }
      if (process.env.ADMIN_PIN) return respond({ error: 'Le code administrateur est défini dans Netlify (ADMIN_PIN)' }, 400);
      await s.set('adminpin', np);
      return respond({ ok: true });
    }

    if (d.action !== 'save') return respond({ error: 'Action inconnue' }, 400);
    const cfg = publicCfg(d.cfg);
    if (!cfg || !Array.isArray(cfg.produits) || !Array.isArray(cfg.pots)) return respond({ error: 'Configuration invalide' }, 400);
    if (!Array.isArray(d.events) || d.events.length > 300) return respond({ error: 'Catalogue événements invalide' }, 400);
    const payments = { wa2: String(d.payments?.wa2 || '').replace(/\D/g, '').slice(0, 18), mvolaEnabled: false };
    const data = { cfg, events: d.events, payments, revision: Date.now() };
    await s.setJSON('site', data);
    return respond({ ok: true, revision: data.revision });
  } catch (e) {
    return respond({ error: 'Erreur de synchronisation : ' + e.message }, 500);
  }
};
