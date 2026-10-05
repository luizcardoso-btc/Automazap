// Testes automáticos (sem internet, banco em memória):  npm test
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'senha-de-teste-123';
process.env.META_APP_SECRET = 'segredo-de-teste';
process.env.META_VERIFY_TOKEN = 'verificar-123';
process.env.NODE_ENV = 'test';
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
  await t('normaliza acento, caixa e pontuação', () => assert.strictEqual(engine.normalizar('  Qual o PREÇO?! '), 'qual o preco'));
  for (const frase of ['qual o preço?', 'Quanto custa a NexTap?', 'qual valor?', 'quero', 'NFC', 'Quero revender!', 'me passa o orçamento', 'PREÇOS']) {
    await t(`"${frase}" aciona um fluxo`, () => assert.ok(engine.acharFluxo(frase), 'nenhum fluxo'));
  }
  await t('preço/valor/quero levam ao fluxo de preço', () => ['qual o preço?', 'qual valor?', 'quero'].forEach(f => assert.strictEqual(engine.acharFluxo(f).name, 'Preço e como revender')));
  await t('NFC leva ao fluxo da placa', () => assert.strictEqual(engine.acharFluxo('NFC').name, 'Como funciona a placa NFC'));
  await t('frase mais específica vence', () => assert.strictEqual(engine.acharFluxo('quero saber como funciona').name, 'Como funciona a placa NFC'));
  await t('prioridade maior vence (nota fiscal)', () => assert.strictEqual(engine.acharFluxo('quanto custa com nota fiscal').name, 'Nota fiscal'));
  await t('não casa dentro de outra palavra', () => assert.strictEqual(engine.acharFluxo('inconfundivel'), null));
  await t('texto sem palavra-chave não aciona', () => assert.strictEqual(engine.acharFluxo('bom dia tudo bem'), null));
  await t('"preciso sair agora" NÃO aciona o fluxo de parar', () => assert.notStrictEqual((engine.acharFluxo('preciso sair agora') || {}).name, 'Parar mensagens'));
  await t('"sair" sozinho aciona o fluxo de parar', () => assert.strictEqual(engine.acharFluxo('sair').name, 'Parar mensagens'));

  console.log('Conversa');
  await t('responde com botão + respostas rápidas e troca {{site}}', async () => {
    const s = falso(); const r = await engine.processarMensagem(msg('qual o preço?'), s);
    assert.strictEqual(r.acao, 'respondeu'); assert.strictEqual(s.env.length, 2);
    assert.strictEqual(s.env[0].type, 'button'); assert.ok(s.env[0].buttons[0].url.startsWith('https://'));
    assert.ok(!JSON.stringify(s.env).includes('{{'), 'sobrou variável sem trocar');
    assert.strictEqual(s.env[1].type, 'quick');
  });
  await t('ignora o mesmo evento repetido (mesmo mid)', async () => {
    const s = falso(), ev = msg('preço'); await engine.processarMensagem(ev, s);
    const r = await engine.processarMensagem(ev, s); assert.strictEqual(r.motivo, 'duplicada'); assert.strictEqual(s.env.length, 2);
  });
  await t('resposta rápida abre o fluxo escolhido', async () => {
    const s = falso(), id = engine.acharFluxo('prazo').id;
    const r = await engine.processarMensagem(msg('Prazo e entrega', { payload: 'FLOW:' + id }), s);
    assert.strictEqual(r.fluxo, 'Prazo e entrega');
  });
  await t('atendente pausa o robô; próxima mensagem não é respondida', async () => {
    const s = falso(), u = msg('quero falar com atendente');
    await engine.processarMensagem(u, s);
    const c = db.prepare("SELECT * FROM contacts WHERE ext_id = ?").get(u.extId);
    assert.strictEqual(c.needs_human, 1); assert.ok(c.bot_paused_until > Date.now());
    const r = await engine.processarMensagem(msg('preço', { extId: u.extId }), s);
    assert.strictEqual(r.motivo, 'pausado');
  });
  await t('"sair" silencia a pessoa por muito tempo', async () => {
    const s = falso(), u = msg('sair'); await engine.processarMensagem(u, s);
    const r = await engine.processarMensagem(msg('preço', { extId: u.extId }), s); assert.strictEqual(r.motivo, 'pausado');
  });
  await t('resposta padrão só 1 vez por período', async () => {
    const s = falso(), id = 'fb1';
    const a = await engine.processarMensagem(msg('asdf qwer', { extId: id }), s);
    const b = await engine.processarMensagem(msg('zxcv uiop', { extId: id }), s);
    assert.strictEqual(a.fluxo, '(resposta padrão)'); assert.strictEqual(b.motivo, 'sem_fluxo'); assert.strictEqual(s.env.length, 1);
  });
  await t('limite de respostas por hora protege contra laço', async () => {
    setSetting('max_replies_hour', '3'); const s = falso(), id = 'lim1'; let ult;
    for (let i = 0; i < 4; i++) ult = await engine.processarMensagem(msg('preço', { extId: id }), s);
    assert.strictEqual(ult.motivo, 'limite_por_hora'); setSetting('max_replies_hour', '8');
  });
  await t('falha de envio é registrada e não derruba o robô', async () => {
    const ruim = { async send() { throw new Error('boom'); }, async sendPrivateReply() {} };
    const r = await engine.processarMensagem(msg('preço', { extId: 'erro1' }), ruim);
    assert.strictEqual(r.acao, 'respondeu');
    assert.ok(db.prepare("SELECT 1 FROM messages WHERE status = 'erro'").get());
  });
  await t('comentário com palavra-chave gera 1 mensagem privada em texto com o link', async () => {
    const s = falso(); const r = await engine.processarComentario({ canal: 'instagram', commentId: 'cm1', texto: 'quero!', fromId: 'c1', username: 'ana' }, s);
    assert.strictEqual(r.acao, 'respondeu'); assert.strictEqual(s.env.length, 1);
    assert.strictEqual(s.env[0].privada, 'cm1'); assert.ok(s.env[0].text.includes('https://'));
    const r2 = await engine.processarComentario({ canal: 'instagram', commentId: 'cm1', texto: 'quero!', fromId: 'c1' }, s);
    assert.strictEqual(r2.motivo, 'duplicada');
  });
  await t('comentário sem palavra-chave é ignorado', async () => {
    const r = await engine.processarComentario({ canal: 'instagram', commentId: 'cm2', texto: 'lindo demais', fromId: 'c2' }, falso());
    assert.strictEqual(r.motivo, 'sem_fluxo');
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
    assert.ok((await chamar('GET', '/api/flows', { headers: H })).json.length >= 6);
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
    'mais de 6 mensagens': { ...base, steps: Array(7).fill({ type: 'text', text: 'a' }) },
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
    assert.strictEqual(r.json.resultado.acao, 'respondeu'); assert.ok(r.json.respostas.length >= 2);
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
  await t('painel (HTML) é servido', async () => { const r = await chamar('GET', '/'); assert.strictEqual(r.status, 200); assert.ok(r.texto.includes('Automação de DMs')); });
  await t('cabeçalhos de segurança', async () => {
    const h = await new Promise(res => http.get({ port: porta, path: '/health' }, r => { r.resume(); res(r.headers); }));
    assert.strictEqual(h['x-content-type-options'], 'nosniff'); assert.ok(!h['x-powered-by']);
  });

  srv.close();
  console.log(`\n${ok} passaram, ${falhou} falharam`);
  process.exit(falhou ? 1 : 0);
})();
