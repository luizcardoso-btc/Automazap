// Motor de conversa: independe do canal. O canal (Instagram, depois WhatsApp) só entrega eventos e envia respostas.
//
//   evento de mensagem  → { canal, extId, username, texto, payload, mid }
//   evento de comentário → { canal, commentId, texto, fromId, username }
//   sender              → { send(contato, passo), sendPrivateReply(commentId, texto) }
const { db, getSetting } = require('./db.js');

const agora = () => Date.now();

// minúsculas, sem acento, sem pontuação: "Qual o PREÇO?" → "qual o preco"
const normalizar = s => String(s == null ? '' : s)
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Palavra inteira (não acha "nfc" dentro de outra palavra) e aceita plural simples: preço/preços.
function criarRegex(palavra, modo) {
  const k = normalizar(palavra);
  if (!k) return null;
  const e = escapeRe(k);
  if (modo === 'exato') return new RegExp('^' + e + '(s|es)?$');
  if (modo === 'comeca') return new RegExp('^' + e + '(s|es)?( |$)');
  return new RegExp('(^| )' + e + '(s|es)?( |$)');
}

const lerFluxo = r => r && ({
  ...r, active: !!r.active, on_comment: !!r.on_comment,
  keywords: JSON.parse(r.keywords || '[]'), steps: JSON.parse(r.steps || '[]'), tags: JSON.parse(r.tags || '[]'),
});
const fluxoPorId = id => lerFluxo(db.prepare('SELECT * FROM flows WHERE id = ?').get(id));

// Escolhe o fluxo: maior prioridade; empate → palavra-chave mais longa (mais específica).
function acharFluxo(texto, { comentario = false } = {}) {
  const t = normalizar(texto);
  if (!t) return null;
  let melhor = null;
  for (const r of db.prepare("SELECT * FROM flows WHERE active = 1 AND kind = 'normal'" + (comentario ? ' AND on_comment = 1' : '')).all()) {
    const f = lerFluxo(r);
    let len = -1;
    for (const kw of f.keywords) {
      const re = criarRegex(kw, f.match_mode);
      if (re && re.test(t)) len = Math.max(len, normalizar(kw).length);
    }
    if (len < 0) continue;
    if (!melhor || f.priority > melhor.f.priority || (f.priority === melhor.f.priority && len > melhor.len)) melhor = { f, len };
  }
  return melhor && melhor.f;
}

// ---------- etiquetas do funil ----------
const ETAPAS = ['NOVO LEAD', 'REVENDEDOR', 'QUANTIDADE', 'VIU DEMO', 'VIU PREÇO', 'ABRIU CHECKOUT', 'QUENTE', 'VENDA', 'FOLLOW-UP'];
const tagsDe = c => { try { return JSON.parse(c.tags || '[]'); } catch (e) { return []; } };
function addTag(contatoId, tag) {
  const c = db.prepare('SELECT tags FROM contacts WHERE id = ?').get(contatoId);
  if (!c) return;
  const t = tagsDe(c);
  if (!t.includes(tag)) db.prepare('UPDATE contacts SET tags = ? WHERE id = ?').run(JSON.stringify([...t, tag]), contatoId);
}
function removeTag(contatoId, tag) {
  const c = db.prepare('SELECT tags FROM contacts WHERE id = ?').get(contatoId);
  if (c) db.prepare('UPDATE contacts SET tags = ? WHERE id = ?').run(JSON.stringify(tagsDe(c).filter(x => x !== tag)), contatoId);
}

// ---------- link rastreado: /go/<token> registra o clique e redireciona ----------
function urlDoSite() {
  const base = getSetting('site_url') || '';
  return base + (base.includes('?') ? '&' : '?') + 'utm_source=instagram&utm_medium=dm&utm_campaign=nextap_bot';
}
function criarLink(contato, destino) {
  const pub = (getSetting('public_url') || '').replace(/\/+$/, '');
  if (!pub || !contato.id) return destino; // sem endereço público: link direto (sem rastreio)
  const existente = db.prepare('SELECT token FROM links WHERE contact_id = ? AND url = ?').get(contato.id, destino);
  if (existente) return `${pub}/go/${existente.token}`;
  const token = require('crypto').randomBytes(6).toString('base64url');
  db.prepare('INSERT INTO links (token, contact_id, url, created_at) VALUES (?, ?, ?, ?)').run(token, contato.id, destino, agora());
  return `${pub}/go/${token}`;
}
// Retorna o destino. No primeiro clique agenda a mensagem do fluxo de evento "clique_link".
function registrarClique(token) {
  const l = db.prepare('SELECT * FROM links WHERE token = ?').get(String(token || ''));
  if (!l) return null;
  const t = agora();
  db.prepare('UPDATE links SET clicks = clicks + 1, last_click_at = ? WHERE token = ?').run(t, l.token);
  db.prepare('UPDATE contacts SET last_click_at = ? WHERE id = ?').run(t, l.contact_id);
  addTag(l.contact_id, 'ABRIU CHECKOUT');
  if (l.clicks === 0) {
    const f = db.prepare("SELECT id FROM flows WHERE kind = 'evento' AND event = 'clique_link' AND active = 1 ORDER BY id LIMIT 1").get();
    if (f) db.prepare('INSERT INTO agenda (contact_id, flow_id, run_at) VALUES (?, ?, ?)').run(l.contact_id, f.id, t + (Number(process.env.CLICK_DELAY_MS) >= 0 ? Number(process.env.CLICK_DELAY_MS) : 25000));
  }
  return l.url;
}

// {{nome}}, {{site}}, {{link}} (link do site com rastreio), {{telefone}}, {{video_demo}}
function aplicarVars(texto, contato) {
  // Só usa um nome de verdade: @usuario com números/pontos/_ não vira "Oi, joao_88"
  const bruto = String(contato.name || '').trim() || (/^[A-Za-zÀ-ÿ]+$/.test(contato.username || '') ? contato.username : '');
  const nome = bruto.split(/\s+/)[0];
  const site = getSetting('site_url') || '';
  let base = String(texto == null ? '' : texto);
  if (!nome) base = base.replace(/,\s*\{\{\s*nome\s*\}\}/g, '').replace(/\{\{\s*nome\s*\}\}\s*/g, '');
  return base
    .replace(/\{\{\s*nome\s*\}\}/g, nome)
    .replace(/\{\{\s*site\s*\}\}/g, site)
    .replace(/\{\{\s*link\s*\}\}/g, () => criarLink(contato, urlDoSite()))
    .replace(/\{\{\s*telefone\s*\}\}/g, getSetting('telefone') || '')
    .replace(/\{\{\s*video_demo\s*\}\}/g, getSetting('video_demo_url') || '')
    .replace(/\s+([!,.?])/g, '$1');
}
function passoComVars(passo, contato) {
  const p = { ...passo };
  if (passo.text != null) p.text = aplicarVars(passo.text, contato);
  if (passo.url != null) p.url = aplicarVars(passo.url, contato).trim();
  if (passo.buttons) p.buttons = passo.buttons.map(b => ({ ...b, title: aplicarVars(b.title, contato), url: aplicarVars(b.url, contato) }));
  if (passo.replies) p.replies = passo.replies.map(r => ({ ...r, title: aplicarVars(r.title, contato) }));
  return p;
}
// Versão em texto puro (usada em resposta a comentário, no histórico e quando o botão falha)
function passoParaTexto(passo) {
  if (passo.type === 'video' || passo.type === 'image') return `[${passo.type === 'video' ? 'vídeo' : 'imagem'}] ${passo.url || ''}`;
  let t = passo.text || '';
  (passo.buttons || []).forEach(b => { t += `\n${b.title}: ${b.url}`; });
  return t;
}

const KIND = { text: 'texto', button: 'botao', quick: 'rapidas', video: 'midia', image: 'midia' };
const registrar = (contatoId, direcao, kind, texto, extra = {}) => db.prepare(
  'INSERT INTO messages (contact_id, direction, kind, text, flow_id, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
).run(contatoId, direcao, kind, texto, extra.flowId || null, extra.erro ? 'erro' : 'ok', extra.erro || null, agora());

function marcarProcessado(id) {
  return db.prepare('INSERT OR IGNORE INTO processed (id, at) VALUES (?, ?)').run(id, agora()).changes === 1;
}

function upsertContato({ canal, extId, username }) {
  const novo = !db.prepare('SELECT 1 FROM contacts WHERE channel = ? AND ext_id = ?').get(canal, String(extId));
  db.prepare(`INSERT INTO contacts (channel, ext_id, username, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(channel, ext_id) DO UPDATE SET username = COALESCE(excluded.username, contacts.username)`)
    .run(canal, String(extId), username || null, agora());
  const c = db.prepare('SELECT * FROM contacts WHERE channel = ? AND ext_id = ?').get(canal, String(extId));
  if (novo) { addTag(c.id, 'NOVO LEAD'); return db.prepare('SELECT * FROM contacts WHERE id = ?').get(c.id); }
  return c;
}

function limiteAtingido(contatoId) {
  const max = Number(getSetting('max_replies_hour')) || 8;
  const n = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE contact_id = ? AND direction = 'out' AND status = 'ok' AND created_at > ?")
    .get(contatoId, agora() - 3600e3).n;
  return n >= max;
}

const dormir = ms => ms > 0 ? new Promise(r => setTimeout(r, ms)) : null;
const pausaEntreMensagens = () => Number(process.env.STEP_DELAY_MS) >= 0 && process.env.STEP_DELAY_MS !== '' && process.env.STEP_DELAY_MS != null ? Number(process.env.STEP_DELAY_MS) : 700;

// Aviso opcional no Telegram quando um lead pede (ou merece) atendimento humano
async function avisarHumano(contato, fluxo, prioridade) {
  const tk = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tk || !chat || process.env.NODE_ENV === 'test') return;
  const nome = contato.username ? '@' + contato.username : 'contato ' + contato.id;
  try {
    await fetch(`https://api.telegram.org/bot${tk}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: `${prioridade >= 2 ? '🔥 PRIORIDADE ALTA' : '🙋 Pediu atendimento'}: ${nome}\nFluxo: ${fluxo.name}\nAbra o painel para responder (janela de 24h do Instagram).` }),
    });
  } catch (e) { console.error('[TELEGRAM]', e.message); }
}

async function enviarFluxo(contato, fluxo, sender) {
  const enviados = [];
  let primeiro = true;
  for (const passo of fluxo.steps) {
    const p = passoComVars(passo, contato);
    const midia = p.type === 'video' || p.type === 'image';
    if (midia && !p.url) continue;                 // vídeo ainda não configurado: pula sem travar a conversa
    if (!primeiro) await dormir(pausaEntreMensagens());
    primeiro = false;
    try {
      await sender.send(contato, p);
      registrar(contato.id, 'out', KIND[p.type] || 'texto', passoParaTexto(p), { flowId: fluxo.id });
      enviados.push(p);
    } catch (e) {
      registrar(contato.id, 'out', KIND[p.type] || 'texto', passoParaTexto(p), { flowId: fluxo.id, erro: e.message });
      console.error(`[BOT] falha ao enviar (fluxo ${fluxo.id}):`, e.message);
      if (midia) continue;                          // mídia que falha não derruba o resto
      break;                                        // texto que falha: não manda o resto fora de ordem
    }
  }
  (fluxo.tags || []).forEach(t => addTag(contato.id, t));
  const prio = Math.max(Number(fluxo.human_priority) || 0, fluxo.action === 'handoff' ? 1 : 0);
  if (prio > 0) {
    const atual = db.prepare('SELECT human_priority FROM contacts WHERE id = ?').get(contato.id);
    db.prepare('UPDATE contacts SET needs_human = 1, human_priority = ? WHERE id = ?').run(Math.max(prio, atual.human_priority), contato.id);
    avisarHumano(contato, fluxo, prio);
  }
  if (fluxo.action === 'handoff') {
    const h = Number(getSetting('handoff_hours')) || 12;
    db.prepare('UPDATE contacts SET bot_paused_until = ? WHERE id = ?').run(agora() + h * 3600e3, contato.id);
  } else if (fluxo.action === 'silenciar') {
    db.prepare('UPDATE contacts SET needs_human = 0, human_priority = 0, bot_paused_until = ? WHERE id = ?').run(agora() + 365 * 86400e3, contato.id);
  }
  return enviados;
}

// Resposta digitada à pergunta "quantas placas?": "100", "uns 50 placas" → faixa certa (só para quem já é REVENDEDOR)
const FAIXAS = [[10, 'qtd_1_10'], [49, 'qtd_11_49'], [299, 'qtd_50_299'], [Infinity, 'qtd_300']];
function fluxoPorQuantidade(texto, contato) {
  if (!tagsDe(contato).includes('REVENDEDOR')) return null;
  const m = /^(?:uns |umas |cerca de |quero |preciso de )?(\d{1,5})(?: (?:placas?|unidades?|pecas?))?$/.exec(normalizar(texto));
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1) return null;
  const ev = FAIXAS.find(f => n <= f[0])[1];
  return lerFluxo(db.prepare("SELECT * FROM flows WHERE kind = 'botao' AND event = ? AND active = 1 ORDER BY id LIMIT 1").get(ev));
}

async function processarMensagem(ev, sender) {
  if (ev.mid && !marcarProcessado('m:' + ev.mid)) return { acao: 'ignorada', motivo: 'duplicada' };
  const contato = upsertContato(ev);
  db.prepare('UPDATE contacts SET last_inbound_at = ?, followup_step = 0 WHERE id = ?').run(agora(), contato.id);
  registrar(contato.id, 'in', 'texto', ev.texto || (ev.payload ? `[botão] ${ev.payload}` : ''));

  const atual = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contato.id);
  if (atual.bot_paused_until > agora()) return { acao: 'ignorada', motivo: 'pausado' };
  if (limiteAtingido(contato.id)) return { acao: 'ignorada', motivo: 'limite_por_hora' };

  let fluxo = null;
  const m = /^FLOW:(\d+)$/.exec(ev.payload || '');
  if (m) fluxo = fluxoPorId(Number(m[1]));
  if (!fluxo || !fluxo.active) fluxo = (!ev.payload && fluxoPorQuantidade(ev.texto, atual)) || acharFluxo(ev.texto);

  if (fluxo) {
    const enviados = await enviarFluxo(atual, fluxo, sender);
    return { acao: 'respondeu', fluxo: fluxo.name, enviados: enviados.length };
  }

  // Respondeu (texto livre) a um follow-up: quem está engajado vai para uma pessoa, em vez de cair na resposta padrão
  if (contato.followup_step > 0) {
    const r = db.prepare("SELECT * FROM flows WHERE kind = 'evento' AND event = 'resposta_followup' AND active = 1 ORDER BY id LIMIT 1").get();
    if (r) { const enviados = await enviarFluxo(atual, lerFluxo(r), sender); return { acao: 'respondeu', fluxo: r.name, enviados: enviados.length }; }
  }

  // Sem fluxo: resposta padrão, no máximo uma por pessoa a cada X horas
  if (getSetting('fallback_enabled') === '1' && getSetting('fallback_text')) {
    const horas = Number(getSetting('fallback_cooldown_hours')) || 24;
    const jaMandou = db.prepare("SELECT 1 FROM messages WHERE contact_id = ? AND kind = 'fallback' AND direction = 'out' AND created_at > ?")
      .get(contato.id, agora() - horas * 3600e3);
    if (!jaMandou) {
      const passo = { type: 'text', text: aplicarVars(getSetting('fallback_text'), atual) };
      try {
        await sender.send(atual, passo);
        registrar(contato.id, 'out', 'fallback', passo.text);
      } catch (e) {
        registrar(contato.id, 'out', 'fallback', passo.text, { erro: e.message });
        console.error('[BOT] falha na resposta padrão:', e.message);
      }
      return { acao: 'respondeu', fluxo: '(resposta padrão)', enviados: 1 };
    }
  }
  return { acao: 'ignorada', motivo: 'sem_fluxo' };
}

// Comentário com palavra-chave → UMA mensagem privada (regra do Instagram: 1 por comentário, até 7 dias)
async function processarComentario(ev, sender) {
  if (!marcarProcessado('c:' + ev.commentId)) return { acao: 'ignorada', motivo: 'duplicada' };
  const fluxo = acharFluxo(ev.texto, { comentario: true });
  if (!fluxo || (!fluxo.steps.length && !fluxo.comment_text)) return { acao: 'ignorada', motivo: 'sem_fluxo' };
  const contato = upsertContato({ canal: ev.canal, extId: ev.fromId, username: ev.username });
  registrar(contato.id, 'in', 'comentario', ev.texto);
  if (contato.bot_paused_until > agora()) return { acao: 'ignorada', motivo: 'pausado' };
  const texto = fluxo.comment_text ? aplicarVars(fluxo.comment_text, contato) : passoParaTexto(passoComVars(fluxo.steps[0], contato));
  try {
    await sender.sendPrivateReply(ev.commentId, texto);
    registrar(contato.id, 'out', 'comentario', texto, { flowId: fluxo.id });
    (fluxo.tags || []).forEach(t => addTag(contato.id, t));
    return { acao: 'respondeu', fluxo: fluxo.name, enviados: 1 };
  } catch (e) {
    registrar(contato.id, 'out', 'comentario', texto, { flowId: fluxo.id, erro: e.message });
    console.error('[BOT] falha na resposta ao comentário:', e.message);
    return { acao: 'erro', motivo: e.message };
  }
}

// ---------- agenda e follow-ups ----------
// Roda a cada ~15s: (1) envia o que foi agendado (ex.: mensagem após o clique no link); (2) follow-ups dentro da janela de 24h.
const JANELA = 24 * 3600e3, MARGEM = 30 * 60e3;   // não tenta enviar nos últimos 30 min da janela
const SEM_FOLLOWUP = ['VENDA', 'INTENÇÃO DE COMPRA'];
let rodando = false;
async function tick(sender, { canal = 'instagram', agoraMs } = {}) {
  if (rodando) return { agenda: 0, followups: 0, ocupado: true };
  rodando = true;
  const t0 = agoraMs || agora();
  const out = { agenda: 0, followups: 0 };
  try {
    for (const a of db.prepare('SELECT * FROM agenda WHERE done = 0 AND run_at <= ? ORDER BY id LIMIT 50').all(t0)) {
      db.prepare('UPDATE agenda SET done = 1 WHERE id = ?').run(a.id);
      const c = db.prepare('SELECT * FROM contacts WHERE id = ? AND channel = ?').get(a.contact_id, canal);
      const f = fluxoPorId(a.flow_id);
      if (!c || !f || !f.active || c.bot_paused_until > t0 || t0 - c.last_inbound_at > JANELA - MARGEM) continue;
      await enviarFluxo(c, f, sender); out.agenda++;
    }
    if (getSetting('followups_enabled') === '1') {
      const fus = db.prepare("SELECT * FROM flows WHERE kind = 'followup' AND active = 1 ORDER BY delay_hours, id").all().map(lerFluxo);
      if (fus.length) {
        const cand = db.prepare(`SELECT * FROM contacts WHERE channel = ? AND needs_human = 0 AND bot_paused_until <= ? AND followup_step < ?
          AND last_inbound_at > ? AND last_click_at > 0 AND tags LIKE '%ABRIU CHECKOUT%'`).all(canal, t0, fus.length, t0 - JANELA);
        for (const c of cand) {
          const tg = tagsDe(c);
          if (!tg.includes('ABRIU CHECKOUT') || !tg.includes('REVENDEDOR') || SEM_FOLLOWUP.some(x => tg.includes(x))) continue;
          const f = fus[c.followup_step];
          const ultimaSaida = (db.prepare("SELECT MAX(created_at) AS m FROM messages WHERE contact_id = ? AND direction = 'out' AND status = 'ok'").get(c.id).m) || 0;
          const devido = Math.max(c.last_inbound_at + f.delay_hours * 3600e3, c.last_click_at + 3600e3, ultimaSaida + 1800e3);
          if (t0 < devido || t0 > c.last_inbound_at + JANELA - MARGEM) continue;
          db.prepare('UPDATE contacts SET followup_step = followup_step + 1 WHERE id = ?').run(c.id);   // antes de enviar: nunca duplica
          await enviarFluxo(db.prepare('SELECT * FROM contacts WHERE id = ?').get(c.id), f, sender); out.followups++;
        }
      }
    }
  } finally { rodando = false; }
  return out;
}

module.exports = { ETAPAS, normalizar, criarRegex, acharFluxo, fluxoPorId, lerFluxo, passoParaTexto, aplicarVars, processarMensagem, processarComentario, upsertContato, registrar, addTag, removeTag, tagsDe, registrarClique, criarLink, tick };
