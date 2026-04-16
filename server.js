// ============================================================
//  KineCube Racing — server.js v4
//  新增：接收玩家自訂 mass + vmax，不再隨機分配質量
// ============================================================

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const QRCode  = require('qrcode');
const os      = require('os');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['websocket', 'polling'],
});
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
//  物理常數（公告供全體學生計算用）
// ============================================================
const PHYSICS = {
  THRUST:     28,    // 推力 N
  BRAKE_F:    50,    // ★ 固定煞車力 N（所有人相同）
  MAX_SPEED:  150,   // 絕對速度上限（防爆用，學生設的 vmax 才是實際上限）
  TRACK_LEN:  300,   // 賽道長度 m
  SAFE_START: 240,   // 安全停止區開始 m (80%)
  WALL_X:     285,   // 終點牆 m (95%)，安全區寬度 = 45m
  SUCCESS_V:  0.5,   // 成功判定速度 m/s
  TICK_MS:    50,    // tick 間隔 ms
  DT:         0.05,  // 時間步長 s
  // 學生計算題：v_safe = √(2 × BRAKE_F × (WALL_X - SAFE_START) / mass)
  //            = √(2 × 50 × 45 / mass) = √(4500 / mass)
};

// 顏色池
const COLOR_POOL = [
  '#00f5ff','#ff6b35','#7fff00','#ff00ff',
  '#ffd700','#00bfff','#ff4500','#39ff14',
  '#ff69b4','#00ff7f','#ff1493','#1e90ff',
  '#ff8c00','#00fa9a','#da70d6','#adff2f',
  '#f08080','#87ceeb','#dda0dd','#98fb98',
];

// 允許的質量選項
const VALID_MASSES = [1.0, 2.0, 3.0];

const rooms = {};

// ============================================================
//  工具
// ============================================================
function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}
function randColor(used) {
  const avail = COLOR_POOL.filter(c => !used.includes(c));
  const pool  = avail.length ? avail : COLOR_POOL;
  return pool[Math.floor(Math.random() * pool.length)];
}
function calcKE(m, v) { return 0.5 * m * v * v; }

// ============================================================
//  物理 Tick（每 50ms）
// ============================================================
function physicsTick() {
  const now = Date.now();

  for (const roomCode in rooms) {
    const { hostId, players } = rooms[roomCode];
    if (!Object.keys(players).length) continue;

    for (const id in players) {
      const p = players[id];
      if (p.status === 'success' || p.status === 'crashed') continue;

      const { mass: m, vmax, DT: dt = PHYSICS.DT } = p;
      // 有效速度上限：學生設定的 vmax（絕對上限 PHYSICS.MAX_SPEED）
      const effMax = Math.min(vmax || PHYSICS.MAX_SPEED, PHYSICS.MAX_SPEED);
      let netF = 0;

      if (p.isAccelerating) {
        netF = PHYSICS.THRUST;
        if (!p.startTime) p.startTime = now; // 首次加速開始計時
      } else if (p.isBraking) {
        if (p.velocity > 0) netF = -PHYSICS.BRAKE_F;
      }
      // else: 自然摩擦 = 0，等速滑行

      let v = p.velocity + (netF / m) * PHYSICS.DT;
      v = Math.max(0, Math.min(effMax, v));
      p.velocity = v;

      const newX = p.x + v * PHYSICS.DT;

      // ── 撞終點牆 ──────────────────────────────────
      if (newX >= PHYSICS.WALL_X) {
        if (hostId) io.to(hostId).emit('player:crash', {
          id: p.id, name: p.name, color: p.color, y: p.y,
        });
        io.to(id).emit('client:crash');
        p.status = 'crashed';
        p.x = 0; p.velocity = 0; p.kineticEnergy = 0;
        p.isAccelerating = false; p.isBraking = false;
        p.startTime = null;
        continue;
      }

      p.x = newX;

      // ── 安全停止區成功判定 ────────────────────────
      if (p.status === 'racing' && p.x >= PHYSICS.SAFE_START && p.velocity <= PHYSICS.SUCCESS_V) {
        p.status      = 'success';
        p.successTime = now;
        p.raceTime    = p.startTime ? now - p.startTime : 999999;
        p.velocity    = 0; p.kineticEnergy = 0;
        p.isAccelerating = false; p.isBraking = false;

        if (hostId) io.to(hostId).emit('player:success', {
          id: p.id, name: p.name, color: p.color,
          x: p.x, y: p.y, raceTime: p.raceTime,
        });
        io.to(id).emit('client:success', { raceTime: p.raceTime });
        continue;
      }

      p.kineticEnergy = calcKE(m, p.velocity);
      p.elapsed = p.startTime ? now - p.startTime : 0;
    }

    // ── 廣播 ──────────────────────────────────────
    if (hostId) io.to(hostId).emit('game:state', { players: Object.values(players) });
    for (const id in players) {
      const p = players[id];
      io.to(id).emit('player:update', {
        velocity:      p.velocity,
        kineticEnergy: p.kineticEnergy,
        x:             p.x,
        status:        p.status,
        elapsed:       p.elapsed || 0,
      });
    }
  }
}
setInterval(physicsTick, PHYSICS.TICK_MS);

// ============================================================
//  Socket.io
// ============================================================
io.on('connection', socket => {
  console.log(`[連線] ${socket.id}`);

  // ── 教師建立房間 ──────────────────────────────────────────
  socket.on('host:create', async () => {
    let code;
    do { code = genCode(); } while (rooms[code]);
    rooms[code] = { hostId: socket.id, players: {} };
    socket.join(code);
    socket.roomCode = code;
    socket.role = 'host';
    console.log(`[房間] ${code}`);

    const url  = `https://awei-lab.web.app/kinecube/client.html?room=${code}`;
    try {
      const qr = await QRCode.toDataURL(url, {
        width: 300, margin: 2,
        color: { dark: '#00f5ff', light: '#0d0d14' },
      });
      socket.emit('host:created', { roomCode: code, clientUrl: url, qrCode: qr,
        physics: PHYSICS   // 將物理常數傳給教師端顯示用
      });
    } catch {
      socket.emit('host:created', { roomCode: code, clientUrl: url, qrCode: null, physics: PHYSICS });
    }
  });

  // ── 學生加入（含 mass + vmax） ────────────────────────────
  socket.on('client:join', ({ name, roomCode, mass, vmax }) => {
    const code = roomCode.toUpperCase().trim();
    const room = rooms[code];
    if (!room) { socket.emit('client:error', { message: `找不到房間 ${code}` }); return; }

    // 驗證質量
    const m  = VALID_MASSES.includes(Number(mass)) ? Number(mass) : 1.0;
    // 驗證限速（5 ~ 150 m/s）
    const vm = Math.min(Math.max(parseFloat(vmax) || 20, 5), 150);

    const usedColors = Object.values(room.players).map(p => p.color);
    const color = randColor(usedColors);
    const y     = 0.05 + Math.random() * 0.90;

    const player = {
      id:    socket.id,
      name:  name.trim().slice(0, 12),
      mass:  m,
      vmax:  vm,
      color, y,
      x: 0, velocity: 0, kineticEnergy: 0,
      isAccelerating: false, isBraking: false,
      status: 'racing',
      startTime: null, successTime: null, raceTime: null,
      elapsed: 0,
    };

    room.players[socket.id] = player;
    socket.join(code);
    socket.roomCode = code;
    socket.role = 'player';
    console.log(`[加入] ${player.name} m=${m}kg vmax=${vm}m/s → ${code}`);

    socket.emit('client:joined', {
      name: player.name, mass: m, vmax: vm, color,
    });

    if (room.hostId) {
      io.to(room.hostId).emit('player:joined', {
        id: player.id, name: player.name,
        mass: m, vmax: vm, color, y,
      });
    }
  });

  // ── 學生重試（附帶新設定） ────────────────────────────
  socket.on('client:retry', ({ mass, vmax }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const p = room.players[socket.id];
    if (!p) return;

    p.mass = VALID_MASSES.includes(Number(mass)) ? Number(mass) : 1.0;
    p.vmax = Math.min(Math.max(parseFloat(vmax) || 20, 5), 150);
    p.x = 0; p.velocity = 0; p.kineticEnergy = 0;
    p.isAccelerating = false; p.isBraking = false;
    p.status = 'racing';
    p.startTime = null; p.successTime = null; p.raceTime = null; p.elapsed = 0;
    p.y = 0.05 + Math.random() * 0.90; // 重新分配車道位置

    console.log(`[重試] ${p.name} m=${p.mass}kg vmax=${p.vmax}m/s → ${socket.roomCode}`);

    socket.emit('client:joined', {
      name: p.name, mass: p.mass, vmax: p.vmax, color: p.color,
    });

    if (room.hostId) {
      io.to(room.hostId).emit('player:retry', {
        id: p.id, mass: p.mass, vmax: p.vmax, y: p.y,
      });
    }
  });

  // ── 操作 ─────────────────────────────────────────────────
  socket.on('client:accelerate', () => {
    const p = rooms[socket.roomCode]?.players[socket.id];
    if (!p || p.status === 'success') return;
    p.isAccelerating = true; p.isBraking = false;
  });
  socket.on('client:brake', () => {
    const p = rooms[socket.roomCode]?.players[socket.id];
    if (!p || p.status === 'success') return;
    p.isBraking = true; p.isAccelerating = false;
  });
  socket.on('client:release', () => {
    const p = rooms[socket.roomCode]?.players[socket.id];
    if (!p) return;
    p.isAccelerating = false; p.isBraking = false;
  });

  // ── 斷線 ─────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[離線] ${socket.id}`);
    if (socket.role === 'host' && rooms[socket.roomCode]) {
      io.to(socket.roomCode).emit('host:closed');
      delete rooms[socket.roomCode];
    } else if (socket.role === 'player' && rooms[socket.roomCode]) {
      const room = rooms[socket.roomCode];
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        if (room.hostId) io.to(room.hostId).emit('player:left', { id: socket.id });
      }
    }
  });
});

// ============================================================
//  啟動
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 KineCube Racing v4`);
  console.log(`   伺服器已啟動於 PORT: ${PORT}`);
  console.log(`   學生端網址: https://awei-lab.web.app/kinecube/client.html`);
  console.log(`\n   ★ 物理常數`);
  console.log(`   賽道 ${PHYSICS.TRACK_LEN}m | 安全區 ${PHYSICS.SAFE_START}~${PHYSICS.WALL_X}m (寬${PHYSICS.WALL_X-PHYSICS.SAFE_START}m)`);
  console.log(`   煞車力 F = ${PHYSICS.BRAKE_F}N | v_safe = √(4500/m)\n`);
});
