// Ponte com o sistema NexTap (site de vendas): tabela de preços oficial e avisos de cadastro/pedido/pagamento.
//   Preços: lidos de <site>/api/public/price-tiers e guardados no banco (o robô sempre mostra o que o site cobra, inclusive em promoção).
//   Avisos: o NexTap chama POST /webhook/nextap com o cabeçalho X-Automazap-Secret (variável NEXTAP_WEBHOOK_SECRET nos dois serviços).
const { db, getSetting, setSetting } = require('./db.js');

// Usada só enquanto o site ainda não respondeu (igual à tabela padrão do NexTap)
const PADRAO = { minimo: 5, tiers: [[5, 10, 21.9], [11, 49, 18.9], [50, 99, 17.9], [100, 299, 16.9], [300, 1000000, 15.9]].map(([min_qty, max_qty, unit_price]) => ({ min_qty, max_qty, unit_price })) };

const origemDoSite = () => { try { return new URL(getSetting('site_url') || '').origin; } catch (e) { return ''; } };
// Segredo e endereço do NexTap: da variável do Railway OU da conexão automática (botão "Conectar ao NexTap")
const segredo = () => process.env.NEXTAP_WEBHOOK_SECRET || getSetting('nextap_segredo') || '';
const baseNx = () => (process.env.NEXTAP_API_BASE || getSetting('nextap_base') || origemDoSite() || '').replace(/\/+$/, '');
const conectado = () => segredo().length >= 16 && !!baseNx();

function tabela() {
  try { const j = JSON.parse(getSetting('nextap_precos') || 'null'); if (j && Array.isArray(j.tiers) && j.tiers.length) return j; } catch (e) { /* usa a padrão */ }
  return PADRAO;
}
const minimo = () => tabela().minimo || tabela().tiers[0].min_qty || 1;
// Mesma regra do checkout do site: acima da última faixa vale a última; abaixo da primeira, a primeira
function precoUnitario(qtd) {
  const t = tabela().tiers, f = t.find(x => qtd >= x.min_qty && qtd <= x.max_qty);
  return f ? f.unit_price : qtd > t[t.length - 1].max_qty ? t[t.length - 1].unit_price : t[0].unit_price;
}

async function atualizarPrecos() {
  const base = baseNx();
  if (!base) return null;
  const r = await fetch(base.replace(/\/+$/, '') + '/api/public/price-tiers', { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('NexTap respondeu ' + r.status + ' na tabela de preços');
  const j = await r.json();
  const tiers = (Array.isArray(j.tiers) ? j.tiers : []).map(t => ({ min_qty: Number(t.min_qty), max_qty: Number(t.max_qty), unit_price: Number(t.unit_price) }))
    .filter(t => Number.isInteger(t.min_qty) && t.min_qty >= 1 && t.max_qty >= t.min_qty && t.unit_price > 0).sort((a, b) => a.min_qty - b.min_qty);
  if (!tiers.length) throw new Error('Tabela de preços do NexTap veio vazia');
  const nova = { tiers, minimo: Number(j.minimo) || tiers[0].min_qty, em: Date.now() };
  setSetting('nextap_precos', JSON.stringify(nova));
  return nova;
}

// Promoção do site (ex.: Black NexTap): lida de /api/public/promocao junto com os preços. As mensagens só falam dela
// enquanto está ativa no site e até a data de fim; depois disso as linhas somem sozinhas.
async function atualizarPromo() {
  const base = baseNx();
  if (!base) return null;
  const r = await fetch(base.replace(/\/+$/, '') + '/api/public/promocao', { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('NexTap respondeu ' + r.status + ' na promoção');
  const j = await r.json();
  const p = j && j.ativa && Date.parse(j.fim) ? { nome: String(j.nome || 'Promoção').slice(0, 40), fim: j.fim, a_partir: Number(j.a_partir) || null,
    minimo_a_partir: Number(j.minimo_a_partir) || null, normais: (Array.isArray(j.normais) ? j.normais : []).map(t => ({ min_qty: Number(t.min_qty), max_qty: Number(t.max_qty), unit_price: Number(t.unit_price) })) } : null;
  setSetting('nextap_promo', JSON.stringify(p));
  return p;
}
function promo(agoraMs = Date.now()) {
  try { const p = JSON.parse(getSetting('nextap_promo') || 'null'); return p && Date.parse(p.fim) > agoraMs ? p : null; } catch (e) { return null; }
}
const DIA = 86400e3, FUSO = 3 * 3600e3, dia0 = t => Math.floor((t - FUSO) / DIA) * DIA + FUSO;
const dataBR = iso => new Date(Date.parse(iso) - FUSO).toISOString().slice(5, 10).split('-').reverse().join('/');
// Preço normal (fora da promoção) da quantidade, pela tabela que o site guardou antes da promoção começar
function precoNormal(qtd, p) {
  const t = (p && p.normais) || [];
  if (!t.length) return null;
  const f = t.find(x => qtd >= x.min_qty && qtd <= x.max_qty);
  return f ? f.unit_price : qtd > t[t.length - 1].max_qty ? t[t.length - 1].unit_price : t[0].unit_price;
}
// Linhas da promoção usadas nas mensagens ({{black}}, {{preco_de_por}}, {{black_oferta}}, {{black_final}}). Sem promoção: '' (ou só o preço).
function textoPromo(v, qtd, agoraMs = Date.now()) {
  const p = promo(agoraMs), unit = precoUnitario(qtd);
  if (v === 'preco_de_por') { const de = p && precoNormal(qtd, p); return de && de > unit ? `de R$ ${brl(de)} por R$ ${brl(unit)}` : `R$ ${brl(unit)}`; }
  if (!p) return '';
  const fim = Date.parse(p.fim), ate = dataBR(p.fim), dias = Math.round((dia0(fim) - dia0(agoraMs)) / DIA);
  const quando = dias <= 0 ? 'termina hoje' : dias === 1 ? 'termina amanhã' : `termina em ${dias} dias (${ate})`;
  const ultimas = fim - agoraMs < 48 * 3600e3;
  if (v === 'black') return p.a_partir ? `🖤 ${p.nome}: placas a partir de R$ ${brl(p.a_partir)}${p.minimo_a_partir > 1 ? ` (pedidos de ${p.minimo_a_partir} ou mais)` : ''}, até ${ate}.\n\n` : `🖤 ${p.nome} até ${ate}.\n\n`;
  if (v === 'black_oferta') return ultimas ? `\n\n⏰ Últimas horas da ${p.nome}: o preço promocional ${quando}.` : `\n\n🖤 Preço da ${p.nome}, válido até ${ate}.`;
  if (v === 'black_final') return `${ultimas ? '⏰ Últimas horas: a' : '🖤 A'} ${p.nome} ${quando}. Depois disso, o preço volta ao normal.\n\n`;
  return '';
}

// Financeiro do NexTap (somente leitura): o mesmo contador do admin, protegido pelo segredo da integração
async function atualizarFinanceiro() {
  const base = baseNx(), seg = segredo();
  if (!base || seg.length < 16) return null;
  const r = await fetch(base.replace(/\/+$/, '') + '/api/integracao/financeiro', { headers: { 'X-Automazap-Secret': seg }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) { setSetting('nextap_fin_erro', r.status === 401 ? 'A conexão com o NexTap mudou: toque em "Conectar ao NexTap" de novo.' : 'O NexTap respondeu ' + r.status + '.'); throw new Error('NexTap respondeu ' + r.status + ' no financeiro'); }
  const j = await r.json();
  setSetting('nextap_fin', JSON.stringify({ ...j, recebido_em: Date.now() })); setSetting('nextap_fin_erro', '');
  try { require('./predio.js').controller(j); } catch (e) { console.error('[CONTROLLER]', e.message); }
  return j;
}
// Banco de artes do NexTap (Theo): o Automazap só repassa, com o segredo da integração
async function artes(metodo, caminho, corpo) {
  const base = baseNx(), seg = segredo();
  if (!base || seg.length < 16) { const e = new Error('O Automazap ainda não está conectado ao NexTap. Toque em "Conectar ao NexTap".'); e.status = 400; throw e; }
  const r = await fetch(base + '/api/integracao/artes' + caminho, { method: metodo, headers: { 'X-Automazap-Secret': seg, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(200000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || (r.status === 401 ? 'A conexão com o NexTap mudou: toque em "Conectar ao NexTap" de novo.' : 'O NexTap respondeu ' + r.status + '.')); e.status = r.status === 401 ? 502 : r.status; throw e; }
  return { ...j, base };
}
function financeiro() { try { return JSON.parse(getSetting('nextap_fin') || 'null'); } catch (e) { return null; } }
const adminNextap = () => (baseNx() || '') + '/admin/';

const brl = n => (Math.round(n * 100) / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const precoRevenda = () => { const v = parseFloat(String(getSetting('preco_revenda') || '').replace(/\./g, '').replace(',', '.')); return v > 0 ? v : 80; };
// Conta mostrada na conversa: custo das placas e quanto a pessoa faz revendendo (o frete entra só no checkout)
function conta(qtd) {
  const c = n => Math.round(n * 100) / 100;
  const unit = precoUnitario(qtd), total = c(unit * qtd), receita = c(precoRevenda() * qtd);
  return { qtd, unit, total, receita, lucro: c(receita - total) };
}

// Página do site que já abre o pedido com a quantidade escolhida. __LEAD__ vira o token do link no redirecionamento (/go/<token>).
function urlPedido(qtd) {
  const base = origemDoSite() || (getSetting('site_url') || '').replace(/\/+$/, '');
  return `${base}/revendedor/?tab=registro&qtd=${qtd}&lead=__LEAD__&utm_source=instagram&utm_medium=dm&utm_campaign=nextap_bot`;
}

// Aviso vindo do NexTap. "lead" é o token do link que a pessoa clicou; devolve o contato atualizado (ou null se não achou).
const EVENTOS = { cadastro: 'CADASTROU', pedido: 'INICIOU PEDIDO', pago: 'VENDA' };
function receberEvento(b) {
  b = b || {};
  const tag = EVENTOS[b.evento];
  if (!tag) return { erro: 'Evento desconhecido.' };
  const l = db.prepare('SELECT contact_id FROM links WHERE token = ?').get(String(b.lead || ''));
  if (!l) return { ok: true, achou: false };
  const engine = require('./engine.js');
  engine.addTag(l.contact_id, tag);
  if (b.evento === 'pago') {
    const total = Number(b.total) > 0 ? Number(b.total) : null;
    db.prepare('UPDATE contacts SET venda_total = COALESCE(?, venda_total), venda_em = ?, needs_human = 0, human_priority = 0 WHERE id = ?').run(total, Date.now(), l.contact_id);
    engine.addTag(l.contact_id, 'ABRIU CHECKOUT');
  }
  const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(l.contact_id);
  const nome = [c.name, c.username ? '@' + c.username : ''].filter(Boolean).join(' ') || 'contato ' + c.id;
  const txt = { cadastro: '📝 Lead do robô criou conta no site', pedido: '🛒 Lead do robô iniciou um pedido', pago: '💰 VENDA paga' }[b.evento];
  engine.avisar(`${b.qty ? `${b.qty} placa(s)` : ''}${Number(b.total) > 0 ? ` · R$ ${brl(Number(b.total))}` : ''}`.replace(/^ · /, ''), {
    tipo: b.evento === 'pago' ? 'venda' : 'site', titulo: `${txt}: ${nome}`, url: '/#c=' + c.id, chave: b.evento + c.id });
  return { ok: true, achou: true, contato: c.id, tag };
}

module.exports = { segredo, baseNx, conectado, artes, atualizarFinanceiro, financeiro, adminNextap, atualizarPromo, promo, textoPromo, precoNormal, tabela, minimo, precoUnitario, atualizarPrecos, conta, brl, precoRevenda, urlPedido, receberEvento, PADRAO };
