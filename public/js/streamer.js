console.log('[streamer.js] chargé (build diagnostic)');

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
  console.log('[oeil] handler attaché', { eyeOpen: !!eyeOpen, eyeClosed: !!eyeClosed });
  pwdToggle.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const isHidden = passwordInput.type === 'password';
    console.log('[oeil] click — type avant:', passwordInput.type);
    passwordInput.type = isHidden ? 'text' : 'password';
    if (eyeOpen) eyeOpen.style.display = isHidden ? 'none' : '';
    if (eyeClosed) eyeClosed.style.display = isHidden ? '' : 'none';
    pwdToggle.setAttribute('aria-label', isHidden ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
    passwordInput.focus();
  });
} else {
  console.warn('[oeil] elements introuvables:', { pwdToggle: !!pwdToggle, pwdEye: !!pwdEye });
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

socket.on('init', (data) => {
  resourceEl.textContent = data.resource;
});
socket.on('resource', (data) => {
  resourceEl.textContent = data.resource;
});
socket.on('streamer:kicked', () => {
  alert('Un autre Amiral s\'est connecté. Tu as perdu le contrôle.');
  location.reload();
});

const SHIP_ASSET = '/assets/2D%20Spaceships%20-%20Bundle%20-%20Free/2D%20Spaceships%20-%20Pack%201/(24).png';
const SHIP_SPRITE_OFFSET = -Math.PI / 2; // l'asset pointe vers le bas, on compense

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

    // Crystal texture
    const cg = this.make.graphics({ x: 0, y: 0, add: false });
    cg.lineStyle(2, 0xffffff, 1);
    cg.fillStyle(0x4afff8, 1);
    cg.beginPath();
    cg.moveTo(50, 4); cg.lineTo(92, 50); cg.lineTo(50, 96); cg.lineTo(8, 50);
    cg.closePath();
    cg.fillPath();
    cg.strokePath();
    cg.generateTexture('crystal', 100, 100);
    cg.destroy();

    this.add.circle(WORLD_W / 2, WORLD_H / 2, 80, 0x4afff8, 0.15);
    this.add.sprite(WORLD_W / 2, WORLD_H / 2, 'crystal');
    this.add.text(WORLD_W / 2, WORLD_H / 2 + 80, 'CRISTAL DE FACTION', {
      fontFamily: 'Consolas, monospace', fontSize: '14px', color: '#4afff8'
    }).setOrigin(0.5);

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
  }

  update(time) {
    if (!this.ship) return;

    // Déplacement vers la destination (clic droit)
    let moving = false;
    if (this.destination) {
      const dx = this.destination.x - this.ship.x;
      const dy = this.destination.y - this.ship.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 10) {
        this.destination = null;
        this.ship.setAcceleration(0, 0);
        this.destMarker.setFillStyle(0x4f8aff, 0);
      } else {
        this.ship.setAcceleration((dx / dist) * 450, (dy / dist) * 450);
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
