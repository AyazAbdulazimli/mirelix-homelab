const { normalizeMediaState, mediaReasons } = require('./lib/media-state');
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const config = require('./lib/runtime').runtimeConfig();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT === undefined ? 3030 : Number(process.env.PORT);
// A fixed hop count is inappropriate when the app is also reachable directly.
// Trust only local/private reverse proxies for forwarded HTTPS information.
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
app.get('/api/ice', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ iceServers: config.iceServers });
});
// Keep health checks and localhost usable; send remote page visits to HTTPS.
app.use((req, res, next) => {
  if (config.publicOrigin && !req.secure && !['localhost', '127.0.0.1', '[::1]', '::1'].includes(req.hostname) && (req.path === '/' || req.path.startsWith('/room/'))) {
    return res.redirect(307, config.publicOrigin + req.originalUrl);
  }
  next();
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/media-bridge.js', (req, res) => res.type('application/javascript').send('(' + require('./lib/media-bridge').mediaBridge.toString() + ')();'));

// Room route
app.get('/room/:roomId', (req, res) => {
  res.sendFile('room.html', { root: path.join(__dirname, 'public') });
});

// Website and media transport.
const { installProxy } = require('./lib/proxy');
installProxy(app);
// Keep third-party scripts on an origin that has no room or signaling endpoints.
// This permits normal player APIs without exposing the application's origin.
const proxyApp = express();
proxyApp.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);
proxyApp.get('/healthz', (req, res) => res.json({ status: 'ok' }));
installProxy(proxyApp, { isolatedOrigin: true });
const proxyServer = http.createServer(proxyApp);
app.get('/api/runtime', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const port = config.publicPort || proxyServer.address()?.port;
  const hostname = req.hostname.replace(/^\[|\]$/g, '');
  const proxyOrigin = config.proxyOrigin || (port ? `http://${hostname.includes(':') ? '[' + hostname + ']' : hostname}:${port}` : null);
  if (proxyOrigin === `${req.protocol}://${req.get('host')}`) return res.status(503).json({ error: 'Proksi ayrıca origin tələb edir.' });
  res.json({ version: 2, proxyOrigin, publicOrigin: config.publicOrigin || null });
});

// Socket.io Room & Realtime Signaling
const rooms = new Map(); // roomId -> Map of (socketId -> username)
const roomBrowserUrls = new Map();
let browserSequence = 0;
const roomScreens = new Map(); // roomId -> Map(socketId -> username)
const roomMedia = new Map(); // roomId -> Map(socketId -> media flags)

function broadcastRoomUsers(roomId) {
  const roomUsers = rooms.get(roomId);
  if (!roomUsers) return;
  const users = Array.from(roomUsers.entries()).map(([id, name]) => ({
    socketId: id,
    username: name,
    ...roomMedia.get(roomId)?.get(id)
  }));
  io.to(roomId).emit('room-users', {
    users,
    totalUsers: users.length
  });
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUser = null;

  socket.on('join-room', ({ roomId, username } = {}) => {
    if (currentRoom || typeof roomId !== 'string' || !roomId || roomId.length > 128) return;
    username = typeof username === 'string' ? username.slice(0, 40) : '';
    currentRoom = roomId;
    currentUser = username || 'Qonaq-' + socket.id.slice(0, 4);

    socket.join(roomId);

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
    }
    const roomUsers = rooms.get(roomId);
    roomUsers.set(socket.id, currentUser);
    if (!roomMedia.has(roomId)) roomMedia.set(roomId, new Map());
    roomMedia.get(roomId).set(socket.id, { mic: false, camera: false });

    const userList = Array.from(roomUsers.entries()).map(([id, name]) => ({
      socketId: id,
      username: name,
      ...roomMedia.get(roomId)?.get(id)
    }));

    // Notify caller with current users in room
    socket.emit('room-joined', {
      myId: socket.id,
      users: userList.filter(u => u.socketId !== socket.id)
    });

    let lastPage = roomBrowserUrls.get(roomId);
    if (!lastPage) {
      lastPage = { url: 'https://www.youtube.com/', navId: ++browserSequence, leaderId: socket.id, controls: [], playback: null };
      roomBrowserUrls.set(roomId, lastPage);
    }
    socket.emit('sync-url', { ...lastPage, serverTime: Date.now() });
    io.to(roomId).emit('browser-role', { leaderId: lastPage.leaderId });

    // Notify other peers in room for WebRTC offer initiation
    socket.to(roomId).emit('user-joined', {
      socketId: socket.id,
      username: currentUser,
      totalUsers: roomUsers.size
    });

    // Broadcast full synchronized participants list to everyone in room
    broadcastRoomUsers(roomId);

    for (const [senderId, username] of roomScreens.get(roomId) || []) {
      socket.emit('screenshare-status', { senderId, username, isSharing: true });
    }

    // Broadcast system chat message
    io.to(roomId).emit('chat-message', {
      sender: 'Sistem',
      isSystem: true,
      action: 'joined',
      username: currentUser,
      text: `${currentUser} otağa qoşuldu 👋`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });

  // Every mesh edge is scoped to two current members of the same room.
  function sameRoom(targetId) {
    return targetId !== socket.id && rooms.get(currentRoom)?.has(socket.id) && rooms.get(currentRoom)?.has(targetId);
  }
  for (const [event, field] of [['webrtc-offer', 'offer'], ['webrtc-answer', 'answer'], ['webrtc-candidate', 'candidate'], ['webrtc-restart', 'request']]) {
    socket.on(event, (packet = {}) => {
      if (!sameRoom(packet.targetId) || !packet[field]) return;
      io.to(packet.targetId).emit(event, { senderId: socket.id, [field]: packet[field] });
    });
  }

  socket.on('media-state', ({ roomId, mic, camera } = {}) => {
    if (roomId !== currentRoom || !rooms.get(currentRoom)?.has(socket.id)) return;
    const state = { mic: mic === true, camera: camera === true };
    roomMedia.get(roomId).set(socket.id, state);
    socket.to(roomId).emit('media-state', { senderId: socket.id, ...state });
  });

  socket.on('screenshare-status', ({ roomId, isSharing } = {}) => {
    if (roomId !== currentRoom || !rooms.get(currentRoom)?.has(socket.id)) return;
    if (isSharing === true) {
      if (!roomScreens.has(roomId)) roomScreens.set(roomId, new Map());
      roomScreens.get(roomId).set(socket.id, currentUser);
    } else {
      roomScreens.get(roomId)?.delete(socket.id);
      if (!roomScreens.get(roomId)?.size) roomScreens.delete(roomId);
    }
    socket.to(roomId).emit('screenshare-status', { senderId: socket.id, username: currentUser, isSharing: isSharing === true });
  });

  // Chat messaging
  socket.on('chat-message', ({ roomId, text }) => {
    if (!text || !text.trim()) return;
    io.to(roomId).emit('chat-message', {
      sender: currentUser,
      senderId: socket.id,
      isSystem: false,
      text: text.trim(),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });

  // Typing indicator
  socket.on('typing', ({ roomId, isTyping }) => {
    socket.to(roomId).emit('user-typing', {
      senderId: socket.id,
      username: currentUser,
      isTyping
    });
  });

  // Synchronized browser navigation
  socket.on('sync-url', ({ roomId, url }) => {
    if (roomId !== currentRoom || typeof url !== 'string' || url.length > 8192) return;
    try {
      const target = new URL(url);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return;
    } catch { return; }
    const previous = roomBrowserUrls.get(roomId);
    const state = previous?.url === url ? previous : { url, navId: ++browserSequence, controls: [], playback: null };
    state.username = currentUser;
    state.leaderId = socket.id;
    roomBrowserUrls.set(roomId, state);
    io.to(roomId).emit('sync-url', { ...state, senderId: socket.id, serverTime: Date.now() });
    io.to(roomId).emit('browser-role', { leaderId: socket.id });
  });

  function currentBrowser(packet) {
    const state = roomBrowserUrls.get(currentRoom);
    if (!packet || packet.roomId !== currentRoom || !rooms.get(currentRoom)?.has(socket.id) || packet.navId !== state?.navId) return null;
    return state;
  }
  function validPath(path) {
    return Array.isArray(path) && path.length <= 10 && path.every(index => Number.isInteger(index) && index >= 0 && index < 64);
  }
  socket.on('browser-clock', packet => {
    if (packet?.roomId === currentRoom && rooms.get(currentRoom)?.has(socket.id) && Number.isFinite(packet.sentAt)) socket.emit('browser-clock', {sentAt:packet.sentAt,serverTime:Date.now()});
  });
  socket.on('browser-state-request', packet => {
    const state = currentBrowser(packet);
    if (state) socket.emit('browser-state', { ...state, serverTime: Date.now() });
  });
  socket.on('media-sync', packet => {
    const browser = currentBrowser(packet);
    const state = normalizeMediaState(packet?.state);
    if (!browser || !validPath(packet.path) || !state || !mediaReasons.includes(packet.reason)) return;
    if (['tick','initial'].includes(packet.reason) && browser.leaderId !== socket.id) return;
    browser.leaderId = socket.id;
    const playback = { path: packet.path, state, reason: packet.reason, at: Date.now(), revision: ++browserSequence, navId: browser.navId, senderId: socket.id };
    browser.playback = playback;
    socket.to(currentRoom).emit('media-sync', { ...playback, serverTime: Date.now() });
    io.to(currentRoom).emit('browser-role', { leaderId: socket.id });
  });
  socket.on('browser-scroll', packet => {
    const browser = currentBrowser(packet);
    if (!browser || !validPath(packet.path) || typeof packet.selector !== 'string' || packet.selector.length > 1500 || ![packet.x, packet.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) return;
    const scroll = { path: packet.path, selector: packet.selector, x: packet.x, y: packet.y, navId: browser.navId, revision: ++browserSequence, senderId: socket.id };
    const key = JSON.stringify(packet.path) + packet.selector;
    browser.scrolls = (browser.scrolls || []).filter(item => JSON.stringify(item.path) + item.selector !== key).concat(scroll).slice(-32);
    socket.to(currentRoom).emit('browser-scroll', scroll);
  });
  socket.on('browser-ui', packet => {
    const browser = currentBrowser(packet);
    if (!browser || !validPath(packet.path) || typeof packet.selector !== 'string' || packet.selector.length > 1500 || !['server','language','episode','start','control'].includes(packet.group)) return;
    browser.leaderId = socket.id;
    browser.playback = null;
    const command = { selector: packet.selector, group: packet.group, path: packet.path, id: ++browserSequence, navId: browser.navId, senderId: socket.id };
    const key = JSON.stringify(packet.path) + packet.group;
    browser.controls = browser.controls.filter(item => JSON.stringify(item.path) + item.group !== key).concat(command).slice(-20);
    socket.to(currentRoom).emit('browser-ui', command);
    io.to(currentRoom).emit('browser-role', { leaderId: socket.id });
  });

  // Active view tab sync (e.g. switch to screenshare or browser)
  socket.on('switch-view', ({ roomId, viewName }) => {
    socket.to(roomId).emit('switch-view', {
      senderId: socket.id,
      username: currentUser,
      viewName
    });
  });

  // Collaborative whiteboard sync
  socket.on('whiteboard-draw', ({ roomId, drawData }) => {
    socket.to(roomId).emit('whiteboard-draw', drawData);
  });

  socket.on('whiteboard-clear', ({ roomId }) => {
    socket.to(roomId).emit('whiteboard-clear');
  });

  // Disconnection
  socket.on('disconnect', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const roomUsers = rooms.get(currentRoom);
      roomUsers.delete(socket.id);

      roomMedia.get(currentRoom)?.delete(socket.id);
      if (roomScreens.get(currentRoom)?.has(socket.id)) {
        roomScreens.get(currentRoom).delete(socket.id);
        if (!roomScreens.get(currentRoom).size) roomScreens.delete(currentRoom);
        socket.to(currentRoom).emit('screenshare-status', { senderId: socket.id, username: currentUser, isSharing: false });
      }

      if (roomUsers.size === 0) {
        rooms.delete(currentRoom);
        roomMedia.delete(currentRoom);
        roomBrowserUrls.delete(currentRoom);
        roomScreens.delete(currentRoom);
      } else {
        const browser = roomBrowserUrls.get(currentRoom);
        if (browser?.leaderId === socket.id) {
          browser.leaderId = roomUsers.keys().next().value;
          io.to(currentRoom).emit('browser-role', { leaderId: browser.leaderId });
        }
        // Broadcast synchronized updated participants list
        broadcastRoomUsers(currentRoom);

        socket.to(currentRoom).emit('user-left', {
          socketId: socket.id,
          username: currentUser,
          totalUsers: roomUsers.size
        });

        io.to(currentRoom).emit('chat-message', {
          sender: 'Sistem',
          isSystem: true,
          action: 'left',
          username: currentUser,
          text: `${currentUser} otaqdan ayrıldı.`,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
      }
    }
  });
});

server.once('error', (err) => {
  console.error(`Server başlaya bilmədi (${PORT}):`, err.message);
  proxyServer.close();
  process.exitCode = 1;
});
proxyServer.once('error', err => {
  console.error('Proksi başlaya bilmədi:', err.message);
  process.exitCode = 1;
});
proxyServer.listen(Number(process.env.PROXY_PORT) || 0, '0.0.0.0', () => server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mirelix: http://localhost:${server.address().port}`);
}));
server.on('close', () => proxyServer.close());
function shutdown() {
  const deadline = setTimeout(() => process.exit(1), 8000);
  deadline.unref();
  io.close();
  server.close();
  proxyServer.close();
  server.closeIdleConnections();
  proxyServer.closeAllConnections();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
