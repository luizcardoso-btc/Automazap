// Gestão (admin): fornecedores, estoque, despesas, custos/taxas e lucro estimado. Montado em /api/admin/gestao (já exige login de admin).
const express = require('express');
const db = require('./database.js');
const F = require('./financeiro.js');
const pedidos = require('./pedidos.js');

const router = express.Router();
const txt = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const hoje = () => F.hojeBR();
// "13,50" ou "13.50" → 13.5 (ou null se inválido)
function num(v, min = 0, max = 1e9) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/\./g, (m, i, s) => (s.includes(',') ? '' : '.')).replace(',', '.'));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
const dataOk = d => /^\d{4}-\d\d-\d\d$/.test(String(d || '')) && !Number.isNaN(Date.parse(d + 'T12:00:00Z')) && d <= new Date(Date.now() + 864e5).toISOString().slice(0, 10);

// ---------------- fornecedores ----------------
function listaFornecedores() {
  return db.prepare(`SELECT f.*,
      (SELECT COUNT(*) FROM estoque_mov m WHERE m.fornecedor_id = f.id AND m.tipo='compra') AS compras,
      (SELECT COALESCE(SUM(quantidade),0) FROM estoque_mov m WHERE m.fornecedor_id = f.id AND m.tipo='compra') AS quantidade,
      (SELECT COALESCE(SUM(quantidade*COALESCE(custo_unit,0)+custo_extra),0) FROM estoque_mov m WHERE m.fornecedor_id = f.id AND m.tipo='compra') AS total_gasto,
      (SELECT MAX(data) FROM estoque_mov m WHERE m.fornecedor_id = f.id AND m.tipo='compra') AS ultima_compra
    FROM fornecedores f WHERE f.ativo = 1 ORDER BY f.nome COLLATE NOCASE`).all()
    .map(f => ({ ...f, preco_medio: f.quantidade ? F.r2(f.total_gasto / f.quantidade) : null, total_gasto: F.r2(f.total_gasto) }));
}
router.get('/fornecedores', (req, res) => res.json(listaFornecedores()));
router.post('/fornecedores', (req, res) => {
  const nome = txt(req.body?.nome, 80);
  if (!nome) return res.status(400).json({ error: 'Informe o nome do fornecedor.' });
  if (db.prepare('SELECT 1 FROM fornecedores WHERE ativo=1 AND lower(nome)=lower(?)').get(nome)) return res.status(409).json({ error: 'Já existe um fornecedor com esse nome.' });
  const r = db.prepare('INSERT INTO fornecedores (nome, contato, observacao) VALUES (?, ?, ?)').run(nome, txt(req.body?.contato, 80), txt(req.body?.observacao, 300));
  res.json({ id: r.lastInsertRowid });
});
router.put('/fornecedores/:id', (req, res) => {
  const nome = txt(req.body?.nome, 80);
  if (!nome) return res.status(400).json({ error: 'Informe o nome do fornecedor.' });
  const r = db.prepare('UPDATE fornecedores SET nome=?, contato=?, observacao=? WHERE id=? AND ativo=1').run(nome, txt(req.body?.contato, 80), txt(req.body?.observacao, 300), req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Fornecedor não encontrado.' });
  res.json({ ok: true });
});
router.delete('/fornecedores/:id', (req, res) => {
  const tem = db.prepare('SELECT 1 FROM estoque_mov WHERE fornecedor_id=?').get(req.params.id);
  if (tem) db.prepare('UPDATE fornecedores SET ativo=0 WHERE id=?').run(req.params.id); // mantém o histórico das compras
  else db.prepare('DELETE FROM fornecedores WHERE id=?').run(req.params.id);
  res.json({ ok: true, arquivado: !!tem });
});

// ---------------- estoque ----------------
router.get('/estoque', (req, res) => {
  const movs = db.prepare(`SELECT m.*, f.nome AS fornecedor FROM estoque_mov m LEFT JOIN fornecedores f ON f.id = m.fornecedor_id ORDER BY m.data DESC, m.id DESC LIMIT 150`).all()
    .map(m => ({ ...m, total: m.tipo === 'compra' ? F.r2(m.quantidade * (m.custo_unit || 0) + m.custo_extra) : null }));
  res.json({ resumo: F.estoque(), movimentos: movs, fornecedores: listaFornecedores() });
});

router.post('/estoque/compra', (req, res) => {
  const b = req.body || {};
  const quantidade = parseInt(b.quantidade, 10);
  if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > 1000000) return res.status(400).json({ error: 'Informe a quantidade comprada (número inteiro, mínimo 1).' });
  const custo = num(b.custo_unit, 0.01, 100000);
  if (custo === null) return res.status(400).json({ error: 'Informe o preço pago por placa (ex.: 13,50).' });
  const extra = b.custo_extra === undefined || String(b.custo_extra).trim() === '' ? 0 : num(b.custo_extra, 0, 1e7);
  if (extra === null) return res.status(400).json({ error: 'Frete/outros custos da compra inválido.' });
  const data = b.data ? String(b.data) : hoje();
  if (!dataOk(data)) return res.status(400).json({ error: 'Data inválida.' });
  let fid = b.fornecedor_id ? Number(b.fornecedor_id) : null;
  if (!fid && txt(b.fornecedor_novo, 80)) {
    const nome = txt(b.fornecedor_novo, 80);
    const ja = db.prepare('SELECT id FROM fornecedores WHERE ativo=1 AND lower(nome)=lower(?)').get(nome);
    fid = ja ? ja.id : Number(db.prepare('INSERT INTO fornecedores (nome) VALUES (?)').run(nome).lastInsertRowid);
  }
  if (!fid || !db.prepare('SELECT 1 FROM fornecedores WHERE id=? AND ativo=1').get(fid)) return res.status(400).json({ error: 'Escolha o fornecedor (ou digite o nome de um novo).' });
  const r = db.prepare("INSERT INTO estoque_mov (tipo, fornecedor_id, data, quantidade, custo_unit, custo_extra, observacao) VALUES ('compra', ?, ?, ?, ?, ?, ?)")
    .run(fid, data, quantidade, F.r2(custo), F.r2(extra), txt(b.observacao, 300));
  res.json({ id: r.lastInsertRowid, resumo: F.estoque() });
});

// "Quantas placas eu tenho agora?" — você conta e informa; o sistema cria o ajuste necessário.
router.post('/estoque/contagem', (req, res) => {
  const q = parseInt(req.body?.quantidade, 10);
  if (!Number.isInteger(q) || q < 0 || q > 1000000) return res.status(400).json({ error: 'Informe quantas placas você tem em mãos agora (número inteiro).' });
  const atual = F.estoque().em_maos, dif = q - atual;
  if (dif !== 0) db.prepare("INSERT INTO estoque_mov (tipo, data, quantidade, observacao) VALUES ('ajuste', ?, ?, ?)").run(hoje(), dif, `Contagem de estoque: ${q} placas em mãos (antes: ${atual})`);
  res.json({ ajuste: dif, resumo: F.estoque() });
});
router.post('/estoque/ajuste', (req, res) => {
  const q = parseInt(req.body?.quantidade, 10);
  const obs = txt(req.body?.observacao, 300);
  if (!Number.isInteger(q) || q === 0 || Math.abs(q) > 1000000) return res.status(400).json({ error: 'Informe a quantidade do ajuste (use negativo para perdas, ex.: -3).' });
  if (obs.length < 3) return res.status(400).json({ error: 'Explique o motivo do ajuste (ex.: "placas quebradas na produção").' });
  db.prepare("INSERT INTO estoque_mov (tipo, data, quantidade, observacao) VALUES ('ajuste', ?, ?, ?)").run(hoje(), q, obs);
  res.json({ resumo: F.estoque() });
});
router.delete('/estoque/:id', (req, res) => {
  const r = db.prepare('DELETE FROM estoque_mov WHERE id=?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Lançamento não encontrado.' });
  res.json({ resumo: F.estoque() });
});

// ---------------- despesas ----------------
router.get('/despesas', (req, res) => res.json(db.prepare('SELECT * FROM despesas ORDER BY data DESC, id DESC LIMIT 300').all().map(d => ({ ...d, mensal: !!d.mensal }))));
router.post('/despesas', (req, res) => {
  const b = req.body || {};
  const descricao = txt(b.descricao, 100), valor = num(b.valor, 0.01, 1e7);
  if (!descricao) return res.status(400).json({ error: 'Descreva a despesa (ex.: Railway, domínio, embalagens).' });
  if (valor === null) return res.status(400).json({ error: 'Informe o valor da despesa.' });
  const data = b.data ? String(b.data) : hoje();
  if (!dataOk(data)) return res.status(400).json({ error: 'Data inválida.' });
  const r = db.prepare('INSERT INTO despesas (data, descricao, categoria, valor, mensal) VALUES (?, ?, ?, ?, ?)').run(data, descricao, txt(b.categoria, 40), F.r2(valor), b.mensal ? 1 : 0);
  res.json({ id: r.lastInsertRowid });
});
router.delete('/despesas/:id', (req, res) => { db.prepare('DELETE FROM despesas WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ---------------- custos e taxas ----------------
const CHAVES = [['custo_placa', 0, 1000], ['icms_pct', 0, 30], ['taxa_pix_pct', 0, 20], ['taxa_cartao_pct', 0, 30], ['custo_envio_padrao', 0, 500], ['estoque_minimo', 0, 1000000]];
const lerCustos = () => ({ custo_placa: db.cfg('custo_placa', 13.5), icms_pct: db.cfg('icms_pct', 1), icms_base_frete: db.cfg('icms_base_frete', 1) === 1,
  taxa_pix_pct: db.cfg('taxa_pix_pct', 0.99), taxa_cartao_pct: db.cfg('taxa_cartao_pct', 4.98), custo_envio_padrao: db.cfg('custo_envio_padrao', 0),
  estoque_minimo: db.cfg('estoque_minimo', 50), custo_usar_medio: db.cfg('custo_usar_medio', 0) === 1, custo_medio_compras: F.estoque().custo_medio, frete_fixo: db.freteFixo() });
router.get('/custos', (req, res) => res.json(lerCustos()));
router.put('/custos', (req, res) => {
  const b = req.body || {}, novos = {};
  for (const [k, min, max] of CHAVES) {
    if (b[k] === undefined) continue;
    const v = num(b[k], min, max);
    if (v === null) return res.status(400).json({ error: `Valor inválido em "${k.replace(/_/g, ' ')}" (use um número entre ${min} e ${max}).` });
    novos[k] = k === 'estoque_minimo' ? Math.round(v) : Math.round(v * 100) / 100;
  }
  db.transaction(() => {
    for (const [k, v] of Object.entries(novos)) db.setCfg(k, v);
    if (b.icms_base_frete !== undefined) db.setCfg('icms_base_frete', b.icms_base_frete ? 1 : 0);
    if (b.custo_usar_medio !== undefined) db.setCfg('custo_usar_medio', b.custo_usar_medio ? 1 : 0);
  })();
  res.json(lerCustos());
});

// ---------------- lucro estimado e analista ----------------
const PERIODOS = ['today', '7', '30', '90', 'month', 'all'];
router.get('/lucro', (req, res) => res.json(F.lucro(PERIODOS.includes(req.query.periodo) ? req.query.periodo : 'all')));
router.post('/taxas-mp/atualizar', async (req, res) => {
  try { res.json(await pedidos.atualizarTaxas()); }
  catch (e) { res.status(502).json({ error: 'Não consegui falar com o Mercado Pago agora.' }); }
});
router.post('/analista', async (req, res) => {
  try { res.json(await F.analistaIA(PERIODOS.includes(req.body?.periodo) ? req.body.periodo : 'all')); }
  catch (e) {
    console.error('[ANALISTA]', e.message);
    res.status(e.codigo === 'sem_chave' ? 503 : 502).json({ error: e.codigo === 'sem_chave' ? e.message : `A IA não respondeu agora: ${e.message}` });
  }
});

module.exports = router;
