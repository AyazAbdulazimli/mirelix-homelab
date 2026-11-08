const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function proxyFailure(error, target, requestedTarget) {
  const status = Number(error.upstreamStatus) || null;
  const code = status === 401 || status === 403 ? 'blocked' : status === 404 || status === 410 ? 'missing' : ['AbortError','TimeoutError'].includes(error.name) ? 'timeout' : 'unavailable';
  const detail = code === 'blocked' ? 'Sayt server üzərindən açılışa icazə vermir. Brauzerdə yoxlama və ya giriş tələb edə bilər.' : code === 'missing' ? `Sayt bu ünvan üçün HTTP ${status} qaytarır. Film səhifəsi hazırda serverdən açılmır.` : code === 'timeout' ? 'Sayt vaxtında cavab vermədi. Bir az sonra yenidən sınayın.' : error.message || 'Sayta qoşulmaq mümkün olmadı.';
  let url;
  try { const parsed = new URL(target); if (['http:','https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed.href; } catch {}
  const packet = {type:'KOSMI_FRAME_ERROR',url,requestedUrl:requestedTarget,code,status,detail};
  const html = `<!doctype html><html lang="az"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sayt açılmadı</title><style>body{margin:0;background:#10131d;color:#eee;font:16px/1.7 system-ui;display:grid;place-items:center;min-height:100vh}main{padding:24px;max-width:500px}p{color:#bac3d6}a{color:#b8aeff}button{font:inherit;padding:8px 16px;border:1px solid #626779;border-radius:10px;background:#252a3a;color:#fff;cursor:pointer}</style><main><h2>Sayt açıla bilmədi</h2><p>${escape(detail)}</p>${url ? `<p><a href="${escape(url)}" target="_blank" rel="noopener noreferrer">Saytı ayrıca tabda aç</a></p><p>Ayrıca tabda film oynayırsa, otağın Ekran bölməsindən həmin tabı paylaşaraq birlikdə baxa bilərsiniz.</p>` : ''}<button onclick="location.reload()">Yenidən yoxla</button></main><script>parent.postMessage(${JSON.stringify(packet).replace(/</g,'\\u003c')},'*')</script></html>`;
  return {packet,html};
}
module.exports = {proxyFailure};
