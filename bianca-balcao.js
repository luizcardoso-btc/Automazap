// Bianca no balcão do WhatsApp: quem ESCREVE para o número da NexTap (não é empresa da prospecção) é atendido pela Bianca.
// Dois caminhos: VAREJO (empresa da cidade que quer a placa para o próprio estabelecimento: 1 placa R$ 80, 2 placas R$ 140)
// e ATACADO (revenda: não tem preço automático aqui, a Bianca anota quantidade e cidade e passa para você).
// O que ela não reconhece vai para você (Gerente avisa no seu WhatsApp). Se você responder pelo celular/painel, ela fica quieta 2h.
const { db, getSetting } = require('./db.js');

db.exec('CREATE TABLE IF NOT EXISTS bianca_balcao (contato_id INTEGER PRIMARY KEY, etapa TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT \'\', dados TEXT NOT NULL DEFAULT \'{}\', tentativas INTEGER NOT NULL DEFAULT 0, em INTEGER NOT NULL)');

const DIA = 86400e3;
const sem = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const valor = (k, pad) => { const v = parseFloat(String(getSetting(k) || '').replace(/\./g, '').replace(',', '.')); const x = v > 0 ? v : pad; return Number.isInteger(x) ? String(x) : x.toFixed(2).replace('.', ','); };
const precos = () => {
  const um = valor('preco_varejo_1', 80), dois = valor('preco_varejo_2', 140), cada = parseFloat(dois.replace(',', '.')) / 2;
  return { um, dois, cada: Number.isInteger(cada) ? String(cada) : cada.toFixed(2).replace('.', ',') };
};

const RX = {
  parar: /(\bpare\b|para de (me )?mandar|nao (me )?(mande|envie|chame)|sem interesse|nao tenho interesse|descadastr|\bstop\b|\bspam\b)/,
  humano: /(falar com (alguem|uma pessoa|atendente|o dono|o luiz|voce|humano)|atendente|pessoa de verdade|me liga|pode (me )?ligar)/,
  atacado: /(revend|revenda|atacado|atacadista|lote|distribu|\b(1\d|[2-9]\d|\d{3,}) (placas|unidades|unid|un)\b|quantidade grande|preco de fabrica|para vender|pra vender)/,
  varejo: /(estabelecimento|meu (negocio|comercio|salao|restaurante|consultorio|espaco|estudio)|minha (loja|empresa|barbearia|clinica|lanchonete|pizzaria|academia|hamburgueria)|pra mim|para mim|uso proprio|para (a|minha|o meu) (loja|empresa)|pro meu|pra minha|no balcao)/,
  preco: /(quanto|\bvalor\b|preco|custa|r\$|tabela)/,
  caro: /(\bcaro\b|desconto|mais barato|faz por menos|abaixa)/,
  pensar: /(vou pensar|vou ver|depois (eu )?(vejo|falo|respondo|te chamo)|mais tarde|outra hora|semana que vem)/,
  nao: /^(nao|n|nao obrigad\w*|nao quero|agora nao|nao preciso)\b/,
  sim: /^(sim|quero|pode|claro|ok|blz|beleza|bora|fechado|fechou|vamos|manda)\b/,
  cor: /\b(azul|preta|preto)\b/,
};
const qtdDe = t => { const m = /\b(\d{1,4})\b/.exec(t); if (m) return Number(m[1]); if (/\b(uma|um|1a)\b/.test(t)) return 1; if (/\b(duas|dois)\b/.test(t)) return 2; if (/\b(tres|quatro|cinco|seis|dez)\b/.test(t)) return 3; return 0; };

function textos() {
  const P = require('./predio.js'), p = precos(), eu = P.nomes().prospectora, dono = P.vendedor(), cidade = P.cidade();
  const ver = String(getSetting('video_demo_url') || '').trim() || String(getSetting('site_url') || '').trim();
  return {
    menu: (nome) => `Oi${nome ? ', ' + nome : ''}! Aqui é a ${eu}, da NexTap. 🙂\n\nPra eu te ajudar certinho: a placa é para o seu estabelecimento ou você quer revender?\n\n*1* Para o meu estabelecimento\n*2* Quero revender (atacado)\n\n_Responda com o número._`,
    menuDeNovo: () => 'Só pra eu te passar a informação certa: é para o *seu estabelecimento* (responda *1*) ou para *revender* (responda *2*)?',
    varejo: () => [`Show! A placa NexTap é de acrílico e fica no balcão: o cliente aproxima o celular (ou aponta a câmera) e cai direto na tela de avaliar a sua empresa no Google. Sem aplicativo, leva uns 5 segundos.${ver ? `\n\nOlha como funciona: ${ver}` : ''}`,
      `Os valores aqui em ${cidade}:\n\n• *1 placa:* R$ ${p.um}\n• *2 placas:* R$ ${p.dois} (sai R$ ${p.cada} cada)\n\nValor único, sem mensalidade. Eu entrego configurada com o link do Google da sua empresa, é só colocar no balcão.\n\nVai querer *1* ou *2*? E prefere *azul* ou *preta*?`],
    preco: () => [`Aqui em ${cidade}:\n• *1 placa:* R$ ${p.um}\n• *2 placas:* R$ ${p.dois} (sai R$ ${p.cada} cada)\n\nValor único, sem mensalidade, já configurada para a sua empresa. Vai querer *1* ou *2*?`],
    caro: () => [`Entendo! Pensa assim: a placa trabalha todo dia no balcão, sem mensalidade, e uma avaliação boa já pode trazer cliente novo. Com 2 placas cada uma sai R$ ${p.cada}.`, 'Quer começar com uma só?'],
    pensar: () => ['Claro, sem pressa! 🙂 Quando decidir, é só me chamar aqui. Ficou alguma dúvida de como funciona?'],
    muitas: (q) => [`Para ${q} placas o ${dono} faz um valor especial pra você. Já avisei ele, ele te chama aqui em instantes! 🙌`],
    pedido: (q, cor) => [`Perfeito! 🙌 Anotado: *${q === 2 ? `2 placas por R$ ${p.dois}` : `1 placa por R$ ${p.um}`}*${cor ? ` (${cor})` : ''}.`, 'Agora me manda, por favor:\n• o *nome da empresa* como aparece no Google\n• o *endereço* (rua e bairro) para a entrega'],
    corOuQtd: () => ['Vai querer *1* placa ou *2*? E a cor: *azul* ou *preta*?'],
    dadosOk: () => [`Anotado! ✅ O ${dono} já vai te mandar o pagamento por aqui e combinar a entrega. Obrigada pela confiança! 💙`],
    atacado: () => [`Que legal! Para revenda (atacado), quem cuida é o ${dono} pessoalmente, com valor por quantidade.`, 'Me conta: quantas placas você está pensando e de qual cidade você é?'],
    atacadoOk: () => [`Obrigada! Já passei tudo para o ${dono}, ele te chama aqui em breve. 🙌`],
    humano: () => [`Claro! Já avisei o ${dono}, ele te responde por aqui. 🙂`],
    nao: () => ['Sem problema! Se um dia quiser mais avaliações no Google, é só me chamar. 🙌'],
    parar: () => ['Combinado, não escrevo mais. Bom trabalho!'],
  };
}

function estado(cid, t0) {
  const e = db.prepare('SELECT * FROM bianca_balcao WHERE contato_id = ?').get(cid);
  if (!e) return null;
  if (e.etapa === 'parado') return e;
  return t0 - e.em > DIA ? null : { ...e, dados: JSON.parse(e.dados || '{}') };   // 24h parada: recomeça do zero
}
const salvar = (cid, etapa, tipo, dados, t0, tentativas = 0) => db.prepare(`INSERT INTO bianca_balcao (contato_id, etapa, tipo, dados, tentativas, em) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(contato_id) DO UPDATE SET etapa = excluded.etapa, tipo = excluded.tipo, dados = excluded.dados, tentativas = excluded.tentativas, em = excluded.em`).run(cid, etapa, tipo, JSON.stringify(dados || {}), tentativas, t0);

function avisar(c, motivo, textoIn, t0) {
  const P = require('./predio.js'), W = require('./whatsapp.js'), quem = c.nome || ('+' + String(c.jid || '').split('@')[0]);
  W.avisarDono(`*${P.nomes().gerente}: atendimento humano*\n${P.nomes().prospectora} (WhatsApp) passou: *${quem}* ${motivo}\n\n"${String(textoIn).slice(0, 300)}"\n\nAbra o WhatsApp do painel para continuar.`).catch(() => {});
  P.registrar('prospectora', `Cliente no WhatsApp: ${quem}`, `${motivo} · "${String(textoIn).slice(0, 120)}"`, { contato: c.id }, t0);
  P.registrar('gerente', `Atendimento humano: ${quem}`, `WhatsApp (${P.nomes().prospectora}) · ${motivo}`, { contato: c.id }, t0);
}

// Decide a resposta. Devolve { textos, etapa, tipo, dados, avisar } (sem enviar nada): fácil de testar.
function decidir(e, textoIn, nome) {
  const T = textos(), t = sem(textoIn), etapa = e ? e.etapa : '', d = (e && e.dados) || {}, tipo = (e && e.tipo) || '';
  const R = (textos, et, tp = tipo, dd = d, av = '') => ({ textos: textos ? (Array.isArray(textos) ? textos : [textos]) : [], etapa: et, tipo: tp, dados: dd, avisar: av });
  if (etapa === 'parado') return R(null, 'parado');
  if (RX.parar.test(t)) return R(T.parar(), 'parado', tipo, d);
  if (etapa === 'humano') return R(null, 'humano');                       // já está com você
  if (RX.humano.test(t)) return R(T.humano(), 'humano', tipo, d, '🙋 pediu para falar com uma pessoa');
  const atac = RX.atacado.test(t) || (etapa === 'menu' && /^\s*2\b/.test(t)), varj = RX.varejo.test(t) || (etapa === 'menu' && /^\s*1\b/.test(t));
  if (!etapa || etapa === 'menu') {
    if (atac && !varj) return R(T.atacado(), 'atacado', 'atacado');
    if (varj) return R(T.varejo(), 'varejo', 'varejo');
    if (!etapa) return R(T.menu(nome), 'menu', '');
    if ((e.tentativas || 0) >= 1) return R(T.humano(), 'humano', '', d, '❓ não disse se é varejo ou atacado');
    return { ...R(T.menuDeNovo(), 'menu', ''), tentativas: 1 };
  }
  if (etapa === 'atacado') return R(T.atacadoOk(), 'humano', 'atacado', { ...d, resposta: String(textoIn).slice(0, 300) }, '📦 ATACADO (revenda): quantidade e cidade na mensagem');
  if (etapa === 'varejo') {
    const q = qtdDe(t), cor = (RX.cor.exec(t) || [])[1];
    if (q >= 3) return R(T.muitas(q), 'humano', 'varejo', { ...d, qtd: q }, `🔥 quer ${q} placas (varejo): faça um valor`);
    if (q === 1 || q === 2) return R(T.pedido(q, cor && cor.replace('preto', 'preta')), 'dados', 'varejo', { ...d, qtd: q, cor: cor || '' }, `🔥 VAREJO: quer ${q} placa(s)${cor ? ' ' + cor : ''}`);
    if (cor || RX.sim.test(t)) return R(T.corOuQtd(), 'varejo', 'varejo', { ...d, cor: cor || d.cor || '' });
    if (RX.caro.test(t)) return R(T.caro(), 'varejo');
    if (RX.preco.test(t)) return R(T.preco(), 'varejo');
    if (RX.pensar.test(t)) return R(T.pensar(), 'varejo');
    if (RX.nao.test(t)) return R(T.nao(), 'parado');
    return R(null, 'humano', 'varejo', d, '❓ mandou algo que eu não sei responder (varejo)');
  }
  if (etapa === 'dados') return R(T.dadosOk(), 'humano', 'varejo', { ...d, dados: String(textoIn).slice(0, 300) }, `🧾 PEDIDO VAREJO: ${d.qtd || 1} placa(s)${d.cor ? ' ' + d.cor : ''}. Mande o link de pagamento`);
  return R(null, 'humano', tipo, d, '❓ mandou algo que eu não sei responder');
}

async function atender(c, textoIn, nome, t0 = Date.now()) {
  const e = estado(c.id, t0), r = decidir(e, textoIn, String(nome || '').trim().split(' ')[0]);
  salvar(c.id, r.etapa, r.tipo, r.dados, t0, r.tentativas || 0);
  if (r.avisar) avisar(c, r.avisar, textoIn, t0);
  const W = require('./whatsapp.js');
  for (const tx of r.textos) await W.enviarContato(c, { texto: tx, digitando: Math.min(6000, 1000 + tx.length * 30) }, 'bianca');
  return { acao: r.textos.length ? 'respondeu' : 'quieta', etapa: r.etapa, tipo: r.tipo };
}

module.exports = { atender, decidir, precos, qtdDe };
