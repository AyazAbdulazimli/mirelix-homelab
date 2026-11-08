// Some film providers serve HLS from extensionless URLs as text/plain or even
// application/octet-stream. Sniff a bounded prefix and preserve every byte.
async function inspectBody(body) {
  if (!body) return {body:null,playlist:false};
  const reader=body.getReader(),chunks=[];let size=0;
  try {
    while(size<16){const next=await reader.read();if(next.done)break;if(next.value?.length){chunks.push(next.value);size+=next.value.length}}
  } catch(error) {await reader.cancel().catch(()=>{});throw error}
  const prefix=new Uint8Array(Math.min(size,512));let offset=0;
  for(const chunk of chunks){const length=Math.min(chunk.length,prefix.length-offset);prefix.set(chunk.subarray(0,length),offset);offset+=length;if(offset===prefix.length)break}
  const playlist=/^\s*#EXTM3U(?:\s|$)/.test(new TextDecoder().decode(prefix));
  const stream=new ReadableStream({
    start(controller){for(const chunk of chunks)controller.enqueue(chunk)},
    async pull(controller){try{const next=await reader.read();if(next.done)controller.close();else controller.enqueue(next.value)}catch(error){controller.error(error)}},
    cancel(reason){return reader.cancel(reason)}
  });
  return {body:stream,playlist};
}
module.exports={inspectBody};
