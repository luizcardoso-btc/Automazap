// Motor financeiro da NexTap: estoque, lucro estimado (já descontando todos os custos), alertas do "contador" e análise por IA.
const db = require('./database.js');

const PAGOS = "('pago','em_producao','enviado','entregue')";
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const pct = (a, b) => (b ? r2((a / b) * 100) : 0);
const hojeBR = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bahia' }); // AAAA-MM-DD
const sqlUtc = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const um = (sql, ...p) => db.prepare(sql).get(...p);

// ---------- estoque ----------
// em_maos = tudo que entrou − saídas por ajuste − placas já enviadas; disponivel = em_maos − placas de pedidos pagos ainda não enviados
function estoque() {
  const entradas = um('SELECT COALESCE(SUM(quantidade),0) n FROM estoque_mov WHERE quantidade > 0').n;
  const saidasAjuste = -um('SELECT COALESCE(SUM(quantidade),0) n FROM estoque_mov WHERE quantidade < 0').n;
  const enviadas = um("SELECT COALESCE(SUM(qty_azul+qty_preta),0) n FROM orders WHERE status IN ('enviado','entregue')").n;
  const comprometido = um("SELECT COALESCE(SUM(qty_azul+qty_preta),0) n FROM orders WHERE status IN ('pago','em_producao')").n;
  const comprado = um("SELECT COALESCE(SUM(quantidade),0) n FROM estoque_mov WHERE tipo='compra'").n;
  const investido = r2(um("SELECT COALESCE(SUM(quantidade*COALESCE(custo_unit,0) + custo_extra),0) n FROM estoque_mov WHERE tipo='compra'").n);
  const emMaos = entradas - saidasAjuste - enviadas;
  const custoMedio = comprado > 0 ? r2(investido / comprado) : null;
  return { em_maos: emMaos, comprometido, disponivel: emMaos - comprometido, comprado, investido, custo_medio: custoMedio,
    minimo: db.cfg('estoque_minimo', 50) };
}

function custoDaPlaca() {
  const medio = estoque().custo_medio;
  return db.cfg('custo_usar_medio', 0) === 1 && medio ? medio : db.cfg('custo_placa', 13.5);
}

// ---------- período ----------
function janela(periodo) {
  const agora = Date.now(), hoje = hojeBR();
  const meia = d => new Date(d + 'T03:00:00Z').getTime(); // meia-noite de Brasília (UTC−3) em UTC
  let ini = null, rotulo = 'Todo o período';
  if (periodo === 'today') { ini = meia(hoje); rotulo = 'Hoje'; }
  else if (periodo === 'month') { ini = meia(hoje.slice(0, 8) + '01'); rotulo = 'Este mês'; }
  else if (['7', '30', '90'].includes(String(periodo))) { ini = agora - Number(periodo) * 864e5; rotulo = `Últimos ${periodo} dias`; }
  return { ini: ini === null ? null : sqlUtc(ini), fim: sqlUtc(agora + 1000), iniMs: ini, fimMs: agora, rotulo, hoje };
}

// ---------- custos de UM pedido ----------
function custosDoPedido(o, cfg) {
  const qty = o.qty_azul + o.qty_preta;
  const frete = o.shipping_fee || 0;
  const recPlacas = r2(o.total - frete);
  const custoPlacas = qty * cfg.custoPlaca;
  const icms = (recPlacas + (cfg.icmsBaseFrete ? frete : 0)) * cfg.icmsPct / 100;
  const taxaReal = o.mp_fee !== null && o.mp_fee !== undefined;
  let taxa = 0;
  if (taxaReal) taxa = o.mp_fee;
  else if (!o.paid_manually) taxa = o.total * (o.payment_method === 'pix' ? cfg.taxaPix : o.payment_method === 'credit_card' ? cfg.taxaCartao : 0) / 100;
  const envioReal = o.custo_frete_real !== null && o.custo_frete_real !== undefined;
  const envio = envioReal ? o.custo_frete_real : cfg.envioPadrao;
  const lucro = o.total - custoPlacas - icms - taxa - envio;
  return { qty, frete, recPlacas, custoPlacas, icms, taxa, taxaReal, envio, envioReal, lucro };
}

function configuracao() {
  return { custoPlaca: custoDaPlaca(), icmsPct: db.cfg('icms_pct', 1), icmsBaseFrete: db.cfg('icms_base_frete', 1) === 1,
    taxaPix: db.cfg('taxa_pix_pct', 0.99), taxaCartao: db.cfg('taxa_cartao_pct', 4.98), envioPadrao: db.cfg('custo_envio_padrao', 0) };
}

// ---------- despesas (únicas e mensais rateadas por dia) ----------
function despesasDoPeriodo(j, primeiraData) {
  const iniData = j.iniMs === null ? (primeiraData || j.hoje) : new Date(j.iniMs - 3 * 3600e3).toISOString().slice(0, 10);
  const fimData = j.hoje;
  const dias = Math.max(1, Math.round((new Date(fimData + 'T12:00:00Z') - new Date(iniData + 'T12:00:00Z')) / 864e5) + 1);
  let total = 0; const itens = [];
  for (const d of db.prepare('SELECT * FROM despesas ORDER BY data DESC').all()) {
    let v = 0;
    if (!d.mensal) { if (d.data >= iniData && d.data <= fimData) v = d.valor; }
    else {
      const de = d.data > iniData ? d.data : iniData;
      if (de <= fimData) { const dd = Math.round((new Date(fimData + 'T12:00:00Z') - new Date(de + 'T12:00:00Z')) / 864e5) + 1; v = d.valor * dd / 30.4375; }
    }
    if (v > 0) { total += v; itens.push({ id: d.id, descricao: d.descricao, categoria: d.categoria, mensal: !!d.mensal, valor_periodo: r2(v) }); }
  }
  return { total: r2(total), itens, dias, iniData, fimData };
}

// ---------- o cálculo principal ----------
function lucro(periodo) {
  const j = janela(periodo), cfg = configuracao(), est = estoque();
  const pedidos = db.prepare(`SELECT * FROM orders WHERE status IN ${PAGOS}
      AND COALESCE(paid_at, created_at) <= ? ${j.ini ? 'AND COALESCE(paid_at, created_at) >= ?' : ''} ORDER BY id`).all(...(j.ini ? [j.fim, j.ini] : [j.fim]));
  const T = { pedidos: pedidos.length, placas: 0, receita_placas: 0, frete_cobrado: 0, receita_bruta: 0, custo_placas: 0, icms: 0, taxas_mp: 0, custo_envio: 0,
    taxas_reais: 0, taxas_estimadas: 0, envio_real: 0, envio_estimado: 0, card_valor: 0 };
  const lista = [];
  for (const o of pedidos) {
    const c = custosDoPedido(o, cfg);
    T.placas += c.qty; T.receita_placas += c.recPlacas; T.frete_cobrado += c.frete; T.receita_bruta += o.total; T.custo_placas += c.custoPlacas;
    T.icms += c.icms; T.taxas_mp += c.taxa; T.custo_envio += c.envio;
    c.taxaReal ? T.taxas_reais++ : T.taxas_estimadas++; c.envioReal ? T.envio_real++ : T.envio_estimado++;
    if (o.payment_method === 'credit_card') T.card_valor += o.total;
    lista.push({ id: o.id, total: o.total, qty: c.qty, frete_cobrado: c.frete, custo_envio: r2(c.envio), envio_real: c.envioReal, lucro: r2(c.lucro) });
  }
  const primeira = pedidos.length ? new Date(String(pedidos[0].paid_at || pedidos[0].created_at).replace(' ', 'T') + 'Z').toISOString().slice(0, 10) : null;
  const desp = despesasDoPeriodo(j, primeira);
  const lucroBruto = T.receita_bruta - T.custo_placas - T.icms - T.taxas_mp - T.custo_envio;
  const final = lucroBruto - desp.total;

  // a receber (pedidos aguardando pagamento) — quanto sobraria se fossem pagos
  const aw = db.prepare("SELECT * FROM orders WHERE status='aguardando_pagamento' AND created_at >= datetime('now','-14 days')").all();
  let awLucro = 0, awValor = 0;
  for (const o of aw) { awValor += o.total; awLucro += custosDoPedido(o, cfg).lucro; }

  // faixas de preço: quanto sobra em cada faixa (no pedido mínimo da faixa)
  const cardShare = T.receita_bruta ? T.card_valor / T.receita_bruta : 0;
  const taxaMedia = (1 - cardShare) * cfg.taxaPix + cardShare * cfg.taxaCartao;
  const enviosReais = pedidos.filter(o => o.custo_frete_real !== null && o.custo_frete_real !== undefined);
  const envioMedio = enviosReais.length ? enviosReais.reduce((s, o) => s + o.custo_frete_real, 0) / enviosReais.length : cfg.envioPadrao;
  const frete = db.freteFixo();
  const faixas = db.prepare('SELECT * FROM price_tiers ORDER BY min_qty').all().map(t => {
    const q = t.min_qty, rec = q * t.unit_price, total = rec + frete;
    const custos = q * cfg.custoPlaca + (rec + (cfg.icmsBaseFrete ? frete : 0)) * cfg.icmsPct / 100 + total * taxaMedia / 100 + envioMedio;
    const l = total - custos;
    return { de: t.min_qty, ate: t.max_qty >= 1e6 ? null : t.max_qty, preco: t.unit_price, qtd_exemplo: q, lucro_pedido: r2(l), lucro_por_placa: r2(l / q), margem_pct: pct(l, total) };
  });

  const dias = Math.max(1, desp.dias);
  const vendas30 = um("SELECT COALESCE(SUM(qty_azul+qty_preta),0) n FROM orders WHERE status IN " + PAGOS + " AND COALESCE(paid_at,created_at) >= datetime('now','-30 days')").n;
  const lucroPlaca = T.placas ? final / T.placas : 0;
  const L = {
    periodo: j.rotulo, chave: String(periodo || 'all'), dias,
    ...Object.fromEntries(Object.entries(T).map(([k, v]) => [k, ['pedidos', 'placas', 'taxas_reais', 'taxas_estimadas', 'envio_real', 'envio_estimado'].includes(k) ? v : r2(v)])),
    lucro_bruto: r2(lucroBruto), despesas: desp.total, despesas_itens: desp.itens, lucro_final: r2(final),
    margem_pct: pct(final, T.receita_bruta), lucro_por_placa: r2(lucroPlaca), lucro_por_pedido: T.pedidos ? r2(final / T.pedidos) : 0,
    ponto_equilibrio_placas: lucroBruto > 0 && desp.total > 0 && T.placas ? Math.ceil(desp.total / (lucroBruto / T.placas)) : 0,
    a_receber: { pedidos: aw.length, valor: r2(awValor), lucro_estimado: r2(awLucro) },
    faixas, pedidos_prejuizo: lista.filter(x => x.lucro < 0).sort((a, b) => a.lucro - b.lucro).slice(0, 10),
    config: { custo_placa: r2(cfg.custoPlaca), icms_pct: cfg.icmsPct, icms_base_frete: cfg.icmsBaseFrete, taxa_pix_pct: cfg.taxaPix, taxa_cartao_pct: cfg.taxaCartao,
      custo_envio_padrao: cfg.envioPadrao, frete_fixo: frete, custo_usa_medio: db.cfg('custo_usar_medio', 0) === 1 },
    estoque: { ...est, valor_parado: r2(Math.max(0, est.em_maos) * cfg.custoPlaca), vendas_30d: vendas30,
      dias_cobertura: vendas30 > 0 ? Math.floor(Math.max(0, est.disponivel) / (vendas30 / 30)) : null },
    envio_medio_real: enviosReais.length ? r2(envioMedio) : null,
  };
  L.alertas = alertas(L);
  return L;
}

// ---------- o "contador": alertas objetivos, sempre com números ----------
function alertas(L) {
  const A = [], m = v => 'R$ ' + Number(v).toFixed(2).replace('.', ',');
  const add = (nivel, titulo, texto) => A.push({ nivel, titulo, texto });
  if (!L.pedidos) { add('info', 'Ainda não há pedidos pagos neste período', 'Quando houver, o lucro estimado aparece aqui, já descontando custo da placa, ICMS, taxas do Mercado Pago, envio e despesas.'); }
  const freteCobradoMedio = L.pedidos ? L.frete_cobrado / L.pedidos : L.config.frete_fixo;
  const envioRef = L.envio_medio_real ?? L.config.custo_envio_padrao;
  if (L.envio_medio_real === null && L.config.custo_envio_padrao === 0) {
    add('atencao', 'Falta informar o custo real dos Correios', 'Hoje o custo de envio está em R$ 0,00, então o lucro mostrado está otimista. Informe o valor pago ao marcar cada pedido como enviado (ou defina um custo médio em "Custos e taxas").');
  } else if (envioRef > L.config.frete_fixo) {
    add('critico', 'O frete cobrado não cobre o envio', `Você cobra ${m(L.config.frete_fixo)} por pedido e paga em média ${m(envioRef)} aos Correios: prejuízo de ${m(envioRef - L.config.frete_fixo)} por pedido. Para empatar, cobre pelo menos ${m(Math.ceil(envioRef * 100) / 100)} de frete.`);
  } else {
    add('ok', 'Frete cobre o envio', `Você cobra ${m(L.config.frete_fixo)} e paga em média ${m(envioRef)}: sobra ${m(L.config.frete_fixo - envioRef)} por pedido.`);
  }
  for (const f of L.faixas) {
    const nome = f.ate === null ? `${f.de}+ placas` : `${f.de} a ${f.ate} placas`;
    if (f.lucro_pedido < 0) add('critico', `Faixa ${nome} dá prejuízo`, `Um pedido de ${f.qtd_exemplo} placas a ${m(f.preco)} deixa ${m(f.lucro_pedido)} depois de todos os custos. Reveja o preço ou o custo.`);
    else if (f.margem_pct < 10) add('atencao', `Margem baixa na faixa ${nome}`, `Sobram só ${f.margem_pct}% (${m(f.lucro_por_placa)} por placa) num pedido de ${f.qtd_exemplo} placas.`);
  }
  if (L.pedidos_prejuizo.length) add('critico', `${L.pedidos_prejuizo.length} pedido(s) no prejuízo`, `O pior: pedido #${String(L.pedidos_prejuizo[0].id).padStart(5, '0')} com ${m(L.pedidos_prejuizo[0].lucro)} (${L.pedidos_prejuizo[0].qty} placas). Costuma ser frete de envio maior que o cobrado ou pedido pequeno.`);
  const e = L.estoque;
  if (e.disponivel < 0) add('critico', 'Você vendeu mais placas do que tem', `Faltam ${-e.disponivel} placas para atender os pedidos já pagos (em mãos: ${e.em_maos}, comprometidas: ${e.comprometido}). Registre a compra em Fornecedores.`);
  else if (e.disponivel < e.minimo) add('atencao', 'Estoque baixo', `Disponível: ${e.disponivel} placas (mínimo que você definiu: ${e.minimo})${e.dias_cobertura !== null ? `. No ritmo dos últimos 30 dias, dura cerca de ${e.dias_cobertura} dias` : ''}. Hora de comprar mais.`);
  else add('ok', 'Estoque saudável', `Disponível: ${e.disponivel} placas${e.dias_cobertura !== null ? ` (cerca de ${e.dias_cobertura} dias de vendas)` : ''}. Capital parado: ${m(e.valor_parado)}.`);
  if (L.pedidos && L.taxas_mp > 0) add('info', 'Taxas do Mercado Pago', `Custaram ${m(L.taxas_mp)} (${pct(L.taxas_mp, L.receita_bruta)}% da receita)${L.taxas_estimadas ? `; ${L.taxas_estimadas} de ${L.pedidos} pedidos ainda usam taxa estimada — use "Buscar taxas reais"` : ' — todas reais'}.`);
  if (L.despesas > 0 && L.lucro_bruto > 0) add('info', 'Ponto de equilíbrio', `Suas despesas do período (${m(L.despesas)}) são cobertas depois de cerca de ${L.ponto_equilibrio_placas} placas vendidas.`);
  if (L.a_receber.pedidos) add('info', 'A receber', `${L.a_receber.pedidos} pedido(s) aguardando pagamento somam ${m(L.a_receber.valor)}; se pagos, sobrariam cerca de ${m(L.a_receber.lucro_estimado)}.`);
  if (L.pedidos && L.lucro_final < 0) add('critico', 'Resultado negativo no período', `Depois de todos os custos e despesas, o resultado é ${m(L.lucro_final)}.`);
  const ordem = { critico: 0, atencao: 1, info: 2, ok: 3 };
  return A.sort((a, b) => ordem[a.nivel] - ordem[b.nivel]);
}

// ---------- análise por IA (opcional: precisa de ANTHROPIC_API_KEY) ----------
const SISTEMA = `Você é o contador e diretor financeiro (CFO) virtual da NexTap, uma empresa que vende placas de acrílico com NFC e QR Code para revendedores (atacado), com pagamento por Pix/cartão no Mercado Pago e envio pelos Correios.
Analise SOMENTE os números fornecidos em JSON (valores em reais). Não invente dados. Responda em português do Brasil, direto e sem enrolação, neste formato:
1. Resumo (3 linhas): como está o negócio no período.
2. O que está bom.
3. Riscos e prejuízos (com valores).
4. Ações recomendadas, em ordem de impacto, cada uma com o efeito estimado em R$ quando possível (ex.: ajustar frete, preço por faixa, comprar estoque, negociar fornecedor).
5. Dados que faltam para uma análise melhor.
Seja específico (cite faixas de preço, quantidades, valores). Lembre que ICMS e obrigações fiscais devem ser confirmados com um contador humano. Use listas curtas. Máximo de 350 palavras.`;

function resumoParaIA(L) {
  const { despesas_itens, pedidos_prejuizo, ...resto } = L;
  return { ...resto, despesas_principais: despesas_itens.slice(0, 8), pedidos_no_prejuizo: pedidos_prejuizo.slice(0, 5) };
}

async function analistaIA(periodo) {
  const chave = process.env.ANTHROPIC_API_KEY;
  if (!chave) { const e = new Error('Configure ANTHROPIC_API_KEY no Railway para ativar o analista de IA.'); e.codigo = 'sem_chave'; throw e; }
  const L = lucro(periodo);
  const modelo = process.env.ANALISTA_MODELO || 'claude-sonnet-5-5';
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 60000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: ac.signal,
      headers: { 'x-api-key': chave, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelo, max_tokens: 1500, system: SISTEMA,
        messages: [{ role: 'user', content: `Período analisado: ${L.periodo}.\nDados financeiros (JSON):\n${JSON.stringify(resumoParaIA(L))}` }] }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j?.error?.message || `A IA respondeu ${r.status}`); e.status = r.status; throw e; }
    const texto = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (!texto) throw new Error('A IA não devolveu texto.');
    return { texto, modelo, periodo: L.periodo };
  } finally { clearTimeout(to); }
}

module.exports = { estoque, lucro, alertas, analistaIA, janela, custosDoPedido, configuracao, r2, hojeBR };
