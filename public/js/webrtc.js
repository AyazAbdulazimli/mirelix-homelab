// One independent, recoverable WebRTC connection per room participant.
class WebRTCManager {
  constructor(socket, roomId, myUsername) {
    this.socket = socket;
    this.roomId = roomId;
    this.myUsername = myUsername;
    this.peers = new Map();
    this.localStream = new MediaStream();
    this.screenTransport = new MediaStream();
    this.screenStream = null;
    this.shares = new Map();
    this.selectedShare = null;
    this.isMicEnabled = true;
    this.isCamEnabled = false;
    this.isScreenSharing = false;
    this.iceServers = window.mirelixIceConfig || { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    this.initSocketEvents();
    document.getElementById('screenSourceSelect')?.addEventListener('change', event => {
      this.selectedShare = event.target.value;
      this.renderScreen();
    });
    document.getElementById('btnEnableCallAudio')?.addEventListener('click', () => this.unlockAudio());
    window.addEventListener?.('pagehide', () => this.dispose(), { once: true });
  }

  text(element, source, params = {}) {
    if (!element) return;
    if (window.I18n) window.I18n.bindText(element, source, params);
    else element.textContent = source.replace(/\{(\w+)\}/g, (_, key) => params[key] ?? '');
  }

  async initLocalMedia() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } } });
    } catch {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch { stream = new MediaStream(); }
    }
    if (this.disposed) { stream.getTracks().forEach(track => track.stop()); return; }
    for (const track of stream.getTracks()) {
      // Keep stream IDs stable for peers that connected while permission was pending.
      if (!this.localStream.getTracks().some(existing => existing.kind === track.kind)) this.localStream.addTrack(track);
      else track.stop();
      track.addEventListener?.('ended', () => this.publishMediaState());
    }
    const preview = document.getElementById('localVideo');
    if (preview) preview.srcObject = this.localStream;
    this.setCameraEnabled(this.isCamEnabled);
    this.setMicEnabled(this.isMicEnabled);
    await this.refreshSenders();
  }

  localTracks() {
    return [this.localStream.getAudioTracks()[0], this.localStream.getVideoTracks()[0], this.screenStream?.getAudioTracks()[0], this.screenStream?.getVideoTracks()[0]].map(track => track?.readyState === 'ended' ? null : track || null);
  }

  getPeer(id, username) {
    if (id === this.socket.id) return null;
    let peer = this.peers.get(id);
    if (peer) {
      if (username !== undefined) { peer.username = username; this.renderPeer(peer); }
      return peer;
    }
    const pc = new RTCPeerConnection(this.iceServers);
    peer = { id, username: username || '', pc, camera: new MediaStream(), screen: new MediaStream(), media: { mic: false, camera: false }, candidates: [], makingOffer: false, ignoreOffer: false, settingAnswer: false, queue: Promise.resolve(), retries: 0 };
    this.peers.set(id, peer);
    pc.onnegotiationneeded = async () => {
      // Only one end starts the first offer; later renegotiations use polite roles.
      if (this.socket.id > id) return;
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        if (!this.peers.has(id) || !this.socket.connected) return;
        this.socket.emit(pc.localDescription.type === 'offer' ? 'webrtc-offer' : 'webrtc-answer', { targetId: id, [pc.localDescription.type]: pc.localDescription });
      } catch (error) { if (pc.signalingState !== 'closed') console.warn('WebRTC negotiation:', error); }
      finally { peer.makingOffer = false; }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.socket.emit('webrtc-candidate', { targetId: id, candidate });
    };
    pc.ontrack = event => {
      const slot = pc.getTransceivers().indexOf(event.transceiver);
      const stream = slot < 2 ? peer.camera : peer.screen;
      if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track);
      event.track.onunmute = () => { this.renderPeer(peer); this.renderScreen(); };
      event.track.onended = () => { stream.removeTrack(event.track); this.renderPeer(peer); this.renderScreen(); };
      this.renderPeer(peer);
      this.renderScreen();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') { clearTimeout(peer.retryTimer); peer.retries = 0; }
      if (['disconnected', 'failed'].includes(pc.connectionState)) {
        clearTimeout(peer.retryTimer);
        peer.retryTimer = setTimeout(() => this.recoverPeer(peer), pc.connectionState === 'failed' ? 0 : 4000);
      }
      this.renderPeer(peer);
    };
    const tracks = this.localTracks();
    // The answerer uses the offered slots. Pre-creating its own addTransceiver
    // slots would append another four m-lines instead of pairing the senders.
    if (this.socket.id < id) ['audio', 'video', 'audio', 'video'].forEach((kind, index) => {
      pc.addTransceiver(tracks[index] || kind, { direction: 'sendrecv', streams: [index < 2 ? this.localStream : this.screenTransport] });
    });
    this.renderPeer(peer);
    return peer;
  }

  // Retained as a small API for diagnostics and local media tests.
  createPeerConnection(id) { return this.getPeer(id).pc; }

  async description(senderId, description) {
    const peer = description?.type === 'offer' ? this.getPeer(senderId) : this.peers.get(senderId);
    if (!peer || !description) return;
    peer.queue = peer.queue.then(async () => {
      const pc = peer.pc;
      if (pc.signalingState === 'closed') return;
      const ready = !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingAnswer);
      const collision = description.type === 'offer' && !ready;
      // Stable ordering gives exactly one side the polite role on every edge.
      peer.ignoreOffer = this.socket.id < senderId && collision;
      if (peer.ignoreOffer) return;
      peer.settingAnswer = description.type === 'answer';
      try { await pc.setRemoteDescription(description); }
      finally { peer.settingAnswer = false; }
      for (const candidate of peer.candidates.splice(0)) {
        try { await pc.addIceCandidate(candidate); } catch (error) { if (!peer.ignoreOffer) console.warn('ICE:', error); }
      }
      if (description.type === 'offer') {
        const tracks = this.localTracks();
        await Promise.all(pc.getTransceivers().slice(0, 4).map((transceiver, index) => {
          transceiver.direction = 'sendrecv';
          transceiver.sender.setStreams(index < 2 ? this.localStream : this.screenTransport);
          return transceiver.sender.replaceTrack(tracks[index]);
        }));
        await pc.setLocalDescription();
        this.socket.emit('webrtc-answer', { targetId: senderId, answer: pc.localDescription });
      }
    }).catch(error => { if (peer.pc.signalingState !== 'closed') console.warn('WebRTC signaling:', error); });
    return peer.queue;
  }

  async candidate(senderId, candidate) {
    if (!candidate) return;
    const peer = this.peers.get(senderId);
    if (!peer || peer.ignoreOffer) return;
    if (!peer.pc.remoteDescription) { peer.candidates.push(candidate); return; }
    try { await peer.pc.addIceCandidate(candidate); }
    catch (error) { if (!peer.ignoreOffer) console.warn('ICE:', error); }
  }

  recoverPeer(peer) {
    if (this.peers.get(peer.id) !== peer || !this.socket.connected || !['failed', 'disconnected'].includes(peer.pc.connectionState) || peer.retries >= 3) return;
    peer.retries++;
    this.restartPeer(peer.id);
    peer.retryTimer = setTimeout(() => this.recoverPeer(peer), 12000);
    this.renderPeer(peer);
  }

  restartPeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    // Keep the original offerer/DTLS roles stable across Chromium and Firefox.
    if (this.socket.id < id) peer.pc.restartIce();
    else this.socket.emit('webrtc-restart', { targetId: id, request: true });
  }

  async refreshSenders() {
    const tracks = this.localTracks();
    const results = await Promise.allSettled([...this.peers.values()].flatMap(peer => peer.pc.getTransceivers().slice(0, 4).map((transceiver, index) => transceiver.sender.replaceTrack(tracks[index]))));
    for (const result of results) if (result.status === 'rejected') console.warn('Media track:', result.reason);
    this.publishMediaState();
  }

  publishMediaState() {
    const live = (kind, enabled) => enabled && this.localStream.getTracks().some(track => track.kind === kind && track.readyState !== 'ended');
    this.socket.emit('media-state', { roomId: this.roomId, mic: live('audio', this.isMicEnabled), camera: live('video', this.isCamEnabled) });
  }

  initSocketEvents() {
    this.socket.on('room-joined', ({ users }) => {
      this.closePeers();
      for (const user of users) {
        const peer = this.getPeer(user.socketId, user.username);
        peer.media = { mic: !!user.mic, camera: !!user.camera };
        this.renderPeer(peer);
      }
      this.publishMediaState();
      if (this.isScreenSharing) {
        this.shares.set(this.socket.id, this.myUsername);
        this.socket.emit('screenshare-status', { roomId: this.roomId, isSharing: true });
        this.renderScreen();
      }
    });
    this.socket.on('room-users', ({ users }) => {
      const active = new Set(users.map(user => user.socketId));
      for (const id of this.peers.keys()) if (!active.has(id)) this.removePeer(id);
      for (const user of users) if (user.socketId !== this.socket.id) {
        const peer = this.getPeer(user.socketId, user.username);
        peer.media = { mic: !!user.mic, camera: !!user.camera };
        this.renderPeer(peer);
      }
    });
    this.socket.on('user-joined', ({ socketId, username }) => {
      this.getPeer(socketId, username);
      window.toast?.('👋 {name} otağa qoşuldu', { name: username });
      window.sounds?.playJoin();
    });
    this.socket.on('user-left', ({ socketId }) => this.removePeer(socketId));
    this.socket.on('webrtc-offer', ({ senderId, offer }) => this.description(senderId, offer));
    this.socket.on('webrtc-answer', ({ senderId, answer }) => this.description(senderId, answer));
    this.socket.on('webrtc-candidate', ({ senderId, candidate }) => this.candidate(senderId, candidate));
    this.socket.on('webrtc-restart', ({ senderId }) => {
      if (this.socket.id < senderId) this.peers.get(senderId)?.pc.restartIce();
    });
    this.socket.on('media-state', ({ senderId, mic, camera }) => {
      const peer = this.peers.get(senderId);
      if (peer) { peer.media = { mic, camera }; this.renderPeer(peer); }
    });
    this.socket.on('screenshare-status', ({ senderId, username, isSharing }) => {
      if (isSharing) this.shares.set(senderId, username);
      else this.shares.delete(senderId);
      this.renderScreen();
      if (isSharing && this.shares.size === 1) document.querySelector('.stage-tab[data-view="screen"]')?.click();
    });
    this.socket.on('disconnect', () => { this.closePeers(); this.shares.clear(); this.renderScreen(); });
  }

  play(video) {
    if (!video?.srcObject || !video.srcObject.getTracks().length) return;
    video.play()?.catch(error => {
      if (error.name === 'NotAllowedError') {
        const button = document.getElementById('btnEnableCallAudio');
        if (button) button.hidden = false;
      }
    });
  }

  async unlockAudio() {
    const videos = [...document.querySelectorAll('.remote-card video'), document.getElementById('screenShareVideo')].filter(video => video?.srcObject?.getTracks().length);
    const results = await Promise.allSettled(videos.map(video => video.play()));
    document.getElementById('btnEnableCallAudio').hidden = results.every(result => result.status === 'fulfilled');
  }

  renderPeer(peer) {
    const grid = document.getElementById('videoGrid');
    if (!grid) return;
    if (!peer.card) {
      const card = document.createElement('div');
      card.className = 'video-card remote-card';
      card.dataset.peerId = peer.id;
      card.innerHTML = '<video autoplay playsinline></video><div class="video-placeholder"><span class="user-avatar-large">👤</span><span class="status-text">Kamera Sönülüdür</span></div><div class="video-label"><span class="peer-name"></span><span class="peer-mic"></span></div><span class="peer-status" role="status"></span>';
      grid.appendChild(card);
      peer.card = card;
      card.addEventListener('click', () => { this.pipPeerId = peer.id; this.updatePip(); });
    }
    const video = peer.card.querySelector('video');
    if (video.srcObject !== peer.camera) video.srcObject = peer.camera;
    this.text(peer.card.querySelector('.peer-name'), '{name}', { name: peer.username });
    peer.card.querySelector('.peer-mic').textContent = peer.media.mic ? '🎙️' : '🔇';
    peer.card.querySelector('.video-placeholder').style.display = peer.media.camera && peer.camera.getVideoTracks().length && peer.pc.connectionState === 'connected' ? 'none' : 'flex';
    const state = peer.pc.connectionState;
    this.text(peer.card.querySelector('.peer-status'), state === 'connected' ? 'Qoşuldu' : peer.retries >= 3 && state === 'failed' ? 'Bağlantı alınmadı' : ['disconnected', 'failed'].includes(state) ? 'Bağlantı bərpa edilir…' : 'Bağlanır…');
    this.play(video);
    const empty = document.getElementById('remoteVideoEmpty');
    if (empty) empty.hidden = this.peers.size > 0;
    this.updatePip();
  }

  updatePip() {
    const pip = document.getElementById('floatingCameraPip');
    if (!pip) return;
    const peer = this.peers.get(this.pipPeerId) || [...this.peers.values()].find(peer => peer.media.camera) || this.peers.values().next().value;
    const video = document.getElementById('pipRemoteVideo');
    if (video) { video.muted = true; video.srcObject = peer?.camera || null; if (peer) this.play(video); }
    this.text(document.getElementById('pipLabel'), peer ? '{name}' : 'Dost', peer ? { name: peer.username } : {});
    pip.style.display = peer?.media.camera && !document.getElementById('viewVideo')?.classList.contains('active') ? 'block' : 'none';
  }

  renderScreen() {
    const select = document.getElementById('screenSourceSelect');
    if (!select) return;
    if (!this.shares.has(this.selectedShare)) this.selectedShare = this.shares.keys().next().value || null;
    select.replaceChildren();
    for (const [id, username] of this.shares) {
      const option = document.createElement('option');
      option.value = id;
      this.text(option, id === this.socket.id ? '{name} (Siz)' : '{name}', { name: username });
      select.appendChild(option);
    }
    if (this.selectedShare) select.value = this.selectedShare;
    document.getElementById('screenSourcePicker').hidden = this.shares.size < 2;
    const local = this.selectedShare === this.socket.id;
    const stream = local ? this.screenStream : this.peers.get(this.selectedShare)?.screen;
    const video = document.getElementById('screenShareVideo');
    video.muted = local;
    if (video.srcObject !== (stream || null)) video.srcObject = stream || null;
    this.play(video);
    const active = this.shares.size > 0;
    document.getElementById('screenEmptyState').style.display = active ? 'none' : 'flex';
    document.getElementById('screenVideoWrapper').style.display = active ? 'flex' : 'none';
    document.getElementById('screenLiveBadge').style.display = active ? 'inline-block' : 'none';
    this.text(document.getElementById('screenOwnerLabel'), local ? 'Ekranınız (Paylaşılır)' : 'Ekran: {name}', { name: this.shares.get(this.selectedShare) || '' });
  }

  removePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    clearTimeout(peer.retryTimer);
    peer.pc.onconnectionstatechange = null;
    peer.pc.ontrack = null;
    peer.pc.close();
    peer.card?.remove();
    this.peers.delete(id);
    this.shares.delete(id);
    const empty = document.getElementById('remoteVideoEmpty');
    if (empty) empty.hidden = this.peers.size > 0;
    this.renderScreen();
    this.updatePip();
  }

  closePeers() { for (const id of [...this.peers.keys()]) this.removePeer(id); }

  async toggleMic() {
    if (!this.isMicEnabled && !this.localStream.getAudioTracks().some(track => track.readyState !== 'ended')) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (this.disposed) { stream.getTracks().forEach(track => track.stop()); return false; }
        this.localStream.getAudioTracks().forEach(track => this.localStream.removeTrack(track));
        stream.getAudioTracks().forEach(track => this.localStream.addTrack(track));
        await this.refreshSenders();
      } catch { window.toast?.('Mikrofon icazəsi alınmadı. Brauzer icazələrini yoxlayın.'); return false; }
    }
    this.setMicEnabled(!this.isMicEnabled);
    return this.isMicEnabled;
  }
  setMicEnabled(enabled) {
    this.isMicEnabled = enabled;
    this.localStream.getAudioTracks().forEach(track => { track.enabled = enabled; });
    const button = document.getElementById('btnToggleMic');
    button?.classList.toggle('muted', !enabled);
    if (button) {
      button.querySelector('.dock-icon').textContent = enabled ? '🎙️' : '🔇';
      this.text(button.querySelector('.dock-label'), enabled ? 'Mikrofon' : 'Səssiz');
    }
    const indicator = document.getElementById('localMicIndicator');
    if (indicator) indicator.textContent = enabled ? '🎙️' : '🔇';
    this.publishMediaState();
  }

  async toggleCamera() {
    if (!this.isCamEnabled && !this.localStream.getVideoTracks().some(track => track.readyState !== 'ended')) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
        if (this.disposed) { stream.getTracks().forEach(track => track.stop()); return false; }
        this.localStream.getVideoTracks().forEach(track => this.localStream.removeTrack(track));
        stream.getVideoTracks().forEach(track => this.localStream.addTrack(track));
        await this.refreshSenders();
      } catch { window.toast?.('Kamera icazəsi alınmadı. Brauzer icazələrini yoxlayın.'); return false; }
    }
    this.setCameraEnabled(!this.isCamEnabled);
    return this.isCamEnabled;
  }

  setCameraEnabled(enabled) {
    this.isCamEnabled = enabled;
    this.localStream.getVideoTracks().forEach(track => { track.enabled = enabled; });
    const button = document.getElementById('btnToggleCam');
    button?.classList.toggle('active', enabled);
    if (button) button.querySelector('.dock-icon').textContent = enabled ? '📹' : '🚫';
    const placeholder = document.getElementById('localVideoPlaceholder');
    if (placeholder) placeholder.style.display = enabled ? 'none' : 'flex';
    this.publishMediaState();
  }

  async toggleScreenShare() {
    if (this.isScreenSharing) await this.stopScreenShare();
    else await this.startScreenShare();
    return this.isScreenSharing;
  }

  async startScreenShare() {
    if (this.isScreenSharing || this.screenPrompt) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      window.toast?.('Bu brauzerdə ekran paylaşımı dəstəklənmir. Başqa iştirakçının paylaşdığı ekranı burada izləyə bilərsiniz.');
      return;
    }
    this.screenPrompt = true;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always', frameRate: { ideal: 60, max: 60 } }, audio: true });
      if (this.disposed) { stream.getTracks().forEach(track => track.stop()); return; }
      this.screenStream = stream;
      this.screenTransport.getTracks().forEach(track => this.screenTransport.removeTrack(track));
      stream.getTracks().forEach(track => this.screenTransport.addTrack(track));
      this.isScreenSharing = true;
      await this.refreshSenders();
      this.shares.set(this.socket.id, this.myUsername);
      this.selectedShare = this.socket.id;
      this.socket.emit('screenshare-status', { roomId: this.roomId, isSharing: true });
      this.renderScreen();
      const button = document.getElementById('btnToggleScreen');
      button?.classList.add('sharing');
      this.text(button?.querySelector('.dock-label'), 'Paylaşımı Bitir');
      stream.getVideoTracks()[0].onended = () => this.stopScreenShare();
      document.querySelector('.stage-tab[data-view="screen"]')?.click();
      this.socket.emit('switch-view', { roomId: this.roomId, viewName: 'screen' });
    } catch (error) { if (error.name !== 'NotAllowedError') console.warn('Screen sharing:', error); }
    finally { this.screenPrompt = false; }
  }

  async stopScreenShare() {
    if (!this.isScreenSharing) return;
    this.isScreenSharing = false;
    this.screenStream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    this.screenStream = null;
    this.screenTransport.getTracks().forEach(track => this.screenTransport.removeTrack(track));
    this.shares.delete(this.socket.id);
    await this.refreshSenders();
    this.socket.emit('screenshare-status', { roomId: this.roomId, isSharing: false });
    const button = document.getElementById('btnToggleScreen');
    button?.classList.remove('sharing');
    this.text(button?.querySelector('.dock-label'), 'Ekran Paylaş');
    this.renderScreen();
  }

  dispose() {
    this.disposed = true;
    this.closePeers();
    this.localStream.getTracks().forEach(track => track.stop());
    this.screenStream?.getTracks().forEach(track => track.stop());
  }
}
window.WebRTCManager = WebRTCManager;
