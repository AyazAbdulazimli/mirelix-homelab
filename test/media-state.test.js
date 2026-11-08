const {test}=require('node:test');
const assert=require('node:assert/strict');
const {normalizeMediaState}=require('../lib/media-state');
const state={time:42,paused:true,rate:1.5,mediaIndex:0,volume:0.6,muted:true};
test('media validation accepts bounded sound settings and ignores unrelated fields',()=>{
  assert.deepEqual(normalizeMediaState({...state,password:'never copied'}),state);
  for(const invalid of [{volume:2},{volume:-1},{volume:NaN},{muted:'true'},{time:Infinity},{mediaIndex:99}])assert.equal(normalizeMediaState({...state,...invalid}),null);
  const {volume,muted,...legacy}=state;assert.deepEqual(normalizeMediaState(legacy),legacy);
});
