<![CDATA[<div align="center">

<img src="public/favicon.svg" width="64" height="64" alt="CampusPulse logo">

# CampusPulse

**Signal, not noise — one calm feed for every campus notice that actually matters to you.**

Built for **KUET** (Khulna University of Engineering & Technology)  
by **Team Code & Caffeine** · Fork KUET Hackathon 2026

[![Python](https://img.shields.io/badge/Python-3.10%2B-blue?logo=python&logoColor=white)](https://python.org)
[![Flask](https://img.shields.io/badge/Flask-3.1-black?logo=flask)](https://flask.palletsprojects.com)
[![SQLite](https://img.shields.io/badge/SQLite-local%20dev-003B57?logo=sqlite)](https://sqlite.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-production-4169E1?logo=postgresql&logoColor=white)](https://postgresql.org)
[![PWA](https://img.shields.io/badge/PWA-ready-5A0FC8?logo=googlechrome&logoColor=white)](https://web.dev/progressive-web-apps)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[Live Demo](#running-locally) · [API Reference](#api-reference) · [Deploy to Render](#deploy-to-render)

</div>

---

## What is CampusPulse?

KUET students and faculty receive a torrent of notices every day across multiple channels — class relocations, lab reschedules, club deadlines, hall events, and admin memos — scattered across dozens of group chats, notice boards, and email threads.

**CampusPulse fixes this.** It reads every campus notice and surfaces only what's relevant to *you*, ranked by urgency. A third-year CSE student in Section A never has to scroll past an EEE lab notice again.

### Key features

| Feature | Description |
|---|---|
| 🎯 **Personalized feed** | Notices filtered by your department, batch, section, hall, and clubs |
| 🚨 **Urgency-aware ranking** | Critical → action-needed → upcoming deadlines → everything else |
| ✅ **Read acknowledgments** | Publishers can require confirmations; students mark notices as read |
| 🔖 **Bookmarks** | Save any notice for later |
| 📅 **Calendar export** | Download deadlines as `.ics` files (Google Calendar, Outlook, Apple Calendar) |
| 🌅 **Morning briefing** | One-click digest of critical alerts, deadlines, and department highlights |
| 📡 **Live updates** | WebSocket broadcast so new notices appear instantly across all open tabs |
| 🔔 **Web Push** | OS-level push notifications via VAPID (opt-in, standards-based) |
| 🌙 **Dark mode** | Persisted preference, no flash of wrong theme |
| 📱 **PWA** | Installable on Android and desktop via the browser |
| 🔍 **Full-text search** | Filter by title, content, summary, or publisher name |
| 🛡️ **Rate limiting** | Brute-force protection on login and signup endpoints |
| 🐘 **PostgreSQL / SQLite** | PostgreSQL for production; SQLite for zero-config local dev |

---

## Tech stack

```
Backend       Flask 3.1 (Python 3.10+)
              flask-sock  — WebSocket support (RFC 6455)
              Werkzeug    — password hashing (bcrypt-backed PBKDF2)
              psycopg 3   — PostgreSQL driver (production)
              pywebpush   — W3C Web Push Protocol
              gunicorn    — WSGI production server

Frontend      Vanilla HTML5 / CSS3 / ES2019+ (no build step required)
              Service Worker (sw.js) — PWA + Web Push handler
              Dicebear 7  — deterministic avatar generation

Database      SQLite (dev)  — file-based, zero config
              PostgreSQL    — managed production DB (Render/Neon/Supabase)
```

---

## Project structure

```
campus-gpt-new/
├── app.py                 # Flask backend — all API routes, DB, WebSocket
├── requirements.txt       # Python dependencies
├── Procfile               # Gunicorn start command (Render / Heroku)
├── .env.example           # Environment variable template
├── .gitignore
└── public/                # Static frontend (served by Flask)
    ├── index.html         # Single-page application shell
    ├── styles.css         # All styles (~1,800 lines, CSS variables, dark mode)
    ├── app.js             # Client-side logic (~950 lines, no framework)
    ├── sw.js              # Service Worker (Web Push + PWA lifecycle)
    ├── manifest.json      # PWA manifest
    ├── favicon.svg        # SVG icon (scales to any size)
    └── robots.txt
```

---

## Running locally

### Prerequisites

- Python 3.10 or newer
- `pip`

### 1 — Clone and install

```bash
git clone https://github.com/<your-username>/campus-gpt-new.git
cd campus-gpt-new
pip install -r requirements.txt
```

> **Tip:** Use a virtual environment to keep your system Python clean:
> ```bash
> python -m venv .venv
> .venv\Scripts\activate   # Windows
> source .venv/bin/activate # macOS / Linux
> pip install -r requirements.txt
> ```

### 2 — Run the server

```bash
python app.py
```

The server starts on **http://localhost:8000**. The SQLite database (`campuspulse.sqlite`) and a session secret (`.session_secret`) are created automatically on first run. Realistic seed data (5 demo personas, 8 sample announcements) is loaded on first startup.

### 3 — Open in your browser

```
http://localhost:8000
```

Click any **demo persona** to log in without a password, or create your own account via **Create account**.

### Windows one-click launcher

Double-click **`Start-CampusPulse.bat`** — it activates a virtual environment (if present) and starts the server automatically.

---

## Environment variables

Copy `.env.example` to `.env` and fill in values for production. **None are required for local development.**

| Variable | Default | Description |
|---|---|---|
| `SESSION_SECRET` | auto-generated | Secret key for signing session cookies. Set explicitly in production. |
| `DATABASE_URL` | *(none)* | PostgreSQL connection string. If absent, SQLite is used. |
| `PORT` | `8000` | Port the server listens on. Set automatically by most hosting platforms. |
| `DB_FILE` | `campuspulse.sqlite` | Local SQLite file path. Ignored when `DATABASE_URL` is set. |

---

## API reference

All API endpoints return JSON. Session cookies are used for authentication.

### Auth

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/auth/me` | Returns the current logged-in user or `{"user": null}` |
| `POST` | `/api/auth/login` | Sign in with `{email, password}` |
| `POST` | `/api/auth/signup` | Create account with `{name, email, password, role, department, batch, section, hall, preferred_topics}` |
| `POST` | `/api/auth/demo-login` | One-click demo login with `{user_id}` (only for seed users without a password) |
| `POST` | `/api/auth/logout` | Clear session |

### Users

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/users` | List all demo personas (no passwords exposed) |
| `GET` | `/api/users/<id>` | Get a specific user's public profile |
| `PUT` | `/api/users/<id>/preferences` | Update `noise_filter` and/or `preferred_topics` |

### Announcements

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/announcements` | Personalized feed. Query params: `user_id`, `feed_type` (`for_me`/`official`/`deadlines`/`bookmarks`), `urgency` (`strict`/`balanced`/`all`), `category`, `search` |
| `POST` | `/api/announcements` | Publish a new notice |
| `POST` | `/api/announcements/<id>/acknowledge` | Record a read acknowledgment |
| `POST` | `/api/announcements/<id>/bookmark` | Toggle bookmark |

### Other

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/digest` | Morning briefing for `?user_id=<id>` |
| `GET` | `/api/export-ics/<id>` | Download deadline as `.ics` calendar event |
| `GET` | `/api/healthz` | Health check — returns `{"status": "ok", "database": "connected"}` |
| `GET` | `/api/push/config` | VAPID public key for Web Push subscription |
| `POST` | `/api/push/subscribe` | Save a push subscription |
| `DELETE` | `/api/push/subscribe` | Remove a push subscription |
| `WS` | `/api/ws` | WebSocket — receives `NEW_ANNOUNCEMENT` and `ACKNOWLEDGMENT_UPDATE` events |

---

## Feed logic

### Personalization

For the **For you** feed, a notice is included if:

- **Critical** notices → included if `target_dept` / `target_batch` / `target_section` match (or are `ALL`)
- **Club-targeted** notices → included if the user is a member of `target_club`
- **Hall-targeted** notices → included if `target_hall` matches the user's hall
- **All other notices** → department + batch + section must all match (or be `ALL`)

### Ranking (priority tiers)

| Priority | Condition | Group label |
|---|---|---|
| 0 | Critical urgency + acknowledgment pending | Action needed |
| 1 | Deadline within 24 hours | Action needed |
| 2 | Acknowledgment pending | Action needed |
| 3 | Deadline within 72 hours | Coming up |
| 4 | Everything else | Latest updates |

Within each tier, items are sorted by deadline proximity (for time-sensitive tiers) then by `created_at` descending.

---

## Demo personas

Five seeded accounts let you explore the app instantly without signing up:

| Name | Role | Dept / Batch | Hall |
|---|---|---|---|
| Arafat Rahman | Student | CSE · Batch 21 · Sec A | Lalon Shah Hall |
| Tasnim Islam | Student | EEE · Batch 23 · Sec B | Rokeya Hall |
| Dr. Farhan Tanvir | Faculty | CSE | Faculty Quarters |
| Tanveer Hasan | Class Rep | CSE · Batch 21 · Sec A | Khan Jahan Ali Hall |
| Sabbir Ahmed | Student | ME · Batch 22 · Sec A | Amar Ekushey Hall |

---

## Deploy to Render

Render offers a free tier for web services and managed PostgreSQL.

### 1 — Create a Managed PostgreSQL database

In your Render dashboard → **New → PostgreSQL** → copy the **External Database URL**.

### 2 — Create a Web Service

- **Environment:** Python 3
- **Build command:** `pip install -r requirements.txt`
- **Start command:** *(auto-read from Procfile)*

### 3 — Set environment variables

| Key | Value |
|---|---|
| `DATABASE_URL` | Paste the PostgreSQL connection string |
| `SESSION_SECRET` | Any long random string (`python -c "import secrets; print(secrets.token_hex(32))"`) |

### 4 — Deploy

Push to GitHub → Render detects the Procfile and deploys automatically.

> **Note:** On first boot Render will run `init_db()`, which creates tables and seeds the demo data automatically. No manual migration step required.

---

## Web Push notifications (optional)

VAPID keys are derived deterministically from `SESSION_SECRET` — no separate key generation step is needed. To enable push:

1. Ensure `pywebpush` and `py_vapid` are installed (`requirements.txt` includes them).
2. Click the **🔔 bell icon** in the app topbar.
3. Grant notification permission when prompted.

The service worker (`sw.js`) handles incoming push events and shows an OS notification.

---

## Development notes

### No build step

The frontend is plain HTML + CSS + JavaScript. Open `public/index.html` and `public/app.js` directly — no bundler, no transpiler, no `node_modules`.

### Database migrations

Schema changes are applied via `ALTER TABLE` guards inside `init_db()`. The function is idempotent and safe to run on every startup.

### WebSocket reconnection

The client reconnects automatically after a 4-second delay if the WebSocket drops.

### Security

- Passwords are hashed with Werkzeug's PBKDF2-SHA256 (salted).
- Demo personas have `password_hash = NULL` and can only be accessed via `/api/auth/demo-login`.
- Login and signup endpoints are rate-limited to 8 attempts per 10-minute window per IP.
- Session cookies are `HttpOnly`, `SameSite=Lax`, and last 30 days.
- CORS is open (`*`) for local dev — tighten in production by removing the `add_cors` after-request hook.

---

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you'd like to change.

```bash
# Run the app in dev mode (auto-restarts on code changes)
FLASK_ENV=development python app.py
```

---

## License

[MIT](LICENSE) — © 2026 Team Code & Caffeine, KUET
]]>
