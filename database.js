// Banco de dados SQLite.
//
// COMO OS DADOS FICAM SEGUROS
//  1. O arquivo do banco fica num Volume do Railway (fora do código). Deploy, commit e atualização do
//     backend NÃO tocam nele. (O arquivo *.db está no .gitignore, então nunca é sobrescrito pelo GitHub.)
//  2. Mudanças na estrutura (novas colunas/tabelas) entram como "migrações" numeradas, que só ADICIONAM.
//     Antes de aplicar qualquer migração, o sistema tira uma cópia do banco.
//  3. Cópia de segurança automática: 1 por dia (guarda as 14 mais recentes), na mesma pasta do Volume.
//  4. O painel admin tem o botão "Backup" para baixar uma cópia completa para o seu computador.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------- onde fica o arquivo ----------
const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH; // o Railway define sozinho quando há Volume
const dbFile =
  process.env.DB_PATH ||
  (volumePath ? path.join(volumePath, 'nextap.db') : path.join(__dirname, 'nextap.db'));
const naRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
// Sem Volume no Railway o disco é apagado a cada deploy — os dados NÃO ficam salvos.
const persistente = !!(process.env.DB_PATH || volumePath) || !naRailway;
const backupDir = path.join(path.dirname(dbFile), 'backups');

fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const bancoJaExistia = fs.existsSync(dbFile) && fs.statSync(dbFile).size > 0;

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = FULL'); // grava no disco antes de confirmar (mais seguro contra queda de energia/reinício)
db.pragma('busy_timeout = 5000');

// ---------- cópias de segurança (VACUUM INTO gera uma cópia consistente, mesmo com o banco em uso) ----------
function copiarPara(destino) {
  if (fs.existsSync(destino)) fs.unlinkSync(destino);
  db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  return destino;
}

function limparBackupsAntigos(prefixo, manter) {
  try {
    const arquivos = fs.readdirSync(backupDir).filter(f => f.startsWith(prefixo) && f.endsWith('.db')).sort().reverse();
    arquivos.slice(manter).forEach(f => fs.unlinkSync(path.join(backupDir, f)));
  } catch (e) { /* sem problema */ }
}

function backupDiario() {
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    const destino = path.join(backupDir, `nextap-${new Date().toISOString().slice(0, 10)}.db`);
    if (!fs.existsSync(destino)) {
      copiarPara(destino);
      console.log(`[DB] Backup diário criado: ${destino}`);
    }
    limparBackupsAntigos('nextap-', 14);
  } catch (e) {
    console.error('[DB] Falha no backup diário:', e.message);
  }
}

// Cópia temporária para o botão "Backup" do painel admin (quem chama apaga o arquivo depois).
function copiaTemporaria() {
  return copiarPara(path.join(os.tmpdir(), `nextap-backup-${Date.now()}.db`));
}

function listarBackups() {
  try {
    return fs.readdirSync(backupDir).filter(f => f.endsWith('.db')).map(f => {
      const st = fs.statSync(path.join(backupDir, f));
      return { nome: f, tamanho: st.size, criado_em: st.mtime.toISOString() };
    }).sort((x, y) => y.criado_em.localeCompare(x.criado_em));
  } catch (e) { return []; }
}

function contagens(conn = db) {
  const n = t => { try { return conn.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch (e) { return 0; } };
  return { revendedores: n('resellers'), pedidos: n('orders'), placas: n('plates'), vendas: n('sales'), leituras: n('plate_reads') };
}

// Cópia a cada vez que o sistema liga (cada deploy): se algo der errado numa atualização, há um ponto de volta recente.
function snapshotInicio() {
  try {
    const c = contagens();
    if (!c.revendedores && !c.pedidos) return;
    fs.mkdirSync(backupDir, { recursive: true });
    const recentes = listarBackups().filter(b => b.nome.startsWith('inicio-'));
    if (recentes[0] && Date.now() - new Date(recentes[0].criado_em).getTime() < 30 * 60 * 1000) return;
    const carimbo = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    copiarPara(path.join(backupDir, `inicio-${carimbo}.db`));
    limparBackupsAntigos('inicio-', 10);
  } catch (e) { console.error('[DB] Falha na cópia de início:', e.message); }
}

// ---------- restauração ----------
const esc = p => p.replace(/'/g, "''");

// Confere se o arquivo enviado é mesmo um backup do NexTap, sem mexer em nada.
function validarBackup(arquivo) {
  const buf = Buffer.alloc(16);
  const fd = fs.openSync(arquivo, 'r'); fs.readSync(fd, buf, 0, 16, 0); fs.closeSync(fd);
  if (buf.toString('utf8', 0, 15) !== 'SQLite format 3') throw new Error('O arquivo enviado não é um backup do NexTap (.db).');
  const t = new Database(arquivo, { readonly: true, fileMustExist: true });
  try {
    if (t.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('O arquivo de backup está corrompido.');
    const cols = t.prepare('PRAGMA table_info(resellers)').all().map(c => c.name);
    if (!cols.includes('email') || !cols.includes('password_hash')) throw new Error('Este arquivo não tem a tabela de revendedores do NexTap.');
    const versao = t.pragma('user_version', { simple: true });
    if (versao > MIGRACOES.length) throw new Error('Este backup é de uma versão mais nova do sistema. Atualize o sistema antes de restaurar.');
    return { versao, contagem: contagens(t) };
  } finally { t.close(); }
}

// modo "substituir": troca TODOS os dados pelos do backup. modo "revendedores": só acrescenta os revendedores
// (por e-mail) que existem no backup e não existem agora — não apaga nada.
// Antes de qualquer mudança, tira uma cópia de segurança do estado atual.
function restaurar(arquivo, modo) {
  const info = validarBackup(arquivo);
  const antes = contagens();
  fs.mkdirSync(backupDir, { recursive: true });
  const seguranca = path.join(backupDir, `antes-do-restore-${Date.now()}.db`);
  copiarPara(seguranca);
  limparBackupsAntigos('antes-do-restore-', 5);
  let acrescentados = 0;
  db.pragma('foreign_keys = OFF');
  db.exec(`ATTACH DATABASE '${esc(arquivo)}' AS bk`);
  try {
    db.transaction(() => {
      const colunas = (esquema, t) => db.prepare(`PRAGMA ${esquema}.table_info("${t}")`).all().map(c => c.name);
      if (modo === 'revendedores') {
        const noBk = colunas('bk', 'resellers');
        const cols = colunas('main', 'resellers').filter(c => c !== 'id' && noBk.includes(c));
        const lista = cols.map(c => `"${c}"`).join(',');
        acrescentados = db.prepare(`INSERT INTO main.resellers (${lista}) SELECT ${lista} FROM bk.resellers
          WHERE lower(email) NOT IN (SELECT lower(email) FROM main.resellers)`).run().changes;
        return;
      }
      const noBackup = new Set(db.prepare("SELECT name FROM bk.sqlite_master WHERE type='table'").all().map(r => r.name));
      const tabelas = db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
      for (const t of tabelas) {
        db.exec(`DELETE FROM main."${t}"`);
        if (!noBackup.has(t)) continue;
        const dele = new Set(colunas('bk', t));
        const cols = colunas('main', t).filter(c => dele.has(c));
        if (!cols.length) continue;
        const lista = cols.map(c => `"${c}"`).join(',');
        db.exec(`INSERT INTO main."${t}" (${lista}) SELECT ${lista} FROM bk."${t}"`);
      }
    })();
  } finally {
    try { db.exec('DETACH DATABASE bk'); } catch (e) { /* já solto */ }
    db.pragma('foreign_keys = ON');
  }
  if (modo !== 'revendedores' && db.prepare('SELECT COUNT(*) AS n FROM price_tiers').get().n === 0) gravarPrecos(PRECOS);
  console.log(`[DB] Restauração (${modo}) concluída. Cópia de segurança do estado anterior: ${seguranca}`);
  return { modo, acrescentados, antes, depois: contagens(), versao_backup: info.versao, copia_de_seguranca: path.basename(seguranca) };
}

// ---------- migrações (só ADICIONAM; nunca apagam dados) ----------
// Para mudar a estrutura no futuro: acrescente um novo item no FINAL da lista. Nunca edite os antigos.
// Exemplo:  db => db.exec("ALTER TABLE resellers ADD COLUMN cidade TEXT"),
const MIGRACOES = [
  // v1 — estrutura inicial. Usa IF NOT EXISTS: um banco criado antes deste sistema entra aqui sem perder nada.
  db => db.exec(`
CREATE TABLE IF NOT EXISTS resellers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  whatsapp TEXT,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS price_tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  min_qty INTEGER NOT NULL,
  max_qty INTEGER NOT NULL,
  unit_price REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id INTEGER NOT NULL REFERENCES resellers(id),
  qty_azul INTEGER NOT NULL DEFAULT 0,
  qty_preta INTEGER NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL,
  total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'aguardando_pagamento', -- aguardando_pagamento | pago (= pedido recebido) | em_producao | enviado | entregue | cancelado
  payment_method TEXT,          -- pix | credit_card
  mp_payment_id TEXT,           -- id do pagamento no Mercado Pago (Pix)
  mp_preference_id TEXT,        -- id da preferência no Mercado Pago (cartão / Checkout Pro)
  pix_qr_code TEXT,             -- copia e cola
  pix_qr_base64 TEXT,           -- imagem do QR em base64
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS plates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id INTEGER NOT NULL REFERENCES resellers(id),
  order_id INTEGER REFERENCES orders(id),
  code TEXT NOT NULL UNIQUE,        -- código único usado no QR/NFC
  color TEXT NOT NULL,              -- azul | preta
  status TEXT NOT NULL DEFAULT 'estoque', -- estoque | ativa
  client_name TEXT,
  plate_label TEXT,
  destination_type TEXT,
  destination_url TEXT,
  cost REAL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plate_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plate_id INTEGER NOT NULL REFERENCES plates(id),
  read_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id INTEGER NOT NULL REFERENCES resellers(id),
  plate_id INTEGER REFERENCES plates(id),
  client_name TEXT NOT NULL,
  value REAL NOT NULL,
  cost REAL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`),
  // v2 — endereço de entrega no pedido + endereço padrão salvo no revendedor (só adiciona colunas).
  db => db.exec(`
    ALTER TABLE orders ADD COLUMN ship_name TEXT;
    ALTER TABLE orders ADD COLUMN ship_phone TEXT;
    ALTER TABLE orders ADD COLUMN ship_cep TEXT;
    ALTER TABLE orders ADD COLUMN ship_street TEXT;
    ALTER TABLE orders ADD COLUMN ship_number TEXT;
    ALTER TABLE orders ADD COLUMN ship_complement TEXT;
    ALTER TABLE orders ADD COLUMN ship_district TEXT;
    ALTER TABLE orders ADD COLUMN ship_city TEXT;
    ALTER TABLE orders ADD COLUMN ship_state TEXT;
    ALTER TABLE resellers ADD COLUMN addr_cep TEXT;
    ALTER TABLE resellers ADD COLUMN addr_street TEXT;
    ALTER TABLE resellers ADD COLUMN addr_number TEXT;
    ALTER TABLE resellers ADD COLUMN addr_complement TEXT;
    ALTER TABLE resellers ADD COLUMN addr_district TEXT;
    ALTER TABLE resellers ADD COLUMN addr_city TEXT;
    ALTER TABLE resellers ADD COLUMN addr_state TEXT;
  `),
  // v3 — links de redefinição de senha (só o hash do token fica guardado).
  db => db.exec(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reseller_id INTEGER NOT NULL REFERENCES resellers(id),
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_password_resets_hash ON password_resets(token_hash);
  `),
  // v4 — código de rastreio da placa (#00001), único, impresso na frente da placa. Só adiciona.
  db => db.exec(`
    ALTER TABLE plates ADD COLUMN tracking_code TEXT;
    UPDATE plates SET tracking_code = '#' || printf('%05d', id) WHERE tracking_code IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_plates_tracking ON plates(tracking_code);
    CREATE INDEX IF NOT EXISTS idx_reads_plate ON plate_reads(plate_id, read_at);
  `),
  // v5 — país no endereço do revendedor (Minha conta). Só adiciona.
  db => db.exec(`ALTER TABLE resellers ADD COLUMN addr_country TEXT;`),
  // v6 — situação do pagamento: conferência no Mercado Pago, confirmação manual e registro de notificações. Só adiciona.
  db => db.exec(`
    ALTER TABLE orders ADD COLUMN paid_manually INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN payment_note TEXT;
    ALTER TABLE orders ADD COLUMN mp_status TEXT;
    ALTER TABLE orders ADD COLUMN mp_checked_at TEXT;
    ALTER TABLE orders ADD COLUMN checkout_url TEXT;
    CREATE TABLE IF NOT EXISTS payment_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      origem TEXT, payment_id TEXT, order_id INTEGER, mp_status TEXT, resultado TEXT, detalhe TEXT
    );
  `),
  // v7 — nova tabela de preços (pedido mínimo de 5 placas): 5–10 = R$ 21,90 · 11–49 = R$ 17,50 · 50–299 = R$ 16,50 · 300+ = R$ 15,90.
  db => {
    db.exec('DELETE FROM price_tiers');
    const ins = db.prepare('INSERT INTO price_tiers (min_qty, max_qty, unit_price) VALUES (?, ?, ?)');
    [[5, 10, 21.9], [11, 49, 17.5], [50, 299, 16.5], [300, 1000000, 15.9]].forEach(p => ins.run(p[0], p[1], p[2]));
  },
  // v8 — andamento do pedido depois de pago: produção, envio com código de rastreio dos Correios e entrega. Só adiciona.
  db => db.exec(`
    ALTER TABLE orders ADD COLUMN producao_at TEXT;
    ALTER TABLE orders ADD COLUMN enviado_at TEXT;
    ALTER TABLE orders ADD COLUMN entregue_at TEXT;
    ALTER TABLE orders ADD COLUMN tracking_code TEXT;
    ALTER TABLE orders ADD COLUMN shipping_service TEXT;
    CREATE INDEX IF NOT EXISTS idx_orders_tracking ON orders(tracking_code);
  `),
  // vFRETE — frete fixo por pedido (valor editável no admin) e o frete cobrado em cada pedido. Só adiciona.
  db => db.exec(`
    CREATE TABLE IF NOT EXISTS settings (chave TEXT PRIMARY KEY, valor TEXT NOT NULL);
    INSERT OR IGNORE INTO settings (chave, valor) VALUES ('frete_fixo', '20.00');
    ALTER TABLE orders ADD COLUMN shipping_fee REAL NOT NULL DEFAULT 0;
  `),
  // v10 — nova tabela de preços: 5–10 R$21,90 · 11–49 R$18,90 · 50–99 R$17,90 · 100–299 R$16,90 · 300+ R$15,90.
  db => {
    db.exec('DELETE FROM price_tiers');
    const ins = db.prepare('INSERT INTO price_tiers (min_qty, max_qty, unit_price) VALUES (?, ?, ?)');
    [[5, 10, 21.9], [11, 49, 18.9], [50, 99, 17.9], [100, 299, 16.9], [300, 1000000, 15.9]].forEach(p => ins.run(p[0], p[1], p[2]));
  },
  // v11 — fornecedores, estoque, despesas, custos e taxas para o financeiro (lucro estimado). Só adiciona.
  db => db.exec(`
    CREATE TABLE IF NOT EXISTS fornecedores (
      id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, contato TEXT, observacao TEXT,
      ativo INTEGER NOT NULL DEFAULT 1, criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS estoque_mov (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT NOT NULL, fornecedor_id INTEGER, data TEXT NOT NULL,
      quantidade INTEGER NOT NULL, custo_unit REAL, custo_extra REAL NOT NULL DEFAULT 0, observacao TEXT,
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_estoque_data ON estoque_mov(data);
    CREATE TABLE IF NOT EXISTS despesas (
      id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, descricao TEXT NOT NULL, categoria TEXT,
      valor REAL NOT NULL, mensal INTEGER NOT NULL DEFAULT 0, criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );
    ALTER TABLE orders ADD COLUMN custo_frete_real REAL;
    ALTER TABLE orders ADD COLUMN mp_fee REAL;
    ALTER TABLE orders ADD COLUMN mp_net REAL;
    INSERT OR IGNORE INTO settings (chave, valor) VALUES ('custo_placa', '13.50');
    INSERT OR IGNORE INTO settings (chave, valor) VALUES ('icms_pct', '1.00');
    INSERT OR IGNORE INTO settings (chave, valor) VALUES ('icms_base_frete', '1');
    INSERT OR IGNORE INTO settings (chave, valor) VALUES ('taxa_pix_pct', '0.99');
    INSERT OR IGNORE INTO settings (chave, valor) VALUES ('taxa_cartao_pct', '4.98');
    INSERT OR IGNORE INTO settings (chave, valor) VALUES ('custo_envio_padrao', '0.00');
    INSERT OR IGNORE INTO settings (chave, valor) VALUES ('estoque_minimo', '50');
    INSERT OR IGNORE INTO settings (chave, valor) VALUES ('custo_usar_medio', '0');
  `),
];

const versaoAtual = db.pragma('user_version', { simple: true });
if (versaoAtual < MIGRACOES.length) {
  const temTabelas = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n > 0;
  if (bancoJaExistia && temTabelas) {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      const snap = path.join(backupDir, `antes-da-migracao-v${versaoAtual}-${Date.now()}.db`);
      copiarPara(snap);
      limparBackupsAntigos('antes-da-migracao-', 5);
      console.log(`[DB] Cópia de segurança antes de atualizar a estrutura: ${snap}`);
    } catch (e) {
      console.error('[DB] Não consegui copiar antes da migração:', e.message);
    }
  }
  for (let v = versaoAtual; v < MIGRACOES.length; v++) {
    db.transaction(() => {
      MIGRACOES[v](db);
      db.pragma(`user_version = ${v + 1}`);
    })();
    console.log(`[DB] Estrutura atualizada para a versão ${v + 1}.`);
  }
}

// Tabela de preços oficial (o site lê esta mesma tabela). Usada na primeira criação do banco.
// O pedido mínimo é o começo da primeira faixa.
const PRECOS = [
  [5, 10, 21.9],
  [11, 49, 18.9],
  [50, 99, 17.9],
  [100, 299, 16.9],
  [300, 1000000, 15.9],
];
// Tabela antiga que era criada por padrão nas primeiras versões.
const PRECOS_ANTIGOS = [[1, 1, 25], [2, 49, 20], [50, 299, 17], [300, 1000000, 15]];

const gravarPrecos = db.transaction(lista => {
  db.prepare('DELETE FROM price_tiers').run();
  const insert = db.prepare('INSERT INTO price_tiers (min_qty, max_qty, unit_price) VALUES (?, ?, ?)');
  lista.forEach(p => insert.run(p[0], p[1], p[2]));
});

const atuais = db.prepare('SELECT min_qty, max_qty, unit_price FROM price_tiers ORDER BY min_qty').all();
if (atuais.length === 0) {
  gravarPrecos(PRECOS);
} else {
  // Banco já existente: só troca se ainda estiver com a tabela antiga (não sobrescreve preços editados no admin).
  const iguaisAosAntigos = atuais.length === PRECOS_ANTIGOS.length &&
    atuais.every((t, i) => t.min_qty === PRECOS_ANTIGOS[i][0] && t.max_qty === PRECOS_ANTIGOS[i][1] && t.unit_price === PRECOS_ANTIGOS[i][2]);
  if (iguaisAosAntigos) gravarPrecos(PRECOS);
}


// ---------- resumo no log + backup ao ligar ----------
const resumo = {
  revendedores: db.prepare('SELECT COUNT(*) AS n FROM resellers').get().n,
  pedidos: db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,
  placas: db.prepare('SELECT COUNT(*) AS n FROM plates').get().n,
};
console.log(`[DB] Arquivo: ${dbFile} | dados persistentes: ${persistente ? 'SIM' : 'NÃO'} | ` +
  `revendedores: ${resumo.revendedores}, pedidos: ${resumo.pedidos}, placas: ${resumo.placas}`);
if (!persistente) {
  console.error('[DB] ⚠️  ATENÇÃO: sem Volume no Railway, os dados serão APAGADOS a cada deploy/reinício. ' +
    'Crie um Volume (montado em /data) e conecte ao serviço NEXTAP.');
}
const integridade = db.pragma('quick_check', { simple: true });
if (integridade !== 'ok') console.error('[DB] ⚠️  Verificação de integridade falhou:', integridade);
snapshotInicio();
backupDiario();
setInterval(backupDiario, 6 * 60 * 60 * 1000).unref();

// Frete fixo por pedido (R$). Lido a cada pedido, então mudar no admin vale na hora.
db.freteFixo = () => {
  const r = db.prepare("SELECT valor FROM settings WHERE chave='frete_fixo'").get();
  const v = r ? Number(r.valor) : 0;
  return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : 0;
};
// Configurações numéricas (custos, taxas…) guardadas na tabela settings.
db.cfg = (chave, padrao = 0) => {
  const r = db.prepare('SELECT valor FROM settings WHERE chave = ?').get(chave);
  const v = r ? Number(r.valor) : NaN;
  return Number.isFinite(v) ? v : padrao;
};
db.setCfg = (chave, valor) => db.prepare('INSERT INTO settings (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor').run(chave, String(valor));
db.meta = { arquivo: dbFile, persistente, backupDir };
db.copiaTemporaria = copiaTemporaria;
db.listarBackups = listarBackups;
db.contagens = contagens;
db.restaurar = restaurar;
db.integridade = () => db.pragma('quick_check', { simple: true });

module.exports = db;
