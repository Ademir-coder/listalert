const API_BASE_URL = "https://api.simplyrets.com/properties";
const API_USERNAME = "simplyrets";
const API_PASSWORD = "simplyrets";
const ALERT_STORAGE_KEY = "simplyrets_saved_alert";
const POLL_INTERVAL_MS = 30000;

const form = document.getElementById("search-form");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const searchBtn = document.getElementById("search-btn");
const saveAlertBtn = document.getElementById("save-alert-btn");
const alertEmailEl = document.getElementById("alertEmail");
const alertBadgeEl = document.getElementById("alert-badge");
const aiQueryEl = document.getElementById("aiQuery");
const aiSearchBtn = document.getElementById("ai-search-btn");

let pollTimer = null;
let previousAlertListingIds = new Set();
let isPollingInProgress = false;

aiSearchBtn.addEventListener("click", async () => {
  const query = aiQueryEl.value.trim();
  if (!query) {
    statusEl.textContent = "Please describe your ideal property first.";
    return;
  }

  const originalText = aiSearchBtn.textContent;
  aiSearchBtn.disabled = true;
  aiSearchBtn.textContent = "Analyzing...";
  statusEl.textContent = "Claude is parsing your request...";

  try {
    const parsedCriteria = await parseCriteriaWithAI(query);
    applyParsedCriteriaToForm(parsedCriteria);
    statusEl.textContent = "Your criteria were filled in automatically. You can now hit Search.";
  } catch (error) {
    statusEl.textContent = `AI search failed: ${error.message}`;
  } finally {
    aiSearchBtn.disabled = false;
    aiSearchBtn.textContent = originalText;
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  alertBadgeEl.classList.add("hidden");
  statusEl.textContent = "";
  resultsEl.innerHTML = "";

  const criteria = getCriteriaFromForm();
  if (!validateCriteria(criteria)) return;

  searchBtn.disabled = true;
  statusEl.textContent = "Searching properties...";

  try {
    const properties = await fetchProperties(criteria);
    renderResults(properties);
  } catch (error) {
    statusEl.textContent = `Error: ${error.message}`;
  } finally {
    searchBtn.disabled = false;
  }
});

saveAlertBtn.addEventListener("click", async () => {
  const criteria = getCriteriaFromForm();
  if (!validateCriteria(criteria)) return;

  const email = alertEmailEl.value.trim();
  if (!isValidEmail(email)) {
    statusEl.textContent = "Please enter a valid email before saving an alert.";
    return;
  }

  const savedAlert = { email, criteria };
  saveAlertBtn.disabled = true;

  try {
    await saveAlertToBackend(savedAlert);
    localStorage.setItem(ALERT_STORAGE_KEY, JSON.stringify(savedAlert));
    statusEl.textContent = "Alert saved! You will receive email notifications when matches are found";
  } catch (error) {
    statusEl.textContent = `Failed to save alert: ${error.message}`;
    return;
  } finally {
    saveAlertBtn.disabled = false;
  }

  await requestNotificationPermission();
  startAlertPolling(savedAlert);
});

loadSavedAlert();

function renderResults(properties) {
  resultsEl.innerHTML = "";

  if (!Array.isArray(properties) || properties.length === 0) {
    statusEl.textContent = "No properties found for the current filters.";
    return;
  }

  statusEl.textContent = `Found ${properties.length} propert${
    properties.length === 1 ? "y" : "ies"
  }.`;

  for (const property of properties) {
    const card = document.createElement("article");
    card.className = "card";

    const street = property.address?.full || property.address?.streetName || "Address unavailable";
    const city = property.address?.city || "";
    const state = property.address?.state || "";
    const addressLine = [street, city, state].filter(Boolean).join(", ");

    const price = formatPrice(property.listPrice);
    const beds = property.property?.bedrooms ?? "N/A";
    const baths = property.property?.bathsFull ?? property.property?.bathrooms ?? "N/A";
    const yearBuilt = property.property?.yearBuilt ?? "N/A";

    card.innerHTML = `
      <h3>${escapeHtml(addressLine)}</h3>
      <p><strong>Price:</strong> ${escapeHtml(price)}</p>
      <p><strong>Bedrooms:</strong> ${escapeHtml(String(beds))}</p>
      <p><strong>Bathrooms:</strong> ${escapeHtml(String(baths))}</p>
      <p><strong>Year Built:</strong> ${escapeHtml(String(yearBuilt))}</p>
    `;

    resultsEl.appendChild(card);
  }
}

function getCriteriaFromForm() {
  return {
    city: document.getElementById("city").value.trim(),
    propertyType: document.getElementById("propertyType").value,
    minPrice: document.getElementById("minPrice").value,
    maxPrice: document.getElementById("maxPrice").value,
    bedrooms: document.getElementById("bedrooms").value,
    maxAge: document.getElementById("maxAge").value,
  };
}

function validateCriteria(criteria) {
  if (
    criteria.minPrice &&
    criteria.maxPrice &&
    Number(criteria.minPrice) > Number(criteria.maxPrice)
  ) {
    statusEl.textContent = "Min price cannot be greater than max price.";
    return false;
  }

  return true;
}

function buildSearchParams(criteria) {
  const params = new URLSearchParams();

  if (criteria.city) params.append("cities", criteria.city);
  if (criteria.propertyType) params.append("type", criteria.propertyType);
  if (criteria.minPrice) params.append("minprice", criteria.minPrice);
  if (criteria.maxPrice) params.append("maxprice", criteria.maxPrice);
  if (criteria.bedrooms) params.append("bedrooms", criteria.bedrooms);

  if (criteria.maxAge) {
    const currentYear = new Date().getFullYear();
    const minYearBuilt = currentYear - Number(criteria.maxAge);
    params.append("minyear", String(minYearBuilt));
  }

  return params;
}

async function fetchProperties(criteria) {
  const params = buildSearchParams(criteria);
  const requestUrl = `${API_BASE_URL}?${params.toString()}`;
  const authToken = btoa(`${API_USERNAME}:${API_PASSWORD}`);

  const response = await fetch(requestUrl, {
    headers: {
      Authorization: `Basic ${authToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`API request failed (${response.status})`);
  }

  return response.json();
}

async function saveAlertToBackend(savedAlert) {
  const response = await fetch("https://listalert-production.up.railway.app/save-alert", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(savedAlert),
  });

  if (!response.ok) {
    let message = `Backend request failed (${response.status})`;
    try {
      const payload = await response.json();
      if (payload?.error) message = payload.error;
    } catch {
      // Keep fallback message when backend response is not JSON.
    }
    throw new Error(message);
  }
}

async function parseCriteriaWithAI(query) {
  const response = await fetch("/parse-natural-search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    let message = `AI endpoint failed (${response.status})`;
    try {
      const payload = await response.json();
      if (payload?.error) message = payload.error;
    } catch {
      // Keep fallback error if payload is not JSON.
    }
    throw new Error(message);
  }

  const payload = await response.json();
  if (!payload?.criteria || typeof payload.criteria !== "object") {
    throw new Error("Invalid AI response payload.");
  }

  return payload.criteria;
}

function applyParsedCriteriaToForm(criteria) {
  if (criteria.city) document.getElementById("city").value = String(criteria.city);
  if (criteria.propertyType) {
    const type = String(criteria.propertyType).toLowerCase();
    if (type === "house" || type === "apartment") {
      document.getElementById("propertyType").value = type;
    }
  }
  if (criteria.minPrice !== undefined && criteria.minPrice !== null) {
    document.getElementById("minPrice").value = String(criteria.minPrice);
  }
  if (criteria.maxPrice !== undefined && criteria.maxPrice !== null) {
    document.getElementById("maxPrice").value = String(criteria.maxPrice);
  }
  if (criteria.bedrooms !== undefined && criteria.bedrooms !== null) {
    document.getElementById("bedrooms").value = String(criteria.bedrooms);
  }
  if (criteria.maxAge !== undefined && criteria.maxAge !== null) {
    document.getElementById("maxAge").value = String(criteria.maxAge);
  }
}

function startAlertPolling(savedAlert) {
  if (pollTimer) clearInterval(pollTimer);

  previousAlertListingIds = new Set();
  pollForNewMatches(savedAlert);

  pollTimer = setInterval(() => {
    pollForNewMatches(savedAlert);
  }, POLL_INTERVAL_MS);
}

async function pollForNewMatches(savedAlert) {
  if (isPollingInProgress) return;
  isPollingInProgress = true;

  try {
    const properties = await fetchProperties(savedAlert.criteria);
    const currentIds = new Set(properties.map(getListingId).filter(Boolean));

    if (previousAlertListingIds.size > 0) {
      const newMatches = properties.filter((property) => {
        const id = getListingId(property);
        return id && !previousAlertListingIds.has(id);
      });

      if (newMatches.length > 0) {
        showNewMatchBadge(newMatches);
        showBrowserNotification(savedAlert.email, newMatches);
      }
    }

    previousAlertListingIds = currentIds;
  } catch (error) {
    statusEl.textContent = `Alert refresh failed: ${error.message}`;
  } finally {
    isPollingInProgress = false;
  }
}

function getListingId(property) {
  return String(
    property.mlsId || property.listingId || property.id || property.address?.full || ""
  );
}

function showNewMatchBadge(newMatches) {
  const details = newMatches
    .slice(0, 3)
    .map((property) => {
      const address = property.address?.full || "Address unavailable";
      const price = formatPrice(property.listPrice);
      return `<p>${escapeHtml(address)} - ${escapeHtml(price)}</p>`;
    })
    .join("");

  const moreCount = newMatches.length - 3;
  const moreLine = moreCount > 0 ? `<p>+${moreCount} more new listing(s)</p>` : "";

  alertBadgeEl.innerHTML = `<strong>New Match Found</strong>${details}${moreLine}`;
  alertBadgeEl.classList.remove("hidden");
}

function showBrowserNotification(email, newMatches) {
  if (Notification.permission !== "granted") return;

  const firstMatchAddress = newMatches[0]?.address?.full || "a saved property alert";
  const title = "New Match Found";
  const body = `${newMatches.length} new listing(s) for ${email}. First: ${firstMatchAddress}`;

  new Notification(title, { body });
}

async function requestNotificationPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted" || Notification.permission === "denied") return;
  await Notification.requestPermission();
}

function loadSavedAlert() {
  const raw = localStorage.getItem(ALERT_STORAGE_KEY);
  if (!raw) return;

  try {
    const savedAlert = JSON.parse(raw);
    if (!savedAlert?.criteria || !savedAlert?.email) return;

    document.getElementById("city").value = savedAlert.criteria.city || "";
    document.getElementById("propertyType").value = savedAlert.criteria.propertyType || "house";
    document.getElementById("minPrice").value = savedAlert.criteria.minPrice || "";
    document.getElementById("maxPrice").value = savedAlert.criteria.maxPrice || "";
    document.getElementById("bedrooms").value = savedAlert.criteria.bedrooms || "";
    document.getElementById("maxAge").value = savedAlert.criteria.maxAge || "";
    alertEmailEl.value = savedAlert.email || "";

    statusEl.textContent = "Loaded saved alert. Auto-check is running every 30 seconds.";
    startAlertPolling(savedAlert);
  } catch {
    localStorage.removeItem(ALERT_STORAGE_KEY);
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function formatPrice(value) {
  if (typeof value !== "number") return "N/A";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
