// ─── State ────────────────────────────────────────────────────────────────────
let currentCriteria = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const aiQuery = document.getElementById("aiQuery");
const aiBtn = document.getElementById("ai-search-btn");
const resultsSection = document.getElementById("results");
const statusEl = document.getElementById("status");
const alertBadge = document.getElementById("alert-badge");

// Manual form refs
const cityInput = document.getElementById("city");
const propertyTypeInput = document.getElementById("propertyType");
const minPriceInput = document.getElementById("minPrice");
const maxPriceInput = document.getElementById("maxPrice");
const bedroomsInput = document.getElementById("bedrooms");
const maxAgeInput = document.getElementById("maxAge");
const searchForm = document.getElementById("search-form");
const saveAlertBtn = document.getElementById("save-alert-btn");
const alertEmailInput = document.getElementById("alertEmail");

// ─── AI Search ────────────────────────────────────────────────────────────────
aiBtn.addEventListener("click", async () => {
  const query = aiQuery.value.trim();
  if (!query) return showStatus("Please enter a search query.", "error");

  setLoading(true, "🤖 AI is searching for properties...");
  clearResults();

  try {
    const res = await fetch("/ai-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Search failed.");

    currentCriteria = data.criteria;

    // Populate filter form to reflect what AI understood
    fillForm(data.criteria);

    // Show listings
    renderListings(data.listings, data.criteria);
  } catch (err) {
    showStatus("❌ " + err.message, "error");
  } finally {
    setLoading(false);
  }
});

// Allow pressing Enter in AI search box
aiQuery.addEventListener("keydown", (e) => {
  if (e.key === "Enter") aiBtn.click();
});

// ─── Manual Search ────────────────────────────────────────────────────────────
searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const criteria = getCriteriaFromForm();
  currentCriteria = criteria;

  setLoading(true, "Searching listings...");
  clearResults();

  try {
    const res = await fetch("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ criteria }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Search failed.");

    renderListings(data.listings, criteria);
  } catch (err) {
    showStatus("❌ " + err.message, "error");
  } finally {
    setLoading(false);
  }
});

// ─── Save Alert ───────────────────────────────────────────────────────────────
saveAlertBtn.addEventListener("click", async () => {
  const email = alertEmailInput.value.trim();
  if (!email) return showStatus("Please enter an email address.", "error");

  const criteria = currentCriteria || getCriteriaFromForm();

  try {
    const res = await fetch("/save-alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, criteria }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to save alert.");

    showStatus("✅ Alert saved! You'll get notified when new listings match.", "success");
  } catch (err) {
    showStatus("❌ " + err.message, "error");
  }
});

// ─── Render Listings ──────────────────────────────────────────────────────────
function renderListings(listings, criteria) {
  clearResults();

  if (!listings || listings.length === 0) {
    showStatus("No properties found. Try a different search.", "info");
    return;
  }

  showStatus(`Found ${listings.length} propert${listings.length === 1 ? "y" : "ies"}`, "success");

  const grid = document.createElement("div");
  grid.className = "listings-grid";

  listings.forEach((listing) => {
    const card = buildListingCard(listing);
    grid.appendChild(card);
  });

  resultsSection.appendChild(grid);

  // Smooth scroll to results
  resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
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
  const propertyType = listing.property?.type || listing.property?.subType || "";
  const photos = listing.photos || [];
  const photo = photos[0] || null;
  const mlsId = listing.mlsId || listing.listingId || "";

  const card = document.createElement("article");
  card.className = "listing-card";

  card.innerHTML = `
    <div class="listing-photo">
      ${photo
        ? `<img src="${escapeHtml(photo)}" alt="Property at ${escapeHtml(address)}" loading="lazy" onerror="this.parentElement.classList.add('no-photo')" />`
        : `<div class="no-photo-placeholder"><span>🏠</span></div>`
      }
      ${price !== "N/A" ? `<div class="listing-price-badge">${escapeHtml(price)}</div>` : ""}
    </div>
    <div class="listing-body">
      <div class="listing-address">${escapeHtml(address)}</div>
      ${city || state ? `<div class="listing-location">${escapeHtml([city, state].filter(Boolean).join(", "))}</div>` : ""}
      <div class="listing-stats">
        ${beds !== null ? `<span class="stat"><strong>${beds}</strong> bed${beds !== 1 ? "s" : ""}</span>` : ""}
        ${baths !== null ? `<span class="stat"><strong>${baths}</strong> bath${baths !== 1 ? "s" : ""}</span>` : ""}
        ${sqft !== null ? `<span class="stat"><strong>${Number(sqft).toLocaleString()}</strong> sqft</span>` : ""}
      </div>
      <div class="listing-meta">
        ${yearBuilt ? `<span>Built ${yearBuilt}</span>` : ""}
        ${propertyType ? `<span>${escapeHtml(propertyType)}</span>` : ""}
        ${mlsId ? `<span class="mls-id">MLS# ${escapeHtml(String(mlsId))}</span>` : ""}
      </div>
    </div>
  `;

  return card;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getCriteriaFromForm() {
  return {
    city: cityInput.value.trim() || null,
    propertyType: propertyTypeInput.value || null,
    minPrice: minPriceInput.value ? Number(minPriceInput.value) : null,
    maxPrice: maxPriceInput.value ? Number(maxPriceInput.value) : null,
    bedrooms: bedroomsInput.value ? Number(bedroomsInput.value) : null,
    maxAge: maxAgeInput.value ? Number(maxAgeInput.value) : null,
  };
}

function fillForm(criteria) {
  if (criteria.city) cityInput.value = criteria.city;
  if (criteria.propertyType) propertyTypeInput.value = criteria.propertyType;
  if (criteria.minPrice) minPriceInput.value = criteria.minPrice;
  if (criteria.maxPrice) maxPriceInput.value = criteria.maxPrice;
  if (criteria.bedrooms) bedroomsInput.value = criteria.bedrooms;
  if (criteria.maxAge) maxAgeInput.value = criteria.maxAge;
}

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
  statusEl.textContent = message;
  statusEl.className = `status status-${type}`;
}

function clearResults() {
  resultsSection.innerHTML = "";
  statusEl.textContent = "";
  statusEl.className = "status";
}

function setLoading(loading, message = "") {
  aiBtn.disabled = loading;
  document.getElementById("search-btn").disabled = loading;
  if (loading && message) showStatus(message, "info");
}

// ─── Load saved alert on page load ───────────────────────────────────────────
(function loadSavedAlert() {
  const saved = localStorage.getItem("listalert_criteria");
  if (!saved) return;
  try {
    const criteria = JSON.parse(saved);
    fillForm(criteria);
    currentCriteria = criteria;
    alertBadge.textContent = "Loaded saved alert. Auto-check is running every 30 seconds.";
    alertBadge.classList.remove("hidden");
  } catch {}
})();

saveAlertBtn.addEventListener("click", () => {
  if (currentCriteria) {
    localStorage.setItem("listalert_criteria", JSON.stringify(currentCriteria));
  }
}, true);
