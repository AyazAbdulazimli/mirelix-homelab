// Runs inside each proxied document and the app-owned YouTube player page.
function mediaBridge() {
  if (window.__kosmiMediaBridge) return;
  window.__kosmiMediaBridge = true;
  let leader = false;
  let gestureAt = 0;
  let pending = null;
  let applyingUntil = 0;
  let lastSample = null;
  let lastSound = null;
  let activeIndex = 0;
  const registered = new WeakSet();
  const appliedUi = new Set();
  const queued = new Map();
  const scrollGuards = new Map();
  const scrollRevisions = new Map();
  let scrollTimer = null;
  const scrollTargets = new Set();
  const scrollRoot = target => !target || target === document || target === window || target === document.documentElement || target === document.body;
  const scrollElement = selector => { try { return selector ? document.querySelector(selector) : document.scrollingElement || document.documentElement; } catch { return null; } };
  function publishScroll(target) {
    if (fullscreenTarget || Date.now() < fullscreenRestoreUntil) return;
    const root = scrollRoot(target);
    const element = root ? scrollElement('') : target;
    if (!element || (element.scrollHeight <= element.clientHeight && element.scrollWidth <= element.clientWidth)) return;
    const selector = root ? '' : selectorFor(element);
    const x = element.scrollLeft / Math.max(1, element.scrollWidth - element.clientWidth);
    const y = element.scrollTop / Math.max(1, element.scrollHeight - element.clientHeight);
    const guard = scrollGuards.get(selector);
    if (guard && Date.now() < guard.until && Math.abs(x - guard.x) < 0.003 && Math.abs(y - guard.y) < 0.003) return;
    queued.delete('scroll:' + JSON.stringify([]) + selector);
    send({ type: 'scroll', selector, x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) });
  }
  document.addEventListener('scroll', event => {
    scrollTargets.add(scrollRoot(event.target) ? document : event.target);
    if (!scrollTimer) scrollTimer = setTimeout(() => {
      scrollTimer = null;
      for (const target of scrollTargets) publishScroll(target);
      scrollTargets.clear();
    }, 80);
  }, true);
  for (const type of ['wheel', 'touchmove', 'keydown']) document.addEventListener(type, event => {
    if (event.isTrusted) scrollGuards.clear();
  }, { capture: true, passive: true });
  function applyScroll(message) {
    const element = scrollElement(message.selector);
    if (!element) return false;
    const width = Math.max(0, element.scrollWidth - element.clientWidth);
    const height = Math.max(0, element.scrollHeight - element.clientHeight);
    if ((message.x > 0 && !width) || (message.y > 0 && !height)) return false;
    scrollGuards.set(message.selector, { x: message.x, y: message.y, until: Date.now() + 1000 });
    element.scrollTo({ left: width * message.x, top: height * message.y, behavior: 'instant' });
    return true;
  }
  const originalUrl = () => {
    try { return new URL(location.href).searchParams.get('url') || location.href; } catch { return location.href; }
  };
  const frames = () => [...document.querySelectorAll('iframe')];
  const send = data => { if (parent !== window) parent.postMessage({ channel: 'kosmi-sync', path: [], ...data }, '*'); };
  // Expand a player within its frame; the outer room owns browser fullscreen.
  // This preserves chat on desktop and the stacked film/chat layout on phones.
  let fullscreenTarget = null;
  let fullscreenScroll = null;
  let fullscreenRestoreUntil = 0;
  let managedFullscreen = false;
  const fullscreenAttribute = 'data-kosmi-fullscreen';
  function frameFullscreen(target) {
    if (fullscreenTarget === target) return;
    if (target && !fullscreenTarget) fullscreenScroll = {x:scrollX,y:scrollY};
    if (!target) fullscreenRestoreUntil = Date.now() + 500;
    fullscreenTarget?.removeAttribute(fullscreenAttribute);
    fullscreenTarget = target;
    if (target) {
      if (!document.getElementById('kosmi-fullscreen-style')) {
        const style = document.createElement('style');
        style.id = 'kosmi-fullscreen-style';
        style.textContent = '[data-kosmi-fullscreen]{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;margin:0!important;border:0!important;z-index:2147483647!important;background:#000!important;object-fit:contain!important}';
        (document.head || document.documentElement).appendChild(style);
      }
      target.setAttribute(fullscreenAttribute, '');
    }
    for (const name of ['fullscreenchange','webkitfullscreenchange','mozfullscreenchange']) (target || document).dispatchEvent(new Event(name,{bubbles:true}));
    if (!target && fullscreenScroll) {
      const previous = fullscreenScroll; fullscreenScroll = null;
      requestAnimationFrame(()=>window.scrollTo(previous.x,previous.y));
    }
  }
  function requestFrameFullscreen() {
    frameFullscreen(this);
    send({type:'fullscreen-request',active:true});
    return Promise.resolve();
  }
  function exitFrameFullscreen() {
    if (fullscreenTarget) {
      frameFullscreen(null);
      send({type:'fullscreen-request',active:false});
    }
    return Promise.resolve();
  }
  function enableManagedFullscreen() {
    if (managedFullscreen || parent === window) return;
    managedFullscreen = true;
    for (const name of ['requestFullscreen','webkitRequestFullscreen','webkitRequestFullScreen','mozRequestFullScreen']) {
      try { Object.defineProperty(Element.prototype,name,{configurable:true,writable:true,value:requestFrameFullscreen}); } catch {}
    }
    for (const name of ['exitFullscreen','webkitExitFullscreen','webkitCancelFullScreen','mozCancelFullScreen']) {
      try { Object.defineProperty(document,name,{configurable:true,value:exitFrameFullscreen}); } catch {}
    }
    for (const name of ['fullscreenElement','webkitFullscreenElement','mozFullScreenElement']) {
      try { Object.defineProperty(document,name,{configurable:true,get:()=>fullscreenTarget}); } catch {}
    }
    for (const name of ['fullscreenEnabled','webkitFullscreenEnabled']) {
      try { Object.defineProperty(document,name,{configurable:true,get:()=>true}); } catch {}
    }
    try { Object.defineProperty(document,'webkitIsFullScreen',{configurable:true,get:()=>Boolean(fullscreenTarget)}); } catch {}
    if (window.HTMLVideoElement) {
      for (const name of ['webkitEnterFullscreen','webkitEnterFullScreen']) {
        try { Object.defineProperty(HTMLVideoElement.prototype,name,{configurable:true,value:requestFrameFullscreen}); } catch {}
      }
      try { Object.defineProperty(HTMLVideoElement.prototype,'webkitExitFullscreen',{configurable:true,value:exitFrameFullscreen}); } catch {}
    }
    document.addEventListener('keydown',event=>{if(event.key==='Escape')exitFrameFullscreen()});
  }
  const gesture = event => { if (event.isTrusted) { gestureAt = Date.now(); applyingUntil = 0; pending = null; } };
  for (const type of ['pointerdown', 'keydown', 'touchstart']) document.addEventListener(type, gesture, true);
  function adapter(index = 0) {
    const yt = window.kosmiYouTube;
    if (yt?.getPlayerState && index === 0) return {
      time: () => yt.getCurrentTime() || 0,
      paused: () => [0, 2, 5, -1].includes(yt.getPlayerState()),
      rate: () => yt.getPlaybackRate() || 1,
      ready: () => Number.isFinite(yt.getDuration()) && yt.getDuration() > 0,
      seek: time => yt.seekTo(time, true),
      play: () => yt.playVideo(), pause: () => yt.pauseVideo(),
      setRate: rate => yt.setPlaybackRate(rate),
      volume: () => (yt.getVolume?.() ?? 100) / 100,
      muted: () => yt.isMuted?.() ?? false,
      setVolume: volume => yt.setVolume?.(volume * 100),
      setMuted: muted => muted ? yt.mute?.() : yt.unMute?.()
    };
    const video = document.querySelectorAll('video,audio')[index];
    if (!video) return null;
    return {
      time: () => Number.isFinite(video.currentTime) ? video.currentTime : 0,
      paused: () => video.paused || video.ended,
      rate: () => video.playbackRate || 1,
      ready: () => video.readyState >= 1,
      seek: time => { if (Number.isFinite(video.duration)) time = Math.min(time, Math.max(0, video.duration - 0.1)); video.currentTime = time; },
      play: () => video.play(), pause: () => video.pause(),
      setRate: rate => { video.playbackRate = rate; },
      volume: () => video.volume, muted: () => video.muted,
      focused: () => video.controls && document.activeElement === video,
      setAutoplay: value => { video.autoplay = value; },
      setVolume: volume => { video.volume = volume; },
      setMuted: muted => { video.muted = muted; }
    };
  }
  function publish(reason, index = 0) {
    const media = adapter(index);
    if (!media?.ready() || Date.now() < applyingUntil) return;
    const intent = Date.now() - gestureAt < 3000 || Boolean(media.focused?.());
    if (!leader && !intent && !(window.kosmiYouTube && !['initial', 'tick'].includes(reason))) return;
    const state = { time: media.time(), paused: media.paused(), rate: media.rate(), volume: media.volume(), muted: media.muted(), mediaIndex: index };
    if (!Number.isFinite(state.time)) return;
    // A follower may act too; periodic correction remains with the last controller.
    if (reason === 'tick' && !leader) return;
    if (pending && !intent && reason !== 'tick') {
      const expected = pending.state.time + (pending.state.paused ? 0 : Math.max(0, Date.now() - pending.receivedAt) / 1000 * pending.state.rate);
      const sameVolume = pending.state.volume === undefined || Math.abs(state.volume - pending.state.volume) < 0.005;
      const sameMute = pending.state.muted === undefined || state.muted === pending.state.muted;
      if (state.paused === pending.state.paused && Math.abs(state.time - expected) < 2 && Math.abs(state.rate - pending.state.rate) < 0.01 && sameVolume && sameMute) return;
    }
    if (reason !== 'tick') { pending = null; activeIndex = index; }
    send({ type: 'media', reason, state });
  }
  function ready(index = 0) {
    send({ type: 'ready', mediaIndex: index });
    if (pending) apply(pending);
    else if (leader) publish('initial', index);
  }
  function apply(packet) {
    pending = packet;
    const media = adapter(packet.state.mediaIndex);
    if (!media?.ready()) return;
    const state = packet.state;
    if (state.paused) media.setAutoplay?.(false);
    activeIndex = state.mediaIndex;
    const elapsed = state.paused ? 0 : Math.max(0, Date.now() - packet.receivedAt) / 1000;
    const target = state.time + elapsed * state.rate;
    try {
      const seek = Math.abs(media.time() - target) > (packet.reason === 'tick' ? 1.25 : 0.4);
      const rate = Math.abs(media.rate() - state.rate) > 0.01;
      const volume = Number.isFinite(state.volume) && Math.abs(media.volume() - state.volume) > 0.005;
      const mute = typeof state.muted === 'boolean' && media.muted() !== state.muted;
      const toggle = media.paused() !== state.paused || (window.kosmiYouTube && !state.paused && window.kosmiYouTube.getPlayerState() === 3 && packet.reason !== 'tick');
      // A heartbeat that changes nothing must not swallow the next local action.
      if (seek || rate || toggle || volume || mute) applyingUntil = Date.now() + (window.kosmiYouTube ? 1500 : 800);
      if (seek) media.seek(target);
      if (rate) media.setRate(state.rate);
      if (volume) media.setVolume(state.volume);
      if (mute) media.setMuted(state.muted);
      if (toggle) {
        if (state.paused) media.pause();
        else Promise.resolve(media.play()).catch(() => send({ type: 'autoplay-blocked' }));
      }
      lastSample = { time: target, at: Date.now(), paused: state.paused };
      // Keep the most recent command for metadata arriving after a source change.
    } catch { /* loadedmetadata/canplay will retry the command. */ }
  }
  function selectorFor(element) {
    const parts = [];
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      const siblings = [...(node.parentElement?.children || [])].filter(sibling => sibling.tagName === node.tagName);
      parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')');
    }
    return parts.join(' > ');
  }
  document.addEventListener('click', event => {
    if (!event.isTrusted) return;
    const target = event.target.closest?.('button,a,[role="button"],.play');
    if (!target) return;
    // Fullscreen is a local viewing preference, never a synchronized control.
    if (target.closest('.jw-icon-fullscreen,.vjs-fullscreen-control,[data-plyr="fullscreen"],[aria-label*="fullscreen" i],[title*="fullscreen" i],#mediaFullscreen')) return;
    // Replicate media/source selectors, never arbitrary forms or account actions.
    if (!target.matches('.sv-pill,.lang-pill,[data-video],[data-episode],.prev-ep,.next-ep,.play,.vjs-big-play-button,.jw-display-icon-container,.plyr__control--overlaid') && !target.closest('.eplist,#player,.player-selector,.video-selector,.playlist')) return;
    if (target.matches('.prev-ep,.next-ep')) {
      setTimeout(() => {
        const selected = document.querySelector('.eplist a.active[data-num]');
        if (selected) send({type:'ui', selector:selectorFor(selected), group:'episode'});
      }, 0);
      return;
    }
    const group = target.matches('.sv-pill') ? 'server' : target.matches('.lang-pill') ? 'language' : target.closest('.eplist') ? 'episode' : target.matches('.play,.vjs-big-play-button,.jw-display-icon-container,.plyr__control--overlaid') ? 'start' : 'control';
    send({ type: 'ui', selector: selectorFor(target), group });
  }, true);
  function deliver(message) {
    if (message.type === 'fullscreen-auto' || message.type === 'fullscreen-apply') enableManagedFullscreen();
    if (message.type === 'fullscreen-clear') {
      for (const [key,command] of queued) if (command.type.startsWith('fullscreen-')) queued.delete(key);
      frameFullscreen(null);
      frames().forEach(frame=>frame.contentWindow.postMessage({...message,path:[]},'*'));
      return true;
    }
    if (message.type === 'fullscreen-auto') {
      const video = document.querySelector('video');
      const child = frames().filter(frame=>frame.getBoundingClientRect().width>100).sort((a,b)=>b.clientWidth*b.clientHeight-a.clientWidth*a.clientHeight)[0];
      const target = video?.closest('.jwplayer,.video-js,.plyr,#mediaShell') || video || child;
      if (target) requestFrameFullscreen.call(target);
      if (!video && child) child.contentWindow.postMessage({...message,path:[]},'*');
      return Boolean(target);
    }
    if (message.path?.length) {
      const child = frames()[message.path[0]];
      if (child && message.type === 'fullscreen-apply') frameFullscreen(child);
      if (child) child.contentWindow.postMessage({ ...message, path: message.path.slice(1) }, '*');
      return Boolean(child);
    }
    if (message.type === 'fullscreen-apply') return true;
    if (message.type === 'scroll-apply') {
      if ((message.revision || 0) < (scrollRevisions.get(message.selector) || 0)) return true;
      scrollRevisions.set(message.selector, message.revision || 0);
      return applyScroll(message);
    }
    if (message.type === 'apply') { apply(message); return true; }
    if (message.type === 'ui-apply') {
      if (appliedUi.has(message.id)) return true;
      if (document.readyState === 'loading') return false;
      const target = document.querySelector(message.selector);
      if (!target || target.disabled) return false;
      applyingUntil = Date.now() + 1800;
      appliedUi.add(message.id);
      // Discard playback from the previous source, while retaining a newer
      // late-join snapshot that belongs after this selector command.
      if (!pending?.revision || pending.revision <= message.id) pending = null;
      for (const [key, command] of queued) if (command.type === 'apply' && (!command.revision || command.revision <= message.id)) queued.delete(key);
      target.click();
      return true;
    }
    if (message.type === 'unlock') {
      if (pending) apply(pending);
      else { const media = adapter(); if (media?.ready()) Promise.resolve(media.play()).catch(() => send({type:'autoplay-blocked'})); }
      frames().forEach(frame => frame.contentWindow.postMessage(message, '*'));
      return true;
    }
    if (message.type === 'context') {
      if (message.managedFullscreen) enableManagedFullscreen();
      const becameLeader = !leader && message.leader;
      leader = message.leader;
      frames().forEach(frame => frame.contentWindow.postMessage(message, '*'));
      if (becameLeader && !pending) ready();
      return true;
    }
    return false;
  }
  function flush() {
    for (const [key, command] of queued) if (deliver(command)) queued.delete(key);
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.channel !== 'kosmi-sync') return;
    if (event.source === parent) {
      if (!['context', 'apply', 'ui-apply', 'scroll-apply', 'unlock','fullscreen-apply','fullscreen-clear','fullscreen-auto'].includes(message.type)) return;
      if (message.type === 'context' && !message.path?.length) deliver(message);
      else if (!deliver(message)) queued.set(message.type === 'scroll-apply' ? 'scroll:' + JSON.stringify(message.path) + message.selector : message.id || JSON.stringify(message.path) + message.type, message);
      return;
    }
    const index = frames().findIndex(frame => frame.contentWindow === event.source);
    if (index < 0 || !['hello','ready','media','ui','scroll','navigate','autoplay-blocked','fullscreen-request'].includes(message.type)) return;
    if (message.type === 'hello') {
      const child = frames()[index];
      child.contentWindow.postMessage({ channel: 'kosmi-sync', type: 'context', leader, managedFullscreen, path: [] }, '*');
      if (fullscreenTarget === child) child.contentWindow.postMessage({channel:'kosmi-sync',type:'fullscreen-auto',path:[]},'*');
    }
    send({ ...message, path: [index, ...(message.path || [])] });
  });
  function scan() {
    document.querySelectorAll('video,audio').forEach((video, index) => {
      if (registered.has(video)) return;
      registered.add(video);
      for (const type of ['play','pause','seeked','ratechange','volumechange']) video.addEventListener(type, () => publish(type, index));
      video.addEventListener('loadedmetadata', () => ready(index));
      video.addEventListener('canplay', () => { if (pending) apply(pending); });
      if (video.readyState >= 1) ready(index);
    });
    flush();
  }
  const observe = () => { if (document.documentElement) new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true }); };
  if (document.documentElement) observe();
  else window.addEventListener('DOMContentLoaded', observe, { once: true });
  window.addEventListener('DOMContentLoaded', scan);
  window.addEventListener('pageshow', () => send({ type: 'hello', url: originalUrl() }));
  window.kosmiAllowAutoplay = () => !pending?.state.paused;
  window.kosmiMediaReady = () => ready();
  window.kosmiMediaChanged = reason => publish(reason);
  setInterval(() => {
    if (window.kosmiYouTube) {
      const media = adapter();
      if (media?.ready()) {
        const now = Date.now(), time = media.time(), paused = media.paused();
        if (lastSample && now >= applyingUntil) {
          const expected = lastSample.time + (lastSample.paused ? 0 : (now - lastSample.at) / 1000 * media.rate());
          if (Math.abs(time - expected) > 1.5) publish('seeked');
        }
        const sound = {volume:media.volume(),muted:media.muted()};
        if (lastSound && now >= applyingUntil && (Math.abs(sound.volume - lastSound.volume) > 0.005 || sound.muted !== lastSound.muted)) publish('volumechange');
        lastSound = sound;
        lastSample = { time, at: now, paused };
      }
    }
    flush();
  }, 250);
  setInterval(() => publish('tick', activeIndex), 2500);
  send({ type: 'hello', url: originalUrl() });
  scan();
}
module.exports = { mediaBridge };
