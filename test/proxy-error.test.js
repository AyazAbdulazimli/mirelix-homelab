const {test}=require('node:test');
const assert=require('node:assert/strict');
const {load}=require('cheerio');
const {proxyFailure}=require('../lib/proxy-error');
const target='https://blocked.example/watch';
test('blocked and missing upstream pages expose a truthful error, exact URL and retry action',()=>{
  for(const [status,code] of [[403,'blocked'],[404,'missing'],[410,'missing']]){
    const result=proxyFailure(Object.assign(new Error('HTTP '+status),{upstreamStatus:status}),target,target);
    assert.equal(result.packet.code,code);assert.equal(result.packet.status,status);assert.equal(result.packet.requestedUrl,target);
    const $=load(result.html);assert.equal($('a').attr('href'),target);assert.equal($('a').attr('rel'),'noopener noreferrer');assert.match($('button').text(),/Yenidən yoxla/);
    assert.doesNotThrow(()=>new Function($('script').text()));
  }
});
test('error details and script payload remain escaped and non-HTTP links are omitted',()=>{
  const result=proxyFailure(new Error('</script><img src=x onerror=bad()>'),'javascript:alert(1)');
  assert.equal(load(result.html)('img,a').length,0);assert.match(result.html,/&lt;\/script&gt;/);assert.doesNotThrow(()=>new Function(load(result.html)('script').text()));
});
