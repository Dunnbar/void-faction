let WORLD_W = 2400;
let WORLD_H = 1350;
let BASE_X = WORLD_W / 2;
let BASE_Y = WORLD_H / 2;
let BASE_PERIMETER = 560;
let TURRET_X = BASE_X;
let TURRET_Y = BASE_Y;
let GAME_TZ_CLIENT = 'Europe/Paris';
let baseClockInterval = null;
let MAP_BOUNDS = { minI: -1, maxI: 1, minJ: -1, maxJ: 1 };
let pendingShipPos = null; // position vaisseau recue a l'init, appliquee au demarrage de la scene

// Met a jour le bandeau #baseClock (jour de la base + heure jeu coloree jour/nuit).
// Demarre l'intervalle une seule fois ; safe a rappeler a chaque reconnexion.
function startBaseClock() {
  const el = document.getElementById('baseClock');
  if (!el) return;
  const tick = () => {
    const baseEl = serverElements.find(e => e.type === 'base');
    const state = baseEl ? elementStates.get(baseEl.id) : null;
    if (!state) return;
    SharedScene.updateBaseClock(el, state, GAME_TZ_CLIENT);
    el.classList.remove('hidden');
  };
  tick();
  if (baseClockInterval) return;
  baseClockInterval = setInterval(tick, 1000);
}
const ZOOM_FACTOR_MIN = 0.25;  // dezoom large : jusqu'a ~4x plus large que la case (nebuleuse autour)
const ZOOM_FACTOR_MAX = 2.5;

let amiralToken = localStorage.getItem('voidfaction:amiralToken') || null;
let socket = null;
const loginEl = document.getElementById('login');
const loginForm = document.getElementById('loginForm');
const signupForm = document.getElementById('signupForm');
const loginError = document.getElementById('loginError');
const tabLogin = document.getElementById('tabLogin');
const tabSignup = document.getElementById('tabSignup');
const profileBtn = document.getElementById('profileBtn');
const profileMenu = document.getElementById('profileMenu');

let authenticated = false;
let gameStarted = false;

document.querySelectorAll('.pwd-toggle').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const id = btn.getAttribute('data-target');
    const input = document.getElementById(id);
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
    input.focus();
  });
});

function setActiveTab(which) {
  loginError.textContent = '';
  const isLogin = which === 'login';
  loginForm.classList.toggle('hidden', !isLogin);
  signupForm.classList.toggle('hidden', isLogin);
  tabLogin.style.borderBottomColor = isLogin ? '#4af' : 'transparent';
  tabLogin.style.color = isLogin ? '#4af' : '#789';
  tabLogin.style.fontWeight = isLogin ? 'bold' : 'normal';
  tabSignup.style.borderBottomColor = !isLogin ? '#4af' : 'transparent';
  tabSignup.style.color = !isLogin ? '#4af' : '#789';
  tabSignup.style.fontWeight = !isLogin ? 'bold' : 'normal';
  setTimeout(() => (isLogin ? loginForm : signupForm).querySelector('input')?.focus(), 30);
}
tabLogin.addEventListener('click', () => setActiveTab('login'));
tabSignup.addEventListener('click', () => setActiveTab('signup'));

function showLoginUI() {
  loginEl.classList.remove('hidden');
  profileBtn.classList.add('hidden');
  profileMenu.classList.add('hidden');
}
function hideLoginUI() {
  loginEl.classList.add('hidden');
  profileBtn.classList.remove('hidden');
}

// Menu profil (haut-droite) : toggle + fermeture au clic exterieur + deconnexion.
profileBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  profileMenu.classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (profileMenu.classList.contains('hidden')) return;
  if (!profileMenu.contains(e.target) && e.target !== profileBtn) profileMenu.classList.add('hidden');
});
document.getElementById('pmLogout').addEventListener('click', () => {
  amiralToken = null;
  localStorage.removeItem('voidfaction:amiralToken');
  location.reload();
});
// "Recommencer" apres destruction de la base.
document.getElementById('bdRestart')?.addEventListener('click', () => {
  if (socket) socket.emit('streamer:rebirth');
});

function connectAmiralSocket() {
  if (socket) try { socket.disconnect(); } catch {}
  socket = io({ auth: amiralToken ? { amiralToken } : {} });
  wireSocketEvents();
}

async function submitAmiralAuth(endpoint, body) {
  loginError.textContent = '';
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    loginError.textContent = 'Erreur réseau: ' + (e?.message || 'inconnue');
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    loginError.textContent = data.error || `Erreur ${res.status}`;
    return;
  }
  amiralToken = data.token;
  localStorage.setItem('voidfaction:amiralToken', amiralToken);
  localStorage.setItem('voidfaction:amiralUsername', data.username);
  connectAmiralSocket();
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submitAmiralAuth('/api/amiral/login', {
    username: document.getElementById('loginUsername').value.trim(),
    password: document.getElementById('loginPassword').value
  });
});
signupForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submitAmiralAuth('/api/amiral/signup', {
    username: document.getElementById('signupUsername').value.trim(),
    password: document.getElementById('signupPassword').value,
    masterCode: document.getElementById('signupMaster').value
  });
});

let lastActiveElements = [];
let elementStates = new Map();
let factionResources = { materiaux: 0, radius: 0 };
let amiralDisplayName = 'AMIRAL';  // pseudo affiche sous le vaisseau
let activeAction = null;  // action active de l'Amiral (slot unique)
let amiralProgress = { puissance: 0, defensif: 0, utilitaire: 0, total: 0 };
let serverElementsRef = null;  // alias vers le tableau d'elements (mis a jour dans init)

// ============ Menu d'action (clic sur un element) ============
let actionMenuElementId = null;
const actionMenu = document.getElementById('actionMenu');
const actionMenuTitle = document.getElementById('actionMenuTitle');
const actionMenuActions = document.getElementById('actionMenuActions');
const actionMenuClose = document.getElementById('actionMenuClose');
const actionMenuNote = document.getElementById('actionMenuNote');
const actionMenuStats = document.getElementById('actionMenuStats');
// Panneau "action en cours" (Amiral) + bouton Stopper
const activeActionPanel = document.getElementById('activeAction');
const activeActionName = document.getElementById('activeActionName');
const deactivateBtn = document.getElementById('deactivateBtn');
function renderActiveAction() {
  if (!activeActionPanel) return;
  if (!activeAction) { activeActionPanel.classList.add('hidden'); return; }
  activeActionPanel.classList.remove('hidden');
  const el = getElement(activeAction.element_id);
  const actionDef = el && el.actions ? el.actions.find(a => a.id === activeAction.action_id) : null;
  const cat = activeAction.category;
  const label = actionDef ? actionDef.label : activeAction.action_id;
  const target = el ? el.label : activeAction.element_id;
  activeActionName.innerHTML = `<span class="cat-tag ${cat}">${cat}</span> <strong>${escapeHtml(label)}</strong> sur ${escapeHtml(target)}`;
}
if (deactivateBtn) deactivateBtn.addEventListener('click', () => deactivateCurrent());
// Icone par action (commun avec le viewer)
const ACTION_ICONS = {
  reparation: '/assets/PNG/Ability21.png',
  remplir:    '/assets/PNG/Ability10.png',
  tir:        '/assets/PNG/Ability02.png',
  visee:      '/assets/PNG/Ability14.png',
  minage:     '/assets/PNG/Ability24.png'
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function getElement(elementId) {
  if (!serverElements) return null;
  return serverElements.find(e => e.id === elementId);
}

function openActionMenu(elementId, anchor) {
  if (!authenticated) return; // l'Amiral doit etre authentifie pour cliquer
  const el = getElement(elementId);
  if (!el) return;
  actionMenuElementId = elementId;
  actionMenuTitle.textContent = el.label;

  // Stats de l'element
  if (actionMenuStats) {
    const st = elementStates.get(elementId);
    if (st) {
      const parts = [];
      if (el.type === 'base' && typeof st.daysAlive === 'number') parts.push(`Jour <strong>${st.daysAlive}</strong>`);
      if (st.hp !== undefined && el.type !== 'asteroid') parts.push(`HP <strong>${st.hp}</strong>/${st.hpMax}`);
      if (st.puissance !== undefined) parts.push(`Puissance <strong>${st.puissance}</strong>`);
      if (st.range !== undefined) parts.push(`Portée <strong>${st.range}</strong>`);
      if (st.essence !== undefined) parts.push(`Essence <strong>${st.essence}</strong>/${st.essenceMax}`);
      if (st.subtype) {
        parts.push(`Type <strong>${st.subtype === 'radius' ? 'Radius' : 'Matériaux'}</strong>`);
        if (st.hpMax) {
          const remainingSec = Math.max(0, Math.round(st.hp / 1000));
          const m = Math.floor(remainingSec / 60);
          const s = remainingSec % 60;
          parts.push(`Durée <strong>${m}m${String(s).padStart(2,'0')}s</strong>`);
        }
      }
      actionMenuStats.innerHTML = parts.join(' &middot; ');
      actionMenuStats.classList.remove('hidden');
    } else {
      actionMenuStats.classList.add('hidden');
    }
  }

  actionMenuActions.innerHTML = '';
  // Tourelle detruite : seule option = Reconstruire (meme mecanique que reparation).
  const stMenu = elementStates.get(elementId);
  const turretDead = el.type === 'turret' && stMenu && stMenu.dead;
  const actionsToShow = turretDead
    ? [{ id: 'reparation', label: 'Reconstruire', category: 'DEFENSIF', icon: '/assets/PNG/Ability25.png' }]
    : el.actions;
  for (const a of actionsToShow) {
    const isActive = activeAction && activeAction.element_id === elementId && activeAction.action_id === a.id;
    const btn = document.createElement('button');
    btn.className = 'act-block ' + a.category;
    const icon = a.icon || ACTION_ICONS[a.id];
    btn.innerHTML = `${icon ? `<img class="act-ico" src="${icon}" alt="">` : ''}<span class="act-lbl">${escapeHtml(a.label)}</span>`;
    if (isActive) btn.classList.add('active');
    btn.addEventListener('click', () => activateAction(elementId, a.id));
    actionMenuActions.appendChild(btn);
  }
  if (activeAction && activeAction.element_id !== elementId) {
    actionMenuNote.textContent = 'Tu vas remplacer ton action en cours.';
    actionMenuNote.classList.remove('hidden');
  } else {
    actionMenuNote.classList.add('hidden');
  }

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

function activateAction(elementId, actionId) {
  if (!socket || !authenticated) return;
  socket.emit('action:activate', { elementId, actionId }, (resp) => {
    if (resp?.ok) closeActionMenu();
    else console.warn('[amiral] activation refusee:', resp?.error);
  });
}

function deactivateCurrent() {
  if (!socket || !authenticated || !activeAction) return;
  socket.emit('action:deactivate', null, () => { closeActionMenu(); });
}

if (actionMenuClose) actionMenuClose.addEventListener('click', closeActionMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeActionMenu(); });
document.addEventListener('mousedown', (e) => {
  if (!actionMenu || actionMenu.classList.contains('hidden')) return;
  if (!actionMenu.contains(e.target)) closeActionMenu();
}, true);
let knownBuildTime = null;

// ============ Commandant overlay HUD ============
const CAPTAIN_FRAMES = (() => {
  const arr = [];
  for (let i = 0; i < 18; i++) arr.push(`/assets/PNG/CaptainTalk/Talk01/skeleton-LoopTalk_${i}.png`);
  return arr;
})();
// On RETIENT les objets Image (sinon le GC peut les liberer : la 1re vague affichait
// alors un portrait vide, le temps que les frames soient re-telechargees).
const _captainPreload = CAPTAIN_FRAMES.map((src) => { const img = new Image(); img.src = src; return img; });
let captainAnimInterval = null;
let captainHideTimeout = null;
function showCaptain(message, durationMs) {
  const el = document.getElementById('captainAlert');
  const img = document.getElementById('captainImg');
  const msg = document.getElementById('captainMsg');
  if (!el || !img || !msg) return;
  msg.innerHTML = message;
  el.classList.remove('hidden');
  if (captainAnimInterval) clearInterval(captainAnimInterval);
  if (captainHideTimeout) clearTimeout(captainHideTimeout);
  let i = 0;
  img.src = CAPTAIN_FRAMES[0];
  captainAnimInterval = setInterval(() => {
    i = (i + 1) % CAPTAIN_FRAMES.length;
    img.src = CAPTAIN_FRAMES[i];
  }, 70);
  if (durationMs > 0) captainHideTimeout = setTimeout(hideCaptain, durationMs);
}
function hideCaptain() {
  const el = document.getElementById('captainAlert');
  if (el) el.classList.add('hidden');
  if (captainAnimInterval) { clearInterval(captainAnimInterval); captainAnimInterval = null; }
  if (captainHideTimeout) { clearTimeout(captainHideTimeout); captainHideTimeout = null; }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function triggerCaptainForWave(wave) {
  if (!wave) return;
  const now = Date.now();
  const warnMs = Math.max(0, wave.warningEndsAt - now);
  const totalRemaining = Math.max(0, wave.endsAt - now);
  if (warnMs > 0) {
    // Captain affiche brievement (15s max), la banniere de wave reste pour le countdown long
    const captainDurationMs = Math.min(15000, warnMs + 800);
    showCaptain(`<span class="danger">⚠ ENNEMIS DÉTECTÉS</span><br>Tenez vos positions !`, captainDurationMs);
    setTimeout(() => {
      if (Date.now() < wave.endsAt - 1500) {
        showCaptain(`<span class="danger">L'ENNEMI EST LÀ !</span><br>Tirez sur les hostiles !`, Math.max(1500, wave.endsAt - Date.now() - 600));
      }
    }, warnMs);
  } else if (totalRemaining > 1500) {
    showCaptain(`<span class="danger">L'ENNEMI EST LÀ !</span><br>Tirez sur les hostiles !`, totalRemaining - 600);
  }
}

function triggerVersionReload() {
  console.log('%c[VoidFaction Amiral] Nouvelle version détectée — rechargement…', 'color:#f80; font-weight:bold; font-size:14px');
  const notif = document.createElement('div');
  notif.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#f80;color:#000;padding:10px;text-align:center;font-family:Consolas,monospace;font-weight:bold;letter-spacing:1px;box-shadow:0 2px 12px rgba(0,0,0,0.5)';
  notif.textContent = 'Nouvelle version disponible — rechargement automatique…';
  document.body.appendChild(notif);
  setTimeout(() => location.reload(), 900);
}
let waveBannerInterval = null;
function showWaveBanner(wave) {
  const banner = document.getElementById('waveBanner');
  if (!banner) return;
  const labelEl = banner.querySelector('.target');
  const cdEl = banner.querySelector('.countdown');
  if (labelEl) labelEl.textContent = wave.targetLabel || '';
  banner.classList.remove('hidden');
  if (waveBannerInterval) clearInterval(waveBannerInterval);
  const update = () => {
    const now = Date.now();
    if (now < wave.warningEndsAt) {
      const remMs = wave.warningEndsAt - now;
      cdEl.textContent = formatWaveCountdown(remMs);
      banner.classList.add('warning'); banner.classList.remove('active');
    } else if (now < wave.endsAt) {
      cdEl.textContent = 'EN COURS';
      banner.classList.remove('warning'); banner.classList.add('active');
    } else {
      banner.classList.add('hidden');
      banner.classList.remove('warning', 'active');
      clearInterval(waveBannerInterval); waveBannerInterval = null;
    }
  };
  update();
  waveBannerInterval = setInterval(update, 1000);
}

function formatWaveCountdown(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${String(m).padStart(2,'0')}`;
  if (m > 0) return `${m}m${String(s).padStart(2,'0')}s`;
  return `${s}s`;
}

// Tableau de bord Amiral : viewers connectes/inscrits + leurs niveaux.
function renderDashboard(data) {
  if (!data) return;
  const cEl = document.getElementById('dashConnected');
  const tEl = document.getElementById('dashTotal');
  const list = document.getElementById('dashList');
  if (cEl) cEl.textContent = data.connected || 0;
  if (tEl) tEl.textContent = data.total || 0;
  if (!list) return;
  const users = data.users || [];
  if (users.length === 0) { list.innerHTML = '<span class="dash-empty">Aucun viewer inscrit.</span>'; return; }
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  list.innerHTML = users.map(u => {
    const lv = u.levels || { puissance:1, defensif:1, utilitaire:1 };
    return `<div class="dash-row ${u.online ? 'online' : 'offline'}"><span class="dot"></span>`
      + `<span class="name">${esc(u.username)}</span>`
      + `<span class="lv"><span class="p">P${lv.puissance}</span> <span class="d">D${lv.defensif}</span> <span class="u">U${lv.utilitaire}</span></span></div>`;
  }).join('');
}

function wireSocketEvents() {
  socket.on('init', (data) => {
    if (data.buildTime) {
      if (knownBuildTime && knownBuildTime !== data.buildTime) {
        triggerVersionReload();
        return;
      }
      knownBuildTime = data.buildTime;
      const d = new Date(data.buildTime);
      console.log(`%c[VoidFaction Amiral] dernière MAJ : ${d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' })}`,
        'color:#ff8044; font-weight:bold');
    }
    // Authentification : si data.amiral est absent, le token est invalide
    if (!data.amiral) {
      amiralToken = null;
      localStorage.removeItem('voidfaction:amiralToken');
      authenticated = false;
      showLoginUI();
      try { socket.disconnect(); } catch {}
      return;
    }
    authenticated = true;
    hideLoginUI();
    document.getElementById('baseDeadOverlay')?.classList.toggle('hidden', !data.baseDead);
    lastActiveElements = data.activeElements || [];
    serverElements = data.elements || [];
    elementStates = new Map((data.elementStates || []).map(s => [s.id, s]));
    factionResources = data.factionResources || factionResources;
    activeAction = data.activeAction || null;
    renderActiveAction();
    chat = Array.isArray(data.chat) ? data.chat : [];
    renderChat();
    amiralProgress = data.progress || amiralProgress;
    // Pseudo de l'Amiral sur le vaisseau (le sien). Stocke pour utilisation au demarrage de la scene
    amiralDisplayName = data.watchedAmiral?.username || data.amiral?.username || 'AMIRAL';
    { const a = document.getElementById('profileBtnName'); if (a) a.textContent = amiralDisplayName; }
    { const a = document.getElementById('pmName'); if (a) a.textContent = amiralDisplayName; }
    const sceneForLabel = game?.scene.getScene('main');
    if (sceneForLabel && sceneForLabel.shipLabel) sceneForLabel.shipLabel.setText(amiralDisplayName);
    if (data.world) {
      WORLD_W = data.world.width;
      WORLD_H = data.world.height;
      BASE_X = data.world.baseX ?? WORLD_W / 2;
      BASE_Y = data.world.baseY ?? WORLD_H / 2;
      BASE_PERIMETER = data.world.basePerimeter ?? 560;
      TURRET_X = data.world.turretX;
      TURRET_Y = data.world.turretY;
      GAME_TZ_CLIENT = data.world.gameTz || 'Europe/Paris';
      MAP_BOUNDS = {
        minI: data.world.mapMinI ?? -1, maxI: data.world.mapMaxI ?? 1,
        minJ: data.world.mapMinJ ?? -1, maxJ: data.world.mapMaxJ ?? 1
      };
    }
    // Position du vaisseau restauree (la sienne) : appliquee au demarrage de la scene.
    if (data.ship) pendingShipPos = data.ship;
    startBaseClock();
    pendingWave = data.currentWave && data.currentWave.endsAt > Date.now() ? data.currentWave : null;
    if (pendingWave) triggerCaptainForWave(pendingWave);
    if (!gameStarted) {
      gameStarted = true;
      startGame();
    } else {
      const scene = game?.scene.getScene('main');
      if (scene && scene.scene.isActive()) {
        scene.setupElements(serverElements);
        scene.applyAllElementStates();
        scene.refreshElementHighlights(lastActiveElements);
        scene.drawBasePerimeter();
        if (pendingWave) {
          scene.handleWaveIncoming(pendingWave);
          pendingWave = null;
        }
      }
    }
  });
  socket.on('resource', () => { /* ressource de faction globale non affichee */ });
  socket.on('elements:update', (data) => {
    // Ne pas ecraser la liste active sur les broadcasts partiels (qui n'envoient que des states).
    if (Array.isArray(data.activeElements)) lastActiveElements = data.activeElements;
    if (Array.isArray(data.states)) {
      // Fusion (pas de remplacement) : les broadcasts partiels (base, asteroides) ne doivent pas s'ecraser
      for (const s of data.states) elementStates.set(s.id, s);
    }
    if (data.faction) factionResources = data.faction;
    const scene = game?.scene.getScene('main');
    if (scene && scene.scene.isActive()) {
      scene.refreshElementHighlights(lastActiveElements);
      scene.applyAllElementStates();
      SharedScene.refreshActionOverlay(scene, lastActiveElements, activeAction?.element_id);
    }
  });
  socket.on('asteroid:destroyed', (data) => {
    const scene = game?.scene.getScene('main');
    if (scene && scene.scene.isActive()) scene.onAsteroidDestroyed(data.id, data.respawnsAt);
    const st = elementStates.get(data.id);
    if (st) { st.hp = 0; st.respawnsAt = data.respawnsAt; }
  });
  socket.on('asteroid:respawned', (data) => {
    const scene = game?.scene.getScene('main');
    if (scene && scene.scene.isActive()) scene.onAsteroidRespawned(data.id);
    if (data.state) elementStates.set(data.id, data.state);
  });
  // Groupes : destruction/respawn de tous les asteroides d'un subtype.
  // Un seul timer de respawn est affiche au centroide du groupe (cf. SharedScene).
  socket.on('asteroid:group_destroyed', (data) => {
    const scene = game?.scene.getScene('main');
    for (const id of (data.ids || [])) {
      if (scene && scene.scene.isActive()) scene.onAsteroidDestroyed(id, data.respawnsAt);
      const st = elementStates.get(id);
      if (st) { st.hp = 0; st.respawnsAt = data.respawnsAt; }
    }
    if (scene && scene.scene.isActive() && data.subtype) {
      SharedScene.showGroupRespawnTimer(scene, data.subtype, data.respawnsAt);
    }
  });
  socket.on('asteroid:group_respawned', (data) => {
    const scene = game?.scene.getScene('main');
    const ids = data.ids || [];
    const states = data.states || [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (scene && scene.scene.isActive()) scene.onAsteroidRespawned(id);
      if (states[i]) elementStates.set(id, states[i]);
    }
    if (scene && scene.scene.isActive() && data.subtype) {
      SharedScene.clearGroupRespawnTimer(scene, data.subtype);
    }
  });
  socket.on('base:reborn', (data) => {
    if (data?.state) elementStates.set(data.id, data.state);
    const scene = game?.scene.getScene('main');
    if (scene && scene.scene.isActive()) scene.applyAllElementStates();
    document.getElementById('baseDeadOverlay')?.classList.add('hidden'); // base relancee
  });
  socket.on('base:destroyed', () => {
    const scene = game?.scene.getScene('main');
    if (scene && scene.scene.isActive() && typeof scene.playBaseExplosion === 'function') {
      scene.playBaseExplosion();
      setTimeout(() => document.getElementById('baseDeadOverlay')?.classList.remove('hidden'), 1200);
    } else {
      document.getElementById('baseDeadOverlay')?.classList.remove('hidden');
    }
  });
  socket.on('wave:incoming', (wave) => {
    const scene = game?.scene.getScene('main');
    if (scene && scene.scene.isActive()) scene.handleWaveIncoming(wave);
    else pendingWave = wave;
    triggerCaptainForWave(wave);
  });
  socket.on('streamer:kicked', () => {
    alert('Un autre Amiral s\'est connecté avec ton compte. Tu as perdu le contrôle.');
    amiralToken = null;
    localStorage.removeItem('voidfaction:amiralToken');
    location.reload();
  });
  socket.on('dashboard', (data) => renderDashboard(data));
  socket.on('action:state', (data) => {
    activeAction = data?.activeAction || null;
    renderActiveAction();
    if (data?.progress) amiralProgress = data.progress;
    // Mise a jour du menu si ouvert sur l'element concerne
    if (actionMenuElementId && !actionMenu.classList.contains('hidden')) {
      openActionMenu(actionMenuElementId, null);
    }
    // Halo "mon action en cours" sur l'element concerne.
    const scene = game?.scene.getScene('main');
    if (scene && scene.scene.isActive()) {
      SharedScene.refreshActionOverlay(scene, lastActiveElements, activeAction?.element_id);
    }
  });

  socket.on('chat:new', (m) => addChatMessage(m));
  socket.on('chat:moderated', () => { /* l'Amiral n'est pas modere sur sa propre base */ });
}

// Connexion initiale : si un token Amiral est en localStorage, on tente de réutiliser ;
// sinon le formulaire de login/signup reste affiché.
if (amiralToken) {
  connectAmiralSocket();
} else {
  setActiveTab('login');
}

// ============ Chat de la base + moderation (Amiral) ============
let chat = [];
let chatUnread = 0;
const chatEl = document.getElementById('chat');
const chatBtn = document.getElementById('chatBtn');
const chatBadge = document.getElementById('chatBadge');
const chatListEl = document.getElementById('chatList');
const chatFormEl = document.getElementById('chatForm');
const chatInputEl = document.getElementById('chatInput');
const chatModMenu = document.getElementById('chatModMenu');
const chatModTarget = document.getElementById('chatModTarget');
let modTargetUserId = null;

function chatIsOpen() { return chatEl && !chatEl.classList.contains('hidden'); }
function setChatBadge(n) {
  if (!chatBtn || !chatBadge) return;
  if (n > 0) { chatBadge.textContent = n > 99 ? '99+' : String(n); chatBtn.classList.add('has-unread'); }
  else chatBtn.classList.remove('has-unread');
}
function chatClock(at) { const d = new Date(at); const p = n => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}`; }
function chatMsgHtml(m) {
  const mine = !m.userId && m.username === amiralDisplayName;
  const modable = !!m.userId;  // seuls les messages de viewers (avec userId) sont moderables
  const cls = 'cm-author' + (mine ? ' me' : '') + (modable ? ' mod' : '');
  const attr = modable ? ` data-uid="${m.userId}" data-uname="${escapeHtml(m.username || '')}"` : '';
  const lvl = m.level ? `<span class="cm-lvl">Niv ${m.level}</span>` : '';
  return `<div class="chat-msg">${lvl}<span class="${cls}"${attr}>${escapeHtml(m.username || '?')}</span>`
       + `<span class="cm-text">${escapeHtml(m.message || '')}</span>`
       + `<span class="cm-time">${chatClock(m.at)}</span></div>`;
}
function renderChat() {
  if (!chatListEl) return;
  chatListEl.innerHTML = chat.map(chatMsgHtml).join('');
  chatListEl.scrollTop = chatListEl.scrollHeight;
}
function addChatMessage(m) {
  if (!m) return;
  chat.push(m); if (chat.length > 50) chat.shift();
  renderChat();
  if (!chatIsOpen()) { chatUnread++; setChatBadge(chatUnread); }
}
function hideModMenu() { chatModMenu?.classList.add('hidden'); modTargetUserId = null; }
function showModMenu(x, y, uid, uname) {
  if (!chatModMenu) return;
  modTargetUserId = uid;
  if (chatModTarget) chatModTarget.textContent = uname;
  chatModMenu.classList.remove('hidden');
  const r = chatModMenu.getBoundingClientRect();
  let px = x, py = y;
  if (px + r.width > window.innerWidth - 8) px = window.innerWidth - r.width - 8;
  if (py + r.height > window.innerHeight - 8) py = y - r.height;
  chatModMenu.style.left = px + 'px';
  chatModMenu.style.top = py + 'px';
}
function toggleChat() {
  if (!chatEl) return;
  const open = chatEl.classList.contains('hidden');
  chatEl.classList.toggle('hidden', !open);
  chatBtn?.classList.toggle('active', open);
  if (open) { chatUnread = 0; setChatBadge(0); if (chatListEl) chatListEl.scrollTop = chatListEl.scrollHeight; chatInputEl?.focus(); }
  else hideModMenu();
}
chatBtn?.addEventListener('click', toggleChat);
chatFormEl?.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = (chatInputEl?.value || '').trim();
  if (!text || !socket) return;
  socket.emit('chat:send', { message: text }, (res) => { if (res && res.ok) chatInputEl.value = ''; });
});
chatListEl?.addEventListener('click', (e) => {
  const a = e.target.closest('.cm-author.mod');
  if (!a) return;
  showModMenu(e.clientX, e.clientY, parseInt(a.dataset.uid, 10), a.dataset.uname || '');
});
chatModMenu?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || !modTargetUserId || !socket) return;
  socket.emit('chat:moderate', { userId: modTargetUserId, action: btn.dataset.act }, () => {});
  hideModMenu();
});
document.addEventListener('click', (e) => {
  if (chatModMenu && !chatModMenu.classList.contains('hidden')
      && !chatModMenu.contains(e.target) && !e.target.closest('.cm-author.mod')) hideModMenu();
});

const SHIP_ASSET = '/assets/PNG/Ship_01/Ship_LVL_1.png';
const SHIP_SCALE = 0.035; // vaisseau Amiral discret, ne masque pas la base
const ENEMY_LEVELS = [1];
const ENEMY_ASSETS = {
  1: '/assets/PNG/Ship_02/Ship_LVL_1.png'
};
const ENEMY_SCALE = 0.045;
// IA ennemie : cap sur la base par defaut, engagement des cibles croisees dans la range.
const ENEMY_SPEED_PX     = 40;   // px/s (aligne sur ENEMY_SPEED serveur)
const ENEMY_DETECT_RANGE = 340;  // rayon de detection d'une cible a engager
const ENEMY_ORBIT_R_MIN  = 90;
const ENEMY_ORBIT_R_MAX  = 160;
const ENEMY_FIRE_MS      = 5000;
const GUN_LEVELS = 10;
const GUN_SCALE = 0.55;
function turretGunLevel(puissance) {
  return Math.min(GUN_LEVELS, Math.max(1, 1 + Math.floor((puissance || 0) / 10)));
}
function turretRangePx(state) {
  return 280 + (state?.range || 0) * 10;
}
const SHIP_SPRITE_OFFSET = Math.PI / 2; // les nouveaux assets pointent vers le haut

const ASTEROID_VARIANTS = {
  '01': { cols: 3, rows: 2, count: 6, w: 600, h: 500 },
  '02': { cols: 2, rows: 2, count: 4, w: 520, h: 430 },
  '03': { cols: 2, rows: 2, count: 4, w: 500, h: 360 },
  '04': { cols: 2, rows: 2, count: 4, w: 350, h: 300 },
  '05': { cols: 2, rows: 2, count: 4, w: 450, h: 200 },
  '06': { cols: 3, rows: 1, count: 3, w: 320, h: 240 },
  '07': { cols: 3, rows: 1, count: 3, w: 300, h: 250 },
  '08': { cols: 3, rows: 1, count: 3, w: 240, h: 240 },
  '09': { cols: 3, rows: 1, count: 3, w: 250, h: 230 },
  '10': { cols: 3, rows: 1, count: 3, w: 260, h: 240 },
  '11': { cols: 3, rows: 1, count: 3, w: 240, h: 150 },
  '12': { cols: 3, rows: 1, count: 3, w: 170, h: 180 },
  '13': { cols: 3, rows: 1, count: 3, w: 190, h: 160 },
  '14': { cols: 2, rows: 1, count: 2, w: 110, h: 110 },
  '15': { cols: 2, rows: 1, count: 2, w: 70,  h: 100 }
};
const ASTEROID_TARGET_SIZE = 85;
function asteroidScaleFor(variantKey, sizeMultiplier) {
  const meta = ASTEROID_VARIANTS[variantKey] || ASTEROID_VARIANTS['01'];
  return (ASTEROID_TARGET_SIZE * (sizeMultiplier || 1)) / Math.max(meta.w, meta.h);
}
function asteroidFrameFor(variantKey, hpRatio) {
  const meta = ASTEROID_VARIANTS[variantKey] || ASTEROID_VARIANTS['01'];
  return Math.min(meta.count - 1, Math.max(0, Math.floor((1 - hpRatio) * meta.count)));
}

let serverElements = [];
let pendingWave = null; // wave reçue avant que la scène ne démarre

class MainScene extends Phaser.Scene {
  constructor() { super('main'); }

  preload() {
    this.load.image('ship', SHIP_ASSET);
    this.load.image('mothership-base', '/assets/Spaceships/PNG/enemy_mothership.png');
    this.load.spritesheet('shield', '/assets/Weapons/PNG/shield_frames.png', { frameWidth: 280, frameHeight: 280 });
    this.load.spritesheet('rocket-flame', '/assets/Weapons/PNG/rocket_flame_animation.png', { frameWidth: 12, frameHeight: 46 });
    for (let i = 0; i < 10; i++) {
      const n = String(i).padStart(3, '0');
      this.load.image(`ship-fr-${n}`, `/assets/PNG/Ship_01/Exhaust/Exhaust_1_2_${n}.png`);
    }
    for (const lvl of ENEMY_LEVELS) {
      this.load.image(`enemy_ship_${lvl}`, ENEMY_ASSETS[lvl]);
      for (let i = 0; i < 10; i++) {
        const n = String(i).padStart(3, '0');
        this.load.image(`enemy${lvl}-fr-${n}`, `/assets/PNG/Ship_02/Exhaust/Exhaust_${lvl}_2_${n}.png`);
      }
      for (let i = 0; i < 9; i++) {
        const n = String(i).padStart(3, '0');
        this.load.image(`enemy${lvl}-ex-${n}`, `/assets/PNG/Ship_02/Explosion/Explosion_${lvl}_${n}.png`);
      }
    }
    this.load.image('bg-01', '/assets/Backgrounds/PNG_and_JPG/background_04_parallax_01.png');
    this.load.image('bg-02', '/assets/Backgrounds/PNG_and_JPG/background_04_parallax_02.png');
    this.load.image('bg-03', '/assets/Backgrounds/PNG_and_JPG/background_04_parallax_03.png');
    this.load.image('bg-04', '/assets/Backgrounds/PNG_and_JPG/background_04_parallax_04.png');
    for (let g = 1; g <= GUN_LEVELS; g++) {
      const k = String(g).padStart(2, '0');
      this.load.image(`gun-${k}-idle`, `/assets/PNG/Guns/Gun${k}/Idle/Gun${k}-Idle_0.png`);
      for (let f = 0; f < 10; f++) {
        const ff = String(f).padStart(2, '0');
        this.load.image(`gun-${k}-shoot-${ff}`, `/assets/PNG/Guns/Gun${k}/Shoot/Gun${k}-Shoot_${ff}.png`);
      }
    }
    for (const [v, meta] of Object.entries(ASTEROID_VARIANTS)) {
      this.load.spritesheet(`a-${v}`,
        `/assets/Asteroids/PNG/asteroid_${v}_with_cracks.png`,
        { frameWidth: meta.w, frameHeight: meta.h });
    }
    // Assets UI in-world : barre de vie, icone de repop, fleche d'amelioration tourelle
    this.load.image('healthbar', '/assets/PNG/HealthBar.png');
    this.load.image('healthbar-line', '/assets/PNG/HealthBar_Line.png');
    this.load.image('time-icon', '/assets/PNG/TimeIcon.png');
    this.load.image('upgrade-arrow', '/assets/PNG/User%20interfaces/Shopping%20popup/upgrade%20arrow.png');
    this.load.image('enemy-hp-bg', '/assets/PNG/User%20interfaces/enemy%20hp%20bar/enemy%20hp%20bar%20bg.png');
    this.load.image('enemy-hp-fg', '/assets/PNG/User%20interfaces/enemy%20hp%20bar/enemy%20hp%20bar%20fg.png');
    // Explosion de la base (Explosion_3, 8 frames)
    for (let i = 1; i <= 8; i++) {
      this.load.image(`base-ex-${i}`, `/assets/PNG/Ship_Effects/Explosion/Explosion_3_${String(i).padStart(3, '0')}.png`);
    }
    // Icones d'actions (overlay in-world) + fond de badge compteur
    this.load.image('act-tir', '/assets/PNG/Ability02.png');
    this.load.image('act-visee', '/assets/PNG/Ability14.png');
    this.load.image('act-reparation', '/assets/PNG/Ability21.png');
    this.load.image('act-remplir', '/assets/PNG/Ability10.png');
    this.load.image('act-minage', '/assets/PNG/Ability24.png');
    this.load.image('bg-hud-icon', '/assets/PNG/Bg_Hud-Icon.png');
    this.load.spritesheet('turret-explosion', '/assets/Explosions/PNG/explosion.png', { frameWidth: 140, frameHeight: 140 });
    this.load.image('turret-alarm', '/assets/HUD/PNG/points_powerup_lifes_05_life_indicator_alarm.png');
    this.load.image('turret-life', '/assets/HUD/PNG/points_powerup_lifes_05_life_indicator.png');
    this.load.image('bullet-ship', '/assets/Weapons/PNG/bullet_blaster_small1.png');
    this.load.image('bullet-turret', '/assets/Weapons/PNG/bullet_blaster_big1.png');
    this.load.image('bullet-enemy', '/assets/Weapons/PNG/bullet_short6.png');
  }

  create() {
    this.cameras.main.setBackgroundColor('#04060a');

    // Background parallax (background_04)
    this.setupParallaxBackground();

    // Animations vaisseaux
    this.createShipAnimations();

    // Setup textures
    this.createTurretTexture();
    this.createExplosionTexture();

    // Containers
    this.elementSprites = new Map();
    this.elementHighlights = new Map();
    this.enemies = new Set();
    this.bullets = [];
    this.waveWarnIcon = null;
    // Verrouillage de cible (clic sur un ennemi) : le vaisseau le vise, tir a Espace.
    this.lockedEnemy = null;
    this.lockReticle = null;
    this.keySpace = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    { const _lb = document.getElementById('lockBtn'); if (_lb) _lb.onclick = () => this.clearLock(); }

    // Thruster particle texture
    const tg = this.make.graphics({ x: 0, y: 0, add: false });
    tg.fillStyle(0xff8844, 1);
    tg.fillCircle(4, 4, 4);
    tg.generateTexture('thrust', 8, 8);
    tg.destroy();

    const _shipStart = pendingShipPos || { x: WORLD_W / 2, y: WORLD_H / 2 + 230, rotation: 0 };
    this.ship = this.physics.add.sprite(_shipStart.x, _shipStart.y, 'ship-fr-000');
    this.ship.setScale(SHIP_SCALE).setOrigin(0.5, 0.36).setDepth(7); // au-dessus des assets (base/tourelles/asteroides en depth 0)
    if (typeof _shipStart.rotation === 'number') this.ship.rotation = _shipStart.rotation;
    pendingShipPos = null;
    this.ship.play('ship-thrust');
    this.ship._hp = 100;
    this.ship._hpMax = 100;
    // Cliquable : ouvre le menu d'actions du vaisseau (tir / portee, comme une tourelle).
    // Hit area = cercle generous en coords texture (vaisseau scale 0.035, sprite ~25px ecran).
    this.ship.setInteractive({
      hitArea: new Phaser.Geom.Circle(this.ship.width / 2, this.ship.height / 2, Math.max(this.ship.width, this.ship.height) * 0.7),
      hitAreaCallback: Phaser.Geom.Circle.Contains,
      useHandCursor: true
    });
    this.ship.on('pointerdown', (pointer) => {
      if (pointer.button !== 0) return;
      if (this._panState) this._panState.pendingMenu = { id: 'ship-1', event: pointer.event };
    });

    // Flamme de reacteur attachee a l'arriere du vaisseau (sprite anime 7 frames)
    this.shipFlame = this.add.sprite(this.ship.x, this.ship.y, 'rocket-flame', 0)
      .setScale(0.8)
      .setOrigin(0.5, 0) // top de la flamme = point d'ancrage (la flamme tombe vers le bas)
      .setDepth(this.ship.depth - 1);
    this.shipFlame.play('rocket-flame-loop');
    this.shipHpBar = this.makeHpBar(this.ship.x, this.ship.y - 40, 60, 0x4fdb73);
    this.shipHpBar.setDepth(11);
    this.ship.setDamping(true);
    this.ship.setDrag(0.92);
    this.ship.setMaxVelocity(140);

    // Pseudo de l'Amiral qui suit le vaisseau
    this.shipLabel = this.add.text(this.ship.x, this.ship.y - 56, amiralDisplayName, {
      fontFamily: 'Consolas, monospace', fontSize: '13px', color: '#ff8044',
      stroke: '#000', strokeThickness: 3, fontStyle: 'bold'
    }).setOrigin(0.5).setDepth(11);

    // Cercle "grande base"
    this.drawBasePerimeter();

    // Caméra : systeme de "cases". La camera reste centree sur la case courante
    // (WORLD_W x WORLD_H) et bascule sur la voisine quand le vaisseau franchit une
    // frontiere (= sort de l'ecran). Pas de follow continu, pas de derive au zoom.
    this._userZoomFactor = 0.5; // demarre dezoome (vue ~2x plus large que la case)
    this.applyFitZoom();
    SharedScene.updateCaseCamera(this, this.ship.x, this.ship.y); // centrage initial sur la case du vaisseau
    // Minimap : uniquement si la carte a plusieurs cases (sinon inutile -> on la laisse cachee).
    const multiCase = (MAP_BOUNDS.maxI > MAP_BOUNDS.minI) || (MAP_BOUNDS.maxJ > MAP_BOUNDS.minJ);
    if (multiCase) {
      this._minimap = SharedScene.setupMinimap({ bounds: MAP_BOUNDS, onTp: (wx, wy) => SharedScene.tpCameraTo(this, wx, wy, true) });
      document.getElementById('minimap')?.classList.remove('hidden');
      document.getElementById('minimapLabel')?.classList.remove('hidden');
    }
    this.scale.on('resize', () => this.onResize());
    // Zoom molette (vers le curseur) + deplacement (drag), bornes a la case courante.
    this.input.on('wheel', (pointer, _g, _dx, deltaY) => {
      this._userZoomFactor = Phaser.Math.Clamp(this._userZoomFactor - deltaY * 0.0006, ZOOM_FACTOR_MIN, ZOOM_FACTOR_MAX);
      SharedScene.zoomView(this, pointer, () => this.applyFitZoom());
    });

    this.thrust = this.add.particles(0, 0, 'thrust', {
      speed: { min: 30, max: 70 },
      scale: { start: 1, end: 0 },
      alpha: { start: 0.8, end: 0 },
      lifespan: 280,
      blendMode: 'ADD',
      frequency: 30,
      emitting: false,
      follow: this.ship
    });

    // Marqueur visuel de destination (clic droit)
    this.destMarker = this.add.circle(0, 0, 14, 0x4f8aff, 0.0).setStrokeStyle(2, 0x4f8aff, 0.9);
    this.destination = null;

    // Clic droit = définir la destination + reaccroche la camera au vaisseau
    this.input.mouse.disableContextMenu();
    this.input.on('pointerdown', (pointer) => {
      if (pointer.rightButtonDown()) {
        this.destination = { x: pointer.worldX, y: pointer.worldY };
        this.destMarker.setPosition(pointer.worldX, pointer.worldY);
        this.destMarker.setFillStyle(0x4f8aff, 0.25);
        this.tweens.killTweensOf(this.destMarker);
        this.tweens.add({
          targets: this.destMarker,
          scale: { from: 1.6, to: 1 },
          duration: 240,
          ease: 'Back.easeOut'
        });
      }
    });

    // Drag-to-pan (clic gauche maintenu) : panoramique style MOBA, libere la camera du vaisseau
    this._panState = { active: false, lastX: 0, lastY: 0, moved: 0, pendingMenu: null };
    const DRAG_THRESHOLD_PX = 6;
    this.input.on('pointerdown', (pointer) => {
      if (pointer.button !== 0) return;
      this._panState.active = true;
      this._panState.lastX = pointer.x;
      this._panState.lastY = pointer.y;
      this._panState.moved = 0;
    });
    this.input.on('pointermove', (pointer) => {
      if (!this._panState.active) return;
      const dx = pointer.x - this._panState.lastX;
      const dy = pointer.y - this._panState.lastY;
      this._panState.lastX = pointer.x;
      this._panState.lastY = pointer.y;
      this._panState.moved += Math.hypot(dx, dy);
      if (this._panState.moved > DRAG_THRESHOLD_PX) {
        // Deplacement borne a la case (centre suivi, pas de manip directe du scroll).
        SharedScene.panView(this, dx, dy);
      }
    });
    this.input.on('pointerup', (pointer) => {
      if (pointer.button !== 0) return;
      const wasPanning = this._panState.moved > DRAG_THRESHOLD_PX;
      const pm = this._panState.pendingMenu;
      if (!wasPanning && pm) {
        if (pm.lockEnemy) this.toggleLock(pm.lockEnemy); // clic sur un ennemi = (de)verrouiller
        else openActionMenu(pm.id, pm.event);
      }
      this._panState.active = false;
      this._panState.moved = 0;
      this._panState.pendingMenu = null;
    });

    this.lastSend = 0;
    if (serverElements.length > 0) this.setupElements(serverElements);
    if (pendingWave) {
      this.handleWaveIncoming(pendingWave);
      pendingWave = null;
    }
  }

  createTurretTexture() {
    const g = this.make.graphics({ x: 0, y: 0, add: false });
    g.fillStyle(0x1a2335, 1);
    g.fillCircle(40, 40, 30);
    g.lineStyle(2, 0xff8044, 1);
    g.strokeCircle(40, 40, 30);
    g.fillStyle(0x2a3550, 1);
    g.fillCircle(40, 40, 20);
    g.lineStyle(1.5, 0xff4f6d, 0.8);
    g.strokeCircle(40, 40, 20);
    g.fillStyle(0x404a60, 1);
    g.fillRect(34, 8, 12, 32);
    g.lineStyle(1.5, 0xff8044, 1);
    g.strokeRect(34, 8, 12, 32);
    g.fillStyle(0xff4f6d, 1);
    g.fillRect(33, 4, 14, 6);
    g.fillStyle(0xff4f6d, 1);
    g.fillCircle(40, 40, 4);
    g.generateTexture('turret', 80, 80);
    g.destroy();
  }

  createExplosionTexture() {
    if (this.textures.exists('explosion-dot')) return;
    const g = this.make.graphics({ x: 0, y: 0, add: false });
    g.fillStyle(0xff6644, 1);
    g.fillCircle(4, 4, 4);
    g.generateTexture('explosion-dot', 8, 8);
    g.destroy();
  }

  createShipAnimations() {
    const mkFrames = (prefix, count, pad) =>
      Array.from({ length: count }, (_, i) => ({ key: `${prefix}${String(i).padStart(pad || 3, '0')}` }));
    if (!this.anims.exists('ship-thrust')) {
      this.anims.create({ key: 'ship-thrust', frames: mkFrames('ship-fr-', 10, 3), frameRate: 24, repeat: -1 });
    }
    if (!this.anims.exists('rocket-flame-loop')) {
      this.anims.create({
        key: 'rocket-flame-loop',
        frames: this.anims.generateFrameNumbers('rocket-flame', { start: 0, end: 6 }),
        frameRate: 18, repeat: -1
      });
    }
    for (const lvl of ENEMY_LEVELS) {
      const thr = `enemy${lvl}-thrust`;
      if (!this.anims.exists(thr)) {
        this.anims.create({ key: thr, frames: mkFrames(`enemy${lvl}-fr-`, 10, 3), frameRate: 24, repeat: -1 });
      }
      const ex = `enemy${lvl}-explode`;
      if (!this.anims.exists(ex)) {
        this.anims.create({ key: ex, frames: mkFrames(`enemy${lvl}-ex-`, 9, 3), frameRate: 22, repeat: 0 });
      }
    }
    for (let g = 1; g <= GUN_LEVELS; g++) {
      const k = String(g).padStart(2, '0');
      const key = `gun-${k}-shoot`;
      if (!this.anims.exists(key)) {
        this.anims.create({ key, frames: mkFrames(`gun-${k}-shoot-`, 10, 2), frameRate: 30, repeat: 0 });
      }
    }
    // Explosion de la base (Explosion_3, frames 1..8)
    if (!this.anims.exists('base-explode')) {
      this.anims.create({
        key: 'base-explode',
        frames: Array.from({ length: 8 }, (_, i) => ({ key: `base-ex-${i + 1}` })),
        frameRate: 18, repeat: 0
      });
    }
    // Explosion de tourelle (spritesheet explosion.png, 9 frames)
    if (this.textures.exists('turret-explosion') && !this.anims.exists('turret-explode')) {
      this.anims.create({
        key: 'turret-explode',
        frames: this.anims.generateFrameNumbers('turret-explosion', { start: 0, end: 8 }),
        frameRate: 20, repeat: 0
      });
    }
  }

  enterTurretDead(id) {
    const sprite = this.elementSprites.get(id);
    if (!sprite || sprite._dead) return;
    sprite._dead = true;
    const bar = this.elementHpBars && this.elementHpBars.get(id);
    if (bar) bar.setVisible(false);
    if (sprite._patrolTween) sprite._patrolTween.stop();
    if (sprite.anims && sprite.anims.isPlaying) sprite.anims.stop();
    if (this.anims.exists('turret-explode')) {
      const ex = this.add.sprite(sprite.x, sprite.y, 'turret-explosion', 0).setDepth(12).setScale(0.95);
      ex.play('turret-explode');
      ex.once('animationcomplete', () => ex.destroy());
    }
    sprite.setVisible(false); // plus d'asset
    this.showTurretHeart(id, sprite, 'turret-alarm');
  }
  updateTurretDeadVisual(id, st) {
    const sprite = this.elementSprites.get(id);
    if (!sprite) return;
    if (st.hp > 0) { sprite.setVisible(true); sprite.setAlpha(0.4); sprite.clearTint(); sprite.setTint(0x666666); }
    else sprite.setVisible(false);
  }
  showTurretHeart(id, sprite, texKey) {
    if (sprite._heart) { sprite._heart.destroy(); sprite._heart = null; }
    if (!this.textures.exists(texKey)) return;
    const target = Math.max(sprite.displayWidth, sprite.displayHeight) * 0.6 || 36;
    const ico = this.add.image(sprite.x, sprite.y, texKey).setDepth(13);
    const base = target / (ico.width || target);
    ico.setScale(base); ico._baseScale = base;
    ico.setInteractive({ useHandCursor: true });
    ico.on('pointerdown', (pointer) => {
      if (pointer.button !== 0) return;
      if (this._panState) this._panState.pendingMenu = { id, event: pointer.event };
    });
    ico._pulse = this.tweens.add({ targets: ico, scaleX: { from: base, to: base * 1.25 }, scaleY: { from: base, to: base * 1.25 },
      yoyo: true, repeat: -1, duration: 600, ease: 'Sine.easeInOut' });
    sprite._heart = ico;
  }
  exitTurretDead(id) {
    const sprite = this.elementSprites.get(id);
    if (!sprite) return;
    sprite._dead = false;
    sprite.setVisible(true); sprite.setAlpha(1); sprite.clearTint();
    sprite._gunLevel = null; sprite._currentAnim = null;
    const bar = this.elementHpBars && this.elementHpBars.get(id);
    if (bar) bar.setVisible(true);
    this.updateTurretAppearance(id);
    const heart = sprite._heart; sprite._heart = null;
    if (heart) {
      if (heart._pulse) heart._pulse.stop();
      heart.disableInteractive();
      if (this.textures.exists('turret-life')) {
        heart.setTexture('turret-life');
        const t = Math.max(sprite.displayWidth, sprite.displayHeight) * 0.6 || 36;
        heart.setScale(t / (heart.width || t));
      }
      this.tweens.add({ targets: heart, alpha: 0, scaleX: heart.scaleX * 1.5, scaleY: heart.scaleY * 1.5,
        duration: 600, ease: 'Sine.easeOut', onComplete: () => heart.destroy() });
    }
  }

  playBaseExplosion() {
    if (!this.anims.exists('base-explode')) return;
    // Masque la barre de vie de la base.
    if (this.elementHpBars) {
      for (const el of serverElements) {
        if (el.type === 'base') { const b = this.elementHpBars.get(el.id); if (b) b.setVisible(false); }
      }
    }
    const cx = BASE_X, cy = BASE_Y;
    const bursts = [
      { dx: 0, dy: 0, s: 0.42, d: 0 },
      { dx: -110, dy: -50, s: 0.22, d: 140 },
      { dx: 100, dy: 70, s: 0.26, d: 260 },
      { dx: 60, dy: -110, s: 0.20, d: 380 },
      { dx: -80, dy: 90, s: 0.24, d: 500 },
      { dx: 0, dy: 0, s: 0.52, d: 600 }
    ];
    for (const b of bursts) {
      this.time.delayedCall(b.d, () => {
        const ex = this.add.sprite(cx + b.dx, cy + b.dy, 'base-ex-1').setScale(b.s).setDepth(13);
        ex.play('base-explode');
        ex.once('animationcomplete', () => ex.destroy());
      });
    }
  }

  setupParallaxBackground() {
    const w = this.scale.gameSize.width;
    const h = this.scale.gameSize.height;
    // Fond principal qui couvre le viewport (suit la camera)
    this.bgLayer01 = this.add.image(w / 2, h / 2, 'bg-01')
      .setOrigin(0.5).setScrollFactor(0).setDepth(-100);
    // Petite planete parallax dans le monde
    this.bgLayer03 = this.add.image(2200, 1200, 'bg-03')
      .setOrigin(0.5).setScrollFactor(0.35).setDepth(-80).setScale(0.4);
    this.updateParallaxBackground();
  }

  updateParallaxBackground() {
    if (!this.bgLayer01) return;
    const cam = this.cameras.main;
    const z = cam.zoom;
    const src01 = this.textures.get('bg-01').getSourceImage();
    const cover01 = Math.max(cam.width / src01.width, cam.height / src01.height) * 1.05;
    this.bgLayer01.setScale(cover01 / z);
  }

  applyFitZoom() {
    const cam = this.cameras.main;
    // "Fit" : la case entiere est TOUJOURS visible (rien n'est rogne, asteroides compris).
    // Le zoom s'ajuste a l'ecran ; l'espace en plus (ecran non 16:9) montre la nebuleuse.
    const fit = Math.min(cam.width / WORLD_W, cam.height / WORLD_H);
    cam.setZoom(fit * (this._userZoomFactor || 1));
  }

  onResize() {
    const w = this.scale.gameSize.width;
    const h = this.scale.gameSize.height;
    this.cameras.main.setSize(w, h);
    this.applyFitZoom();
    SharedScene.recenterCurrentCase(this);
    if (this.bgLayer01) this.bgLayer01.setPosition(w / 2, h / 2);
    this.updateParallaxBackground();
  }

  // Pas de bouclier visuel autour de la base (la base n'a pas de shield).
  // On nettoie d'eventuels restes ; BASE_PERIMETER reste utilise par l'IA ennemie.
  drawBasePerimeter() {
    if (this.basePerimeterGfx) { this.basePerimeterGfx.destroy(); this.basePerimeterGfx = null; }
    if (this.basePerimeterHalo) { this.basePerimeterHalo.destroy(); this.basePerimeterHalo = null; }
    if (this.shieldSprite) { this.shieldSprite.destroy(); this.shieldSprite = null; }
  }

  setupElements(elements) {
    if (!Array.isArray(elements)) return;
    for (const s of this.elementSprites.values()) s.destroy();
    for (const h of this.elementHighlights.values()) h.destroy();
    if (this.elementHpBars) for (const b of this.elementHpBars.values()) b.destroy();
    if (this.elementRespawnTimers) for (const t of this.elementRespawnTimers.values()) t.destroy();
    SharedScene.clearAllGroupRespawnTimers(this);
    this.elementSprites.clear();
    this.elementHighlights.clear();
    this.elementHpBars = new Map();
    this.elementRespawnTimers = new Map();

    this.createBaseTexture();

    // Pour les asteroides, on partage UNE seule barre par subtype (materiaux / radius).
    // La barre est attachee au premier asteroide rencontre de chaque type ; les autres
    // n'ont pas de barre individuelle.
    const groupBarSubtypes = new Set();

    elements.forEach((el, i) => {
      if (el.type === 'asteroid') {
        const variant = el.variant || '01';
        const meta = ASTEROID_VARIANTS[variant] || ASTEROID_VARIANTS['01'];
        const phaserScale = asteroidScaleFor(variant, el.scale);
        const tint = el.subtype === 'radius' ? 0x88e0c8 : 0xffffff;
        const visibleSize = Math.max(meta.w, meta.h) * phaserScale;
        const tex = this.textures.get(`a-${variant}`);
        if (tex) tex.setFilter(Phaser.Textures.FilterMode.NEAREST);
        const highlight = this.add.circle(el.x, el.y, visibleSize * 0.6, 0xffd24f, 0)
          .setStrokeStyle(3, 0xffd24f, 0);
        const sprite = this.add.sprite(el.x, el.y, `a-${variant}`, 0)
          .setScale(phaserScale)
          .setRotation(Math.random() * Math.PI * 2)
          .setTint(tint)
          .setInteractive({ useHandCursor: true });
        sprite.on('pointerdown', (pointer) => {
          if (pointer.button !== 0) return;
          // Defer : on memorise l'intent ; le menu s'ouvrira au pointerup si pas de drag
          if (this._panState) this._panState.pendingMenu = { id: el.id, event: pointer.event };
        });
        // Asteroides statiques : rotation aleatoire fixee a l'init, pas d'animation
        sprite._asteroidVariant = variant;
        this.elementSprites.set(el.id, sprite);
        this.elementHighlights.set(el.id, highlight);
        // Pas de barre HP visible sur les asteroides : l'info est dans le menu d'action au clic
      } else if (el.type === 'turret') {
        const highlight = this.add.circle(el.x, el.y, 60, 0xff4f6d, 0)
          .setStrokeStyle(2, 0xff4f6d, 0);
        const outward = Math.atan2(el.y - BASE_Y, el.x - BASE_X);
        const baseRot = outward + Math.PI / 2;
        const sprite = this.add.sprite(el.x, el.y, 'gun-01-idle')
          .setScale(GUN_SCALE)
          .setRotation(baseRot)
          .setInteractive({ useHandCursor: true });
        sprite.on('pointerdown', (pointer) => {
          if (pointer.button !== 0) return;
          // Defer : on memorise l'intent ; le menu s'ouvrira au pointerup si pas de drag
          if (this._panState) this._panState.pendingMenu = { id: el.id, event: pointer.event };
        });
        sprite._baseRotation = baseRot;
        // Patrouille discrete : toutes les 5s, tire un angle aleatoire entre baseRot et baseRot + π/4 ;
        // la tourelle pivote vers cet angle (transition courte) puis y reste jusqu'au prochain tirage.
        const PATROL_AMP = Math.PI / 4;
        const pickNewPatrolTarget = () => {
          // Tourelle desactivee (base hors tension) ou detruite -> pas de patrouille (figee).
          const stt = elementStates.get(el.id);
          if (!sprite.active || sprite._targetingEnemy || !SharedScene.isBasePowered() || (stt && stt.dead)) return;
          // Cible = angle voulu, ramene au PLUS COURT chemin depuis la rotation courante
          // (sinon, si baseRot depasse ±π, le tween fait un tour complet — bug tourelle SO).
          const wanted = Phaser.Math.Angle.Wrap(baseRot + Math.random() * PATROL_AMP);
          const target = sprite.rotation + Phaser.Math.Angle.Wrap(wanted - sprite.rotation);
          if (sprite._patrolTween) sprite._patrolTween.stop();
          sprite._patrolTween = this.tweens.add({
            targets: sprite,
            rotation: target,
            duration: 800,
            ease: 'Sine.easeInOut'
          });
        };
        pickNewPatrolTarget();
        sprite._patrolEvent = this.time.addEvent({ delay: 5000, loop: true, callback: pickNewPatrolTarget });
        sprite._turretId = el.id;
        this.elementSprites.set(el.id, sprite);
        this.elementHighlights.set(el.id, highlight);
        this.elementHpBars.set(el.id, this.makeHpBar(el.x, el.y - 70, 90, 0xff4f6d));
      } else if (el.type === 'base') {
        const highlight = this.add.circle(el.x, el.y, 120, 0x4af, 0)
          .setStrokeStyle(2, 0x4af, 0);
        const sprite = this.add.image(el.x, el.y, 'mothership-base').setScale(0.9)
          .setInteractive({ useHandCursor: true });
        sprite.on('pointerdown', (pointer) => {
          if (pointer.button !== 0) return;
          // Defer : on memorise l'intent ; le menu s'ouvrira au pointerup si pas de drag
          if (this._panState) this._panState.pendingMenu = { id: el.id, event: pointer.event };
        });
        this.baseElementId = el.id;
        this.elementSprites.set(el.id, sprite);
        this.elementHighlights.set(el.id, highlight);
        this.elementHpBars.set(el.id, this.makeHpBar(el.x, el.y - 88, 120, 0x4af));
      }
    });
    this.refreshElementHighlights(lastActiveElements);
    this.applyAllElementStates();
    SharedScene.refreshActionOverlay(this, lastActiveElements, activeAction?.element_id);
  }

  makeHpBar(x, y, width, strokeColor) {
    return SharedScene.makeImageHpBar(this, x, y, width);
  }

  applyAllElementStates() {
    if (!this.elementHpBars) return;
    for (const [id, bar] of this.elementHpBars.entries()) {
      const state = elementStates.get(id);
      if (!state) continue;
      const ratio = Math.max(0, Math.min(1, state.hp / state.hpMax));
      const w = bar.maxWidth * ratio;
      bar.fill.width = Math.max(0, w);
      let color = 0x4fdb73;
      if (ratio < 0.3) color = 0xff4f6d;
      else if (ratio < 0.6) color = 0xffd24f;
      bar.fill.fillColor = color;
      const sprite = this.elementSprites.get(id);
      if (sprite && sprite._asteroidVariant) {
        sprite.setFrame(asteroidFrameFor(sprite._asteroidVariant, ratio));
      }
    }
    for (const el of serverElements) {
      if (el.type !== 'turret') continue;
      const st = elementStates.get(el.id);
      const sp = this.elementSprites.get(el.id);
      if (st && sp) {
        if (st.dead && !sp._dead) this.enterTurretDead(el.id);
        else if (!st.dead && sp._dead) this.exitTurretDead(el.id);
        else if (st.dead && sp._dead) this.updateTurretDeadVisual(el.id, st);
      }
      if (sp && !sp._dead) this.updateTurretAppearance(el.id);
    }
  }

  updateTurretTargeting() {
    if (!this.elementSprites || !this.enemies) return;
    const now = Date.now();
    const powered = SharedScene.isBasePowered();
    for (const el of serverElements) {
      if (el.type !== 'turret') continue;
      const sprite = this.elementSprites.get(el.id);
      const state = elementStates.get(el.id);
      if (!sprite || !state) continue;
      // Tourelle detruite : inactive (pas de tir ; apparence + coeur geres par enterTurretDead).
      if (state.dead) { sprite._targetingEnemy = false; sprite._firing = false; continue; }
      SharedScene.applyTurretPowerVisual(sprite, powered);
      // Base hors tension : la tourelle est desactivee et FIGE (on stoppe la patrouille).
      if (!powered) {
        sprite._targetingEnemy = false; sprite._firing = false;
        if (sprite._patrolTween) sprite._patrolTween.stop();
        this.updateTurretAppearance(el.id);
        continue;
      }
      // Tourelle autonome : tire sur l'ennemi le plus proche en portee.
      const range = turretRangePx(state);
      const target = this.findNearestEnemyInRange(sprite.x, sprite.y, range);
      if (target) {
        // Stoppe la patrouille pour ne pas se battre avec le tween
        if (sprite._patrolTween) sprite._patrolTween.stop();
        sprite._targetingEnemy = true;
        sprite._firing = true; // -> anim de tir (updateTurretAppearance)
        const a = Phaser.Math.Angle.Between(sprite.x, sprite.y, target.x, target.y);
        // Ciblage : rotation LIBRE 360° pour suivre l'ennemi (plus court chemin). Le clamp
        // ±90° vers l'exterieur ne s'applique qu'au repos (patrouille), cf. pickNewPatrolTarget.
        const desiredRot = a + Math.PI / 2;
        sprite.rotation += Phaser.Math.Angle.Wrap(desiredRot - sprite.rotation);
        if (!sprite._lastShotAt) sprite._lastShotAt = 0;
        // Cadence de tir : 2s de base, descend a ~1s si tir est tres ameliore
        const fireDelay = Math.max(1000, 2000 - (state.puissance || 0) * 30);
        if (now - sprite._lastShotAt >= fireDelay) {
          const dmg = 5 + Math.floor((state.puissance || 0) * 0.5);
          this.playTurretShoot(sprite, turretGunLevel(state.puissance)); // anim UNIQUEMENT au tir
          this.fireTurretLaser(sprite, target);
          this.damageEnemy(target, dmg);
          sprite._lastShotAt = now;
        }
      } else {
        // Pas d'ennemi : la patrouille reprend au prochain tick du timer (max 5s)
        sprite._targetingEnemy = false;
        sprite._firing = false;
      }
      this.updateTurretAppearance(el.id); // synchronise l'anim tir/idle avec _firing
    }
  }

  // Tir tourelle : projectile bullet_blaster_big1 vers l'ennemi (tracer).
  fireTurretLaser(turretSprite, enemySprite) {
    const a = Phaser.Math.Angle.Between(turretSprite.x, turretSprite.y, enemySprite.x, enemySprite.y);
    // dmg:0 -> degats deja appliques par updateTurretTargeting ; le projectile disparait
    // simplement au contact d'un ennemi (hitEnemies).
    this.spawnBullet(turretSprite.x, turretSprite.y, a, 'bullet-turret', { scale: 0.6, speed: 820, hitEnemies: true, dmg: 0 });
  }

  // ===== Projectiles =====
  spawnBullet(x, y, angle, texKey, opts) {
    if (!this.bullets) this.bullets = [];
    opts = opts || {};
    if (!this.textures.exists(texKey)) return null;
    const b = this.add.image(x, y, texKey).setDepth(9).setRotation(angle + Math.PI / 2).setScale(opts.scale || 0.7);
    const speed = opts.speed || 700;
    b._vx = Math.cos(angle) * speed; b._vy = Math.sin(angle) * speed;
    b._life = opts.life || 1400;
    b._hitEnemies = !!opts.hitEnemies; b._dmg = opts.dmg || 0;
    b._hitDefenders = !!opts.hitDefenders;
    this.bullets.push(b);
    return b;
  }
  bulletHitsDefender(bx, by) {
    if (this.elementSprites) {
      for (const el of serverElements) {
        if (el.type !== 'turret' && el.type !== 'base' && el.type !== 'asteroid') continue;
        const sp = this.elementSprites.get(el.id);
        if (!sp || !sp.visible || sp.alpha < 0.5) continue;
        const r = Math.max(sp.displayWidth, sp.displayHeight) * 0.4;
        if (Phaser.Math.Distance.Between(bx, by, sp.x, sp.y) < r) return sp;
      }
    }
    if (this.ship && this.ship.active) {
      const r = Math.max(this.ship.displayWidth, this.ship.displayHeight) * 0.55;
      if (Phaser.Math.Distance.Between(bx, by, this.ship.x, this.ship.y) < r) return this.ship;
    }
    return null;
  }
  impactFlash(x, y) {
    const f = this.add.circle(x, y, 5, 0xffffff, 0.95).setDepth(10);
    this.tweens.add({ targets: f, scale: 2.6, alpha: 0, duration: 200, ease: 'Quad.easeOut', onComplete: () => f.destroy() });
  }
  // Verrouillage : clic sur un ennemi le (de)verrouille. Le vaisseau le vise, tir a Espace.
  toggleLock(enemy) {
    if (this.lockedEnemy === enemy) { this.clearLock(); return; }
    this.lockedEnemy = enemy;
    if (!this.lockReticle) {
      this.lockReticle = this.add.circle(enemy.x, enemy.y, 34, 0xff4f6d, 0)
        .setStrokeStyle(2.5, 0xff4f6d, 0.95).setDepth(11);
      this.tweens.add({ targets: this.lockReticle, scaleX: { from: 1, to: 1.18 }, scaleY: { from: 1, to: 1.18 },
        yoyo: true, repeat: -1, duration: 600, ease: 'Sine.easeInOut' });
    }
    this.lockReticle.setPosition(enemy.x, enemy.y).setVisible(true);
    const btn = document.getElementById('lockBtn'); if (btn) btn.classList.remove('hidden');
  }
  clearLock() {
    this.lockedEnemy = null;
    if (this.lockReticle) this.lockReticle.setVisible(false);
    const btn = document.getElementById('lockBtn'); if (btn) btn.classList.add('hidden');
  }
  // Tir sur la cible verrouillee (touche Espace), cadence limitee. Diffuse aux viewers.
  tryFireLocked() {
    if (!this.ship || !this.ship.active || !this.lockedEnemy || !this.lockedEnemy.active) return;
    const now = this.time.now;
    if (this.ship._lastShotAt && now - this.ship._lastShotAt < 200) return;
    this.ship._lastShotAt = now;
    const a = Phaser.Math.Angle.Between(this.ship.x, this.ship.y, this.lockedEnemy.x, this.lockedEnemy.y);
    const state = elementStates.get('ship-1') || {};
    const dmg = 5 + Math.floor((state.puissance || 0) * 0.5);
    this.spawnBullet(this.ship.x, this.ship.y, a, 'bullet-ship', { scale: 0.7, speed: 900, hitEnemies: true, dmg });
    if (typeof socket !== 'undefined' && socket) socket.emit('ship:fire', { x: this.ship.x, y: this.ship.y, angle: a });
  }
  updateBullets(delta) {
    if (!this.bullets || !this.bullets.length) return;
    const dt = (delta || 16) / 1000;
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.x += b._vx * dt; b.y += b._vy * dt; b._life -= (delta || 16);
      let hit = false;
      if (b._hitEnemies && this.enemies) {
        for (const e of this.enemies) {
          if (e.active && Phaser.Math.Distance.Between(b.x, b.y, e.x, e.y) < 28) {
            if (b._dmg) this.damageEnemy(e, b._dmg);
            this.impactFlash(b.x, b.y); hit = true; break;
          }
        }
      } else if (b._hitDefenders) {
        if (this.bulletHitsDefender(b.x, b.y)) { this.impactFlash(b.x, b.y); hit = true; }
      }
      if (hit || b._life <= 0) { b.destroy(); this.bullets.splice(i, 1); }
    }
  }

  // Cibles hostiles qu'un ennemi peut engager : asteroides vivants, tourelles, vaisseau du joueur.
  collectEnemyTargets() {
    const targets = [];
    if (this.elementSprites) {
      for (const el of serverElements) {
        if (el.type === 'asteroid') {
          const s = this.elementSprites.get(el.id);
          if (s && s.active && s.alpha > 0.5) targets.push({ kind: 'asteroid', sprite: s });
        } else if (el.type === 'turret') {
          const s = this.elementSprites.get(el.id);
          if (s && s.active && !s._dead) targets.push({ kind: 'turret', sprite: s, id: el.id });
        }
      }
    }
    if (this.ship && this.ship.active) targets.push({ kind: 'ship', sprite: this.ship });
    return targets;
  }

  updateEnemies(delta) {
    if (!this.enemies) return;
    const dtSec = (delta || 16) / 1000;
    const now = this.time.now;
    const targets = this.collectEnemyTargets();
    for (const sprite of this.enemies) {
      if (!sprite.active) continue;

      // Cible hostile la plus proche dans la range de detection
      let best = null, bestDist = ENEMY_DETECT_RANGE;
      for (const t of targets) {
        const d = Phaser.Math.Distance.Between(sprite.x, sprite.y, t.sprite.x, t.sprite.y);
        if (d < bestDist) { best = t; bestDist = d; }
      }

      let mode, cx, cy, orbitR;
      if (best) {
        mode = best.kind;
        cx = best.sprite.x; cy = best.sprite.y;
        orbitR = sprite._orbitRadius;
        // Nouvelle cible : on casse la trajectoire et on (re)part en approche
        if (sprite._engageRef !== best.sprite) {
          sprite._engageRef = best.sprite;
          sprite._engaging = false;
        }
      } else {
        // Aucune cible : on file vers la base centrale (orbite sans degats une fois arrive)
        if (sprite._engageRef !== 'base') {
          sprite._engageRef = 'base';
          sprite._engaging = false;
        }
        mode = 'base';
        cx = BASE_X; cy = BASE_Y;
        orbitR = BASE_PERIMETER + sprite._orbitRadius;
      }

      const distToCenter = Phaser.Math.Distance.Between(sprite.x, sprite.y, cx, cy);
      if (!sprite._engaging && distToCenter > orbitR + 6) {
        // Phase d'approche : on fonce en ligne droite vers la cible
        const dx = cx - sprite.x, dy = cy - sprite.y;
        const dn = distToCenter || 1;
        const step = ENEMY_SPEED_PX * dtSec;
        sprite.x += (dx / dn) * step;
        sprite.y += (dy / dn) * step;
        sprite.rotation = Math.atan2(dy, dx) + Math.PI / 2;
      } else {
        // Engagement : croisiere orbitale (avec variation) + passes d'attaque en ligne droite.
        if (!sprite._engaging) {
          sprite._engaging = true;
          sprite._orbitAngle = Math.atan2(sprite.y - cy, sprite.x - cx);
          sprite._phase = 'cruise';
          if (sprite._wobblePhase == null) sprite._wobblePhase = Math.random() * Math.PI * 2;
        }
        if (!sprite._lastFireAt) sprite._lastFireAt = now - Math.random() * ENEMY_FIRE_MS;
        this.updateEnemyEngage(sprite, cx, cy, orbitR, dtSec, now, mode, best);
      }

      if (sprite._hpBar) {
        sprite._hpBar.x = sprite.x;
        sprite._hpBar.y = sprite.y - 38;
      }
    }
  }

  // Voir player.js : cruise (orbite ondulante) -> pullback -> strafe (passe + tir) -> return.
  updateEnemyEngage(sprite, cx, cy, orbitR, dtSec, now, mode, best) {
    const step = ENEMY_SPEED_PX * dtSec;
    const turn = 5 * dtSec;
    const bearing = Math.atan2(sprite.y - cy, sprite.x - cx);
    const distT = Math.hypot(sprite.x - cx, sprite.y - cy) || 1;
    const dirAway = bearing + Math.PI / 2;
    const dirToward = bearing + Math.PI + Math.PI / 2;
    const moveFwd = (spd) => { const f = sprite.rotation - Math.PI / 2; sprite.x += Math.cos(f) * spd; sprite.y += Math.sin(f) * spd; };

    if (sprite._phase === 'exit') {
      sprite.rotation = Phaser.Math.Angle.RotateTo(sprite.rotation, dirAway, turn * 0.6);
      moveFwd(step * 1.6);
      if (distT >= orbitR + 130) { sprite._phase = 'dive'; sprite._firedThisRun = false; sprite._peelSide = Math.random() < 0.5 ? 1 : -1; }
      return;
    }
    if (sprite._phase === 'dive') {
      sprite.rotation = Phaser.Math.Angle.RotateTo(sprite.rotation, dirToward, turn * 1.3);
      moveFwd(step * 2.6);
      if (!sprite._firedThisRun && Math.abs(Phaser.Math.Angle.Wrap(dirToward - sprite.rotation)) < 0.2) {
        this.fireEnemyShot(sprite, cx, cy);
        sprite._firedThisRun = true;
        this.onEnemyFiredAt(mode, best);
      }
      if (distT <= Math.max(orbitR - 110, orbitR * 0.5)) sprite._phase = 'peel';
      return;
    }
    if (sprite._phase === 'peel') {
      sprite.rotation = Phaser.Math.Angle.RotateTo(sprite.rotation, dirAway + sprite._peelSide * (Math.PI / 4), turn);
      moveFwd(step * 1.8);
      if (distT >= orbitR) {
        sprite._phase = 'cruise';
        sprite._lastFireAt = now;
        sprite._orbitAngle = bearing;
      }
      return;
    }
    sprite._orbitAngle += sprite._orbitSpeed * dtSec;
    const r = orbitR + Math.sin(now * 0.0011 + sprite._wobblePhase) * (orbitR * 0.18);
    sprite.x = cx + Math.cos(sprite._orbitAngle) * r;
    sprite.y = cy + Math.sin(sprite._orbitAngle) * r;
    const tangent = sprite._orbitAngle + (sprite._orbitSpeed > 0 ? Math.PI / 2 : -Math.PI / 2) + Math.PI / 2;
    sprite.rotation = Phaser.Math.Angle.RotateTo(sprite.rotation, tangent, turn);
    if (now - sprite._lastFireAt >= ENEMY_FIRE_MS) sprite._phase = 'exit';
  }
  // Cote streameur : autoritatif -> on emet les degats (base / tourelle).
  onEnemyFiredAt(mode, best) {
    if (mode === 'base') socket.emit('streamer:base_hit');
    else if (mode === 'turret' && best && best.id) socket.emit('streamer:turret_hit', { id: best.id });
  }

  findNearestEnemyInRange(tx, ty, range) {
    let best = null, bestDist = range;
    for (const e of this.enemies) {
      const d = Phaser.Math.Distance.Between(tx, ty, e.x, e.y);
      if (d < bestDist) { best = e; bestDist = d; }
    }
    return best;
  }

  updateTurretAppearance(id) {
    const sprite = this.elementSprites.get(id);
    if (!sprite) return;
    const state = elementStates.get(id);
    if (!state) return;
    const level = turretGunLevel(state.puissance);
    if (sprite._gunLevel == null) sprite._gunLevel = level;
    else if (level > sprite._gunLevel) { this.showTurretUpgrade(sprite); sprite._gunLevel = level; }
    else sprite._gunLevel = level;
    const k = String(level).padStart(2, '0');
    const idleKey = `gun-${k}-idle`;
    const shootKey = `gun-${k}-shoot`;
    // L'anim de tir est jouee UNE FOIS au moment du tir (playTurretShoot). Ici on n'interrompt
    // pas une anim de tir en cours ; sinon on reste sur l'idle du niveau courant.
    if (sprite.anims && sprite.anims.isPlaying && sprite._currentAnim === shootKey) return;
    if (sprite.texture && sprite.texture.key !== idleKey) sprite.setTexture(idleKey);
    sprite._currentAnim = null;
  }

  playTurretShoot(sprite, level) {
    const shootKey = `gun-${String(level).padStart(2, '0')}-shoot`;
    if (!this.anims.exists(shootKey)) return;
    sprite._currentAnim = shootKey;
    sprite.play(shootKey);
  }

  // Fleche d'amelioration (upgrade arrow) en fondu rapide quand une tourelle monte de niveau.
  showTurretUpgrade(turretSprite) {
    if (!this.textures.exists('upgrade-arrow')) return;
    const arrow = this.add.image(turretSprite.x, turretSprite.y - 30, 'upgrade-arrow')
      .setDepth(12).setDisplaySize(26, 30).setAlpha(0);
    this.tweens.add({
      targets: arrow,
      y: turretSprite.y - 60,
      alpha: { from: 0, to: 1 },
      duration: 220, yoyo: true, hold: 120, ease: 'Sine.easeOut',
      onComplete: () => arrow.destroy()
    });
  }

  // Astero detruit (un seul). Animation visuelle uniquement ; le timer de respawn
  // est gere au niveau du GROUPE dans le handler asteroid:group_destroyed.
  onAsteroidDestroyed(id /*, respawnsAt */) {
    const sprite = this.elementSprites.get(id);
    const bar = this.elementHpBars.get(id);
    SharedScene.fadeAsteroidSprite(this, sprite, bar);
  }

  onAsteroidRespawned(id) {
    const sprite = this.elementSprites.get(id);
    const bar = this.elementHpBars.get(id);
    SharedScene.restoreAsteroidSprite(this, sprite, bar);
    this.applyAllElementStates();
  }

  createBaseTexture() {
    if (this.textures.exists('base')) return;
    const g = this.make.graphics({ x: 0, y: 0, add: false });
    const cx = 80, cy = 80, r = 60;
    g.fillStyle(0x152038, 1);
    g.lineStyle(3, 0x4af, 1);
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
      pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    g.beginPath();
    g.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i+1]);
    g.closePath();
    g.fillPath();
    g.strokePath();
    g.fillStyle(0x223a5e, 1);
    g.fillCircle(cx, cy, r * 0.65);
    g.lineStyle(2, 0x6cf, 0.7);
    g.strokeCircle(cx, cy, r * 0.65);
    g.lineStyle(2, 0x4af, 1);
    g.beginPath();
    g.moveTo(cx - 14, cy); g.lineTo(cx + 14, cy);
    g.moveTo(cx, cy - 14); g.lineTo(cx, cy + 14);
    g.strokePath();
    g.fillStyle(0x4af, 1);
    g.fillCircle(cx, cy, 5);
    g.generateTexture('base', 160, 160);
    g.destroy();
  }

  handleWaveIncoming(wave) {
    if (!wave) return;
    const now = Date.now();
    const warningRemaining = Math.max(0, wave.warningEndsAt - now);
    showWaveBanner(wave);
    this.showWaveWarnIcon(wave);
    for (const enemy of wave.enemies) {
      const delay = warningRemaining + (enemy.spawnOffsetMs || 0);
      this.time.delayedCall(delay, () => this.spawnEnemy(enemy));
    }
    this.time.delayedCall(warningRemaining + 600, () => this.hideWaveWarnIcon());
  }

  showWaveWarnIcon(wave) {
    this.hideWaveWarnIcon();
    const avgX = wave.enemies.reduce((s, e) => s + e.spawnX, 0) / wave.enemies.length;
    const avgY = wave.enemies.reduce((s, e) => s + e.spawnY, 0) / wave.enemies.length;
    const x = Math.max(60, Math.min(WORLD_W - 60, avgX));
    const y = Math.max(60, Math.min(WORLD_H - 60, avgY));
    // Viseur leger marquant la zone d'arrivee des ennemis (pas de cible nommee).
    this.waveWarnIcon = SharedScene.makeReticle(this, x, y);
  }

  hideWaveWarnIcon() {
    if (this.waveWarnIcon) {
      this.tweens.killTweensOf(this.waveWarnIcon);
      this.tweens.add({
        targets: this.waveWarnIcon, alpha: 0, duration: 300,
        onComplete: () => this.waveWarnIcon?.destroy()
      });
      this.waveWarnIcon = null;
    }
  }

  spawnEnemy(e) {
    const level = 1;
    const sprite = this.add.sprite(e.spawnX, e.spawnY, `enemy${level}-fr-000`)
      .setScale(ENEMY_SCALE).setOrigin(0.5, 0.36).setDepth(8);
    sprite.play(`enemy${level}-thrust`);
    sprite._level = level;
    // HP fourni par le serveur (croit avec les jours de survie de la base) ; 30 par defaut.
    sprite._hp = sprite._hpMax = (typeof e.hp === 'number' && e.hp > 0) ? e.hp : 30;
    sprite._orbitRadius = ENEMY_ORBIT_R_MIN + Math.random() * (ENEMY_ORBIT_R_MAX - ENEMY_ORBIT_R_MIN);
    sprite._orbitSpeed = (0.20 + Math.random() * 0.20) * (Math.random() < 0.5 ? 1 : -1);
    sprite._engageRef = null;
    sprite._engaging = false;
    // Oriente d'emblee vers la base (cap par defaut)
    sprite.rotation = Math.atan2(BASE_Y - e.spawnY, BASE_X - e.spawnX) + Math.PI / 2;
    sprite._hpBar = SharedScene.makeImageHpBar(this, sprite.x, sprite.y - 38, 40,
      { fillTex: 'enemy-hp-fg', frameTex: 'enemy-hp-bg', tint: false, uniform: true, fillDy: -1 });
    sprite._hpBar.setDepth(8);
    // Cliquable : verrouille / deverrouille la cible (gere au pointerup pour ne pas gener le pan).
    sprite.setInteractive({ useHandCursor: true });
    sprite.on('pointerdown', (pointer) => {
      if (pointer.button !== 0) return;
      if (this._panState) this._panState.pendingMenu = { lockEnemy: sprite, event: pointer.event };
    });
    this.enemies.add(sprite);
  }

  damageEnemy(sprite, dmg) {
    if (!sprite.active) return;
    sprite._hp = Math.max(0, sprite._hp - dmg);
    if (sprite._hpBar) {
      const ratio = sprite._hp / sprite._hpMax;
      sprite._hpBar.fill.width = sprite._hpBar.maxWidth * ratio;
      let color = 0x4fdb73;
      if (ratio < 0.3) color = 0xff4f6d;
      else if (ratio < 0.6) color = 0xffd24f;
      sprite._hpBar.fill.fillColor = color;
    }
    if (sprite._hp <= 0) this.destroyEnemy(sprite);
  }

  fireEnemyShot(sprite, tx, ty) {
    const a = Phaser.Math.Angle.Between(sprite.x, sprite.y, tx, ty);
    // hitDefenders : le tir disparait + fait un eclat blanc quand il touche un defenseur.
    this.spawnBullet(sprite.x, sprite.y, a, 'bullet-enemy', { scale: 0.7, speed: 520, hitDefenders: true });
  }

  destroyEnemy(sprite) {
    if (!sprite.active) return;
    if (sprite === this.lockedEnemy) this.clearLock();
    if (sprite._hpBar) sprite._hpBar.destroy();
    this.playEnemyExplosion(sprite.x, sprite.y, sprite._level || 1);
    this.enemies.delete(sprite);
    sprite.destroy();
  }

  playEnemyExplosion(x, y, level) {
    const lvl = 1;
    const ex = this.add.sprite(x, y, `enemy${lvl}-ex-000`).setScale(ENEMY_SCALE * 2.2).setDepth(9);
    ex.play(`enemy${lvl}-explode`);
    ex.once('animationcomplete', () => ex.destroy());
  }

  explodeAt(x, y) {
    const p = this.add.particles(x, y, 'explosion-dot', {
      speed: { min: 80, max: 220 },
      scale: { start: 1.5, end: 0 },
      alpha: { start: 1, end: 0 },
      lifespan: 700, blendMode: 'ADD',
      quantity: 18, emitting: false
    });
    p.explode(18);
    this.time.delayedCall(900, () => p.destroy());
  }

  refreshElementHighlights(activeList) {
    if (!this.elementHighlights) return;
    const activeMap = new Map();
    if (Array.isArray(activeList)) {
      for (const a of activeList) activeMap.set(a.element_id, a);
    }
    for (const [id, highlight] of this.elementHighlights.entries()) {
      const active = activeMap.get(id);
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
    for (const el of serverElements) {
      if (el.type === 'turret') this.updateTurretAppearance(el.id);
    }
  }

  update(time, delta) {
    this.updateParallaxBackground();
    this.updateTurretTargeting();
    this.updateEnemies(delta);
    this.updateBullets(delta);
    if (!this.ship) return;
    if (this.shipLabel) {
      this.shipLabel.x = this.ship.x;
      this.shipLabel.y = this.ship.y - 56;
    }
    if (this.shipHpBar) {
      this.shipHpBar.x = this.ship.x;
      this.shipHpBar.y = this.ship.y - 40;
    }
    // Sync de la flamme de reacteur : positionnee a l'arriere du vaisseau, alignee avec sa rotation
    if (this.shipFlame) {
      // Le sprite-ship pointe selon ship.rotation + SHIP_SPRITE_OFFSET (compensation texture).
      // L'arriere du vaisseau est dans la direction opposee a son "forward".
      const rearAngle = this.ship.rotation + Math.PI / 2; // direction "vers l'arriere" du sprite ship
      const offset = 18; // distance entre le centre du vaisseau et le point d'attache de la flamme
      this.shipFlame.x = this.ship.x + Math.cos(rearAngle) * offset;
      this.shipFlame.y = this.ship.y + Math.sin(rearAngle) * offset;
      this.shipFlame.rotation = rearAngle - Math.PI / 2; // la flamme natural points down (+Y)
    }

    // Déplacement vers la destination : contrôleur proportionnel.
    // Le vaisseau accélère pour rejoindre une "vitesse cible" qui décroît
    // en sqrt(2·a·d) à l'approche, ce qui le fait freiner avant d'arriver.
    // La "capacite" du vaisseau (boostee par les viewers) augmente la vitesse max.
    const shipCapacite = (elementStates.get('ship-1')?.capacite) || 0;
    const MAX_SPEED = 120 + shipCapacite * 20;  // px/s (120 de base, +20 par niveau cumule)
    const APPROACH_DECEL = 150;      // px/s² (force de freinage théorique)
    const STIFFNESS = 6;             // raideur du correcteur vitesse
    const STOP_DIST = 4;             // px : on s'arrête net si proche ET lent
    const STOP_SPEED = 20;           // px/s

    let moving = false;
    let distToDest = Infinity;
    if (this.destination) {
      const dx = this.destination.x - this.ship.x;
      const dy = this.destination.y - this.ship.y;
      const dist = Math.hypot(dx, dy);
      distToDest = dist;
      const v = this.ship.body.velocity;
      const speed = Math.hypot(v.x, v.y);

      if (dist < STOP_DIST && speed < STOP_SPEED) {
        this.destination = null;
        this.ship.setAcceleration(0, 0);
        this.ship.setVelocity(0, 0);
        this.destMarker.setFillStyle(0x4f8aff, 0);
      } else {
        const targetSpeed = Math.min(MAX_SPEED, Math.sqrt(2 * APPROACH_DECEL * dist));
        const desiredVx = (dx / dist) * targetSpeed;
        const desiredVy = (dy / dist) * targetSpeed;
        this.ship.setAcceleration((desiredVx - v.x) * STIFFNESS, (desiredVy - v.y) * STIFFNESS);
        moving = true;
      }
    } else {
      this.ship.setAcceleration(0, 0);
    }
    this.thrust.emitting = moving;

    // Cible verrouillee disparue -> on retire le verrouillage.
    if (this.lockedEnemy && !this.lockedEnemy.active) this.clearLock();
    // Orientation : vers la cible verrouillee si active, sinon vers le curseur.
    {
      let aimX, aimY;
      if (this.lockedEnemy && this.lockedEnemy.active) { aimX = this.lockedEnemy.x; aimY = this.lockedEnemy.y; }
      else { const p = this.input.activePointer; aimX = p.worldX; aimY = p.worldY; }
      const targetRot = Phaser.Math.Angle.Between(this.ship.x, this.ship.y, aimX, aimY) + SHIP_SPRITE_OFFSET;
      const maxStep = 9 * ((delta || 16) / 1000);
      this.ship.rotation = Phaser.Math.Angle.RotateTo(this.ship.rotation, targetRot, maxStep);
    }
    // Reticule de verrouillage suit la cible ; tir a Espace (maintenu = tir continu cadence).
    if (this.lockedEnemy && this.lockedEnemy.active) {
      if (this.lockReticle) { this.lockReticle.x = this.lockedEnemy.x; this.lockReticle.y = this.lockedEnemy.y; }
      if (this.keySpace && this.keySpace.isDown) this.tryFireLocked();
    }

    // Borne le vaisseau a la grille de cases (memes bornes que le serveur).
    // Max exclusif (-1) pour que la case du bord droit/bas reste dans la grille.
    {
      const minX = MAP_BOUNDS.minI * WORLD_W, maxX = (MAP_BOUNDS.maxI + 1) * WORLD_W - 1;
      const minY = MAP_BOUNDS.minJ * WORLD_H, maxY = (MAP_BOUNDS.maxJ + 1) * WORLD_H - 1;
      if (this.ship.x < minX) { this.ship.x = minX; this.ship.body.velocity.x = 0; }
      else if (this.ship.x > maxX) { this.ship.x = maxX; this.ship.body.velocity.x = 0; }
      if (this.ship.y < minY) { this.ship.y = minY; this.ship.body.velocity.y = 0; }
      else if (this.ship.y > maxY) { this.ship.y = maxY; this.ship.body.velocity.y = 0; }
    }

    // Systeme de cases : si le vaisseau a franchi une frontiere, on bascule la camera
    // sur la case voisine (transition fluide, en gardant le vaisseau visible).
    SharedScene.updateCaseCamera(this, this.ship.x, this.ship.y);
    if (this._minimap) SharedScene.drawMinimap(this._minimap, this, this.ship.x, this.ship.y);
    SharedScene.positionActionOverlay(this); // suit le vaisseau (labels + halo)
    SharedScene.updateStatsPanel(); // barre d'essence + materiaux/radius

    if (time - this.lastSend > 50) {
      this.lastSend = time;
      socket.emit('streamer:ship', {
        x: this.ship.x,
        y: this.ship.y,
        rotation: this.ship.rotation
      });
    }
  }
}

let game = null;
function startGame() {
  if (game) return;
  game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#04060a',
    physics: { default: 'arcade', arcade: { gravity: { y: 0 } } },
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: window.innerWidth,
      height: window.innerHeight
    },
    scene: MainScene
  });
}
