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
  keywords: JSON.parse(r.keywords || '[]'), steps: JSON.parse(r.steps || '[]'),
});
const fluxoPorId = id => lerFluxo(db.prepare('SELECT * FROM flows WHERE id = ?').get(id));

// Escolhe o fluxo: maior prioridade; empate → palavra-chave mais longa (mais específica).
function acharFluxo(texto, { comentario = false } = {}) {
  const t = normalizar(texto);
  if (!t) return null;
  let melhor = null;
  for (const r of db.prepare('SELECT * FROM flows WHERE active = 1' + (comentario ? ' AND on_comment = 1' : '')).all()) {
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

// {{nome}}, {{site}}, {{telefone}}
function aplicarVars(texto, contato) {
  const nome = String(contato.name || contato.username || '').trim().split(/\s+/)[0];
  return String(texto)
    .replace(/\{\{\s*nome\s*\}\}/g, nome)
    .replace(/\{\{\s*site\s*\}\}/g, getSetting('site_url') || '')
    .replace(/\{\{\s*telefone\s*\}\}/g, getSetting('telefone') || '')
    .replace(/\s+([!,.?])/g, '$1');
}
function passoComVars(passo, contato) {
  const p = { ...passo, text: aplicarVars(passo.text, contato) };
  if (passo.buttons) p.buttons = passo.buttons.map(b => ({ ...b, title: aplicarVars(b.title, contato), url: aplicarVars(b.url, contato) }));
  if (passo.replies) p.replies = passo.replies.map(r => ({ ...r, title: aplicarVars(r.title, contato) }));
  return p;
}
// Versão em texto puro (usada em resposta a comentário e quando o botão falha)
function passoParaTexto(passo) {
  let t = passo.text || '';
  (passo.buttons || []).forEach(b => { t += `\n${b.title}: ${b.url}`; });
  return t;
}

const KIND = { text: 'texto', button: 'botao', quick: 'rapidas' };
const registrar = (contatoId, direcao, kind, texto, extra = {}) => db.prepare(
  'INSERT INTO messages (contact_id, direction, kind, text, flow_id, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
).run(contatoId, direcao, kind, texto, extra.flowId || null, extra.erro ? 'erro' : 'ok', extra.erro || null, agora());

function marcarProcessado(id) {
  return db.prepare('INSERT OR IGNORE INTO processed (id, at) VALUES (?, ?)').run(id, agora()).changes === 1;
}

function upsertContato({ canal, extId, username }) {
  db.prepare(`INSERT INTO contacts (channel, ext_id, username, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(channel, ext_id) DO UPDATE SET username = COALESCE(excluded.username, contacts.username)`)
    .run(canal, String(extId), username || null, agora());
  return db.prepare('SELECT * FROM contacts WHERE channel = ? AND ext_id = ?').get(canal, String(extId));
}

function limiteAtingido(contatoId) {
  const max = Number(getSetting('max_replies_hour')) || 8;
  const n = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE contact_id = ? AND direction = 'out' AND status = 'ok' AND created_at > ?")
    .get(contatoId, agora() - 3600e3).n;
  return n >= max;
}

async function enviarFluxo(contato, fluxo, sender) {
  const enviados = [];
  for (const passo of fluxo.steps) {
    const p = passoComVars(passo, contato);
    try {
      await sender.send(contato, p);
      registrar(contato.id, 'out', KIND[p.type] || 'texto', passoParaTexto(p), { flowId: fluxo.id });
      enviados.push(p);
    } catch (e) {
      registrar(contato.id, 'out', KIND[p.type] || 'texto', passoParaTexto(p), { flowId: fluxo.id, erro: e.message });
      console.error(`[BOT] falha ao enviar (fluxo ${fluxo.id}):`, e.message);
      break; // não manda o resto fora de ordem
    }
  }
  if (fluxo.action === 'handoff') {
    const h = Number(getSetting('handoff_hours')) || 12;
    db.prepare('UPDATE contacts SET needs_human = 1, bot_paused_until = ? WHERE id = ?').run(agora() + h * 3600e3, contato.id);
  } else if (fluxo.action === 'silenciar') {
    db.prepare('UPDATE contacts SET needs_human = 0, bot_paused_until = ? WHERE id = ?').run(agora() + 365 * 86400e3, contato.id);
  }
  return enviados;
}

async function processarMensagem(ev, sender) {
  if (ev.mid && !marcarProcessado('m:' + ev.mid)) return { acao: 'ignorada', motivo: 'duplicada' };
  const contato = upsertContato(ev);
  db.prepare('UPDATE contacts SET last_inbound_at = ? WHERE id = ?').run(agora(), contato.id);
  registrar(contato.id, 'in', 'texto', ev.texto || (ev.payload ? `[botão] ${ev.payload}` : ''));

  const atual = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contato.id);
  if (atual.bot_paused_until > agora()) return { acao: 'ignorada', motivo: 'pausado' };
  if (limiteAtingido(contato.id)) return { acao: 'ignorada', motivo: 'limite_por_hora' };

  let fluxo = null;
  const m = /^FLOW:(\d+)$/.exec(ev.payload || '');
  if (m) fluxo = fluxoPorId(Number(m[1]));
  if (!fluxo || !fluxo.active) fluxo = acharFluxo(ev.texto);

  if (fluxo) {
    const enviados = await enviarFluxo(atual, fluxo, sender);
    return { acao: 'respondeu', fluxo: fluxo.name, enviados: enviados.length };
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
  if (!fluxo || !fluxo.steps.length) return { acao: 'ignorada', motivo: 'sem_fluxo' };
  const contato = upsertContato({ canal: ev.canal, extId: ev.fromId, username: ev.username });
  registrar(contato.id, 'in', 'comentario', ev.texto);
  if (contato.bot_paused_until > agora()) return { acao: 'ignorada', motivo: 'pausado' };
  const texto = passoParaTexto(passoComVars(fluxo.steps[0], contato));
  try {
    await sender.sendPrivateReply(ev.commentId, texto);
    registrar(contato.id, 'out', 'comentario', texto, { flowId: fluxo.id });
    return { acao: 'respondeu', fluxo: fluxo.name, enviados: 1 };
  } catch (e) {
    registrar(contato.id, 'out', 'comentario', texto, { flowId: fluxo.id, erro: e.message });
    console.error('[BOT] falha na resposta ao comentário:', e.message);
    return { acao: 'erro', motivo: e.message };
  }
}

module.exports = { normalizar, criarRegex, acharFluxo, fluxoPorId, lerFluxo, passoParaTexto, aplicarVars, processarMensagem, processarComentario, upsertContato, registrar };
