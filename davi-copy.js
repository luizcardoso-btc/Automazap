// Davi · Copywriter de vídeo — "cérebro de copy" (inspirado na ideia do Mega Brain: o conhecimento organizado em 5 camadas
// e um agente que decide com base nele). Linha editorial direta: gancho que para o dedo, verdade incômoda, uma ideia por vídeo,
// número específico, demonstração em vez de promessa e UMA chamada. Tudo grátis, sem API: o Davi escreve a partir deste
// banco de munição e aprende todos os dias com os comentários que cada vídeo trouxe.
const { db, getSetting, setSetting } = require('./db.js');

db.exec(`CREATE TABLE IF NOT EXISTS davi_roteiros (conteudo_id INTEGER PRIMARY KEY, fw TEXT NOT NULL, dados TEXT NOT NULL, criado_em INTEGER NOT NULL,
  gancho_usado INTEGER, views INTEGER, comentarios INTEGER, avaliado_em INTEGER)`);

const DIA = 86400e3, FUSO = 3 * 3600e3;
const dataStr = t => new Date(t - FUSO).toISOString().slice(0, 10);

// ======================= DNA (5 camadas) =======================
const DNA = {
  filosofias: [
    'Copy não é texto bonito: é decisão. Cada frase existe para levar à próxima, e a última leva ao comentário.',
    'Quem fala com todo mundo não fala com ninguém. Cada vídeo conversa com UM dono de negócio, com UMA dor.',
    'Clareza vence criatividade. Se precisar explicar o gancho, o gancho falhou.',
    'Mostrar é mais forte que prometer: a demonstração na tela faz o trabalho da promessa.',
    'Verdade dita sem rodeio gera confiança. Exagero gera desconfiança (e bloqueio de anúncio).',
  ],
  modelos_mentais: [
    'Atrito: cada passo a mais derruba gente no caminho. O cliente não avalia porque dá trabalho, não porque não gostou.',
    'Inimigo comum: o vilão nunca é o cliente, é o processo (procurar no Google, abrir a câmera, esquecer).',
    'Custo da inação: mostrar o que ele perde por não agir pesa mais do que o que ele ganha.',
    'Prova antes do pedido: primeiro o cliente vê funcionando, depois recebe a chamada.',
    'Especificidade = credibilidade: "6 passos viram 1" convence mais que "muito mais fácil".',
  ],
  heuristicas: [
    'Gancho com até 12 palavras e nos 3 primeiros segundos, falado E escrito na tela.',
    'Uma ideia por vídeo. Se cabe um "e também", vira outro vídeo.',
    'Frases curtas (até 15 palavras), na segunda pessoa: "você", "seu cliente", "seu balcão".',
    'Pelo menos um número concreto no roteiro.',
    'Uma única chamada, com a palavra-chave que o robô reconhece (COMO FUNCIONA, REVENDER, EU QUERO).',
    'Nada de "garantido", "100%", "fature X por mês" nem depoimento inventado.',
    'Legenda: a primeira linha repete a força do gancho; no máximo 5 hashtags.',
  ],
  frameworks: [],   // preenchido abaixo (FW)
  metodologias: [
    'Treino diário: dois dias depois de cada vídeo postado, conto os comentários que ele trouxe e dou nota para a estrutura e para o tipo de gancho usado.',
    'Teste de ganchos: cada roteiro sai com 3 ganchos de famílias diferentes (dor, curiosidade, polêmica ou número). O que for gravado é registrado e entra no placar.',
    'Exploração x aproveitamento: uso mais as estruturas que vencem, mas sempre testo uma menos usada para não ficar repetitivo.',
    'Pauta pelo cliente: leio as dúvidas mais frequentes do Instagram e do WhatsApp e sugiro os próximos vídeos a partir delas.',
    'Revisão antes de entregar: todo roteiro passa por uma nota de 0 a 100; abaixo de 80, eu reescrevo.',
  ],
};

// ======================= Munição por tema =======================
// Cada tema tem: a dor, o vilão (o atrito), o mecanismo (a placa), a demonstração, um número e ganchos por família.
const TEMAS = {
  avaliacao5s: { cta: 'COMO FUNCIONA',
    dor: 'Seu cliente sai satisfeito e não te avalia.', vilao: 'Não é preguiça: é atrito. Abrir o Google, procurar a empresa, achar o botão. Ninguém faz isso de graça.',
    mecanismo: 'Com a NexTap é um passo só: aproximou o celular da placa, a avaliação do Google abre.', demo: 'Olha: aproximou, abriu, cinco estrelas.',
    numero: 'Seis passos viram um.', beneficio: 'Mais estrelas, e cliente novo te escolhendo pelo Google.',
    ganchos: { dor: 'Seu cliente sai feliz e não te avalia. A culpa não é dele.', curiosidade: 'O jeito mais rápido de ganhar avaliação no Google (e não é pedir).', polemica: 'Pare de pedir avaliação para o seu cliente. Faça isto no lugar.', numero: 'São 6 passos para avaliar no Google. Aqui é 1.' },
    visual: ['Close no rosto, falando direto para a câmera', 'Cliente pagando e indo embora sem avaliar', 'Mão aproximando o celular da placa no balcão', 'Tela do Google abrindo e cinco estrelas marcadas', 'Placa em destaque com a palavra-chave na tela'] },
  nfc_qr: { cta: 'COMO FUNCIONA',
    dor: '"E se o celular do cliente não tiver NFC?" É a pergunta que eu mais recebo.', vilao: 'Se uma parte dos clientes não consegue usar, a placa vira enfeite.',
    mecanismo: 'Por isso a placa tem os dois: quem tem NFC só aproxima, quem não tem aponta a câmera para o QR Code.', demo: 'Olha os dois jeitos abrindo a mesma avaliação.',
    numero: 'Dois jeitos de avaliar, nenhum cliente de fora.', beneficio: 'Funciona em qualquer celular, do mais novo ao mais simples.',
    ganchos: { dor: '"Meu celular não tem NFC." E agora?', curiosidade: 'Aproximar ou apontar a câmera? Seu cliente escolhe.', polemica: 'Placa só com NFC deixa cliente para trás.', numero: '2 jeitos de avaliar, nenhum cliente de fora.' },
    visual: ['Falando para a câmera com a placa na mão', 'Celular com NFC aproximando da placa', 'Celular sem NFC lendo o QR Code', 'As duas telas abrindo a mesma avaliação', 'Placa em destaque com a palavra-chave na tela'] },
  onde_colocar: { cta: 'COMO FUNCIONA',
    dor: 'Placa escondida não gera avaliação. Gera poeira.', vilao: 'O cliente só avalia no momento em que está feliz, e esse momento dura segundos.',
    mecanismo: 'A placa tem que estar exatamente onde esse momento acontece: no caixa, na mesa ou na recepção.', demo: 'Olha a diferença: na parede ninguém vê; ao lado da maquininha, todo mundo usa.',
    numero: 'Três lugares onde a placa trabalha por você.', beneficio: 'Mesma placa, muito mais avaliações, só mudando o lugar.',
    ganchos: { dor: 'Sua placa de avaliação está no lugar errado.', curiosidade: 'Existe um lugar no seu balcão que gera mais avaliação.', polemica: 'Se a sua placa está na parede, você já perdeu.', numero: '3 lugares onde a placa trabalha por você.' },
    visual: ['Placa esquecida na parede', 'Placa ao lado da maquininha do caixa', 'Placa na mesa do restaurante', 'Placa no balcão da recepção', 'Cliente aproximando o celular, palavra-chave na tela'] },
  ja_tenho_qr: { cta: 'COMO FUNCIONA', objecao: '"Já tenho QR Code no balcão."',
    dor: 'Você já tem QR Code no balcão e acha que está resolvido.', vilao: 'Só que QR Code pede para abrir a câmera, focar e esperar carregar. Cada passo a mais derruba cliente no caminho.',
    mecanismo: 'Com a NexTap o cliente só aproxima o celular. E quem não tem NFC ainda tem o QR Code na mesma placa.', demo: 'Olha os dois lado a lado: apontar a câmera e aproximar.',
    numero: 'Menos passos, mais avaliações.', beneficio: 'Você não troca o QR Code: você ganha um atalho.',
    ganchos: { dor: 'Seu QR Code está te custando avaliações.', curiosidade: 'QR Code ou aproximar o celular? Olha a diferença.', polemica: '"Já tenho QR Code." Esse é o problema.', numero: 'Apontar a câmera: 4 passos. Aproximar: 1.' },
    visual: ['Falando para a câmera, tom de conversa franca', 'Pessoa abrindo a câmera e tentando focar no QR', 'Pessoa só aproximando o celular da NexTap', 'Tela de avaliação aberta', 'Placa em destaque com a palavra-chave na tela'] },
  movimento_bom: { cta: 'COMO FUNCIONA', objecao: '"Meu movimento já é bom, não preciso disso."',
    dor: 'Seu movimento está bom e você acha que avaliação é coisa para depois.', vilao: 'Só que o cliente novo escolhe pelas estrelas. E o concorrente da sua rua sabe disso.',
    mecanismo: 'Com a placa no balcão, cada cliente feliz de hoje vira uma estrela que te protege amanhã.', demo: 'Olha: um toque e a avaliação está feita.',
    numero: 'A nota de hoje é o cliente de amanhã.', beneficio: 'Quem cuida da nota com o movimento bom não sente quando a rua aperta.',
    ganchos: { dor: 'Seu concorrente novo está de olho nas suas estrelas.', curiosidade: 'Por que os melhores negócios cuidam da nota quando está tudo bem?', polemica: 'Movimento bom é a pior hora para relaxar.', numero: '1 estrela a menos e o cliente vai para o vizinho.' },
    visual: ['Falando para a câmera na frente do comércio', 'Rua de comércio com outra loja abrindo', 'Pessoa escolhendo restaurante pelas estrelas no celular', 'Cliente aproximando o celular da placa', 'Placa em destaque com a palavra-chave na tela'] },
  configurar: { cta: 'COMO FUNCIONA', objecao: '"Deve dar trabalho configurar."',
    dor: 'Você acha que vai perder uma tarde configurando placa.', vilao: 'Tecnologia que dá trabalho fica na gaveta. Todo dono de negócio já comprou alguma assim.',
    mecanismo: 'A placa chega configurada com o link da sua empresa. Você coloca no balcão e pronto.', demo: 'Olha: tirei da caixa, coloquei no balcão, o cliente já avaliou.',
    numero: 'Zero configuração.', beneficio: 'Você cuida do seu negócio; a placa cuida das avaliações.',
    ganchos: { dor: 'Você acha que vai dar trabalho. Não vai.', curiosidade: 'Quanto tempo leva para colocar a placa para funcionar?', polemica: 'Se precisa de manual, não serve para o seu balcão.', numero: 'Zero configuração. Chega pronta.' },
    visual: ['Caixa chegando no balcão', 'Placa saindo da caixa', 'Placa colocada ao lado do caixa', 'Cliente aproximando e avaliando', 'Placa em destaque com a palavra-chave na tela'] },
  revenda: { cta: 'REVENDER',
    dor: 'Você quer uma renda a mais, mas não quer estoque encalhado nem produto difícil de explicar.', vilao: 'Produto que precisa de muita explicação não vende no balcão.',
    mecanismo: 'A placa se explica sozinha: você aproxima o celular na frente do dono e a avaliação abre. Ele entende na hora.', demo: 'Olha a demonstração que fecha a venda em segundos.',
    numero: 'Todo comércio da sua rua é um cliente possível.', beneficio: 'Você define o seu preço de venda e fica com a diferença.',
    ganchos: { dor: 'Quer renda extra sem produto difícil de vender? Olha isto.', curiosidade: 'O produto que se vende sozinho na frente do dono do negócio.', polemica: 'Pare de revender o que todo mundo já vende.', numero: 'Toda rua tem pelo menos 10 clientes para isto.' },
    visual: ['Falando para a câmera, placas na mão', 'Rua de comércio com várias lojas', 'Demonstração para o dono de uma barbearia', 'Dono sorrindo vendo a avaliação abrir', 'Placas em destaque com a palavra-chave na tela'] },
  oferta: { cta: 'EU QUERO',
    dor: 'Você está deixando avaliação na mesa todo dia.', vilao: 'Cada cliente que sai sem avaliar é uma estrela a menos para o seu negócio.',
    mecanismo: 'A placa NexTap resolve isso com um toque, em qualquer celular.', demo: 'Olha a placa funcionando.',
    numero: '', beneficio: 'Quanto mais placas no pedido, menor o preço de cada uma.',
    ganchos: { dor: 'Você está deixando avaliação na mesa todo dia.', curiosidade: 'Quanto custa parar de perder avaliação no seu balcão?', polemica: 'Pedir avaliação no papelzinho não funciona mais.', numero: '' },
    visual: ['Placa na mão, fundo escuro', 'Placa funcionando no celular', 'Condição na tela', 'Palavra-chave na tela'] },
};
function temaDe(c) {
  const t = String(c.titulo || '').toLowerCase();
  if (/nfc ou qr|celular n/.test(t)) return 'nfc_qr';
  if (/onde colocar|lugar/.test(t)) return 'onde_colocar';
  if (/qr code/.test(t)) return 'ja_tenho_qr';
  if (/movimento/.test(t)) return 'movimento_bom';
  if (/configurar|trabalho/.test(t)) return 'configurar';
  if (c.pilar === 'Revenda e lucro') return 'revenda';
  if (c.pilar === 'Oferta') return 'oferta';
  return 'avaliacao5s';
}

// ======================= Estruturas (frameworks) =======================
// Cada uma devolve as batidas do vídeo: [papel, fala]. O gancho é a primeira batida.
const FW = {
  verdade: { nome: 'Verdade incômoda', quando: 'Para temas em que o dono acha que já sabe; quebra a crença com uma verdade dita sem rodeio.',
    batidas: m => [['Verdade', m.vilao], ['Virada', m.mecanismo], ['Demonstração', m.demo], ['Ganho', m.beneficio]] },
  erro: { nome: 'O erro que custa caro', quando: 'Para mostrar o custo de continuar fazendo do jeito antigo.',
    batidas: m => [['O erro', m.dor], ['Quanto custa', m.vilao], ['A correção', m.mecanismo], ['Demonstração', m.demo]] },
  contraste: { nome: 'Antes e depois', quando: 'Quando dá para mostrar o jeito antigo e o novo lado a lado na tela.',
    batidas: m => [['Antes', m.vilao], ['Depois', m.mecanismo], ['Demonstração', m.demo], ['Em números', m.numero || m.beneficio]] },
  objecao: { nome: 'Objeção de frente', quando: 'Para a frase que trava a compra: repete a objeção e responde sem rodeio.',
    batidas: m => [['A objeção', m.objecao ? `Todo dono me fala: ${m.objecao}` : m.dor], ['Vou ser direto', m.vilao], ['A resposta', m.mecanismo], ['Demonstração', m.demo]] },
  numero: { nome: 'Número na tela', quando: 'Quando existe um número simples que resume a ideia.',
    batidas: m => [['O número', m.numero || m.dor], ['Por quê', m.vilao], ['Como', m.mecanismo], ['Demonstração', m.demo]] },
};
DNA.frameworks = Object.entries(FW).map(([id, f]) => ({ id, nome: f.nome, quando: f.quando }));
const FAMILIAS = { dor: 'Dor / perda', curiosidade: 'Curiosidade', polemica: 'Polêmica', numero: 'Número' };

// ======================= Placar de aprendizado =======================
function cerebro() {
  let c = {}; try { c = JSON.parse(getSetting('davi_cerebro') || '{}'); } catch (e) { c = {}; }
  c.fw = c.fw || {}; c.fam = c.fam || {}; c.treinos = c.treinos || 0;
  for (const k of Object.keys(FW)) c.fw[k] = c.fw[k] || { n: 0, nota: 50 };
  for (const k of Object.keys(FAMILIAS)) c.fam[k] = c.fam[k] || { n: 0, nota: 50 };
  return c;
}
const salvarCerebro = c => setSetting('davi_cerebro', JSON.stringify(c));
// nota de seleção: média aprendida + bônus para quem foi pouco testado (exploração)
const potencial = x => x.nota + 18 / Math.sqrt(x.n + 1);

function escolherFw(c, tema, conteudoId, evitar = []) {
  const cer = cerebro(), m = TEMAS[tema];
  let ops = Object.keys(FW).filter(k => !evitar.includes(k));
  if (!m.objecao) ops = ops.filter(k => k !== 'objecao');
  if (!m.numero) ops = ops.filter(k => k !== 'numero');
  if (!ops.length) ops = ['verdade'];
  // o último usado neste mesmo tema não se repete (variedade semana a semana)
  const ult = db.prepare("SELECT d.fw FROM davi_roteiros d JOIN conteudo c ON c.id = d.conteudo_id WHERE c.titulo = ? AND d.conteudo_id <> ? ORDER BY d.criado_em DESC LIMIT 1").get(c.titulo, conteudoId || 0);
  if (ult && ops.length > 1) ops = ops.filter(k => k !== ult.fw);
  // variedade na semana: evita repetir a estrutura que outro vídeo da mesma semana já usa
  if (c.semana) {
    const usadas = db.prepare('SELECT d.fw FROM davi_roteiros d JOIN conteudo x ON x.id = d.conteudo_id WHERE x.semana = ? AND d.conteudo_id <> ?').all(c.semana, conteudoId || 0).map(r => r.fw);
    const livres = ops.filter(k => !usadas.includes(k)); if (livres.length) ops = livres;
  }
  return ops.sort((a, b) => potencial(cer.fw[b]) - potencial(cer.fw[a]) || ((conteudoId || 0) + a.length) % 3 - ((conteudoId || 0) + b.length) % 3 || a.localeCompare(b))[0];
}

// ======================= Revisão (nota de 0 a 100) =======================
const PROIBIDO = /(garantid|100 ?%|fature|faturar|fique rico|dinheiro f[aá]cil|milion|sem esfor[cç]o)/i;
const sem = t => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const palavras = t => String(t || '').trim().split(/\s+/).filter(Boolean).length;
function revisar(r) {
  const fala = r.cenas.map(x => x.fala).join(' ');
  const itens = [
    ['Gancho com até 12 palavras', palavras(r.ganchos[0].texto) <= 12],
    ['Gancho fala com "você" ou com o cliente dele', /\b(voc[eê]|seu|sua)\b/i.test(r.ganchos.map(g => g.texto).join(' '))],
    ['Tem um número concreto', /\d|\b(um|uma|dois|duas|tr[eê]s|seis|zero)\b/i.test(fala + r.ganchos.map(g => g.texto).join(' '))],
    ['Frases curtas (até 15 palavras)', fala.split(/(?<=[.!?…:])\s+/).every(f => palavras(f) <= 18)],
    ['Uma única chamada com palavra-chave', (r.cenas.map(x => x.fala).join(' ').match(/Comente /g) || []).length === 1],
    ['Tem demonstração na tela', r.cenas.some(x => /Demonstra/.test(x.papel))],
    ['Duração entre 15 e 45 segundos', r.duracao_s >= 15 && r.duracao_s <= 45],
    ['Sem promessa exagerada', !PROIBIDO.test(fala + r.legenda)],
    ['Legenda com no máximo 5 hashtags', (r.legenda.match(/#/g) || []).length <= 5],
    ['3 ganchos de famílias diferentes', new Set(r.ganchos.map(g => g.familia)).size === r.ganchos.length && r.ganchos.length >= 3],
  ];
  return { nota: Math.round(100 * itens.filter(x => x[1]).length / itens.length), itens: itens.map(([t, ok]) => ({ t, ok })) };
}

// ======================= Escrita =======================
const segs = t => Math.max(2, Math.round(palavras(t) / 2.6));   // ~2,6 palavras por segundo de fala
function escrever(c, fw, dados = {}) {
  const tema = temaDe(c), m = { ...TEMAS[tema] };
  if (tema === 'oferta') {
    if (dados.promo) { m.numero = `${dados.promo.nome}: placas a partir de R$ ${dados.promo.a_partir}, até ${dados.promo.ate}.`; m.ganchos = { ...m.ganchos, numero: `${dados.promo.nome}: até ${dados.promo.ate}. Depois, o preço volta.`, curiosidade: `O que muda no seu pedido até ${dados.promo.ate}.` }; m.cta = 'BLACK'; }
    else if (dados.menor) { m.numero = `Placas a partir de R$ ${dados.menor} cada, com pedido mínimo de ${dados.minimo}.`; m.ganchos = { ...m.ganchos, numero: `Placa de avaliação a partir de R$ ${dados.menor}.` }; m.cta = 'REVENDER'; }
  }
  const cer = cerebro(), fams = Object.keys(FAMILIAS).filter(f => m.ganchos[f]).sort((a, b) => potencial(cer.fam[b]) - potencial(cer.fam[a]));
  // o gancho principal vem da família que mais converte; os outros dois são de famílias diferentes, para testar
  const ganchos = fams.slice(0, 3).map(f => ({ familia: f, familia_nome: FAMILIAS[f], texto: m.ganchos[f] }));
  const cta = `Comente ${m.cta} que eu te mando no direct.`;
  // batidas da estrutura, sem repetir o que o gancho já disse
  const pal = t => new Set(sem(t).split(' ').filter(w => w.length > 3));
  const parecido = (a, b) => { const A = pal(a), B = pal(b); if (!A.size || !B.size) return false; let i = 0; A.forEach(w => { if (B.has(w)) i++; }); return i / Math.min(A.size, B.size) >= 0.6; };
  let corpo = FW[fw].batidas(m).filter(b => b[1] && !parecido(b[1], ganchos[0].texto));
  if (tema === 'oferta' && m.numero && !corpo.some(b => b[1] === m.numero)) corpo.push(['Condição', m.numero]);   // a oferta sempre mostra a condição
  const batidas = [['Gancho', ganchos[0].texto], ...corpo, ['Chamada', cta]];
  let t = 0;
  const cenas = batidas.map(([papel, fala], i) => {
    const d = i === 0 ? 3 : segs(fala), ini = t; t += d;
    const tela = papel === 'Gancho' ? fala : papel === 'Chamada' ? `Comente ${m.cta}` : resumoTela(fala);
    return { tempo: `${ini}–${t}s`, papel, acao: m.visual[Math.min(i, m.visual.length - 1)] || '', fala, tela };
  });
  const tags = '#avaliacoesgoogle #nfc #pequenosnegocios #marketinglocal #nextap';
  const legenda = [ganchos[0].texto, '', m.vilao, '', m.mecanismo + (m.beneficio ? ' ' + m.beneficio : ''), '', `👉 Comente ${m.cta} que eu te mando no direct.`, '', tags].join('\n');
  const r = { id: c.id, dia: c.dia, formato: c.formato, pilar: c.pilar, titulo: c.titulo, status: c.status, tema, fw, fw_nome: FW[fw].nome, ganchos, cta: `Comente ${m.cta}`, legenda, cenas, duracao_s: t };
  r.revisao = revisar(r);
  return r;
}
// Texto curto para a tela: a parte mais forte da fala, com até 7 palavras e sem cortar no meio da ideia quando der.
function resumoTela(f) {
  let s = String(f).replace(/["“”]/g, '').split(/(?<=[.!?…])\s+/)[0].replace(/[.!…]$/, '');
  const dp = s.split(/:\s*/); if (dp.length > 1 && palavras(dp[0]) <= 3) s = dp.slice(1).join(': ');   // "Olha: um toque..." → "um toque..."
  else if (dp.length > 1) s = dp[0];
  s = s.replace(/^(Só que|Por isso|E|Mas)\s+/i, '');
  const partes = s.split(/,\s+/); if (palavras(s) > 9 && palavras(partes[0]) >= 3 && palavras(partes[0]) <= 9) s = partes[0];
  const w = s.split(/\s+/); s = w.length > 9 ? w.slice(0, 8).join(' ') + '…' : s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Roteiro do vídeo: fica salvo (estável) até o CEO pedir para reescrever
function roteiro(c, dados = {}) {
  const sv = db.prepare('SELECT * FROM davi_roteiros WHERE conteudo_id = ?').get(c.id);
  if (sv) {
    try {
      const r = escrever(c, sv.fw, dados);   // reescreve com a munição atual (melhorias de texto entram sozinhas), mantendo a estrutura escolhida
      return { ...r, gancho_usado: sv.gancho_usado, views: sv.views, comentarios: sv.comentarios, avaliado: !!sv.avaliado_em };
    } catch (e) { /* estrutura antiga: escolhe de novo */ }
  }
  let fw = escolherFw(c, temaDe(c), c.id), r = escrever(c, fw, dados);
  if (r.revisao.nota < 80) {   // revisão antes de entregar: tenta outra estrutura
    const alt = escrever(c, escolherFw(c, temaDe(c), c.id, [fw]), dados);
    if (alt.revisao.nota > r.revisao.nota) { r = alt; fw = alt.fw; }
  }
  db.prepare('INSERT OR REPLACE INTO davi_roteiros (conteudo_id, fw, dados, criado_em) VALUES (?, ?, ?, ?)').run(c.id, fw, '{}', Date.now());
  return r;
}
function reescrever(conteudoId, dados = {}) {
  const c = db.prepare('SELECT * FROM conteudo WHERE id = ?').get(conteudoId); if (!c) throw new Error('Vídeo não encontrado.');
  const sv = db.prepare('SELECT fw FROM davi_roteiros WHERE conteudo_id = ?').get(conteudoId);
  const fw = escolherFw(c, temaDe(c), c.id, sv ? [sv.fw] : []);
  db.prepare('INSERT OR REPLACE INTO davi_roteiros (conteudo_id, fw, dados, criado_em) VALUES (?, ?, ?, ?)').run(conteudoId, fw, '{}', Date.now());
  return roteiro(c, dados);
}
function resultado(conteudoId, { gancho, views, comentarios } = {}) {
  if (!db.prepare('SELECT 1 FROM davi_roteiros WHERE conteudo_id = ?').get(conteudoId)) throw new Error('Abra o roteiro antes de registrar o resultado.');
  const num = v => (v === '' || v === null || v === undefined || isNaN(Number(v)) ? null : Math.max(0, Math.round(Number(v))));
  const g = num(gancho), c = db.prepare('SELECT * FROM conteudo WHERE id = ?').get(conteudoId);
  let dados = null;
  if (g && c) { const r = roteiro(c); const x = r.ganchos[Math.max(0, Math.min(r.ganchos.length - 1, g - 1))]; dados = JSON.stringify({ familia: x.familia, gancho: x.texto }); }
  db.prepare('UPDATE davi_roteiros SET gancho_usado = COALESCE(?, gancho_usado), views = COALESCE(?, views), comentarios = COALESCE(?, comentarios), dados = COALESCE(?, dados) WHERE conteudo_id = ?')
    .run(g, num(views), num(comentarios), dados, conteudoId);
  return true;
}

// ======================= Treino diário =======================
// Dois dias depois de cada vídeo postado: conta os comentários que chegaram (ou usa os números que o CEO registrou),
// dá nota para a estrutura e para a família do gancho e anota o que aprendeu.
function treinar(t0 = Date.now()) {
  const cer = cerebro(), aprendi = [];
  const pend = db.prepare(`SELECT d.*, c.dia, c.titulo, c.status FROM davi_roteiros d JOIN conteudo c ON c.id = d.conteudo_id
    WHERE d.avaliado_em IS NULL AND c.status = 'postado' AND c.dia <= ?`).all(dataStr(t0 - 2 * DIA));
  for (const p of pend) {
    const ini = Date.parse(p.dia + 'T00:00:00-03:00'), fim = ini + 2 * DIA;
    let com = p.comentarios;
    if (com === null || com === undefined) { try { com = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind = 'comentario' AND direction = 'in' AND created_at >= ? AND created_at < ?").get(ini, fim).n; } catch (e) { com = 0; } }
    // nota de 0 a 100: comentários pesam mais que visualizações (comentário vira conversa e venda)
    const nota = Math.min(100, com * 12 + (p.views ? Math.min(40, p.views / 50) : 0));
    const fw = cer.fw[p.fw] || (cer.fw[p.fw] = { n: 0, nota: 50 });
    fw.nota = Math.round((fw.nota * fw.n + nota) / (fw.n + 1)); fw.n++;
    const c = db.prepare('SELECT * FROM conteudo WHERE id = ?').get(p.conteudo_id);
    let fam = null;
    try { fam = JSON.parse(p.dados || '{}').familia || null; } catch (e) { /* sem registro */ }
    if (!fam) { try { fam = escrever(c, p.fw).ganchos[0].familia; } catch (e) { /* tema removido */ } }
    if (fam) { const f = cer.fam[fam]; f.nota = Math.round((f.nota * f.n + nota) / (f.n + 1)); f.n++; }
    db.prepare('UPDATE davi_roteiros SET avaliado_em = ?, comentarios = ? WHERE conteudo_id = ?').run(t0, com, p.conteudo_id);
    aprendi.push(`"${p.titulo}" (${FW[p.fw] ? FW[p.fw].nome : p.fw}${fam ? ', gancho de ' + FAMILIAS[fam].toLowerCase() : ''}): ${com} comentário(s)${p.views ? ' e ' + p.views + ' visualizações' : ''}, nota ${Math.round(nota)}.`);
  }
  cer.treinos++; cer.ultimo = t0; salvarCerebro(cer);
  // pauta a partir das dúvidas reais dos clientes
  let pautas = [];
  try { pautas = require('./duvidas.js').mapa(30, t0).temas.slice(0, 3).map(x => x.nome.replace(/^\S+\s/, '')); } catch (e) { /* sem mapa */ }
  const rk = ranking(cer);
  const linhas = [
    ...(aprendi.length ? ['📈 O que aprendi com os vídeos:', ...aprendi.map(x => '• ' + x)] : ['📚 Nenhum vídeo novo para avaliar hoje (preciso de 2 dias depois da postagem). Revisei as estruturas e os ganchos.']),
    `🏆 Estrutura que mais converte: ${rk.fw[0].nome} (nota ${rk.fw[0].nota}${rk.fw[0].n ? `, ${rk.fw[0].n} vídeo(s)` : ', ainda sem dados'}).`,
    `🎣 Gancho que mais converte: ${rk.fam[0].nome} (nota ${rk.fam[0].nota}).`,
    ...(pautas.length ? [`💡 Próximas pautas pelas dúvidas dos clientes: ${pautas.join(', ')}.`] : []),
  ];
  return { texto: linhas.join('\n'), avaliados: aprendi.length };
}
function ranking(cer = cerebro()) {
  return {
    fw: Object.entries(cer.fw).filter(([k]) => FW[k]).map(([k, v]) => ({ id: k, nome: FW[k].nome, ...v })).sort((a, b) => b.nota - a.nota || b.n - a.n),
    fam: Object.entries(cer.fam).filter(([k]) => FAMILIAS[k]).map(([k, v]) => ({ id: k, nome: FAMILIAS[k], ...v })).sort((a, b) => b.nota - a.nota || b.n - a.n),
    treinos: cer.treinos, ultimo: cer.ultimo || null,
  };
}

module.exports = { DNA, FW, FAMILIAS, TEMAS, temaDe, escrever, revisar, roteiro, reescrever, resultado, treinar, ranking, cerebro };
