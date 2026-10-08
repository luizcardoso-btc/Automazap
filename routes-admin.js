const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./database.js');
const senha = require('./senha.js');
const pedidos = require('./pedidos.js');
const { requireAdmin } = require('./auth-middleware.js');

const router = express.Router();
router.use(requireAdmin);

router.get('/overview', (req, res) => {
  const revendedores = db.prepare('SELECT COUNT(*) AS n FROM resellers').get().n;
  const faturamento = db.prepare("SELECT COALESCE(SUM(total),0) AS s FROM orders WHERE status IN ('pago','em_producao','enviado','entregue')").get().s;
  const pendentes = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status='aguardando_pagamento'").get().n;
  const placas = db.prepare('SELECT COUNT(*) AS n FROM plates').get().n;
  const ativas = db.prepare("SELECT COUNT(*) AS n FROM plates WHERE status='ativa'").get().n;
  const aReceber = db.prepare("SELECT COALESCE(SUM(total),0) AS s FROM orders WHERE status='aguardando_pagamento'").get().s;
  const pagos = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status IN ('pago','em_producao','enviado','entregue')").get().n;
  const freteCobrado = db.prepare("SELECT COALESCE(SUM(shipping_fee),0) AS s FROM orders WHERE status IN ('pago','em_producao','enviado','entregue')").get().s;
  res.json({ revendedores, faturamento, frete_cobrado: freteCobrado, a_receber: aReceber, pendentes, pagos, placas, ativas, persistente: db.meta.persistente });
});

// Gera um link de redefinição de senha (vale 24h) para o fornecedor enviar ao revendedor, por exemplo no WhatsApp.
router.post('/resellers/:id/reset-link', (req, res) => {
  const r = db.prepare('SELECT id, name FROM resellers WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Revendedor não encontrado.' });
  res.json({ link: senha.criarLink(req, r.id, 24), nome: r.name });
});

// Baixa uma cópia completa do banco (arquivo .db) — guarde no seu computador de vez em quando.
router.get('/backup', (req, res) => {
  try {
    const arquivo = db.copiaTemporaria();
    const nome = `nextap-backup-${new Date().toISOString().slice(0, 10)}.db`;
    res.download(arquivo, nome, () => fs.unlink(arquivo, () => {}));
  } catch (e) {
    console.error('[DB] Falha ao gerar backup para download:', e.message);
    res.status(500).json({ error: 'Não foi possível gerar o backup agora.' });
  }
});

// Situação do armazenamento, contagens e backups (tela "Dados e backups").
router.get('/sistema', (req, res) => {
  res.json({
    dados_persistentes: db.meta.persistente,
    integridade: db.integridade(),
    contagens: db.contagens(),
    backups: db.listarBackups(),
  });
});

// Restaurar a partir de um backup que já está guardado no servidor (pasta backups/ do Volume).
router.post('/restore-local', (req, res) => {
  const { nome, modo } = req.body || {};
  const arquivo = path.join(db.meta.backupDir, path.basename(String(nome || '')));
  if (!/\.db$/.test(arquivo) || !fs.existsSync(arquivo)) return res.status(404).json({ error: 'Backup não encontrado no servidor.' });
  if (!['substituir', 'revendedores'].includes(modo)) return res.status(400).json({ error: 'Escolha como restaurar.' });
  try { res.json(db.restaurar(arquivo, modo)); }
  catch (e) { console.error('[DB] Falha ao restaurar:', e.message); res.status(400).json({ error: e.message }); }
});

// Restaurar a partir de um arquivo .db enviado pelo painel (o backup que você baixou).
router.post('/restore', express.raw({ type: () => true, limit: '80mb' }), (req, res) => {
  const modo = String(req.query.modo || '');
  if (!['substituir', 'revendedores'].includes(modo)) return res.status(400).json({ error: 'Escolha como restaurar.' });
  if (!Buffer.isBuffer(req.body) || req.body.length < 512) return res.status(400).json({ error: 'Nenhum arquivo recebido.' });
  const tmp = path.join(os.tmpdir(), `restore-${crypto.randomBytes(6).toString('hex')}.db`);
  try {
    fs.writeFileSync(tmp, req.body);
    res.json(db.restaurar(tmp, modo));
  } catch (e) {
    console.error('[DB] Falha ao restaurar upload:', e.message);
    res.status(400).json({ error: e.message });
  } finally { fs.unlink(tmp, () => {}); }
});

// Lista de revendedores em planilha (CSV abre no Excel/Google Planilhas) — outra forma de guardar uma cópia.
const csvCel = v => {
  let t = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // evita fórmulas maliciosas ao abrir no Excel
  return '"' + t.replace(/"/g, '""') + '"';
};
router.get('/export/revendedores', (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.name, r.email, r.whatsapp, r.created_at,
      r.addr_cep, r.addr_street, r.addr_number, r.addr_complement, r.addr_district, r.addr_city, r.addr_state, r.addr_country,
      (SELECT COUNT(*) FROM orders o WHERE o.reseller_id = r.id) AS pedidos,
      (SELECT COUNT(*) FROM plates p WHERE p.reseller_id = r.id) AS placas
    FROM resellers r ORDER BY r.id`).all();
  const cab = ['ID', 'Nome', 'E-mail', 'WhatsApp', 'Cadastro', 'CEP', 'Rua', 'Número', 'Complemento', 'Bairro', 'Cidade', 'UF', 'País', 'Pedidos', 'Placas'];
  const linhas = rows.map(r => [r.id, r.name, r.email, r.whatsapp, r.created_at, r.addr_cep, r.addr_street, r.addr_number,
    r.addr_complement, r.addr_district, r.addr_city, r.addr_state, r.addr_country, r.pedidos, r.placas].map(csvCel).join(';'));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="nextap-revendedores-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('\ufeff' + [cab.map(csvCel).join(';'), ...linhas].join('\r\n'));
});

// Cadastro manual de um revendedor (para reativar quem já tinha conta): cria a conta e devolve o link para ele escolher a senha.
router.post('/resellers', async (req, res) => {
  const { name, email, whatsapp } = req.body || {};
  const em = String(email || '').toLowerCase().trim();
  if (!String(name || '').trim() || !em.includes('@')) return res.status(400).json({ error: 'Informe nome e e-mail válidos.' });
  if (db.prepare('SELECT 1 FROM resellers WHERE email = ?').get(em)) return res.status(409).json({ error: 'Já existe um revendedor com esse e-mail.' });
  const hash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10); // senha aleatória; ele define a dele pelo link
  const info = db.prepare('INSERT INTO resellers (name, email, whatsapp, password_hash) VALUES (?, ?, ?, ?)')
    .run(String(name).trim().slice(0, 120), em, String(whatsapp || '').trim().slice(0, 30), hash);
  res.json({ id: info.lastInsertRowid, link: senha.criarLink(req, info.lastInsertRowid, 72) });
});

router.get('/resellers', (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.name, r.email, r.whatsapp, r.created_at,
      (SELECT COUNT(*) FROM orders o WHERE o.reseller_id=r.id) AS pedidos,
      (SELECT COALESCE(SUM(total),0) FROM orders o WHERE o.reseller_id=r.id AND o.status IN ('pago','em_producao','enviado','entregue')) AS gasto,
      (SELECT COUNT(*) FROM plates p WHERE p.reseller_id=r.id) AS placas,
      (SELECT COUNT(*) FROM sales s WHERE s.reseller_id=r.id) AS vendas
    FROM resellers r ORDER BY r.id DESC
  `).all();
  res.json(rows);
});

router.get('/orders', (req, res) => {
  const rows = db.prepare(`
    SELECT o.*, r.name AS reseller_name, r.email AS reseller_email
    FROM orders o JOIN resellers r ON r.id = o.reseller_id
    ORDER BY o.id DESC
  `).all();
  res.json(rows.map(pedidos.decorar));
});

// Frete fixo cobrado em cada pedido (R$). Vale na hora para novos pedidos; pedidos já feitos não mudam.
router.get('/frete', (req, res) => res.json({ frete: db.freteFixo() }));
router.put('/frete', (req, res) => {
  const v = Number(String((req.body || {}).valor).replace(',', '.'));
  if (!Number.isFinite(v) || v < 0 || v > 500) return res.status(400).json({ error: 'Informe um valor entre R$ 0,00 e R$ 500,00.' });
  db.prepare("INSERT INTO settings (chave, valor) VALUES ('frete_fixo', ?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor").run(v.toFixed(2));
  pedidos.registrarEvento({ origem: 'admin', resultado: 'frete_alterado', detalhe: 'R$ ' + v.toFixed(2) });
  res.json({ frete: db.freteFixo() });
});

// Cancelar (só pedido que ainda não foi pago). As demais etapas têm rotas próprias, abaixo.
router.put('/orders/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (status !== 'cancelado') return res.status(400).json({ error: 'Use os botões de produção, envio e entrega.' });
  const o = db.prepare('SELECT status FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (o.status !== 'aguardando_pagamento') {
    return res.status(409).json({ error: 'Só dá para cancelar pedidos que ainda aguardam pagamento. Para um pedido já pago, faça o estorno no Mercado Pago.' });
  }
  db.prepare("UPDATE orders SET status='cancelado' WHERE id=?").run(req.params.id);
  pedidos.registrarEvento({ origem: 'admin', order_id: Number(req.params.id), resultado: 'status_cancelado' });
  res.json({ ok: true });
});

// Custo real do envio (o que você pagou aos Correios). Vazio = não informado (null); inválido = false.
function lerCusto(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n >= 0 && n <= 5000 ? Math.round(n * 100) / 100 : false;
}
router.put('/orders/:id/custo-frete', (req, res) => {
  const v = lerCusto((req.body || {}).valor);
  if (v === false) return res.status(400).json({ error: 'Valor inválido.' });
  const r = db.prepare('UPDATE orders SET custo_frete_real = ? WHERE id = ?').run(v, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Pedido não encontrado.' });
  res.json({ ok: true });
});

// ---- Pedido recebido (pago) → Produção → Enviado (com código dos Correios) → Entregue ----
const pegar = id => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const resposta = id => ({ ok: true, order: pedidos.decorar(pegar(id)) });

function iniciarProducao(id) {
  const r = db.prepare("UPDATE orders SET status='em_producao', producao_at=datetime('now') WHERE id=? AND status='pago'").run(id);
  if (r.changes) pedidos.registrarEvento({ origem: 'admin', order_id: id, resultado: 'status_em_producao' });
  return r.changes > 0;
}

router.post('/orders/:id/producao', (req, res) => {
  const id = Number(req.params.id);
  if (!pegar(id)) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (!iniciarProducao(id)) return res.status(409).json({ error: 'A produção só pode começar em pedidos pagos que ainda não entraram em produção.' });
  res.json(resposta(id));
});

// Vários de uma vez (produzir em lote).
router.post('/orders-producao-lote', (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 200) : [];
  if (!ids.length) return res.status(400).json({ error: 'Selecione ao menos um pedido.' });
  const iniciados = db.transaction(() => ids.filter(iniciarProducao).length)();
  res.json({ iniciados, ignorados: ids.length - iniciados });
});

// Marcar como enviado, com o código de rastreio dos Correios.
router.post('/orders/:id/enviar', (req, res) => {
  const id = Number(req.params.id);
  const o = pegar(id);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (!['pago', 'em_producao'].includes(o.status)) {
    return res.status(409).json({ error: o.status === 'aguardando_pagamento' ? 'Este pedido ainda não foi pago. Confirme o pagamento antes de enviar.' : 'Este pedido não está na fila de envio.' });
  }
  const r = pedidos.lerRastreio(req.body);
  if (r.erro) return res.status(400).json({ error: r.erro });
  const outro = db.prepare('SELECT id FROM orders WHERE tracking_code = ? AND id <> ?').get(r.codigo, id);
  if (outro) return res.status(409).json({ error: `Este código de rastreio já foi usado no pedido #${String(outro.id).padStart(5, '0')}.` });
  const custo = lerCusto((req.body || {}).custo_frete);
  if (custo === false) return res.status(400).json({ error: 'Custo do frete inválido. Informe um valor em reais (ex.: 18,90) ou deixe em branco.' });
  db.prepare(`UPDATE orders SET status='enviado', enviado_at=datetime('now'), producao_at=COALESCE(producao_at, datetime('now')),
    tracking_code=?, shipping_service=?, custo_frete_real=COALESCE(?, custo_frete_real) WHERE id=?`).run(r.codigo, r.servico || null, custo, id);
  pedidos.registrarEvento({ origem: 'admin', order_id: id, resultado: 'status_enviado', detalhe: r.codigo });
  res.json(resposta(id));
});

// Corrigir o código/serviço de um pedido que já foi enviado.
router.put('/orders/:id/rastreio', (req, res) => {
  const id = Number(req.params.id);
  const o = pegar(id);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (!['enviado', 'entregue'].includes(o.status)) return res.status(409).json({ error: 'Só dá para editar o rastreio de pedidos enviados.' });
  const r = pedidos.lerRastreio(req.body);
  if (r.erro) return res.status(400).json({ error: r.erro });
  const outro = db.prepare('SELECT id FROM orders WHERE tracking_code = ? AND id <> ?').get(r.codigo, id);
  if (outro) return res.status(409).json({ error: `Este código de rastreio já foi usado no pedido #${String(outro.id).padStart(5, '0')}.` });
  const custo = lerCusto((req.body || {}).custo_frete);
  if (custo === false) return res.status(400).json({ error: 'Custo do frete inválido. Informe um valor em reais (ex.: 18,90) ou deixe em branco.' });
  db.prepare('UPDATE orders SET tracking_code=?, shipping_service=?, custo_frete_real=COALESCE(?, custo_frete_real) WHERE id=?').run(r.codigo, r.servico || null, custo, id);
  pedidos.registrarEvento({ origem: 'admin', order_id: id, resultado: 'rastreio_alterado', detalhe: r.codigo });
  res.json(resposta(id));
});

// Entregue. (Também vale para entrega em mãos, sem código de rastreio.)
router.post('/orders/:id/entregar', (req, res) => {
  const id = Number(req.params.id);
  const o = pegar(id);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (!['pago', 'em_producao', 'enviado'].includes(o.status)) return res.status(409).json({ error: 'Este pedido não pode ser marcado como entregue agora.' });
  db.prepare("UPDATE orders SET status='entregue', entregue_at=datetime('now') WHERE id=?").run(id);
  pedidos.registrarEvento({ origem: 'admin', order_id: id, resultado: 'status_entregue' });
  res.json(resposta(id));
});

// Desfaz a última etapa (para corrigir um clique errado).
router.post('/orders/:id/voltar', (req, res) => {
  const id = Number(req.params.id);
  const o = pegar(id);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  const sql = {
    em_producao: "UPDATE orders SET status='pago', producao_at=NULL WHERE id=?",
    enviado: "UPDATE orders SET status='em_producao', enviado_at=NULL, tracking_code=NULL, shipping_service=NULL WHERE id=?",
    entregue: "UPDATE orders SET status='enviado', entregue_at=NULL WHERE id=?",
  }[o.status];
  if (!sql) return res.status(409).json({ error: 'Não há etapa para desfazer neste pedido.' });
  db.prepare(sql).run(id);
  pedidos.registrarEvento({ origem: 'admin', order_id: id, resultado: 'etapa_desfeita', detalhe: o.status });
  res.json(resposta(id));
});

// Confere no Mercado Pago se o pagamento deste pedido já caiu (não depende do webhook).
router.post('/orders/:id/conferir', async (req, res) => {
  try { res.json(await pedidos.conferirPedido(Number(req.params.id), 'admin')); }
  catch (e) { console.error('[PAGAMENTO] conferência manual falhou:', e.message); res.status(502).json({ error: 'Não consegui falar com o Mercado Pago agora. Tente de novo em instantes.' }); }
});

// Confere todos os pedidos que aguardam pagamento.
router.post('/orders-conferir-todos', async (req, res) => {
  try { res.json(await pedidos.conferirPendentes(60, 'admin')); }
  catch (e) { res.status(502).json({ error: 'Não consegui falar com o Mercado Pago agora.' }); }
});

// Confirmação manual (ex.: o dinheiro entrou por outro meio). Exige uma observação para ficar registrado.
router.post('/orders/:id/confirmar-pagamento', (req, res) => {
  const nota = String((req.body || {}).observacao || '').trim().slice(0, 300);
  if (nota.length < 3) return res.status(400).json({ error: 'Descreva como o pagamento foi recebido (ex.: "Pix direto na conta em 02/10").' });
  const o = db.prepare('SELECT status FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (!['aguardando_pagamento', 'cancelado'].includes(o.status)) return res.status(409).json({ error: 'Este pedido já está pago.' });
  pedidos.marcarPago(Number(req.params.id), { manual: true, nota });
  pedidos.registrarEvento({ origem: 'admin', order_id: Number(req.params.id), resultado: 'pago_manual', detalhe: nota });
  res.json({ ok: true });
});

// Pagamentos aprovados no Mercado Pago que não têm pedido no sistema (para o financeiro bater com o que você recebeu).
router.get('/mp-sem-pedido', async (req, res) => {
  try { res.json(await pedidos.pagamentosSemPedido()); }
  catch (e) { console.error('[PAGAMENTO] busca no MP falhou:', e.message); res.status(502).json({ error: 'Não consegui consultar o Mercado Pago agora.' }); }
});

// Últimas notificações/conferências de pagamento (para entender o que aconteceu com cada pedido).
router.get('/payment-events', (req, res) => {
  res.json(db.prepare('SELECT * FROM payment_events ORDER BY id DESC LIMIT 60').all());
});

router.get('/plates', (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, r.name AS reseller_name
    FROM plates p JOIN resellers r ON r.id = p.reseller_id
    ORDER BY p.id DESC
  `).all();
  res.json(rows);
});

router.get('/price-tiers', (req, res) => {
  res.json(db.prepare('SELECT * FROM price_tiers ORDER BY min_qty').all());
});

router.post('/price-tiers', (req, res) => {
  const { tiers } = req.body || {};
  if (!Array.isArray(tiers) || !tiers.length) return res.status(400).json({ error: 'Tabela inválida.' });
  const valid = tiers.every(t =>
    Number.isInteger(t.min_qty) && Number.isInteger(t.max_qty) &&
    t.min_qty >= 1 && t.max_qty >= t.min_qty &&
    typeof t.unit_price === 'number' && t.unit_price > 0);
  if (!valid) return res.status(400).json({ error: 'Faixas inválidas (quantidades inteiras e preço maior que zero).' });
  const del = db.prepare('DELETE FROM price_tiers');
  const ins = db.prepare('INSERT INTO price_tiers (min_qty, max_qty, unit_price) VALUES (?, ?, ?)');
  const tx = db.transaction((list) => {
    del.run();
    list.forEach(t => ins.run(t.min_qty, t.max_qty, t.unit_price));
  });
  tx(tiers);
  res.json({ ok: true });
});

// Fornecedores, estoque, despesas, custos e lucro estimado
router.use('/gestao', require('./routes-gestao.js'));

module.exports = router;
