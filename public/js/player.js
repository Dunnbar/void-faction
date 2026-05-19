const WORLD_W = 1280;
const WORLD_H = 720;
const ACTION_MAX_DURATION_MS_DEFAULT = 60 * 60 * 1000;

const SHIP_ASSET = '/assets/2D%20Spaceships%20-%20Bundle%20-%20Free/2D%20Spaceships%20-%20Pack%201/(24).png';
const ASTEROID_ASSET = '/assets/Foozle_2DS0015_Void_EnvironmentPack/Foozle_2DS0015_Void_EnvironmentPack/Asteroids/PNGs/Asteroid%2001%20-%20Base.png';

let token = localStorage.getItem('voidfaction:token') || null;
let username = localStorage.getItem('voidfaction:username') || null;
let pendingElementId = null; // id de l'élément cliqué quand non-auth, à rouvrir après auth

// État courant fourni par le serveur
let serverElements = [];
let activeElementsByElement = new Map(); // element_id -> { action_id, category, username }
let activeAction = null; // { element_id, action_id, category, started_at, last_settled_at }
let progress = { puissance: 0, defensif: 0, utilitaire: 0, total: 0 };
let previousProgress = null;
let actionDurationMs = ACTION_MAX_DURATION_MS_DEFAULT;
let history = [];
let socket = null;
let authenticated = false;

// DOM refs
const resourceEl = document.getElementById('resource');
const userLineEl = document.getElementById('userLine');
const userLabelEl = document.getElementById('userLabel');
const authBtn = document.getElementById('authBtn');
const historyListEl = document.getElementById('historyList');
const activeActionRow = document.getElementById('activeAction');
const activeActionName = document.getElementById('activeActionName');
const activeActionTimer = document.getElementById('activeActionTimer');
const deactivateBtn = document.getElementById('deactivateBtn');
const barEls = {
  PUISSANCE:  { val: document.getElementById('barPuissanceVal'),  fill: document.getElementById('barPuissanceFill') },
  DEFENSIF:   { val: document.getElementById('barDefensifVal'),   fill: document.getElementById('barDefensifFill') },
  UTILITAIRE: { val: document.getElementById('barUtilitaireVal'), fill: document.getElementById('barUtilitaireFill') }
};
const actionMenu = document.getElementById('actionMenu');
const actionMenuTitle = document.getElementById('actionMenuTitle');
const actionMenuActions = document.getElementById('actionMenuActions');
const actionMenuClose = document.getElementById('actionMenuClose');
const actionMenuDeact = document.getElementById('actionMenuDeact');
const actionMenuNote = document.getElementById('actionMenuNote');
const authModal = document.getElementById('authModal');
const authClose = document.getElementById('authClose');
const authError = document.getElementById('authError');
const loginForm = document.getElementById('loginForm');
const signupForm = document.getElementById('signupForm');
const tabs = document.querySelectorAll('.tab');

// ============ Helpers ============

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 0 || diff < 60000) return 'à l\'instant';
  const m = Math.floor(diff / 60000);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h}h`;
  return `il y a ${Math.floor(h / 24)}j`;
}

function formatDuration(ms) {
  if (ms <= 0) return '00:00';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function getElement(id) {
  return serverElements.find(e => e.id === id);
}

// ============ Rendu HUD ============

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

function animateBarPlus(cat, delta) {
  const bar = document.querySelector(`.bar.${cat}`);
  if (!bar) return;
  const float = document.createElement('span');
  float.className = 'float-plus';
  float.textContent = `+${delta}`;
  bar.appendChild(float);
  setTimeout(() => float.remove(), 1600);
}

function renderBars() {
  const cats = ['PUISSANCE', 'DEFENSIF', 'UTILITAIRE'];
  const keys = { PUISSANCE: 'puissance', DEFENSIF: 'defensif', UTILITAIRE: 'utilitaire' };
  // % par rapport au max théorique d'1h (360 ticks). On ne dépasse pas 100% visuellement,
  // mais on continue à incrémenter le compteur.
  const max = Math.floor(actionDurationMs / 10000);
  for (const c of cats) {
    const v = progress[keys[c]] || 0;
    barEls[c].val.textContent = v;
    const pct = Math.min(100, (v / max) * 100);
    barEls[c].fill.style.width = pct + '%';
  }
}

function renderActiveAction() {
  if (!authenticated) {
    activeActionRow.classList.add('idle');
    activeActionName.innerHTML = '<span style="opacity:0.5">connecte-toi pour agir</span>';
    activeActionTimer.textContent = '';
    return;
  }
  if (!activeAction) {
    activeActionRow.classList.add('idle');
    activeActionName.textContent = '— aucune —';
    activeActionTimer.textContent = '';
    return;
  }
  activeActionRow.classList.remove('idle');
  const el = getElement(activeAction.element_id);
  const actionDef = el?.actions.find(a => a.id === activeAction.action_id);
  const cat = activeAction.category;
  const label = actionDef ? actionDef.label : activeAction.action_id;
  const target = el ? el.label : activeAction.element_id;
  activeActionName.innerHTML = `<span class="cat-tag ${cat}">${cat}</span> <strong>${escapeHtml(label)}</strong> sur ${escapeHtml(target)}`;
  refreshActiveActionTimer();
}

function refreshActiveActionTimer() {
  if (!activeAction) { activeActionTimer.textContent = ''; return; }
  const remaining = (activeAction.started_at + actionDurationMs) - Date.now();
  activeActionTimer.textContent = remaining > 0 ? `⏳ ${formatDuration(remaining)} restant` : 'Expiration imminente…';
}

function renderHistory(freshTimestamp) {
  if (!history.length) {
    historyListEl.innerHTML = '<li class="empty">Aucune action pour le moment</li>';
    return;
  }
  historyListEl.innerHTML = history.map((h) => {
    const fresh = (h.at === freshTimestamp) ? ' class="fresh"' : '';
    const el = getElement(h.element_id);
    const actionDef = el?.actions.find(a => a.id === h.action_id);
    const label = actionDef ? actionDef.label : h.action_id;
    const target = el ? el.label : h.element_id;
    return `<li${fresh}><span class="hu">${escapeHtml(h.username)}</span><span class="hev"><span class="cat-tag ${h.category}">${h.category[0]}</span> ${escapeHtml(label)} sur ${escapeHtml(target)}</span><span class="ht">${formatAgo(h.at)}</span></li>`;
  }).join('');
}

setInterval(() => {
  refreshActiveActionTimer();
  if (history.length) renderHistory();
}, 1000);

// ============ Menu d'action ============

let actionMenuElementId = null;

function openActionMenu(elementId, anchor) {
  if (!authenticated) {
    pendingElementId = elementId;
    openAuthModal();
    return;
  }
  const el = getElement(elementId);
  if (!el) return;
  actionMenuElementId = elementId;
  actionMenuTitle.textContent = el.label;
  actionMenuActions.innerHTML = '';
  for (const a of el.actions) {
    const isActive = activeAction && activeAction.element_id === elementId && activeAction.action_id === a.id;
    const btn = document.createElement('button');
    btn.innerHTML = `<span class="tag cat-tag ${a.category}">${a.category}</span> ${escapeHtml(a.label)}`;
    if (isActive) btn.classList.add('active');
    btn.addEventListener('click', () => activateAction(elementId, a.id));
    actionMenuActions.appendChild(btn);
  }
  const activeHere = activeAction && activeAction.element_id === elementId;
  actionMenuDeact.classList.toggle('hidden', !activeHere);
  if (activeAction && activeAction.element_id !== elementId) {
    actionMenuNote.textContent = `Tu vas désactiver ton action en cours.`;
    actionMenuNote.classList.remove('hidden');
  } else {
    actionMenuNote.classList.add('hidden');
  }

  // Positionnement: près du point cliqué, en restant dans le viewport
  actionMenu.classList.remove('hidden');
  const rect = actionMenu.getBoundingClientRect();
  let x = (anchor?.clientX ?? window.innerWidth / 2) + 12;
  let y = (anchor?.clientY ?? window.innerHeight / 2) - 10;
  if (x + rect.width > window.innerWidth - 8) x = (anchor?.clientX ?? 0) - rect.width - 12;
  if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
  if (y < 8) y = 8;
  if (x < 8) x = 8;
  actionMenu.style.left = x + 'px';
  actionMenu.style.top = y + 'px';
}

function closeActionMenu() {
  actionMenu.classList.add('hidden');
  actionMenuElementId = null;
}

actionMenuClose.addEventListener('click', closeActionMenu);
actionMenuDeact.addEventListener('click', () => deactivateCurrent());

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeActionMenu(); });

document.addEventListener('mousedown', (e) => {
  if (actionMenu.classList.contains('hidden')) return;
  if (!actionMenu.contains(e.target)) closeActionMenu();
}, true);

function activateAction(elementId, actionId) {
  if (!socket || !authenticated) return;
  socket.emit('action:activate', { elementId, actionId }, (resp) => {
    if (resp?.ok) {
      closeActionMenu();
    } else {
      console.warn('[action] échec activation:', resp?.error);
    }
  });
}

function deactivateCurrent() {
  if (!socket || !authenticated || !activeAction) return;
  socket.emit('action:deactivate', null, () => closeActionMenu());
}

deactivateBtn.addEventListener('click', deactivateCurrent);

// ============ Auth ============

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
  pendingElementId = null;
}

authBtn.addEventListener('click', async () => {
  if (authenticated) {
    try {
      await fetch('/api/logout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
    } catch {}
    token = null; username = null; authenticated = false;
    localStorage.removeItem('voidfaction:token');
    localStorage.removeItem('voidfaction:username');
    activeAction = null;
    progress = { puissance: 0, defensif: 0, utilitaire: 0, total: 0 };
    updateUserLine();
    renderActiveAction();
    renderBars();
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
    setTimeout(() => (isLogin ? loginForm : signupForm).querySelector('input')?.focus(), 30);
  });
});

async function submitAuth(endpoint, data) {
  authError.textContent = '';
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } catch (e) {
    authError.textContent = 'Erreur réseau: ' + (e?.message || 'inconnue');
    return false;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    authError.textContent = body.error || `Erreur ${res.status}`;
    return false;
  }
  token = body.token;
  username = body.username;
  localStorage.setItem('voidfaction:token', token);
  localStorage.setItem('voidfaction:username', username);
  closeAuthModal();
  const pending = pendingElementId;
  pendingElementId = null;
  connectSocket();
  if (pending) {
    setTimeout(() => openActionMenu(pending, null), 400);
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

// ============ Socket ============

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
      token = null;
      localStorage.removeItem('voidfaction:token');
      localStorage.removeItem('voidfaction:username');
      username = null;
    }
    serverElements = Array.isArray(data.elements) ? data.elements : [];
    activeAction = data.activeAction || null;
    progress = data.progress || { puissance: 0, defensif: 0, utilitaire: 0, total: 0 };
    previousProgress = { ...progress };
    actionDurationMs = data.actionDurationMs || ACTION_MAX_DURATION_MS_DEFAULT;
    history = Array.isArray(data.history) ? data.history : [];
    rebuildActiveElementsMap(data.activeElements);
    updateUserLine();
    renderActiveAction();
    renderBars();
    renderHistory();
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive()) {
      scene.setShipState(data.ship);
      scene.refreshElementHighlights();
    }
  });

  socket.on('resource', (data) => { resourceEl.textContent = data.resource; });

  socket.on('ship', (data) => {
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive()) scene.setShipState(data);
  });

  socket.on('action:state', (data) => {
    const oldProgress = previousProgress;
    activeAction = data.activeAction || null;
    progress = data.progress || progress;
    // Anim +N pour chaque catégorie qui a gagné des points depuis le dernier état
    if (oldProgress) {
      const deltas = {
        PUISSANCE:  (progress.puissance  || 0) - (oldProgress.puissance  || 0),
        DEFENSIF:   (progress.defensif   || 0) - (oldProgress.defensif   || 0),
        UTILITAIRE: (progress.utilitaire || 0) - (oldProgress.utilitaire || 0)
      };
      for (const cat of ['PUISSANCE', 'DEFENSIF', 'UTILITAIRE']) {
        if (deltas[cat] > 0) animateBarPlus(cat, deltas[cat]);
      }
      // +N sur l'élément activé (catégorie de l'action active si elle existe)
      const cat = activeAction?.category;
      if (cat && deltas[cat] > 0) {
        const scene = game.scene.getScene('main');
        if (scene && scene.scene.isActive()) {
          scene.flashElementPlus(activeAction.element_id, deltas[cat], cat);
        }
      }
    }
    previousProgress = { ...progress };
    renderActiveAction();
    renderBars();
  });

  socket.on('elements:update', (data) => {
    rebuildActiveElementsMap(data.activeElements);
    const scene = game.scene.getScene('main');
    if (scene && scene.scene.isActive()) scene.refreshElementHighlights();
  });

  socket.on('history:new', (entry) => {
    if (!entry) return;
    history.unshift(entry);
    if (history.length > 10) history.pop();
    renderHistory(entry.at);
  });
}

function rebuildActiveElementsMap(list) {
  activeElementsByElement = new Map();
  if (!Array.isArray(list)) return;
  for (const entry of list) {
    activeElementsByElement.set(entry.element_id, entry);
  }
}

// ============ Phaser Scene ============

const ASTEROID_LAYOUT = [
  { id: 'asteroid-0', x: 180,  y: 140, scale: 2.4, rot:  0.3 },
  { id: 'asteroid-1', x: 1090, y: 170, scale: 1.8, rot:  1.1 },
  { id: 'asteroid-2', x: 200,  y: 580, scale: 3.0, rot: -0.4 },
  { id: 'asteroid-3', x: 1100, y: 590, scale: 1.6, rot:  0.7 },
  { id: 'asteroid-4', x: 420,  y: 90,  scale: 1.4, rot:  2.0 },
  { id: 'asteroid-5', x: 860,  y: 80,  scale: 2.0, rot:  1.5 },
  { id: 'asteroid-6', x: 340,  y: 640, scale: 1.9, rot: -1.0 },
  { id: 'asteroid-7', x: 940,  y: 630, scale: 2.6, rot:  0.5 }
];

class MainScene extends Phaser.Scene {
  constructor() { super('main'); }

  preload() {
    this.load.image('ship', SHIP_ASSET);
    this.load.image('asteroid', ASTEROID_ASSET);
  }

  create() {
    this.cameras.main.setBackgroundColor('#04060a');

    // Starfield
    const sg = this.add.graphics();
    for (let i = 0; i < 240; i++) {
      sg.fillStyle(0xffffff, Phaser.Math.FloatBetween(0.25, 1));
      sg.fillCircle(Phaser.Math.Between(0, WORLD_W), Phaser.Math.Between(0, WORLD_H), Phaser.Math.FloatBetween(0.4, 1.8));
    }

    // Astéroïdes interactifs
    this.textures.get('asteroid').setFilter(Phaser.Textures.FilterMode.NEAREST);
    this.elementSprites = new Map();         // element_id -> sprite
    this.elementHighlights = new Map();      // element_id -> highlight circle

    ASTEROID_LAYOUT.forEach((a, i) => {
      const highlight = this.add.circle(a.x, a.y, 36 * a.scale * 0.5, 0xffd24f, 0.0)
        .setStrokeStyle(2, 0xffd24f, 0.0);
      const sprite = this.add.image(a.x, a.y, 'asteroid')
        .setScale(a.scale).setRotation(a.rot)
        .setInteractive({ useHandCursor: true });
      const dir = (i % 2 === 0) ? 1 : -1;
      this.tweens.add({
        targets: sprite,
        rotation: a.rot + dir * Math.PI * 2,
        duration: 22000 + (i * 3500),
        repeat: -1
      });
      sprite.on('pointerdown', (pointer) => {
        if (pointer.button !== 0) return; // clic gauche uniquement
        openActionMenu(a.id, pointer.event);
      });
      this.elementSprites.set(a.id, sprite);
      this.elementHighlights.set(a.id, highlight);
    });

    // Tourelle (sprite procédural)
    this.createTurretTexture();
    const turretX = WORLD_W / 2;
    const turretY = 540;
    const turretHighlight = this.add.circle(turretX, turretY, 48, 0xff4f6d, 0.0)
      .setStrokeStyle(2, 0xff4f6d, 0.0);
    const turret = this.add.image(turretX, turretY, 'turret')
      .setInteractive({ useHandCursor: true });
    turret.on('pointerdown', (pointer) => {
      if (pointer.button !== 0) return;
      openActionMenu('turret-1', pointer.event);
    });
    this.elementSprites.set('turret-1', turret);
    this.elementHighlights.set('turret-1', turretHighlight);

    this.add.text(turretX, turretY + 50, 'TOURELLE', {
      fontFamily: 'Consolas, monospace', fontSize: '11px', color: '#ff4f6d'
    }).setOrigin(0.5);

    // Vaisseau
    this.ship = this.add.sprite(WORLD_W / 2, WORLD_H / 2 + 120, 'ship').setScale(0.16);

    this.refreshElementHighlights();
  }

  createTurretTexture() {
    const g = this.make.graphics({ x: 0, y: 0, add: false });
    // Base : disque foncé avec anneau
    g.fillStyle(0x1a2335, 1);
    g.fillCircle(40, 40, 30);
    g.lineStyle(2, 0xff8044, 1);
    g.strokeCircle(40, 40, 30);
    // Cercle intérieur
    g.fillStyle(0x2a3550, 1);
    g.fillCircle(40, 40, 20);
    g.lineStyle(1.5, 0xff4f6d, 0.8);
    g.strokeCircle(40, 40, 20);
    // Canon vertical
    g.fillStyle(0x404a60, 1);
    g.fillRect(34, 8, 12, 32);
    g.lineStyle(1.5, 0xff8044, 1);
    g.strokeRect(34, 8, 12, 32);
    // Embout du canon
    g.fillStyle(0xff4f6d, 1);
    g.fillRect(33, 4, 14, 6);
    // Point central
    g.fillStyle(0xff4f6d, 1);
    g.fillCircle(40, 40, 4);
    g.generateTexture('turret', 80, 80);
    g.destroy();
  }

  refreshElementHighlights() {
    if (!this.elementHighlights) return;
    for (const [elementId, highlight] of this.elementHighlights.entries()) {
      const active = activeElementsByElement.get(elementId);
      if (active) {
        const color = active.category === 'PUISSANCE' ? 0xff4f6d :
                      active.category === 'DEFENSIF'  ? 0x4fa3ff :
                                                        0xffd24f;
        highlight.setStrokeStyle(2, color, 0.9);
        highlight.setFillStyle(color, 0.18);
        this.tweens.killTweensOf(highlight);
        this.tweens.add({
          targets: highlight,
          alpha: { from: 1, to: 0.5 },
          yoyo: true, repeat: -1, duration: 900, ease: 'Sine.easeInOut'
        });
      } else {
        this.tweens.killTweensOf(highlight);
        highlight.setStrokeStyle(2, 0xffffff, 0);
        highlight.setFillStyle(0xffffff, 0);
        highlight.alpha = 1;
      }
    }
  }

  setShipState(s) {
    if (!this.ship || !s) return;
    this.ship.x = s.x;
    this.ship.y = s.y;
    this.ship.rotation = s.rotation;
  }

  flashElementPlus(elementId, n, category) {
    const sprite = this.elementSprites?.get(elementId);
    if (!sprite) return;
    const color = category === 'PUISSANCE'  ? '#ff4f6d' :
                  category === 'DEFENSIF'   ? '#4fa3ff' :
                  category === 'UTILITAIRE' ? '#ffd24f' :
                                              '#ffffff';
    const txt = this.add.text(sprite.x, sprite.y - 30, `+${n}`, {
      fontFamily: 'Consolas, monospace',
      fontSize: '22px',
      color,
      stroke: '#000000',
      strokeThickness: 4,
      fontStyle: 'bold'
    }).setOrigin(0.5);
    this.tweens.add({
      targets: txt,
      y: txt.y - 48,
      alpha: { from: 1, to: 0 },
      scale: { from: 0.7, to: 1.1 },
      duration: 1500,
      ease: 'Cubic.easeOut',
      onComplete: () => txt.destroy()
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
renderActiveAction();
renderBars();
connectSocket();
