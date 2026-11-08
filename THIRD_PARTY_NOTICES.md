# Third-party notices

The application license does not replace the licenses of its dependencies.

- **HLS.js** — Apache-2.0. The bundled browser distribution is in `public/vendor/hls.min.js`; its upstream copyright and license notice is preserved in `public/vendor/hls.LICENSE`. The Docker build copies the distribution from the locked npm package.
- **Express**, **Socket.IO**, **Cheerio**, **ipaddr.js**, and transitive npm dependencies retain their upstream license notices inside the installed packages. Exact package versions are recorded in `package-lock.json`.
- **Playwright** is a development-only dependency. Its browsers are installed separately and are not included in the application image.
- The Node.js base image and optional Caddy image retain their respective upstream licenses.

Google Fonts and external media/websites are fetched from their providers at runtime. Website names and links do not imply affiliation or transfer any rights to third-party content.
