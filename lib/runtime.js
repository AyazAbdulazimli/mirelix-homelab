function runtimeConfig(env = process.env) {
  const publicOrigin = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN) : null;
  if (publicOrigin && (publicOrigin.protocol !== 'https:' || publicOrigin.username || publicOrigin.password || publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash)) {
    throw new Error('PUBLIC_ORIGIN tam HTTPS origin olmalıdır.');
  }
  const proxyOrigin = env.PROXY_ORIGIN ? new URL(env.PROXY_ORIGIN) : null;
  if (proxyOrigin && (!['http:', 'https:'].includes(proxyOrigin.protocol) || proxyOrigin.username || proxyOrigin.password || proxyOrigin.pathname !== '/' || proxyOrigin.search || proxyOrigin.hash)) {
    throw new Error('PROXY_ORIGIN tam HTTP/HTTPS origin olmalıdır.');
  }
  const iceServers = JSON.parse(env.ICE_SERVERS || '[{"urls":"stun:stun.l.google.com:19302"}]');
  if (!Array.isArray(iceServers) || iceServers.some(server => {
    if (!server || typeof server !== 'object') return true;
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return !urls.length || urls.some(url => typeof url !== 'string' || !/^(stun|stuns|turn|turns):\S+$/.test(url));
  })) throw new Error('ICE_SERVERS STUN/TURN serverlərinin JSON siyahısı olmalıdır.');
  const publicPort = env.PROXY_PUBLIC_PORT ? Number(env.PROXY_PUBLIC_PORT) : null;
  if (publicPort !== null && (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535)) throw new Error('PROXY_PUBLIC_PORT 1–65535 aralığında olmalıdır.');
  return { publicOrigin: publicOrigin?.origin, proxyOrigin: proxyOrigin?.origin, publicPort, iceServers };
}

module.exports = { runtimeConfig };
