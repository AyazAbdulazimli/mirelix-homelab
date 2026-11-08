// Fullscreen belongs to this room, never to an isolated movie iframe.
(() => {
  let active = false;
  const post = packet => document.getElementById('browserIframe')?.contentWindow?.postMessage({channel:'kosmi-sync',path:[],...packet},'*');
  const exitButton = document.getElementById('btnExitRoomFullscreen');
  async function enter(path = null) {
    const wasActive = active;
    active = true;
    document.body.classList.add('room-expanded');
    exitButton.hidden = false;
    window.dispatchEvent(new Event('room-fullscreen-enter'));
    if (path) post({type:'fullscreen-apply',path});
    else if (!wasActive && document.getElementById('viewBrowser').classList.contains('active')) post({type:'fullscreen-auto'});
    // Phones retain the stacked film/chat layout and their browser chrome.
    if (!wasActive && !matchMedia('(max-width: 850px)').matches && !document.fullscreenElement) {
      try {
        await document.documentElement.requestFullscreen?.();
        if (!active && document.fullscreenElement) await document.exitFullscreen();
      } catch { /* The expanded room still fills the available browser window. */ }
    }
  }
  function exit() {
    if (!active) return;
    active = false;
    document.body.classList.remove('room-expanded');
    exitButton.hidden = true;
    post({type:'fullscreen-clear'});
    if (document.fullscreenElement) document.exitFullscreen?.().catch(()=>{});
  }
  window.RoomFullscreen = {enter,exit,toggle:()=>active?exit():enter(),get active(){return active}};
  exitButton.addEventListener('click',exit);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&active)exit()});
  document.addEventListener('fullscreenchange',()=>{if(active&&!document.fullscreenElement)exit()});
})();
