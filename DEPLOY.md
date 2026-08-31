# Deploying the render service on the VPS

## Before you deploy — two things I genuinely can't confirm for you

1. **The exact Traefik network name and label convention this panel
   uses.** I don't have access to your VPS or this panel's
   documentation, so `docker-compose.yml` here has a *plausible*
   Traefik label setup, not a verified one. Before deploying, open
   the `n8n` app's compose config in this same panel (there should be
   a way to view/edit it) and copy its exact network name and label
   pattern — swap that into this file rather than trusting mine
   verbatim.

2. **The subdomain.** I guessed `render.scaleyourresults.cloud` to
   match the pattern of `n8n.scaleyourresults.cloud`. Confirm DNS for
   that subdomain actually points at this VPS before relying on it —
   if it doesn't, you'll need to add an A/CNAME record wherever your
   domain is managed, or pick a subdomain that's already wired up.

## Files here
- `Dockerfile` — builds on Puppeteer's official image, which ships a
  working Chromium so you don't need to hand-install browser
  dependencies (the thing that failed in my own sandbox earlier)
- `docker-compose.yml` — the standalone service definition, kept
  entirely separate from `n8n`'s compose per the spec's explicit rule
- `server.js`, `template.html`, `package.json`, fonts — same
  compositor as before, plus one addition: a simple API key check

## New: API key protection
Once this has a public HTTPS URL, anyone who finds it can call
`/render` and burn your compute. Added a minimal guard:
- Set an environment variable `RENDER_API_KEY` on the container (the
  compose file already wires this through) to any random string
- In n8n's `Call Renderer` node, add a header: `x-api-key: <that same
  string>`
- If `RENDER_API_KEY` is left unset, the check is skipped entirely —
  fine for local testing, not fine once this is public

## Steps
1. In the panel, create a new **Compose** application (same type as
   `baserow`/`documenso`, separate entry from `n8n`)
2. Upload/paste this folder's contents (`Dockerfile`,
   `docker-compose.yml`, `server.js`, `template.html`, `package.json`,
   `Anton.ttf`, `Inter.ttf`)
3. Fix the Traefik labels and network name per the caveat above
4. Set the `RENDER_API_KEY` environment variable in the panel's env
   settings for this app (don't hard-code it into the compose file
   itself if the panel supports a secrets/env UI — check its
   "Documentation" link for how it wants secrets handled)
5. Deploy, then hit `https://render.scaleyourresults.cloud/health` —
   should return `{"ok":true}`
6. Update the `Call Renderer` node in the n8n workflow: swap the URL
   for the real one, add the `x-api-key` header

## Verify before wiring into the real workflow
Test with `curl` against the deployed URL first (same body as the
local test earlier), confirm you get a real PNG back, *then* update
the n8n node. Don't debug both the deployment and the n8n wiring at
the same time — you won't know which layer the problem is in.
