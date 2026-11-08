// Shared validation for the Node and Cloudflare signaling servers.
function normalizeMediaState(state) {
  if (!state || !Number.isFinite(state.time) || state.time < 0 || state.time > 864000 || typeof state.paused !== 'boolean' || !Number.isFinite(state.rate) || state.rate < 0.25 || state.rate > 4 || !Number.isInteger(state.mediaIndex) || state.mediaIndex < 0 || state.mediaIndex > 31) return null;
  if (state.volume !== undefined && (!Number.isFinite(state.volume) || state.volume < 0 || state.volume > 1)) return null;
  if (state.muted !== undefined && typeof state.muted !== 'boolean') return null;
  return { time:state.time, paused:state.paused, rate:state.rate, mediaIndex:state.mediaIndex, ...(state.volume !== undefined ? {volume:state.volume} : {}), ...(state.muted !== undefined ? {muted:state.muted} : {}) };
}
const mediaReasons = ['play','pause','seeked','ratechange','volumechange','tick','initial'];
module.exports = {normalizeMediaState,mediaReasons};
