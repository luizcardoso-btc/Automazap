// Bianca no balcão do WhatsApp: quem ESCREVE para o número da NexTap (não é empresa da prospecção) é atendido pela Bianca.
// Dois caminhos: VAREJO (empresa da cidade que quer a placa para o próprio estabelecimento: 1 placa R$ 80, 2 placas R$ 140;
// entrega pessoal sem taxa, já configurada, pagamento na entrega; modelos Google, Instagram, WhatsApp e Pix; vídeo vai como vídeo; lembrete após 3h sem resposta; 3+ = preço especial com você)
// e ATACADO (revenda: não tem preço automático aqui, a Bianca anota quantidade e cidade e passa para você).
// O que ela não reconhece vai para você (Gerente avisa no seu WhatsApp). Se você responder pelo celular/painel, ela fica quieta 2h.
const { db, getSetting, setSetting } = require('./db.js');

db.exec('CREATE TABLE IF NOT EXISTS bianca_balcao (contato_id INTEGER PRIMARY KEY, etapa TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT \'\', dados TEXT NOT NULL DEFAULT \'{}\', tentativas INTEGER NOT NULL DEFAULT 0, em INTEGER NOT NULL)');

const DIA = 86400e3;
const precoPerso = () => { const v = parseFloat(String(getSetting('preco_personalizada') || '').replace(/\./g, '').replace(',', '.')); return v > 0 ? v : 21.9; };
const MIN_PERSO = 50;

// ---------- Treino: perguntas e respostas (você edita no painel) ----------
// Valem em qualquer etapa da conversa. {painel} = link do painel do revendedor (login). "avisar" = também te chama (sem o cliente ver).
db.exec(`CREATE TABLE IF NOT EXISTS bianca_faq (id INTEGER PRIMARY KEY AUTOINCREMENT, palavras TEXT NOT NULL, resposta TEXT NOT NULL, avisar INTEGER NOT NULL DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1, usos INTEGER NOT NULL DEFAULT 0, criado_em INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS bianca_perguntas (id INTEGER PRIMARY KEY AUTOINCREMENT, contato_id INTEGER, texto TEXT NOT NULL, etapa TEXT NOT NULL DEFAULT '', criado_em INTEGER NOT NULL);`);
const FAQ0 = [
  ['ja comprei, comprei, meu pedido, nao chegou, nao chegaram, ainda nao chegou, quando vai chegar, rastreio, rastreamento, codigo de rastreio, cade minhas placas, cade meu pedido, ja paguei',
    'Que bom que você já é cliente NexTap! 💚\n\nO andamento do seu pedido (produção, envio e rastreio) aparece no painel do revendedor, em *Pedidos*:\n\n👉 {painel}\n\nSe preferir, me manda o *e-mail do cadastro* ou o *número do pedido* que eu confiro pra você também. 🙂', 1],
  ['como configurar, como ativar, ativar a placa, configurar a placa, nao funciona, nao esta funcionando, nao ta funcionando, nao abre, nfc nao, qr code nao',
    'Eu te ajudo! 🙂\n\nNo painel do revendedor tem a *NFC Academy*, com vídeo passo a passo de como ativar e configurar a placa:\n\n👉 {painel}\n\nSe mesmo assim não funcionar, me manda uma foto da placa e me conta o que acontece quando aproxima o celular.', 1],
  ['defeito, quebrou, quebrada, veio quebrada, veio errada, trocar a placa, troca, garantia',
    'Poxa, sinto muito! 😕\n\nPlaca com defeito tem troca, pode ficar tranquilo(a).\n\nMe manda, por favor:\n\n• Uma *foto* da placa\n• O *e-mail do cadastro* ou o *número do pedido*\n\nQue eu já encaminho a troca pra você.', 1],
  ['forma de pagamento, formas de pagamento, como pago, como pagar, aceita cartao, aceita pix, pagar no cartao, pagar no pix, boleto',
    'No painel do revendedor você finaliza no *Pix* ou no *cartão*. 💳\n\nE no varejo aqui na cidade, o pagamento é feito na hora da entrega. 🙂', 0],
  ['esqueci a senha, esqueci minha senha, nao consigo entrar, nao consigo acessar, recuperar senha',
    'Sem problema! 🙂\n\nNa tela de entrada do painel tem a opção *Esqueci a senha*: é só colocar o seu e-mail que chega um link para criar uma nova.\n\n👉 {painel}', 0],
];
if (!db.prepare('SELECT COUNT(*) AS n FROM bianca_faq').get().n) { const ins = db.prepare('INSERT INTO bianca_faq (palavras, resposta, avisar, criado_em) VALUES (?, ?, ?, ?)'); for (const [p, r, a] of FAQ0) ins.run(p, r, a, Date.now()); }
const FAQ_V2 = [
  ['prazo, prazo de entrega, quanto tempo, demora quanto, demora quantos dias, quantos dias, quando chega, tempo de entrega, tempo de producao',
    '⏱️ Os prazos da NexTap:\n\n• *Produção:* de 5 a 7 dias\n• *Envio pelos Correios:* de 3 a 10 dias, dependendo do modo de envio que você escolher\n\nEnviamos da Bahia para todo o Brasil. 📦\n\nAqui em Feira de Santana, no varejo, a entrega é pessoal, no dia que a gente combinar. 🙂', 0],
  ['loja fisica, tem loja, voces tem loja, onde fica, onde voces ficam, endereco de voces, de onde voces sao, posso ir ai, posso buscar, retirar pessoalmente',
    'Não temos loja física: atendemos só online e enviamos da Bahia para todo o Brasil. 📦\n\nAqui em Feira de Santana, no varejo, a gente leva até você, sem taxa de entrega. 🙂', 0],
];
if (!getSetting('bianca_faq_v2')) {   // bancos que já tinham as respostas da 1ª versão
  const ins = db.prepare('INSERT INTO bianca_faq (palavras, resposta, avisar, criado_em) VALUES (?, ?, ?, ?)');
  if (db.prepare('SELECT COUNT(*) AS n FROM bianca_faq').get().n) db.prepare("UPDATE bianca_faq SET palavras = replace(replace(palavras, ' quando chega,', ''), ' prazo de entrega,', '') WHERE palavras LIKE 'ja comprei,%'").run();
  for (const [p, r, a] of FAQ_V2) ins.run(p, r, a, Date.now());
  setSetting('bianca_faq_v2', new Date().toISOString());
}
if (!getSetting('bianca_obj_v1')) { try { db.exec("DELETE FROM bianca_perguntas WHERE lower(trim(texto, ' .!?')) IN ('tá caro','ta caro','não sei','nao sei')"); } catch (e) { /* ok */ } setSetting('bianca_obj_v1', '1'); }
// Objeções e dúvidas comuns (v3). Todas terminam com pergunta ou ganham a pergunta da etapa.
const FAQ_V3 = [
  ['golpe, e golpe, confiavel, e confiavel, posso confiar, e seguro, e verdade, e real isso, empresa seria, reclame aqui',
    'Pergunta super justa! 🙂\n\nA NexTap é uma empresa da Bahia que vende placas de avaliação para comércios do Brasil todo. Pra você comprar tranquilo:\n\n• Aqui em Feira de Santana, no varejo, você *só paga na entrega*, depois de ver a placa funcionando\n• No painel do revendedor, o pagamento é pelo Pix ou cartão, com o pedido registrado na sua conta\n• Placa com defeito tem troca\n\nNo Instagram você vê o nosso trabalho: @nextapbr', 0],
  ['iphone, android, todo celular, qualquer celular, celular antigo, celular sem nfc, nao tem nfc, sem nfc, funciona em qualquer',
    'Funciona sim! 📱\n\n• Nos celulares com *NFC* (a maioria dos Android e os iPhones mais novos), é só *aproximar* da placa\n• Em *qualquer celular* com câmera, é só *apontar para o QR Code*\n\nOu seja: nenhum cliente fica de fora. ✅', 0],
  ['mensalidade, tem mensalidade, assinatura, paga todo mes, taxa mensal, cobranca mensal',
    'Não tem mensalidade nenhuma! 🙌\n\nVocê paga *uma vez só* e a placa é sua. Ela trabalha todo dia no seu balcão, sem custo extra.', 0],
  ['bateria, pilha, energia, tomada, precisa carregar, precisa de internet, wifi',
    'A placa *não usa bateria, pilha nem energia*: ela fica no balcão e funciona sempre. 🔋❌\n\nQuem precisa de internet é só o celular do seu cliente, pra abrir a página do Google (o que todo mundo já tem).', 0],
  ['tamanho, medida, material, acrilico, resistente, quebra facil, dura quanto tempo, durabilidade',
    'A placa é de *acrílico cristal, 10×10 cm*: bonita, resistente e fácil de limpar. 💎\n\nComo não tem bateria, ela não "descarrega": é só deixar no balcão ou no caixa.', 0],
  ['funciona mesmo, da resultado, vale a pena, meus clientes vao usar, cliente nao vai usar, ninguem vai usar, nao sei se funciona',
    'Funciona porque deixa tudo *fácil*: o cliente avalia em uns 5 segundos, sem procurar a sua empresa no Google. 🙂\n\n💡 Dica que faz muita diferença: na hora do pagamento, o atendente fala "*se puder, encosta o celular aqui e deixa sua avaliação*". Com a placa ali do lado, muito mais gente avalia.', 0],
  ['permitido, e permitido, proibido, proibe, nao proibe, google proibe, pode pedir avaliacao, google bane, google bloqueia, pode banir, contra as regras, politica do google',
    'É permitido sim! ✅\n\nO Google deixa você *pedir* avaliação aos seus clientes. O que ele não permite é *pagar* ou dar brinde em troca de avaliação, ou avaliação falsa.\n\nA placa só facilita o caminho: quem decide a nota é o cliente.', 0],
  ['avaliacao ruim, avaliacao negativa, nota baixa, cliente insatisfeito, e se avaliarem mal',
    'Boa pergunta! 🙂\n\nA placa leva o cliente direto pra avaliar, e quem decide a nota é ele. O lado bom: quanto mais clientes satisfeitos avaliam, *mais a sua nota sobe* e uma avaliação ruim perde força no meio de muitas boas.\n\n💡 Dica: responda todas as avaliações no Google, inclusive as negativas, com educação. Isso passa muita confiança.', 0],
  ['ja tenho avaliacoes, ja tenho muitas, nao preciso, ja tenho nota boa, minha nota ja e boa',
    'Que ótimo, isso é raro! 👏\n\nO ponto é *manter o ritmo*: o Google valoriza avaliação *recente*. A placa deixa isso no automático, todo dia, sem você precisar pedir no WhatsApp.\n\nE além da do Google, tem as de *Instagram*, *WhatsApp* e *Pix*, que também ajudam no dia a dia.', 0],
  ['vou pensar, vou ver, depois eu vejo, depois falo, mais tarde, outra hora, semana que vem, vou falar com meu socio, vou falar com minha esposa, vou falar com meu marido',
    'Claro, sem pressa! 🙂\n\nSó pra eu te ajudar: ficou alguma dúvida de *como funciona*, de *valor* ou de *qual modelo* escolher?', 0],
  ['amostra, testar antes, ver antes, ver funcionando, demonstracao',
    'Pode sim! 🙂\n\nAqui em Feira de Santana, no varejo, o Luiz leva a placa até você *já configurada* e mostra funcionando. Você *só paga na hora*, depois de ver.', 0],
  ['outra cidade, sou de fora, nao sou de feira, voces entregam em, envia para, manda para, entrega em outra cidade',
    'Atendemos o Brasil todo! 📦\n\nFora de Feira de Santana, o envio é pelos *Correios* (de 3 a 10 dias, conforme o modo de envio, depois de 5 a 7 dias de produção).\n\nMe conta: de qual cidade você é e quantas placas você precisa?', 1],
  ['quanto lucro, quanto ganho, da lucro, vale a pena revender, por quanto vendo, por quanto revender, margem',
    'Dá pra ter uma margem muito boa! 💰\n\nAqui em Feira de Santana, a gente vende a placa por *R$ 80* no varejo. No atacado, o valor por placa cai conforme a quantidade, e você vê tudo no painel do revendedor antes de pagar.\n\nE você não começa sozinho: acompanha o *roteiro de vendas* para oferecer aos comércios da sua cidade.', 0],
  ['pedido minimo, minimo, so uma placa, apenas uma, uma unidade, comprar uma so',
    'Depende de onde você está! 🙂\n\n• *Aqui em Feira de Santana* (varejo): pode levar *1 placa*, com entrega sem taxa e pagamento na entrega\n• *Revenda / outras cidades*: o pedido mínimo no painel do revendedor é de *5 placas*', 0],
  ['trocar o link, mudar o link, mudar depois, trocar depois, reprogramar, regravar',
    'Pode ficar tranquilo! 🙂\n\nA placa é configurada com o link da sua empresa. Se um dia precisar mudar (por exemplo, trocar de perfil), me chama aqui que a gente te orienta no passo a passo.', 1],
];
if (!getSetting('bianca_faq_v3')) {
  const ins = db.prepare('INSERT INTO bianca_faq (palavras, resposta, avisar, criado_em) VALUES (?, ?, ?, ?)');
  for (const [p, r, a] of FAQ_V3) ins.run(p, r, a, Date.now());
  setSetting('bianca_faq_v3', new Date().toISOString());
}
const FAQ_V4 = [
  ['onde comprar, onde compro, como comprar, como faco para comprar, como faco pra comprar, como eu compro, onde vende, qual o site, onde fica o site, tem site',
    'Você compra direto com a gente, da fábrica! 🙂\n\n• *Aqui em Feira de Santana* (para o seu estabelecimento): por aqui mesmo, com entrega sem taxa e pagamento na entrega\n• *Revenda ou outras cidades*: pelo painel do revendedor, no site 👉 {painel}', 0],
  ['qr code dinamico, configurar pra loja, configurar para loja, configurar para a loja, configurar para minha loja, ja vem configurado, vem configurado, vem com qr code, qr code ja vem, configurar para meus clientes, configurar pro cliente',
    'Dá sim! 🙂\n\nO *QR Code e o NFC* da NexTap são ativados com o link que *você* escolher: avaliação no Google, Instagram, WhatsApp ou Pix da loja.\n\nPra quem revende, cada placa é configurada para a loja do seu cliente. No painel do revendedor tem a *NFC Academy* com o passo a passo em vídeo. 📲', 0],
  ['frete caro, taxa de entrega, frete alto, valor do frete, quanto e o frete, quanto fica o frete',
    'O frete é calculado pelo seu *CEP* no painel, na hora de finalizar, e você escolhe o modo de envio. 📦\n\n💡 Dica: quanto mais placas no mesmo pedido, menor fica o frete de cada uma.\n\nE aqui em Feira de Santana, no varejo, a entrega é *sem taxa*.', 0],
  ['chave pix, manda o pix, me manda o pix, passa o pix, dados para pagamento, como faco o pagamento',
    'Claro! 🙂\n\n• *Revenda*: o pagamento é feito no painel do revendedor (Pix ou cartão), com o pedido registrado na sua conta\n• *Varejo aqui em Feira*: você paga na hora da entrega\n\nSe você já combinou um pedido comigo, o Luiz te envia os dados do pagamento por aqui em instantes.', 1],
];
if (!getSetting('bianca_faq_v4')) {
  const ins = db.prepare('INSERT INTO bianca_faq (palavras, resposta, avisar, criado_em) VALUES (?, ?, ?, ?)');
  for (const [p, r, a] of FAQ_V4) ins.run(p, r, a, Date.now());
  // "testar antes": acrescenta quem quer testar para revenda
  db.prepare("UPDATE bianca_faq SET palavras = palavras || ', fazer teste, fazer um teste, realizar um teste, pra testar, testar primeiro, comprar pra testar', resposta = ? WHERE palavras LIKE 'amostra,%'")
    .run('Pode sim! 🙂\n\n• *Aqui em Feira de Santana*: o Luiz leva a placa até você *já configurada* e mostra funcionando. Você *só paga na hora*, depois de ver.\n• *Para revenda*: dá pra começar com o pedido mínimo de *5 placas* e testar na sua cidade antes de pedir mais.');
  setSetting('bianca_faq_v4', new Date().toISOString());
}
const palavrasDe = p => String(p || '').split(/[,;\n]+/).map(x => x.trim()).filter(x => x.length >= 2);
function linkPainel() { let base = ''; try { base = new URL(getSetting('site_url') || '').origin; } catch (e) { /* sem site */ } return base ? base + '/revendedor/?tab=login' : ''; }
function faqDe(texto) {
  const t = sem(texto).replace(/[^\w ]/g, ' ').replace(/\s+/g, ' ');
  let melhor = null, tam = 0;
  for (const f of db.prepare('SELECT * FROM bianca_faq WHERE ativo = 1').all())
    for (const k of palavrasDe(f.palavras)) { const kk = sem(k).replace(/[^\w ]/g, ' ').replace(/\s+/g, ' ').trim(); if (kk && (' ' + t + ' ').includes(' ' + kk + ' ') && kk.length > tam) { melhor = f; tam = kk.length; } }
  return melhor;
}
function faqPainel() { return { faq: db.prepare('SELECT * FROM bianca_faq ORDER BY id').all(), perguntas: db.prepare('SELECT * FROM bianca_perguntas ORDER BY id DESC LIMIT 50').all() }; }
function faqSalvar(b) {
  const palavras = palavrasDe(b.palavras).join(', '), resposta = String(b.resposta || '').trim();
  if (!palavras) throw new Error('Informe pelo menos uma palavra ou frase que o cliente escreve.');
  if (resposta.length < 5 || resposta.length > 1500) throw new Error('A resposta precisa ter entre 5 e 1500 caracteres.');
  const avisar = b.avisar ? 1 : 0, ativo = b.ativo === false || b.ativo === 0 ? 0 : 1;
  if (b.id) db.prepare('UPDATE bianca_faq SET palavras = ?, resposta = ?, avisar = ?, ativo = ? WHERE id = ?').run(palavras, resposta, avisar, ativo, b.id);
  else b.id = db.prepare('INSERT INTO bianca_faq (palavras, resposta, avisar, ativo, criado_em) VALUES (?, ?, ?, ?, ?)').run(palavras, resposta, avisar, ativo, Date.now()).lastInsertRowid;
  if (b.pergunta_id) db.prepare('DELETE FROM bianca_perguntas WHERE id = ?').run(b.pergunta_id);   // ensinou: sai da lista
  return db.prepare('SELECT * FROM bianca_faq WHERE id = ?').get(b.id);
}
const faqApagar = id => db.prepare('DELETE FROM bianca_faq WHERE id = ?').run(id).changes > 0;
const perguntaApagar = id => db.prepare('DELETE FROM bianca_perguntas WHERE id = ?').run(id).changes > 0;

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
  atacado: /(revend|revenda|atacado|atacadista|lote|distribu|\b(1\d|[2-9]\d|\d{3,}) (placas|unidades|unid|un)\b|quantidade grande|preco de fabrica|para vender|pra vender|comecar a vender|como vender|quero vender)/,
  comoFunciona: /(como funciona|o que e isso|o que e a nextap|o que e nextap|como usa|como que usa|me explica|tecnologia nfc|como e a placa|pra que serve|para que serve)/,
  modelosQ: /(quais (sao )?(os )?modelos|modelos disponiveis|que modelos|tem quais modelos|catalogo|quais placas|quais tipos|tipos de placa)/,
  varejo: /(estabelecimento|meu (negocio|comercio|salao|restaurante|consultorio|espaco|estudio)|minha (loja|empresa|barbearia|clinica|lanchonete|pizzaria|academia|hamburgueria)|pra mim|para mim|uso proprio|para (a|minha|o meu) (loja|empresa)|pro meu|pra minha|no balcao)/,
  preco: /(quanto|\bvalor\b|preco|custa|\bcusto\b|r\$|tabela)/,
  caro: /(\bcaro\b|carinho|salgado|desconto|mais barato|faz por menos|abaixa|nao tenho dinheiro|sem dinheiro|sem grana|apertad)/,
  naoSei: /^(nao sei|sei la|nao sei ainda|nao sei dizer|nao tenho certeza|to em duvida|estou em duvida|fiquei em duvida|tanto faz|qualquer um|qualquer uma|me ajuda a escolher|qual voce indica|qual vc indica|qual voce recomenda|o que voce indica)\b/,
  pensar: /(vou pensar|vou ver|depois (eu )?(vejo|falo|respondo|te chamo)|mais tarde|outra hora|semana que vem)/,
  nao: /^(nao|n|nao obrigad\w*|nao quero|agora nao|nao preciso)\b/,
  sim: /^(sim|quero|pode|claro|ok|blz|beleza|bora|fechado|fechou|vamos|manda)\b/,
  cor: /\b(azul|preta|preto)\b/,
  perso: /(personaliz|minha logo|com logo|com a logo|logomarca|minha marca|com a minha marca|com meu nome|arte propria|arte personalizada|exclusiv)/,
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
  const P = require('./predio.js'), p = precos(), eu = P.nomes().balcao, dono = P.vendedor(), cidade = P.cidade();
  const video = String(getSetting('video_demo_url') || '').trim();
  const pub = String(getSetting('public_url') || '').replace(/\/+$/, ''), foto = String(getSetting('foto_modelos_url') || '').trim() || (pub ? pub + '/assets/modelos-nextap.jpg' : ''), comFoto = txt => (/^https:\/\/\S+$/.test(foto) ? { midia: foto, texto: txt } : txt);   // foto com todos os modelos
  const comVideo = txt => (ehVideo(video) ? { midia: video, texto: txt } : txt);   // o vídeo vai como vídeo no WhatsApp, com o texto na legenda
    return {
    // Primeira mensagem perguntando o preço / como funciona / modelos: responde o que dá e já qualifica
    menuPreco: (nome) => `Oi${nome ? ', ' + nome : ''}! Aqui é a ${eu}, da NexTap. 🙂\n\nJá te passo o valor certinho! É que ele muda se a placa é para o *seu estabelecimento* ou para *revender*:\n\n1️⃣ Para o meu estabelecimento\n2️⃣ Quero revender (atacado)\n\n_Responda com o número._`,
    explica: () => comVideo('A NexTap é uma placa de *acrílico* com *NFC + QR Code*. ✨\n\nO cliente *aproxima o celular* (ou aponta a câmera) e cai direto onde você quiser:\n\n• Avaliação no *Google*\n• Seu *Instagram*\n• Seu *WhatsApp*\n• Seu *Pix*\n\nSem aplicativo, em uns 5 segundos.'),
    listaModelos: () => comFoto(`Estes são os modelos disponíveis:\n\n${LISTA_MODELOS}\n\nTodos com NFC + QR Code, em acrílico.`),
    menuCurto: () => 'Me conta: a placa é para o seu estabelecimento (1️⃣) ou para revender (2️⃣)?',
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
    // Personalizada (a partir de 50): benefícios primeiro, preço só no final
    perso: () => ['Dá sim! 🎨\n\nA placa personalizada leva a *sua marca*:\n\n• Logo e cores da sua empresa\n• NFC + QR Code já configurados\n• Um produto exclusivo, com a cara do seu negócio\n\nA personalização é feita a partir de *50 peças*.', 'Quantas peças você precisa?'],
    persoQtdDeNovo: () => ['Me diz só o número, por favor: quantas peças personalizadas você precisa? 🙂'],
    persoPreco: () => ['O valor depende da quantidade, então já te passo certinho. 🙂\n\nQuantas peças você precisa?'],
    persoMenos: (q) => [`A personalização é feita a partir de *50 peças*. 🙂\n\nCom ${q}, você pode levar os nossos modelos prontos (*Google*, *Instagram*, *WhatsApp* e *Pix*), que já chegam configurados.`],
    persoOk: (q) => { const u = n => n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.'), pu = precoPerso(); return [`Perfeito! ✅\n\n*${q} placas personalizadas* com a sua marca:\n\n• *R$ ${u(pu)}* cada, já personalizada\n• Total: *R$ ${u(pu * q)}*`, 'Pra eu adiantar, me manda a sua *logo* (imagem) e o *nome da empresa*. 🙂']; },
    persoDadosOk: () => [`Recebido! ✅\n\nO ${dono} já vai te chamar aqui para alinhar a arte e o pedido antes da produção. 🙌`],
    // Objeções (respondem de acordo com a etapa e voltam para a pergunta em que a conversa estava)
    obj: {
      caro_menu: () => ['Entendo! 🙂 Mas pensa assim: a placa é um valor único, sem mensalidade, e trabalha todo dia pra você trazendo avaliações e clientes novos.', 'Me conta: é para o seu estabelecimento (1️⃣) ou para revender (2️⃣)? Assim eu te mostro a opção que cabe melhor no seu bolso.'],
      caro_varejo: (fim) => [`Entendo! 🙂 Pensa assim:\n\n• É um valor *único*, sem mensalidade\n• A placa trabalha todo dia no seu balcão\n• Uma única avaliação boa já pode trazer um cliente novo, e esse cliente paga a placa\n\nE levando 2, você ainda ganha desconto: ${p.economia ? `economiza R$ ${p.economia}.` : `cada uma sai R$ ${p.cada}.`}\n\nO pagamento é só na entrega, depois que você vê funcionando. 😉`, fim],
      caro_atacado: (fim) => ['Entendo! 🙂 No atacado funciona assim:\n\n• Quanto *mais placas*, menor o valor de cada uma\n• Você pode começar com o mínimo e ir aumentando conforme vende\n• Revendendo na sua cidade, cada placa sai por bem mais do que você paga\n\nNo painel você simula quantidades diferentes e vê o valor na hora, antes de pagar.', fim],
      caro_perso: (fim) => ['Entendo! 🙂 A personalizada é um produto *exclusivo*, com a sua marca, e o valor por peça já inclui a arte.\n\nPra quem revende ou tem várias unidades, ela costuma se pagar rápido, porque vira um produto só seu.', fim],
      naoSei_menu: () => ['Sem problema, eu te ajudo! 🙂\n\n1️⃣ Se a placa vai ficar no *balcão da sua empresa*, para os seus clientes avaliarem, seguirem ou pagarem\n\n2️⃣ Se você quer comprar *várias placas para vender* para outras empresas\n\nQual combina mais com você?'],
      naoSei_modelo: () => ['Te ajudo a escolher! 🙂\n\n• Quer *mais clientes novos*? A do *Google*: mais avaliações e você aparece melhor nas buscas e no Maps\n• Vende muito pelas redes? A do *Instagram*\n• Atende muito pelo zap? A do *WhatsApp*\n• Quer agilizar o caixa? A do *Pix*\n\nSe ficar na dúvida, comece pela do *Google*: é a que todo comércio quer. Qual você prefere?'],
      naoSei_dados: () => ['Sem pressa! 🙂 Se quiser, me manda só o *bairro* e o melhor *dia*, que o resto o Luiz confirma com você por aqui.'],
      naoSei_atacado: () => ['Te dou uma dica! 🙂\n\nComece pela do *Google*: todo comércio quer mais avaliações, então é a mais fácil de vender. Depois você amplia com Instagram, WhatsApp e Pix.\n\nQuer montar com a do Google, ou com todos os modelos?'],
      naoSei_qtdAtacado: (min) => [`Uma boa forma de começar é com *10 placas*: dá pra testar na sua região e ver quais modelos saem mais. Se preferir ir com calma, o mínimo é ${min}.\n\nQuantas eu coloco na sua simulação?`],
      naoSei_perso: () => ['Sem problema! 🙂 Pensa em quantas unidades ou clientes vão usar a placa com a sua marca. A personalização começa em *50 peças*.\n\nQuantas você acha que precisa?'],
    },
    naoSei: () => ['Boa pergunta! 🙂\n\nDeixa eu confirmar essa informação certinho pra você. Já te respondo por aqui.'],
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
      perso: () => 'Oi! 🙂\n\nSó falta me dizer quantas peças personalizadas você precisa, que eu já te passo tudo certinho.',
      perso_dados: () => 'Oi! 🙂\n\nPra adiantar a sua placa personalizada, só preciso da sua *logo* e do *nome da empresa*.',
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
  W.avisarDono(`*${P.nomes().gerente}: atendimento humano*\n${P.nomes().balcao} (WhatsApp) passou: *${quem}* ${motivo}\n\n"${String(textoIn).slice(0, 300)}"\n\nAbra o WhatsApp do painel para continuar.`, { exceto: String(c.jid || '').split('@')[0] }).catch(() => {});
  try { require('./notificacoes.js').notificar({ tipo: 'alta', titulo: '🙋 ' + quem + ' precisa de você', texto: motivo.slice(0, 140), url: '/#wa=' + c.id, chave: 'balcao' + c.id }).catch(() => {}); } catch (e) { /* opcional */ }
  P.registrar('balcao', `Cliente no WhatsApp: ${quem}`, `${motivo} · "${String(textoIn).slice(0, 120)}"`, { contato: c.id }, t0);
  P.registrar('gerente', `Atendimento humano: ${quem}`, `WhatsApp (${P.nomes().balcao}) · ${motivo}`, { contato: c.id }, t0);
}

// Pergunta que leva a conversa adiante (fechamento ou dúvida), de acordo com a etapa
function proxPergunta(etapa) {
  return ({ varejo: 'Qual modelo você prefere: *Google*, *Instagram*, *WhatsApp* ou *Pix*?', modelo: 'Qual modelo você prefere: *Google*, *Instagram*, *WhatsApp* ou *Pix*?',
    qtd: 'Vai querer 1 ou já leva as 2 com desconto?', segundo: 'E a segunda placa, é do mesmo modelo ou de outro?',
    dados: 'Posso agendar a sua? É só me mandar o nome da empresa, o endereço e o melhor dia. 🙂',
    atacado: 'Quais modelos você quer revender?', atacado_qtd: 'Quantas placas eu coloco na sua simulação?', atacado_min: 'Quantas placas eu coloco na sua simulação?',
    atacado_link: 'Conseguiu criar a sua conta, ou ficou alguma dúvida?', perso: 'Quantas peças você precisa?', perso_dados: 'Me manda a sua logo e o nome da empresa?' })[etapa]
    || 'Me conta: a placa é para o seu estabelecimento (1️⃣) ou para revender (2️⃣)?';
}
const terminaEmPergunta = t => /\?[\s\p{Extended_Pictographic}\uFE0F\u200D]*$/u.test(String(t || '').trim());
// Decide a resposta. Devolve { textos, etapa, tipo, dados, avisar } (sem enviar nada): fácil de testar.
// Conversa nova: a primeira resposta sempre se apresenta (quando ainda não se apresentou)
function decidir(e, textoIn, nome) {
  const r = decidir0(e, textoIn, nome);
  if (!e && r.textos.length && r.etapa !== 'parado') {
    const oi = `Oi${nome ? ', ' + nome : ''}! Aqui é a ${require('./predio.js').nomes().balcao}, da NexTap. 🙂\n\n`, x = r.textos[0];
    if (typeof x === 'string') { if (!/^Oi\b/.test(x)) r.textos[0] = oi + x; } else if (x && !/^Oi\b/.test(x.texto || '')) r.textos[0] = { ...x, texto: oi + (x.texto || '') };
  }
  return r;
}
function decidir0(e, textoIn, nome) {
  const T = textos(), t = sem(textoIn), etapa = e ? e.etapa : '', d = (e && e.dados) || {}, tipo = (e && e.tipo) || '';
  const naoSei = (tp, dd, av) => ({ ...R(T.naoSei(), 'humano', tp, dd, av), pergunta: true });   // não sabe: responde com naturalidade e te chama em segredo
  const R = (textos, et, tp = tipo, dd = d, av = '') => ({ textos: textos ? (Array.isArray(textos) ? textos : [textos]) : [], etapa: et, tipo: tp, dados: dd, avisar: av });
  if (etapa === 'parado') return R(null, 'parado');
  if (RX.parar.test(t)) return R(T.parar(), 'parado', tipo, d);
  if (etapa === 'humano') return R(null, 'humano');                       // já está com você
  if (RX.humano.test(t)) return R(T.humano(), 'humano', tipo, d, '🙋 pediu para falar com uma pessoa');
  // "Como funciona?" e "Quais modelos?" em qualquer etapa de venda: explica (com vídeo/foto) e volta para a pergunta da etapa
  if (!['perso', 'perso_dados'].includes(etapa) && !RX.atacado.test(t) && !RX.perso.test(t) && (RX.modelosQ.test(t) || RX.comoFunciona.test(t))) {
    const fim = !etapa || etapa === 'menu' ? T.menuCurto() : etapa === 'atacado' ? 'Quais modelos você quer revender?' : ['varejo', 'modelo'].includes(etapa) ? 'Você prefere a do *Google* ou algum outro modelo?' : proxPergunta(etapa);
    return R([RX.modelosQ.test(t) ? T.listaModelos() : T.explica(), fim], etapa || 'menu', tipo, d);
  }
  // Personalizada: em qualquer etapa (benefícios → quantidade → preço no final)
  if (RX.perso.test(t) && !['perso', 'perso_dados'].includes(etapa)) {
    const q = qtdDe(t), antes = etapa;
    if (q >= MIN_PERSO) return { ...R(T.persoOk(q), 'perso_dados', 'perso', { ...d, qtd: q, antes }) };
    return R(T.perso(), 'perso', 'perso', { ...d, antes });
  }
  if (etapa === 'perso') {
    const q = qtdDe(t);
    if (q >= MIN_PERSO) return R(T.persoOk(q), 'perso_dados', 'perso', { ...d, qtd: q });
    if (q > 0) { const volta = d.antes && d.antes !== 'menu' ? d.antes : 'menu'; return R([...T.persoMenos(q), ...(volta === 'menu' ? [T.menu('')] : [])], volta, volta === 'menu' ? '' : tipo, d); }
    if (RX.preco.test(t)) return R(T.persoPreco(), 'perso');
    if ((e.tentativas || 0) < 1) return { ...R(T.persoQtdDeNovo(), 'perso'), tentativas: 1 };
  }
  if (etapa === 'perso_dados') return R(T.persoDadosOk(), 'humano', 'perso', { ...d, dados: String(textoIn).slice(0, 300) }, `🎨 PERSONALIZADA: ${d.qtd} placas (R$ ${(precoPerso() * (d.qtd || 0)).toFixed(2).replace('.', ',')}). Ele mandou logo/nome: alinhe a arte`);
  const f = !/^\s*[12]\s*$/.test(t) && faqDe(textoIn);
  if (f) { db.prepare('UPDATE bianca_faq SET usos = usos + 1 WHERE id = ?').run(f.id);
    const resp = String(f.resposta).replace(/\{painel\}/g, linkPainel() || 'o painel do revendedor');
    // sempre termina com uma pergunta (dúvidas de venda): leva para o fechamento sem perder a etapa
    const textos = f.avisar || terminaEmPergunta(resp) ? [resp] : [resp, proxPergunta(etapa)];
    return { ...R(textos, etapa || 'menu', tipo, d, f.avisar ? `💬 respondi uma dúvida, mas vale você acompanhar` : ''), faq: f.id }; }
  // Objeções "tá caro" e "não sei": resposta de acordo com a etapa, sem sair do lugar
  const O = T.obj, caro = RX.caro.test(t) && !qtdDe(t), duvida = RX.naoSei.test(t);
  if (caro || duvida) {
    const fimVarejo = ['dados', 'qtd', 'segundo'].includes(etapa) ? proxPergunta(etapa) : proxPergunta('varejo');
    const fimAtacado = /^atacado/.test(etapa) ? proxPergunta(etapa) : 'Quantas placas você quer na primeira compra?';
    const fam = /^atacado/.test(etapa) ? 'atacado' : /^perso/.test(etapa) ? 'perso' : ['varejo', 'modelo', 'qtd', 'segundo', 'dados'].includes(etapa) ? 'varejo' : 'menu';
    const r = caro
      ? (fam === 'varejo' ? O.caro_varejo(fimVarejo) : fam === 'atacado' ? O.caro_atacado(fimAtacado) : fam === 'perso' ? O.caro_perso('Quantas peças você precisa?') : O.caro_menu())
      : (fam === 'menu' ? O.naoSei_menu() : fam === 'perso' ? O.naoSei_perso() : etapa === 'atacado' ? O.naoSei_atacado() : /^atacado_(qtd|min)$/.test(etapa) ? O.naoSei_qtdAtacado(minimoAtacado())
        : ['varejo', 'modelo'].includes(etapa) ? O.naoSei_modelo() : etapa === 'dados' ? O.naoSei_dados() : etapa === 'qtd' || etapa === 'segundo' ? ['Sem problema! 🙂 Comece com 1 e, se gostar, você pede a segunda depois. Vai querer 1 ou 2?'] : O.naoSei_menu());
    return { ...R(r, etapa || 'menu', tipo, d), objecao: caro ? 'caro' : 'nao_sei' };
  }
  const atac = RX.atacado.test(t) || (etapa === 'menu' && /^\s*2\b/.test(t)), varj = RX.varejo.test(t) || (etapa === 'menu' && /^\s*1\b/.test(t));
  if (!etapa || etapa === 'menu') {
    if (atac && !varj) return R(T.atacado(), 'atacado', 'atacado', qtdDe(t) ? { qtd: qtdDe(t) } : {});   // primeiro os modelos (com a foto), depois a quantidade
    if (varj) return R(T.varejo(), 'varejo', 'varejo');
    if (!etapa) return R(RX.preco.test(t) ? T.menuPreco(nome) : T.menu(nome), 'menu', '');
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
    if ((e.tentativas || 0) >= 1) return naoSei('atacado', d, '❓ revenda: não entendi os modelos');
    return { ...R(T.atacadoModDeNovo(), etapa, 'atacado', qtdDe(t) ? { ...d, qtd: qtdDe(t) } : d), tentativas: 1 };
  }
  // Atacado 2: quantas?
  if (etapa === 'atacado_qtd' || etapa === 'atacado_min') {
    const min = minimoAtacado(), q = etapa === 'atacado_min' && RX.sim.test(t) && !qtdDe(t) ? min : qtdDe(t), mods = modsAt.length ? modsAt : (d.modelos || []);
    if (q >= min) return simular(q, mods, d);
    if (q > 0) return R(T.atacadoMin(min), 'atacado_min', 'atacado', { ...d, qtd: q });
    if (RX.preco.test(t)) return R([...T.atacadoPreco(), ...T.atacadoQtdDeNovo()], etapa);
    if ((e.tentativas || 0) >= 1) return naoSei('atacado', d, '❓ revenda: não entendi a quantidade');
    return { ...R(T.atacadoQtdDeNovo(), etapa), tentativas: 1 };
  }
  if (etapa === 'atacado_link') {
    const q = qtdDe(t);
    if (q >= minimoAtacado() && q !== d.qtd) return simular(q, modsAt.length ? modsAt : (d.modelos || []), d);
    if (RX.preco.test(t)) return R(T.atacadoPreco(), 'atacado_link');
    if (RX.sim.test(t) || /obrigad|valeu|blz|beleza|ok|certo|show/.test(t)) return R(['Por nada! 🙌\n\nQualquer coisa, é só me chamar.'], 'atacado_link');
    return naoSei('atacado', d, `❓ revenda (${d.qtd} placas): mandou algo que eu não sei responder depois da simulação`);
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
    if ((e.tentativas || 0) >= 1) return naoSei('varejo', d, '❓ não consegui entender o modelo que ele quer');
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
    if ((e.tentativas || 0) >= 1) return naoSei('varejo', d, `❓ escolheu ${mods.join(', ')}, mas não entendi a quantidade`);
    return { ...R(T.qtdDeNovo(), 'qtd'), tentativas: 1 };
  }
  // 2 placas, falta o modelo da segunda
  if (etapa === 'segundo') {
    const p0 = (d.modelos || [])[0], novos = modelosDe(t), m2 = novos.length ? [p0, novos.find(x => x !== p0) || novos[0]] : /mesm|igua|tambem/.test(t) ? [p0, p0] : null;
    if (m2) return R(T.dados(2, m2, [p0]), 'dados', 'varejo', { ...d, modelos: m2 });
    if (extra === 'preco') return R(T.preco('E a segunda placa, é do mesmo modelo ou de outro?'), 'segundo');
    if ((e.tentativas || 0) >= 1) return naoSei('varejo', d, '❓ quer 2 placas, mas não entendi o modelo da segunda');
    return { ...R(T.segundo(), 'segundo'), tentativas: 1 };
  }
  if (etapa === 'dados') {
    const q = qtdDe(t), curta = t.length <= 50 && !/\b(rua|av|avenida|travessa|bairro|n[ºo°]?\s?\d)/.test(t);
    if (curta && q >= 3) return R(T.muitas(q), 'humano', 'varejo', { ...d, qtd: q }, `🔥 VAREJO: quer ${q} placas (${(d.modelos || []).join(', ')}). Faça um preço especial (não é atacado)`);
    if (curta && q === 2 && (d.qtd || 1) === 1) { const m = modelosDe(t).find(x => x !== d.modelos[0]) || d.modelos[0], m2 = [d.modelos[0], m]; return R(T.dados(2, m2, d.modelos), 'dados', 'varejo', { ...d, modelos: m2, qtd: 2 }); }
    if (extra === 'preco') return R(T.preco('Agora é só me mandar o nome da empresa, o endereço e o melhor dia e horário. 🙂'), 'dados');
  }
  if (etapa === 'dados') return R(T.dadosOk(), 'humano', 'varejo', { ...d, dados: String(textoIn).slice(0, 300) }, `🧾 PEDIDO VAREJO: ${d.qtd || 1} placa(s)${(d.modelos || []).length ? ' (' + d.modelos.join(', ') + ')' : ''}. Confirme dia e horário da entrega (pagamento na entrega)`);
  return naoSei(tipo, d, '❓ mandou algo que eu não sei responder');
}

const enviarItem = (W, c, x) => typeof x === 'string'
  ? W.enviarContato(c, { texto: x, digitando: Math.min(6000, 1000 + x.length * 30) }, 'bianca')
  : W.enviarContato(c, { midia: x.midia, texto: x.texto }, 'bianca');
async function atender(c, textoIn, nome, t0 = Date.now()) {
  if (ehReinicio(textoIn)) reiniciar(c.id);
  const e = estado(c.id, t0), r = decidir(e, textoIn, String(nome || '').trim().split(' ')[0]);
  salvar(c.id, r.etapa, r.tipo, r.dados, t0, r.tentativas || 0);
  if (r.avisar) avisar(c, r.avisar, textoIn, t0);
  if (r.pergunta) db.prepare('INSERT INTO bianca_perguntas (contato_id, texto, etapa, criado_em) VALUES (?, ?, ?, ?)').run(c.id, String(textoIn).slice(0, 500), e ? e.etapa : '', t0);
  if (r.log) require('./predio.js').registrar('balcao', `Revenda no WhatsApp: ${c.nome || '+' + String(c.jid || '').split('@')[0]}`, r.log, { contato: c.id }, t0);
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
  const L = db.prepare("SELECT * FROM bianca_balcao WHERE lembrado = 0 AND etapa IN ('menu','varejo','modelo','qtd','segundo','dados','atacado','atacado_qtd','perso','perso_dados') AND em <= ? AND em > ? ORDER BY em LIMIT 5").all(t0 - 3 * 3600e3, t0 - DIA);
  let n = 0;
  for (const b of L) {
    db.prepare('UPDATE bianca_balcao SET lembrado = 1 WHERE contato_id = ?').run(b.contato_id);
    const c = db.prepare('SELECT * FROM wa_contatos WHERE id = ?').get(b.contato_id);
    if (!c || c.prospect_id) continue;
    const ult = db.prepare("SELECT direcao, origem FROM wa_mensagens WHERE contato_id = ? ORDER BY id DESC LIMIT 1").get(c.id);
    if (!ult || ult.direcao !== 'out' || ult.origem !== 'bianca') continue;   // cliente respondeu, ou você assumiu
    try { await enviarItem(W, c, T[b.etapa]()); n++; require('./predio.js').registrar('balcao', `Lembrete: ${c.nome || '+' + String(c.jid).split('@')[0]}`, `Sem resposta há 3h (etapa: ${b.etapa}).`, { contato: c.id }, t0); }
    catch (e) { console.error('[BIANCA] lembrete:', e.message); }
  }
  return n;
}

module.exports = { faqPainel, faqSalvar, faqApagar, perguntaApagar, faqDe, reiniciar, ehReinicio, atender, decidir, lembrar, precos, qtdDe, modelosDe };
