# Deploy the backend (free, step by step)

Your site stays on GitHub Pages (fast, always on). The API + database run on a free Node.js host and the site talks to it.
These steps use **Render**, whose free web service does not need a paid plan. Check at sign-up whether it asks for a payment card; if it does, tell me and I'll adapt the steps for another host.

## 1. Put the backend in its own GitHub repo
1. Create a new public repo, e.g. `portfolio-api`.
2. Unzip `sudeys-portfolio.zip` and upload **everything inside** the `sudeys-portfolio` folder to the repo's top level (`server.js`, `package.json`, `render.yaml`, `Dockerfile`, the `public` and `cv-source` folders).
   `server.js` and `package.json` must be at the top level of the repo.

## 2. Create the service on Render
1. Sign up at render.com with your GitHub account.
2. **New → Blueprint**, pick the `portfolio-api` repo, and apply. (Or **New → Web Service** with: build command `npm install`, start command `node server.js`, instance type Free.)
3. In the service's **Environment** tab, check:
   - `ADMIN_PASSWORD` is set (Render generated one; copy it, or set your own).
   - `ALLOWED_ORIGINS` is `https://sudeysdev.github.io`.
4. When the deploy is live, Render shows the service URL, like `https://sudeys-portfolio-api.onrender.com`. Open `<that url>/api/health`; it should show `{"ok":true}`. Open `<that url>/admin` to log in.

## 3. Connect your GitHub Pages site
1. In your `Sudeysdev.github.io` repo, edit `config.js` so it says:
   ```js
   window.PORTFOLIO_API = 'https://YOUR-SERVICE.onrender.com';
   ```
   (use your real URL, no trailing slash)
2. Upload the new `index.html`, `config.js` and `cv.pdf` to the Pages repo and commit.
3. Open your site and send yourself a test message. Then log in at `<api url>/admin` to read it.

## 4. (Recommended) Get every message on Telegram
This protects you from the free plan's database resets. Takes about 3 minutes.
1. In Telegram, open **@BotFather**, send `/newbot`, choose a name and a username. It replies with a **token** (looks like `123456:ABC-...`). Keep it secret.
2. Open your new bot in Telegram and press **Start**, then send it any message like "hi".
3. Open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in your browser. Find `"chat":{"id":NUMBER` and copy that number.
4. In Render, open your service, go to **Environment**, and add:
   - `TELEGRAM_BOT_TOKEN` = your token
   - `TELEGRAM_CHAT_ID` = the number
5. Save; Render restarts the service. Send a test message from your site. It should arrive on Telegram within seconds.

## What the free plan means in practice
- **It sleeps after ~15 minutes without visits** and takes up to a minute to wake. The site loads instantly from GitHub Pages anyway, and the contact form waits for the server before falling back to email.
- **The free plan has no permanent disk.** The SQLite database resets when the service restarts or redeploys. Messages and projects you added in the admin page can be lost. Read and copy messages soon after they arrive. The default projects are re-created automatically.
- If you later want permanent storage, add a paid persistent disk on the host and set `DB_PATH` to it.
