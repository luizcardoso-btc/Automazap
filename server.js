require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./database.js'); // abre o banco (e aplica migrações) já no boot

// Sem JWT_SECRET o login quebra em runtime (jwt.sign lança erro). Melhor falhar já no boot,
// com uma mensagem clara nos logs do Railway.
if (!process.env.JWT_SECRET) {
  console.error('ERRO: a variável de ambiente JWT_SECRET não está definida. Configure em Variables no Railway.');
  process.exit(1);
}
if (!process.env.MP_ACCESS_TOKEN) console.warn('AVISO: MP_ACCESS_TOKEN não definido — pagamentos ficarão indisponíveis.');
if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) console.warn('AVISO: ADMIN_EMAIL/ADMIN_PASSWORD não definidos — login de admin desativado.');

const app = express();
app.set('trust proxy', 1); // Railway fica atrás de um proxy
// Domínio principal (ex.: SITE_HOST=www.seudominio.com.br): quem entrar por outro endereço (sem www, ou o endereço
// .up.railway.app) é levado ao principal. Só páginas (GET): o webhook do Mercado Pago e o /health nunca são redirecionados.
app.use((req, res, next) => {
  if (SITE_HOST && ['GET', 'HEAD'].includes(req.method) && req.hostname !== SITE_HOST
      && req.path !== '/health' && !req.path.startsWith('/api/payments/webhook')) {
    return res.redirect(301, 'https://' + SITE_HOST + req.originalUrl);
  }
  next();
});

// Cabeçalhos de segurança
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.secure && SITE_HOST && req.hostname === SITE_HOST) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000'); // 180 dias: o navegador só abre o site em HTTPS
  }
  if (/^\/(admin|revendedor|api)/.test(req.path)) res.setHeader('Cache-Control', 'no-store'); // nada de dados em cache
  next();
});

// Google: pode indexar o site de vendas; painéis e API ficam de fora.
app.get('/robots.txt', (req, res) => res.type('text/plain').send(
  'User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /revendedor\nDisallow: /api\n' +
  (SITE_HOST ? `Sitemap: https://${SITE_HOST}/sitemap.xml\n` : '')));
app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://${SITE_HOST || req.hostname}/</loc></url></urlset>`));

// CORS: se FRONTEND_URL estiver definido, aceita só ele (mais seguro); vírgula separa vários domínios.
const SITE_HOST = (process.env.SITE_HOST || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const origins = (process.env.FRONTEND_URL || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
if (SITE_HOST) origins.push('https://' + SITE_HOST, 'https://' + SITE_HOST.replace(/^www\./, ''), 'https://www.' + SITE_HOST.replace(/^www\./, ''));
app.use(cors(origins.length ? { origin: origins } : {}));
app.use(express.json({ limit: '1mb' }));

// Health check (Railway usa para saber se o deploy subiu)
app.get('/health', (req, res) => res.json({ ok: true, dados_persistentes: db.meta.persistente }));

app.use('/api/auth', require('./routes-auth.js'));
app.use('/api/resellers', require('./routes-resellers.js'));
app.use('/api/payments', require('./routes-payments.js'));
app.use('/api/admin', require('./routes-admin.js'));
app.use('/', require('./routes-public.js')); // /r/:code — link do QR Code / NFC da placa e /api/public/stats

// Site (/), painel do revendedor (/revendedor) e painel admin (/admin) — servidos pelo próprio backend,
// no mesmo domínio da API, então não há problema de CORS.
['logo.png', 'placa.jpg', 'placas-nextap.jpg', 'favicon.png'].forEach(f =>
  app.get('/' + f, (req, res) => res.sendFile(path.join(__dirname, f), { maxAge: '1d' })));
const page = f => (req, res) => res.sendFile(path.join(__dirname, f));
app.get('/', page('site.html'));
app.get(['/revendedor', '/revendedor/'], page('revendedor.html'));
app.get(['/admin', '/admin/'], page('admin.html'));

// 404 e erro genérico em JSON (evita devolver stack trace e HTML para o frontend)
app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
  console.error('Erro não tratado:', err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`NexTap backend rodando na porta ${PORT}`);
  require('./routes-payments.js').diagnose().catch(() => {});
  require('./pedidos.js').agendar(); // confere os pagamentos pendentes direto no Mercado Pago a cada poucos minutos
});

// No redeploy o Railway manda SIGTERM: fecha o banco direito para não deixar nada pela metade.
function encerrar() {
  console.log('Encerrando: fechando o banco com segurança…');
  server.close(() => { try { db.close(); } catch (e) {} process.exit(0); });
  setTimeout(() => { try { db.close(); } catch (e) {} process.exit(0); }, 8000).unref();
}
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);
