// Sala do CEO (Luiz): checklist do dia. A Helena (Gerente geral) monta a lista do que você precisa FAZER e APROVAR,
// e cada item se marca sozinho quando você faz/aprova no painel (ou no celular, no caso das conversas).
// Você também pode marcar à mão e criar tarefas suas.
const { db, getSetting } = require('./db.js');

db.exec(`CREATE TABLE IF NOT EXISTS ceo_check (id INTEGER PRIMARY KEY AUTOINCREMENT, dia TEXT NOT NULL, chave TEXT NOT NULL, titulo TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'fazer', area TEXT NOT NULL DEFAULT '', acao TEXT NOT NULL DEFAULT '', auto INTEGER NOT NULL DEFAULT 1,
  feito_em INTEGER, feito_por TEXT NOT NULL DEFAULT '', criado_em INTEGER NOT NULL, UNIQUE(dia, chave))`);

const DIA = 86400e3, FUSO = 3 * 3600e3;
const dataStr = t => new Date(t - FUSO).toISOString().slice(0, 10);
const dia0 = t => Math.floor((t - FUSO) / DIA) * DIA + FUSO;
const n = (sql, ...a) => { try { return db.prepare(sql).get(...a).n || 0; } catch (e) { return 0; } };

// O que está pendente AGORA (cada item tem uma chave fixa: some da lista = feito)
function pendencias(t0 = Date.now()) {
  const P = require('./predio.js'), N = P.nomes(), L = [];
  const add = (chave, titulo, tipo, area, acao) => L.push({ chave, titulo, tipo, area, acao });
  // ---- aprovar ----
  try {
    const pc = P.pecasDoDia(t0), ok = pc.filter(x => x.status === 'aprovado');
    if (ok.length) add('mkt_imagens', `Aprovar as imagens de ${ok.length} peça(s) de hoje (o ${N.social} só publica depois)`, 'aprovar', 'Marketing', "pdSala('social')");
  } catch (e) { /* sem marketing */ }
  const rasc = n("SELECT COUNT(*) AS n FROM conteudo WHERE dia = ? AND status = 'rascunho'", dataStr(t0));
  if (rasc) add('video_hoje', `Aprovar o vídeo de hoje do ${N.conteudo}`, 'aprovar', 'Marketing', "pdSala('conteudo')");
  try {
    for (const t of require('./routes-api.js').resultadosAB().filter(x => x.b_ativo && x.confianca >= 95))
      add('ab_' + t.b_id, `Escolher a vencedora do teste A/B "${t.a_nome}"`, 'aprovar', 'Funil', "nav('flows')");
  } catch (e) { /* sem A/B */ }
  // ---- fazer ----
  try { const W = require('./whatsapp.js'), cx = W.conexaoCache(); if (W.configurado() && cx.ok === false) add('wa_conexao', 'Reconectar o WhatsApp (ler o QR Code em WhatsApp → Conexão): a Jade e a Bianca estão paradas', 'fazer', 'Sistema', "WT='conexao';nav('wa')"); } catch (e) { /* sem WhatsApp */ }
  if (getSetting('ig_conexao_erro')) add('ig_token', 'Trocar o token do Instagram no Railway (o robô está parado)', 'fazer', 'Sistema', "nav('ig')");
  const esperando = n("SELECT COUNT(*) AS n FROM contacts WHERE channel = 'instagram' AND needs_human = 1");
  if (esperando) add('ig_humano', `Responder ${esperando} pessoa(s) esperando atendente no Instagram`, 'fazer', 'Atendimento', "irChats('humano')");
  try {   // conversas do WhatsApp que a Bianca passou para você e ainda estão sem a sua resposta
    for (const b of db.prepare("SELECT b.contato_id, b.tipo, c.nome, c.jid FROM bianca_balcao b JOIN wa_contatos c ON c.id = b.contato_id WHERE b.etapa = 'humano' AND b.em > ?").all(t0 - 2 * DIA)) {
      const ult = db.prepare("SELECT origem FROM wa_mensagens WHERE contato_id = ? AND direcao = 'out' ORDER BY id DESC LIMIT 1").get(b.contato_id);
      if (ult && ['celular', 'painel'].includes(ult.origem)) continue;
      const quem = b.nome || '+' + String(b.jid).split('@')[0], o = { varejo: 'pedido de varejo', perso: 'placa personalizada', atacado: 'revenda' }[b.tipo] || 'conversa';
      add('wa_' + b.contato_id, `Responder ${quem} no WhatsApp (${o})`, 'fazer', 'WhatsApp · ' + N.balcao, `nav('wa')`);
    }
  } catch (e) { /* sem WhatsApp */ }
  try {   // empresas da prospecção que responderam e estão com você
    const hum = db.prepare("SELECT id, nome FROM prospects WHERE etapa IN ('humano','fechamento') AND status NOT IN ('fechado','perdido') AND etapa_em > ?").all(t0 - 3 * DIA);
    for (const p of hum) add('jade_' + p.id, `Atender ${p.nome} (a ${N.prospectora} passou para você)`, 'fazer', 'Prospecção · ' + N.prospectora, "nav('pros')");
  } catch (e) { /* sem prospecção */ }
  const naoEnt = n("SELECT COUNT(*) AS n FROM nao_entendidas WHERE status = 'nova'");
  if (naoEnt) add('ensinar_sofia', `Ensinar ${naoEnt} frase(s) que a ${N.atendente} não entendeu`, 'fazer', 'Atendimento', "pdSala('atendente')");
  const perg = n('SELECT COUNT(*) AS n FROM bianca_perguntas');
  if (perg) add('ensinar_bianca', `Ensinar ${perg} pergunta(s) que a ${N.balcao} não soube responder`, 'fazer', 'WhatsApp · ' + N.balcao, "WT='conexao';nav('wa')");
  try {
    const l = P.listaDeHoje(t0), falta = l ? l.itens.filter(i => !i.feito).length : 0;
    if (falta) add('lista_jade', `Lista da ${N.prospectora}: ${falta} contato(s) de hoje para fazer`, 'fazer', 'Prospecção · ' + N.prospectora, "nav('pros')");
  } catch (e) { /* sem lista */ }
  try {
    const rf = P.resumoFin(JSON.parse(getSetting('nextap_fin') || 'null'));
    if (rf && rf.parados) add('pedidos_parados', `Produzir e enviar ${rf.parados} pedido(s) pago(s) parado(s) há 3 dias ou mais`, 'fazer', 'Finanças', "pdSala('financeiro')");
  } catch (e) { /* sem financeiro */ }
  return L;
}

// Sincroniza o checklist de hoje: entra o que apareceu, marca feito o que saiu da lista (e reabre se voltar)
function sincronizar(t0 = Date.now()) {
  const hoje = dataStr(t0), atual = pendencias(t0), chaves = new Set(atual.map(x => x.chave));
  const ins = db.prepare(`INSERT INTO ceo_check (dia, chave, titulo, tipo, area, acao, auto, criado_em) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(dia, chave) DO UPDATE SET titulo = excluded.titulo, feito_em = CASE WHEN ceo_check.feito_por = 'voce' THEN ceo_check.feito_em ELSE NULL END,
      feito_por = CASE WHEN ceo_check.feito_por = 'voce' THEN 'voce' ELSE '' END`);
  db.transaction(() => {
    for (const x of atual) ins.run(hoje, x.chave, x.titulo, x.tipo, x.area, x.acao, t0);
    for (const r of db.prepare('SELECT id, chave FROM ceo_check WHERE dia = ? AND auto = 1 AND feito_em IS NULL').all(hoje))
      if (!chaves.has(r.chave)) db.prepare("UPDATE ceo_check SET feito_em = ?, feito_por = 'sistema' WHERE id = ?").run(t0, r.id);
  })();
}

function checklist(t0 = Date.now(), dia) {
  dia = dia || dataStr(t0);
  if (dia === dataStr(t0)) { try { sincronizar(t0); } catch (e) { console.error('[CEO] checklist:', e.message); } }
  const itens = db.prepare('SELECT * FROM ceo_check WHERE dia = ? ORDER BY (feito_em IS NOT NULL), CASE tipo WHEN \'aprovar\' THEN 0 WHEN \'fazer\' THEN 1 ELSE 2 END, id').all(dia);
  const feitos = itens.filter(i => i.feito_em).length;
  const ontem = dataStr(dia0(t0) - DIA), o = db.prepare('SELECT COUNT(*) AS t, SUM(feito_em IS NOT NULL) AS f FROM ceo_check WHERE dia = ?').get(ontem);
  return { dia, itens, total: itens.length, feitos, pct: itens.length ? Math.round((100 * feitos) / itens.length) : 100, ontem: { total: o.t || 0, feitos: o.f || 0 } };
}
function marcar(id, feito, t0 = Date.now()) {
  const r = db.prepare('SELECT * FROM ceo_check WHERE id = ?').get(id); if (!r) return null;
  db.prepare('UPDATE ceo_check SET feito_em = ?, feito_por = ? WHERE id = ?').run(feito ? t0 : null, feito ? 'voce' : '', id);
  return db.prepare('SELECT * FROM ceo_check WHERE id = ?').get(id);
}
function tarefa(titulo, t0 = Date.now()) {
  const t = String(titulo || '').trim().slice(0, 200); if (!t) throw new Error('Escreva a tarefa.');
  return db.prepare("INSERT INTO ceo_check (dia, chave, titulo, tipo, area, auto, criado_em) VALUES (?, ?, ?, 'manual', 'Minhas tarefas', 0, ?)").run(dataStr(t0), 'manual_' + t0 + '_' + Math.floor(Math.random() * 1e6), t, t0).lastInsertRowid;
}
const apagar = id => db.prepare('DELETE FROM ceo_check WHERE id = ? AND auto = 0').run(id).changes > 0;

// Bloco do relatório da Helena (Prédio e WhatsApp)
function textoRelatorio(t0 = Date.now()) {
  const c = checklist(t0), ab = c.itens.filter(i => !i.feito_em);
  const ap = ab.filter(i => i.tipo === 'aprovar'), fz = ab.filter(i => i.tipo !== 'aprovar');
  const L = [];
  if (ap.length) L.push('📝 *Para aprovar:*', ...ap.map(i => '• ' + i.titulo), '');
  if (fz.length) L.push('✅ *Para fazer:*', ...fz.map(i => '• ' + i.titulo), '');
  if (!ab.length) L.push('✅ Nada pendente para você agora. Bom trabalho!', '');
  if (c.ontem.total) L.push(`📋 Checklist de ontem: ${c.ontem.feitos} de ${c.ontem.total} concluído(s).`);
  return { texto: L.join('\n').trim(), abertos: ab.length, aprovar: ap.length, fazer: fz.length };
}

module.exports = { pendencias, sincronizar, checklist, marcar, tarefa, apagar, textoRelatorio };
