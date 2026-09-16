import { DatabaseSync } from "node:sqlite";

// Path to SQLite database file
const DB_FILE = "campuspulse.sqlite";
export const db = new DatabaseSync(DB_FILE);

// Initialize schema
export function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      avatar TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL,
      department TEXT NOT NULL,
      batch TEXT NOT NULL,
      section TEXT NOT NULL,
      hall TEXT NOT NULL,
      clubs TEXT NOT NULL, -- JSON array
      courses TEXT NOT NULL, -- JSON array
      noise_filter TEXT DEFAULT 'balanced',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      summary_tldr TEXT NOT NULL,
      category TEXT NOT NULL, -- academics, clubs, admin, career, hall, community
      urgency TEXT NOT NULL, -- critical, high, medium, low
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
  `);

  // Check if users exist; if not, seed realistic data
  const userCountStmt = db.prepare("SELECT COUNT(*) as count FROM users");
  const userCount = (userCountStmt.get() as { count: number }).count;

  if (userCount === 0) {
    seedDatabase();
  }
}

function seedDatabase() {
  console.log("🌱 Seeding CampusPulse database with realistic university data...");

  // Seed Personas
  const insertUser = db.prepare(`
    INSERT INTO users (id, name, avatar, email, role, department, batch, section, hall, clubs, courses, noise_filter)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertUser.run(
    1,
    "Arafat Rahman",
    "https://api.dicebear.com/7.x/bottts/svg?seed=Arafat",
    "arafat.cse21@kuet.ac.bd",
    "student",
    "CSE",
    "21",
    "A",
    "Lalon Shah Hall",
    JSON.stringify(["Cyber Security Club", "KUET Programming Club"]),
    JSON.stringify(["CSE-3101", "CSE-3103", "MATH-3101"]),
    "balanced"
  );

  insertUser.run(
    2,
    "Tasnim Islam",
    "https://api.dicebear.com/7.x/bottts/svg?seed=Tasnim",
    "tasnim.eee23@kuet.ac.bd",
    "student",
    "EEE",
    "23",
    "B",
    "Rokeya Hall",
    JSON.stringify(["KUET Robotics Club", "Debating Society"]),
    JSON.stringify(["EEE-2201", "EEE-2202", "PHY-2201"]),
    "balanced"
  );

  insertUser.run(
    3,
    "Dr. Farhan Tanvir",
    "https://api.dicebear.com/7.x/bottts/svg?seed=Farhan",
    "farhan@cse.kuet.ac.bd",
    "faculty",
    "CSE",
    "ALL",
    "ALL",
    "Faculty Quarters",
    JSON.stringify([]),
    JSON.stringify(["CSE-3101"]),
    "strict"
  );

  insertUser.run(
    4,
    "Tanveer Hasan (CR)",
    "https://api.dicebear.com/7.x/bottts/svg?seed=TanveerCR",
    "cr.cse21a@kuet.ac.bd",
    "cr",
    "CSE",
    "21",
    "A",
    "Khan Jahan Ali Hall",
    JSON.stringify(["KUET Programming Club"]),
    JSON.stringify(["CSE-3101", "CSE-3103"]),
    "strict"
  );

  insertUser.run(
    5,
    "Sabbir Ahmed",
    "https://api.dicebear.com/7.x/bottts/svg?seed=Sabbir",
    "sabbir.me22@kuet.ac.bd",
    "student",
    "ME",
    "22",
    "A",
    "Amar Ekushey Hall",
    JSON.stringify(["Sports Club", "Automobile Club"]),
    JSON.stringify(["ME-2201", "MATH-2201"]),
    "all"
  );

  // Dynamic timestamps for realistic upcoming deadlines
  const now = new Date();
  const inHours = (h: number) => new Date(now.getTime() + h * 3600 * 1000).toISOString();
  const pastMinutes = (m: number) => new Date(now.getTime() - m * 60 * 1000).toISOString();

  // Seed Announcements
  const insertNotice = db.prepare(`
    INSERT INTO announcements (
      title, content, summary_tldr, category, urgency,
      target_dept, target_batch, target_section, target_club, target_hall,
      publisher_id, publisher_name, publisher_role,
      is_verified, requires_acknowledgment, deadline_at,
      action_label, action_url, location_change, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // 1. Critical classroom relocation (Matches prompt: "A student wakes up and discovers that the class location changed")
  insertNotice.run(
    "🚨 CRITICAL: CSE-3101 Database Class Relocated to NAB-405",
    "Attention 3rd Year CSE Section A: Due to an unexpected multimedia projector malfunction in Room 302, today's 10:00 AM Database Systems lecture by Dr. Farhan Tanvir will be held in New Academic Building, Room 405 (NAB-405). Please arrive on time as attendance will be recorded digitally at the start.",
    "Class moved from Room 302 to NAB-405 today at 10:00 AM due to hardware failure. Please confirm acknowledgment.",
    "academics",
    "critical",
    "CSE",
    "21",
    "A",
    "ALL",
    "ALL",
    3,
    "Dr. Farhan Tanvir",
    "Course Teacher / Associate Professor",
    1,
    1,
    inHours(2),
    "View Room on Map",
    "#campus-map",
    "CSE Room 302 ➔ NAB-405",
    pastMinutes(25)
  );

  // 2. Buried club registration deadline (Matches prompt: "missed a club registration because announcement was buried in group chat")
  insertNotice.run(
    "⏳ KUET Cyber HackFest 2026: Team Registration Closes in 24 Hours",
    "Registration for the 48-hour National Cyber HackFest 2026 closes tomorrow at 11:59 PM. We have only 15 slots remaining across university teams. Cash prize pool: 150,000 BDT. Make sure your 3-member squad includes at least one reverse-engineering specialist. Don't let this slip by in your chat feeds!",
    "Final 15 slots remaining. Team registration ends tomorrow at 11:59 PM. 150k BDT prize pool.",
    "clubs",
    "high",
    "ALL",
    "ALL",
    "ALL",
    "Cyber Security Club",
    "ALL",
    1,
    "Cyber Security Club Exec",
    "Club Organizers",
    1,
    0,
    inHours(24),
    "Register Squad",
    "https://cyberhackfest.kuet.ac.bd",
    null,
    pastMinutes(180)
  );

  // 3. EEE Lab Reschedule
  insertNotice.run(
    "⚡ EEE-2202 Circuit Lab Section B Shifted to 2:30 PM",
    "Due to scheduled power grid maintenance on the 3rd floor East Wing, the morning lab session for EEE Batch 23 Section B is rescheduled to 2:30 PM today in Analog Lab 2.",
    "EEE Batch 23 Sec B lab shifted from 10:30 AM to 2:30 PM today.",
    "academics",
    "high",
    "EEE",
    "23",
    "B",
    "ALL",
    "ALL",
    2,
    "Engr. Kamrul Hasan",
    "Lab In-Charge",
    1,
    1,
    inHours(4),
    "Acknowledge Change",
    null,
    "East Wing Lab ➔ Analog Lab 2",
    pastMinutes(55)
  );

  // 4. Academic Coursework Deadline
  insertNotice.run(
    "📝 CSE-3103 Operating Systems: Kernel Module Project Submission",
    "All CSE 21 Batch students must submit their Phase 1 custom Linux kernel scheduling module source code with Makefile and brief test documentation via the university LMS portal. Late submissions will incur a 10% penalty per day.",
    "Submit kernel module code + Makefile by Sunday 5:00 PM on LMS. No email submissions.",
    "academics",
    "high",
    "CSE",
    "21",
    "ALL",
    "ALL",
    "ALL",
    4,
    "Tanveer Hasan (CR)",
    "Class Representative",
    1,
    0,
    inHours(48),
    "Open LMS Portal",
    "https://lms.kuet.ac.bd/course/cse3103",
    null,
    pastMinutes(360)
  );

  // 5. Official University Notice (Library)
  insertNotice.run(
    "📚 KUET Central Library: 24/7 Reading Room Open for Mid-Term Exams",
    "The Central Library Committee announces that the Air-Conditioned Study Hall on the 2nd floor will remain accessible 24/7 starting this Saturday until the end of Semester Mid-Terms. High-speed Wi-Fi and power outlets have been upgraded across 200 study cubicles.",
    "2nd Floor Study Hall open 24/7 starting Saturday through Mid-terms. Wi-Fi & outlets upgraded.",
    "admin",
    "medium",
    "ALL",
    "ALL",
    "ALL",
    "ALL",
    "ALL",
    3,
    "Registrar Office",
    "Central Administration",
    1,
    0,
    null,
    "Check Library Guidelines",
    "#library",
    null,
    pastMinutes(720)
  );

  // 6. Robotics Workshop
  insertNotice.run(
    "🤖 Hands-On ROS 2 & Autonomous Mobile Robots Workshop",
    "KUET Robotics Club proudly presents a two-weekend intensive workshop on Robot Operating System 2 (ROS 2 Humble), LiDAR mapping, and SLAM navigation. Hardware kits provided for hands-on sessions. Limited to 40 participants.",
    "2-weekend hands-on ROS 2 and SLAM robotics boot camp. Kits provided. 40 seats max.",
    "clubs",
    "medium",
    "ALL",
    "ALL",
    "ALL",
    "KUET Robotics Club",
    "ALL",
    2,
    "KUET Robotics Club",
    "Executive Committee",
    1,
    0,
    inHours(72),
    "Apply for Seat",
    "https://robotics.kuet.ac.bd/ros2",
    null,
    pastMinutes(840)
  );

  // 7. Hall Notice (Lalon Shah Hall)
  insertNotice.run(
    "🏸 Lalon Shah Hall Annual Badminton Championship 2026",
    "Fixtures for the Singles and Doubles tournaments are posted on the hall ground floor board. First round matches commence Thursday evening after Maghrib prayer. Non-marking shoes mandatory.",
    "Hall badminton tournament begins Thursday evening. Check ground floor board for fixtures.",
    "hall",
    "low",
    "ALL",
    "ALL",
    "ALL",
    "ALL",
    "Lalon Shah Hall",
    1,
    "Hall Sports Secretary",
    "Student Cabinet",
    0,
    0,
    inHours(36),
    "View Bracket",
    "#hall-sports",
    null,
    pastMinutes(1200)
  );

  // 8. Campus Community / Lost & Found
  insertNotice.run(
    "🔍 Found: Casio fx-991EX ClassWiz in Auditorium 2",
    "Found during yesterday's 4:00 PM session on row G seat 14. Has a small carbon fiber skin sticker on the back cover. The rightful owner can reclaim it from the Student Welfare Center by verifying the sticker detail.",
    "Found Casio fx-991EX calculator in Audi 2. Reclaim at DSW office with proof.",
    "community",
    "low",
    "ALL",
    "ALL",
    "ALL",
    "ALL",
    "ALL",
    5,
    "Sabbir Ahmed",
    "Student",
    0,
    0,
    null,
    "Contact DSW",
    "#dsw",
    null,
    pastMinutes(1440)
  );

  // Seed sample acknowledgments for notice #1 (to show social proof of reach)
  db.prepare("INSERT INTO acknowledgments (announcement_id, user_id) VALUES (?, ?)").run(1, 4); // CR acknowledged
  db.prepare("INSERT INTO acknowledgments (announcement_id, user_id) VALUES (?, ?)").run(1, 1); // Arafat acknowledged

  console.log("✅ Seed completed successfully.");
}
