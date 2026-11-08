(async () => {
  const video = document.getElementById('mediaPlayer');
  let source;
  const fail = detail => {
    document.getElementById('mediaError').hidden = false;
    document.getElementById('mediaErrorMessage').textContent = detail;
    parent.postMessage({type:'KOSMI_FRAME_ERROR',code:'media',requestedUrl:source,detail}, '*');
  };
  const play = () => {
    if (window.kosmiAllowAutoplay?.() === false) return;
    video.play().catch(error => { if (error.name === 'NotAllowedError') parent.postMessage({channel:'kosmi-sync',type:'autoplay-blocked',path:[]}, '*'); });
  };
  // App-owned controls expose the same user gestures in Chrome and Firefox.
  video.controls = false;
  const toggle = document.getElementById('mediaToggle'), seek = document.getElementById('mediaSeek');
  const volume = document.getElementById('mediaVolume'), mute = document.getElementById('mediaMute'), rate = document.getElementById('mediaRate');
  const time = seconds => { const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0)); return String(Math.floor(total / 60)).padStart(2,'0') + ':' + String(total % 60).padStart(2,'0'); };
  const update = () => {
    toggle.disabled = video.readyState < 1;
    toggle.textContent = video.paused ? '▶ Başlat' : '⏸ Dayandır';
    const end = Number.isFinite(video.duration) ? video.duration : video.seekable.length ? video.seekable.end(video.seekable.length-1) : 0;
    seek.max = String(end); seek.value = String(video.currentTime);
    document.getElementById('mediaClock').textContent = time(video.currentTime) + ' / ' + time(end);
    volume.value = String(video.volume); mute.textContent = video.muted ? '🔇' : '🔊'; mute.setAttribute('aria-label',video.muted ? 'Səsi aç' : 'Səsi bağla');
    if (![...rate.options].some(option=>Number(option.value) === video.playbackRate)) rate.add(new Option(String(video.playbackRate),String(video.playbackRate)));
    rate.value = String(video.playbackRate);
  };
  toggle.addEventListener('click', () => video.paused ? play() : video.pause());
  video.addEventListener('click', () => video.paused ? play() : video.pause());
  seek.addEventListener('input', () => { video.currentTime = Number(seek.value); });
  volume.addEventListener('input', () => { video.volume = Number(volume.value); });
  mute.addEventListener('click', () => { video.muted = !video.muted; });
  rate.addEventListener('change', () => { video.playbackRate = Number(rate.value); });
  document.getElementById('mediaFullscreen').addEventListener('click', () => {
    const shell = document.getElementById('mediaShell');
    if (document.fullscreenElement) document.exitFullscreen?.().catch(()=>{});
    else if (shell.requestFullscreen) shell.requestFullscreen().catch(()=>{});
    else video.webkitEnterFullscreen?.();
  });
  for (const event of ['play','pause','timeupdate','loadedmetadata','durationchange','volumechange','ratechange']) video.addEventListener(event, update);
  try {
    const parameters = new URLSearchParams(location.search);
    const url = new URL(parameters.get('url'));
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Video ünvanı düzgün deyil.');
    source = url.href;
    const response = await fetch('/api/runtime', {cache:'no-store'});
    if (!response.ok) throw new Error('Media bağlantısı hazır deyil. Səhifəni yeniləyin.');
    const runtime = await response.json();
    const proxy = new URL(runtime.proxyOrigin);
    if (!['http:','https:'].includes(proxy.protocol) || proxy.origin === location.origin) throw new Error('Media proksisi ayrıca ünvanda olmalıdır.');
    const mediaUrl = new URL('/proxy', proxy);
    mediaUrl.searchParams.set('url', source);
    let referer=source;
    try{const requested=new URL(parameters.get('ref'));if(['http:','https:'].includes(requested.protocol))referer=requested.href}catch{}
    mediaUrl.searchParams.set('ref', referer);
    mediaUrl.searchParams.set('media', '1');
    video.addEventListener('error', () => fail('Media yüklənmədi. Linkin işləyən video və ya audio mənbəyi olduğuna əmin olun.'));
    if (parameters.get('format') === 'hls' || /\.m3u8$/i.test(url.pathname)) {
      if (window.Hls?.isSupported()) {
        const hls = new Hls({enableWorker:true});
        hls.loadSource(mediaUrl.href);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, play);
        hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) fail('Video axını açıla bilmədi. Mənbə əlçatmazdır və ya brauzer bu yayımı dəstəkləmir.'); });
        window.addEventListener('pagehide', () => hls.destroy(), {once:true});
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = mediaUrl.href;
      else fail('Bu brauzer HLS video axınını dəstəkləmir.');
    } else video.src = mediaUrl.href;
    video.addEventListener('loadedmetadata', play, {once:true});
  } catch(error) { fail(error.message || 'Media açıla bilmədi.'); }
})();
