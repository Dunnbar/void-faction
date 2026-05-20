const CANVAS_W = 1280;
const CANVAS_H = 720;
let WORLD_W = 2400;
let WORLD_H = 1350;
let TURRET_X = 1200;
let TURRET_Y = 1000;
const MIN_ZOOM = 0.45;
const MAX_ZOOM = 1.4;
const DEFAULT_ZOOM = 0.75;

const socket = io({ autoConnect: false });
const loginEl = document.getElementById('login');
const loginForm = document.getElementById('loginForm');
const loginError = document.getElementById('loginError');
const passwordInput = document.getElementById('password');
const hudEl = document.getElementById('hud');
const resourceEl = document.getElementById('resource');

let authenticated = false;

const pwdToggle = document.getElementById('pwdToggle');
const pwdEye = document.getElementById('pwdEye');
if (pwdToggle && pwdEye) {
  const eyeOpen = pwdEye.querySelector('.eye-open');
  const eyeClosed = pwdEye.querySelector('.eye-closed');
  pwdToggle.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const isHidden = passwordInput.type === 'password';
    passwordInput.type = isHidden ? 'text' : 'password';
    if (eyeOpen) eyeOpen.style.display = isHidden ? 'none' : '';
    if (eyeClosed) eyeClosed.style.display = isHidden ? '' : 'none';
    pwdToggle.setAttribute('aria-label', isHidden ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
    passwordInput.focus();
  });
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const password = passwordInput.value;
  if (!socket.connected) socket.connect();
  const tryAuth = () => {
    socket.emit('streamer:auth', { password }, (resp) => {
      if (resp?.ok) {
        authenticated = true;
        loginEl.classList.add('hidden');
        hudEl.classList.remove('hidden');
        startGame();
      } else {
        loginError.textContent = 'Mot de passe incorrect';
        socket.disconnect();
      }
    });
  };
  if (socket.connected) tryAuth();
  else socket.once('connect', tryAuth);
});

let lastActiveElements = [];
let elementStates = new Map();
let factionResources = { materiaux: 0, radius: 0 };
let knownBuildTime = null;

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
      cdEl.textContent = `${Math.ceil((wave.warningEndsAt - now) / 1000)}s`;
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
  waveBannerInterval = setInterval(update, 250);
}

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
  resourceEl.textContent = data.resource;
  lastActiveElements = data.activeElements || [];
  serverElements = data.elements || [];
  elementStates = new Map((data.elementStates || []).map(s => [s.id, s]));
  factionResources = data.factionResources || factionResources;
  if (data.world) {
    WORLD_W = data.world.width;
    WORLD_H = data.world.height;
    TURRET_X = data.world.turretX;
    TURRET_Y = data.world.turretY;
  }
  pendingWave = data.currentWave && data.currentWave.endsAt > Date.now() ? data.currentWave : null;
  const scene = game?.scene.getScene('main');
  if (scene && scene.scene.isActive()) {
    scene.setupElements(serverElements);
    scene.applyAllElementStates();
    scene.refreshElementHighlights(lastActiveElements);
    if (pendingWave) {
      scene.handleWaveIncoming(pendingWave);
      pendingWave = null;
    }
  }
});
socket.on('resource', (data) => {
  resourceEl.textContent = data.resource;
});
socket.on('elements:update', (data) => {
  lastActiveElements = data.activeElements || [];
  if (Array.isArray(data.states)) {
    elementStates = new Map(data.states.map(s => [s.id, s]));
  }
  if (data.faction) factionResources = data.faction;
  const scene = game?.scene.getScene('main');
  if (scene && scene.scene.isActive()) {
    scene.refreshElementHighlights(lastActiveElements);
    scene.applyAllElementStates();
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
socket.on('wave:incoming', (wave) => {
  const scene = game?.scene.getScene('main');
  if (scene && scene.scene.isActive()) scene.handleWaveIncoming(wave);
  else pendingWave = wave;
});
socket.on('streamer:kicked', () => {
  alert('Un autre Amiral s\'est connecté. Tu as perdu le contrôle.');
  location.reload();
});

const SHIP_ASSET = '/assets/PNG/Ship_01/Ship_LVL_1.png';
const SHIP_SCALE = 0.085;
const ENEMY_LEVELS = [1, 2];
const ENEMY_ASSETS = {
  1: '/assets/PNG/Ship_02/Ship_LVL_1.png',
  2: '/assets/PNG/Ship_02/Ship_LVL_2.png'
};
const ENEMY_SCALE = 0.07;
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
const ASTEROID_TARGET_SIZE = 130;
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
    this.load.image('bg-01', '/assets/Backgrounds/PNG_and_JPG/background_02_parallax_01.png');
    this.load.image('bg-02', '/assets/Backgrounds/PNG_and_JPG/background_02_parallax_02.png');
    this.load.image('bg-03', '/assets/Backgrounds/PNG_and_JPG/background_02_parallax_03.png');
    this.load.image('bg-04', '/assets/Backgrounds/PNG_and_JPG/background_02_parallax_04.png');
    for (const [v, meta] of Object.entries(ASTEROID_VARIANTS)) {
      this.load.spritesheet(`a-${v}`,
        `/assets/Asteroids/PNG/asteroid_${v}_with_cracks.png`,
        { frameWidth: meta.w, frameHeight: meta.h });
    }
  }

  create() {
    this.cameras.main.setBackgroundColor('#04060a');

    // Background parallax (background_02)
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
    this.waveWarnIcon = null;

    // Thruster particle texture
    const tg = this.make.graphics({ x: 0, y: 0, add: false });
    tg.fillStyle(0xff8844, 1);
    tg.fillCircle(4, 4, 4);
    tg.generateTexture('thrust', 8, 8);
    tg.destroy();

    this.ship = this.physics.add.sprite(WORLD_W / 2, WORLD_H / 2, 'ship-fr-000');
    this.ship.setScale(SHIP_SCALE).setOrigin(0.5, 0.36).setDepth(10);
    this.ship.play('ship-thrust');
    this.ship.setDamping(true);
    this.ship.setDrag(0.92);
    this.ship.setMaxVelocity(320);

    // Caméra : bornes du monde + follow ship + zoom par molette
    this.cameras.main.setBounds(0, 0, WORLD_W, WORLD_H);
    this.cameras.main.startFollow(this.ship, true, 0.08, 0.08);
    this.cameras.main.setZoom(DEFAULT_ZOOM);
    this.input.on('wheel', (_p, _g, _dx, deltaY) => {
      const cam = this.cameras.main;
      cam.setZoom(Phaser.Math.Clamp(cam.zoom - deltaY * 0.0008, MIN_ZOOM, MAX_ZOOM));
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

    // Clic droit = définir la destination
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
    const mkFrames = (prefix, count) =>
      Array.from({ length: count }, (_, i) => ({ key: `${prefix}${String(i).padStart(3, '0')}` }));
    if (!this.anims.exists('ship-thrust')) {
      this.anims.create({ key: 'ship-thrust', frames: mkFrames('ship-fr-', 10), frameRate: 24, repeat: -1 });
    }
    for (const lvl of ENEMY_LEVELS) {
      const thr = `enemy${lvl}-thrust`;
      if (!this.anims.exists(thr)) {
        this.anims.create({ key: thr, frames: mkFrames(`enemy${lvl}-fr-`, 10), frameRate: 24, repeat: -1 });
      }
      const ex = `enemy${lvl}-explode`;
      if (!this.anims.exists(ex)) {
        this.anims.create({ key: ex, frames: mkFrames(`enemy${lvl}-ex-`, 9), frameRate: 22, repeat: 0 });
      }
    }
  }

  setupParallaxBackground() {
    const bg01 = this.add.image(CANVAS_W / 2, CANVAS_H / 2, 'bg-01')
      .setOrigin(0.5).setScrollFactor(0).setDepth(-100);
    const src01 = this.textures.get('bg-01').getSourceImage();
    this._bg01CoverScale = Math.max(CANVAS_W / src01.width, CANVAS_H / src01.height) * 1.05;
    bg01.setScale(this._bg01CoverScale);
    this.bgLayer01 = bg01;

    const bg02 = this.add.image(CANVAS_W / 2, CANVAS_H / 2, 'bg-02')
      .setOrigin(0.5).setScrollFactor(0.05).setDepth(-90).setAlpha(0.6);
    const src02 = this.textures.get('bg-02').getSourceImage();
    this._bg02CoverScale = Math.max(CANVAS_W / src02.width, CANVAS_H / src02.height);
    bg02.setScale(this._bg02CoverScale);
    this.bgLayer02 = bg02;

    const bg03 = this.add.image(360, 240, 'bg-03')
      .setOrigin(0.5).setScrollFactor(0.35).setDepth(-80).setScale(0.55);
    this.bgLayer03 = bg03;

    const bg04 = this.add.image(2100, 1180, 'bg-04')
      .setOrigin(0.5).setScrollFactor(0.65).setDepth(-70).setScale(0.7);
    this.bgLayer04 = bg04;
  }

  updateParallaxBackground() {
    if (!this.bgLayer01) return;
    const z = this.cameras.main.zoom;
    if (this._bg01CoverScale) this.bgLayer01.setScale(this._bg01CoverScale / z);
    if (this._bg02CoverScale) this.bgLayer02.setScale(this._bg02CoverScale / z);
  }

  setupElements(elements) {
    if (!Array.isArray(elements)) return;
    for (const s of this.elementSprites.values()) s.destroy();
    for (const h of this.elementHighlights.values()) h.destroy();
    if (this.elementHpBars) for (const b of this.elementHpBars.values()) b.destroy();
    if (this.elementRespawnTimers) for (const t of this.elementRespawnTimers.values()) t.destroy();
    this.elementSprites.clear();
    this.elementHighlights.clear();
    this.elementHpBars = new Map();
    this.elementRespawnTimers = new Map();

    this.createBaseTexture();

    elements.forEach((el, i) => {
      if (el.type === 'asteroid') {
        const variant = el.variant || '01';
        const meta = ASTEROID_VARIANTS[variant] || ASTEROID_VARIANTS['01'];
        const phaserScale = asteroidScaleFor(variant, el.scale);
        const tint = el.subtype === 'radius' ? 0x88e0c8 : 0xffffff;
        const visibleSize = Math.max(meta.w, meta.h) * phaserScale;
        const highlight = this.add.circle(el.x, el.y, visibleSize * 0.6, 0xffd24f, 0)
          .setStrokeStyle(3, 0xffd24f, 0);
        const sprite = this.add.sprite(el.x, el.y, `a-${variant}`, 0)
          .setScale(phaserScale)
          .setRotation(Math.random() * Math.PI * 2)
          .setTint(tint);
        const dir = (i % 2 === 0) ? 1 : -1;
        this.tweens.add({
          targets: sprite,
          rotation: sprite.rotation + dir * Math.PI * 2,
          duration: 28000 + (i * 4000),
          repeat: -1
        });
        sprite._asteroidVariant = variant;
        this.elementSprites.set(el.id, sprite);
        this.elementHighlights.set(el.id, highlight);
        const barW = Math.max(60, Math.min(140, visibleSize * 0.9));
        this.elementHpBars.set(el.id, this.makeHpBar(el.x, el.y - visibleSize * 0.5 - 14, barW));
      } else if (el.type === 'turret') {
        const highlight = this.add.circle(el.x, el.y, 50, 0xff4f6d, 0)
          .setStrokeStyle(2, 0xff4f6d, 0);
        const sprite = this.add.image(el.x, el.y, 'turret');
        this.add.text(el.x, el.y + 58, el.label, {
          fontFamily: 'Consolas, monospace', fontSize: '11px', color: '#ff4f6d'
        }).setOrigin(0.5);
        this.elementSprites.set(el.id, sprite);
        this.elementHighlights.set(el.id, highlight);
        this.elementHpBars.set(el.id, this.makeHpBar(el.x, el.y - 50, 80));
      } else if (el.type === 'base') {
        const highlight = this.add.circle(el.x, el.y, 90, 0x4af, 0)
          .setStrokeStyle(2, 0x4af, 0);
        const sprite = this.add.image(el.x, el.y, 'base');
        this.add.text(el.x, el.y + 90, el.label, {
          fontFamily: 'Consolas, monospace', fontSize: '13px', color: '#4af'
        }).setOrigin(0.5);
        this.elementSprites.set(el.id, sprite);
        this.elementHighlights.set(el.id, highlight);
        this.elementHpBars.set(el.id, this.makeHpBar(el.x, el.y - 88, 120));
      }
    });
    this.refreshElementHighlights(lastActiveElements);
    this.applyAllElementStates();
  }

  makeHpBar(x, y, width) {
    const c = this.add.container(x, y);
    const bg = this.add.rectangle(0, 0, width, 6, 0x000000, 0.6).setStrokeStyle(1, 0xffffff, 0.4);
    const fill = this.add.rectangle(-width / 2, 0, width, 4, 0x4fdb73).setOrigin(0, 0.5);
    c.add([bg, fill]);
    c.fill = fill; c.bg = bg; c.maxWidth = width;
    return c;
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
  }

  onAsteroidDestroyed(id, respawnsAt) {
    const sprite = this.elementSprites.get(id);
    const bar = this.elementHpBars.get(id);
    if (sprite) {
      this.explodeAt(sprite.x, sprite.y);
      this.tweens.killTweensOf(sprite);
      this.tweens.add({ targets: sprite, alpha: 0, scale: sprite.scale * 1.4, duration: 600, ease: 'Cubic.easeOut' });
    }
    if (bar) bar.setVisible(false);
    if (sprite) {
      const timer = this.add.text(sprite.x, sprite.y, '', {
        fontFamily: 'Consolas, monospace', fontSize: '14px', color: '#88e0c8',
        stroke: '#000', strokeThickness: 3, align: 'center'
      }).setOrigin(0.5);
      const update = () => {
        const remaining = respawnsAt - Date.now();
        if (remaining <= 0) { timer.destroy(); return; }
        const m = Math.floor(remaining / 60000);
        const s = Math.floor((remaining % 60000) / 1000);
        timer.setText(`RESPAWN\n${m}m ${String(s).padStart(2,'0')}s`);
      };
      update();
      const interval = setInterval(update, 1000);
      timer.once('destroy', () => clearInterval(interval));
      this.elementRespawnTimers.set(id, timer);
    }
  }

  onAsteroidRespawned(id) {
    const sprite = this.elementSprites.get(id);
    const bar = this.elementHpBars.get(id);
    const timer = this.elementRespawnTimers.get(id);
    if (timer) { timer.destroy(); this.elementRespawnTimers.delete(id); }
    if (sprite) {
      this.tweens.killTweensOf(sprite);
      sprite.setAlpha(0);
      if (sprite._asteroidVariant) sprite.setFrame(0);
      const scaleTarget = sprite.scale;
      this.tweens.add({ targets: sprite, alpha: 1, scale: { from: scaleTarget * 0.5, to: scaleTarget }, duration: 500 });
    }
    if (bar) bar.setVisible(true);
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
    const x = Math.max(40, Math.min(WORLD_W - 40, avgX));
    const y = Math.max(40, Math.min(WORLD_H - 40, avgY));
    const icon = this.add.text(x, y, '⚠', {
      fontFamily: 'Consolas, monospace', fontSize: '64px', color: '#ff4444',
      stroke: '#000000', strokeThickness: 4
    }).setOrigin(0.5).setAlpha(0);
    this.tweens.add({ targets: icon, alpha: { from: 0, to: 1 }, scale: { from: 0.5, to: 1.2 }, duration: 400, ease: 'Back.easeOut' });
    this.tweens.add({ targets: icon, scale: { from: 1.0, to: 1.3 }, yoyo: true, repeat: -1, duration: 600, ease: 'Sine.easeInOut' });
    this.waveWarnIcon = icon;
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
    const level = ENEMY_LEVELS.includes(e.level) ? e.level : 1;
    const sprite = this.add.sprite(e.spawnX, e.spawnY, `enemy${level}-fr-000`)
      .setScale(ENEMY_SCALE).setOrigin(0.5, 0.36).setDepth(8);
    sprite.play(`enemy${level}-thrust`);
    const angle = Math.atan2(e.targetY - e.spawnY, e.targetX - e.spawnX);
    sprite.rotation = angle + Math.PI / 2;
    this.enemies.add(sprite);
    this.tweens.add({
      targets: sprite,
      x: e.targetX, y: e.targetY,
      duration: e.travelMs, ease: 'Linear',
      onComplete: () => {
        this.playEnemyExplosion(sprite.x, sprite.y, level);
        this.enemies.delete(sprite);
        sprite.destroy();
      }
    });
  }

  playEnemyExplosion(x, y, level) {
    const lvl = ENEMY_LEVELS.includes(level) ? level : 1;
    const ex = this.add.sprite(x, y, `enemy${lvl}-ex-000`).setScale(ENEMY_SCALE * 1.8);
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
  }

  update(time) {
    this.updateParallaxBackground();
    if (!this.ship) return;

    // Déplacement vers la destination : contrôleur proportionnel.
    // Le vaisseau accélère pour rejoindre une "vitesse cible" qui décroît
    // en sqrt(2·a·d) à l'approche, ce qui le fait freiner avant d'arriver.
    const MAX_SPEED = 280;           // px/s
    const APPROACH_DECEL = 300;      // px/s² (force de freinage théorique)
    const STIFFNESS = 6;             // raideur du correcteur vitesse
    const STOP_DIST = 4;             // px : on s'arrête net si proche ET lent
    const STOP_SPEED = 20;           // px/s

    let moving = false;
    if (this.destination) {
      const dx = this.destination.x - this.ship.x;
      const dy = this.destination.y - this.ship.y;
      const dist = Math.hypot(dx, dy);
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

    // Orientation : on s'oriente vers la destination quand on se déplace,
    // sinon on garde la rotation actuelle
    if (this.destination) {
      this.ship.rotation = Phaser.Math.Angle.Between(this.ship.x, this.ship.y, this.destination.x, this.destination.y) + SHIP_SPRITE_OFFSET;
    }

    if (this.ship.x < 0) this.ship.x = WORLD_W;
    else if (this.ship.x > WORLD_W) this.ship.x = 0;
    if (this.ship.y < 0) this.ship.y = WORLD_H;
    else if (this.ship.y > WORLD_H) this.ship.y = 0;

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
    width: CANVAS_W,
    height: CANVAS_H,
    backgroundColor: '#04060a',
    physics: { default: 'arcade', arcade: { gravity: { y: 0 } } },
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: MainScene
  });
}
