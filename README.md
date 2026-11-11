# ChessTG Frontend

Responsive chess web app and Telegram Mini App.

## Run locally

Serve this directory with any static server, for example:

```bash
python -m http.server 5500
```

Open http://localhost:5500. The API URL is configured in `config.js`. The app uses Telegram Web Apps authentication inside Telegram and a persistent guest session in a normal browser.

## Deployment

Render Static Site:
- Repository: `klein52345/Chess-in-telegram`
- Branch: `main`
- Build command: `echo "Static frontend — no build step"`
- Publish directory: `.`

Do not put API secrets in this repository. Only the public backend URL belongs in config.js.
