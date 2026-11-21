import QRCode from "qrcode";
import { journeyTypeForRoundTrip, scannerQrNote } from "./scanner-protocol.js";
import { getSubscriptionEstimate } from "./subscription.js";
import { getMonthEndDate, getMonthlyPassStatus } from "./ticket-status.js";
import "./style.css";

const routes = [
  {
    id: "bole-piassa",
    from: "Bole",
    to: "Piassa",
    duration: 35,
    fare: 45,
    trips: [
      { id: "bole-piassa-0815", departure: "08:15", arrival: "08:50", bus: "City shuttle", seatsLeft: 8 },
      { id: "bole-piassa-0900", departure: "09:00", arrival: "09:35", bus: "Express", seatsLeft: 14 },
      { id: "bole-piassa-1015", departure: "10:15", arrival: "10:50", bus: "City shuttle", seatsLeft: 5 },
    ],
  },
  {
    id: "bole-megenagna",
    from: "Bole",
    to: "Megenagna",
    duration: 25,
    fare: 35,
    trips: [
      { id: "bole-megenagna-0840", departure: "08:40", arrival: "09:05", bus: "City shuttle", seatsLeft: 11 },
      { id: "bole-megenagna-0930", departure: "09:30", arrival: "09:55", bus: "Express", seatsLeft: 7 },
    ],
  },
  {
    id: "mexico-megenagna",
    from: "Mexico",
    to: "Megenagna",
    duration: 30,
    fare: 40,
    trips: [
      { id: "mexico-megenagna-0905", departure: "09:05", arrival: "09:35", bus: "City shuttle", seatsLeft: 9 },
      { id: "mexico-megenagna-1000", departure: "10:00", arrival: "10:30", bus: "Express", seatsLeft: 13 },
    ],
  },
  {
    id: "bole-cmc",
    from: "Bole",
    to: "CMC",
    duration: 40,
    fare: 55,
    trips: [
      { id: "bole-cmc-0920", departure: "09:20", arrival: "10:00", bus: "City shuttle", seatsLeft: 12 },
      { id: "bole-cmc-1030", departure: "10:30", arrival: "11:10", bus: "Express", seatsLeft: 6 },
    ],
  },
  {
    id: "piassa-merkato",
    from: "Piassa",
    to: "Merkato",
    duration: 18,
    fare: 25,
    trips: [
      { id: "piassa-merkato-0835", departure: "08:35", arrival: "08:53", bus: "City shuttle", seatsLeft: 10 },
      { id: "piassa-merkato-0945", departure: "09:45", arrival: "10:03", bus: "City shuttle", seatsLeft: 4 },
    ],
  },
  {
    id: "piassa-meskel",
    from: "Piassa",
    to: "Meskel Square",
    duration: 20,
    fare: 30,
    trips: [
      { id: "piassa-meskel-0850", departure: "08:50", arrival: "09:10", bus: "Express", seatsLeft: 9 },
      { id: "piassa-meskel-1010", departure: "10:10", arrival: "10:30", bus: "City shuttle", seatsLeft: 15 },
    ],
  },
  {
    id: "megenagna-mexico",
    from: "Megenagna",
    to: "Mexico",
    duration: 18,
    fare: 30,
    trips: [
      { id: "megenagna-mexico-0820", departure: "08:20", arrival: "08:38", bus: "City shuttle", seatsLeft: 7 },
      { id: "megenagna-mexico-0910", departure: "09:10", arrival: "09:28", bus: "Express", seatsLeft: 12 },
    ],
  },
  {
    id: "merkato-cmc",
    from: "Merkato",
    to: "CMC",
    duration: 30,
    fare: 45,
    trips: [
      { id: "merkato-cmc-0900", departure: "09:00", arrival: "09:30", bus: "City shuttle", seatsLeft: 8 },
      { id: "merkato-cmc-1000", departure: "10:00", arrival: "10:30", bus: "Express", seatsLeft: 11 },
    ],
  },
];

const stopNames = [...new Set(routes.flatMap(({ from, to }) => [from, to]))];
const occupiedSeats = new Set(["02", "04", "07", "11"]);
const weekdays = [
  { value: 1, short: "Mon", name: "Monday" },
  { value: 2, short: "Tue", name: "Tuesday" },
  { value: 3, short: "Wed", name: "Wednesday" },
  { value: 4, short: "Thu", name: "Thursday" },
  { value: 5, short: "Fri", name: "Friday" },
  { value: 6, short: "Sat", name: "Saturday" },
  { value: 0, short: "Sun", name: "Sunday" },
];
const state = {
  appReady: false,
  apiError: "",
  gtfsError: "",
  gtfsRoutes: [],
  gtfsFeeds: [],
  page: "book",
  step: "search",
  from: "Bole",
  to: "Piassa",
  date: today(),
  route: null,
  trip: null,
  seat: null,
  holdExpiresAt: null,
  passenger: "",
  ticketId: "",
  holdTimer: null,
  walletBalance: 250,
  walletMessage: "",
  walletTransactions: [
    { id: "demo-opening-balance", label: "Starting demo balance", method: "Preview only", amount: 250, date: new Date().toLocaleDateString() },
  ],
  subscriptionForm: {
    routeId: routes[0].id,
    month: currentMonth(),
    weekdays: [1, 3, 5],
    roundTrip: false,
  },
  subscriptionMessage: "",
  subscriptionError: "",
  subscriptions: [],
  tickets: [],
  ticketDetail: null,
  savingPurchase: false,
  savingSubscription: false,
};

const app = document.querySelector("#app");

async function apiRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  } catch (error) {
    throw new Error(`Could not reach ${path}: ${error.message}`);
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed with status ${response.status}.`);
  return result;
}

async function refreshTicketRecords() {
  const [tickets, subscriptions] = await Promise.all([
    apiRequest("/api/tickets"),
    apiRequest("/api/subscriptions"),
  ]);
  state.tickets = tickets;
  state.subscriptions = subscriptions;
}

async function loadAppData() {
  state.appReady = false;
  state.apiError = "";
  render();
  try {
    const [loadedRoutes, gtfsData] = await Promise.all([
      apiRequest("/api/routes"),
      apiRequest(`/api/gtfs/routes?date=${encodeURIComponent(state.date)}`),
    ]);
    if (!Array.isArray(loadedRoutes) || loadedRoutes.length === 0) {
      throw new Error("The database has no sample routes.");
    }
    state.gtfsRoutes = Array.isArray(gtfsData.routes) ? gtfsData.routes : [];
    state.gtfsFeeds = Array.isArray(gtfsData.feeds) ? gtfsData.feeds : [];
    routes.splice(0, routes.length,
      ...loadedRoutes.map((route) => ({ ...route, sourceType: "sample", bookable: true })),
      ...state.gtfsRoutes,
    );
    stopNames.splice(0, stopNames.length, ...new Set(routes.flatMap(({ from, to }) => [from, to])));
    if (!routes.some(({ id, bookable }) => id === state.subscriptionForm.routeId && bookable)) {
      state.subscriptionForm.routeId = loadedRoutes[0].id;
    }
    await refreshTicketRecords();
    state.appReady = true;
  } catch (error) {
    state.apiError = `Could not load routes and tickets from PostgreSQL. ${error.message}`;
  }
  render();
}

function today() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function currentMonth() {
  return today().slice(0, 7);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

function formatLongDate(value) {
  return new Intl.DateTimeFormat("en", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

function money(value) {
  return `${value} ETB`;
}

function preciseMoney(value) {
  const rounded = Math.round(value * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(2)} ETB`;
}

function routeName(route) {
  return `${route.from} → ${route.to}`;
}

function renderHeader() {
  return `
    <header class="topbar">
      <a class="brand" href="#" data-action="home" aria-label="Ride Addis home">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 32 32" fill="none">
            <path d="M7 23.5V10.8c0-1 .8-1.8 1.8-1.8h14.4c1 0 1.8.8 1.8 1.8v12.7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
            <path d="M9 15h14M11 23.5v2M21 23.5v2M10.5 19.5h.1M21.5 19.5h.1" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
          </svg>
        </span>
        <span>ride<span class="brand-light">addis</span></span>
      </a>
      <nav class="topbar-nav" aria-label="Passenger pages">
        <button class="nav-link ${state.page === "book" ? "nav-link-active" : ""}" type="button" data-page="book" ${state.page === "book" ? 'aria-current="page"' : ""}>Book a ride</button>
        <button class="nav-link ${state.page === "wallet" ? "nav-link-active" : ""}" type="button" data-page="wallet" ${state.page === "wallet" ? 'aria-current="page"' : ""}>My balance</button>
        <button class="nav-link ${state.page === "subscription" ? "nav-link-active" : ""}" type="button" data-page="subscription" ${state.page === "subscription" ? 'aria-current="page"' : ""}>Monthly pass</button>
        <button class="nav-link ${state.page === "tickets" ? "nav-link-active" : ""}" type="button" data-page="tickets" ${state.page === "tickets" ? 'aria-current="page"' : ""}>My tickets</button>
      </nav>
      <div class="topbar-right">
        <span class="preview-label"><span></span> Passenger preview</span>
      </div>
    </header>
    ${state.apiError ? `<div class="api-error" role="alert"><span>${escapeHtml(state.apiError)}</span><button type="button" data-action="retry">Retry</button></div>` : ""}`;
}

function renderWallet() {
  const transactions = state.walletTransactions.map((transaction) => `
    <div class="transaction-row">
      <span class="transaction-icon ${transaction.amount < 0 ? "transaction-debit" : ""}" aria-hidden="true">${transaction.amount < 0 ? "↗" : "+"}</span>
      <span class="transaction-description"><strong>${escapeHtml(transaction.label)}</strong><small>${escapeHtml(transaction.method)} · ${escapeHtml(transaction.date)}</small></span>
      <strong class="transaction-amount ${transaction.amount < 0 ? "amount-debit" : ""}">${transaction.amount < 0 ? "−" : "+"}${preciseMoney(Math.abs(transaction.amount))}</strong>
    </div>
  `).join("");

  return `
    <main class="service-shell">
      <section class="service-intro">
        <div><span class="section-kicker">PASSENGER WALLET</span><h1>Your balance, <span class="heading-accent">at a glance.</span></h1><p>Top up a demo balance for your Ride Addis preview.</p></div>
        <span class="demo-only-tag">DEMO ONLY</span>
      </section>
      <div class="wallet-layout">
        <section class="wallet-balance-card">
          <span class="balance-card-label">AVAILABLE DEMO BALANCE</span>
          <strong class="balance-amount">${preciseMoney(state.walletBalance)}</strong>
          <span class="balance-card-footnote">In-page preview balance · resets when refreshed</span>
          <span class="balance-decoration" aria-hidden="true">✳</span>
        </section>
        <form class="service-card topup-card" id="topup-form">
          <div class="service-card-heading"><span class="checkout-icon">＋</span><div><h2>Add demo balance</h2><p>No payment is sent or processed.</p></div></div>
          <label class="field service-field"><span>TOP-UP AMOUNT</span><span class="service-select-wrap"><select name="amount"><option value="100">100 ETB</option><option value="250" selected>250 ETB</option><option value="500">500 ETB</option><option value="1000">1,000 ETB</option></select></span></label>
          <label class="field service-field"><span>MOCK PAYMENT METHOD</span><span class="service-select-wrap"><select name="method"><option>Telebirr (demo)</option><option>CBE Birr (demo)</option><option>Chapa (demo)</option></select></span></label>
          <div class="demo-notice"><span aria-hidden="true">ⓘ</span><span>Choosing a method only labels this sample top-up. No wallet or payment service is connected.</span></div>
          <button class="primary-button service-submit" type="submit">Add demo funds <span aria-hidden="true">→</span></button>
          ${state.walletMessage ? `<p class="success-message" role="status">${escapeHtml(state.walletMessage)}</p>` : ""}
        </form>
      </div>
      <section class="transactions-card">
        <div class="transactions-heading"><div><span class="section-kicker">LOCAL ACTIVITY</span><h2>Recent activity</h2></div><span class="local-only-label">This page only</span></div>
        <div class="transaction-list">${transactions}</div>
      </section>
    </main>`;
}

function passStatus(subscription) {
  return getMonthlyPassStatus(subscription.month, currentMonth());
}

function renderTicketListCard(record) {
  const isTicket = record.type === "ticket";
  const passState = isTicket ? "" : passStatus(record);
  const status = isTicket ? (record.usedAt ? "Used" : "Valid · expires after use") : `${passState[0].toUpperCase()}${passState.slice(1)}`;
  const route = isTicket ? `${record.from} → ${record.to}` : record.route;
  const date = isTicket ? formatDate(record.travelDate) : record.month;
  const amount = isTicket ? record.amount : record.price;
  return `
    <button class="record-card" type="button" data-record-type="${record.type}" data-record-id="${escapeHtml(record.id)}">
      <span class="record-icon ${status === "Used" || status === "Expired" ? "record-icon-muted" : ""}" aria-hidden="true">${isTicket ? "▣" : "↻"}</span>
      <span class="record-main">
        <span class="record-category">${isTicket ? "ONE-TIME TICKET" : "MONTHLY PASS"}</span>
        <strong>${escapeHtml(route)}</strong>
        <small>${escapeHtml(date)} · ${isTicket ? `Seat ${escapeHtml(record.seat)}` : escapeHtml(record.days)}</small>
      </span>
      <span class="record-end">
        <span class="record-status ${status === "Used" || status === "Expired" ? "record-status-muted" : ""}">${escapeHtml(status)}</span>
        <strong>${preciseMoney(amount)}</strong>
        <small>Amount paid · demo</small>
      </span>
      <span class="record-arrow" aria-hidden="true">→</span>
    </button>`;
}

function renderTicketList() {
  const records = [
    ...state.tickets.map((ticket) => ({ ...ticket, type: "ticket" })),
    ...state.subscriptions.map((subscription) => ({ ...subscription, type: "subscription" })),
  ];
  const currentRecords = records.filter((record) => {
    if (record.type === "ticket") return !record.usedAt;
    return passStatus(record) !== "expired";
  });
  const pastRecords = records.filter((record) => {
    if (record.type === "ticket") return Boolean(record.usedAt);
    return passStatus(record) === "expired";
  });

  return `
    <main class="my-tickets-shell">
      <section class="service-intro">
        <div><span class="section-kicker">YOUR TRAVEL RECORDS</span><h1>My <span class="heading-accent">tickets.</span></h1><p>Open a ticket or pass to see its route, demo amount, and status.</p></div>
        <span class="demo-only-tag">PREVIEW ONLY</span>
      </section>
      ${records.length ? `
        <section class="record-group">
          <div class="record-group-heading"><h2>Active &amp; upcoming</h2><span>${currentRecords.length}</span></div>
          ${currentRecords.length ? currentRecords.map(renderTicketListCard).join("") : `<p class="record-empty">No active tickets or upcoming passes.</p>`}
        </section>
        ${pastRecords.length ? `
          <section class="record-group past-records">
            <div class="record-group-heading"><h2>Used / expired</h2><span>${pastRecords.length}</span></div>
            ${pastRecords.map(renderTicketListCard).join("")}
          </section>` : ""}
      ` : `
        <section class="tickets-empty">
          <span class="empty-icon" aria-hidden="true">▣</span>
          <h2>Your tickets and passes will show up here</h2>
          <p>Complete a demo ticket booking or create a monthly pass to see its details and status.</p>
          <div><button class="outline-button" type="button" data-page="book">Find a trip</button><button class="outline-button" type="button" data-page="subscription">Explore monthly passes</button></div>
        </section>`}
      <p class="flow-disclaimer"><span aria-hidden="true">✳</span> These are local demo records. They are not real tickets or transit passes.</p>
    </main>`;
}

function renderTicketDetail(record) {
  if (!record) {
    state.ticketDetail = null;
    return renderTicketList();
  }
  const isTicket = state.ticketDetail.type === "ticket";
  if (isTicket) {
    const used = Boolean(record.usedAt);
    return `
      <main class="my-tickets-shell">
        <button class="back-link ticket-list-back" type="button" data-action="ticket-list"><span aria-hidden="true">←</span> Back to My tickets</button>
        <section class="ticket-detail-heading">
          <div><span class="section-kicker">ONE-TIME TICKET</span><h1>${escapeHtml(record.from)} <span class="heading-arrow">→</span> ${escapeHtml(record.to)}</h1><p>${formatDate(record.travelDate)} · ${escapeHtml(record.departure)} departure · Seat ${escapeHtml(record.seat)}</p></div>
          <span class="detail-status ${used ? "detail-status-muted" : ""}">${used ? "Used · expired" : "Valid until used"}</span>
        </section>
        <article class="ticket-detail-card">
          <div class="detail-summary-grid">
            <div><span>FROM</span><strong>${escapeHtml(record.from)}</strong></div>
            <div><span>TO</span><strong>${escapeHtml(record.to)}</strong></div>
            <div><span>TRAVEL DATE</span><strong>${formatLongDate(record.travelDate)}</strong></div>
            <div><span>AMOUNT PAID · DEMO</span><strong>${preciseMoney(record.amount)}</strong></div>
            <div><span>PASSENGER</span><strong>${escapeHtml(record.passenger)}</strong></div>
            <div><span>TICKET ID</span><strong>${escapeHtml(record.id)}</strong></div>
          </div>
          ${used ? `
            <div class="used-ticket-message"><strong>This demo ticket has been used.</strong><span>Marked used on ${formatLongDate(record.usedAt)}. The sample QR is no longer available.</span></div>
          ` : `
            <div class="ticket-detail-qr">
              <canvas id="history-ticket-qr" width="160" height="160" aria-label="Demo ticket QR code"></canvas>
              <div><span class="section-kicker">DEMO QR · NOT VALID FOR TRAVEL</span><h2>Valid until used</h2><p>Use the demo action below to simulate a scan. This changes only the local ticket status.</p></div>
            </div>
            <button class="primary-button use-ticket-button" type="button" data-action="use-ticket" data-ticket-id="${escapeHtml(record.id)}">Demo scan / mark as used <span aria-hidden="true">✓</span></button>
          `}
        </article>
        <p class="flow-disclaimer"><span aria-hidden="true">✳</span> The ticket and QR are sample data and cannot be used to board a bus.</p>
      </main>`;
  }

  const status = passStatus(record);
  const monthEnd = getMonthEndDate(record.month);
  const statusLabel = status === "expired" ? "Expired" : status === "upcoming" ? "Upcoming" : `Active through ${formatLongDate(monthEnd)}`;
  return `
    <main class="my-tickets-shell">
      <button class="back-link ticket-list-back" type="button" data-action="ticket-list"><span aria-hidden="true">←</span> Back to My tickets</button>
      <section class="ticket-detail-heading">
        <div><span class="section-kicker">MONTHLY PASS</span><h1>${escapeHtml(record.from)} <span class="heading-arrow">→</span> ${escapeHtml(record.to)}</h1><p>${escapeHtml(record.month)} · ${escapeHtml(record.roundTrip ? "Round trip" : "One way")}</p></div>
        <span class="detail-status ${status === "expired" ? "detail-status-muted" : ""}">${statusLabel}</span>
      </section>
      <article class="ticket-detail-card pass-detail-card">
        <div class="detail-summary-grid">
          <div><span>FROM</span><strong>${escapeHtml(record.from)}</strong></div>
          <div><span>TO</span><strong>${escapeHtml(record.to)}</strong></div>
          <div><span>TRAVEL DAYS</span><strong>${escapeHtml(record.days)}</strong></div>
          <div><span>AMOUNT PAID · DEMO</span><strong>${preciseMoney(record.price)}</strong></div>
          <div><span>STARTING MONTH</span><strong>${escapeHtml(record.month)}</strong></div>
          <div><span>EXPIRES AFTER</span><strong>${formatLongDate(monthEnd)}</strong></div>
        </div>
        <div class="ticket-detail-qr pass-detail-qr">
          <canvas id="history-pass-qr" width="160" height="160" aria-label="Demo monthly pass QR code"></canvas>
          <div><span class="section-kicker">DEMO PASS QR · NOT VALID FOR TRANSIT</span><h2>Preview code only</h2><p>This sample code is not connected to a scanner and does not validate travel.</p></div>
        </div>
        <div class="pass-expiry-note ${status === "expired" ? "pass-expired-note" : ""}">
          <strong>${status === "expired" ? "This pass has expired." : "Expires at the end of the selected month."}</strong>
          <span>${status === "expired" ? "A new month requires a new pass." : "This demo pass does not carry over into the next month."}</span>
        </div>
      </article>
      <p class="flow-disclaimer"><span aria-hidden="true">✳</span> Pass payment and validity are local preview data; no transit service is activated.</p>
    </main>`;
}

function renderMyTickets() {
  if (!state.ticketDetail) {
    app.innerHTML = `${renderHeader()}${renderTicketList()}`;
    return;
  }
  const records = state.ticketDetail.type === "ticket" ? state.tickets : state.subscriptions;
  const record = records.find(({ id }) => id === state.ticketDetail.id);
  app.innerHTML = `${renderHeader()}${renderTicketDetail(record)}`;
  if (state.ticketDetail.type === "ticket" && record && !record.usedAt) {
    QRCode.toCanvas(document.querySelector("#history-ticket-qr"), JSON.stringify({
      demo: true,
      ticket: record.id,
      route: `${record.from} to ${record.to}`,
      seat: record.seat,
      note: "SAMPLE ONLY - NOT VALID FOR TRAVEL",
    }), {
      width: 160,
      margin: 1,
      color: { dark: "#183f31", light: "#ffffff" },
      errorCorrectionLevel: "M",
    });
  }
  if (state.ticketDetail.type === "subscription" && record) {
    QRCode.toCanvas(document.querySelector("#history-pass-qr"), JSON.stringify({
      demo: true,
      pass: record.id,
      route: `${record.from} to ${record.to}`,
      month: record.month,
      weekdays: record.days,
      journeyType: journeyTypeForRoundTrip(record.roundTrip),
      note: scannerQrNote,
    }), {
      width: 160,
      margin: 1,
      color: { dark: "#183f31", light: "#ffffff" },
      errorCorrectionLevel: "M",
    });
  }
}

function selectedSubscriptionRoute() {
  return routes.find((route) => route.id === state.subscriptionForm.routeId && route.bookable) ??
    routes.find((route) => route.bookable);
}

function subscriptionEstimate() {
  const route = selectedSubscriptionRoute();
  return getSubscriptionEstimate({
    fare: route.fare,
    month: state.subscriptionForm.month,
    weekdays: state.subscriptionForm.weekdays,
    roundTrip: state.subscriptionForm.roundTrip,
  });
}

function renderSubscription() {
  const route = selectedSubscriptionRoute();
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(state.subscriptionForm.month);
  const hasSelectedDays = state.subscriptionForm.weekdays.length > 0;
  const estimate = validMonth && hasSelectedDays
    ? subscriptionEstimate()
    : { discount: 0, discountedFare: route.fare, weekdayOccurrences: 0, tripCount: 0, total: 0 };
  const selectedDays = weekdays.filter(({ value }) => state.subscriptionForm.weekdays.includes(value));
  const monthLabel = validMonth
    ? new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(new Date(`${state.subscriptionForm.month}-01T12:00:00`))
    : "Select a starting month";
  const passList = state.subscriptions.length ? `
    <section class="transactions-card pass-list-card">
      <div class="transactions-heading"><div><span class="section-kicker">YOUR PREVIEW PASSES</span><h2>Monthly subscriptions</h2></div><span class="local-only-label">Demo records only</span></div>
      <div class="transaction-list">
        ${state.subscriptions.map((subscription) => `
          <div class="transaction-row pass-row">
            <span class="transaction-icon" aria-hidden="true">✓</span>
            <span class="transaction-description"><strong>${escapeHtml(subscription.route)}</strong><small>${escapeHtml(subscription.month)} · ${escapeHtml(subscription.days)} · ${subscription.roundTrip ? "Round trip" : "One way"} · Preview only</small></span>
            <strong class="transaction-amount">${preciseMoney(subscription.price)}</strong>
          </div>
        `).join("")}
      </div>
    </section>` : "";

  return `
    <main class="service-shell">
      <section class="service-intro">
        <div><span class="section-kicker">REGULAR RIDERS</span><h1>A pass that fits <span class="heading-accent">your week.</span></h1><p>Pick a route, choose your travel days, and see an estimated monthly price.</p></div>
        <span class="demo-only-tag">DEMO ONLY</span>
      </section>
      <div class="subscription-layout">
        <form class="service-card subscription-form" id="subscription-form">
          <div class="service-card-heading"><span class="checkout-icon">01</span><div><h2>Build your monthly pass</h2><p>Choose the route and days you expect to ride.</p></div></div>
          <label class="field service-field"><span>ROUTE</span><span class="service-select-wrap"><select name="routeId">${routes.filter((candidate) => candidate.bookable).map((candidate) => `<option value="${escapeHtml(candidate.id)}" ${candidate.id === route.id ? "selected" : ""}>${escapeHtml(routeName(candidate))} · ${money(candidate.fare)} / trip</option>`).join("")}</select></span></label>
          <label class="field service-field"><span>STARTING MONTH</span><span class="service-input-wrap"><input type="month" name="month" min="${currentMonth()}" value="${state.subscriptionForm.month}" required /></span></label>
          <fieldset class="weekday-fieldset">
            <legend>CHOOSE YOUR WEEKDAYS <span>Select 1–7 days for your weekly discount</span></legend>
            <div class="weekday-grid">
              ${weekdays.map(({ value, short, name }) => `<label class="weekday-choice"><input type="checkbox" name="weekdays" value="${value}" ${state.subscriptionForm.weekdays.includes(value) ? "checked" : ""} /><span title="${name}">${short}</span></label>`).join("")}
            </div>
          </fieldset>
          ${!hasSelectedDays ? `<p class="field-hint">Select at least one weekday to see the estimate.</p>` : ""}
          <label class="roundtrip-choice"><input type="checkbox" name="roundTrip" ${state.subscriptionForm.roundTrip ? "checked" : ""} /><span><strong>Include a return ride</strong><small>Count two trips for each selected weekday.</small></span></label>
          <div class="estimate-inline" aria-live="polite">
            <span>Estimated for ${escapeHtml(monthLabel)}</span>
            <strong data-estimate-total>${preciseMoney(estimate.total)}</strong>
          </div>
          <div class="demo-notice"><span aria-hidden="true">ⓘ</span><span>Demo checkout only. Completing this pass deducts from the in-page demo balance; no real payment or service is activated.</span></div>
          ${state.subscriptionError ? `<p class="inline-alert" role="alert">${escapeHtml(state.subscriptionError)} <button class="inline-action" type="button" data-page="wallet">Go to demo balance</button></p>` : ""}
          ${state.subscriptionMessage ? `<p class="success-message" role="status">${escapeHtml(state.subscriptionMessage)}</p>` : ""}
          <button class="primary-button service-submit" type="submit" ${hasSelectedDays && validMonth && !state.savingSubscription ? "" : "disabled"}>${state.savingSubscription ? "Saving demo pass…" : "Activate demo pass"} <span aria-hidden="true">→</span></button>
        </form>
        <aside class="estimate-card">
          <span class="section-kicker">PRICE BREAKDOWN</span>
          <h2>${escapeHtml(routeName(route))}</h2>
          <p class="estimate-month">${escapeHtml(monthLabel)} · Sample fare ${money(route.fare)} per trip</p>
          <div class="estimate-price"><span>Estimated monthly total</span><strong data-estimate-total>${preciseMoney(estimate.total)}</strong></div>
          <div class="estimate-lines">
            <div><span>Selected travel days</span><strong>${selectedDays.length} / week</strong></div>
            <div><span>Plan discount</span><strong>${Math.round(estimate.discount * 100)}%</strong></div>
            <div><span>Discounted fare</span><strong>${preciseMoney(estimate.discountedFare)} / trip</strong></div>
            <div><span>${estimate.weekdayOccurrences} weekday occurrences × ${state.subscriptionForm.roundTrip ? "2" : "1"} ride${state.subscriptionForm.roundTrip ? "s" : ""}</span><strong>${estimate.tripCount} trips</strong></div>
          </div>
          <p class="pricing-note">Uses the plan’s sample weekly discount ladder (0%–30%) and counts each selected weekday in the chosen calendar month. Discounts are placeholders, not operator pricing.</p>
          <div class="wallet-mini"><span>Demo wallet balance</span><strong>${preciseMoney(state.walletBalance)}</strong><button type="button" data-page="wallet">Add demo balance <span aria-hidden="true">→</span></button></div>
        </aside>
      </div>
      ${passList}
    </main>`;
}

function renderSearch() {
  return `
    <section class="hero">
      <div class="hero-copy">
        <span class="eyebrow"><span class="eyebrow-line"></span> GET THERE, YOUR WAY</span>
        <h1>Your next ride<br />starts <span>here.</span></h1>
        <p>Find a bus, choose your seat, and keep your trip details close.</p>
        <div class="hero-note">
          <span class="note-icon" aria-hidden="true">✳</span>
          <span>Built for the everyday rhythm of Addis Ababa.</span>
        </div>
      </div>
      <div class="search-card">
        <div class="card-heading">
          <div>
            <span class="section-kicker">PLAN A JOURNEY</span>
            <h2>Where are you headed?</h2>
          </div>
          <span class="round-icon" aria-hidden="true">↗</span>
        </div>
        <form id="search-form">
          <div class="route-fields">
            <label class="field">
              <span>FROM</span>
              <span class="select-wrap">
                <span class="location-dot from-dot" aria-hidden="true"></span>
                <select name="from" aria-label="From">
                  ${stopNames.map((stop) => `<option value="${escapeHtml(stop)}" ${stop === state.from ? "selected" : ""}>${escapeHtml(stop)}</option>`).join("")}
                </select>
              </span>
            </label>
            <button class="swap-button" type="button" data-action="swap" aria-label="Swap origin and destination">↕</button>
            <label class="field">
              <span>TO</span>
              <span class="select-wrap">
                <span class="location-dot to-dot" aria-hidden="true"></span>
                <select name="to" aria-label="To">
                  ${stopNames.map((stop) => `<option value="${escapeHtml(stop)}" ${stop === state.to ? "selected" : ""}>${escapeHtml(stop)}</option>`).join("")}
                </select>
              </span>
            </label>
          </div>
          <label class="field date-field">
            <span>TRAVEL DATE</span>
            <span class="date-input-wrap">
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="5" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M6.5 3.5v3M13.5 3.5v3M3 8.5h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
              <input type="date" name="date" min="${today()}" value="${state.date}" required />
            </span>
          </label>
          <button class="primary-button search-button" type="submit">
            <span>Search buses</span><span class="button-arrow" aria-hidden="true">→</span>
          </button>
        </form>
        <p class="mock-caption"><span class="tiny-spark" aria-hidden="true">✳</span> Sample routes and schedules for preview only</p>
      </div>
    </section>
    <section class="how-strip" aria-label="How it works">
      <div class="how-heading"><span class="section-kicker">A SIMPLE RIDE</span><strong>From search to seat in a few steps.</strong></div>
      <div class="how-item"><span class="how-number">01</span><span>Find a trip</span></div>
      <span class="how-divider" aria-hidden="true"></span>
      <div class="how-item"><span class="how-number">02</span><span>Pick your seat</span></div>
      <span class="how-divider" aria-hidden="true"></span>
      <div class="how-item"><span class="how-number">03</span><span>Get your ticket</span></div>
    </section>`;
}

function renderProgress() {
  const steps = [
    ["trips", "Trip"],
    ["seats", "Seat"],
    ["checkout", "Checkout"],
    ["ticket", "Ticket"],
  ];
  const order = ["trips", "seats", "checkout", "ticket"];
  const current = order.indexOf(state.step);
  return `
    <nav class="stepper" aria-label="Booking steps">
      ${steps.map(([step, label], index) => `
        <div class="step ${index <= current ? "is-active" : ""} ${step === state.step ? "is-current" : ""}">
          <span class="step-circle">${index < current ? "✓" : `0${index + 1}`}</span>
          <span>${label}</span>
        </div>
        ${index < steps.length - 1 ? `<span class="step-line ${index < current ? "is-done" : ""}" aria-hidden="true"></span>` : ""}
      `).join("")}
    </nav>`;
}

function renderTrips() {
  const route = routes.find(({ from, to, bookable }) => bookable && from === state.from && to === state.to);
  const importedRoutes = state.gtfsRoutes.filter(({ from, to }) => from === state.from && to === state.to);
  state.route = route ?? null;
  const tripCards = route?.trips.map((trip) => `
    <article class="trip-card">
      <div class="trip-time">
        <strong>${trip.departure}</strong><span>${escapeHtml(state.from)}</span>
      </div>
      <div class="trip-duration">
        <span>${route.duration} min</span><span class="trip-track"><i></i></span><span>Direct</span>
      </div>
      <div class="trip-time trip-arrival">
        <strong>${trip.arrival}</strong><span>${escapeHtml(state.to)}</span>
      </div>
      <div class="trip-meta">
        <span class="bus-tag"><span aria-hidden="true">▰</span> ${trip.bus}</span>
        <span class="seats-available">${trip.seatsLeft} seats left</span>
      </div>
      <div class="trip-price"><strong>${money(route.fare)}</strong><span>per passenger</span></div>
      <button class="outline-button" type="button" data-trip="${trip.id}">Choose trip <span aria-hidden="true">→</span></button>
    </article>
  `).join("") ?? "";
  const importedTripCards = importedRoutes.flatMap((importedRoute) =>
    importedRoute.trips.map((trip) => {
      const frequencyLabel = trip.frequencies.length
        ? trip.frequencies.map(({ startTime, endTime, headwaySeconds }) =>
          `${escapeHtml(startTime)}–${escapeHtml(endTime)} · every ${Math.round(headwaySeconds / 60)} min`).join(", ")
        : "";
      const tripTime = trip.departure
        ? `<strong>${escapeHtml(trip.departure)}</strong><span>${escapeHtml(importedRoute.from)}</span>`
        : `<strong>Frequency service</strong><span>${frequencyLabel}</span>`;
      const arrival = trip.arrival
        ? `<strong>${escapeHtml(trip.arrival)}</strong><span>${escapeHtml(importedRoute.to)}</span>`
        : `<strong>—</strong><span>Arrival time not provided</span>`;
      const routeLabel = [importedRoute.routeShortName, importedRoute.routeLongName].filter(Boolean).join(" · ") || importedRoute.routeId;
      const via = importedRoute.stops.map(({ name }) => escapeHtml(name)).join(" → ");
      return `
        <article class="trip-card">
          <div class="trip-time">${tripTime}</div>
          <div class="trip-duration"><span>GTFS</span><span class="trip-track"><i></i></span><span>${escapeHtml(importedRoute.sourceName)}</span></div>
          <div class="trip-time trip-arrival">${arrival}</div>
          <div class="trip-meta">
            <span class="bus-tag">${escapeHtml(routeLabel)}</span>
            <span class="seats-available">Source route ${escapeHtml(importedRoute.routeId)}</span>
          </div>
          <div class="trip-price"><strong>Fare not provided</strong><span>Timetable only · not bookable</span></div>
          <p class="gtfs-stop-list">${via}</p>
        </article>`;
    }),
  ).join("");
  const feedNotices = state.gtfsFeeds.map((feed) => {
    const coverage = feed.dateCoverage;
    const range = coverage?.serviceStart && coverage?.serviceEnd
      ? `${coverage.serviceStart}–${coverage.serviceEnd}`
      : "no service-date range recorded";
    const collisionNotice = feed.collisions?.length
      ? ` · ${feed.collisions.length} source collisions preserved`
      : "";
    return `<p class="flow-disclaimer">Imported feed: ${escapeHtml(feed.name)} · service coverage ${escapeHtml(range)}${collisionNotice}</p>`;
  }).join("");
  const noImportedService = !importedRoutes.length && state.gtfsFeeds.length
    ? `<p class="flow-disclaimer">No imported GTFS service is available for this route and date. Imported feeds are preserved separately from sample routes.</p>`
    : "";

  return `
    <main class="flow-shell">
      ${renderProgress()}
      <div class="flow-heading">
        <div>
          <button class="back-link" type="button" data-action="home"><span aria-hidden="true">←</span> Edit search</button>
          <span class="section-kicker">AVAILABLE TRIPS</span>
          <h1>${escapeHtml(state.from)} <span class="heading-arrow">→</span> ${escapeHtml(state.to)}</h1>
          <p>${formatDate(state.date)} <span class="muted-dot">·</span> Sample and imported schedules</p>
        </div>
        <span class="results-count">${(route?.trips.length ?? 0) + importedRoutes.reduce((count, item) => count + item.trips.length, 0)} trips</span>
      </div>
      ${state.gtfsError ? `<p class="inline-alert" role="alert">${escapeHtml(state.gtfsError)}</p>` : ""}
      ${route ? `<div class="trip-list">${tripCards}</div>` : ""}
      ${importedTripCards ? `<section class="gtfs-results"><h2>Imported GTFS schedules</h2><div class="trip-list">${importedTripCards}</div></section>` : ""}
      ${!route && !importedRoutes.length ? `
        <div class="empty-state">
          <span class="empty-icon" aria-hidden="true">⌁</span>
          <h2>No trips on this route yet</h2>
          <p>Try one of these routes: ${routes.map(({ from, to, bookable }) => bookable ? `${escapeHtml(from)} to ${escapeHtml(to)}` : "").filter(Boolean).join(", ")}.</p>
          <button class="outline-button" type="button" data-action="home">Change route</button>
        </div>` : ""}
      ${feedNotices}${noImportedService}
      ${route ? `<p class="flow-disclaimer"><span aria-hidden="true">✳</span> Sample times, seat counts, and fares are preview data, not live bus information.</p>` : ""}
    </main>`;
}

function renderSeatGrid() {
  const rows = [];
  for (let row = 1; row <= 6; row += 1) {
    const seats = [1, 2, 3, 4].map((column) => {
      const number = String((row - 1) * 4 + column).padStart(2, "0");
      const isOccupied = occupiedSeats.has(number);
      const isSelected = state.seat === number;
      return `<button type="button" class="seat ${isOccupied ? "seat-taken" : ""} ${isSelected ? "seat-selected" : ""}" data-seat="${number}" ${isOccupied ? "disabled aria-label=\"Seat ${number}, unavailable\"" : `aria-label="Seat ${number}${isSelected ? ", selected" : ""}" aria-pressed="${isSelected}"`}>${number}</button>`;
    });
    rows.push(`
      <div class="seat-row">
        <span class="row-number">${String(row).padStart(2, "0")}</span>
        ${seats[0]}${seats[1]}<span class="seat-aisle" aria-hidden="true"></span>${seats[2]}${seats[3]}
      </div>`);
  }
  return rows.join("");
}

function holdSecondsLeft() {
  if (!state.holdExpiresAt) return 0;
  return Math.max(0, Math.ceil((state.holdExpiresAt - Date.now()) / 1000));
}

function renderSeats() {
  const held = holdSecondsLeft() > 0;
  return `
    <main class="flow-shell">
      ${renderProgress()}
      <button class="back-link flow-back" type="button" data-action="trips"><span aria-hidden="true">←</span> Back to trips</button>
      <div class="flow-heading compact-heading">
        <div>
          <span class="section-kicker">PICK YOUR SEAT</span>
          <h1>Make it <span class="heading-accent">your ride.</span></h1>
          <p>${escapeHtml(state.trip.departure)} departure <span class="muted-dot">·</span> ${escapeHtml(state.trip.bus)}</p>
        </div>
        <div class="trip-summary-mini"><span>${escapeHtml(state.from)} → ${escapeHtml(state.to)}</span><strong>${money(state.route.fare)}</strong></div>
      </div>
      <div class="seat-layout">
        <section class="seat-picker-card">
          <div class="bus-front"><span class="steering" aria-hidden="true">◉</span><span>FRONT OF BUS</span></div>
          <div class="seat-map" aria-label="Bus seat map">${renderSeatGrid()}</div>
          <div class="seat-legend">
            <span><i class="legend-seat available-seat"></i> Available</span>
            <span><i class="legend-seat selected-seat"></i> Selected</span>
            <span><i class="legend-seat unavailable-seat"></i> Taken</span>
          </div>
        </section>
        <aside class="booking-summary">
          <span class="section-kicker">YOUR SELECTION</span>
          <h2>Trip summary</h2>
          <div class="summary-route">
            <span class="summary-dot"></span>
            <div><strong>${escapeHtml(state.from)}</strong><span>${escapeHtml(state.trip.departure)}</span></div>
          </div>
          <div class="summary-connector"></div>
          <div class="summary-route">
            <span class="summary-dot destination-dot"></span>
            <div><strong>${escapeHtml(state.to)}</strong><span>${escapeHtml(state.trip.arrival)}</span></div>
          </div>
          <div class="summary-rule"></div>
          <div class="summary-line"><span>Date</span><strong>${formatDate(state.date)}</strong></div>
          <div class="summary-line"><span>Seat</span><strong>${state.seat ? state.seat : "Choose a seat"}</strong></div>
          <div class="summary-rule"></div>
          <div class="summary-line total-line"><span>Trip fare</span><strong>${money(state.route.fare)}</strong></div>
          ${held ? `<div class="hold-timer" role="status"><span>◷</span> Seat held for <strong>${String(Math.floor(holdSecondsLeft() / 60)).padStart(2, "0")}:${String(holdSecondsLeft() % 60).padStart(2, "0")}</strong></div>` : ""}
          ${state.holdExpired ? `<p class="inline-alert" role="alert">Your seat hold expired. Select a seat and hold it again.</p>` : ""}
          ${held ? `
            <button class="primary-button summary-button" type="button" data-action="checkout">Continue to checkout <span aria-hidden="true">→</span></button>
          ` : `
            <button class="primary-button summary-button" type="button" data-action="hold" ${state.seat ? "" : "disabled"}>${state.holdExpired ? "Hold this seat again" : "Hold seat for 5 minutes"} <span aria-hidden="true">→</span></button>
          `}
          <p class="safe-note"><span aria-hidden="true">⌑</span> This preview hold is stored only in this page.</p>
        </aside>
      </div>
      <p class="flow-disclaimer"><span aria-hidden="true">✳</span> Seat availability is fixed sample data and is not shared with a real bus operator.</p>
    </main>`;
}

function renderCheckout() {
  const seconds = holdSecondsLeft();
  return `
    <main class="flow-shell">
      ${renderProgress()}
      <button class="back-link flow-back" type="button" data-action="seats"><span aria-hidden="true">←</span> Back to seat selection</button>
      <div class="flow-heading compact-heading">
        <div>
          <span class="section-kicker">PASSENGER DETAILS</span>
          <h1>Almost <span class="heading-accent">there.</span></h1>
          <p>Your held seat is reserved in this preview for ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.</p>
        </div>
      </div>
      <div class="checkout-layout">
        <form class="checkout-card" id="checkout-form">
          <div class="checkout-section-heading"><span class="checkout-icon">01</span><div><h2>Who’s travelling?</h2><p>Details are used only to personalize this demo ticket.</p></div></div>
          <label class="field passenger-field"><span>PASSENGER NAME</span><input type="text" name="passenger" placeholder="Enter your name" autocomplete="name" required maxlength="60" value="${escapeHtml(state.passenger)}" /></label>
          <div class="mock-payment">
            <span class="payment-symbol" aria-hidden="true">✳</span>
            <div><strong>Demo checkout</strong><p>No payment is connected. Nothing will be charged.</p></div>
            <span class="demo-only-tag">MOCK</span>
          </div>
          <button class="primary-button checkout-button" type="submit" ${state.savingPurchase ? "disabled" : ""}>${state.savingPurchase ? "Saving demo ticket…" : "Complete demo checkout"} <span aria-hidden="true">→</span></button>
          <p class="checkout-footnote">Continuing creates a sample ticket only. It cannot be used for travel.</p>
        </form>
        <aside class="booking-summary checkout-summary">
          <span class="section-kicker">ORDER SUMMARY</span>
          <h2>One easy ride</h2>
          <div class="summary-route">
            <span class="summary-dot"></span>
            <div><strong>${escapeHtml(state.from)}</strong><span>${escapeHtml(state.trip.departure)}</span></div>
          </div>
          <div class="summary-connector"></div>
          <div class="summary-route">
            <span class="summary-dot destination-dot"></span>
            <div><strong>${escapeHtml(state.to)}</strong><span>${escapeHtml(state.trip.arrival)}</span></div>
          </div>
          <div class="summary-rule"></div>
          <div class="summary-line"><span>${formatDate(state.date)}</span><strong>Seat ${state.seat}</strong></div>
          <div class="summary-rule"></div>
          <div class="summary-line total-line"><span>Demo fare</span><strong>${money(state.route.fare)}</strong></div>
        </aside>
      </div>
    </main>`;
}

async function renderTicket() {
  const markup = `
    <main class="flow-shell ticket-flow">
      ${renderProgress()}
      <div class="ticket-success">
        <span class="success-check" aria-hidden="true">✓</span>
        <span class="section-kicker">DEMO BOOKING COMPLETE</span>
        <h1>You’re all <span class="heading-accent">set.</span></h1>
        <p>Your sample e-ticket is ready. This is a local preview, not a travel ticket.</p>
      </div>
      <article class="ticket-card">
        <div class="ticket-top">
          <div class="ticket-brand"><span class="brand-mark small-mark" aria-hidden="true">↗</span><strong>ride<span class="brand-light">addis</span></strong></div>
          <span class="ticket-id">${escapeHtml(state.ticketId)}</span>
        </div>
        <div class="ticket-warning"><span aria-hidden="true">!</span> DEMO TICKET · NOT VALID FOR TRAVEL</div>
        <div class="ticket-route">
          <div class="ticket-stop"><span class="ticket-stop-label">FROM</span><strong>${escapeHtml(state.from)}</strong><span>${escapeHtml(state.trip.departure)}</span></div>
          <div class="ticket-route-line"><i></i><span>✦</span></div>
          <div class="ticket-stop destination-stop"><span class="ticket-stop-label">TO</span><strong>${escapeHtml(state.to)}</strong><span>${escapeHtml(state.trip.arrival)}</span></div>
        </div>
        <div class="ticket-info-grid">
          <div><span>PASSENGER</span><strong>${escapeHtml(state.passenger)}</strong></div>
          <div><span>DATE</span><strong>${formatDate(state.date)}</strong></div>
          <div><span>SEAT</span><strong>${escapeHtml(state.seat)}</strong></div>
          <div><span>FARE</span><strong>${money(state.route.fare)} <small>· demo</small></strong></div>
        </div>
        <div class="ticket-bottom">
          <canvas id="ticket-qr" width="176" height="176" aria-label="Demo ticket QR code"></canvas>
          <div class="ticket-qr-copy"><span class="section-kicker">YOUR DEMO QR</span><strong>Just for this preview.</strong><p>This QR contains sample data and won’t scan as a real bus ticket.</p></div>
        </div>
      </article>
      <button class="primary-button return-button" type="button" data-action="home">Plan another trip <span aria-hidden="true">→</span></button>
    </main>`;
  app.innerHTML = `${renderHeader()}${markup}`;
  const qrData = JSON.stringify({
    demo: true,
    ticket: state.ticketId,
    passenger: state.passenger,
    route: `${state.from} to ${state.to}`,
    seat: state.seat,
    note: "SAMPLE ONLY - NOT VALID FOR TRAVEL",
  });
  await QRCode.toCanvas(document.querySelector("#ticket-qr"), qrData, {
    width: 176,
    margin: 1,
    color: { dark: "#183f31", light: "#ffffff" },
    errorCorrectionLevel: "M",
  });
}

function render() {
  if (!state.appReady) {
    app.innerHTML = `${renderHeader()}<main class="connection-state"><span class="section-kicker">LOCAL DATABASE</span><h1>${state.apiError ? "Preview data unavailable" : "Connecting to PostgreSQL…"}</h1><p>${state.apiError ? "Start PostgreSQL and retry to load the routes and saved tickets." : "Loading routes and saved demo records."}</p></main>`;
    return;
  }
  if (state.page === "wallet") {
    app.innerHTML = `${renderHeader()}${renderWallet()}`;
    return;
  }
  if (state.page === "subscription") {
    app.innerHTML = `${renderHeader()}${renderSubscription()}`;
    return;
  }
  if (state.page === "tickets") {
    renderMyTickets();
    return;
  }
  if (state.step === "ticket") {
    renderTicket();
    return;
  }
  const content = {
    search: renderSearch,
    trips: renderTrips,
    seats: renderSeats,
    checkout: renderCheckout,
  }[state.step]();
  app.innerHTML = `${renderHeader()}${content}`;
}

function clearHold() {
  state.holdExpiresAt = null;
  state.holdExpired = false;
  clearInterval(state.holdTimer);
  state.holdTimer = null;
}

function beginHold() {
  if (!state.seat) return;
  state.holdExpiresAt = Date.now() + 5 * 60 * 1000;
  state.holdExpired = false;
  render();
  state.holdTimer = setInterval(() => {
    if (holdSecondsLeft() <= 0) {
      clearHold();
      state.holdExpired = true;
      state.step = "seats";
      render();
      return;
    }
    const timer = document.querySelector(".hold-timer strong");
    if (timer) {
      const seconds = holdSecondsLeft();
      timer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    }
    const checkoutCopy = document.querySelector(".compact-heading p");
    if (checkoutCopy && state.step === "checkout") {
      const seconds = holdSecondsLeft();
      checkoutCopy.textContent = `Your held seat is reserved in this preview for ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.`;
    }
  }, 1000);
}

function chooseTrip(tripId) {
  const trip = state.route?.trips.find((candidate) => candidate.id === tripId);
  if (!trip) return;
  state.trip = trip;
  state.seat = null;
  clearHold();
  state.step = "seats";
  render();
}

function resetBooking() {
  clearHold();
  state.page = "book";
  state.step = "search";
  state.route = null;
  state.trip = null;
  state.seat = null;
  state.passenger = "";
  state.ticketId = "";
  state.holdExpired = false;
  render();
}

app.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action], [data-trip], [data-seat], [data-page], [data-record-type][data-record-id]");
  if (!target) return;
  if (target.dataset.action === "retry") {
    await loadAppData();
    return;
  }
  if (target.dataset.page) {
    state.page = target.dataset.page;
    state.ticketDetail = null;
    render();
    if (state.page === "tickets") {
      try {
        await refreshTicketRecords();
        state.apiError = "";
      } catch (error) {
        state.apiError = `Could not load saved tickets. ${error.message}`;
      }
      render();
    }
    return;
  }
  if (target.dataset.action === "ticket-list") {
    state.ticketDetail = null;
    render();
    return;
  }
  if (target.dataset.action === "use-ticket") {
    try {
      const ticket = await apiRequest(`/api/tickets/${encodeURIComponent(target.dataset.ticketId)}/use`, { method: "POST" });
      state.tickets = state.tickets.map((existing) => existing.id === ticket.id ? ticket : existing);
      state.apiError = "";
    } catch (error) {
      state.apiError = `Could not update ticket status. ${error.message}`;
    }
    render();
    return;
  }
  if (target.dataset.recordType && target.dataset.recordId) {
    state.page = "tickets";
    state.ticketDetail = { type: target.dataset.recordType, id: target.dataset.recordId };
    render();
    return;
  }
  if (target.dataset.action === "home") resetBooking();
  if (target.dataset.action === "swap") {
    [state.from, state.to] = [state.to, state.from];
    render();
  }
  if (target.dataset.action === "trips") {
    clearHold();
    state.step = "trips";
    render();
  }
  if (target.dataset.action === "seats") {
    if (holdSecondsLeft() <= 0) {
      clearHold();
      state.holdExpired = true;
      state.step = "seats";
    } else {
      state.step = "seats";
    }
    render();
  }
  if (target.dataset.trip) chooseTrip(target.dataset.trip);
  if (target.dataset.seat && !target.disabled) {
    clearHold();
    state.seat = target.dataset.seat;
    state.holdExpired = false;
    render();
  }
  if (target.dataset.action === "hold") beginHold();
  if (target.dataset.action === "checkout") {
    if (holdSecondsLeft() <= 0) {
      clearHold();
      state.holdExpired = true;
      state.step = "seats";
    } else {
      state.step = "checkout";
    }
    render();
  }
});

app.addEventListener("change", (event) => {
  if (event.target.form?.id !== "subscription-form") return;
  const form = event.target.form;
  const formData = new FormData(form);
  state.subscriptionForm = {
    routeId: String(formData.get("routeId")),
    month: String(formData.get("month") ?? ""),
    weekdays: formData.getAll("weekdays").map(Number),
    roundTrip: formData.get("roundTrip") === "on",
  };
  state.subscriptionError = "";
  state.subscriptionMessage = "";
  render();
});

app.addEventListener("submit", async (event) => {
  if (event.target.id === "search-form") {
    event.preventDefault();
    const form = new FormData(event.target);
    state.from = String(form.get("from"));
    state.to = String(form.get("to"));
    state.date = String(form.get("date"));
    state.gtfsError = "";
    try {
      const gtfsData = await apiRequest(`/api/gtfs/routes?date=${encodeURIComponent(state.date)}`);
      state.gtfsRoutes = Array.isArray(gtfsData.routes) ? gtfsData.routes : [];
      state.gtfsFeeds = Array.isArray(gtfsData.feeds) ? gtfsData.feeds : [];
      const sampleRoutes = routes.filter(({ bookable }) => bookable);
      routes.splice(0, routes.length, ...sampleRoutes, ...state.gtfsRoutes);
      stopNames.splice(0, stopNames.length, ...new Set(routes.flatMap(({ from, to }) => [from, to])));
    } catch (error) {
      state.gtfsRoutes = [];
      state.gtfsFeeds = [];
      state.gtfsError = `Could not load imported GTFS schedules. ${error.message}`;
      routes.splice(0, routes.length, ...routes.filter(({ bookable }) => bookable));
      stopNames.splice(0, stopNames.length, ...new Set(routes.flatMap(({ from, to }) => [from, to])));
    }
    state.step = "trips";
    render();
  }
  if (event.target.id === "checkout-form") {
    event.preventDefault();
    if (holdSecondsLeft() <= 0) {
      clearHold();
      state.holdExpired = true;
      state.step = "seats";
      render();
      return;
    }
    state.passenger = String(new FormData(event.target).get("passenger")).trim();
    if (!state.passenger) return;
    state.savingPurchase = true;
    state.apiError = "";
    render();
    try {
      const ticket = await apiRequest("/api/tickets", {
        method: "POST",
        body: JSON.stringify({
          routeId: state.route.id,
          tripId: state.trip.id,
          travelDate: state.date,
          seat: state.seat,
          passenger: state.passenger,
        }),
      });
      state.ticketId = ticket.id;
      state.tickets.unshift(ticket);
      state.savingPurchase = false;
      clearHold();
      state.step = "ticket";
    } catch (error) {
      state.savingPurchase = false;
      state.apiError = `Could not save your demo ticket. ${error.message}`;
    }
    render();
    return;
  }
  if (event.target.id === "topup-form") {
    event.preventDefault();
    const form = new FormData(event.target);
    const amount = Number(form.get("amount"));
    const method = String(form.get("method"));
    if (![100, 250, 500, 1000].includes(amount) || !["Telebirr (demo)", "CBE Birr (demo)", "Chapa (demo)"].includes(method)) {
      state.walletMessage = "Choose one of the listed demo amounts and methods.";
      render();
      return;
    }
    state.walletBalance = Math.round((state.walletBalance + amount) * 100) / 100;
    state.walletTransactions.unshift({
      id: `topup-${Date.now()}`,
      label: "Demo balance top-up",
      method,
      amount,
      date: new Date().toLocaleDateString(),
    });
    state.walletMessage = `${money(amount)} added to your demo balance. No payment was made.`;
    render();
  }
  if (event.target.id === "subscription-form") {
    event.preventDefault();
    const route = selectedSubscriptionRoute();
    if (state.subscriptionForm.weekdays.length < 1 || state.subscriptionForm.weekdays.length > 7) {
      state.subscriptionError = "Choose at least one weekday to calculate a pass.";
      render();
      return;
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(state.subscriptionForm.month)) {
      state.subscriptionError = "Choose a starting month to calculate a pass.";
      render();
      return;
    }
    const estimate = subscriptionEstimate();
    if (state.walletBalance + 0.001 < estimate.total) {
      state.subscriptionError = `This pass is ${preciseMoney(estimate.total)}, but your demo balance is ${preciseMoney(state.walletBalance)}. Add mock balance to continue.`;
      state.subscriptionMessage = "";
      render();
      return;
    }
    state.savingSubscription = true;
    state.apiError = "";
    render();
    let subscription;
    try {
      subscription = await apiRequest("/api/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          routeId: route.id,
          month: state.subscriptionForm.month,
          weekdays: state.subscriptionForm.weekdays,
          roundTrip: state.subscriptionForm.roundTrip,
        }),
      });
    } catch (error) {
      state.savingSubscription = false;
      state.apiError = `Could not save your demo monthly pass. ${error.message}`;
      render();
      return;
    }
    state.walletBalance = Math.round((state.walletBalance - subscription.price) * 100) / 100;
    const selectedDays = weekdays.filter(({ value }) => state.subscriptionForm.weekdays.includes(value)).map(({ short }) => short);
    state.walletTransactions.unshift({
      id: subscription.id,
      label: `Demo monthly pass · ${routeName(route)}`,
      method: "Demo wallet",
      amount: -subscription.price,
      date: new Date().toLocaleDateString(),
    });
    state.subscriptions.unshift(subscription);
    state.savingSubscription = false;
    state.subscriptionError = "";
    state.apiError = "";
    state.subscriptionMessage = `Demo pass created for ${routeName(route)}. ${preciseMoney(subscription.price)} was deducted from the in-page demo balance only.`;
    render();
  }
});

loadAppData();
