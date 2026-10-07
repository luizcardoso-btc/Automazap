// Canal Instagram (API do Instagram com Instagram Login, da Meta).
// ATENÇÃO: os formatos abaixo seguem o que a Meta documenta para mensagens e comentários, mas a documentação
// oficial exige login e não pôde ser conferida aqui. Teste com a ferramenta de webhook do app Meta (guia SETUP-INSTAGRAM.md).
const crypto = require('crypto');

const BASE = process.env.IG_GRAPH_BASE || 'https://graph.instagram.com';
const VERSAO = process.env.META_GRAPH_VERSION || 'v21.0';

// Token em uso: o renovado automaticamente (guardado no banco, que fica no Volume) ou, se não houver, o do Railway.
// Se você colar um token novo no Railway, ele passa a valer no lugar do guardado.
function lerAtivo() {
  const env = process.env.IG_ACCESS_TOKEN;
  if (!env) return null;
  try {
    const db = require('./db.js');
    const a = JSON.parse(db.getSetting('ig_token_ativo') || 'null');
    if (a && a.token && a.origem === env.slice(-12)) return a;
  } catch (e) { /* sem token guardado */ }
  return { token: env, origem: env.slice(-12), em: 0 };
}
const tokenAtual = () => { const a = lerAtivo(); return a ? a.token : null; };

function configurado() {
  return { token: !!process.env.IG_ACCESS_TOKEN, appSecret: !!process.env.META_APP_SECRET, verifyToken: !!process.env.META_VERIFY_TOKEN };
}

// Confere a assinatura X-Hub-Signature-256 (HMAC-SHA256 do corpo bruto com o App Secret)
function assinaturaValida(corpoBruto, cabecalho, segredo) {
  if (!segredo || !cabecalho || !Buffer.isBuffer(corpoBruto)) return false;
  const esperado = 'sha256=' + crypto.createHmac('sha256', segredo).update(corpoBruto).digest('hex');
  const a = Buffer.from(esperado), b = Buffer.from(String(cabecalho));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Transforma o corpo do webhook em eventos simples para o motor. Ignora ecos (mensagens enviadas por nós).
function lerWebhook(corpo) {
  const out = { mensagens: [], comentarios: [] };
  if (!corpo || corpo.object !== 'instagram') return out;
  for (const entry of corpo.entry || []) {
    const meuId = String(entry.id || '');
    for (const m of entry.messaging || []) {
      const de = String((m.sender && m.sender.id) || '');
      if (!de || de === meuId) continue;
      if (m.message && m.message.is_echo) continue;
      if (m.message) {
        const texto = m.message.text || '';
        const payload = (m.message.quick_reply && m.message.quick_reply.payload) || null;
        if (!texto && !payload) continue; // figurinha, áudio, etc.
        out.mensagens.push({ canal: 'instagram', extId: de, texto, payload, mid: m.message.mid || null });
      } else if (m.postback) {
        out.mensagens.push({
          canal: 'instagram', extId: de, texto: m.postback.title || '', payload: m.postback.payload || null,
          mid: m.postback.mid || `pb:${de}:${m.timestamp}:${m.postback.payload}`,
        });
      }
    }
    for (const ch of entry.changes || []) {
      if (ch.field !== 'comments' || !ch.value) continue;
      const v = ch.value, de = String((v.from && v.from.id) || '');
      if (!v.id || !de || de === meuId) continue;
      out.comentarios.push({ canal: 'instagram', commentId: String(v.id), texto: v.text || '', fromId: de, username: v.from && v.from.username, mediaId: v.media && v.media.id });
    }
  }
  return out;
}

async function chamar(caminho, corpo, metodo = 'POST') {
  const token = tokenAtual();
  if (!token) throw new Error('IG_ACCESS_TOKEN ausente: gere o token no app da Meta e coloque nas variáveis do Railway.');
  const r = await fetch(`${BASE}/${VERSAO}/${caminho}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const txt = await r.text();
  if (!r.ok) { const e = new Error(`Instagram respondeu ${r.status}: ${txt.slice(0, 300)}`); e.status = r.status; throw e; }
  try { return JSON.parse(txt || '{}'); } catch (e) { return {}; }
}

const corta = (s, n) => String(s).slice(0, n);
// Caminho de envio: "me" funciona para o dono do token; se a Meta recusar, defina IG_USER_ID com o ID numérico da conta.
const quem = () => process.env.IG_USER_ID || 'me';

function montarMensagem(passo) {
  if (passo.type === 'video' || passo.type === 'image') {
    // A Meta baixa o arquivo pelo link: ele precisa ser público, em https (vídeo em .mp4).
    return { attachment: { type: passo.type, payload: { url: passo.url } } };
  }
  if (passo.type === 'button') {
    return { attachment: { type: 'template', payload: {
      template_type: 'button', text: corta(passo.text, 640),
      buttons: passo.buttons.slice(0, 3).map(b => ({ type: 'web_url', url: b.url, title: corta(b.title, 20) })),
    } } };
  }
  if (passo.type === 'quick') {
    return { text: corta(passo.text, 1000), quick_replies: passo.replies.slice(0, 13).map(r => ({
      content_type: 'text', title: corta(r.title, 20), payload: `FLOW:${r.flow_id}`,
    })) };
  }
  return { text: corta(passo.text, 1000) };
}
const emTexto = passo => corta((passo.text || '') + (passo.buttons || []).map(b => `\n${b.title}: ${b.url}`).join(''), 1000);

const sender = {
  async send(contato, passo) {
    const destino = { id: contato.ext_id };
    try {
      return await chamar(`${quem()}/messages`, { recipient: destino, message: montarMensagem(passo) });
    } catch (e) {
      // Botão/respostas rápidas podem ser recusados em algumas contas: manda o texto com o link para a pessoa não ficar sem resposta.
      if (passo.type !== 'text' && passo.type !== 'video' && passo.type !== 'image' && e.status === 400) {
        console.warn('[IG] formato rico recusado, reenviando como texto:', e.message);
        return chamar(`${quem()}/messages`, { recipient: destino, message: { text: emTexto(passo) } });
      }
      throw e;
    }
  },
  perfil,
  async sendPrivateReply(commentId, texto) {
    return chamar(`${quem()}/messages`, { recipient: { comment_id: commentId }, message: { text: corta(texto, 1000) } });
  },
};

// Nome e @ de quem escreveu (a Meta só libera depois que a pessoa mandou mensagem)
async function perfil(igsid) {
  const r = await chamar(`${encodeURIComponent(igsid)}?fields=name,username`, null, 'GET');
  return { name: r.name || null, username: r.username || null };
}

// Dados da conta dona do token: confirma que o token funciona e de qual @ ele é.
async function conta() {
  return chamar('me?fields=user_id,username,account_type', null, 'GET');
}
// Assina o app nos eventos da conta (sem isso a Meta não manda as DMs ao webhook).
async function ativarWebhook() {
  return chamar(`${quem()}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,comments`, null, 'POST');
}

// Token do Instagram vale ~60 dias; renovar estende a validade (precisa ter pelo menos 24h de vida).
// Renova sozinho: guarda o token novo no banco, sem você precisar mexer no Railway.
async function renovarToken() {
  const ativo = lerAtivo();
  if (!ativo) throw new Error('IG_ACCESS_TOKEN ausente.');
  const r = await fetch(`${BASE}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(ativo.token)}`);
  const txt = await r.text();
  if (!r.ok) throw new Error(`Meta respondeu ${r.status}: ${txt.slice(0, 300)}`);
  const j = JSON.parse(txt);
  if (j.access_token) {
    const db = require('./db.js');
    db.setSetting('ig_token_ativo', JSON.stringify({ token: j.access_token, origem: ativo.origem, em: Date.now(), expira: Date.now() + (j.expires_in || 0) * 1000 }));
  }
  return { ok: true, expires_in: j.expires_in, renovado_em: Date.now() };
}
// Chamado todo dia: renova quando o último ciclo tem 20+ dias (a Meta só renova token com mais de 24h de vida)
async function renovarSeNecessario() {
  const ativo = lerAtivo();
  if (!ativo) return null;
  const db = require('./db.js');
  const ult = Number(db.getSetting('ig_token_tentativa') || 0);
  if (Date.now() - ult < 12 * 3600e3) return null;
  if (ativo.em && Date.now() - ativo.em < 20 * 86400e3) return null;
  db.setSetting('ig_token_tentativa', Date.now());
  try { const r = await renovarToken(); console.log('[IG] token renovado automaticamente'); db.setSetting('ig_token_erro', ''); return r; }
  catch (e) { console.error('[IG] falha ao renovar token:', e.message); require('./db.js').setSetting('ig_token_erro', e.message.slice(0, 200)); return null; }
}

module.exports = { conta, ativarWebhook, configurado, assinaturaValida, lerWebhook, sender, renovarToken, renovarSeNecessario, montarMensagem };
