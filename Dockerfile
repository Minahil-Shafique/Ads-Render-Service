# Puppeteer needs a real Chromium plus its shared libraries. The official
# Puppeteer image already bundles a working Chromium build and every
# dependency it needs, which avoids a long manual apt-get list that tends
# to drift out of date.
FROM ghcr.io/puppeteer/puppeteer:24.15.0

WORKDIR /app

# The base image runs as a non-root 'pptruser' by default, which is fine —
# just make sure the app directory is writable by that user.
COPY --chown=pptruser:pptruser package.json ./
RUN npm install --omit=dev

COPY --chown=pptruser:pptruser server.js template.html Anton.ttf Inter.ttf ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
