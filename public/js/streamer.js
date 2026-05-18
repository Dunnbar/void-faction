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
        game.scene.start('main');
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
  alert('Un autre streameur s\'est connecté. Tu as perdu le contrôle.');
  location.reload();
});

const SHIP_ASSET = '/assets/2D%20Spaceships%20-%20Bundle%20-%20Free/2D%20Spaceships%20-%20Pack%201/(24).png';
const SHIP_SPRITE_OFFSET = -Math.PI / 2; // l'asset pointe vers le bas, on compense

class MainScene extends Phaser.Scene {
  constructor() { super({ key: 'main', active: false }); }

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

    this.keys = this.input.keyboard.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.Z,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.Q,
      right: Phaser.Input.Keyboard.KeyCodes.D,
      upArrow: Phaser.Input.Keyboard.KeyCodes.UP,
      downArrow: Phaser.Input.Keyboard.KeyCodes.DOWN,
      leftArrow: Phaser.Input.Keyboard.KeyCodes.LEFT,
      rightArrow: Phaser.Input.Keyboard.KeyCodes.RIGHT
    });

    this.lastSend = 0;
  }

  update(time) {
    if (!this.ship) return;

    let ax = 0, ay = 0;
    if (this.keys.up.isDown || this.keys.upArrow.isDown) ay -= 1;
    if (this.keys.down.isDown || this.keys.downArrow.isDown) ay += 1;
    if (this.keys.left.isDown || this.keys.leftArrow.isDown) ax -= 1;
    if (this.keys.right.isDown || this.keys.rightArrow.isDown) ax += 1;
    const moving = (ax !== 0 || ay !== 0);
    if (moving) {
      const len = Math.hypot(ax, ay);
      this.ship.setAcceleration((ax / len) * 450, (ay / len) * 450);
    } else {
      this.ship.setAcceleration(0, 0);
    }
    this.thrust.emitting = moving;

    const pointer = this.input.activePointer;
    this.ship.rotation = Phaser.Math.Angle.Between(this.ship.x, this.ship.y, pointer.worldX, pointer.worldY) + SHIP_SPRITE_OFFSET;

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

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: WORLD_W,
  height: WORLD_H,
  backgroundColor: '#04060a',
  physics: { default: 'arcade', arcade: { gravity: { y: 0 } } },
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: MainScene
});
