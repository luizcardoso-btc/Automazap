// Fluxos iniciais da NexTap. Só são criados se ainda não existir nenhum fluxo; edite tudo pelo painel.
const { db } = require('./db.js');

function semear() {
  if (db.prepare('SELECT COUNT(*) AS n FROM flows').get().n > 0) return false;
  const agora = Date.now();
  const ins = db.prepare('INSERT INTO flows (name, active, priority, match_mode, keywords, on_comment, action, steps, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)');
  const criar = (nome, prioridade, palavras, passos, { comentario = false, acao = null, modo = 'contem' } = {}) =>
    Number(ins.run(nome, prioridade, modo, JSON.stringify(palavras), comentario ? 1 : 0, acao, JSON.stringify(passos), agora).lastInsertRowid);

  const nfc = criar('Como funciona a placa NFC', 10,
    ['nfc', 'como funciona', 'aproximar', 'avaliacao google', 'qr code', 'qrcode'],
    [{ type: 'text', text: 'A placa NexTap tem *NFC e QR Code*. O cliente aproxima o celular (ou lê o QR) e cai direto na tela de avaliar a sua empresa no Google, sem digitar nada. ⭐' }]);

  const prazo = criar('Prazo e entrega', 10,
    ['prazo', 'entrega', 'frete', 'envio', 'correios', 'rastreio', 'quanto tempo'],
    [{ type: 'text', text: 'A produção leva *5 dias úteis* depois do pagamento aprovado. O envio é pelos Correios, com código de rastreio que aparece no seu painel. 📦' }]);

  const atendente = criar('Falar com atendente', 100,
    ['atendente', 'humano', 'falar com alguem', 'falar com pessoa', 'suporte', 'ajuda'],
    [{ type: 'text', text: 'Certo! Já avisei a nossa equipe e uma pessoa vai te responder em breve. Se preferir, chame no WhatsApp: {{telefone}} 💚' }],
    { acao: 'handoff' });

  criar('Nota fiscal', 20,
    ['nota fiscal', 'nf', 'nfe', 'cnpj', 'cpf', 'nota'],
    [{ type: 'text', text: 'Sobre nota fiscal, vou chamar alguém da equipe para te explicar direitinho. Já já te respondemos! 🙂' }],
    { acao: 'handoff' });

  // Busca exata de propósito: "preciso sair agora" não deve silenciar o robô por um ano.
  criar('Parar mensagens', 200,
    ['parar', 'sair', 'stop', 'cancelar', 'nao quero receber', 'nao quero receber mensagens'],
    [{ type: 'text', text: 'Combinado, não envio mais mensagens automáticas. Se precisar, é só chamar! 👋' }],
    { acao: 'silenciar', modo: 'exato' });

  // Mensagem principal: baseada na que já está no Youze
  criar('Preço e como revender', 10,
    ['preco', 'valor', 'quanto custa', 'quanto e', 'quanto fica', 'orcamento', 'tabela', 'quero', 'quero revender', 'revender', 'revenda', 'comprar', 'atacado', 'nextap'],
    [
      { type: 'button', text: 'Olá! 👋💚 Você quer começar a revender NexTap? Preparei uma página onde você pode calcular seu pedido, escolher a quantidade de placas e conferir o valor antes de finalizar. 👇', buttons: [{ title: 'CALCULAR PLACAS', url: '{{site}}' }] },
      { type: 'quick', text: 'Posso ajudar com mais alguma coisa?', replies: [
        { title: 'Como funciona', flow_id: nfc },
        { title: 'Prazo e entrega', flow_id: prazo },
        { title: 'Falar com atendente', flow_id: atendente },
      ] },
    ], { comentario: true });
  return true;
}

module.exports = { semear };
