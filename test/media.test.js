const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('late camera permission fills pre-negotiated media slots without blocking browsing', async () => {
  const videoTrack = { kind: 'video', enabled: true };
  const audioTrack = { kind: 'audio', enabled: true };
  class Stream {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    addTrack(track) { this.tracks.push(track); }
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
  }
  class Connection {
    constructor() { this.transceivers = []; }
    addTransceiver(track, options) {
      const kind = typeof track === 'string' ? track : track.kind;
      const sender = { track: typeof track === 'string' ? null : track, async replaceTrack(next) { this.track = next; } };
      this.transceivers.push({ receiver: { track: { kind } }, sender, streams: options.streams });
    }
    getTransceivers() { return this.transceivers; }
  }
  let grant;
  const context = { window: {}, console, MediaStream: Stream, RTCPeerConnection: Connection, navigator: { mediaDevices: { getUserMedia: () => new Promise(resolve => { grant = resolve; }) } }, document: { getElementById: () => null } };
  vm.runInNewContext(fs.readFileSync('public/js/webrtc.js', 'utf8'), context);
  const manager = new context.window.WebRTCManager({ id: 'a', on() {}, emit() {} }, 'room', 'guest');
  const pending = manager.initLocalMedia();
  const connection = manager.createPeerConnection('peer');
  assert.equal(connection.transceivers.length, 4);
  const second = manager.createPeerConnection('second');
  assert.equal(manager.peers.size, 2);
  assert.ok(connection.transceivers.every(t => t.streams.length === 1));
  grant(new Stream([audioTrack, videoTrack]));
  // Real DOM contains the preview; provide it for the resolved request.
  context.document.getElementById = id => id === 'localVideo' ? {} : null;
  await pending;
  assert.equal(connection.transceivers[0].sender.track, audioTrack);
  assert.equal(connection.transceivers[1].sender.track, videoTrack);
  assert.equal(videoTrack.enabled, false);
  assert.equal(second.transceivers[0].sender.track, audioTrack);
  assert.equal(second.transceivers[1].sender.track, videoTrack);
  assert.equal(second.transceivers[3].sender.track, null);
});
