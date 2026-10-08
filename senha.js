// Redefinição de senha do revendedor: link com validade, guardado só como hash no banco.
const crypto = require('crypto');
const db = require('./database.js');

const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');

function baseUrl(req) {
  const b = (process.env.PUBLIC_BACKEND_URL || '').trim().replace(/\/+$/, '');
  return /^https:\/\//i.test(b) ? b : `${req.protocol}://${req.get('host')}`;
}

// Gera um link novo (invalida os anteriores do mesmo revendedor).
function criarLink(req, resellerId, horas = 1) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`UPDATE password_resets SET used_at = datetime('now') WHERE reseller_id = ? AND used_at IS NULL`).run(resellerId);
  db.prepare(`INSERT INTO password_resets (reseller_id, token_hash, expires_at) VALUES (?, ?, datetime('now', ?))`)
    .run(resellerId, sha(token), `+${Math.max(1, Math.floor(horas))} hours`);
  return `${baseUrl(req)}/revendedor/?reset=${token}`;
}

function validar(token) {
  return db.prepare(`SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`)
    .get(sha(token || '')) || null;
}

function consumir(resellerId) {
  db.prepare(`UPDATE password_resets SET used_at = datetime('now') WHERE reseller_id = ? AND used_at IS NULL`).run(resellerId);
}

// Envio por e-mail via Resend (https://resend.com). Só funciona se RESEND_API_KEY e MAIL_FROM estiverem configurados.
async function enviarEmail(para, nome, link) {
  if (!process.env.RESEND_API_KEY || !process.env.MAIL_FROM) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.MAIL_FROM,
      to: [para],
      subject: 'NexTap — redefinir sua senha',
      html: `<p>Olá, ${String(nome || '').replace(/[<>&]/g, '')}!</p><p>Recebemos um pedido para criar uma nova senha no painel NexTap.</p>
             <p><a href="${link}" style="background:#15803d;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700">Criar nova senha</a></p>
             <p>O link vale por 1 hora. Se não foi você, é só ignorar este e-mail.</p>`,
    }),
  });
  if (!r.ok) console.error('[SENHA] Falha ao enviar e-mail:', r.status, (await r.text()).slice(0, 200));
  return r.ok;
}

// Limite simples: por padrão 5 tentativas a cada 15 minutos para a mesma chave.
const tentativas = new Map();
function limitado(chave, max = 5) {
  const agora = Date.now();
  const lista = (tentativas.get(chave) || []).filter(t => agora - t < 15 * 60 * 1000);
  lista.push(agora);
  tentativas.set(chave, lista);
  return lista.length > max;
}

module.exports = { criarLink, validar, consumir, enviarEmail, limitado };
