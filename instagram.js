// Canal Instagram (API do Instagram com Instagram Login, da Meta).
// ATENÇÃO: os formatos abaixo seguem o que a Meta documenta para mensagens e comentários, mas a documentação
// oficial exige login e não pôde ser conferida aqui. Teste com a ferramenta de webhook do app Meta (guia SETUP-INSTAGRAM.md).
const crypto = require('crypto');

const BASE = process.env.IG_GRAPH_BASE || 'https://graph.instagram.com';
const VERSAO = process.env.META_GRAPH_VERSION || 'v21.0';

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
  const token = process.env.IG_ACCESS_TOKEN;
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
  async sendPrivateReply(commentId, texto) {
    return chamar(`${quem()}/messages`, { recipient: { comment_id: commentId }, message: { text: corta(texto, 1000) } });
  },
};

// Dados da conta dona do token: confirma que o token funciona e de qual @ ele é.
async function conta() {
  return chamar('me?fields=user_id,username,account_type', null, 'GET');
}
// Assina o app nos eventos da conta (sem isso a Meta não manda as DMs ao webhook).
async function ativarWebhook() {
  return chamar(`${quem()}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,comments`, null, 'POST');
}

// Token do Instagram vale ~60 dias; renovar estende a validade (precisa ter pelo menos 24h de vida).
async function renovarToken() {
  const token = process.env.IG_ACCESS_TOKEN;
  if (!token) throw new Error('IG_ACCESS_TOKEN ausente.');
  const r = await fetch(`${BASE}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`);
  const txt = await r.text();
  if (!r.ok) throw new Error(`Meta respondeu ${r.status}: ${txt.slice(0, 300)}`);
  return JSON.parse(txt);
}

module.exports = { conta, ativarWebhook, configurado, assinaturaValida, lerWebhook, sender, renovarToken, montarMensagem };
