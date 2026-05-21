const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');

const STREAMER_PASSWORD = process.env.STREAMER_PASSWORD || 'satelitteOrion';
const PORT = Number(process.env.PORT) || 3000;
const BUILD_TIME = new Date().toISOString();
const WORLD_W = 2400;
const WORLD_H = 1350;
const BASE_X = WORLD_W / 2;
const BASE_Y = WORLD_H / 2;
const BASE_PERIMETER = 560;
const TURRET_X = BASE_X;
const TURRET_Y = BASE_Y;
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;

const ACTION_TICK_MS = 10 * 1000;
const ACTION_MAX_DURATION_MS = 60 * 60 * 1000;
const HISTORY_LIMIT = 10;

const WAVE_CHECK_INTERVAL_MS = 60 * 1000;
const WAVE_PROBABILITY = 0.35;
const WAVE_WARNING_MS = 10 * 1000;
const ENEMY_SPEED = 70;
const ENEMY_MIN = 3;
const ENEMY_MAX = 6;
const ENEMY_LEVELS_AVAILABLE = [1];

const CATEGORIES = ['PUISSANCE', 'DEFENSIF', 'UTILITAIRE'];
const CATEGORY_TO_COLUMN = { PUISSANCE: 'puissance', DEFENSIF: 'defensif', UTILITAIRE: 'utilitaire' };

// ============ Templates d'éléments (instanciés par Amiral) ============

const TURRET_ACTIONS = [
  { id: 'tir',        label: 'Améliorer Tir',   category: 'PUISSANCE' },
  { id: 'visee',      label: 'Améliorer Visée', category: 'PUISSANCE' },
  { id: 'reparation', label: 'Réparation',      category: 'DEFENSIF'  }
];
const BASE_ACTIONS = [
  { id: 'reparation', label: 'Réparation', category: 'DEFENSIF'   },
  { id: 'remplir',    label: 'Remplir',    category: 'UTILITAIRE' }
];
const MINING_ACTION = [{ id: 'minage', label: 'Minage', category: 'UTILITAIRE' }];

const ASTEROID_HP_MAX     = 240;
const ASTEROID_RESPAWN_MS = 20 * 60 * 1000;
const TURRET_HP_MAX       = 200;
const BASE_HP_MAX         = 400;
const BASE_ESSENCE_MAX    = 400;

function poly(angleRad, dist) {
  return { x: Math.round(BASE_X + Math.cos(angleRad) * dist), y: Math.round(BASE_Y + Math.sin(angleRad) * dist) };
}
const TURRET_D = 260;
const ASTEROID_D = 470;
const ASTEROID_VARIANT_COUNT = 15;

const ELEMENT_TEMPLATES = (() => {
  const list = [
    { id: 'base-1', type: 'base', x: BASE_X, y: BASE_Y, label: 'BASE', actions: BASE_ACTIONS },
  ];
  const turretAngles = [-Math.PI/2, Math.PI*5/6, Math.PI/6];
  const turretLabels = ['TOURELLE NORD', 'TOURELLE SO', 'TOURELLE SE'];
  turretAngles.forEach((a, i) => {
    const p = poly(a, TURRET_D);
    list.push({ id: `turret-${i + 1}`, type: 'turret', x: p.x, y: p.y, label: turretLabels[i], actions: TURRET_ACTIONS });
  });
  const subtypes = ['materiaux', 'radius'];
  const scales = [1.0, 1.1, 1.2, 0.9, 1.0, 0.95, 1.0, 1.05];
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const p = poly(angle, ASTEROID_D);
    const subtype = subtypes[i % 2];
    list.push({
      id: `asteroid-${i}`,
      type: 'asteroid',
      subtype,
      x: p.x, y: p.y, scale: scales[i],
      label: `ASTÉROÏDE (${subtype})`,
      actions: MINING_ACTION
    });
  }
  return list;
})();

function buildElementsForAmiral() {
  return ELEMENT_TEMPLATES.map(t => {
    const el = { ...t };
    if (el.type === 'asteroid') {
      el.variant = String(1 + Math.floor(Math.random() * ASTEROID_VARIANT_COUNT)).padStart(2, '0');
    }
    return el;
  });
}

function initStateFor(el) {
  if (el.type === 'base') {
    return { hp: BASE_HP_MAX, hpMax: BASE_HP_MAX, essence: BASE_ESSENCE_MAX, essenceMax: BASE_ESSENCE_MAX };
  }
  if (el.type === 'turret') {
    return { hp: TURRET_HP_MAX, hpMax: TURRET_HP_MAX, puissance: 0, range: 0 };
  }
  if (el.type === 'asteroid') {
    return { hp: ASTEROID_HP_MAX, hpMax: ASTEROID_HP_MAX, subtype: el.subtype, destroyedAt: null, respawnsAt: null };
  }
  return {};
}

// ============ DB schema ============

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'voidfaction.db'));
db.pragma('journal_mode = WAL');

// Détection migration : si la table users existe SANS amiral_id, on reset (changement de contrat).
function needsReset() {
  const usersExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (!usersExists) return false;
  const cols = db.prepare("PRAGMA table_info(users)").all();
  return !cols.find(c => c.name === 'amiral_id');
}

if (needsReset()) {
  console.log('[migration] Refonte Amiraux : reset des utilisateurs et tables liées.');
  db.exec(`
    DROP TABLE IF EXISTS active_actions;
    DROP TABLE IF EXISTS user_progress;
    DROP TABLE IF EXISTS action_log;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS users;
  `);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS amirals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    grid_x INTEGER NOT NULL,
    grid_y INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS amiral_sessions (
    token TEXT PRIMARY KEY,
    amiral_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (amiral_id) REFERENCES amirals(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    amiral_id INTEGER NOT NULL,
    FOREIGN KEY (amiral_id) REFERENCES amirals(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS user_progress (
    user_id INTEGER PRIMARY KEY,
    puissance INTEGER NOT NULL DEFAULT 0,
    defensif INTEGER NOT NULL DEFAULT 0,
    utilitaire INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS active_actions (
    user_id INTEGER PRIMARY KEY,
    element_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    category TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    last_settled_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS action_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    amiral_id INTEGER NOT NULL,
    element_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    category TEXT NOT NULL,
    event_type TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_action_log_time ON action_log (at DESC);
  CREATE INDEX IF NOT EXISTS idx_action_log_amiral ON action_log (amiral_id, at DESC);
`);
db.prepare("INSERT OR IGNORE INTO state (key, value) VALUES ('resource', '0')").run();

// Prepared statements
const stmtGetState           = db.prepare('SELECT value FROM state WHERE key = ?');
const stmtSetState           = db.prepare('UPDATE state SET value = ? WHERE key = ?');

const stmtInsertAmiral       = db.prepare('INSERT INTO amirals (username, password_hash, created_at, grid_x, grid_y) VALUES (?, ?, ?, ?, ?)');
const stmtGetAmiralByName    = db.prepare('SELECT id, username, password_hash, grid_x, grid_y FROM amirals WHERE username = ?');
const stmtGetAmiralById      = db.prepare('SELECT id, username, grid_x, grid_y FROM amirals WHERE id = ?');
const stmtAllAmirals         = db.prepare('SELECT id, username, grid_x, grid_y FROM amirals');
const stmtAmiralGridUsed     = db.prepare('SELECT 1 AS x FROM amirals WHERE grid_x = ? AND grid_y = ?');
const stmtInsertAmiralSess   = db.prepare('INSERT INTO amiral_sessions (token, amiral_id, created_at) VALUES (?, ?, ?)');
const stmtGetAmiralSess      = db.prepare('SELECT amiral_id FROM amiral_sessions WHERE token = ?');
const stmtDeleteAmiralSess   = db.prepare('DELETE FROM amiral_sessions WHERE token = ?');

const stmtInsertUser         = db.prepare('INSERT INTO users (username, password_hash, created_at, amiral_id) VALUES (?, ?, ?, ?)');
const stmtGetUserByName      = db.prepare('SELECT id, username, password_hash, amiral_id FROM users WHERE username = ?');
const stmtGetUserById        = db.prepare('SELECT id, username, amiral_id FROM users WHERE id = ?');
const stmtInsertSession      = db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)');
const stmtGetSession         = db.prepare('SELECT user_id FROM sessions WHERE token = ?');
const stmtDeleteSession      = db.prepare('DELETE FROM sessions WHERE token = ?');

const stmtEnsureProgress = db.prepare('INSERT OR IGNORE INTO user_progress (user_id) VALUES (?)');
const stmtGetProgress    = db.prepare('SELECT puissance, defensif, utilitaire, total FROM user_progress WHERE user_id = ?');
const stmtIncPuissance   = db.prepare('UPDATE user_progress SET puissance = puissance + ?, total = total + ? WHERE user_id = ?');
const stmtIncDefensif    = db.prepare('UPDATE user_progress SET defensif  = defensif  + ?, total = total + ? WHERE user_id = ?');
const stmtIncUtilitaire  = db.prepare('UPDATE user_progress SET utilitaire = utilitaire + ?, total = total + ? WHERE user_id = ?');

const stmtGetActiveAction  = db.prepare('SELECT user_id, element_id, action_id, category, started_at, last_settled_at FROM active_actions WHERE user_id = ?');
const stmtAllActiveActions = db.prepare(`
  SELECT a.user_id, a.element_id, a.action_id, a.category, a.started_at, a.last_settled_at, u.amiral_id, u.username
  FROM active_actions a JOIN users u ON u.id = a.user_id
`);
const stmtUpsertActiveAction = db.prepare(`
  INSERT INTO active_actions (user_id, element_id, action_id, category, started_at, last_settled_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    element_id = excluded.element_id,
    action_id = excluded.action_id,
    category = excluded.category,
    started_at = excluded.started_at,
    last_settled_at = excluded.last_settled_at
`);
const stmtDeleteActiveAction = db.prepare('DELETE FROM active_actions WHERE user_id = ?');
const stmtUpdateLastSettled  = db.prepare('UPDATE active_actions SET last_settled_at = ? WHERE user_id = ?');
const stmtActiveOnElement    = db.prepare('SELECT a.user_id, a.action_id, a.category FROM active_actions a JOIN users u ON u.id = a.user_id WHERE a.element_id = ? AND u.amiral_id = ?');

const stmtInsertActionLog   = db.prepare('INSERT INTO action_log (user_id, username, amiral_id, element_id, action_id, category, event_type, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const stmtRecentActionLog   = db.prepare("SELECT username, element_id, action_id, category, event_type, at FROM action_log WHERE event_type = 'activate' AND amiral_id = ? ORDER BY at DESC LIMIT ?");
const stmtActiveElementsBy  = db.prepare(`
  SELECT a.element_id, a.action_id, a.category, u.username
  FROM active_actions a JOIN users u ON u.id = a.user_id
  WHERE u.amiral_id = ?
`);

const getResource = () => parseInt(stmtGetState.get('resource').value, 10);
const setResource = (n) => stmtSetState.run(String(n), 'resource');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}
function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}
function userFromToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const row = stmtGetSession.get(token);
  if (!row) return null;
  return stmtGetUserById.get(row.user_id) || null;
}
function amiralFromToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const row = stmtGetAmiralSess.get(token);
  if (!row) return null;
  return stmtGetAmiralById.get(row.amiral_id) || null;
}

// ============ Runtime par Amiral ============

// Map<amiral_id, AmiralRuntime>
const amiralsRuntime = new Map();

function getOrCreateAmiralRuntime(amiral) {
  let rt = amiralsRuntime.get(amiral.id);
  if (rt) return rt;
  const elements = buildElementsForAmiral();
  const elementStates = new Map();
  for (const el of elements) elementStates.set(el.id, initStateFor(el));
  rt = {
    id: amiral.id,
    username: amiral.username,
    gridX: amiral.grid_x,
    gridY: amiral.grid_y,
    socketId: null,
    online: false,
    ship: { x: WORLD_W / 2, y: WORLD_H / 2 + 230, rotation: 0 },
    elements,
    elementById: Object.fromEntries(elements.map(e => [e.id, e])),
    elementStates,
    factionResources: { materiaux: 0, radius: 0 },
    currentWave: null
  };
  amiralsRuntime.set(amiral.id, rt);
  return rt;
}

// Précharge tous les amiraux (élements en mémoire dès le boot)
for (const a of stmtAllAmirals.all()) getOrCreateAmiralRuntime(a);

// Runtime de démo (uniquement en mémoire, pas en DB) : sert de fallback pour les
// visiteurs anonymes quand aucun Amiral n'est inscrit. Permet d'avoir une vue
// non-vide même au démarrage.
let demoRuntime = null;
function getDemoRuntime() {
  if (demoRuntime) return demoRuntime;
  const elements = buildElementsForAmiral();
  const elementStates = new Map();
  for (const el of elements) elementStates.set(el.id, initStateFor(el));
  demoRuntime = {
    id: 0,
    username: 'DEMO',
    gridX: 0, gridY: 0,
    socketId: null,
    online: false,
    ship: { x: WORLD_W / 2, y: WORLD_H / 2 + 230, rotation: 0 },
    elements,
    elementById: Object.fromEntries(elements.map(e => [e.id, e])),
    elementStates,
    factionResources: { materiaux: 0, radius: 0 },
    currentWave: null
  };
  return demoRuntime;
}

function publicElementState(rt, id) {
  const s = rt.elementStates.get(id);
  if (!s) return null;
  return { id, ...s };
}
function allElementStates(rt) {
  return rt.elements.map(e => publicElementState(rt, e.id));
}
function activeElementStatesForAmiral(amiralId) {
  return stmtActiveElementsBy.all(amiralId);
}
function recentHistoryForAmiral(amiralId) {
  return stmtRecentActionLog.all(amiralId, HISTORY_LIMIT).map(r => ({
    username: r.username,
    element_id: r.element_id,
    action_id: r.action_id,
    category: r.category,
    at: r.at
  }));
}

function amiralRoom(amiralId) { return `amiral-${amiralId}`; }

function getOnlineAmiralsList() {
  const out = [];
  for (const rt of amiralsRuntime.values()) {
    if (rt.online) out.push({ name: rt.username });
  }
  return out;
}

// Allocation de case en spirale : cherche la plus proche du centre non utilisée
function nextFreeGridCell() {
  const used = new Set(stmtAllAmirals.all().map(a => `${a.grid_x},${a.grid_y}`));
  // Spirale carrée : on parcourt les anneaux r = 0, 1, 2, ...
  for (let r = 0; r < 1000; r++) {
    if (r === 0) {
      if (!used.has('0,0')) return { x: 0, y: 0 };
      continue;
    }
    const cells = [];
    // top row (y = -r)
    for (let x = -r; x <= r; x++) cells.push([x, -r]);
    // right col (x = r, y from -r+1 to r)
    for (let y = -r + 1; y <= r; y++) cells.push([r, y]);
    // bottom row (y = r, x from r-1 down to -r)
    for (let x = r - 1; x >= -r; x--) cells.push([x, r]);
    // left col (x = -r, y from r-1 down to -r+1)
    for (let y = r - 1; y >= -r + 1; y--) cells.push([-r, y]);
    for (const [x, y] of cells) {
      if (!used.has(`${x},${y}`)) return { x, y };
    }
  }
  return null;
}

// ============ HTTP / Socket ============

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

app.get('/api/amiraux', (_req, res) => {
  res.json({ amiraux: getOnlineAmiralsList() });
});

app.post('/api/amiral/signup', (req, res) => {
  const { username, password, masterCode } = req.body || {};
  if (typeof masterCode !== 'string' || masterCode !== STREAMER_PASSWORD) {
    return res.status(403).json({ ok: false, error: 'Code maître incorrect' });
  }
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return res.status(400).json({ ok: false, error: 'Pseudo invalide (3-20 caractères, alphanumériques)' });
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
    return res.status(400).json({ ok: false, error: 'Mot de passe : 6 caractères minimum' });
  }
  const existing = stmtGetAmiralByName.get(username);
  if (existing) return res.status(409).json({ ok: false, error: 'Ce pseudo Amiral est déjà pris' });
  const cell = nextFreeGridCell();
  if (!cell) return res.status(503).json({ ok: false, error: 'Plus de cases disponibles' });
  try {
    const info = stmtInsertAmiral.run(username, hashPassword(password), Date.now(), cell.x, cell.y);
    const amiral = stmtGetAmiralById.get(info.lastInsertRowid);
    getOrCreateAmiralRuntime(amiral);
    const token = newToken();
    stmtInsertAmiralSess.run(token, amiral.id, Date.now());
    res.json({ ok: true, token, username, gridX: cell.x, gridY: cell.y });
  } catch (e) {
    console.error('[amiral signup] erreur:', e?.code || '', e?.message || e);
    res.status(500).json({ ok: false, error: 'Erreur serveur: ' + (e?.code || e?.message || 'inconnue') });
  }
});

app.post('/api/amiral/login', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ ok: false, error: 'Identifiants manquants' });
  }
  const amiral = stmtGetAmiralByName.get(username);
  if (!amiral || !verifyPassword(password, amiral.password_hash)) {
    return res.status(401).json({ ok: false, error: 'Identifiants incorrects' });
  }
  getOrCreateAmiralRuntime(amiral);
  const token = newToken();
  stmtInsertAmiralSess.run(token, amiral.id, Date.now());
  res.json({ ok: true, token, username: amiral.username, gridX: amiral.grid_x, gridY: amiral.grid_y });
});

app.post('/api/amiral/logout', (req, res) => {
  const { token } = req.body || {};
  if (typeof token === 'string') stmtDeleteAmiralSess.run(token);
  res.json({ ok: true });
});

app.post('/api/signup', (req, res) => {
  const { username, password, amiralName } = req.body || {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return res.status(400).json({ ok: false, error: 'Pseudo invalide (3-20 caractères, alphanumériques)' });
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
    return res.status(400).json({ ok: false, error: 'Mot de passe : 6 caractères minimum' });
  }
  if (typeof amiralName !== 'string' || !amiralName) {
    return res.status(400).json({ ok: false, error: 'Choisis un Amiral à rejoindre' });
  }
  const amiral = stmtGetAmiralByName.get(amiralName);
  if (!amiral) return res.status(400).json({ ok: false, error: 'Amiral inconnu' });
  const rt = amiralsRuntime.get(amiral.id);
  if (!rt || !rt.online) return res.status(409).json({ ok: false, error: 'Cet Amiral n\'est pas en ligne' });
  const existing = stmtGetUserByName.get(username);
  if (existing) return res.status(409).json({ ok: false, error: 'Ce pseudo est déjà pris' });
  try {
    const info = stmtInsertUser.run(username, hashPassword(password), Date.now(), amiral.id);
    stmtEnsureProgress.run(info.lastInsertRowid);
    const token = newToken();
    stmtInsertSession.run(token, info.lastInsertRowid, Date.now());
    res.json({ ok: true, token, username, amiralName: amiral.username });
  } catch (e) {
    console.error('[signup] erreur:', e?.code || '', e?.message || e);
    res.status(500).json({ ok: false, error: 'Erreur serveur: ' + (e?.code || e?.message || 'inconnue') });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ ok: false, error: 'Identifiants manquants' });
  }
  const user = stmtGetUserByName.get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ ok: false, error: 'Identifiants incorrects' });
  }
  stmtEnsureProgress.run(user.id);
  const token = newToken();
  stmtInsertSession.run(token, user.id, Date.now());
  res.json({ ok: true, token, username: user.username });
});

app.post('/api/logout', (req, res) => {
  const { token } = req.body || {};
  if (typeof token === 'string') stmtDeleteSession.run(token);
  res.json({ ok: true });
});

const server = http.createServer(app);
const io = new Server(server);

io.use((socket, next) => {
  const auth = socket.handshake.auth || {};
  // Tentative d'auth Amiral via amiralToken
  if (typeof auth.amiralToken === 'string' && auth.amiralToken) {
    const amiral = amiralFromToken(auth.amiralToken);
    if (amiral) {
      socket.data.amiralId = amiral.id;
      socket.data.amiralUsername = amiral.username;
    }
  }
  // Tentative d'auth Joueur via token
  if (typeof auth.token === 'string' && auth.token) {
    const user = userFromToken(auth.token);
    if (user) {
      socket.data.userId = user.id;
      socket.data.username = user.username;
      socket.data.userAmiralId = user.amiral_id;
    }
  }
  next();
});

const socketsByUser = new Map();

function broadcastAmiraux() {
  io.emit('amirals:update', { amiraux: getOnlineAmiralsList() });
}

io.on('connection', (socket) => {
  let amiralIdForRoom = null;

  if (socket.data.amiralId) {
    const rt = amiralsRuntime.get(socket.data.amiralId);
    if (rt) {
      // Si un autre socket pilote déjà cet Amiral, on kick l'ancien
      if (rt.socketId && rt.socketId !== socket.id) {
        const prev = io.sockets.sockets.get(rt.socketId);
        if (prev) {
          prev.data.amiralId = null;
          prev.emit('streamer:kicked');
        }
      }
      rt.socketId = socket.id;
      rt.online = true;
      socket.join(amiralRoom(rt.id));
      amiralIdForRoom = rt.id;
      broadcastAmiraux();
    }
  } else if (socket.data.userId && socket.data.userAmiralId) {
    socket.join(amiralRoom(socket.data.userAmiralId));
    amiralIdForRoom = socket.data.userAmiralId;
    if (!socketsByUser.has(socket.data.userId)) socketsByUser.set(socket.data.userId, new Set());
    socketsByUser.get(socket.data.userId).add(socket);
  }

  const userActiveAction = socket.data.userId ? stmtGetActiveAction.get(socket.data.userId) : null;
  const userProgress = socket.data.userId ? getProgressFor(socket.data.userId) : null;

  // 1) Amiral connecté -> son propre monde
  // 2) Joueur affilié -> monde de son Amiral
  // 3) Visiteur anonyme / joueur non-affilié -> premier Amiral en ligne, sinon premier en DB
  let rtForInit = socket.data.amiralId
    ? amiralsRuntime.get(socket.data.amiralId)
    : (socket.data.userAmiralId ? amiralsRuntime.get(socket.data.userAmiralId) : null);
  if (!rtForInit) {
    for (const rt of amiralsRuntime.values()) { if (rt.online) { rtForInit = rt; break; } }
  }
  if (!rtForInit) {
    rtForInit = amiralsRuntime.values().next().value || null;
  }
  if (!rtForInit) {
    rtForInit = getDemoRuntime();
  }
  // Le visiteur anonyme rejoint la room de l'Amiral observé pour voir les events en live
  // (sauf demo runtime qui n'a pas de room dédiée)
  if (rtForInit && rtForInit.id !== 0 && !socket.data.amiralId && !socket.data.userAmiralId) {
    socket.join(amiralRoom(rtForInit.id));
  }

  socket.emit('init', {
    resource: getResource(),
    ship: rtForInit ? rtForInit.ship : null,
    user: socket.data.userId ? { username: socket.data.username } : null,
    amiral: socket.data.amiralId ? { username: socket.data.amiralUsername, gridX: rtForInit?.gridX, gridY: rtForInit?.gridY } : null,
    history: rtForInit ? recentHistoryForAmiral(rtForInit.id) : [],
    elements: rtForInit ? rtForInit.elements : [],
    elementStates: rtForInit ? allElementStates(rtForInit) : [],
    factionResources: rtForInit ? { ...rtForInit.factionResources } : { materiaux: 0, radius: 0 },
    activeAction: userActiveAction || null,
    actionDurationMs: ACTION_MAX_DURATION_MS,
    actionTickMs: ACTION_TICK_MS,
    progress: userProgress,
    activeElements: rtForInit ? activeElementStatesForAmiral(rtForInit.id) : [],
    world: { width: WORLD_W, height: WORLD_H, baseX: BASE_X, baseY: BASE_Y, basePerimeter: BASE_PERIMETER, turretX: TURRET_X, turretY: TURRET_Y },
    currentWave: rtForInit && rtForInit.currentWave && rtForInit.currentWave.endsAt > Date.now() ? rtForInit.currentWave : null,
    buildTime: BUILD_TIME
  });

  socket.on('action:activate', (data, cb) => {
    const respond = (payload) => { if (typeof cb === 'function') cb(payload); };
    const uid = socket.data.userId;
    if (!uid) return respond({ ok: false, error: 'auth' });
    const amiralId = socket.data.userAmiralId;
    const rt = amiralsRuntime.get(amiralId);
    if (!rt) return respond({ ok: false, error: 'amiral inconnu' });
    if (!rt.online) return respond({ ok: false, error: 'amiral hors-ligne' });
    const elementId = String(data?.elementId || '');
    const actionId = String(data?.actionId || '');
    const el = rt.elementById[elementId];
    if (!el) return respond({ ok: false, error: 'element inconnu' });
    const action = el.actions.find(a => a.id === actionId);
    if (!action) return respond({ ok: false, error: 'action inconnue' });
    const st = rt.elementStates.get(elementId);
    if (st && el.type === 'asteroid' && st.hp <= 0) {
      return respond({ ok: false, error: 'asteroïde détruit (respawn en cours)' });
    }

    const now = Date.now();
    const prev = stmtGetActiveAction.get(uid);
    if (prev) {
      settleAction(prev, now, rt);
      stmtInsertActionLog.run(uid, socket.data.username, amiralId, prev.element_id, prev.action_id, prev.category, 'deactivate', now);
    }

    stmtUpsertActiveAction.run(uid, elementId, actionId, action.category, now, now);
    stmtInsertActionLog.run(uid, socket.data.username, amiralId, elementId, actionId, action.category, 'activate', now);

    const newAction = stmtGetActiveAction.get(uid);
    const progress = getProgressFor(uid);

    io.to(amiralRoom(amiralId)).emit('elements:update', { activeElements: activeElementStatesForAmiral(amiralId) });
    io.to(amiralRoom(amiralId)).emit('history:new', { username: socket.data.username, element_id: elementId, action_id: actionId, category: action.category, at: now });
    socket.emit('action:state', { activeAction: newAction, progress });
    respond({ ok: true });
  });

  socket.on('action:deactivate', (_, cb) => {
    const respond = (payload) => { if (typeof cb === 'function') cb(payload); };
    const uid = socket.data.userId;
    if (!uid) return respond({ ok: false, error: 'auth' });
    const amiralId = socket.data.userAmiralId;
    const rt = amiralsRuntime.get(amiralId);
    const prev = stmtGetActiveAction.get(uid);
    if (!prev) return respond({ ok: true });
    const now = Date.now();
    if (rt) settleAction(prev, now, rt);
    stmtDeleteActiveAction.run(uid);
    stmtInsertActionLog.run(uid, socket.data.username, amiralId, prev.element_id, prev.action_id, prev.category, 'deactivate', now);
    const progress = getProgressFor(uid);
    if (amiralId) io.to(amiralRoom(amiralId)).emit('elements:update', { activeElements: activeElementStatesForAmiral(amiralId) });
    socket.emit('action:state', { activeAction: null, progress });
    respond({ ok: true });
  });

  socket.on('streamer:ship', (data) => {
    if (!socket.data.amiralId) return;
    const rt = amiralsRuntime.get(socket.data.amiralId);
    if (!rt) return;
    if (typeof data?.x !== 'number' || typeof data?.y !== 'number' || typeof data?.rotation !== 'number') return;
    if (!Number.isFinite(data.x) || !Number.isFinite(data.y) || !Number.isFinite(data.rotation)) return;
    rt.ship.x = Math.max(0, Math.min(WORLD_W, data.x));
    rt.ship.y = Math.max(0, Math.min(WORLD_H, data.y));
    rt.ship.rotation = data.rotation;
    socket.broadcast.to(amiralRoom(rt.id)).emit('ship', rt.ship);
  });

  socket.on('disconnect', () => {
    if (socket.data.amiralId) {
      const rt = amiralsRuntime.get(socket.data.amiralId);
      if (rt && rt.socketId === socket.id) {
        rt.socketId = null;
        rt.online = false;
        broadcastAmiraux();
      }
    }
    if (socket.data.userId) {
      const set = socketsByUser.get(socket.data.userId);
      if (set) {
        set.delete(socket);
        if (set.size === 0) socketsByUser.delete(socket.data.userId);
      }
    }
  });
});

// ============ Logique d'effet ============

function applyActionEffect(rt, actionId, element) {
  const state = rt.elementStates.get(element.id);
  if (!state) return false;
  if (element.type === 'asteroid' && state.hp <= 0) return false;

  switch (actionId) {
    case 'tir':
      state.puissance = (state.puissance || 0) + 1;
      return true;
    case 'visee':
      state.range = (state.range || 0) + 1;
      return true;
    case 'reparation':
      if (state.hp >= state.hpMax) return false;
      state.hp = Math.min(state.hp + 1, state.hpMax);
      return true;
    case 'remplir':
      if (state.essence >= state.essenceMax) return false;
      state.essence = Math.min(state.essence + 1, state.essenceMax);
      return true;
    case 'minage':
      state.hp = Math.max(0, state.hp - 1);
      if (state.subtype === 'materiaux') rt.factionResources.materiaux += 1;
      else if (state.subtype === 'radius') rt.factionResources.radius += 1;
      if (state.hp <= 0) destroyAsteroid(rt, element.id);
      return true;
    default:
      return false;
  }
}

function destroyAsteroid(rt, id) {
  const state = rt.elementStates.get(id);
  if (!state) return;
  state.destroyedAt = Date.now();
  state.respawnsAt = state.destroyedAt + ASTEROID_RESPAWN_MS;
  io.to(amiralRoom(rt.id)).emit('asteroid:destroyed', { id, respawnsAt: state.respawnsAt });
  console.log(`[amiral ${rt.username}] asteroïde ${id} détruit, respawn à ${new Date(state.respawnsAt).toISOString()}`);
  const affected = stmtActiveOnElement.all(id, rt.id);
  for (const a of affected) {
    stmtDeleteActiveAction.run(a.user_id);
    stmtInsertActionLog.run(a.user_id, '', rt.id, id, a.action_id, a.category, 'expire', Date.now());
    const sockets = socketsByUser.get(a.user_id);
    if (sockets) {
      const progress = getProgressFor(a.user_id);
      for (const s of sockets) s.emit('action:state', { activeAction: null, progress, expired: true });
    }
  }
  setTimeout(() => respawnAsteroid(rt, id), ASTEROID_RESPAWN_MS);
}

function respawnAsteroid(rt, id) {
  const state = rt.elementStates.get(id);
  if (!state) return;
  state.hp = state.hpMax;
  state.destroyedAt = null;
  state.respawnsAt = null;
  io.to(amiralRoom(rt.id)).emit('asteroid:respawned', { id, state: publicElementState(rt, id) });
  console.log(`[amiral ${rt.username}] asteroïde ${id} respawn`);
}

function incrementCategory(uid, category, n) {
  if (n <= 0) return;
  if (category === 'PUISSANCE')      stmtIncPuissance.run(n, n, uid);
  else if (category === 'DEFENSIF')  stmtIncDefensif.run(n, n, uid);
  else if (category === 'UTILITAIRE') stmtIncUtilitaire.run(n, n, uid);
}
function getProgressFor(uid) {
  stmtEnsureProgress.run(uid);
  return stmtGetProgress.get(uid);
}

function settleAction(action, now, rt) {
  const cap = action.started_at + ACTION_MAX_DURATION_MS;
  const settledThrough = Math.min(now, cap);
  const elapsedSinceLast = settledThrough - action.last_settled_at;
  if (elapsedSinceLast <= 0) return 0;
  const delta = Math.floor(elapsedSinceLast / ACTION_TICK_MS);
  if (delta <= 0) return 0;
  const newLastSettled = action.last_settled_at + delta * ACTION_TICK_MS;
  stmtUpdateLastSettled.run(newLastSettled, action.user_id);
  incrementCategory(action.user_id, action.category, delta);
  const newRes = getResource() + delta;
  setResource(newRes);
  const element = rt.elementById[action.element_id];
  if (element) {
    for (let i = 0; i < delta; i++) {
      const applied = applyActionEffect(rt, action.action_id, element);
      if (!applied) break;
    }
  }
  return delta;
}

let lastBroadcastResource = -1;
function tickActions() {
  const now = Date.now();
  const all = stmtAllActiveActions.all();
  const dirtyAmiraux = new Set();
  const expiredUserIds = [];
  for (const a of all) {
    const rt = amiralsRuntime.get(a.amiral_id);
    if (!rt) continue;
    const delta = settleAction(a, now, rt);
    if (delta > 0) dirtyAmiraux.add(a.amiral_id);
    if (now >= a.started_at + ACTION_MAX_DURATION_MS) {
      stmtDeleteActiveAction.run(a.user_id);
      stmtInsertActionLog.run(a.user_id, a.username, a.amiral_id, a.element_id, a.action_id, a.category, 'expire', now);
      expiredUserIds.push(a.user_id);
      dirtyAmiraux.add(a.amiral_id);
    }
  }
  if (dirtyAmiraux.size > 0) {
    const res = getResource();
    if (res !== lastBroadcastResource) {
      io.emit('resource', { resource: res });
      lastBroadcastResource = res;
    }
    for (const amiralId of dirtyAmiraux) {
      const rt = amiralsRuntime.get(amiralId);
      if (!rt) continue;
      io.to(amiralRoom(amiralId)).emit('elements:update', {
        activeElements: activeElementStatesForAmiral(amiralId),
        states: allElementStates(rt),
        faction: { ...rt.factionResources }
      });
    }
    const stillActive = stmtAllActiveActions.all();
    for (const a of stillActive) {
      const sockets = socketsByUser.get(a.user_id);
      if (!sockets) continue;
      const progress = getProgressFor(a.user_id);
      const activeAction = stmtGetActiveAction.get(a.user_id);
      for (const s of sockets) s.emit('action:state', { activeAction, progress });
    }
    for (const uid of expiredUserIds) {
      const sockets = socketsByUser.get(uid);
      if (!sockets) continue;
      const progress = getProgressFor(uid);
      for (const s of sockets) s.emit('action:state', { activeAction: null, progress, expired: true });
    }
  }
}
setInterval(tickActions, ACTION_TICK_MS);

// ============ Vagues (par Amiral en ligne) ============

function rollWaveFor(rt) {
  if (rt.currentWave && rt.currentWave.endsAt > Date.now()) return;
  if (Math.random() > WAVE_PROBABILITY) return;

  const count = ENEMY_MIN + Math.floor(Math.random() * (ENEMY_MAX - ENEMY_MIN + 1));
  const baseAngle = Math.random() * Math.PI * 2;
  const spread = 1.9;
  const asteroids = rt.elements.filter(e => e.type === 'asteroid');
  const target = Math.random() < 0.4 ? rt.elementById['turret-1'] : asteroids[Math.floor(Math.random() * asteroids.length)];
  const cx = WORLD_W / 2;
  const cy = WORLD_H / 2;
  const r = Math.max(WORLD_W, WORLD_H) * 1.2;
  const margin = 80;
  const now = Date.now();
  const spawnAt = now + WAVE_WARNING_MS;
  const enemies = [];
  let maxTravel = 0;
  for (let i = 0; i < count; i++) {
    const a = baseAngle + (Math.random() - 0.5) * spread;
    const rawX = cx + Math.cos(a) * r;
    const rawY = cy + Math.sin(a) * r;
    const spawnX = Math.max(-margin, Math.min(WORLD_W + margin, rawX));
    const spawnY = Math.max(-margin, Math.min(WORLD_H + margin, rawY));
    const dist = Math.hypot(target.x - spawnX, target.y - spawnY);
    const travelMs = (dist / ENEMY_SPEED) * 1000;
    if (travelMs > maxTravel) maxTravel = travelMs;
    const level = ENEMY_LEVELS_AVAILABLE[Math.floor(Math.random() * ENEMY_LEVELS_AVAILABLE.length)];
    enemies.push({
      id: `e-${rt.id}-${now}-${i}`,
      level,
      spawnX, spawnY,
      targetX: target.x, targetY: target.y,
      travelMs: Math.round(travelMs),
      spawnOffsetMs: Math.floor(Math.random() * 3500)
    });
  }
  rt.currentWave = {
    id: `w-${rt.id}-${now}`,
    startedAt: now,
    warningEndsAt: spawnAt,
    spawnAt,
    targetId: target.id,
    targetLabel: target.label,
    edgeAngle: baseAngle,
    enemies,
    endsAt: spawnAt + Math.ceil(maxTravel) + 120000
  };
  io.to(amiralRoom(rt.id)).emit('wave:incoming', rt.currentWave);
  console.log(`[amiral ${rt.username}] wave ${rt.currentWave.id} — ${count} ennemis vers ${target.id}`);
}

function rollWaves() {
  for (const rt of amiralsRuntime.values()) {
    if (rt.online) rollWaveFor(rt);
  }
}
setInterval(rollWaves, WAVE_CHECK_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`VoidFaction écoute sur le port ${PORT}`);
  const fromEnv = !!process.env.STREAMER_PASSWORD;
  console.log(`Amiral : STREAMER_PASSWORD (code maître) source=${fromEnv ? 'env' : 'défaut'}, longueur=${STREAMER_PASSWORD.length}`);
  try {
    const testFile = path.join(dataDir, '.write-test');
    fs.writeFileSync(testFile, String(Date.now()));
    fs.unlinkSync(testFile);
    const fromEnvDir = !!process.env.DATA_DIR;
    const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const amiralCount = db.prepare('SELECT COUNT(*) AS n FROM amirals').get().n;
    if (!fromEnvDir) {
      console.warn(`⚠️  DB : dataDir=${dataDir} (DATA_DIR non défini → stockage ÉPHÉMÈRE, perdu à chaque déploiement)`);
    } else {
      console.log(`DB : dataDir=${dataDir} (DATA_DIR=env, écriture OK)`);
    }
    console.log(`DB : ${amiralCount} amiral(aux), ${userCount} joueur(s) au démarrage`);
  } catch (e) {
    console.error(`DB : dataDir=${dataDir} ÉCHEC ÉCRITURE:`, e?.code || e?.message);
  }
});
