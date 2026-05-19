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
    const d = new Date(data.buildTime);
    console.log(`%c[VoidFaction Amiral] dernière MAJ : ${d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' })}`,
      'color:#ff8044; font-weight:bold');
  }
  resourceEl.textContent = data.resource;
  lastActiveElements = data.activeElements || [];
  serverElements = data.elements || [];
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
  const scene = game?.scene.getScene('main');
  if (scene && scene.scene.isActive()) scene.refreshElementHighlights(lastActiveElements);
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

const SHIP_ASSET = '/assets/2D%20Spaceships%20-%20Bundle%20-%20Free/2D%20Spaceships%20-%20Pack%201/(24).png';
const ASTEROID_ASSET = '/assets/Foozle_2DS0015_Void_EnvironmentPack/Foozle_2DS0015_Void_EnvironmentPack/Asteroids/PNGs/Asteroid%2001%20-%20Base.png';
const ENEMY_ASSET = '/assets/2D%20Spaceships%20-%20Bundle%20-%20Free/2D%20Spaceships%20-%20Pack%201/(22).png';
const SHIP_SPRITE_OFFSET = -Math.PI / 2; // l'asset pointe vers le bas, on compense

let serverElements = [];
let pendingWave = null; // wave reçue avant que la scène ne démarre

class MainScene extends Phaser.Scene {
  constructor() { super('main'); }

  preload() {
    this.load.image('ship', SHIP_ASSET);
    this.load.image('asteroid', ASTEROID_ASSET);
    this.load.image('enemy_ship', ENEMY_ASSET);
  }

  create() {
    this.cameras.main.setBackgroundColor('#04060a');

    // Starfield à la taille du monde
    const sg = this.add.graphics();
    for (let i = 0; i < 600; i++) {
      sg.fillStyle(0xffffff, Phaser.Math.FloatBetween(0.25, 1));
      sg.fillCircle(Phaser.Math.Between(0, WORLD_W), Phaser.Math.Between(0, WORLD_H), Phaser.Math.FloatBetween(0.4, 1.8));
    }

    // Setup textures
    this.textures.get('asteroid').setFilter(Phaser.Textures.FilterMode.NEAREST);
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

    this.ship = this.physics.add.image(WORLD_W / 2, WORLD_H / 2, 'ship');
    this.ship.setScale(0.16);
    this.ship.body.setCircle(160, 40, 40);
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

  setupElements(elements) {
    if (!Array.isArray(elements)) return;
    for (const s of this.elementSprites.values()) s.destroy();
    for (const h of this.elementHighlights.values()) h.destroy();
    this.elementSprites.clear();
    this.elementHighlights.clear();

    elements.forEach((el, i) => {
      if (el.type === 'asteroid') {
        const scale = el.scale || 2.0;
        const highlight = this.add.circle(el.x, el.y, 36 * scale * 0.5, 0xffd24f, 0)
          .setStrokeStyle(2, 0xffd24f, 0);
        const sprite = this.add.image(el.x, el.y, 'asteroid')
          .setScale(scale)
          .setRotation(Math.random() * Math.PI * 2);
        const dir = (i % 2 === 0) ? 1 : -1;
        this.tweens.add({
          targets: sprite,
          rotation: sprite.rotation + dir * Math.PI * 2,
          duration: 22000 + (i * 3500),
          repeat: -1
        });
        this.elementSprites.set(el.id, sprite);
        this.elementHighlights.set(el.id, highlight);
      } else if (el.type === 'turret') {
        const highlight = this.add.circle(el.x, el.y, 48, 0xff4f6d, 0)
          .setStrokeStyle(2, 0xff4f6d, 0);
        this.add.image(el.x, el.y, 'turret');
        this.add.text(el.x, el.y + 50, el.label, {
          fontFamily: 'Consolas, monospace', fontSize: '12px', color: '#ff4f6d'
        }).setOrigin(0.5);
        this.elementHighlights.set(el.id, highlight);
      }
    });
    this.refreshElementHighlights(lastActiveElements);
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
    const sprite = this.add.image(e.spawnX, e.spawnY, 'enemy_ship').setScale(0.10).setTint(0xff6677);
    const angle = Math.atan2(e.targetY - e.spawnY, e.targetX - e.spawnX);
    sprite.rotation = angle - Math.PI / 2;
    this.enemies.add(sprite);
    this.tweens.add({
      targets: sprite,
      x: e.targetX, y: e.targetY,
      duration: e.travelMs, ease: 'Linear',
      onComplete: () => {
        this.explodeAt(sprite.x, sprite.y);
        this.enemies.delete(sprite);
        sprite.destroy();
      }
    });
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
