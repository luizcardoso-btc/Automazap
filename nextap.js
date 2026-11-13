// Ponte com o sistema NexTap (site de vendas): tabela de preços oficial e avisos de cadastro/pedido/pagamento.
//   Preços: lidos de <site>/api/public/price-tiers e guardados no banco (o robô sempre mostra o que o site cobra, inclusive em promoção).
//   Avisos: o NexTap chama POST /webhook/nextap com o cabeçalho X-Automazap-Secret (variável NEXTAP_WEBHOOK_SECRET nos dois serviços).
const { db, getSetting, setSetting } = require('./db.js');

// Usada só enquanto o site ainda não respondeu (igual à tabela padrão do NexTap)
const PADRAO = { minimo: 5, tiers: [[5, 10, 21.9], [11, 49, 18.9], [50, 99, 17.9], [100, 299, 16.9], [300, 1000000, 15.9]].map(([min_qty, max_qty, unit_price]) => ({ min_qty, max_qty, unit_price })) };

const origemDoSite = () => { try { return new URL(getSetting('site_url') || '').origin; } catch (e) { return ''; } };

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
  const base = process.env.NEXTAP_API_BASE || origemDoSite();
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
  engine.avisar(`${txt}: ${nome}${b.qty ? ` · ${b.qty} placa(s)` : ''}${Number(b.total) > 0 ? ` · R$ ${brl(Number(b.total))}` : ''}`);
  return { ok: true, achou: true, contato: c.id, tag };
}

module.exports = { tabela, minimo, precoUnitario, atualizarPrecos, conta, brl, precoRevenda, urlPedido, receberEvento, PADRAO };
