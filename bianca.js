// Bianca automática (Prospectora): todo dia mapeia empresas novas da cidade e aborda de 10 a 15 pelo WhatsApp, sozinha,
// com a mensagem personalizada da lista do dia. Retornos nos dias 1, 3 e 7. Quem responde passa para você; quem pede para parar não recebe mais nada.
// Proteções do número: só em horário comercial, intervalo aleatório entre envios, limite diário, confere se o número tem WhatsApp.
const { db, getSetting, setSetting } = require('./db.js');

const DIA = 86400e3, FUSO = 3 * 3600e3;
const dataStr = t => new Date(t - FUSO).toISOString().slice(0, 10);
const local = t => new Date(t - FUSO);
const n = (sql, ...a) => db.prepare(sql).get(...a).n;
const ligada = () => getSetting('bianca_auto') === '1';
const meta = () => Math.max(1, Math.min(20, Number(getSetting('bianca_meta')) || 12));
// Seg a sex 09:00–17:30 · sábado 09:00–12:00 · domingo não
function naJanela(t0) { const d = local(t0), w = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes(); return w >= 1 && w <= 5 ? m >= 540 && m < 1050 : w === 6 ? m >= 540 && m < 720 : false; }
const celular = num => /^55\d{2}9\d{8}$/.test(num);
const enviadosHoje = t0 => n("SELECT COUNT(*) AS n FROM agentes_log WHERE agente = 'prospectora' AND titulo LIKE 'Enviado:%' AND criado_em >= ?", Math.floor((t0 - FUSO) / DIA) * DIA + FUSO);
const novosHoje = t0 => n("SELECT COUNT(*) AS n FROM agentes_log WHERE agente = 'prospectora' AND titulo LIKE 'Enviado:%' AND json_extract(dados, '$.passo') = 'd0' AND criado_em >= ?", Math.floor((t0 - FUSO) / DIA) * DIA + FUSO);
const estoque = () => db.prepare("SELECT telefone FROM prospects WHERE status = 'novo' AND telefone <> ''").all().filter(p => celular(require('./whatsapp.js').normalizarNumero(p.telefone))).length;

// Nichos que mais compram placa de avaliação, em rodízio (um por mapeamento)
const RODIZIO = ['barbearia', 'salao', 'restaurante', 'estetica', 'dentista', 'pet', 'lanchonete', 'academia', 'clinica', 'pizzaria', 'oficina', 'otica', 'tatuagem', 'padaria', 'lavajato', 'bar', 'roupa', 'celular', 'farmacia', 'hotel'];
// Mapeia um nicho na cidade (Google se houver chave: traz nota e avaliações; senão o mapa livre) e guarda as empresas novas com telefone.
async function mapear(t0 = Date.now()) {
  const P = require('./prospeccao.js')._t, W = require('./whatsapp.js'), cidade = getSetting('cidade') || 'Feira de Santana';
  const i = Number(getSetting('bianca_nicho_i') || 0) % RODIZIO.length, nicho = P.NICHOS.find(x => x.id === RODIZIO[i]) || P.NICHOS[0];
  setSetting('bianca_nicho_i', String(i + 1));
  let achados = [], fonte = 'mapa livre';
  if (process.env.GOOGLE_PLACES_API_KEY) {
    fonte = 'Google';
    const j = await P.google('/v1/places:searchText', { metodo: 'POST', mascara: P.CAMPOS, corpo: { textQuery: `${nicho.nome} em ${cidade}`, languageCode: 'pt-BR', regionCode: 'BR', pageSize: 20 } });
    achados = (j.places || []).map(P.normalizar).filter(p => p.aberto).map(p => ({ ...p, segmento: nicho.nome }));
  } else {
    const centro = await P.geocodificar(cidade + ', Brasil');
    if (!centro) throw new Error('Não achei a cidade "' + cidade + '" no mapa. Confira em Configurações → Prédio.');
    achados = await P.acharNicho(nicho, centro, 12000, cidade);
  }
  const tem = db.prepare('SELECT 1 FROM prospects WHERE place_id = ?'), tels = new Set(db.prepare("SELECT telefone FROM prospects WHERE telefone <> ''").all().map(p => W.normalizarNumero(p.telefone)).filter(Boolean));
  const ins = db.prepare(`INSERT INTO prospects (place_id, nome, segmento, telefone, instagram, endereco, bairro, nota, avaliacoes, site, maps_url, lat, lng, origem)
    VALUES (@place_id, @nome, @segmento, @telefone, @instagram, @endereco, @bairro, @nota, @avaliacoes, @site, @maps_url, @lat, @lng, 'bianca')`);
  let novos = 0, comCel = 0;
  db.transaction(() => {
    for (const x of achados) {
      const num = W.normalizarNumero(x.telefone);
      if (!x.nome || !x.place_id || !num || tem.get(x.place_id) || tels.has(num)) continue;   // sem telefone não serve para o WhatsApp
      tels.add(num);
      ins.run({ place_id: String(x.place_id).slice(0, 120), nome: String(x.nome).slice(0, 120), segmento: nicho.nome.slice(0, 40), telefone: String(x.telefone).slice(0, 25), instagram: String(x.instagram || '').slice(0, 60), endereco: String(x.endereco || '').slice(0, 200),
        bairro: String(x.bairro || '').slice(0, 60), nota: x.nota == null ? null : Number(x.nota), avaliacoes: Math.max(0, Math.floor(Number(x.avaliacoes) || 0)), site: String(x.site || '').slice(0, 200), maps_url: String(x.maps_url || '').slice(0, 300), lat: x.lat == null ? null : Number(x.lat), lng: x.lng == null ? null : Number(x.lng) });
      novos++; if (celular(num)) comCel++;
    }
  })();
  require('./predio.js').registrar('prospectora', `Mapeamento: ${nicho.nome}`, `${achados.length} empresa(s) encontradas no ${fonte}, ${novos} nova(s) com telefone (${comCel} com celular).`, { nicho: nicho.id, novos, comCel }, t0);
  return { nicho: nicho.nome, fonte, encontradas: achados.length, novos, comCel };
}

const PARAR = /\b(n[aã]o (tenho|temos|h[aá]) interesse|sem interesse|n[aã]o quero|n[aã]o me (mande|envie|chame)|pare|para de|parar|me tir[ae]|remov|descadastr|stop|spam|bloque)/i;
// A empresa respondeu: os retornos automáticos param. Pedido de parar encerra de vez; qualquer outra resposta vira "interessado" e avisa você.
function respondeu(prospectId, texto, contato) {
  const p = db.prepare('SELECT * FROM prospects WHERE id = ?').get(prospectId);
  if (!p || ['fechado', 'perdido'].includes(p.status)) return null;
  const parar = PARAR.test(String(texto || ''));
  db.prepare("UPDATE prospects SET status = ?, prox_contato = NULL, motivo_perda = ?, atualizado_em = datetime('now') WHERE id = ?").run(parar ? 'perdido' : (['novo', 'abordado'].includes(p.status) ? 'interessado' : p.status), parar ? 'Pediu para não receber mensagens' : '', p.id);
  if (!parar && ligada()) {
    const N = require('./predio.js').nomes();
    require('./whatsapp.js').avisarDono(`🔥 *${N.prospectora}: ${p.nome} respondeu*\n\n"${String(texto).slice(0, 300)}"\n\nA conversa agora é sua: abra o WhatsApp do painel e use o roteiro (Meio e Fechamento) da ficha.`).catch(() => {});
  }
  return { parar };
}

let ocupada = false;
// Roda a cada minuto. Um envio por vez, com intervalo sorteado de 5 a 14 minutos.
async function tick(t0 = Date.now(), { sorteio = Math.random } = {}) {
  if (ocupada || !ligada()) return { enviado: false, motivo: 'desligada' };
  const W = require('./whatsapp.js'), P = require('./predio.js');
  if (!W.configurado()) return { enviado: false, motivo: 'whatsapp' };
  ocupada = true;
  try {
    const hoje = dataStr(t0);
    // 1) Mapeamento: uma vez por dia (e de novo se o estoque de empresas com celular estiver baixo), a partir das 7h
    if (local(t0).getUTCHours() >= 7 && estoque() < meta() * 2 && Number(getSetting('bianca_mapeou_n_' + hoje) || 0) < 3 && t0 - Number(getSetting('bianca_mapeou_em') || 0) > 20 * 60e3) {
      setSetting('bianca_mapeou_em', String(t0)); setSetting('bianca_mapeou_n_' + hoje, String(Number(getSetting('bianca_mapeou_n_' + hoje) || 0) + 1));
      try { await mapear(t0); } catch (e) { P.registrar('prospectora', 'Mapeamento falhou', String(e.message).slice(0, 300), {}, t0); }
    }
    if (!naJanela(t0)) return { enviado: false, motivo: 'fora do horário' };
    if (t0 < Number(getSetting('bianca_prox') || 0)) return { enviado: false, motivo: 'intervalo' };
    if (enviadosHoje(t0) >= meta() * 2) return { enviado: false, motivo: 'limite do dia' };
    // 2) Próximo da lista de hoje (retornos primeiro, depois as empresas novas de maior oportunidade)
    let lista = P.listaDeHoje(t0) || P.montarLista(t0);
    let item = lista.itens.find(i => !i.feito && !i.pulado && (i.tipo === 'retorno' || novosHoje(t0) < meta()));
    if (!item && novosHoje(t0) < meta() && Number(getSetting('bianca_remontou_' + hoje) || 0) < 4) {   // lista acabou antes da meta: monta de novo com o que foi mapeado
      setSetting('bianca_remontou_' + hoje, String(Number(getSetting('bianca_remontou_' + hoje) || 0) + 1));
      lista = P.montarLista(t0); item = lista.itens.find(i => !i.feito && !i.pulado && (i.tipo === 'retorno' || novosHoje(t0) < meta()));
    }
    if (!item) return { enviado: false, motivo: 'lista vazia' };
    const marcar = campos => { const l = P.listaDeHoje(t0); if (l) { l.itens.forEach(i => { if (i.id === item.id) Object.assign(i, campos); }); db.prepare('UPDATE agentes_log SET dados = ? WHERE id = ?').run(JSON.stringify({ dia: l.dia, itens: l.itens }), l.id); } };
    const p = db.prepare('SELECT * FROM prospects WHERE id = ?').get(item.id), num = p && W.normalizarNumero(p.telefone);
    if (!p || !num || ['fechado', 'perdido'].includes(p.status)) { marcar({ pulado: 'sem telefone válido' }); return { enviado: false, motivo: 'pulado' }; }
    // 3) Só manda para quem tem WhatsApp (fixo sem WhatsApp Business é pulado e anotado)
    const tem = await W.temWhatsapp(num);
    if ((tem && !tem.existe) || (!tem && !celular(num))) {
      marcar({ pulado: 'número sem WhatsApp' });
      db.prepare("INSERT INTO prospect_hist (prospect_id, tipo, texto, criado_em) VALUES (?, 'nota', ?, ?)").run(p.id, 'Número sem WhatsApp: a abordagem automática pulou. Tente ligação ou visita.', new Date(t0).toISOString().replace('T', ' ').slice(0, 19));
      db.prepare("UPDATE prospects SET obs = CASE WHEN obs LIKE '%sem WhatsApp%' THEN obs ELSE trim(obs || ' [sem WhatsApp]') END, status = CASE WHEN status = 'novo' THEN 'abordado' ELSE status END, prox_contato = NULL WHERE id = ?").run(p.id);
      return { enviado: false, motivo: 'sem whatsapp' };
    }
    const texto = item.passo === 'd0' ? item.mensagem + '\n\n(Se não fizer sentido para vocês, é só me avisar que eu não escrevo mais.)' : item.mensagem;
    try { await W.enviarNumero(num, texto, 'bianca'); }
    catch (e) {
      if (e.limite) { setSetting('bianca_prox', String(t0 + 3 * 3600e3)); return { enviado: false, motivo: 'limite do whatsapp' }; }
      marcar({ pulado: 'erro no envio' }); P.registrar('prospectora', `Falhou: ${p.nome}`, String(e.message).slice(0, 300), { id: p.id }, t0);
      setSetting('bianca_prox', String(t0 + 10 * 60e3)); return { enviado: false, motivo: 'erro' };
    }
    P.contatoFeito(p.id, t0);
    P.registrar('prospectora', `Enviado: ${p.nome}`, item.tipo === 'retorno' ? 'Retorno automático pelo WhatsApp.' : 'Primeira abordagem pelo WhatsApp.', { id: p.id, passo: item.passo }, t0);
    setSetting('bianca_prox', String(t0 + Math.round((5 + sorteio() * 9) * 60e3)));
    return { enviado: true, id: p.id, passo: item.passo };
  } finally { ocupada = false; }
}

function painel(t0 = Date.now()) {
  const W = require('./whatsapp.js'), prox = Number(getSetting('bianca_prox') || 0), ini = Math.floor((t0 - FUSO) / DIA) * DIA + FUSO;
  return { ligada: ligada(), meta: meta(), whatsapp: W.configurado(), enviados_hoje: enviadosHoje(t0), novos_hoje: novosHoje(t0), estoque: estoque(), na_janela: naJanela(t0),
    proximo: ligada() && naJanela(t0) && prox > t0 ? new Date(prox - FUSO).toISOString().slice(11, 16) : '',
    respostas_hoje: n("SELECT COUNT(*) AS n FROM prospect_hist WHERE tipo = 'whatsapp' AND texto LIKE 'Respondeu no WhatsApp:%' AND criado_em >= ?", new Date(ini).toISOString().replace('T', ' ').slice(0, 19)),
    mapeadas_hoje: db.prepare("SELECT COALESCE(SUM(json_extract(dados, '$.novos')), 0) AS n FROM agentes_log WHERE agente = 'prospectora' AND titulo LIKE 'Mapeamento:%' AND criado_em >= ?").get(ini).n,
    google: !!process.env.GOOGLE_PLACES_API_KEY };
}

module.exports = { tick, mapear, respondeu, painel, naJanela, celular, ligada, meta };
