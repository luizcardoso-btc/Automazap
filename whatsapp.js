// WhatsApp pela Evolution API (conexão por QR Code, não oficial): conversas com empresas e disparos programados.
// Montado em routes-api.js (herda o login do painel): /api/whatsapp/...  ·  Webhook público: POST /webhook/whatsapp/<token>
//
// Variáveis: EVOLUTION_URL (ex.: https://evolution-xxx.up.railway.app), EVOLUTION_API_KEY, EVOLUTION_INSTANCE (padrão: nextap).
// Não há robô respondendo no WhatsApp: as conversas com empresas são feitas por uma pessoa, com os roteiros do painel.
const express = require('express');
const crypto = require('crypto');
const { db, getSetting } = require('./db.js');

const router = express.Router();
const agora = () => Date.now();
const FUSO = 3 * 3600e3;                 // horário de Brasília (UTC-3, sem horário de verão)
const DIA = 86400e3;
const txt = (v, n) => String(v ?? '').trim().slice(0, n);

// ---------- configuração ----------
const cfg = () => ({
  url: String(process.env.EVOLUTION_URL || '').replace(/\/+$/, ''),
  chave: process.env.EVOLUTION_API_KEY || '',
  instancia: process.env.EVOLUTION_INSTANCE || 'nextap',
});
const configurado = () => { const c = cfg(); return !!(c.url && c.chave); };
// Token do webhook derivado da senha do painel: ninguém de fora consegue injetar mensagens falsas
const tokenWebhook = () => crypto.createHmac('sha256', 'wa-webhook:' + (process.env.ADMIN_PASSWORD || '')).update('evolution').digest('hex').slice(0, 32);
const urlWebhook = base => `${String(base || getSetting('public_url') || '').replace(/\/+$/, '')}/webhook/whatsapp/${tokenWebhook()}`;

async function evo(metodo, caminho, corpo) {
  const c = cfg();
  if (!c.url || !c.chave) throw new Error('WhatsApp não configurado: preencha EVOLUTION_URL e EVOLUTION_API_KEY no Railway.');
  let r;
  try {
    r = await fetch(c.url + caminho.replace('{i}', encodeURIComponent(c.instancia)), {
      method: metodo, headers: { apikey: c.chave, 'Content-Type': 'application/json' },
      body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(20000),
    });
  } catch (e) { throw new Error('Não consegui falar com a Evolution API (' + e.message + '). Confira EVOLUTION_URL e se o serviço está no ar.'); }
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { /* resposta não-JSON */ }
  if (!r.ok) {
    const m = j && (j.response && (Array.isArray(j.response.message) ? j.response.message.join('; ') : j.response.message) || j.message || j.error);
    const e = new Error(`Evolution respondeu ${r.status}: ${typeof m === 'string' ? m : JSON.stringify(m || t).slice(0, 300)}`);
    e.status = r.status; throw e;
  }
  return j;
}

// ---------- números ----------
// "(75) 98820-9055" → "5575988209055". Número de fora do Brasil: escreva com o código do país (ex.: +351...).
function normalizarNumero(v) {
  const s = String(v || '').trim();
  let d = s.replace(/\D/g, '').replace(/^0+/, '');
  if (!d) return '';
  if (!s.startsWith('+') && (d.length === 10 || d.length === 11)) d = '55' + d;
  return d.length >= 10 && d.length <= 15 ? d : '';
}
const jidDe = numero => numero + '@s.whatsapp.net';
const numeroDoJid = jid => String(jid || '').split('@')[0].split(':')[0];
// Mesmo celular com ou sem o 9 extra (contas antigas do WhatsApp): DDD + 8 últimos dígitos
const chaveTel = n => (n.startsWith('55') && n.length >= 12 ? n.slice(2, 4) : '') + n.slice(-8);

function prospectDoNumero(numero) {
  const k = chaveTel(numero);
  for (const p of db.prepare("SELECT id, telefone FROM prospects WHERE telefone <> ''").all()) {
    const n = normalizarNumero(p.telefone);
    if (n && chaveTel(n) === k) return p.id;
  }
  return null;
}

function contatoPorJid(jid, { nome = '', grupo = false, doWhatsapp = false } = {}) {
  let c = db.prepare('SELECT * FROM wa_contatos WHERE jid = ?').get(jid);
  if (!c && !grupo) {
    // Mesmo celular com/sem o 9 extra: continua na mesma conversa e passa a usar o id que o WhatsApp mandou
    const k = chaveTel(numeroDoJid(jid));
    c = db.prepare('SELECT * FROM wa_contatos WHERE grupo = 0').all().find(x => chaveTel(numeroDoJid(x.jid)) === k);
    if (c && doWhatsapp) { db.prepare('UPDATE wa_contatos SET jid = ? WHERE id = ?').run(jid, c.id); c.jid = jid; }
  }
  if (!c) {
    const prospect = grupo ? null : prospectDoNumero(numeroDoJid(jid));
    const r = db.prepare('INSERT INTO wa_contatos (jid, nome, grupo, prospect_id, criado_em) VALUES (?, ?, ?, ?, ?)').run(jid, txt(nome, 120), grupo ? 1 : 0, prospect, agora());
    c = db.prepare('SELECT * FROM wa_contatos WHERE id = ?').get(r.lastInsertRowid);
  } else if (nome && !c.nome) {
    db.prepare('UPDATE wa_contatos SET nome = ? WHERE id = ?').run(txt(nome, 120), c.id);
    c.nome = txt(nome, 120);
  }
  return c;
}

function registrar(contatoId, direcao, origem, texto, extra = {}) {
  const r = db.prepare(`INSERT OR IGNORE INTO wa_mensagens (contato_id, direcao, origem, texto, midia_url, status, erro, wa_id, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(contatoId, direcao, origem, txt(texto, 4000), extra.midia || null,
    extra.erro ? 'erro' : 'ok', extra.erro || null, extra.waId || null, extra.em || agora());
  return r.changes === 1;
}

// Histórico da empresa na Prospecção (contato por WhatsApp; "novo" passa a "abordado")
function anotarProspect(prospectId, texto, { abordou = false } = {}) {
  if (!prospectId) return;
  const p = db.prepare('SELECT status FROM prospects WHERE id = ?').get(prospectId);
  if (!p) return;
  const quando = new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.prepare("INSERT INTO prospect_hist (prospect_id, tipo, texto, criado_em) VALUES (?, 'whatsapp', ?, ?)").run(prospectId, txt(texto, 800), quando);
  db.prepare("UPDATE prospects SET status = ?, atualizado_em = datetime('now') WHERE id = ?").run(abordou && p.status === 'novo' ? 'abordado' : p.status, prospectId);
}

// ---------- limite de primeiras mensagens (protege o número de bloqueio) ----------
const inicioDoDia = (t = agora()) => Math.floor((t - FUSO) / DIA) * DIA + FUSO;   // meia-noite em Brasília
const ehNovo = c => !c.grupo && !c.ultimo_in && !db.prepare("SELECT 1 FROM wa_mensagens WHERE contato_id = ? AND direcao = 'out' AND status = 'ok'").get(c.id);
function novosHoje() {
  return db.prepare(`SELECT COUNT(*) AS n FROM wa_contatos c WHERE c.grupo = 0 AND c.ultimo_in = 0 AND
    (SELECT MIN(m.criado_em) FROM wa_mensagens m WHERE m.contato_id = c.id AND m.direcao = 'out' AND m.status = 'ok') >= ?`).get(inicioDoDia()).n;
}
const limiteNovos = () => Number(getSetting('wa_max_novos_dia')) || 30;

// ---------- envio ----------
let ultimoEnvio = 0;
const intervalo = () => (Number(process.env.WA_GAP_MS) >= 0 && process.env.WA_GAP_MS != null && process.env.WA_GAP_MS !== '' ? Number(process.env.WA_GAP_MS) : 4000);
async function espaçar() {
  const falta = ultimoEnvio + intervalo() - agora();
  if (falta > 0) await new Promise(r => setTimeout(r, falta));
  ultimoEnvio = agora();
}

async function enviar(contato, { texto = '', midia = null }, origem = 'painel') {
  const numero = contato.grupo ? contato.jid : numeroDoJid(contato.jid);
  await espaçar();
  let r;
  try {
    r = midia
      ? await evo('POST', '/message/sendMedia/{i}', { number: numero, mediatype: /\.(mp4|mov)(\?|$)/i.test(midia) ? 'video' : 'image', media: midia, caption: texto })
      : await evo('POST', '/message/sendText/{i}', { number: numero, text: texto });
  } catch (e) {
    registrar(contato.id, 'out', origem, texto, { midia, erro: e.message });
    throw e;
  }
  const waId = r && r.key && r.key.id;
  registrar(contato.id, 'out', origem, texto, { midia, waId });
  db.prepare('UPDATE wa_contatos SET ultimo_out = ? WHERE id = ?').run(agora(), contato.id);
  return { waId };
}

// ---------- webhook (mensagens que chegam) ----------
function textoDa(m) {
  if (!m) return '';
  const t = m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || (m.imageMessage && m.imageMessage.caption)
    || (m.videoMessage && m.videoMessage.caption) || (m.buttonsResponseMessage && m.buttonsResponseMessage.selectedDisplayText)
    || (m.listResponseMessage && m.listResponseMessage.title);
  if (t) return t;
  if (m.audioMessage) return '[áudio]';
  if (m.imageMessage) return '[imagem]';
  if (m.videoMessage) return '[vídeo]';
  if (m.documentMessage) return '[documento] ' + (m.documentMessage.fileName || '');
  if (m.stickerMessage) return '[figurinha]';
  if (m.locationMessage) return '[localização]';
  if (m.contactMessage) return '[contato] ' + (m.contactMessage.displayName || '');
  return '';
}

function processarWebhook(corpo) {
  const ev = String((corpo && corpo.event) || '').toLowerCase().replace(/_/g, '.');
  if (ev !== 'messages.upsert') return { ignorado: ev || 'sem evento' };
  const lista = Array.isArray(corpo.data) ? corpo.data : corpo.data && Array.isArray(corpo.data.messages) ? corpo.data.messages : [corpo.data];
  let salvas = 0;
  for (const d of lista) {
    if (!d || !d.key) continue;
    // Conversas novas podem vir com id "@lid": o número de verdade vem em remoteJidAlt / senderPn
    let jid = d.key.remoteJid || '';
    if (jid.endsWith('@lid')) jid = d.key.remoteJidAlt || d.key.senderPn || jid;
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@g.us') || jid.endsWith('@newsletter') || jid.endsWith('@lid')) continue; // grupos não entram na caixa de entrada
    const texto = textoDa(d.message);
    if (!texto) continue;
    const em = d.messageTimestamp ? Number(d.messageTimestamp) * 1000 : agora();
    const c = contatoPorJid(jid, { nome: d.key.fromMe ? '' : d.pushName, doWhatsapp: true });
    if (d.key.fromMe) {
      if (registrar(c.id, 'out', 'celular', texto, { waId: d.key.id, em })) db.prepare('UPDATE wa_contatos SET ultimo_out = ? WHERE id = ?').run(em, c.id);
      continue;
    }
    if (!registrar(c.id, 'in', 'cliente', texto, { waId: d.key.id, em })) continue;   // repetido
    db.prepare('UPDATE wa_contatos SET ultimo_in = ?, nao_lidas = nao_lidas + 1 WHERE id = ?').run(em, c.id);
    anotarProspect(c.prospect_id, 'Respondeu no WhatsApp: ' + texto);
    salvas++;
  }
  return { salvas };
}

// ---------- disparos programados ----------
// Próximo horário (Brasília) depois de "depois": envio único (data + hora) ou repetindo nos dias da semana marcados
function proximoEnvio(d, depois = agora()) {
  const [h, m] = String(d.hora).split(':').map(Number);
  const dias = Array.isArray(d.dias) ? d.dias : JSON.parse(d.dias || '[]');
  if (!dias.length) {
    if (!d.data) return null;
    const t = Date.parse(`${d.data}T${String(d.hora)}:00-03:00`);
    return t > depois ? t : null;
  }
  const hoje = inicioDoDia(depois);
  for (let i = 0; i <= 7; i++) {
    const dia0 = hoje + i * DIA, t = dia0 + (h * 60 + m) * 60e3;
    const semana = new Date(dia0 - FUSO + 12 * 3600e3).getUTCDay();
    if (dias.includes(semana) && t > depois) return t;
  }
  return null;
}

let rodando = false;
async function tick({ agoraMs } = {}) {
  if (rodando || !configurado()) return { enviados: 0 };
  rodando = true;
  const t0 = agoraMs || agora();
  let enviados = 0;
  try {
    for (const d of db.prepare('SELECT * FROM wa_disparos WHERE ativo = 1 AND proximo_em IS NOT NULL AND proximo_em <= ? ORDER BY proximo_em LIMIT 10').all(t0)) {
      // Antes de enviar: agenda o próximo (nunca envia duas vezes o mesmo horário, mesmo se cair no meio)
      const prox = proximoEnvio(d, Math.max(t0, d.proximo_em));
      db.prepare('UPDATE wa_disparos SET proximo_em = ?, ultimo_em = ? WHERE id = ?').run(prox, t0, d.id);
      const c = contatoPorJid(d.alvo_jid, { nome: d.alvo_nome, grupo: d.alvo_jid.endsWith('@g.us') });
      try {
        await enviar(c, { texto: d.texto, midia: d.midia_url }, 'disparo');
        db.prepare('UPDATE wa_disparos SET enviados = enviados + 1, ultimo_erro = NULL WHERE id = ?').run(d.id);
        enviados++;
      } catch (e) {
        db.prepare('UPDATE wa_disparos SET ultimo_erro = ? WHERE id = ?').run(txt(e.message, 300), d.id);
        console.error('[WHATSAPP] disparo', d.id, e.message);
      }
    }
  } finally { rodando = false; }
  return { enviados };
}

function validarDisparo(b) {
  b = b || {};
  const nome = txt(b.nome, 80);
  const texto = String(b.texto ?? '').trim().slice(0, 4000);
  const midia = txt(b.midia_url, 500) || null;
  if (!texto && !midia) return { erro: 'Escreva a mensagem (ou informe uma imagem).' };
  if (midia && !/^https:\/\/\S+$/.test(midia)) return { erro: 'A imagem/vídeo precisa ser um link https:// público.' };
  let alvo = txt(b.alvo_jid, 120);
  if (!alvo) return { erro: 'Escolha o grupo ou o número que recebe o disparo.' };
  if (!alvo.endsWith('@g.us')) { const n = normalizarNumero(alvo); if (!n) return { erro: 'Número inválido. Use DDD + número, ex.: 75 98820-9055.' }; alvo = jidDe(n); }
  const hora = txt(b.hora, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) return { erro: 'Informe a hora no formato 09:30.' };
  const dias = [...new Set((Array.isArray(b.dias) ? b.dias : []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
  const data = dias.length ? null : txt(b.data, 10);
  if (!dias.length && !/^\d{4}-\d\d-\d\d$/.test(data || '')) return { erro: 'Escolha a data do envio, ou os dias da semana para repetir.' };
  const v = { nome: nome || (texto || 'Disparo').slice(0, 40), alvo_jid: alvo, alvo_nome: txt(b.alvo_nome, 120), texto, midia_url: midia, hora, data, dias: JSON.stringify(dias), ativo: b.ativo === false ? 0 : 1 };
  v.proximo_em = v.ativo ? proximoEnvio(v) : null;
  if (v.ativo && !v.proximo_em) return { erro: 'Esse horário já passou. Escolha uma data e hora no futuro.' };
  return { v };
}
const lerDisparo = d => d && ({ ...d, dias: JSON.parse(d.dias || '[]'), ativo: !!d.ativo });

// ---------- rotas do painel ----------
router.get('/status', async (req, res) => {
  const out = { configurado: configurado(), instancia: cfg().instancia, webhook_url: urlWebhook(getSetting('public_url') || `${req.protocol}://${req.get('host')}`),
    estado: null, numero: null, erro: null, novos_hoje: novosHoje(), limite_novos: limiteNovos(),
    nao_lidas: db.prepare('SELECT COALESCE(SUM(nao_lidas), 0) AS n FROM wa_contatos').get().n };
  if (out.configurado) {
    try {
      const s = await evo('GET', '/instance/connectionState/{i}');
      out.estado = (s && s.instance && s.instance.state) || (s && s.state) || null;
      if (out.estado === 'open') {
        try {
          const l = await evo('GET', '/instance/fetchInstances?instanceName=' + encodeURIComponent(cfg().instancia));
          const i = Array.isArray(l) ? l[0] : l;
          const dono = i && (i.ownerJid || (i.instance && i.instance.owner));
          if (dono) out.numero = numeroDoJid(dono);
        } catch (e) { /* número é só informativo */ }
      }
    } catch (e) { out.erro = e.status === 404 ? null : e.message; out.estado = e.status === 404 ? 'sem_instancia' : null; }
  }
  res.json(out);
});

// Cria a instância (se preciso), devolve o QR Code e já aponta o webhook para este painel
router.post('/conectar', async (req, res) => {
  try {
    let qr = null, codigo = null;
    try {
      const r = await evo('POST', '/instance/create', { instanceName: cfg().instancia, qrcode: true, integration: 'WHATSAPP-BAILEYS' });
      qr = r && r.qrcode && r.qrcode.base64; codigo = r && r.qrcode && r.qrcode.pairingCode;
    } catch (e) { if (![400, 403, 409].includes(e.status)) throw e; }   // já existe
    if (!qr) {
      const r = await evo('GET', '/instance/connect/{i}');
      qr = r && (r.base64 || (r.qrcode && r.qrcode.base64)); codigo = r && (r.pairingCode || null);
      if (r && r.instance && r.instance.state === 'open') return res.json({ estado: 'open' });
    }
    let webhook = null;
    const base = getSetting('public_url') || `${req.protocol}://${req.get('host')}`;
    try { await configurarWebhook(base); webhook = 'ok'; } catch (e) { webhook = e.message; }
    res.json({ qr: qr && !qr.startsWith('data:') ? 'data:image/png;base64,' + qr : qr, codigo, webhook });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
async function configurarWebhook(base) {
  return evo('POST', '/webhook/set/{i}', { webhook: { enabled: true, url: urlWebhook(base), webhookByEvents: false, webhookBase64: false, events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'] } });
}
router.post('/webhook', async (req, res) => {
  try { await configurarWebhook(getSetting('public_url') || `${req.protocol}://${req.get('host')}`); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
router.post('/desconectar', async (req, res) => {
  try { await evo('DELETE', '/instance/logout/{i}'); res.json({ ok: true }); } catch (e) { res.status(502).json({ error: e.message }); }
});

router.get('/grupos', async (req, res) => {
  try {
    const l = await evo('GET', '/group/fetchAllGroups/{i}?getParticipants=false');
    res.json((Array.isArray(l) ? l : []).map(g => ({ jid: g.id, nome: g.subject || g.id, membros: g.size || (g.participants || []).length || null }))
      .sort((a, b) => a.nome.localeCompare(b.nome)));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

const LISTA = `SELECT c.*, p.nome AS empresa, p.status AS empresa_status, p.segmento AS empresa_segmento,
  (SELECT texto FROM wa_mensagens m WHERE m.contato_id = c.id ORDER BY id DESC LIMIT 1) AS ultimo_texto,
  (SELECT direcao FROM wa_mensagens m WHERE m.contato_id = c.id ORDER BY id DESC LIMIT 1) AS ultima_direcao,
  MAX(c.ultimo_in, c.ultimo_out) AS ultima
  FROM wa_contatos c LEFT JOIN prospects p ON p.id = c.prospect_id`;
router.get('/conversas', (req, res) => {
  res.json(db.prepare(LISTA + ' WHERE c.grupo = 0 AND EXISTS (SELECT 1 FROM wa_mensagens m WHERE m.contato_id = c.id) ORDER BY ultima DESC, c.id DESC LIMIT 500').all());
});
router.get('/conversas/:id', (req, res) => {
  const c = db.prepare(LISTA + ' WHERE c.id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Conversa não encontrada.' });
  db.prepare('UPDATE wa_contatos SET nao_lidas = 0 WHERE id = ?').run(c.id);
  c.mensagens = db.prepare('SELECT id, direcao, origem, texto, midia_url, status, erro, criado_em FROM wa_mensagens WHERE contato_id = ? ORDER BY id DESC LIMIT 300').all(c.id).reverse();
  res.json(c);
});
// Abre (ou cria) a conversa de um número ou de uma empresa da Prospecção, sem enviar nada
router.post('/conversas', (req, res) => {
  const b = req.body || {};
  let numero = normalizarNumero(b.numero), prospect = null;
  if (b.prospect_id) {
    prospect = db.prepare('SELECT id, nome, telefone FROM prospects WHERE id = ?').get(b.prospect_id);
    if (!prospect) return res.status(404).json({ error: 'Empresa não encontrada.' });
    numero = numero || normalizarNumero(prospect.telefone);
  }
  if (!numero) return res.status(400).json({ error: 'Número inválido. Use DDD + número, ex.: 75 98820-9055.' });
  const c = contatoPorJid(jidDe(numero), { nome: txt(b.nome, 120) || (prospect && prospect.nome) || '' });
  if (prospect && c.prospect_id !== prospect.id) db.prepare('UPDATE wa_contatos SET prospect_id = ? WHERE id = ?').run(prospect.id, c.id);
  res.json(db.prepare(LISTA + ' WHERE c.id = ?').get(c.id));
});
router.post('/conversas/:id/enviar', async (req, res) => {
  const c = db.prepare('SELECT * FROM wa_contatos WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Conversa não encontrada.' });
  const texto = String((req.body || {}).texto ?? '').trim().slice(0, 4000);
  const midia = txt((req.body || {}).midia_url, 500) || null;
  if (!texto && !midia) return res.status(400).json({ error: 'Escreva a mensagem.' });
  if (midia && !/^https:\/\/\S+$/.test(midia)) return res.status(400).json({ error: 'A imagem/vídeo precisa ser um link https:// público.' });
  if (ehNovo(c) && novosHoje() >= limiteNovos()) {
    return res.status(429).json({ error: `Limite de ${limiteNovos()} primeiras mensagens por dia atingido. Mandar para muitos números que nunca falaram com você é o que faz o WhatsApp bloquear o número. Continue amanhã ou ajuste em Configurações.` });
  }
  const novo = ehNovo(c);
  try {
    await enviar(c, { texto, midia });
    anotarProspect(c.prospect_id, (novo ? 'Abordagem pelo WhatsApp: ' : 'WhatsApp: ') + texto, { abordou: true });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

router.get('/disparos', (req, res) => res.json(db.prepare('SELECT * FROM wa_disparos ORDER BY ativo DESC, COALESCE(proximo_em, 9e15), id DESC').all().map(lerDisparo)));
router.post('/disparos', (req, res) => {
  const r = validarDisparo(req.body); if (r.erro) return res.status(400).json({ error: r.erro });
  const v = r.v;
  const id = db.prepare(`INSERT INTO wa_disparos (nome, alvo_jid, alvo_nome, texto, midia_url, hora, data, dias, ativo, proximo_em, criado_em)
    VALUES (@nome, @alvo_jid, @alvo_nome, @texto, @midia_url, @hora, @data, @dias, @ativo, @proximo_em, ${agora()})`).run(v).lastInsertRowid;
  res.json(lerDisparo(db.prepare('SELECT * FROM wa_disparos WHERE id = ?').get(id)));
});
router.put('/disparos/:id', (req, res) => {
  const r = validarDisparo(req.body); if (r.erro) return res.status(400).json({ error: r.erro });
  const x = db.prepare(`UPDATE wa_disparos SET nome=@nome, alvo_jid=@alvo_jid, alvo_nome=@alvo_nome, texto=@texto, midia_url=@midia_url, hora=@hora,
    data=@data, dias=@dias, ativo=@ativo, proximo_em=@proximo_em WHERE id=@id`).run({ ...r.v, id: Number(req.params.id) });
  if (!x.changes) return res.status(404).json({ error: 'Disparo não encontrado.' });
  res.json(lerDisparo(db.prepare('SELECT * FROM wa_disparos WHERE id = ?').get(req.params.id)));
});
router.delete('/disparos/:id', (req, res) => { db.prepare('DELETE FROM wa_disparos WHERE id = ?').run(req.params.id); res.json({ ok: true }); });
router.post('/disparos/:id/enviar-agora', async (req, res) => {
  const d = db.prepare('SELECT * FROM wa_disparos WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Disparo não encontrado.' });
  const c = contatoPorJid(d.alvo_jid, { nome: d.alvo_nome, grupo: d.alvo_jid.endsWith('@g.us') });
  try {
    await enviar(c, { texto: d.texto, midia: d.midia_url }, 'disparo');
    db.prepare('UPDATE wa_disparos SET enviados = enviados + 1, ultimo_em = ?, ultimo_erro = NULL WHERE id = ?').run(agora(), d.id);
    res.json({ ok: true });
  } catch (e) {
    db.prepare('UPDATE wa_disparos SET ultimo_erro = ? WHERE id = ?').run(txt(e.message, 300), d.id);
    res.status(502).json({ error: e.message });
  }
});

module.exports = { router, tick, processarWebhook, tokenWebhook, configurado, normalizarNumero, proximoEnvio, chaveTel };
