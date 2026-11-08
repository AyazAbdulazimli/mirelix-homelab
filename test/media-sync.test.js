const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {mediaBridge} = require('../lib/media-bridge');

function playerFixture() {
  let time=10, status=1, clock=10000, volume=100, muted=false, rate=1;
  const intervals=new Map();
  const messages=[], handlers=new Map();
  const parent={postMessage:message=>messages.push(message)};
  const window={addEventListener:(name,handler)=>handlers.set(name,handler)};
  window.kosmiYouTube={
    getCurrentTime:()=>time,getPlayerState:()=>status,getDuration:()=>100,getPlaybackRate:()=>rate,getVolume:()=>volume,isMuted:()=>muted,
    setVolume:value=>{volume=value},mute:()=>{muted=true},unMute:()=>{muted=false},
    seekTo:target=>{time=target},setPlaybackRate:value=>{rate=value},
    playVideo:()=>{status=1;window.kosmiMediaChanged('play')},
    pauseVideo:()=>{status=2;window.kosmiMediaChanged('pause')}
  };
  const context={window,parent,location:{href:'https://app.example/player.html'},document:{readyState:'complete',documentElement:{},addEventListener(){},querySelectorAll:()=>[],querySelector:()=>({disabled:false,click(){}})},MutationObserver:class{observe(){}},Date:{now:()=>clock},setInterval:(handler,ms)=>intervals.set(ms,handler),setTimeout(){},URL,Promise,WeakSet,Set,Map};
  vm.runInNewContext('('+mediaBridge.toString()+')()',context);
  const receive=data=>handlers.get('message')({source:parent,data:{channel:'kosmi-sync',path:[],...data}});
  return {window,messages,receive,poll:()=>intervals.get(250)(),setSound:(v,m)=>{volume=v;muted=m},getSound:()=>({volume,muted}),setStatus:value=>{status=value},advance:ms=>{clock+=ms},packet:paused=>({type:'apply',reason:'tick',receivedAt:clock,state:{time,paused,rate:1,mediaIndex:0}})};
}

test('a no-op heartbeat does not swallow a follower pause action',()=>{
  const fixture=playerFixture();
  fixture.receive(fixture.packet(false));
  fixture.setStatus(2);
  fixture.window.kosmiMediaChanged('pause');
  const media=fixture.messages.filter(message=>message.type==='media');
  assert.equal(media.length,1);
  assert.equal(media[0].state.paused,true);
});

test('applying and later acknowledging the same remote pause does not echo it',()=>{
  const fixture=playerFixture();
  fixture.receive(fixture.packet(true));
  fixture.advance(1500);
  fixture.window.kosmiMediaChanged('pause');
  assert.equal(fixture.messages.filter(message=>message.type==='media').length,0);
});

test('play during YouTube buffering overrides an earlier queued pause',()=>{
  const fixture=playerFixture();
  fixture.setStatus(3);
  fixture.receive({...fixture.packet(false),reason:'play'});
  assert.equal(fixture.window.kosmiYouTube.getPlayerState(),1);
  assert.equal(fixture.messages.filter(message=>message.type==='media').length,0);
});

function scrollFixture() {
  const messages=[], documentHandlers=new Map(), windowHandlers=new Map(), timers=[];
  const listen=(map,type,handler)=>{if(!map.has(type))map.set(type,[]);map.get(type).push(handler)};
  const dispatch=(map,type,event)=>{for(const handler of map.get(type)||[])handler(event)};
  let clock=10000;
  const root={scrollWidth:800,clientWidth:800,scrollHeight:2000,clientHeight:500,scrollLeft:0,scrollTop:0};
  const list={id:'list',scrollWidth:300,clientWidth:300,scrollHeight:1000,clientHeight:200,scrollLeft:0,scrollTop:0};
  const document={readyState:'complete',documentElement:root,body:{},scrollingElement:root,
    addEventListener:(type,handler)=>listen(documentHandlers,type,handler),querySelectorAll:()=>[],querySelector:selector=>selector==='#list'?list:null};
  for(const element of [root,list])element.scrollTo=({left,top})=>{element.scrollLeft=left;element.scrollTop=top;dispatch(documentHandlers,'scroll',{target:element===root?document:element})};
  const parent={postMessage:message=>messages.push(message)};
  const window={addEventListener:(type,handler)=>listen(windowHandlers,type,handler)};
  const context={window,parent,document,location:{href:'https://site.example/'},URL,CSS:{escape:value=>value},Date:{now:()=>clock},MutationObserver:class{observe(){}},setTimeout:fn=>{timers.push(fn);return timers.length},setInterval(){},WeakSet,Set,Map,Promise};
  vm.runInNewContext('('+mediaBridge.toString()+')()',context);
  const flush=()=>{while(timers.length)timers.shift()()};
  const receive=packet=>dispatch(windowHandlers,'message',{source:parent,data:{channel:'kosmi-sync',path:[],type:'scroll-apply',selector:'',x:0,y:0.5,revision:1,...packet}});
  return {root,list,messages,receive,flush,
    scroll:(element,top)=>{element.scrollTop=top;dispatch(documentHandlers,'scroll',{target:element===root?document:element});flush()},
    queueScroll:(element,top)=>{element.scrollTop=top;dispatch(documentHandlers,'scroll',{target:element===root?document:element})},
    gesture:()=>dispatch(documentHandlers,'wheel',{isTrusted:true}),
    ready:()=>dispatch(windowHandlers,'DOMContentLoaded',{}),advance:ms=>{clock+=ms}};
}

test('scroll sync sends ratios, suppresses remote echoes and permits the next local gesture',()=>{
  const f=scrollFixture();
  f.scroll(f.root,750);
  let sent=f.messages.filter(message=>message.type==='scroll');assert.equal(sent.length,1);assert.equal(sent[0].y,0.5);
  f.receive({y:0.8,revision:2});f.flush();assert.equal(f.root.scrollTop,1200);
  assert.equal(f.messages.filter(message=>message.type==='scroll').length,1);
  f.gesture();f.scroll(f.root,300);
  sent=f.messages.filter(message=>message.type==='scroll');assert.equal(sent.length,2);assert.equal(sent[1].y,0.2);
  f.receive({y:0.1,revision:1});assert.equal(f.root.scrollTop,300);
});

test('late scroll waits for content and keeps root and nested containers separate',()=>{
  const f=scrollFixture();f.list.scrollHeight=f.list.clientHeight;
  f.receive({selector:'#list',y:0.75,revision:3});assert.equal(f.list.scrollTop,0);
  f.receive({selector:'',y:0.4,revision:4});f.flush();assert.equal(f.root.scrollTop,600);
  f.list.scrollHeight=1000;f.ready();f.flush();assert.equal(f.list.scrollTop,600);
  assert.equal(f.messages.filter(message=>message.type==='scroll').length,0);
  f.gesture();f.scroll(f.list,200);
  const message=f.messages.find(message=>message.type==='scroll');assert.equal(message.selector,'#list');assert.equal(message.y,0.25);
});


test('YouTube volume and mute changes synchronize without echoing the applied state',()=>{
  const f=playerFixture();
  f.receive({...f.packet(false),state:{...f.packet(false).state,volume:0.4,muted:true}});
  assert.deepEqual(f.getSound(),{volume:40,muted:true});
  f.poll();f.advance(1600);f.poll();
  assert.equal(f.messages.filter(message=>message.type==='media').length,0);
  f.setSound(75,false);f.poll();
  const sent=f.messages.find(message=>message.type==='media');
  assert.equal(sent.reason,'volumechange');assert.equal(sent.state.volume,0.75);assert.equal(sent.state.muted,false);
});

test('one scroll batch preserves changes in both the page and its inner list',()=>{
  const f=scrollFixture();f.queueScroll(f.root,750);f.queueScroll(f.list,400);f.flush();
  const sent=f.messages.filter(message=>message.type==='scroll');
  assert.equal(sent.length,2);assert.equal(sent[0].selector,'');assert.equal(sent[1].selector,'#list');
  assert.equal(sent[0].y,0.5);assert.equal(sent[1].y,0.5);
});


test('a source change clears old playback and retains newer late-join playback',()=>{
  const live=playerFixture();live.receive({...live.packet(true),revision:2});assert.equal(live.window.kosmiAllowAutoplay(),false);
  live.receive({type:'ui-apply',id:3,selector:'#source',path:[]});assert.equal(live.window.kosmiAllowAutoplay(),true);
  const late=playerFixture();late.receive({...late.packet(true),revision:5});
  late.receive({type:'ui-apply',id:3,selector:'#source',path:[]});assert.equal(late.window.kosmiAllowAutoplay(),false);
});
