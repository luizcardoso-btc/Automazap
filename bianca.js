// Bianca automática (Prospectora): todo dia mapeia empresas novas da cidade e aborda de 10 a 15 pelo WhatsApp, sozinha,
// com a mensagem personalizada da lista do dia. Retornos nos dias 1, 3 e 7. Quem responde passa para você; quem pede para parar não recebe mais nada.
// Proteções do número: só em horário comercial, intervalo aleatório entre envios, limite diário, confere se o número tem WhatsApp.
const { db, getSetting, setSetting } = require('./db.js');

const DIA = 86400e3, FUSO = 3 * 3600e3;
const dataStr = t => new Date(t - FUSO).toISOString().slice(0, 10);
const local = t => new Date(t - FUSO);
const n = (sql, ...a) => db.prepare(sql).get(...a).n;
const ligada = () => getSetting('bianca_auto') === '1';
const meta = () => Math.max(1, Math.min(20, Number(getSetting('bianca_meta')) || 12));
// Seg a sex 09:00–17:30 · sábado 09:00–12:00 · domingo não
function naJanela(t0) { const d = local(t0), w = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes(); return w >= 1 && w <= 5 ? m >= 540 && m < 1050 : w === 6 ? m >= 540 && m < 720 : false; }
const celular = num => /^55\d{2}9\d{8}$/.test(num);
const enviadosHoje = t0 => n("SELECT COUNT(*) AS n FROM agentes_log WHERE agente = 'prospectora' AND titulo LIKE 'Enviado:%' AND criado_em >= ?", Math.floor((t0 - FUSO) / DIA) * DIA + FUSO);
const novosHoje = t0 => n("SELECT COUNT(*) AS n FROM agentes_log WHERE agente = 'prospectora' AND titulo LIKE 'Enviado:%' AND json_extract(dados, '$.passo') = 'd0' AND criado_em >= ?", Math.floor((t0 - FUSO) / DIA) * DIA + FUSO);
const estoque = () => db.prepare("SELECT telefone FROM prospects WHERE status = 'novo' AND telefone <> ''").all().filter(p => celular(require('./whatsapp.js').normalizarNumero(p.telefone))).length;

// Nichos que mais compram placa de avaliação, em rodízio (um por mapeamento)
const RODIZIO = ['barbearia', 'salao', 'restaurante', 'estetica', 'dentista', 'pet', 'lanchonete', 'academia', 'clinica', 'pizzaria', 'oficina', 'otica', 'tatuagem', 'padaria', 'lavajato', 'bar', 'roupa', 'celular', 'farmacia', 'hotel'];
// Mapeia um nicho na cidade (Google se houver chave: traz nota e avaliações; senão o mapa livre) e guarda as empresas novas com telefone.
async function mapear(t0 = Date.now()) {
  const P = require('./prospeccao.js')._t, W = require('./whatsapp.js'), cidade = getSetting('cidade') || 'Feira de Santana';
  const i = Number(getSetting('bianca_nicho_i') || 0) % RODIZIO.length, nicho = P.NICHOS.find(x => x.id === RODIZIO[i]) || P.NICHOS[0];
  setSetting('bianca_nicho_i', String(i + 1));
  let achados = [], fonte = 'mapa livre';
  if (process.env.GOOGLE_PLACES_API_KEY) {
    fonte = 'Google';
    const j = await P.google('/v1/places:searchText', { metodo: 'POST', mascara: P.CAMPOS, corpo: { textQuery: `${nicho.nome} em ${cidade}`, languageCode: 'pt-BR', regionCode: 'BR', pageSize: 20 } });
    achados = (j.places || []).map(P.normalizar).filter(p => p.aberto).map(p => ({ ...p, segmento: nicho.nome }));
  } else {
    const centro = await P.geocodificar(cidade + ', Brasil');
    if (!centro) throw new Error('Não achei a cidade "' + cidade + '" no mapa. Confira em Configurações → Prédio.');
    achados = await P.acharNicho(nicho, centro, 12000, cidade);
  }
  const tem = db.prepare('SELECT 1 FROM prospects WHERE place_id = ?'), tels = new Set(db.prepare("SELECT telefone FROM prospects WHERE telefone <> ''").all().map(p => W.normalizarNumero(p.telefone)).filter(Boolean));
  const ins = db.prepare(`INSERT INTO prospects (place_id, nome, segmento, telefone, instagram, endereco, bairro, nota, avaliacoes, site, maps_url, lat, lng, origem)
    VALUES (@place_id, @nome, @segmento, @telefone, @instagram, @endereco, @bairro, @nota, @avaliacoes, @site, @maps_url, @lat, @lng, 'bianca')`);
  let novos = 0, comCel = 0;
  db.transaction(() => {
    for (const x of achados) {
      const num = W.normalizarNumero(x.telefone);
      if (!x.nome || !x.place_id || !num || tem.get(x.place_id) || tels.has(num)) continue;   // sem telefone não serve para o WhatsApp
      tels.add(num);
      ins.run({ place_id: String(x.place_id).slice(0, 120), nome: String(x.nome).slice(0, 120), segmento: nicho.nome.slice(0, 40), telefone: String(x.telefone).slice(0, 25), instagram: String(x.instagram || '').slice(0, 60), endereco: String(x.endereco || '').slice(0, 200),
        bairro: String(x.bairro || '').slice(0, 60), nota: x.nota == null ? null : Number(x.nota), avaliacoes: Math.max(0, Math.floor(Number(x.avaliacoes) || 0)), site: String(x.site || '').slice(0, 200), maps_url: String(x.maps_url || '').slice(0, 300), lat: x.lat == null ? null : Number(x.lat), lng: x.lng == null ? null : Number(x.lng) });
      novos++; if (celular(num)) comCel++;
    }
  })();
  require('./predio.js').registrar('prospectora', `Mapeamento: ${nicho.nome}`, `${achados.length} empresa(s) encontradas no ${fonte}, ${novos} nova(s) com telefone (${comCel} com celular).`, { nicho: nicho.id, novos, comCel }, t0);
  return { nicho: nicho.nome, fonte, encontradas: achados.length, novos, comCel };
}

// ======================= V2: conversa autônoma e humanizada =======================
// A Bianca acompanha cada empresa por etapa da conversa e responde sozinha o que é previsível (interesse, preço, compra, objeções comuns).
// O que ela não reconhece vai para você: ela nunca chuta resposta. Se perguntarem, diz que é a assistente virtual da NexTap.
{ const tem = c => db.prepare('PRAGMA table_info(prospects)').all().some(x => x.name === c);
  for (const [c, def] of [['variante', "TEXT NOT NULL DEFAULT ''"], ['respondeu_em', 'INTEGER'], ['etapa', "TEXT NOT NULL DEFAULT ''"], ['etapa_em', 'INTEGER'], ['auto_n', 'INTEGER NOT NULL DEFAULT 0'], ['ultima_intencao', "TEXT NOT NULL DEFAULT ''"]]) if (!tem(c)) db.exec(`ALTER TABLE prospects ADD COLUMN ${c} ${def}`);
  db.exec('CREATE TABLE IF NOT EXISTS bianca_respostas (id INTEGER PRIMARY KEY AUTOINCREMENT, prospect_id INTEGER NOT NULL, textos TEXT NOT NULL, enviar_em INTEGER NOT NULL, feito INTEGER NOT NULL DEFAULT 0, criado_em INTEGER NOT NULL)'); }
const ETAPAS = [['fila', 'Na fila', 'Mapeada, esperando a vez'], ['abertura', 'Abertura enviada', 'Primeira mensagem enviada, sem resposta ainda'], ['retorno', 'Em retorno', 'Retornos dos dias 1, 3 e 7, sem resposta'],
  ['explicou', 'Explicação enviada', 'Respondeu com interesse e recebeu como funciona'], ['preco', 'Preço enviado', 'Perguntou o valor ou pediu para seguir'], ['objecao', 'Tratando objeção', 'Levantou uma objeção e recebeu a resposta'],
  ['fechamento', 'Quer fechar', 'Disse que quer: falta você mandar o pagamento'], ['humano', 'Com você', 'Algo que eu não sei responder, ou pediu uma pessoa'], ['fechado', 'Fechado', 'Venda feita'], ['perdido', 'Encerrado', 'Não quis, pediu para parar ou não respondeu']];
const etapaDe = p => (p.status === 'fechado' ? 'fechado' : p.status === 'perdido' ? 'perdido' : p.etapa || ({ novo: 'fila', abordado: 'abertura', interessado: 'humano', orcamento: 'preco' })[p.status] || 'fila');
const setEtapa = (id, etapa, t0 = Date.now()) => db.prepare('UPDATE prospects SET etapa = ?, etapa_em = ? WHERE id = ?').run(etapa, t0, id);
const conversa = () => getSetting('bianca_conversa') !== '0';
const semAcento = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// Intenção da resposta (ordem importa). Devolve '' quando não reconhece: aí é com você.
const RX = {
  parar: /(nao (tenho|temos|ha) interesse|sem interesse|nao me (mande|envie|chame|perturbe|escreva)|\bpare\b|para de|parar de|me tira|remov|descadastr|\bstop\b|\bspam\b|bloque|denunci)/,
  robo: /(\brobo\b|\bbot\b|automatic|e uma pessoa|pessoa de verdade|humano mesmo|inteligencia artificial|\bia\b\??$)/,
  origem: /((como|onde|quem).{0,25}(conseguiu|pegou|achou|passou|deu).{0,25}(numero|contato|telefone|whats|zap)|quem e voce|quem ta falando|de onde (voce|vc) (e|fala))/,
  dono: /(nao sou (o|a) (dono|dona|responsavel|proprietari)|falar com (o|a) (dono|dona|gerente|responsavel|proprietari)|so (com )?(o|a) (dono|dona)|sou (so )?funcionari)/,
  humano: /(falar com (alguem|uma pessoa|atendente|voce|vc)|me liga|pode (me )?ligar|ligar pra mim|atendente)/,
  preco: /(quanto|\bvalor\b|preco|custa|custo|r\$|mensalidade|tem que pagar|e pago)/,
  compra: /(quero (uma|duas|a |sim|fechar|comprar|pedir|essa)|vou querer|\bfechado\b|pode (separar|fazer o pedido)|como (faco|faz|eu faco) (pra|para) (comprar|pedir|pagar)|\bpix\b|\bazul\b|\bpreta\b|manda o link|link de pagamento|quero comprar)/,
  caro: /(\bcaro\b|sem dinheiro|sem grana|apertad|nao tenho como pagar|desconto|mais barato)/,
  pensar: /(vou pensar|vou ver|vou analisar|depois (eu )?(vejo|falo|te falo|respondo|te chamo)|mais tarde|outra hora|semana que vem|mes que vem|agora nao da)/,
  ja_tenho: /(ja tenho|ja temos|ja uso|ja usamos|muitas? avaliac|bastante avaliac)/,
  tempo: /(sem tempo|ocupad|correria|corrido|agora nao posso|to atendendo|estou atendendo)/,
  positivo: /(^(sim|pode|claro|ok|okay|blz|beleza|manda|opa|oi|ola|oie|bom dia|boa tarde|boa noite|show|top|legal|interessante|pode sim|pode mandar|manda ai|tenho sim|\?+)\b|como funciona|me explica|quero (ver|saber|entender)|pode mandar|tenho interesse|interessad|o que e isso|do que se trata)/,
  nao: /^(nao|n|nao obrigad\w*|nao preciso|nao quero|agora nao|obrigad\w*,? nao|nao,? obrigad\w*)\b/,
};
function intencao(texto, etapa) {
  const t = semAcento(texto);
  if (!t) return '';
  for (const k of ['parar', 'robo', 'origem', 'dono', 'humano']) if (RX[k].test(t)) return k;
  const inicio = ['fila', 'abertura', 'retorno'].includes(etapa);
  if (inicio && RX.positivo.test(t) && !RX.preco.test(t)) return 'positivo';
  for (const k of ['compra', 'preco', 'caro', 'pensar', 'ja_tenho', 'tempo']) if (RX[k].test(t)) return k;
  if (RX.nao.test(t)) return 'nao';
  if (RX.positivo.test(t)) return etapa === 'preco' && /^(sim|pode|claro|ok|blz|beleza|quero)\b/.test(t) ? 'compra' : 'positivo';
  return '';
}

// Textos: 2 ou 3 jeitos de dizer a mesma coisa (cada empresa recebe sempre o mesmo jeito), saudação pela hora e nome do dono quando há.
const precoBR = () => { const v = parseFloat(String(getSetting('preco_revenda') || '').replace(/\./g, '').replace(',', '.')); return (v > 0 ? v : 80).toFixed(2).replace('.', ','); };
function vars(p, t0 = Date.now()) {
  const P = require('./predio.js'), h = local(t0).getUTCHours(), nome = String(p.contato || '').trim().split(' ')[0];
  const av = Number(p.avaliacoes) || 0, nt = Number(p.nota) > 0 ? String(p.nota).replace('.', ',') : '';
  const numeros = av && nt ? `Vi que vocês estão com nota ${nt} e ${av} avaliações.` : av ? `Vi que vocês têm ${av} avaliações por lá.` : 'Vi que vocês ainda têm poucas avaliações por lá.';
  return { numeros, saud: h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite', nome, cnome: nome ? ', ' + nome : '', empresa: p.nome, eu: P.nomes().prospectora, dono: P.vendedor(), cidade: P.cidade(), dado: P.abertura(p), preco: precoBR(),
    ver: String(getSetting('video_demo_url') || '').trim() || String(getSetting('site_url') || '').trim(), temVideo: !!String(getSetting('video_demo_url') || '').trim() };
}
const escolher = (l, p) => l[(Number(p.id) || 0) % l.length];
const T = {
  aviso: () => 'Se não for do seu interesse, é só me dizer que eu não escrevo mais.',
  d1: [v => `${v.saud}${v.cnome}! Passando só pra saber se você conseguiu ver a minha mensagem. 🙂\n\nÉ coisa rápida: mostro como cada cliente satisfeito avalia a ${v.empresa} em 5 segundos. Posso mandar?`,
    v => `Oi${v.cnome}! Sei que o dia é corrido. Fica a pergunta: posso te mandar um vídeo curtinho mostrando como aumentar as avaliações da ${v.empresa}?`],
  d3: [v => `${v.saud}${v.cnome}! Última tentativa por enquanto, pra não incomodar. 🙂\n\nSe fizer sentido ter mais avaliações no Google, me responde com um "pode" que eu te explico em 1 minuto.`,
    v => `Oi${v.cnome}! Consigo deixar a placa da ${v.empresa} configurada ainda esta semana. Quer que eu te mostre como funciona?`],
  d7: [v => `Oi${v.cnome}! Não vou mais te escrever por aqui. Quando quiser mais avaliações no Google para a ${v.empresa}, é só me chamar. Bom trabalho! 🙌`],
  positivo: [v => [`Que bom! É bem simples: é uma plaquinha de acrílico que fica no balcão. O cliente aproxima o celular (ou aponta a câmera) e já cai direto na tela de avaliar a ${v.empresa} no Google. Sem aplicativo, leva uns 5 segundos.`, `${v.temVideo ? 'Olha funcionando' : 'Dá pra ver os modelos aqui'}: ${v.ver}\n\nQuer que eu te passe o valor?`],
    v => [`Show! Funciona assim: uma placa de acrílico no balcão. O cliente encosta o celular nela e a tela de avaliação da ${v.empresa} abre na hora, sem baixar nada.`, `${v.temVideo ? 'Dá uma olhada' : 'Os modelos estão aqui'}: ${v.ver}\n\nPosso te dizer quanto custa?`]],
  preco: [v => [`Ela sai por R$ ${v.preco}, valor único, sem mensalidade. Já vai configurada com o link da ${v.empresa}: chega pronta, é só colocar no balcão.`, 'Prefere a azul ou a preta?'],
    v => [`É R$ ${v.preco} uma vez só, sem mensalidade, e eu já entrego configurada para a ${v.empresa}.`, 'Qual combina mais com o espaço de vocês: azul ou preta?']],
  compra: [v => [`Perfeito! 🙌 Vou separar a sua.`, `Me confirma o nome que vai no pedido e o endereço de entrega? O ${v.dono} já te manda o link de pagamento por aqui.`]],
  caro: [v => [`Entendo! Pensa assim: a placa trabalha todo dia, sem mensalidade, e uma única avaliação boa já pode trazer um cliente novo. É um valor único de R$ ${v.preco}.`, 'Quer começar com uma só, no balcão?']],
  pensar: [v => ['Claro, sem pressa! 🙂 Só pra eu te ajudar: ficou alguma dúvida de como funciona, ou é mais a questão do valor?']],
  ja_tenho: [v => [`Que ótimo, isso é raro! O ponto agora é manter o ritmo: o Google dá mais peso para avaliação recente, e a placa mantém isso no automático.`, 'Quer ver como ela fica no balcão?']],
  tempo: [v => [`Tranquilo, sei como é! Deixo aqui pra você ver quando puder: ${v.ver}`, 'Qualquer coisa é só me chamar. 🙂']],
  dono: [v => ['Sem problema! Qual o melhor horário pra falar com o responsável? Ou, se preferir, me passa o WhatsApp dele(a) que eu mando o vídeo direto.']],
  humano: [v => [`Claro! Já avisei o ${v.dono}, ele te responde por aqui. 🙂`]],
  robo: [v => [`Boa pergunta! 🙂 Sou a assistente virtual da NexTap e cuido do primeiro contato. Se preferir falar direto com o ${v.dono}, é só dizer que ele assume a conversa.`]],
  origem: [v => [`Sou a ${v.eu}, assistente da NexTap, aqui de ${v.cidade}. Peguei o contato no perfil público da ${v.empresa} no Google.`, 'Se preferir que eu não escreva mais, é só me avisar, sem problema nenhum.']],
  nao: [v => ['Sem problema, obrigada pela atenção! Se um dia quiser mais avaliações no Google, é só me chamar. Bom trabalho por aí! 🙌']],
  parar: [v => ['Combinado, não escrevo mais. Desculpa o incômodo e bom trabalho!']],
};

// ---------- Teste A/B/C da primeira mensagem ----------
// Cada empresa recebe sempre a mesma versão (A, B ou C), distribuídas por igual. Os textos são editáveis na sala da Bianca.
// Marcadores: {saudacao} {nome} {eu} {cidade} {empresa} {dado} (frase com os números dela) {numeros} (só os números, curto)
const ABERTURAS0 = {
  A: '{saudacao}{nome}! Aqui é a {eu}, assistente da NexTap, aqui de {cidade}. 🙂\n\n{dado}\n\nPosso te mostrar um jeito simples de aumentar as avaliações da sua empresa no Google, sem precisar pagar tráfego pago?',
  B: '{saudacao}{nome}, tudo bem? Estava olhando os negócios de {cidade} no Google e parei na {empresa}. {numeros}\n\nTem um jeito simples de fazer os seus próprios clientes avaliarem vocês na hora, sem tráfego pago. Posso te mostrar em 1 minuto?',
  C: '{saudacao}{nome}! Sou a {eu}, da NexTap. Pergunta rápida: hoje vocês pedem para os clientes avaliarem a {empresa} no Google?\n\n{numeros} Dá para ter muito mais, e de clientes reais.\n\nTenho um jeito de fazer isso acontecer sozinho, sem pagar tráfego. Posso te mostrar?',
};
const LETRAS = ['A', 'B', 'C'];
const aberturaTxt = l => String(getSetting('bianca_abertura_' + l) || '').trim() || ABERTURAS0[l];
const ativas = () => { const a = String(getSetting('bianca_abertura_ativas') || 'ABC').toUpperCase().split('').filter(l => LETRAS.includes(l)); return a.length ? [...new Set(a)] : ['A']; };
function varianteDe(p) {
  const at = ativas();
  if (p.variante && at.includes(p.variante)) return p.variante;
  const cont = Object.fromEntries(at.map(l => [l, 0]));
  for (const r of db.prepare("SELECT variante, COUNT(*) AS n FROM prospects WHERE variante <> '' GROUP BY variante").all()) if (r.variante in cont) cont[r.variante] = r.n;
  const v = at.slice().sort((a, b) => cont[a] - cont[b] || at.indexOf(a) - at.indexOf(b))[0];
  if (p.id) db.prepare('UPDATE prospects SET variante = ? WHERE id = ?').run(v, p.id);
  p.variante = v;
  return v;
}
const preencher = (tpl, v) => String(tpl).replace(/\{saudacao\}/g, v.saud).replace(/\{nome\}/g, v.cnome).replace(/\{eu\}/g, v.eu).replace(/\{cidade\}/g, v.cidade).replace(/\{empresa\}/g, v.empresa).replace(/\{dado\}/g, v.dado).replace(/\{numeros\}/g, v.numeros);
function abertura(p, t0 = Date.now(), letra) { return preencher(aberturaTxt(letra || varianteDe(p)), vars(p, t0)); }
function testeABC() {
  const at = ativas(), dados = LETRAS.map(l => {
    const r = db.prepare(`SELECT COUNT(*) AS enviadas, SUM(CASE WHEN respondeu_em IS NOT NULL THEN 1 ELSE 0 END) AS respostas,
      SUM(CASE WHEN etapa IN ('explicou','preco','objecao','fechamento','fechado') OR status IN ('orcamento','fechado') OR ultima_intencao IN ('positivo','preco','compra','caro','pensar','ja_tenho','tempo') THEN 1 ELSE 0 END) AS interesse,
      SUM(CASE WHEN status = 'fechado' THEN 1 ELSE 0 END) AS fechadas FROM prospects WHERE variante = ? AND status <> 'novo'`).get(l);
    const env = r.enviadas || 0;
    return { id: l, texto: aberturaTxt(l), padrao: !String(getSetting('bianca_abertura_' + l) || '').trim(), ativa: at.includes(l), enviadas: env, respostas: r.respostas || 0, interesse: r.interesse || 0, fechadas: r.fechadas || 0,
      taxa: env ? Math.round((1000 * (r.respostas || 0)) / env) / 10 : 0, taxa_interesse: env ? Math.round((1000 * (r.interesse || 0)) / env) / 10 : 0 };
  });
  const prontas = dados.filter(d => d.ativa && d.enviadas >= 20), melhor = prontas.slice().sort((a, b) => b.taxa_interesse - a.taxa_interesse || b.taxa - a.taxa)[0];
  return { variantes: dados, vencedora: prontas.length >= 2 && melhor ? melhor.id : null, minimo: 20,
    exemplo: Object.fromEntries(LETRAS.map(l => [l, abertura({ id: 0, nome: 'Barbearia Navalha', contato: 'Carlos Silva', nota: 4.3, avaliacoes: 18 }, Date.now(), l) + '\n\n' + T.aviso()])) };
}
function salvarABC({ textos, ativas: at } = {}) {
  if (textos && typeof textos === 'object') for (const l of LETRAS) if (typeof textos[l] === 'string') {
    const t = textos[l].trim();
    if (t && (t.length < 30 || t.length > 900)) { const e = new Error(`A versão ${l} precisa ter entre 30 e 900 caracteres.`); e.status = 400; throw e; }
    setSetting('bianca_abertura_' + l, t === ABERTURAS0[l] ? '' : t);
  }
  if (typeof at === 'string') { const a = [...new Set(at.toUpperCase().split('').filter(l => LETRAS.includes(l)))]; if (!a.length) { const e = new Error('Deixe pelo menos uma versão ligada.'); e.status = 400; throw e; } setSetting('bianca_abertura_ativas', a.join('')); }
  return testeABC();
}
const texto = (chave, p, t0) => { const r = escolher(T[chave], p)(vars(p, t0)); return Array.isArray(r) ? r : [r]; };
// Mensagem de saída (abertura e retornos) da abordagem automática
function saida(p, passo, t0 = Date.now()) { return passo === 'd0' ? abertura(p, t0) + '\n\n' + T.aviso() : texto(passo, p, t0)[0]; }

const DEPOIS = { positivo: 'explicou', preco: 'preco', compra: 'fechamento', caro: 'objecao', pensar: 'objecao', ja_tenho: 'objecao', tempo: 'objecao', dono: 'humano', humano: 'humano', robo: null, origem: null, nao: 'perdido', parar: 'perdido' };
const AVISAR = { compra: '🔥 quer fechar', dono: '👤 não é o dono (pediu contato do responsável)', humano: '🙋 pediu para falar com uma pessoa', '': '❓ mandou algo que eu não sei responder' };
// A empresa respondeu. Retornos automáticos param sempre. Com a conversa autônoma ligada, a resposta entra na fila com atraso de gente (1 a 3 min).
function respondeu(prospectId, textoIn, contato, t0 = Date.now(), { sorteio = Math.random } = {}) {
  const p = db.prepare('SELECT * FROM prospects WHERE id = ?').get(prospectId);
  if (!p || ['fechado', 'perdido'].includes(p.status)) return null;
  const W = require('./whatsapp.js'), P = require('./predio.js'), etapa = etapaDe(p), k = intencao(textoIn, etapa);
  const auto = ligada() && conversa();
  // Você entrou na conversa (mensagem pelo painel ou pelo celular depois da última minha)? Então é sua.
  const c = contato && contato.id ? contato : db.prepare('SELECT * FROM wa_contatos WHERE prospect_id = ? ORDER BY id DESC LIMIT 1').get(p.id);
  const ultOut = c ? db.prepare("SELECT origem FROM wa_mensagens WHERE contato_id = ? AND direcao = 'out' ORDER BY id DESC LIMIT 1").get(c.id) : null;
  const tua = !!(ultOut && ultOut.origem !== 'bianca') || etapa === 'humano' || etapa === 'fechamento';
  const repetiu = k && k === p.ultima_intencao && !['positivo', 'preco'].includes(k), limite = p.auto_n >= 6;
  const final = k === 'parar' || k === 'nao';
  const responde = auto && k && (final || (!tua && !repetiu && !limite));
  const nova = final ? 'perdido' : responde ? (DEPOIS[k] || etapa) : 'humano';
  db.prepare("UPDATE prospects SET status = ?, prox_contato = ?, motivo_perda = ?, etapa = ?, etapa_em = ?, ultima_intencao = ?, auto_n = auto_n + ?, atualizado_em = datetime('now') WHERE id = ?")
    .run(final ? 'perdido' : nova === 'preco' || nova === 'fechamento' ? 'orcamento' : (['novo', 'abordado'].includes(p.status) ? 'interessado' : p.status),
      k === 'pensar' && responde ? dataStr(t0 + 2 * DIA) : null, k === 'parar' ? 'Pediu para não receber mensagens' : k === 'nao' ? 'Sem interesse agora' : '', nova, t0, k || '', responde ? 1 : 0, p.id);
  db.prepare('UPDATE prospects SET respondeu_em = COALESCE(respondeu_em, ?) WHERE id = ?').run(t0, p.id);
  db.prepare('UPDATE bianca_respostas SET feito = 2 WHERE prospect_id = ? AND feito = 0').run(p.id);   // resposta nova substitui a que ainda não saiu
  if (responde) db.prepare('INSERT INTO bianca_respostas (prospect_id, textos, enviar_em, criado_em) VALUES (?, ?, ?, ?)').run(p.id, JSON.stringify(texto(k, p, t0)), t0 + Math.round((60 + sorteio() * 110) * 1000), t0);
  const motivo = !responde || AVISAR[k] ? (responde ? AVISAR[k] : (k && AVISAR[k]) || (tua ? '💬 respondeu (a conversa já é sua)' : repetiu || limite ? '🔁 insistiu no mesmo ponto: melhor você assumir' : AVISAR[''])) : '';
  if (motivo && !final) {
    W.avisarDono(`*${P.nomes().prospectora}: ${p.nome}* ${motivo}\n\n"${String(textoIn).slice(0, 300)}"\n\nAbra o WhatsApp do painel para continuar.`).catch(() => {});
    P.registrar('prospectora', `Com você: ${p.nome}`, `${motivo} · "${String(textoIn).slice(0, 120)}"`, { id: p.id }, t0);
  }
  return { parar: k === 'parar', intencao: k, etapa: nova, responde: !!responde };
}
// Envia as respostas que já "amadureceram" (uma empresa por vez). Entre 8h e 20h30; fora disso espera a manhã.
async function responder(t0 = Date.now()) {
  const W = require('./whatsapp.js'), m = local(t0).getUTCHours() * 60 + local(t0).getUTCMinutes();
  if (!W.configurado() || m < 480 || m > 1230) return 0;
  const r = db.prepare('SELECT * FROM bianca_respostas WHERE feito = 0 AND enviar_em <= ? ORDER BY enviar_em LIMIT 1').get(t0);
  if (!r) return 0;
  db.prepare('UPDATE bianca_respostas SET feito = 1 WHERE id = ?').run(r.id);
  const p = db.prepare('SELECT * FROM prospects WHERE id = ?').get(r.prospect_id), num = p && W.normalizarNumero(p.telefone);
  if (!num) return 0;
  let n = 0;
  for (const t of JSON.parse(r.textos)) { try { await W.enviarNumero(num, t, 'bianca', Math.min(7000, 1200 + t.length * 35)); n++; } catch (e) { require('./predio.js').registrar('prospectora', `Falhou: ${p.nome}`, String(e.message).slice(0, 200), { id: p.id }, t0); break; } }
  return n;
}
// Mapa da conversa: quantas empresas em cada etapa e o texto de cada ponto do fluxo (com os dados da empresa escolhida, se houver)
function mapa(id, t0 = Date.now()) {
  const todas = db.prepare('SELECT id, nome, status, etapa, etapa_em FROM prospects').all();
  const por = {}; for (const p of todas) (por[etapaDe(p)] = por[etapaDe(p)] || []).push({ id: p.id, nome: p.nome, desde: p.etapa_em || null });
  const ex = (id && db.prepare('SELECT * FROM prospects WHERE id = ?').get(id)) || { id: 0, nome: 'a sua empresa', contato: '', nota: 4.3, avaliacoes: 18, raiox: '' };
  const tx = k => texto(k, ex, t0).join('\n\n');
  return { ligada: ligada(), conversa: conversa(), empresa: ex.id ? { id: ex.id, nome: ex.nome, etapa: etapaDe(ex) } : null,
    etapas: ETAPAS.map(([eid, nome, desc]) => ({ id: eid, nome, desc, total: (por[eid] || []).length, empresas: (por[eid] || []).sort((a, b) => (b.desde || 0) - (a.desde || 0)).slice(0, 30) })),
    textos: { abertura: saida(ex.id ? ex : { ...ex, variante: 'A' }, 'd0', t0), d1: tx('d1'), d3: tx('d3'), d7: tx('d7'), positivo: tx('positivo'), preco: tx('preco'), compra: tx('compra'), caro: tx('caro'), pensar: tx('pensar'), ja_tenho: tx('ja_tenho'), tempo: tx('tempo'), dono: tx('dono'), humano: tx('humano'), robo: tx('robo'), origem: tx('origem'), nao: tx('nao'), parar: tx('parar') } };
}

let ocupada = false;
// Roda a cada minuto. Um envio por vez, com intervalo sorteado de 5 a 14 minutos.
async function tick(t0 = Date.now(), { sorteio = Math.random } = {}) {
  if (ocupada) return { enviado: false, motivo: 'ocupada' };
  if (ligada()) { ocupada = true; try { await responder(t0); } catch (e) { console.error('[BIANCA] resposta:', e.message); } finally { ocupada = false; } }
  if (!ligada()) return { enviado: false, motivo: 'desligada' };
  const W = require('./whatsapp.js'), P = require('./predio.js');
  if (!W.configurado()) return { enviado: false, motivo: 'whatsapp' };
  ocupada = true;
  try {
    const hoje = dataStr(t0);
    // 1) Mapeamento: uma vez por dia (e de novo se o estoque de empresas com celular estiver baixo), a partir das 7h
    if (local(t0).getUTCHours() >= 7 && estoque() < meta() * 2 && Number(getSetting('bianca_mapeou_n_' + hoje) || 0) < 3 && t0 - Number(getSetting('bianca_mapeou_em') || 0) > 20 * 60e3) {
      setSetting('bianca_mapeou_em', String(t0)); setSetting('bianca_mapeou_n_' + hoje, String(Number(getSetting('bianca_mapeou_n_' + hoje) || 0) + 1));
      try { await mapear(t0); } catch (e) { P.registrar('prospectora', 'Mapeamento falhou', String(e.message).slice(0, 300), {}, t0); }
    }
    if (!naJanela(t0)) return { enviado: false, motivo: 'fora do horário' };
    if (t0 < Number(getSetting('bianca_prox') || 0)) return { enviado: false, motivo: 'intervalo' };
    if (enviadosHoje(t0) >= meta() * 2) return { enviado: false, motivo: 'limite do dia' };
    // 2) Próximo da lista de hoje (retornos primeiro, depois as empresas novas de maior oportunidade)
    let lista = P.listaDeHoje(t0) || P.montarLista(t0);
    let item = lista.itens.find(i => !i.feito && !i.pulado && (i.tipo === 'retorno' || novosHoje(t0) < meta()));
    if (!item && novosHoje(t0) < meta() && Number(getSetting('bianca_remontou_' + hoje) || 0) < 4) {   // lista acabou antes da meta: monta de novo com o que foi mapeado
      setSetting('bianca_remontou_' + hoje, String(Number(getSetting('bianca_remontou_' + hoje) || 0) + 1));
      lista = P.montarLista(t0); item = lista.itens.find(i => !i.feito && !i.pulado && (i.tipo === 'retorno' || novosHoje(t0) < meta()));
    }
    if (!item) return { enviado: false, motivo: 'lista vazia' };
    const marcar = campos => { const l = P.listaDeHoje(t0); if (l) { l.itens.forEach(i => { if (i.id === item.id) Object.assign(i, campos); }); db.prepare('UPDATE agentes_log SET dados = ? WHERE id = ?').run(JSON.stringify({ dia: l.dia, itens: l.itens }), l.id); } };
    const p = db.prepare('SELECT * FROM prospects WHERE id = ?').get(item.id), num = p && W.normalizarNumero(p.telefone);
    if (!p || !num || ['fechado', 'perdido'].includes(p.status)) { marcar({ pulado: 'sem telefone válido' }); return { enviado: false, motivo: 'pulado' }; }
    // 3) Só manda para quem tem WhatsApp (fixo sem WhatsApp Business é pulado e anotado)
    const tem = await W.temWhatsapp(num);
    if ((tem && !tem.existe) || (!tem && !celular(num))) {
      marcar({ pulado: 'número sem WhatsApp' });
      db.prepare("INSERT INTO prospect_hist (prospect_id, tipo, texto, criado_em) VALUES (?, 'nota', ?, ?)").run(p.id, 'Número sem WhatsApp: a abordagem automática pulou. Tente ligação ou visita.', new Date(t0).toISOString().replace('T', ' ').slice(0, 19));
      db.prepare("UPDATE prospects SET obs = CASE WHEN obs LIKE '%sem WhatsApp%' THEN obs ELSE trim(obs || ' [sem WhatsApp]') END, status = CASE WHEN status = 'novo' THEN 'abordado' ELSE status END, prox_contato = NULL WHERE id = ?").run(p.id);
      return { enviado: false, motivo: 'sem whatsapp' };
    }
    const msg = saida(p, item.passo, t0);
    try { await W.enviarNumero(num, msg, 'bianca', Math.min(7000, 1500 + msg.length * 20)); }
    catch (e) {
      if (e.limite) { setSetting('bianca_prox', String(t0 + 3 * 3600e3)); return { enviado: false, motivo: 'limite do whatsapp' }; }
      marcar({ pulado: 'erro no envio' }); P.registrar('prospectora', `Falhou: ${p.nome}`, String(e.message).slice(0, 300), { id: p.id }, t0);
      setSetting('bianca_prox', String(t0 + 10 * 60e3)); return { enviado: false, motivo: 'erro' };
    }
    P.contatoFeito(p.id, t0); setEtapa(p.id, item.passo === 'd0' ? 'abertura' : 'retorno', t0);
    if (item.passo === 'd7') db.prepare("UPDATE prospects SET status = 'perdido', motivo_perda = 'Sem resposta depois de 4 contatos', etapa = 'perdido' WHERE id = ? AND status = 'abordado'").run(p.id);
    P.registrar('prospectora', `Enviado: ${p.nome}`, item.tipo === 'retorno' ? 'Retorno automático pelo WhatsApp.' : 'Primeira abordagem pelo WhatsApp.', { id: p.id, passo: item.passo }, t0);
    setSetting('bianca_prox', String(t0 + Math.round((5 + sorteio() * 9) * 60e3)));
    return { enviado: true, id: p.id, passo: item.passo };
  } finally { ocupada = false; }
}

function painel(t0 = Date.now()) {
  const W = require('./whatsapp.js'), prox = Number(getSetting('bianca_prox') || 0), ini = Math.floor((t0 - FUSO) / DIA) * DIA + FUSO;
  return { ligada: ligada(), meta: meta(), whatsapp: W.configurado(), enviados_hoje: enviadosHoje(t0), novos_hoje: novosHoje(t0), estoque: estoque(), na_janela: naJanela(t0),
    proximo: ligada() && naJanela(t0) && prox > t0 ? new Date(prox - FUSO).toISOString().slice(11, 16) : '',
    respostas_hoje: n("SELECT COUNT(*) AS n FROM prospect_hist WHERE tipo = 'whatsapp' AND texto LIKE 'Respondeu no WhatsApp:%' AND criado_em >= ?", new Date(ini).toISOString().replace('T', ' ').slice(0, 19)),
    mapeadas_hoje: db.prepare("SELECT COALESCE(SUM(json_extract(dados, '$.novos')), 0) AS n FROM agentes_log WHERE agente = 'prospectora' AND titulo LIKE 'Mapeamento:%' AND criado_em >= ?").get(ini).n,
    conversa: conversa(), com_voce: n("SELECT COUNT(*) AS n FROM prospects WHERE etapa IN ('humano','fechamento') AND status NOT IN ('fechado','perdido')"),
    google: !!process.env.GOOGLE_PLACES_API_KEY };
}

module.exports = { testeABC, salvarABC, varianteDe, tick, mapear, respondeu, responder, intencao, mapa, saida, etapaDe, ETAPAS, painel, naJanela, celular, ligada, meta };
