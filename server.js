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

  const { mensagens, comentarios, ecos } = ig.lerWebhook(corpo);
  // Resposta da equipe pelo app do Instagram: espera uns segundos para o robô já ter anotado o que ele mesmo enviou
  for (const ev of ecos) setTimeout(() => { try { const r = engine.processarEco(ev); if (r.acao === 'pausado') eventos.registrar('equipe', 'respondeu pelo app', 'robô pausado'); } catch (e) { console.error('[IG] eco:', e.message); } }, Number(process.env.ECO_ESPERA_MS) >= 0 && process.env.ECO_ESPERA_MS !== undefined ? Number(process.env.ECO_ESPERA_MS) : 4000);
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

// ---------- Webhook do WhatsApp (Evolution API) ----------
// O token no caminho é derivado da senha do painel: só a Evolution configurada pelo painel conhece o endereço.
const wa = require('./whatsapp.js');
app.post('/webhook/whatsapp/:token', express.json({ limit: '5mb' }), (req, res) => {
  const a = Buffer.from(String(req.params.token)), b = Buffer.from(wa.tokenWebhook());
  if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) return res.sendStatus(401);
  res.sendStatus(200);
  try { wa.processarWebhook(req.body); } catch (e) { console.error('[WHATSAPP] webhook:', e.message); }
});

// ---------- Avisos do sistema NexTap (cadastro, pedido iniciado, pagamento) ----------
// Os dois serviços guardam o mesmo segredo em NEXTAP_WEBHOOK_SECRET. Sem ele, a rota fica desligada.
const nextap = require('./nextap.js');
app.post('/webhook/nextap', express.json({ limit: '100kb' }), (req, res) => {
  const seg = process.env.NEXTAP_WEBHOOK_SECRET || '';
  const a = Buffer.from(String(req.get('X-Automazap-Secret') || '')), b = Buffer.from(seg);
  if (seg.length < 16) return res.status(503).json({ error: 'NEXTAP_WEBHOOK_SECRET não configurado (mínimo 16 caracteres).' });
  if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) return res.sendStatus(401);
  try {
    const r = nextap.receberEvento(req.body);
    if (r.erro) return res.status(400).json({ error: r.erro });
    eventos.registrar('nextap', (req.body || {}).evento, r.achou ? 'contato ' + r.contato : 'lead não encontrado');
    res.json(r);
  } catch (e) { console.error('[NEXTAP] webhook:', e.message); res.status(500).json({ error: 'Falha ao registrar o evento.' }); }
});

// ---------- Painel e API ----------
app.use(express.json({ limit: '1mb' }));
const marca = require('./marca.js');
app.use('/media', (req, res, next) => {
  const d = require('path').join(require('path').dirname(require('./db.js').arquivo === ':memory:' ? require('os').tmpdir() + '/x' : require('./db.js').arquivo), 'media');
  express.static(d, { maxAge: '7d', index: false, dotfiles: 'deny', setHeaders: r => r.setHeader('X-Content-Type-Options', 'nosniff') })(req, res, next);
});
app.get('/brand', (req, res) => res.json(marca.publica()));
// Painel instalável no celular (atalho na tela inicial) com notificações push
app.get('/sw.js', (req, res) => { res.set({ 'Content-Type': 'text/javascript; charset=utf-8', 'Service-Worker-Allowed': '/', 'Cache-Control': 'no-cache' }); res.sendFile(path.join(__dirname, 'sw.js')); });
app.get('/manifest.webmanifest', (req, res) => {
  const b = marca.publica();
  res.type('application/manifest+json').json({ name: b.nome + ' · Central', short_name: b.nome, start_url: '/', scope: '/', display: 'standalone',
    background_color: '#0a0c10', theme_color: b.cor, icons: [{ src: b.logo, sizes: 'any', type: 'image/svg+xml', purpose: 'any' }, { src: b.logo, sizes: '512x512', purpose: 'any' }] });
});
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
  setInterval(() => { if (ig.configurado().token) { engine.tick(ig.sender).catch(e => console.error('[AGENDA]', e.message)); engine.completarNomes(ig.sender).catch(() => {}); } }, 15000).unref();
  // Tabela de preços do site (o robô mostra sempre o valor que o checkout cobra)
  const precos = () => { nextap.atualizarPrecos().catch(e => console.warn('[NEXTAP] preços:', e.message)); nextap.atualizarPromo().catch(e => console.warn('[NEXTAP] promoção:', e.message)); };
  setTimeout(precos, 5000).unref(); setInterval(precos, 10 * 60e3).unref();
  // Vigia do Instagram: se o token cair, avisa no Telegram e mostra no painel (em vez de ficar dias parado em silêncio)
  const vigiar = async () => {
    if (!ig.configurado().token) return;
    try { await ig.conta(); if (getSetting('ig_conexao_erro')) { setSetting('ig_conexao_erro', ''); engine.avisar('✅ Instagram voltou a responder: o robô está no ar de novo.'); } }
    catch (e) {
      const novo = !getSetting('ig_conexao_erro');
      setSetting('ig_conexao_erro', String(e.message).slice(0, 300));
      if (novo || Date.now() - Number(getSetting('ig_alerta_em') || 0) > 12 * 3600e3) {
        setSetting('ig_alerta_em', Date.now());
        engine.avisar('🚨 O robô do Instagram PAROU de responder: ' + String(e.message).slice(0, 200) + '\nGere um token novo no app da Meta e troque IG_ACCESS_TOKEN no Railway.');
      }
    }
  };
  setTimeout(vigiar, 20000).unref(); setInterval(vigiar, 15 * 60e3).unref();
  // Prédio: lista da Prospectora, conteúdo da semana e resumo da Gerente (todo dia, na hora configurada)
  setTimeout(() => { try { require('./predio.js').tick(); } catch (e) { console.error('[PRÉDIO]', e.message); } }, 15e3).unref();   // agentes começam logo que o servidor sobe
  setInterval(() => { try { require('./predio.js').tick(); } catch (e) { console.error('[PRÉDIO]', e.message); } }, 60e3).unref();
  // Disparos programados do WhatsApp
  setInterval(() => { wa.tick().catch(e => console.error('[WHATSAPP]', e.message)); }, 20000).unref();
  setTimeout(() => ig.renovarSeNecessario().catch(() => {}), 30000).unref();
  setInterval(() => ig.renovarSeNecessario().catch(() => {}), 6 * 3600e3).unref();
  setInterval(() => { try { backupAgora(); limparAntigos(); } catch (e) { console.error('[BACKUP]', e.message); } }, 24 * 3600e3).unref();
  app.listen(PORT, () => console.log(`[BOT] no ar na porta ${PORT} · persistência: ${persistente ? 'SIM' : 'NÃO'}`));
}
module.exports = app;
