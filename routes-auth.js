const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const senha = require('./senha.js');
const db = require('./database.js');

const router = express.Router();

function sign(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// Cadastro gratuito de revendedor
router.post('/register', async (req, res) => {
  const { name, email, whatsapp, password } = req.body || {};
  if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string'
      || !name.trim() || !email.includes('@') || password.length < 6) {
    return res.status(400).json({ error: 'Informe nome, e-mail e senha (mínimo 6 caracteres).' });
  }
  const existing = db.prepare('SELECT id FROM resellers WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });

  const hash = await bcrypt.hash(password, 10);
  const info = db.prepare(
    'INSERT INTO resellers (name, email, whatsapp, password_hash) VALUES (?, ?, ?, ?)'
  ).run(name, email.toLowerCase(), whatsapp || '', hash);

  const token = sign({ id: info.lastInsertRowid, type: 'reseller' });
  res.json({ token, reseller: { id: info.lastInsertRowid, name, email: email.toLowerCase(), whatsapp } });
});

// Login de revendedor
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (senha.limitado('login:' + req.ip + ':' + String(email || '').toLowerCase(), 10)) {
    return res.status(429).json({ error: 'Muitas tentativas de login. Aguarde alguns minutos e tente de novo.' });
  }
  const r = db.prepare('SELECT * FROM resellers WHERE email = ?').get(String(email || '').toLowerCase().trim());
  if (!r) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  const ok = await bcrypt.compare(password || '', r.password_hash);
  if (!ok) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });

  const token = sign({ id: r.id, type: 'reseller' });
  res.json({ token, reseller: { id: r.id, name: r.name, email: r.email, whatsapp: r.whatsapp } });
});

// Esqueci a senha: sempre responde "ok" (não revela se o e-mail existe).
router.post('/forgot', async (req, res) => {
  const email = String((req.body || {}).email || '').toLowerCase().trim();
  if (!email.includes('@')) return res.status(400).json({ error: 'Informe o e-mail da sua conta.' });
  if (senha.limitado(req.ip)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' });
  const r = db.prepare('SELECT id, name, email FROM resellers WHERE email = ?').get(email);
  if (r) {
    const link = senha.criarLink(req, r.id, 1);
    const enviado = await senha.enviarEmail(r.email, r.name, link).catch(() => false);
    if (!enviado) console.log(`[SENHA] E-mail não configurado. Link de redefinição (1h) para ${r.email}: ${link}`);
  }
  res.json({ ok: true });
});

// Define a nova senha a partir do link e já entra no painel.
router.post('/reset', async (req, res) => {
  const { token, password } = req.body || {};
  if (typeof password !== 'string' || password.length < 6) return res.status(400).json({ error: 'A senha deve ter no mínimo 6 caracteres.' });
  const row = senha.validar(token);
  if (!row) return res.status(400).json({ error: 'Link inválido ou expirado. Peça um novo link.' });
  const hash = await bcrypt.hash(password, 10);
  db.prepare('UPDATE resellers SET password_hash = ? WHERE id = ?').run(hash, row.reseller_id);
  senha.consumir(row.reseller_id);
  const r = db.prepare('SELECT id, name, email, whatsapp FROM resellers WHERE id = ?').get(row.reseller_id);
  res.json({ token: sign({ id: r.id, type: 'reseller' }), reseller: r });
});

// Login do admin (fornecedor) — credenciais fixas definidas no .env
router.post('/admin-login', (req, res) => {
  const { email, password } = req.body || {};
  const safeEq = (a, b) => {
    const A = Buffer.from(String(a ?? '')), B = Buffer.from(String(b ?? ''));
    return A.length === B.length && crypto.timingSafeEqual(A, B);
  };
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD
      || !safeEq(email, process.env.ADMIN_EMAIL) || !safeEq(password, process.env.ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }
  const token = sign({ type: 'admin' });
  res.json({ token });
});

module.exports = router;
