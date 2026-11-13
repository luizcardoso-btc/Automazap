// Banco SQLite (arquivo único). No Railway, conecte um Volume ao serviço: o caminho é detectado sozinho.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const emMemoria = process.env.DB_PATH === ':memory:';
const dataDir = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH
  || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
const arquivo = emMemoria ? ':memory:' : (process.env.DB_PATH || path.join(dataDir, 'automacao.db'));
if (!emMemoria) fs.mkdirSync(path.dirname(arquivo), { recursive: true });

// Sem Volume no Railway, o disco é apagado a cada deploy.
const persistente = !process.env.RAILWAY_ENVIRONMENT || !!(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR);

const db = new Database(arquivo);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Migrações só-aditivas: nunca apagam dados. Para mudar o banco no futuro, acrescente uma função no fim da lista.
const MIGRACOES = [
  db => db.exec(`
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,                 -- 'instagram' (depois: 'whatsapp'); 'sim' = simulador
      ext_id TEXT NOT NULL,                  -- id da pessoa naquele canal
      username TEXT,
      name TEXT,
      needs_human INTEGER NOT NULL DEFAULT 0,
      bot_paused_until INTEGER NOT NULL DEFAULT 0,   -- ms; enquanto for futuro o robô não responde
      last_inbound_at INTEGER NOT NULL DEFAULT 0,    -- ms; base da janela de 24h do Instagram
      created_at INTEGER NOT NULL,
      UNIQUE (channel, ext_id)
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES contacts(id),
      direction TEXT NOT NULL,               -- 'in' | 'out'
      kind TEXT NOT NULL DEFAULT 'texto',    -- texto | botao | rapidas | fallback | comentario | manual
      text TEXT,
      flow_id INTEGER,
      status TEXT NOT NULL DEFAULT 'ok',     -- ok | erro
      error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_messages_contact ON messages(contact_id, id);
    CREATE TABLE flows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      match_mode TEXT NOT NULL DEFAULT 'contem',   -- contem | exato | comeca
      keywords TEXT NOT NULL DEFAULT '[]',         -- JSON: ["preço","quanto custa"]
      on_comment INTEGER NOT NULL DEFAULT 0,       -- também responde comentários (mensagem privada)
      action TEXT,                                 -- null | 'handoff' | 'silenciar'
      steps TEXT NOT NULL DEFAULT '[]',            -- JSON: mensagens enviadas em sequência
      created_at INTEGER NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE processed (id TEXT PRIMARY KEY, at INTEGER NOT NULL);  -- evita responder duas vezes ao mesmo evento
  `),
  // v2: funil (etiquetas, prioridade humana), links rastreados, agenda de envios e follow-ups
  db => db.exec(`
    ALTER TABLE contacts ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';           -- JSON: etapas do funil
    ALTER TABLE contacts ADD COLUMN human_priority INTEGER NOT NULL DEFAULT 0; -- 0 nenhuma | 1 normal | 2 alta
    ALTER TABLE contacts ADD COLUMN followup_step INTEGER NOT NULL DEFAULT 0;  -- quantos follow-ups já foram enviados
    ALTER TABLE contacts ADD COLUMN last_click_at INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE flows ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal';          -- normal | evento | followup
    ALTER TABLE flows ADD COLUMN event TEXT;                                   -- evento: 'clique_link'
    ALTER TABLE flows ADD COLUMN delay_hours REAL NOT NULL DEFAULT 0;          -- followup: horas após a última mensagem da pessoa
    ALTER TABLE flows ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';              -- etiquetas aplicadas quando o fluxo é enviado
    ALTER TABLE flows ADD COLUMN human_priority INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE flows ADD COLUMN comment_text TEXT;                            -- texto alternativo ao responder comentário
    CREATE TABLE links (
      token TEXT PRIMARY KEY,
      contact_id INTEGER NOT NULL REFERENCES contacts(id),
      url TEXT NOT NULL,
      clicks INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_click_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE agenda (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES contacts(id),
      flow_id INTEGER NOT NULL,
      run_at INTEGER NOT NULL,
      done INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_agenda_due ON agenda(done, run_at);
    UPDATE settings SET value = '30' WHERE key = 'max_replies_hour' AND value = '8';  -- o funil novo envia mais mensagens por conversa
  `),
  // v3: prospecção de empresas locais (busca no Google, funil de vendas e histórico de contatos)
  db => db.exec(`
    CREATE TABLE prospects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, place_id TEXT, nome TEXT NOT NULL, segmento TEXT NOT NULL DEFAULT '', contato TEXT NOT NULL DEFAULT '',
      telefone TEXT NOT NULL DEFAULT '', instagram TEXT NOT NULL DEFAULT '', endereco TEXT NOT NULL DEFAULT '', bairro TEXT NOT NULL DEFAULT '',
      nota REAL, avaliacoes INTEGER NOT NULL DEFAULT 0, site TEXT NOT NULL DEFAULT '', maps_url TEXT NOT NULL DEFAULT '', lat REAL, lng REAL,
      origem TEXT NOT NULL DEFAULT 'manual', obs TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'novo', prox_contato TEXT,
      motivo_perda TEXT NOT NULL DEFAULT '', criado_em TEXT NOT NULL DEFAULT (datetime('now')), atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_prospects_place ON prospects(place_id) WHERE place_id IS NOT NULL;
    CREATE INDEX idx_prospects_status ON prospects(status, prox_contato);
    CREATE TABLE prospect_hist (
      id INTEGER PRIMARY KEY AUTOINCREMENT, prospect_id INTEGER NOT NULL, tipo TEXT NOT NULL DEFAULT 'nota', texto TEXT NOT NULL DEFAULT '',
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_prospect_hist ON prospect_hist(prospect_id, id);
  `),
  // v4: follow-ups por etapa do funil, sem recomeçar a sequência a cada mensagem.
  // Só cria o que falta: bancos que rodaram a primeira versão desta mudança (como "v3") já têm as colunas.
  db => {
    const tem = (tabela, col) => db.prepare(`PRAGMA table_info(${tabela})`).all().some(c => c.name === col);
    if (!tem('flows', 'audience')) db.exec('ALTER TABLE flows ADD COLUMN audience TEXT');              // followup: checkout | revenda_qtd | revenda_preco | negocio
    if (!tem('contacts', 'followup_seq')) db.exec('ALTER TABLE contacts ADD COLUMN followup_seq TEXT'); // sequência (etapa) em que a pessoa está
    if (!tem('contacts', 'last_followup_at')) db.exec('ALTER TABLE contacts ADD COLUMN last_followup_at INTEGER NOT NULL DEFAULT 0');
    db.exec(`
      UPDATE flows SET audience = 'checkout' WHERE kind = 'followup' AND audience IS NULL;
      UPDATE contacts SET followup_seq = 'checkout' WHERE followup_step > 0 AND followup_seq IS NULL;
      CREATE INDEX IF NOT EXISTS idx_messages_flow ON messages(flow_id, contact_id, created_at);
    `);
  },
  // v5: WhatsApp (Evolution API) — conversas com empresas e disparos programados. Separado do Instagram de propósito.
  db => db.exec(`
    CREATE TABLE IF NOT EXISTS wa_contatos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL UNIQUE,                    -- 5575988887777@s.whatsapp.net ou id do grupo (@g.us)
      nome TEXT NOT NULL DEFAULT '',
      grupo INTEGER NOT NULL DEFAULT 0,
      prospect_id INTEGER,                         -- empresa da Prospecção com o mesmo telefone
      ultimo_in INTEGER NOT NULL DEFAULT 0,        -- ms
      ultimo_out INTEGER NOT NULL DEFAULT 0,
      nao_lidas INTEGER NOT NULL DEFAULT 0,
      criado_em INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wa_mensagens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contato_id INTEGER NOT NULL REFERENCES wa_contatos(id),
      direcao TEXT NOT NULL,                       -- in | out
      origem TEXT NOT NULL DEFAULT 'painel',       -- cliente | painel | celular | disparo
      texto TEXT NOT NULL DEFAULT '',
      midia_url TEXT,
      status TEXT NOT NULL DEFAULT 'ok',           -- ok | erro
      erro TEXT,
      wa_id TEXT,                                  -- id da mensagem no WhatsApp (evita duplicar)
      criado_em INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wa_msg ON wa_mensagens(contato_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_msg_waid ON wa_mensagens(wa_id) WHERE wa_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS wa_disparos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL DEFAULT '',
      alvo_jid TEXT NOT NULL,
      alvo_nome TEXT NOT NULL DEFAULT '',
      texto TEXT NOT NULL DEFAULT '',
      midia_url TEXT,
      hora TEXT NOT NULL,                          -- HH:MM (horário de Brasília)
      data TEXT,                                   -- AAAA-MM-DD, só para envio único
      dias TEXT NOT NULL DEFAULT '[]',             -- repetir: [0..6] (0 = domingo); vazio = envio único
      ativo INTEGER NOT NULL DEFAULT 1,
      proximo_em INTEGER,                          -- ms do próximo envio (null = nada pendente)
      ultimo_em INTEGER NOT NULL DEFAULT 0,
      ultimo_erro TEXT,
      enviados INTEGER NOT NULL DEFAULT 0,
      criado_em INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wa_disparos ON wa_disparos(ativo, proximo_em);
  `),
];

const versaoAtual = db.pragma('user_version', { simple: true });
for (let v = versaoAtual; v < MIGRACOES.length; v++) {
  db.transaction(() => { MIGRACOES[v](db); db.pragma(`user_version = ${v + 1}`); })();
}

// Rede de segurança: garante as tabelas da prospecção mesmo que a versão do banco já esteja "adiantada" (ex.: arquivos subidos fora de ordem).
db.exec(`
  CREATE TABLE IF NOT EXISTS prospects (
    id INTEGER PRIMARY KEY AUTOINCREMENT, place_id TEXT, nome TEXT NOT NULL, segmento TEXT NOT NULL DEFAULT '', contato TEXT NOT NULL DEFAULT '',
    telefone TEXT NOT NULL DEFAULT '', instagram TEXT NOT NULL DEFAULT '', endereco TEXT NOT NULL DEFAULT '', bairro TEXT NOT NULL DEFAULT '',
    nota REAL, avaliacoes INTEGER NOT NULL DEFAULT 0, site TEXT NOT NULL DEFAULT '', maps_url TEXT NOT NULL DEFAULT '', lat REAL, lng REAL,
    origem TEXT NOT NULL DEFAULT 'manual', obs TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'novo', prox_contato TEXT,
    motivo_perda TEXT NOT NULL DEFAULT '', criado_em TEXT NOT NULL DEFAULT (datetime('now')), atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_place ON prospects(place_id) WHERE place_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects(status, prox_contato);
  CREATE TABLE IF NOT EXISTS prospect_hist (
    id INTEGER PRIMARY KEY AUTOINCREMENT, prospect_id INTEGER NOT NULL, tipo TEXT NOT NULL DEFAULT 'nota', texto TEXT NOT NULL DEFAULT '',
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_prospect_hist ON prospect_hist(prospect_id, id);
`);

const SETTINGS_PADRAO = {
  site_url: process.env.SITE_URL || 'https://www.nextapbrasil.com.br',
  telefone: '75 988209055',
  public_url: process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : ''),
  video_demo_url: '',
  followups_enabled: '1',
  brand_name: 'NexTap',
  brand_tagline: 'Atendimento automático no Instagram',
  brand_color: '#15803d',
  logo_data: '',
  logo_v: '0',
  fallback_enabled: '1',
  fallback_text: 'Oi! 👋 Sou o assistente automático da NexTap. Digite PREÇO para ver como revender, NFC para saber como a placa funciona ou ATENDENTE para falar com uma pessoa.',
  fallback_cooldown_hours: '24',
  handoff_hours: '12',
  max_replies_hour: '30',
  wa_max_novos_dia: '30',      // WhatsApp: primeiras mensagens para números que nunca responderam, por dia (protege o número de bloqueio)
};
const insSet = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
Object.entries(SETTINGS_PADRAO).forEach(([k, v]) => insSet.run(k, v));

const getSetting = k => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) || {}).value;
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
const allSettings = () => Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));

// Cópia diária (7 últimas) ao lado do banco. Protege de erro, não de apagar o Volume: baixe também pelo painel.
const dirBackup = path.join(path.dirname(arquivo), 'backups');
function backupAgora() {
  if (emMemoria) return null;
  fs.mkdirSync(dirBackup, { recursive: true });
  const destino = path.join(dirBackup, `automacao-${new Date().toISOString().slice(0, 10)}.db`);
  if (!fs.existsSync(destino)) db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  fs.readdirSync(dirBackup).filter(f => f.startsWith('automacao-')).sort().reverse().slice(7).forEach(f => fs.unlinkSync(path.join(dirBackup, f)));
  return destino;
}
function limparAntigos() {
  db.prepare('DELETE FROM processed WHERE at < ?').run(Date.now() - 7 * 86400e3);
}

module.exports = { db, persistente, arquivo, getSetting, setSetting, allSettings, backupAgora, limparAntigos };
