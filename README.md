# Big Brother Comics card inventory

Staff-shared Magic card inventory with Card Kingdom pricing.

- `site/` – the app (GitHub Pages). `config.js` holds the inventory sheet's web address.
- `apps-script/Code.gs` – the shared backend, run by Google Apps Script on the inventory Google Sheet.
- `scripts/build-prices.mjs` – downloads the Card Kingdom price list and slims it to `prices.json`.
- `.github/workflows/publish.yml` – publishes the app with fresh prices every night at about 3 AM Pacific, and whenever the files change.

## One-time setup

### 1. Google Sheet + backend (signed in as bigbrothercomics@gmail.com)
1. Create a new Google Sheet named **Card Inventory**.
2. Extensions → Apps Script. Delete the sample code, paste in all of `apps-script/Code.gs`, and save.
3. Deploy → New deployment → gear icon → **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Click Deploy, then Authorize access. Google shows "Google hasn't verified this app" because it's your own script: Advanced → Go to (project name) → Allow.
5. Copy the **Web app URL** (ends in `/exec`).

The Inventory and Log tabs are created automatically the first time the app connects. Don't delete or reorder rows in **Log**, because the app uses row order to sync changes.

### 2. GitHub (signed in as bigbrothercomics)
1. New repository named **card-inventory**, Public, then "uploading an existing file" and drag in everything from this folder, keeping the folders. (`.github` is a hidden folder, so turn on hidden files in File Explorer, or create `.github/workflows/publish.yml` with "Add file → Create new file" and paste the contents.)
2. Edit `site/config.js` and paste the web app URL between the quotes. Commit.
3. Settings → Pages → Source: **GitHub Actions**.
4. Actions tab → **Publish** → Run workflow. After about a minute the app is at
   **https://bigbrothercomics.github.io/card-inventory/**

## Later: requiring a store code
In Apps Script: Project Settings → Script Properties → add `ACCESS_CODE` with any code. The app will then ask each browser for it once.

## Updating the backend
After changing `Code.gs`: Deploy → Manage deployments → pencil → Version: New version → Deploy. The URL stays the same.
