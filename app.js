// ─── State ────────────────────────────────────────────────────────────────────
let currentCriteria = null;
let billingPeriod = "monthly";

// ─── Clerk auth ───────────────────────────────────────────────────────────────
(async function setupClerk() {
  // Poll for Clerk CDN script to finish executing (it's loaded async)
  const deadline = Date.now() + 5000;
  while (!window.Clerk && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 80));
  }
  if (!window.Clerk) return; // Clerk unavailable (blocked, offline, etc.)

  await window.Clerk.load();
  renderAuthUI(window.Clerk.user);
  window.Clerk.addListener(({ user }) => renderAuthUI(user));
})();

function renderAuthUI(user) {
  const signInBtn = document.getElementById("navSignIn");
  const navUser = document.getElementById("navUser");
  const navInitials = document.getElementById("navInitials");
  const navDropdownName = document.getElementById("navDropdownName");

  if (user) {
    const first = user.firstName || "";
    const last = user.lastName || "";
    const initials = (first[0] || "") + (last[0] || "") ||
      (user.emailAddresses?.[0]?.emailAddress?.[0] || "?").toUpperCase();
    const displayName = first || user.emailAddresses?.[0]?.emailAddress?.split("@")[0] || "Account";

    navInitials.textContent = initials.toUpperCase();
    navDropdownName.textContent = displayName;
    signInBtn.hidden = true;
    navUser.hidden = false;
  } else {
    signInBtn.hidden = false;
    navUser.hidden = true;
  }
}

document.getElementById("navSignIn").addEventListener("click", () => {
  window.Clerk?.openSignIn({ redirectUrl: "/dashboard" });
});

document.getElementById("navAvatarBtn").addEventListener("click", () => {
  const dropdown = document.getElementById("navDropdown");
  const btn = document.getElementById("navAvatarBtn");
  const isOpen = !dropdown.hidden;
  dropdown.hidden = isOpen;
  btn.setAttribute("aria-expanded", String(!isOpen));
});

document.getElementById("navSignOut").addEventListener("click", async () => {
  document.getElementById("navDropdown").hidden = true;
  await window.Clerk?.signOut();
});

// Close dropdown when clicking outside
document.addEventListener("click", (e) => {
  const navUser = document.getElementById("navUser");
  const dropdown = document.getElementById("navDropdown");
  if (!navUser.contains(e.target) && !dropdown.hidden) {
    dropdown.hidden = true;
    document.getElementById("navAvatarBtn").setAttribute("aria-expanded", "false");
  }
});

// ─── Billing toggle ───────────────────────────────────────────────────────────
document.querySelectorAll(".billing-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    billingPeriod = btn.dataset.billing;
    document.querySelectorAll(".billing-btn").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.billing === billingPeriod);
    });

    const isAnnual = billingPeriod === "annual";

    // Swap price amounts
    document.querySelectorAll(".plan-price-amount[data-monthly]").forEach((el) => {
      el.style.opacity = "0";
      setTimeout(() => {
        el.textContent = isAnnual ? el.dataset.annual : el.dataset.monthly;
        el.style.opacity = "1";
      }, 120);
    });

    // Swap CTA labels
    document.querySelectorAll(".btn-label[data-monthly]").forEach((el) => {
      el.textContent = isAnnual ? el.dataset.annual : el.dataset.monthly;
    });

    // Show/hide annual billing note
    document.querySelectorAll(".plan-annual-billed").forEach((el) => {
      el.hidden = !isAnnual;
    });
  });
});

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const aiQuery = document.getElementById("aiQuery");
const aiBtn = document.getElementById("aiBtn");

const alertForm = document.getElementById("alertForm");
const alertCity = document.getElementById("alertCity");
const alertType = document.getElementById("alertType");
const alertMinPrice = document.getElementById("alertMinPrice");
const alertMaxPrice = document.getElementById("alertMaxPrice");
const alertBeds = document.getElementById("alertBeds");
const alertEmail = document.getElementById("alertEmail");

const resultsSection = document.getElementById("results-section");
const results = document.getElementById("results");
const resultsTitle = document.getElementById("resultsTitle");
const resultsSub = document.getElementById("resultsSub");
const statusEl = document.getElementById("status");

// ─── Tab switcher ─────────────────────────────────────────────────────────────
const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".tab-panel");
const tabIndicator = document.querySelector(".tab-indicator");

function activateTab(target) {
  tabs.forEach((t) => {
    const isActive = t.dataset.tab === target;
    t.classList.toggle("is-active", isActive);
    t.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  panels.forEach((p) => p.classList.toggle("is-active", p.dataset.panel === target));
  positionIndicator();
}

function positionIndicator() {
  const active = document.querySelector(".tab.is-active");
  if (!active || !tabIndicator) return;
  tabIndicator.style.width = `${active.offsetWidth}px`;
  tabIndicator.style.transform = `translateX(${active.offsetLeft - 4}px)`;
}

tabs.forEach((tab) => tab.addEventListener("click", () => activateTab(tab.dataset.tab)));
window.addEventListener("load", positionIndicator);
window.addEventListener("resize", positionIndicator);

// ─── Suggestion chips ────────────────────────────────────────────────────────
document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    aiQuery.value = chip.dataset.q || chip.textContent;
    aiQuery.focus();
    runAiSearch();
  });
});

// ─── AI Search ────────────────────────────────────────────────────────────────
aiBtn.addEventListener("click", runAiSearch);
aiQuery.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    runAiSearch();
  }
});

async function runAiSearch() {
  const query = aiQuery.value.trim();
  if (!query) return showStatus("Please enter a search query.", "error");

  showResults();
  resultsTitle.textContent = "Searching…";
  resultsSub.textContent = `"${query}"`;
  setLoading(true, "AI is parsing your query and fetching live listings…");
  clearResultsGrid();

  try {
    const res = await fetch("/ai-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Search failed.");

    currentCriteria = data.criteria;
    renderListings(data.listings, data.criteria, query);
  } catch (err) {
    showStatus("Error: " + err.message, "error");
    resultsTitle.textContent = "Couldn't run search";
  } finally {
    setLoading(false);
  }
}

// ─── Realtor Alert form ──────────────────────────────────────────────────────
alertForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  // Require sign-in before saving an alert
  if (!window.Clerk?.user) {
    window.Clerk?.openSignIn();
    return;
  }

  const email = alertEmail.value.trim();
  if (!email) return flashField(alertEmail);

  const criteria = {
    city: alertCity.value.trim() || null,
    propertyType: alertType.value || null,
    minPrice: alertMinPrice.value ? Number(alertMinPrice.value) : null,
    maxPrice: alertMaxPrice.value ? Number(alertMaxPrice.value) : null,
    bedrooms: alertBeds.value ? Number(alertBeds.value) : null,
    maxAge: null,
  };

  const submitBtn = alertForm.querySelector("button[type=submit]");
  const originalLabel = submitBtn.querySelector(".btn-label").innerHTML;
  submitBtn.disabled = true;
  submitBtn.querySelector(".btn-label").textContent = "Activating…";

  try {
    const token = await window.Clerk.session?.getToken();
    if (!token) throw new Error("Session expired. Please sign in again.");

    const res = await fetch("/save-alert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ email, criteria }),
    });

    const data = await res.json();

    if (res.status === 401) {
      window.Clerk?.openSignIn();
      throw new Error("Session expired. Please sign in again.");
    }
    if (res.status === 403 && data.code === "ALERT_LIMIT_REACHED") {
      throw new Error("Free plan allows 1 alert. Upgrade to Pro for unlimited alerts.");
    }
    if (!res.ok) throw new Error(data.error || "Failed to save alert.");

    submitBtn.querySelector(".btn-label").textContent = "Alert active ✓";
    setTimeout(() => {
      submitBtn.disabled = false;
      submitBtn.querySelector(".btn-label").innerHTML = originalLabel;
    }, 2400);

    try { localStorage.setItem("listalert_criteria", JSON.stringify(criteria)); } catch {}
  } catch (err) {
    submitBtn.querySelector(".btn-label").textContent = err.message.length < 40 ? err.message : "Try again";
    setTimeout(() => {
      submitBtn.disabled = false;
      submitBtn.querySelector(".btn-label").innerHTML = originalLabel;
    }, 3000);
  }
});

function flashField(el) {
  el.style.transition = "border-color 200ms ease, box-shadow 200ms ease";
  el.style.borderColor = "#f87171";
  el.style.boxShadow = "0 0 0 3px rgba(248, 113, 113, 0.15)";
  el.focus();
  setTimeout(() => {
    el.style.borderColor = "";
    el.style.boxShadow = "";
  }, 1400);
}

// ─── Render listings ─────────────────────────────────────────────────────────
function renderListings(listings, criteria, query) {
  clearResultsGrid();

  if (!listings || listings.length === 0) {
    resultsTitle.textContent = "No matches found";
    resultsSub.textContent = query ? `"${query}"` : "";
    showStatus("Try widening your criteria — different city, broader price range, or fewer beds.", "info");
    return;
  }

  resultsTitle.textContent = `${listings.length} ${listings.length === 1 ? "property" : "properties"} found`;
  resultsSub.textContent = buildCriteriaSummary(criteria, query);
  showStatus("", "info");

  listings.forEach((listing, i) => {
    const card = buildListingCard(listing);
    card.style.animationDelay = `${Math.min(i * 60, 600)}ms`;
    results.appendChild(card);
  });

  resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function buildCriteriaSummary(criteria, query) {
  if (!criteria) return query || "";
  const parts = [];
  if (criteria.city) parts.push(criteria.city);
  if (criteria.propertyType) parts.push(criteria.propertyType);
  if (criteria.bedrooms) parts.push(`${criteria.bedrooms}+ bed`);
  if (criteria.minPrice || criteria.maxPrice) {
    const lo = criteria.minPrice ? formatCompactPrice(criteria.minPrice) : "any";
    const hi = criteria.maxPrice ? formatCompactPrice(criteria.maxPrice) : "any";
    parts.push(`${lo} – ${hi}`);
  }
  return parts.join(" · ");
}

function formatCompactPrice(value) {
  if (typeof value !== "number") return "";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${value}`;
}

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
        <span class="stat"><strong>${beds ?? "—"}</strong>${beds === 1 ? "Bed" : "Beds"}</span>
        <span class="stat"><strong>${baths ?? "—"}</strong>${baths === 1 ? "Bath" : "Baths"}</span>
        <span class="stat"><strong>${sqft ? Number(sqft).toLocaleString() : "—"}</strong>Sqft</span>
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
    const photoEl = card.querySelector(".listing-photo");
    photoEl.insertBefore(img, photoEl.firstChild);
  }

  return card;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatPrice(value) {
  if (typeof value !== "number") return "N/A";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showStatus(message, type = "info") {
  if (!message) {
    statusEl.textContent = "";
    statusEl.className = "status";
    return;
  }
  statusEl.className = `status status-${type}`;
  statusEl.textContent = message;
}

function showResults() {
  resultsSection.hidden = false;
}

function clearResultsGrid() {
  results.innerHTML = "";
}

function setLoading(loading, message = "") {
  aiBtn.disabled = loading;
  if (loading && message) {
    statusEl.className = "status status-loading";
    statusEl.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${escapeHtml(message)}</span>`;
  }
}

// ─── Restore saved alert criteria ────────────────────────────────────────────
(function loadSavedAlert() {
  try {
    const saved = localStorage.getItem("listalert_criteria");
    if (!saved) return;
    const c = JSON.parse(saved);
    if (c.city) alertCity.value = c.city;
    if (c.propertyType) alertType.value = c.propertyType;
    if (c.minPrice) alertMinPrice.value = c.minPrice;
    if (c.maxPrice) alertMaxPrice.value = c.maxPrice;
    if (c.bedrooms) alertBeds.value = c.bedrooms;
  } catch {}
})();
