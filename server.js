const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');

const STREAMER_PASSWORD = process.env.STREAMER_PASSWORD || 'satelitteOrion';
const PORT = Number(process.env.PORT) || 3000;
const CLICK_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const WORLD_W = 1280;
const WORLD_H = 720;
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'voidfaction.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS clicks (
    user_id INTEGER PRIMARY KEY,
    last_click INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS click_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    clicked_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_click_log_time ON click_log (clicked_at DESC);
`);
db.prepare("INSERT OR IGNORE INTO state (key, value) VALUES ('resource', '0')").run();

const stmtGetState = db.prepare('SELECT value FROM state WHERE key = ?');
const stmtSetState = db.prepare('UPDATE state SET value = ? WHERE key = ?');
const stmtInsertUser = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)');
const stmtGetUserByName = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?');
const stmtGetUserById = db.prepare('SELECT id, username FROM users WHERE id = ?');
const stmtInsertSession = db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)');
const stmtGetSession = db.prepare('SELECT user_id FROM sessions WHERE token = ?');
const stmtDeleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');
const stmtGetClick = db.prepare('SELECT last_click FROM clicks WHERE user_id = ?');
const stmtUpsertClick = db.prepare(`
  INSERT INTO clicks (user_id, last_click) VALUES (?, ?)
  ON CONFLICT(user_id) DO UPDATE SET last_click = excluded.last_click
`);
const stmtInsertLog = db.prepare('INSERT INTO click_log (user_id, username, clicked_at) VALUES (?, ?, ?)');
const stmtRecentLog = db.prepare('SELECT username, clicked_at FROM click_log ORDER BY clicked_at DESC LIMIT ?');

const HISTORY_LIMIT = 10;
const getRecentHistory = () => stmtRecentLog.all(HISTORY_LIMIT);

const getResource = () => parseInt(stmtGetState.get('resource').value, 10);
const setResource = (n) => stmtSetState.run(String(n), 'resource');
const getLastClick = (uid) => stmtGetClick.get(uid)?.last_click ?? 0;
const setLastClick = (uid, ts) => stmtUpsertClick.run(uid, ts);

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

const ship = { x: WORLD_W / 2, y: WORLD_H / 2 + 120, rotation: 0 };
let streamerSocketId = null;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/signup', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return res.status(400).json({ ok: false, error: 'Pseudo invalide (3-20 caractères, alphanumériques)' });
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
    return res.status(400).json({ ok: false, error: 'Mot de passe : 6 caractères minimum' });
  }
  const existing = stmtGetUserByName.get(username);
  if (existing) return res.status(409).json({ ok: false, error: 'Ce pseudo est déjà pris' });
  try {
    const info = stmtInsertUser.run(username, hashPassword(password), Date.now());
    const token = newToken();
    stmtInsertSession.run(token, info.lastInsertRowid, Date.now());
    res.json({ ok: true, token, username });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
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
  const token = socket.handshake.auth?.token;
  const user = userFromToken(token);
  if (user) {
    socket.data.userId = user.id;
    socket.data.username = user.username;
  }
  next();
});

io.on('connection', (socket) => {
  socket.emit('init', {
    resource: getResource(),
    ship,
    user: socket.data.userId ? { username: socket.data.username } : null,
    history: getRecentHistory()
  });
  if (socket.data.userId) {
    socket.emit('cooldown', { lastClick: getLastClick(socket.data.userId), cooldownMs: CLICK_COOLDOWN_MS });
  }

  socket.on('player:click', () => {
    const uid = socket.data.userId;
    if (!uid) {
      socket.emit('click:reject', { reason: 'auth' });
      return;
    }
    const now = Date.now();
    const last = getLastClick(uid);
    if (now - last < CLICK_COOLDOWN_MS) {
      socket.emit('click:reject', { reason: 'cooldown', lastClick: last, cooldownMs: CLICK_COOLDOWN_MS });
      return;
    }
    setLastClick(uid, now);
    stmtInsertLog.run(uid, socket.data.username, now);
    const newRes = getResource() + 1;
    setResource(newRes);
    io.emit('resource', { resource: newRes });
    io.emit('history:new', { username: socket.data.username, clicked_at: now });
    socket.emit('cooldown', { lastClick: now, cooldownMs: CLICK_COOLDOWN_MS });
  });

  socket.on('streamer:auth', (data, cb) => {
    if (typeof cb !== 'function') return;
    if (data?.password !== STREAMER_PASSWORD) {
      cb({ ok: false });
      return;
    }
    if (streamerSocketId && streamerSocketId !== socket.id) {
      const prev = io.sockets.sockets.get(streamerSocketId);
      if (prev) {
        prev.data.isStreamer = false;
        prev.emit('streamer:kicked');
      }
    }
    streamerSocketId = socket.id;
    socket.data.isStreamer = true;
    cb({ ok: true });
  });

  socket.on('streamer:ship', (data) => {
    if (!socket.data.isStreamer) return;
    if (typeof data?.x !== 'number' || typeof data?.y !== 'number' || typeof data?.rotation !== 'number') return;
    if (!Number.isFinite(data.x) || !Number.isFinite(data.y) || !Number.isFinite(data.rotation)) return;
    ship.x = Math.max(0, Math.min(WORLD_W, data.x));
    ship.y = Math.max(0, Math.min(WORLD_H, data.y));
    ship.rotation = data.rotation;
    socket.broadcast.emit('ship', ship);
  });

  socket.on('disconnect', () => {
    if (socket.id === streamerSocketId) streamerSocketId = null;
  });
});

server.listen(PORT, () => {
  console.log(`VoidFaction écoute sur http://localhost:${PORT}`);
  console.log(`Streameur : http://localhost:${PORT}/stream.html (mot de passe : ${STREAMER_PASSWORD})`);
});
