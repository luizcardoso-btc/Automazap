const express = require('express');
const { nanoid } = require('nanoid');
const db = require('./database.js');
const pedidos = require('./pedidos.js');
const { requireReseller } = require('./auth-middleware.js');

const router = express.Router();
router.use(requireReseller);

// Dados do próprio revendedor logado
router.get('/me', (req, res) => {
  const r = db.prepare('SELECT id, name, email, whatsapp, created_at, addr_cep, addr_street, addr_number, addr_complement, addr_district, addr_city, addr_state, addr_country FROM resellers WHERE id = ?').get(req.resellerId);
  res.json(r);
});

router.put('/me', (req, res) => {
  const b = req.body || {};
  const txt = (v, max = 120) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  if (b.name !== undefined && !txt(b.name)) return res.status(400).json({ error: 'Nome inválido.' });
  const cep = b.addr_cep === undefined ? undefined : String(b.addr_cep).replace(/\D/g, '');
  if (cep !== undefined && cep !== '' && cep.length !== 8) return res.status(400).json({ error: 'CEP inválido. Informe os 8 números.' });
  const uf = b.addr_state === undefined ? undefined : txt(b.addr_state, 20).toUpperCase(); // confere ANTES de cortar ("Bahia" não vira "BA")
  if (uf !== undefined && uf !== '' && !/^[A-Z]{2}$/.test(uf)) return res.status(400).json({ error: 'Estado (UF) inválido, por exemplo BA.' });
  const campo = (v, max) => (v === undefined ? null : txt(v, max));
  db.prepare(`UPDATE resellers SET name = COALESCE(?, name), whatsapp = COALESCE(?, whatsapp),
      addr_cep = COALESCE(?, addr_cep), addr_street = COALESCE(?, addr_street), addr_number = COALESCE(?, addr_number),
      addr_complement = COALESCE(?, addr_complement), addr_district = COALESCE(?, addr_district),
      addr_city = COALESCE(?, addr_city), addr_state = COALESCE(?, addr_state), addr_country = COALESCE(?, addr_country)
    WHERE id = ?`)
    .run(campo(b.name, 120), campo(b.whatsapp, 30), cep ?? null, campo(b.addr_street), campo(b.addr_number, 20),
         campo(b.addr_complement, 60), campo(b.addr_district), campo(b.addr_city), uf ?? null, campo(b.addr_country, 60), req.resellerId);
  res.json({ ok: true });
});

// Valores que o painel mostra antes do pedido: frete fixo e pedido mínimo.
router.get('/config', (req, res) => {
  const minimo = db.prepare('SELECT MIN(min_qty) AS m FROM price_tiers').get().m || 1;
  res.json({ frete: db.freteFixo(), minimo });
});

// Faixas de preço (públicas para o revendedor logado)
router.get('/price-tiers', (req, res) => {
  const tiers = db.prepare('SELECT min_qty, max_qty, unit_price FROM price_tiers ORDER BY min_qty').all();
  res.json(tiers);
});

// Placas do revendedor
const TIPOS_DESTINO = ['Google Avaliações', 'Instagram', 'Facebook', 'Site', 'Cardápio', 'Link personalizado',
  'WhatsApp', 'Outro']; // os dois últimos só existem por compatibilidade com placas antigas

// Aceita "instagram.com/loja" (sem https) e confere se é um endereço web válido.
function normalizarLink(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const url = new URL(u);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) return null;
    return url.href;
  } catch (e) { return null; }
}

// "#7", "7" ou "00007" viram "#00007".
function normalizarCodigo(c) {
  const d = String(c || '').replace(/\D/g, '');
  if (!d || d.length > 8) return null;
  return '#' + d.padStart(5, '0');
}

router.get('/plates', (req, res) => {
  const plates = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM plate_reads r WHERE r.plate_id = p.id) AS reads_total,
      (SELECT strftime('%Y-%m-%dT%H:%M:%SZ', MAX(r.read_at)) FROM plate_reads r WHERE r.plate_id = p.id) AS last_read_at
    FROM plates p WHERE p.reseller_id = ? ORDER BY p.id DESC`).all(req.resellerId);
  res.json(plates);
});

router.put('/plates/:id', (req, res) => {
  const plate = db.prepare('SELECT * FROM plates WHERE id = ? AND reseller_id = ?').get(req.params.id, req.resellerId);
  if (!plate) return res.status(404).json({ error: 'Placa não encontrada.' });
  const b = req.body || {};
  const txt = (v, max = 120) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

  let tracking = plate.tracking_code;
  if (b.tracking_code !== undefined) {
    tracking = normalizarCodigo(b.tracking_code);
    if (!tracking) return res.status(400).json({ error: 'Informe o código da placa, por exemplo #00001.' });
    const outro = db.prepare('SELECT id FROM plates WHERE tracking_code = ? AND id <> ?').get(tracking, plate.id);
    if (outro) return res.status(409).json({ error: `O código ${tracking} já está em uso por outra placa.` });
  }
  const tipo = txt(b.destination_type, 40);
  if (tipo && !TIPOS_DESTINO.includes(tipo)) return res.status(400).json({ error: 'Tipo de destino inválido.' });
  const url = normalizarLink(b.destination_url);
  if (url === null) return res.status(400).json({ error: 'Link inválido. Exemplo: https://g.page/r/sua-loja/review' });

  // Configurada = tem um destino para onde a placa leva o cliente.
  const status = url ? 'ativa' : 'estoque';
  db.prepare(`UPDATE plates SET tracking_code=?, client_name=?, plate_label=?, destination_type=?, destination_url=?, status=? WHERE id=?`)
    .run(tracking, txt(b.client_name), txt(b.plate_label), tipo, url, status, plate.id);
  res.json({ ok: true, tracking_code: tracking, destination_url: url, status });
});

// Leituras (quando alguém aproxima o celular/escaneia o QR) — o endpoint público /r/:code está em routes-public.js
router.get('/plates/:id/reads', (req, res) => {
  const plate = db.prepare('SELECT id FROM plates WHERE id = ? AND reseller_id = ?').get(req.params.id, req.resellerId);
  if (!plate) return res.status(404).json({ error: 'Placa não encontrada.' });
  const reads = db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%SZ', read_at) AS read_at FROM plate_reads WHERE plate_id = ? ORDER BY read_at DESC LIMIT 500`).all(plate.id);
  res.json(reads);
});

// Resumo de leituras: total, hoje (a partir de ?since=, meia-noite do aparelho), 7 e 30 dias, última leitura.
router.get('/plates/:id/stats', (req, res) => {
  const plate = db.prepare('SELECT id FROM plates WHERE id = ? AND reseller_id = ?').get(req.params.id, req.resellerId);
  if (!plate) return res.status(404).json({ error: 'Placa não encontrada.' });
  const desde = new Date(String(req.query.since || ''));
  const hoje = Number.isNaN(desde.getTime()) ? new Date(Date.now() - 864e5) : desde;
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN read_at >= ? THEN 1 ELSE 0 END) AS hoje,
      SUM(CASE WHEN read_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS d7,
      SUM(CASE WHEN read_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS d30,
      strftime('%Y-%m-%dT%H:%M:%SZ', MAX(read_at)) AS ultima
    FROM plate_reads WHERE plate_id = ?`).get(hoje.toISOString().slice(0, 19).replace('T', ' '), plate.id);
  res.json({ total: row.total, hoje: row.hoje || 0, d7: row.d7 || 0, d30: row.d30 || 0, ultima: row.ultima });
});

// Vendas do revendedor
router.get('/sales', (req, res) => {
  const sales = db.prepare('SELECT * FROM sales WHERE reseller_id = ? ORDER BY id DESC').all(req.resellerId);
  res.json(sales);
});

router.post('/sales', (req, res) => {
  const { client_name, value, plate_id, destination_url } = req.body || {};
  if (!client_name || typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return res.status(400).json({ error: 'Informe cliente e valor válidos.' });
  }
  let cost = 0;
  if (plate_id) {
    const plate = db.prepare('SELECT * FROM plates WHERE id = ? AND reseller_id = ?').get(plate_id, req.resellerId);
    if (!plate) return res.status(404).json({ error: 'Placa não encontrada.' });
    cost = plate.cost || 0;
    const novoLink = normalizarLink(destination_url);
    if (novoLink === null) return res.status(400).json({ error: 'Link de avaliação inválido.' });
    // Só fica "configurada" se a placa tiver um destino (o novo ou o que já existia).
    db.prepare(`UPDATE plates SET client_name=?, destination_url=COALESCE(NULLIF(?, ''), destination_url),
                status = CASE WHEN COALESCE(NULLIF(?, ''), destination_url, '') <> '' THEN 'ativa' ELSE status END WHERE id=?`)
      .run(client_name, novoLink, novoLink, plate_id);
  }
  const info = db.prepare('INSERT INTO sales (reseller_id, plate_id, client_name, value, cost) VALUES (?, ?, ?, ?, ?)')
    .run(req.resellerId, plate_id || null, client_name, value, cost);
  res.json({ id: info.lastInsertRowid });
});

router.delete('/sales/:id', (req, res) => {
  db.prepare('DELETE FROM sales WHERE id = ? AND reseller_id = ?').run(req.params.id, req.resellerId);
  res.json({ ok: true });
});

// Pedidos do revendedor (histórico)
router.get('/orders', (req, res) => {
  const orders = db.prepare('SELECT * FROM orders WHERE reseller_id = ? ORDER BY id DESC').all(req.resellerId);
  res.json(orders.map(pedidos.decorar));
});

module.exports = router;
