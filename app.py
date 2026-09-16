"""
CampusPulse — Python Flask Backend
Team: Code & Caffeine | Fork KUET 2026
Faithful port of server.ts + db.ts (Deno) → Python

Run:
    pip install flask flask-sock
    python app.py
Then open http://localhost:8000
"""

import json
import re
import secrets
import sqlite3
import os
import threading
import base64
import hashlib
from datetime import datetime, timedelta, timezone

from flask import Flask, request, jsonify, send_from_directory, Response, session

# Real-time sockets and browser push are optional enhancements.  Keeping them
# optional means the core dashboard can still start on a fresh Python install
# after Flask is installed, instead of refusing every local connection.
try:
    from flask_sock import Sock
    SOCKETS_AVAILABLE = True
except ImportError:
    SOCKETS_AVAILABLE = False

    class Sock:
        def __init__(self, app):
            self.app = app

        def route(self, _path):
            def decorator(function):
                return function
            return decorator

try:
    from pywebpush import webpush, WebPushException
    from py_vapid import Vapid02
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
    PUSH_AVAILABLE = True
except ImportError:
    webpush = None
    WebPushException = Exception
    Vapid02 = None
    Encoding = PublicFormat = None
    PUSH_AVAILABLE = False
from werkzeug.security import generate_password_hash, check_password_hash

try:
    import psycopg
    from psycopg.rows import dict_row
    PSYCOPG_AVAILABLE = True
except ImportError:
    psycopg = None
    dict_row = None
    PSYCOPG_AVAILABLE = False

# ---------------------------------------------------------------------------
# App Setup
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# PostgreSQL is the production database.  Hosted providers expose a DATABASE_URL
# and keep data outside the web service's ephemeral filesystem. SQLite remains a
# zero-config local-development fallback only.
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
DB_FILE = os.environ.get("DB_FILE") or os.path.join(BASE_DIR, "campuspulse.sqlite")
USING_POSTGRES = DATABASE_URL.startswith(("postgres://", "postgresql://"))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")

app = Flask(__name__, static_folder=None)  # we serve static files manually

# Session cookie secret. Persisted to disk so logged-in sessions survive
# server restarts — the whole point of a "permanent" deployment. You can
# override this by setting SESSION_SECRET (recommended for production).
SECRET_KEY_FILE = os.path.join(BASE_DIR, ".session_secret")


def _load_or_create_secret_key() -> str:
    env_secret = os.environ.get("SESSION_SECRET") or os.environ.get("SECRET_KEY")
    if env_secret:
        return env_secret
    if os.path.exists(SECRET_KEY_FILE):
        with open(SECRET_KEY_FILE, "r") as f:
            existing = f.read().strip()
            if existing:
                return existing
    new_secret = secrets.token_hex(32)
    with open(SECRET_KEY_FILE, "w") as f:
        f.write(new_secret)
    return new_secret


app.secret_key = _load_or_create_secret_key()
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    # Keep people signed in across browser restarts for up to 30 days.
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)
sock = Sock(app)

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
VALID_TOPICS = {"academics", "clubs", "admin", "hall", "community"}

# ---------------------------------------------------------------------------
# WebSocket Client Registry (thread-safe)
# ---------------------------------------------------------------------------
ws_clients: list = []
ws_lock = threading.Lock()


def broadcast(message: dict):
    """Send a JSON message to every connected WebSocket client."""
    data = json.dumps(message)
    with ws_lock:
        dead = []
        for client in ws_clients:
            try:
                client.send(data)
            except Exception:
                dead.append(client)
        for d in dead:
            ws_clients.remove(d)


# ---------------------------------------------------------------------------
# Database Helpers
# ---------------------------------------------------------------------------
class CompatRow(dict):
    """Mapping row with SQLite-style numeric access for aggregate queries."""

    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self.values())[key]
        return super().__getitem__(key)


def _postgres_sql(query: str) -> str:
    """Translate this app's DB-API qmark placeholders for psycopg."""
    return query.replace("?", "%s")


class PostgresCursor:
    """Small compatibility layer so existing route queries run on PostgreSQL."""

    def __init__(self, cursor):
        self._cursor = cursor

    def execute(self, query, params=None):
        self._cursor.execute(_postgres_sql(query), params)
        return self

    def executemany(self, query, params_seq):
        self._cursor.executemany(_postgres_sql(query), params_seq)
        return self

    def fetchone(self):
        row = self._cursor.fetchone()
        return CompatRow(row) if row is not None else None

    def fetchall(self):
        return [CompatRow(row) for row in self._cursor.fetchall()]


class PostgresConnection:
    def __init__(self, connection):
        self._connection = connection

    def cursor(self):
        return PostgresCursor(self._connection.cursor())

    def execute(self, query, params=None):
        return self.cursor().execute(query, params)

    def commit(self):
        self._connection.commit()

    def close(self):
        self._connection.close()


def get_db():
    """Open a hosted PostgreSQL connection, or a local SQLite connection."""
    if USING_POSTGRES:
        if not PSYCOPG_AVAILABLE:
            raise RuntimeError("PostgreSQL is configured but psycopg is not installed.")
        return PostgresConnection(psycopg.connect(DATABASE_URL, row_factory=dict_row))
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def row_to_dict(row):
    if row is None:
        return None
    return dict(row)


def rows_to_list(rows):
    return [dict(r) for r in rows]


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def vapid_keypair():
    """Derive stable VAPID keys from the existing application secret."""
    if not PUSH_AVAILABLE:
        return None, None
    seed = os.environ.get("SESSION_SECRET") or str(app.secret_key)
    digest = hashlib.sha256(seed.encode("utf-8")).digest()
    # P-256 order; reducing keeps the derived scalar in the valid range.
    curve_order = int(
        "FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551",
        16,
    )
    scalar = (int.from_bytes(digest, "big") % (curve_order - 1)) + 1
    private_key = _b64url(scalar.to_bytes(32, "big"))
    vapid = Vapid02.from_raw(private_key.encode("ascii"))
    public_key = _b64url(
        vapid.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    )
    return private_key, public_key


def public_user(user_dict):
    """Strip sensitive fields before sending a user object to the client."""
    if not user_dict:
        return None
    safe = dict(user_dict)
    safe.pop("password_hash", None)
    safe["has_password"] = bool(user_dict.get("password_hash"))
    return safe


# ---------------------------------------------------------------------------
# Database Initialization & Seeding
# ---------------------------------------------------------------------------
def init_db():
    conn = get_db()
    cur = conn.cursor()

    sqlite_schema = """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            avatar TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT,
            role TEXT NOT NULL,
            department TEXT NOT NULL,
            batch TEXT NOT NULL,
            section TEXT NOT NULL,
            hall TEXT NOT NULL,
            clubs TEXT NOT NULL,
            courses TEXT NOT NULL,
            noise_filter TEXT DEFAULT 'balanced',
            preferred_topics TEXT DEFAULT '[]',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS announcements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            summary_tldr TEXT NOT NULL,
            category TEXT NOT NULL,
            urgency TEXT NOT NULL,
            target_dept TEXT DEFAULT 'ALL',
            target_batch TEXT DEFAULT 'ALL',
            target_section TEXT DEFAULT 'ALL',
            target_club TEXT DEFAULT 'ALL',
            target_hall TEXT DEFAULT 'ALL',
            publisher_id INTEGER NOT NULL,
            publisher_name TEXT NOT NULL,
            publisher_role TEXT NOT NULL,
            is_verified INTEGER DEFAULT 0,
            requires_acknowledgment INTEGER DEFAULT 0,
            deadline_at TEXT,
            action_label TEXT,
            action_url TEXT,
            location_change TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS acknowledgments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            announcement_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            acknowledged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(announcement_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS bookmarks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            announcement_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(announcement_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            endpoint TEXT NOT NULL UNIQUE,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_announcements_created_at ON announcements(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_announcements_category ON announcements(category);
        CREATE INDEX IF NOT EXISTS idx_announcements_urgency ON announcements(urgency);
        CREATE INDEX IF NOT EXISTS idx_announcements_deadline ON announcements(deadline_at);
        CREATE INDEX IF NOT EXISTS idx_acknowledgments_announcement ON acknowledgments(announcement_id);
        CREATE INDEX IF NOT EXISTS idx_acknowledgments_user ON acknowledgments(user_id);
        CREATE INDEX IF NOT EXISTS idx_bookmarks_announcement ON bookmarks(announcement_id);
        CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id);
        CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
    """

    postgres_schema = """
        CREATE TABLE IF NOT EXISTS users (
            id BIGSERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            avatar TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT,
            role TEXT NOT NULL,
            department TEXT NOT NULL,
            batch TEXT NOT NULL,
            section TEXT NOT NULL,
            hall TEXT NOT NULL,
            clubs TEXT NOT NULL,
            courses TEXT NOT NULL,
            noise_filter TEXT DEFAULT 'balanced',
            preferred_topics TEXT DEFAULT '[]',
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS announcements (
            id BIGSERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            summary_tldr TEXT NOT NULL,
            category TEXT NOT NULL,
            urgency TEXT NOT NULL,
            target_dept TEXT DEFAULT 'ALL',
            target_batch TEXT DEFAULT 'ALL',
            target_section TEXT DEFAULT 'ALL',
            target_club TEXT DEFAULT 'ALL',
            target_hall TEXT DEFAULT 'ALL',
            publisher_id BIGINT NOT NULL,
            publisher_name TEXT NOT NULL,
            publisher_role TEXT NOT NULL,
            is_verified INTEGER DEFAULT 0,
            requires_acknowledgment INTEGER DEFAULT 0,
            deadline_at TEXT,
            action_label TEXT,
            action_url TEXT,
            location_change TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS acknowledgments (
            id BIGSERIAL PRIMARY KEY,
            announcement_id BIGINT NOT NULL,
            user_id BIGINT NOT NULL,
            acknowledged_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(announcement_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS bookmarks (
            id BIGSERIAL PRIMARY KEY,
            announcement_id BIGINT NOT NULL,
            user_id BIGINT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(announcement_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id BIGSERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL,
            endpoint TEXT NOT NULL UNIQUE,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_announcements_created_at ON announcements(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_announcements_category ON announcements(category);
        CREATE INDEX IF NOT EXISTS idx_announcements_urgency ON announcements(urgency);
        CREATE INDEX IF NOT EXISTS idx_announcements_deadline ON announcements(deadline_at);
        CREATE INDEX IF NOT EXISTS idx_acknowledgments_announcement ON acknowledgments(announcement_id);
        CREATE INDEX IF NOT EXISTS idx_acknowledgments_user ON acknowledgments(user_id);
        CREATE INDEX IF NOT EXISTS idx_bookmarks_announcement ON bookmarks(announcement_id);
        CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id);
        CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
    """

    if USING_POSTGRES:
        for statement in postgres_schema.split(";"):
            if statement.strip():
                cur.execute(statement)
    else:
        cur.executescript(sqlite_schema)

    # Safety-net migration in case an older DB file (without auth columns) is reused
    if USING_POSTGRES:
        existing_cols = {
            row["column_name"]
            for row in cur.execute(
                "SELECT column_name FROM information_schema.columns WHERE table_name = 'users'"
            ).fetchall()
        }
    else:
        existing_cols = {row[1] for row in cur.execute("PRAGMA table_info(users)").fetchall()}
    if "password_hash" not in existing_cols:
        cur.execute("ALTER TABLE users ADD COLUMN password_hash TEXT")
    if "preferred_topics" not in existing_cols:
        cur.execute("ALTER TABLE users ADD COLUMN preferred_topics TEXT DEFAULT '[]'")

    # Check if data already seeded
    count = cur.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    if count == 0:
        seed_database(conn)

    conn.commit()
    conn.close()


def seed_database(conn):
    print("[SEED] Seeding CampusPulse database with realistic university data...")
    cur = conn.cursor()

    # ---- Users / Personas ----
    # password_hash is NULL for all seeded demo personas — they're accessed via
    # one-click "Demo Login" rather than a password, exactly like before.
    users = [
        (1, "Arafat Rahman",
         "https://api.dicebear.com/7.x/bottts/svg?seed=Arafat",
         "arafat.cse21@kuet.ac.bd", None, "student", "CSE", "21", "A",
         "Lalon Shah Hall",
         json.dumps(["Cyber Security Club", "KUET Programming Club"]),
         json.dumps(["CSE-3101", "CSE-3103", "MATH-3101"]),
         "balanced",
         json.dumps(["academics", "clubs"])),
        (2, "Tasnim Islam",
         "https://api.dicebear.com/7.x/bottts/svg?seed=Tasnim",
         "tasnim.eee23@kuet.ac.bd", None, "student", "EEE", "23", "B",
         "Rokeya Hall",
         json.dumps(["KUET Robotics Club", "Debating Society"]),
         json.dumps(["EEE-2201", "EEE-2202", "PHY-2201"]),
         "balanced",
         json.dumps(["academics", "clubs"])),
        (3, "Dr. Farhan Tanvir",
         "https://api.dicebear.com/7.x/bottts/svg?seed=Farhan",
         "farhan@cse.kuet.ac.bd", None, "faculty", "CSE", "ALL", "ALL",
         "Faculty Quarters",
         json.dumps([]),
         json.dumps(["CSE-3101"]),
         "strict",
         json.dumps(["academics", "admin"])),
        (4, "Tanveer Hasan (CR)",
         "https://api.dicebear.com/7.x/bottts/svg?seed=TanveerCR",
         "cr.cse21a@kuet.ac.bd", None, "cr", "CSE", "21", "A",
         "Khan Jahan Ali Hall",
         json.dumps(["KUET Programming Club"]),
         json.dumps(["CSE-3101", "CSE-3103"]),
         "strict",
         json.dumps(["academics", "admin", "hall"])),
        (5, "Sabbir Ahmed",
         "https://api.dicebear.com/7.x/bottts/svg?seed=Sabbir",
         "sabbir.me22@kuet.ac.bd", None, "student", "ME", "22", "A",
         "Amar Ekushey Hall",
         json.dumps(["Sports Club", "Automobile Club"]),
         json.dumps(["ME-2201", "MATH-2201"]),
         "all",
         json.dumps(["clubs", "community", "hall"])),
    ]

    cur.executemany(
        """INSERT INTO users
           (id, name, avatar, email, password_hash, role, department, batch, section,
            hall, clubs, courses, noise_filter, preferred_topics)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        users,
    )

    # ---- Announcements ----
    now = datetime.now(timezone.utc)

    def in_hours(h):
        return (now + timedelta(hours=h)).isoformat()

    def past_minutes(m):
        return (now - timedelta(minutes=m)).isoformat()

    notices = [
        # 1. Critical classroom relocation
        ("🚨 CRITICAL: CSE-3101 Database Class Relocated to NAB-405",
         "Attention 3rd Year CSE Section A: Due to an unexpected multimedia projector malfunction in Room 302, today's 10:00 AM Database Systems lecture by Dr. Farhan Tanvir will be held in New Academic Building, Room 405 (NAB-405). Please arrive on time as attendance will be recorded digitally at the start.",
         "Class moved from Room 302 to NAB-405 today at 10:00 AM due to hardware failure. Please confirm acknowledgment.",
         "academics", "critical",
         "CSE", "21", "A", "ALL", "ALL",
         3, "Dr. Farhan Tanvir", "Course Teacher / Associate Professor",
         1, 1, in_hours(2),
         "View Room on Map", "#campus-map",
         "CSE Room 302 ➔ NAB-405", past_minutes(25)),

        # 2. Club registration deadline
        ("⏳ KUET Cyber HackFest 2026: Team Registration Closes in 24 Hours",
         "Registration for the 48-hour National Cyber HackFest 2026 closes tomorrow at 11:59 PM. We have only 15 slots remaining across university teams. Cash prize pool: 150,000 BDT. Make sure your 3-member squad includes at least one reverse-engineering specialist. Don't let this slip by in your chat feeds!",
         "Final 15 slots remaining. Team registration ends tomorrow at 11:59 PM. 150k BDT prize pool.",
         "clubs", "high",
         "ALL", "ALL", "ALL", "Cyber Security Club", "ALL",
         1, "Cyber Security Club Exec", "Club Organizers",
         1, 0, in_hours(24),
         "Register Squad", "https://cyberhackfest.kuet.ac.bd",
         None, past_minutes(180)),

        # 3. EEE Lab Reschedule
        ("⚡ EEE-2202 Circuit Lab Section B Shifted to 2:30 PM",
         "Due to scheduled power grid maintenance on the 3rd floor East Wing, the morning lab session for EEE Batch 23 Section B is rescheduled to 2:30 PM today in Analog Lab 2.",
         "EEE Batch 23 Sec B lab shifted from 10:30 AM to 2:30 PM today.",
         "academics", "high",
         "EEE", "23", "B", "ALL", "ALL",
         2, "Engr. Kamrul Hasan", "Lab In-Charge",
         1, 1, in_hours(4),
         "Acknowledge Change", None,
         "East Wing Lab ➔ Analog Lab 2", past_minutes(55)),

        # 4. Academic Coursework Deadline
        ("📝 CSE-3103 Operating Systems: Kernel Module Project Submission",
         "All CSE 21 Batch students must submit their Phase 1 custom Linux kernel scheduling module source code with Makefile and brief test documentation via the university LMS portal. Late submissions will incur a 10% penalty per day.",
         "Submit kernel module code + Makefile by Sunday 5:00 PM on LMS. No email submissions.",
         "academics", "high",
         "CSE", "21", "ALL", "ALL", "ALL",
         4, "Tanveer Hasan (CR)", "Class Representative",
         1, 0, in_hours(48),
         "Open LMS Portal", "https://lms.kuet.ac.bd/course/cse3103",
         None, past_minutes(360)),

        # 5. Official University Notice (Library)
        ("📚 KUET Central Library: 24/7 Reading Room Open for Mid-Term Exams",
         "The Central Library Committee announces that the Air-Conditioned Study Hall on the 2nd floor will remain accessible 24/7 starting this Saturday until the end of Semester Mid-Terms. High-speed Wi-Fi and power outlets have been upgraded across 200 study cubicles.",
         "2nd Floor Study Hall open 24/7 starting Saturday through Mid-terms. Wi-Fi & outlets upgraded.",
         "admin", "medium",
         "ALL", "ALL", "ALL", "ALL", "ALL",
         3, "Registrar Office", "Central Administration",
         1, 0, None,
         "Check Library Guidelines", "#library",
         None, past_minutes(720)),

        # 6. Robotics Workshop
        ("🤖 Hands-On ROS 2 & Autonomous Mobile Robots Workshop",
         "KUET Robotics Club proudly presents a two-weekend intensive workshop on Robot Operating System 2 (ROS 2 Humble), LiDAR mapping, and SLAM navigation. Hardware kits provided for hands-on sessions. Limited to 40 participants.",
         "2-weekend hands-on ROS 2 and SLAM robotics boot camp. Kits provided. 40 seats max.",
         "clubs", "medium",
         "ALL", "ALL", "ALL", "KUET Robotics Club", "ALL",
         2, "KUET Robotics Club", "Executive Committee",
         1, 0, in_hours(72),
         "Apply for Seat", "https://robotics.kuet.ac.bd/ros2",
         None, past_minutes(840)),

        # 7. Hall Notice (Lalon Shah Hall)
        ("🏸 Lalon Shah Hall Annual Badminton Championship 2026",
         "Fixtures for the Singles and Doubles tournaments are posted on the hall ground floor board. First round matches commence Thursday evening after Maghrib prayer. Non-marking shoes mandatory.",
         "Hall badminton tournament begins Thursday evening. Check ground floor board for fixtures.",
         "hall", "low",
         "ALL", "ALL", "ALL", "ALL", "Lalon Shah Hall",
         1, "Hall Sports Secretary", "Student Cabinet",
         0, 0, in_hours(36),
         "View Bracket", "#hall-sports",
         None, past_minutes(1200)),

        # 8. Campus Community / Lost & Found
        ("🔍 Found: Casio fx-991EX ClassWiz in Auditorium 2",
         "Found during yesterday's 4:00 PM session on row G seat 14. Has a small carbon fiber skin sticker on the back cover. The rightful owner can reclaim it from the Student Welfare Center by verifying the sticker detail.",
         "Found Casio fx-991EX calculator in Audi 2. Reclaim at DSW office with proof.",
         "community", "low",
         "ALL", "ALL", "ALL", "ALL", "ALL",
         5, "Sabbir Ahmed", "Student",
         0, 0, None,
         "Contact DSW", "#dsw",
         None, past_minutes(1440)),
    ]

    cur.executemany(
        """INSERT INTO announcements
           (title, content, summary_tldr, category, urgency,
            target_dept, target_batch, target_section, target_club, target_hall,
            publisher_id, publisher_name, publisher_role,
            is_verified, requires_acknowledgment, deadline_at,
            action_label, action_url, location_change, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        notices,
    )

    # Sample acknowledgments for notice #1
    cur.execute(
        "INSERT INTO acknowledgments (announcement_id, user_id) VALUES (?,?)",
        (1, 4),
    )
    cur.execute(
        "INSERT INTO acknowledgments (announcement_id, user_id) VALUES (?,?)",
        (1, 1),
    )

    if USING_POSTGRES:
        cur.execute(
            "SELECT setval(pg_get_serial_sequence('users', 'id'), "
            "COALESCE((SELECT MAX(id) FROM users), 1), true)"
        )

    conn.commit()
    print("[OK] Seed completed successfully.")


# Run schema setup during module import as well as local execution. Gunicorn
# imports ``app:app`` instead of entering the __main__ block, so keeping this
# here guarantees a freshly attached managed database is ready before traffic.
init_db()


# ---------------------------------------------------------------------------
# Lightweight Login Rate Limiting (in-memory; resets on restart)
# ---------------------------------------------------------------------------
LOGIN_ATTEMPT_LIMIT = 8
LOGIN_ATTEMPT_WINDOW = timedelta(minutes=10)
_login_attempts: dict = {}
_login_attempts_lock = threading.Lock()


def _client_ip() -> str:
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or "unknown"


def is_rate_limited(key: str) -> bool:
    now = datetime.now(timezone.utc)
    with _login_attempts_lock:
        attempts = [t for t in _login_attempts.get(key, []) if now - t < LOGIN_ATTEMPT_WINDOW]
        _login_attempts[key] = attempts
        return len(attempts) >= LOGIN_ATTEMPT_LIMIT


def register_failed_attempt(key: str):
    now = datetime.now(timezone.utc)
    with _login_attempts_lock:
        _login_attempts.setdefault(key, []).append(now)


def clear_attempts(key: str):
    with _login_attempts_lock:
        _login_attempts.pop(key, None)


# ---------------------------------------------------------------------------
# CORS Helper
# ---------------------------------------------------------------------------
@app.after_request
def add_cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    return response


# Handle CORS preflight
@app.route("/<path:path>", methods=["OPTIONS"])
@app.route("/", methods=["OPTIONS"])
def cors_preflight(path=""):
    return "", 204


@app.route("/api/healthz", methods=["GET"])
def health_check():
    try:
        conn = get_db()
        conn.execute("SELECT 1").fetchone()
        conn.close()
        return jsonify({"status": "ok", "database": "connected"})
    except Exception as exc:
        app.logger.exception("Database health check failed: %s", exc)
        return jsonify({"status": "unavailable", "database": "disconnected"}), 503


# ---------------------------------------------------------------------------
# WebSocket Endpoint
# ---------------------------------------------------------------------------
@sock.route("/api/ws")
def websocket_handler(ws):
    with ws_lock:
        ws_clients.append(ws)
    try:
        while True:
            # keep connection alive; ignore client messages
            ws.receive(timeout=60)
    except Exception:
        pass
    finally:
        with ws_lock:
            if ws in ws_clients:
                ws_clients.remove(ws)


# ---------------------------------------------------------------------------
# Auth Helpers
# ---------------------------------------------------------------------------
def get_session_user():
    uid = session.get("user_id")
    if not uid:
        return None
    conn = get_db()
    user = row_to_dict(conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone())
    conn.close()
    return user


def require_login():
    """Returns (user, None) if logged in, or (None, error_response) otherwise."""
    user = get_session_user()
    if not user:
        return None, (jsonify({"error": "Not logged in"}), 401)
    return user, None


# ---------------------------------------------------------------------------
# API: POST /api/auth/signup
# ---------------------------------------------------------------------------
@app.route("/api/auth/signup", methods=["POST"])
def signup():
    body = request.get_json(force=True)

    rate_key = f"signup:{_client_ip()}"
    if is_rate_limited(rate_key):
        return jsonify({
            "error": "Too many signup attempts from this connection. Please wait a few minutes."
        }), 429
    register_failed_attempt(rate_key)

    name = (body.get("name") or "").strip()
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    role = body.get("role") or "student"
    department = (body.get("department") or "").strip() or "CSE"
    batch = (body.get("batch") or "").strip() or "ALL"
    section = (body.get("section") or "").strip() or "ALL"
    hall = (body.get("hall") or "").strip() or "N/A"
    clubs_raw = body.get("clubs") or []
    courses_raw = body.get("courses") or []
    preferred_topics_raw = body.get("preferred_topics") or []

    if not name or len(name) < 2:
        return jsonify({"error": "Please enter your full name."}), 400
    if not EMAIL_RE.match(email):
        return jsonify({"error": "Please enter a valid email address."}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters."}), 400
    if role not in ("student", "cr", "faculty"):
        role = "student"

    clubs = [c.strip() for c in clubs_raw if isinstance(c, str) and c.strip()]
    courses = [c.strip() for c in courses_raw if isinstance(c, str) and c.strip()]
    preferred_topics = [t for t in preferred_topics_raw if t in VALID_TOPICS]

    conn = get_db()
    existing = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if existing:
        conn.close()
        return jsonify({"error": "An account with this email already exists."}), 409

    avatar = f"https://api.dicebear.com/7.x/bottts/svg?seed={email.split('@')[0]}"
    password_hash = generate_password_hash(password)

    cur = conn.execute(
        """INSERT INTO users
           (name, avatar, email, password_hash, role, department, batch, section,
            hall, clubs, courses, noise_filter, preferred_topics)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
           (name, avatar, email, password_hash, role, department, batch, section,
         hall, json.dumps(clubs), json.dumps(courses), "balanced", json.dumps(preferred_topics)),
    )
    if USING_POSTGRES:
        new_id = cur.execute("SELECT LASTVAL() AS id").fetchone()["id"]
    else:
        new_id = cur.lastrowid
    conn.commit()
    user = row_to_dict(conn.execute("SELECT * FROM users WHERE id = ?", (new_id,)).fetchone())
    conn.close()

    session.clear()
    session.permanent = True
    session["user_id"] = new_id
    return jsonify({"success": True, "user": public_user(user)}), 201


# ---------------------------------------------------------------------------
# API: POST /api/auth/login
# ---------------------------------------------------------------------------
@app.route("/api/auth/login", methods=["POST"])
def login():
    body = request.get_json(force=True)
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""

    rate_key = f"{_client_ip()}:{email}"
    if is_rate_limited(rate_key):
        return jsonify({
            "error": "Too many login attempts. Please wait a few minutes and try again."
        }), 429

    conn = get_db()
    user = row_to_dict(conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone())
    conn.close()

    if not user or not user.get("password_hash") or not check_password_hash(user["password_hash"], password):
        register_failed_attempt(rate_key)
        return jsonify({"error": "Invalid email or password."}), 401

    clear_attempts(rate_key)
    session.clear()
    session.permanent = True
    session["user_id"] = user["id"]
    return jsonify({"success": True, "user": public_user(user)})


# ---------------------------------------------------------------------------
# API: POST /api/auth/demo-login  (1-click persona login, no password)
# ---------------------------------------------------------------------------
@app.route("/api/auth/demo-login", methods=["POST"])
def demo_login():
    body = request.get_json(force=True)
    user_id = body.get("user_id")

    conn = get_db()
    user = row_to_dict(conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())
    conn.close()

    if not user:
        return jsonify({"error": "User not found."}), 404
    if user.get("password_hash"):
        return jsonify({"error": "This account has a password. Please log in instead."}), 403

    session.clear()
    session.permanent = True
    session["user_id"] = user["id"]
    return jsonify({"success": True, "user": public_user(user)})


# ---------------------------------------------------------------------------
# API: POST /api/auth/logout
# ---------------------------------------------------------------------------
@app.route("/api/auth/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"success": True})


# ---------------------------------------------------------------------------
# API: GET /api/auth/me
# ---------------------------------------------------------------------------
@app.route("/api/auth/me", methods=["GET"])
def me():
    user = get_session_user()
    if not user:
        return jsonify({"user": None}), 200
    return jsonify({"user": public_user(user)})


# ---------------------------------------------------------------------------
# API: GET /api/users  (demo persona directory — no passwords included)
# ---------------------------------------------------------------------------
@app.route("/api/users", methods=["GET"])
def get_users():
    conn = get_db()
    users = rows_to_list(
        conn.execute("SELECT * FROM users WHERE password_hash IS NULL ORDER BY id ASC").fetchall()
    )
    conn.close()
    return jsonify([public_user(u) for u in users])


# ---------------------------------------------------------------------------
# API: GET /api/users/<id>
# ---------------------------------------------------------------------------
@app.route("/api/users/<int:user_id>", methods=["GET"])
def get_user(user_id):
    conn = get_db()
    user = row_to_dict(conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())
    conn.close()
    if not user:
        return "User not found", 404
    return jsonify(public_user(user))


# ---------------------------------------------------------------------------
# API: PUT /api/users/<id>/preferences
# ---------------------------------------------------------------------------
@app.route("/api/users/<int:user_id>/preferences", methods=["PUT"])
def update_preferences(user_id):
    body = request.get_json(force=True)
    fields = []
    values = []

    if body.get("noise_filter"):
        fields.append("noise_filter = ?")
        values.append(body["noise_filter"])

    if "preferred_topics" in body:
        raw = body.get("preferred_topics") or []
        topics = [t for t in raw if t in VALID_TOPICS]
        fields.append("preferred_topics = ?")
        values.append(json.dumps(topics))

    if not fields:
        return jsonify({"success": True})

    conn = get_db()
    values.append(user_id)
    conn.execute(f"UPDATE users SET {', '.join(fields)} WHERE id = ?", values)
    conn.commit()
    user = row_to_dict(conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())
    conn.close()
    return jsonify({"success": True, "user": public_user(user)})


# ---------------------------------------------------------------------------
# API: Web Push notifications
# ---------------------------------------------------------------------------
@app.route("/api/push/config", methods=["GET"])
def push_config():
    _, public_key = vapid_keypair()
    if not public_key:
        return jsonify({"error": "Browser push is not installed on this server."}), 503
    return jsonify({"public_key": public_key})


@app.route("/api/push/subscribe", methods=["POST"])
def save_push_subscription():
    user, error = require_login()
    if error:
        return error

    body = request.get_json(force=True) or {}
    subscription = body.get("subscription") or body
    endpoint = (subscription.get("endpoint") or "").strip()
    keys = subscription.get("keys") or {}
    p256dh = (keys.get("p256dh") or "").strip()
    auth = (keys.get("auth") or "").strip()

    if not endpoint or not p256dh or not auth:
        return jsonify({"error": "A complete push subscription is required."}), 400

    conn = get_db()
    conn.execute(
        """INSERT INTO push_subscriptions
           (user_id, endpoint, p256dh, auth, updated_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(endpoint) DO UPDATE SET
             user_id = excluded.user_id,
             p256dh = excluded.p256dh,
             auth = excluded.auth,
             updated_at = CURRENT_TIMESTAMP""",
        (user["id"], endpoint, p256dh, auth),
    )
    conn.commit()
    conn.close()
    return jsonify({"success": True})


@app.route("/api/push/subscribe", methods=["DELETE"])
def delete_push_subscription():
    user, error = require_login()
    if error:
        return error

    body = request.get_json(force=True) or {}
    endpoint = (body.get("endpoint") or "").strip()
    if endpoint:
        conn = get_db()
        conn.execute(
            "DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?",
            (user["id"], endpoint),
        )
        conn.commit()
        conn.close()
    return jsonify({"success": True})


def _notice_matches_user(notice, user):
    """Match push recipients to the same audience rules used by the feed."""
    try:
        preferred_topics = json.loads(user.get("preferred_topics") or "[]")
    except Exception:
        preferred_topics = []

    if notice.get("category") not in preferred_topics:
        return False

    dept_match = notice["target_dept"] in ("ALL", user["department"])
    batch_match = notice["target_batch"] in ("ALL", user["batch"])
    section_match = notice["target_section"] in ("ALL", user["section"])
    hall_match = notice["target_hall"] in ("ALL", user["hall"])
    try:
        user_clubs = json.loads(user.get("clubs") or "[]")
    except Exception:
        user_clubs = []
    club_match = notice["target_club"] == "ALL" or notice["target_club"] in user_clubs

    if notice["target_club"] != "ALL":
        return club_match
    if notice["target_hall"] != "ALL":
        return hall_match
    return dept_match and batch_match and section_match


def send_push_for_notice(notice):
    """Deliver an OS-level push notification to matching subscribed browsers."""
    if not PUSH_AVAILABLE:
        return
    try:
        private_key, _ = vapid_keypair()
        conn = get_db()
        subscriptions = rows_to_list(
            conn.execute(
                """SELECT ps.*, u.name, u.department, u.batch, u.section, u.hall,
                          u.clubs, u.preferred_topics
                   FROM push_subscriptions ps
                   JOIN users u ON u.id = ps.user_id"""
            ).fetchall()
        )

        payload = json.dumps(
            {
                "title": notice["title"],
                "body": notice.get("summary_tldr") or notice.get("content", ""),
                "url": "/",
                "notice_id": notice["id"],
                "urgency": notice.get("urgency", "medium"),
            }
        )
        stale_endpoints = []
        sent_count = 0

        for subscription in subscriptions:
            if not _notice_matches_user(notice, subscription):
                continue

            subscription_info = {
                "endpoint": subscription["endpoint"],
                "keys": {
                    "p256dh": subscription["p256dh"],
                    "auth": subscription["auth"],
                },
            }
            try:
                webpush(
                    subscription_info=subscription_info,
                    data=payload,
                    vapid_private_key=private_key,
                    vapid_claims={"sub": "mailto:notifications@campuspulse.local"},
                    ttl=300,
                    timeout=5,
                )
                sent_count += 1
            except WebPushException as exc:
                status_code = getattr(getattr(exc, "response", None), "status_code", None)
                if status_code in (404, 410):
                    stale_endpoints.append(subscription["endpoint"])
                print(f"[PUSH] Delivery failed ({status_code or 'unknown'}): {exc}")
            except Exception as exc:
                print(f"[PUSH] Delivery failed: {exc}")

        for endpoint in stale_endpoints:
            conn.execute(
                "DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,)
            )
        if stale_endpoints:
            conn.commit()
        conn.close()
        if sent_count:
            print(f"[PUSH] Delivered notice {notice['id']} to {sent_count} browser(s).")
    except Exception as exc:
        # Push delivery must never prevent a notice from being saved or broadcast.
        print(f"[PUSH] Delivery setup failed: {exc}")


# ---------------------------------------------------------------------------
# API: GET /api/announcements  (Personalized Feed)
# ---------------------------------------------------------------------------
@app.route("/api/announcements", methods=["GET"])
def get_announcements():
    user_id = int(request.args.get("user_id", "1"))
    feed_type = request.args.get("feed_type", "for_me")
    urgency_filter = request.args.get("urgency", "balanced")
    category_filter = request.args.get("category", "all")
    search = (request.args.get("search", "") or "").strip().lower()

    conn = get_db()

    # Retrieve user
    user = row_to_dict(
        conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    )
    if not user:
        conn.close()
        return "User not found", 404

    user_clubs = json.loads(user.get("clubs") or "[]")

    # Fetch all announcements with ack/bookmark counts
    all_notices = rows_to_list(conn.execute("""
        SELECT a.*,
            (SELECT COUNT(*) FROM acknowledgments WHERE announcement_id = a.id) as ack_count,
            (SELECT COUNT(*) FROM acknowledgments WHERE announcement_id = a.id AND user_id = ?) as user_acknowledged,
            (SELECT COUNT(*) FROM bookmarks WHERE announcement_id = a.id AND user_id = ?) as user_bookmarked
        FROM announcements a
        ORDER BY a.created_at DESC
    """, (user_id, user_id)).fetchall())

    conn.close()

    total_count = len(all_notices)

    # ---------- Filter ----------
    filtered = []
    for n in all_notices:
        # Search
        if search:
            match_search = (
                search in (n["title"] or "").lower()
                or search in (n["content"] or "").lower()
                or search in (n["summary_tldr"] or "").lower()
                or search in (n["publisher_name"] or "").lower()
            )
            if not match_search:
                continue

        # Category
        if category_filter != "all" and n["category"] != category_filter:
            continue

        # Bookmarks feed
        if feed_type == "bookmarks":
            if not n["user_bookmarked"]:
                continue
            filtered.append(n)
            continue

        # Official feed
        if feed_type == "official" and not n["is_verified"]:
            continue

        # Deadlines feed
        if feed_type == "deadlines" and not n["deadline_at"]:
            continue

        # Urgency filter
        if urgency_filter == "strict":
            if n["urgency"] not in ("critical", "high"):
                continue
        elif urgency_filter == "balanced":
            if n["urgency"] == "low" and feed_type == "for_me":
                continue

        # Personalization for "for_me"
        if feed_type == "for_me":
            dept_match = n["target_dept"] in ("ALL", user["department"])
            batch_match = n["target_batch"] in ("ALL", user["batch"])
            section_match = n["target_section"] in ("ALL", user["section"])
            hall_match = n["target_hall"] in ("ALL", user["hall"])
            club_match = n["target_club"] == "ALL" or n["target_club"] in user_clubs

            if n["urgency"] == "critical":
                if n["target_dept"] != "ALL" and n["target_dept"] != user["department"]:
                    continue
                if n["target_batch"] != "ALL" and n["target_batch"] != user["batch"]:
                    continue
                if n["target_section"] != "ALL" and n["target_section"] != user["section"]:
                    continue
            elif n["target_club"] != "ALL":
                if not club_match:
                    continue
            elif n["target_hall"] != "ALL":
                if not hall_match:
                    continue
            else:
                if not (dept_match and batch_match and section_match):
                    continue

        filtered.append(n)

    # ---------- Calm, action-first ranking ----------
    # A feed should answer “what needs me now?” before “what is merely new?”.
    # Keep the number of priority tiers intentionally small so people do not
    # have to decode a noisy scoring system.
    now = datetime.now(timezone.utc)

    def deadline_timestamp(value):
        if not value:
            return None
        try:
            parsed = datetime.fromisoformat(value)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.timestamp()
        except (TypeError, ValueError):
            return None

    def created_timestamp(value):
        return deadline_timestamp(value) or 0

    for n in filtered:
        deadline_ts = deadline_timestamp(n.get("deadline_at"))
        hours_to_deadline = ((deadline_ts - now.timestamp()) / 3600) if deadline_ts else None
        needs_ack = bool(n["requires_acknowledgment"] and not n["user_acknowledged"])

        if n["urgency"] == "critical" and needs_ack:
            priority, attention = 0, "Action needed"
        elif hours_to_deadline is not None and 0 <= hours_to_deadline <= 24:
            priority, attention = 1, "Action needed"
        elif needs_ack:
            priority, attention = 2, "Action needed"
        elif hours_to_deadline is not None and 0 <= hours_to_deadline <= 72:
            priority, attention = 3, "Coming up"
        else:
            priority, attention = 4, "Latest updates"

        n["priority_rank"] = priority
        n["attention_group"] = attention
        n["_deadline_timestamp"] = deadline_ts or float("inf")
        n["_created_timestamp"] = created_timestamp(n.get("created_at"))

    # ---------- Sort ----------
    if feed_type == "deadlines":
        filtered.sort(key=lambda x: (x["_deadline_timestamp"], -x["_created_timestamp"]))
    else:
        filtered.sort(key=lambda x: (
            x["priority_rank"],
            x["_deadline_timestamp"] if x["priority_rank"] in (1, 3) else float("inf"),
            -x["_created_timestamp"],
        ))

    for n in filtered:
        n.pop("_deadline_timestamp", None)
        n.pop("_created_timestamp", None)

    # ---------- Metrics ----------
    noise_filtered_out = max(0, total_count - len(filtered))
    noise_pct = round((noise_filtered_out / total_count) * 100) if total_count else 0

    return jsonify({
        "announcements": filtered,
        "metrics": {
            "totalCampusNotices": total_count,
            "filteredCount": len(filtered),
            "noiseFilteredOut": noise_filtered_out,
            "noiseReductionPercent": noise_pct,
        },
    })


# ---------------------------------------------------------------------------
# API: POST /api/announcements  (Publish New Notice)
# ---------------------------------------------------------------------------
@app.route("/api/announcements", methods=["POST"])
def create_announcement():
    body = request.get_json(force=True)

    title = (body.get("title") or "").strip()
    content = (body.get("content") or "").strip()
    if not title or not content:
        return jsonify({"error": "Title and content are required"}), 400

    urgency = body.get("urgency", "medium")
    category = body.get("category", "academics")
    summary_tldr = (body.get("summary_tldr") or "").strip() or (content[:140] + "...")
    target_dept = body.get("target_dept", "ALL")
    target_batch = body.get("target_batch", "ALL")
    target_section = body.get("target_section", "ALL")
    target_club = body.get("target_club", "ALL")
    target_hall = body.get("target_hall", "ALL")
    publisher_id = body.get("publisher_id", 3)
    publisher_name = body.get("publisher_name", "Faculty / CR")
    publisher_role = body.get("publisher_role", "Official Publisher")
    is_verified = 1 if body.get("is_verified") else 0
    requires_ack = 1 if body.get("requires_acknowledgment") else (1 if urgency == "critical" else 0)
    deadline_at = body.get("deadline_at")
    action_label = body.get("action_label")
    action_url = body.get("action_url")
    location_change = body.get("location_change")
    created_at = datetime.now(timezone.utc).isoformat()

    conn = get_db()
    cur = conn.execute(
        """INSERT INTO announcements
           (title, content, summary_tldr, category, urgency,
            target_dept, target_batch, target_section, target_club, target_hall,
            publisher_id, publisher_name, publisher_role,
            is_verified, requires_acknowledgment, deadline_at,
            action_label, action_url, location_change, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (title, content, summary_tldr, category, urgency,
         target_dept, target_batch, target_section, target_club, target_hall,
         publisher_id, publisher_name, publisher_role,
         is_verified, requires_ack, deadline_at,
         action_label, action_url, location_change, created_at),
    )
    if USING_POSTGRES:
        new_id = cur.execute("SELECT LASTVAL() AS id").fetchone()["id"]
    else:
        new_id = cur.lastrowid
    conn.commit()

    created_notice = row_to_dict(
        conn.execute("SELECT * FROM announcements WHERE id = ?", (new_id,)).fetchone()
    )
    conn.close()

    # Broadcast via WebSocket
    broadcast({"type": "NEW_ANNOUNCEMENT", "announcement": created_notice})
    send_push_for_notice(created_notice)

    return jsonify({"success": True, "announcement": created_notice}), 201


# ---------------------------------------------------------------------------
# API: POST /api/announcements/<id>/acknowledge
# ---------------------------------------------------------------------------
@app.route("/api/announcements/<int:ann_id>/acknowledge", methods=["POST"])
def acknowledge(ann_id):
    body = request.get_json(force=True)
    uid = int(body.get("user_id", 0))

    conn = get_db()
    exists = conn.execute(
        "SELECT 1 FROM acknowledgments WHERE announcement_id = ? AND user_id = ?",
        (ann_id, uid),
    ).fetchone()

    if not exists:
        conn.execute(
            "INSERT INTO acknowledgments (announcement_id, user_id) VALUES (?,?)",
            (ann_id, uid),
        )
        conn.commit()

    count = conn.execute(
        "SELECT COUNT(*) FROM acknowledgments WHERE announcement_id = ?",
        (ann_id,),
    ).fetchone()[0]
    conn.close()

    broadcast({
        "type": "ACKNOWLEDGMENT_UPDATE",
        "announcement_id": ann_id,
        "ack_count": count,
        "user_id": uid,
    })

    return jsonify({"success": True, "ack_count": count})


# ---------------------------------------------------------------------------
# API: POST /api/announcements/<id>/bookmark
# ---------------------------------------------------------------------------
@app.route("/api/announcements/<int:ann_id>/bookmark", methods=["POST"])
def toggle_bookmark(ann_id):
    body = request.get_json(force=True)
    uid = int(body.get("user_id", 0))

    conn = get_db()
    exists = conn.execute(
        "SELECT 1 FROM bookmarks WHERE announcement_id = ? AND user_id = ?",
        (ann_id, uid),
    ).fetchone()

    if exists:
        conn.execute(
            "DELETE FROM bookmarks WHERE announcement_id = ? AND user_id = ?",
            (ann_id, uid),
        )
        bookmarked = False
    else:
        conn.execute(
            "INSERT INTO bookmarks (announcement_id, user_id) VALUES (?,?)",
            (ann_id, uid),
        )
        bookmarked = True

    conn.commit()
    conn.close()
    return jsonify({"success": True, "bookmarked": bookmarked})


# ---------------------------------------------------------------------------
# API: GET /api/digest  (Morning Briefing)
# ---------------------------------------------------------------------------
@app.route("/api/digest", methods=["GET"])
def morning_digest():
    user_id = int(request.args.get("user_id", "1"))

    conn = get_db()
    user = row_to_dict(
        conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    )
    if not user:
        conn.close()
        return "User not found", 404

    user_clubs = json.loads(user.get("clubs") or "[]")

    # Critical alerts
    critical = rows_to_list(conn.execute("""
        SELECT * FROM announcements
        WHERE urgency = 'critical'
          AND (target_dept = 'ALL' OR target_dept = ?)
          AND (target_batch = 'ALL' OR target_batch = ?)
          AND (target_section = 'ALL' OR target_section = ?)
    """, (user["department"], user["batch"], user["section"])).fetchall())

    # Deadlines within 72 hours
    now_iso = datetime.now(timezone.utc).isoformat()
    in_three_days = (datetime.now(timezone.utc) + timedelta(hours=72)).isoformat()
    deadlines = rows_to_list(conn.execute("""
        SELECT * FROM announcements
        WHERE deadline_at IS NOT NULL
          AND deadline_at >= ?
          AND deadline_at <= ?
          AND (target_dept = 'ALL' OR target_dept = ?)
        ORDER BY deadline_at ASC
    """, (now_iso, in_three_days, user["department"])).fetchall())

    # Department & Academic highlights
    dept_notices = rows_to_list(conn.execute("""
        SELECT * FROM announcements
        WHERE (target_dept = ? OR (target_dept = 'ALL' AND is_verified = 1))
          AND urgency IN ('high', 'medium')
        ORDER BY created_at DESC
        LIMIT 3
    """, (user["department"],)).fetchall())

    # Club highlights
    club_notices = rows_to_list(conn.execute("""
        SELECT * FROM announcements
        WHERE category = 'clubs'
        ORDER BY created_at DESC
        LIMIT 2
    """).fetchall())

    conn.close()

    # Executive summary
    summary = f"Good morning, {user['name']}! "
    if critical:
        summary += f"⚠️ Attention: You have {len(critical)} urgent room relocation/critical alert today. "
    else:
        summary += "✨ No last-minute room relocations or critical cancellations today. "
    if deadlines:
        summary += f"You have {len(deadlines)} approaching deadline(s) over the next 72 hours. "
    summary += f"Here is your noise-free digest for {user['department']} Batch {user['batch']} (Section {user['section']})."

    return jsonify({
        "user": {
            "name": user["name"],
            "department": user["department"],
            "batch": user["batch"],
            "section": user["section"],
            "hall": user["hall"],
        },
        "executiveSummary": summary,
        "criticalAlerts": critical,
        "upcomingDeadlines": deadlines,
        "departmentNotices": dept_notices,
        "clubHighlights": club_notices,
    })


# ---------------------------------------------------------------------------
# API: GET /api/export-ics/<id>  (iCalendar .ics download)
# ---------------------------------------------------------------------------
@app.route("/api/export-ics/<int:ann_id>", methods=["GET"])
def export_ics(ann_id):
    conn = get_db()
    notice = row_to_dict(
        conn.execute("SELECT * FROM announcements WHERE id = ?", (ann_id,)).fetchone()
    )
    conn.close()

    if not notice or not notice.get("deadline_at"):
        return "Event deadline not found", 404

    d = datetime.fromisoformat(notice["deadline_at"])
    dtstamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dtstart = d.strftime("%Y%m%dT%H%M%SZ")
    d_end = d + timedelta(hours=1)
    dtend = d_end.strftime("%Y%m%dT%H%M%SZ")

    title_clean = notice["title"].replace("\r", " ").replace("\n", " ")
    desc_clean = notice["summary_tldr"].replace("\r", " ").replace("\n", " ")
    location = notice.get("location_change") or "KUET Campus"

    ics = "\r\n".join([
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//CampusPulse//KUET Hackathon//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        f"UID:campuspulse-{notice['id']}@kuet.ac.bd",
        f"DTSTAMP:{dtstamp}",
        f"DTSTART:{dtstart}",
        f"DTEND:{dtend}",
        f"SUMMARY:{title_clean}",
        f"DESCRIPTION:{desc_clean}",
        f"LOCATION:{location}",
        "STATUS:CONFIRMED",
        "END:VEVENT",
        "END:VCALENDAR",
    ])

    return Response(
        ics,
        mimetype="text/calendar; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="deadline-{ann_id}.ics"',
        },
    )


# ---------------------------------------------------------------------------
# Static File Serving  (public/ directory)
# ---------------------------------------------------------------------------
MIME_MAP = {
    ".html": "text/html; charset=UTF-8",
    ".css":  "text/css; charset=UTF-8",
    ".js":   "application/javascript; charset=UTF-8",
    ".json": "application/json; charset=UTF-8",
    ".svg":  "image/svg+xml",
    ".png":  "image/png",
    ".ico":  "image/x-icon",
}


@app.route("/")
def serve_index():
    return send_from_directory(PUBLIC_DIR, "index.html")


@app.route("/<path:filename>")
def serve_static(filename):
    filepath = os.path.join(PUBLIC_DIR, filename)
    if os.path.isfile(filepath):
        return send_from_directory(PUBLIC_DIR, filename)
    # SPA fallback
    return send_from_directory(PUBLIC_DIR, "index.html")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"[START] CampusPulse Server running on port {port}")
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
