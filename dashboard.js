// ─── Clerk init + auth guard ───────────────────────────────────────────────
(async function initDashboard() {
  const deadline = Date.now() + 5000;
  while (!window.Clerk && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 80));
  }
  if (!window.Clerk) {
    showAuthError("Authentication unavailable. Please refresh and try again.");
    return;
  }

  await window.Clerk.load();

  if (!window.Clerk.user) {
    window.location.replace("/");
    return;
  }

  revealDashboard();
  populateSidebar(window.Clerk.user);
  populateAccount(window.Clerk.user);
  loadStats();
  loadAlerts();

  window.Clerk.addListener(({ user }) => {
    if (!user) window.location.replace("/");
  });
})();

function revealDashboard() {
  document.getElementById("dashLoading").hidden = true;
  document.getElementById("dashLayout").hidden = false;
}

function showAuthError(msg) {
  const el = document.getElementById("dashLoading");
  el.innerHTML = `
    <div style="text-align:center;padding:40px;color:#f87171;font-size:15px;max-width:320px;line-height:1.6">
      ${msg}
    </div>`;
}

// ─── Sidebar user info ────────────────────────────────────────────────────
function populateSidebar(user) {
  const first = user.firstName || "";
  const last = user.lastName || "";
  const email = user.emailAddresses?.[0]?.emailAddress || "";
  const initials = ((first[0] || "") + (last[0] || "")).toUpperCase() ||
    (email[0] || "?").toUpperCase();
  const displayName = first ? `${first} ${last}`.trim() : (email.split("@")[0] || "Account");

  document.getElementById("sidebarAvatar").textContent = initials;
  document.getElementById("sidebarUserName").textContent = displayName;
  document.getElementById("sidebarUserEmail").textContent = email;

  const h = new Date().getHours();
  const greeting = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  document.getElementById("dashGreeting").textContent = `${greeting}, ${first || displayName}`;
}

// ─── Sign out ─────────────────────────────────────────────────────────────
document.getElementById("sidebarSignOut").addEventListener("click", async () => {
  await window.Clerk?.signOut();
  window.location.replace("/");
});

// ─── Section navigation ───────────────────────────────────────────────────
const sidebarLinks = document.querySelectorAll(".sidebar-link[data-section]");
const dashSections = document.querySelectorAll(".dash-section");

sidebarLinks.forEach((link) => {
  link.addEventListener("click", () => activateSection(link.dataset.section));
});

function activateSection(target) {
  sidebarLinks.forEach((l) => l.classList.toggle("is-active", l.dataset.section === target));
  dashSections.forEach((s) => s.classList.toggle("is-active", s.id === `section-${target}`));
}

// ─── Auth token ───────────────────────────────────────────────────────────
async function getToken() {
  const token = await window.Clerk?.session?.getToken();
  if (!token) throw new Error("Session expired. Please sign in again.");
  return token;
}

// ─── Stats (overview) ────────────────────────────────────────────────────
async function loadStats() {
  try {
    const token = await getToken();
    const res = await fetch("/api/me/stats", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error("Stats unavailable.");
    const data = await res.json();

    document.getElementById("statAlerts").textContent = data.alertCount ?? "0";
    document.getElementById("statMatched").textContent = data.matchCount ?? "0";
    document.getElementById("statSearches").textContent = data.searchCount ?? "0";

    renderActivityFeed(data.recentActivity || []);
  } catch (err) {
    console.error("loadStats:", err);
  }
}

function renderActivityFeed(items) {
  const feed = document.getElementById("activityFeed");
  const empty = document.getElementById("activityEmpty");

  if (!items.length) {
    empty.hidden = false;
    return;
  }

  empty.hidden = true;
  items.forEach((item, i) => {
    const el = document.createElement("div");
    el.className = "activity-item";
    el.style.animationDelay = `${i * 50}ms`;

    const loc = [item.city, item.state].filter(Boolean).join(", ");
    el.innerHTML = `
      <div class="activity-dot"></div>
      <div class="activity-info">
        <div class="activity-address">${escapeHtml(item.address || "Property")}</div>
        ${loc ? `<div class="activity-location">${escapeHtml(loc)}</div>` : ""}
      </div>
      ${item.price ? `<div class="activity-price">${formatPrice(item.price)}</div>` : ""}
      <div class="activity-time">${formatRelativeTime(item.matchedAt)}</div>
    `;
    feed.appendChild(el);
  });
}

// ─── My Alerts ────────────────────────────────────────────────────────────
async function loadAlerts() {
  try {
    const token = await getToken();
    const res = await fetch("/api/me/alerts", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error("Failed to load alerts.");
    const alerts = await res.json();
    renderAlerts(alerts);
    syncAlertBadge(alerts.length);
    syncUsageBar(alerts.length);
  } catch (err) {
    console.error("loadAlerts:", err);
    const loadingEl = document.getElementById("alertsLoading");
    if (loadingEl) loadingEl.remove();
  }
}

function syncAlertBadge(count) {
  const badge = document.getElementById("alertsBadge");
  if (count > 0) {
    badge.textContent = count;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function syncUsageBar(count) {
  const limit = 1;
  document.getElementById("usageCount").textContent = `${count} / ${limit}`;
  document.getElementById("usageFill").style.width = `${Math.min(100, (count / limit) * 100)}%`;
}

function renderAlerts(alerts) {
  const list = document.getElementById("alertsList");
  const loadingEl = document.getElementById("alertsLoading");
  if (loadingEl) loadingEl.remove();

  if (!alerts.length) {
    list.innerHTML = `
      <div class="alerts-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
        <p>No alerts yet. Search for properties and save an alert to get notified of new matches.</p>
        <button class="btn-primary" id="alertsGoSearch">
          <span class="btn-label">Search properties</span>
          <span class="btn-shine" aria-hidden="true"></span>
        </button>
      </div>`;
    document.getElementById("alertsGoSearch")?.addEventListener("click", () => activateSection("search"));
    return;
  }

  alerts.forEach((alert, i) => list.appendChild(buildAlertCard(alert, i)));
}

function buildAlertCard(alert, i) {
  const c = alert.criteria || {};
  const tags = [];
  if (c.city) tags.push(c.city);
  if (c.propertyType) tags.push(c.propertyType);
  if (c.bedrooms) tags.push(`${c.bedrooms}+ bed`);
  if (c.minPrice || c.maxPrice) {
    const lo = c.minPrice ? formatCompactPrice(c.minPrice) : "any";
    const hi = c.maxPrice ? formatCompactPrice(c.maxPrice) : "any";
    tags.push(`${lo} – ${hi}`);
  }

  const title = tags.join(" · ") || "Custom alert";
  const card = document.createElement("div");
  card.className = "alert-card";
  card.dataset.id = alert.id;
  card.style.animationDelay = `${i * 60}ms`;

  card.innerHTML = `
    <div class="alert-icon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
    </div>
    <div class="alert-info">
      <div class="alert-title">${escapeHtml(title)}</div>
      ${tags.length ? `<div class="alert-tags">${tags.map((t) => `<span class="alert-tag">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
      <div class="alert-email">${escapeHtml(alert.email || "")}</div>
    </div>
    <div class="alert-actions">
      <button class="btn-alert-delete" aria-label="Delete alert">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
      </button>
    </div>
  `;

  card.querySelector(".btn-alert-delete").addEventListener("click", () => deleteAlert(alert.id, card));
  return card;
}

async function deleteAlert(id, cardEl) {
  cardEl.style.opacity = "0.45";
  cardEl.style.pointerEvents = "none";
  try {
    const token = await getToken();
    const res = await fetch(`/api/me/alerts/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error("Delete failed.");
    cardEl.style.transition = "opacity 0.2s ease, transform 0.2s ease";
    cardEl.style.transform = "translateX(16px)";
    cardEl.style.opacity = "0";
    setTimeout(() => {
      cardEl.remove();
      loadStats();
      const remaining = document.querySelectorAll(".alert-card").length;
      syncAlertBadge(remaining);
      syncUsageBar(remaining);
      if (remaining === 0) renderAlerts([]);
    }, 220);
  } catch (err) {
    cardEl.style.opacity = "1";
    cardEl.style.pointerEvents = "";
    console.error("deleteAlert:", err);
  }
}

// New alert → go to search
document.getElementById("newAlertBtn").addEventListener("click", () => activateSection("search"));

// ─── Dashboard AI search ──────────────────────────────────────────────────
const dashAiQuery = document.getElementById("dashAiQuery");
const dashAiBtn = document.getElementById("dashAiBtn");
const dashStatus = document.getElementById("dashSearchStatus");
const dashResults = document.getElementById("dashResults");

dashAiBtn.addEventListener("click", runDashSearch);
dashAiQuery.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); runDashSearch(); }
});

document.querySelectorAll("#section-search .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    dashAiQuery.value = chip.dataset.q || chip.textContent.trim();
    dashAiQuery.focus();
    runDashSearch();
  });
});

async function runDashSearch() {
  const query = dashAiQuery.value.trim();
  if (!query) return;

  dashResults.innerHTML = "";
  dashStatus.className = "status status-loading";
  dashStatus.innerHTML = `<span class="spinner"></span><span>Searching properties…</span>`;
  dashAiBtn.disabled = true;

  try {
    const res = await fetch("/ai-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Search failed.");

    dashStatus.textContent = "";
    dashStatus.className = "status";

    if (!data.listings?.length) {
      dashStatus.className = "status status-info";
      dashStatus.textContent = "No listings matched. Try different criteria or a broader search.";
      return;
    }

    data.listings.forEach((listing, i) => {
      const card = buildListingCard(listing);
      card.style.animationDelay = `${Math.min(i * 60, 600)}ms`;
      dashResults.appendChild(card);
    });
  } catch (err) {
    dashStatus.className = "status status-error";
    dashStatus.textContent = err.message;
  } finally {
    dashAiBtn.disabled = false;
  }
}

// ─── Account section ──────────────────────────────────────────────────────
function populateAccount(user) {
  const email = user.emailAddresses?.[0]?.emailAddress || "—";
  const first = user.firstName || "";
  const last = user.lastName || "";
  const name = (first + " " + last).trim() || email.split("@")[0] || "—";
  const joined = user.createdAt
    ? new Date(user.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long" })
    : "—";

  document.getElementById("accountEmail").textContent = email;
  document.getElementById("accountName").textContent = name;
  document.getElementById("accountJoined").textContent = joined;
  document.getElementById("accountUserId").textContent = user.id || "—";
}

// ─── Listing card builder ─────────────────────────────────────────────────
function buildListingCard(listing) {
  const address = listing.address?.full || listing.address?.city || "Address unavailable";
  const city = listing.address?.city || "";
  const state = listing.address?.state || "";
  const price = formatPrice(listing.listPrice);
  const beds = listing.property?.bedrooms ?? null;
  const baths = listing.property?.bathsFull ?? listing.property?.bathrooms ?? null;
  const sqft = listing.property?.area ?? null;
  const yearBuilt = listing.property?.yearBuilt ?? null;
  const photos = listing.photos || [];
  const photo = photos[0] || null;
  const mlsId = listing.mlsId || listing.listingId || "";

  const placeholderSvg = `<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;

  const card = document.createElement("article");
  card.className = "listing-card";
  card.innerHTML = `
    <div class="listing-photo">
      <div class="no-photo-placeholder">${placeholderSvg}</div>
      ${price !== "N/A" ? `<div class="listing-price-badge">${escapeHtml(price)}</div>` : ""}
    </div>
    <div class="listing-body">
      <div class="listing-address">${escapeHtml(address)}</div>
      ${(city || state) ? `<div class="listing-location">${escapeHtml([city, state].filter(Boolean).join(", "))}</div>` : ""}
      <div class="listing-stats">
        <span class="stat"><strong>${beds ?? "—"}</strong> ${beds === 1 ? "Bed" : "Beds"}</span>
        <span class="stat"><strong>${baths ?? "—"}</strong> ${baths === 1 ? "Bath" : "Baths"}</span>
        <span class="stat"><strong>${sqft ? Number(sqft).toLocaleString() : "—"}</strong> Sqft</span>
      </div>
      <div class="listing-meta">
        ${yearBuilt ? `<span>Built ${yearBuilt}</span>` : ""}
        ${mlsId ? `<span class="mls-id">MLS# ${escapeHtml(String(mlsId))}</span>` : ""}
      </div>
    </div>
  `;

  if (photo) {
    const img = document.createElement("img");
    img.src = photo;
    img.alt = `Property at ${address}`;
    img.loading = "lazy";
    img.addEventListener("error", () => img.remove());
    card.querySelector(".listing-photo").prepend(img);
  }

  return card;
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function formatPrice(value) {
  if (typeof value !== "number") return "N/A";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatCompactPrice(value) {
  if (typeof value !== "number") return "";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${value}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
