'use strict';

const http             = require('http');
const os               = require('os');
const { WebSocketServer, WebSocket } = require('ws');

const PORT             = process.env.PORT || 3000;
const MAX_CONN_PER_IP  = 10;   // simultaneous WS connections per IP
const MSG_RATE_LIMIT   = 20;   // messages per second before disconnect
const MSG_RATE_WINDOW  = 1000; // ms window for rate limiting
const MAX_MSG_BYTES    = 262144; // 256 KB hard limit per message

// Valid message types — anything else is dropped silently
const VALID_TYPES = new Set([
  'create_room', 'join_room',
  'game_settings', 'start_game', 'turn_action', 'state_sync',
  'shop_done', 'round_start_data', 'round_begin',
  'chat', 'ping',
]);

// ── local network info ────────────────────────────────────────────────────────

function getLocalIPs() {
  const ips = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
    }
  }
  return ips;
}

// ── connection tracking ───────────────────────────────────────────────────────

// connsByIp: Map<ip, Set<ws>>  — tracks open connections per IP
const connsByIp = new Map();

function trackConn(ip, ws) {
  if (!connsByIp.has(ip)) connsByIp.set(ip, new Set());
  connsByIp.get(ip).add(ws);
}

function untrackConn(ip, ws) {
  const set = connsByIp.get(ip);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) connsByIp.delete(ip);
}

function connCountForIp(ip) {
  const set = connsByIp.get(ip);
  return set ? set.size : 0;
}

// ── rooms ─────────────────────────────────────────────────────────────────────

// rooms: Map<roomCode, Room>
// Room: { code, host: ws, players: Map<playerId, {ws,id,name,color}>, locked: bool }
const rooms = new Map();

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/info') {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ hostname: os.hostname(), localIPs: getLocalIPs() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES });
server.listen(PORT);

// ── helpers ───────────────────────────────────────────────────────────────────

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function genPlayerId() {
  return Math.random().toString(36).slice(2, 10);
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcast(room, obj, excludeWs = null) {
  for (const player of room.players.values()) {
    if (player.ws !== excludeWs) send(player.ws, obj);
  }
}

function broadcastAll(room, obj) {
  broadcast(room, obj, null);
}

function playerList(room) {
  return Array.from(room.players.values()).map(p => ({
    id:     p.id,
    name:   p.name,
    color:  p.color,
    isHost: p.ws === room.host,
  }));
}

function cleanupRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.players.size === 0) {
    rooms.delete(code);
    console.log(`[room] ${code} deleted (empty)`);
  }
}

// Reject and close a connection with a log message. Never eval incoming data.
function reject(ws, ip, reason) {
  console.log(`[reject] ${ip} — ${reason}`);
  try { ws.terminate(); } catch (_) {}
}

// ── connection handler ────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;

  // ── IP connection limit ──────────────────────────────────────────────────
  if (connCountForIp(ip) >= MAX_CONN_PER_IP) {
    console.log(`[reject] ${ip} — too many connections (${MAX_CONN_PER_IP} max)`);
    ws.terminate();
    return;
  }

  trackConn(ip, ws);
  console.log(`[connect] ${ip} (${connCountForIp(ip)} from this IP)`);

  ws._playerId = null;
  ws._roomCode = null;

  // ── per-connection rate-limit state ─────────────────────────────────────
  let msgCount    = 0;
  let windowStart = Date.now();

  ws.on('message', (data, isBinary) => {

    // ── binary frames are not used — drop silently ───────────────────────
    if (isBinary) return;

    // ── size guard (ws maxPayload already enforces this at the socket
    //    level and will emit an error, but double-check here) ─────────────
    if (data.length > MAX_MSG_BYTES) {
      reject(ws, ip, `message too large (${data.length} bytes)`);
      return;
    }

    // ── rate limiting ────────────────────────────────────────────────────
    const now = Date.now();
    if (now - windowStart >= MSG_RATE_WINDOW) {
      msgCount    = 0;
      windowStart = now;
    }
    msgCount++;
    if (msgCount > MSG_RATE_LIMIT) {
      reject(ws, ip, `rate limit exceeded (${MSG_RATE_LIMIT} msg/s)`);
      return;
    }

    // ── JSON parse ───────────────────────────────────────────────────────
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      // Invalid JSON — drop silently (don't reward probing with error info)
      return;
    }

    // ── type validation ──────────────────────────────────────────────────
    if (typeof msg !== 'object' || msg === null || !VALID_TYPES.has(msg.type)) {
      return; // unknown or missing type — drop silently
    }

    const { type } = msg;

    // ── create_room ──────────────────────────────────────────────────────
    if (type === 'create_room') {
      const name  = typeof msg.name  === 'string' ? msg.name.trim().slice(0, 16)  : '';
      const color = typeof msg.color === 'string' ? msg.color.trim().slice(0, 16) : '';
      if (!name || !color) {
        send(ws, { type: 'error', message: 'name and color required' });
        return;
      }

      const code     = genRoomCode();
      const playerId = genPlayerId();

      ws._playerId = playerId;
      ws._roomCode = code;

      const player = { ws, id: playerId, name, color };
      const room   = { code, host: ws, players: new Map([[playerId, player]]), locked: false };
      rooms.set(code, room);

      console.log(`[room] ${code} created by "${name}" (${ip})`);
      send(ws, { type: 'room_created', roomCode: code, playerId, players: playerList(room) });
      return;
    }

    // ── join_room ────────────────────────────────────────────────────────
    if (type === 'join_room') {
      const roomCode = typeof msg.roomCode === 'string' ? msg.roomCode.trim().toUpperCase().slice(0, 6) : '';
      const name     = typeof msg.name     === 'string' ? msg.name.trim().slice(0, 16)  : '';
      const color    = typeof msg.color    === 'string' ? msg.color.trim().slice(0, 16) : '';

      if (!roomCode || !name || !color) {
        send(ws, { type: 'error', message: 'roomCode, name, and color required' });
        return;
      }

      // Always return the same generic error — don't leak whether code exists
      const room = rooms.get(roomCode);
      if (!room || room.locked) {
        console.log(`[join] ${ip} — invalid/locked room code "${roomCode}"`);
        send(ws, { type: 'error', message: 'Invalid room code' });
        return;
      }

      if (room.players.size >= 5) {
        send(ws, { type: 'error', message: 'Room is full (5 players max)' });
        return;
      }

      const playerId = genPlayerId();
      ws._playerId   = playerId;
      ws._roomCode   = roomCode;

      const player = { ws, id: playerId, name, color };
      room.players.set(playerId, player);

      console.log(`[room] ${roomCode} — "${name}" joined (${ip})`);
      send(ws, { type: 'room_joined', roomCode, playerId, players: playerList(room) });
      broadcast(room, {
        type:    'player_joined',
        player:  { id: playerId, name, color, isHost: false },
        players: playerList(room),
      }, ws);
      return;
    }

    // ── all other messages require the player to be in a room ────────────
    const roomCode = ws._roomCode;
    const playerId = ws._playerId;
    if (!roomCode || !playerId) return; // not in a room — drop silently

    const room = rooms.get(roomCode);
    if (!room) return;

    const sender = room.players.get(playerId);
    if (!sender) return;

    const isHost = ws === room.host;

    switch (type) {

      case 'game_settings': {
        if (!isHost) return;
        broadcast(room, { type: 'game_settings', settings: msg.settings, from: playerId }, ws);
        break;
      }

      case 'start_game': {
        if (!isHost) return;
        // Lock the room so no new players can join once the game starts
        room.locked = true;
        console.log(`[room] ${roomCode} — game started (${room.players.size} players), room locked`);
        broadcastAll(room, {
          type:       'start_game',
          settings:   msg.settings,
          players:    msg.players || playerList(room),
          terrain:    msg.terrain,
          positions:  msg.positions,
          worldWidth: msg.worldWidth,
          wind:       msg.wind,
        });
        break;
      }

      case 'turn_action': {
        broadcast(room, {
          type:      'turn_action',
          from:      playerId,
          playerIdx: msg.playerIdx,
          weapon:    msg.weapon,
          angle:     msg.angle,
          power:     msg.power,
          wind:      msg.wind,
        }, ws);
        break;
      }

      case 'state_sync': {
        if (!isHost) return;
        broadcast(room, {
          type:          'state_sync',
          healths:       msg.healths,
          shieldHPs:     msg.shieldHPs,
          moneys:        msg.moneys,
          currentPlayer: msg.currentPlayer,
          wind:          msg.wind,
          terrainHash:   msg.terrainHash,
        }, ws);
        break;
      }

      case 'shop_done': {
        broadcast(room, { type: 'shop_done', from: playerId }, ws);
        break;
      }

      case 'round_start_data': {
        if (!isHost) return;
        broadcast(room, {
          type:      'round_start_data',
          terrain:   msg.terrain,
          positions: msg.positions,
          wind:      msg.wind,
          walls:     msg.walls,
        }, ws);
        break;
      }

      case 'round_begin': {
        if (!isHost) return;
        broadcast(room, { type: 'round_begin' }, ws);
        break;
      }

      case 'chat': {
        const text = String(msg.text || '').slice(0, 300);
        broadcast(room, {
          type:     'chat',
          from:     playerId,
          fromName: sender.name,
          color:    sender.color,
          text,
        }, ws);
        break;
      }

      case 'ping': {
        send(ws, { type: 'pong' });
        break;
      }
    }
  });

  // ── ws maxPayload exceeded — terminate the connection ────────────────────
  ws.on('error', (err) => {
    if (err.message && err.message.includes('Max payload')) {
      reject(ws, ip, `message exceeded ${MAX_MSG_BYTES} bytes`);
    } else {
      console.error(`[error] ${ip}:`, err.message);
    }
  });

  // ── disconnect ───────────────────────────────────────────────────────────
  ws.on('close', () => {
    untrackConn(ip, ws);

    const roomCode = ws._roomCode;
    const playerId = ws._playerId;

    if (!roomCode || !playerId) {
      console.log(`[disconnect] ${ip} (was not in a room)`);
      return;
    }

    const room = rooms.get(roomCode);
    if (!room) return;

    const player = room.players.get(playerId);
    const name   = player ? player.name : playerId;
    room.players.delete(playerId);

    console.log(`[disconnect] "${name}" left room ${roomCode} (${ip})`);

    if (ws === room.host) {
      console.log(`[room] ${roomCode} — host disconnected, closing room`);
      broadcast(room, { type: 'host_disconnected', message: 'Host left the game.' });
      rooms.delete(roomCode);
    } else {
      broadcast(room, { type: 'player_left', id: playerId, name, players: playerList(room) });
      cleanupRoom(roomCode);
    }
  });
});

server.on('listening', () => {
  const ips = getLocalIPs();
  console.log(`Scorched Earth multiplayer server listening on port ${PORT}`);
  console.log(`  Hostname : ${os.hostname()}`);
  ips.forEach(ip => console.log(`  Local IP : ${ip}`));
});
