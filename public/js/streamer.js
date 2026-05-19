const WORLD_W = 1280;
const WORLD_H = 720;

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

socket.on('init', (data) => {
  if (data.buildTime) {
    const d = new Date(data.buildTime);
    console.log(`%c[VoidFaction Amiral] dernière MAJ : ${d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' })}`,
      'color:#ff8044; font-weight:bold');
  }
  resourceEl.textContent = data.resource;
  lastActiveElements = data.activeElements || [];
  const scene = game?.scene.getScene('main');
  if (scene && scene.scene.isActive()) scene.refreshElementHighlights(lastActiveElements);
});
socket.on('resource', (data) => {
  resourceEl.textContent = data.resource;
});
socket.on('elements:update', (data) => {
  lastActiveElements = data.activeElements || [];
  const scene = game?.scene.getScene('main');
  if (scene && scene.scene.isActive()) scene.refreshElementHighlights(lastActiveElements);
});
socket.on('streamer:kicked', () => {
  alert('Un autre Amiral s\'est connecté. Tu as perdu le contrôle.');
  location.reload();
});

const SHIP_ASSET = '/assets/2D%20Spaceships%20-%20Bundle%20-%20Free/2D%20Spaceships%20-%20Pack%201/(24).png';
const ASTEROID_ASSET = '/assets/Foozle_2DS0015_Void_EnvironmentPack/Foozle_2DS0015_Void_EnvironmentPack/Asteroids/PNGs/Asteroid%2001%20-%20Base.png';
const SHIP_SPRITE_OFFSET = -Math.PI / 2; // l'asset pointe vers le bas, on compense

const ASTEROIDS = [
  { x: 180,  y: 140, scale: 2.4, rot:  0.3 },
  { x: 1090, y: 170, scale: 1.8, rot:  1.1 },
  { x: 200,  y: 580, scale: 3.0, rot: -0.4 },
  { x: 1100, y: 590, scale: 1.6, rot:  0.7 },
  { x: 420,  y: 90,  scale: 1.4, rot:  2.0 },
  { x: 860,  y: 80,  scale: 2.0, rot:  1.5 },
  { x: 340,  y: 640, scale: 1.9, rot: -1.0 },
  { x: 940,  y: 630, scale: 2.6, rot:  0.5 }
];

class MainScene extends Phaser.Scene {
  constructor() { super('main'); }

  preload() {
    this.load.image('ship', SHIP_ASSET);
    this.load.image('asteroid', ASTEROID_ASSET);
  }

  create() {
    this.cameras.main.setBackgroundColor('#04060a');

    const sg = this.add.graphics();
    for (let i = 0; i < 240; i++) {
      sg.fillStyle(0xffffff, Phaser.Math.FloatBetween(0.25, 1));
      sg.fillCircle(Phaser.Math.Between(0, WORLD_W), Phaser.Math.Between(0, WORLD_H), Phaser.Math.FloatBetween(0.4, 1.8));
    }

    // Astéroïdes (avec ID pour highlights)
    this.textures.get('asteroid').setFilter(Phaser.Textures.FilterMode.NEAREST);
    this.elementHighlights = new Map();
    ASTEROIDS.forEach((a, i) => {
      const highlight = this.add.circle(a.x, a.y, 36 * a.scale * 0.5, 0xffd24f, 0.0)
        .setStrokeStyle(2, 0xffd24f, 0.0);
      const sprite = this.add.image(a.x, a.y, 'asteroid').setScale(a.scale).setRotation(a.rot);
      const dir = (i % 2 === 0) ? 1 : -1;
      this.tweens.add({
        targets: sprite,
        rotation: a.rot + dir * Math.PI * 2,
        duration: 22000 + (i * 3500),
        repeat: -1
      });
      this.elementHighlights.set('asteroid-' + i, highlight);
    });

    // Tourelle (sprite procédural, identique au joueur)
    this.createTurretTexture();
    const turretX = WORLD_W / 2;
    const turretY = 540;
    const turretHighlight = this.add.circle(turretX, turretY, 48, 0xff4f6d, 0.0)
      .setStrokeStyle(2, 0xff4f6d, 0.0);
    this.add.image(turretX, turretY, 'turret');
    this.add.text(turretX, turretY + 50, 'TOURELLE', {
      fontFamily: 'Consolas, monospace', fontSize: '11px', color: '#ff4f6d'
    }).setOrigin(0.5);
    this.elementHighlights.set('turret-1', turretHighlight);

    // Thruster particle texture
    const tg = this.make.graphics({ x: 0, y: 0, add: false });
    tg.fillStyle(0xff8844, 1);
    tg.fillCircle(4, 4, 4);
    tg.generateTexture('thrust', 8, 8);
    tg.destroy();

    this.ship = this.physics.add.image(WORLD_W / 2, WORLD_H / 2 + 120, 'ship');
    this.ship.setScale(0.16);
    this.ship.body.setCircle(160, 40, 40);
    this.ship.setDamping(true);
    this.ship.setDrag(0.92);
    this.ship.setMaxVelocity(320);

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
    this.refreshElementHighlights(lastActiveElements);
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
    width: WORLD_W,
    height: WORLD_H,
    backgroundColor: '#04060a',
    physics: { default: 'arcade', arcade: { gravity: { y: 0 } } },
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: MainScene
  });
}
