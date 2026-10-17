// Prospecção de empresas locais — busca no Google (Places API) por região, funil de vendas e histórico de contatos.
// Montado dentro de routes-api.js (herda o login do painel): /api/prospeccao/...
const express = require('express');
const { db } = require('./db.js');

const router = express.Router();
const STATUS = ['novo', 'abordado', 'interessado', 'orcamento', 'fechado', 'perdido'];
const TIPOS = ['visita', 'whatsapp', 'ligacao', 'nota'];
const BASE = () => (process.env.GOOGLE_PLACES_BASE || 'https://places.googleapis.com').replace(/\/+$/, '');
const CAMPOS = 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.rating,places.userRatingCount,places.websiteUri,places.googleMapsUri,places.businessStatus,places.location,places.primaryTypeDisplayName,nextPageToken';

const txt = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const data = v => (/^\d{4}-\d\d-\d\d$/.test(String(v || '')) ? v : null);
const digitos = v => String(v || '').replace(/\D/g, '');
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const agora = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// "Rua A, 12 - Centro, Feira de Santana - BA, 44001-000, Brasil" → "Centro"
function bairroDe(end) {
  const m = /,\s*[^,]*?\s-\s*([^,]+?),\s*[^,]+?\s-\s*[A-Z]{2}\b/.exec(String(end || '')) || /^[^,]+\s-\s*([^,]+?),\s*[^,]+?\s-\s*[A-Z]{2}\b/.exec(String(end || ''));
  return m ? txt(m[1], 60) : '';
}

// Quanto essa empresa precisa de avaliações (0–100): poucas avaliações, nota abaixo do ideal e telefone para contato.
function oportunidade(p) {
  let s = 0; const porque = [];
  const n = p.avaliacoes, r = p.nota;
  if (n == null || n < 10) { s += 40; porque.push(n ? `só ${n} avaliações` : 'quase sem avaliações'); }
  else if (n < 30) { s += 30; porque.push(`poucas avaliações (${n})`); }
  else if (n < 100) { s += 15; porque.push(`${n} avaliações`); }
  if (r != null && r < 4.0) { s += 25; porque.push(`nota baixa (${String(r).replace('.', ',')})`); }
  else if (r != null && r < 4.5) { s += 15; porque.push(`nota ${String(r).replace('.', ',')}`); }
  else if (r != null && r < 4.7) s += 5;
  if (p.telefone) s += 20; else porque.push('sem telefone no Google');
  if (!p.site) s += 5;
  return { score: Math.min(100, s), nivel: s >= 65 ? 'alta' : s >= 40 ? 'media' : 'baixa', porque };
}

function normalizar(g) {
  const loc = g.location || {};
  const p = {
    place_id: g.id, nome: txt((g.displayName || {}).text, 120), endereco: txt(g.formattedAddress, 200), bairro: bairroDe(g.formattedAddress),
    telefone: txt(g.nationalPhoneNumber || g.internationalPhoneNumber, 25), nota: num(g.rating), avaliacoes: num(g.userRatingCount) || 0,
    site: txt(g.websiteUri, 200), maps_url: txt(g.googleMapsUri, 300), lat: num(loc.latitude), lng: num(loc.longitude),
    categoria: txt((g.primaryTypeDisplayName || {}).text, 60), aberto: !g.businessStatus || g.businessStatus === 'OPERATIONAL',
  };
  return { ...p, ...oportunidade(p) };
}

router.get('/status', (req, res) => {
  const n = s => db.prepare(s).get().n;
  res.json({ google: !!process.env.GOOGLE_PLACES_API_KEY, total: n('SELECT COUNT(*) AS n FROM prospects') });
});

// Busca empresas no Google por segmento + região (texto "Bairro, Cidade" e/ou latitude/longitude + raio).
router.post('/buscar', async (req, res) => {
  const chave = process.env.GOOGLE_PLACES_API_KEY;
  if (!chave) return res.status(400).json({ error: 'Falta a chave do Google. No Railway, crie a variável GOOGLE_PLACES_API_KEY (Places API ativada no Google Cloud).' });
  const b = req.body || {};
  const segmento = txt(b.segmento, 60), local = txt(b.local, 100);
  if (!segmento) return res.status(400).json({ error: 'Informe o segmento (ex.: barbearia).' });
  const lat = num(b.lat), lng = num(b.lng);
  if (!local && (lat == null || lng == null)) return res.status(400).json({ error: 'Informe o bairro/cidade ou use a sua localização.' });
  const raio = Math.min(50000, Math.max(500, Number(b.raio) || 5000));
  const paginas = Math.min(3, Math.max(1, Number(b.paginas) || 1));
  const corpo = { textQuery: local ? `${segmento} em ${local}` : segmento, languageCode: 'pt-BR', regionCode: 'BR', pageSize: 20 };
  if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) corpo.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: raio } };
  let achados = [], token = null;
  try {
    for (let i = 0; i < paginas; i++) {
      const r = await fetch(BASE() + '/v1/places:searchText', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': chave, 'X-Goog-FieldMask': CAMPOS },
        body: JSON.stringify(token ? { ...corpo, pageToken: token } : corpo), signal: AbortSignal.timeout(15000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = (j.error && j.error.message) || ('Erro ' + r.status);
        if (i === 0) return res.status(502).json({ error: 'O Google recusou a busca: ' + msg });
        break;
      }
      achados = achados.concat((j.places || []).map(normalizar));
      token = j.nextPageToken || null;
      if (!token) break;
    }
  } catch (e) { return res.status(502).json({ error: 'Não consegui falar com o Google: ' + e.message }); }
  const tem = db.prepare('SELECT id FROM prospects WHERE place_id = ?');
  const lista = achados.filter(p => p.aberto && p.place_id && p.nome).map(p => ({ ...p, ja_salvo: !!tem.get(p.place_id) }))
    .sort((a, b) => b.score - a.score || a.avaliacoes - b.avaliacoes);
  res.json({ total: lista.length, mais: !!token, resultados: lista });
});

// Salva (no funil) as empresas escolhidas na busca.
router.post('/salvar', (req, res) => {
  const L = (Array.isArray((req.body || {}).lugares) ? req.body.lugares : []).slice(0, 200);
  const segPadrao = txt((req.body || {}).segmento, 40);
  const tem = db.prepare('SELECT 1 FROM prospects WHERE place_id = ?');
  const ins = db.prepare(`INSERT INTO prospects (place_id, nome, segmento, telefone, endereco, bairro, nota, avaliacoes, site, maps_url, lat, lng, origem)
    VALUES (@place_id, @nome, @segmento, @telefone, @endereco, @bairro, @nota, @avaliacoes, @site, @maps_url, @lat, @lng, 'google')`);
  let novos = 0, repetidos = 0;
  db.transaction(() => {
    for (const x of L) {
      const nome = txt(x.nome, 120), pid = txt(x.place_id, 120);
      if (!nome || !pid) continue;
      if (tem.get(pid)) { repetidos++; continue; }
      ins.run({ place_id: pid, nome, segmento: txt(x.categoria, 40) || segPadrao, telefone: txt(x.telefone, 25), endereco: txt(x.endereco, 200), bairro: txt(x.bairro, 60),
        nota: num(x.nota), avaliacoes: Math.max(0, Math.floor(num(x.avaliacoes) || 0)), site: txt(x.site, 200), maps_url: txt(x.maps_url, 300), lat: num(x.lat), lng: num(x.lng) });
      novos++;
    }
  })();
  res.json({ novos, repetidos });
});

function campos(b) {
  b = b || {};
  const nome = txt(b.nome, 120);
  if (!nome) return { erro: 'Informe o nome da empresa.' };
  const status = STATUS.includes(b.status) ? b.status : 'novo';
  return { d: { nome, segmento: txt(b.segmento, 40), contato: txt(b.contato, 80), telefone: txt(b.telefone, 25), instagram: txt(b.instagram, 60).replace(/^@/, ''),
    endereco: txt(b.endereco, 200), bairro: txt(b.bairro, 60), obs: String(b.obs ?? '').trim().slice(0, 800), status, prox_contato: data(b.prox_contato),
    motivo_perda: status === 'perdido' ? txt(b.motivo_perda, 120) : '' } };
}
const LISTA = `SELECT p.*, (SELECT COUNT(*) FROM prospect_hist h WHERE h.prospect_id = p.id) AS contatos,
  (SELECT MAX(h.criado_em) FROM prospect_hist h WHERE h.prospect_id = p.id AND h.tipo <> 'nota') AS ultimo_contato FROM prospects p`;

router.get('/', (req, res) => res.json(db.prepare(LISTA + ' ORDER BY p.atualizado_em DESC, p.id DESC LIMIT 3000').all()));

router.post('/', (req, res) => {
  const v = campos(req.body); if (v.erro) return res.status(400).json({ error: v.erro });
  const r = db.prepare(`INSERT INTO prospects (nome, segmento, contato, telefone, instagram, endereco, bairro, obs, status, prox_contato, motivo_perda, origem)
    VALUES (@nome, @segmento, @contato, @telefone, @instagram, @endereco, @bairro, @obs, @status, @prox_contato, @motivo_perda, 'manual')`).run(v.d);
  res.json(db.prepare(LISTA + ' WHERE p.id = ?').get(r.lastInsertRowid));
});

// Lista colada: "Nome; telefone; segmento; bairro" por linha.
router.post('/importar', (req, res) => {
  const linhas = String((req.body || {}).texto || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 500);
  const segPadrao = txt((req.body || {}).segmento, 40);
  const tem = db.prepare('SELECT telefone FROM prospects WHERE lower(nome) = lower(?)');
  const ins = db.prepare("INSERT INTO prospects (nome, telefone, segmento, bairro, origem) VALUES (?, ?, ?, ?, 'manual')");
  let novos = 0, repetidos = 0;
  db.transaction(() => {
    for (const l of linhas) {
      const [nome, tel, seg, bairro] = l.split(/\s*[;\t|]\s*/).map(x => txt(x, 120));
      if (!nome) continue;
      if (tem.all(nome).some(p => !tel || !p.telefone || digitos(p.telefone) === digitos(tel))) { repetidos++; continue; }
      ins.run(nome, txt(tel, 25), txt(seg, 40) || segPadrao, txt(bairro, 60)); novos++;
    }
  })();
  res.json({ novos, repetidos });
});

router.get('/:id', (req, res) => {
  const p = db.prepare(LISTA + ' WHERE p.id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Empresa não encontrada.' });
  p.historico = db.prepare('SELECT id, tipo, texto, criado_em FROM prospect_hist WHERE prospect_id = ? ORDER BY id DESC LIMIT 200').all(p.id);
  res.json(p);
});

router.put('/:id', (req, res) => {
  const v = campos(req.body); if (v.erro) return res.status(400).json({ error: v.erro });
  const r = db.prepare(`UPDATE prospects SET nome=@nome, segmento=@segmento, contato=@contato, telefone=@telefone, instagram=@instagram, endereco=@endereco, bairro=@bairro,
    obs=@obs, status=@status, prox_contato=@prox_contato, motivo_perda=@motivo_perda, atualizado_em=datetime('now') WHERE id=@id`).run({ ...v.d, id: Number(req.params.id) });
  if (!r.changes) return res.status(404).json({ error: 'Empresa não encontrada.' });
  res.json(db.prepare(LISTA + ' WHERE p.id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  db.transaction(() => { db.prepare('DELETE FROM prospect_hist WHERE prospect_id = ?').run(req.params.id); db.prepare('DELETE FROM prospects WHERE id = ?').run(req.params.id); })();
  res.json({ ok: true });
});

router.post('/:id/contato', (req, res) => {
  const p = db.prepare('SELECT * FROM prospects WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Empresa não encontrada.' });
  const b = req.body || {};
  const tipo = TIPOS.includes(b.tipo) ? b.tipo : 'nota';
  const texto = String(b.texto ?? '').trim().slice(0, 800);
  if (!texto && tipo === 'nota') return res.status(400).json({ error: 'Escreva a anotação.' });
  let status = STATUS.includes(b.status) ? b.status : p.status;
  if (status === 'novo' && tipo !== 'nota') status = 'abordado';
  const prox = b.prox_contato === '' ? null : (data(b.prox_contato) || p.prox_contato);
  db.transaction(() => {
    db.prepare('INSERT INTO prospect_hist (prospect_id, tipo, texto, criado_em) VALUES (?, ?, ?, ?)').run(p.id, tipo, texto || 'Contato registrado', agora());
    db.prepare("UPDATE prospects SET status = ?, prox_contato = ?, motivo_perda = ?, atualizado_em = datetime('now') WHERE id = ?")
      .run(status, prox, status === 'perdido' ? txt(b.motivo_perda, 120) || p.motivo_perda : '', p.id);
  })();
  res.json(db.prepare(LISTA + ' WHERE p.id = ?').get(p.id));
});

module.exports = router;
module.exports._t = { bairroDe, oportunidade };
