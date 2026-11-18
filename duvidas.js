// Mapa de dúvidas: lê as mensagens que os clientes mandaram (Instagram e WhatsApp), agrupa por assunto e mostra
// as perguntas mais feitas, com exemplos reais e se a Bianca já sabe responder.
const { db } = require('./db.js');

const sem = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w ?]/g, ' ').replace(/\s+/g, ' ').trim();
const TEMAS = [
  ['preco', '💰 Preço / valor', /(quanto|\bvalor|preco|custa|tabela)/],
  ['caro', '💸 Achou caro / desconto', /(\bcaro\b|desconto|mais barato|promoc|black)/],
  ['como_funciona', '❓ Como funciona', /(como funciona|o que e isso|como usa|como que usa|me explica|explica|serve pra|para que serve)/],
  ['app', '📲 Precisa de aplicativo', /(aplicativo|\bapp\b|baixar|nfc tools)/],
  ['celular', '📱 Funciona em qualquer celular (iPhone/Android/NFC)', /(iphone|android|todo celular|qualquer celular|celular antigo|tem nfc|sem nfc|\bnfc\b)/],
  ['configurar', '⚙️ Como configurar / ativar', /(configur|ativar|ativa a|gravar|programar|colocar o link|meu link)/],
  ['prazo', '⏱️ Prazo de produção e entrega', /(prazo|demora|quantos dias|quando chega|chega quando|tempo de entrega)/],
  ['frete', '📦 Frete / envio para a cidade', /(frete|envia para|envio|correio|sedex|entrega em|manda para|voces entregam)/],
  ['pagamento', '💳 Formas de pagamento / parcelamento', /(\bpix\b|cartao|boleto|parcel|forma de pagamento|como pago|pagar)/],
  ['minimo', '🔢 Pedido mínimo / comprar só uma', /(minimo|so uma|apenas uma|uma unidade|uma so|1 unidade|comprar uma)/],
  ['revenda', '🤝 Revenda / lucro', /(revend|revenda|lucro|atacado|margem|quanto ganho|ganhar dinheiro|vender as placas)/],
  ['personalizar', '🎨 Personalização / com a minha logo', /(personaliz|minha logo|com logo|logomarca|minha marca|meu nome)/],
  ['confianca', '🛡️ É confiável? / golpe', /(golpe|confiavel|confianca|seguro|reclame|verdade mesmo|e real)/],
  ['onde', '📍 Onde comprar / onde fica / loja física', /(onde fica|onde voces|loja fisica|endereco|retirar|buscar ai|de onde|onde comprar|onde compro|como comprar)/],
  ['modelos', '🗂️ Quais modelos existem', /(modelos|catalogo|quais placas|tipos de placa)/],
  ['teste', '🧪 Quer testar antes / amostra', /(teste|testar|amostra)/],
  ['mensalidade', '🔁 Tem mensalidade?', /(mensalidade|assinatura|todo mes|mensal|taxa)/],
  ['bateria', '🔋 Precisa de bateria / internet / energia', /(bateria|pilha|energia|tomada|internet|wifi|carregar)/],
  ['garantia', '🔧 Garantia / defeito / troca', /(garantia|defeito|quebr|troca|devolu)/],
  ['material', '📐 Material / tamanho', /(material|tamanho|medida|acrilico|\bcm\b|resistente|durabilidade|dura quanto)/],
  ['google', '⭐ Avaliações: é permitido? e avaliação ruim?', /(permitido|proibido|banir|bloquear|politica|avaliacao ruim|avaliacao negativa|nota baixa|falsa)/],
  ['nota', '🧾 Nota fiscal', /(nota fiscal|\bnf\b|\bnfe\b|cnpj)/],
  ['pedido', '🚚 Já comprei / meu pedido', /(ja comprei|meu pedido|nao chegou|rastreio|rastreamento|ja paguei)/],
];

function mapa(dias = 90, t0 = Date.now()) {
  const desde = t0 - Math.min(365, Math.max(7, dias)) * 86400e3, msgs = [];
  try { for (const r of db.prepare("SELECT m.text AS t, 'instagram' AS canal FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE c.channel = 'instagram' AND m.direction = 'in' AND m.created_at >= ?").all(desde)) msgs.push(r); } catch (e) { /* sem Instagram */ }
  try { for (const r of db.prepare("SELECT m.texto AS t, 'whatsapp' AS canal FROM wa_mensagens m JOIN wa_contatos c ON c.id = m.contato_id WHERE c.grupo = 0 AND m.direcao = 'in' AND m.criado_em >= ?").all(desde)) msgs.push(r); } catch (e) { /* sem WhatsApp */ }
  const B = (() => { try { return require('./bianca-balcao.js'); } catch (e) { return null; } })();
  const temas = TEMAS.map(([id, nome]) => ({ id, nome, n: 0, instagram: 0, whatsapp: 0, exemplos: [] })), por = Object.fromEntries(temas.map(x => [x.id, x]));
  const frases = new Map(); let consideradas = 0;
  for (const m of msgs) {
    const bruto = String(m.t || '').trim();
    if (bruto.length < 4 || bruto.length > 300 || /^\[(audio|imagem|video|figurinha)/i.test(bruto)) continue;
    if (bruto === bruto.toUpperCase() && /[A-Z]/.test(bruto) && bruto.length < 30) continue;   // toque em botão (ex.: "💰 REVENDER")
    const t = sem(bruto); if (!t || /^\d+$/.test(t)) continue;
    let achou = false;
    for (const [id, , rx] of TEMAS) if (rx.test(t)) { const x = por[id]; x.n++; x[m.canal]++; if (x.exemplos.length < 4 && !x.exemplos.includes(bruto)) x.exemplos.push(bruto.slice(0, 160)); achou = true; }
    if (achou || t.includes('?')) { consideradas++; const k = t.replace(/\?/g, '').trim(); if (k.length >= 4) frases.set(k, { texto: bruto.slice(0, 160), n: ((frases.get(k) || {}).n || 0) + 1 }); }
  }
  // a Bianca responde pela conversa (código) ou por uma resposta do treino
  const PELA_CONVERSA = ['preco', 'caro', 'como_funciona', 'revenda', 'personalizar', 'minimo'];
  for (const x of temas) x.bianca = PELA_CONVERSA.includes(x.id) || !!(B && x.exemplos.some(e => B.faqDe(e, null)));
  return { dias, mensagens: msgs.length, consideradas, temas: temas.filter(x => x.n).sort((a, b) => b.n - a.n), frases: [...frases.values()].filter(f => f.n >= 2).sort((a, b) => b.n - a.n).slice(0, 20) };
}

module.exports = { mapa, TEMAS };
