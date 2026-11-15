// Bianca no balcão do WhatsApp: quem ESCREVE para o número da NexTap (não é empresa da prospecção) é atendido pela Bianca.
// Dois caminhos: VAREJO (empresa da cidade que quer a placa para o próprio estabelecimento: 1 placa R$ 80, 2 placas R$ 140;
// entrega pessoal sem taxa, já configurada, pagamento na entrega; modelos Google, Instagram, WhatsApp e Pix; vídeo vai como vídeo; lembrete após 3h sem resposta; 3+ = preço especial com você)
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
// Modelos de placa (o cliente escolhe; pode ser um de cada)
const MODELOS = [['Google', /google|avalia/], ['Instagram', /insta/], ['WhatsApp', /whats|zap/], ['Pix', /\bpix\b/]];
const modelosDe = t => MODELOS.filter(([, r]) => r.test(t)).map(([n]) => n);
const LISTA_MODELOS = '• *Google* (avaliações)\n• *Instagram*\n• *WhatsApp*\n• *Pix*';
const qtdDe = t => { const m = /\b(\d{1,4})\b/.exec(t); if (m) return Number(m[1]); if (/\b(duas|dois)\b/.test(t)) return 2; if (/\b(uma|um|1a)\b/.test(t)) return 1; if (/\b(tres|quatro|cinco|seis|dez)\b/.test(t)) return 3; return 0; };
const ehVideo = u => /^https?:\/\/\S+\.(mp4|mov)(\?\S*)?$/i.test(u);

function textos() {
  const P = require('./predio.js'), p = precos(), eu = P.nomes().prospectora, dono = P.vendedor(), cidade = P.cidade();
  const video = String(getSetting('video_demo_url') || '').trim();
  const comVideo = txt => (ehVideo(video) ? { midia: video, texto: txt } : txt);   // o vídeo vai como vídeo no WhatsApp, com o texto na legenda
  const qtdOk = q => `*${q === 2 ? `2 placas por R$ ${p.dois}` : `1 placa por R$ ${p.um}`}*`;
  return {
    menu: (nome) => `Oi${nome ? ', ' + nome : ''}! Aqui é a ${eu}, da NexTap. 🙂\n\nPra eu te ajudar certinho: a placa é para o seu estabelecimento ou você quer revender?\n\n*1* Para o meu estabelecimento\n*2* Quero revender (atacado)\n\n_Responda com o número._`,
    menuDeNovo: () => 'Só pra eu te passar a informação certa: é para o *seu estabelecimento* (responda *1*) ou para *revender* (responda *2*)?',
    varejo: () => [comVideo(`Show! A placa NexTap é de acrílico e fica no balcão: o cliente aproxima o celular (ou aponta a câmera) e já cai onde você quiser, sem aplicativo, em uns 5 segundos. Tem estes modelos:\n\n${LISTA_MODELOS}`),
      `Os valores aqui em ${cidade}:\n\n• *1 placa:* R$ ${p.um}\n• *2 placas:* R$ ${p.dois} (sai R$ ${p.cada} cada)\n\nValor único, sem mensalidade. O ${dono} leva até o seu estabelecimento já configurada, *sem taxa de entrega*, e mostra os modelos na hora. O pagamento é feito na entrega.\n\nVai querer *1* ou *2*?`],
    preco: () => [`Aqui em ${cidade}:\n• *1 placa:* R$ ${p.um}\n• *2 placas:* R$ ${p.dois} (sai R$ ${p.cada} cada)\n\nValor único, sem mensalidade. Entrega no seu estabelecimento sem taxa, já configurada, e você paga na entrega. Vai querer *1* ou *2*?`],
    caro: () => [`Entendo! Pensa assim: a placa trabalha todo dia no balcão, sem mensalidade, e uma avaliação boa já pode trazer cliente novo. Com 2 placas cada uma sai R$ ${p.cada}.`, 'Quer começar com uma só?'],
    pensar: () => ['Claro, sem pressa! 🙂 Quando decidir, é só me chamar aqui. Ficou alguma dúvida de como funciona?'],
    muitas: (q) => [`Para ${q} placas o ${dono} faz um preço especial pra você! Já avisei ele, ele te chama aqui em instantes. 🙌`],
    qtd: () => ['Vai querer *1* ou *2*?'],
    modelo: (q) => [`Perfeito! 🙌 Anotado: ${qtdOk(q)}.`, `${q === 2 ? 'Quais modelos você quer? Pode ser um de cada.' : 'Qual modelo você quer?'}\n\n${LISTA_MODELOS}`],
    modeloDeNovo: () => [`Só pra eu anotar certinho, qual modelo? *Google*, *Instagram*, *WhatsApp* ou *Pix*?`],
    dados: (q, mods) => [`Ótimo! ${qtdOk(q)} (${mods.join(' + ')}). ✅`, `Agora me manda, por favor:\n• o *nome da empresa* como aparece no Google\n• o *endereço* (rua e bairro)\n• o melhor *dia e horário* pro ${dono} passar aí\n\nEle leva já configurada, sem taxa de entrega, e você paga na hora.`],
    modelos: () => [`Temos estes modelos:\n${LISTA_MODELOS}\n\nO ${dono} leva todos pra você ver na hora da entrega. Vai querer *1* ou *2*?`],
    dadosOk: () => [`Anotado! ✅ O ${dono} vai te confirmar por aqui o dia e o horário da entrega. Ele leva a placa já configurada, sem taxa, e o pagamento é na hora. Obrigada pela confiança! 💙`],
    atacado: () => [`Que legal! Para revenda (atacado), quem cuida é o ${dono} pessoalmente, com valor por quantidade.`, 'Me conta: quantas placas você está pensando e de qual cidade você é?'],
    atacadoOk: () => [`Obrigada! Já passei tudo para o ${dono}, ele te chama aqui em breve. 🙌`],
    humano: () => [`Claro! Já avisei o ${dono}, ele te responde por aqui. 🙂`],
    nao: () => ['Sem problema! Se um dia quiser mais avaliações no Google, é só me chamar. 🙌'],
    parar: () => ['Combinado, não escrevo mais. Bom trabalho!'],
    // Lembrete quando o cliente some por 3 horas no meio da conversa (um por etapa)
    lembrete: {
      menu: () => 'Oi! 🙂 Ainda posso te ajudar com a placa? É só responder *1* (para o seu estabelecimento) ou *2* (para revender).',
      varejo: () => 'Oi! 🙂 Conseguiu ver o vídeo? A placa já chega configurada e o pagamento é só na entrega. Vai querer *1* ou *2*?',
      modelo: () => `Oi! 🙂 Só falta escolher o modelo pra eu reservar a sua: *Google*, *Instagram*, *WhatsApp* ou *Pix*?`,
      dados: () => `Oi! 🙂 Pra o ${dono} levar a sua placa, só preciso do nome da empresa, do endereço e do melhor dia e horário.`,
      atacado: () => `Oi! 🙂 Me conta quantas placas e de qual cidade você é, que eu já passo para o ${dono}.`,
    },
  };
}

{ const tem = db.prepare('PRAGMA table_info(bianca_balcao)').all().some(x => x.name === 'lembrado'); if (!tem) db.exec('ALTER TABLE bianca_balcao ADD COLUMN lembrado INTEGER NOT NULL DEFAULT 0'); }
function estado(cid, t0) {
  const e = db.prepare('SELECT * FROM bianca_balcao WHERE contato_id = ?').get(cid);
  if (!e) return null;
  if (e.etapa === 'parado') return e;
  return t0 - e.em > DIA ? null : { ...e, dados: JSON.parse(e.dados || '{}') };   // 24h parada: recomeça do zero
}
const salvar = (cid, etapa, tipo, dados, t0, tentativas = 0) => db.prepare(`INSERT INTO bianca_balcao (contato_id, etapa, tipo, dados, tentativas, em, lembrado) VALUES (?, ?, ?, ?, ?, ?, 0)
  ON CONFLICT(contato_id) DO UPDATE SET etapa = excluded.etapa, tipo = excluded.tipo, dados = excluded.dados, tentativas = excluded.tentativas, em = excluded.em, lembrado = 0`).run(cid, etapa, tipo, JSON.stringify(dados || {}), tentativas, t0);

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
  const mods = [...new Set([...(d.modelos || []), ...modelosDe(t)])];
  if (etapa === 'varejo') {
    const q = qtdDe(t), tudo = { ...d, modelos: mods };
    if (q >= 3) return R(T.muitas(q), 'humano', 'varejo', { ...tudo, qtd: q }, `🔥 VAREJO: quer ${q} placas${mods.length ? ' (' + mods.join(', ') + ')' : ''}. Faça um preço especial (não é atacado)`);
    if ((q === 1 || q === 2) && mods.length) return R(T.dados(q, mods), 'dados', 'varejo', { ...tudo, qtd: q });   // já disse quantidade e modelo
    if (q === 1 || q === 2) return R(T.modelo(q), 'modelo', 'varejo', { ...tudo, qtd: q });
    if (/modelo|tipo|quais|opc/.test(t) && !mods.length) return R(T.modelos(), 'varejo', 'varejo', tudo);
    if (mods.length || RX.sim.test(t)) return R(T.qtd(), 'varejo', 'varejo', tudo);
    if (RX.caro.test(t)) return R(T.caro(), 'varejo');
    if (RX.preco.test(t)) return R(T.preco(), 'varejo');
    if (RX.pensar.test(t)) return R(T.pensar(), 'varejo');
    if (RX.nao.test(t)) return R(T.nao(), 'parado');
    return R(null, 'humano', 'varejo', d, '❓ mandou algo que eu não sei responder (varejo)');
  }
  if (etapa === 'modelo') {
    if (mods.length) return R(T.dados(d.qtd || 1, mods), 'dados', 'varejo', { ...d, modelos: mods });
    if (RX.pensar.test(t)) return R(T.pensar(), 'modelo');
    if ((e.tentativas || 0) >= 1) return R(null, 'humano', 'varejo', d, `❓ quer ${d.qtd || 1} placa(s), mas não consegui entender o modelo`);
    return { ...R(T.modeloDeNovo(), 'modelo'), tentativas: 1 };
  }
  if (etapa === 'dados') return R(T.dadosOk(), 'humano', 'varejo', { ...d, modelos: mods, dados: String(textoIn).slice(0, 300) }, `🧾 PEDIDO VAREJO: ${d.qtd || 1} placa(s)${mods.length ? ' (' + mods.join(', ') + ')' : ''}. Confirme dia e horário da entrega (pagamento na entrega)`);
  return R(null, 'humano', tipo, d, '❓ mandou algo que eu não sei responder');
}

const enviarItem = (W, c, x) => typeof x === 'string'
  ? W.enviarContato(c, { texto: x, digitando: Math.min(6000, 1000 + x.length * 30) }, 'bianca')
  : W.enviarContato(c, { midia: x.midia, texto: x.texto }, 'bianca');
async function atender(c, textoIn, nome, t0 = Date.now()) {
  const e = estado(c.id, t0), r = decidir(e, textoIn, String(nome || '').trim().split(' ')[0]);
  salvar(c.id, r.etapa, r.tipo, r.dados, t0, r.tentativas || 0);
  if (r.avisar) avisar(c, r.avisar, textoIn, t0);
  const W = require('./whatsapp.js');
  for (const x of r.textos) {
    try { await enviarItem(W, c, x); }
    catch (err) { if (typeof x === 'string' || !x.texto) throw err; await enviarItem(W, c, x.texto); }   // vídeo falhou: manda só o texto
  }
  return { acao: r.textos.length ? 'respondeu' : 'quieta', etapa: r.etapa, tipo: r.tipo };
}

// Cliente parou de responder no meio da conversa: depois de 3 horas a Bianca manda UM lembrete (entre 8h e 20h30).
// Não lembra se você entrou na conversa pelo celular/painel.
async function lembrar(t0 = Date.now()) {
  const W = require('./whatsapp.js'), d = new Date(t0 - 3 * 3600e3), m = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (getSetting('wa_robo') !== '1' || !W.configurado() || m < 480 || m > 1230) return 0;
  const T = textos().lembrete;
  const L = db.prepare("SELECT * FROM bianca_balcao WHERE lembrado = 0 AND etapa IN ('menu','varejo','modelo','dados','atacado') AND em <= ? AND em > ? ORDER BY em LIMIT 5").all(t0 - 3 * 3600e3, t0 - DIA);
  let n = 0;
  for (const b of L) {
    db.prepare('UPDATE bianca_balcao SET lembrado = 1 WHERE contato_id = ?').run(b.contato_id);
    const c = db.prepare('SELECT * FROM wa_contatos WHERE id = ?').get(b.contato_id);
    if (!c || c.prospect_id) continue;
    const ult = db.prepare("SELECT direcao, origem FROM wa_mensagens WHERE contato_id = ? ORDER BY id DESC LIMIT 1").get(c.id);
    if (!ult || ult.direcao !== 'out' || ult.origem !== 'bianca') continue;   // cliente respondeu, ou você assumiu
    try { await enviarItem(W, c, T[b.etapa]()); n++; require('./predio.js').registrar('prospectora', `Lembrete: ${c.nome || '+' + String(c.jid).split('@')[0]}`, `Sem resposta há 3h (etapa: ${b.etapa}).`, { contato: c.id }, t0); }
    catch (e) { console.error('[BIANCA] lembrete:', e.message); }
  }
  return n;
}

module.exports = { atender, decidir, lembrar, precos, qtdDe, modelosDe };
