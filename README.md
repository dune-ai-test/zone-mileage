# Zone Mileage

A single-page mileage and fuel ledger with two views of the same per-vehicle data:

- **Receipt** — a paper-tape style fill-up form and printable receipt.
- **Table** — the default view: one row per fill-up, inline cell editing, stats, and totals.

Both views share the same ledger. Each vehicle keeps its own odometer continuity, receipt number, and entries. Data lives in `localStorage` first and can optionally sync to **Cloudflare D1** through a Pages Function.

Built using **DeepSeek V4.1 Flash in OpenCode**. No framework, no bundler, no build step.

**Version:** `0.0.6` (shown in the page footer). Bump the footer `#appVersion` on every commit/push.

## Features

- Table view by default, with hash routing (`#table`, `#receipt`) and a receipt redirect fallback.
- Dates can be typed as `dd/mm/yy` (or `dd/mm/yyyy`), with the calendar picker still available from the calendar button.
- One-cell-at-a-time editing: click/tap to edit, `Enter` or blur saves, `Escape` cancels.
- Always-open blank add row plus a separate **Older entry** row for backdated fill-ups.
- Start-only fill-ups: enter today's odometer at the pump and leave End km blank. The next fill-up's Start km closes the previous entry automatically.
- Calculated distance, mileage (km/L), and cost per km; still-open entries show **Pending** and a muted `—` until the next fill-up closes them.
- Mileage uses the **previous fill-up's litres and amount** for each row, matching the fuel that was actually burned over that distance. The first row shows its distance but no mileage or cost/km because there is no previous fill to attribute.
- JSON export/import with confirmation and Undo. Import replaces the ledger and syncs the replacement to D1.
- Mobile card layouts, 16px inputs, larger touch targets, and editors scrolled into view.
- Optional D1 sync with a live status pill in the masthead (`Checking`, `Saving`, `D1 synced`, `D1 offline`, `Local only`).

## Project files

| File | Purpose |
| --- | --- |
| `index.html` | The entire app: receipt view, table view, styles, import/export, routing. |
| `cloud.js` | localStorage ⇄ D1 sync layer. Loads after the views and stays out of the way when no API exists. |
| `functions/api/ledger.js` | Cloudflare Pages Function: `GET`/`PUT /api/ledger`, backed by D1 binding `DB`. |
| `schema.sql` | The `ledger` table. The Function creates it automatically; the file is for the D1 console. |
| `table.html`, `table/index.html` | Small redirects to `./index.html#table` for old links. |
| `.gitignore` | Excludes local tooling, secrets, and the unrelated `watchlist.html` / `images.jpg`. |

## Data model

The ledger is one JSON object in `localStorage`:

```json
{
  "version": 1,
  "vehicles": [{ "id": "v…", "name": "…", "reg": "…", "receiptNo": "…", "issuedAt": "…" }],
  "entries": [{ "id": "e…", "vehicleId": "v…", "date": "2026-10-29", "start": 0, "end": null, "price": 0, "amount": 0, "fuel": "Petrol", "createdAt": 0 }],
  "settings": { "lastVehicleId": "v…" }
}
```

`end` is nullable. `null` means the fill-up is waiting for the next entry's `start` reading (its **Pending** state). A number is an explicit closing reading that overrides chaining. In exported JSON, pending entries keep `"end": null`. In D1 this object is stored as a single row in `ledger` (`id = 'default'`), along with a monotonically increasing `version` used for pull decisions.

## How a fill-up closes

1. At the pump, enter the odometer you see now as **Start km**. Leave **End km** blank and save.
2. That entry stays **Pending**. Its distance, Km/L, and cost/km show `—`; its fuel and amount still count in the totals.
3. At the next refill, the new entry's **Start km** becomes the previous entry's end. The previous row fills in its distance and mileage automatically.
4. To override the chain, type an explicit **End km** on the receipt form or in the table's End cell. Clearing that End cell returns the row to automatic chaining.

Entries are ordered per vehicle by date, then start KM, then creation time. The newest entry therefore stays Pending until there is a later reading, and backfilling an **Older entry** closes the right gap in the chain.

## Run locally

Any static server works. Without Pages Functions the app runs in **Local only** mode.

```powershell
npx serve .
# or
python -m http.server 8080
```

Open the printed URL. To exercise D1 locally you would need Wrangler and a local D1 setup, but the deployed site is the intended target.

## Deploy to Cloudflare Pages and link D1

The D1 binding is configured **only in the Cloudflare dashboard** — this repo intentionally has no `wrangler.toml`.

### 1. Create the GitHub repository

The repo is already pushed as `zone-mileage`. If you recreate it:

```powershell
gh repo create zone-mileage --public `
  --description "Mileage and fuel ledger with receipt + table views, JSON backup, and Cloudflare D1 sync. Built with DeepSeek V4.1 Flash in OpenCode."
```

### 2. Connect the repository to Pages

1. Open the [Cloudflare dashboard](https://dash.cloudflare.com/) → **Workers & Pages**.
2. Choose **Create application** → **Pages** → **Connect to Git**.
3. Authorize GitHub if asked, then pick the **`zone-mileage`** repository.
4. Select the **`main`** branch.
5. Build settings:
   - **Framework preset:** `None`
   - **Build command:** `exit 0` (the site has no build step)
   - **Build output directory:** `.` (the repo root, where `index.html` lives)
6. Click **Save and Deploy**.

The site is live at `https://<project-name>.pages.dev`. The masthead pill will say **Local only** until D1 is linked — that is expected.

### 3. Create the D1 database

1. In the dashboard go to **Storage & Databases** → **D1 SQL Database** (older dashboards list D1 under **Workers & Pages**).
2. Click **Create database**.
3. Name it **`zone-mileage`** and create it.

The table itself is created by the Function on its first request, so you do not have to run SQL now. To pre-create it manually, open the database → **Console**, paste `schema.sql`, and run it.

### 4. Bind the database to the Pages project

1. Open **Workers & Pages** → your Pages project → **Settings**.
2. Go to **Functions** → **D1 database bindings** (some accounts show this under **Settings** → **Bindings**).
3. Click **Add binding**:
   - **Variable name:** `DB`
   - **D1 database:** `zone-mileage`
4. Save the binding.

The variable name must be exactly `DB`; `functions/api/ledger.js` reads `env.DB`.

> Bindings apply to the **next deployment**. After saving, open **Deployments** → the latest deployment → **Retry deployment** (or push any commit). Until then the API returns a binding error.

### 5. Verify the API

Open:

```text
https://<project-name>.pages.dev/api/ledger
```

- A healthy, still-empty database returns HTTP **404** with JSON like `{"app":"zone-mileage","empty":true}`. That is the expected “no ledger yet” response. (Once the site has opened and uploaded its first ledger, the same URL returns **200** with the stored data instead.)
- A `503` explaining that the `DB` binding is missing means the binding was not saved or the project has not been redeployed since adding it.
- If you get an HTML 404 page instead, `/api/ledger` is not deployed — check that the `functions/` folder is in the repository root.

### 6. Sync the first ledger

1. Open the site and wait for the pill to say **D1 ready** or **D1 synced**.
2. Existing data in that browser is uploaded automatically on the first visit.
3. Add or edit a fill-up. The pill shows **Saving**, then **D1 synced**.
4. Reload the page: the ledger comes back from D1 and the local cache.
5. Optional check in **D1** → `zone-mileage` → **Console**:

```sql
SELECT id, version, updated_at, length(payload) AS bytes FROM ledger;
```

### 7. Optional: custom domain

Pages project → **Custom domains** → **Set up a domain**, then add the DNS record Cloudflare shows.

### 8. Optional: restrict access

`/api/ledger` has no login. Anyone who can open the site can read and overwrite the ledger. That is usually fine for a personal `.pages.dev` URL, but if the deployment is public:

- Put **Cloudflare Access** (Zero Trust) in front of the Pages hostname, or
- Serve the app on a private/custom domain that you do not share.

## How sync behaves

- Writes are debounced by ~0.5s, then PUT to `/api/ledger`. D1 is the shared copy; `localStorage` remains the offline cache.
- The browser checks for newer D1 versions on page load, on focus/wake, and every 20 seconds. It never pulls while you are editing a cell.
- If a save fails, the pill shows **D1 offline** and the local change is marked dirty. It is retried every 15 seconds and again on the next page load, so an offline edit is not silently replaced by an older D1 copy.
- A blank D1 ledger never overwrites a populated local ledger; the local copy is uploaded instead. This makes linking D1 after using the site safe.
- Across devices the last successful write wins. Take an **Export** before importing a backup or making a large batch of changes.
- The first visit to a brand-new Pages project uploads the browser's existing ledger. On a second browser, an existing D1 ledger takes precedence over that browser's local copy — export first if both copies matter.
- If the first check fails because the network is down, the pill shows **Local only** for that moment; focusing the page or coming back online retries the check, and edits made meanwhile stay marked for upload.

## Notes

- Everything is client-side except the small `GET`/`PUT` Function. There is no account system.
- `watchlist.html` and `images.jpg` are intentionally ignored by git; they are unrelated to this site.
- `table.html` and `table/index.html` keep old `#table` links working after the receipt/table merge.

---

Built using **DeepSeek V4.1 Flash in OpenCode**.
