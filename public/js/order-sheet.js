import { closeTopLayer } from "./overlays.js";
import { renderCookingLoader } from "./cooking-loader.js";
import {
  GROCERY_PLATFORMS,
  FOOD_PLATFORMS,
  extractMissingIngredients,
  buildGroceryDeepLink,
  buildRestaurantDeepLink,
  simplifyDishName
} from "./delivery-links.js";
import {
  fetchGroceryAddresses,
  searchGroceries,
  manageGroceryCart,
  searchFoodRestaurants,
  fetchFoodMenu,
  manageFoodCart,
  callMcpTool
} from "./mcp-client.js";

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  }[c]));

function isPlatformMcpConnected(platformId, mcpStatus) {
  if (!mcpStatus?.available) return false;
  if (platformId === "swiggy-im" || platformId === "swiggy-food") {
    return Boolean(mcpStatus.providers?.swiggy?.connected);
  }
  if (platformId === "zepto") {
    return Boolean(mcpStatus.providers?.zepto?.connected);
  }
  if (platformId === "blinkit") {
    return Boolean(mcpStatus.providers?.blinkit?.connected && mcpStatus.providers?.blinkit?.loggedIn);
  }
  return false;
}

function formatPrice(val) {
  if (val == null || val === "") return "";
  const str = String(val).trim();
  if (str.startsWith("₹") || /^INR\s/i.test(str)) return str;
  const num = Number(str);
  if (Number.isFinite(num)) return `₹${num}`;
  return str;
}

/**
 * Native <dialog> Ordering Sheet controller combining static deep-links with
 * live Local MCP Companion search, carts, and two-step confirmed ordering.
 */
export class OrderSheetController {
  constructor(dialogEl, callbacks = {}) {
    this.dialog = dialogEl;
    this.cb = callbacks;

    this.recipe = null;
    this.activeTab = "groceries"; // "groceries" | "restaurants"
    this.groceryPlatform = "swiggy-im";
    this.foodPlatform = "swiggy-food";
    this.autoMatchPantry = true;

    // Grocery MCP state
    this.groceryAddresses = {}; // provider -> array
    this.selectedGroceryAddr = {}; // provider -> id
    this.groceryResults = {}; // `${provider}:${ingIdx}` -> items[]
    this.groceryLoading = false;
    this.groceryLoadingLabel = "";
    this.groceryCart = null;
    this.groceryError = "";
    this.confirmGroceryOrder = false;
    this.groceryOrderReceipt = null;

    // Restaurant MCP & deep-link state
    this.dishQuery = "";
    this.city = "";
    this.foodAddresses = [];
    this.selectedFoodAddr = "";
    this.restaurants = [];
    this.selectedRestaurant = null;
    this.menuItems = [];
    this.foodCart = null;
    this.foodCoupons = [];
    this.foodLoading = false;
    this.foodLoadingLabel = "";
    this.foodError = "";
    this.confirmFoodOrder = false;
    this.foodOrderReceipt = null;
  }

  open(recipe, { tab = "groceries" } = {}) {
    if (!this.dialog || !recipe) return;
    const prefs = this.cb.getDeliveryPrefs?.() || {};
    this.recipe = recipe;
    this.activeTab = tab === "restaurants" ? "restaurants" : "groceries";
    this.groceryPlatform = prefs.preferredGrocery || "swiggy-im";
    this.foodPlatform = prefs.preferredFood || "swiggy-food";
    this.autoMatchPantry = prefs.autoMatchPantry !== undefined ? Boolean(prefs.autoMatchPantry) : true;
    this.dishQuery = recipe.title || "";
    this.city = prefs.city || "";
    this.groceryError = "";
    this.foodError = "";
    this.confirmGroceryOrder = false;
    this.confirmFoodOrder = false;
    this.groceryOrderReceipt = null;
    this.foodOrderReceipt = null;

    this.render();
    if (!this.dialog.open) {
      this.dialog.showModal();
    }
    this.hydrateActivePlatformIfConnected();
  }

  refresh() {
    if (this.dialog?.open && this.recipe) {
      this.render();
    }
  }

  close() {
    if (this.dialog?.open) {
      closeTopLayer(this.dialog);
    }
  }

  async hydrateActivePlatformIfConnected() {
    const mcp = this.cb.getMcpStatus?.();
    const prefs = this.cb.getDeliveryPrefs?.() || {};
    if (this.activeTab === "groceries" && isPlatformMcpConnected(this.groceryPlatform, mcp)) {
      if (!this.groceryAddresses[this.groceryPlatform]) {
        try {
          const res = await fetchGroceryAddresses(this.groceryPlatform, prefs);
          this.groceryAddresses[this.groceryPlatform] = res.addresses || [];
          const def = res.addresses?.find((a) => a.isDefault) || res.addresses?.[0];
          if (def && !this.selectedGroceryAddr[this.groceryPlatform]) {
            this.selectedGroceryAddr[this.groceryPlatform] = def.id;
          }
          if (this.dialog.open) this.render();
        } catch {
          // Optional prefill
        }
      }
      if (!this.groceryCart) {
        try {
          this.groceryCart = await manageGroceryCart({ provider: this.groceryPlatform, action: "get" }, prefs);
          if (this.dialog.open) this.render();
        } catch {
          // Ignore empty cart errors
        }
      }
    } else if (this.activeTab === "restaurants" && isPlatformMcpConnected("swiggy-food", mcp) && this.foodPlatform === "swiggy-food") {
      if (!this.foodAddresses.length) {
        try {
          const res = await fetchGroceryAddresses("swiggy-im", prefs);
          this.foodAddresses = res.addresses || [];
          const def = res.addresses?.find((a) => a.isDefault) || res.addresses?.[0];
          if (def && !this.selectedFoodAddr) this.selectedFoodAddr = def.id;
          if (this.dialog.open) this.render();
        } catch {
          // Ignore
        }
      }
    }
  }

  getMissingRows() {
    const checkedSet = this.cb.getCheckedIngredients?.() || new Set();
    const profile = this.cb.getProfile?.() || {};
    const servings = this.cb.getServings?.() || this.recipe?.servings || 2;
    const unitSystem = this.cb.getUnitSystem?.() || "metric";
    return extractMissingIngredients(this.recipe, checkedSet, profile.pantry || "", {
      autoMatchPantry: this.autoMatchPantry,
      servings,
      unitSystem
    });
  }

  formatMissingText(rows) {
    const needed = rows.filter((r) => r.needed);
    const items = needed.length ? needed : rows;
    return [
      `Missing ingredients — ${this.recipe?.title || "Recipe"}`,
      ...items.map((r) => `[ ] ${r.displayAmount ? `${r.displayAmount} ` : ""}${r.item}${r.note ? ` (${r.note})` : ""}`)
    ].join("\n");
  }

  async searchSingleIngredient(row) {
    const prefs = this.cb.getDeliveryPrefs?.() || {};
    this.groceryError = "";
    this.groceryLoading = true;
    this.groceryLoadingLabel = `Searching ${this.getGroceryPlatformObj().shortLabel} for ${row.query}…`;
    this.render();
    try {
      const res = await searchGroceries(
        {
          provider: this.groceryPlatform,
          query: row.query,
          addressId: this.selectedGroceryAddr[this.groceryPlatform] || ""
        },
        prefs
      );
      this.groceryResults[`${this.groceryPlatform}:${row.index}`] = (res.items || []).slice(0, 4);
    } catch (err) {
      this.groceryError = err?.message || `Could not search for ${row.query}.`;
    } finally {
      this.groceryLoading = false;
      this.render();
    }
  }

  async searchAllMissing(neededRows) {
    if (!neededRows.length) return;
    const prefs = this.cb.getDeliveryPrefs?.() || {};
    this.groceryError = "";
    this.groceryLoading = true;
    this.groceryLoadingLabel = `Searching ${this.getGroceryPlatformObj().shortLabel} for ${neededRows.length} ingredient${neededRows.length === 1 ? "" : "s"}…`;
    this.render();
    try {
      for (const row of neededRows.slice(0, 8)) {
        const res = await searchGroceries(
          {
            provider: this.groceryPlatform,
            query: row.query,
            addressId: this.selectedGroceryAddr[this.groceryPlatform] || ""
          },
          prefs
        );
        this.groceryResults[`${this.groceryPlatform}:${row.index}`] = (res.items || []).slice(0, 3);
      }
    } catch (err) {
      this.groceryError = err?.message || "Batch ingredient search failed.";
    } finally {
      this.groceryLoading = false;
      this.render();
    }
  }

  async addProductToGroceryCart(item) {
    const prefs = this.cb.getDeliveryPrefs?.() || {};
    this.groceryError = "";
    this.groceryLoading = true;
    this.groceryLoadingLabel = `Adding ${item.name} to cart…`;
    this.render();
    try {
      const cart = await manageGroceryCart(
        {
          provider: this.groceryPlatform,
          action: "add",
          addressId: this.selectedGroceryAddr[this.groceryPlatform] || "",
          itemId: item.id,
          spinId: item.spinId,
          skuId: item.skuId,
          productVariantId: item.productVariantId,
          quantity: 1
        },
        prefs
      );
      this.groceryCart = cart;
    } catch (err) {
      this.groceryError = err?.message || "Could not add item to cart.";
    } finally {
      this.groceryLoading = false;
      this.render();
    }
  }

  async placeConfirmedGroceryOrder() {
    const prefs = this.cb.getDeliveryPrefs?.() || {};
    this.groceryError = "";
    this.groceryLoading = true;
    this.groceryLoadingLabel = "Submitting order…";
    this.render();
    try {
      const addrId = this.selectedGroceryAddr[this.groceryPlatform] || "";
      let tool = "checkout";
      let args = {};
      if (this.groceryPlatform === "swiggy-im") {
        tool = "checkout";
        args = { addressId: addrId, paymentMethod: "COD" };
      } else if (this.groceryPlatform === "blinkit") {
        tool = "checkout";
        args = {};
      } else {
        tool = "checkout";
        args = {};
      }
      const res = await callMcpTool(
        { provider: this.groceryPlatform, tool, args, confirmedRealOrder: true },
        prefs
      );
      this.confirmGroceryOrder = false;
      this.groceryOrderReceipt = res;
      this.groceryCart = await manageGroceryCart({ provider: this.groceryPlatform, action: "get" }, prefs).catch(() => null);
    } catch (err) {
      this.groceryError = err?.message || "Order placement failed. Check your account orders before retrying.";
    } finally {
      this.groceryLoading = false;
      this.render();
    }
  }

  async findNearbyRestaurants() {
    const prefs = this.cb.getDeliveryPrefs?.() || {};
    const q = String(this.dishQuery || this.recipe?.title || "").trim();
    if (!q) return;
    this.foodError = "";
    this.foodLoading = true;
    this.foodLoadingLabel = `Finding open restaurants serving "${q}"…`;
    this.selectedRestaurant = null;
    this.menuItems = [];
    this.render();
    try {
      const res = await searchFoodRestaurants({ query: q, addressId: this.selectedFoodAddr || "" }, prefs);
      this.restaurants = res.restaurants || [];
      if (res.addressId && !this.selectedFoodAddr) this.selectedFoodAddr = res.addressId;
    } catch (err) {
      this.foodError = err?.message || "Could not search nearby restaurants.";
    } finally {
      this.foodLoading = false;
      this.render();
    }
  }

  async openRestaurantMenu(restaurant) {
    const prefs = this.cb.getDeliveryPrefs?.() || {};
    this.foodError = "";
    this.selectedRestaurant = restaurant;
    this.foodLoading = true;
    this.foodLoadingLabel = `Loading ${restaurant.name} menu…`;
    this.render();
    try {
      const res = await fetchFoodMenu(
        { restaurantId: restaurant.id, addressId: this.selectedFoodAddr || "", query: this.dishQuery },
        prefs
      );
      this.menuItems = (res.items || []).slice(0, 24);
    } catch (err) {
      this.foodError = err?.message || "Could not load restaurant menu.";
    } finally {
      this.foodLoading = false;
      this.render();
    }
  }

  async addMenuItemToFoodCart(dish) {
    if (!this.selectedRestaurant) return;
    const prefs = this.cb.getDeliveryPrefs?.() || {};
    this.foodError = "";
    this.foodLoading = true;
    this.foodLoadingLabel = `Adding ${dish.name} to Swiggy cart…`;
    this.render();
    try {
      const existing = (this.foodCart?.items || []).map((it) => ({
        menu_item_id: it.id,
        quantity: it.quantity || 1
      }));
      const match = existing.find((e) => e.menu_item_id === dish.id);
      if (match) match.quantity += 1;
      else existing.push({ menu_item_id: dish.id, quantity: 1 });

      this.foodCart = await manageFoodCart(
        {
          action: "update",
          addressId: this.selectedFoodAddr || "",
          restaurantId: this.selectedRestaurant.id,
          restaurantName: this.selectedRestaurant.name,
          cartItems: existing
        },
        prefs
      );
    } catch (err) {
      this.foodError = err?.message || "Could not add dish to cart.";
    } finally {
      this.foodLoading = false;
      this.render();
    }
  }

  async placeConfirmedFoodOrder() {
    const prefs = this.cb.getDeliveryPrefs?.() || {};
    this.foodError = "";
    this.foodLoading = true;
    this.foodLoadingLabel = "Submitting food order…";
    this.render();
    try {
      const res = await callMcpTool(
        {
          provider: "swiggy-food",
          tool: "place_food_order",
          args: { addressId: this.selectedFoodAddr || "", paymentMethod: "Cash" },
          confirmedRealOrder: true
        },
        prefs
      );
      this.confirmFoodOrder = false;
      this.foodOrderReceipt = res;
    } catch (err) {
      this.foodError = err?.message || "Order placement failed. Check your Swiggy orders before retrying.";
    } finally {
      this.foodLoading = false;
      this.render();
    }
  }

  getGroceryPlatformObj() {
    return GROCERY_PLATFORMS.find((p) => p.id === this.groceryPlatform) || GROCERY_PLATFORMS[0];
  }

  getFoodPlatformObj() {
    return FOOD_PLATFORMS.find((p) => p.id === this.foodPlatform) || FOOD_PLATFORMS[0];
  }

  renderGroceriesTab(rows) {
    const mcp = this.cb.getMcpStatus?.();
    const profile = this.cb.getProfile?.() || {};
    const hasPantry = Boolean(String(profile.pantry || "").trim());
    const neededRows = rows.filter((r) => r.needed);
    const platformObj = this.getGroceryPlatformObj();
    const connected = isPlatformMcpConnected(this.groceryPlatform, mcp);
    const addresses = this.groceryAddresses[this.groceryPlatform] || [];

    const pillsHtml = GROCERY_PLATFORMS.map((p) => {
      const on = isPlatformMcpConnected(p.id, mcp);
      const selected = p.id === this.groceryPlatform;
      return `
        <button type="button" class="ord-app-pill ${selected ? "is-active" : ""}" data-ord-gprov="${esc(p.id)}">
          ${on ? `<span class="mcp-dot is-on" aria-label="Connected"></span>` : ""}
          <span>${esc(p.shortLabel)}</span>
          <small>${on ? "Live" : "Link"}</small>
        </button>
      `;
    }).join("");

    const mcpToolbarHtml = connected
      ? `
        <div class="ord-mcp-bar">
          ${
            addresses.length
              ? `
            <label class="ord-addr-wrap">
              <span class="visually-hidden">Delivery address</span>
              <select class="m3-select ord-addr-select" id="ord-g-addr">
                ${addresses
                  .map(
                    (a) =>
                      `<option value="${esc(a.id)}" ${String(this.selectedGroceryAddr[this.groceryPlatform]) === String(a.id) ? "selected" : ""}>${esc(a.label)}${a.details ? ` — ${esc(a.details.slice(0, 48))}` : ""}</option>`
                  )
                  .join("")}
              </select>
            </label>
          `
              : `<button type="button" class="tbtn" id="ord-g-load-addr">Load addresses</button>`
          }
          <button type="button" class="go ord-sm-btn" id="ord-g-search-all" ${neededRows.length === 0 || this.groceryLoading ? "disabled" : ""}>Search all missing (${neededRows.length})</button>
        </div>
      `
      : "";

    const rowsHtml = rows.length
      ? rows
          .map((row) => {
            const deepUrl = buildGroceryDeepLink(this.groceryPlatform, row.query);
            const matches = this.groceryResults[`${this.groceryPlatform}:${row.index}`] || [];
            const statusHint = row.checked
              ? "Checked off"
              : row.pantryMatch && this.autoMatchPantry
              ? "In pantry"
              : "Needed";

            const resultsHtml =
              connected && matches.length
                ? `<div class="ord-product-grid">
                    ${matches
                      .map(
                        (item, mIdx) => `
                      <div class="ord-product-card">
                        <div class="ord-product-meta">
                          <strong>${esc(item.name)}</strong>
                          <small>${[item.variant, formatPrice(item.price), item.inStock === false ? "Out of stock" : ""].filter(Boolean).join(" · ")}</small>
                        </div>
                        <button type="button" class="tbtn ord-add-btn" data-g-add="${row.index}:${mIdx}" ${item.inStock === false || this.groceryLoading ? "disabled" : ""}>Add</button>
                      </div>
                    `
                      )
                      .join("")}
                  </div>`
                : "";

            return `
              <div class="ord-ing-item ${row.needed ? "" : "is-have"}">
                <div class="ord-ing-row ${row.checked ? "on" : ""}">
                  <button type="button" class="ing-check" data-ord-toggle="${row.index}" aria-pressed="${row.checked}">
                    <span class="box" aria-hidden="true"></span>
                    <span class="t">
                      ${row.displayAmount ? `<span class="amt">${esc(row.displayAmount)}</span> ` : ""}${esc(row.item)}
                      <span class="sub">· ${esc(statusHint)}</span>
                    </span>
                  </button>
                  <div class="ord-row-act">
                    ${
                      connected
                        ? `<button type="button" class="tbtn" data-g-find="${row.index}" ${this.groceryLoading ? "disabled" : ""}>Find</button>`
                        : ""
                    }
                    <a class="quiet-act ord-ext-link" href="${esc(deepUrl)}" target="_blank" rel="noopener noreferrer">${esc(platformObj.shortLabel)} ↗</a>
                  </div>
                </div>
                ${resultsHtml}
              </div>
            `;
          })
          .join("")
      : `<p class="ord-empty">This recipe has no listed ingredients yet.</p>`;

    const cartHtml = connected && this.groceryCart
      ? `
        <section class="ord-cart-card" aria-label="Live cart">
          <div class="ord-cart-head">
            <div>
              <strong>${esc(platformObj.label)} Cart</strong>
              <small>${
                this.groceryCart.items?.length
                  ? `${this.groceryCart.items.length} item(s)${this.groceryCart.total != null ? ` · ${formatPrice(this.groceryCart.total)}` : ""}`
                  : this.groceryCart.rawText || "Empty cart"
              }</small>
            </div>
            <div class="ord-cart-acts">
              <button type="button" class="tbtn" id="ord-g-cart-refresh">Refresh</button>
              <button type="button" class="tbtn" id="ord-g-cart-clear">Clear</button>
            </div>
          </div>
          ${
            this.groceryCart.warnings?.length
              ? `<p class="ord-warn">${esc(this.groceryCart.warnings.join(" "))}</p>`
              : ""
          }
          ${
            this.confirmGroceryOrder
              ? `
            <div class="ord-confirm-box" role="alert">
              <p><strong>Real order safety check:</strong> This will place a live Cash-on-Delivery order on your ${esc(platformObj.label)} account and charge real money upon delivery.</p>
              <div class="ord-confirm-acts">
                <button type="button" class="tbtn" id="ord-g-cancel-order">Cancel</button>
                <button type="button" class="go" id="ord-g-confirm-order" ${this.groceryLoading ? "disabled" : ""}>Confirm &amp; place real order</button>
              </div>
            </div>
          `
              : `<button type="button" class="go" id="ord-g-review-order" ${this.groceryLoading ? "disabled" : ""}>Review real order →</button>`
          }
        </section>
      `
      : "";

    const bannerHtml = !connected
      ? mcp?.available
        ? `<div class="ord-banner">
            <span>Companion is running — sign in to <strong>${esc(platformObj.label)}</strong> to search live local stock and fill your cart here.</span>
            <button type="button" class="tbtn" id="ord-open-settings-btn">Sign in →</button>
          </div>`
        : `<div class="ord-banner">
            <span>Smart search links work everywhere. To sign in with OAuth and build live ${esc(platformObj.shortLabel)} carts, start Mise locally with <code>npm start</code> and <button type="button" class="link-btn" id="ord-open-settings-btn">connect in Settings</button>.</span>
          </div>`
      : "";

    return `
      <div class="ord-top-meta">
        <span class="ord-count">${neededRows.length} missing of ${rows.length} ingredient${rows.length === 1 ? "" : "s"}</span>
        <div class="ord-top-tools">
          ${
            hasPantry
              ? `<button type="button" class="chip ${this.autoMatchPantry ? "is-active" : ""}" id="ord-pantry-toggle" aria-pressed="${this.autoMatchPantry}">Skip pantry staples</button>`
              : ""
          }
          <button type="button" class="tbtn" id="ord-copy-list">Copy checklist</button>
        </div>
      </div>

      <div class="ord-app-pills" role="tablist" aria-label="Grocery delivery app">${pillsHtml}</div>
      ${mcpToolbarHtml}
      ${this.groceryLoading ? `<div class="ord-loading">${renderCookingLoader({ compact: true, label: this.groceryLoadingLabel || "Working…" })}</div>` : ""}
      ${this.groceryError ? `<p class="ord-err">${esc(this.groceryError)}</p>` : ""}
      ${
        this.groceryOrderReceipt
          ? `<div class="ord-receipt"><strong>Order submitted!</strong> <small>${esc(this.groceryOrderReceipt.text || JSON.stringify(this.groceryOrderReceipt.data || {}))}</small></div>`
          : ""
      }
      <div class="ord-ing-list">${rowsHtml}</div>
      ${cartHtml}
      ${bannerHtml}
    `;
  }

  renderRestaurantsTab() {
    const mcp = this.cb.getMcpStatus?.();
    const swiggyConnected = isPlatformMcpConnected("swiggy-food", mcp);
    const suggestions = simplifyDishName(this.recipe?.title || "");

    const pillsHtml = FOOD_PLATFORMS.map((p) => {
      const on = p.id === "swiggy-food" && swiggyConnected;
      const selected = p.id === this.foodPlatform;
      return `
        <button type="button" class="ord-app-pill ${selected ? "is-active" : ""}" data-ord-fprov="${esc(p.id)}">
          ${on ? `<span class="mcp-dot is-on" aria-label="Connected"></span>` : ""}
          <span>${esc(p.label)}</span>
          <small>${on ? "Live MCP" : p.id === "zomato" ? "Deep-Link" : "Link"}</small>
        </button>
      `;
    }).join("");

    const zomatoUrl = buildRestaurantDeepLink("zomato", this.dishQuery || this.recipe?.title || "", this.city);
    const swiggyUrl = buildRestaurantDeepLink("swiggy-food", this.dishQuery || this.recipe?.title || "", this.city);
    const primaryUrl = this.foodPlatform === "zomato" ? zomatoUrl : swiggyUrl;
    const altUrl = this.foodPlatform === "zomato" ? swiggyUrl : zomatoUrl;
    const altName = this.foodPlatform === "zomato" ? "Swiggy" : "Zomato";

    const mcpSection =
      this.foodPlatform === "swiggy-food" && swiggyConnected
        ? `
          <div class="ord-mcp-bar">
            ${
              this.foodAddresses.length
                ? `<select class="m3-select ord-addr-select" id="ord-f-addr" aria-label="Delivery address">
                    ${this.foodAddresses
                      .map(
                        (a) =>
                          `<option value="${esc(a.id)}" ${String(this.selectedFoodAddr) === String(a.id) ? "selected" : ""}>${esc(a.label)}${a.details ? ` — ${esc(a.details.slice(0, 48))}` : ""}</option>`
                      )
                      .join("")}
                  </select>`
                : ""
            }
            <button type="button" class="go ord-sm-btn" id="ord-f-search-btn" ${this.foodLoading ? "disabled" : ""}>Find open restaurants</button>
          </div>
          ${this.foodLoading ? `<div class="ord-loading">${renderCookingLoader({ compact: true, label: this.foodLoadingLabel || "Searching nearby kitchens…" })}</div>` : ""}
          ${this.foodError ? `<p class="ord-err">${esc(this.foodError)}</p>` : ""}
          ${
            this.foodOrderReceipt
              ? `<div class="ord-receipt"><strong>Order submitted!</strong> <small>${esc(JSON.stringify(this.foodOrderReceipt.data || {}))}</small></div>`
              : ""
          }
          ${
            this.selectedRestaurant
              ? `
              <div class="ord-menu-head">
                <button type="button" class="tbtn" id="ord-f-back-rest">← All restaurants</button>
                <div>
                  <strong>${esc(this.selectedRestaurant.name)}</strong>
                  <small>${[this.selectedRestaurant.eta, this.selectedRestaurant.rating ? `★ ${this.selectedRestaurant.rating}` : "", this.selectedRestaurant.costForTwo].filter(Boolean).join(" · ")}</small>
                </div>
              </div>
              <div class="ord-product-grid">
                ${
                  this.menuItems.length
                    ? this.menuItems
                        .map(
                          (dish, idx) => `
                      <div class="ord-product-card">
                        <div class="ord-product-meta">
                          <strong>${esc(dish.name)}</strong>
                          <small>${[formatPrice(dish.price), dish.category, dish.inStock === false ? "Unavailable" : ""].filter(Boolean).join(" · ")}</small>
                        </div>
                        <button type="button" class="tbtn ord-add-btn" data-f-add="${idx}" ${dish.inStock === false || this.foodLoading ? "disabled" : ""}>+ Add</button>
                      </div>
                    `
                        )
                        .join("")
                    : `<p class="ord-empty">No menu items loaded.</p>`
                }
              </div>
            `
              : this.restaurants.length
              ? `
              <div class="ord-rest-list">
                ${this.restaurants
                  .map(
                    (rest, idx) => `
                  <div class="ord-rest-card ${rest.availabilityStatus !== "OPEN" ? "is-closed" : ""}">
                    <div>
                      <strong>${esc(rest.name)}</strong>
                      <small>${[
                        rest.availabilityStatus,
                        rest.rating ? `★ ${rest.rating}` : "",
                        rest.eta,
                        rest.distance,
                        rest.costForTwo
                      ]
                        .filter(Boolean)
                        .join(" · ")}</small>
                    </div>
                    <button type="button" class="tbtn" data-f-menu="${idx}" ${rest.availabilityStatus !== "OPEN" ? "disabled" : ""}>View menu</button>
                  </div>
                `
                  )
                  .join("")}
              </div>
            `
              : ""
          }
          ${
            this.foodCart
              ? `
            <section class="ord-cart-card">
              <div class="ord-cart-head">
                <div>
                  <strong>${esc(this.foodCart.restaurantName || "Swiggy Food")} Cart</strong>
                  <small>${this.foodCart.items?.length || 0} dish(es)${this.foodCart.total != null ? ` · ${formatPrice(this.foodCart.total)}` : ""}</small>
                </div>
                <div class="ord-cart-acts">
                  <button type="button" class="tbtn" id="ord-f-coupons">Coupons</button>
                  <button type="button" class="tbtn" id="ord-f-flush">Clear</button>
                </div>
              </div>
              ${
                this.foodCoupons.length
                  ? `<div class="preset-chips">${this.foodCoupons
                      .slice(0, 4)
                      .map((c) => `<button type="button" class="chip" data-f-coupon="${esc(c.id || c.code)}">${esc(c.id || c.code)}</button>`)
                      .join("")}</div>`
                  : ""
              }
              ${this.foodCart.warnings?.length ? `<p class="ord-warn">${esc(this.foodCart.warnings.join(" "))}</p>` : ""}
              ${
                this.confirmFoodOrder
                  ? `
                <div class="ord-confirm-box" role="alert">
                  <p><strong>Real order safety check:</strong> This will place a live Cash-on-Delivery restaurant order via Swiggy Food.</p>
                  <div class="ord-confirm-acts">
                    <button type="button" class="tbtn" id="ord-f-cancel-order">Cancel</button>
                    <button type="button" class="go" id="ord-f-confirm-order" ${this.foodLoading || this.foodCart.exceedsCap ? "disabled" : ""}>Confirm &amp; place real order</button>
                  </div>
                </div>
              `
                  : `<button type="button" class="go" id="ord-f-review-order" ${this.foodLoading || this.foodCart.exceedsCap ? "disabled" : ""}>Review real order →</button>`
              }
            </section>
          `
              : ""
          }
        `
        : `
          <div class="ord-launch-card">
            <div class="ord-launch-acts">
              <a class="go" href="${esc(primaryUrl)}" target="_blank" rel="noopener noreferrer">Search “${esc(this.dishQuery || this.recipe?.title)}” on ${esc(this.getFoodPlatformObj().label)} ↗</a>
              <a class="tbtn" href="${esc(altUrl)}" target="_blank" rel="noopener noreferrer">Also search on ${esc(altName)} ↗</a>
            </div>
            <p class="st-help">
              ${
                this.foodPlatform === "zomato"
                  ? "Zomato’s official MCP server restricts OAuth callbacks to 6 approved clients (ChatGPT, Claude, VS Code, Postman), so Mise opens Zomato delivery search directly for your dish and city."
                  : mcp?.available
                  ? "Sign in to Swiggy in Settings to search live nearby restaurant menus & place orders inside Mise, or open Swiggy web search above."
                  : "Smart deep-links open Swiggy & Zomato directly. Run Mise locally (`npm start`) and connect Swiggy in Settings for live restaurant menus inside Mise."
              }
            </p>
            ${
              this.foodPlatform === "swiggy-food"
                ? `<button type="button" class="quiet-act" id="ord-open-settings-btn">Configure accounts in Settings →</button>`
                : ""
            }
          </div>
        `;

    return `
      <div class="ord-app-pills" role="tablist" aria-label="Restaurant delivery app">${pillsHtml}</div>
      <div class="ord-food-inputs">
        <div class="st-field">
          <label for="ord-dish-q">Dish to order nearby</label>
          <input type="text" id="ord-dish-q" value="${esc(this.dishQuery)}" placeholder="e.g. Miso Rigatoni or Ramen">
          ${
            suggestions.length > 1
              ? `<div class="st-presets">${suggestions
                  .map(
                    (s) =>
                      `<button type="button" class="chip ${this.dishQuery === s ? "is-active" : ""}" data-dish-chip="${esc(s)}">${esc(s)}</button>`
                  )
                  .join("")}</div>`
              : ""
          }
        </div>
        <div class="st-field">
          <label for="ord-city-in">City (for Zomato delivery link)</label>
          <input type="text" id="ord-city-in" value="${esc(this.city)}" placeholder="e.g. bengaluru, mumbai, delhi-ncr">
        </div>
      </div>
      ${mcpSection}
    `;
  }

  render() {
    if (!this.dialog || !this.recipe) return;
    const rows = this.getMissingRows();
    const bodyHtml =
      this.activeTab === "restaurants" ? this.renderRestaurantsTab() : this.renderGroceriesTab(rows);

    this.dialog.innerHTML = `
      <div class="ord-shell">
        <header class="ord-head">
          <div>
            <small class="ord-kicker">${esc(this.recipe.title)}</small>
            <h2 id="order-dialog-title">Order for this dish</h2>
          </div>
          <button type="button" class="pop-close" id="ord-close-btn" aria-label="Close ordering sheet">×</button>
        </header>

        <div class="m3-seg ord-tabs" role="tablist" aria-label="Ordering mode">
          <button type="button" role="tab" aria-selected="${this.activeTab === "groceries"}" class="m3-seg-btn ${this.activeTab === "groceries" ? "is-active" : ""}" data-ord-tab="groceries">Missing Ingredients</button>
          <button type="button" role="tab" aria-selected="${this.activeTab === "restaurants"}" class="m3-seg-btn ${this.activeTab === "restaurants" ? "is-active" : ""}" data-ord-tab="restaurants">Order Dish Nearby</button>
        </div>

        <div class="ord-body">${bodyHtml}</div>
      </div>
    `;

    this.bindEvents(rows);
  }

  bindEvents(rows) {
    const d = this.dialog;

    d.querySelector("#ord-close-btn")?.addEventListener("click", () => this.close());

    d.querySelectorAll("[data-ord-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.activeTab = btn.dataset.ordTab;
        this.render();
        this.hydrateActivePlatformIfConnected();
      });
    });

    d.querySelector("#ord-open-settings-btn")?.addEventListener("click", () => {
      this.close();
      this.cb.onOpenDeliverySettings?.();
    });

    if (this.activeTab === "groceries") {
      d.querySelectorAll("[data-ord-gprov]").forEach((btn) => {
        btn.addEventListener("click", () => {
          this.groceryPlatform = btn.dataset.ordGprov;
          this.groceryError = "";
          this.confirmGroceryOrder = false;
          this.render();
          this.hydrateActivePlatformIfConnected();
        });
      });

      d.querySelector("#ord-pantry-toggle")?.addEventListener("click", () => {
        this.autoMatchPantry = !this.autoMatchPantry;
        this.render();
      });

      d.querySelector("#ord-copy-list")?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        const text = this.formatMissingText(rows);
        navigator.clipboard?.writeText(text).then(
          () => {
            if (!btn?.isConnected) return;
            btn.textContent = "Copied";
            setTimeout(() => {
              if (btn.isConnected) btn.textContent = "Copy checklist";
            }, 1500);
          },
          () => {}
        );
      });

      d.querySelectorAll("[data-ord-toggle]").forEach((btn) => {
        btn.addEventListener("click", () => {
          this.cb.onToggleIngredient?.(Number(btn.dataset.ordToggle));
          this.render();
        });
      });

      d.querySelector("#ord-g-addr")?.addEventListener("change", (e) => {
        this.selectedGroceryAddr[this.groceryPlatform] = e.target.value;
      });

      d.querySelector("#ord-g-load-addr")?.addEventListener("click", async () => {
        this.groceryAddresses[this.groceryPlatform] = null;
        await this.hydrateActivePlatformIfConnected();
      });

      d.querySelectorAll("[data-g-find]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.dataset.gFind);
          const row = rows.find((r) => r.index === idx);
          if (row) this.searchSingleIngredient(row);
        });
      });

      d.querySelector("#ord-g-search-all")?.addEventListener("click", () => {
        this.searchAllMissing(rows.filter((r) => r.needed));
      });

      d.querySelectorAll("[data-g-add]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const [ingIdx, matchIdx] = btn.dataset.gAdd.split(":").map(Number);
          const item = (this.groceryResults[`${this.groceryPlatform}:${ingIdx}`] || [])[matchIdx];
          if (item) this.addProductToGroceryCart(item);
        });
      });

      d.querySelector("#ord-g-cart-refresh")?.addEventListener("click", async () => {
        try {
          this.groceryCart = await manageGroceryCart(
            { provider: this.groceryPlatform, action: "get" },
            this.cb.getDeliveryPrefs?.()
          );
          this.render();
        } catch (err) {
          this.groceryError = err?.message || "Could not refresh cart.";
          this.render();
        }
      });

      d.querySelector("#ord-g-cart-clear")?.addEventListener("click", async () => {
        try {
          this.groceryCart = await manageGroceryCart(
            { provider: this.groceryPlatform, action: "clear" },
            this.cb.getDeliveryPrefs?.()
          );
          this.confirmGroceryOrder = false;
          this.render();
        } catch (err) {
          this.groceryError = err?.message || "Could not clear cart.";
          this.render();
        }
      });

      d.querySelector("#ord-g-review-order")?.addEventListener("click", () => {
        this.confirmGroceryOrder = true;
        this.render();
        d.querySelector("#ord-g-cancel-order")?.focus();
      });

      d.querySelector("#ord-g-cancel-order")?.addEventListener("click", () => {
        this.confirmGroceryOrder = false;
        this.render();
      });

      d.querySelector("#ord-g-confirm-order")?.addEventListener("click", () => {
        this.placeConfirmedGroceryOrder();
      });
    } else {
      d.querySelectorAll("[data-ord-fprov]").forEach((btn) => {
        btn.addEventListener("click", () => {
          this.foodPlatform = btn.dataset.ordFprov;
          this.foodError = "";
          this.confirmFoodOrder = false;
          this.render();
          this.hydrateActivePlatformIfConnected();
        });
      });

      d.querySelector("#ord-dish-q")?.addEventListener("input", (e) => {
        this.dishQuery = e.target.value;
        // Update deep-link anchors live without re-rendering/losing input focus
        const anchors = d.querySelectorAll(".ord-launch-acts a");
        if (anchors.length >= 2) {
          const zUrl = buildRestaurantDeepLink("zomato", this.dishQuery || this.recipe?.title || "", this.city);
          const sUrl = buildRestaurantDeepLink("swiggy-food", this.dishQuery || this.recipe?.title || "", this.city);
          anchors[0].href = this.foodPlatform === "zomato" ? zUrl : sUrl;
          anchors[0].textContent = `Search “${this.dishQuery || this.recipe?.title}” on ${this.getFoodPlatformObj().label} ↗`;
          anchors[1].href = this.foodPlatform === "zomato" ? sUrl : zUrl;
        }
      });

      d.querySelector("#ord-city-in")?.addEventListener("input", (e) => {
        this.city = e.target.value;
        const anchors = d.querySelectorAll(".ord-launch-acts a");
        if (anchors.length >= 2) {
          const zUrl = buildRestaurantDeepLink("zomato", this.dishQuery || this.recipe?.title || "", this.city);
          const sUrl = buildRestaurantDeepLink("swiggy-food", this.dishQuery || this.recipe?.title || "", this.city);
          anchors[0].href = this.foodPlatform === "zomato" ? zUrl : sUrl;
          anchors[1].href = this.foodPlatform === "zomato" ? sUrl : zUrl;
        }
      });

      d.querySelectorAll("[data-dish-chip]").forEach((btn) => {
        btn.addEventListener("click", () => {
          this.dishQuery = btn.dataset.dishChip;
          this.render();
        });
      });

      d.querySelector("#ord-f-addr")?.addEventListener("change", (e) => {
        this.selectedFoodAddr = e.target.value;
      });

      d.querySelector("#ord-f-search-btn")?.addEventListener("click", () => this.findNearbyRestaurants());
      d.querySelector("#ord-f-back-rest")?.addEventListener("click", () => {
        this.selectedRestaurant = null;
        this.menuItems = [];
        this.render();
      });

      d.querySelectorAll("[data-f-menu]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const rest = this.restaurants[Number(btn.dataset.fMenu)];
          if (rest) this.openRestaurantMenu(rest);
        });
      });

      d.querySelectorAll("[data-f-add]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const dish = this.menuItems[Number(btn.dataset.fAdd)];
          if (dish) this.addMenuItemToFoodCart(dish);
        });
      });

      d.querySelector("#ord-f-coupons")?.addEventListener("click", async () => {
        if (!this.selectedRestaurant) return;
        try {
          const res = await manageFoodCart(
            { action: "coupons", addressId: this.selectedFoodAddr, restaurantId: this.selectedRestaurant.id },
            this.cb.getDeliveryPrefs?.()
          );
          this.foodCoupons = res.coupons || [];
          this.render();
        } catch (err) {
          this.foodError = err?.message || "Could not load coupons.";
          this.render();
        }
      });

      d.querySelectorAll("[data-f-coupon]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            this.foodCart = await manageFoodCart(
              {
                action: "apply_coupon",
                addressId: this.selectedFoodAddr,
                restaurantName: this.selectedRestaurant?.name || "",
                couponCode: btn.dataset.fCoupon
              },
              this.cb.getDeliveryPrefs?.()
            );
            this.render();
          } catch (err) {
            this.foodError = err?.message || "Coupon could not be applied.";
            this.render();
          }
        });
      });

      d.querySelector("#ord-f-flush")?.addEventListener("click", async () => {
        try {
          this.foodCart = await manageFoodCart({ action: "flush", addressId: this.selectedFoodAddr }, this.cb.getDeliveryPrefs?.());
          this.confirmFoodOrder = false;
          this.render();
        } catch (err) {
          this.foodError = err?.message || "Could not clear food cart.";
          this.render();
        }
      });

      d.querySelector("#ord-f-review-order")?.addEventListener("click", () => {
        this.confirmFoodOrder = true;
        this.render();
        d.querySelector("#ord-f-cancel-order")?.focus();
      });

      d.querySelector("#ord-f-cancel-order")?.addEventListener("click", () => {
        this.confirmFoodOrder = false;
        this.render();
      });

      d.querySelector("#ord-f-confirm-order")?.addEventListener("click", () => {
        this.placeConfirmedFoodOrder();
      });
    }
  }
}
