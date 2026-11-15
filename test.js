// Testes automáticos (sem internet, banco em memória):  npm test
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'senha-de-teste-123';
process.env.META_APP_SECRET = 'segredo-de-teste';
process.env.META_VERIFY_TOKEN = 'verificar-123';
process.env.NODE_ENV = 'test';
process.env.STEP_DELAY_MS = '0';
process.env.CLICK_DELAY_MS = '0';
process.env.WA_GAP_MS = '0';
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');

const { db, setSetting } = require('./db.js');
const { semear } = require('./seed.js');
const engine = require('./engine.js');
const ig = require('./instagram.js');
semear();

let ok = 0, falhou = 0;
async function t(nome, fn) {
  try { await fn(); ok++; console.log('  ✓', nome); } catch (e) { falhou++; console.log('  ✗', nome, '\n     ', e.message); }
}
const falso = () => { const env = []; return { env, async send(c, p) { env.push(p); }, async sendPrivateReply(id, tx) { env.push({ type: 'text', text: tx, privada: id }); } }; };
let n = 0;
const msg = (texto, extra = {}) => ({ canal: 'instagram', extId: extra.extId || 'u' + (++n), username: 'fulano', texto, mid: 'm' + (++n), ...extra });

(async () => {
  console.log('Motor de palavras-chave');
  const ENTRADA = 'Entrada: REVENDER ou MEU NEGÓCIO';
  await t('normaliza acento, caixa e pontuação', () => assert.strictEqual(engine.normalizar('  Qual o PREÇO?! '), 'qual o preco'));
  for (const frase of ['qual o preço?', 'Quanto custa a NexTap?', 'qual valor?', 'quero', 'eu quero', 'NFC', 'me passa o orçamento', 'PREÇOS']) {
    await t(`"${frase}" abre a entrada (pergunta REVENDER / MEU NEGÓCIO)`, () => assert.strictEqual((engine.acharFluxo(frase) || {}).name, ENTRADA));
  }
  await t('revender / revenda vão direto para a quantidade', () => ['revender', 'quero revender', 'revenda', 'QUERO REVENDER'].forEach(f => assert.strictEqual(engine.acharFluxo(f).name, 'REVENDER: quantas placas?')));
  await t('meu negócio vai para o fluxo de negócio', () => assert.strictEqual(engine.acharFluxo('é para o meu negócio').name, 'MEU NEGÓCIO: ver funcionando'));
  await t('objeções', () => {
    assert.strictEqual(engine.acharFluxo('como funciona?').name, 'Objeção: Como funciona?');
    assert.strictEqual(engine.acharFluxo('o nfc funciona em todo celular?').name, 'Objeção: Como funciona?');
    assert.strictEqual(engine.acharFluxo('já tenho qr code').name, 'Objeção: Já tenho QR Code');
    assert.strictEqual(engine.acharFluxo('achei caro').name, 'Objeção: Está caro');
    assert.strictEqual(engine.acharFluxo('qual o prazo?').name, 'Prazo e entrega');
  });
  await t('prioridade maior vence (nota fiscal > entrada)', () => assert.strictEqual(engine.acharFluxo('quanto custa com nota fiscal').name, 'Nota fiscal'));
  await t('atendente/ajuda vencem tudo, exceto parar', () => { assert.strictEqual(engine.acharFluxo('preciso de ajuda com o preço').name, 'Falar com atendente'); assert.strictEqual(engine.acharFluxo('quero falar com um humano').name, 'Falar com atendente'); });
  await t('não casa dentro de outra palavra', () => assert.strictEqual(engine.acharFluxo('inconfundivel'), null));
  await t('texto sem palavra-chave não aciona', () => assert.strictEqual(engine.acharFluxo('bom dia tudo bem'), null));
  await t('"preciso sair agora" NÃO para o robô', () => assert.notStrictEqual((engine.acharFluxo('preciso sair agora') || {}).name, 'Parar mensagens'));
  await t('palavras de parada (inclusive frases) têm prioridade máxima', () => {
    for (const f of ['sair', 'parar', 'stop', 'cancelar']) assert.strictEqual(engine.acharFluxo(f).name, 'Parar mensagens');
    for (const f of ['não quero receber', 'não enviar mais', 'não quero mais receber ajuda']) assert.strictEqual(engine.acharFluxo(f).name, 'Parar mensagens (frases)');
  });
  await t('fluxos de botão, evento e follow-up não respondem a texto digitado', () => {
    for (const f of ['quero ajuda de verdade', 'ver valores', 'falar com comercial', 'conseguiu calcular', 'vou encerrar']) {
      const r = engine.acharFluxo(f); assert.ok(!r || r.kind === 'normal');
    }
  });
  await t('textos não têm asteriscos (Instagram não formata negrito)', () => {
    for (const f of db.prepare('SELECT steps, comment_text FROM flows').all()) assert.ok(!(f.steps + (f.comment_text || '')).includes('*'), 'asterisco encontrado');
  });
  await t('limites do Instagram: botões e respostas rápidas até 20 letras, botão com 640', () => {
    for (const f of db.prepare('SELECT name, steps FROM flows').all()) for (const p of JSON.parse(f.steps)) {
      (p.buttons || []).forEach(b => assert.ok(b.title.length <= 20, f.name + ': ' + b.title));
      (p.replies || []).forEach(r => assert.ok(r.title.length <= 20 && r.flow_id, f.name + ': ' + r.title));
      if (p.type === 'button' || p.type === 'quick') assert.ok(p.text.length <= 640, f.name);
    }
  });
  await t('instalar o funil de novo não duplica', () => assert.strictEqual(require('./seed.js').instalarV2(), false));

  console.log('Funil de conversa');
  const rec = () => { const env = []; return { env, async send(c, p) { env.push({ c: c.id, p }); }, async sendPrivateReply(id, tx) { env.push({ c: 0, p: { type: 'text', text: tx, privada: id } }); } }; };
  const contatoDe = ext => db.prepare('SELECT * FROM contacts WHERE ext_id = ?').get(ext);
  const tagsC = ext => JSON.parse(contatoDe(ext).tags);
  const respRapida = (p, titulo) => { const r = p.replies.find(x => x.title === titulo); assert.ok(r, 'sem botão ' + titulo); return 'FLOW:' + r.flow_id; };
  setSetting('public_url', 'https://bot.exemplo.com');
  await t('entrada: pergunta REVENDER ou MEU NEGÓCIO, sem mandar link', async () => {
    const s = rec(); const r = await engine.processarMensagem(msg('qual o preço?', { extId: 'f1' }), s);
    assert.strictEqual(r.fluxo, ENTRADA); assert.strictEqual(s.env.length, 1);
    const p = s.env[0].p; assert.strictEqual(p.type, 'quick'); assert.deepStrictEqual(p.replies.map(x => x.title), ['💰 REVENDER', '🏪 MEU NEGÓCIO']);
    assert.ok(!JSON.stringify(s.env).includes('http')); assert.deepStrictEqual(tagsC('f1'), ['NOVO LEAD']);
  });
  let pQtd;
  await t('REVENDER: pergunta quantidade em 4 faixas e marca REVENDEDOR', async () => {
    const s = rec(); const e = rec(); await engine.processarMensagem(msg('preço', { extId: 'f2' }), e);
    await engine.processarMensagem(msg('REVENDER', { extId: 'f2', payload: respRapida(e.env[0].p, '💰 REVENDER') }), s);
    pQtd = s.env[0].p; assert.deepStrictEqual(pQtd.replies.map(x => x.title), ['1–10', '11–49', '50–299', '300+']);
    assert.ok(tagsC('f2').includes('REVENDEDOR'));
  });
  await t('11–49: demo (pulado sem vídeo) → explicação → preço com link rastreado', async () => {
    const s = rec(); await engine.processarMensagem(msg('11–49', { extId: 'f2', payload: respRapida(pQtd, '11–49') }), s);
    assert.deepStrictEqual(s.env.map(x => x.p.type), ['text', 'text', 'button']);             // sem vídeo configurado: etapa pulada
    const b = s.env[2].p.buttons[0]; assert.strictEqual(b.title, 'CALCULAR MEU PEDIDO'); assert.ok(b.url.startsWith('https://bot.exemplo.com/go/'));
    const tg = tagsC('f2'); for (const x of ['QUANTIDADE', 'QTD 11-49', 'VIU DEMO', 'VIU PREÇO']) assert.ok(tg.includes(x), x);
    assert.strictEqual(contatoDe('f2').human_priority, 0);
  });
  await t('com vídeo configurado, o vídeo é enviado entre a mensagem e a explicação', async () => {
    setSetting('video_demo_url', 'https://exemplo.com/demo.mp4');
    const s = rec(); await engine.processarMensagem(msg('1–10', { extId: 'f2', payload: respRapida(pQtd, '1–10') }), s);
    assert.deepStrictEqual(s.env.map(x => x.p.type), ['text', 'video', 'text', 'button']); assert.strictEqual(s.env[1].p.url, 'https://exemplo.com/demo.mp4');
  });
  await t('vídeo que falha não derruba o resto da sequência', async () => {
    const env = []; const s = { async send(c, p) { if (p.type === 'video') throw new Error('video recusado'); env.push(p.type); } };
    await engine.processarMensagem(msg('1–10', { extId: 'f2', payload: respRapida(pQtd, '1–10') }), s);
    assert.deepStrictEqual(env, ['text', 'text', 'text', 'button']);   // o vídeo recusado vira link no texto
  });
  await t('clique no link: redireciona com utm, marca ABRIU CHECKOUT, agenda a mensagem de acompanhamento', async () => {
    const tok = db.prepare('SELECT token FROM links WHERE contact_id = ?').get(contatoDe('f2').id).token;
    const dest = engine.registrarClique(tok); assert.ok(dest.startsWith(require('./db.js').getSetting('site_url'))); assert.ok(dest.includes('utm_source=instagram'));
    assert.ok(tagsC('f2').includes('ABRIU CHECKOUT')); assert.strictEqual(engine.registrarClique('inexistente'), null);
    const s = rec(); const r = await engine.tick(s); assert.strictEqual(r.agenda, 1);
    const q = s.env.find(x => x.c === contatoDe('f2').id).p; assert.deepStrictEqual(q.replies.map(x => x.title), ['QUERO AJUDA', 'JÁ VOU COMPRAR']);
    engine.registrarClique(tok); assert.strictEqual((await engine.tick(rec())).agenda, 0);       // segundo clique não repete a mensagem
  });
  await t('JÁ VOU COMPRAR: marca INTENÇÃO DE COMPRA e não pede humano', async () => {
    const q = (await (async () => { const s = rec(); engine.registrarClique(db.prepare('SELECT token FROM links WHERE contact_id = ?').get(contatoDe('f2').id).token); return s; })());
    const id = db.prepare("SELECT id FROM flows WHERE name = 'Botão: JÁ VOU COMPRAR'").get().id;
    const s = rec(); const r = await engine.processarMensagem(msg('JÁ VOU COMPRAR', { extId: 'f2', payload: 'FLOW:' + id }), s);
    assert.ok(r.enviados >= 1); assert.ok(tagsC('f2').includes('INTENÇÃO DE COMPRA')); assert.strictEqual(contatoDe('f2').needs_human, 0);
  });
  await t('QUERO AJUDA chama atendente (prioridade normal) e pausa o robô', async () => {
    const id = db.prepare("SELECT id FROM flows WHERE name = 'Botão: QUERO AJUDA'").get().id;
    await engine.processarMensagem(msg('QUERO AJUDA', { extId: 'f3', payload: 'FLOW:' + id }), rec());
    const c = contatoDe('f3'); assert.strictEqual(c.needs_human, 1); assert.strictEqual(c.human_priority, 1); assert.ok(c.bot_paused_until > Date.now());
  });
  let pGrande;
  await t('50–299: lead quente, fila humana com prioridade alta SEM pausar o robô', async () => {
    const e = rec(), s = rec(); await engine.processarMensagem(msg('revender', { extId: 'f4' }), e);
    await engine.processarMensagem(msg('50–299', { extId: 'f4', payload: respRapida(e.env[0].p, '50–299') }), s);
    pGrande = s.env[s.env.length - 1].p; assert.deepStrictEqual(pGrande.replies.map(x => x.title), ['FALAR COM COMERCIAL', 'VER VALORES']);
    const c = contatoDe('f4'), tg = tagsC('f4'); assert.strictEqual(c.human_priority, 2); assert.strictEqual(c.needs_human, 1); assert.ok(!(c.bot_paused_until > Date.now()));
    for (const x of ['QTD 50-299', 'LEAD GRANDE', 'QUENTE']) assert.ok(tg.includes(x), x);
    assert.ok(!JSON.stringify(s.env).includes('CALCULAR'), 'preço não vem antes do comercial');
  });
  await t('FALAR COM COMERCIAL: atendimento humano com prioridade alta e robô pausado', async () => {
    await engine.processarMensagem(msg('FALAR COM COMERCIAL', { extId: 'f4', payload: respRapida(pGrande, 'FALAR COM COMERCIAL') }), rec());
    const c = contatoDe('f4'); assert.strictEqual(c.human_priority, 2); assert.ok(c.bot_paused_until > Date.now());
  });
  await t('VER VALORES (lead grande) mostra a calculadora e marca VIU PREÇO', async () => {
    const s = rec(); await engine.processarMensagem(msg('VER VALORES', { extId: 'f5', payload: respRapida(pGrande, 'VER VALORES') }), s);
    assert.strictEqual(s.env[0].p.buttons[0].title, 'CALCULAR MEU PEDIDO'); assert.ok(tagsC('f5').includes('VIU PREÇO'));
  });
  await t('quantidade digitada: "100" vira a faixa 50–299 (só para REVENDEDOR)', async () => {
    const e = rec(); await engine.processarMensagem(msg('revender', { extId: 'f6' }), e);
    const r = await engine.processarMensagem(msg('uns 100 placas', { extId: 'f6' }), rec()); assert.strictEqual(r.fluxo, 'Quantidade: 50–299 (lead quente)');
    const r2 = await engine.processarMensagem(msg('300', { extId: 'f7' }), rec()); assert.notStrictEqual(r2.fluxo, 'Quantidade: 300+ (lead quente)');
  });
  await t('MEU NEGÓCIO: ver funcionando → vídeo → modelos', async () => {
    const e = rec(), s = rec(); await engine.processarMensagem(msg('preço', { extId: 'f8' }), e);
    await engine.processarMensagem(msg('x', { extId: 'f8', payload: respRapida(e.env[0].p, '🏪 MEU NEGÓCIO') }), s);
    assert.strictEqual(s.env.length, 2); assert.ok(tagsC('f8').includes('MEU NEGÓCIO'));
    const s2 = rec(); await engine.processarMensagem(msg('x', { extId: 'f8', payload: respRapida(s.env[1].p, 'SIM, ME MOSTRA') }), s2);
    assert.deepStrictEqual(s2.env.map(x => x.p.type), ['video', 'text', 'quick']);
    const s3 = rec(); await engine.processarMensagem(msg('x', { extId: 'f8', payload: respRapida(s2.env[2].p, 'VER MODELOS') }), s3);
    assert.strictEqual(s3.env[1].p.buttons[0].title, 'VER MODELOS');
  });

  console.log('Follow-ups (janela de 24h)');
  const H1 = 3600e3;
  function novoLead(ext, tags = ['REVENDEDOR', 'ABRIU CHECKOUT']) {
    const c = engine.upsertContato({ canal: 'instagram', extId: ext, username: 'lead' });
    db.prepare('UPDATE contacts SET tags = ?, last_inbound_at = ?, last_click_at = ?, followup_step = 0, needs_human = 0, bot_paused_until = 0 WHERE id = ?').run(JSON.stringify(tags), Date.now(), Date.now(), c.id);
    return c.id;
  }
  const enviosDe = (s, id) => s.env.filter(x => x.c === id).map(x => x.p);
  await t('sequência 1→2→3→final nos horários certos, sem duplicar e sem passar de 24h', async () => {
    db.prepare("UPDATE contacts SET followup_step = 99 WHERE ext_id NOT LIKE 'fu%'").run();
    const id = novoLead('fu1'), base = Date.now(), s = rec();
    await engine.tick(s, { agoraMs: base + 2 * H1 }); assert.strictEqual(enviosDe(s, id).length, 0, 'cedo demais');
    await engine.tick(s, { agoraMs: base + 3.2 * H1 }); assert.ok(enviosDe(s, id)[0].text.includes('Conseguiu calcular'));
    await engine.tick(s, { agoraMs: base + 3.3 * H1 }); assert.strictEqual(enviosDe(s, id).length, 1, 'duplicou');
    await engine.tick(s, { agoraMs: base + 9.2 * H1 }); assert.ok(enviosDe(s, id)[1].text.includes('dúvida rápida'));
    await engine.tick(s, { agoraMs: base + 16.2 * H1 }); assert.strictEqual(enviosDe(s, id)[2].replies[0].title, 'QUERO O ROTEIRO');
    await engine.tick(s, { agoraMs: base + 22.2 * H1 }); assert.ok(enviosDe(s, id)[3].text.includes('QUERO REVENDER'));
    await engine.tick(s, { agoraMs: base + 23.0 * H1 }); assert.strictEqual(enviosDe(s, id).length, 4);
    assert.ok(tagsC('fu1').includes('FOLLOW-UP'));
  });
  await t('não manda follow-up fora da janela de 24h', async () => {
    const id = novoLead('fu2'), s = rec();
    await engine.tick(s, { agoraMs: Date.now() + 24.5 * H1 }); assert.strictEqual(enviosDe(s, id).length, 0);
  });
  await t('não manda para quem comprou, tem intenção de compra ou está com humano; MEU NEGÓCIO recebe a sequência dele', async () => {
    const ids = [novoLead('fu3', ['REVENDEDOR', 'ABRIU CHECKOUT', 'VENDA']), novoLead('fu4', ['REVENDEDOR', 'ABRIU CHECKOUT', 'INTENÇÃO DE COMPRA']), novoLead('fu6')];
    db.prepare('UPDATE contacts SET needs_human = 1 WHERE id = ?').run(ids[2]);
    const neg = novoLead('fu5', ['MEU NEGÓCIO', 'ABRIU CHECKOUT']);
    const s = rec(); await engine.tick(s, { agoraMs: Date.now() + 4 * H1 }); ids.forEach(i => assert.strictEqual(enviosDe(s, i).length, 0));
    const e = enviosDe(s, neg); assert.strictEqual(e.length, 1); assert.ok(e[0].text.includes('Conseguiu ver os modelos'));
    assert.strictEqual(e[0].buttons[0].title, 'VER MODELOS');
  });
  await t('"parar" interrompe os follow-ups', async () => {
    const e = rec(), id = novoLead('fu7'); await engine.processarMensagem(msg('parar', { extId: 'fu7' }), e);
    const s = rec(); await engine.tick(s, { agoraMs: Date.now() + 4 * H1 }); assert.strictEqual(enviosDe(s, id).length, 0);
  });
  await t('follow-ups desligados nas configurações não são enviados', async () => {
    setSetting('followups_enabled', '0'); const id = novoLead('fu8'), s = rec();
    await engine.tick(s, { agoraMs: Date.now() + 4 * H1 }); assert.strictEqual(enviosDe(s, id).length, 0); setSetting('followups_enabled', '1');
  });
  await t('quem responde um follow-up com texto livre vai para atendimento humano', async () => {
    const id = novoLead('fu9'), s = rec(); await engine.tick(s, { agoraMs: Date.now() + 3.2 * H1 });
    assert.strictEqual(enviosDe(s, id).length, 1);
    const r = await engine.processarMensagem(msg('vou vender pessoalmente mesmo', { extId: 'fu9' }), rec());
    assert.strictEqual(r.fluxo, 'Resposta a um follow-up'); const c = contatoDe('fu9'); assert.strictEqual(c.needs_human, 1); assert.strictEqual(c.followup_step, 1);
  });
  await t('texto livre sem follow-up pendente não chama atendente (cai na resposta padrão)', async () => {
    const id = novoLead('fu9b'), s = rec(); await engine.tick(s, { agoraMs: Date.now() + 3.2 * H1 });
    db.prepare('UPDATE contacts SET last_inbound_at = ? WHERE id = ?').run(Date.now() + 4 * H1, id);   // já respondeu depois do follow-up
    const r = await engine.processarMensagem(msg('blablabla', { extId: 'fu9b' }), rec());
    assert.notStrictEqual(r.fluxo, 'Resposta a um follow-up'); assert.strictEqual(contatoDe('fu9b').needs_human, 0);
  });
  await t('responder no meio não recomeça a sequência (não repete o follow-up 1)', async () => {
    const id = novoLead('fu10'), s = rec();
    await engine.tick(s, { agoraMs: Date.now() + 3.2 * H1 }); assert.ok(enviosDe(s, id)[0].text.includes('Conseguiu calcular'));
    await engine.processarMensagem(msg('prazo', { extId: 'fu10' }), rec());   // responde por palavra-chave
    await engine.tick(s, { agoraMs: Date.now() + 3.3 * H1 }); assert.strictEqual(enviosDe(s, id).length, 1, 'repetiu o follow-up 1');
    await engine.tick(s, { agoraMs: Date.now() + 9.2 * H1 }); assert.ok(enviosDe(s, id)[1].text.includes('dúvida rápida'));
  });
  await t('conversa nova (depois de 24h) recomeça a sequência', async () => {
    const id = novoLead('fu11');
    db.prepare("UPDATE contacts SET followup_step = 4, followup_seq = 'checkout', last_inbound_at = ? WHERE id = ?").run(Date.now() - 25 * H1, id);
    await engine.processarMensagem(msg('prazo', { extId: 'fu11' }), rec());
    const c = contatoDe('fu11'); assert.strictEqual(c.followup_step, 0); assert.strictEqual(c.followup_seq, null);
  });
  await t('robô parado: manda só o mais recente que venceu e a mensagem final não se perde', async () => {
    const id = novoLead('fu12'), s = rec();
    await engine.tick(s, { agoraMs: Date.now() + 22.2 * H1 });
    const e = enviosDe(s, id); assert.strictEqual(e.length, 1); assert.ok(e[0].text.includes('QUERO REVENDER'));
    await engine.tick(s, { agoraMs: Date.now() + 23 * H1 }); assert.strictEqual(enviosDe(s, id).length, 1);
  });
  await t('quem não escolheu a quantidade recebe a pergunta de novo; ao escolher, passa para a sequência do preço', async () => {
    const id = novoLead('fu13', ['REVENDEDOR']), s = rec();
    await engine.tick(s, { agoraMs: Date.now() + 1.5 * H1 }); assert.strictEqual(enviosDe(s, id).length, 0, 'cedo demais');
    await engine.tick(s, { agoraMs: Date.now() + 2.1 * H1 });
    const p = enviosDe(s, id)[0]; assert.deepStrictEqual(p.replies.map(r => r.title), ['1–10', '11–49', '50–299', '300+']);
    await engine.processarMensagem(msg('x', { extId: 'fu13', payload: respRapida(p, '11–49') }), rec());
    assert.strictEqual(engine.segmentoDe(contatoDe('fu13')), 'revenda_preco');
    await engine.tick(s, { agoraMs: Date.now() + 2.1 * H1 });
    const b = enviosDe(s, id)[1]; assert.strictEqual(b.type, 'button'); assert.ok(b.text.includes('começar com 11 a 49 placas'), b.text);
    assert.strictEqual(contatoDe('fu13').followup_seq, 'revenda_preco');
  });
  await t('{{quantidade}}: faixa da etiqueta, "mais de 300" e "algumas" sem faixa', () => {
    assert.strictEqual(engine.aplicarVars('{{quantidade}}', { tags: '["QTD 1-10"]' }), '1 a 10');
    assert.strictEqual(engine.aplicarVars('{{quantidade}}', { tags: '["QTD 300+"]' }), 'mais de 300');
    assert.strictEqual(engine.aplicarVars('{{quantidade}}', { tags: '[]' }), 'algumas');
  });
  await t('banco que já tinha o funil ganha as sequências novas uma vez só', () => {
    const { instalarFollowupsEtapas } = require('./seed.js');
    assert.strictEqual(instalarFollowupsEtapas(), false);
    const n = () => db.prepare("SELECT COUNT(*) AS n FROM flows WHERE kind = 'followup' AND audience <> 'checkout'").get().n;
    const antes = n(); assert.ok(antes >= 7);
    setSetting('followups_etapas', '0'); assert.strictEqual(instalarFollowupsEtapas(), true); assert.strictEqual(n(), antes, 'duplicou');
  });

  console.log('Conversa (regras gerais)');
  await t('ignora o mesmo evento repetido (mesmo mid)', async () => {
    const s = rec(), ev = msg('preço'); await engine.processarMensagem(ev, s);
    const r = await engine.processarMensagem(ev, s); assert.strictEqual(r.motivo, 'duplicada'); assert.strictEqual(s.env.length, 1);
  });
  await t('atendente pausa o robô, marca prioridade normal; próxima mensagem não é respondida', async () => {
    const s = rec(), u = msg('quero falar com atendente');
    await engine.processarMensagem(u, s);
    const c = contatoDe(u.extId);
    assert.strictEqual(c.needs_human, 1); assert.strictEqual(c.human_priority, 1); assert.ok(c.bot_paused_until > Date.now());
    const r = await engine.processarMensagem(msg('preço', { extId: u.extId }), s);
    assert.strictEqual(r.motivo, 'pausado');
  });
  await t('"sair" silencia a pessoa por muito tempo e limpa a fila humana', async () => {
    const s = rec(), u = msg('sair'); await engine.processarMensagem(u, s);
    const r = await engine.processarMensagem(msg('preço', { extId: u.extId }), s); assert.strictEqual(r.motivo, 'pausado');
  });
  await t('resposta padrão só 1 vez por período', async () => {
    const s = rec(), id = 'fb1';
    const a = await engine.processarMensagem(msg('asdf qwer', { extId: id }), s);
    const b = await engine.processarMensagem(msg('zxcv uiop', { extId: id }), s);
    assert.strictEqual(a.fluxo, '(resposta padrão)'); assert.strictEqual(b.motivo, 'sem_fluxo'); assert.strictEqual(s.env.length, 1);
  });
  await t('limite de respostas por hora protege contra laço', async () => {
    setSetting('max_replies_hour', '3'); const s = rec(), id = 'lim1'; let ult;
    for (let i = 0; i < 4; i++) ult = await engine.processarMensagem(msg('preço', { extId: id }), s);
    assert.strictEqual(ult.motivo, 'limite_por_hora'); setSetting('max_replies_hour', '30');
  });
  await t('o funil completo cabe no limite padrão por hora', async () => {
    const id = 'lim2', e = rec(); let r = await engine.processarMensagem(msg('preço', { extId: id }), e);
    const q = rec(); await engine.processarMensagem(msg('x', { extId: id, payload: respRapida(e.env[0].p, '💰 REVENDER') }), q);
    const g = rec(); await engine.processarMensagem(msg('x', { extId: id, payload: respRapida(q.env[0].p, '300+') }), g);
    const v = rec(); r = await engine.processarMensagem(msg('x', { extId: id, payload: respRapida(g.env[g.env.length - 1].p, 'VER VALORES') }), v);
    assert.strictEqual(r.acao, 'respondeu');
  });
  await t('falha de envio é registrada e não derruba o robô', async () => {
    const ruim = { async send() { throw new Error('boom'); }, async sendPrivateReply() {} };
    const r = await engine.processarMensagem(msg('preço', { extId: 'erro1' }), ruim);
    assert.strictEqual(r.acao, 'respondeu');
    assert.ok(db.prepare("SELECT 1 FROM messages WHERE status = 'erro'").get());
  });
  await t('comentário: 1 DM de texto pedindo REVENDER ou MEU NEGÓCIO; não repete', async () => {
    const s = rec(); const r = await engine.processarComentario({ canal: 'instagram', commentId: 'cm1', texto: 'quero!', fromId: 'c1', username: 'ana' }, s);
    assert.strictEqual(r.acao, 'respondeu'); assert.strictEqual(s.env.length, 1);
    assert.strictEqual(s.env[0].p.privada, 'cm1'); assert.ok(s.env[0].p.text.includes('REVENDER') && s.env[0].p.text.includes('MEU NEGÓCIO'));
    const r2 = await engine.processarComentario({ canal: 'instagram', commentId: 'cm1', texto: 'quero!', fromId: 'c1' }, s);
    assert.strictEqual(r2.motivo, 'duplicada');
  });
  await t('comentário "revender" marca REVENDEDOR e a resposta numérica entra no funil', async () => {
    await engine.processarComentario({ canal: 'instagram', commentId: 'cm3', texto: 'quero revender', fromId: 'c3', username: 'bia' }, rec());
    assert.ok(tagsC('c3').includes('REVENDEDOR'));
    const r = await engine.processarMensagem(msg('20', { extId: 'c3' }), rec()); assert.strictEqual(r.fluxo, 'Quantidade: 11–49');
  });
  await t('comentário sem palavra-chave é ignorado', async () => {
    const r = await engine.processarComentario({ canal: 'instagram', commentId: 'cm2', texto: 'lindo demais', fromId: 'c2' }, rec());
    assert.strictEqual(r.motivo, 'sem_fluxo');
  });
  await t('{{nome}} some sem sobrar vírgula quando não há nome', () => {
    assert.strictEqual(engine.aplicarVars('Oi, {{nome}} 👋', { username: 'joao_88' }), 'Oi 👋'); assert.strictEqual(engine.aplicarVars('Oi, {{nome}}!', { name: 'Ana Souza' }), 'Oi, Ana!');
  });

  console.log('Instagram (webhook)');
  const corpo = { object: 'instagram', entry: [{ id: 'EU', messaging: [
    { sender: { id: 'A' }, recipient: { id: 'EU' }, timestamp: 1, message: { mid: 'x1', text: 'preço' } },
    { sender: { id: 'EU' }, recipient: { id: 'A' }, timestamp: 2, message: { mid: 'x2', text: 'eco', is_echo: true } },
    { sender: { id: 'B' }, recipient: { id: 'EU' }, timestamp: 3, message: { mid: 'x3', text: 'Prazo', quick_reply: { payload: 'FLOW:2' } } },
    { sender: { id: 'C' }, recipient: { id: 'EU' }, timestamp: 4, message: { mid: 'x4', attachments: [{ type: 'image' }] } },
  ], changes: [{ field: 'comments', value: { id: 'cc1', text: 'quero', from: { id: 'D', username: 'dani' } } }, { field: 'mentions', value: {} }] }] };
  await t('lê mensagens, ignora eco/anexo, lê comentário', () => {
    const r = ig.lerWebhook(corpo);
    assert.strictEqual(r.mensagens.length, 2); assert.strictEqual(r.mensagens[1].payload, 'FLOW:2');
    assert.strictEqual(r.comentarios.length, 1); assert.strictEqual(r.comentarios[0].fromId, 'D');
  });
  await t('assinatura válida/ inválida', () => {
    const b = Buffer.from('{"a":1}'), ass = 'sha256=' + crypto.createHmac('sha256', 'k').update(b).digest('hex');
    assert.ok(ig.assinaturaValida(b, ass, 'k')); assert.ok(!ig.assinaturaValida(b, ass, 'outro')); assert.ok(!ig.assinaturaValida(b, null, 'k'));
    assert.ok(!ig.assinaturaValida(b, 'sha256=00', 'k'));
  });
  await t('vídeo e imagem viram anexo', () => {
    assert.deepStrictEqual(ig.montarMensagem({ type: 'video', url: 'https://a.com/v.mp4' }), { attachment: { type: 'video', payload: { url: 'https://a.com/v.mp4' } } });
    assert.strictEqual(ig.montarMensagem({ type: 'image', url: 'https://a.com/i.jpg' }).attachment.type, 'image');
  });
  await t('formato do botão respeita limites do Instagram', () => {
    const m = ig.montarMensagem({ type: 'button', text: 'x'.repeat(900), buttons: [{ title: 'T'.repeat(40), url: 'https://a.com' }] });
    assert.strictEqual(m.attachment.payload.text.length, 640); assert.strictEqual(m.attachment.payload.buttons[0].title.length, 20);
    const q = ig.montarMensagem({ type: 'quick', text: 'oi', replies: [{ title: 'A', flow_id: 7 }] });
    assert.strictEqual(q.quick_replies[0].payload, 'FLOW:7');
  });

  console.log('Servidor e API');
  const app = require('./server.js');
  const srv = http.createServer(app); await new Promise(r => srv.listen(0, r));
  const porta = srv.address().port;
  const chamar = (metodo, caminho, { corpo, headers = {}, bruto } = {}) => new Promise((res, rej) => {
    const dados = bruto !== undefined ? bruto : (corpo ? JSON.stringify(corpo) : null);
    const req = http.request({ port: porta, path: caminho, method: metodo, headers: { ...(dados ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dados) } : {}), ...headers } }, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} res({ status: r.statusCode, json: j, texto: b }); });
    });
    req.on('error', rej); if (dados) req.write(dados); req.end();
  });
  const assinar = b => 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(b).digest('hex');

  await t('verificação do webhook (GET)', async () => {
    const certo = await chamar('GET', '/webhook/instagram?hub.mode=subscribe&hub.verify_token=verificar-123&hub.challenge=abc');
    assert.strictEqual(certo.status, 200); assert.strictEqual(certo.texto, 'abc');
    assert.strictEqual((await chamar('GET', '/webhook/instagram?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=abc')).status, 403);
  });
  await t('webhook sem assinatura é recusado (401)', async () => assert.strictEqual((await chamar('POST', '/webhook/instagram', { bruto: JSON.stringify(corpo) })).status, 401));
  await t('webhook com assinatura errada é recusado (401)', async () => assert.strictEqual((await chamar('POST', '/webhook/instagram', { bruto: JSON.stringify(corpo), headers: { 'X-Hub-Signature-256': 'sha256=00' } })).status, 401));
  await t('webhook assinado é aceito (200) e processado', async () => {
    const b = JSON.stringify({ object: 'instagram', entry: [{ id: 'EU', messaging: [{ sender: { id: 'Z9' }, message: { mid: 'srv1', text: 'asdf' } }] }] });
    const r = await chamar('POST', '/webhook/instagram', { bruto: b, headers: { 'X-Hub-Signature-256': assinar(b) } });
    assert.strictEqual(r.status, 200);
    await new Promise(r => setTimeout(r, 300));
    assert.ok(db.prepare("SELECT 1 FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE c.ext_id = 'Z9' AND m.direction = 'in'").get(), 'mensagem não foi registrada');
  });
  await t('API exige login', async () => assert.strictEqual((await chamar('GET', '/api/flows')).status, 401));
  await t('login com senha errada falha', async () => assert.strictEqual((await chamar('POST', '/api/login', { corpo: { senha: 'x' } })).status, 401));
  const tk = (await chamar('POST', '/api/login', { corpo: { senha: process.env.ADMIN_PASSWORD } })).json.token;
  const H = { Authorization: 'Bearer ' + tk };
  await t('token adulterado é recusado', async () => assert.strictEqual((await chamar('GET', '/api/flows', { headers: { Authorization: 'Bearer 9999999999999.abc' } })).status, 401));
  await t('lista fluxos e status', async () => {
    assert.ok((await chamar('GET', '/api/flows', { headers: H })).json.length >= 25);
    const s = (await chamar('GET', '/api/status', { headers: H })).json; assert.strictEqual(typeof s.contatos, 'number'); assert.ok(s.webhook_url.endsWith('/webhook/instagram'));
  });
  const base = { name: 'Teste', priority: 5, match_mode: 'contem', keywords: ['garantia'], steps: [{ type: 'text', text: 'Tem garantia sim.' }] };
  let novoId;
  await t('cria, edita e apaga fluxo', async () => {
    const c = await chamar('POST', '/api/flows', { corpo: base, headers: H }); assert.strictEqual(c.status, 200); novoId = c.json.id;
    assert.strictEqual(engine.acharFluxo('qual a garantia?').id, novoId);
    const e = await chamar('PUT', '/api/flows/' + novoId, { corpo: { ...base, keywords: ['troca'] }, headers: H }); assert.strictEqual(e.status, 200);
    assert.strictEqual(engine.acharFluxo('qual a garantia?'), null);
    assert.strictEqual((await chamar('DELETE', '/api/flows/' + novoId, { headers: H })).status, 200);
  });
  const invalidos = {
    'sem palavra-chave': { ...base, keywords: [] },
    'botão com título de 21 letras': { ...base, steps: [{ type: 'button', text: 'x', buttons: [{ title: 'A'.repeat(21), url: 'https://a.com' }] }] },
    'botão com link http (sem s)': { ...base, steps: [{ type: 'button', text: 'x', buttons: [{ title: 'Ok', url: 'http://a.com' }] }] },
    'mais de 8 mensagens': { ...base, steps: Array(9).fill({ type: 'text', text: 'a' }) },
    'resposta rápida sem destino': { ...base, steps: [{ type: 'quick', text: 'x', replies: [{ title: 'Ok', flow_id: 0 }] }] },
    'ação inválida': { ...base, action: 'apagar_tudo' },
  };
  for (const [nome, corpoRuim] of Object.entries(invalidos)) await t(`recusa fluxo ${nome}`, async () => assert.strictEqual((await chamar('POST', '/api/flows', { corpo: corpoRuim, headers: H })).status, 400));
  await t('configurações: salva e recusa valor/chave inválidos', async () => {
    assert.strictEqual((await chamar('PUT', '/api/settings', { corpo: { telefone: '75 99999-0000' }, headers: H })).status, 200);
    assert.strictEqual((await chamar('PUT', '/api/settings', { corpo: { max_replies_hour: '0' }, headers: H })).status, 400);
    assert.strictEqual((await chamar('PUT', '/api/settings', { corpo: { qualquer: 'x' }, headers: H })).status, 400);
  });
  await t('simulador responde sem enviar ao Instagram', async () => {
    const r = await chamar('POST', '/api/simular', { corpo: { texto: 'quanto custa a nextap?' }, headers: H });
    assert.strictEqual(r.json.resultado.acao, 'respondeu'); assert.ok(r.json.respostas.length >= 1);
    const c = await chamar('POST', '/api/simular', { corpo: { texto: 'quero', comentario: true }, headers: H });
    assert.strictEqual(c.json.respostas.length, 1);
  });
  await t('simulador não aparece na lista de conversas', async () => {
    const l = (await chamar('GET', '/api/contatos', { headers: H })).json; assert.ok(!l.some(x => x.channel === 'sim'));
  });
  await t('responder à mão é recusado depois de 24h', async () => {
    const c = db.prepare("SELECT id FROM contacts WHERE channel = 'instagram' LIMIT 1").get();
    db.prepare('UPDATE contacts SET last_inbound_at = ? WHERE id = ?').run(Date.now() - 25 * 3600e3, c.id);
    assert.strictEqual((await chamar('POST', `/api/contatos/${c.id}/responder`, { corpo: { texto: 'oi' }, headers: H })).status, 409);
  });
  await t('API: validações novas (vídeo, follow-up, etiquetas) e instalação do funil', async () => {
    const post = corpo => chamar('POST', '/api/flows', { corpo, headers: H });
    assert.strictEqual((await post({ ...base, steps: [{ type: 'video', url: 'http://x.com/a.mp4' }] })).status, 400);
    assert.strictEqual((await post({ ...base, kind: 'followup', delay_hours: 30 })).status, 400);
    assert.strictEqual((await post({ ...base, kind: 'followup', delay_hours: 3, audience: 'qualquer' })).status, 400);
    const fu = await post({ ...base, kind: 'followup', delay_hours: 3, audience: 'negocio' });
    assert.strictEqual(fu.status, 200); assert.strictEqual(fu.json.audience, 'negocio');
    await chamar('DELETE', '/api/flows/' + fu.json.id, { headers: H });
    assert.strictEqual((await post({ ...base, kind: 'evento', event: 'qualquer' })).status, 400);
    assert.strictEqual((await post({ ...base, human_priority: 7 })).status, 400);
    const ok1 = await post({ ...base, keywords: ['xyzvideo'], steps: [{ type: 'video', url: '{{video_demo}}' }, { type: 'text', text: 'ok' }], tags: ['teste'], human_priority: 2 });
    assert.strictEqual(ok1.status, 200); assert.deepStrictEqual(ok1.json.tags, ['TESTE']); assert.strictEqual(ok1.json.human_priority, 2);
    await chamar('DELETE', '/api/flows/' + ok1.json.id, { headers: H });
    assert.strictEqual((await chamar('POST', '/api/flows/instalar-v2', { corpo: {}, headers: H })).status, 409);
  });
  await t('API: etiquetas, prioridade na lista e funil no status', async () => {
    const lista = (await chamar('GET', '/api/contatos', { headers: H })).json; const c = lista.find(x => x.username === 'fulano');
    const r = await chamar('POST', `/api/contatos/${c.id}/tags`, { corpo: { tag: 'venda' }, headers: H }); assert.ok(r.json.tags.includes('VENDA'));
    assert.ok(!(await chamar('POST', `/api/contatos/${c.id}/tags`, { corpo: { tag: 'venda', remover: true }, headers: H })).json.tags.includes('VENDA'));
    const alta = (await chamar('GET', '/api/contatos?precisa=1', { headers: H })).json; assert.ok(alta.length && alta[0].human_priority >= alta[alta.length - 1].human_priority);
    assert.ok((await chamar('GET', '/api/contatos?tag=REVENDEDOR', { headers: H })).json.every(x => x.tags.includes('REVENDEDOR')));
    const st = (await chamar('GET', '/api/status', { headers: H })).json; assert.ok(st.funil['REVENDEDOR'] >= 1); assert.ok(st.prioridade_alta >= 1); assert.ok(st.cliques >= 1);
    const f1 = st.followups.find(f => f.name === 'Follow-up 1: conseguiu calcular?');
    assert.ok(f1.enviados >= 3); assert.ok(f1.responderam >= 2 && f1.responderam <= f1.enviados); assert.strictEqual(f1.audience, 'checkout');
    assert.ok(st.followups.some(f => f.audience === 'negocio' && f.enviados >= 1));
  });
  await t('configurações novas: endereço público e vídeo só em https', async () => {
    assert.strictEqual((await chamar('PUT', '/api/settings', { corpo: { video_demo_url: 'http://x.com/a.mp4' }, headers: H })).status, 400);
    assert.strictEqual((await chamar('PUT', '/api/settings', { corpo: { video_demo_url: '' , public_url: 'https://bot.exemplo.com' }, headers: H })).status, 200);
  });
  await t('GET /go/<token> redireciona (e token desconhecido cai no site)', async () => {
    const tok = db.prepare('SELECT token FROM links LIMIT 1').get().token;
    const r = await new Promise(res => http.get({ port: porta, path: '/go/' + tok }, x => { x.resume(); res(x); }));
    assert.strictEqual(r.statusCode, 302); assert.ok(r.headers.location.includes('utm_source=instagram'));
    const r2 = await new Promise(res => http.get({ port: porta, path: '/go/naoexiste' }, x => { x.resume(); res(x); })); assert.strictEqual(r2.statusCode, 302);
  });
  await t('painel (HTML) é servido', async () => { const r = await chamar('GET', '/'); assert.strictEqual(r.status, 200); assert.ok(r.texto.includes('Entrar no painel')); });
  await t('identidade visual: /brand e /logo públicos; salvar exige login, valida cor e logo', async () => {
    const b = await chamar('GET', '/brand'); assert.strictEqual(b.status, 200); assert.strictEqual(b.json.nome, 'NexTap');
    const l = await chamar('GET', '/logo'); assert.strictEqual(l.status, 200); assert.ok(l.texto.includes('<svg'));
    assert.strictEqual((await chamar('PUT', '/api/marca', { corpo: { nome: 'X', frase: '', cor: '#112233' } })).status, 401);
    assert.strictEqual((await chamar('PUT', '/api/marca', { corpo: { nome: 'X', frase: '', cor: 'verde' }, headers: H })).status, 400);
    assert.strictEqual((await chamar('PUT', '/api/marca', { corpo: { nome: 'X', frase: '', cor: '#112233', logo: 'data:image/svg+xml;base64,AAAA' }, headers: H })).status, 400);
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    assert.strictEqual((await chamar('PUT', '/api/marca', { corpo: { nome: 'ACS NexTap', frase: 'Oi', cor: '#112233', logo: png }, headers: H })).status, 200);
    assert.strictEqual((await chamar('GET', '/brand')).json.nome, 'ACS NexTap');
    assert.ok(!('logo_data' in (await chamar('GET', '/api/settings', { headers: H })).json));
    await chamar('PUT', '/api/marca', { corpo: { nome: 'NexTap', frase: '', cor: '#15803d', logo: null }, headers: H });
  });
  await t('diagnóstico do Instagram: sem token mostra o que falta; webhook recusado aparece nos eventos', async () => {
    await chamar('POST', '/webhook/instagram', { corpo: { object: 'instagram' } });
    const d = (await chamar('GET', '/api/instagram/diagnostico', { headers: H })).json;
    assert.strictEqual(d.config.token, false); assert.strictEqual(d.conta, null); assert.ok(d.eventos.some(e => e.resultado === 'recusado'));
    assert.strictEqual((await chamar('GET', '/api/instagram/diagnostico')).status, 401);
  });
  await t('link de Reel/post vira texto com o link (sem utm), e mídia recusada também', async () => {
    setSetting('video_demo_url', 'https://www.instagram.com/reel/DelyG-3OPAO/?utm_source=ig_web_copy_link&igsh=abc');
    const s = rec(); await engine.processarMensagem(msg('1–10', { extId: 'v1', payload: respRapida(pQtd, '1–10') }), s);
    const tx = s.env.map(x => x.p); assert.ok(!tx.some(p => p.type === 'video'));
    const lk = tx.find(p => /instagram\.com\/reel\/DelyG-3OPAO\/$/.test(p.text || '')); assert.ok(lk, 'link do reel limpo não encontrado: ' + JSON.stringify(tx.map(p => p.text)));
    setSetting('video_demo_url', '');
  });
  await t('upload de vídeo pelo painel: aceita MP4, recusa outros, serve em /media e configura o link', async () => {
    const post = (corpo, auth = true) => new Promise(res => { const r = http.request({ port: porta, method: 'POST', path: '/api/midia', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': corpo.length, ...(auth ? H : {}) } }, x => { let d = ''; x.on('data', c => d += c); x.on('end', () => res({ status: x.statusCode, json: JSON.parse(d || '{}') })); }); r.end(corpo); });
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(64)]);
    assert.strictEqual((await post(mp4, false)).status, 401);
    assert.strictEqual((await post(Buffer.from('isto nao e video'))).status, 400);
    const ok1 = await post(mp4); assert.strictEqual(ok1.status, 200); assert.ok(/\/media\/video-\d+\.mp4$/.test(ok1.json.url));
    assert.strictEqual(require('./db.js').getSetting('video_demo_url'), ok1.json.url);
    const g = await new Promise(res => http.get({ port: porta, path: '/media/' + ok1.json.url.split('/media/')[1] }, x => { x.resume(); res(x); })); assert.strictEqual(g.statusCode, 200);
    setSetting('video_demo_url', '');
  });
  await t('cabeçalhos de segurança', async () => {
    const h = await new Promise(res => http.get({ port: porta, path: '/health' }, r => { r.resume(); res(r.headers); }));
    assert.strictEqual(h['x-content-type-options'], 'nosniff'); assert.ok(!h['x-powered-by']);
  });

  await t('busca nome e @ reais do lead no Instagram (e não quebra se falhar)', async () => {
    const enviados = [];
    const sender = { send: async (c, p) => { enviados.push(p); return {}; }, perfil: async id => ({ name: 'Maria Souza', username: 'maria.souza' }) };
    await engine.processarMensagem({ canal: 'instagram', extId: 'nome-1', texto: 'oi preço', mid: 'mid-nome-1' }, sender);
    const c = db.prepare("SELECT name, username FROM contacts WHERE ext_id = 'nome-1'").get();
    assert.strictEqual(c.name, 'Maria Souza'); assert.strictEqual(c.username, 'maria.souza');
    const ruim = { send: async () => ({}), perfil: async () => { throw new Error('Meta recusou'); } };
    const r = await engine.processarMensagem({ canal: 'instagram', extId: 'nome-2', texto: 'oi preço', mid: 'mid-nome-2' }, ruim);
    assert.ok(r.acao); assert.strictEqual(db.prepare("SELECT name FROM contacts WHERE ext_id = 'nome-2'").get().name, null);
  });

  await t('funil direto (v3): entrada → revender → 11–49 em no máximo 2 mensagens com botão de compra', async () => {
    assert.strictEqual(require('./seed.js').instalarV3(), true); assert.strictEqual(require('./seed.js').instalarV3(), false);
    const e = rec(); await engine.processarMensagem(msg('preço', { extId: 'v3a' }), e);
    assert.strictEqual(e.env.length, 1); assert.deepStrictEqual(e.env[0].p.replies.map(x => x.title), ['💰 REVENDER', '🏪 MEU NEGÓCIO']);
    const r = rec(); await engine.processarMensagem(msg('x', { extId: 'v3a', payload: respRapida(e.env[0].p, '💰 REVENDER') }), r);
    assert.strictEqual(r.env.length, 1); assert.deepStrictEqual(r.env[0].p.replies.map(x => x.title), ['1–10', '11–49', '50–299', '300+']);
    const q = rec(); await engine.processarMensagem(msg('x', { extId: 'v3a', payload: respRapida(r.env[0].p, '11–49') }), q);
    assert.ok(q.env.length <= 2, 'mensagens: ' + q.env.length); assert.strictEqual(q.env[q.env.length - 1].p.buttons[0].title, 'CALCULAR E COMPRAR');
    assert.ok(tagsC('v3a').includes('QTD 11-49'));
  });
  await t('funil direto (v3): 50+ vai direto ao comercial (1 mensagem) e quantidade digitada funciona', async () => {
    const e = rec(); await engine.processarMensagem(msg('revender', { extId: 'v3b' }), e);
    const g = rec(); await engine.processarMensagem(msg('120', { extId: 'v3b' }), g);
    assert.strictEqual(g.env.length, 1); assert.deepStrictEqual(g.env[0].p.replies.map(x => x.title), ['FALAR COM COMERCIAL', 'VER VALORES']);
    assert.strictEqual(contatoDe('v3b').human_priority, 2);
  });
  await t('funil direto (v3): MEU NEGÓCIO em 1 mensagem com link para o site', async () => {
    const e = rec(); await engine.processarMensagem(msg('quero', { extId: 'v3c' }), e);
    const n = rec(); await engine.processarMensagem(msg('x', { extId: 'v3c', payload: respRapida(e.env[0].p, '🏪 MEU NEGÓCIO') }), n);
    assert.strictEqual(n.env.length, 1); assert.strictEqual(n.env[0].p.buttons[0].title, 'VER MODELOS E COMPRAR');
  });

  console.log('Prospecção');
  const gfake = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
    const j = JSON.parse(b || '{}'); res.setHeader('content-type', 'application/json');
    if (req.headers['x-goog-api-key'] === 'ruim') { res.statusCode = 403; return res.end(JSON.stringify({ error: { message: 'API não ativada' } })); }
    const lugar = (i, n, r, tel, st) => ({ id: 'p' + i, displayName: { text: n }, formattedAddress: `Rua A, ${i} - Centro, Feira de Santana - BA, 44000-000, Brasil`, nationalPhoneNumber: tel, rating: r, userRatingCount: n.length * 0 + i * 9, businessStatus: st || 'OPERATIONAL', location: { latitude: -12.2, longitude: -38.9 } });
    res.end(JSON.stringify(j.pageToken ? { places: [lugar(4, 'Pág2', 4.8, '75 90000-0004')] } : { places: [lugar(1, 'Loja Um', 3.8, '75 90000-0001'), lugar(2, 'Loja Fechada', 4, '75 90000-0002', 'CLOSED_PERMANENTLY'), lugar(3, 'Loja Sem Fone', 4.9, '')], nextPageToken: 'x' }));
  }); });
  await new Promise(r => gfake.listen(0, r));
  process.env.GOOGLE_PLACES_BASE = 'http://localhost:' + gfake.address().port;
  await t('prospecção exige login', async () => assert.strictEqual((await chamar('GET', '/api/prospeccao')).status, 401));
  await t('busca sem chave do Google explica o que falta', async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    const r = await chamar('POST', '/api/prospeccao/buscar', { corpo: { fonte: 'google', segmento: 'barbearia', local: 'Centro' }, headers: H });
    assert.strictEqual(r.status, 400); assert.ok(/GOOGLE_PLACES_API_KEY/.test(r.json.error));
  });
  await t('busca: exige segmento e local; recusa do Google vira erro claro', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'boa';
    assert.strictEqual((await chamar('POST', '/api/prospeccao/buscar', { corpo: { fonte: 'google', local: 'Centro' }, headers: H })).status, 400);
    assert.strictEqual((await chamar('POST', '/api/prospeccao/buscar', { corpo: { fonte: 'google', segmento: 'x' }, headers: H })).status, 400);
    process.env.GOOGLE_PLACES_API_KEY = 'ruim';
    const r = await chamar('POST', '/api/prospeccao/buscar', { corpo: { fonte: 'google', segmento: 'barbearia', local: 'Centro' }, headers: H });
    assert.strictEqual(r.status, 502); assert.ok(/API não ativada/.test(r.json.error)); process.env.GOOGLE_PLACES_API_KEY = 'boa';
  });
  let achados;
  await t('busca: junta páginas, tira empresa fechada e ordena por oportunidade', async () => {
    const r = await chamar('POST', '/api/prospeccao/buscar', { corpo: { fonte: 'google', segmento: 'barbearia', local: 'Centro, Feira de Santana', paginas: 2 }, headers: H });
    assert.strictEqual(r.status, 200); achados = r.json.resultados;
    assert.deepStrictEqual(achados.map(x => x.nome), ['Loja Um', 'Pág2', 'Loja Sem Fone']);
    assert.strictEqual(achados[0].bairro, 'Centro'); assert.strictEqual(achados[0].nivel, 'alta'); assert.ok(achados[0].score > achados[2].score);
  });
  await t('salvar não duplica a mesma empresa do Google', async () => {
    const a = await chamar('POST', '/api/prospeccao/salvar', { corpo: { lugares: achados }, headers: H }); assert.strictEqual(a.json.novos, 3);
    const b = await chamar('POST', '/api/prospeccao/salvar', { corpo: { lugares: achados }, headers: H }); assert.strictEqual(b.json.novos, 0); assert.strictEqual(b.json.repetidos, 3);
    const c = await chamar('POST', '/api/prospeccao/buscar', { corpo: { fonte: 'google', segmento: 'barbearia', local: 'Centro' }, headers: H }); assert.ok(c.json.resultados.every(x => x.ja_salvo));
  });
  await t('registrar contato muda status, agenda retorno e guarda histórico', async () => {
    const lista = (await chamar('GET', '/api/prospeccao', { headers: H })).json; const id = lista.find(x => x.nome === 'Loja Um').id;
    assert.strictEqual(lista.find(x => x.id === id).status, 'novo');
    const r = await chamar('POST', `/api/prospeccao/${id}/contato`, { corpo: { tipo: 'whatsapp', texto: 'Abordagem', prox_contato: '2030-01-02' }, headers: H });
    assert.strictEqual(r.json.status, 'abordado'); assert.strictEqual(r.json.prox_contato, '2030-01-02');
    assert.strictEqual((await chamar('POST', `/api/prospeccao/${id}/contato`, { corpo: { tipo: 'nota', texto: '' }, headers: H })).status, 400);
    const d = (await chamar('GET', `/api/prospeccao/${id}`, { headers: H })).json; assert.strictEqual(d.historico.length, 1); assert.strictEqual(d.contatos, 1);
    const p = await chamar('POST', `/api/prospeccao/${id}/contato`, { corpo: { tipo: 'ligacao', texto: 'Sem interesse', status: 'perdido', motivo_perda: 'Já tem solução' }, headers: H });
    assert.strictEqual(p.json.status, 'perdido'); assert.strictEqual(p.json.motivo_perda, 'Já tem solução');
  });
  await t('cadastro manual, importação de lista (sem repetir) e exclusão', async () => {
    assert.strictEqual((await chamar('POST', '/api/prospeccao', { corpo: { nome: '' }, headers: H })).status, 400);
    const m = await chamar('POST', '/api/prospeccao', { corpo: { nome: 'Salão Bela', telefone: '75 91111-2222', segmento: 'Salão' }, headers: H }); assert.strictEqual(m.json.origem, 'manual');
    const i = await chamar('POST', '/api/prospeccao/importar', { corpo: { texto: 'Salão Bela; 75 91111-2222\nPet do Zé; 75 93333-4444; Pet shop; Centro', segmento: 'Loja' }, headers: H });
    assert.strictEqual(i.json.novos, 1); assert.strictEqual(i.json.repetidos, 1);
    assert.strictEqual((await chamar('DELETE', `/api/prospeccao/${m.json.id}`, { headers: H })).json.ok, true);
    assert.strictEqual((await chamar('GET', `/api/prospeccao/${m.json.id}`, { headers: H })).status, 404);
  });
  await t('mapa livre (OSM): geocodifica, busca por etiqueta, ordena e salva sem nota', async () => {
    const osmf = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/search')) return res.end(JSON.stringify(/Nada/.test(decodeURIComponent(req.url)) ? [] : [{ lat: '-12.2', lon: '-38.9', display_name: 'Centro, Feira de Santana' }]));
      global.__q = decodeURIComponent(b);
      res.end(JSON.stringify({ elements: [
        { type: 'node', id: 1, lat: -12.201, lon: -38.901, tags: { name: 'Barbearia do Zé', shop: 'hairdresser', phone: '+55 75 99999-0001', 'addr:street': 'Rua A', 'addr:housenumber': '10' } },
        { type: 'way', id: 2, center: { lat: -12.25, lon: -38.95 }, tags: { name: 'Barber Top', shop: 'hairdresser', website: 'https://x.com', 'contact:instagram': 'https://instagram.com/bartop' } },
        { type: 'node', id: 3, lat: -12.2, lon: -38.9, tags: { shop: 'hairdresser' } },
        { type: 'node', id: 1, lat: -12.201, lon: -38.901, tags: { name: 'Barbearia do Zé', shop: 'hairdresser' } }] }));
    }); });
    await new Promise(r => osmf.listen(0, r));
    process.env.NOMINATIM_BASE = process.env.OVERPASS_URLS = ''; process.env.NOMINATIM_BASE = 'http://localhost:' + osmf.address().port; process.env.OVERPASS_URLS = 'http://localhost:' + osmf.address().port + '/api';
    const r = await chamar('POST', '/api/prospeccao/buscar', { corpo: { segmento: 'barbearia', local: 'Centro, Feira de Santana', raio: 3000 }, headers: H });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json)); assert.strictEqual(r.json.fonte, 'osm');
    assert.deepStrictEqual(r.json.resultados.map(x => x.nome), ['Barbearia do Zé', 'Barber Top']);
    const z = r.json.resultados[0]; assert.strictEqual(z.nota, null); assert.strictEqual(z.place_id, 'osm:node/1'); assert.strictEqual(z.nivel, 'alta'); assert.ok(z.maps_url.includes('google.com/maps'));
    assert.strictEqual(r.json.resultados[1].instagram, 'bartop'); assert.ok(/around:3000,-12.2,-38.9/.test(global.__q) && /"shop"="hairdresser"/.test(global.__q));
    assert.strictEqual((await chamar('POST', '/api/prospeccao/buscar', { corpo: { segmento: 'barbearia', local: 'Nada aqui' }, headers: H })).status, 400);
    const livre = await chamar('POST', '/api/prospeccao/buscar', { corpo: { segmento: 'xyzabc', local: 'Centro' }, headers: H }); assert.strictEqual(livre.status, 200); assert.strictEqual(livre.json.por_nome, true);   // fora da lista: procura pelo nome
    assert.strictEqual((await chamar('POST', '/api/prospeccao/buscar', { corpo: { segmento: 'lanches', local: 'Centro' }, headers: H })).json.nicho, 'Lanchonete / hamburgueria');
    assert.strictEqual((await chamar('POST', '/api/prospeccao/buscar', { corpo: { segmento: ' ', local: 'Centro' }, headers: H })).status, 400);
    const s1 = await chamar('POST', '/api/prospeccao/salvar', { corpo: { lugares: r.json.resultados, segmento: 'Barbearia' }, headers: H }); assert.strictEqual(s1.json.novos, 2);
    const reg = (await chamar('GET', '/api/prospeccao', { headers: H })).json.find(x => x.nome === 'Barber Top'); assert.strictEqual(reg.origem, 'osm'); assert.strictEqual(reg.instagram, 'bartop');
    const up = await chamar('PUT', `/api/prospeccao/${reg.id}`, { corpo: { ...reg, nota: '4,3', avaliacoes: '27' }, headers: H }); assert.strictEqual(up.json.nota, 4.3); assert.strictEqual(up.json.avaliacoes, 27);
    const bad = await chamar('PUT', `/api/prospeccao/${reg.id}`, { corpo: { ...reg, nota: '9', avaliacoes: '' }, headers: H }); assert.strictEqual(bad.json.nota, null);
    osmf.close();
  });
  await t('varredura da cidade: vários nichos, cidade inteira com fallback para raio, sem repetir empresa', async () => {
    const consultas = [];
    const f = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
      res.setHeader('content-type', 'application/json'); if (req.url.startsWith('/search')) return res.end(JSON.stringify([{ lat: '-12.26', lon: '-38.96', display_name: 'Feira de Santana, Bahia' }]));
      const q = decodeURIComponent(b); consultas.push(q); const el = (id, nome, tags) => ({ type: 'node', id, lat: -12.26, lon: -38.96, tags: { name: nome, ...tags } });
      if (/"tattoo"/.test(q)) return res.end(JSON.stringify({ elements: [el(11, 'Dark Ink', { shop: 'tattoo', phone: '75 98888-0001' })] }));
      if (/"optician"/.test(q)) return res.end(JSON.stringify({ elements: /area\.a/.test(q) ? [] : [el(12, 'Ótica Visão', { shop: 'optician', website: 'https://o.com' })] }));
      if (/"clothes"="men"/.test(q)) return res.end(JSON.stringify({ elements: [el(11, 'Dark Ink', { shop: 'tattoo' }), el(13, 'Moda Homem', { shop: 'clothes', clothes: 'men', phone: '75 97777-0001' })] }));
      res.end(JSON.stringify({ elements: [] })); }); });
    await new Promise(r => f.listen(0, r)); process.env.NOMINATIM_BASE = 'http://localhost:' + f.address().port; process.env.OVERPASS_URLS = 'http://localhost:' + f.address().port + '/api'; process.env.VARRER_PAUSA_MS = '0';
    assert.strictEqual((await chamar('POST', '/api/prospeccao/varrer', { corpo: { nichos: [] }, headers: H })).status, 400);
    const r = await chamar('POST', '/api/prospeccao/varrer', { corpo: { nichos: ['tatuagem', 'otica', 'roupa_masc', 'padaria'], cidade: 'Feira de Santana' }, headers: H });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.deepStrictEqual(r.json.resumo.map(x => [x.id, x.total]), [['tatuagem', 1], ['otica', 1], ['roupa_masc', 1], ['padaria', 0]], 'Dark Ink não conta duas vezes');
    assert.strictEqual(r.json.total, 3); assert.ok(r.json.resultados.find(x => x.nome === 'Dark Ink').segmento === 'Estúdio de tatuagem');
    assert.ok(consultas.some(q => /area\["name"="Feira de Santana"\]\["boundary"="administrative"\]/.test(q) && /"shop"="tattoo"\]\(area\.a\)/.test(q)), 'consulta por área da cidade');
    assert.ok(consultas.some(q => /"optician"\]\(around:/.test(q)), 'sem área → cai no raio');
    assert.ok(consultas.some(q => /"clothes"="men"/.test(q) && /"name"~"masc\|homem/.test(q)), 'roupa masculina por etiqueta e por nome');
    const nich = (await chamar('GET', '/api/prospeccao/nichos', { headers: H })).json; assert.ok(['tatuagem', 'otica', 'padaria', 'roupa_masc', 'roupa_fem'].every(i => nich.some(n => n.id === i)) && nich.every(n => n.dica));
    const sv = await chamar('POST', '/api/prospeccao/salvar', { corpo: { lugares: r.json.resultados }, headers: H }); assert.strictEqual(sv.json.novos, 3);
    assert.ok((await chamar('GET', '/api/prospeccao', { headers: H })).json.some(x => x.nome === 'Ótica Visão' && x.segmento === 'Ótica'));
    f.close();
  });
  gfake.close();


  console.log('WhatsApp (Evolution API simulada)');
  // Evolution falsa: guarda o que recebeu e responde como a API real
  const evo = { chamadas: [], estado: 'open', falhar: false };
  const evoSrv = http.createServer((rq, rs) => {
    let b = ''; rq.on('data', c => b += c); rq.on('end', () => {
      const corpo = b ? JSON.parse(b) : null; evo.chamadas.push({ metodo: rq.method, url: rq.url, apikey: rq.headers.apikey, corpo });
      const ok = j => { rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(j)); };
      if (evo.falhar) { rs.writeHead(500); return rs.end('{"message":"caiu"}'); }
      if (rq.url.startsWith('/instance/connectionState/')) return ok({ instance: { instanceName: 'nextap', state: evo.estado } });
      if (rq.url.startsWith('/instance/fetchInstances')) return ok([{ name: 'nextap', ownerJid: '5575999990000@s.whatsapp.net' }]);
      if (rq.url === '/instance/create') { rs.writeHead(403, { 'Content-Type': 'application/json' }); return rs.end('{"response":{"message":["This name \"nextap\" is already in use."]}}'); }
      if (rq.url.startsWith('/instance/connect/')) return ok({ base64: 'data:image/png;base64,QUJD', pairingCode: 'ABCD1234' });
      if (rq.url.startsWith('/webhook/set/')) return ok({ webhook: corpo.webhook });
      if (rq.url.startsWith('/group/fetchAllGroups/')) return ok([{ id: '120363000000000001@g.us', subject: 'Vendas NexTap', size: 42 }]);
      if (rq.url.startsWith('/message/send')) return ok({ key: { id: 'ID' + evo.chamadas.length, remoteJid: corpo.number } });
      rs.writeHead(404); rs.end('{}');
    });
  });
  await new Promise(r => evoSrv.listen(0, r));
  const wa = require('./whatsapp.js');
  const enviosEvo = () => evo.chamadas.filter(c => c.url.startsWith('/message/send'));
  await t('sem EVOLUTION_URL: status diz que não está configurado e envio explica o que falta', async () => {
    const st = (await chamar('GET', '/api/whatsapp/status', { headers: H })).json; assert.strictEqual(st.configurado, false);
    const c = (await chamar('POST', '/api/whatsapp/conversas', { corpo: { numero: '75 98888-1111' }, headers: H })).json;
    const r = await chamar('POST', `/api/whatsapp/conversas/${c.id}/enviar`, { corpo: { texto: 'oi' }, headers: H });
    assert.strictEqual(r.status, 502); assert.ok(r.json.error.includes('EVOLUTION_URL'));
  });
  process.env.EVOLUTION_URL = `http://127.0.0.1:${evoSrv.address().port}`; process.env.EVOLUTION_API_KEY = 'chave-evo';
  await t('números: DDD vira +55, 9º dígito não atrapalha a ligação com a empresa', () => {
    assert.strictEqual(wa.normalizarNumero('(75) 98820-9055'), '5575988209055');
    assert.strictEqual(wa.normalizarNumero('+351 912 345 678'), '351912345678');
    assert.strictEqual(wa.normalizarNumero('123'), '');
    assert.strictEqual(wa.chaveTel('5575988209055'), wa.chaveTel('557588209055'));
  });
  await t('status conectado mostra o número; conectar devolve QR e configura o webhook com token', async () => {
    const st = (await chamar('GET', '/api/whatsapp/status', { headers: H })).json;
    assert.strictEqual(st.estado, 'open'); assert.strictEqual(st.numero, '5575999990000');
    const q = (await chamar('POST', '/api/whatsapp/conectar', { headers: H })).json;
    assert.ok(q.qr.startsWith('data:image/png;base64,')); assert.strictEqual(q.codigo, 'ABCD1234'); assert.strictEqual(q.webhook, 'ok');
    const wh = evo.chamadas.find(c => c.url.startsWith('/webhook/set/'));
    assert.ok(wh.corpo.webhook.url.endsWith('/webhook/whatsapp/' + wa.tokenWebhook())); assert.strictEqual(wh.apikey, 'chave-evo');
    assert.strictEqual((await chamar('GET', '/api/whatsapp/status')).status, 401);
  });
  let pid;
  await t('abrir conversa por empresa da Prospecção liga o número à empresa; enviar registra no histórico e marca "abordado"', async () => {
    pid = (await chamar('POST', '/api/prospeccao', { corpo: { nome: 'Barbearia do Zé', telefone: '(75) 98820-9055', segmento: 'Barbearia' }, headers: H })).json.id;
    const c = (await chamar('POST', '/api/whatsapp/conversas', { corpo: { prospect_id: pid }, headers: H })).json;
    assert.strictEqual(c.prospect_id, pid); assert.strictEqual(c.jid, '5575988209055@s.whatsapp.net'); assert.strictEqual(c.empresa, 'Barbearia do Zé');
    const r = await chamar('POST', `/api/whatsapp/conversas/${c.id}/enviar`, { corpo: { texto: 'Oi! Vi a Barbearia do Zé no Google…' }, headers: H });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const env = enviosEvo().pop(); assert.strictEqual(env.url, '/message/sendText/nextap'); assert.strictEqual(env.corpo.number, '5575988209055');
    const p = (await chamar('GET', '/api/prospeccao/' + pid, { headers: H })).json;
    assert.strictEqual(p.status, 'abordado'); assert.ok(p.historico.some(h => h.tipo === 'whatsapp' && h.texto.includes('Abordagem')));
  });
  await t('webhook: resposta da empresa entra na conversa (mesmo sem o 9), conta como não lida e vai para o histórico', async () => {
    const corpo = { event: 'messages.upsert', instance: 'nextap', data: { key: { remoteJid: '557588209055@s.whatsapp.net', fromMe: false, id: 'IN1' }, pushName: 'Zé', message: { conversation: 'Pode mandar!' }, messageTimestamp: Math.floor(Date.now() / 1000) } };
    assert.strictEqual((await chamar('POST', '/webhook/whatsapp/token-errado', { corpo })).status, 401);
    assert.strictEqual((await chamar('POST', '/webhook/whatsapp/' + wa.tokenWebhook(), { corpo })).status, 200);
    await chamar('POST', '/webhook/whatsapp/' + wa.tokenWebhook(), { corpo });   // repetido: não duplica
    await new Promise(r => setTimeout(r, 30));
    const l = (await chamar('GET', '/api/whatsapp/conversas', { headers: H })).json;
    const c = l.find(x => x.prospect_id === pid);
    assert.ok(c, 'conversa da empresa não encontrada: ' + JSON.stringify(l.map(x => x.jid)));
    assert.strictEqual(c.nao_lidas, 1); assert.strictEqual(c.ultimo_texto, 'Pode mandar!');
    const det = (await chamar('GET', '/api/whatsapp/conversas/' + c.id, { headers: H })).json;
    assert.deepStrictEqual(det.mensagens.map(m => m.direcao), ['out', 'in']);
    assert.strictEqual((await chamar('GET', '/api/whatsapp/conversas', { headers: H })).json.find(x => x.id === c.id).nao_lidas, 0);
    const p = (await chamar('GET', '/api/prospeccao/' + pid, { headers: H })).json; assert.ok(p.historico.some(h => h.texto.includes('Respondeu no WhatsApp: Pode mandar!')));
  });
  await t('webhook ignora grupos e status; mensagem enviada pelo celular aparece como "pelo celular"', async () => {
    const ev = data => chamar('POST', '/webhook/whatsapp/' + wa.tokenWebhook(), { corpo: { event: 'messages.upsert', data } });
    await ev({ key: { remoteJid: '120363000000000001@g.us', fromMe: false, id: 'G1' }, message: { conversation: 'msg no grupo' } });
    await ev({ key: { remoteJid: 'status@broadcast', fromMe: false, id: 'S1' }, message: { conversation: 'story' } });
    await ev({ key: { remoteJid: '5575977776666@s.whatsapp.net', fromMe: true, id: 'C1' }, message: { extendedTextMessage: { text: 'mandei do celular' } } });
    await new Promise(r => setTimeout(r, 30));
    const l = (await chamar('GET', '/api/whatsapp/conversas', { headers: H })).json;
    assert.ok(!l.some(c => c.jid.endsWith('@g.us')));
    const c = l.find(x => x.jid === '5575977776666@s.whatsapp.net'); assert.ok(c); assert.strictEqual(c.ultima_direcao, 'out');
  });
  await t('Bianca no WhatsApp: quem escreve escolhe varejo ou atacado; varejo R$ 80 / R$ 140, anota pedido e chama você; desligada ou com você na conversa, fica quieta', async () => {
    const ev = data => chamar('POST', '/webhook/whatsapp/' + wa.tokenWebhook(), { corpo: { event: 'messages.upsert', data } });
    const n0 = () => enviosEvo().length, espera = () => new Promise(r => setTimeout(r, 150)), gap = process.env.WA_GAP_MS; process.env.WA_GAP_MS = '0';
    const msg = (jid, id, texto, extra) => ev({ key: { remoteJid: jid + '@s.whatsapp.net', fromMe: false, id }, pushName: 'Ana Souza', message: { conversation: texto }, ...extra });
    const saiu = a => enviosEvo().slice(a).map(x => x.corpo.text || x.corpo.caption || '').join('\n---\n');
    try {
      setSetting('wa_robo', '0'); setSetting('ceo_whatsapp', ''); setSetting('video_demo_url', 'https://x.com/demo.mp4'); let a = n0();
      await msg('5575966660001', 'R0', 'qual o preço?'); await espera(); assert.strictEqual(n0(), a);           // desligada: não responde
      assert.deepStrictEqual((await chamar('PUT', '/api/whatsapp/robo', { corpo: { ligado: true }, headers: H })).json, { ligado: true });
      a = n0(); await msg('5575966660001', 'R1', 'qual o preço?'); await espera();
      let tx = saiu(a); assert.ok(tx.includes('Ana') && tx.includes('Bianca') && tx.includes('1️⃣ Para o meu estabelecimento') && tx.includes('2️⃣ Quero revender'), tx);
      assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE ext_id = '5575966660001'").get().n, 0);   // a Sofia (fluxos do Instagram) não entra
      a = n0(); await msg('5575966660001', 'R2', '1'); await espera(); tx = saiu(a);
      assert.ok(tx.includes('*Pix*') && !tx.includes('Redes sociais') && !tx.includes('R$') && /prefere uma placa do \*Google\* ou algum outro modelo\?$/.test(tx) && !tx.includes('http'), tx);
      const vid = enviosEvo().slice(a).find(x => x.corpo.mediatype === 'video'); assert.ok(vid && vid.corpo.media === 'https://x.com/demo.mp4' && vid.corpo.caption.includes('*Google*')); assert.strictEqual(enviosEvo().slice(a).length, 1);
      a = n0(); await msg('5575966660001', 'R3', 'quanto custa?'); await espera(); tx = saiu(a); assert.ok(tx.includes('*1 placa:* R$ 80') && tx.includes('de ~R$ 160~ por *R$ 140*') && tx.includes('economiza R$ 20') && tx.includes('qual modelo'), tx);
      a = n0(); await msg('5575966660001', 'R3a', 'a do google'); await espera(); tx = saiu(a);
      assert.ok(tx.includes('1 placa do *Google*') && tx.includes('do *Google* faz o cliente') && tx.includes('ganha desconto') && tx.includes('*endereço*') && !tx.includes('R$') && !tx.includes('*1* ou *2*'), tx);
      a = n0(); await msg('5575966660001', 'R3b', 'quero 2, a outra do instagram'); await espera(); tx = saiu(a);
      assert.ok(tx.includes('2 placas (*Google* + *Instagram*)') && tx.includes('do *Instagram* faz') && !tx.includes('do *Google* faz') && !tx.includes('R$') && tx.includes('dia e horário'), tx);
      a = n0(); await msg('5575966660001', 'R4', 'Barbearia da Ana, Rua X 10, Centro, amanhã 10h'); await espera(); tx = saiu(a); assert.ok(tx.includes('só paga na hora'), tx);
      assert.ok(db.prepare("SELECT COUNT(*) AS n FROM agentes_log WHERE titulo LIKE 'Cliente no WhatsApp:%' AND texto LIKE '%PEDIDO VAREJO: 2 placa(s) (Google, Instagram)%'").get().n === 1);
      assert.ok(db.prepare("SELECT COUNT(*) AS n FROM agentes_log WHERE agente = 'gerente' AND titulo LIKE 'Atendimento humano:%' AND texto LIKE '%Bianca%'").get().n >= 2);
      a = n0(); await msg('5575966660001', 'R5', 'obrigada'); await espera(); assert.strictEqual(n0(), a);   // agora é com você
      a = n0(); await msg('5575966660001', 'R6', '#teste'); await espera(); assert.ok(saiu(a).includes('1️⃣ Para o meu estabelecimento'));   // recomeça do zero no mesmo número
      assert.ok((await chamar('POST', '/api/whatsapp/bianca/reiniciar', { headers: H })).json.reiniciadas >= 1);
      // atacado
      a = n0(); await msg('5575966660002', 'A1', 'boa tarde, quero revender as placas'); await espera(); tx = saiu(a); assert.ok(tx.includes('revenda') && tx.includes('quantas placas'), tx);
      a = n0(); await msg('5575966660002', 'A2', '50 placas, sou de Salvador'); await espera(); tx = saiu(a); assert.ok(tx.includes('Já passei'), tx);
      // sumiu 3h no meio da conversa: um lembrete só (e só em horário bom)
      const B2 = require('./bianca-balcao.js'), cid = db.prepare("SELECT id FROM wa_contatos WHERE jid = '5575966660004@s.whatsapp.net'").get;
      await msg('5575966660004', 'L1', 'oi'); await espera(); a = n0(); await msg('5575966660004', 'L2', '1'); await espera();
      const idL = db.prepare("SELECT id FROM wa_contatos WHERE jid = '5575966660004@s.whatsapp.net'").get().id, t9 = Date.parse('2026-12-22T14:00:00-03:00');
      db.prepare('UPDATE bianca_balcao SET em = ? WHERE contato_id = ?').run(t9 - 2 * 3600e3, idL); a = n0(); assert.strictEqual(await B2.lembrar(t9), 0);
      db.prepare('UPDATE bianca_balcao SET em = ? WHERE contato_id = ?').run(t9 - 3.1 * 3600e3, idL); assert.strictEqual(await B2.lembrar(t9), 1);
      assert.ok(saiu(a).includes('Conseguiu ver o vídeo')); assert.strictEqual(await B2.lembrar(t9 + 3600e3), 0);
      db.prepare('UPDATE bianca_balcao SET em = ?, lembrado = 0 WHERE contato_id = ?').run(t9 - 4 * 3600e3, idL); assert.strictEqual(await B2.lembrar(Date.parse('2026-12-22T22:00:00-03:00')), 0);   // de noite não
      // você respondeu pelo celular: ela fica quieta
      await ev({ key: { remoteJid: '5575966660003@s.whatsapp.net', fromMe: true, id: 'C3' }, message: { conversation: 'Oi, aqui é o Luiz!' } }); await espera();
      a = n0(); await msg('5575966660003', 'C4', 'qual o preço?'); await espera(); assert.strictEqual(n0(), a);
      // preços editáveis
      setSetting('preco_varejo_1', '85'); setSetting('preco_varejo_2', '150'); assert.deepStrictEqual(require('./bianca-balcao.js').precos(), { um: '85', dois: '150', cada: '75', de: '170', economia: '20' });
    } finally { setSetting('wa_robo', '0'); setSetting('video_demo_url', ''); setSetting('preco_varejo_1', '80'); setSetting('preco_varejo_2', '140'); if (gap === undefined) delete process.env.WA_GAP_MS; else process.env.WA_GAP_MS = gap; }
  });
  await t('Bianca no balcão: decide sem enviar (menu, varejo, 3+ placas, pedir humano, parar)', () => {
    const B = require('./bianca-balcao.js'), d = (e, t) => B.decidir(e, t, 'Ana');
    assert.strictEqual(d(null, 'oi').etapa, 'menu'); assert.strictEqual(d({ etapa: 'menu', dados: {} }, '1️⃣').etapa, 'varejo'); assert.strictEqual(d({ etapa: 'menu', dados: {} }, '2️⃣').etapa, 'atacado'); assert.strictEqual(d(null, 'quero pra minha loja').etapa, 'varejo'); assert.strictEqual(d(null, 'trabalho com revenda').etapa, 'atacado');
    const m = d({ etapa: 'menu', dados: {}, tentativas: 0 }, 'hã?'); assert.strictEqual(m.etapa, 'menu'); assert.strictEqual(d({ etapa: 'menu', dados: {}, tentativas: 1 }, 'hã?').etapa, 'humano');
    const tres = d({ etapa: 'varejo', dados: {} }, 'quero 4'); assert.strictEqual(tres.etapa, 'humano'); assert.ok(tres.avisar.includes('4 placas'));
    assert.ok(tres.textos[0].includes('preço especial') && !/atacado/i.test(tres.textos[0]) && tres.avisar.includes('não é atacado'));
    assert.strictEqual(d({ etapa: 'varejo', dados: {} }, 'pix').etapa, 'dados'); assert.strictEqual(d({ etapa: 'varejo', dados: {}, tentativas: 0 }, 'hmm').etapa, 'varejo'); assert.strictEqual(d({ etapa: 'varejo', dados: {}, tentativas: 1 }, 'hmm').etapa, 'humano');
    assert.strictEqual(d({ etapa: 'qtd', dados: { modelos: ['Pix'] } }, 'uma').etapa, 'dados'); assert.ok(d({ etapa: 'qtd', dados: { modelos: ['Pix'] } }, '2 iguais').textos[0].includes('2 placas do *Pix*') && !d({ etapa: 'qtd', dados: { modelos: ['Pix'] } }, '2 iguais').textos.join().includes('R$'));
    assert.ok(!d({ etapa: 'varejo', dados: {} }, 'google e pix').textos.join().includes('R$') && d({ etapa: 'varejo', dados: {} }, 'google e pix').textos[0].includes('do *Pix* faz'));
    assert.strictEqual(d({ etapa: 'varejo', dados: {} }, '2 do whatsapp').etapa, 'dados'); assert.strictEqual(d({ etapa: 'varejo', dados: {} }, 'google e pix').etapa, 'dados');
    assert.ok(d({ etapa: 'qtd', dados: { modelos: ['Pix'] } }, 'qual o valor?').textos[0].includes('R$ 140'));
    assert.strictEqual(d({ etapa: 'varejo', dados: {} }, 'quais modelos tem?').textos[0].includes('*WhatsApp*'), true);
    assert.deepStrictEqual(B.modelosDe('pix e zap e redes sociais'), ['WhatsApp', 'Pix']);
    assert.strictEqual(d({ etapa: 'varejo', dados: {} }, 'tá caro').etapa, 'varejo'); assert.ok(d({ etapa: 'varejo', dados: {} }, 'tá caro').textos[0].includes('R$ 70'));
    assert.strictEqual(d({ etapa: 'varejo', dados: {} }, 'quero falar com o dono').etapa, 'humano');
    assert.strictEqual(d({ etapa: 'varejo', dados: {} }, 'pare de mandar').etapa, 'parado'); assert.strictEqual(d({ etapa: 'parado' }, 'oi').textos.length, 0);
    assert.strictEqual(d({ etapa: 'varejo', dados: {}, tentativas: 1 }, 'xyz abc').etapa, 'humano');
    assert.strictEqual(B.qtdDe('vou querer uma'), 1); assert.strictEqual(B.qtdDe('duas'), 2);
  });
  await t('limite diário de primeiras mensagens protege o número (conversas respondidas não contam)', async () => {
    setSetting('wa_max_novos_dia', '1');
    const a = (await chamar('POST', '/api/whatsapp/conversas', { corpo: { numero: '75 91111-0001' }, headers: H })).json;
    const r = await chamar('POST', `/api/whatsapp/conversas/${a.id}/enviar`, { corpo: { texto: 'oi' }, headers: H });
    assert.strictEqual(r.status, 429); assert.ok(r.json.error.includes('bloquear'));
    const z = (await chamar('GET', '/api/whatsapp/conversas', { headers: H })).json.find(x => x.prospect_id === pid);
    assert.strictEqual((await chamar('POST', `/api/whatsapp/conversas/${z.id}/enviar`, { corpo: { texto: 'segue o vídeo' }, headers: H })).status, 200);
    setSetting('wa_max_novos_dia', '30');
  });
  await t('grupos: lista os grupos do número conectado', async () => {
    const g = (await chamar('GET', '/api/whatsapp/grupos', { headers: H })).json;
    assert.deepStrictEqual(g, [{ jid: '120363000000000001@g.us', nome: 'Vendas NexTap', membros: 42 }]);
  });
  await t('próximo envio: único, semanal (dias marcados) e horário de Brasília', () => {
    const base = Date.parse('2026-11-13T12:00:00-03:00');   // sexta-feira, 12h
    assert.strictEqual(wa.proximoEnvio({ hora: '09:00', data: '2026-11-14', dias: '[]' }, base), Date.parse('2026-11-14T09:00:00-03:00'));
    assert.strictEqual(wa.proximoEnvio({ hora: '09:00', data: '2026-11-13', dias: '[]' }, base), null);
    assert.strictEqual(wa.proximoEnvio({ hora: '18:30', dias: '[5]' }, base), Date.parse('2026-11-13T18:30:00-03:00'));
    assert.strictEqual(wa.proximoEnvio({ hora: '09:00', dias: '[1,3]' }, base), Date.parse('2026-11-16T09:00:00-03:00'));
    assert.strictEqual(wa.proximoEnvio({ hora: '09:00', dias: '[5]' }, base), Date.parse('2026-11-20T09:00:00-03:00'));
  });
  await t('disparos: validação, envio no horário para o grupo, reagenda a semana e não repete', async () => {
    const post = corpo => chamar('POST', '/api/whatsapp/disparos', { corpo, headers: H });
    assert.strictEqual((await post({ alvo_jid: '120363000000000001@g.us', texto: '', hora: '09:00', dias: [1] })).status, 400);
    assert.strictEqual((await post({ alvo_jid: '120363000000000001@g.us', texto: 'x', hora: '9h', dias: [1] })).status, 400);
    assert.strictEqual((await post({ alvo_jid: '120363000000000001@g.us', texto: 'x', hora: '09:00', data: '2020-01-01' })).status, 400);
    const d = (await post({ nome: 'Bom dia', alvo_jid: '120363000000000001@g.us', alvo_nome: 'Vendas NexTap', texto: 'Bom dia, time! 🚀', hora: '08:00', dias: [0, 1, 2, 3, 4, 5, 6] })).json;
    assert.ok(d.proximo_em > Date.now()); assert.deepStrictEqual(d.dias, [0, 1, 2, 3, 4, 5, 6]);
    const antes = enviosEvo().length;
    assert.strictEqual((await wa.tick({ agoraMs: d.proximo_em - 1000 })).enviados, 0);
    assert.strictEqual((await wa.tick({ agoraMs: d.proximo_em + 1000 })).enviados, 1);
    const e = enviosEvo().pop(); assert.strictEqual(e.corpo.number, '120363000000000001@g.us'); assert.strictEqual(e.corpo.text, 'Bom dia, time! 🚀');
    assert.strictEqual((await wa.tick({ agoraMs: d.proximo_em + 2000 })).enviados, 0, 'repetiu');
    const depois = (await chamar('GET', '/api/whatsapp/disparos', { headers: H })).json.find(x => x.id === d.id);
    assert.strictEqual(depois.proximo_em, d.proximo_em + 86400e3); assert.strictEqual(depois.enviados, 1); assert.strictEqual(enviosEvo().length, antes + 1);
    assert.strictEqual((await chamar('GET', '/api/whatsapp/conversas', { headers: H })).json.some(c => c.jid.endsWith('@g.us')), false, 'grupo apareceu na caixa de entrada');
  });
  await t('disparo único com imagem: sai uma vez e some da agenda; erro da Evolution fica registrado', async () => {
    const amanha = new Date(Date.now() - 3 * 3600e3 + 86400e3).toISOString().slice(0, 10);
    const d = (await chamar('POST', '/api/whatsapp/disparos', { corpo: { alvo_jid: '75 98820-9055', texto: 'Oferta', midia_url: 'https://x.com/oferta.jpg', hora: '10:00', data: amanha }, headers: H })).json;
    assert.strictEqual(d.alvo_jid, '5575988209055@s.whatsapp.net');
    await wa.tick({ agoraMs: d.proximo_em + 1000 });
    const e = enviosEvo().pop(); assert.strictEqual(e.url, '/message/sendMedia/nextap'); assert.strictEqual(e.corpo.mediatype, 'image'); assert.strictEqual(e.corpo.caption, 'Oferta');
    assert.strictEqual((await chamar('GET', '/api/whatsapp/disparos', { headers: H })).json.find(x => x.id === d.id).proximo_em, null);
    evo.falhar = true;
    const r = await chamar('POST', `/api/whatsapp/disparos/${d.id}/enviar-agora`, { headers: H }); evo.falhar = false;
    assert.strictEqual(r.status, 502); assert.ok((await chamar('GET', '/api/whatsapp/disparos', { headers: H })).json.find(x => x.id === d.id).ultimo_erro.includes('500'));
  });
  evoSrv.close();


  console.log('Funil de vendas (preço na conversa + avisos do NexTap)');
  const nx = require('./nextap.js');
  const nxSrv = http.createServer((rq, rs) => { rs.writeHead(200, { 'Content-Type': 'application/json' });
    rs.end(JSON.stringify({ minimo: 5, frete: 0, tiers: [{ min_qty: 5, max_qty: 10, unit_price: 19.99 }, { min_qty: 11, max_qty: 49, unit_price: 17.99 }, { min_qty: 50, max_qty: 1000000, unit_price: 14.99 }] })); });
  await new Promise(r => nxSrv.listen(0, r));
  await t('tabela de preços: padrão igual à do site; depois de ler o NexTap vale a do site (ex.: promoção)', async () => {
    assert.strictEqual(nx.precoUnitario(10), 21.9); assert.strictEqual(nx.precoUnitario(20), 18.9); assert.strictEqual(nx.precoUnitario(2), 21.9); assert.strictEqual(nx.precoUnitario(5000000), 15.9);
    process.env.NEXTAP_API_BASE = `http://127.0.0.1:${nxSrv.address().port}`; await nx.atualizarPrecos();
    assert.strictEqual(nx.precoUnitario(20), 17.99); assert.strictEqual(nx.minimo(), 5);
    assert.deepStrictEqual(nx.conta(20), { qtd: 20, unit: 17.99, total: 359.8, receita: 1600, lucro: 1240.2 }); assert.strictEqual(nx.brl(1240.2), '1.240,20');
    assert.ok((await chamar('GET', '/api/status', { headers: H })).json.precos.em > 0);
  });
  await t('instalação do funil de vendas pelo painel desliga os antigos e traz follow-ups por etapa', async () => {
    assert.strictEqual((await chamar('POST', '/api/flows/instalar-v4', { corpo: {}, headers: H })).status, 200);
    assert.strictEqual((await chamar('POST', '/api/flows/instalar-v4', { corpo: {}, headers: H })).status, 409);
    const at = db.prepare("SELECT audience, COUNT(*) AS n FROM flows WHERE active = 1 AND kind = 'followup' GROUP BY audience").all();
    assert.deepStrictEqual(at.map(x => x.audience).sort(), ['checkout', 'negocio', 'revenda_preco', 'revenda_qtd']);
    for (const f of db.prepare('SELECT name, steps FROM flows WHERE active = 1').all()) for (const p of JSON.parse(f.steps)) {
      (p.buttons || []).concat(p.replies || []).forEach(b => assert.ok(b.title.length <= 20, f.name + ': botão longo demais: ' + b.title));
      if (p.type !== 'text' && p.text) assert.ok(p.text.length <= 640, f.name + ': texto com botão passa de 640');
    }
  });
  let pedidoUrl, leadTok;
  await t('quantidade digitada: preço, total e lucro na conversa; o botão abre o pedido no site já com a quantidade', async () => {
    const s = rec(); await engine.processarMensagem(msg('quero revender', { extId: 'v4a' }), s);
    assert.deepStrictEqual(s.env[0].p.replies.map(r => r.title), ['5–10', '11–49', '50–99', '100+']); assert.ok(s.env[0].p.text.includes('mínimo 5'));
    const s2 = rec(); const r = await engine.processarMensagem(msg('20', { extId: 'v4a' }), s2);
    assert.strictEqual(r.fluxo, 'Venda: 11 a 49 placas'); assert.strictEqual(contatoDe('v4a').qty, 20);
    const txt = s2.env.map(x => x.p.text || '').join('\n');
    assert.ok(txt.includes('Para 20 placas: R$ 17,99 cada, total de R$ 359,80'), txt); assert.ok(txt.includes('R$ 1.240,20 de lucro'), txt);
    const bt = s2.env.map(x => x.p).find(p => p.type === 'button'); assert.strictEqual(bt.buttons[0].title, 'FAZER MEU PEDIDO');
    leadTok = /\/go\/([\w-]+)$/.exec(bt.buttons[0].url)[1];
    pedidoUrl = engine.registrarClique(leadTok);
    assert.ok(pedidoUrl.includes('/revendedor/?tab=registro&qtd=20&lead=' + leadTok), pedidoUrl); assert.ok(tagsC('v4a').includes('ABRIU CHECKOUT'));
  });
  await t('faixa pelo botão usa a quantidade de exemplo; abaixo do mínimo explica e pergunta de novo', async () => {
    const s = rec(); await engine.processarMensagem(msg('revender', { extId: 'v4b' }), s);
    const s2 = rec(); await engine.processarMensagem(msg('x', { extId: 'v4b', payload: respRapida(s.env[0].p, '5–10') }), s2);
    assert.strictEqual(contatoDe('v4b').qty, 10); assert.ok(s2.env.map(x => x.p.text || '').join('\n').includes('Para 10 placas: R$ 19,99 cada, total de R$ 199,90'));
    const s3 = rec(); await engine.processarMensagem(msg('revender', { extId: 'v4c' }), rec()); const r = await engine.processarMensagem(msg('3', { extId: 'v4c' }), s3);
    assert.strictEqual(r.fluxo, 'Venda: abaixo do pedido mínimo'); assert.ok(s3.env[0].p.text.includes('pedido mínimo é de 5 placas'));
    const s4 = rec(); await engine.processarMensagem(msg('100', { extId: 'v4c' }), s4);
    assert.strictEqual(contatoDe('v4c').qty, 100); assert.strictEqual(contatoDe('v4c').human_priority, 2); assert.ok(s4.env[0].p.text.includes('R$ 14,99 cada'));
  });
  await t('avisos do NexTap: exigem o segredo; cadastro e pagamento marcam as etiquetas, a venda e param os follow-ups', async () => {
    const ev = (corpo, seg) => chamar('POST', '/webhook/nextap', { corpo, headers: seg ? { 'X-Automazap-Secret': seg } : {} });
    assert.strictEqual((await ev({ evento: 'pago', lead: leadTok })).status, 503);
    process.env.NEXTAP_WEBHOOK_SECRET = 'segredo-compartilhado-123';
    assert.strictEqual((await ev({ evento: 'pago', lead: leadTok }, 'errado')).status, 401);
    assert.strictEqual((await ev({ evento: 'xyz', lead: leadTok }, 'segredo-compartilhado-123')).status, 400);
    assert.strictEqual((await ev({ evento: 'pago', lead: 'nao-existe' }, 'segredo-compartilhado-123')).json.achou, false);
    await ev({ evento: 'cadastro', lead: leadTok }, 'segredo-compartilhado-123'); assert.ok(tagsC('v4a').includes('CADASTROU')); assert.ok(!tagsC('v4a').includes('VENDA'));
    await ev({ evento: 'pedido', lead: leadTok, qty: 20 }, 'segredo-compartilhado-123'); assert.ok(tagsC('v4a').includes('INICIOU PEDIDO'));
    const r = await ev({ evento: 'pago', lead: leadTok, qty: 20, total: 389.7 }, 'segredo-compartilhado-123');
    assert.strictEqual(r.json.tag, 'VENDA'); const c = contatoDe('v4a'); assert.ok(tagsC('v4a').includes('VENDA')); assert.strictEqual(c.venda_total, 389.7);
    const s = rec(); await engine.tick(s, { agoraMs: Date.now() + 4 * 3600e3 }); assert.strictEqual(s.env.filter(x => x.c === c.id).length, 0, 'follow-up para quem já comprou');
    const st = (await chamar('GET', '/api/status', { headers: H })).json; assert.strictEqual(st.vendas_site.n, 1); assert.strictEqual(st.vendas_site.total, 389.7); assert.ok(st.funil['CADASTROU'] >= 1);
  });
  await t('follow-up de quem viu o preço traz o pedido montado; o final convida para o WhatsApp', async () => {
    const e = rec(); await engine.processarMensagem(msg('revender', { extId: 'v4d' }), e);
    await engine.processarMensagem(msg('x', { extId: 'v4d', payload: respRapida(e.env[0].p, '5–10') }), rec());
    const id = contatoDe('v4d').id, s = rec();
    await engine.tick(s, { agoraMs: Date.now() + 2.1 * 3600e3 });
    const p = s.env.filter(x => x.c === id).map(x => x.p)[0]; assert.ok(p.text.includes('pedido de 10 placas montado: R$ 199,90'), p.text);
    await engine.tick(s, { agoraMs: Date.now() + 20.5 * 3600e3 });
    assert.ok(s.env.filter(x => x.c === id).map(x => x.p).pop().text.includes('me manda o seu número com DDD'));
  });
  await t('lead manda o WhatsApp: guarda o número, etiqueta, abre a conversa na aba WhatsApp e confirma', async () => {
    assert.strictEqual(engine.telefoneDe('20'), null); assert.strictEqual(engine.telefoneDe('quero 100 placas'), null);
    assert.strictEqual(engine.telefoneDe('meu whats é (75) 9 9123-4567'), '5575991234567');
    const s = rec(); const r = await engine.processarMensagem(msg('75 99123-4567', { extId: 'v4b' }), s);
    assert.strictEqual(r.fluxo, 'Recebeu o WhatsApp do lead'); const c = contatoDe('v4b');
    assert.strictEqual(c.phone, '5575991234567'); assert.ok(tagsC('v4b').includes('WHATSAPP')); assert.strictEqual(c.needs_human, 1);
    const l = (await chamar('GET', '/api/whatsapp/conversas', { headers: H })).json; assert.ok(l.some(x => x.jid === '5575991234567@s.whatsapp.net'));
  });
  nxSrv.close(); delete process.env.NEXTAP_API_BASE;


  console.log('Funil 3 toques (v5), funis, teste A/B e notificações');
  const notif = require('./notificacoes.js');
  const pushes = []; let pushFalha = null;
  notif._t.trocarEnvio(async (sub, corpo) => { if (pushFalha) { const e = new Error('gone'); e.statusCode = pushFalha; throw e; } pushes.push({ endpoint: sub.endpoint, ...JSON.parse(corpo) }); });
  await t('instalação do v5 cria um funil próprio, desliga os outros e os funis antigos aparecem agrupados', async () => {
    assert.strictEqual((await chamar('POST', '/api/flows/instalar-v5', { corpo: {}, headers: H })).status, 200);
    assert.strictEqual((await chamar('POST', '/api/flows/instalar-v5', { corpo: {}, headers: H })).status, 409);
    const fx = (await chamar('GET', '/api/funis', { headers: H })).json;
    const v5 = fx.funis.find(f => f.nome === 'Funil 3 toques (v5)'), v4 = fx.funis.find(f => f.nome === 'Funil de vendas (v4)');
    assert.ok(v5 && v4); assert.strictEqual(v5.ativos, v5.total); assert.strictEqual(v4.ativos, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM flows WHERE active = 1 AND (funil_id IS NULL OR funil_id <> ?)').get(v5.id).n, 0);
    for (const f of db.prepare('SELECT name, steps FROM flows WHERE funil_id = ?').all(v5.id)) {
      const passos = JSON.parse(f.steps); assert.strictEqual(passos.length, 1, f.name + ' tem mais de uma mensagem');
      for (const p of passos) { (p.buttons || []).concat(p.replies || []).forEach(b => assert.ok(b.title.length <= 20, f.name + ': ' + b.title)); if (p.type !== 'text') assert.ok(p.text.length <= 640, f.name); }
    }
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM flows WHERE kind = 'followup' AND funil_id = ? AND delay_hours NOT IN (3, 20)").get(v5.id).n === 0);
  });
  await t('3 toques: entrada → quantidade → UMA mensagem de oferta com pedido; vídeo sem link vira só o botão do pedido', async () => {
    const s1 = rec(); await engine.processarMensagem(msg('quanto custa?', { extId: 'v5a' }), s1);
    assert.strictEqual(s1.env.length, 1); assert.deepStrictEqual(s1.env[0].p.replies.map(r => r.title), ['💰 REVENDER', '🏪 MEU NEGÓCIO']);
    const s2 = rec(); await engine.processarMensagem(msg('x', { extId: 'v5a', payload: respRapida(s1.env[0].p, '💰 REVENDER') }), s2);
    assert.strictEqual(s2.env.length, 1); assert.deepStrictEqual(s2.env[0].p.replies.map(r => r.title), ['5 a 10', '11 a 49', '50 ou mais']);
    db.prepare("UPDATE contacts SET ab_grupo = 'A' WHERE ext_id = 'v5a'").run();
    const s3 = rec(); const r = await engine.processarMensagem(msg('20', { extId: 'v5a' }), s3);
    assert.strictEqual(r.fluxo, 'Oferta: 11 a 49 placas'); assert.strictEqual(s3.env.length, 1, 'mais de uma mensagem na oferta');
    const p = s3.env[0].p; assert.strictEqual(p.type, 'button'); assert.ok(p.text.includes('R$ 1.240,20 de lucro'), p.text);
    assert.deepStrictEqual(p.buttons.map(b => b.title), ['FAZER MEU PEDIDO'], 'botão de vídeo sem link devia sumir');
    setSetting('video_demo_url', 'https://x.com/demo.mp4');
    const s4 = rec(); await engine.processarMensagem(msg('11 a 49', { extId: 'v5a', payload: respRapida(s2.env[0].p, '11 a 49') }), s4);
    assert.deepStrictEqual(s4.env[0].p.buttons.map(b => b.title), ['FAZER MEU PEDIDO', 'VER FUNCIONANDO']); setSetting('video_demo_url', '');
  });
  await t('A/B: cada pessoa é sorteada uma vez e sempre vê o mesmo lado; a B usa {{payback}}', async () => {
    db.prepare("UPDATE contacts SET ab_grupo = 'B' WHERE ext_id = 'v5a'").run();
    const s = rec(); const r = await engine.processarMensagem(msg('20', { extId: 'v5a' }), s);
    assert.strictEqual(r.fluxo, 'Oferta: 11 a 49 placas · variante B'); assert.ok(s.env[0].p.text.startsWith('🚀 Com 5 placas vendidas, você já paga o pedido inteiro.\n\n'), s.env[0].p.text);
    const lados = new Set();
    for (let i = 0; i < 30; i++) {
      await engine.processarMensagem(msg('revender', { extId: 'ab' + i }), rec());
      const x = rec(); const y = await engine.processarMensagem(msg('20', { extId: 'ab' + i }), x);
      const g = contatoDe('ab' + i).ab_grupo; lados.add(g);
      assert.strictEqual(y.fluxo.endsWith('variante B'), g === 'B');
      const z = await engine.processarMensagem(msg('20', { extId: 'ab' + i }), rec()); assert.strictEqual(z.fluxo, y.fluxo, 'trocou de lado');
    }
    assert.deepStrictEqual([...lados].sort(), ['A', 'B'], 'sorteio sempre caiu do mesmo lado');
  });
  await t('A/B: resultados por lado e escolha da vencedora (B passa a ser a mensagem principal)', async () => {
    const ab = (await chamar('GET', '/api/ab', { headers: H })).json; const t1 = ab.find(x => x.a_nome === 'Oferta: 11 a 49 placas');
    assert.ok(t1.A.recebeu + t1.B.recebeu >= 30, JSON.stringify(t1)); assert.ok('confianca' in t1);
    const bSteps = db.prepare('SELECT steps FROM flows WHERE id = ?').get(t1.b_id).steps;
    assert.strictEqual((await chamar('POST', `/api/ab/${t1.b_id}/vencedora`, { corpo: { lado: 'X' }, headers: H })).status, 400);
    assert.strictEqual((await chamar('POST', `/api/ab/${t1.b_id}/vencedora`, { corpo: { lado: 'B' }, headers: H })).status, 200);
    assert.strictEqual(db.prepare('SELECT steps FROM flows WHERE id = ?').get(t1.a_id).steps, bSteps);
    const r = await engine.processarMensagem(msg('20', { extId: 'ab0' }), rec()); assert.strictEqual(r.fluxo, 'Oferta: 11 a 49 placas', 'B desligada ainda respondeu');
  });
  await t('A/B pelo painel: criar variante B de qualquer fluxo (uma só por fluxo)', async () => {
    const a = db.prepare("SELECT id FROM flows WHERE name = 'Botão: VER MEU PEDIDO' AND active = 1").get().id;
    const b = await chamar('POST', `/api/flows/${a}/variante`, { headers: H }); assert.strictEqual(b.status, 200); assert.strictEqual(b.json.variante_de, a); assert.strictEqual(b.json.event, null);
    assert.strictEqual((await chamar('POST', `/api/flows/${a}/variante`, { headers: H })).status, 409);
    assert.strictEqual((await chamar('POST', `/api/flows/${b.json.id}/variante`, { headers: H })).status, 400);
    await chamar('DELETE', '/api/flows/' + b.json.id, { headers: H });
  });
  await t('funis: ligar um funil desliga os outros; mover fluxo de funil pelo editor; apagar funil não apaga fluxos', async () => {
    const fx = (await chamar('GET', '/api/funis', { headers: H })).json, v4 = fx.funis.find(f => f.nome === 'Funil de vendas (v4)'), v5 = fx.funis.find(f => f.nome === 'Funil 3 toques (v5)');
    await chamar('POST', `/api/funis/${v4.id}/ativar`, { headers: H });
    let g = (await chamar('GET', '/api/funis', { headers: H })).json.funis; assert.strictEqual(g.find(f => f.id === v5.id).ativos, 0); assert.strictEqual(g.find(f => f.id === v4.id).ativos, g.find(f => f.id === v4.id).total);
    await chamar('POST', `/api/funis/${v5.id}/ativar`, { headers: H });
    const novo = (await chamar('POST', '/api/funis', { corpo: { nome: 'Teste' }, headers: H })).json;
    const base = { name: 'Fluxo do funil teste', priority: 5, match_mode: 'contem', keywords: ['zzteste'], steps: [{ type: 'text', text: 'oi' }], funil_id: novo.id };
    const fl = (await chamar('POST', '/api/flows', { corpo: base, headers: H })).json; assert.strictEqual(fl.funil_id, novo.id);
    assert.strictEqual((await chamar('DELETE', '/api/funis/' + novo.id, { headers: H })).status, 200);
    assert.strictEqual(engine.fluxoPorId(fl.id).funil_id, null); await chamar('DELETE', '/api/flows/' + fl.id, { headers: H });
  });
  await t('v5: no máximo 2 follow-ups por pessoa (3h e 20h), com o pedido montado', async () => {
    const e = rec(); await engine.processarMensagem(msg('revender', { extId: 'v5f' }), e);
    db.prepare("UPDATE contacts SET ab_grupo = 'A' WHERE ext_id = 'v5f'").run();
    await engine.processarMensagem(msg('10', { extId: 'v5f' }), rec());
    const id = contatoDe('v5f').id, s = rec();
    for (const h of [1, 3.1, 8, 12, 20.2, 23]) await engine.tick(s, { agoraMs: Date.now() + h * 3600e3 });
    const env = s.env.filter(x => x.c === id).map(x => x.p);
    assert.strictEqual(env.length, 2, JSON.stringify(env.map(p => p.text)));
    assert.ok(env[0].text.includes('O seu pedido de 10 placas continua montado')); assert.ok(env[1].text.includes('envie o seu WhatsApp com DDD'));
  });
  await t('textos do v5: parágrafos separados por linha em branco, sem "pra", e a revisão não mexe no que foi editado', async () => {
    const ofertas = db.prepare("SELECT name, steps FROM flows WHERE name LIKE 'Oferta:%' OR name LIKE 'Entrada: 3 toques'").all();
    for (const f of ofertas) for (const p of JSON.parse(f.steps)) { assert.ok(p.text.includes('\n\n'), f.name + ' sem parágrafos'); assert.ok(!/\bpr[ao]\b/.test(p.text), f.name + ': ' + p.text); }
    const s = rec(); await engine.processarMensagem(msg('quanto custa?', { extId: 'v5t' }), s);
    assert.strictEqual(s.env[0].p.text, 'Olá! 👋 Aqui é a NexTap.\n\nA nossa placa leva o cliente direto para a avaliação da empresa no Google, sem precisar de aplicativo.\n\nVocê quer a placa para revender ou para usar no seu negócio?');
    // banco antigo: textos originais voltam a ser trocados; um texto editado à mão fica como está
    const sd = require('./seed.js');
    const ent = db.prepare("SELECT id, steps FROM flows WHERE name = 'Entrada: 3 toques'").get(), pc = db.prepare("SELECT id, steps FROM flows WHERE name = 'Dúvida: prazo e entrega'").get();
    const velho = JSON.parse(ent.steps); velho[0].text = 'Oi! 👋 Aqui é a NexTap: placa que leva o cliente direto pra avaliação no Google, sem app.\nÉ pra revender ou pro seu negócio?';
    const meu = JSON.parse(pc.steps); meu[0].text = 'Texto que eu escrevi no painel.';
    db.prepare('UPDATE flows SET steps = ? WHERE id = ?').run(JSON.stringify(velho), ent.id); db.prepare('UPDATE flows SET steps = ? WHERE id = ?').run(JSON.stringify(meu), pc.id);
    setSetting('textos_v5', '1'); assert.ok(sd.atualizarTextosV5() >= 1); assert.strictEqual(sd.atualizarTextosV5(), 0, 'rodou duas vezes');
    assert.ok(JSON.parse(db.prepare('SELECT steps FROM flows WHERE id = ?').get(ent.id).steps)[0].text.startsWith('Olá! 👋 Aqui é a NexTap.\n\n'));
    assert.strictEqual(JSON.parse(db.prepare('SELECT steps FROM flows WHERE id = ?').get(pc.id).steps)[0].text, 'Texto que eu escrevi no painel.');
    db.prepare('UPDATE flows SET steps = ? WHERE id = ?').run(pc.steps, pc.id);
  });
  await t('"Como funciona?" (primeira mensagem dos anúncios) abre a entrada; perguntas específicas vão para a dúvida', async () => {
    for (const [txt, fluxo] of [['Como funciona?', 'Entrada: 3 toques'], ['Olá! Como funciona?', 'Entrada: 3 toques'], ['como funciona a placa?', 'Dúvida: como funciona?'], ['funciona no iPhone?', 'Dúvida: como funciona?']]) {
      const r = await engine.processarMensagem(msg(txt, { extId: 'cf' + txt.length }), rec()); assert.strictEqual(r.fluxo, fluxo, txt);
    }
    // banco antigo: aplica uma vez e não mexe nas outras palavras
    const sd = require('./seed.js');
    const ent = db.prepare("SELECT id, keywords FROM flows WHERE name = 'Entrada: 3 toques'").get(), duv = db.prepare("SELECT id, keywords FROM flows WHERE name = 'Dúvida: como funciona?'").get();
    db.prepare('UPDATE flows SET keywords = ? WHERE id = ?').run(JSON.stringify(['preco', 'minha palavra']), ent.id);
    db.prepare('UPDATE flows SET keywords = ? WHERE id = ?').run(JSON.stringify(['como funciona', 'funciona', 'como e']), duv.id);
    setSetting('palavras_v5', '0'); assert.strictEqual(sd.atualizarPalavrasV5(), 2); assert.strictEqual(sd.atualizarPalavrasV5(), 0);
    assert.deepStrictEqual(JSON.parse(db.prepare('SELECT keywords FROM flows WHERE id = ?').get(ent.id).keywords), ['como funciona', 'preco', 'minha palavra']);
    const kd = JSON.parse(db.prepare('SELECT keywords FROM flows WHERE id = ?').get(duv.id).keywords); assert.ok(!kd.includes('como funciona') && !kd.includes('funciona') && kd.includes('como e') && kd.includes('funciona no'));
    db.prepare('UPDATE flows SET keywords = ? WHERE id = ?').run(ent.keywords, ent.id);
  });
  await t('pausa inteligente: pediu atendente → pausa curta; ninguém respondeu → o robô volta e avisa uma vez', async () => {
    const s1 = rec(); await engine.processarMensagem(msg('quero falar com atendente', { extId: 'pz1' }), s1);
    const c = contatoDe('pz1'); assert.ok(c.handoff_em > 0); assert.ok(c.bot_paused_until - Date.now() <= 15 * 60e3 + 1000 && c.bot_paused_until > Date.now());
    assert.strictEqual((await engine.processarMensagem(msg('oi?', { extId: 'pz1' }), rec())).motivo, 'pausado');
    const s = rec(); await engine.tick(s, { agoraMs: Date.now() + 10 * 60e3 }); assert.strictEqual(s.env.filter(x => x.c === c.id).length, 0, 'voltou cedo demais');
    db.prepare('UPDATE contacts SET bot_paused_until = ? WHERE id = ?').run(Date.now() - 1000, c.id);
    await engine.tick(s, { agoraMs: Date.now() }); await engine.tick(s, { agoraMs: Date.now() + 60e3 });
    const env = s.env.filter(x => x.c === c.id).map(x => x.p.text); assert.strictEqual(env.length, 1, JSON.stringify(env)); assert.ok(env[0].startsWith('Nossa equipe já foi avisada'));
    assert.strictEqual((await engine.processarMensagem(msg('quanto custa?', { extId: 'pz1' }), rec())).fluxo, 'Entrada: 3 toques');
  });
  await t('pausa inteligente: a equipe respondeu (painel ou app) → robô quieto e volta 2h depois da ÚLTIMA resposta', async () => {
    assert.strictEqual(require('./db.js').getSetting('handoff_hours'), '2');
    await engine.processarMensagem(msg('atendente', { extId: 'pz2' }), rec());
    const c = contatoDe('pz2');
    // resposta pelo app do Instagram chega como eco com um código que o robô não conhece
    const ecos = ig.lerWebhook({ object: 'instagram', entry: [{ id: 'conta', messaging: [{ sender: { id: 'conta' }, recipient: { id: 'pz2' }, message: { mid: 'MID-HUMANO', text: 'Oi! Aqui é o Luiz.', is_echo: true } }] }] }).ecos;
    assert.deepStrictEqual(ecos, [{ canal: 'instagram', extId: 'pz2', texto: 'Oi! Aqui é o Luiz.', mid: 'MID-HUMANO' }]);
    assert.strictEqual(engine.processarEco(ecos[0]).acao, 'pausado');
    const d = contatoDe('pz2'); assert.strictEqual(d.handoff_em, null); assert.strictEqual(d.needs_human, 0); assert.ok(Math.abs(d.bot_paused_until - (Date.now() + 2 * 3600e3)) < 5000);
    const s = rec(); db.prepare('UPDATE contacts SET bot_paused_until = ? WHERE id = ?').run(Date.now() - 1, d.id); await engine.tick(s, { agoraMs: Date.now() });
    assert.strictEqual(s.env.filter(x => x.c === d.id).length, 0, 'mandou "equipe demorou" mesmo com a equipe tendo respondido');
    assert.strictEqual((await engine.processarMensagem(msg('quanto custa?', { extId: 'pz2' }), rec())).fluxo, 'Entrada: 3 toques', 'não voltou depois da pausa');
  });
  await t('pausa inteligente: o eco das mensagens do próprio robô não pausa nada', async () => {
    await engine.processarMensagem(msg('quanto custa?', { extId: 'pz3' }), rec());
    const ultimo = db.prepare("SELECT text FROM messages WHERE contact_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1").get(contatoDe('pz3').id).text;
    assert.strictEqual(engine.processarEco({ canal: 'instagram', extId: 'pz3', texto: ultimo, mid: 'MID-X' }).motivo, 'enviada pelo robô');
    assert.strictEqual(contatoDe('pz3').bot_paused_until, 0);
    assert.strictEqual(engine.processarEco({ canal: 'instagram', extId: 'ninguem', texto: 'x' }).motivo, 'contato desconhecido');
  });
  await t('contas de teste: o robô nunca fica pausado para elas', async () => {
    const c = engine.upsertContato({ canal: 'instagram', extId: 'pz4', username: 'dr.luizcardos0' });
    db.prepare('UPDATE contacts SET bot_paused_until = ?, needs_human = 1 WHERE id = ?').run(Date.now() + 365 * 86400e3, c.id);
    assert.strictEqual((await engine.processarMensagem(msg('Como funciona?', { extId: 'pz4', username: 'dr.luizcardos0' }), rec())).fluxo, 'Entrada: 3 toques');
    engine.upsertContato({ canal: 'instagram', extId: 'pz5', username: 'outra.pessoa' }); db.prepare("UPDATE contacts SET bot_paused_until = ? WHERE ext_id = 'pz5'").run(Date.now() + 3600e3);
    assert.strictEqual((await engine.processarMensagem(msg('Como funciona?', { extId: 'pz5' }), rec())).motivo, 'pausado');
    assert.strictEqual((await chamar('PUT', '/api/settings', { corpo: { contas_teste: 'a, b', espera_equipe_min: '20', handoff_hours: '3' }, headers: H })).status, 200);
    assert.strictEqual((await chamar('PUT', '/api/settings', { corpo: { handoff_hours: '100' }, headers: H })).status, 400);
    await chamar('PUT', '/api/settings', { corpo: { contas_teste: 'dr.luizcardos0, dr.luizcardoso', espera_equipe_min: '15', handoff_hours: '2' }, headers: H });
  });
  await t('Black do site: entra igual nas ofertas A e B, some quando acaba, avisa as últimas horas e "BLACK" abre o robô', async () => {
    const pr = http.createServer((rq, rs) => { rs.writeHead(200, { 'Content-Type': 'application/json' });
      rs.end(JSON.stringify(rq.url.includes('promocao') ? { ativa: true, nome: 'Black NexTap', fim: new Date(Date.now() + 10 * 86400e3).toISOString(), a_partir: 14.99, minimo_a_partir: 50,
        normais: [{ min_qty: 5, max_qty: 10, unit_price: 21.9 }, { min_qty: 11, max_qty: 49, unit_price: 18.9 }, { min_qty: 50, max_qty: 1000000, unit_price: 17.9 }] }
        : { minimo: 5, tiers: [{ min_qty: 5, max_qty: 9, unit_price: 19.99 }, { min_qty: 10, max_qty: 49, unit_price: 17.99 }, { min_qty: 50, max_qty: 1000000, unit_price: 14.99 }] })); });
    await new Promise(r => pr.listen(0, r)); process.env.NEXTAP_API_BASE = `http://127.0.0.1:${pr.address().port}`;
    await nx.atualizarPrecos(); await nx.atualizarPromo(); pr.close(); delete process.env.NEXTAP_API_BASE;
    const oferta = async (ext, lado) => { await engine.processarMensagem(msg('revender', { extId: ext }), rec()); db.prepare('UPDATE contacts SET ab_grupo = ? WHERE ext_id = ?').run(lado, ext);
      const s = rec(); await engine.processarMensagem(msg('10', { extId: ext }), s); return s.env[0].p.text; };
    const a = await oferta('bfA', 'A'), b = await oferta('bfB', 'B');
    for (const t of [a, b]) { assert.ok(t.includes('de R$ 21,90 por R$ 17,99 cada'), t); assert.ok(t.includes('\n\n🖤 Preço da Black NexTap, válido até '), t); assert.ok(t.length <= 640); }
    assert.ok(a.includes('de lucro') && b.startsWith('🚀'), 'as duas versões continuam diferentes no que está sendo testado');
    // banco com o v5 já instalado (a entrada ainda sem a linha da Black): troca uma vez e só o que estava igual ao original
    const sd = require('./seed.js'); setSetting('black_v5', '0'); assert.ok(sd.atualizarBlackV5() >= 1); assert.strictEqual(sd.atualizarBlackV5(), 0, 'rodou duas vezes');
    const e = rec(); assert.strictEqual((await engine.processarMensagem(msg('BLACK', { extId: 'bfE' }), e)).fluxo, 'Entrada: 3 toques');
    assert.ok(e.env[0].p.text.includes('🖤 Black NexTap: placas a partir de R$ 14,99 (pedidos de 50 ou mais), até '));
    assert.ok(nx.textoPromo('black_final', 10).includes('termina em 10 dias'));
    assert.ok(nx.textoPromo('black_final', 10, Date.now() + 9.5 * 86400e3).startsWith('⏰ Últimas horas'));
    assert.strictEqual(nx.textoPromo('black', 10, Date.now() + 11 * 86400e3), '', 'promoção vencida continuou aparecendo');
    setSetting('nextap_promo', 'null');
    const sem = await oferta('bfC', 'A'); assert.ok(sem.startsWith('📦 10 placas: R$ 17,99 cada, total de R$ 179,90.\n\n💰'), sem); assert.ok(!sem.includes('Black'));
  });
  console.log('Prédio (agentes por regras)');
  const predio = require('./predio.js');
  await t('Atendente: entende abreviação e erro de digitação, mas não confunde "carro" com "caro"', async () => {
    assert.strictEqual(engine.corrigirTexto('qnto custa?'), 'quanto custa'); assert.strictEqual(engine.corrigirTexto('meu carro quebrou'), 'meu carro quebrou');
    assert.strictEqual((await engine.processarMensagem(msg('quero revendee', { extId: 'at1' }), rec())).fluxo, 'Revender: quantas placas?');
    assert.strictEqual((await engine.processarMensagem(msg('vlr da plaquinha?', { extId: 'at1b' }), rec())).fluxo, 'Entrada: 3 toques');
    assert.strictEqual((await engine.processarMensagem(msg('vocês entregam em salvador?', { extId: 'at1c' }), rec())).fluxo, 'Dúvida: prazo e entrega');
  });
  await t('Atendente: não entendeu → menu com botões (uma vez), anota a frase; ensinar faz o robô responder sozinho', async () => {
    const s1 = rec(); const r = await engine.processarMensagem(msg('vocês atendem aos sábados', { extId: 'at2' }), s1);
    assert.strictEqual(r.fluxo, 'Não entendi (menu)'); assert.deepStrictEqual(s1.env[0].p.replies.map(x => x.title), ['💰 VER PREÇOS', '❓ COMO FUNCIONA', '🙋 FALAR COM ALGUÉM']);
    assert.strictEqual((await engine.processarMensagem(msg('vocês atendem aos sábados', { extId: 'at2' }), rec())).motivo, 'sem_fluxo', 'mandou o menu duas vezes');
    const lista = (await chamar('GET', '/api/predio/atendente', { headers: H })).json.frases; const f = lista.find(x => x.chave === 'voces atendem aos sabados');
    assert.strictEqual(f.vezes, 2);
    const prazo = db.prepare("SELECT id FROM flows WHERE name = 'Falar com atendente' AND active = 1").get().id;
    assert.strictEqual((await chamar('POST', `/api/predio/atendente/${f.id}/ensinar`, { corpo: { flow_id: 999999 }, headers: H })).status, 400);
    assert.strictEqual((await chamar('POST', `/api/predio/atendente/${f.id}/ensinar`, { corpo: { flow_id: prazo }, headers: H })).status, 200);
    assert.strictEqual((await engine.processarMensagem(msg('vocês atendem aos sábados?', { extId: 'at3' }), rec())).fluxo, 'Falar com atendente');
    assert.ok(!(await chamar('GET', '/api/predio/atendente', { headers: H })).json.frases.some(x => x.id === f.id));
  });
  await t('Prospectora: retornos primeiro, novas pela oportunidade, mensagem pronta; retornos nos dias 1, 3 e 7', async () => {
    db.prepare("UPDATE prospects SET status = 'perdido'").run();
    const nova = (nome, nota, av, tel) => (db.prepare("INSERT INTO prospects (nome, segmento, telefone, nota, avaliacoes, status, contato) VALUES (?, 'Barbearia', ?, ?, ?, 'novo', 'José Silva')").run(nome, tel, nota, av).lastInsertRowid);
    const fraca = nova('Barbearia Poucas', 4.1, 3, '75 91111-1111'), forte = nova('Barbearia Top', 4.9, 400, '75 92222-2222'); nova('Sem Telefone', 3, 1, '');
    const hoje = predio.dataStr(Date.now());
    const ret = db.prepare("INSERT INTO prospects (nome, telefone, status, prox_contato) VALUES ('Ótica Retorno', '75 93333-3333', 'abordado', ?)").run(hoje).lastInsertRowid;
    db.prepare("INSERT INTO prospect_hist (prospect_id, tipo, texto) VALUES (?, 'whatsapp', 'abordagem')").run(ret);
    const l = (await chamar('POST', '/api/predio/prospectora/montar', { headers: H })).json;
    assert.deepStrictEqual(l.itens.map(i => i.nome), ['Ótica Retorno', 'Barbearia Poucas', 'Barbearia Top']);
    assert.strictEqual(l.itens[0].passo, 'd1'); assert.ok(/minha mensagem|dia é corrido/.test(l.itens[0].mensagem), l.itens[0].mensagem);
    const m1 = l.itens[1].mensagem; assert.ok(['A', 'B', 'C'].includes(l.itens[1].variante)); assert.ok(m1.includes('José') && m1.includes('Barbearia Poucas') && /\b3\b/.test(m1) && m1.includes('tráfego') && m1.endsWith('é só me dizer que eu não escrevo mais.'), m1);
    assert.notStrictEqual(l.itens[1].variante, l.itens[2].variante);   // teste A/B/C: empresas seguidas recebem versões diferentes
    const dias = []; for (let i = 0; i < 4; i++) dias.push((await chamar('POST', '/api/predio/prospectora/feito', { corpo: { prospect_id: fraca }, headers: H })).json.prox_contato);
    const d = k => predio.dataStr(Date.now() + k * 86400e3);
    assert.deepStrictEqual(dias, [d(1), d(2), d(4), null]);
    assert.strictEqual(db.prepare('SELECT status FROM prospects WHERE id = ?').get(fraca).status, 'abordado');
    assert.ok((await chamar('GET', '/api/predio/prospectora', { headers: H })).json.itens.find(i => i.id === fraca).feito);
  });
  await t('Teste A/B/C da abertura: textos editáveis, versão desligada não é sorteada, métricas por versão', async () => {
    const t0 = (await chamar('GET', '/api/predio/prospectora/abc', { headers: H })).json; assert.deepStrictEqual(t0.variantes.map(v => v.id), ['A', 'B', 'C']); assert.ok(t0.exemplo.B.includes('Barbearia Navalha'));
    assert.strictEqual((await chamar('PUT', '/api/predio/prospectora/abc', { corpo: { textos: { B: 'curto' } }, headers: H })).status, 400);
    assert.strictEqual((await chamar('PUT', '/api/predio/prospectora/abc', { corpo: { ativas: '' }, headers: H })).status, 400);
    const t1 = (await chamar('PUT', '/api/predio/prospectora/abc', { corpo: { textos: { B: 'Olá{nome}! Teste da versão B para {empresa}. {numeros} Posso te mostrar?' }, ativas: 'B' }, headers: H })).json;
    assert.deepStrictEqual(t1.variantes.map(v => v.ativa), [false, true, false]); assert.ok(t1.exemplo.B.startsWith('Olá, Carlos! Teste da versão B para Barbearia Navalha. Vi que vocês estão com nota 4,3 e 18 avaliações.'));
    const B = require('./bianca.js'), id = db.prepare("INSERT INTO prospects (place_id, nome, telefone, status) VALUES ('abc1', 'Loja ABC', '75988887777', 'abordado')").run().lastInsertRowid;
    assert.ok(B.saida(db.prepare('SELECT * FROM prospects WHERE id = ?').get(id), 'd0').startsWith('Olá! Teste da versão B para Loja ABC.'));
    B.respondeu(id, 'pode sim');
    const v = (await chamar('GET', '/api/predio/prospectora/abc', { headers: H })).json.variantes.find(x => x.id === 'B'); assert.ok(v.enviadas >= 1 && v.respostas >= 1 && v.interesse >= 1);
    await chamar('PUT', '/api/predio/prospectora/abc', { corpo: { textos: { A: '', B: '', C: '' }, ativas: 'ABC' }, headers: H }); db.prepare('DELETE FROM prospects WHERE id = ?').run(id);
  });
  await t('Conteúdo: semana de segunda a sexta com números reais e chamadas que disparam o robô; aprovado não é trocado', async () => {
    const r = (await chamar('GET', '/api/predio/conteudo', { headers: H })).json; assert.strictEqual(r.itens.length, 5);
    assert.deepStrictEqual(r.itens.map(c => c.pilar), ['Prova social', 'Como funciona', 'Revenda e lucro', 'Quebra de objeção', 'Oferta']);
    const dias = r.itens.map(c => new Date(c.dia + 'T12:00:00-03:00').getUTCDay()); assert.deepStrictEqual(dias, [1, 2, 3, 4, 5]);
    for (const c of r.itens) { assert.ok(/Comente (COMO FUNCIONA|REVENDER|BLACK)/.test(c.legenda), c.titulo); assert.ok(c.legenda.includes('#avaliacoesgoogle')); assert.ok(c.legenda.length <= 2200); }
    assert.strictEqual((await chamar('PUT', `/api/predio/conteudo/${r.itens[0].id}`, { corpo: { status: 'aprovado', legenda: 'Minha legenda' }, headers: H })).status, 200);
    await chamar('POST', '/api/predio/conteudo/gerar', { headers: H });
    const r2 = (await chamar('GET', '/api/predio/conteudo', { headers: H })).json; assert.strictEqual(r2.itens.length, 5);
    assert.strictEqual(r2.itens.find(c => c.id === r.itens[0].id).legenda, 'Minha legenda');
  });
  await t('Marketing: cronograma (seg 2 posts, ter 1, dom 0, stories 2/dia), CTO revisa e aprova, outra versão, postado, métricas e guia de estilo', async () => {
    const P = require('./predio.js'), m = (await chamar('GET', '/api/predio/marketing', { headers: H })).json;
    assert.ok(m.videos.length >= 2); for (const v of m.videos) { assert.strictEqual(v.ganchos.length, 3); assert.ok(/^Comente [A-Z]/.test(v.cta), v.cta); assert.strictEqual(v.cenas[v.cenas.length - 1].tela, v.cta); }
    assert.deepStrictEqual(m.cronograma, { feed: [0, 2, 1, 2, 1, 2, 2], stories: 2 }); assert.ok(m.estilo.includes('NexTap') && m.estilo_padrao);
    const dia = d => Date.parse(d + 'T15:00:00-03:00'), slots = d => P.pecasDoDia(dia(d)).map(p => p.slot).sort();
    assert.deepStrictEqual(slots('2026-12-07'), ['feed1', 'feed2', 'story1', 'story2']);   // segunda
    assert.deepStrictEqual(slots('2026-12-08'), ['feed1', 'story1', 'story2']);            // terça
    assert.deepStrictEqual(slots('2026-12-13'), ['story1', 'story2']);                     // domingo
    const seg = P.pecasDoDia(dia('2026-12-07')), car = seg.find(p => p.slot === 'feed1');
    assert.strictEqual(car.tipo, 'carrossel'); assert.ok(car.slides.length >= 4); assert.strictEqual(seg.find(p => p.slot === 'feed2').tipo, 'post');
    for (const p of seg) { assert.strictEqual(p.status, 'aprovado', p.titulo + ' ' + JSON.stringify(p.revisao.notas)); for (const x of p.slides) { assert.ok(x.prompt.includes('"' + x.texto + '"')); assert.ok(x.texto.length <= 70); assert.ok(x.prompt.includes(p.canal === 'stories' ? '9:16' : '4:5')); } }
    assert.ok(/Comente [A-Z]{3,}/.test(car.legenda) && car.legenda.includes('#'));
    const ruim = P.revisar({ ...car, legenda: 'Garantimos o dobro de clientes', slides: [{ n: 1, texto: 'x'.repeat(90), sub: '' }] });
    assert.ok(!ruim.ok && ruim.notas.length >= 4);   // texto longo, promessa, sem chamada, sem hashtag, poucas imagens
    const r2 = (await chamar('POST', `/api/predio/marketing/pecas/${car.id}/refazer`, { headers: H })).json; assert.ok(r2.titulo !== car.titulo && r2.versao === car.versao + 1);
    assert.strictEqual((await chamar('PUT', `/api/predio/marketing/pecas/${car.id}`, { corpo: { status: 'postado' }, headers: H })).json.status, 'postado');
    const mt = P.metricasMkt(dia('2026-12-08')); assert.deepStrictEqual([mt.ontem.planejadas, mt.ontem.postadas], [4, 1]); assert.ok(mt.recomendacoes[0].includes('3 peça(s) sem postar'));
    assert.strictEqual((await chamar('PUT', '/api/predio/marketing/config', { corpo: { cronograma: { feed: [0, 9, 1, 2, 1, 2, 2], stories: 2 } }, headers: H })).status, 400);
    const c2 = (await chamar('PUT', '/api/predio/marketing/config', { corpo: { cronograma: { feed: [1, 2, 1, 2, 1, 2, 2], stories: 1 }, estilo: 'Estilo novo da marca' }, headers: H })).json;
    assert.strictEqual(c2.cronograma.stories, 1); assert.strictEqual(c2.estilo, 'Estilo novo da marca'); assert.deepStrictEqual(slots('2026-12-20'), ['feed1', 'story1']);
    await chamar('PUT', '/api/predio/marketing/config', { corpo: { cronograma: { feed: [0, 2, 1, 2, 1, 2, 2], stories: 2 }, estilo: '' }, headers: H });
    const n0 = db.prepare("SELECT COUNT(*) AS n FROM agentes_log WHERE agente = 'cto'").get().n;
    const rel = (await chamar('POST', '/api/predio/marketing/relatorio', { headers: H })).json; assert.ok(rel.texto.includes('Recomendações'));
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM agentes_log WHERE agente = 'cto'").get().n > n0);
    const vis = (await chamar('GET', '/api/predio', { headers: H })).json; assert.strictEqual(vis.nomes.cto, 'Rafael'); assert.strictEqual(vis.nomes.imagem, 'Lia'); assert.ok(vis.marketing.hoje.pecas >= 2); assert.ok(vis.ceo);
  });
  await t('Renan (social media): imagens cortadas em JPEG 4:5 e 9:16, CEO aprova, fila publica na hora marcada (carrossel, post e story), erro de permissão e métricas', async () => {
    const P = require('./predio.js'), S = require('./social.js'), ig = require('./instagram.js'), sharp = require('sharp'), fs = require('fs'), path = require('path');
    const t0 = Date.parse('2026-12-14T07:00:00-03:00'), pecas = P.pecasDoDia(t0);   // segunda: 2 no feed + 2 stories
    assert.deepStrictEqual(pecas.map(p => p.slot + '@' + p.horario).sort(), ['feed1@11:30', 'feed2@18:00', 'story1@08:30', 'story2@21:00']);
    const png = 'data:image/png;base64,' + (await sharp({ create: { width: 1024, height: 1536, channels: 3, background: '#208040' } }).png({ compressionLevel: 0 }).toBuffer()).toString('base64');
    const car = pecas.find(p => p.slot === 'feed1'), st = pecas.find(p => p.slot === 'story1'), post = pecas.find(p => p.slot === 'feed2');
    assert.strictEqual((await chamar('POST', `/api/predio/marketing/pecas/${car.id}/aprovar`, { corpo: {}, headers: H })).status, 400);   // sem imagens não aprova
    assert.strictEqual((await chamar('POST', `/api/predio/marketing/pecas/${car.id}/imagem`, { corpo: { i: 0, data: 'data:text/plain;base64,QUJD' }, headers: H })).status, 400);
    for (let i = 0; i < car.slides.length; i++) assert.strictEqual((await chamar('POST', `/api/predio/marketing/pecas/${car.id}/imagem`, { corpo: { i, data: png }, headers: H })).status, 200);
    const c2 = S.ler(db.prepare('SELECT * FROM mkt_pecas WHERE id = ?').get(car.id)); assert.ok(S.completa(c2));
    const m1 = await sharp(path.join(S.pasta, c2.imagens[0].arquivo)).metadata(); assert.deepStrictEqual([m1.format, m1.width, m1.height], ['jpeg', 1080, 1350]);
    await S.anexar(st.id, 0, png); const m2 = await sharp(path.join(S.pasta, S.ler(db.prepare('SELECT * FROM mkt_pecas WHERE id = ?').get(st.id)).imagens[0].arquivo)).metadata(); assert.deepStrictEqual([m2.width, m2.height], [1080, 1920]);
    await S.anexar(post.id, 0, png);
    const ap = (await chamar('POST', `/api/predio/marketing/pecas/${car.id}/aprovar`, { corpo: { legenda: 'Legenda final. Comente COMO FUNCIONA #nextap' }, headers: H })).json; assert.deepStrictEqual([ap.status, ap.horario], ['programado', '11:30']);
    S.aprovar(st.id, {}, t0); S.aprovar(post.id, { horario: '11:40' }, t0);
    const chamadas = [], pubO = ig.publicar, insO = ig.insights; setSetting('public_url', 'https://automazap.teste');
    ig.publicar = async o => { chamadas.push(o); return { id: 'ig' + chamadas.length, permalink: 'https://instagram.com/p/x' + chamadas.length }; };
    ig.insights = async (id, story) => (story ? { reach: 50, replies: 1 } : { reach: 400, likes: 30, comments: 4, saved: 6, shares: 2 });
    try {
      assert.strictEqual(await S.tick(t0), 0);                                                   // 07:00: ainda não é hora
      assert.strictEqual(await S.tick(Date.parse('2026-12-14T08:31:00-03:00')), 1);              // story das 08:30
      assert.deepStrictEqual([chamadas[0].tipo, chamadas[0].urls.length, chamadas[0].legenda], ['story', 1, '']); assert.ok(/^https:\/\/automazap\.teste\/media\/mkt\/p\d+-1-[0-9a-f]+\.jpg$/.test(chamadas[0].urls[0]));
      assert.strictEqual(await S.tick(Date.parse('2026-12-14T11:31:00-03:00')), 1);              // carrossel das 11:30
      assert.deepStrictEqual([chamadas[1].tipo, chamadas[1].urls.length], ['carrossel', car.slides.length]); assert.ok(chamadas[1].legenda.startsWith('Legenda final'));
      assert.strictEqual(await S.tick(Date.parse('2026-12-14T11:41:00-03:00')), 0);              // 2º post do feed espera 20 min do anterior
      assert.strictEqual(await S.tick(Date.parse('2026-12-14T11:52:00-03:00')), 1); assert.strictEqual(chamadas[2].tipo, 'post');
      const fim = S.ler(db.prepare('SELECT * FROM mkt_pecas WHERE id = ?').get(car.id)); assert.deepStrictEqual([fim.status, fim.ig_id], ['postado', 'ig2']); assert.ok(fim.insights.reach === 400);
      assert.strictEqual((await chamar('POST', `/api/predio/marketing/pecas/${car.id}/aprovar`, { corpo: {}, headers: H })).status, 400);   // já publicada
      assert.ok(await S.coletarInsights(Date.parse('2026-12-14T13:00:00-03:00')) >= 3);
      const d = S.desempenho(Date.parse('2026-12-15T08:00:00-03:00')); assert.ok(d.melhor && d.ranking.length >= 1 && d.ontem.alcance === 800);
      // sem permissão no token: fica em erro com a instrução, sem publicar
      const s2 = pecas.find(p => p.slot === 'story2'); await S.anexar(s2.id, 0, png); S.aprovar(s2.id, {}, t0);
      ig.publicar = async () => { throw new Error('Instagram respondeu 400: (#10) Application does not have permission for this action'); };
      await S.tick(Date.parse('2026-12-14T21:01:00-03:00'));
      const er = S.ler(db.prepare('SELECT * FROM mkt_pecas WHERE id = ?').get(s2.id)); assert.strictEqual(er.status, 'erro'); assert.ok(er.erro.includes('instagram_business_content_publish'));
      assert.strictEqual((await chamar('POST', `/api/predio/marketing/pecas/${s2.id}/publicar`, { headers: H })).status, 502);
    } finally { ig.publicar = pubO; ig.insights = insO; }
    const mk = (await chamar('PUT', '/api/predio/marketing/horarios', { corpo: { feed: '12:00, 19:00', stories: ['09:00', '20:00'] }, headers: H })).json; assert.deepStrictEqual(mk.social.horarios.feed, ['12:00', '19:00']);
    assert.strictEqual((await chamar('PUT', '/api/predio/marketing/horarios', { corpo: { feed: '25:00', stories: '09:00' }, headers: H })).status, 400);
    await chamar('PUT', '/api/predio/marketing/horarios', { corpo: { feed: ['11:30', '18:00', '20:00'], stories: ['08:30', '10:00', '12:00', '16:00', '19:00', '21:00'] }, headers: H });
    // API da Meta: carrossel = um rascunho por imagem + rascunho pai + publicar
    const fo = global.fetch, tk = process.env.IG_ACCESS_TOKEN, esp = process.env.IG_ESPERA_MS, urls = []; process.env.IG_ACCESS_TOKEN = 'token-de-teste-123456'; process.env.IG_ESPERA_MS = '1';
    global.fetch = async (u, o) => { urls.push((o.method || 'GET') + ' ' + String(u).replace(/^https?:\/\/[^/]+\/v[\d.]+\//, '') + (o.body ? ' ' + o.body : '')); const j = /media_publish/.test(u) ? { id: '999' } : /status_code/.test(u) ? { status_code: 'FINISHED' } : /permalink/.test(u) ? { permalink: 'https://instagram.com/p/abc' } : { id: 'c' + urls.length }; return { ok: true, status: 200, text: async () => JSON.stringify(j) }; };
    try { const r = await ig.publicar({ tipo: 'carrossel', urls: ['https://a/1.jpg', 'https://a/2.jpg'], legenda: 'Oi' }); assert.deepStrictEqual(r, { id: '999', permalink: 'https://instagram.com/p/abc' });
      assert.strictEqual(urls.filter(x => x.includes('"is_carousel_item":true')).length, 2); assert.ok(urls.some(x => x.includes('"media_type":"CAROUSEL"') && x.includes('"caption":"Oi"'))); assert.ok(urls.some(x => x.startsWith('POST me/media_publish')));
      urls.length = 0; await ig.publicar({ tipo: 'story', urls: ['https://a/s.jpg'] }); assert.ok(urls[0].includes('"media_type":"STORIES"'));
    } finally { global.fetch = fo; if (tk === undefined) delete process.env.IG_ACCESS_TOKEN; else process.env.IG_ACCESS_TOKEN = tk; if (esp === undefined) delete process.env.IG_ESPERA_MS; else process.env.IG_ESPERA_MS = esp; }
  });
  await t('Resumo da Gerente no WhatsApp do CEO: precisa do número e do WhatsApp ligado; número inválido é recusado', async () => {
    const W = require('./whatsapp.js'); setSetting('ceo_whatsapp', '');
    assert.ok(/Informe o seu WhatsApp/.test((await W.avisarDono('oi')).motivo));
    assert.strictEqual((await chamar('PUT', '/api/settings', { corpo: { ceo_whatsapp: '123' }, headers: H })).status, 400);
    assert.strictEqual((await chamar('PUT', '/api/settings', { corpo: { ceo_whatsapp: '(75) 98820-9055' }, headers: H })).status, 200);
    const fo = global.fetch, eu = process.env.EVOLUTION_URL, ek = process.env.EVOLUTION_API_KEY, env = [];
    process.env.EVOLUTION_URL = 'https://evo.teste'; process.env.EVOLUTION_API_KEY = 'chave';
    global.fetch = async (u, o) => { env.push([String(u), JSON.parse(o.body)]); return { ok: true, status: 200, text: async () => '{"key":{"id":"x"}}' }; };
    try { const r = await W.avisarDono('Resumo de hoje'); assert.ok(r.ok); assert.ok(env[0][0].includes('/message/sendText/')); assert.deepStrictEqual(env[0][1], { number: '5575988209055', text: 'Resumo de hoje' }); }
    finally { global.fetch = fo; if (eu === undefined) delete process.env.EVOLUTION_URL; else process.env.EVOLUTION_URL = eu; if (ek === undefined) delete process.env.EVOLUTION_API_KEY; else process.env.EVOLUTION_API_KEY = ek; setSetting('ceo_whatsapp', ''); }
  });
  await t('Treino da Bianca: Raio-X do Google (vizinhos, posição, avaliações), dono pelo CNPJ (sócio e MEI) e roteiro em 3 fases com os dados reais', async () => {
    const hoje = Date.now(), iso = d => new Date(hoje - d * 86400e3).toISOString();
    const srv = http.createServer((rq, rs) => { let b = ''; rq.on('data', d => b += d); rq.on('end', () => { rs.setHeader('content-type', 'application/json');
      if (rq.url.startsWith('/cnpj/11222333000181')) return rs.end(JSON.stringify({ razao_social: 'BARBEARIA NAVALHA LTDA', data_inicio_atividade: '2019-03-01', porte: 'MICRO EMPRESA', descricao_situacao_cadastral: 'ATIVA', ddd_telefone_1: '7532210000', email: 'CONTATO@NAVALHA.COM', qsa: [{ nome_socio: 'MARIA DE SOUZA LIMA', qualificacao_socio: 'Sócio' }, { nome_socio: 'CARLOS EDUARDO DA SILVA', qualificacao_socio: 'Sócio-Administrador' }] }));
      if (rq.url.startsWith('/cnpj/44555666000199')) return rs.end(JSON.stringify({ razao_social: '12.345.678 JOAO PEDRO DOS SANTOS', qsa: [] }));
      if (rq.url.startsWith('/cnpj/')) { rs.statusCode = 404; return rs.end('{}'); }
      if (rq.url.includes('searchNearby')) return rs.end(JSON.stringify({ places: [{ id: 'eu', displayName: { text: 'Barbearia Navalha' }, rating: 4.2, userRatingCount: 12 }, { id: 'v1', displayName: { text: 'Barbearia do Rei' }, rating: 4.8, userRatingCount: 180 }, { id: 'v2', displayName: { text: 'Corte Fino' }, rating: 4.5, userRatingCount: 40 }, { id: 'v3', displayName: { text: 'Barba Feita' }, rating: 4.9, userRatingCount: 6 }] }));
      if (rq.url.includes('searchText')) return rs.end(JSON.stringify({ places: [{ id: 'eu' }] }));
      rs.end(JSON.stringify({ id: 'eu', displayName: { text: 'Barbearia Navalha' }, rating: 4.2, userRatingCount: 12, primaryType: 'barber_shop', primaryTypeDisplayName: { text: 'Barbearia' }, location: { latitude: -12.25, longitude: -38.95 }, nationalPhoneNumber: '(75) 3221-0000', googleMapsUri: 'https://maps.google.com/?cid=1',
        reviews: [{ rating: 5, text: { text: 'Ótimo corte' }, relativePublishTimeDescription: 'há 4 meses', publishTime: iso(120) }, { rating: 2, text: { text: 'Demorou demais para atender' }, relativePublishTimeDescription: 'há 8 meses', publishTime: iso(240) }] })); }); });
    await new Promise(r => srv.listen(0, r));
    const gb = process.env.GOOGLE_PLACES_BASE, gk = process.env.GOOGLE_PLACES_API_KEY, cb = process.env.CNPJ_API_BASE, base = 'http://localhost:' + srv.address().port;
    process.env.GOOGLE_PLACES_BASE = base; process.env.CNPJ_API_BASE = base + '/cnpj'; delete process.env.GOOGLE_PLACES_API_KEY;
    try {
      const p = (await chamar('POST', '/api/prospeccao', { corpo: { nome: 'Barbearia Navalha', segmento: 'Barbearia', bairro: 'Centro' }, headers: H })).json;
      assert.strictEqual((await chamar('POST', `/api/prospeccao/${p.id}/raiox`, { headers: H })).status, 400);   // sem chave do Google
      process.env.GOOGLE_PLACES_API_KEY = 'boa';
      const f = (await chamar('POST', `/api/prospeccao/${p.id}/raiox`, { headers: H })).json, x = f.raiox;
      assert.deepStrictEqual([f.nota, f.avaliacoes, x.posicao, x.total_ramo, x.lider.nome, x.negativas], [4.2, 12, 3, 4, 'Barbearia do Rei', 1]); assert.ok(x.ultima_dias >= 119 && x.ultima_dias <= 121);
      assert.ok(x.pontos[0].includes('Barbearia do Rei') && x.pontos[0].includes('180')); assert.ok(x.pontos.some(t => t.includes('3º lugar'))); assert.ok(x.pontos.some(t => t.includes('4 meses'))); assert.ok(x.pontos.some(t => t.includes('Demorou demais')));
      assert.ok(f.telefone.includes('3221'));
      const c = (await chamar('POST', `/api/prospeccao/${p.id}/cnpj`, { corpo: { cnpj: '11.222.333/0001-81' }, headers: H })).json;
      assert.deepStrictEqual([c.contato, c.email, c.cnpj], ['Carlos Eduardo da Silva', 'contato@navalha.com', '11222333000181']); assert.strictEqual(c.cnpj_info.socios.length, 2); assert.ok(c.historico[0].texto.includes('Carlos Eduardo da Silva'));
      const r = c.roteiro; assert.deepStrictEqual(r.fases.map(z => z.fase), ['Início', 'Meio', 'Fechamento']);
      assert.ok(r.fases[0].passos[0].texto.startsWith('Oi, Carlos!') && r.fases[0].passos[0].texto.includes('12 avaliações') && r.fases[0].passos[0].texto.includes('Barbearia do Rei'));
      assert.ok(r.fases[1].passos[0].texto.includes('4 meses atrás')); assert.ok(r.fases[2].passos[0].texto.includes('R$ ') && r.fases[2].passos[0].texto.includes('azul ou a preta'));
      const mei = (await chamar('POST', '/api/prospeccao', { corpo: { nome: 'Lanche do João' }, headers: H })).json;
      assert.strictEqual((await chamar('POST', `/api/prospeccao/${mei.id}/cnpj`, { corpo: { cnpj: '44555666000199' }, headers: H })).json.contato, 'Joao Pedro dos Santos');
      assert.strictEqual((await chamar('POST', `/api/prospeccao/${mei.id}/cnpj`, { corpo: { cnpj: '123' }, headers: H })).status, 400);
      assert.strictEqual((await chamar('POST', `/api/prospeccao/${mei.id}/cnpj`, { corpo: { cnpj: '00000000000000' }, headers: H })).status, 404);
      assert.ok((await chamar('GET', `/api/prospeccao/${mei.id}/roteiro`, { headers: H })).json.fases[0].passos[0].texto.includes('quase não achei avaliações'));
      await chamar('DELETE', `/api/prospeccao/${p.id}`, { headers: H }); await chamar('DELETE', `/api/prospeccao/${mei.id}`, { headers: H });
    } finally { srv.close(); const v = (k, x) => { if (x === undefined) delete process.env[k]; else process.env[k] = x; }; v('GOOGLE_PLACES_BASE', gb); v('GOOGLE_PLACES_API_KEY', gk); v('CNPJ_API_BASE', cb); }
  });
  await t('Bianca importa lotes do Google (nota, avaliações) sem repetir e só uma vez por arquivo', () => {
    const B = require('./bianca.js'), fs = require('fs'), os = require('os'), path = require('path'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotes-'));
    fs.writeFileSync(path.join(dir, '2099-01-01.json'), JSON.stringify({ empresas: [
      { nome: 'Barbearia Lote', telefone: '(75) 98877-1001', segmento: 'Barbearia', bairro: 'Centro', google_nota: 4.3, google_avaliacoes: 12, lat: -12.25, lng: -38.96 },
      { nome: 'Barbearia Lote', telefone: '(75) 98877-1001' }, { nome: 'Sem Fone' }, { nome: 'Pizzaria Lote', telefone: '75 3221-1002', nota: '4,8', avaliacoes: 310, place_id: 'ChIJlote2' }] }));
    assert.deepStrictEqual(B.importarLotes(dir), { arquivos: 1, novos: 2, atualizados: 1 });
    const a = db.prepare("SELECT * FROM prospects WHERE nome = 'Barbearia Lote'").get(), b = db.prepare("SELECT * FROM prospects WHERE nome = 'Pizzaria Lote'").get();
    assert.ok(a.nota === 4.3 && a.avaliacoes === 12 && a.origem === 'bianca' && a.place_id.startsWith('lote:') && a.lat === -12.25);
    assert.ok(b.nota === 4.8 && b.avaliacoes === 310 && b.place_id === 'ChIJlote2');
    assert.deepStrictEqual(B.importarLotes(dir), { arquivos: 0, novos: 0, atualizados: 0 });
    db.prepare("DELETE FROM prospects WHERE nome IN ('Barbearia Lote','Pizzaria Lote')").run();
  });
  await t('horário do Google: aberta agora, fecha de madrugada, só à noite, fechada, 24h e português', () => {
    const B = require('./bianca.js'), N = '\u202f', T = '\u2009';
    const piz = B.horariosDe(['Monday: Closed', `Tuesday: 11:00${N}AM${T}–${T}3:00${N}PM, 6:00${T}–${T}11:00${N}PM`, 'Wednesday: Closed', 'Thursday: Closed', 'Friday: Closed', `Saturday: 6:00${N}PM${T}–${T}2:00${N}AM`, 'Sunday: Open 24 hours']);
    assert.deepStrictEqual(piz[2], [[660, 900], [1080, 1380]]); assert.deepStrictEqual(piz[6], [[1080, 1560]]); assert.deepStrictEqual(piz[0], [[0, 1440]]); assert.deepStrictEqual(piz[1], []);
    const h = s => Date.parse(s + '-03:00');
    assert.deepStrictEqual(B.abertaAgora(piz, h('2026-12-22T19:00:00')), { aberta: true, fecha: '23:00' });       // terça 19h
    assert.deepStrictEqual(B.abertaAgora(piz, h('2026-12-22T16:00:00')), { aberta: false, abre: 'hoje 18:00' });
    assert.deepStrictEqual(B.abertaAgora(piz, h('2026-12-22T23:30:00')), { aberta: false, abre: 'sáb 18:00' });
    assert.deepStrictEqual(B.abertaAgora(piz, h('2026-12-27T01:30:00')), { aberta: true, fecha: '00:00' });   // domingo 24h
    assert.strictEqual(B.abertaAgora(B.horariosDe(['Saturday: 6:00 PM – 2:00 AM']), h('2026-12-27T01:30:00')).aberta, true);   // madrugada de sábado para domingo
    assert.ok(B.abreNoite(piz)); assert.ok(!B.abreNoite(B.horariosDe(['Monday: 8:00 AM – 6:00 PM'])));
    assert.deepStrictEqual(B.horariosDe(['segunda-feira: 08:00–18:00', 'sábado: Fechado'])[1], [[480, 1080]]);
    assert.strictEqual(B.horariosDe([]), null); assert.strictEqual(B.abertaAgora(null), null);
  });
  await t('lote atualiza empresa já cadastrada com horário e nota (sem duplicar)', () => {
    const B = require('./bianca.js'), fs = require('fs'), os = require('os'), path = require('path'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotes-'));
    const id = db.prepare("INSERT INTO prospects (place_id, nome, telefone, origem) VALUES ('lote:5575988771234', 'Bar da Noite', '(75) 98877-1234', 'bianca')").run().lastInsertRowid;
    fs.writeFileSync(path.join(dir, 'horarios-1.json'), JSON.stringify({ empresas: [{ nome: 'Bar da Noite Ltda', telefone: '+55 75 98877-1234', place_id: 'ChIJnoite', rating: 4.4, rating_count: 51, weekday_hours: ['Friday: 6:00 PM – 1:00 AM'] }] }));
    assert.deepStrictEqual(B.importarLotes(dir), { arquivos: 1, novos: 0, atualizados: 1 });
    const p = db.prepare('SELECT * FROM prospects WHERE id = ?').get(id);
    assert.ok(p.nota === 4.4 && p.avaliacoes === 51 && p.place_id === 'ChIJnoite' && JSON.parse(p.horarios).length === 1);
    db.prepare('DELETE FROM prospects WHERE id = ?').run(id);
  });
  await t('Bianca automática: só ligada e em horário comercial, intervalo entre envios, pula número sem WhatsApp, meta do dia, resposta para os retornos e pedido de parar encerra', async () => {
    const B = require('./bianca.js'), P = require('./predio.js'), W = require('./whatsapp.js');
    db.prepare("UPDATE prospects SET status = 'perdido' WHERE status IN ('novo','abordado','interessado','orcamento')").run();   // zera o funil dos outros testes
    const ins = db.prepare("INSERT INTO prospects (place_id, nome, segmento, telefone, nota, avaliacoes, origem) VALUES (?, ?, 'Barbearia', ?, 4.1, ?, 'bianca')");
    const ids = ['(75) 98811-0001', '(75) 98811-0002', '(75) 3221-0003', '(75) 98811-0004'].map((tel, i) => ins.run('auto' + i, 'Auto ' + (i + 1), tel, 5 + i).lastInsertRowid);
    const seg = h => Date.parse(`2026-12-21T${h}:00-03:00`), env = [], fo = global.fetch, eu = process.env.EVOLUTION_URL, ek = process.env.EVOLUTION_API_KEY, gap = process.env.WA_GAP_MS;
    process.env.WA_GAP_MS = '0'; setSetting('bianca_prox', '0'); setSetting('bianca_meta', '2'); setSetting('bianca_auto', '0'); setSetting('ceo_whatsapp', '');
    global.fetch = async (u, o) => { const b = JSON.parse(o.body || '{}'); if (String(u).includes('whatsappNumbers')) return { ok: true, status: 200, text: async () => JSON.stringify([{ exists: !b.numbers[0].endsWith('32210003'), jid: b.numbers[0] + '@s.whatsapp.net' }]) }; env.push(b); return { ok: true, status: 200, text: async () => '{"key":{"id":"m' + env.length + '"}}' }; };
    try {
      assert.strictEqual((await B.tick(seg('10:00'))).motivo, 'desligada');
      setSetting('bianca_auto', '1'); delete process.env.EVOLUTION_URL; assert.strictEqual((await B.tick(seg('10:00'))).motivo, 'whatsapp');
      process.env.EVOLUTION_URL = 'https://evo.teste'; process.env.EVOLUTION_API_KEY = 'k';
      setSetting('bianca_mapeou_n_2026-12-20', '9'); setSetting('bianca_mapeou_n_2026-12-21', '9');   // sem mapeamento na rede durante o teste
      assert.strictEqual((await B.tick(Date.parse('2026-12-20T10:00:00-03:00'))).motivo, 'fora do horário');   // domingo
      assert.strictEqual((await B.tick(seg('08:10'))).motivo, 'fora do horário'); assert.ok(B.naJanela(seg('09:00')) && !B.naJanela(seg('17:30')) && B.naJanela(Date.parse('2026-12-19T11:00:00-03:00')) && !B.naJanela(Date.parse('2026-12-19T12:30:00-03:00')));
      const r1 = await B.tick(seg('09:05'), { sorteio: () => 0 }); assert.ok(r1.enviado && r1.passo === 'd0'); assert.strictEqual(env.length, 1);
      assert.ok(env[0].number.startsWith('55759881100') && env[0].text.includes('Auto ') && env[0].text.includes('tráfego') && env[0].text.includes('é só me dizer que eu não escrevo mais'));
      assert.strictEqual((await B.tick(seg('09:07'))).motivo, 'intervalo');                                   // 5 min mínimos
      const r2 = await B.tick(seg('09:11'), { sorteio: () => 0 }); assert.ok(r2.enviado); assert.strictEqual(env.length, 2);
      const r3 = await B.tick(seg('09:30'), { sorteio: () => 0 }); assert.ok(!r3.enviado); assert.strictEqual(env.length, 2);   // meta de 2 novas atingida
      setSetting('bianca_meta', '5');
      const r4 = await B.tick(seg('09:40'), { sorteio: () => 0 }), r5 = await B.tick(seg('09:50'), { sorteio: () => 0 });
      assert.deepStrictEqual([r4, r5].map(x => x.motivo || 'ok').sort(), ['ok', 'sem whatsapp']); assert.strictEqual(env.length, 3);   // o fixo sem WhatsApp foi pulado e anotado
      assert.ok(db.prepare('SELECT obs FROM prospects WHERE id = ?').get(ids[2]).obs.includes('sem WhatsApp'));
      const ab = db.prepare("SELECT id, status, prox_contato FROM prospects WHERE id IN (?, ?, ?) ORDER BY id").all(ids[0], ids[1], ids[3]); assert.ok(ab.every(x => x.status === 'abordado' && x.prox_contato === '2026-12-22'));
      const pa = B.painel(seg('10:00')); assert.deepStrictEqual([pa.ligada, pa.novos_hoje, pa.enviados_hoje], [true, 3, 3]);
      // respostas
      const q0 = db.prepare('SELECT COUNT(*) AS n FROM bianca_respostas WHERE feito = 0').get().n;
      const rs = B.respondeu(ids[0], 'Oi, pode mandar o vídeo', null, seg('10:00'), { sorteio: () => 0 }); assert.deepStrictEqual([rs.intencao, rs.etapa, rs.responde], ['positivo', 'explicou', true]);
      assert.deepStrictEqual(db.prepare('SELECT status, prox_contato, etapa FROM prospects WHERE id = ?').get(ids[0]), { status: 'interessado', prox_contato: null, etapa: 'explicou' });
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM bianca_respostas WHERE feito = 0').get().n, q0 + 1);
      assert.strictEqual(await B.responder(seg('10:00')), 0);                                                // ainda "digitando": sai 1 min depois
      const antes = env.length; assert.strictEqual(await B.responder(seg('10:02')), 2); assert.ok(env[antes].text.includes('acrílico') && env[antes].delay > 1000 && /valor|custa/.test(env[antes + 1].text));
      // segue a conversa sozinha: preço → compra (avisa você) ; pergunta fora do roteiro vai para você sem resposta automática
      const r6 = B.respondeu(ids[0], 'quanto custa?', null, seg('10:05'), { sorteio: () => 0 }); assert.deepStrictEqual([r6.intencao, r6.etapa], ['preco', 'preco']); await B.responder(seg('10:07')); assert.ok(env[env.length - 2].text.includes('R$ ') && env[env.length - 1].text.includes('1 ou 2'));
      const r7 = B.respondeu(ids[0], 'quero a preta', null, seg('10:10'), { sorteio: () => 0 }); assert.deepStrictEqual([r7.intencao, r7.etapa, r7.responde], ['compra', 'fechamento', true]); await B.responder(seg('10:12')); assert.ok(env[env.length - 1].text.includes('pagamento é na hora'));
      assert.strictEqual(db.prepare('SELECT status FROM prospects WHERE id = ?').get(ids[0]).status, 'orcamento');
      const n8 = env.length, r8 = B.respondeu(ids[0], 'entregam em Salvador amanhã cedo?', null, seg('10:15')); assert.deepStrictEqual([r8.intencao, r8.responde, r8.etapa], ['', false, 'humano']); await B.responder(seg('10:20')); assert.strictEqual(env.length, n8);
      const r9 = B.respondeu(ids[3], 'isso é um robô?', null, seg('10:30'), { sorteio: () => 0 }); assert.deepStrictEqual([r9.intencao, r9.responde, r9.etapa], ['robo', true, 'abertura']); await B.responder(seg('10:32')); assert.ok(env[env.length - 1].text.includes('assistente virtual'));
      db.prepare("UPDATE prospects SET status = 'abordado', prox_contato = '2026-12-22', etapa = 'abertura', auto_n = 0, ultima_intencao = '' WHERE id = ?").run(ids[3]);
      const mp = B.mapa(ids[0]); assert.strictEqual(mp.etapas.find(e => e.id === 'humano').empresas[0].id, ids[0]); assert.ok(mp.textos.abertura.includes('Auto 1') && mp.textos.preco.includes('R$'));
      assert.strictEqual((await chamar('GET', '/api/predio/prospectora/mapa', { headers: H })).json.etapas.length, 10);
      const li = (await chamar('GET', '/api/prospeccao', { headers: H })).json.find(x => x.id === ids[0]); assert.deepStrictEqual([li.etapa_id, li.etapa_nome], ['humano', 'Com você']);
      assert.strictEqual(B.respondeu(ids[1], 'Não tenho interesse, obrigado', null, seg('10:40'), { sorteio: () => 0 }).parar, true); await B.responder(seg('10:42')); assert.ok(env[env.length - 1].text.includes('não escrevo mais')); const pp = db.prepare('SELECT status, prox_contato, motivo_perda FROM prospects WHERE id = ?').get(ids[1]); assert.deepStrictEqual([pp.status, pp.prox_contato], ['perdido', null]); assert.ok(pp.motivo_perda.includes('não receber'));
      // dia seguinte: só quem não respondeu recebe o retorno do dia 1
      setSetting('bianca_prox', '0'); setSetting('bianca_mapeou_n_2026-12-22', '9');
      const d1 = await B.tick(Date.parse('2026-12-22T09:10:00-03:00'), { sorteio: () => 0 }); assert.ok(d1.enviado && d1.passo === 'd1' && d1.id === ids[3]); assert.ok(!env[env.length - 1].text.includes('não escrevo mais') && env[env.length - 1].text.includes('Auto 4'));
      assert.ok(!(await B.tick(Date.parse('2026-12-22T09:30:00-03:00'), { sorteio: () => 0 })).enviado);
    } finally { global.fetch = fo; const v = (k, x) => { if (x === undefined) delete process.env[k]; else process.env[k] = x; }; v('EVOLUTION_URL', eu); v('EVOLUTION_API_KEY', ek); v('WA_GAP_MS', gap); setSetting('bianca_auto', '0'); db.prepare("DELETE FROM prospects WHERE origem = 'bianca'").run(); db.prepare('DELETE FROM bianca_respostas').run(); }
    assert.strictEqual((await chamar('PUT', '/api/settings', { corpo: { bianca_meta: '99' }, headers: H })).status, 400);
    assert.strictEqual((await chamar('GET', '/api/predio/prospectora/auto', { headers: H })).json.ligada, false);
  });
  await t('Gerente: resumo com números de ontem e prioridades, aviso no celular; relógio roda uma vez por dia na hora certa', async () => {
    const sub = { endpoint: 'https://push.exemplo.com/gerente', keys: { p256dh: 'BChave', auth: 'segredo' } };
    await chamar('POST', '/api/push/assinar', { corpo: { assinatura: sub, aparelho: 'iPhone' }, headers: H }); pushes.length = 0;
    const ontem = Date.now() - 86400e3; const c = engine.upsertContato({ canal: 'instagram', extId: 'gr1' }); db.prepare('UPDATE contacts SET created_at = ?, needs_human = 1 WHERE id = ?').run(ontem, c.id);
    const r = predio.resumo(); assert.ok(r.texto.includes('📊 Ontem: '), r.texto); assert.ok(/🙋 \d+ pessoa\(s\) esperando atendente/.test(r.texto), r.texto); assert.ok(r.texto.includes('Prospectora'));
    await new Promise(z => setTimeout(z, 30)); assert.ok(pushes.some(x => x.titulo.startsWith('☀️ Helena: Resumo de') && x.url === '/#predio'), JSON.stringify(pushes));
    setSetting('predio_hora', '08:00');
    const base = Date.parse(predio.dataStr(Date.now()) + 'T07:59:00-03:00');
    setSetting('predio_dia', ''); assert.strictEqual(predio.tick(base), true, 'primeira vez: devia começar na hora, sem esperar');
    setSetting('predio_dia', '2020-01-01');
    assert.strictEqual(predio.tick(base), false, 'rodou antes da hora'); assert.strictEqual(predio.tick(base + 2 * 60e3), true); assert.strictEqual(predio.tick(base + 5 * 60e3), false, 'rodou duas vezes no dia');
    assert.strictEqual((await chamar('GET', '/api/predio')).status, 401);
    const vis = (await chamar('GET', '/api/predio', { headers: H })).json; assert.ok(vis.gerente.titulo.startsWith('Resumo de')); assert.ok(vis.conteudo.total === 5);
    await chamar('DELETE', '/api/push/aparelhos/' + (await chamar('GET', '/api/push', { headers: H })).json.aparelhos.find(a => a.aparelho === 'iPhone').id, { headers: H });
  });
  await t('notificações: assinar, escolher tipos, lead quente avisa uma vez, aparelho desinstalado é removido', async () => {
    const info = (await chamar('GET', '/api/push', { headers: H })).json; assert.ok(info.chave.length > 60); assert.ok(info.tipos.quantidade);
    assert.strictEqual((await chamar('POST', '/api/push/assinar', { corpo: { assinatura: { endpoint: 'http://x' } }, headers: H })).status, 400);
    const sub = { endpoint: 'https://push.exemplo.com/abc123', keys: { p256dh: 'BChave', auth: 'segredo' } };
    const a = (await chamar('POST', '/api/push/assinar', { corpo: { assinatura: sub, aparelho: 'iPhone (app)' }, headers: H })).json;
    const b = (await chamar('POST', '/api/push/assinar', { corpo: { assinatura: { ...sub, endpoint: 'https://push.exemplo.com/outro' }, aparelho: 'Android', prefs: ['venda'] }, headers: H })).json;
    notif._t.limpar(); pushes.length = 0;
    await engine.processarMensagem(msg('revender', { extId: 'pq1' }), rec()); await engine.processarMensagem(msg('20', { extId: 'pq1' }), rec());
    await engine.processarMensagem(msg('20', { extId: 'pq1' }), rec());   // repetiu: não avisa de novo
    await new Promise(r => setTimeout(r, 30));
    const q = pushes.filter(x => x.titulo.includes('Lead quente')); assert.strictEqual(q.length, 1, JSON.stringify(pushes)); assert.strictEqual(q[0].endpoint, sub.endpoint);
    assert.ok(q[0].titulo.includes('20 placas')); assert.ok(/^\/#c=\d+$/.test(q[0].url));
    // reabrir o painel reconfirma a assinatura sem perder as escolhas
    await chamar('PUT', '/api/push/aparelhos/' + a.id, { corpo: { prefs: ['alta'] }, headers: H });
    await chamar('POST', '/api/push/assinar', { corpo: { assinatura: sub, aparelho: 'iPhone (app)' }, headers: H });
    assert.deepStrictEqual((await chamar('GET', '/api/push', { headers: H })).json.aparelhos.find(x => x.id === a.id).prefs, ['alta']);
    pushes.length = 0; await engine.processarMensagem(msg('revender', { extId: 'pq2' }), rec()); await engine.processarMensagem(msg('100', { extId: 'pq2' }), rec());
    await new Promise(r => setTimeout(r, 30));
    assert.deepStrictEqual(pushes.map(x => x.endpoint), [sub.endpoint]); assert.ok(pushes[0].titulo.includes('Prioridade alta'));
    pushFalha = 410; await notif.notificar({ tipo: 'alta', titulo: 'x' }); pushFalha = null;
    assert.ok(!(await chamar('GET', '/api/push', { headers: H })).json.aparelhos.some(x => x.id === a.id), 'aparelho desinstalado continuou');
    await chamar('DELETE', '/api/push/aparelhos/' + b.id, { headers: H });
  });
  await t('painel instalável: manifest e service worker públicos', async () => {
    const m = await chamar('GET', '/manifest.webmanifest'); assert.strictEqual(m.status, 200); assert.strictEqual(m.json.display, 'standalone');
    const w = await chamar('GET', '/sw.js'); assert.strictEqual(w.status, 200); assert.ok(w.texto.includes('showNotification'));
    assert.strictEqual((await chamar('GET', '/api/push')).status, 401);
  });

  srv.close();
  console.log(`\n${ok} passaram, ${falhou} falharam`);
  process.exit(falhou ? 1 : 0);
})();
