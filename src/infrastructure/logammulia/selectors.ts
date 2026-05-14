/**
 * All Playwright selectors for the Logam Mulia website.
 *
 * ⚠️  These selectors are best-effort based on common e-commerce patterns.
 *     If the website UI changes, update the values here — no other files need changing.
 *
 * Each selector is annotated with a TODO when the actual DOM value is uncertain.
 */
export const SELECTORS = {
  login: {
    // Email field — type="text" (not type="email"), identified by name attribute
    emailInput: 'input[name="email"]',

    // Password field — identified by name; also has id="id_password" as fallback
    passwordInput: 'input[name="password"], #id_password',

    // Submit button — <input type="submit" id="login-btn">
    submitButton: 'input#login-btn',

    // Form selector — used to detect whether we're still on the login page
    loginForm: '#login_form',

    // Confirmed from actual post-login HTML:
    // li.user-desktop is the navbar user menu container (desktop) — only present when logged in.
    // a[href*="/logout"] is the "KELUAR" link in the user dropdown.
    loggedInIndicator: 'li.user-desktop, a[href*="/logout"]',

    // reCAPTCHA is present on the login form.
    // If automated login is blocked, set HEADLESS=false so the user can solve it manually
    // on the first run, after which the saved session is reused automatically.
    recaptchaSelector: '.g-recaptcha',
  },

  stock: {
    // URL fragment that indicates the session has expired and the user was redirected to login
    loginRedirectUrl: '/login',

    // ── Change-location popup (AJAX-loaded via Fancybox) ─────────────────────

    // Confirmed: <a href="#" id="btnChangeLocation" data-fancybox data-type="ajax"
    //              data-src="https://www.logammulia.com/change-location">Ubah Lokasi</a>
    // The desktop page button; a second one in the top header has id="btnChangeLocation2"
    locationPopupTrigger: 'a#btnChangeLocation, a#btnChangeLocation2',

    // Confirmed: <select id="location" name="location"> injected inside popup via AJAX
    locationSelect: 'select#location',

    // Confirmed: <div class="popup-change-location popup-general"> (Fancybox container)
    locationPopup: '.popup-change-location',

    // Confirmed: <form id="change-location" action="...do-change-location">
    changeLocationForm: '#change-location',

    // Confirmed: <input type="submit" id="change-location-button" ...>
    changeLocationSubmit: '#change-location-button',

    // ── Transaction Purpose popup (AJAX, auto-opens when tujuanTransaksi not set) ──

    // Confirmed: <div class="popup-change-destination-transaction ..."> (Fancybox container)
    // Only appears on first visit when session doesn't have a confirmed tujuanTransaksi value
    transactionPurposePopup: '.popup-change-destination-transaction',

    // Confirmed: <select name="tujuan_transaksi" id="tujuan_transaksi">
    // Default pre-selected option: "Investasi/Pemakaian Pribadi"
    transactionPurposeSelect: '#tujuan_transaksi',

    // Confirmed: <input type="submit" id="change-destination-transaction-button">
    transactionPurposeSubmit: '#change-destination-transaction-button',

    // ── Stock table (confirmed from checkout.html) ────────────────────────────

    // Confirmed: inside <form id="purchase"> → <div class="cart-table"> → <div class="ct-body">
    stockContainer: '.cart-table .ct-body',

    // Confirmed: <div class="ctr"> for each product row.
    // When no stock: <div class="ctr disabled"> (has .disabled CSS class)
    stockItem: '.ctr',

    // Confirmed: <div class="ngc-text"> contains product name as first text node
    // e.g.  "Emas Batangan - 5 gr" followed by child <span class="no-stock"> when unavailable
    weightLabel: '.ngc-text',

    // Confirmed: <input type="number" class="input-text qty text" name="qty[]">
    // The `max` attribute is set by page JavaScript when stock is available (may not be present
    // in the raw HTML — its absence means fall back to binary: qty=1 when row is not disabled)
    qtyValue: 'input.qty[type="number"]',

    // Confirmed: <span class="no-stock">Belum tersedia</span> inside .ngc-text
    soldOutIndicator: 'span.no-stock',

    // Text patterns that indicate a sold-out / unavailable status (case-insensitive)
    soldOutTexts: [
      'belum tersedia',  // confirmed from actual HTML (span.no-stock text)
      'stok habis',
      'tidak tersedia',
      'habis',
      'out of stock',
      'sold out',
      'unavailable',
      'kosong',
    ],

    // Confirmed: .cart-table appears when the stock page has finished loading
    pageLoadIndicator: '.cart-table',

    // Generic Fancybox close button — used to dismiss popups programmatically
    fancyboxClose: '[data-fancybox-close], .fancybox-close-small, .fancybox-button--close',
  },
};
