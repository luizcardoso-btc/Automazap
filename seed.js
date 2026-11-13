// Fluxos da NexTap (versão 2: funil de qualificação). Edite tudo pelo painel.
//   semear()    → na primeira subida (nenhum fluxo): instala o funil.
//   instalarV2() → botão do painel: desativa os fluxos antigos (não apaga) e instala o funil novo.
const { db, getSetting, setSetting } = require('./db.js');

const NOME_ENTRADA = 'Entrada: REVENDER ou MEU NEGÓCIO';
const NOME_ENTRADA_V3 = 'Entrada: direto ao ponto';
const NOME_ENTRADA_V4 = 'Entrada: funil de vendas';

const NOME_ENTRADA_V5 = 'Entrada: 3 toques';

// Funil em que os fluxos criados agora entram (cada instalação cria o seu, para aparecer organizado no fluxograma)
let FUNIL = null;
const novoFunil = (nome, descricao) => (FUNIL = Number(db.prepare('INSERT INTO funis (nome, descricao, criado_em) VALUES (?, ?, ?)').run(nome, descricao, Date.now()).lastInsertRowid));
const ins = () => db.prepare(`INSERT INTO flows (name, active, priority, match_mode, keywords, on_comment, action, steps, created_at,
  kind, event, delay_hours, tags, human_priority, comment_text, audience, funil_id, variante_de) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const criar = (nome, passos, o = {}) => Number(ins().run(
  nome, o.prioridade || 0, o.modo || 'contem', JSON.stringify(o.palavras || []), o.comentario ? 1 : 0, o.acao || null,
  JSON.stringify(passos), Date.now(), o.tipo || 'normal', o.evento || null, o.atraso || 0, JSON.stringify(o.tags || []),
  o.humano || 0, o.textoComentario || null, o.tipo === 'followup' ? (o.publico || 'checkout') : null, FUNIL, o.varianteDe || null).lastInsertRowid);
// Primeiro fluxo ATIVO com um desses nomes (o funil v2 e o funil direto usam nomes diferentes)
const idPorNome = nomes => [].concat(nomes).map(n => (db.prepare('SELECT id FROM flows WHERE name = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(n) || {}).id).find(Boolean);

// Follow-ups de quem parou antes da calculadora e do caminho MEU NEGÓCIO (os de quem abriu a calculadora ficam em instalarV2/instalarV3).
// Respostas rápidas apontam para os fluxos do funil pelo nome; se algum foi renomeado/apagado, a mensagem vai sem esse botão.
function criarFollowupsEtapas() {
  const rapidas = (texto, opcoes) => {
    const replies = opcoes.map(([title, nome]) => ({ title, flow_id: idPorNome(nome) })).filter(r => r.flow_id);
    return replies.length ? { type: 'quick', text: texto, replies } : { type: 'text', text: texto };
  };
  const fu = (nome, passos, publico, atraso) => criar(nome, passos, { tipo: 'followup', publico, atraso, tags: ['FOLLOW-UP'] });

  fu('Follow-up (quantidade) 1: quantas placas?', [
    rapidas('Oi, {{nome}} 👋\nFicou alguma dúvida? Me diz com quantas placas você pensa em começar que eu te mostro o valor da sua faixa:',
      idPorNome('Venda: 5 a 10 placas')
        ? [['5–10', 'Venda: 5 a 10 placas'], ['11–49', 'Venda: 11 a 49 placas'], ['50–99', 'Venda: 50 a 99 placas (lead quente)'], ['100+', 'Venda: 100+ placas (lead quente)']]
        : [['1–10', ['Qtd 1–10', 'Quantidade: 1–10']], ['11–49', ['Qtd 11–49', 'Quantidade: 11–49']],
           ['50–299', ['Qtd 50–299 (lead quente)', 'Quantidade: 50–299 (lead quente)']], ['300+', ['Qtd 300+ (lead quente)', 'Quantidade: 300+ (lead quente)']]]),
  ], 'revenda_qtd', 2);
  fu('Follow-up (quantidade) final', [
    { type: 'text', text: 'Vou parar por aqui para não te incomodar 😄\nQuando quiser ver os valores de revenda, é só mandar "QUERO REVENDER" aqui. 💚' },
  ], 'revenda_qtd', 20);

  fu('Follow-up (preço) 1: link da calculadora', [
    { type: 'button', text: 'Oi, {{nome}} 👋\nDeixei aqui o link para você simular quanto fica começar com {{quantidade}} placas:', buttons: [{ title: 'CALCULAR MEU PEDIDO', url: '{{link}}' }] },
  ], 'revenda_preco', 2);
  fu('Follow-up (preço) 2: preço de revenda', [
    rapidas('Uma dúvida comum de quem está começando: dá para revender pelo preço que eu quiser?\nSim! Você compra direto conosco e define o seu preço final. Quer ajuda para escolher a quantidade?',
      [['QUERO AJUDA', 'Botão: QUERO AJUDA'], ['VER VALORES', 'Botão: VER VALORES']]),
  ], 'revenda_preco', 8);
  fu('Follow-up (preço) final', [
    { type: 'text', text: 'Vou encerrar por aqui para não ficar te incomodando 😄\nQuando quiser começar sua revenda Nextap, é só mandar "QUERO REVENDER" aqui que retomamos de onde paramos. 💚' },
  ], 'revenda_preco', 20);

  fu('Follow-up (meu negócio) 1: ver modelos', [
    { type: 'button', text: 'Oi, {{nome}} 👋\nConseguiu ver os modelos? Seu cliente aproxima o celular e já cai na avaliação da sua empresa no Google, sem app. ⭐', buttons: [{ title: 'VER MODELOS', url: '{{site}}' }] },
  ], 'negocio', 2);
  fu('Follow-up (meu negócio) final', [
    { type: 'text', text: 'Vou parar por aqui para não incomodar 😄\nQuando quiser a sua placa no balcão, é só mandar "MEU NEGÓCIO" aqui que continuamos. 💚' },
  ], 'negocio', 20);
}

// Bancos que já tinham o funil: acrescenta as sequências novas uma única vez (apagadas pelo painel, não voltam)
// (uma vez por funil: v2 ou funil direto)
function instalarFollowupsEtapas() {
  if (db.prepare('SELECT 1 FROM flows WHERE name IN (?, ?) AND active = 1').get(NOME_ENTRADA_V4, NOME_ENTRADA_V5)) return false;   // os funis de vendas trazem os próprios
  const v3 = db.prepare('SELECT 1 FROM flows WHERE name = ? AND active = 1').get(NOME_ENTRADA_V3);
  if (!v3 && !db.prepare('SELECT 1 FROM flows WHERE name = ?').get(NOME_ENTRADA)) return false;
  const flag = v3 ? 'followups_etapas_v3' : 'followups_etapas';
  if (getSetting(flag) === '1') return false;
  db.transaction(() => {
    FUNIL = (db.prepare('SELECT funil_id FROM flows WHERE name IN (?, ?) AND active = 1 ORDER BY id DESC LIMIT 1').get(NOME_ENTRADA_V3, NOME_ENTRADA) || {}).funil_id || null;
    if (!db.prepare("SELECT 1 FROM flows WHERE kind = 'followup' AND active = 1 AND audience <> 'checkout'").get()) criarFollowupsEtapas();
    setSetting(flag, '1');
  })();
  return true;
}

function instalarV2({ desativarAntigos = true } = {}) {
  if (!db.prepare('SELECT 1 FROM flows WHERE name = ?').get(NOME_ENTRADA)) novoFunil('Funil de qualificação (v2)', 'REVENDER / MEU NEGÓCIO → quantidade → demonstração → calculadora.');
  if (db.prepare('SELECT 1 FROM flows WHERE name = ?').get(NOME_ENTRADA)) return false;
  db.transaction(() => {
    if (desativarAntigos) db.prepare('UPDATE flows SET active = 0').run();

    // ---------- finais de funil ----------
    const jaVouComprar = criar('Botão: JÁ VOU COMPRAR', [
      { type: 'text', text: 'Perfeito. 🔥\nVou te deixar finalizar por lá. Se tiver qualquer dúvida com quantidade, pagamento ou envio, me chama aqui.' },
    ], { tipo: 'botao', tags: ['INTENÇÃO DE COMPRA', 'QUENTE'] });

    const queroAjuda = criar('Botão: QUERO AJUDA', [
      { type: 'text', text: 'Claro! 💚 Já avisei nosso time: em breve alguém te ajuda a escolher a quantidade ideal por aqui. Se preferir, chame no WhatsApp: {{telefone}}' },
    ], { tipo: 'botao', acao: 'handoff', humano: 1, tags: ['QUENTE'] });

    // Enviado ~25s depois que a pessoa clica no link da calculadora (link rastreado {{link}})
    criar('Depois do clique na calculadora', [
      { type: 'quick', text: 'Se quiser, eu também posso te ajudar a escolher a quantidade ideal para começar.', replies: [
        { title: 'QUERO AJUDA', flow_id: queroAjuda },
        { title: 'JÁ VOU COMPRAR', flow_id: jaVouComprar },
      ] },
    ], { tipo: 'evento', evento: 'clique_link' });

    const passoPreco = { type: 'button', text: 'Quer simular quanto ficaria seu primeiro pedido?', buttons: [{ title: 'CALCULAR MEU PEDIDO', url: '{{link}}' }] };

    const preco = criar('Botão: VER VALORES', [passoPreco], { tipo: 'botao', tags: ['VIU PREÇO'] });

    const comercial = criar('Botão: FALAR COM COMERCIAL', [
      { type: 'text', text: 'Perfeito! 🔥 Já avisei nosso time comercial e alguém vai falar com você por aqui, com prioridade. Se preferir, chame no WhatsApp: {{telefone}}' },
    ], { tipo: 'botao', acao: 'handoff', humano: 2, tags: ['QUENTE'] });

    // ---------- quantidade ----------
    const video = { type: 'video', url: '{{video_demo}}' };
    const eIsso = { type: 'text', text: 'É isso. Sem aplicativo e sem complicação.\nO cliente aproxima o celular ou lê o QR Code e vai direto para a avaliação.\nPara o revendedor, o diferencial é que você compra direto conosco e define seu próprio preço de venda.' };
    const pequeno = (nome, evento, faixa) => criar(nome, [
      { type: 'text', text: 'Boa! 💚 É um ótimo jeito de começar.\nAntes de eu te mostrar o valor, olha como o produto funciona na prática:' },
      video, eIsso, passoPreco,
    ], { tipo: 'botao', evento, tags: ['QUANTIDADE', 'QTD ' + faixa, 'VIU DEMO', 'VIU PREÇO'] });
    const grande = (nome, evento, faixa) => criar(nome, [
      { type: 'text', text: 'Excelente. Nesse volume você já entra nas melhores condições de atacado. 💚\nAntes de eu te mostrar o valor, olha como o produto funciona na prática:' },
      video, eIsso,
      { type: 'quick', text: 'Pelo volume que você selecionou, consigo te dar um atendimento comercial melhor.\nQuer falar com nosso time agora?', replies: [
        { title: 'FALAR COM COMERCIAL', flow_id: comercial },
        { title: 'VER VALORES', flow_id: preco },
      ] },
    ], { tipo: 'botao', evento, humano: 2, tags: ['QUANTIDADE', 'QTD ' + faixa, 'LEAD GRANDE', 'QUENTE', 'VIU DEMO'] });

    const q1 = pequeno('Quantidade: 1–10', 'qtd_1_10', '1-10');
    const q2 = pequeno('Quantidade: 11–49', 'qtd_11_49', '11-49');
    const q3 = grande('Quantidade: 50–299 (lead quente)', 'qtd_50_299', '50-299');
    const q4 = grande('Quantidade: 300+ (lead quente)', 'qtd_300', '300+');

    const revender = criar('REVENDER: quantas placas?', [
      { type: 'quick', text: 'Perfeito. 🚀\nA Nextap foi pensada para ser um produto simples de apresentar para negócios locais: o cliente aproxima o celular e cai direto na avaliação do Google.\nE você pode vender para barbearias, clínicas, lojas, salões, oficinas, academias e vários outros segmentos.\nQuantas placas você pensa em começar?', replies: [
        { title: '1–10', flow_id: q1 }, { title: '11–49', flow_id: q2 }, { title: '50–299', flow_id: q3 }, { title: '300+', flow_id: q4 },
      ] },
    ], { prioridade: 15, palavras: ['revender', 'revenda', 'revendedor', 'revendedora', 'quero revender', 'ser revendedor'],
      comentario: true, tags: ['REVENDEDOR'],
      textoComentario: 'Oi! 👋💚 Que bom ter você aqui na Nextap.\nPerfeito, vamos falar de revenda! 🚀 Quantas placas você pensa em começar? Pode responder por aqui com um número, por exemplo: 20' });

    // ---------- MEU NEGÓCIO ----------
    const negModelos = criar('Botão: VER MODELOS', [
      { type: 'image', url: '{{site}}/placa.jpg' },
      { type: 'button', text: 'Veja os modelos disponíveis e escolha o seu:', buttons: [{ title: 'VER MODELOS', url: '{{site}}' }] },
    ], { tipo: 'botao' });
    const negDemo = criar('Botão: SIM, ME MOSTRA', [
      video,
      { type: 'text', text: 'Agora imagina isso no seu balcão logo depois de um cliente satisfeito terminar o atendimento. 👀' },
      { type: 'quick', text: 'Quer ver os modelos disponíveis?', replies: [{ title: 'VER MODELOS', flow_id: negModelos }] },
    ], { tipo: 'botao', tags: ['VIU DEMO'] });
    const negocio = criar('MEU NEGÓCIO: ver funcionando', [
      { type: 'text', text: 'Perfeito. ⭐\nA Nextap ajuda seus clientes a encontrarem sua avaliação no Google em segundos.\nEm vez de procurar sua empresa, abrir o Google e localizar o perfil, ele simplesmente aproxima o celular.' },
      { type: 'quick', text: 'Quer ver funcionando?', replies: [{ title: 'SIM, ME MOSTRA', flow_id: negDemo }] },
    ], { prioridade: 15, palavras: ['meu negocio', 'minha empresa', 'minha loja', 'para meu negocio'], tags: ['MEU NEGÓCIO'] });

    // ---------- entrada ----------
    criar(NOME_ENTRADA, [
      { type: 'quick', text: 'Oi! 👋💚 Que bom ter você aqui na Nextap.\nAntes de te mandar valores, me diz uma coisa para eu te mostrar a melhor opção:\nVocê quer a Nextap para:', replies: [
        { title: '💰 REVENDER', flow_id: revender },
        { title: '🏪 MEU NEGÓCIO', flow_id: negocio },
      ] },
    ], { prioridade: 10, comentario: true,
      palavras: ['preco', 'valor', 'quanto custa', 'quanto e', 'quanto fica', 'quanto sai', 'orcamento', 'tabela', 'quero', 'eu quero', 'nfc', 'nextap', 'comprar', 'atacado', 'informacoes', 'info', 'interesse'],
      textoComentario: 'Oi! 👋💚 Que bom ter você aqui na Nextap.\nPara eu te mostrar a melhor opção, me responde por aqui: REVENDER (para revender) ou MEU NEGÓCIO (para usar no seu negócio).' });

    // ---------- objeções ----------
    criar('Objeção: Como funciona?', [
      { type: 'text', text: 'A placa possui NFC + QR Code. 📲\nNós configuramos para o perfil da empresa e o cliente aproxima o celular ou escaneia o QR Code.\nEle é direcionado para a página configurada sem precisar instalar aplicativo.' },
    ], { prioridade: 20, palavras: ['como funciona', 'funciona', 'como e', 'como usa', 'aproximar'] });
    criar('Objeção: Já tenho QR Code', [
      { type: 'text', text: 'Ótimo — e ele continua sendo útil.\nA vantagem da Nextap é adicionar também o NFC: o cliente pode simplesmente aproximar o celular.\nQuanto menos passos, mais simples fica a experiência.' },
    ], { prioridade: 20, palavras: ['ja tenho qr code', 'ja tenho qrcode', 'ja tenho qr', 'tenho qr code', 'tenho qr', 'qr code', 'qrcode'] });
    criar('Objeção: Está caro', [
      { type: 'text', text: 'Entendo. O ponto é que a Nextap não é apenas uma peça de acrílico.\nEla vira uma ferramenta permanente no balcão para facilitar avaliações de clientes todos os dias.\nPara revenda, você ainda define seu próprio preço final.' },
    ], { prioridade: 20, palavras: ['caro', 'esta caro', 'ta caro', 'muito caro', 'achei caro', 'desconto', 'mais barato', 'barato'] });
    criar('Prazo e entrega', [
      { type: 'text', text: 'A produção leva aproximadamente 5 dias úteis após a confirmação do pedido.\nDepois enviamos com rastreamento. 📦' },
    ], { prioridade: 20, palavras: ['prazo', 'entrega', 'frete', 'envio', 'correios', 'rastreio', 'quanto tempo', 'demora'] });
    criar('Nota fiscal', [
      { type: 'text', text: 'Sobre nota fiscal, vou chamar alguém da equipe para te explicar direitinho. Já já te respondemos! 🙂' },
    ], { prioridade: 20, palavras: ['nota fiscal', 'nf', 'nfe', 'cnpj', 'cpf', 'nota'], acao: 'handoff', humano: 1 });

    // ---------- atendente e parada (prioridades mais altas) ----------
    criar('Falar com atendente', [
      { type: 'text', text: 'Certo! Já avisei a nossa equipe e uma pessoa vai te responder em breve. Se preferir, chame no WhatsApp: {{telefone}} 💚' },
    ], { prioridade: 100, palavras: ['atendente', 'humano', 'falar com alguem', 'falar com pessoa', 'falar com atendente', 'suporte', 'ajuda'], acao: 'handoff', humano: 1 });
    // Busca exata de propósito: "preciso sair agora" não deve silenciar o robô por um ano.
    criar('Parar mensagens', [
      { type: 'text', text: 'Combinado, não envio mais mensagens automáticas. Se precisar, é só chamar! 👋' },
    ], { prioridade: 200, palavras: ['parar', 'sair', 'stop', 'cancelar', 'descadastrar'], acao: 'silenciar', modo: 'exato' });
    criar('Parar mensagens (frases)', [
      { type: 'text', text: 'Combinado, não envio mais mensagens automáticas. Se precisar, é só chamar! 👋' },
    ], { prioridade: 200, palavras: ['nao quero receber', 'nao quero mais receber', 'nao enviar', 'nao envie', 'pare de enviar'], acao: 'silenciar' });

    // ---------- follow-ups (só dentro da janela de 24h do Instagram) ----------
    const roteiro = criar('Botão: QUERO O ROTEIRO', [
      { type: 'text', text: 'Boa! 🙌 Vou pedir para alguém do time te enviar o roteiro de abordagem por aqui. Já já te chamamos.' },
    ], { tipo: 'botao', acao: 'handoff', humano: 1, tags: ['QUENTE'] });
    criar('Follow-up 1: conseguiu calcular?', [
      { type: 'text', text: 'Oi, {{nome}} 👋\nConseguiu calcular seu pedido da Nextap?\nSe estiver em dúvida entre {{quantidade}} placas e outra faixa, me fala que eu te ajudo a encontrar a melhor.' },
    ], { tipo: 'followup', atraso: 3, tags: ['FOLLOW-UP'] });
    criar('Follow-up 2: pergunta rápida', [
      { type: 'text', text: 'Uma dúvida rápida: sua ideia é começar vendendo pessoalmente para empresas da sua região ou pela internet?' },
    ], { tipo: 'followup', atraso: 9, tags: ['FOLLOW-UP'] });
    criar('Follow-up 3: roteiro', [
      { type: 'quick', text: 'Separei alguns dos segmentos onde nossos revendedores conseguem apresentar a Nextap com facilidade: clínicas, salões, barbearias, oficinas, restaurantes e lojas.\nQuer que eu te mande também nosso roteiro de abordagem comercial?', replies: [{ title: 'QUERO O ROTEIRO', flow_id: roteiro }] },
    ], { tipo: 'followup', atraso: 16, tags: ['FOLLOW-UP'] });
    criar('Follow-up final', [
      { type: 'text', text: 'Vou encerrar por aqui para não ficar te incomodando 😄\nQuando quiser começar sua revenda Nextap, é só mandar "QUERO REVENDER" aqui que retomamos de onde paramos. 💚' },
    ], { tipo: 'followup', atraso: 22, tags: ['FOLLOW-UP'] });
    criar('Resposta a um follow-up', [
      { type: 'text', text: 'Boa! 💚 Vou chamar alguém do time para continuar essa conversa com você por aqui.' },
    ], { tipo: 'evento', evento: 'resposta_followup', acao: 'handoff', humano: 1, tags: ['QUENTE'] });
    criarFollowupsEtapas();
    setSetting('followups_etapas', '1');
  })();
  return true;
}


// ---------------------------------------------------------------------------
// Funil DIRETO (v3): menos mensagens, sempre com chamada para calcular/comprar.
// Entrada → REVENDER/MEU NEGÓCIO → quantidade → (vídeo) + botão "calcular e comprar".
// Lead grande (50+) vai direto para o comercial. Só 2 follow-ups.
// ---------------------------------------------------------------------------

function instalarV3({ desativarAntigos = true } = {}) {
  if (db.prepare('SELECT 1 FROM flows WHERE name = ?').get(NOME_ENTRADA_V3)) return false;
  novoFunil('Funil direto (v3)', 'Menos mensagens, sempre com botão para calcular e comprar.');

  db.transaction(() => {
    if (desativarAntigos) db.prepare('UPDATE flows SET active = 0').run();
    const CALC = [{ title: 'CALCULAR E COMPRAR', url: '{{link}}' }];

    // ---------- fechamento ----------
    const jaVouComprar = criar('Botão: JÁ VOU COMPRAR', [
      { type: 'text', text: 'Perfeito! 🔥 Finalize pelo link da calculadora. Qualquer dúvida de pagamento ou envio, me chama aqui.' },
    ], { tipo: 'botao', tags: ['INTENÇÃO DE COMPRA', 'QUENTE'] });
    const queroAjuda = criar('Botão: QUERO AJUDA', [
      { type: 'text', text: 'Já avisei o time: em instantes alguém fecha com você por aqui. Se preferir, WhatsApp: {{telefone}} 💚' },
    ], { tipo: 'botao', acao: 'handoff', humano: 1, tags: ['QUENTE'] });
    criar('Depois do clique na calculadora', [
      { type: 'quick', text: 'Ficou alguma dúvida de quantidade ou pagamento? Eu te ajudo a fechar agora.', replies: [
        { title: 'QUERO AJUDA', flow_id: queroAjuda }, { title: 'JÁ VOU COMPRAR', flow_id: jaVouComprar },
      ] },
    ], { tipo: 'evento', evento: 'clique_link' });
    const comercial = criar('Botão: FALAR COM COMERCIAL', [
      { type: 'text', text: 'Combinado! 🔥 Já chamei o comercial: você será atendido com prioridade aqui mesmo. WhatsApp: {{telefone}}' },
    ], { tipo: 'botao', acao: 'handoff', humano: 2, tags: ['QUENTE'] });
    const preco = criar('Botão: VER VALORES', [
      { type: 'button', text: 'Aqui você vê o valor exato do seu pedido e já finaliza 👇', buttons: CALC },
    ], { tipo: 'botao', tags: ['VIU PREÇO'] });

    // ---------- quantidade ----------
    const video = { type: 'video', url: '{{video_demo}}' };
    const pequeno = (nome, evento, faixa, lbl) => criar(nome, [
      video,
      { type: 'button', text: `Sem app: o cliente aproxima o celular e cai direto na avaliação. Você compra direto da fábrica e define seu preço. Para ${lbl} placas o valor por unidade já cai. Veja quanto fica 👇`, buttons: CALC },
    ], { tipo: 'botao', evento, tags: ['QUANTIDADE', 'QTD ' + faixa, 'VIU DEMO', 'VIU PREÇO'] });
    const grande = (nome, evento, faixa, lbl) => criar(nome, [
      { type: 'quick', text: `Para ${lbl} placas você entra nas melhores condições de atacado. 💚\nQuer falar direto com o comercial ou ver os valores agora?`, replies: [
        { title: 'FALAR COM COMERCIAL', flow_id: comercial }, { title: 'VER VALORES', flow_id: preco },
      ] },
    ], { tipo: 'botao', evento, humano: 2, tags: ['QUANTIDADE', 'QTD ' + faixa, 'LEAD GRANDE', 'QUENTE'] });
    const q1 = pequeno('Qtd 1–10', 'qtd_1_10', '1-10', '1 a 10');
    const q2 = pequeno('Qtd 11–49', 'qtd_11_49', '11-49', '11 a 49');
    const q3 = grande('Qtd 50–299 (lead quente)', 'qtd_50_299', '50-299', '50 a 299');
    const q4 = grande('Qtd 300+ (lead quente)', 'qtd_300', '300+', '300 ou mais');

    const revender = criar('REVENDER: quantas placas?', [
      { type: 'quick', text: 'Boa! 🚀 Você compra direto da fábrica e define seu preço de venda. Quantas placas quer começar?', replies: [
        { title: '1–10', flow_id: q1 }, { title: '11–49', flow_id: q2 }, { title: '50–299', flow_id: q3 }, { title: '300+', flow_id: q4 },
      ] },
    ], { prioridade: 15, palavras: ['revender', 'revenda', 'revendedor', 'revendedora', 'quero revender', 'ser revendedor'], comentario: true, tags: ['REVENDEDOR'],
      textoComentario: 'Oi! 👋💚 Perfeito, vamos de revenda! Quantas placas você pensa em começar? Responda com um número, ex.: 20' });

    // ---------- MEU NEGÓCIO (1 mensagem) ----------
    const negocio = criar('MEU NEGÓCIO: ver modelos', [
      { type: 'button', text: 'Seu cliente aproxima o celular e cai direto na sua avaliação do Google, sem app. ⭐ Escolha o modelo e peça a sua 👇', buttons: [{ title: 'VER MODELOS E COMPRAR', url: '{{site}}' }] },
    ], { prioridade: 15, palavras: ['meu negocio', 'minha empresa', 'minha loja', 'para meu negocio'], tags: ['MEU NEGÓCIO', 'VIU PREÇO'] });

    // ---------- entrada (1 mensagem) ----------
    criar(NOME_ENTRADA_V3, [
      { type: 'quick', text: 'Oi! 👋💚 Aqui é a NexTap: placas NFC + QR Code que levam o cliente direto para a sua avaliação no Google.\nVocê quer para:', replies: [
        { title: '💰 REVENDER', flow_id: revender }, { title: '🏪 MEU NEGÓCIO', flow_id: negocio },
      ] },
    ], { prioridade: 10, comentario: true,
      palavras: ['preco', 'valor', 'quanto custa', 'quanto e', 'quanto fica', 'quanto sai', 'orcamento', 'tabela', 'quero', 'eu quero', 'nfc', 'nextap', 'comprar', 'atacado', 'informacoes', 'info', 'interesse'],
      textoComentario: 'Oi! 👋💚 Para te mostrar a melhor opção, responda por aqui: REVENDER ou MEU NEGÓCIO.' });

    // ---------- objeções (curtas, sempre com botão para calcular) ----------
    const obj = (nome, palavras, texto) => criar(nome, [{ type: 'button', text: texto, buttons: CALC }], { prioridade: 20, palavras });
    obj('Objeção: Como funciona?', ['como funciona', 'funciona', 'como e', 'como usa', 'aproximar'], 'A placa tem NFC + QR Code: o cliente aproxima o celular (ou lê o QR) e abre sua página, sem app. Veja quanto fica o seu pedido 👇');
    obj('Objeção: Já tenho QR Code', ['ja tenho qr code', 'ja tenho qrcode', 'ja tenho qr', 'tenho qr code', 'tenho qr', 'qr code', 'qrcode'], 'Ótimo, e ele continua útil. A NexTap soma o NFC: o cliente só aproxima o celular. Menos passos, mais avaliações. Veja os valores 👇');
    obj('Objeção: Está caro', ['caro', 'esta caro', 'ta caro', 'muito caro', 'achei caro', 'desconto', 'mais barato', 'barato'], 'Entendo! Quanto maior a quantidade, menor o valor por placa, e na revenda você ainda define seu preço final. Simule aqui 👇');
    criar('Prazo e entrega', [
      { type: 'button', text: 'Produção em ~5 dias úteis após a confirmação, com envio rastreado 📦 O frete é calculado pelo seu CEP na hora de fechar.', buttons: CALC },
    ], { prioridade: 20, palavras: ['prazo', 'entrega', 'frete', 'envio', 'correios', 'rastreio', 'quanto tempo', 'demora'] });
    criar('Nota fiscal', [
      { type: 'text', text: 'Sobre nota fiscal, vou chamar alguém da equipe para te explicar direitinho. Já já respondemos! 🙂' },
    ], { prioridade: 20, palavras: ['nota fiscal', 'nf', 'nfe', 'cnpj', 'cpf', 'nota'], acao: 'handoff', humano: 1 });

    // ---------- atendente e parada ----------
    criar('Falar com atendente', [
      { type: 'text', text: 'Certo! Já avisei a equipe e uma pessoa vai te responder em breve. WhatsApp: {{telefone}} 💚' },
    ], { prioridade: 100, palavras: ['atendente', 'humano', 'falar com alguem', 'falar com pessoa', 'falar com atendente', 'suporte', 'ajuda'], acao: 'handoff', humano: 1 });
    criar('Parar mensagens', [
      { type: 'text', text: 'Combinado, não envio mais mensagens automáticas. Se precisar, é só chamar! 👋' },
    ], { prioridade: 200, palavras: ['parar', 'sair', 'stop', 'cancelar', 'descadastrar'], acao: 'silenciar', modo: 'exato' });
    criar('Parar mensagens (frases)', [
      { type: 'text', text: 'Combinado, não envio mais mensagens automáticas. Se precisar, é só chamar! 👋' },
    ], { prioridade: 200, palavras: ['nao quero receber', 'nao quero mais receber', 'nao enviar', 'nao envie', 'pare de enviar'], acao: 'silenciar' });

    // ---------- follow-ups: só 2 (dentro das 24h do Instagram) ----------
    criar('Follow-up 1: conseguiu calcular?', [
      { type: 'quick', text: 'Oi, {{nome}} 👋 Conseguiu ver os valores? Me diz a quantidade e eu te passo a melhor faixa.', replies: [
        { title: 'QUERO AJUDA', flow_id: queroAjuda }, { title: 'JÁ VOU COMPRAR', flow_id: jaVouComprar },
      ] },
    ], { tipo: 'followup', atraso: 3, tags: ['FOLLOW-UP'] });
    criar('Follow-up final', [
      { type: 'button', text: 'Última mensagem por aqui 😄 Se quiser fechar, é só calcular e finalizar o pedido, ou me chamar que eu te ajudo.', buttons: CALC },
    ], { tipo: 'followup', atraso: 20, tags: ['FOLLOW-UP'] });
    criar('Resposta a um follow-up', [
      { type: 'text', text: 'Boa! 💚 Vou chamar alguém do time para fechar com você por aqui.' },
    ], { tipo: 'evento', evento: 'resposta_followup', acao: 'handoff', humano: 1, tags: ['QUENTE'] });
    criarFollowupsEtapas();
    setSetting('followups_etapas_v3', '1');
  })();
  return true;
}

// ---------------------------------------------------------------------------
// Funil DE VENDAS (v4): o preço, a conta do lucro e o pedido aparecem na própria conversa.
// Entrada → REVENDER/MEU NEGÓCIO → quantidade (faixas do site, mínimo {{minimo}}) → vídeo + preço + lucro + botão que abre
// o pedido no site já com a quantidade. Quem não compra em 24h recebe o convite para continuar pelo WhatsApp.
// Variáveis de venda: {{qtd}} {{preco}} {{total}} {{preco_venda}} {{receita}} {{lucro}} {{minimo}} {{link_pedido}}
// ---------------------------------------------------------------------------
function instalarV4({ desativarAntigos = true } = {}) {
  if (db.prepare('SELECT 1 FROM flows WHERE name = ?').get(NOME_ENTRADA_V4)) return false;
  novoFunil('Funil de vendas (v4)', 'Preço, lucro e pedido montado na conversa.');

  db.transaction(() => {
    if (desativarAntigos) db.prepare('UPDATE flows SET active = 0').run();
    const PEDIR = [{ title: 'FAZER MEU PEDIDO', url: '{{link_pedido}}' }];
    const CONTA = 'Para {{qtd}} placas: R$ {{preco}} cada, total de R$ {{total}} (frete calculado pelo seu CEP).\nRevendendo a R$ {{preco_venda}} cada, você recebe R$ {{receita}}: são R$ {{lucro}} de lucro.';
    const OFERTA = 'No primeiro pedido você leva o nosso roteiro de abordagem (o passo a passo para vender para barbearias, clínicas e lojas) e o painel do revendedor para configurar cada placa. Se alguma placa chegar com defeito, a gente troca.';

    // ---------- fechamento ----------
    const jaVouComprar = criar('Botão: JÁ VOU COMPRAR', [
      { type: 'button', text: 'Perfeito! 🔥 Seu pedido de {{qtd}} placas já abre montado aqui. Qualquer dúvida de pagamento ou envio, me chama.', buttons: PEDIR },
    ], { tipo: 'botao', tags: ['INTENÇÃO DE COMPRA', 'QUENTE'] });
    const queroAjuda = criar('Botão: QUERO AJUDA', [
      { type: 'text', text: 'Já avisei o time: em instantes alguém fecha com você por aqui. Se preferir, WhatsApp: {{telefone}} 💚' },
    ], { tipo: 'botao', acao: 'handoff', humano: 1, tags: ['QUENTE'] });
    criar('Depois do clique no pedido', [
      { type: 'quick', text: 'Vi que você abriu o pedido 👀 Ficou alguma dúvida de quantidade, pagamento ou frete? Eu te ajudo a finalizar agora.', replies: [
        { title: 'QUERO AJUDA', flow_id: queroAjuda }, { title: 'JÁ VOU COMPRAR', flow_id: jaVouComprar },
      ] },
    ], { tipo: 'evento', evento: 'clique_link' });
    const comercial = criar('Botão: FALAR COM COMERCIAL', [
      { type: 'text', text: 'Combinado! 🔥 Já chamei o comercial: você será atendido com prioridade aqui mesmo. WhatsApp: {{telefone}}' },
    ], { tipo: 'botao', acao: 'handoff', humano: 2, tags: ['QUENTE'] });
    const verPedido = criar('Botão: VER MEU PEDIDO', [
      { type: 'button', text: CONTA + '\n\nÉ só abrir e finalizar 👇', buttons: PEDIR },
    ], { tipo: 'botao', tags: ['VIU PREÇO'] });

    // ---------- quantidade (o número no evento é a quantidade de exemplo da faixa) ----------
    const video = { type: 'video', url: '{{video_demo}}' };
    const pequeno = (nome, evento, faixa) => criar(nome, [
      video,
      { type: 'text', text: 'Sem aplicativo: o cliente aproxima o celular da placa e cai direto na avaliação da empresa no Google. É isso que você vai vender. 👆' },
      { type: 'text', text: CONTA },
      { type: 'button', text: OFERTA + '\n\nSeu pedido já abre montado 👇', buttons: PEDIR },
    ], { tipo: 'botao', evento, tags: ['QUANTIDADE', 'QTD ' + faixa, 'VIU DEMO', 'VIU PREÇO'] });
    const grande = (nome, evento, faixa) => criar(nome, [
      { type: 'text', text: CONTA },
      { type: 'quick', text: 'Nesse volume você tem atendimento direto do comercial e as melhores condições de atacado. 💚\nQuer falar com o comercial ou já ver o seu pedido?', replies: [
        { title: 'FALAR COM COMERCIAL', flow_id: comercial }, { title: 'VER MEU PEDIDO', flow_id: verPedido },
      ] },
    ], { tipo: 'botao', evento, humano: 2, tags: ['QUANTIDADE', 'QTD ' + faixa, 'LEAD GRANDE', 'QUENTE', 'VIU PREÇO'] });
    const q1 = pequeno('Venda: 5 a 10 placas', 'qtd4_10', '5-10');
    const q2 = pequeno('Venda: 11 a 49 placas', 'qtd4_20', '11-49');
    const q3 = grande('Venda: 50 a 99 placas (lead quente)', 'qtd4_50', '50-99');
    const q4 = grande('Venda: 100+ placas (lead quente)', 'qtd4_100', '100+');
    const QTD = [{ title: '5–10', flow_id: q1 }, { title: '11–49', flow_id: q2 }, { title: '50–99', flow_id: q3 }, { title: '100+', flow_id: q4 }];
    criar('Venda: abaixo do pedido mínimo', [
      { type: 'quick', text: 'O pedido mínimo é de {{minimo}} placas, que é o que faz a revenda valer a pena: com {{minimo}} você já cobre o investimento nas primeiras vendas. Com quantas quer começar?', replies: QTD },
    ], { tipo: 'botao', evento: 'qtd4_min' });

    const revender = criar('REVENDER: quantas placas?', [
      { type: 'quick', text: 'Boa! 🚀 Você compra direto da fábrica e define o seu preço de venda. Com quantas placas quer começar? (mínimo {{minimo}}; pode digitar o número)', replies: QTD },
    ], { prioridade: 15, palavras: ['revender', 'revenda', 'revendedor', 'revendedora', 'quero revender', 'ser revendedor'], comentario: true, tags: ['REVENDEDOR'],
      textoComentario: 'Oi! 👋💚 Perfeito, vamos de revenda! Com quantas placas você pensa em começar? Responda com um número, ex.: 20' });

    // ---------- MEU NEGÓCIO ----------
    const negocio = criar('MEU NEGÓCIO: ver modelos', [
      { type: 'button', text: 'Seu cliente aproxima o celular e cai direto na sua avaliação do Google, sem app. ⭐ Escolha o modelo e peça a sua 👇', buttons: [{ title: 'VER MODELOS', url: '{{site}}' }] },
    ], { prioridade: 15, palavras: ['meu negocio', 'minha empresa', 'minha loja', 'para meu negocio'], tags: ['MEU NEGÓCIO', 'VIU PREÇO'] });

    // ---------- entrada ----------
    criar(NOME_ENTRADA_V4, [
      { type: 'quick', text: 'Oi! 👋💚 Aqui é a NexTap: placas NFC + QR Code que levam o cliente direto para a avaliação no Google.\nVocê quer para:', replies: [
        { title: '💰 REVENDER', flow_id: revender }, { title: '🏪 MEU NEGÓCIO', flow_id: negocio },
      ] },
    ], { prioridade: 10, comentario: true,
      palavras: ['preco', 'valor', 'quanto custa', 'quanto e', 'quanto fica', 'quanto sai', 'orcamento', 'tabela', 'quero', 'eu quero', 'nfc', 'nextap', 'comprar', 'atacado', 'informacoes', 'info', 'interesse'],
      textoComentario: 'Oi! 👋💚 Para te mostrar a melhor opção, responda por aqui: REVENDER ou MEU NEGÓCIO.' });

    // ---------- objeções (curtas, sempre com o pedido) ----------
    const obj = (nome, palavras, texto) => criar(nome, [{ type: 'button', text: texto, buttons: PEDIR }], { prioridade: 20, palavras });
    obj('Objeção: Como funciona?', ['como funciona', 'funciona', 'como e', 'como usa', 'aproximar'], 'A placa tem NFC + QR Code: o cliente aproxima o celular (ou lê o QR) e abre a avaliação no Google, sem app. Você configura cada placa pelo painel do revendedor. Seu pedido 👇');
    obj('Objeção: Já tenho QR Code', ['ja tenho qr code', 'ja tenho qrcode', 'ja tenho qr', 'tenho qr code', 'tenho qr', 'qr code', 'qrcode'], 'Ótimo, e ele continua útil. A NexTap soma o NFC: o cliente só aproxima o celular. Menos passos, mais avaliações. Veja o seu pedido 👇');
    obj('Objeção: Está caro', ['caro', 'esta caro', 'ta caro', 'muito caro', 'achei caro', 'desconto', 'mais barato', 'barato'], 'Entendo! Faz a conta comigo: ' + CONTA + '\nQuanto maior a quantidade, menor o valor por placa 👇');
    criar('Prazo e entrega', [
      { type: 'button', text: 'Produção em ~5 dias úteis após a confirmação, com envio rastreado 📦 O frete é calculado pelo seu CEP na hora de fechar.', buttons: PEDIR },
    ], { prioridade: 20, palavras: ['prazo', 'entrega', 'frete', 'envio', 'correios', 'rastreio', 'quanto tempo', 'demora'] });
    criar('Nota fiscal', [
      { type: 'text', text: 'Sobre nota fiscal, vou chamar alguém da equipe para te explicar direitinho. Já já respondemos! 🙂' },
    ], { prioridade: 20, palavras: ['nota fiscal', 'nf', 'nfe', 'cnpj', 'cpf', 'nota'], acao: 'handoff', humano: 1 });

    // ---------- atendente e parada ----------
    criar('Falar com atendente', [
      { type: 'text', text: 'Certo! Já avisei a equipe e uma pessoa vai te responder em breve. WhatsApp: {{telefone}} 💚' },
    ], { prioridade: 100, palavras: ['atendente', 'humano', 'falar com alguem', 'falar com pessoa', 'falar com atendente', 'suporte', 'ajuda'], acao: 'handoff', humano: 1 });
    criar('Parar mensagens', [
      { type: 'text', text: 'Combinado, não envio mais mensagens automáticas. Se precisar, é só chamar! 👋' },
    ], { prioridade: 200, palavras: ['parar', 'sair', 'stop', 'cancelar', 'descadastrar'], acao: 'silenciar', modo: 'exato' });
    criar('Parar mensagens (frases)', [
      { type: 'text', text: 'Combinado, não envio mais mensagens automáticas. Se precisar, é só chamar! 👋' },
    ], { prioridade: 200, palavras: ['nao quero receber', 'nao quero mais receber', 'nao enviar', 'nao envie', 'pare de enviar'], acao: 'silenciar' });

    // ---------- follow-ups por etapa (dentro das 24h) e convite para o WhatsApp no final ----------
    const WPP = '\nSe preferir continuar pelo WhatsApp, me manda o seu número com DDD aqui que eu te chamo por lá. 📱';
    const fu = (nome, passos, publico, atraso) => criar(nome, passos, { tipo: 'followup', publico, atraso, tags: ['FOLLOW-UP'] });
    fu('Follow-up (quantidade) 1: quantas placas?', [
      { type: 'quick', text: 'Oi, {{nome}} 👋 Ficou alguma dúvida? Me diz com quantas placas você pensa em começar que eu já te mostro o valor e o lucro:', replies: QTD },
    ], 'revenda_qtd', 2);
    fu('Follow-up (quantidade) final', [
      { type: 'text', text: 'Vou parar por aqui para não te incomodar 😄 Quando quiser ver os valores, é só mandar "QUERO REVENDER".' + WPP },
    ], 'revenda_qtd', 20);
    fu('Follow-up (preço) 1: seu pedido', [
      { type: 'button', text: 'Oi, {{nome}} 👋 Deixei o seu pedido de {{qtd}} placas montado: R$ {{total}}, com R$ {{lucro}} de lucro revendendo a R$ {{preco_venda}}.', buttons: PEDIR },
    ], 'revenda_preco', 2);
    fu('Follow-up (preço) 2: como vender', [
      { type: 'quick', text: 'Uma dúvida comum de quem está começando: "para quem eu vendo?" Barbearias, salões, clínicas, restaurantes e lojas do seu bairro. O roteiro de abordagem vai junto no primeiro pedido. Quer ajuda para fechar?', replies: [
        { title: 'QUERO AJUDA', flow_id: queroAjuda }, { title: 'VER MEU PEDIDO', flow_id: verPedido },
      ] },
    ], 'revenda_preco', 8);
    fu('Follow-up (preço) final', [
      { type: 'text', text: 'Vou encerrar por aqui para não ficar te incomodando 😄 O seu pedido continua guardado.' + WPP },
    ], 'revenda_preco', 20);
    fu('Follow-up (pedido aberto) 1: conseguiu finalizar?', [
      { type: 'quick', text: 'Oi, {{nome}} 👋 Vi que você abriu o pedido de {{qtd}} placas. Conseguiu finalizar ou travou em alguma parte (cadastro, frete, pagamento)?', replies: [
        { title: 'QUERO AJUDA', flow_id: queroAjuda }, { title: 'JÁ VOU COMPRAR', flow_id: jaVouComprar },
      ] },
    ], 'checkout', 3);
    fu('Follow-up (pedido aberto) final', [
      { type: 'button', text: 'Última mensagem por aqui 😄 Seu pedido de {{qtd}} placas continua montado, é só finalizar.' + WPP, buttons: PEDIR },
    ], 'checkout', 20);
    fu('Follow-up (meu negócio) 1: ver modelos', [
      { type: 'button', text: 'Oi, {{nome}} 👋 Conseguiu ver os modelos? Seu cliente aproxima o celular e já cai na avaliação da sua empresa no Google, sem app. ⭐', buttons: [{ title: 'VER MODELOS', url: '{{site}}' }] },
    ], 'negocio', 2);
    fu('Follow-up (meu negócio) final', [
      { type: 'text', text: 'Vou parar por aqui para não incomodar 😄 Quando quiser a sua placa no balcão, é só mandar "MEU NEGÓCIO".' + WPP },
    ], 'negocio', 20);
    criar('Resposta a um follow-up', [
      { type: 'text', text: 'Boa! 💚 Vou chamar alguém do time para fechar com você por aqui.' },
    ], { tipo: 'evento', evento: 'resposta_followup', acao: 'handoff', humano: 1, tags: ['QUENTE'] });
    criar('Recebeu o WhatsApp do lead', [
      { type: 'text', text: 'Anotado! 📱 Alguém do time vai te chamar no WhatsApp para continuar por lá. Se quiser adiantar, o seu pedido está aqui em cima.' },
    ], { tipo: 'evento', evento: 'recebeu_whatsapp', humano: 1, tags: ['QUENTE'] });
    setSetting('followups_etapas_v4', '1');
  })();
  return true;
}

// ---------------------------------------------------------------------------
// Funil 3 TOQUES (v5): uma ideia e uma ação por mensagem. Entrada → quantidade → oferta (preço + lucro + pedido montado).
// Vídeo só sob pedido (botão). No máximo 2 follow-ups por pessoa. A oferta tem variante B (teste A/B):
//   A = lucro em destaque · B = "com N placas vendidas você paga o pedido" ({{payback}}).
// ---------------------------------------------------------------------------
function instalarV5({ desativarAntigos = true } = {}) {
  if (db.prepare('SELECT 1 FROM flows WHERE name = ?').get(NOME_ENTRADA_V5)) return false;
  novoFunil('Funil 3 toques (v5)', 'Entrada → quantidade → oferta com preço, lucro e pedido montado. Máximo de 2 follow-ups. Teste A/B na oferta.');

  db.transaction(() => {
    if (desativarAntigos) db.prepare('UPDATE flows SET active = 0').run();
    const PEDIR = { title: 'FAZER MEU PEDIDO', url: '{{link_pedido}}' };
    const VIDEO = { title: 'VER FUNCIONANDO', url: '{{video_demo}}' };   // some sozinho se o vídeo não estiver configurado
    const GARANTIA = 'Vai com o roteiro de vendas + troca se vier com defeito.';
    const ULTIMA = 'Última mensagem por aqui 😄 Se preferir, me manda o seu WhatsApp com DDD que eu te ajudo por lá. 📱';

    // ---------- fechamento ----------
    const querAjuda = criar('Botão: QUERO AJUDA', [
      { type: 'text', text: 'Já avisei o time: em instantes alguém te ajuda a finalizar por aqui. 💚' },
    ], { tipo: 'botao', acao: 'handoff', humano: 1, tags: ['QUENTE'] });
    const meChama = criar('Botão: SIM, ME CHAMA', [
      { type: 'text', text: 'Combinado! 🔥 O comercial já foi avisado e vai te chamar aqui em instantes.' },
    ], { tipo: 'botao', acao: 'handoff', humano: 2, tags: ['QUENTE'] });
    const verPedido = criar('Botão: VER MEU PEDIDO', [
      { type: 'button', text: 'Seu pedido de {{qtd}} placas: R$ {{total}} (frete pelo seu CEP). É só abrir e finalizar 👇', buttons: [PEDIR] },
    ], { tipo: 'botao', tags: ['VIU PREÇO'] });

    // ---------- oferta (o número no evento é a quantidade de exemplo da faixa) ----------
    const ofertaA = 'Para {{qtd}} placas: R$ {{preco}} cada = R$ {{total}}.\nRevendendo a R$ {{preco_venda}}, você recebe R$ {{receita}}: são R$ {{lucro}} de lucro. 💰\n' + GARANTIA;
    const ofertaB = 'Com {{payback}} placas vendidas você já paga o pedido inteiro. 🚀\nPara {{qtd}} placas: R$ {{preco}} cada = R$ {{total}} (frete pelo seu CEP). O resto é lucro.\n' + GARANTIA;
    const oferta = (nome, evento, faixa) => {
      const tags = ['QUANTIDADE', 'QTD ' + faixa, 'VIU PREÇO'];
      const a = criar(nome, [{ type: 'button', text: ofertaA, buttons: [PEDIR, VIDEO] }], { tipo: 'botao', evento, tags });
      criar(nome + ' · variante B', [{ type: 'button', text: ofertaB, buttons: [PEDIR, VIDEO] }], { tipo: 'botao', tags, varianteDe: a });
      return a;
    };
    const q1 = oferta('Oferta: 5 a 10 placas', 'qtd5_10', '5-10');
    const q2 = oferta('Oferta: 11 a 49 placas', 'qtd5_20', '11-49');
    const q3 = criar('Oferta: 50 ou mais (lead quente)', [
      { type: 'quick', text: 'Para {{qtd}} placas: R$ {{preco}} cada = R$ {{total}}, com R$ {{lucro}} de lucro revendendo a R$ {{preco_venda}}.\nNesse volume o comercial te atende direto. Quer que te chamem agora?', replies: [
        { title: 'SIM, ME CHAMA', flow_id: meChama }, { title: 'VER MEU PEDIDO', flow_id: verPedido },
      ] },
    ], { tipo: 'botao', evento: 'qtd5_50', humano: 2, tags: ['QUANTIDADE', 'QTD 50+', 'LEAD GRANDE', 'QUENTE', 'VIU PREÇO'] });
    const FAIXAS = [{ title: '5 a 10', flow_id: q1 }, { title: '11 a 49', flow_id: q2 }, { title: '50 ou mais', flow_id: q3 }];
    criar('Abaixo do pedido mínimo', [
      { type: 'quick', text: 'O mínimo é {{minimo}} placas: é o que faz a revenda valer a pena. Com quantas quer começar?', replies: FAIXAS },
    ], { tipo: 'botao', evento: 'qtd5_min' });

    // ---------- qualificação e entrada ----------
    const revender = criar('Revender: quantas placas?', [
      { type: 'quick', text: 'Boa! 🚀 Com quantas placas você quer começar? (mínimo {{minimo}}; pode digitar o número)', replies: FAIXAS },
    ], { prioridade: 15, palavras: ['revender', 'revenda', 'revendedor', 'revendedora', 'quero revender', 'ser revendedor'], comentario: true, tags: ['REVENDEDOR'],
      textoComentario: 'Oi! 👋 Vamos de revenda! Com quantas placas você quer começar? Responda com um número, ex.: 20' });
    const negocio = criar('Meu negócio: ver modelos', [
      { type: 'button', text: 'Seu cliente aproxima o celular e cai direto na sua avaliação do Google, sem app. ⭐ Escolha o modelo e peça a sua:', buttons: [{ title: 'VER MODELOS E PEDIR', url: '{{site}}' }] },
    ], { prioridade: 15, palavras: ['meu negocio', 'minha empresa', 'minha loja', 'para meu negocio'], tags: ['MEU NEGÓCIO', 'VIU PREÇO'] });
    criar(NOME_ENTRADA_V5, [
      { type: 'quick', text: 'Oi! 👋 Aqui é a NexTap: placa que leva o cliente direto pra avaliação no Google, sem app.\nÉ pra revender ou pro seu negócio?', replies: [
        { title: '💰 REVENDER', flow_id: revender }, { title: '🏪 MEU NEGÓCIO', flow_id: negocio },
      ] },
    ], { prioridade: 10, comentario: true,
      palavras: ['preco', 'valor', 'quanto custa', 'quanto e', 'quanto fica', 'quanto sai', 'orcamento', 'tabela', 'quero', 'eu quero', 'nfc', 'nextap', 'comprar', 'atacado', 'informacoes', 'info', 'interesse'],
      textoComentario: 'Oi! 👋 Me responde por aqui: é pra REVENDER ou pro seu NEGÓCIO?' });

    // ---------- respostas por palavra-chave (1 mensagem cada) ----------
    const obj = (nome, palavras, texto, extra = {}) => criar(nome, [{ type: 'button', text: texto, buttons: [PEDIR] }], { prioridade: 20, palavras, ...extra });
    obj('Dúvida: como funciona?', ['como funciona', 'funciona', 'como e', 'como usa', 'aproximar'], 'O cliente aproxima o celular da placa (ou lê o QR Code) e abre a avaliação no Google, sem app. Você configura cada placa no painel do revendedor.');
    obj('Dúvida: já tenho QR Code', ['ja tenho qr code', 'ja tenho qrcode', 'ja tenho qr', 'tenho qr code', 'tenho qr', 'qr code', 'qrcode'], 'Ótimo, ele continua útil. A NexTap soma o NFC: o cliente só aproxima o celular. Menos passos, mais avaliações.');
    obj('Dúvida: está caro', ['caro', 'esta caro', 'ta caro', 'muito caro', 'achei caro', 'desconto', 'mais barato', 'barato'], 'Faz a conta comigo: {{qtd}} placas saem R$ {{total}} e, revendendo a R$ {{preco_venda}}, você recebe R$ {{receita}}. Quanto mais placas, menor o preço de cada uma.');
    obj('Dúvida: prazo e entrega', ['prazo', 'entrega', 'frete', 'envio', 'correios', 'rastreio', 'quanto tempo', 'demora'], 'Produção em ~5 dias úteis após o pagamento, com envio rastreado 📦 O frete é calculado pelo seu CEP no pedido.');
    criar('Dúvida: nota fiscal', [
      { type: 'text', text: 'Sobre nota fiscal, vou chamar alguém da equipe para te explicar direitinho. Já já respondemos! 🙂' },
    ], { prioridade: 20, palavras: ['nota fiscal', 'nf', 'nfe', 'cnpj', 'cpf', 'nota'], acao: 'handoff', humano: 1 });
    criar('Falar com atendente', [
      { type: 'text', text: 'Certo! Já avisei a equipe e uma pessoa vai te responder em breve. 💚' },
    ], { prioridade: 100, palavras: ['atendente', 'humano', 'falar com alguem', 'falar com pessoa', 'falar com atendente', 'suporte', 'ajuda'], acao: 'handoff', humano: 1 });
    criar('Parar mensagens', [
      { type: 'text', text: 'Combinado, não envio mais mensagens automáticas. Se precisar, é só chamar! 👋' },
    ], { prioridade: 200, palavras: ['parar', 'sair', 'stop', 'cancelar', 'descadastrar'], acao: 'silenciar', modo: 'exato' });
    criar('Parar mensagens (frases)', [
      { type: 'text', text: 'Combinado, não envio mais mensagens automáticas. Se precisar, é só chamar! 👋' },
    ], { prioridade: 200, palavras: ['nao quero receber', 'nao quero mais receber', 'nao enviar', 'nao envie', 'pare de enviar'], acao: 'silenciar' });

    // ---------- acompanhamento: no máximo 2 por pessoa (3h e 20h depois da última mensagem dela) ----------
    const fu = (nome, passos, publico, atraso) => criar(nome, passos, { tipo: 'followup', publico, atraso, tags: ['FOLLOW-UP'] });
    fu('3h · não escolheu a quantidade', [
      { type: 'quick', text: 'Oi, {{nome}} 👋 A maioria começa com 10 placas. Quer ver quanto fica e quanto sobra de lucro?', replies: [
        { title: '10 PLACAS', flow_id: q1 }, { title: 'OUTRA QUANTIDADE', flow_id: revender },
      ] },
    ], 'revenda_qtd', 3);
    fu('3h · viu o preço e não pediu', [
      { type: 'button', text: 'Oi, {{nome}} 👋 Seu pedido de {{qtd}} placas continua montado: R$ {{total}}, com R$ {{lucro}} de lucro.', buttons: [PEDIR] },
    ], 'revenda_preco', 3);
    fu('3h · abriu o pedido e não pagou', [
      { type: 'quick', text: 'Oi, {{nome}} 👋 Travou em algo? Cadastro, frete ou pagamento? Eu te ajudo a finalizar.', replies: [{ title: 'QUERO AJUDA', flow_id: querAjuda }] },
    ], 'checkout', 3);
    for (const [publico, quem] of [['revenda_qtd', 'não escolheu a quantidade'], ['revenda_preco', 'viu o preço'], ['checkout', 'abriu o pedido'], ['negocio', 'meu negócio']]) {
      fu('20h · última (' + quem + ')', [{ type: 'text', text: ULTIMA }], publico, 20);
    }
    criar('Respondeu a um follow-up', [
      { type: 'text', text: 'Boa! 💚 Vou chamar alguém do time para continuar com você por aqui.' },
    ], { tipo: 'evento', evento: 'resposta_followup', acao: 'handoff', humano: 1, tags: ['QUENTE'] });
    criar('Mandou o WhatsApp', [
      { type: 'text', text: 'Anotado! 📱 Alguém do time vai te chamar no WhatsApp para continuar por lá.' },
    ], { tipo: 'evento', evento: 'recebeu_whatsapp', humano: 1, tags: ['QUENTE'] });
  })();
  return true;
}

function semear() {
  if (db.prepare('SELECT COUNT(*) AS n FROM flows').get().n > 0) { instalarFollowupsEtapas(); return false; }
  return instalarV2({ desativarAntigos: false });
}

module.exports = { semear, instalarV2, instalarV3, instalarV4, instalarV5, instalarFollowupsEtapas, NOME_ENTRADA, NOME_ENTRADA_V3, NOME_ENTRADA_V4, NOME_ENTRADA_V5 };
