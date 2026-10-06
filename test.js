// Testes automáticos (sem internet, banco em memória):  npm test
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'senha-de-teste-123';
process.env.META_APP_SECRET = 'segredo-de-teste';
process.env.META_VERIFY_TOKEN = 'verificar-123';
process.env.NODE_ENV = 'test';
process.env.STEP_DELAY_MS = '0';
process.env.CLICK_DELAY_MS = '0';
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
    assert.deepStrictEqual(env, ['text', 'text', 'button']);
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
  await t('não manda para quem comprou, tem intenção de compra, não é revendedor ou está com humano', async () => {
    const ids = [novoLead('fu3', ['REVENDEDOR', 'ABRIU CHECKOUT', 'VENDA']), novoLead('fu4', ['REVENDEDOR', 'ABRIU CHECKOUT', 'INTENÇÃO DE COMPRA']), novoLead('fu5', ['MEU NEGÓCIO', 'ABRIU CHECKOUT']), novoLead('fu6')];
    db.prepare('UPDATE contacts SET needs_human = 1 WHERE id = ?').run(ids[3]);
    const s = rec(); await engine.tick(s, { agoraMs: Date.now() + 4 * H1 }); ids.forEach(i => assert.strictEqual(enviosDe(s, i).length, 0));
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
    assert.strictEqual(r.fluxo, 'Resposta a um follow-up'); const c = contatoDe('fu9'); assert.strictEqual(c.needs_human, 1); assert.strictEqual(c.followup_step, 0);
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
  await t('cabeçalhos de segurança', async () => {
    const h = await new Promise(res => http.get({ port: porta, path: '/health' }, r => { r.resume(); res(r.headers); }));
    assert.strictEqual(h['x-content-type-options'], 'nosniff'); assert.ok(!h['x-powered-by']);
  });

  srv.close();
  console.log(`\n${ok} passaram, ${falhou} falharam`);
  process.exit(falhou ? 1 : 0);
})();
