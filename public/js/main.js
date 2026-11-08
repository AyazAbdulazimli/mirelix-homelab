// Main Room Coordinator & UI Logic

// Toast notification helper
window.toast = function(message, params = {}) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toastEl = document.createElement('div');
  toastEl.className = 'toast';
  window.I18n.bindText(toastEl, message, params);
  container.appendChild(toastEl);

  setTimeout(() => {
    toastEl.style.opacity = '0';
    toastEl.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toastEl.remove(), 300);
  }, 3500);
};

document.addEventListener('DOMContentLoaded', async () => {
  if (!window.isSecureContext) document.getElementById('secureContextNotice').hidden = false;
  // Extract roomId from URL
  const pathParts = window.location.pathname.split('/room/');
  const roomId = (pathParts[1] || 'default').split('?')[0].split('#')[0];

  // Get or prompt username
  let myUsername = localStorage.getItem('kosmi_username');
  if (!myUsername) {
    myUsername = 'İstifadəçi-' + Math.floor(1000 + Math.random() * 9000);
    localStorage.setItem('kosmi_username', myUsername);
  }

  // Update UI headers
  const displayRoomId = document.getElementById('displayRoomId');
  if (displayRoomId) displayRoomId.textContent = roomId;

  const myUsernameDisplay = document.getElementById('myUsernameDisplay');
  if (myUsernameDisplay) window.I18n.bindText(myUsernameDisplay, '{name}', { name: myUsername });

  const localUserCardName = document.getElementById('localUserCardName');
  if (localUserCardName) window.I18n.bindText(localUserCardName, '{name} (Siz)', { name: myUsername });

  const inviteUrl = window.location.href;
  const inviteUrlField = document.getElementById('inviteUrlField');
  if (inviteUrlField) inviteUrlField.value = inviteUrl;

  // Copy invite link buttons
  const copyInvite = () => {
    if (!navigator.clipboard) { window.toast('Link: ' + inviteUrl); return; }
    navigator.clipboard.writeText(inviteUrl).then(() => {
      window.toast('📋 Otaq dəvət linki kopyalandı! Dostunuza göndərin.');
    }).catch(() => {
      window.toast('Link: ' + inviteUrl);
    });
  };

  const btnCopyInvite = document.getElementById('btnCopyInvite');
  if (btnCopyInvite) btnCopyInvite.addEventListener('click', copyInvite);

  const btnCopyInviteSidebar = document.getElementById('btnCopyInviteSidebar');
  if (btnCopyInviteSidebar) btnCopyInviteSidebar.addEventListener('click', copyInvite);
  document.getElementById('btnCopyInviteChat')?.addEventListener('click', copyInvite);

  // Load ICE settings before opening the socket so connect cannot race join-room.
  try {
    const response = await fetch('/api/ice', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('ICE configuration unavailable');
    window.mirelixIceConfig = await response.json();
  } catch (err) {
    console.warn('STUN/TURN ayarları alınmadı; standart STUN istifadə edilir.', err);
  }
  const socket = io();
  const webrtc = new WebRTCManager(socket, roomId, myUsername);
  window.mirelixCall = webrtc;
  // Browsing and chat must work while the media permission prompt is pending.
  webrtc.initLocalMedia();

  const browser = new BrowserManager(socket, roomId);
  const chat = new ChatManager(socket, roomId, myUsername);

  document.getElementById('btnBrowserShareFallback')?.addEventListener('click', () => {
    window.toast('Açdığınız film tabını seçin. Brauzer təklif edirsə, tab səsini paylaşmağı da aktiv edin.');
    if (!webrtc.isScreenSharing) webrtc.startScreenShare();
    else document.querySelector('.stage-tab[data-view="screen"]')?.click();
  });

  // Join the room on socket
  socket.on('connect', () => {
    socket.emit('join-room', { roomId, username: myUsername });
    document.querySelector('#connectionStatus .status-txt').textContent = 'Qoşuldu';
  });
  socket.on('disconnect', () => {
    document.querySelector('#connectionStatus .status-txt').textContent = 'Yenidən qoşulur…';
  });

  // Synchronized room users list from server
  socket.on('room-users', ({ users, totalUsers }) => {
    updateUsersList(users);
    updateUserCount(totalUsers);


  });

  socket.on('user-left', ({ username, totalUsers }) => {
    window.toast('🚪 {name} otaqdan ayrıldı.', { name: username });
    window.sounds.playLeave();
    updateUserCount(totalUsers);
  });

  // Synchronize active view mode between both peers (Browser, Screen, Video, Whiteboard)
  socket.on('switch-view', ({ username, viewName }) => {
    const targetTab = document.querySelector(`.stage-tab[data-view="${viewName}"]`);
    if (targetTab && !targetTab.classList.contains('active')) {
      targetTab.click();
      const viewTitles = { browser: 'Brauzer', screen: 'Ekran Paylaşımı', video: 'Video Zəng', whiteboard: 'Lövhə' };
      window.toast('📺 {name} {view} rejiminə keçdi', { name: username, view: viewTitles[viewName] || viewName });
    }
  });

  function updateUserCount(count) {
    const userCountEl = document.getElementById('userCount');
    if (userCountEl) userCountEl.textContent = count;
  }

  function updateUsersList(users) {
    const list = document.getElementById('usersList');
    if (!list) return;
    list.innerHTML = '';
    users.forEach(u => {
      const isMe = u.socketId === socket.id;
      const row = document.createElement('div');
      row.className = 'user-row';
      const avatar = document.createElement('div');
      avatar.className = 'user-avatar-small';
      avatar.textContent = isMe ? '⭐' : '👤';
      const name = document.createElement('span');
      window.I18n.bindText(name, isMe ? '{name} (Siz)' : '{name}', { name: u.username });
      row.append(avatar, name);
      list.appendChild(row);
    });
    updateUserCount(users.length);
  }

  // ---------------------------------------------------------
  // STAGE VIEW SWITCHER (Tabs: Browser, Screen, Video, Whiteboard)
  // ---------------------------------------------------------
  const stageTabs = document.querySelectorAll('.stage-tab');
  const stageViews = {
    browser: document.getElementById('viewBrowser'),
    screen: document.getElementById('viewScreen'),
    video: document.getElementById('viewVideo'),
    whiteboard: document.getElementById('viewWhiteboard')
  };

  stageTabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      const view = tab.getAttribute('data-view');
      stageTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      Object.values(stageViews).forEach(v => v.classList.remove('active'));
      if (stageViews[view]) {
        stageViews[view].classList.add('active');
      }

      // If switching to whiteboard, resize canvas
      if (view === 'whiteboard') {
        resizeCanvas();
      }

      webrtc.updatePip();

      // Synchronize tab view across both peers if clicked directly by user
      if (e.isTrusted) {
        socket.emit('switch-view', { roomId, viewName: view });
      }
    });
  });

  // Floating PIP close button
  const btnHidePip = document.getElementById('btnHidePip');
  if (btnHidePip) {
    btnHidePip.addEventListener('click', () => {
      document.getElementById('floatingCameraPip').style.display = 'none';
    });
  }

  // ---------------------------------------------------------
  // COLLABORATIVE WHITEBOARD LOGIC
  // ---------------------------------------------------------
  const canvas = document.getElementById('whiteboardCanvas');
  const ctx = canvas.getContext('2d');
  const wbColor = document.getElementById('wbColor');
  const wbSize = document.getElementById('wbSize');
  const wbClear = document.getElementById('wbClear');

  let isDrawing = false;
  let lastX = 0;
  let lastY = 0;

  function resizeCanvas() {
    if (!canvas || !canvas.parentElement) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width && rect.height) {
      canvas.width = rect.width;
      canvas.height = rect.height;
    }
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  function drawLine(x0, y0, x1, y1, color, size, emit = true) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.closePath();

    if (!emit) return;
    socket.emit('whiteboard-draw', {
      roomId,
      drawData: { x0, y0, x1, y1, color, size }
    });
  }

  canvas.addEventListener('mousedown', (e) => {
    isDrawing = true;
    lastX = e.offsetX;
    lastY = e.offsetY;
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!isDrawing) return;
    drawLine(lastX, lastY, e.offsetX, e.offsetY, wbColor.value, wbSize.value, true);
    lastX = e.offsetX;
    lastY = e.offsetY;
  });

  window.addEventListener('mouseup', () => { isDrawing = false; });

  // Touch support for mobile/tablets
  canvas.addEventListener('touchstart', (e) => {
    const rect = canvas.getBoundingClientRect();
    isDrawing = true;
    lastX = e.touches[0].clientX - rect.left;
    lastY = e.touches[0].clientY - rect.top;
  });

  canvas.addEventListener('touchmove', (e) => {
    if (!isDrawing) return;
    const rect = canvas.getBoundingClientRect();
    const curX = e.touches[0].clientX - rect.left;
    const curY = e.touches[0].clientY - rect.top;
    drawLine(lastX, lastY, curX, curY, wbColor.value, wbSize.value, true);
    lastX = curX;
    lastY = curY;
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener('touchend', () => { isDrawing = false; });

  wbClear.addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    socket.emit('whiteboard-clear', { roomId });
  });

  // Socket drawing events from remote peer
  socket.on('whiteboard-draw', (data) => {
    drawLine(data.x0, data.y0, data.x1, data.y1, data.color, data.size, false);
  });

  socket.on('whiteboard-clear', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  });

  // ---------------------------------------------------------
  // Chat shares the workspace: below the stage on phones, beside it on desktop.
  // ---------------------------------------------------------
  const sidebar = document.getElementById('roomSidebar');
  const workspace = document.querySelector('.room-workspace');
  const btnToggleSidebar = document.getElementById('btnToggleSidebar');
  const btnCloseSidebar = document.getElementById('btnCloseSidebar');
  const btnDockChat = document.getElementById('btnDockChat');
  const sidebarTabs = document.querySelectorAll('.sidebar-tab');
  const paneChat = document.getElementById('paneChat');
  const paneUsers = document.getElementById('paneUsers');

  let isSidebarOpen = true;

  function setSidebarOpen(open) {
    isSidebarOpen = open;
    sidebar.setAttribute('aria-hidden', String(!open));
    workspace.classList.toggle('chat-hidden', !open);
    btnToggleSidebar?.setAttribute('aria-expanded', String(open));
    btnDockChat?.setAttribute('aria-expanded', String(open));
    if (open) {
      sidebar.classList.remove('closed');
      if (btnToggleSidebar) btnToggleSidebar.classList.add('active');
      if (btnDockChat) btnDockChat.classList.add('active');
      chat.clearUnread();
    } else {
      sidebar.classList.add('closed');
      if (btnToggleSidebar) btnToggleSidebar.classList.remove('active');
      if (btnDockChat) btnDockChat.classList.remove('active');
    }
  }

  const mobileLayout = window.matchMedia('(max-width: 850px)');
  mobileLayout.addEventListener('change', () => setSidebarOpen(isSidebarOpen));
  // Keep the composer above the software keyboard on mobile browsers.
  const revealLatestMessage = () => requestAnimationFrame(() => {
    chat.messagesContainer.scrollTop = chat.messagesContainer.scrollHeight;
  });
  const updateViewport = () => {
    if (window.visualViewport) document.body.style.height = `${window.visualViewport.height}px`;
    if (document.activeElement === chat.chatInput) revealLatestMessage();
  };
  window.visualViewport?.addEventListener('resize', updateViewport);
  updateViewport();
  chat.chatInput.addEventListener('focus', () => {
    document.body.classList.add('chat-composing');
    revealLatestMessage();
  });
  chat.chatInput.addEventListener('blur', () => document.body.classList.remove('chat-composing'));

  // Both the film and chat are visible immediately, on every screen size.
  setSidebarOpen(isSidebarOpen);
  window.addEventListener('room-fullscreen-enter', () => setSidebarOpen(true));

  // Toggle handlers
  if (btnToggleSidebar) {
    btnToggleSidebar.addEventListener('click', () => {
      setSidebarOpen(!isSidebarOpen);
    });
  }

  if (btnCloseSidebar) {
    btnCloseSidebar.addEventListener('click', () => {
      setSidebarOpen(false);
    });
  }

  if (btnDockChat) {
    btnDockChat.addEventListener('click', () => {
      setSidebarOpen(!isSidebarOpen);
    });
  }

  sidebarTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      sidebarTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const target = tab.getAttribute('data-tab');
      if (target === 'chat') {
        paneChat.classList.add('active');
        paneUsers.classList.remove('active');
        chat.clearUnread();
      } else {
        paneChat.classList.remove('active');
        paneUsers.classList.add('active');
      }
    });
  });

  // ---------------------------------------------------------
  // BOTTOM CONTROL DOCK HANDLERS
  // ---------------------------------------------------------
  // Mic toggle
  document.getElementById('btnToggleMic').addEventListener('click', () => {
    webrtc.toggleMic();
  });

  // Camera toggle
  document.getElementById('btnToggleCam').addEventListener('click', () => {
    webrtc.toggleCamera();
  });

  // Screen share toggle
  document.getElementById('btnToggleScreen').addEventListener('click', () => {
    webrtc.toggleScreenShare();
  });

  const btnStartScreenEmpty = document.getElementById('btnStartScreenEmpty');
  if (btnStartScreenEmpty) {
    btnStartScreenEmpty.addEventListener('click', () => {
      webrtc.startScreenShare();
    });
  }

  // Quick switch to browser
  document.getElementById('btnQuickBrowser').addEventListener('click', () => {
    document.querySelector('.stage-tab[data-view="browser"]').click();
  });

  // Leave room
  document.getElementById('btnLeaveRoom').addEventListener('click', () => {
    if (confirm(window.I18n.t('Otaqdan çıxmaq istədiyinizə əminsiniz?'))) {
      window.location.href = '/';
    }
  });

  // Fullscreen dock button
  document.getElementById('btnDockFullscreen').addEventListener('click', () => {
    window.RoomFullscreen.toggle();
  });

  // Screen Picture-in-Picture button
  const btnScreenPip = document.getElementById('btnScreenPip');
  if (btnScreenPip) {
    btnScreenPip.addEventListener('click', () => {
      const vid = document.getElementById('screenShareVideo');
      if (vid && document.pictureInPictureEnabled) {
        if (document.pictureInPictureElement) {
          document.exitPictureInPicture().catch(() => {});
        } else {
          vid.requestPictureInPicture().catch(() => {
            window.toast('PiP aktiv edilə bilmədi');
          });
        }
      } else {
        window.toast('Brauzeriniz PiP rejimini dəstəkləmir');
      }
    });
  }

  // Screen viewer specific fullscreen button
  const btnFullscreenScreen = document.getElementById('btnFullscreenScreen');
  if (btnFullscreenScreen) {
    btnFullscreenScreen.addEventListener('click', () => {
      window.RoomFullscreen.toggle();
    });
  }
});
