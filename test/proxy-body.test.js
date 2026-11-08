const {test}=require('node:test');const assert=require('node:assert/strict');const {inspectBody}=require('../lib/proxy-body');
test('prefix detection handles split HLS headers and preserves all bytes',async()=>{
 const bytes=new TextEncoder().encode('#EXTM3U\n#EXTINF:4,\nsegment\n');let offset=0;
 const inspected=await inspectBody(new ReadableStream({pull(controller){if(offset>=bytes.length)return controller.close();controller.enqueue(bytes.slice(offset,offset+3));offset+=3}}));
 assert.equal(inspected.playlist,true);assert.deepEqual(new Uint8Array(await new Response(inspected.body).arrayBuffer()),bytes);
});
test('binary media remains byte-for-byte identical after inspection',async()=>{
 const bytes=new Uint8Array([0x47,0xff,0x80,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,0]);const inspected=await inspectBody(new Response(bytes).body);assert.equal(inspected.playlist,false);assert.deepEqual(new Uint8Array(await new Response(inspected.body).arrayBuffer()),bytes);
});
