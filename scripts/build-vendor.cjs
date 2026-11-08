const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
fs.mkdirSync(path.join(root,'public/vendor'),{recursive:true});
fs.copyFileSync(path.join(root,'node_modules/hls.js/dist/hls.min.js'),path.join(root,'public/vendor/hls.min.js'));
fs.copyFileSync(path.join(root,'node_modules/hls.js/LICENSE'),path.join(root,'public/vendor/hls.LICENSE'));
