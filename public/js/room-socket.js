// Event adapter for the Cloudflare Durable Object WebSocket transport.
// The local Node server continues to serve the original Socket.IO client.
(function () {
  class RoomSocket {
    constructor() {
      this.handlers = new Map();
      this.queue = [];
      this.connected = false;
      this.id = null;
      this.attempt = 0;
      this.closed = false;
      this.connect();
    }
    on(event, handler) {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event).add(handler);
      return this;
    }
    off(event, handler) { this.handlers.get(event)?.delete(handler); return this; }
    dispatch(event, data) { for (const handler of this.handlers.get(event) || []) handler(data); }
    emit(event, data) {
      if (this.connected && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({event, data}));
      else if (event !== 'join-room') {
        this.queue.push({event,data});
        if (this.queue.length > 100) this.queue.shift();
      }
      return this;
    }
    connect() {
      const roomId = decodeURIComponent(location.pathname.split('/room/')[1]?.split('/')[0] || 'default');
      const url = new URL('/api/rooms/' + encodeURIComponent(roomId) + '/ws', location.origin);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.ws = new WebSocket(url);
      this.ws.addEventListener('message', event => {
        let packet;
        try { packet = JSON.parse(event.data); } catch { return; }
        if (packet.event === 'connect') {
          this.id = packet.data.id;
          this.connected = true;
          this.attempt = 0;
          // The app's connect handler joins first; offline messages follow it.
          this.dispatch('connect');
          for (const message of this.queue.splice(0)) this.emit(message.event, message.data);
        } else this.dispatch(packet.event, packet.data);
      });
      this.ws.addEventListener('error', () => this.dispatch('connect_error', new Error('Otağa qoşulmaq mümkün olmadı.')));
      this.ws.addEventListener('close', () => {
        this.connected = false;
        this.dispatch('disconnect');
        if (!this.closed) this.retry = setTimeout(() => this.connect(), Math.min(1000 * 2 ** this.attempt++, 15000));
      });
    }
    disconnect() { this.closed = true; clearTimeout(this.retry); this.ws.close(); return this; }
  }
  window.io = () => new RoomSocket();
})();
