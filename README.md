# Sudeys Feysel — Portfolio

A portfolio site with its own backend: a Node.js REST API, a SQLite database, and an admin dashboard.
No npm packages needed (uses only Node built-ins).

## What the backend does

| Feature | How |
|---|---|
| Contact form | Messages are saved in the database (rate limited, spam honeypot, validated) |
| Projects | Loaded from the database, so you edit them in the admin page, not in code |
| Admin dashboard (`/admin`) | Password login. Read/delete messages, add/edit/hide projects, see visit stats |
| Visit counter | One count per browser session, shown in the admin overview |

If the API is unreachable (for example on plain GitHub Pages), the site still works: it shows built-in project cards and the contact form opens the visitor's email app.

## Run it on your computer

Requires **Node.js 22.13 or newer** (`node --version`).

```bash
# Windows PowerShell
$env:ADMIN_PASSWORD="choose-a-strong-password"; node server.js

# macOS / Linux
ADMIN_PASSWORD="choose-a-strong-password" node server.js
```

- Site: http://localhost:3000
- Admin: http://localhost:3000/admin
- Database file: `data/portfolio.db` (created automatically, ignored by git)

If you don't set `ADMIN_PASSWORD`, a temporary one is printed in the terminal on each start.

## Environment variables

| Name | Purpose | Default |
|---|---|---|
| `ADMIN_PASSWORD` | Admin login password. **Set this.** | random, printed at start |
| `PORT` | Port to listen on | `3000` |
| `DB_PATH` | Where the SQLite file lives | `./data/portfolio.db` |
| `ALLOWED_ORIGINS` | Sites allowed to call the API from a browser (comma separated) | none |
| `TOKEN_SECRET` | Signs admin sessions | derived from the password |

## Put it online

**GitHub Pages cannot run a backend.** It only serves static files. To get the database features live you need a host that runs Node.js. Two setups:

**A. Everything on one Node host (simplest).** Push this folder to GitHub, create a web service on a host such as Render, Railway or Fly.io, set start command `node server.js`, and set `ADMIN_PASSWORD`. The host serves the site and the API together, so nothing else needs configuring. A `Dockerfile` is included.

**B. Keep the site on GitHub Pages, API elsewhere.**
1. Deploy this repo to a Node host as in A and set `ALLOWED_ORIGINS=https://sudeysdev.github.io`.
2. In `public/config.js` set `window.PORTFOLIO_API = 'https://your-api-host'`.
3. Push the contents of `public/` to your `Sudeysdev.github.io` repo.

**Important: keep the database on a persistent disk.** SQLite is a single file. On hosts or plans without persistent storage (many free tiers), the file is wiped on every redeploy or restart and you would lose messages and project edits. Mount a volume and point `DB_PATH` at it (the Dockerfile uses `/data`). Some hosts ask for a payment card even on free plans, so check before choosing one.

## Optional files

- `public/cv.pdf` — add your CV and the "Download CV" button appears automatically.
- `public/photo.jpg` — your profile photo (already included).

## Project layout

```
server.js        API, auth, static file server
public/          the website (index.html, admin.html, config.js, photo.jpg)
Dockerfile       container deploy
```
