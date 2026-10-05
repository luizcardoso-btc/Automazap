// API do painel (tudo exige login, menos /login).
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { db, persistente, getSetting, setSetting, allSettings } = require('./db.js');
const engine = require('./engine.js');
const ig = require('./instagram.js');

const router = express.Router();
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const SEGREDO = sha('dm-automacao:' + process.env.ADMIN_PASSWORD);
const hmac = p => crypto.createHmac('sha256', SEGREDO).update(p).digest('hex');
const iguais = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

const emitir = () => { const p = String(Date.now() + 12 * 3600e3); return p + '.' + hmac(p); };
function tokenValido(t) {
  const [p, s] = String(t || '').split('.');
  if (!p || !s || !/^\d+$/.test(p)) return false;
  return iguais(Buffer.from(hmac(p)), Buffer.from(s)) && Number(p) > Date.now();
}

// Limite de tentativas de login por IP
const tentativas = new Map();
router.post('/login', (req, res) => {
  const t = tentativas.get(req.ip) || { n: 0, ate: Date.now() + 15 * 60e3 };
  if (t.ate < Date.now()) { t.n = 0; t.ate = Date.now() + 15 * 60e3; }
  if (t.n >= 8) return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
  t.n++; tentativas.set(req.ip, t);
  const ok = iguais(sha((req.body || {}).senha || ''), sha(process.env.ADMIN_PASSWORD));
  if (!ok) return res.status(401).json({ error: 'Senha incorreta.' });
  tentativas.delete(req.ip);
  res.json({ token: emitir() });
});

router.use((req, res, next) => {
  const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  if (m && tokenValido(m[1])) return next();
  res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
});

// ---------- status ----------
router.get('/status', (req, res) => {
  const n = (sql, ...a) => db.prepare(sql).get(...a).n;
  res.json({
    persistente,
    instagram: ig.configurado(),
    webhook_url: `${req.protocol}://${req.get('host')}/webhook/instagram`,
    contatos: n("SELECT COUNT(*) AS n FROM contacts WHERE channel <> 'sim'"),
    precisam_humano: n("SELECT COUNT(*) AS n FROM contacts WHERE needs_human = 1 AND channel <> 'sim'"),
    fluxos_ativos: n('SELECT COUNT(*) AS n FROM flows WHERE active = 1'),
    erros_24h: n("SELECT COUNT(*) AS n FROM messages WHERE status = 'erro' AND created_at > ?", Date.now() - 86400e3),
  });
});

// ---------- fluxos ----------
function validarPassos(passos) {
  if (!Array.isArray(passos) || passos.length < 1 || passos.length > 6) return 'Informe de 1 a 6 mensagens.';
  const out = [];
  for (const p of passos) {
    const type = p && p.type, text = String((p && p.text) || '').trim();
    if (!['text', 'button', 'quick'].includes(type)) return 'Tipo de mensagem inválido.';
    if (!text || text.length > 1000) return 'Cada mensagem precisa de texto (até 1000 caracteres).';
    if (type === 'text') { out.push({ type, text }); continue; }
    if (text.length > 640) return 'Mensagem com botão aceita até 640 caracteres.';
    if (type === 'button') {
      const bs = (Array.isArray(p.buttons) ? p.buttons : []).map(b => ({ title: String(b.title || '').trim(), url: String(b.url || '').trim() }));
      if (bs.length < 1 || bs.length > 3) return 'Use de 1 a 3 botões.';
      for (const b of bs) {
        if (!b.title || b.title.length > 20) return `O texto do botão "${b.title}" precisa ter de 1 a 20 caracteres (limite do Instagram).`;
        if (!/^https:\/\/\S+$/.test(b.url.replace(/\{\{\s*site\s*\}\}/g, 'https://x.com'))) return `O link do botão "${b.title}" precisa começar com https://`;
      }
      out.push({ type, text, buttons: bs });
    } else {
      const rs = (Array.isArray(p.replies) ? p.replies : []).map(r => ({ title: String(r.title || '').trim(), flow_id: Number(r.flow_id) }));
      if (rs.length < 1 || rs.length > 5) return 'Use de 1 a 5 respostas rápidas.';
      for (const r of rs) {
        if (!r.title || r.title.length > 20) return `O texto da resposta rápida "${r.title}" precisa ter de 1 a 20 caracteres.`;
        if (!Number.isInteger(r.flow_id) || r.flow_id < 1) return `Escolha o fluxo de destino da resposta "${r.title}".`;
      }
      out.push({ type, text, replies: rs });
    }
  }
  return out;
}

function validarFluxo(b) {
  b = b || {};
  const nome = String(b.name || '').trim();
  if (!nome || nome.length > 80) return { erro: 'Dê um nome ao fluxo (até 80 caracteres).' };
  const prioridade = Number.isInteger(Number(b.priority)) ? Number(b.priority) : 0;
  if (prioridade < -1000 || prioridade > 1000) return { erro: 'Prioridade entre -1000 e 1000.' };
  if (!['contem', 'exato', 'comeca'].includes(b.match_mode)) return { erro: 'Modo de busca inválido.' };
  const palavras = [...new Set((Array.isArray(b.keywords) ? b.keywords : []).map(k => String(k).trim()).filter(Boolean))];
  if (!palavras.length || palavras.length > 50) return { erro: 'Informe de 1 a 50 palavras-chave.' };
  if (palavras.some(k => k.length > 80 || engine.normalizar(k).length < 2)) return { erro: 'Cada palavra-chave precisa ter pelo menos 2 letras (até 80 caracteres).' };
  if (![null, undefined, '', 'handoff', 'silenciar'].includes(b.action)) return { erro: 'Ação inválida.' };
  const passos = validarPassos(b.steps);
  if (typeof passos === 'string') return { erro: passos };
  return { valor: { nome, prioridade, modo: b.match_mode, palavras, comentario: b.on_comment ? 1 : 0, acao: b.action || null, ativo: b.active === false ? 0 : 1, passos } };
}

router.get('/flows', (req, res) => {
  res.json(db.prepare('SELECT * FROM flows ORDER BY priority DESC, id').all().map(engine.lerFluxo));
});
router.post('/flows', (req, res) => {
  const v = validarFluxo(req.body);
  if (v.erro) return res.status(400).json({ error: v.erro });
  const x = v.valor;
  const id = db.prepare('INSERT INTO flows (name, active, priority, match_mode, keywords, on_comment, action, steps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(x.nome, x.ativo, x.prioridade, x.modo, JSON.stringify(x.palavras), x.comentario, x.acao, JSON.stringify(x.passos), Date.now()).lastInsertRowid;
  res.json(engine.fluxoPorId(Number(id)));
});
router.put('/flows/:id', (req, res) => {
  const v = validarFluxo(req.body);
  if (v.erro) return res.status(400).json({ error: v.erro });
  const x = v.valor;
  const r = db.prepare('UPDATE flows SET name=?, active=?, priority=?, match_mode=?, keywords=?, on_comment=?, action=?, steps=? WHERE id=?')
    .run(x.nome, x.ativo, x.prioridade, x.modo, JSON.stringify(x.palavras), x.comentario, x.acao, JSON.stringify(x.passos), req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Fluxo não encontrado.' });
  res.json(engine.fluxoPorId(Number(req.params.id)));
});
router.delete('/flows/:id', (req, res) => {
  const r = db.prepare('DELETE FROM flows WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Fluxo não encontrado.' });
  res.json({ ok: true });
});

// ---------- configurações ----------
const REGRAS = {
  site_url: v => /^https?:\/\/\S+$/.test(v) && v.length <= 200,
  telefone: v => v.length <= 40,
  fallback_enabled: v => v === '0' || v === '1',
  fallback_text: v => v.length <= 1000,
  fallback_cooldown_hours: v => /^\d+$/.test(v) && v >= 1 && v <= 168,
  handoff_hours: v => /^\d+$/.test(v) && v >= 1 && v <= 720,
  max_replies_hour: v => /^\d+$/.test(v) && v >= 1 && v <= 100,
};
router.get('/settings', (req, res) => res.json(allSettings()));
router.put('/settings', (req, res) => {
  const b = req.body || {};
  for (const k of Object.keys(b)) {
    if (!REGRAS[k]) return res.status(400).json({ error: `Configuração desconhecida: ${k}` });
    if (!REGRAS[k](String(b[k]).trim())) return res.status(400).json({ error: `Valor inválido em "${k}".` });
  }
  Object.keys(b).forEach(k => setSetting(k, String(b[k]).trim()));
  res.json(allSettings());
});

// ---------- conversas ----------
router.get('/contatos', (req, res) => {
  const so = req.query.precisa === '1' ? ' AND c.needs_human = 1' : '';
  res.json(db.prepare(`
    SELECT c.id, c.channel, c.username, c.name, c.needs_human, c.bot_paused_until, c.last_inbound_at,
      (SELECT MAX(created_at) FROM messages m WHERE m.contact_id = c.id) AS last_at,
      (SELECT text FROM messages m WHERE m.contact_id = c.id ORDER BY id DESC LIMIT 1) AS last_text
    FROM contacts c WHERE c.channel <> 'sim'${so} ORDER BY last_at DESC LIMIT 200`).all());
});
router.get('/contatos/:id/mensagens', (req, res) => {
  res.json(db.prepare('SELECT id, direction, kind, text, status, error, created_at FROM messages WHERE contact_id = ? ORDER BY id DESC LIMIT 200')
    .all(req.params.id).reverse());
});
router.post('/contatos/:id/retomar', (req, res) => {
  const r = db.prepare('UPDATE contacts SET needs_human = 0, bot_paused_until = 0 WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Contato não encontrado.' });
  res.json({ ok: true });
});
router.post('/contatos/:id/responder', async (req, res) => {
  const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!c || c.channel !== 'instagram') return res.status(404).json({ error: 'Contato não encontrado.' });
  const texto = String((req.body || {}).texto || '').trim();
  if (!texto || texto.length > 1000) return res.status(400).json({ error: 'Escreva a mensagem (até 1000 caracteres).' });
  if (Date.now() - c.last_inbound_at > 24 * 3600e3) {
    return res.status(409).json({ error: 'Passaram mais de 24 horas desde a última mensagem desta pessoa. O Instagram só permite responder dentro desse prazo.' });
  }
  try {
    await ig.sender.send(c, { type: 'text', text: texto });
    engine.registrar(c.id, 'out', 'manual', texto);
    // Quem respondeu à mão assume a conversa: o robô fica quieto por um tempo
    const h = Number(getSetting('handoff_hours')) || 12;
    db.prepare('UPDATE contacts SET needs_human = 0, bot_paused_until = ? WHERE id = ?').run(Date.now() + h * 3600e3, c.id);
    res.json({ ok: true });
  } catch (e) {
    engine.registrar(c.id, 'out', 'manual', texto, { erro: e.message });
    res.status(502).json({ error: e.message });
  }
});

// ---------- simulador (não envia nada ao Instagram) ----------
router.post('/simular', async (req, res) => {
  const b = req.body || {};
  const texto = String(b.texto || '').slice(0, 500);
  const respostas = [];
  const falso = {
    async send(contato, passo) { respostas.push(passo); },
    async sendPrivateReply(id, t) { respostas.push({ type: 'text', text: t, privada: true }); },
  };
  const c = engine.upsertContato({ canal: 'sim', extId: 'simulador', username: 'simulador' });
  db.prepare('DELETE FROM messages WHERE contact_id = ?').run(c.id);
  db.prepare('UPDATE contacts SET needs_human = 0, bot_paused_until = 0 WHERE id = ?').run(c.id);
  try {
    const r = b.comentario
      ? await engine.processarComentario({ canal: 'sim', commentId: 'sim-' + Date.now(), texto, fromId: 'simulador', username: 'simulador' }, falso)
      : await engine.processarMensagem({ canal: 'sim', extId: 'simulador', username: 'simulador', texto, payload: b.payload || null }, falso);
    res.json({ resultado: r, respostas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- backup e token ----------
router.get('/backup', (req, res) => {
  const tmp = path.join(os.tmpdir(), `automacao-${Date.now()}.db`);
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    res.download(tmp, `automacao-${new Date().toISOString().slice(0, 10)}.db`, () => fs.unlink(tmp, () => {}));
  } catch (e) { res.status(500).json({ error: 'Não consegui gerar o backup: ' + e.message }); }
});
router.post('/token/renovar', async (req, res) => {
  try { res.json(await ig.renovarToken()); } catch (e) { res.status(502).json({ error: e.message }); }
});

module.exports = router;
