/**
 * Zaman Analysis — Shared Client-Side Password Gate (docs/auth.js)
 *
 * - Protects all 5 pages (index.html, intraday.html, hourly.html, daily.html, detail.html).
 * - Never stores the plain-text password in code; verifies the SHA-256 hash.
 * - Remembers the unlocked session across pages in localStorage / sessionStorage.
 * - Injects a "Lock" button in the top header bar so the user can lock/log out anytime.
 */
(function () {
  "use strict";

  const AUTH_STORAGE_KEY = "zaman_dse_auth_hash";
  // SHA-256 hash of the dashboard password (default: "zaman2026")
  const EXPECTED_SHA256_HASH =
    "d49ab4d33e4b9f8ded33633e1d2861950edda4cae186085afbb374a448646336";

  function isAuthenticated() {
    try {
      return (
        localStorage.getItem(AUTH_STORAGE_KEY) === EXPECTED_SHA256_HASH ||
        sessionStorage.getItem(AUTH_STORAGE_KEY) === EXPECTED_SHA256_HASH
      );
    } catch (_e) {
      return false;
    }
  }

  // Immediately lock the document before <body> renders to prevent any flash of content
  if (!isAuthenticated()) {
    document.documentElement.classList.add("auth-locked");
  }

  async function sha256Hex(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    if (window.crypto && window.crypto.subtle) {
      const hashBuffer = await window.crypto.subtle.digest("SHA-256", data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    // Pure-JS SHA-256 fallback for non-HTTPS contexts
    function rightRotate(value, amount) {
      return (value >>> amount) | (value << (32 - amount));
    }
    const mathPow = Math.pow;
    const maxWord = mathPow(2, 32);
    let result = "";
    const words = [];
    const asciiBitLength = str.length * 8;
    let hash = [];
    const k = [];
    let primeCounter = 0;
    const isComposite = {};
    for (let candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (let i = 0; i < 313; i += candidate) {
          isComposite[i] = candidate;
        }
        hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    str += "\x80";
    while ((str.length % 64) - 56) str += "\x00";
    for (let i = 0; i < str.length; i++) {
      const j = str.charCodeAt(i);
      words[i >> 2] |= j << (((3 - i) % 4) * 8);
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;
    for (let j = 0; j < words.length; ) {
      const w = words.slice(j, (j += 16));
      const oldHash = hash;
      hash = hash.slice(0, 8);
      for (let i = 0; i < 64; i++) {
        const w15 = w[i - 15],
          w2 = w[i - 2];
        const a = hash[0],
          e = hash[4];
        const temp1 =
          hash[7] +
          (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) +
          ((e & hash[5]) ^ (~e & hash[6])) +
          k[i] +
          (w[i] =
            i < 16
              ? w[i]
              : (w[i - 16] +
                  (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) +
                  w[i - 7] +
                  (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) |
                0);
        const temp2 =
          (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) +
          ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
      }
      for (let i = 0; i < 8; i++) {
        hash[i] = (hash[i] + oldHash[i]) | 0;
      }
    }
    for (let i = 0; i < 8; i++) {
      for (let j = 3; j + 1; j--) {
        const b = (hash[i] >> (j * 8)) & 255;
        result += (b < 16 ? 0 : "") + b.toString(16);
      }
    }
    return result;
  }

  function injectHeaderLockButton() {
    const actions = document.querySelector(".header-actions");
    if (!actions || document.getElementById("btn-auth-lock")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn";
    btn.id = "btn-auth-lock";
    btn.title = "Lock dashboard and require password";
    btn.textContent = "Lock";
    btn.addEventListener("click", () => {
      try {
        localStorage.removeItem(AUTH_STORAGE_KEY);
        sessionStorage.removeItem(AUTH_STORAGE_KEY);
      } catch (_e) {}
      document.documentElement.classList.add("auth-locked");
      renderLockOverlay();
    });
    actions.appendChild(btn);
  }

  function renderLockOverlay() {
    if (document.getElementById("zaman-auth-overlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "zaman-auth-overlay";
    overlay.className = "auth-lock-overlay";
    overlay.innerHTML = `
      <div class="auth-lock-card" role="dialog" aria-modal="true" aria-labelledby="auth-lock-title">
        <div class="auth-brand-row">
          <div class="brand-mark">DSE</div>
          <div>
            <h1 class="brand-title" id="auth-lock-title">Zaman Analysis</h1>
            <div class="brand-subtitle">Enter Password to Unlock Dashboard</div>
          </div>
        </div>

        <form id="zaman-auth-form" class="auth-lock-form" autocomplete="off">
          <div class="form-field">
            <label for="zaman-auth-password">Password</label>
            <div class="auth-password-wrap">
              <input
                type="password"
                id="zaman-auth-password"
                placeholder="Enter dashboard password..."
                required
                autofocus
              />
              <button type="button" class="btn auth-toggle-pw" id="btn-toggle-pw" tabindex="-1">Show</button>
            </div>
          </div>

          <div class="auth-options-row">
            <label class="auth-remember-label">
              <input type="checkbox" id="zaman-auth-remember" checked />
              <span>Remember me on this browser</span>
            </label>
          </div>

          <div class="auth-error-msg" id="zaman-auth-error" hidden>
            Incorrect password. Please try again.
          </div>

          <button type="submit" class="btn btn-primary auth-submit-btn">
            Unlock Zaman Analysis
          </button>
        </form>
      </div>
    `;

    document.body.appendChild(overlay);

    const input = document.getElementById("zaman-auth-password");
    const toggleBtn = document.getElementById("btn-toggle-pw");
    const rememberChk = document.getElementById("zaman-auth-remember");
    const errBox = document.getElementById("zaman-auth-error");
    const form = document.getElementById("zaman-auth-form");

    if (input) {
      setTimeout(() => input.focus(), 30);
    }

    if (toggleBtn && input) {
      toggleBtn.addEventListener("click", () => {
        const isPw = input.type === "password";
        input.type = isPw ? "text" : "password";
        toggleBtn.textContent = isPw ? "Hide" : "Show";
        input.focus();
      });
    }

    if (form) {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const val = input ? input.value : "";
        const digest = await sha256Hex(val);
        if (digest === EXPECTED_SHA256_HASH) {
          try {
            if (rememberChk && rememberChk.checked) {
              localStorage.setItem(AUTH_STORAGE_KEY, EXPECTED_SHA256_HASH);
            } else {
              sessionStorage.setItem(AUTH_STORAGE_KEY, EXPECTED_SHA256_HASH);
            }
          } catch (_e) {}
          document.documentElement.classList.remove("auth-locked");
          overlay.remove();
          injectHeaderLockButton();
        } else {
          if (errBox) errBox.hidden = false;
          if (input) {
            input.value = "";
            input.focus();
          }
        }
      });
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (isAuthenticated()) {
      document.documentElement.classList.remove("auth-locked");
      injectHeaderLockButton();
    } else {
      renderLockOverlay();
    }
  });
})();
