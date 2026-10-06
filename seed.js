// Fluxos da NexTap (versão 2: funil de qualificação). Edite tudo pelo painel.
//   semear()    → na primeira subida (nenhum fluxo): instala o funil.
//   instalarV2() → botão do painel: desativa os fluxos antigos (não apaga) e instala o funil novo.
const { db } = require('./db.js');

const NOME_ENTRADA = 'Entrada: REVENDER ou MEU NEGÓCIO';

function instalarV2({ desativarAntigos = true } = {}) {
  if (db.prepare('SELECT 1 FROM flows WHERE name = ?').get(NOME_ENTRADA)) return false;
  const agora = Date.now();
  const ins = db.prepare(`INSERT INTO flows (name, active, priority, match_mode, keywords, on_comment, action, steps, created_at,
    kind, event, delay_hours, tags, human_priority, comment_text) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const criar = (nome, passos, o = {}) => Number(ins.run(
    nome, o.prioridade || 0, o.modo || 'contem', JSON.stringify(o.palavras || []), o.comentario ? 1 : 0, o.acao || null,
    JSON.stringify(passos), agora, o.tipo || 'normal', o.evento || null, o.atraso || 0, JSON.stringify(o.tags || []),
    o.humano || 0, o.textoComentario || null).lastInsertRowid);

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
      { type: 'text', text: 'Oi, {{nome}} 👋\nConseguiu calcular seu pedido da Nextap?\nSe quiser, me fala quantas unidades está pensando e eu te ajudo a encontrar a melhor faixa.' },
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
  })();
  return true;
}

function semear() {
  if (db.prepare('SELECT COUNT(*) AS n FROM flows').get().n > 0) return false;
  return instalarV2({ desativarAntigos: false });
}

module.exports = { semear, instalarV2, NOME_ENTRADA };
