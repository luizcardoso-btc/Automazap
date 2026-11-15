// Bianca no balcão do WhatsApp: quem ESCREVE para o número da NexTap (não é empresa da prospecção) é atendido pela Bianca.
// Dois caminhos: VAREJO (empresa da cidade que quer a placa para o próprio estabelecimento: 1 placa R$ 80, 2 placas R$ 140;
// entrega pessoal sem taxa, já configurada, pagamento na entrega; modelos Google, Instagram, WhatsApp e Pix; vídeo vai como vídeo; lembrete após 3h sem resposta; 3+ = preço especial com você)
// e ATACADO (revenda: não tem preço automático aqui, a Bianca anota quantidade e cidade e passa para você).
// O que ela não reconhece vai para você (Gerente avisa no seu WhatsApp). Se você responder pelo celular/painel, ela fica quieta 2h.
const { db, getSetting, setSetting } = require('./db.js');

db.exec('CREATE TABLE IF NOT EXISTS bianca_balcao (contato_id INTEGER PRIMARY KEY, etapa TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT \'\', dados TEXT NOT NULL DEFAULT \'{}\', tentativas INTEGER NOT NULL DEFAULT 0, em INTEGER NOT NULL)');

const DIA = 86400e3;
const sem = t => String(t || '').replace(/[\uFE0F\u20E3]/g, '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const valor = (k, pad) => { const v = parseFloat(String(getSetting(k) || '').replace(/\./g, '').replace(',', '.')); const x = v > 0 ? v : pad; return Number.isInteger(x) ? String(x) : x.toFixed(2).replace('.', ','); };
const precos = () => {
  const um = valor('preco_varejo_1', 80), dois = valor('preco_varejo_2', 140), n = x => parseFloat(x.replace(',', '.')), br = x => Number.isInteger(x) ? String(x) : x.toFixed(2).replace('.', ',');
  const cada = n(dois) / 2, de = n(um) * 2, eco = de - n(dois);
  return { um, dois, cada: br(cada), de: br(de), economia: eco > 0 ? br(eco) : '' };
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
// O que cada placa resolve (benefício antes de preço)
const BENEFICIO = {
  Google: 'a do *Google* faz o cliente satisfeito te avaliar em 5 segundos: mais estrelas, você aparece melhor nas buscas e no Maps e quem ainda não te conhece confia mais',
  Instagram: 'a do *Instagram* faz o cliente seguir o seu perfil na hora: mais seguidores reais para ver suas novidades e promoções',
  WhatsApp: 'a do *WhatsApp* abre a conversa com você em um toque: o cliente salva o seu contato e volta a comprar',
  Pix: 'a do *Pix* faz o cliente pagar sem digitar chave: mais rápido no caixa e sem erro de digitação',
};
const beneficios = mods => [...new Set(mods)].map(m => BENEFICIO[m]).filter(Boolean).map(b => '• ' + b.charAt(0).toUpperCase() + b.slice(1) + '.').join('\n');
// Revenda: mínimo e link do painel do revendedor com o pedido montado (?qtd=N). Sem preço e sem promoção na conversa.
const minimoAtacado = () => { try { return require('./nextap.js').minimo(); } catch (e) { return 5; } };
function linkAtacado(q) { let u = ''; try { u = require('./nextap.js').urlPedido(q); } catch (e) { /* sem site */ } return u.replace('&lead=__LEAD__', '').replace('utm_source=instagram&utm_medium=dm', 'utm_source=whatsapp&utm_medium=bianca'); }
const listaE = mods => { const m = mods.map(x => `*${x}*`); return m.length > 1 ? m.slice(0, -1).join(', ') + ' e ' + m[m.length - 1] : m.join(''); };
const ehVideo = u => /^https?:\/\/\S+\.(mp4|mov)(\?\S*)?$/i.test(u);

function textos() {
  const P = require('./predio.js'), p = precos(), eu = P.nomes().prospectora, dono = P.vendedor(), cidade = P.cidade();
  const video = String(getSetting('video_demo_url') || '').trim();
  const pub = String(getSetting('public_url') || '').replace(/\/+$/, ''), foto = String(getSetting('foto_modelos_url') || '').trim() || (pub ? pub + '/assets/modelos-nextap.jpg' : ''), comFoto = txt => (/^https:\/\/\S+$/.test(foto) ? { midia: foto, texto: txt } : txt);   // foto com todos os modelos
  const comVideo = txt => (ehVideo(video) ? { midia: video, texto: txt } : txt);   // o vídeo vai como vídeo no WhatsApp, com o texto na legenda
    return {
    menu: (nome) => `Oi${nome ? ', ' + nome : ''}! Aqui é a ${eu}, da NexTap. 🙂\n\nPra eu te ajudar certinho: a placa é para o seu estabelecimento ou você quer revender?\n\n1️⃣ Para o meu estabelecimento\n2️⃣ Quero revender (atacado)\n\n_Responda com o número._`,
    menuDeNovo: () => 'Só pra eu te passar a informação certa: é para o *seu estabelecimento* (responda 1️⃣) ou para *revender* (responda 2️⃣)?',
    // 1º balão: só o vídeo e a pergunta do modelo. Valores só se o cliente perguntar (ou na confirmação do pedido).
    varejo: () => [comVideo(`Show! A placa NexTap é de acrílico e fica no balcão: o cliente aproxima o celular (ou aponta a câmera) e já cai onde você quiser, sem aplicativo, em uns 5 segundos. Tem estes modelos:\n\n${LISTA_MODELOS}\n\nVocê prefere uma placa do *Google* ou algum outro modelo?`)],
    preco: (fim) => [`Aqui em ${cidade}:\n• *1 placa:* R$ ${p.um}\n• *2 placas:* ${p.economia ? `de ~R$ ${p.de}~ por *R$ ${p.dois}*: você economiza R$ ${p.economia} (sai R$ ${p.cada} cada)` : `R$ ${p.dois} (sai R$ ${p.cada} cada)`}\n\nValor único, sem mensalidade. O ${dono} leva até o seu estabelecimento já configurada, *sem taxa de entrega*, e o pagamento é feito na entrega.\n\n${fim}`],
    caro: () => [`Entendo! Pensa assim: a placa trabalha todo dia no balcão, sem mensalidade, e uma avaliação boa já pode trazer cliente novo. ${p.economia ? `E levando 2 você economiza R$ ${p.economia}: cada uma sai R$ ${p.cada}.` : `Com 2 placas cada uma sai R$ ${p.cada}.`}`, 'Quer começar com uma só?'],
    pensar: () => ['Claro, sem pressa! 🙂 Quando decidir, é só me chamar aqui. Ficou alguma dúvida de como funciona?'],
    muitas: (q) => [`Para ${q} placas o ${dono} faz um preço especial pra você! Já avisei ele, ele te chama aqui em instantes. 🙌`],
    qtd: (mods) => [`Ótima escolha! ✅\n\n${beneficios(mods)}\n\nE ela já chega configurada com a sua empresa: é só colocar no balcão.`, `Vai querer *1* ou *2* placas?${p.economia ? ' Levando 2 você ganha desconto. 😉' : ''}`],
    qtdDeNovo: () => ['Só pra eu anotar certinho: vai querer *1* ou *2* placas?'],
    modeloDeNovo: () => [`Só pra eu anotar certinho, qual modelo você prefere? *Google*, *Instagram*, *WhatsApp* ou *Pix*?`],
    segundo: () => ['Show, 2 placas! A segunda é do mesmo modelo ou de outro? (*Google*, *Instagram*, *WhatsApp* ou *Pix*)'],
    // Confirmação SEM preço (preço só se o cliente perguntar): benefícios do que ainda não foi explicado + o que vem a seguir
    dados: (q, mods, jaExplicados = []) => { const novos = mods.filter(m => !jaExplicados.includes(m)), oque = q === 2 ? (mods[0] === mods[1] ? `2 placas do *${mods[0]}*` : `2 placas (*${mods.join('* + *')}*)`) : `1 placa do *${mods[0]}*`;
      return [`Perfeito! ✅ Anotado: ${oque}.${novos.length ? `\n\n${beneficios(novos)}` : ''}\n\nO ${dono} leva até você já configurada, *sem taxa de entrega*, e te mostra funcionando na hora.`,
        `${q === 1 ? 'Se quiser 2 placas, é só me falar: levando 2 você ganha desconto. 😉\n\n' : ''}Pra eu agendar, me manda:\n• o *nome da empresa* como aparece no Google\n• o *endereço* (rua e bairro)\n• o melhor *dia e horário* pro ${dono} passar aí`]; },
    modelos: () => [comFoto(`Temos estes modelos:\n\n${LISTA_MODELOS}\n\nO ${dono} leva todos pra você ver na hora da entrega.\n\nVocê prefere a do *Google* ou outro?`)],
    dadosOk: () => [`Anotado! ✅ O ${dono} vai te confirmar por aqui o dia e o horário. Ele leva a placa já configurada, sem taxa de entrega, e você só paga na hora, depois de ver funcionando. Obrigada pela confiança! 💙`],
    // Atacado: simulação direto no painel do revendedor (sem preço nem promoção na conversa)
    atacado: () => ['Que legal! 🙌\n\nPra revenda, você compra direto pelo *painel do revendedor*:\n\n• Preço especial por quantidade\n• Entrega para todo o Brasil\n• Placas prontas para você configurar para os seus clientes',
      comFoto(`Estes são os modelos disponíveis:\n\n${LISTA_MODELOS}\n\nQuais modelos você quer revender? Pode escolher mais de um. 🙂`)],
    atacadoModDeNovo: () => [`Só pra eu montar certinho: quais modelos você quer?\n\n${LISTA_MODELOS}\n\nSe quiser todos, é só responder *todos*. 🙂`],
    atacadoQtd: (mods) => [`Ótima escolha! ✅\n\nModelos: ${listaE(mods)}.\n\nQuantas placas você quer na primeira compra?\n\n_Exemplo: 10, 20 ou 50._`],
    atacadoQtdDeNovo: () => ['Me diz só o número, por favor: quantas placas você quer na primeira compra?\n\n_Exemplo: 10, 20 ou 50._'],
    atacadoMin: (min) => [`Para revenda, o pedido mínimo é de *${min} placas*.\n\nQuer que eu monte a simulação com ${min}?`],
    atacadoLink: (q, url, mods) => [`Pronto! ✅\n\nMontei a sua simulação:\n\n• *${q} placas*${mods && mods.length ? `\n• Modelos: ${listaE(mods)}` : ''}`,
      `Agora é só criar a sua conta grátis no *painel do revendedor*.\n\nO pedido já abre com as ${q} placas e, lá, você:\n\n• Vê o valor por quantidade\n• Calcula o frete pelo seu CEP\n• Finaliza no Pix ou no cartão\n\n👉 ${url}`,
      'Qualquer dúvida no cadastro, é só me chamar aqui. 🙂'],
    atacadoPreco: () => ['O valor por quantidade aparece no painel assim que você cria a sua conta (leva 1 minuto).\n\nLá também já calcula o frete para o seu CEP. 🙂'],
    humano: () => [`Claro! Já avisei o ${dono}, ele te responde por aqui. 🙂`],
    nao: () => ['Sem problema! Se um dia quiser mais avaliações no Google, é só me chamar. 🙌'],
    parar: () => ['Combinado, não escrevo mais. Bom trabalho!'],
    // Lembrete quando o cliente some por 3 horas no meio da conversa (um por etapa)
    lembrete: {
      menu: () => 'Oi! 🙂 Ainda posso te ajudar com a placa? É só responder 1️⃣ (para o seu estabelecimento) ou 2️⃣ (para revender).',
      varejo: () => 'Oi! 🙂 Conseguiu ver o vídeo? Você prefere a placa do *Google* ou algum outro modelo?',
      modelo: () => 'Oi! 🙂 Conseguiu ver o vídeo? Você prefere a placa do *Google* ou algum outro modelo?',
      qtd: () => 'Oi! 🙂 Só falta me dizer: vai querer *1* ou *2* placas?',
      segundo: () => 'Oi! 🙂 Só falta me dizer o modelo da segunda placa: o mesmo ou outro?',
      dados: () => `Oi! 🙂 Pra o ${dono} levar a sua placa, só preciso do nome da empresa, do endereço e do melhor dia e horário.`,
      atacado: () => 'Oi! 🙂\n\nMe diz quais modelos você quer revender (*Google*, *Instagram*, *WhatsApp* ou *Pix*), que eu já monto a sua simulação.',
      atacado_qtd: () => 'Oi! 🙂\n\nSó falta me dizer quantas placas você quer na primeira compra, que eu já monto a sua simulação.',
    },
  };
}

// Recomeçar do zero (para testar do mesmo número): o cliente manda "#teste" ou "reiniciar", ou você usa o botão no painel.
const REINICIO = /^#?\s*(teste|reiniciar|recomecar|reset)\s*$/;
const ehReinicio = texto => REINICIO.test(sem(texto));
function reiniciar(cid) { return cid ? db.prepare('DELETE FROM bianca_balcao WHERE contato_id = ?').run(cid).changes : db.prepare('DELETE FROM bianca_balcao').run().changes; }
if (!getSetting('bianca_balcao_reset_1')) { db.exec('DELETE FROM bianca_balcao'); setSetting('bianca_balcao_reset_1', new Date().toISOString()); }   // recomeço pedido em 15/11
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
    if (atac && !varj) return R(T.atacado(), 'atacado', 'atacado', qtdDe(t) ? { qtd: qtdDe(t) } : {});   // primeiro os modelos (com a foto), depois a quantidade
    if (varj) return R(T.varejo(), 'varejo', 'varejo');
    if (!etapa) return R(T.menu(nome), 'menu', '');
    if ((e.tentativas || 0) >= 1) return R(T.humano(), 'humano', '', d, '❓ não disse se é varejo ou atacado');
    return { ...R(T.menuDeNovo(), 'menu', ''), tentativas: 1 };
  }
  const modsAt = /\b(todos|todas|tudo|os 4|as 4|os quatro|as quatro)\b/.test(t) ? MODELOS.map(m => m[0]) : modelosDe(t);
  const simular = (q, mods, dd) => ({ ...R(T.atacadoLink(q, linkAtacado(q), mods), 'atacado_link', 'atacado', { ...dd, qtd: q, modelos: mods }), log: `📦 Atacado: simulação de ${q} placas${mods.length ? ' (' + mods.join(', ') + ')' : ''} enviada (painel do revendedor)` });
  // Atacado 1: quais modelos?
  if (etapa === 'atacado') {
    const q = qtdDe(t) || d.qtd || 0, min = minimoAtacado();
    if (modsAt.length) { if (q >= min) return simular(q, modsAt, d); return R(T.atacadoQtd(modsAt), 'atacado_qtd', 'atacado', { ...d, modelos: modsAt }); }
    if (RX.preco.test(t)) return R([...T.atacadoPreco(), ...T.atacadoModDeNovo()], etapa);
    if ((e.tentativas || 0) >= 1) return R(null, 'humano', 'atacado', d, '❓ revenda: não entendi os modelos');
    return { ...R(T.atacadoModDeNovo(), etapa, 'atacado', qtdDe(t) ? { ...d, qtd: qtdDe(t) } : d), tentativas: 1 };
  }
  // Atacado 2: quantas?
  if (etapa === 'atacado_qtd' || etapa === 'atacado_min') {
    const min = minimoAtacado(), q = etapa === 'atacado_min' && RX.sim.test(t) && !qtdDe(t) ? min : qtdDe(t), mods = modsAt.length ? modsAt : (d.modelos || []);
    if (q >= min) return simular(q, mods, d);
    if (q > 0) return R(T.atacadoMin(min), 'atacado_min', 'atacado', { ...d, qtd: q });
    if (RX.preco.test(t)) return R([...T.atacadoPreco(), ...T.atacadoQtdDeNovo()], etapa);
    if ((e.tentativas || 0) >= 1) return R(null, 'humano', 'atacado', d, '❓ revenda: não entendi a quantidade');
    return { ...R(T.atacadoQtdDeNovo(), etapa), tentativas: 1 };
  }
  if (etapa === 'atacado_link') {
    const q = qtdDe(t);
    if (q >= minimoAtacado() && q !== d.qtd) return simular(q, modsAt.length ? modsAt : (d.modelos || []), d);
    if (RX.preco.test(t)) return R(T.atacadoPreco(), 'atacado_link');
    if (RX.sim.test(t) || /obrigad|valeu|blz|beleza|ok|certo|show/.test(t)) return R(['Por nada! 🙌\n\nQualquer coisa, é só me chamar.'], 'atacado_link');
    return R(null, 'humano', 'atacado', d, `❓ revenda (${d.qtd} placas): mandou algo que eu não sei responder depois da simulação`);
  }
  const mods = [...new Set([...(d.modelos || []), ...modelosDe(t)])];
  const extra = (RX.caro.test(t) && T.caro()) || (RX.preco.test(t) && 'preco') || null;
  // Etapa 1 (varejo): qual modelo? Valores só se perguntar.
  if (etapa === 'varejo' || etapa === 'modelo') {
    const q = qtdDe(t), tudo = { ...d, modelos: mods };
    if (q >= 3 || mods.length >= 3) { const n = Math.max(q, mods.length); return R(T.muitas(n), 'humano', 'varejo', { ...tudo, qtd: n }, `🔥 VAREJO: quer ${n} placas${mods.length ? ' (' + mods.join(', ') + ')' : ''}. Faça um preço especial (não é atacado)`); }
    if (mods.length === 2 || (mods.length && q)) { const n = mods.length === 2 ? 2 : q, m = n === 2 && mods.length === 1 ? [mods[0], mods[0]] : mods; return R(T.dados(n, m), 'dados', 'varejo', { ...tudo, modelos: m, qtd: n }); }
    if (mods.length === 1) return R(T.dados(1, mods), 'dados', 'varejo', { ...tudo, qtd: 1 });   // escolheu: já pede os dados da empresa
    if (extra === 'preco') return R(T.preco('E qual modelo você prefere: *Google*, *Instagram*, *WhatsApp* ou *Pix*?'), etapa);
    if (extra) return R(extra, etapa);
    if (/modelo|tipo|quais|opc/.test(t)) return R(T.modelos(), etapa);
    if (RX.pensar.test(t)) return R(T.pensar(), etapa);
    if (RX.nao.test(t)) return R(T.nao(), 'parado');
    if ((e.tentativas || 0) >= 1) return R(null, 'humano', 'varejo', d, '❓ não consegui entender o modelo que ele quer');
    return { ...R(T.modeloDeNovo(), etapa), tentativas: 1 };
  }
  // Etapa 2: quantas (1 ou 2)
  if (etapa === 'qtd') {
    const q = qtdDe(t), tudo = { ...d, modelos: mods };
    if (q >= 3) return R(T.muitas(q), 'humano', 'varejo', { ...tudo, qtd: q }, `🔥 VAREJO: quer ${q} placas (${mods.join(', ')}). Faça um preço especial (não é atacado)`);
    if (q === 2 && mods.length < 2) return /mesm|igua|ambas|as duas/.test(t) ? R(T.dados(2, [mods[0], mods[0]], mods), 'dados', 'varejo', { ...tudo, modelos: [mods[0], mods[0]], qtd: 2 }) : R(T.segundo(), 'segundo', 'varejo', { ...tudo, qtd: 2 });
    if (q === 1 || q === 2) return R(T.dados(q, mods.slice(0, q), mods), 'dados', 'varejo', { ...tudo, modelos: mods.slice(0, q), qtd: q });
    if (extra === 'preco') return R(T.preco('Vai querer *1* ou *2*?'), 'qtd');
    if (extra) return R(extra, 'qtd');
    if (RX.pensar.test(t)) return R(T.pensar(), 'qtd');
    if (RX.nao.test(t)) return R(T.nao(), 'parado');
    if ((e.tentativas || 0) >= 1) return R(null, 'humano', 'varejo', d, `❓ escolheu ${mods.join(', ')}, mas não entendi a quantidade`);
    return { ...R(T.qtdDeNovo(), 'qtd'), tentativas: 1 };
  }
  // 2 placas, falta o modelo da segunda
  if (etapa === 'segundo') {
    const p0 = (d.modelos || [])[0], novos = modelosDe(t), m2 = novos.length ? [p0, novos.find(x => x !== p0) || novos[0]] : /mesm|igua|tambem/.test(t) ? [p0, p0] : null;
    if (m2) return R(T.dados(2, m2, [p0]), 'dados', 'varejo', { ...d, modelos: m2 });
    if (extra === 'preco') return R(T.preco('E a segunda placa, é do mesmo modelo ou de outro?'), 'segundo');
    if ((e.tentativas || 0) >= 1) return R(null, 'humano', 'varejo', d, '❓ quer 2 placas, mas não entendi o modelo da segunda');
    return { ...R(T.segundo(), 'segundo'), tentativas: 1 };
  }
  if (etapa === 'dados') {
    const q = qtdDe(t), curta = t.length <= 50 && !/\b(rua|av|avenida|travessa|bairro|n[ºo°]?\s?\d)/.test(t);
    if (curta && q >= 3) return R(T.muitas(q), 'humano', 'varejo', { ...d, qtd: q }, `🔥 VAREJO: quer ${q} placas (${(d.modelos || []).join(', ')}). Faça um preço especial (não é atacado)`);
    if (curta && q === 2 && (d.qtd || 1) === 1) { const m = modelosDe(t).find(x => x !== d.modelos[0]) || d.modelos[0], m2 = [d.modelos[0], m]; return R(T.dados(2, m2, d.modelos), 'dados', 'varejo', { ...d, modelos: m2, qtd: 2 }); }
    if (extra === 'preco') return R(T.preco('Agora é só me mandar o nome da empresa, o endereço e o melhor dia e horário. 🙂'), 'dados');
  }
  if (etapa === 'dados') return R(T.dadosOk(), 'humano', 'varejo', { ...d, dados: String(textoIn).slice(0, 300) }, `🧾 PEDIDO VAREJO: ${d.qtd || 1} placa(s)${(d.modelos || []).length ? ' (' + d.modelos.join(', ') + ')' : ''}. Confirme dia e horário da entrega (pagamento na entrega)`);
  return R(null, 'humano', tipo, d, '❓ mandou algo que eu não sei responder');
}

const enviarItem = (W, c, x) => typeof x === 'string'
  ? W.enviarContato(c, { texto: x, digitando: Math.min(6000, 1000 + x.length * 30) }, 'bianca')
  : W.enviarContato(c, { midia: x.midia, texto: x.texto }, 'bianca');
async function atender(c, textoIn, nome, t0 = Date.now()) {
  if (ehReinicio(textoIn)) reiniciar(c.id);
  const e = estado(c.id, t0), r = decidir(e, textoIn, String(nome || '').trim().split(' ')[0]);
  salvar(c.id, r.etapa, r.tipo, r.dados, t0, r.tentativas || 0);
  if (r.avisar) avisar(c, r.avisar, textoIn, t0);
  if (r.log) require('./predio.js').registrar('prospectora', `Revenda no WhatsApp: ${c.nome || '+' + String(c.jid || '').split('@')[0]}`, r.log, { contato: c.id }, t0);
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
  const L = db.prepare("SELECT * FROM bianca_balcao WHERE lembrado = 0 AND etapa IN ('menu','varejo','modelo','qtd','segundo','dados','atacado','atacado_qtd') AND em <= ? AND em > ? ORDER BY em LIMIT 5").all(t0 - 3 * 3600e3, t0 - DIA);
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

module.exports = { reiniciar, ehReinicio, atender, decidir, lembrar, precos, qtdDe, modelosDe };
