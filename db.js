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
];

const versaoAtual = db.pragma('user_version', { simple: true });
for (let v = versaoAtual; v < MIGRACOES.length; v++) {
  db.transaction(() => { MIGRACOES[v](db); db.pragma(`user_version = ${v + 1}`); })();
}

const SETTINGS_PADRAO = {
  site_url: process.env.SITE_URL || 'https://www.nextapbrasil.com.br',
  telefone: '75 988209055',
  public_url: process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : ''),
  video_demo_url: '',
  followups_enabled: '1',
  fallback_enabled: '1',
  fallback_text: 'Oi! 👋 Sou o assistente automático da NexTap. Digite PREÇO para ver como revender, NFC para saber como a placa funciona ou ATENDENTE para falar com uma pessoa.',
  fallback_cooldown_hours: '24',
  handoff_hours: '12',
  max_replies_hour: '30',
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
