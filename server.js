require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { clerkMiddleware, requireAuth, getAuth } = require("@clerk/express");

const app = express();
const PORT = process.env.PORT || 3000;

const BASE_DIR = __dirname;
const ALERTS_FILE = path.join(BASE_DIR, "alerts.json");
const SEEN_LISTINGS_FILE = path.join(BASE_DIR, "seen-listings.json");
const ACTIVITY_FILE = path.join(BASE_DIR, "user-activity.json");
const USER_STATS_FILE = path.join(BASE_DIR, "user-stats.json");

const SIMPLYRETS_API_URL = "https://api.simplyrets.com/properties";
const SIMPLYRETS_USERNAME = "simplyrets";
const SIMPLYRETS_PASSWORD = "simplyrets";

const RESEND_API_URL = "https://api.resend.com/emails";
const RESEND_API_KEY = "re_Q4BcWaxr_CSuKpFbaRCGbqFYg1CYajSTX";
const EMAIL_FROM = "onboarding@resend.dev";
const ALERT_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const FORCE_SEND_TEST_EMAILS = false;

const FREE_TIER_ALERT_LIMIT = 1;

// ─── RAILWAY DEPLOYMENT ───────────────────────────────────────────────────────
// Add these environment variables in Railway:
//   1. Go to your Railway project → Variables tab
//   2. Add each key individually:
//
//   CLERK_SECRET_KEY      → sk_live_... (from clerk.com → API Keys)
//   CLERK_PUBLISHABLE_KEY → pk_live_... (from clerk.com → API Keys)
//   ANTHROPIC_API_KEY     → your Anthropic key (from console.anthropic.com)
//
// Never commit your real .env to git — use .env.example as the template.
// ─────────────────────────────────────────────────────────────────────────────

let isScheduledCheckRunning = false;

app.use(express.json());
app.use(cors({ origin: "*" }));
app.use(clerkMiddleware());

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(BASE_DIR, "dashboard.html"));
});

app.use(express.static(BASE_DIR));

// ─── AI SEARCH ────────────────────────────────────────────────────────────────
app.post("/ai-search", async (req, res) => {
  try {
    const query = String(req.body?.query || "").trim();
    if (!query) return res.status(400).json({ error: "Query is required." });

    const criteria = await parseNaturalQueryWithClaude(query);
    const listings = await fetchSimplyRetsListings(criteria);

    const { userId } = getAuth(req);
    if (userId) {
      readJsonFile(USER_STATS_FILE, {}).then((stats) => {
        if (!stats[userId]) stats[userId] = {};
        stats[userId].searchCount = (stats[userId].searchCount || 0) + 1;
        return writeJsonFile(USER_STATS_FILE, stats);
      }).catch(() => {});
    }

    return res.json({ success: true, criteria, listings });
  } catch (error) {
    console.error("AI search error:", error);
    return res.status(500).json({ error: error.message || "AI search failed." });
  }
});

// ─── MANUAL SEARCH ────────────────────────────────────────────────────────────
app.post("/search", async (req, res) => {
  try {
    const criteria = req.body?.criteria;
    if (!criteria) return res.status(400).json({ error: "Criteria is required." });
    const listings = await fetchSimplyRetsListings(criteria);
    return res.json({ success: true, listings });
  } catch (error) {
    console.error("Search error:", error);
    return res.status(500).json({ error: "Search failed." });
  }
});

// ─── SAVE ALERT (requires auth) ───────────────────────────────────────────────
app.post("/save-alert", requireAuth(), async (req, res) => {
  try {
    const { userId } = getAuth(req);
    const { email, criteria } = req.body ?? {};

    if (!isValidEmail(email) || !isValidCriteria(criteria)) {
      return res.status(400).json({ error: "Invalid payload." });
    }

    const alerts = await readJsonFile(ALERTS_FILE, []);
    const id = buildAlertId(email, criteria);

    // Check if this exact alert already exists for this user (it's an update, not new)
    const existingIndex = alerts.findIndex((a) => a.id === id && a.userId === userId);
    const isUpdate = existingIndex >= 0;

    if (!isUpdate) {
      // Enforce free tier limit: count all alerts belonging to this user
      const userAlertCount = alerts.filter((a) => a.userId === userId).length;
      if (userAlertCount >= FREE_TIER_ALERT_LIMIT) {
        return res.status(403).json({
          error: `Free plan is limited to ${FREE_TIER_ALERT_LIMIT} saved alert. Upgrade to Pro for unlimited alerts.`,
          code: "ALERT_LIMIT_REACHED",
        });
      }
    }

    const payload = { id, email, criteria, userId, updatedAt: new Date().toISOString() };

    if (isUpdate) {
      alerts[existingIndex] = payload;
    } else {
      alerts.push({ ...payload, createdAt: payload.updatedAt });
    }

    await writeJsonFile(ALERTS_FILE, alerts);
    await sendAlertConfirmationEmail(email, criteria);
    return res.json({ success: true, alertId: id });
  } catch (error) {
    console.error("Failed to save alert:", error);
    return res.status(500).json({ error: "Failed to save alert." });
  }
});

// ─── DASHBOARD API ────────────────────────────────────────────────────────────
app.get("/api/me/alerts", requireAuth(), async (req, res) => {
  try {
    const { userId } = getAuth(req);
    const alerts = await readJsonFile(ALERTS_FILE, []);
    return res.json(alerts.filter((a) => a.userId === userId));
  } catch {
    return res.status(500).json({ error: "Failed to fetch alerts." });
  }
});

app.delete("/api/me/alerts/:id", requireAuth(), async (req, res) => {
  try {
    const { userId } = getAuth(req);
    const { id } = req.params;
    const alerts = await readJsonFile(ALERTS_FILE, []);
    const idx = alerts.findIndex((a) => a.id === id && a.userId === userId);
    if (idx === -1) return res.status(404).json({ error: "Alert not found." });
    alerts.splice(idx, 1);
    await writeJsonFile(ALERTS_FILE, alerts);
    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: "Failed to delete alert." });
  }
});

app.get("/api/me/stats", requireAuth(), async (req, res) => {
  try {
    const { userId } = getAuth(req);
    const [alerts, activity, stats] = await Promise.all([
      readJsonFile(ALERTS_FILE, []),
      readJsonFile(ACTIVITY_FILE, {}),
      readJsonFile(USER_STATS_FILE, {}),
    ]);
    const userStats = stats[userId] || {};
    return res.json({
      alertCount: alerts.filter((a) => a.userId === userId).length,
      matchCount: userStats.matchCount || 0,
      searchCount: userStats.searchCount || 0,
      recentActivity: (activity[userId] || []).slice(0, 10),
    });
  } catch {
    return res.status(500).json({ error: "Failed to fetch stats." });
  }
});

app.post("/check-alerts", async (_req, res) => {
  try {
    const summary = await runAlertCheckCycle();
    return res.json({ success: true, ...summary });
  } catch (error) {
    console.error("Failed to check alerts:", error);
    return res.status(500).json({ error: "Failed to check alerts." });
  }
});

app.listen(PORT, () => {
  console.log(`ListAlert server running at http://localhost:${PORT}`);
});

setInterval(async () => {
  if (isScheduledCheckRunning) return;
  isScheduledCheckRunning = true;
  try {
    const summary = await runAlertCheckCycle();
    console.log(`Scheduled check done. Checked: ${summary.alertsChecked}, emails: ${summary.emailsSent}`);
  } catch (error) {
    console.error("Scheduled check failed:", error);
  } finally {
    isScheduledCheckRunning = false;
  }
}, ALERT_CHECK_INTERVAL_MS);

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function buildAlertId(email, criteria) {
  const raw = JSON.stringify({ email: email.toLowerCase(), criteria });
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

function isValidEmail(email) {
  if (typeof email !== "string") return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidCriteria(criteria) {
  return criteria && typeof criteria === "object";
}

function buildSimplyRetsQuery(criteria) {
  const params = new URLSearchParams();
  if (criteria.city) params.append("cities", String(criteria.city).trim());
  if (criteria.propertyType) params.append("type", String(criteria.propertyType));
  if (criteria.minPrice) params.append("minprice", String(criteria.minPrice));
  if (criteria.maxPrice) params.append("maxprice", String(criteria.maxPrice));
  if (criteria.bedrooms) params.append("bedrooms", String(criteria.bedrooms));
  if (criteria.maxAge) {
    const minYear = new Date().getFullYear() - Number(criteria.maxAge);
    if (!Number.isNaN(minYear)) params.append("minyear", String(minYear));
  }
  params.append("limit", "20");
  return params.toString();
}

async function fetchSimplyRetsListings(criteria) {
  const query = buildSimplyRetsQuery(criteria);
  const url = query ? `${SIMPLYRETS_API_URL}?${query}` : `${SIMPLYRETS_API_URL}?limit=20`;
  const token = Buffer.from(`${SIMPLYRETS_USERNAME}:${SIMPLYRETS_PASSWORD}`).toString("base64");

  const response = await fetch(url, {
    headers: { Authorization: `Basic ${token}` },
  });

  if (!response.ok) throw new Error(`SimplyRETS request failed: ${response.status}`);
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

function getListingId(listing) {
  return String(listing.mlsId || listing.listingId || listing.id || listing.address?.full || "");
}

async function parseNaturalQueryWithClaude(query) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured.");

  const currentYear = new Date().getFullYear();
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 300,
      system: "You convert real-estate search text into JSON. Respond with ONLY valid JSON, no markdown, no explanation.",
      messages: [{
        role: "user",
        content: `Parse this property search into JSON with these keys:
{
  "city": string or null,
  "propertyType": "house" | "apartment" | null,
  "minPrice": number or null,
  "maxPrice": number or null,
  "bedrooms": number or null,
  "maxAge": number or null
}
Rules:
- Normalize price: 350k -> 350000, 1.2m -> 1200000
- "built after YEAR" -> maxAge = ${currentYear} - YEAR
- If unknown, use null

Input: ${query}`
      }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API failed (${response.status}): ${err}`);
  }

  const payload = await response.json();
  const text = payload?.content?.[0]?.text;
  if (!text) throw new Error("Empty Claude response.");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s === -1 || e === -1) throw new Error("Claude did not return valid JSON.");
    parsed = JSON.parse(text.slice(s, e + 1));
  }

  return sanitizeParsedCriteria(parsed, currentYear);
}

function sanitizeParsedCriteria(criteria, currentYear) {
  return {
    city: normalizeOptionalString(criteria?.city),
    propertyType: normalizePropertyType(criteria?.propertyType),
    minPrice: normalizeOptionalNumber(criteria?.minPrice),
    maxPrice: normalizeOptionalNumber(criteria?.maxPrice),
    bedrooms: normalizeOptionalNumber(criteria?.bedrooms),
    maxAge: normalizeOptionalNumber(criteria?.maxAge),
  };
}

function normalizeOptionalString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function normalizePropertyType(value) {
  if (value == null) return null;
  const text = String(value).toLowerCase().trim();
  if (text.includes("house")) return "house";
  if (text.includes("apartment") || text.includes("apt")) return "apartment";
  return null;
}

function normalizeOptionalNumber(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  if (Number.isNaN(num) || num < 0) return null;
  return Math.round(num);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatPrice(value) {
  if (typeof value !== "number") return "N/A";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonFile(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function runAlertCheckCycle() {
  const alerts = await readJsonFile(ALERTS_FILE, []);
  const seenMap = await readJsonFile(SEEN_LISTINGS_FILE, {});
  const activity = await readJsonFile(ACTIVITY_FILE, {});
  const stats = await readJsonFile(USER_STATS_FILE, {});
  let emailsSent = 0;
  let alertsChecked = 0;

  for (const alert of alerts) {
    alertsChecked++;
    const listings = await fetchSimplyRetsListings(alert.criteria);
    const currentIds = new Set(listings.map(getListingId).filter(Boolean));
    const previousIds = new Set(seenMap[alert.id] || []);
    const newMatches = listings.filter((l) => { const id = getListingId(l); return id && !previousIds.has(id); });
    const toEmail = FORCE_SEND_TEST_EMAILS ? listings : newMatches;

    if (toEmail.length > 0) {
      await sendAlertEmail(alert.email, alert.criteria, toEmail);
      emailsSent++;

      if (alert.userId) {
        if (!activity[alert.userId]) activity[alert.userId] = [];
        const entries = toEmail.map((l) => ({
          listingId: getListingId(l),
          address: l.address?.full || l.address?.city || "Address unavailable",
          city: l.address?.city || "",
          state: l.address?.state || "",
          price: l.listPrice || null,
          matchedAt: new Date().toISOString(),
          alertId: alert.id,
        }));
        activity[alert.userId] = [...entries, ...activity[alert.userId]].slice(0, 50);
        if (!stats[alert.userId]) stats[alert.userId] = {};
        stats[alert.userId].matchCount = (stats[alert.userId].matchCount || 0) + toEmail.length;
      }
    }

    seenMap[alert.id] = [...currentIds];
  }

  await writeJsonFile(SEEN_LISTINGS_FILE, seenMap);
  await writeJsonFile(ACTIVITY_FILE, activity);
  await writeJsonFile(USER_STATS_FILE, stats);
  return { alertsChecked, emailsSent };
}

async function sendAlertEmail(to, criteria, listings) {
  const rows = listings.slice(0, 10).map((l) => {
    const address = l.address?.full || "Address unavailable";
    const price = formatPrice(l.listPrice);
    const beds = l.property?.bedrooms ?? "N/A";
    const baths = l.property?.bathsFull ?? l.property?.bathrooms ?? "N/A";
    return `<tr><td style="padding:12px 0;border-bottom:1px solid #e2e8f0;"><div style="font-weight:600;">${escapeHtml(address)}</div><div style="color:#475569;font-size:14px;">${escapeHtml(price)} | ${escapeHtml(String(beds))} bed | ${escapeHtml(String(baths))} bath</div></td></tr>`;
  }).join("");

  await fetch(RESEND_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: EMAIL_FROM, to,
      subject: "New Listing Match Found!",
      html: `<div style="font-family:Arial,sans-serif;padding:24px;"><h2>New listings matching your criteria:</h2><table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">${rows}</table></div>`,
      text: listings.slice(0, 10).map((l) => `${l.address?.full || "?"} | ${formatPrice(l.listPrice)}`).join("\n"),
    }),
  });
}

async function sendAlertConfirmationEmail(to, criteria) {
  const city = criteria?.city || "your selected area";
  await fetch(RESEND_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: EMAIL_FROM, to,
      subject: "Your ListAlert is active!",
      html: `<div style="font-family:Arial,sans-serif;padding:24px;"><h2>Your ListAlert is active!</h2><p>We'll notify you the moment a matching property drops in <strong>${escapeHtml(city)}</strong>.</p></div>`,
      text: `Your alert is active! We'll notify you about new listings in ${city}.`,
    }),
  });
}
