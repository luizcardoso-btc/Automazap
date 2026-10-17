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
// Catálogo de nichos → etiquetas do OpenStreetMap. Cada "alternativa" é um conjunto de condições (E); as alternativas são "OU".
const C = (k, v) => [k, v];
const NICHOS = [
  { id: 'barbearia', nome: 'Barbearia', ico: '✂️', re: /barbear|barber/, alt: [[C('shop', 'hairdresser'), ['name', '~', 'barb']]], dica: 'Vive de indicação e de nota no Google: a placa faz o cliente avaliar ao pagar.' },
  { id: 'salao', nome: 'Salão de beleza', ico: '💇', re: /sal[aã]o|cabelei|beleza|manicure|unha/, alt: [[C('shop', 'hairdresser')], [C('shop', 'beauty')]], dica: 'Cliente fiel e muito Instagram: placa de avaliação + QR do perfil na bancada.' },
  { id: 'estetica', nome: 'Clínica de estética', ico: '💆', re: /est[eé]tic|depila|sobrancelha/, alt: [[C('shop', 'beauty')], [C('shop', 'massage')]], dica: 'Serviço de confiança: avaliações no Google decidem a compra.' },
  { id: 'tatuagem', nome: 'Estúdio de tatuagem', ico: '🖋️', re: /tatu|tattoo/, alt: [[C('shop', 'tattoo')]], dica: 'Cliente escolhe pelo portfólio: placa leva direto ao Instagram e ao WhatsApp para agendar.' },
  { id: 'otica', nome: 'Ótica', ico: '👓', re: /[óo]tica|[óo]culos/, alt: [[C('shop', 'optician')]], dica: 'Ticket alto: avaliações e Instagram dão confiança; QR no balcão para orçamento.' },
  { id: 'padaria', nome: 'Padaria / confeitaria', ico: '🥖', re: /padaria|confeit|panific/, alt: [[C('shop', 'bakery')], [C('shop', 'pastry')]], dica: 'Alto fluxo diário: QR no balcão para seguir o Instagram e ver promoções.' },
  { id: 'roupa_masc', nome: 'Roupas masculinas', ico: '👔', re: /masculin|homem|men/, alt: [[C('shop', 'clothes'), C('clothes', 'men')], [C('shop', 'clothes'), ['name', '~', 'masc|homem|men|man |boy|social']]], dica: 'Cliente segue o Instagram da loja para ver lançamentos: placa no caixa e no provador.' },
  { id: 'roupa_fem', nome: 'Roupas femininas', ico: '👗', re: /feminin|mulher|women|moda fem/, alt: [[C('shop', 'clothes'), C('clothes', 'women')], [C('shop', 'clothes'), ['name', '~', 'fem|mulher|women|moda|boutique|lingerie']], [C('shop', 'boutique')]], dica: 'Compra por Instagram e indicação: placa com perfil + avaliação no caixa.' },
  { id: 'roupa', nome: 'Lojas de roupas (geral)', ico: '👕', re: /roupa|moda|boutique|vestu[aá]rio|loja de roupas/, alt: [[C('shop', 'clothes')], [C('shop', 'boutique')]], dica: 'Placa no caixa para seguir o Instagram e avaliar.' },
  { id: 'calcados', nome: 'Calçados', ico: '👟', re: /cal[cç]ado|sapato|t[eê]nis/, alt: [[C('shop', 'shoes')]], dica: 'Avaliações e Instagram trazem o cliente que compara loja antes de comprar.' },
  { id: 'joias', nome: 'Joalheria / bijuteria', ico: '💍', re: /joia|jóia|bijut|semi.?joia/, alt: [[C('shop', 'jewelry')]], dica: 'Compra por confiança: avaliações e perfil do Instagram pesam muito.' },
  { id: 'perfumaria', nome: 'Perfumaria / cosméticos', ico: '💄', re: /perfum|cosm[eé]tic/, alt: [[C('shop', 'perfumery')], [C('shop', 'cosmetics')]], dica: 'Placa com Instagram e avaliação ao lado do caixa.' },
  { id: 'restaurante', nome: 'Restaurante', ico: '🍽️', re: /restaurante|churrasc/, alt: [[C('amenity', 'restaurant')]], dica: 'Nota no Google define onde as pessoas almoçam: QR na mesa e no caixa.' },
  { id: 'pizzaria', nome: 'Pizzaria', ico: '🍕', re: /pizz/, alt: [[C('amenity', 'restaurant'), C('cuisine', 'pizza')], [C('amenity', 'fast_food'), C('cuisine', 'pizza')]], dica: 'Delivery e salão: QR na caixa da pizza e na mesa para avaliar.' },
  { id: 'lanchonete', nome: 'Lanchonete / hamburgueria', ico: '🍔', re: /lanchonete|hamb[uú]rguer|sorvete|a[cç]a[ií]|fast/, alt: [[C('amenity', 'fast_food')], [C('amenity', 'ice_cream')], [C('amenity', 'cafe')]], dica: 'Alto giro: QR no balcão e na embalagem para avaliar e seguir.' },
  { id: 'bar', nome: 'Bar / pub', ico: '🍺', re: /\bbar\b|pub|boteco/, alt: [[C('amenity', 'bar')], [C('amenity', 'pub')]], dica: 'Placa nas mesas leva ao Instagram da programação.' },
  { id: 'academia', nome: 'Academia', ico: '🏋️', re: /academia|fitness|muscula|crossfit|pilates/, alt: [[C('leisure', 'fitness_centre')]], dica: 'Avaliações atraem matrícula; placa na recepção.' },
  { id: 'dentista', nome: 'Dentista', ico: '🦷', re: /dentist|odonto/, alt: [[C('amenity', 'dentist')]], dica: 'Confiança é tudo: nota no Google traz paciente novo.' },
  { id: 'clinica', nome: 'Clínica / consultório', ico: '🏥', re: /cl[ií]nica|consult[oó]rio|m[eé]dic|fisio|psic/, alt: [[C('amenity', 'clinic')], [C('amenity', 'doctors')], [C('healthcare', 'physiotherapist')]], dica: 'Placa na recepção pede avaliação de forma discreta.' },
  { id: 'pet', nome: 'Pet shop / veterinária', ico: '🐾', re: /pet|veterin|animal|ra[cç][aã]o/, alt: [[C('shop', 'pet')], [C('amenity', 'veterinary')]], dica: 'Tutor adora postar e avaliar: placa no balcão e no banho & tosa.' },
  { id: 'oficina', nome: 'Oficina mecânica', ico: '🔧', re: /oficina|mec[aâ]nic|funilaria|borracharia|auto el[eé]tric/, alt: [[C('shop', 'car_repair')]], dica: 'Cliente desconfia de oficina: avaliações no Google dão credibilidade.' },
  { id: 'lavajato', nome: 'Lava-jato / estética automotiva', ico: '🚿', re: /lava.?jato|est[eé]tica automotiva|car wash/, alt: [[C('amenity', 'car_wash')]], dica: 'Placa na saída pede avaliação com o carro limpo.' },
  { id: 'autoescola', nome: 'Autoescola', ico: '🚗', re: /autoescola|auto escola/, alt: [[C('amenity', 'driving_school')]], dica: 'Indicação e avaliações trazem aluno novo.' },
  { id: 'farmacia', nome: 'Farmácia', ico: '💊', re: /farm[aá]cia|drogaria/, alt: [[C('amenity', 'pharmacy')]], dica: 'Placa no balcão para avaliação e Instagram de ofertas.' },
  { id: 'mercado', nome: 'Mercadinho / supermercado', ico: '🛒', re: /mercad|supermercado|mercearia|a[cç]ougue/, alt: [[C('shop', 'supermarket')], [C('shop', 'convenience')], [C('shop', 'butcher')]], dica: 'QR nos caixas para ofertas da semana no Instagram/WhatsApp.' },
  { id: 'celular', nome: 'Celulares / eletrônicos', ico: '📱', re: /celular|eletr[oô]nic|inform[aá]tica|assist[eê]ncia/, alt: [[C('shop', 'mobile_phone')], [C('shop', 'electronics')], [C('shop', 'computer')]], dica: 'Assistência vive de confiança: avaliações no Google.' },
  { id: 'floricultura', nome: 'Floricultura', ico: '💐', re: /flor/, alt: [[C('shop', 'florist')]], dica: 'Compra por Instagram e WhatsApp: placa com os dois.' },
  { id: 'papelaria', nome: 'Papelaria / presentes', ico: '🎁', re: /papelaria|presente|armarinho/, alt: [[C('shop', 'stationery')], [C('shop', 'gift')]], dica: 'Placa no caixa para seguir e avaliar.' },
  { id: 'moveis', nome: 'Móveis / decoração', ico: '🛋️', re: /m[oó]veis|decora/, alt: [[C('shop', 'furniture')], [C('shop', 'interior_decoration')]], dica: 'Ticket alto: avaliações pesam na decisão.' },
  { id: 'construcao', nome: 'Material de construção', ico: '🧱', re: /constru|ferragem|tintas?/, alt: [[C('shop', 'doityourself')], [C('shop', 'hardware')], [C('shop', 'paint')]], dica: 'QR no balcão leva ao WhatsApp para orçamento.' },
  { id: 'imobiliaria', nome: 'Imobiliária', ico: '🏠', re: /imobili/, alt: [[C('office', 'estate_agent')]], dica: 'QR em placas de imóvel leva ao WhatsApp do corretor.' },
  { id: 'idiomas', nome: 'Escola / curso de idiomas', ico: '🎓', re: /idioma|curso|escola de/, alt: [[C('amenity', 'language_school')], [C('amenity', 'training')]], dica: 'Avaliações trazem matrícula.' },
  { id: 'hotel', nome: 'Hotel / pousada', ico: '🏨', re: /hotel|pousada|hospedagem/, alt: [[C('tourism', 'hotel')], [C('tourism', 'guest_house')], [C('tourism', 'motel')]], dica: 'Placa no quarto e na recepção para avaliação.' },
];
const nichoDe = seg => { const t = String(seg || '').toLowerCase().trim(); return NICHOS.find(n => n.id === t || n.nome.toLowerCase() === t) || NICHOS.find(n => n.re.test(t)) || null; };
const tagsDe = seg => { const n = nichoDe(seg); return n ? n.alt : null; };
// monta o pedaço da consulta Overpass para um nicho
const condQ = c => c.length === 3 ? `["${c[0]}"~"${String(c[2]).replace(/"/g, '')}",i]` : `["${c[0]}"="${c[1]}"]`;
const filtroQ = (alt, esc) => alt.map(conj => 'nwr' + conj.map(condQ).join('') + esc + ';').join('');
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
const pausa = ms => new Promise(r => setTimeout(r, ms));
// Busca um nicho: cidade inteira (área administrativa do OpenStreetMap) quando pedido; se a cidade não for achada, cai no raio.
async function acharNicho(nicho, centro, raio, cidade) {
  let els = [];
  if (cidade) {
    const nome = String(cidade).replace(/["\\]/g, '');
    els = await overpass(`[out:json][timeout:60];area["name"="${nome}"]["boundary"="administrative"]->.a;(${filtroQ(nicho.alt, '(area.a)')});out center tags 800;`);
  }
  if (!els.length) els = await overpass(`[out:json][timeout:30];(${filtroQ(nicho.alt, `(around:${raio},${centro.lat},${centro.lng})`)});out center tags 500;`);
  const visto = new Set();
  return els.map(e => normalizarOsm(e, centro)).filter(p => p && !visto.has(p.place_id) && visto.add(p.place_id)).map(p => ({ ...p, segmento: nicho.nome, nicho: nicho.id }));
}
const ordenar = (l, tem) => l.map(p => ({ ...p, ja_salvo: !!tem.get(p.place_id) })).sort((a, b2) => b2.score - a.score || (a.distancia_km || 99) - (b2.distancia_km || 99));
async function centroDe(b) {
  const local = txt(b.local, 100), lat = num(b.lat), lng = num(b.lng); let centro = null;
  if (local) centro = await geocodificar(local);
  if (!centro && lat != null && lng != null) centro = { lat, lng, nome: 'sua localização' };
  return centro;
}
async function buscarOsm(b, res) {
  const nicho = nichoDe(b.nicho || b.segmento);
  if (!nicho) return res.status(400).json({ error: 'Não reconheci esse segmento no mapa livre. Escolha um da lista (barbearia, tatuagem, ótica, padaria, roupas…).' });
  const raio = Math.min(20000, Math.max(500, Number(b.raio) || 5000));
  try {
    const centro = await centroDe(b);
    if (!centro) return res.status(400).json({ error: 'Não achei esse lugar. Escreva "bairro, cidade" ou use a sua localização.' });
    const out = ordenar(await acharNicho(nicho, centro, raio, null), db.prepare('SELECT id FROM prospects WHERE place_id = ?'));
    res.json({ total: out.length, mais: false, fonte: 'osm', centro: centro.nome, resultados: out });
  } catch (e) { res.status(502).json({ error: 'O mapa livre (OpenStreetMap) não respondeu agora: ' + e.message + '. Tente de novo em instantes.' }); }
}
// Varredura da cidade: vários nichos de uma vez, um resumo por nicho e a lista única (sem repetir a mesma empresa).
async function varrerOsm(b, res) {
  const ids = Array.isArray(b.nichos) ? b.nichos : []; const nichos = ids.map(nichoDe).filter(Boolean).filter((n, i, a) => a.indexOf(n) === i);
  if (!nichos.length) return res.status(400).json({ error: 'Marque pelo menos um nicho para varrer.' });
  const cidade = txt(b.cidade, 60) || 'Feira de Santana';
  try {
    const centro = await geocodificar(cidade + ', Brasil') || await centroDe(b);
    if (!centro) return res.status(400).json({ error: 'Não achei essa cidade no mapa.' });
    const tem = db.prepare('SELECT id FROM prospects WHERE place_id = ?'), vistos = new Set(), resumo = [], todos = [];
    for (let i = 0; i < nichos.length; i++) {
      if (i) await pausa(Number(process.env.VARRER_PAUSA_MS != null ? process.env.VARRER_PAUSA_MS : 1200)); // educado com o servidor gratuito
      const n = nichos[i];
      try {
        const lista = (await acharNicho(n, centro, Math.min(20000, Math.max(3000, Number(b.raio) || 12000)), cidade)).filter(p => !vistos.has(p.place_id) && vistos.add(p.place_id));
        todos.push(...lista);
        resumo.push({ id: n.id, nome: n.nome, ico: n.ico, dica: n.dica, total: lista.length, com_telefone: lista.filter(p => p.telefone).length, sem_site: lista.filter(p => !p.site).length, novos: lista.filter(p => !tem.get(p.place_id)).length });
      } catch (e) { resumo.push({ id: n.id, nome: n.nome, ico: n.ico, dica: n.dica, total: 0, com_telefone: 0, sem_site: 0, novos: 0, erro: e.message }); }
    }
    res.json({ total: todos.length, mais: false, fonte: 'osm', centro: centro.nome, cidade, resumo, resultados: ordenar(todos, tem) });
  } catch (e) { res.status(502).json({ error: 'O mapa livre (OpenStreetMap) não respondeu agora: ' + e.message + '. Tente de novo em instantes.' }); }
}

router.get('/nichos', (req, res) => res.json(NICHOS.map(({ id, nome, ico, dica }) => ({ id, nome, ico, dica }))));
router.post('/varrer', (req, res) => varrerOsm(req.body || {}, res));
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
      ins.run({ place_id: pid, nome, origem: /^osm:/.test(pid) ? 'osm' : 'google', instagram: txt(x.instagram, 60), segmento: txt(x.segmento, 40) || segPadrao || txt(x.categoria, 40), telefone: txt(x.telefone, 25), endereco: txt(x.endereco, 200), bairro: txt(x.bairro, 60),
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
module.exports._t = { bairroDe, oportunidade, tagsDe, normalizarOsm, NICHOS };
