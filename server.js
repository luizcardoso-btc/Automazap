const express = require('express');
const path = require('path');
const { persistente, backupAgora, limparAntigos } = require('./db.js');
const engine = require('./engine.js');
const ig = require('./instagram.js');
const eventos = require('./eventos.js');
const { semear } = require('./seed.js');

const senhaAdmin = process.env.ADMIN_PASSWORD || '';
if (senhaAdmin.length < 8) {
  console.error('[ERRO] Defina ADMIN_PASSWORD (mínimo 8 caracteres, de preferência longa) nas variáveis de ambiente.');
  process.exit(1);
}
if (semear()) console.log('[BOT] Fluxos iniciais da NexTap criados. Edite pelo painel.');
if (!persistente) console.warn('[ATENÇÃO] Sem Volume no Railway: os dados serão APAGADOS a cada deploy. Crie um Volume e conecte a este serviço.');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

// ---------- Webhook do Instagram ----------
app.get('/webhook/instagram', (req, res) => {
  const ok = req.query['hub.mode'] === 'subscribe' && process.env.META_VERIFY_TOKEN
    && req.query['hub.verify_token'] === process.env.META_VERIFY_TOKEN;
  eventos.registrar('verificação', ok ? 'ok' : 'recusada', ok ? 'Meta validou o webhook' : 'Token de verificação não confere com META_VERIFY_TOKEN');
  if (ok) return res.status(200).send(String(req.query['hub.challenge'] || ''));
  res.sendStatus(403);
});

app.post('/webhook/instagram', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const segredo = process.env.META_APP_SECRET;
  const semAssinatura = process.env.ALLOW_UNSIGNED === '1' && process.env.NODE_ENV !== 'production';
  if (!semAssinatura) {
    if (!segredo) { eventos.registrar('evento', 'recusado', 'META_APP_SECRET ausente'); console.error('[IG] META_APP_SECRET ausente: não aceito eventos sem conferir a assinatura.'); return res.sendStatus(500); }
    if (!ig.assinaturaValida(req.body, req.get('X-Hub-Signature-256'), segredo)) { eventos.registrar('evento', 'recusado', 'Assinatura inválida: confira se META_APP_SECRET é o segredo do app do Instagram'); return res.sendStatus(401); }
  }
  let corpo;
  try { corpo = JSON.parse(req.body.toString('utf8')); } catch (e) { return res.sendStatus(400); }
  res.status(200).send('EVENT_RECEIVED'); // a Meta exige resposta rápida; o processamento segue em seguida

  const { mensagens, comentarios } = ig.lerWebhook(corpo);
  eventos.registrar('evento', 'recebido', `${mensagens.length} mensagem(ns), ${comentarios.length} comentário(s)`);
  (async () => {
    for (const ev of mensagens) {
      try { const r = await engine.processarMensagem(ev, ig.sender); console.log('[IG] msg', ev.extId, JSON.stringify(r)); eventos.registrar('mensagem', r.acao, r.fluxo || r.motivo || ''); }
      catch (e) { console.error('[IG] erro ao tratar mensagem:', e.message); eventos.registrar('mensagem', 'erro', e.message); }
    }
    for (const ev of comentarios) {
      try { const r = await engine.processarComentario(ev, ig.sender); console.log('[IG] comentário', ev.commentId, JSON.stringify(r)); eventos.registrar('comentário', r.acao, r.fluxo || r.motivo || ''); }
      catch (e) { console.error('[IG] erro ao tratar comentário:', e.message); eventos.registrar('comentário', 'erro', e.message); }
    }
  })();
});

// ---------- Painel e API ----------
app.use(express.json({ limit: '1mb' }));
const marca = require('./marca.js');
app.use('/media', (req, res, next) => {
  const d = require('path').join(require('path').dirname(require('./db.js').arquivo === ':memory:' ? require('os').tmpdir() + '/x' : require('./db.js').arquivo), 'media');
  express.static(d, { maxAge: '7d', index: false, dotfiles: 'deny', setHeaders: r => r.setHeader('X-Content-Type-Options', 'nosniff') })(req, res, next);
});
app.get('/brand', (req, res) => res.json(marca.publica()));
app.get(['/logo', '/favicon.ico'], marca.servirLogo);
app.use('/api', require('./routes-api.js'));
// Link rastreado: registra o clique (etiqueta ABRIU CHECKOUT + mensagem de acompanhamento) e leva ao site
app.get('/go/:token', (req, res) => {
  let destino = null;
  try { destino = engine.registrarClique(req.params.token); } catch (e) { console.error('[GO]', e.message); }
  res.set('Cache-Control', 'no-store').redirect(302, destino || require('./db.js').getSetting('site_url') || '/');
});
app.get('/health', (req, res) => res.json({ ok: true, dados_persistentes: persistente }));
app.get(['/', '/painel'], (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));
app.use((req, res) => res.status(404).json({ error: 'Não encontrado.' }));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  try { backupAgora(); } catch (e) { console.error('[BACKUP]', e.message); }
  // Endereço público (para links rastreados): descoberto sozinho a partir do domínio do Railway, se ainda não configurado
  const { getSetting, setSetting } = require('./db.js');
  if (!getSetting('public_url') && process.env.RAILWAY_PUBLIC_DOMAIN) setSetting('public_url', 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN);
  // Agenda (mensagem após o clique) e follow-ups dentro da janela de 24h
  setInterval(() => { if (ig.configurado().token) engine.tick(ig.sender).catch(e => console.error('[AGENDA]', e.message)); }, 15000).unref();
  setInterval(() => { try { backupAgora(); limparAntigos(); } catch (e) { console.error('[BACKUP]', e.message); } }, 24 * 3600e3).unref();
  app.listen(PORT, () => console.log(`[BOT] no ar na porta ${PORT} · persistência: ${persistente ? 'SIM' : 'NÃO'}`));
}
module.exports = app;
