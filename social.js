// Renan (social media do Prédio): recebe as imagens que o CEO gerou e aprovou, publica no Instagram nos horários
// programados (feed, carrossel e stories) e traz as métricas de cada post para a Lia, a Nina e o CTO melhorarem a pauta.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, getSetting, setSetting, arquivo } = require('./db.js');

const DIA = 86400e3, FUSO = 3 * 3600e3;
const dataStr = t => new Date(t - FUSO).toISOString().slice(0, 10);
const horaStr = t => new Date(t - FUSO).toISOString().slice(11, 16);
const pasta = path.join(path.dirname(arquivo === ':memory:' ? path.join(require('os').tmpdir(), 'automazap-x', 'x') : arquivo), 'media', 'mkt');
fs.mkdirSync(pasta, { recursive: true });

db.exec(`CREATE TABLE IF NOT EXISTS mkt_pecas (id INTEGER PRIMARY KEY AUTOINCREMENT, dia TEXT NOT NULL, slot TEXT NOT NULL, canal TEXT NOT NULL, tipo TEXT NOT NULL,
  titulo TEXT NOT NULL, pilar TEXT NOT NULL DEFAULT '', slides TEXT NOT NULL DEFAULT '[]', legenda TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'aguardando',
  revisao TEXT NOT NULL DEFAULT '{}', versao INTEGER NOT NULL DEFAULT 0, criado_em INTEGER NOT NULL, UNIQUE(dia, slot))`);
// Colunas novas da peça (sem depender da ordem das migrações)
{ const tem = c => db.prepare('PRAGMA table_info(mkt_pecas)').all().some(x => x.name === c);
  for (const [c, def] of [['imagens', "TEXT NOT NULL DEFAULT '[]'"], ['horario', "TEXT NOT NULL DEFAULT ''"], ['ig_id', "TEXT NOT NULL DEFAULT ''"], ['permalink', "TEXT NOT NULL DEFAULT ''"],
    ['insights', "TEXT NOT NULL DEFAULT '{}'"], ['postado_em', 'INTEGER'], ['erro', "TEXT NOT NULL DEFAULT ''"]]) if (!tem(c)) db.exec(`ALTER TABLE mkt_pecas ADD COLUMN ${c} ${def}`); }

// Horários de publicação (Brasília). O feed das 11:30 pode sair até as 13:00 se a peça for aprovada depois.
const HOR0 = { feed: ['11:30', '18:00', '20:00'], stories: ['08:30', '10:00', '12:00', '16:00', '19:00', '21:00'], janela_min: 90 };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
function horarios() { try { const o = JSON.parse(getSetting('mkt_horarios') || 'null'); if (o && Array.isArray(o.feed) && Array.isArray(o.stories) && o.feed.length && o.stories.length && [...o.feed, ...o.stories].every(x => HHMM.test(x))) return { feed: o.feed.slice(0, 3).sort(), stories: o.stories.slice(0, 6).sort(), janela_min: HOR0.janela_min }; } catch (e) { /* padrão */ } return HOR0; }
// Espalha as n peças do dia pelos horários do canal (2 stories em 6 horários = primeiro e último)
function horarioDe(slot, total) {
  const h = horarios(), canal = slot.startsWith('story') ? 'stories' : 'feed', l = h[canal], i = Number(slot.slice(-1)) - 1;
  if (canal === 'feed' || total >= l.length || total <= 1) return l[Math.min(i, l.length - 1)];
  return l[Math.round((i * (l.length - 1)) / (total - 1))];
}

const ler = r => r && { ...r, slides: JSON.parse(r.slides || '[]'), revisao: JSON.parse(r.revisao || '{}'), imagens: JSON.parse(r.imagens || '[]'), insights: JSON.parse(r.insights || '{}') };
const peca = id => ler(db.prepare('SELECT * FROM mkt_pecas WHERE id = ?').get(id));
const erro = (msg, status = 400) => { const e = new Error(msg); e.status = status; return e; };
const TAM = { feed: [1080, 1350], stories: [1080, 1920] };

// O CEO envia a imagem gerada no ChatGPT: cortamos na proporção do Instagram (4:5 no feed, 9:16 nos stories) e gravamos em JPEG.
async function anexar(id, i, dataUrl) {
  const p = peca(id);
  if (!p) throw erro('Peça não encontrada.', 404);
  if (p.status === 'postado') throw erro('Esta peça já foi publicada.');
  if (!Number.isInteger(i) || i < 0 || i >= p.slides.length) throw erro('Imagem fora da sequência desta peça.');
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw erro('Envie uma imagem JPG, PNG ou WebP.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 1000 || buf.length > 10 * 1024 * 1024) throw erro('Imagem vazia ou acima de 10 MB.');
  const [w, h] = TAM[p.canal];
  let jpg; try { jpg = await require('sharp')(buf).rotate().resize(w, h, { fit: 'cover', position: 'centre' }).flatten({ background: '#000000' }).jpeg({ quality: 90, mozjpeg: true }).toBuffer(); }
  catch (e) { throw erro('Não consegui ler esta imagem. Baixe de novo do ChatGPT e envie o arquivo original.'); }
  const nome = `p${p.id}-${i + 1}-${crypto.randomBytes(6).toString('hex')}.jpg`;
  fs.writeFileSync(path.join(pasta, nome), jpg);
  const imgs = p.imagens.slice(); while (imgs.length < p.slides.length) imgs.push(null);
  if (imgs[i] && imgs[i].arquivo) fs.unlink(path.join(pasta, path.basename(imgs[i].arquivo)), () => {});
  imgs[i] = { arquivo: nome, url: '/media/mkt/' + nome, em: Date.now() };
  // Se a peça já estava programada e a imagem mudou, continua programada com a imagem nova
  db.prepare("UPDATE mkt_pecas SET imagens = ?, erro = '' WHERE id = ?").run(JSON.stringify(imgs), p.id);
  // Cópia do original no banco de artes do NexTap (não impede nada se o NexTap estiver fora)
  require('./nextap.js').artes('POST', '', { data: dataUrl, titulo: `${p.titulo} · ${i + 1}/${p.slides.length}${p.canal === 'stories' ? ' · story' : ''}`.slice(0, 80), destino: 'marketing', prompt: p.slides[i].prompt, origem: 'chatgpt' }).catch(() => {});
  return peca(p.id);
}
const completa = p => p.imagens.length >= p.slides.length && p.imagens.slice(0, p.slides.length).every(x => x && x.arquivo);

// Aprovação do CEO: com todas as imagens no lugar, a peça entra na fila do Renan com horário marcado
function aprovar(id, { legenda, horario } = {}, t0 = Date.now()) {
  const p = peca(id);
  if (!p) throw erro('Peça não encontrada.', 404);
  if (p.status === 'postado') throw erro('Esta peça já foi publicada.');
  if (!completa(p)) throw erro(`Faltam imagens: envie as ${p.slides.length} antes de aprovar.`);
  if (horario !== undefined && horario !== '' && !HHMM.test(horario)) throw erro('Horário inválido. Use HH:MM.');
  const total = db.prepare('SELECT COUNT(*) AS n FROM mkt_pecas WHERE dia = ? AND canal = ?').get(p.dia, p.canal).n;
  const h = horario || p.horario || horarioDe(p.slot, total);
  db.prepare("UPDATE mkt_pecas SET status = 'programado', horario = ?, legenda = ?, erro = '' WHERE id = ?").run(h, typeof legenda === 'string' ? legenda.slice(0, 2200) : p.legenda, p.id);
  require('./predio.js').registrar('social', `Programado: ${p.titulo}`, `${p.canal === 'feed' ? 'Feed' : 'Stories'} de ${p.dia.slice(8)}/${p.dia.slice(5, 7)} às ${h}.`, { id: p.id }, t0);
  return peca(p.id);
}

const baseUrl = () => String(getSetting('public_url') || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '')).replace(/\/+$/, '');
let ocupado = false;
async function publicarPeca(id, t0 = Date.now()) {
  const p = peca(id);
  if (!p) throw erro('Peça não encontrada.', 404);
  if (p.status === 'postado') return p;
  if (!completa(p)) throw erro('Faltam imagens nesta peça.');
  const base = baseUrl();
  if (!/^https:\/\//.test(base)) throw erro('Não sei o endereço público do Automazap (https). Confira o domínio no Railway.');
  const P = require('./predio.js'), N = P.nomes();
  try {
    const legenda = p.canal === 'feed' ? p.legenda : '';
    const r = await require('./instagram.js').publicar({ tipo: p.tipo, urls: p.imagens.slice(0, p.slides.length).map(x => base + x.url), legenda });
    db.prepare("UPDATE mkt_pecas SET status = 'postado', ig_id = ?, permalink = ?, postado_em = ?, erro = '' WHERE id = ?").run(r.id, r.permalink, t0, p.id);
    P.registrar('social', `Publicado: ${p.titulo}`, `${p.canal === 'feed' ? (p.tipo === 'carrossel' ? 'Carrossel no feed' : 'Post no feed') : 'Story'} às ${horaStr(t0)}.`, { id: p.id, ig_id: r.id }, t0);
    require('./notificacoes.js').notificar({ tipo: 'resumo', titulo: `📲 ${N.social}: publicado no Instagram`, texto: `${p.canal === 'feed' ? 'Feed' : 'Stories'} · ${p.titulo}`, url: '/#predio' }).catch(() => {});
  } catch (e) {
    const msg = /permission|\(#10\)|\(#200\)|OAuth/i.test(e.message) ? 'O token do Instagram não tem permissão para publicar. Adicione instagram_business_content_publish no app da Meta, gere um token novo e troque IG_ACCESS_TOKEN no Railway.' : e.message;
    db.prepare("UPDATE mkt_pecas SET status = 'erro', erro = ? WHERE id = ?").run(String(msg).slice(0, 400), p.id);
    P.registrar('social', `Falhou: ${p.titulo}`, String(msg).slice(0, 300), { id: p.id }, t0);
    require('./notificacoes.js').notificar({ tipo: 'sistema', titulo: `⚠️ ${N.social}: não consegui publicar`, texto: `${p.titulo}: ${String(msg).slice(0, 120)}`, url: '/#predio', chave: 'pub' + p.id }).catch(() => {});
  }
  return peca(p.id);
}

// Roda a cada minuto: publica o que está programado e já chegou a hora (uma peça por vez, com 20 min entre peças do mesmo canal)
async function tick(t0 = Date.now()) {
  if (ocupado) return 0;
  ocupado = true;
  let feitos = 0;
  try {
    const hoje = dataStr(t0), agora = horaStr(t0);
    db.prepare("UPDATE mkt_pecas SET status = 'erro', erro = 'O dia passou sem publicar. Toque em Publicar agora se ainda quiser postar.' WHERE status = 'programado' AND dia < ?").run(hoje);
    const fila = db.prepare("SELECT id, canal FROM mkt_pecas WHERE status = 'programado' AND dia = ? AND horario <= ? ORDER BY horario, id").all(hoje, agora);
    for (const f of fila) {
      const ult = db.prepare("SELECT MAX(postado_em) AS t FROM mkt_pecas WHERE canal = ? AND status = 'postado'").get(f.canal).t || 0;
      if (t0 - ult < 20 * 60e3) continue;
      const r = await publicarPeca(f.id, t0); if (r.status === 'postado') feitos++;
      break;
    }
    if (t0 - Number(getSetting('mkt_insights_em') || 0) > 3 * 3600e3) { setSetting('mkt_insights_em', String(t0)); await coletarInsights(t0).catch(e => console.error('[SOCIAL] métricas:', e.message)); }
  } finally { ocupado = false; }
  return feitos;
}

// Métricas de cada publicação (feed: até 14 dias; stories: só nas primeiras 24h, depois o Instagram apaga)
async function coletarInsights(t0 = Date.now()) {
  const ig = require('./instagram.js');
  const l = db.prepare("SELECT id, ig_id, canal, postado_em FROM mkt_pecas WHERE status = 'postado' AND ig_id <> '' AND postado_em >= ?").all(t0 - 14 * DIA);
  let n = 0;
  for (const p of l) {
    if (p.canal === 'stories' && t0 - p.postado_em > DIA) continue;
    try { const o = await ig.insights(p.ig_id, p.canal === 'stories'); db.prepare('UPDATE mkt_pecas SET insights = ? WHERE id = ?').run(JSON.stringify({ ...o, em: t0 }), p.id); n++; } catch (e) { if (/permission|\(#10\)|OAuth/i.test(e.message)) { setSetting('mkt_insights_erro', 'O token não tem a permissão instagram_business_manage_insights.'); return n; } }
  }
  if (n) setSetting('mkt_insights_erro', '');
  return n;
}
const engaj = i => (i.likes || 0) + 2 * (i.comments || 0) + 3 * (i.saved || 0) + 3 * (i.shares || 0);
// O que rendeu mais nos últimos 14 dias: melhor post e ranking por tema (para a Lia e a Nina repetirem o que funciona)
function desempenho(t0 = Date.now()) {
  const l = db.prepare("SELECT * FROM mkt_pecas WHERE status = 'postado' AND canal = 'feed' AND postado_em >= ?").all(t0 - 14 * DIA).map(ler).filter(p => p.insights.reach);
  const porPilar = {};
  for (const p of l) { const k = p.pilar || 'Outros'; (porPilar[k] = porPilar[k] || { pilar: k, posts: 0, alcance: 0, engajamento: 0 }); porPilar[k].posts++; porPilar[k].alcance += p.insights.reach; porPilar[k].engajamento += engaj(p.insights); }
  const ranking = Object.values(porPilar).map(x => ({ ...x, taxa: x.alcance ? Math.round((1000 * x.engajamento) / x.alcance) / 10 : 0 })).sort((a, b) => b.taxa - a.taxa);
  const melhor = l.slice().sort((a, b) => engaj(b.insights) - engaj(a.insights))[0];
  const ontem = l.filter(p => p.dia === dataStr(t0 - DIA));
  return { com_dados: l.length, ranking, melhor: melhor ? { titulo: melhor.titulo, tipo: melhor.tipo, pilar: melhor.pilar, alcance: melhor.insights.reach, engajamento: engaj(melhor.insights), permalink: melhor.permalink } : null,
    ontem: { alcance: ontem.reduce((a, p) => a + p.insights.reach, 0), engajamento: ontem.reduce((a, p) => a + engaj(p.insights), 0) }, erro: getSetting('mkt_insights_erro') || '' };
}

function painel(t0 = Date.now()) {
  const hoje = dataStr(t0), pub = p => ({ id: p.id, dia: p.dia, slot: p.slot, canal: p.canal, tipo: p.tipo, titulo: p.titulo, pilar: p.pilar, status: p.status, horario: p.horario, erro: p.erro, permalink: p.permalink, postado_em: p.postado_em, insights: p.insights, manual: p.status === 'postado' && !p.ig_id,
    imagens: p.imagens.map(x => x && x.url), total: p.slides.length });
  const doDia = db.prepare('SELECT * FROM mkt_pecas WHERE dia = ? ORDER BY canal, slot').all(hoje).map(ler);
  const tot = { feed: doDia.filter(p => p.canal === 'feed').length, stories: doDia.filter(p => p.canal === 'stories').length };
  return { horarios: horarios(), ig: require('./instagram.js').configurado().token, base_ok: /^https:\/\//.test(baseUrl()),
    fila: doDia.map(p => ({ ...pub(p), horario: p.horario || horarioDe(p.slot, tot[p.canal]) })).sort((a, b) => a.horario.localeCompare(b.horario)),
    publicados: db.prepare("SELECT * FROM mkt_pecas WHERE status = 'postado' AND postado_em >= ? ORDER BY postado_em DESC LIMIT 30").all(t0 - 7 * DIA).map(ler).map(pub), desempenho: desempenho(t0) };
}
function salvarHorarios(o) {
  const limpa = l => [...new Set((Array.isArray(l) ? l : String(l || '').split(/[,; ]+/)).map(x => String(x).trim()).filter(Boolean))];
  const feed = limpa(o.feed), stories = limpa(o.stories);
  if (!feed.length || !stories.length || feed.length > 3 || stories.length > 6 || ![...feed, ...stories].every(x => HHMM.test(x))) throw erro('Horários inválidos: até 3 no feed e 6 nos stories, no formato HH:MM (ex.: 11:30).');
  setSetting('mkt_horarios', JSON.stringify({ feed: feed.sort(), stories: stories.sort() }));
  return horarios();
}

module.exports = { anexar, aprovar, publicarPeca, tick, coletarInsights, desempenho, painel, horarios, horarioDe, salvarHorarios, completa, ler, pasta };
