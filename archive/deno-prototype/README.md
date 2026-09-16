# Archived: early Deno/TypeScript prototype

This folder holds an earlier version of CampusPulse's backend, written for
Deno with a `node:sqlite`-backed `db.ts` and a `server.ts` HTTP server.

It is **not** the backend the app currently runs on. The live app is the
Flask/Python backend at the repo root (`app.py`), which the `Procfile`,
`requirements.txt`, and `Start-CampusPulse.bat` all point to. The Python
version is a superset of this prototype — it has everything here
(personalized feed, scoring, digest, `.ics` export) plus real password
auth, sessions, rate limiting, WebSocket live updates, and Web Push.

Kept for reference / in case any of the original logic is useful later.
Safe to delete if you don't need the history.
