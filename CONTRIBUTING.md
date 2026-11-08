# Contributing

Keep changes focused and include the behavior being fixed, how to reproduce it, and relevant validation.

## Local setup

```sh
npm ci
npm run build:vendor
npm test
PROXY_PORT=3031 npm start
```

Use Node.js 22.12 or later. See the README for Docker, HTTPS, browser integration tests, and media fixtures.

## Changes to check

- Keep Azerbaijani, English, and Turkish UI text in sync in `public/js/translations.js`.
- Preserve names and chat messages exactly; never translate user content.
- Keep proxied third-party content isolated from the application origin and retain private-IP validation.
- For call changes, check multiple peers, late media permission, simultaneous screen shares, reconnect, and departures.
- For player changes, check source changes, late joins, pause/seek, and both Chromium and Firefox where practical.
- Do not commit `.env`, credentials, private tailnet addresses, browser profiles, `node_modules`, or generated test artifacts.

## Reporting a bug

Include the app version or commit, deployment method, browser/OS versions, number of participants, and reproduction steps. Remove credentials, signed media tokens, and private addresses from logs and screenshots.
