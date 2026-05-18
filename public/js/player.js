console.log('[player.js] chargé (build diagnostic)');

const WORLD_W = 1280;
const WORLD_H = 720;

let token = localStorage.getItem('voidfaction:token') || null;
let username = localStorage.getItem('voidfaction:username') || null;
let pendingClickAfterAuth = false;

const resourceEl = document.getElementById('resource');
const cooldownEl = document.getElementById('cooldown');
const userLineEl = document.getElementById('userLine');
const userLabelEl = document.getElementById('userLabel');
const authBtn = document.getElementById('authBtn');
const historyListEl = document.getElementById('historyList');

const authModal = document.getElementById('authModal');
const authClose = document.getElementById('authClose');
const authError = document.getElementById('authError');
const loginForm = document.getElementById('loginForm');
const signupForm = document.getElementById('signupForm');
const tabs = document.querySelectorAll('.tab');

let lastClick = 0;
let cooldownMs = 6 * 60 * 60 * 1000;
let authenticated = false;
let history = [];

let socket = null;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 0) return 'à l\'instant';
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'à l\'instant';
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h}h`;
  const d = Math.floor(h / 24);
  return `il y a ${d}j`;
}

function renderHistory(freshTimestamp) {
  if (!history.length) {
    historyListEl.innerHTML = '<li class="empty">Aucun clic pour le moment</li>';
    return;
  }
  historyListEl.innerHTML = history.map((h) => {
    const fresh = (h.clicked_at === freshTimestamp) ? ' class="fresh"' : '';
    return `<li${fresh}><span class="hu">${escapeHtml(h.username)}</span><span class="ht">${formatAgo(h.clicked_at)}</span></li>`;
  }).join('');
}

setInterval(() => { if (history.length) renderHistory(); }, 30000);

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ auth: token ? { token } : {} });

  socket.on('init', (data) => {
    resourceEl.textContent = data.resource;
    authenticated = !!data.user;
    if (data.user) {
      username = data.user.username;
      localStorage.setItem('voidfaction:username', username);
    } else if (token) {
      // Token was rejected (expired/invalid) — clear it
      token = null;
      localStorage.removeItem('voidfaction:token');
      localStorage.removeItem('voidfaction:username');
      username = null;
    }
    history = Array.isArray(data.history) ? data.history.slice(0, 10) : [];
    renderHistory();
    updateUserLine();
    refreshCooldownUi();
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive()) scene.setShipState(data.ship);
  });

  socket.on('history:new', (entry) => {
    if (!entry || typeof entry.username !== 'string') return;
    history.unshift(entry);
    if (history.length > 10) history.pop();
    renderHistory(entry.clicked_at);
  });

  socket.on('resource', (data) => {
    resourceEl.textContent = data.resource;
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive()) scene.flashCrystal();
  });

  socket.on('ship', (data) => {
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive()) scene.setShipState(data);
  });

  socket.on('cooldown', (data) => {
    lastClick = data.lastClick;
    cooldownMs = data.cooldownMs;
    refreshCooldownUi();
  });

  socket.on('click:reject', (data) => {
    if (data?.reason === 'auth') {
      openAuthModal();
      return;
    }
    if (data?.reason === 'cooldown') {
      lastClick = data.lastClick;
      cooldownMs = data.cooldownMs;
      refreshCooldownUi();
    }
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive()) scene.cameras.main.shake(180, 0.004);
  });
}

function updateUserLine() {
  if (authenticated && username) {
    userLabelEl.textContent = username;
    userLineEl.classList.remove('anon');
    authBtn.textContent = 'Déconnexion';
  } else {
    userLabelEl.textContent = 'Visiteur';
    userLineEl.classList.add('anon');
    authBtn.textContent = 'Se connecter';
  }
}

function formatRemaining(ms) {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
}

function refreshCooldownUi() {
  if (!authenticated) {
    cooldownEl.textContent = '🔒 Connecte-toi pour contribuer';
    cooldownEl.className = 'line';
    return;
  }
  const remaining = (lastClick + cooldownMs) - Date.now();
  if (remaining <= 0) {
    cooldownEl.textContent = '✓ Clic disponible';
    cooldownEl.className = 'line ready';
  } else {
    cooldownEl.textContent = `⏳ Prochain clic dans ${formatRemaining(remaining)}`;
    cooldownEl.className = 'line locked';
  }
}
setInterval(refreshCooldownUi, 1000);

function openAuthModal() {
  authError.textContent = '';
  authModal.classList.remove('hidden');
  setTimeout(() => {
    const visible = signupForm.classList.contains('hidden') ? loginForm : signupForm;
    visible.querySelector('input')?.focus();
  }, 50);
}
function closeAuthModal() {
  authModal.classList.add('hidden');
  pendingClickAfterAuth = false;
}

authBtn.addEventListener('click', async () => {
  if (authenticated) {
    try {
      await fetch('/api/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
    } catch {}
    token = null; username = null; authenticated = false;
    localStorage.removeItem('voidfaction:token');
    localStorage.removeItem('voidfaction:username');
    lastClick = 0;
    updateUserLine();
    connectSocket();
  } else {
    openAuthModal();
  }
});

authClose.addEventListener('click', closeAuthModal);
authModal.addEventListener('click', (e) => { if (e.target === authModal) closeAuthModal(); });

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.toggle('active', t === tab));
    const isLogin = tab.dataset.tab === 'login';
    loginForm.classList.toggle('hidden', !isLogin);
    signupForm.classList.toggle('hidden', isLogin);
    authError.textContent = '';
    setTimeout(() => {
      (isLogin ? loginForm : signupForm).querySelector('input')?.focus();
    }, 30);
  });
});

async function submitAuth(endpoint, data) {
  authError.textContent = '';
  console.log('[auth] POST', endpoint, { username: data.username });
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } catch (e) {
    console.error('[auth] fetch a échoué:', e);
    authError.textContent = 'Erreur réseau: ' + (e?.message || 'inconnue');
    return false;
  }
  const body = await res.json().catch((e) => { console.error('[auth] JSON parse:', e); return {}; });
  console.log('[auth] réponse', res.status, body);
  if (!res.ok || !body.ok) {
    authError.textContent = body.error || `Erreur ${res.status}`;
    return false;
  }
  token = body.token;
  username = body.username;
  localStorage.setItem('voidfaction:token', token);
  localStorage.setItem('voidfaction:username', username);
  closeAuthModal();
  connectSocket();
  if (pendingClickAfterAuth) {
    pendingClickAfterAuth = false;
    setTimeout(() => socket.emit('player:click'), 400);
  }
  return true;
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(loginForm);
  submitAuth('/api/login', { username: fd.get('username'), password: fd.get('password') });
});
signupForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(signupForm);
  submitAuth('/api/signup', { username: fd.get('username'), password: fd.get('password') });
});

const SHIP_ASSET = '/assets/2D%20Spaceships%20-%20Bundle%20-%20Free/2D%20Spaceships%20-%20Pack%201/(24).png';

class MainScene extends Phaser.Scene {
  constructor() { super('main'); }

  preload() {
    this.load.image('ship', SHIP_ASSET);
  }

  create() {
    this.cameras.main.setBackgroundColor('#04060a');

    const sg = this.add.graphics();
    for (let i = 0; i < 240; i++) {
      sg.fillStyle(0xffffff, Phaser.Math.FloatBetween(0.25, 1));
      sg.fillCircle(Phaser.Math.Between(0, WORLD_W), Phaser.Math.Between(0, WORLD_H), Phaser.Math.FloatBetween(0.4, 1.8));
    }

    const cg = this.make.graphics({ x: 0, y: 0, add: false });
    cg.lineStyle(2, 0xffffff, 1);
    cg.fillStyle(0x4afff8, 1);
    cg.beginPath();
    cg.moveTo(50, 4);
    cg.lineTo(92, 50);
    cg.lineTo(50, 96);
    cg.lineTo(8, 50);
    cg.closePath();
    cg.fillPath();
    cg.strokePath();
    cg.lineStyle(1, 0xffffff, 0.5);
    cg.beginPath();
    cg.moveTo(50, 4); cg.lineTo(50, 96);
    cg.moveTo(8, 50); cg.lineTo(92, 50);
    cg.strokePath();
    cg.generateTexture('crystal', 100, 100);
    cg.destroy();

    this.crystalGlow = this.add.circle(WORLD_W / 2, WORLD_H / 2, 80, 0x4afff8, 0.15);
    this.tweens.add({
      targets: this.crystalGlow,
      radius: { from: 70, to: 95 },
      alpha: { from: 0.1, to: 0.25 },
      yoyo: true, repeat: -1, duration: 1600, ease: 'Sine.easeInOut'
    });

    this.crystal = this.add.sprite(WORLD_W / 2, WORLD_H / 2, 'crystal').setInteractive({ useHandCursor: true });
    this.tweens.add({
      targets: this.crystal,
      scale: { from: 1, to: 1.08 },
      yoyo: true, repeat: -1, duration: 1400, ease: 'Sine.easeInOut'
    });
    this.crystal.on('pointerdown', () => {
      if (!authenticated) {
        pendingClickAfterAuth = true;
        openAuthModal();
        return;
      }
      const remaining = (lastClick + cooldownMs) - Date.now();
      if (remaining > 0) {
        this.cameras.main.shake(180, 0.004);
        return;
      }
      socket.emit('player:click');
      this.tweens.add({
        targets: this.crystal,
        scale: { from: 1.3, to: 1 },
        duration: 250, ease: 'Back.easeOut'
      });
    });

    this.add.text(WORLD_W / 2, WORLD_H / 2 + 80, 'CRISTAL DE FACTION', {
      fontFamily: 'Consolas, monospace', fontSize: '14px', color: '#4afff8'
    }).setOrigin(0.5);

    this.ship = this.add.sprite(WORLD_W / 2, WORLD_H / 2 + 120, 'ship').setScale(0.16);
  }

  setShipState(s) {
    if (!this.ship || !s) return;
    this.ship.x = s.x;
    this.ship.y = s.y;
    this.ship.rotation = s.rotation;
  }

  flashCrystal() {
    this.tweens.add({
      targets: this.crystalGlow,
      alpha: { from: 0.7, to: 0.15 },
      radius: { from: 130, to: 80 },
      duration: 600, ease: 'Cubic.easeOut'
    });
    const burst = this.add.text(this.crystal.x, this.crystal.y - 30, '+1', {
      fontFamily: 'Consolas, monospace', fontSize: '22px', color: '#4afff8'
    }).setOrigin(0.5);
    this.tweens.add({
      targets: burst,
      y: burst.y - 50, alpha: 0,
      duration: 900,
      onComplete: () => burst.destroy()
    });
  }
}

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: WORLD_W,
  height: WORLD_H,
  backgroundColor: '#04060a',
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: MainScene
});

updateUserLine();
refreshCooldownUi();
connectSocket();
