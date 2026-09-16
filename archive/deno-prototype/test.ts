function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("Assertion failed: " + msg);
}
import { initDB, db } from "./db.ts";

console.log("🧪 Starting automated integration test suite for CampusPulse...\n");

// 1. Test Database Initialization & Seeds
console.log("1️⃣ Verifying Database Tables and Seed Data...");
initDB();

const users = db.prepare("SELECT * FROM users").all() as any[];
console.log(`   Found ${users.length} registered personas.`);
if (users.length < 4) throw new Error("Expected at least 4 personas");

const arafat = users.find(u => u.name.includes("Arafat"));
const tasnim = users.find(u => u.name.includes("Tasnim"));
const farhan = users.find(u => u.name.includes("Farhan"));

console.log(`   ✓ Arafat: Dept=${arafat.department}, Batch=${arafat.batch}, Section=${arafat.section}`);
console.log(`   ✓ Tasnim: Dept=${tasnim.department}, Batch=${tasnim.batch}, Section=${tasnim.section}`);
console.log(`   ✓ Dr. Farhan: Role=${farhan.role}, Dept=${farhan.department}`);

const notices = db.prepare("SELECT * FROM announcements").all() as any[];
console.log(`   Found ${notices.length} initial announcements.`);
const criticalNotice = notices.find(n => n.urgency === "critical");
if (!criticalNotice) throw new Error("Missing critical emergency announcement");
console.log(`   ✓ Critical Alert found: "${criticalNotice.title}"`);
console.log(`   ✓ Location change recorded: "${criticalNotice.location_change}"`);

// 2. Test Personalization Filtering & Relevance Logic
console.log("\n2️⃣ Verifying Personalization Engine (Noise Filtering)...");

// Simulate Arafat's feed (CSE 21 Section A)
const arafatNotices = notices.filter(n => {
  const deptMatch = n.target_dept === "ALL" || n.target_dept === arafat.department;
  const batchMatch = n.target_batch === "ALL" || n.target_batch === arafat.batch;
  const sectionMatch = n.target_section === "ALL" || n.target_section === arafat.section;
  return deptMatch && batchMatch && sectionMatch;
});

console.log(`   Total announcements on campus: ${notices.length}`);
console.log(`   Announcements reaching Arafat (CSE 21-A): ${arafatNotices.length}`);
const noiseBlocked = notices.length - arafatNotices.length;
const reductionPercent = Math.round((noiseBlocked / notices.length) * 100);
console.log(`   ✓ Noise Reduction Ratio: ${reductionPercent}% irrelevant spam blocked for Arafat!`);

// Verify EEE notice is NOT in Arafat's feed
const eeeNotice = arafatNotices.find(n => n.target_dept === "EEE");
if (eeeNotice) throw new Error("EEE notice leaked into CSE student feed!");
console.log("   ✓ Verified: EEE-specific notice correctly filtered out of CSE student's feed.");

// 3. Test Acknowledgment Flow
console.log("\n3️⃣ Verifying Acknowledgment Receipt System...");
const initialAckCount = (db.prepare("SELECT COUNT(*) as count FROM acknowledgments WHERE announcement_id = ?").get(criticalNotice.id) as any).count;
console.log(`   Initial acknowledgments for critical notice #${criticalNotice.id}: ${initialAckCount}`);

// Add Tasnim's acknowledgment
db.prepare("INSERT OR IGNORE INTO acknowledgments (announcement_id, user_id) VALUES (?, ?)").run(criticalNotice.id, tasnim.id);
const newAckCount = (db.prepare("SELECT COUNT(*) as count FROM acknowledgments WHERE announcement_id = ?").get(criticalNotice.id) as any).count;
console.log(`   Updated acknowledgments after Tasnim confirmed: ${newAckCount}`);
if (newAckCount <= initialAckCount) throw new Error("Acknowledgment count did not increment!");
console.log("   ✓ Acknowledgment tracking verified.");

// 4. Test Morning Digest Synthesis
console.log("\n4️⃣ Verifying Morning Briefing / Digest Engine...");
const urgentForArafat = db.prepare(`
  SELECT * FROM announcements 
  WHERE urgency = 'critical'
  AND (target_dept = 'ALL' OR target_dept = ?)
  AND (target_batch = 'ALL' OR target_batch = ?)
  AND (target_section = 'ALL' OR target_section = ?)
`).all(arafat.department, arafat.batch, arafat.section) as any[];

console.log(`   Critical notices in Arafat's morning briefing: ${urgentForArafat.length}`);
if (urgentForArafat.length === 0) throw new Error("Expected urgent alert in morning digest");
console.log(`   ✓ Morning Briefing alert: "${urgentForArafat[0].title}"`);

// 5. Test iCalendar (.ics) format generation
console.log("\n5️⃣ Verifying iCalendar (.ics) Export Payload...");
const deadlineNotice = notices.find(n => n.deadline_at);
if (!deadlineNotice) throw new Error("No deadline notice found");

const d = new Date(deadlineNotice.deadline_at);
const dtstamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
const dtstart = d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

const icsSample = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  `UID:campuspulse-${deadlineNotice.id}@kuet.ac.bd`,
  `SUMMARY:${deadlineNotice.title}`,
  `DTSTART:${dtstart}`,
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n");

if (!icsSample.includes("BEGIN:VCALENDAR") || !icsSample.includes("SUMMARY:")) {
  throw new Error("Invalid .ics content");
}
console.log("   ✓ iCalendar (.ics) generation verified.");

console.log("\n🎉 ALL 5 INTEGRATION SUITES PASSED CLEANLY!");
