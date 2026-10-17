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


// ---------- Fonte GRÁTIS: OpenStreetMap (Nominatim + Overpass). Sem chave, sem cartão. ----------
// Não traz nota nem avaliações (isso só o Google tem): use o botão "Ver no Google" e digite a nota na ficha.
const OVERPASS = () => (process.env.OVERPASS_URLS ? process.env.OVERPASS_URLS.split(',') : ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']).map(u => u.trim());
const NOMINATIM = () => (process.env.NOMINATIM_BASE || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
const UA = 'Automazap-Prospeccao/1.0 (uso interno)';
// segmento digitado → etiquetas do OpenStreetMap
const OSM_TAGS = [
  [/barbear|barber/, [['shop', 'hairdresser']]], [/sal[aã]o|cabelei|beleza|manicure|unha/, [['shop', 'hairdresser'], ['shop', 'beauty']]],
  [/est[eé]tic|depila|sobrancelha/, [['shop', 'beauty']]], [/dentist|odonto/, [['amenity', 'dentist']]],
  [/cl[ií]nica|consult[oó]rio|m[eé]dic|fisio/, [['amenity', 'clinic'], ['amenity', 'doctors'], ['healthcare', 'physiotherapist']]],
  [/restaurante|pizzaria|churrasc/, [['amenity', 'restaurant']]], [/lanchonete|hamb[uú]rguer|padaria|caf[eé]|sorvete|a[cç]a[ií]/, [['amenity', 'fast_food'], ['amenity', 'cafe'], ['shop', 'bakery']]],
  [/oficina|mec[aâ]nic|auto|funilaria|borracharia/, [['shop', 'car_repair']]], [/academia|fitness|muscula|crossfit/, [['leisure', 'fitness_centre']]],
  [/roupa|moda|boutique|vestu[aá]rio/, [['shop', 'clothes'], ['shop', 'boutique']]], [/pet|veterin|animal/, [['shop', 'pet'], ['amenity', 'veterinary']]],
  [/farm[aá]cia|drogaria/, [['amenity', 'pharmacy']]], [/autoescola|auto escola/, [['amenity', 'driving_school']]],
  [/mercad|supermercado|mercearia/, [['shop', 'supermarket'], ['shop', 'convenience']]], [/hotel|pousada|hospedagem/, [['tourism', 'hotel'], ['tourism', 'guest_house']]],
  [/[óo]tica|oculos|óculos/, [['shop', 'optician']]], [/loja|com[eé]rcio/, [['shop', 'clothes'], ['shop', 'variety_store'], ['shop', 'electronics']]],
];
const tagsDe = seg => { const t = String(seg || '').toLowerCase(); const r = OSM_TAGS.find(([re]) => re.test(t)); return r ? r[1] : null; };
const distKm = (a, b, c, d) => { const R = 6371, rad = x => x * Math.PI / 180, dl = rad(c - a), dn = rad(d - b); const h = Math.sin(dl / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

async function geocodificar(local) {
  const r = await fetch(`${NOMINATIM()}/search?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(local)}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('geocodificação ' + r.status);
  const j = await r.json();
  if (!j.length) return null;
  return { lat: Number(j[0].lat), lng: Number(j[0].lon), nome: j[0].display_name };
}
async function overpass(q) {
  let erro = 'sem resposta';
  for (const url of OVERPASS()) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(30000) });
      if (r.ok) return (await r.json()).elements || [];
      erro = 'Overpass ' + r.status;
    } catch (e) { erro = e.message; }
  }
  throw new Error(erro);
}
function normalizarOsm(e, centro) {
  const t = e.tags || {};
  const nome = txt(t.name || t.brand, 120); if (!nome) return null;
  const lat = e.lat != null ? e.lat : (e.center || {}).lat, lng = e.lon != null ? e.lon : (e.center || {}).lon;
  const rua = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(', ');
  const bairro = txt(t['addr:suburb'] || t['addr:neighbourhood'] || t['addr:district'], 60);
  const cidade = txt(t['addr:city'], 60);
  const endereco = txt([rua, bairro, cidade].filter(Boolean).join(' - '), 200);
  const telefone = txt(t.phone || t['contact:phone'] || t['contact:mobile'] || t['contact:whatsapp'] || t.mobile, 40).split(/[;,]/)[0].trim();
  const site = txt(t.website || t['contact:website'] || t.url, 200);
  const insta = txt(t['contact:instagram'] || t.instagram, 60).replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/[/@]/g, '');
  const p = { place_id: `osm:${e.type}/${e.id}`, nome, endereco, bairro, telefone, nota: null, avaliacoes: 0, site, instagram: insta, lat, lng,
    maps_url: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(nome + ' ' + (cidade || endereco || '')),
    categoria: txt(t.shop || t.amenity || t.leisure || t.tourism || t.healthcare, 40), aberto: true, fonte: 'osm',
    distancia_km: lat != null && centro ? Math.round(distKm(centro.lat, centro.lng, lat, lng) * 10) / 10 : null };
  // Sem nota (OSM não tem): a oportunidade vem de ter como contatar e de ter pouca presença digital.
  let s = 0; const porque = [];
  if (telefone) { s += 45; porque.push('tem telefone'); } else porque.push('sem telefone no mapa');
  if (insta) { s += 5; porque.push('tem Instagram'); }
  if (!site) { s += 20; porque.push('sem site (pouca presença digital)'); } else porque.push('tem site');
  if (p.distancia_km != null && p.distancia_km <= 2) { s += 10; porque.push('pertinho'); }
  if (endereco) s += 10;
  return { ...p, score: Math.min(100, s), nivel: s >= 70 ? 'alta' : s >= 45 ? 'media' : 'baixa', porque };
}
async function buscarOsm(b, res) {
  const segmento = txt(b.segmento, 60), local = txt(b.local, 100);
  const tags = tagsDe(segmento);
  if (!tags) return res.status(400).json({ error: 'Não reconheci esse segmento no mapa livre. Tente: barbearia, salão, clínica, dentista, restaurante, lanchonete, oficina, academia, loja de roupas, pet shop, farmácia, mercadinho, hotel.' });
  const raio = Math.min(20000, Math.max(500, Number(b.raio) || 5000));
  let centro = null;
  const lat = num(b.lat), lng = num(b.lng);
  try {
    if (local) centro = await geocodificar(local);
    if (!centro && lat != null && lng != null) centro = { lat, lng, nome: 'sua localização' };
    if (!centro) return res.status(400).json({ error: 'Não achei esse lugar. Escreva "bairro, cidade" ou use a sua localização.' });
    const filtros = tags.map(([k, v]) => `nwr["${k}"="${v}"](around:${raio},${centro.lat},${centro.lng});`).join('');
    const els = await overpass(`[out:json][timeout:25];(${filtros});out center tags 300;`);
    const visto = new Set();
    const lista = els.map(e => normalizarOsm(e, centro)).filter(p => p && !visto.has(p.place_id) && visto.add(p.place_id));
    const tem = db.prepare('SELECT id FROM prospects WHERE place_id = ?');
    const out = lista.map(p => ({ ...p, ja_salvo: !!tem.get(p.place_id) })).sort((a, b2) => b2.score - a.score || (a.distancia_km || 99) - (b2.distancia_km || 99));
    res.json({ total: out.length, mais: false, fonte: 'osm', centro: centro.nome, resultados: out });
  } catch (e) { res.status(502).json({ error: 'O mapa livre (OpenStreetMap) não respondeu agora: ' + e.message + '. Tente de novo em instantes.' }); }
}

router.get('/status', (req, res) => {
  const n = s => db.prepare(s).get().n;
  res.json({ google: !!process.env.GOOGLE_PLACES_API_KEY, osm: true, total: n('SELECT COUNT(*) AS n FROM prospects') });
});

// Busca empresas no Google por segmento + região (texto "Bairro, Cidade" e/ou latitude/longitude + raio).
router.post('/buscar', async (req, res) => {
  if ((req.body || {}).fonte !== 'google') return buscarOsm(req.body || {}, res);
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
  const ins = db.prepare(`INSERT INTO prospects (place_id, nome, segmento, telefone, instagram, endereco, bairro, nota, avaliacoes, site, maps_url, lat, lng, origem)
    VALUES (@place_id, @nome, @segmento, @telefone, @instagram, @endereco, @bairro, @nota, @avaliacoes, @site, @maps_url, @lat, @lng, @origem)`);
  let novos = 0, repetidos = 0;
  db.transaction(() => {
    for (const x of L) {
      const nome = txt(x.nome, 120), pid = txt(x.place_id, 120);
      if (!nome || !pid) continue;
      if (tem.get(pid)) { repetidos++; continue; }
      ins.run({ place_id: pid, nome, origem: /^osm:/.test(pid) ? 'osm' : 'google', instagram: txt(x.instagram, 60), segmento: segPadrao || txt(x.categoria, 40), telefone: txt(x.telefone, 25), endereco: txt(x.endereco, 200), bairro: txt(x.bairro, 60),
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
    nota: (() => { const n = num(String(b.nota ?? '').replace(',', '.')); return b.nota === '' || b.nota == null || n == null || n < 0 || n > 5 ? null : Math.round(n * 10) / 10; })(),
    avaliacoes: Math.max(0, Math.floor(num(b.avaliacoes) || 0)),
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
    obs=@obs, status=@status, prox_contato=@prox_contato, nota=@nota, avaliacoes=@avaliacoes, motivo_perda=@motivo_perda, atualizado_em=datetime('now') WHERE id=@id`).run({ ...v.d, id: Number(req.params.id) });
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
module.exports._t = { bairroDe, oportunidade, tagsDe, normalizarOsm };
