// Alertas da central: push no celular (painel instalado na tela inicial) e, se configurado, Telegram.
// Cada aparelho escolhe quais tipos recebe (Configurações → Notificações no celular).
const express = require('express');
const webpush = require('web-push');
const { db, getSetting, setSetting } = require('./db.js');

const TIPOS = {
  quantidade: 'Lead escolheu a quantidade (lead quente)',
  alta: 'Lead grande (50+ placas) ou pediu o comercial',
  atendente: 'Pediu atendente ou respondeu um follow-up',
  whatsapp_lead: 'Lead mandou o WhatsApp',
  site: 'Lead criou conta ou iniciou pedido no site',
  venda: 'Venda paga',
  wa_msg: 'Mensagem nova na aba WhatsApp',
  sistema: 'Robô parou ou voltou (Instagram)',
  resumo: 'Resumo diário da Gerente (Prédio)',
};
const PADRAO = Object.keys(TIPOS);

// Tipos criados depois que o aparelho foi cadastrado entram ligados uma vez (dá para desligar em Configurações)
if (getSetting('push_tipos_v') !== '2') {
  for (const s of db.prepare('SELECT id, prefs FROM push_subs').all()) { const p = JSON.parse(s.prefs || '[]'); if (!p.includes('resumo')) db.prepare('UPDATE push_subs SET prefs = ? WHERE id = ?').run(JSON.stringify([...p, 'resumo']), s.id); }
  setSetting('push_tipos_v', '2');
}

// Chaves VAPID: geradas uma vez e guardadas no banco (sobrevivem a deploys com o Volume)
function chaves() {
  let pub = getSetting('vapid_publica'), priv = getSetting('vapid_privada');
  if (!pub || !priv) { const k = webpush.generateVAPIDKeys(); pub = k.publicKey; priv = k.privateKey; setSetting('vapid_publica', pub); setSetting('vapid_privada', priv); }
  return { pub, priv };
}

// Troca em testes: (assinatura, corpo) => Promise
let enviarPara = (sub, corpo) => {
  const k = chaves();
  return webpush.sendNotification(sub, corpo, { TTL: 6 * 3600, urgency: 'high',
    vapidDetails: { subject: process.env.PUSH_CONTATO || 'mailto:contato@nextapbrasil.com.br', publicKey: k.pub, privateKey: k.priv } });
};

async function telegram(texto) {
  const tk = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tk || !chat || process.env.NODE_ENV === 'test') return;
  try { await fetch(`https://api.telegram.org/bot${tk}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: texto }) }); }
  catch (e) { console.error('[TELEGRAM]', e.message); }
}

// Mesmo alerta (tipo + chave) não se repete em 10 minutos: ninguém recebe 5 avisos do mesmo lead
const recentes = new Map();
async function notificar({ tipo = 'sistema', titulo, texto = '', url = '/', chave = '' }) {
  const k = tipo + ':' + (chave || titulo);
  const t = Date.now();
  if (chave && t - (recentes.get(k) || 0) < 10 * 60e3) return { enviados: 0, repetido: true };
  recentes.set(k, t);
  if (recentes.size > 2000) for (const [x, v] of recentes) if (t - v > 10 * 60e3) recentes.delete(x);
  telegram(titulo + (texto ? '\n' + texto : ''));
  let enviados = 0;
  for (const s of db.prepare('SELECT * FROM push_subs').all()) {
    let prefs; try { prefs = JSON.parse(s.prefs); } catch (e) { prefs = PADRAO; }
    if (!prefs.includes(tipo)) continue;
    try {
      await enviarPara({ endpoint: s.endpoint, keys: JSON.parse(s.chaves) }, JSON.stringify({ titulo, texto, url, tag: k }));
      db.prepare('UPDATE push_subs SET ultimo_ok = ? WHERE id = ?').run(t, s.id); enviados++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE id = ?').run(s.id);   // aparelho desinstalou ou bloqueou
      else console.warn('[PUSH]', e.statusCode || '', e.message);
    }
  }
  return { enviados };
}

// ---------- rotas do painel (com login): /api/push/... ----------
const router = express.Router();
router.get('/', (req, res) => res.json({ chave: chaves().pub, tipos: TIPOS,
  aparelhos: db.prepare('SELECT id, aparelho, prefs, criado_em, ultimo_ok FROM push_subs ORDER BY id DESC').all().map(a => ({ ...a, prefs: JSON.parse(a.prefs || '[]') })) }));
router.post('/assinar', (req, res) => {
  const b = req.body || {}, s = b.assinatura || {};
  if (!/^https:\/\/\S{10,600}$/.test(String(s.endpoint || '')) || !s.keys || !s.keys.p256dh || !s.keys.auth) return res.status(400).json({ error: 'Assinatura de notificação inválida.' });
  // Aparelho que já estava cadastrado mantém as escolhas dele (o painel reconfirma a assinatura a cada abertura)
  const ja = db.prepare('SELECT prefs FROM push_subs WHERE endpoint = ?').get(s.endpoint);
  const prefs = Array.isArray(b.prefs) ? b.prefs.filter(t => TIPOS[t]) : ja ? JSON.parse(ja.prefs) : PADRAO;
  db.prepare(`INSERT INTO push_subs (endpoint, chaves, aparelho, prefs, criado_em) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET chaves = excluded.chaves, aparelho = excluded.aparelho, prefs = excluded.prefs`)
    .run(s.endpoint, JSON.stringify({ p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) }), String(b.aparelho || '').slice(0, 80), JSON.stringify(prefs), Date.now());
  res.json(db.prepare('SELECT id, aparelho, prefs FROM push_subs WHERE endpoint = ?').get(s.endpoint));
});
router.put('/aparelhos/:id', (req, res) => {
  const prefs = (Array.isArray((req.body || {}).prefs) ? req.body.prefs : []).filter(t => TIPOS[t]);
  const r = db.prepare('UPDATE push_subs SET prefs = ? WHERE id = ?').run(JSON.stringify(prefs), req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Aparelho não encontrado.' });
  res.json({ ok: true, prefs });
});
router.delete('/aparelhos/:id', (req, res) => { db.prepare('DELETE FROM push_subs WHERE id = ?').run(req.params.id); res.json({ ok: true }); });
router.post('/teste', async (req, res) => {
  const r = await notificar({ tipo: 'sistema', titulo: '🔔 Notificações ligadas', texto: 'É assim que os alertas da central vão chegar.', url: '/' });
  res.json(r);
});

module.exports = { notificar, router, TIPOS, chaves, _t: { trocarEnvio: f => { enviarPara = f; }, limpar: () => recentes.clear() } };
