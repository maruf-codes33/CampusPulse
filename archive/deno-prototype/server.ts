import { initDB, db } from "./db.ts";

// Initialize database
initDB();

const PORT = 8000;
const clients = new Set<WebSocket>();

// Helper: Broadcast to all active WebSocket clients
function broadcast(message: object) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(data);
      } catch (err) {
        console.error("Failed to send WebSocket message:", err);
      }
    }
  }
}

// MIME types for static files
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=UTF-8",
  ".css": "text/css; charset=UTF-8",
  ".js": "application/javascript; charset=UTF-8",
  ".json": "application/json; charset=UTF-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Start Deno HTTP server
Deno.serve({ port: PORT }, async (req: Request) => {
  const url = new URL(req.url);
  const pathname = url.pathname;

  // Handle WebSocket upgrades
  if (pathname === "/ws") {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => {
      clients.add(socket);
    };
    socket.onclose = () => {
      clients.delete(socket);
    };
    socket.onerror = (e) => {
      console.error("WebSocket error:", e);
      clients.delete(socket);
    };
    return response;
  }

  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // -------------------------------------------------------------
    // API: GET /api/users
    // -------------------------------------------------------------
    if (pathname === "/api/users" && req.method === "GET") {
      const users = db.prepare("SELECT * FROM users ORDER BY id ASC").all();
      return Response.json(users, { headers: corsHeaders });
    }

    // -------------------------------------------------------------
    // API: GET /api/users/:id
    // -------------------------------------------------------------
    if (pathname.startsWith("/api/users/") && req.method === "GET") {
      const id = parseInt(pathname.replace("/api/users/", ""), 10);
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
      if (!user) return new Response("User not found", { status: 404, headers: corsHeaders });
      return Response.json(user, { headers: corsHeaders });
    }

    // -------------------------------------------------------------
    // API: PUT /api/users/:id/preferences
    // -------------------------------------------------------------
    if (pathname.startsWith("/api/users/") && pathname.endsWith("/preferences") && req.method === "PUT") {
      const parts = pathname.split("/");
      const id = parseInt(parts[3], 10);
      const body = await req.json();
      if (body.noise_filter) {
        db.prepare("UPDATE users SET noise_filter = ? WHERE id = ?").run(body.noise_filter, id);
      }
      return Response.json({ success: true }, { headers: corsHeaders });
    }

    // -------------------------------------------------------------
    // API: GET /api/announcements
    // -------------------------------------------------------------
    if (pathname === "/api/announcements" && req.method === "GET") {
      const userId = parseInt(url.searchParams.get("user_id") || "1", 10);
      const feedType = url.searchParams.get("feed_type") || "for_me"; // for_me, all, deadlines, official, bookmarks
      const urgencyFilter = url.searchParams.get("urgency") || "balanced"; // strict, balanced, all
      const categoryFilter = url.searchParams.get("category") || "all";
      const search = (url.searchParams.get("search") || "").trim().toLowerCase();

      // Retrieve user for personalization
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
      if (!user) return new Response("User not found", { status: 404, headers: corsHeaders });

      const userClubs: string[] = JSON.parse(user.clubs || "[]");

      // Fetch all announcements
      const allNotices = db.prepare(`
        SELECT a.*,
          (SELECT COUNT(*) FROM acknowledgments WHERE announcement_id = a.id) as ack_count,
          (SELECT COUNT(*) FROM acknowledgments WHERE announcement_id = a.id AND user_id = ?) as user_acknowledged,
          (SELECT COUNT(*) FROM bookmarks WHERE announcement_id = a.id AND user_id = ?) as user_bookmarked
        FROM announcements a
        ORDER BY a.created_at DESC
      `).all(userId, userId) as any[];

      const totalAnnouncementsCount = allNotices.length;

      // Filter and score announcements
      let filtered = allNotices.filter((n) => {
        // Search query
        if (search) {
          const matchSearch =
            n.title.toLowerCase().includes(search) ||
            n.content.toLowerCase().includes(search) ||
            n.summary_tldr.toLowerCase().includes(search) ||
            n.publisher_name.toLowerCase().includes(search);
          if (!matchSearch) return false;
        }

        // Category filter
        if (categoryFilter !== "all" && n.category !== categoryFilter) {
          return false;
        }

        // Bookmarks feed
        if (feedType === "bookmarks") {
          return n.user_bookmarked > 0;
        }

        // Official feed
        if (feedType === "official") {
          if (!n.is_verified) return false;
        }

        // Deadlines feed
        if (feedType === "deadlines") {
          if (!n.deadline_at) return false;
        }

        // Urgency filter logic
        if (urgencyFilter === "strict") {
          // Only critical & high
          if (n.urgency !== "critical" && n.urgency !== "high") return false;
        } else if (urgencyFilter === "balanced") {
          // Critical, high, medium (filters out low noise)
          if (n.urgency === "low" && feedType === "for_me") return false;
        }

        // Personalization for "for_me" feed
        if (feedType === "for_me") {
          // If faculty or CR, they also want to see their published notices or dept notices
          const deptMatch = n.target_dept === "ALL" || n.target_dept === user.department;
          const batchMatch = n.target_batch === "ALL" || n.target_batch === user.batch;
          const sectionMatch = n.target_section === "ALL" || n.target_section === user.section;
          const hallMatch = n.target_hall === "ALL" || n.target_hall === user.hall;
          const clubMatch = n.target_club === "ALL" || userClubs.includes(n.target_club);

          // If it's a critical campus-wide alert, always show
          if (n.urgency === "critical") {
            // If it has specific dept/batch/sec targeting, must match user
            if (n.target_dept !== "ALL" && n.target_dept !== user.department) return false;
            if (n.target_batch !== "ALL" && n.target_batch !== user.batch) return false;
            if (n.target_section !== "ALL" && n.target_section !== user.section) return false;
            return true;
          }

          // If targeted by club
          if (n.target_club !== "ALL") {
            return clubMatch;
          }

          // If targeted by hall
          if (n.target_hall !== "ALL") {
            return hallMatch;
          }

          // Standard academic or dept targeting
          return deptMatch && batchMatch && sectionMatch;
        }

        return true;
      });

      // Calculate personalization relevance score and sort
      filtered = filtered.map((n) => {
        let score = 0;
        // Urgency weight
        if (n.urgency === "critical") score += 100;
        else if (n.urgency === "high") score += 60;
        else if (n.urgency === "medium") score += 30;
        else score += 10;

        // Specific targeting weight (hyper-relevance)
        if (n.target_section === user.section && n.target_section !== "ALL") score += 40;
        if (n.target_batch === user.batch && n.target_batch !== "ALL") score += 30;
        if (n.target_dept === user.department && n.target_dept !== "ALL") score += 20;
        if (n.target_club !== "ALL" && userClubs.includes(n.target_club)) score += 35;
        if (n.target_hall === user.hall && n.target_hall !== "ALL") score += 25;

        // Imminent deadline bonus
        if (n.deadline_at) {
          const diffHours = (new Date(n.deadline_at).getTime() - Date.now()) / (3600 * 1000);
          if (diffHours > 0 && diffHours <= 24) score += 45;
          else if (diffHours > 0 && diffHours <= 48) score += 25;
        }

        // Verified source bonus
        if (n.is_verified) score += 15;

        // Unacknowledged critical item needs immediate attention
        if (n.requires_acknowledgment && !n.user_acknowledged) score += 50;

        return { ...n, relevance_score: score };
      });

      // Sort logic
      if (feedType === "deadlines") {
        filtered.sort((a, b) => {
          const timeA = a.deadline_at ? new Date(a.deadline_at).getTime() : Infinity;
          const timeB = b.deadline_at ? new Date(b.deadline_at).getTime() : Infinity;
          return timeA - timeB;
        });
      } else {
        // Sort by relevance score descending, then created_at descending
        filtered.sort((a, b) => {
          if (b.urgency === "critical" && a.urgency !== "critical") return 1;
          if (a.urgency === "critical" && b.urgency !== "critical") return -1;
          return b.relevance_score - a.relevance_score;
        });
      }

      // Noise reduction metrics
      const noiseFilteredOut = Math.max(0, totalAnnouncementsCount - filtered.length);
      const noiseReductionPercent = totalAnnouncementsCount > 0
        ? Math.round((noiseFilteredOut / totalAnnouncementsCount) * 100)
        : 0;

      return Response.json({
        announcements: filtered,
        metrics: {
          totalCampusNotices: totalAnnouncementsCount,
          filteredCount: filtered.length,
          noiseFilteredOut,
          noiseReductionPercent,
        },
      }, { headers: corsHeaders });
    }

    // -------------------------------------------------------------
    // API: POST /api/announcements (Publish New Notice)
    // -------------------------------------------------------------
    if (pathname === "/api/announcements" && req.method === "POST") {
      const body = await req.json();

      const title = body.title?.trim();
      const content = body.content?.trim();
      if (!title || !content) {
        return new Response(JSON.stringify({ error: "Title and content are required" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const urgency = body.urgency || "medium";
      const category = body.category || "academics";
      const summary_tldr = body.summary_tldr?.trim() || content.slice(0, 140) + "...";
      const target_dept = body.target_dept || "ALL";
      const target_batch = body.target_batch || "ALL";
      const target_section = body.target_section || "ALL";
      const target_club = body.target_club || "ALL";
      const target_hall = body.target_hall || "ALL";
      const publisher_id = body.publisher_id || 3;
      const publisher_name = body.publisher_name || "Faculty / CR";
      const publisher_role = body.publisher_role || "Official Publisher";
      const is_verified = body.is_verified ? 1 : 0;
      const requires_acknowledgment = body.requires_acknowledgment ? 1 : (urgency === "critical" ? 1 : 0);
      const deadline_at = body.deadline_at || null;
      const action_label = body.action_label || null;
      const action_url = body.action_url || null;
      const location_change = body.location_change || null;
      const created_at = new Date().toISOString();

      const insertStmt = db.prepare(`
        INSERT INTO announcements (
          title, content, summary_tldr, category, urgency,
          target_dept, target_batch, target_section, target_club, target_hall,
          publisher_id, publisher_name, publisher_role,
          is_verified, requires_acknowledgment, deadline_at,
          action_label, action_url, location_change, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const res = insertStmt.run(
        title, content, summary_tldr, category, urgency,
        target_dept, target_batch, target_section, target_club, target_hall,
        publisher_id, publisher_name, publisher_role,
        is_verified, requires_acknowledgment, deadline_at,
        action_label, action_url, location_change, created_at
      );

      const newId = Number(res.lastInsertRowid);
      const createdNotice = db.prepare("SELECT * FROM announcements WHERE id = ?").get(newId);

      // Broadcast live event over WebSocket
      broadcast({
        type: "NEW_ANNOUNCEMENT",
        announcement: createdNotice,
      });

      return Response.json({ success: true, announcement: createdNotice }, {
        status: 201,
        headers: corsHeaders,
      });
    }

    // -------------------------------------------------------------
    // API: POST /api/announcements/:id/acknowledge
    // -------------------------------------------------------------
    if (pathname.startsWith("/api/announcements/") && pathname.endsWith("/acknowledge") && req.method === "POST") {
      const parts = pathname.split("/");
      const announcementId = parseInt(parts[3], 10);
      const body = await req.json();
      const userId = parseInt(body.user_id, 10);

      const check = db.prepare("SELECT * FROM acknowledgments WHERE announcement_id = ? AND user_id = ?").get(announcementId, userId);
      if (!check) {
        db.prepare("INSERT INTO acknowledgments (announcement_id, user_id) VALUES (?, ?)").run(announcementId, userId);
      }

      const count = (db.prepare("SELECT COUNT(*) as count FROM acknowledgments WHERE announcement_id = ?").get(announcementId) as any).count;

      broadcast({
        type: "ACKNOWLEDGMENT_UPDATE",
        announcement_id: announcementId,
        ack_count: count,
        user_id: userId,
      });

      return Response.json({ success: true, ack_count: count }, { headers: corsHeaders });
    }

    // -------------------------------------------------------------
    // API: POST /api/announcements/:id/bookmark
    // -------------------------------------------------------------
    if (pathname.startsWith("/api/announcements/") && pathname.endsWith("/bookmark") && req.method === "POST") {
      const parts = pathname.split("/");
      const announcementId = parseInt(parts[3], 10);
      const body = await req.json();
      const userId = parseInt(body.user_id, 10);

      const check = db.prepare("SELECT * FROM bookmarks WHERE announcement_id = ? AND user_id = ?").get(announcementId, userId);
      let bookmarked = false;
      if (check) {
        db.prepare("DELETE FROM bookmarks WHERE announcement_id = ? AND user_id = ?").run(announcementId, userId);
        bookmarked = false;
      } else {
        db.prepare("INSERT INTO bookmarks (announcement_id, user_id) VALUES (?, ?)").run(announcementId, userId);
        bookmarked = true;
      }

      return Response.json({ success: true, bookmarked }, { headers: corsHeaders });
    }

    // -------------------------------------------------------------
    // API: GET /api/digest (Personalized Morning Briefing)
    // -------------------------------------------------------------
    if (pathname === "/api/digest" && req.method === "GET") {
      const userId = parseInt(url.searchParams.get("user_id") || "1", 10);
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
      if (!user) return new Response("User not found", { status: 404, headers: corsHeaders });

      const userClubs: string[] = JSON.parse(user.clubs || "[]");

      // Critical alerts affecting this user
      const criticalNotices = db.prepare(`
        SELECT * FROM announcements
        WHERE urgency = 'critical'
        AND (target_dept = 'ALL' OR target_dept = ?)
        AND (target_batch = 'ALL' OR target_batch = ?)
        AND (target_section = 'ALL' OR target_section = ?)
      `).all(user.department, user.batch, user.section) as any[];

      // Deadlines within next 72 hours
      const now = new Date().toISOString();
      const inThreeDays = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
      const upcomingDeadlines = db.prepare(`
        SELECT * FROM announcements
        WHERE deadline_at IS NOT NULL
        AND deadline_at >= ?
        AND deadline_at <= ?
        AND (target_dept = 'ALL' OR target_dept = ?)
        ORDER BY deadline_at ASC
      `).all(now, inThreeDays, user.department) as any[];

      // Department & Academic highlights
      const deptNotices = db.prepare(`
        SELECT * FROM announcements
        WHERE (target_dept = ? OR (target_dept = 'ALL' AND is_verified = 1))
        AND urgency IN ('high', 'medium')
        ORDER BY created_at DESC
        LIMIT 3
      `).all(user.department) as any[];

      // Club highlights
      const clubNotices = db.prepare(`
        SELECT * FROM announcements
        WHERE category = 'clubs'
        ORDER BY created_at DESC
        LIMIT 2
      `).all() as any[];

      // Synthesize AI-style executive summary
      const urgentCount = criticalNotices.length;
      const deadlineCount = upcomingDeadlines.length;

      let executiveSummary = `Good morning, ${user.name}! `;
      if (urgentCount > 0) {
        executiveSummary += `⚠️ Attention: You have ${urgentCount} urgent room relocation/critical alert today. `;
      } else {
        executiveSummary += `✨ No last-minute room relocations or critical cancellations today. `;
      }
      if (deadlineCount > 0) {
        executiveSummary += `You have ${deadlineCount} approaching deadline(s) over the next 72 hours. `;
      }
      executiveSummary += `Here is your noise-free digest for ${user.department} Batch ${user.batch} (Section ${user.section}).`;

      return Response.json({
        user: {
          name: user.name,
          department: user.department,
          batch: user.batch,
          section: user.section,
          hall: user.hall,
        },
        executiveSummary,
        criticalAlerts: criticalNotices,
        upcomingDeadlines,
        departmentNotices: deptNotices,
        clubHighlights: clubNotices,
      }, { headers: corsHeaders });
    }

    // -------------------------------------------------------------
    // API: GET /api/export-ics/:id (iCalendar .ics export)
    // -------------------------------------------------------------
    if (pathname.startsWith("/api/export-ics/") && req.method === "GET") {
      const id = parseInt(pathname.replace("/api/export-ics/", ""), 10);
      const notice = db.prepare("SELECT * FROM announcements WHERE id = ?").get(id) as any;
      if (!notice || !notice.deadline_at) {
        return new Response("Event deadline not found", { status: 404, headers: corsHeaders });
      }

      const d = new Date(notice.deadline_at);
      const dtstamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
      const dtstart = d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
      const dEnd = new Date(d.getTime() + 3600 * 1000);
      const dtend = dEnd.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

      const ics = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//CampusPulse//KUET Hackathon//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        `UID:campuspulse-${notice.id}@kuet.ac.bd`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART:${dtstart}`,
        `DTEND:${dtend}`,
        `SUMMARY:${notice.title.replace(/[\r\n]/g, " ")}`,
        `DESCRIPTION:${notice.summary_tldr.replace(/[\r\n]/g, " ")}`,
        `LOCATION:${notice.location_change || "KUET Campus"}`,
        "STATUS:CONFIRMED",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      return new Response(ics, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition": `attachment; filename="deadline-${id}.ics"`,
        },
      });
    }

    // -------------------------------------------------------------
    // Serve Static Frontend Assets (public/...)
    // -------------------------------------------------------------
    let filePath = pathname === "/" ? "/index.html" : pathname;
    const safePath = `./public${filePath}`;

    try {
      const fileData = await Deno.readFile(safePath);
      const ext = filePath.substring(filePath.lastIndexOf("."));
      const contentType = MIME_TYPES[ext] || "text/plain";
      return new Response(fileData, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "no-cache",
        },
      });
    } catch {
      // Fallback to index.html for SPA client-side routing if not found
      try {
        const indexData = await Deno.readFile("./public/index.html");
        return new Response(indexData, {
          headers: { "Content-Type": "text/html; charset=UTF-8" },
        });
      } catch {
        return new Response("Not Found", { status: 404 });
      }
    }
  } catch (error) {
    console.error("Server error:", error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});

console.log(`🚀 CampusPulse Server running at http://localhost:${PORT}`);
