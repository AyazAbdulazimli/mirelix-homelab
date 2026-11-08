// Browser navigation is owned by the room, including cross-origin frames.
class BrowserManager {
  constructor(socket, roomId) {
    this.socket = socket;
    this.roomId = roomId;
    this.iframe = document.getElementById('browserIframe');
    this.frameContainer = document.getElementById('browserFrameContainer');
    this.urlInput = document.getElementById('browserUrlInput');
    this.navId = null;
    this.isLeader = false;
    this.lastPlayback = null;
    this.clockOffset = 0;
    this.clockReady = false;
    this.clockSamples = [];
    this.seenControls = new Set();
    this.loader = document.getElementById('browserLoader');
    this.status = document.getElementById('browserStatus');
    this.hubModal = document.getElementById('browserHubModal');
    this.history = ['https://www.youtube.com/'];
    this.historyIndex = 0;
    this.currentUrl = this.history[0];
    this.pending = false;
    this.proxyOrigin = '';
    this.runtimeReady = this.configureRuntime();
    this.init();
  }
  async configureRuntime() {
    this.runtimeError = false;
    try {
      const response = await fetch('/api/runtime', { cache: 'no-store' });
      if (!response.ok) throw new Error('old-backend');
      const config = await response.json();
      if (config.proxyOrigin && new URL(config.proxyOrigin).origin !== location.origin) this.proxyOrigin = new URL(config.proxyOrigin).origin;
    } catch {
      this.runtimeError = true;
      const local = ['localhost','127.0.0.1','[::1]'].includes(location.hostname);
      this.status.textContent = local ? 'Lokal serverə qoşulmaq mümkün olmadı. Yenilənmiş serveri işə salın.' : 'Serverə qoşulmaq mümkün olmadı. Səhifəni yeniləyin və yenidən sınayın.';
      const notice = document.getElementById('runtimeNotice');
      if (notice && local) {
        notice.hidden = false;
        const link = notice.querySelector('a');
        link.href = 'http://localhost:3040' + location.pathname;
      }
      window.toast(this.status.textContent);
    }
  }
  init() {
    this.urlInput.value = this.currentUrl;
    document.getElementById('browserAddressForm').addEventListener('submit', event => {
      event.preventDefault();
      if (this.urlInput.value.trim()) this.navigateTo(this.urlInput.value);
      this.urlInput.blur();
    });
    document.getElementById('btnBrowserBack').addEventListener('click', () => this.moveHistory(-1));
    document.getElementById('btnBrowserForward').addEventListener('click', () => this.moveHistory(1));
    document.getElementById('btnBrowserReload').addEventListener('click', () => this.navigateTo(this.currentUrl, false, false));
    document.getElementById('btnBrowserExternalFallback')?.addEventListener('click', () => window.open(this.currentUrl, '_blank', 'noopener,noreferrer'));
    document.getElementById('btnBrowserRetry')?.addEventListener('click', () => this.navigateTo(this.currentUrl, false, false));
    document.getElementById('btnOpenExternal').addEventListener('click', () => window.open(this.currentUrl, '_blank', 'noopener,noreferrer'));
    document.getElementById('btnExpandBrowser').addEventListener('click', () => window.RoomFullscreen.toggle());
    document.getElementById('btnBrowserHelp').addEventListener('click', () => {
      const help = document.getElementById('browserHelp');
      help.hidden = !help.hidden;
      document.getElementById('btnBrowserHelp').setAttribute('aria-expanded', String(!help.hidden));
    });
    document.querySelectorAll('.browser-quick-links .chip, .hub-tile').forEach(tile => {
      tile.addEventListener('click', () => {
        this.navigateTo(tile.dataset.url, true, true, tile.dataset.fallback);
        this.hubModal.style.display = 'none';
      });
    });
    document.getElementById('btnOpenBrowserHub').addEventListener('click', () => { this.hubModal.style.display = 'flex'; });
    document.getElementById('btnCloseBrowserHub').addEventListener('click', () => { this.hubModal.style.display = 'none'; });
    this.hubModal.addEventListener('click', event => { if (event.target === this.hubModal) this.hubModal.style.display = 'none'; });
    this.iframe.addEventListener('load', () => {
      if (!this.pending) return;
      this.hideLoader();
      this.sendMediaContext();
      // A frame load does not prove a cross-origin player successfully loaded.
      if (!this.frameError) this.status.textContent = this.bridgeConnected ? 'Sürüşdürmə və media idarəsi avtomatik sinxronlaşır.' : 'Səhifə açıldı. Sinxron bağlantı gözlənilir…';
    });
    window.addEventListener('message', event => {
      if (event.source !== this.iframe.contentWindow || !event.data || typeof event.data !== 'object') return;
      if (event.data.channel === 'kosmi-sync') { this.handleMediaMessage(event.data); return; }
      const { type, url } = event.data;
      if (type === 'KOSMI_FRAME_MEDIA') { this.openDetectedMedia(event.data); return; }
      if (type === 'KOSMI_FRAME_NAVIGATE' && typeof url === 'string') this.navigateTo(url);
      if (type === 'KOSMI_FRAME_LOADED' && typeof url === 'string') {
        try {
          const finalUrl = this.formatUrl(url);
          if (finalUrl !== this.currentUrl && !this.pending) {
            this.history = this.history.slice(0, this.historyIndex + 1);
            this.history.push(finalUrl);
            this.historyIndex++;
            this.currentUrl = finalUrl;
            this.broadcast();
          } else {
            this.history[this.historyIndex] = finalUrl;
            this.currentUrl = finalUrl;
          }
          this.urlInput.value = finalUrl;
          this.updateHistoryButtons();
        } catch { /* Ignore malformed messages. */ }
      }
      if (type === 'KOSMI_FRAME_ERROR') this.showFrameError(event.data);
      if (type === 'KOSMI_SWITCH_SCREEN') document.querySelector('[data-view="screen"]').click();
    });
    this.socket.on('browser-clock', packet => this.updateClock(packet));
    this.socket.on('disconnect', () => { this.clockReady = false; this.clockSamples = []; this.lastClockPing = 0; });
    const clockTimer = setInterval(() => this.pingClock(), 30000);
    window.addEventListener('pagehide', () => clearInterval(clockTimer), {once:true});
    this.socket.on('sync-url', async packet => {
      this.pingClock();
      if (!packet.senderId && this.localNavigation) {
        this.socket.emit('sync-url', {roomId:this.roomId,url:this.localNavigation});
        return;
      }
      if (packet.senderId === this.socket.id) this.localNavigation = null;
      const previousNav = this.navId;
      this.navId = packet.navId;
      this.isLeader = packet.leaderId === this.socket.id;
      if (packet.senderId !== this.socket.id && (packet.url !== this.currentUrl || (previousNav !== null && previousNav !== packet.navId))) {
        document.querySelector('.stage-tab[data-view="browser"]')?.click();
        await this.navigateTo(packet.url, false);
      }
      if (packet.navId !== this.navId) return;
      this.restoreBrowserState(packet);
      this.sendMediaContext();
    });
    this.socket.on('browser-role', ({ leaderId }) => {
      this.isLeader = leaderId === this.socket.id;
      this.sendMediaContext();
    });
    this.socket.on('browser-scroll', packet => this.applyScroll(packet));
    this.socket.on('media-sync', packet => this.applyPlayback(packet));
    this.socket.on('browser-ui', command => this.applyUi(command));
    this.socket.on('browser-state', packet => {
      if (packet.navId === this.navId) this.restoreBrowserState(packet);
    });
    document.getElementById('btnResumeSyncedMedia')?.addEventListener('click', () => {
      document.getElementById('btnResumeSyncedMedia').hidden = true;
      if (this.lastPlayback) this.applyPlayback(this.lastPlayback);
      this.postMedia({ type: 'unlock' });
    });
    this.updateHistoryButtons();
  }
  formatUrl(input) {
    const clean = String(input).trim();
    if (!clean) throw new Error('Domen və ya video linki daxil edin.');
    if (/^[a-z][a-z\d+.-]*:/i.test(clean) && !/^https?:\/\//i.test(clean)) throw new Error('Yalnız http:// və https:// linkləri dəstəklənir.');
    const looksLikeUrl = /^https?:\/\//i.test(clean) || (!/\s/.test(clean) && (clean.includes('.') || clean.startsWith('//')));
    const url = new URL(looksLikeUrl ? (/^https?:\/\//i.test(clean) ? clean : 'https://' + clean.replace(/^\/\//, '')) : `https://duckduckgo.com/?q=${encodeURIComponent(clean)}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Sayt ünvanı düzgün deyil.');
    return url.href;
  }
  getYouTubeEmbed(value) {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, '');
    if (!['youtube.com', 'm.youtube.com', 'youtu.be', 'youtube-nocookie.com'].includes(host)) return null;
    const id = host === 'youtu.be' ? url.pathname.split('/')[1] : url.searchParams.get('v') || url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1];
    if (!id || !/^[\w-]{11}$/.test(id)) return '/youtube.html';
    const embed = new URL(`https://www.youtube-nocookie.com/embed/${id}`);
    embed.searchParams.set('playsinline', '1');
    embed.searchParams.set('autoplay', '1');
    const start = url.searchParams.get('start') || url.searchParams.get('t');
    if (start) {
      const match = start.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
      if (match) embed.searchParams.set('start', Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0));
    }
    return embed.href;
  }
  getMediaEmbed(value) {
    const url = new URL(value);
    if (!/\.(mp4|m4v|webm|ogv|ogg|mp3|m4a|aac|wav|flac|m3u8)$/i.test(url.pathname)) return null;
    return '/media.html?url=' + encodeURIComponent(url.href);
  }
  openDetectedMedia(message) {
    if (message.requestedUrl !== this.currentUrl || !['hls', 'native'].includes(message.format)) return;
    let url;
    try { url = new URL(message.url); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    this.bridgeConnected = false;
    this.iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-presentation allow-pointer-lock allow-same-origin');
    this.iframe.src = '/media.html?url=' + encodeURIComponent(url.href) + '&format=' + message.format;
  }
  pingClock() {
    const now = Date.now();
    if (this.socket.connected === false || (this.lastClockPing && now - this.lastClockPing < 15000)) return;
    this.lastClockPing = now;
    this.socket.emit('browser-clock', {roomId:this.roomId,sentAt:now});
  }
  updateClock(packet) {
    const now = Date.now(), rtt = now - packet.sentAt;
    if (!Number.isFinite(packet.sentAt) || !Number.isFinite(packet.serverTime) || rtt < 0 || rtt > 10000) return;
    this.clockSamples = (this.clockSamples || []).filter(sample => now - sample.at < 300000);
    this.clockSamples.push({at:now,rtt,offset:packet.serverTime - (packet.sentAt + now) / 2});
    this.clockSamples = this.clockSamples.slice(-10);
    this.clockOffset = this.clockSamples.reduce((best, sample) => sample.rtt < best.rtt ? sample : best).offset;
    this.clockReady = true;
  }
  async navigateTo(value, shouldBroadcast = true, addHistory = true, fallbackValue = '') {
    const navigation = (this.navigationRequest || 0) + 1;
    this.navigationRequest = navigation;
    let url;
    try { url = this.formatUrl(value); }
    catch (error) { window.toast(error.message); return; }
    if (shouldBroadcast) this.localNavigation = url;
    if (this.runtimeError) this.runtimeReady = this.configureRuntime();
    await this.runtimeReady;
    if (this.runtimeError) {
      this.currentUrl = url; this.urlInput.value = url;
      this.showFrameError({detail: this.status.textContent});
      return;
    }
    if (navigation !== this.navigationRequest) return;
    this.pendingFallback = null;
    if (shouldBroadcast && fallbackValue) {
      try {
        const alternative = this.formatUrl(fallbackValue);
        if (alternative !== url) this.pendingFallback = {from: url, to: alternative};
      } catch { /* A malformed bookmark must not affect normal navigation. */ }
    }
    if (url !== this.currentUrl) { this.lastPlayback = null; this.seenControls?.clear(); }
    this.currentUrl = url;
    this.urlInput.value = url;
    if (addHistory && this.history[this.historyIndex] !== url) {
      this.history = this.history.slice(0, this.historyIndex + 1);
      this.history.push(url);
      this.historyIndex++;
    }
    this.updateHistoryButtons();
    this.showLoader();
    const youtube = this.getYouTubeEmbed(url);
    const media = this.getMediaEmbed(url);
    const owned = Boolean(youtube || media);
    this.bridgeConnected = false;
    this.frameError = false;
    const errorPanel = document.getElementById('browserError');
    if (errorPanel) errorPanel.hidden = true;
    const indicator = document.querySelector('.auto-sync-status');
    if (indicator) indicator.textContent = '● Sinxron qoşulur…';
    // Keep website scripts, forms and media inside the room, including nested
    // players. The isolated proxy can retain origin APIs without granting any
    // frame permission to navigate the room tab or open popups.
    this.iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-presentation allow-pointer-lock' + (owned || this.proxyOrigin ? ' allow-same-origin' : ''));
    let source = youtube || media || `${this.proxyOrigin}/proxy?url=${encodeURIComponent(url)}&view=1${new URL(url).hash}`;
    if (youtube?.startsWith('https://')) {
      const embed = new URL(youtube);
      source = '/player.html?video=' + encodeURIComponent(embed.pathname.split('/').pop()) + '&start=' + (embed.searchParams.get('start') || '0');
    }
    this.iframe.src = source;
    if (shouldBroadcast) this.broadcast();
  }
  showFrameError(error) {
    if (error.requestedUrl) {
      try { if (this.formatUrl(error.requestedUrl) !== this.currentUrl) return; } catch { return; }
    }
    if (this.pendingFallback?.from === this.currentUrl && ['missing', 'blocked'].includes(error.code)) {
      const alternative = this.pendingFallback.to;
      this.pendingFallback = null;
      window.toast('İlkin mənbə açılmadı. Eyni film FilmBox mənbəsində açılır.');
      this.navigateTo(alternative);
      return;
    }
    this.frameError = true;
    this.hideLoader();
    const title = error.code === 'blocked' ? 'Sayt açılışı məhdudlaşdırır' : error.code === 'missing' ? 'Film səhifəsi açılmadı' : 'Sayt açıla bilmədi';
    this.status.textContent = title;
    const indicator = document.querySelector('.auto-sync-status');
    if (indicator) indicator.textContent = '● Sayt açılmadı';
    const panel = document.getElementById('browserError');
    if (panel) {
      document.getElementById('browserErrorTitle').textContent = title;
      document.getElementById('browserErrorDetail').textContent = error.detail || 'Ünvanı yoxlayın və yenidən sınayın.';
      const detail = document.getElementById('browserErrorDetail');
      if (window.I18n) {
        if (error.code === 'missing' && error.status) window.I18n.bindText(detail, 'Sayt bu ünvan üçün HTTP {status} qaytarır. Film səhifəsi hazırda serverdən açılmır.', { status: error.status });
        else window.I18n.bindText(detail, error.detail || 'Ünvanı yoxlayın və yenidən sınayın.');
      }
      panel.hidden = false;
    }
  }
  broadcast() { this.socket.emit('sync-url', { roomId: this.roomId, url: this.currentUrl }); }
  postMedia(message) {
    this.iframe.contentWindow?.postMessage({ channel: 'kosmi-sync', path: [], ...message }, '*');
  }
  sendMediaContext() { this.postMedia({ type: 'context', leader: this.isLeader, managedFullscreen: Boolean(window.RoomFullscreen) }); }
  handleMediaMessage(message) {
    if (!Array.isArray(message.path) || message.path.length > 10) return;
    if (message.type === 'fullscreen-request') {
      if (message.active) window.RoomFullscreen?.enter(message.path);
      else window.RoomFullscreen?.exit();
      return;
    }
    if (message.type === 'navigate' && !message.path.length && typeof message.url === 'string') { this.navigateTo(message.url); return; }
    if (message.type === 'scroll' && this.navId !== null) {
      this.socket.emit('browser-scroll', { roomId: this.roomId, navId: this.navId, path: message.path, selector: message.selector, x: message.x, y: message.y });
    }
    if ((message.type === 'hello' || message.type === 'ready') && !message.path.length) {
      this.bridgeConnected = true;
      const indicator = document.querySelector('.auto-sync-status');
      if (indicator) indicator.textContent = '● Avtomatik sinxron';
      this.status.textContent = 'Sürüşdürmə və media idarəsi avtomatik sinxronlaşır.';
    }
    if (message.type === 'hello' || message.type === 'ready') {
      this.sendMediaContext();
      if (this.navId !== null) this.socket.emit('browser-state-request', { roomId: this.roomId, navId: this.navId });
      if (this.lastPlayback) this.applyPlayback(this.lastPlayback);
    }
    if (message.type === 'media' && this.navId !== null) {
      // Local control supersedes any cached command from the previous controller.
      this.lastPlayback = null;
      this.socket.emit('media-sync', { roomId: this.roomId, navId: this.navId, path: message.path, reason: message.reason, state: message.state });
    }
    if (message.type === 'ui' && this.navId !== null) {
      this.lastPlayback = null;
      this.socket.emit('browser-ui', { roomId: this.roomId, navId: this.navId, path: message.path, selector: message.selector, group: message.group });
    }
    if (message.type === 'autoplay-blocked') document.getElementById('btnResumeSyncedMedia').hidden = false;
  }
  applyScroll(packet) {
    if (packet.navId === this.navId) this.postMedia({ ...packet, type: 'scroll-apply' });
  }
  applyUi(command) {
    if (command.navId !== this.navId) return;
    if (!this.seenControls.has(command.id)) this.lastPlayback = null;
    this.seenControls.add(command.id);
    this.postMedia({ ...command, type: 'ui-apply' });
  }
  applyPlayback(packet) {
    if (packet.navId !== this.navId || !packet.state) return;
    if (this.lastPlayback && packet.revision < this.lastPlayback.revision) return;
    this.lastPlayback = packet;
    const serverNow = this.clockReady ? Date.now() + this.clockOffset : (packet.serverTime || packet.at);
    const elapsed = packet.state.paused ? 0 : Math.max(0, serverNow - packet.at) / 1000;
    this.postMedia({ ...packet, type: 'apply', state: { ...packet.state, time: packet.state.time + elapsed * packet.state.rate }, receivedAt: Date.now() });
  }
  restoreBrowserState(packet) {
    for (const scroll of packet.scrolls || []) if (scroll.senderId !== this.socket.id) this.applyScroll(scroll);
    for (const command of packet.controls || []) {
      if (command.senderId !== this.socket.id) this.applyUi(command);
    }
    if (packet.playback && packet.playback.senderId !== this.socket.id) this.applyPlayback({ ...packet.playback, serverTime: packet.serverTime });
  }
  moveHistory(delta) {
    const next = this.historyIndex + delta;
    if (next < 0 || next >= this.history.length) return;
    this.historyIndex = next;
    return this.navigateTo(this.history[next], true, false);
  }
  updateHistoryButtons() {
    document.getElementById('btnBrowserBack').disabled = this.historyIndex === 0;
    document.getElementById('btnBrowserForward').disabled = this.historyIndex === this.history.length - 1;
  }
  showLoader() {
    this.pending = true;
    this.loader.style.display = 'flex';
    this.status.textContent = 'Sayt yüklənir…';
    clearTimeout(this.loaderTimeout);
    this.loaderTimeout = setTimeout(() => {
      this.hideLoader();
      this.status.textContent = 'Yükləmə uzun çəkir. Yeniləyərək təkrar sınayın.';
    }, 35000);
  }
  hideLoader() {
    this.pending = false;
    clearTimeout(this.loaderTimeout);
    this.loader.style.display = 'none';
  }
  exitFullscreen() {
    window.RoomFullscreen?.exit();
  }
}
window.BrowserManager = BrowserManager;
