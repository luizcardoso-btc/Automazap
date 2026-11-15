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

const PAPEIS = { cto: 'CTO · Gestor de marketing', gerente: 'Gerente geral', atendente: 'Atendente', prospectora: 'Prospectora', conteudo: 'Editor de vídeo', copy_video: 'Copywriter de vídeo', imagem: 'Designer de imagem', copy_imagem: 'Copywriter de imagem', social: 'Social media', financeiro: 'CFO', recepcao: 'Recepcionista' };
const NOMES0 = { cto: 'Rafael', gerente: 'Helena', atendente: 'Sofia', prospectora: 'Bianca', conteudo: 'Theo', copy_video: 'Davi', imagem: 'Lia', copy_imagem: 'Nina', social: 'Renan', financeiro: 'Otávio', recepcao: 'Clara' };
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
  // Com o Raio-X feito, a abertura compara com o vizinho do mesmo ramo: é o argumento mais forte.
  try { const x = p.raiox && JSON.parse(p.raiox); if (x && x.lider && x.lider.avaliacoes > (p.avaliacoes || 0) * 1.3 && x.lider.avaliacoes >= 20) return `Vi no Google que ${p.nome} tem ${p.avaliacoes || 0} avaliações e que ${x.lider.nome}, aqui perto, já tem ${x.lider.avaliacoes}. Quem procura pelo ramo costuma ir em quem tem mais estrelas.`; } catch (e) { /* sem Raio-X */ }
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


// ======================= MARKETING (2º andar): Theo + Davi (copy de vídeo) · Lia (imagem) + Nina (copy de imagem) =======================
// Tudo sai do calendário da semana do Theo. Davi escreve os roteiros dos vídeos; Nina escreve os textos das imagens;
// Lia transforma os textos da Nina em comandos para o ChatGPT (grátis) e guarda as imagens no banco de artes do NexTap.
const frases = t => String(t || '').split('\n\n#')[0].replace(/\s+/g, ' ').split(/(?<=[.!?…])\s+/).map(x => x.replace(/^[^\p{L}\p{N}"“]+/u, '').trim()).filter(x => x.length > 2);
const ctaDe = t => { const m = /Comente ((?:[A-ZÇÃÕÉÊÍÓÚ]{2,}\s?){1,4})/.exec(String(t || '')); return m ? `Comente ${m[1].trim()}` : 'Chama no direct'; };
const linhasRoteiro = r => String(r || '').split('\n').map(l => l.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
const curto = (t, n = 7) => { const w = String(t).replace(/["“”]/g, '').split(/\s+/); return w.length > n ? w.slice(0, n).join(' ') + '…' : w.join(' '); };
const GANCHOS = {
  'Como funciona': ['Seu cliente não avalia porque dá trabalho. Olha isso:', 'Avaliação no Google sem aplicativo? Assim:'],
  'Quebra de objeção': ['Todo mundo me fala isso antes de comprar…', 'Eu também pensava assim. Até ver isto:'],
  'Oferta': ['Quanto custa ter mais avaliações no Google?', 'Seu primeiro pedido é mais simples do que parece.'],
  'Prova social': ['Olha o que aconteceu neste balcão:', 'Mais uma empresa da região usando isto:'],
  'Revenda e lucro': ['Faça esta conta comigo:', 'Renda extra com uma placa de acrílico? Sim.'],
};
// Davi: roteiro completo de cada vídeo (3 ganchos para testar, cenas com fala e texto na tela, CTA e legenda)
function copyVideo(c) {
  const fala = frases(c.legenda).filter(x => !/^Comente /i.test(x)), cenas = linhasRoteiro(c.roteiro), cta = ctaDe(c.legenda);
  const ganchos = [c.gancho, ...(GANCHOS[c.pilar] || ['Você precisa ver isto:', 'Pare de perder clientes no Google.'])].filter(Boolean).slice(0, 3);
  return { id: c.id, dia: c.dia, formato: c.formato, pilar: c.pilar, titulo: c.titulo, status: c.status, ganchos, cta, legenda: c.legenda,
    cenas: cenas.map((l, i) => { const m = /^([\d–-]+s):\s*(.*)$/.exec(l), acao = m ? m[2] : l, ult = i === cenas.length - 1;
      const f = i === 0 ? c.gancho : ult ? cta + ' que eu te explico no direct.' : (fala[i - 1] || '');
      return { tempo: m ? m[1] : `${i * 3}–${i * 3 + 3}s`, acao, fala: f || '(sem fala: só a imagem e a música)', tela: ult ? cta : curto(f || acao.replace(/^["“]|["”]$/g, ''), 6) }; }),
    duracao_s: Math.max(9, cenas.length * 3) };
}
// ---------- Banco de pautas (a Nina escreve, a Lia transforma em comando, o CTO aprova) ----------
const CARROSSEIS = [
  { titulo: '5 lugares para a placa', pilar: 'Como funciona', slides: [
    ['5 lugares onde a placa traz mais avaliações', 'Arraste para o lado →', 'placa de acrílico NexTap em destaque sobre um balcão de madeira, comércio desfocado ao fundo'],
    ['1. No caixa', 'O cliente acabou de pagar e está satisfeito', 'placa de acrílico ao lado da maquininha de cartão no caixa de uma loja'],
    ['2. Na mesa', 'Enquanto espera a conta', 'placa de acrílico sobre a mesa de um restaurante, pratos ao fundo'],
    ['3. Na recepção', 'Na saída da consulta ou do serviço', 'placa de acrílico no balcão da recepção de uma clínica'],
    ['4. No espelho', 'Na hora em que o cliente vê o resultado', 'placa de acrílico na bancada de uma barbearia, espelho ao fundo'],
    ['5. Na sacola', 'O QR Code vai junto para casa', 'sacola de loja com um cartão com QR Code preso, sobre o balcão'],
    ['Quer a sua?', 'Comente COMO FUNCIONA', 'placa de acrílico NexTap em destaque sobre fundo escuro com luz verde-limão'] ],
    legenda: 'O lugar da placa muda o resultado. 📍\n\nColoque onde o cliente termina o atendimento satisfeito: caixa, mesa, recepção, espelho ou sacola.\n\nComente COMO FUNCIONA que eu te explico no direct.' },
  { titulo: 'Por que o cliente não avalia', pilar: 'Quebra de objeção', slides: [
    ['Por que o seu cliente não avalia você no Google?', 'Arraste para o lado →', 'dono de comércio brasileiro olhando o celular com expressão pensativa atrás do balcão'],
    ['Ele esquece', 'Saiu da loja, a vida continua', 'cliente saindo de uma loja com sacolas, de costas, rua ao fundo'],
    ['Dá trabalho', 'Abrir o Google, procurar a empresa, achar o botão…', 'mão segurando um celular, pessoa com expressão de impaciência'],
    ['Ninguém pediu', 'Quem não é lembrado não é avaliado', 'atendente e cliente se despedindo no balcão'],
    ['Com a placa é um toque', 'Aproximou o celular, a avaliação abre', 'close de um celular se aproximando de uma placa de acrílico no balcão'],
    ['Facilite e peça na hora', 'Comente COMO FUNCIONA', 'placa de acrílico NexTap em destaque sobre fundo escuro com luz verde-limão'] ],
    legenda: 'Cliente satisfeito quase nunca avalia sozinho: ele esquece, acha trabalhoso e ninguém pediu. 😅\n\nCom a NexTap é só aproximar o celular da placa, na hora em que ele está feliz com o atendimento.\n\nComente COMO FUNCIONA que eu te mostro.' },
  { titulo: 'NFC ou QR Code', pilar: 'Como funciona', slides: [
    ['NFC ou QR Code: qual usar?', 'Arraste para o lado →', 'placa de acrílico com área para QR Code e símbolo de aproximação, sobre balcão claro'],
    ['NFC: é só aproximar', 'Sem abrir a câmera, sem aplicativo', 'celular encostando levemente em uma placa de acrílico'],
    ['QR Code: é só apontar a câmera', 'Para quem não tem NFC no celular', 'pessoa apontando a câmera do celular para uma placa de acrílico a um palmo de distância'],
    ['A NexTap tem os dois', 'Nenhum cliente fica de fora', 'dois clientes diferentes usando a mesma placa de acrílico no balcão'],
    ['Quer ver funcionando?', 'Comente COMO FUNCIONA', 'placa de acrílico NexTap em destaque sobre fundo escuro com luz verde-limão'] ],
    legenda: 'Com NFC o cliente só aproxima o celular. Com QR Code ele aponta a câmera. A NexTap tem os dois, então funciona em qualquer celular. ✅\n\nComente COMO FUNCIONA que eu te mando os detalhes.' },
  { titulo: 'Quem precisa de avaliação', pilar: 'Revenda e lucro', slides: [
    ['6 negócios que vivem de avaliação no Google', 'Arraste para o lado →', 'rua de comércio de bairro brasileiro com várias fachadas, luz de fim de tarde'],
    ['Barbearias e salões', 'O cliente escolhe pelas estrelas', 'interior de barbearia moderna com cadeira e espelho'],
    ['Restaurantes e lanchonetes', 'Fome + Google = decisão em segundos', 'mesa de restaurante com prato bonito e ambiente aconchegante'],
    ['Clínicas e consultórios', 'Confiança começa na nota', 'recepção de clínica clara e organizada'],
    ['Oficinas e lava-jatos', 'Ninguém entrega o carro para nota baixa', 'oficina mecânica limpa com carro no elevador'],
    ['Pet shops e lojas', 'Indicação que fica registrada', 'balcão de pet shop com atendente sorrindo'],
    ['Conhece algum desses?', 'Comente REVENDER', 'placa de acrílico NexTap em destaque sobre fundo escuro com luz verde-limão'] ],
    legenda: 'Barbearia, restaurante, clínica, oficina, pet shop: todo negócio local depende das estrelas no Google. ⭐\n\nRevendendo a NexTap você ajuda essas empresas e ganha por placa.\n\nComente REVENDER que eu te mostro como começar.' },
  { titulo: 'Do pedido ao balcão', pilar: 'Bastidores', slides: [
    ['Do pedido ao balcão: como a sua placa chega', 'Arraste para o lado →', 'caixa de papelão aberta com placas de acrílico embaladas, mesa de trabalho'],
    ['1. Você faz o pedido', 'Pelo site, em poucos minutos', 'pessoa fazendo um pedido no celular, sentada em um café'],
    ['2. Produzimos a placa', 'Acrílico com NFC e QR Code', 'placas de acrílico alinhadas em uma bancada de produção limpa'],
    ['3. Enviamos para você', 'Com código de rastreio', 'pacote sendo lacrado com fita em uma mesa de expedição'],
    ['4. Configure o link', 'Leva menos de um minuto', 'mãos segurando celular ao lado de uma placa de acrílico sobre a mesa'],
    ['5. Coloque no balcão', 'E peça a avaliação na hora', 'placa de acrílico posicionada no balcão de uma loja, cliente ao fundo'],
    ['Quer a sua?', 'Comente COMO FUNCIONA', 'placa de acrílico NexTap em destaque sobre fundo escuro com luz verde-limão'] ],
    legenda: 'Do pedido ao balcão é simples: você pede pelo site, nós produzimos e enviamos com rastreio, e a placa fica pronta para usar em menos de um minuto. 📦\n\nComente COMO FUNCIONA que eu te explico.' },
  { titulo: '3 erros com avaliações', pilar: 'Autoridade', slides: [
    ['3 erros que travam as suas avaliações', 'Arraste para o lado →', 'dono de loja olhando para a tela de um notebook com expressão preocupada'],
    ['Erro 1: esperar o cliente lembrar', 'Peça na hora em que ele está satisfeito', 'cliente sorrindo recebendo o produto no balcão'],
    ['Erro 2: mandar link depois', 'Mensagem no dia seguinte quase ninguém abre', 'celular sobre a mesa com notificações, visto de cima'],
    ['Erro 3: não responder quem avaliou', 'Responder mostra cuidado', 'pessoa digitando no celular com um café ao lado'],
    ['O certo: um toque, na hora', 'A placa no balcão faz o pedido por você', 'close de celular se aproximando de uma placa de acrílico'],
    ['Quer parar de errar?', 'Comente COMO FUNCIONA', 'placa de acrílico NexTap em destaque sobre fundo escuro com luz verde-limão'] ],
    legenda: 'Esperar o cliente lembrar, mandar o link só depois e não responder quem avaliou: três erros comuns que seguram a nota. 💡\n\nCom a placa no balcão o pedido acontece na hora certa.\n\nComente COMO FUNCIONA.' },
];
const POSTS = [
  ['Onde colocar a placa', 'Coloque a placa onde o cliente sai satisfeito', 'Caixa, mesa ou recepção', 'placa de acrílico NexTap no balcão do caixa de uma loja, cliente sorrindo pagando ao fundo', 'COMO FUNCIONA'],
  ['Avaliação em um toque', 'Aproximou, avaliou.', 'Sem aplicativo, em qualquer celular', 'close de uma mão aproximando o celular de uma placa de acrílico sobre o balcão', 'COMO FUNCIONA'],
  ['Estrelas vendem', 'Cliente novo escolhe pelas estrelas', 'Quantas avaliações você tem hoje?', 'pessoa na rua olhando o celular para escolher um restaurante, fachada de comércio ao fundo', 'COMO FUNCIONA'],
  ['NFC + QR Code', 'Com NFC ou QR Code, ninguém fica de fora', 'Funciona em qualquer celular', 'dois celulares diante de uma placa de acrílico, um aproximando e outro lendo com a câmera', 'COMO FUNCIONA'],
  ['Revenda', 'Venda para os negócios da sua cidade', 'Renda extra com placas NexTap', 'pessoa empreendedora mostrando uma placa de acrílico ao dono de uma barbearia', 'REVENDER'],
  ['Pronta em um minuto', 'Recebeu, configurou, colocou no balcão', 'Leva menos de um minuto', 'caixa aberta com uma placa de acrílico dentro, sobre mesa de madeira clara', 'COMO FUNCIONA'],
  ['Peça na hora certa', 'O melhor momento para pedir avaliação é agora', 'Enquanto o cliente ainda está no balcão', 'atendente sorrindo e apontando para uma placa de acrílico no balcão', 'COMO FUNCIONA'],
  ['Responda as avaliações', 'Quem responde avaliação ganha confiança', 'Dica rápida de hoje', 'dono de negócio respondendo mensagens no celular, sentado no balcão da loja', 'COMO FUNCIONA'],
  ['Além do Google', 'Uma placa, vários destinos', 'Google, Instagram, WhatsApp, cardápio ou Pix', 'várias placas de acrílico de modelos diferentes alinhadas sobre um balcão escuro', 'COMO FUNCIONA'],
  ['Para quem revende', 'Todo comércio da sua rua é um cliente possível', 'Comece com poucas placas', 'rua de comércio de bairro com lojas abertas, luz da manhã', 'REVENDER'],
  ['Primeira impressão', 'Antes de entrar, o cliente olha a sua nota', 'Cuide dela todos os dias', 'pessoa em frente a uma vitrine consultando o celular antes de entrar', 'COMO FUNCIONA'],
  ['Simples de usar', 'Seu cliente não precisa baixar nada', 'É só aproximar o celular', 'senhora de meia-idade aproximando o celular de uma placa de acrílico, sorrindo', 'COMO FUNCIONA'],
];
// Stories publicados pela API não aceitam figurinha (enquete, caixinha, quiz): a interação é pedir uma resposta ao story, que cai no direct.
const STORIES = [
  ['Pergunta', 'Você pede avaliação para os seus clientes?', 'Responda SIM ou NÃO aqui', 'balcão de loja com uma placa de acrílico, visto de frente'],
  ['Dúvidas', 'Qual é a sua maior dúvida sobre a placa?', 'Responda este story que eu explico', 'placa de acrílico NexTap segurada por uma mão, fundo desfocado'],
  ['Bastidores', 'Pedidos de hoje saindo', 'Embalados um a um', 'mesa de expedição com caixas e placas de acrílico sendo embaladas'],
  ['Dica rápida', 'Coloque a placa perto do caixa', 'Dica de 5 segundos', 'placa de acrílico ao lado da maquininha de cartão'],
  ['Você sabia?', 'O cliente não precisa baixar nenhum aplicativo', 'É só aproximar o celular', 'celular encostando em uma placa de acrílico'],
  ['Chamada', 'Quer ver a placa funcionando?', 'Responda EU QUERO', 'close de celular abrindo uma tela de avaliação ao se aproximar da placa'],
  ['Revenda', 'Já pensou em revender?', 'Responda REVENDER que eu te explico', 'pessoa segurando várias placas de acrílico, sorrindo'],
  ['Antes da visita', 'Você olha a nota antes de ir a um lugar novo?', 'Seu cliente também', 'pessoa consultando o celular na calçada, comércio ao fundo'],
  ['Novo post', 'Tem post novo no feed', 'Corre lá no perfil', 'celular sobre uma mesa mostrando um feed de rede social genérico, placa de acrílico ao lado'],
  ['Estrelas', 'Quantas avaliações você recebeu esta semana?', 'Responda com o número', 'cinco estrelas douradas de acrílico sobre um balcão escuro'],
];
db.exec(`CREATE TABLE IF NOT EXISTS mkt_pecas (id INTEGER PRIMARY KEY AUTOINCREMENT, dia TEXT NOT NULL, slot TEXT NOT NULL, canal TEXT NOT NULL, tipo TEXT NOT NULL,
  titulo TEXT NOT NULL, pilar TEXT NOT NULL DEFAULT '', slides TEXT NOT NULL DEFAULT '[]', legenda TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'aguardando',
  revisao TEXT NOT NULL DEFAULT '{}', versao INTEGER NOT NULL DEFAULT 0, criado_em INTEGER NOT NULL, UNIQUE(dia, slot))`);   // status: aguardando | ajustar | aprovado (texto ok) | programado (CEO aprovou as imagens) | postado | erro
const social = require('./social.js');   // Renan: imagens, fila de publicação e métricas (acrescenta as colunas dele em mkt_pecas)

// Cronograma: posts do feed por dia da semana (0 = domingo) e stories por dia. O CTO ajusta na sala dele.
const CRON0 = { feed: [0, 2, 1, 2, 1, 2, 2], stories: 2 };
function cronograma() { try { const o = JSON.parse(getSetting('mkt_cronograma') || 'null'); if (o && Array.isArray(o.feed) && o.feed.length === 7) return { feed: o.feed.map(x => Math.max(0, Math.min(3, x | 0))), stories: Math.max(0, Math.min(6, o.stories | 0)) }; } catch (e) { /* padrão */ } return CRON0; }
// Guia de estilo da Lia (o CTO treina e ajusta). É o comando-mestre colado uma vez em cada chat do ChatGPT.
const ESTILO0 = 'Você é o designer da NexTap, marca brasileira de placas de acrílico com NFC e QR Code que fazem o cliente avaliar a empresa no Google com um toque. Regras para TODAS as imagens deste chat: fotografia publicitária realista de comércio local brasileiro (pessoas e ambientes naturais, nada com cara de banco de imagens), luz natural suave, paleta escura (preto e grafite) com detalhes em verde-limão #C6F432, tipografia sem serifa bem grossa, branca, com uma palavra-chave em verde-limão. A placa NexTap é de acrílico, com área reservada para o QR Code: nunca desenhe um QR Code de verdade nem logotipos de outras marcas. Escreva SOMENTE o texto que eu pedir, em português do Brasil, com os acentos corretos, grande e legível no celular. Mantenha a mesma identidade em todas as imagens. Responda "pronto" e espere o primeiro pedido.';
const estilo = () => String(getSetting('mkt_estilo') || '').trim() || ESTILO0;
const FORMATO = { feed: 'formato vertical 4:5 (1080x1350)', stories: 'formato vertical 9:16 (1080x1920), deixando livres os 14% de cima e os 20% de baixo (área dos botões do Instagram)' };
function comando(p, s, i, n) {
  const onde = p.canal === 'stories' ? 'no centro da imagem' : `no terço ${i % 2 ? 'inferior' : 'superior'}`;
  return `${p.tipo === 'carrossel' ? `Imagem ${i + 1} de ${n} do carrossel "${p.titulo}"` : p.canal === 'stories' ? `Story "${p.titulo}"` : `Post do feed "${p.titulo}"`}, ${FORMATO[p.canal]}. Cena: ${s.visual}. Deixe uma área limpa ${onde} e escreva nela, grande, exatamente: "${s.texto}"${s.sub ? ` e, menor, logo abaixo: "${s.sub}"` : ''}. Mantenha o texto e tudo que é importante longe das bordas (margem de 12% em cada lado): a imagem será cortada na proporção do Instagram. Nenhum outro texto na imagem.${p.tipo === 'carrossel' && i ? ' Mesma paleta, mesma tipografia e mesma luz da imagem anterior.' : ''}`;
}
// Legenda da Lia: gancho com emoji do tema, os pontos do carrossel em lista, chamada que dispara o robô e hashtags do tema.
const TEMA = {
  'Como funciona': { e: ['⚡', '📲', '✅', '👆', '🔔'], h: '#qrcode #nfc #tecnologia #atendimentoaocliente #googlemeunegocio #dicasdenegocios' },
  'Quebra de objeção': { e: ['🤔', '💡', '✅', '👉', '🙌'], h: '#googlemeunegocio #marketinglocal #dicasdenegocios #clientes #reputacaoonline #vendas' },
  'Revenda e lucro': { e: ['💰', '🚀', '🤝', '📈', '🏪'], h: '#rendaextra #revenda #empreender #negociolocal #oportunidade #vendas' },
  'Bastidores': { e: ['📦', '🛠️', '✨', '🚚', '🙌'], h: '#bastidores #feitonobrasil #pequenosnegocios #entrega #produtopersonalizado #negociolocal' },
  'Autoridade': { e: ['⭐', '📈', '🏆', '💡', '✅'], h: '#reputacaoonline #googlemeunegocio #marketinglocal #dicasdenegocios #clientes #estrelasnogoogle' },
  'Prova social': { e: ['⭐', '🙌', '📍', '💚', '✅'], h: '#clientesatisfeito #provasocial #negociolocal #googlemeunegocio #marketinglocal #comerciolocal' },
};
const TEMA0 = { e: ['✨', '✅', '👉', '⭐', '📲'], h: '#googlemeunegocio #marketinglocal #dicasdenegocios #negociolocal #clientes #comerciolocal' };
function legendaRica(p, cta) {
  const t = TEMA[p.pilar] || TEMA0, sl = p.slides, semSeta = x => String(x || '').replace(/\s*→\s*$/, '').trim(), pt = x => (/[.!?…]$/.test(x) ? x : x + '.');
  const palavra = (/Comente ([A-ZÇÃÕÉÊÍÓÚ ]+)/.exec(cta || '') || [, 'COMO FUNCIONA'])[1].trim();
  const linhas = [`${t.e[0]} ${pt(semSeta(sl[0].texto))}`];
  if (sl.length > 2) { linhas.push(''); sl.slice(1, -1).forEach((x, i) => linhas.push(`${t.e[1 + (i % (t.e.length - 1))]} ${semSeta(x.texto)}${x.sub ? ': ' + semSeta(x.sub).replace(/^./, c => c.toLowerCase()) : ''}`)); }
  else if (sl[0].sub && !/Arraste/.test(sl[0].sub)) linhas.push('', `${t.e[1]} ${pt(semSeta(sl[0].sub))}`);
  linhas.push('', `👉 Comente ${palavra} que eu te explico no direct.`, sl.length > 1 ? '📌 Salve este post para consultar depois e envie para quem precisa ver.' : '📌 Salve para lembrar depois.');
  const hs = [...new Set((tags() + ' ' + t.h + ' #nextap').split(/\s+/).filter(Boolean))].slice(0, 12).join(' ');
  return (linhas.join('\n') + '\n\n' + hs).slice(0, 2200);
}
// Monta uma peça (Nina: textos e legenda · Lia: comandos). "v" troca o modelo quando o CTO pede outra versão.
function montarPeca(t0, slot, v = 0) {
  const dia = dataStr(t0), k = Math.floor(dia0(t0) / DIA) + v * 5, canal = slot.startsWith('story') ? 'stories' : 'feed', idx = Number(slot.slice(-1)) - 1;
  let p;
  if (canal === 'stories') { const s = STORIES[(k * 2 + idx * 3) % STORIES.length]; p = { tipo: 'story', titulo: s[0], pilar: 'Stories', slides: [{ texto: s[1], sub: s[2], visual: s[3] }], legenda: 'Story sem legenda: as respostas chegam no direct e o robô atende.' }; }
  else {
    const doisPosts = cronograma().feed[new Date(dia0(t0) - FUSO + 12 * 3600e3).getUTCDay()] >= 2;
    const cal = idx === 0 && !v ? db.prepare("SELECT * FROM conteudo WHERE dia = ? AND formato = 'Carrossel' ORDER BY id DESC LIMIT 1").get(dia) : null;
    if (cal) {
      const fr = frases(cal.legenda).filter(x => !/^Comente /i.test(x)), vis = linhasRoteiro(cal.roteiro), cta = ctaDe(cal.legenda);
      const sl = [{ texto: cal.gancho, sub: 'Arraste para o lado →', visual: vis[0] || 'placa de acrílico NexTap no balcão' }];
      fr.slice(0, 4).forEach((f, i) => sl.push({ texto: f, sub: '', visual: vis[i + 1] || vis[vis.length - 1] || 'cliente usando a placa no balcão' }));
      sl.push({ texto: cta, sub: 'Respondemos no direct', visual: 'placa de acrílico NexTap em destaque sobre fundo escuro com luz verde-limão' });
      p = { tipo: 'carrossel', titulo: cal.titulo, pilar: cal.pilar, slides: sl, legenda: cal.legenda };
    } else if (idx === 0 && doisPosts) {
      // Os temas que mais renderam (métricas do Renan) entram primeiro no rodízio
      const rk = social.desempenho(t0).ranking.map(x => x.pilar), ordem = rk.length >= 2 ? CARROSSEIS.slice().sort((a, b) => (rk.indexOf(a.pilar) + 1 || 99) - (rk.indexOf(b.pilar) + 1 || 99)) : CARROSSEIS;
      const c = ordem[k % ordem.length]; p = { tipo: 'carrossel', titulo: c.titulo, pilar: c.pilar, slides: c.slides.map(x => ({ texto: x[0], sub: x[1], visual: x[2] })), legenda: c.legenda + '\n\n' + tags() }; }
    else { const o = POSTS[(k + idx * 5) % POSTS.length]; p = { tipo: 'post', titulo: o[0], pilar: 'Post do dia', slides: [{ texto: o[1], sub: o[2], visual: o[3] }], legenda: `${o[1]}${/[.!?]$/.test(o[1]) ? '' : '.'} ${o[2]}${/[.!?]$/.test(o[2]) ? '' : '.'} ✨\n\nComente ${o[4]} que eu te explico no direct.\n\n${tags()}` }; }
  }
  if (canal === 'feed') p.legenda = legendaRica(p, ctaDe(p.legenda));
  p = { ...p, dia, slot, canal, versao: v };
  p.slides = p.slides.map((s, i) => ({ ...s, n: i + 1, prompt: comando(p, s, i, p.slides.length) }));
  return p;
}
// CTO: revisão de cada peça antes de liberar para gerar a imagem
const PROIBIDO = /(garant|100 ?%|dobr[ea]|triplic|fatur[ea] mais|sem falha|o melhor do brasil|últimos dias|só hoje)/i;
function revisar(p) {
  const notas = [], todos = p.slides.map(s => s.texto + ' ' + (s.sub || '')).join(' ') + ' ' + p.legenda;
  p.slides.forEach(s => { if (s.texto.length > 70) notas.push(`Imagem ${s.n}: texto longo demais para ler no celular (${s.texto.length} letras, máximo 70).`); if (/^[^\p{L}\p{N}"“]/u.test(s.texto)) notas.push(`Imagem ${s.n}: o texto começa com símbolo.`); });
  if (PROIBIDO.test(todos)) notas.push('Promessa de resultado ou urgência sem prova: troque por um benefício concreto.');
  if (p.canal === 'feed') { if (!/Comente [A-Z]{3,}/.test(p.legenda)) notas.push('A legenda não tem a chamada "Comente ..." que dispara o robô.'); if (!p.legenda.includes('#')) notas.push('Faltam as hashtags na legenda.'); if (p.legenda.length > 2200) notas.push('Legenda acima de 2.200 caracteres.'); }
  if (p.tipo === 'carrossel' && (p.slides.length < 4 || p.slides.length > 8)) notas.push(`Carrossel com ${p.slides.length} imagens: o ideal é de 4 a 8.`);
  if (db.prepare("SELECT 1 FROM mkt_pecas WHERE titulo = ? AND canal = ? AND dia < ? AND dia >= ?").get(p.titulo, p.canal, p.dia, dataStr(Date.parse(p.dia + 'T12:00:00-03:00') - (p.canal === 'feed' ? 10 : 3) * DIA))) notas.push('Mesmo tema usado há poucos dias neste canal.');
  return { ok: !notas.length, notas, em: Date.now() };
}
const SLOTS = t0 => { const c = cronograma(), f = c.feed[new Date(dia0(t0) - FUSO + 12 * 3600e3).getUTCDay()]; return [...Array.from({ length: f }, (_, i) => 'feed' + (i + 1)), ...Array.from({ length: c.stories }, (_, i) => 'story' + (i + 1))]; };
const lerPeca = r => social.ler(r);
const gravar = db.prepare(`INSERT INTO mkt_pecas (dia, slot, canal, tipo, titulo, pilar, slides, legenda, status, revisao, versao, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(dia, slot) DO UPDATE SET tipo = excluded.tipo, titulo = excluded.titulo, pilar = excluded.pilar, slides = excluded.slides, legenda = excluded.legenda, status = excluded.status, revisao = excluded.revisao, versao = excluded.versao, imagens = '[]', horario = '', erro = ''`);
// A Lia propõe; se o CTO reprovar, ela tenta outra versão (até 3). O que continuar reprovado fica em "ajustar" para você decidir.
function proporPeca(t0, slot, v0 = 0) {
  let p, r;
  for (let v = v0; v < v0 + 3; v++) { p = montarPeca(t0, slot, v); r = revisar(p); if (r.ok) break; }
  gravar.run(p.dia, slot, p.canal, p.tipo, p.titulo, p.pilar, JSON.stringify(p.slides), p.legenda, r.ok ? 'aprovado' : 'ajustar', JSON.stringify(r), p.versao, Date.now());
  return lerPeca(db.prepare('SELECT * FROM mkt_pecas WHERE dia = ? AND slot = ?').get(p.dia, slot));
}
function pecasDoDia(t0 = Date.now()) {
  const dia = dataStr(t0), slots = SLOTS(t0);
  for (const s of slots) if (!db.prepare('SELECT 1 FROM mkt_pecas WHERE dia = ? AND slot = ?').get(dia, s)) proporPeca(t0, s);
  return db.prepare('SELECT * FROM mkt_pecas WHERE dia = ? ORDER BY canal, slot').all(dia).filter(r => slots.includes(r.slot) || r.status === 'postado' || r.status === 'programado').map(lerPeca)
    .map(p => ({ ...p, horario: p.horario || social.horarioDe(p.slot, slots.filter(x => x.startsWith(p.canal === 'feed' ? 'feed' : 'story')).length), completa: social.completa(p) }));
}
function refazerPeca(id) {
  const r = db.prepare('SELECT * FROM mkt_pecas WHERE id = ?').get(id);
  if (!r) return null;
  return proporPeca(Date.parse(r.dia + 'T12:00:00-03:00'), r.slot, r.versao + 1);
}
// CTO: métricas das últimas 24h e recomendações
function metricasMkt(t0 = Date.now()) {
  const hoje0 = dia0(t0), ontem = dataStr(hoje0 - DIA), d7 = dataStr(hoje0 - 7 * DIA), hoje = dataStr(t0);
  const cont = (cond, ...a) => n(`SELECT COUNT(*) AS n FROM mkt_pecas WHERE ${cond}`, ...a);
  const plan = cont('dia = ?', ontem), post = cont("dia = ? AND status = 'postado'", ontem);
  const plan7 = cont('dia >= ? AND dia < ?', d7, hoje), post7 = cont("dia >= ? AND dia < ? AND status = 'postado'", d7, hoje);
  const leads = n("SELECT COUNT(*) AS n FROM contacts WHERE channel = 'instagram' AND created_at >= ? AND created_at < ?", hoje0 - DIA, hoje0);
  const leads7 = n("SELECT COUNT(*) AS n FROM contacts WHERE channel = 'instagram' AND created_at >= ? AND created_at < ?", hoje0 - 8 * DIA, hoje0 - DIA) / 7;
  const cliques = n('SELECT COUNT(DISTINCT contact_id) AS n FROM links WHERE last_click_at >= ? AND last_click_at < ?', hoje0 - DIA, hoje0);
  const vid = n("SELECT COUNT(*) AS n FROM conteudo WHERE semana = ? AND formato <> 'Carrossel' AND status = 'postado'", semanaDe(t0)), vidT = n("SELECT COUNT(*) AS n FROM conteudo WHERE semana = ? AND formato <> 'Carrossel'", semanaDe(t0));
  const rec = [];
  if (plan && post < plan) rec.push(`Ontem ficaram ${plan - post} peça(s) sem postar. Constância pesa mais que perfeição: poste as de hoje antes do meio-dia.`);
  if (plan7 && post7 / plan7 < 0.6) rec.push(`Na semana, só ${pct(post7, plan7)}% do cronograma foi postado. Se estiver pesado, diminua o cronograma na minha sala em vez de falhar dias.`);
  if (leads7 >= 1 && leads < leads7 * 0.6) rec.push(`Leads abaixo da média (${leads} ontem contra ${leads7.toFixed(1).replace('.', ',')} por dia): reforce a chamada "Comente COMO FUNCIONA" no post de hoje.`);
  if (leads7 >= 1 && leads > leads7 * 1.5) rec.push(`Leads acima da média (${leads} ontem): repita o tema de ontem em outro formato nesta semana.`);
  if (vidT && !vid && new Date(hoje0 - FUSO + 12 * 3600e3).getUTCDay() >= 4) rec.push(`Nenhum vídeo postado nesta semana (${vidT} roteiro(s) prontos com ${nomes().copy_video}).`);
  if (!rec.length) rec.push('Cronograma em dia. Mantendo o plano.');
  const des = social.desempenho(t0);
  if (des.melhor) rec.push(`Melhor post dos últimos 14 dias: "${des.melhor.titulo}" (${des.melhor.alcance} de alcance). ${des.ranking[0] ? `O tema "${des.ranking[0].pilar}" é o que mais engaja: ${nomes().copy_imagem} e ${nomes().imagem} vão puxar mais dele.` : ''}`);
  return { desempenho: des, ontem: { planejadas: plan, postadas: post, leads, cliques }, semana: { planejadas: plan7, postadas: post7, leads_media: Math.round(leads7 * 10) / 10, videos: `${vid}/${vidT}` }, recomendacoes: rec };
}
function marketingSemana(t0 = Date.now()) {
  const semana = semanaDe(t0), itens = db.prepare('SELECT * FROM conteudo WHERE semana = ? ORDER BY dia, id').all(semana);
  const m = ultimo('cto');
  return { semana, videos: itens.filter(c => c.formato !== 'Carrossel').map(copyVideo), imagens: itens.filter(c => c.formato === 'Carrossel').map(c => ({ id: c.id, dia: c.dia, titulo: c.titulo, status: c.status })),
    pecas: pecasDoDia(t0), social: social.painel(t0), estilo: estilo(), estilo_padrao: !String(getSetting('mkt_estilo') || '').trim(), cronograma: cronograma(), metricas: metricasMkt(t0),
    relatorio: m ? { titulo: m.titulo, texto: m.texto, em: m.criado_em } : null };
}
function turnoMarketing(t0 = Date.now(), { avisar = true } = {}) {
  const pecas = pecasDoDia(t0), dd = dataStr(t0).slice(8) + '/' + dataStr(t0).slice(5, 7), ok = pecas.filter(p => p.status === 'aprovado').length, aj = pecas.filter(p => p.status === 'ajustar').length;
  const feed = pecas.filter(p => p.canal === 'feed').length, st = pecas.length - feed, N = nomes(), semana = semanaDe(t0), mt = metricasMkt(t0);
  registrar('copy_imagem', `Textos de ${dd}`, `${pecas.length} peça(s) com texto e legenda.`, { dia: dataStr(t0) }, t0);
  registrar('imagem', `Pauta de ${dd}`, `${feed} post(s) e ${st} story(ies): ${pecas.reduce((a, p) => a + p.slides.length, 0)} comando(s) enviados ao ${N.cto} para aprovar.`, { dia: dataStr(t0) }, t0);
  if (!db.prepare("SELECT 1 FROM agentes_log WHERE agente = 'copy_video' AND titulo = ?").get('Roteiros da semana ' + semana.split('-').reverse().join('/')))
    registrar('copy_video', 'Roteiros da semana ' + semana.split('-').reverse().join('/'), `${n("SELECT COUNT(*) AS n FROM conteudo WHERE semana = ? AND formato <> 'Carrossel'", semana)} roteiro(s) de vídeo para o ${N.conteudo}.`, { semana }, t0);
  const texto = [`✅ Pauta de hoje: ${ok} peça(s) aprovada(s)${aj ? ` e ${aj} para ajustar` : ''} (${feed} no feed, ${st} nos stories).`,
    `📊 Ontem: ${mt.ontem.postadas} de ${mt.ontem.planejadas} peça(s) postada(s), ${mt.ontem.leads} lead(s) pelo Instagram, ${mt.ontem.cliques} clique(s) no pedido.`,
    ...(mt.desempenho.com_dados ? [`👀 Alcance de ontem no feed: ${mt.desempenho.ontem.alcance} pessoa(s), ${mt.desempenho.ontem.engajamento} ponto(s) de engajamento (curtidas, comentários, salvamentos e envios).`] : []),
    `📅 Últimos 7 dias: ${mt.semana.postadas} de ${mt.semana.planejadas} peça(s) postada(s), média de ${String(mt.semana.leads_media).replace('.', ',')} lead(s) por dia, vídeos da semana ${mt.semana.videos}.`,
    '', 'Recomendações:', ...mt.recomendacoes.map(x => '• ' + x)].join('\n');
  registrar('cto', `Métricas e aprovações de ${dd}`, texto, { dia: dataStr(t0), aprovadas: ok, ajustar: aj, ...mt.ontem }, t0);
  if (avisar) require('./notificacoes.js').notificar({ tipo: 'resumo', titulo: `📈 ${N.cto} (CTO): pauta de ${dd} aprovada`, texto: `${ok} peça(s) prontas para gerar no ChatGPT${aj ? ` · ${aj} para ajustar` : ''} · ontem ${mt.ontem.postadas}/${mt.ontem.planejadas} postadas`, url: '/#predio' }).catch(() => {});
  return { pecas, texto };
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
  try { const pc = pecasDoDia(t0), fal = pc.filter(x => x.status !== 'postado'); if (fal.length) prioridades.push(`🖼 ${quem('imagem')}: ${fal.length} peça(s) de hoje para gerar no ChatGPT e postar (${pc.filter(x => x.status === 'ajustar').length} aguardando ajuste do ${nomes().cto}).`); } catch (e) { /* sem pauta */ }
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
  // O resumo completo também vai para o WhatsApp do CEO (se o número estiver informado e o WhatsApp ligado)
  if (avisar) require('./whatsapp.js').avisarDono(`☀️ *${nomes().gerente} · ${titulo}*\n\n${texto}`).then(r => { if (!r.ok && getSetting('ceo_whatsapp')) console.warn('[PRÉDIO] resumo no WhatsApp:', r.motivo); }).catch(() => {});
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
  try { turnoMarketing(t0); } catch (e) { console.error('[PRÉDIO] marketing:', e.message); }
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
    ceo: vendedor(),
    feed: db.prepare('SELECT agente, titulo, criado_em FROM agentes_log ORDER BY id DESC LIMIT 12').all(),
    gerente: g ? { titulo: g.titulo, texto: g.texto, em: g.criado_em, prioridades: g.dados.prioridades || 0, novos: g.dados.novos || 0, vendas: g.dados.vendas || 0 } : null,
    atendente: { novas: n("SELECT COUNT(*) AS n FROM nao_entendidas WHERE status = 'nova'"), ensinadas: n("SELECT COUNT(*) AS n FROM nao_entendidas WHERE status = 'ensinada'"),
      menus7: n("SELECT COUNT(*) AS n FROM messages m JOIN flows f ON f.id = m.flow_id WHERE f.event = 'nao_entendi' AND m.direction = 'out' AND m.created_at >= ?", s7),
      corrigidas7: n("SELECT COUNT(*) AS n FROM agentes_log WHERE agente = 'atendente' AND criado_em >= ?", s7) },
    prospectora: l ? { total: l.itens.length, feitos: l.itens.filter(i => i.feito).length, proxima: proxima ? proxima.nome : null } : null,
    marketing: (() => { try { const pc = pecasDoDia(); return { videos: n("SELECT COUNT(*) AS n FROM conteudo WHERE semana = ? AND formato <> 'Carrossel'", sem), hoje: { pecas: pc.length, imagens: pc.reduce((a, p) => a + p.slides.length, 0), aprovadas: pc.filter(p => p.status === 'aprovado').length, programadas: pc.filter(p => p.status === 'programado').length, erros: pc.filter(p => p.status === 'erro').length, proxima: (pc.filter(p => p.status === 'programado').sort((a, b) => a.horario.localeCompare(b.horario))[0] || {}).horario || '', ajustar: pc.filter(p => p.status === 'ajustar').length, postadas: pc.filter(p => p.status === 'postado').length, feed: pc.filter(p => p.canal === 'feed').length } }; } catch (e) { return null; } })(),
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
  res.json({ dados: fin(), erro: getSetting('nextap_fin_erro') || '', admin: nx.adminNextap(), configurado: nx.conectado(),
    avisos: db.prepare("SELECT id, titulo, texto, criado_em FROM agentes_log WHERE agente = 'financeiro' ORDER BY id DESC LIMIT 20").all() });
});
router.post('/financeiro/atualizar', async (req, res) => {
  try { const j = await require('./nextap.js').atualizarFinanceiro(); if (!j) return res.status(400).json({ error: 'O Automazap ainda não está conectado ao NexTap. Toque em "Conectar ao NexTap".' }); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: getSetting('nextap_fin_erro') || e.message }); }
});
// Theo + banco de artes do NexTap (ChatGPT grátis ou API da OpenAI no NexTap)
const nxArtes = (fn) => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(e.status && e.status < 600 ? e.status : 502).json({ error: e.message }); } };
// Botão "Conectar ao NexTap": gera o código de uso único e devolve o link da página de conexão do NexTap
router.post('/nextap/conectar', (req, res) => {
  const nx = require('./nextap.js'), base = nx.baseNx() || 'https://www.nextapbrasil.com.br';
  const codigo = require('crypto').randomBytes(24).toString('hex');
  setSetting('nextap_parear', JSON.stringify({ codigo, exp: Date.now() + 10 * 60e3 }));
  const volta = `${req.protocol}://${req.get('host')}`;
  res.json({ url: `${base}/admin/conectar-automazap?volta=${encodeURIComponent(volta)}&codigo=${codigo}`, conectado: nx.conectado(), base });
});
router.get('/nextap/status', (req, res) => { const nx = require('./nextap.js'); res.json({ conectado: nx.conectado(), base: nx.baseNx(), por_variavel: !!process.env.NEXTAP_WEBHOOK_SECRET }); });
router.get('/artes', nxArtes(req => require('./nextap.js').artes('GET', '?destino=' + encodeURIComponent(req.query.destino || '') + '&pedido=' + encodeURIComponent(req.query.pedido || '') + '&limite=60')));
router.post('/artes/prompt', nxArtes(req => require('./nextap.js').artes('POST', '/prompt', req.body || {})));
router.post('/artes', nxArtes(async req => { const a = await require('./nextap.js').artes('POST', '', req.body || {}); registrar('conteudo', `Arte enviada ao banco: ${a.titulo}`, a.destino, {}); return a; }));
router.post('/artes/gerar', nxArtes(async req => { const a = await require('./nextap.js').artes('POST', '/gerar', req.body || {}); registrar('conteudo', `Arte gerada pela API: ${a.titulo}`, a.destino, {}); return a; }));
router.put('/artes/limite', nxArtes(req => require('./nextap.js').artes('PUT', '/limite', req.body || {})));
router.put('/artes/:id', nxArtes(req => require('./nextap.js').artes('PUT', '/' + Number(req.params.id), req.body || {})));
router.delete('/artes/:id', nxArtes(async req => { const r = await require('./nextap.js').artes('DELETE', '/' + Number(req.params.id)); registrar('conteudo', `Arte #${Number(req.params.id)} excluída do banco`, '', {}); return r; }));
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
router.get('/marketing', (req, res) => { gerarSemana(); res.json(marketingSemana(Date.now())); });
router.put('/marketing/config', (req, res) => {
  const b = req.body || {};
  if (b.cronograma) { const c = b.cronograma; if (!Array.isArray(c.feed) || c.feed.length !== 7 || c.feed.some(x => !Number.isInteger(x) || x < 0 || x > 3) || !Number.isInteger(c.stories) || c.stories < 0 || c.stories > 6) return res.status(400).json({ error: 'Cronograma inválido: até 3 posts por dia e até 6 stories.' }); setSetting('mkt_cronograma', JSON.stringify({ feed: c.feed, stories: c.stories })); }
  if (typeof b.estilo === 'string') { if (b.estilo.length > 4000) return res.status(400).json({ error: 'Guia de estilo muito longo (máximo 4.000 caracteres).' }); setSetting('mkt_estilo', b.estilo.trim()); registrar('cto', 'Guia de estilo atualizado', 'Os próximos comandos já usam o novo guia.', {}); }
  res.json(marketingSemana(Date.now()));
});
router.post('/marketing/pecas/:id/refazer', (req, res) => { const p = refazerPeca(Number(req.params.id)); if (!p) return res.status(404).json({ error: 'Peça não encontrada.' }); res.json(p); });
router.put('/marketing/pecas/:id', (req, res) => {
  const b = req.body || {}, r = db.prepare('SELECT * FROM mkt_pecas WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Peça não encontrada.' });
  const status = ['aprovado', 'postado', 'ajustar'].includes(b.status) ? b.status : r.status;
  if (typeof b.horario === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.horario)) db.prepare('UPDATE mkt_pecas SET horario = ? WHERE id = ?').run(b.horario, r.id);
  db.prepare('UPDATE mkt_pecas SET status = ?, legenda = ? WHERE id = ?').run(status, typeof b.legenda === 'string' ? b.legenda.slice(0, 2200) : r.legenda, r.id);
  if (status === 'postado' && r.status !== 'postado') db.prepare('UPDATE mkt_pecas SET postado_em = ? WHERE id = ?').run(Date.now(), r.id);
  if (status === 'postado' && r.status !== 'postado') registrar('imagem', `Postado: ${r.titulo}`, r.canal === 'feed' ? 'No feed.' : 'Nos stories.', {});
  res.json(lerPeca(db.prepare('SELECT * FROM mkt_pecas WHERE id = ?').get(r.id)));
});
const tratarMk = fn => async (req, res) => { try { res.json(await fn(req)); } catch (e) { if (!e.status) console.error('[MARKETING]', e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Falha no marketing.' }); } };
router.post('/marketing/pecas/:id/imagem', tratarMk(req => social.anexar(Number(req.params.id), Number((req.body || {}).i), (req.body || {}).data)));
router.post('/marketing/pecas/:id/aprovar', tratarMk(req => social.aprovar(Number(req.params.id), req.body || {})));
router.post('/marketing/pecas/:id/publicar', tratarMk(async req => { const p = await social.publicarPeca(Number(req.params.id)); if (p.status === 'erro') { const e = new Error(p.erro); e.status = 502; throw e; } return p; }));
router.put('/marketing/horarios', tratarMk(req => { social.salvarHorarios(req.body || {}); return marketingSemana(Date.now()); }));
router.post('/marketing/pecas/:id/legenda', tratarMk(req => { const p = lerPeca(db.prepare('SELECT * FROM mkt_pecas WHERE id = ?').get(req.params.id)); if (!p) { const e = new Error('Peça não encontrada.'); e.status = 404; throw e; } if (p.canal !== 'feed') { const e = new Error('Stories não têm legenda.'); e.status = 400; throw e; } const l = legendaRica(p, ctaDe(p.legenda)); if (p.status !== 'postado') db.prepare('UPDATE mkt_pecas SET legenda = ? WHERE id = ?').run(l, p.id); return { legenda: l }; }));
router.post('/marketing/relatorio', (req, res) => res.json(turnoMarketing(Date.now(), { avisar: false })));
router.post('/conteudo/gerar', (req, res) => res.json(gerarSemana(Date.now(), { forcar: true })));
router.put('/conteudo/:id', (req, res) => {
  const b = req.body || {}, c = db.prepare('SELECT * FROM conteudo WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Conteúdo não encontrado.' });
  const status = ['rascunho', 'aprovado', 'postado'].includes(b.status) ? b.status : c.status;
  const legenda = typeof b.legenda === 'string' ? b.legenda.slice(0, 2200) : c.legenda;
  db.prepare('UPDATE conteudo SET status = ?, legenda = ? WHERE id = ?').run(status, legenda, c.id);
  res.json({ ok: true });
});

module.exports = { router, tick, legendaRica, marketingSemana, copyVideo, pecasDoDia, montarPeca, revisar, refazerPeca, metricasMkt, turnoMarketing, cronograma, resumo, controller, resumoFin, nomes, montarLista, listaDeHoje, contatoFeito, gerarSemana, registrar, dataStr, semanaDe, MSG };
