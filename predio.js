// Prédio: agentes que trabalham sozinhos, por regras, sem IA paga e sem custo extra.
//   Gerente      → resumo do dia às 8h (Brasília): números, gargalos e prioridades, com aviso no celular
//   Atendente    → (no engine.js) entende erros de digitação, mostra um menu quando não entende e anota as frases novas
//   Prospectora  → lista diária de empresas para abordar e retornos do dia 1, 3 e 7, com a mensagem pronta
//   Conteúdo     → calendário da semana (segunda a sexta) com roteiro e legenda, a partir de modelos e dados reais
//   Controller   → lê o financeiro do NexTap (somente leitura, a cada 10 min): lucro, margem, estoque, a receber e pedidos parados;
//                  avisa no celular quando surge um alerta crítico e entrega os números para o resumo da Gerente
// Cada agente tem um nome (Configurações → Prédio): padrão Helena, Sofia, Bianca, Theo, Otávio e Clara.
// Montado em routes-api.js (com login): /api/predio/...   ·   Relógio: tick() a cada minuto (server.js)
const express = require('express');
const { db, getSetting, setSetting } = require('./db.js');

const DIA = 86400e3, FUSO = 3 * 3600e3;
const dia0 = t => Math.floor((t - FUSO) / DIA) * DIA + FUSO;                       // meia-noite em Brasília
const dataStr = t => new Date(t - FUSO).toISOString().slice(0, 10);               // AAAA-MM-DD em Brasília
const semanaDe = t => dataStr(dia0(t) - ((new Date(dia0(t) - FUSO + 12 * 3600e3).getUTCDay() + 6) % 7) * DIA);   // segunda-feira
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const diaBR = t => { const d = new Date(t - FUSO); return `${DIAS[d.getUTCDay()]}, ${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const n = (sql, ...a) => db.prepare(sql).get(...a).n;
const brl = v => require('./nextap.js').brl(v);
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);

function registrar(agente, titulo, texto, dados = {}, t0 = Date.now()) {
  const id = db.prepare('INSERT INTO agentes_log (agente, titulo, texto, dados, criado_em) VALUES (?, ?, ?, ?, ?)').run(agente, titulo, texto, JSON.stringify(dados), t0).lastInsertRowid;
  db.prepare('DELETE FROM agentes_log WHERE agente = ? AND id NOT IN (SELECT id FROM agentes_log WHERE agente = ? ORDER BY id DESC LIMIT 60)').run(agente, agente);
  return id;
}
const ultimo = agente => { const r = db.prepare('SELECT * FROM agentes_log WHERE agente = ? ORDER BY id DESC LIMIT 1').get(agente); return r && { ...r, dados: JSON.parse(r.dados || '{}') }; };

const PAPEIS = { gerente: 'Gerente', atendente: 'Atendente', prospectora: 'Prospectora', conteudo: 'Conteúdo', financeiro: 'Controller', recepcao: 'Recepcionista' };
const NOMES0 = { gerente: 'Helena', atendente: 'Sofia', prospectora: 'Bianca', conteudo: 'Theo', financeiro: 'Otávio', recepcao: 'Clara' };
function nomes() { let o = {}; try { o = JSON.parse(getSetting('predio_nomes') || '{}') || {}; } catch (e) { /* padrão */ } const r = {}; for (const k in NOMES0) r[k] = String(o[k] || '').trim() || NOMES0[k]; return r; }
const quem = k => `${nomes()[k]} (${PAPEIS[k]})`;

// ======================= CONTROLLER (financeiro do NexTap) =======================
const fin = () => { try { return JSON.parse(getSetting('nextap_fin') || 'null'); } catch (e) { return null; } };
const reais = v => 'R$ ' + brl(v || 0);
// Chamado a cada leitura do NexTap: registra e avisa só o que é NOVO (alerta crítico ou pedido pago parado)
function controller(j, t0 = Date.now()) {
  if (!j || !j.mes) return [];
  let vistos = []; try { vistos = JSON.parse(getSetting('controller_vistos') || '[]'); } catch (e) { /* vazio */ }
  const atuais = [], novos = [];
  for (const a of (j.mes.alertas || []).filter(x => x.nivel === 'critico')) { const k = 'a:' + a.titulo; atuais.push(k); if (!vistos.includes(k)) novos.push({ titulo: '🚨 ' + a.titulo, texto: a.texto }); }
  for (const p of (j.pedidos && j.pedidos.parados) || []) { const k = 'p:' + p.id; atuais.push(k); if (!vistos.includes(k)) novos.push({ titulo: `📦 Pedido #${String(p.id).padStart(5, '0')} parado há ${p.dias} dias`, texto: `${p.ship_name || 'Cliente'} · ${reais(p.total)} · status: ${String(p.status).replace('_', ' ')}. Produza e envie no admin do NexTap.` }); }
  setSetting('controller_vistos', JSON.stringify(atuais));
  if (!getSetting('controller_ok')) { setSetting('controller_ok', '1'); registrar('financeiro', 'Primeira leitura do financeiro do NexTap ✓', `Mês: receita ${reais(j.periodos.month.receita_bruta)}, lucro ${reais(j.periodos.month.lucro_final)}.`, {}, t0); return []; }   // não dispara avisos antigos na instalação
  for (const x of novos) registrar('financeiro', x.titulo, x.texto, {}, t0);
  if (novos.length) require('./notificacoes.js').notificar({ tipo: 'financeiro', titulo: `${nomes().financeiro}: ${novos[0].titulo}`, texto: novos.length > 1 ? `${novos[0].texto} (+${novos.length - 1} aviso(s))` : novos[0].texto, url: '/#predio', chave: 'fin-' + atuais.join('|').slice(0, 60) }).catch(() => {});
  return novos;
}
function resumoFin(j) {
  if (!j || !j.periodos) return null;
  const m = j.periodos.month, s = j.periodos['7'], e = j.mes.estoque || {};
  return { em: j.recebido_em || j.gerado_em, receita_mes: m.receita_bruta, lucro_mes: m.lucro_final, margem_mes: m.margem_pct, pedidos_mes: m.pedidos, placas_mes: m.placas,
    receita_7: s.receita_bruta, lucro_7: s.lucro_final, hoje: j.periodos.today.receita_bruta,
    criticos: (j.mes.alertas || []).filter(a => a.nivel === 'critico').length, atencao: (j.mes.alertas || []).filter(a => a.nivel === 'atencao').length,
    parados: ((j.pedidos && j.pedidos.parados) || []).length, a_receber: (j.mes.a_receber || {}).valor || 0, estoque: e.disponivel, cobertura: e.dias_cobertura };
}

// ======================= PROSPECTORA =======================
const cidade = () => getSetting('cidade') || 'Feira de Santana';
const vendedor = () => getSetting('vendedor_nome') || 'Luiz';
const notaBR = v => Number(v).toFixed(1).replace('.', ',');
function abertura(p) {
  const nome = p.nome, av = p.avaliacoes || 0, r = p.nota;
  if (r == null && !av) return `Encontrei ${nome} no Google e queria te mostrar uma coisa rápida.`;
  if (av < 10) return `Encontrei ${nome} no Google e reparei que tem poucas avaliações${av ? ` (só ${av})` : ''}. Para um negócio que atende gente todo dia, dá para ter muito mais.`;
  const base = `Encontrei ${nome} no Google: nota ${notaBR(r)} com ${av} avaliações.`;
  if (av < 30) return `${base} Para quem atende tanta gente, dá para ter bem mais.`;
  if (r != null && r < 4.3) return `${base} Nota assim pesa na hora do cliente escolher, e o jeito mais rápido de subir é fazer os clientes satisfeitos avaliarem.`;
  return `${base} Parabéns! O desafio agora é manter o ritmo e ficar na frente dos concorrentes da região.`;
}
const primeiro = p => (p.contato ? ' ' + String(p.contato).split(' ')[0] : '');
const MSG = {
  d0: p => `Oi${primeiro(p)}! Tudo bem? Sou o ${vendedor()}, aqui de ${cidade()}.\n\n${abertura(p)}\n\nPosso te mostrar em 15 segundos como fazer os seus clientes avaliarem sem esforço?`,
  d1: p => `Oi${primeiro(p)}! Conseguiu ver a minha mensagem?\n\nImagina cada cliente satisfeito avaliando ${p.nome} na saída, em 5 segundos. Posso te mandar um vídeo rápido?`,
  d3: p => `Oi${primeiro(p)}! Só para não deixar passar: consigo deixar a placa de vocês configurada ainda esta semana.\n\nPrefere uma só, para o balcão, ou duas (balcão e caixa)?`,
  d7: p => `Oi${primeiro(p)}! Última mensagem por aqui. 🙂\n\nQuando quiser mais avaliações no Google para ${p.nome}, é só me chamar. Obrigado pela atenção!`,
};
const PASSOS = ['d0', 'd1', 'd3', 'd7'], PROXIMO = [1, 2, 4];   // depois do 1º contato: +1 dia; 2º: +2 (dia 3); 3º: +4 (dia 7)
const contatosWpp = id => n("SELECT COUNT(*) AS n FROM prospect_hist WHERE prospect_id = ? AND tipo = 'whatsapp'", id);

function montarLista(t0 = Date.now()) {
  const hoje = dataStr(t0), max = Math.max(1, Math.min(50, Number(getSetting('prospeccao_dia')) || 10));
  const { oportunidade } = require('./prospeccao.js')._t;
  const novos = db.prepare("SELECT * FROM prospects WHERE status = 'novo' AND telefone <> ''").all()
    .map(p => ({ p, o: oportunidade(p) })).sort((a, b) => b.o.score - a.o.score || a.p.id - b.p.id).slice(0, max);
  const retornos = db.prepare("SELECT * FROM prospects WHERE status IN ('abordado', 'interessado', 'orcamento') AND telefone <> '' AND prox_contato IS NOT NULL AND prox_contato <= ? ORDER BY prox_contato, id LIMIT 50").all(hoje);
  const itens = [
    ...retornos.map(p => { const k = PASSOS[Math.min(3, Math.max(1, contatosWpp(p.id)))]; return { id: p.id, nome: p.nome, telefone: p.telefone, segmento: p.segmento, tipo: 'retorno', passo: k, mensagem: MSG[k](p), feito: false }; }),
    ...novos.map(({ p, o }) => ({ id: p.id, nome: p.nome, telefone: p.telefone, segmento: p.segmento, tipo: 'abordagem', passo: 'd0', motivo: o.porque.join(', '), nivel: o.nivel, mensagem: MSG.d0(p), feito: false })),
  ];
  db.prepare("DELETE FROM agentes_log WHERE agente = 'prospectora' AND json_extract(dados, '$.dia') = ?").run(hoje);
  const texto = itens.length ? `${retornos.length} retorno(s) e ${novos.length} empresa(s) nova(s) para abordar hoje.` : 'Nenhuma empresa para hoje: busque novas empresas na Prospecção.';
  registrar('prospectora', 'Lista de ' + diaBR(t0), texto, { dia: hoje, itens }, t0);
  return { dia: hoje, itens };
}
function listaDeHoje(t0 = Date.now()) {
  const r = db.prepare("SELECT * FROM agentes_log WHERE agente = 'prospectora' AND json_extract(dados, '$.dia') = ? ORDER BY id DESC LIMIT 1").get(dataStr(t0));
  return r ? { id: r.id, ...JSON.parse(r.dados) } : null;
}
// Contato feito pela lista: anota na empresa e agenda o próximo retorno (dia 1, 3 e 7); depois do 4º sem resposta, para.
function contatoFeito(prospectId, t0 = Date.now()) {
  const p = db.prepare('SELECT * FROM prospects WHERE id = ?').get(prospectId);
  if (!p) return null;
  const feitos = contatosWpp(p.id) + 1;
  const prox = feitos <= PROXIMO.length ? dataStr(dia0(t0) + PROXIMO[feitos - 1] * DIA) : null;
  const quando = new Date(t0).toISOString().replace('T', ' ').slice(0, 19);
  db.transaction(() => {
    db.prepare("INSERT INTO prospect_hist (prospect_id, tipo, texto, criado_em) VALUES (?, 'whatsapp', ?, ?)").run(p.id, `Contato ${feitos} pela lista da Prospectora`, quando);
    db.prepare("UPDATE prospects SET status = ?, prox_contato = ?, atualizado_em = datetime('now') WHERE id = ?").run(p.status === 'novo' ? 'abordado' : p.status, prox, p.id);
    const l = listaDeHoje(t0);
    if (l) { l.itens.forEach(i => { if (i.id === p.id) i.feito = true; }); db.prepare('UPDATE agentes_log SET dados = ? WHERE id = ?').run(JSON.stringify({ dia: l.dia, itens: l.itens }), l.id); }
  })();
  return { prox_contato: prox, contatos: feitos };
}

// ======================= CONTEÚDO =======================
const clientes = () => String(getSetting('clientes_prova') || '').split(',').map(x => x.trim()).filter(Boolean);
const tags = () => `#avaliacoesgoogle #nfc #empreendedorismo #pequenosnegocios #${cidade().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '')}`;
// Cada pilar tem modelos que se revezam semana a semana (sem repetir o mesmo texto em seguida)
const PILARES = [
  { dia: 1, pilar: 'Prova social', formato: 'Carrossel', modelos: [
    c => ({ titulo: `No balcão: ${c.cliente}`, gancho: 'Olha onde a NexTap está trabalhando esta semana 👀', roteiro: `1. Foto da placa no balcão (${c.cliente})\n2. Cliente aproximando o celular\n3. Tela de avaliação aberta no Google\n4. Chamada: "Quer no seu negócio também?"`,
      legenda: `Mais uma empresa da região com a NexTap no balcão: ${c.cliente}! ⭐\n\nO cliente aproxima o celular e já cai na avaliação do Google, sem aplicativo e sem procurar.\n\nQuer uma no seu negócio? Comente COMO FUNCIONA que eu te explico no direct.` }),
    c => ({ titulo: 'Antes e depois das avaliações', gancho: 'Quantas avaliações a sua empresa recebeu este mês?', roteiro: '1. Pergunta na capa\n2. "Cliente satisfeito quase nunca avalia sozinho"\n3. "Com a placa, ele avalia em 5 segundos"\n4. Foto de cliente usando (ex.: ' + c.cliente + ')\n5. Chamada para o direct',
      legenda: `Cliente satisfeito quase nunca lembra de avaliar. 😅\n\nCom a NexTap, ele aproxima o celular da placa e a avaliação abre na hora. É assim que empresas como ${c.cliente} fazem as estrelas crescerem.\n\nComente COMO FUNCIONA que eu te mostro.` }),
    c => ({ titulo: 'Bastidores da entrega', gancho: 'Embalando as placas de hoje 📦', roteiro: '1. Placas sendo embaladas\n2. Etiqueta com o nome do cliente\n3. Placa configurada sendo testada no celular\n4. "Já sai pronta para usar"',
      legenda: 'Bastidores de hoje: placas saindo configuradas, prontas para colocar no balcão. 📦\n\nVocê recebe, cola e o cliente já consegue avaliar.\n\nQuer a sua? Comente COMO FUNCIONA.' }),
  ] },
  { dia: 2, pilar: 'Como funciona', formato: 'Reels', modelos: [
    () => ({ titulo: 'Avaliação em 5 segundos', gancho: 'Seu cliente avalia a sua empresa em 5 segundos, sem aplicativo.', roteiro: '0–2s: gancho na tela\n2–6s: mão aproximando o celular da placa\n6–9s: tela de avaliação do Google abrindo\n9–12s: estrelas sendo marcadas\n12–15s: "Comente COMO FUNCIONA"',
      legenda: 'Sem aplicativo, sem procurar a empresa no Google: aproximou, avaliou. ⚡\n\nA NexTap tem NFC e QR Code, e funciona em qualquer celular.\n\nComente COMO FUNCIONA que eu te mando os detalhes no direct.' }),
    () => ({ titulo: 'NFC ou QR Code?', gancho: 'Seu celular não tem NFC? Sem problema.', roteiro: '1. Celular com NFC aproximando\n2. Celular sem NFC lendo o QR Code\n3. As duas formas abrem a mesma avaliação\n4. Chamada para o direct',
      legenda: 'Funciona com NFC (é só aproximar) e com QR Code (é só apontar a câmera). Nenhum cliente fica de fora. ✅\n\nComente COMO FUNCIONA.' }),
    () => ({ titulo: 'Onde colocar a placa', gancho: 'O lugar da placa muda tudo.', roteiro: '1. Balcão do caixa\n2. Mesa do restaurante\n3. Recepção da clínica\n4. "Onde o cliente está feliz, a placa precisa estar"',
      legenda: 'A dica de ouro: coloque a placa onde o cliente termina o atendimento satisfeito, como o caixa, a mesa ou a recepção. 💡\n\nComente COMO FUNCIONA para receber a sua.' }),
  ] },
  { dia: 3, pilar: 'Revenda e lucro', formato: 'Carrossel', modelos: [
    c => ({ titulo: 'Faça a conta da revenda', gancho: 'Quanto sobra revendendo 10 placas?', roteiro: `1. Pergunta na capa\n2. Custo: 10 placas a R$ ${c.preco10} cada = R$ ${c.total10}\n3. Revendendo a R$ ${c.venda} cada = R$ ${c.receita10}\n4. Lucro: R$ ${c.lucro10}\n5. "Comente REVENDER"`,
      legenda: `Revendendo 10 placas a R$ ${c.venda}, você recebe R$ ${c.receita10}. Com o custo de R$ ${c.total10}, sobram R$ ${c.lucro10} de lucro. 💰\n\nVocê define o seu preço de venda e vende para os negócios da sua cidade.\n\nComente REVENDER que eu te mostro como começar.` }),
    c => ({ titulo: 'Para quem vender', gancho: '5 tipos de negócio que precisam de avaliação no Google', roteiro: '1. Barbearias\n2. Restaurantes\n3. Clínicas e consultórios\n4. Salões de beleza\n5. Oficinas\n6. "Comente REVENDER"',
      legenda: `Barbearia, restaurante, clínica, salão, oficina: todo negócio local vive de avaliação no Google. ⭐\n\nRevendendo a NexTap você ajuda essas empresas e ganha por placa (a partir de ${c.minimo} placas no primeiro pedido).\n\nComente REVENDER.` }),
    c => ({ titulo: 'Renda extra com 10 placas', gancho: 'Uma renda extra que cabe no seu dia.', roteiro: `1. "Renda extra?"\n2. Compre ${c.minimo} ou mais placas direto da fábrica\n3. Venda para negócios da sua cidade\n4. Lucro de R$ ${c.lucro10} em 10 placas\n5. "Comente REVENDER"`,
      legenda: `Comece com ${c.minimo} placas, venda para os negócios da sua cidade e fique com a diferença. Em 10 placas são R$ ${c.lucro10} de lucro revendendo a R$ ${c.venda}. 🚀\n\nComente REVENDER que eu te mando o passo a passo.` }),
  ] },
  { dia: 4, pilar: 'Quebra de objeção', formato: 'Reels', modelos: [
    () => ({ titulo: '"Já tenho QR Code"', gancho: '"Já tenho QR Code no balcão." Ótimo, mas…', roteiro: '1. Pessoa abrindo a câmera e apontando (demora)\n2. Pessoa só aproximando o celular da NexTap (rápido)\n3. "Menos passos, mais avaliações"',
      legenda: 'QR Code é bom. Aproximar o celular é mais rápido. ⚡\n\nA NexTap tem os dois: quem tem NFC só aproxima, quem não tem lê o QR.\n\nComente COMO FUNCIONA.' }),
    () => ({ titulo: '"Meu movimento já é bom"', gancho: 'Seu movimento está bom? Então é a hora certa.', roteiro: '1. "Movimento bom hoje"\n2. "Concorrente novo abriu na rua"\n3. "Cliente novo escolhe pelas estrelas"\n4. "Avaliação é o que mantém você na frente"',
      legenda: 'Os melhores negócios da região não esperam a nota cair para cuidar dela. ⭐\n\nCom a NexTap, cada cliente satisfeito vira uma avaliação.\n\nComente COMO FUNCIONA.' }),
    () => ({ titulo: '"Dá trabalho configurar?"', gancho: 'Quanto trabalho dá para configurar a placa? Zero.', roteiro: '1. Placa chegando\n2. Já vem configurada com o link da empresa\n3. Colar no balcão\n4. Cliente avaliando',
      legenda: 'A placa já chega configurada com o link da sua empresa no Google. É só colocar no balcão. ✅\n\nComente COMO FUNCIONA.' }),
  ] },
  { dia: 5, pilar: 'Oferta', formato: 'Stories', modelos: [
    c => c.promo ? ({ titulo: `${c.promo.nome}: ${c.promo.quando}`, gancho: `🖤 ${c.promo.nome}: placas a partir de R$ ${c.promo.a_partir}`, roteiro: `1. "${c.promo.nome}"\n2. Preço a partir de R$ ${c.promo.a_partir}\n3. Contagem: ${c.promo.quando}\n4. Figurinha de link ou "Comente BLACK"`,
      legenda: `🖤 ${c.promo.nome}: placas a partir de R$ ${c.promo.a_partir}, até ${c.promo.ate}.\n\nDepois disso, o preço volta ao normal.\n\nComente BLACK que eu te mando o seu pedido montado no direct.` })
      : ({ titulo: 'Seu primeiro pedido', gancho: `Placas a partir de R$ ${c.menor} cada`, roteiro: `1. Placa na mão\n2. "A partir de R$ ${c.menor}"\n3. "Pedido mínimo de ${c.minimo} placas"\n4. "Comente REVENDER"`,
        legenda: `Placas NexTap a partir de R$ ${c.menor} cada, com pedido mínimo de ${c.minimo}. 📦\n\nQuanto mais placas, menor o preço de cada uma.\n\nComente REVENDER que eu te mostro o valor do seu pedido.` }),
  ] },
];
function dadosConteudo(t0) {
  const nx = require('./nextap.js'), c10 = nx.conta(10), tab = nx.tabela().tiers, p = nx.promo(t0);
  const cl = clientes(), semanaN = Math.floor(dia0(t0) / (7 * DIA));
  let promo = null;
  if (p) { const t = nx.textoPromo('black_final', 10, t0); promo = { nome: p.nome, a_partir: p.a_partir ? brl(p.a_partir) : brl(Math.min(...tab.map(x => x.unit_price))), ate: new Date(Date.parse(p.fim) - FUSO).toISOString().slice(5, 10).split('-').reverse().join('/'), quando: (/ (termina [^.]*)\./.exec(t) || [, 'por tempo limitado'])[1] }; }
  return { cliente: cl.length ? cl[semanaN % cl.length] : 'um dos nossos clientes', preco10: brl(c10.unit), total10: brl(c10.total), venda: brl(nx.precoRevenda()),
    receita10: brl(c10.receita), lucro10: brl(c10.lucro), minimo: nx.minimo(), menor: brl(Math.min(...tab.map(x => x.unit_price))), promo, semanaN };
}
function gerarSemana(t0 = Date.now(), { forcar = false } = {}) {
  const semana = semanaDe(t0);
  if (!forcar && n('SELECT COUNT(*) AS n FROM conteudo WHERE semana = ?', semana)) return { semana, criados: 0 };
  const c = dadosConteudo(t0), seg = Date.parse(semana + 'T12:00:00-03:00');
  let criados = 0;
  db.transaction(() => {
    db.prepare("DELETE FROM conteudo WHERE semana = ? AND status = 'rascunho'").run(semana);
    for (const p of PILARES) {
      const dia = dataStr(seg + (p.dia - 1) * DIA);
      if (db.prepare("SELECT 1 FROM conteudo WHERE semana = ? AND dia = ? AND status <> 'rascunho'").get(semana, dia)) continue;   // já aprovado/postado: fica
      const m = p.modelos[(c.semanaN + (forcar ? 1 + Math.floor(Math.random() * 10) : 0)) % p.modelos.length](c);
      db.prepare('INSERT INTO conteudo (semana, dia, formato, pilar, titulo, gancho, roteiro, legenda, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(semana, dia, p.formato, p.pilar, m.titulo, m.gancho, m.roteiro, m.legenda + '\n\n' + tags(), Date.now());
      criados++;
    }
  })();
  registrar('conteudo', 'Semana de ' + diaBR(seg), `${criados} conteúdo(s) prontos para revisar.`, { semana }, t0);
  return { semana, criados };
}

// ======================= GERENTE =======================
function resumo(t0 = Date.now(), { avisar = true } = {}) {
  const hoje0 = dia0(t0), ontem0 = hoje0 - DIA;
  const novos = n("SELECT COUNT(*) AS n FROM contacts WHERE channel <> 'sim' AND created_at >= ? AND created_at < ?", ontem0, hoje0);
  const recebidas = n("SELECT COUNT(*) AS n FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE c.channel <> 'sim' AND m.direction = 'in' AND m.created_at >= ? AND m.created_at < ?", ontem0, hoje0);
  const cliques = n('SELECT COUNT(DISTINCT contact_id) AS n FROM links WHERE last_click_at >= ? AND last_click_at < ?', ontem0, hoje0);
  const v = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(venda_total), 0) AS total FROM contacts WHERE channel <> 'sim' AND venda_em >= ? AND venda_em < ?").get(ontem0, hoje0);
  const esperando = n("SELECT COUNT(*) AS n FROM contacts WHERE channel <> 'sim' AND needs_human = 1");
  const semResposta = n(`SELECT COUNT(*) AS n FROM contacts c WHERE c.channel <> 'sim' AND c.last_inbound_at > ? AND c.bot_paused_until <= ?
    AND (SELECT direction FROM messages m WHERE m.contact_id = c.id ORDER BY id DESC LIMIT 1) = 'in'`, t0 - DIA, t0);
  // Funil da semana: de quem escolheu a quantidade, quantos abriram o pedido (comparado com a semana anterior)
  const taxa = (ini, fim) => { const r = db.prepare(`SELECT COALESCE(SUM(tags LIKE '%"QUANTIDADE"%'), 0) AS q, COALESCE(SUM(tags LIKE '%"QUANTIDADE"%' AND tags LIKE '%"ABRIU CHECKOUT"%'), 0) AS c
    FROM contacts WHERE channel <> 'sim' AND created_at >= ? AND created_at < ?`).get(ini, fim); return { q: r.q, c: r.c, p: r.q ? r.c / r.q : 0 }; };
  const s1 = taxa(hoje0 - 7 * DIA, hoje0), s0 = taxa(hoje0 - 14 * DIA, hoje0 - 7 * DIA);
  const prioridades = [], alertas = [];
  const igErro = getSetting('ig_conexao_erro');
  if (igErro) prioridades.push('🚨 O robô do Instagram está parado: gere um token novo e troque IG_ACCESS_TOKEN no Railway.');
  if (esperando) prioridades.push(`🙋 ${esperando} pessoa(s) esperando atendente.`);
  if (semResposta) prioridades.push(`💬 ${semResposta} conversa(s) das últimas 24h com a última mensagem do cliente sem resposta.`);
  if (s1.q >= 10 && s0.q >= 10 && s0.p > 0 && s1.p < s0.p * 0.7) alertas.push(`📉 Pedidos abertos caíram: ${pct(s1.c, s1.q)}% de quem escolheu a quantidade nesta semana, contra ${pct(s0.c, s0.q)}% na anterior.`);
  try {
    for (const t of require('./routes-api.js').resultadosAB().filter(x => x.b_ativo && x.confianca >= 95)) {
      const a = t.A.clicou / (t.A.recebeu || 1), b = t.B.clicou / (t.B.recebeu || 1);
      prioridades.push(`🧪 Teste A/B "${t.a_nome}": a versão ${b > a ? 'B' : 'A'} está na frente com ${t.confianca}% de confiança. Escolha a vencedora em Fluxos.`);
    }
  } catch (e) { /* sem teste A/B */ }
  const nx = require('./nextap.js'), black = nx.textoPromo('black_final', 10, t0).split('\n')[0];
  const lista = listaDeHoje(t0), hojeConteudo = db.prepare('SELECT * FROM conteudo WHERE dia = ? ORDER BY id DESC LIMIT 1').get(dataStr(t0));
  const naoEnt = n("SELECT COUNT(*) AS n FROM nao_entendidas WHERE status = 'nova' AND ultimo_em >= ?", ontem0);
  if (lista && lista.itens.length) prioridades.push(`📋 ${quem('prospectora')}: ${lista.itens.filter(i => i.tipo === 'retorno').length} retorno(s) e ${lista.itens.filter(i => i.tipo === 'abordagem').length} empresa(s) nova(s) para hoje.`);
  if (hojeConteudo && hojeConteudo.status !== 'postado') prioridades.push(`🎬 ${quem('conteudo')}, conteúdo de hoje: ${hojeConteudo.formato} "${hojeConteudo.titulo}".`);
  if (naoEnt) prioridades.push(`🧠 ${quem('atendente')}: ${naoEnt} frase(s) nova(s) que o robô não entendeu. Ensine em Prédio → Atendente.`);
  const F = fin(), rf = resumoFin(F), finLinhas = [];
  if (rf) {
    finLinhas.push(`💰 ${quem('financeiro')}: no mês, ${rf.pedidos_mes} pedido(s) pago(s), receita ${reais(rf.receita_mes)} e lucro final ${reais(rf.lucro_mes)} (margem ${String(rf.margem_mes).replace('.', ',')}%). Últimos 7 dias: ${reais(rf.receita_7)} de receita.`);
    if (rf.a_receber) finLinhas.push(`🧾 A receber: ${reais(rf.a_receber)} em pedidos aguardando pagamento.`);
    for (const a of (F.mes.alertas || []).filter(x => x.nivel === 'critico').slice(0, 3)) prioridades.push(`🚨 Financeiro: ${a.titulo}.`);
    if (rf.parados) prioridades.push(`📦 ${rf.parados} pedido(s) pago(s) parado(s) há 3 dias ou mais. Produza e envie no admin do NexTap.`);
    const est = (F.mes.alertas || []).find(x => x.titulo === 'Estoque baixo'); if (est) prioridades.push(`📦 Estoque baixo: ${rf.estoque} placa(s) disponível(is)${rf.cobertura != null ? `, dura cerca de ${rf.cobertura} dia(s)` : ''}.`);
    if (t0 - rf.em > 2 * DIA) prioridades.push(`🔌 ${quem('financeiro')}: o financeiro do NexTap não atualiza há mais de 2 dias.`);
  } else if (getSetting('nextap_fin_erro')) prioridades.push(`🔌 ${quem('financeiro')} não consegue ler o NexTap: ${getSetting('nextap_fin_erro')}`);
  const linhas = [
    `📊 Ontem: ${novos} lead(s) novo(s), ${recebidas} mensagem(ns) recebida(s), ${cliques} clique(s) no pedido, ${v.n} venda(s)${v.total ? ` (R$ ${brl(v.total)})` : ''}.`,
    `🔁 Funil da semana: ${pct(s1.c, s1.q)}% de quem escolheu a quantidade abriu o pedido (${s1.c} de ${s1.q}).`,
    ...finLinhas, ...(black ? [black] : []), ...alertas,
    '', prioridades.length ? '✅ Prioridades de hoje:' : '✅ Nada urgente hoje. Bom trabalho!', ...prioridades.map(p => '• ' + p),
  ];
  const titulo = 'Resumo de ' + diaBR(t0), texto = linhas.join('\n');
  registrar('gerente', titulo, texto, { novos, recebidas, cliques, vendas: v.n, total: v.total, esperando, semResposta, prioridades: prioridades.length, lucro_mes: rf ? rf.lucro_mes : null }, t0);
  if (avisar) require('./notificacoes.js').notificar({ tipo: 'resumo', titulo: '☀️ ' + nomes().gerente + ': ' + titulo, texto: `${novos} lead(s), ${v.n} venda(s) ontem${rf ? ` · lucro do mês ${reais(rf.lucro_mes)}` : ''} · ${prioridades.length} prioridade(s) hoje`, url: '/#predio' }).catch(() => {});
  return { titulo, texto };
}

// ======================= RELÓGIO =======================
// Todo dia, a partir da hora configurada (padrão 08:00 de Brasília): lista da Prospectora, conteúdo da semana e resumo da Gerente
function tick(t0 = Date.now()) {
  if (!n('SELECT COUNT(*) AS n FROM conteudo WHERE semana = ?', semanaDe(t0))) { try { gerarSemana(t0); } catch (e) { console.error('[PRÉDIO] conteúdo:', e.message); } }
  const [h, m] = String(getSetting('predio_hora') || '08:00').split(':').map(Number);
  const primeiraVez = !getSetting('predio_dia');   // acabou de instalar: os agentes começam já, sem esperar a hora do dia seguinte
  if (!primeiraVez && t0 < dia0(t0) + ((h || 0) * 60 + (m || 0)) * 60e3) return false;
  const hoje = dataStr(t0);
  if (getSetting('predio_dia') === hoje) return false;
  setSetting('predio_dia', hoje);
  try { montarLista(t0); } catch (e) { console.error('[PRÉDIO] prospectora:', e.message); }
  try { gerarSemana(t0); } catch (e) { console.error('[PRÉDIO] conteúdo:', e.message); }
  try { resumo(t0); } catch (e) { console.error('[PRÉDIO] gerente:', e.message); }
  return true;
}

// ======================= ROTAS =======================
const router = express.Router();
router.get('/', (req, res) => {
  const g = ultimo('gerente'), l = listaDeHoje(), sem = semanaDe(Date.now());
  const conteudo = db.prepare('SELECT status, COUNT(*) AS n FROM conteudo WHERE semana = ? GROUP BY status').all(sem);
  const s7 = Date.now() - 7 * DIA;
  const hoje0 = dia0(Date.now());
  const ultima = db.prepare(`SELECT m.created_at AS em, c.name, c.username FROM messages m JOIN contacts c ON c.id = m.contact_id
    WHERE c.channel = 'instagram' AND m.direction = 'out' AND m.status = 'ok' AND m.kind <> 'manual' ORDER BY m.id DESC LIMIT 1`).get();
  const proxima = l && l.itens.find(i => !i.feito);
  const hojeC = db.prepare('SELECT titulo, formato, status FROM conteudo WHERE dia = ? ORDER BY id DESC LIMIT 1').get(dataStr(Date.now()));
  res.json({
    agora: {
      leads_hoje: n("SELECT COUNT(*) AS n FROM contacts WHERE channel = 'instagram' AND created_at >= ?", hoje0),
      respostas_hoje: n("SELECT COUNT(*) AS n FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE c.channel = 'instagram' AND m.direction = 'out' AND m.status = 'ok' AND m.kind <> 'manual' AND m.created_at >= ?", hoje0),
      ultima_resposta: ultima ? { em: ultima.em, nome: ultima.name || (ultima.username ? '@' + ultima.username : '') } : null,
      esperando: n("SELECT COUNT(*) AS n FROM contacts WHERE channel = 'instagram' AND needs_human = 1"),
      robo_parado: !!getSetting('ig_conexao_erro'),
    },
    nomes: nomes(),
    financeiro: resumoFin(fin()), financeiro_erro: getSetting('nextap_fin_erro') || '',
    feed: db.prepare('SELECT agente, titulo, criado_em FROM agentes_log ORDER BY id DESC LIMIT 12').all(),
    gerente: g ? { titulo: g.titulo, texto: g.texto, em: g.criado_em, prioridades: g.dados.prioridades || 0, novos: g.dados.novos || 0, vendas: g.dados.vendas || 0 } : null,
    atendente: { novas: n("SELECT COUNT(*) AS n FROM nao_entendidas WHERE status = 'nova'"), ensinadas: n("SELECT COUNT(*) AS n FROM nao_entendidas WHERE status = 'ensinada'"),
      menus7: n("SELECT COUNT(*) AS n FROM messages m JOIN flows f ON f.id = m.flow_id WHERE f.event = 'nao_entendi' AND m.direction = 'out' AND m.created_at >= ?", s7),
      corrigidas7: n("SELECT COUNT(*) AS n FROM agentes_log WHERE agente = 'atendente' AND criado_em >= ?", s7) },
    prospectora: l ? { total: l.itens.length, feitos: l.itens.filter(i => i.feito).length, proxima: proxima ? proxima.nome : null } : null,
    conteudo: { semana: sem, hoje: hojeC || null, total: conteudo.reduce((a, x) => a + x.n, 0), aprovados: (conteudo.find(x => x.status === 'aprovado') || { n: 0 }).n, postados: (conteudo.find(x => x.status === 'postado') || { n: 0 }).n },
  });
});
router.get('/gerente', (req, res) => res.json(db.prepare("SELECT id, titulo, texto, criado_em FROM agentes_log WHERE agente = 'gerente' ORDER BY id DESC LIMIT 14").all()));
router.post('/gerente/agora', (req, res) => res.json(resumo(Date.now(), { avisar: false })));
router.get('/atendente', (req, res) => res.json({
  frases: db.prepare("SELECT * FROM nao_entendidas WHERE status = 'nova' ORDER BY vezes DESC, ultimo_em DESC LIMIT 100").all(),
  correcoes: db.prepare("SELECT titulo, texto, criado_em FROM agentes_log WHERE agente = 'atendente' ORDER BY id DESC LIMIT 20").all(),
}));
// Ensinar: a frase vira palavra-chave do fluxo escolhido (só fluxos de palavra-chave)
router.post('/atendente/:id/ensinar', (req, res) => {
  const x = db.prepare('SELECT * FROM nao_entendidas WHERE id = ?').get(req.params.id);
  const f = db.prepare("SELECT id, keywords FROM flows WHERE id = ? AND kind = 'normal'").get(Number((req.body || {}).flow_id));
  if (!x) return res.status(404).json({ error: 'Frase não encontrada.' });
  if (!f) return res.status(400).json({ error: 'Escolha um fluxo de palavra-chave.' });
  const kws = JSON.parse(f.keywords || '[]');
  if (!kws.includes(x.chave)) kws.push(x.chave);
  db.transaction(() => {
    db.prepare('UPDATE flows SET keywords = ? WHERE id = ?').run(JSON.stringify(kws), f.id);
    db.prepare("UPDATE nao_entendidas SET status = 'ensinada', flow_id = ? WHERE id = ?").run(f.id, x.id);
  })();
  res.json({ ok: true });
});
router.post('/atendente/:id/ignorar', (req, res) => { db.prepare("UPDATE nao_entendidas SET status = 'ignorada' WHERE id = ?").run(req.params.id); res.json({ ok: true }); });
router.get('/financeiro', (req, res) => {
  const nx = require('./nextap.js');
  res.json({ dados: fin(), erro: getSetting('nextap_fin_erro') || '', admin: nx.adminNextap(), configurado: (process.env.NEXTAP_WEBHOOK_SECRET || '').length >= 16,
    avisos: db.prepare("SELECT id, titulo, texto, criado_em FROM agentes_log WHERE agente = 'financeiro' ORDER BY id DESC LIMIT 20").all() });
});
router.post('/financeiro/atualizar', async (req, res) => {
  try { const j = await require('./nextap.js').atualizarFinanceiro(); if (!j) return res.status(400).json({ error: 'Configure NEXTAP_WEBHOOK_SECRET (o mesmo valor no NexTap e no Automazap) e o endereço do site.' }); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: getSetting('nextap_fin_erro') || e.message }); }
});
router.get('/prospectora', (req, res) => res.json(listaDeHoje() || montarLista()));
router.post('/prospectora/montar', (req, res) => res.json(montarLista()));
router.post('/prospectora/feito', (req, res) => {
  const r = contatoFeito(Number((req.body || {}).prospect_id));
  if (!r) return res.status(404).json({ error: 'Empresa não encontrada.' });
  res.json(r);
});
router.get('/conteudo', (req, res) => {
  const semana = /^\d{4}-\d\d-\d\d$/.test(String(req.query.semana || '')) ? req.query.semana : semanaDe(Date.now());
  if (semana === semanaDe(Date.now())) gerarSemana();
  res.json({ semana, itens: db.prepare('SELECT * FROM conteudo WHERE semana = ? ORDER BY dia, id').all(semana) });
});
router.post('/conteudo/gerar', (req, res) => res.json(gerarSemana(Date.now(), { forcar: true })));
router.put('/conteudo/:id', (req, res) => {
  const b = req.body || {}, c = db.prepare('SELECT * FROM conteudo WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Conteúdo não encontrado.' });
  const status = ['rascunho', 'aprovado', 'postado'].includes(b.status) ? b.status : c.status;
  const legenda = typeof b.legenda === 'string' ? b.legenda.slice(0, 2200) : c.legenda;
  db.prepare('UPDATE conteudo SET status = ?, legenda = ? WHERE id = ?').run(status, legenda, c.id);
  res.json({ ok: true });
});

module.exports = { router, tick, resumo, controller, resumoFin, nomes, montarLista, listaDeHoje, contatoFeito, gerarSemana, registrar, dataStr, semanaDe, MSG };
