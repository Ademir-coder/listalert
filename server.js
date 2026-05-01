const express = require("express");
const cors = require("cors");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const BASE_DIR = __dirname;
const ALERTS_FILE = path.join(BASE_DIR, "alerts.json");
const SEEN_LISTINGS_FILE = path.join(BASE_DIR, "seen-listings.json");

const SIMPLYRETS_API_URL = "https://api.simplyrets.com/properties";
const SIMPLYRETS_USERNAME = "simplyrets";
const SIMPLYRETS_PASSWORD = "simplyrets";

const RESEND_API_URL = "https://api.resend.com/emails";
const RESEND_API_KEY = "re_Q4BcWaxr_CSuKpFbaRCGbqFYg1CYajSTX";
const EMAIL_FROM = "onboarding@resend.dev";
const ALERT_CHECK_INTERVAL_MS = 2 * 60 * 1000;
const FORCE_SEND_TEST_EMAILS = true;

let isScheduledCheckRunning = false;

app.use(express.json());
app.use(cors({ origin: "*" }));
app.use(express.static(BASE_DIR));

app.post("/save-alert", async (req, res) => {
  try {
    const { email, criteria } = req.body ?? {};
    if (!isValidEmail(email) || !isValidCriteria(criteria)) {
      return res
        .status(400)
        .json({ error: "Invalid payload. Send { email, criteria } with valid values." });
    }

    const alerts = await readJsonFile(ALERTS_FILE, []);
    const id = buildAlertId(email, criteria);

    const existingIndex = alerts.findIndex((alert) => alert.id === id);
    const payload = { id, email, criteria, updatedAt: new Date().toISOString() };

    if (existingIndex >= 0) {
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
    console.log(
      `Scheduled alert check complete. Checked: ${summary.alertsChecked}, emails sent: ${summary.emailsSent}`
    );
  } catch (error) {
    console.error("Scheduled alert check failed:", error);
  } finally {
    isScheduledCheckRunning = false;
  }
}, ALERT_CHECK_INTERVAL_MS);

function buildAlertId(email, criteria) {
  const raw = JSON.stringify({ email: email.toLowerCase(), criteria });
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

function isValidEmail(email) {
  if (typeof email !== "string") return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidCriteria(criteria) {
  if (!criteria || typeof criteria !== "object") return false;
  return true;
}

function buildSimplyRetsQuery(criteria) {
  const params = new URLSearchParams();
  if (criteria.city) params.append("cities", String(criteria.city).trim());
  if (criteria.propertyType) params.append("type", String(criteria.propertyType));
  if (criteria.minPrice) params.append("minprice", String(criteria.minPrice));
  if (criteria.maxPrice) params.append("maxprice", String(criteria.maxPrice));
  if (criteria.bedrooms) params.append("bedrooms", String(criteria.bedrooms));

  if (criteria.maxAge) {
    const currentYear = new Date().getFullYear();
    const minYear = currentYear - Number(criteria.maxAge);
    if (!Number.isNaN(minYear)) params.append("minyear", String(minYear));
  }

  return params.toString();
}

async function fetchSimplyRetsListings(criteria) {
  const query = buildSimplyRetsQuery(criteria);
  const requestUrl = query ? `${SIMPLYRETS_API_URL}?${query}` : SIMPLYRETS_API_URL;
  const token = Buffer.from(`${SIMPLYRETS_USERNAME}:${SIMPLYRETS_PASSWORD}`).toString("base64");

  const response = await fetch(requestUrl, {
    headers: { Authorization: `Basic ${token}` },
  });

  if (!response.ok) {
    throw new Error(`SimplyRETS request failed: ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

function getListingId(listing) {
  return String(
    listing.mlsId || listing.listingId || listing.id || listing.address?.full || ""
  );
}

async function sendAlertEmail(to, criteria, listings) {
  const html = buildAlertEmailHtml(criteria, listings);
  const text = buildAlertEmailText(listings);

  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to,
      subject: "New Listing Match Found!",
      html,
      text,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Resend failed (${response.status}): ${errorBody}`);
  }
}

async function sendAlertConfirmationEmail(to, criteria) {
  const city = criteria?.city ? String(criteria.city).trim() : "your selected city";
  const safeCity = city || "your selected city";
  const message = `Hi! Your listing alert has been saved. We will notify you the moment a matching property drops in ${safeCity} matching your criteria. The ListAlert Team.`;

  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to,
      subject: "Your ListAlert is active!",
      html: `
      <div style="font-family:Inter,Arial,sans-serif;background:#f8fafc;padding:24px;">
        <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:22px;">
          <h2 style="margin:0 0 10px;color:#1e1b4b;">Your ListAlert is active!</h2>
          <p style="margin:0;color:#334155;font-size:15px;line-height:1.6;">
            Hi! Your listing alert has been saved. We will notify you the moment a matching property drops in <strong>${escapeHtml(safeCity)}</strong> matching your criteria. The ListAlert Team.
          </p>
        </div>
      </div>`,
      text: message,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Resend confirmation failed (${response.status}): ${errorBody}`);
  }
}

function buildAlertEmailHtml(criteria, listings) {
  const criteriaSummary = [
    criteria.city ? `City: ${escapeHtml(criteria.city)}` : null,
    criteria.propertyType ? `Type: ${escapeHtml(criteria.propertyType)}` : null,
    criteria.minPrice ? `Min: $${escapeHtml(String(criteria.minPrice))}` : null,
    criteria.maxPrice ? `Max: $${escapeHtml(String(criteria.maxPrice))}` : null,
    criteria.bedrooms ? `Beds: ${escapeHtml(String(criteria.bedrooms))}` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  const rows = listings
    .slice(0, 10)
    .map((listing) => {
      const address = listing.address?.full || "Address unavailable";
      const price = formatPrice(listing.listPrice);
      const beds = listing.property?.bedrooms ?? "N/A";
      const baths = listing.property?.bathsFull ?? listing.property?.bathrooms ?? "N/A";
      const yearBuilt = listing.property?.yearBuilt ?? "N/A";

      return `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #e2e8f0;">
          <div style="font-weight:600;color:#0f172a;">${escapeHtml(address)}</div>
          <div style="color:#475569;font-size:14px;margin-top:4px;">
            Price: ${escapeHtml(price)} | Bedrooms: ${escapeHtml(String(beds))} | Bathrooms: ${escapeHtml(String(baths))} | Year Built: ${escapeHtml(String(yearBuilt))}
          </div>
        </td>
      </tr>`;
    })
    .join("");

  return `
  <div style="font-family:Inter,Arial,sans-serif;background:#f8fafc;padding:24px;">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:22px;">
      <h2 style="margin:0 0 10px;color:#1e1b4b;">ListAlert</h2>
      <p style="margin:0 0 14px;color:#334155;font-size:15px;">
        A new listing matching your criteria just dropped.
      </p>
      <p style="margin:0 0 18px;color:#64748b;font-size:13px;">${criteriaSummary}</p>
      <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
        ${rows}
      </table>
    </div>
  </div>`;
}

function buildAlertEmailText(listings) {
  const rows = listings
    .slice(0, 10)
    .map((listing) => {
      const address = listing.address?.full || "Address unavailable";
      const price = formatPrice(listing.listPrice);
      const beds = listing.property?.bedrooms ?? "N/A";
      const baths = listing.property?.bathsFull ?? listing.property?.bathrooms ?? "N/A";
      const yearBuilt = listing.property?.yearBuilt ?? "N/A";
      return `${address} | Price: ${price} | Bedrooms: ${beds} | Bathrooms: ${baths} | Year Built: ${yearBuilt}`;
    })
    .join("\n");

  return `A new listing matching your criteria just dropped.\n\n${rows}`;
}

function formatPrice(value) {
  if (typeof value !== "number") return "N/A";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
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
  let emailsSent = 0;
  let alertsChecked = 0;

  for (const alert of alerts) {
    alertsChecked += 1;
    const listings = await fetchSimplyRetsListings(alert.criteria);
    const currentIds = new Set(listings.map(getListingId).filter(Boolean));
    const previousIds = new Set(seenMap[alert.id] || []);

    const newMatches = listings.filter((listing) => {
      const id = getListingId(listing);
      return id && !previousIds.has(id);
    });

    const matchesToEmail = FORCE_SEND_TEST_EMAILS ? listings : newMatches;

    if (matchesToEmail.length > 0) {
      await sendAlertEmail(alert.email, alert.criteria, matchesToEmail);
      emailsSent += 1;
    }

    seenMap[alert.id] = [...currentIds];
  }

  await writeJsonFile(SEEN_LISTINGS_FILE, seenMap);

  return {
    alertsChecked,
    emailsSent,
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
