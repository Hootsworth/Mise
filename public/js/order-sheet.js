import { closeTopLayer } from "./overlays.js";
import { renderCookingLoader } from "./cooking-loader.js";
import { renderQrSvg } from "./qr-svg.js";
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
  fetchGoToGroceries,
  searchGroceries,
  manageGroceryCart,
  searchFoodRestaurants,
  fetchFoodMenu,
  manageFoodCart,
  fetchPaymentOptions,
  submitRealPayment,
  pollPaymentStatus,
  confirmPaidOrder,
  trackLiveOrder
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
  if (Number.isFinite(num)) return `₹${Math.round(num * 100) / 100}`;
  return str;
}

function getCartQtyForProduct(cart, item) {
  const list = cart?.items || [];
  const hit = list.find(
    (c) =>
      (item.spinId && c.spinId === item.spinId) ||
      (item.skuId && c.skuId === item.skuId) ||
      (item.productVariantId && c.productVariantId === item.productVariantId) ||
      (item.id && String(c.id) === String(item.id))
  );
  return hit ? Number(hit.quantity || 1) : 0;
}

/**
 * Native <dialog> 3-tab Commerce & UPI Checkout Workbench combining static deep-links
 * with live MCP inventory, itemized bill/cart management, UPI QR payment, and delivery tracking.
 */
export class OrderSheetController {
  constructor(dialogEl, callbacks = {}) {
    this.dialog = dialogEl;
    this.cb = callbacks;

    this.recipe = null;
    this.activeTab = "groceries"; // "groceries" | "restaurants" | "cart"
    this.groceryPlatform = "swiggy-im";
    this.foodPlatform = "swiggy-food";
    this.checkoutProvider = "swiggy-im"; // "swiggy-im" | "swiggy-food" | "zepto"
    this.autoMatchPantry = true;

    // Grocery MCP state
    this.groceryAddresses = {}; // provider -> array
    this.selectedGroceryAddr = {}; // provider -> id
    this.groceryResults = {}; // `${provider}:${ingIdx}` -> items[]
    this.goToItems = [];
    this.groceryLoading = false;
    this.groceryLoadingLabel = "";
    this.groceryCarts = {}; // provider -> normalized cart
    this.groceryError = "";

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

    // Payment & tracking state
    this.paymentOptions = {}; // provider -> options
    this.selectedPayment = null; // { methodType, paymentMethod, intentApp, label }
    this.checkoutLoading = false;
    this.checkoutLoadingLabel = "";
    this.checkoutError = "";
    this.confirmRealOrder = false;
    this.pendingUpiOrder = null; // { provider, orderId, paasId, transactionId, upiIntentUrl, bridgeUrl, paymentUrl, foodContext, ... }
    this.activeOrder = null; // { provider, orderId, status, etaText, delivered, cancelled, brandMessage, ... }

    this._pollTimer = null;
    this._trackTimer = null;

    this.dialog?.addEventListener("close", () => {
      this.stopTimers();
    });
  }

  stopTimers() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._trackTimer) {
      clearTimeout(this._trackTimer);
      this._trackTimer = null;
    }
  }

  open(recipe, { tab = "groceries" } = {}) {
    if (!this.dialog) return;
    if (!recipe && tab !== "cart") return;
    const prefs = this.cb.getDeliveryPrefs?.() || {};
    if (recipe) {
      this.recipe = recipe;
      this.dishQuery = recipe.title || "";
    }
    this.activeTab = tab === "restaurants" || tab === "cart" ? tab : "groceries";
    this.groceryPlatform = prefs.preferredGrocery || "swiggy-im";
    this.foodPlatform = prefs.preferredFood || "swiggy-food";
    this.autoMatchPantry = prefs.autoMatchPantry !== undefined ? Boolean(prefs.autoMatchPantry) : true;
    this.city = prefs.city || "";
    this.groceryError = "";
    this.foodError = "";
    this.checkoutError = "";
    this.confirmRealOrder = false;

    if (tab === "cart") {
      this.checkoutProvider = this.pickBestCheckoutProvider();
    }

    this.render();
    if (!this.dialog.open) {
      this.dialog.showModal();
    }
    this.hydrateActiveView();
  }

  refresh() {
    this.notifyParentCounts();
    if (this.dialog?.open) {
      this.render();
    }
  }

  close() {
    this.stopTimers();
    if (this.dialog?.open) {
      closeTopLayer(this.dialog);
    }
  }

  getTotalCartCount() {
    let total = 0;
    for (const c of Object.values(this.groceryCarts)) {
      for (const it of c?.items || []) total += Number(it.quantity || 1);
    }
    for (const it of this.foodCart?.items || []) {
      total += Number(it.quantity || 1);
    }
    return total;
  }

  notifyParentCounts() {
    this.cb.onCartOrOrderUpdate?.({
      cartCount: this.getTotalCartCount(),
      activeOrder: this.activeOrder
    });
  }

  pickBestCheckoutProvider() {
    const mcp = this.cb.getMcpStatus?.();
    if (this.foodCart?.items?.length && isPlatformMcpConnected("swiggy-food", mcp)) {
      return "swiggy-food";
    }
    if (this.groceryCarts[this.groceryPlatform]?.items?.length && isPlatformMcpConnected(this.groceryPlatform, mcp)) {
      return this.groceryPlatform === "blinkit" ? "swiggy-im" : this.groceryPlatform;
    }
    for (const pid of ["swiggy-im", "zepto", "swiggy-food"]) {
      if (isPlatformMcpConnected(pid, mcp)) return pid;
    }
    return "swiggy-im";
  }

  getActiveCheckoutCart() {
    if (this.checkoutProvider === "swiggy-food") return this.foodCart;
    return this.groceryCarts[this.checkoutProvider] || null;
  }

  getActiveAddressList(provider) {
    if (provider === "swiggy-food") return this.foodAddresses;
    return this.groceryAddresses[provider] || this.groceryAddresses["swiggy-im"] || [];
  }

  getActiveAddressId(provider) {
    if (provider === "swiggy-food") return this.selectedFoodAddr;
    return this.selectedGroceryAddr[provider] || this.selectedGroceryAddr["swiggy-im"] || "";
  }

  async hydrateActiveView() {
    const mcp = this.cb.getMcpStatus?.();
    const prefs = this.cb.getDeliveryPrefs?.() || {};

    if (this.activeTab === "groceries" && isPlatformMcpConnected(this.groceryPlatform, mcp)) {
      await this.ensureAddressesAndCart(this.groceryPlatform, prefs);
    } else if (this.activeTab === "restaurants" && this.foodPlatform === "swiggy-food" && isPlatformMcpConnected("swiggy-food", mcp)) {
      await this.ensureAddressesAndCart("swiggy-food", prefs);
    } else if (this.activeTab === "cart" && isPlatformMcpConnected(this.checkoutProvider, mcp)) {
      await this.ensureAddressesAndCart(this.checkoutProvider, prefs);
      await this.loadPaymentOptions(this.checkoutProvider);
    }
  }

  async ensureAddressesAndCart(provider, prefs = this.cb.getDeliveryPrefs?.() || {}) {
    let changed = false;
    if (provider === "swiggy-food") {
      if (!this.foodAddresses.length) {
        try {
          const res = await fetchGroceryAddresses("swiggy-food", prefs);
          this.foodAddresses = res.addresses || [];
          const def = res.addresses?.find((a) => a.isDefault) || res.addresses?.[0];
          if (def && !this.selectedFoodAddr) this.selectedFoodAddr = def.id;
          changed = true;
        } catch {
          // Optional prefill
        }
      }
      if (!this.foodCart) {
        try {
          this.foodCart = await manageFoodCart({ action: "get", addressId: this.selectedFoodAddr }, prefs);
          changed = true;
        } catch {
          // Empty food cart
        }
      }
    } else {
      if (!this.groceryAddresses[provider]) {
        try {
          const res = await fetchGroceryAddresses(provider, prefs);
          this.groceryAddresses[provider] = res.addresses || [];
          const def = res.addresses?.find((a) => a.isDefault) || res.addresses?.[0];
          if (def && !this.selectedGroceryAddr[provider]) {
            this.selectedGroceryAddr[provider] = def.id;
          }
          changed = true;
        } catch {
          // Optional prefill
        }
      }
      if (!this.groceryCarts[provider]) {
        try {
          this.groceryCarts[provider] = await manageGroceryCart({ provider, action: "get" }, prefs);
          changed = true;
        } catch {
          // Ignore
        }
      }
    }
    this.notifyParentCounts();
    if (changed && this.dialog.open) this.render();
  }

  getMissingRows() {
    if (!this.recipe) return [];
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

  async loadQuickReorders() {
    const prefs = this.cb.getDeliveryPrefs?.() || {};
    this.groceryError = "";
    this.groceryLoading = true;
    this.groceryLoadingLabel = "Loading your go-to items…";
    this.render();
    try {
      const res = await fetchGoToGroceries(
        { provider: this.groceryPlatform, addressId: this.selectedGroceryAddr[this.groceryPlatform] || "" },
        prefs
      );
      this.goToItems = (res.items || []).slice(0, 8);
    } catch (err) {
      this.groceryError = err?.message || "Could not load frequent items.";
    } finally {
      this.groceryLoading = false;
      this.render();
    }
  }

  async mutateGroceryCart({ provider = this.groceryPlatform, action, item, quantity = 1 }) {
    const prefs = this.cb.getDeliveryPrefs?.() || {};
    this.groceryError = "";
    this.checkoutError = "";
    this.groceryLoading = true;
    this.groceryLoadingLabel = action === "clear" ? "Clearing cart…" : `Updating cart…`;
    this.render();
    try {
      const cart = await manageGroceryCart(
        {
          provider,
          action,
          addressId: this.selectedGroceryAddr[provider] || "",
          itemId: item?.id,
          spinId: item?.spinId,
          skuId: item?.skuId,
          productVariantId: item?.productVariantId,
          quantity
        },
        prefs
      );
      this.groceryCarts[provider] = cart;
      this.paymentOptions[provider] = null; // Force fresh payment options on next Pay screen visit
      this.notifyParentCounts();
    } catch (err) {
      const msg = err?.message || "Could not update cart.";
      this.groceryError = msg;
      this.checkoutError = msg;
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

  async mutateFoodCart({ action, dish, quantity = 1 }) {
    const prefs = this.cb.getDeliveryPrefs?.() || {};
    this.foodError = "";
    this.checkoutError = "";
    this.foodLoading = true;
    this.foodLoadingLabel = `Updating Swiggy Food cart…`;
    this.render();
    try {
      this.foodCart = await manageFoodCart(
        {
          action,
          addressId: this.selectedFoodAddr || "",
          restaurantId: this.selectedRestaurant?.id || this.foodCart?.restaurantId || "",
          restaurantName: this.selectedRestaurant?.name || this.foodCart?.restaurantName || "",
          menuItemId: dish?.id,
          quantity
        },
        prefs
      );
      this.paymentOptions["swiggy-food"] = null;
      this.notifyParentCounts();
    } catch (err) {
      const msg = err?.message || "Could not update Swiggy Food cart.";
      this.foodError = msg;
      this.checkoutError = msg;
    } finally {
      this.foodLoading = false;
      this.render();
    }
  }

  async loadPaymentOptions(provider) {
    const mcp = this.cb.getMcpStatus?.();
    if (!isPlatformMcpConnected(provider, mcp)) return;
    const cart = provider === "swiggy-food" ? this.foodCart : this.groceryCarts[provider];
    if (!cart?.items?.length) return;

    const prefs = this.cb.getDeliveryPrefs?.() || {};
    this.checkoutError = "";
    this.checkoutLoading = true;
    this.checkoutLoadingLabel = "Loading live payment methods…";
    this.render();
    try {
      const opts = await fetchPaymentOptions(
        { provider, addressId: this.getActiveAddressId(provider) },
        prefs
      );
      this.paymentOptions[provider] = opts;
      if (!this.selectedPayment || this.selectedPayment.provider !== provider) {
        this.selectedPayment = this.pickDefaultPaymentMethod(opts, provider);
      }
    } catch (err) {
      this.checkoutError = err?.message || "Could not load payment options.";
    } finally {
      this.checkoutLoading = false;
      this.render();
    }
  }

  pickDefaultPaymentMethod(opts, provider) {
    if (!opts) return null;
    if (provider === "zepto") {
      const first = opts.zeptoMethods?.[0];
      return first ? { provider, methodType: "zepto", paymentMethod: first.id, label: first.displayName } : null;
    }
    if (opts.desktopQr?.length) {
      return {
        provider,
        methodType: "upi_qr",
        paymentMethod: "UPI",
        label: opts.desktopQr[0].displayName || "Scan UPI QR"
      };
    }
    if (opts.mobileUpiApps?.length) {
      const m = opts.mobileUpiApps[0];
      return {
        provider,
        methodType: "upi_intent",
        paymentMethod: "UPI",
        intentApp: m.id,
        label: m.displayName || "UPI App"
      };
    }
    if (opts.swiggyMoney?.available) {
      return {
        provider,
        methodType: "swiggy_money",
        paymentMethod: "SwiggyPay",
        label: opts.swiggyMoney.displayName || "Swiggy Money"
      };
    }
    if (opts.cod) {
      return {
        provider,
        methodType: "cod",
        paymentMethod: opts.cod.id || (provider === "swiggy-food" ? "Cash" : "COD"),
        label: opts.cod.displayName || "Cash on Delivery"
      };
    }
    return null;
  }

  async executeConfirmedPayment() {
    const provider = this.checkoutProvider;
    const sel = this.selectedPayment;
    if (!sel) {
      this.checkoutError = "Select a payment method first.";
      this.render();
      return;
    }

    const prefs = this.cb.getDeliveryPrefs?.() || {};
    this.checkoutError = "";
    this.checkoutLoading = true;
    this.checkoutLoadingLabel =
      sel.methodType === "upi_qr" || sel.methodType === "upi_intent"
        ? "Generating UPI payment request…"
        : "Placing real order…";
    this.render();

    try {
      const res = await submitRealPayment(
        {
          provider,
          addressId: this.getActiveAddressId(provider),
          methodType: sel.methodType,
          paymentMethod: sel.paymentMethod,
          intentApp: sel.intentApp || "",
          confirmedRealOrder: true
        },
        prefs
      );

      this.confirmRealOrder = false;

      if (res.status === "PENDING_PAYMENT" || res.normalizedStatus === "pending") {
        this.pendingUpiOrder = res;
        this.schedulePaymentPoll(res);
      } else {
        this.pendingUpiOrder = null;
        this.activeOrder = {
          provider,
          orderId: res.orderId,
          status: res.status || "PLACED",
          etaText: "",
          delivered: false,
          cancelled: false,
          brandMessage: res.brandMessage,
          addressId: this.getActiveAddressId(provider)
        };
        if (provider === "swiggy-food") this.foodCart = null;
        else this.groceryCarts[provider] = null;
        this.notifyParentCounts();
      }
    } catch (err) {
      this.checkoutError =
        err?.message || "Payment initiation failed. Check your app's recent orders before retrying.";
    } finally {
      this.checkoutLoading = false;
      this.render();
    }
  }

  schedulePaymentPoll(pending) {
    this.stopTimers();
    if (!pending) return;
    const interval = Math.max(4000, Number(pending.pollingIntervalInMs) || 4000);
    const deadline = (pending._startedAt ||= Date.now()) + Math.min(180000, Number(pending.maxTimeToPollForInMs) || 180000);
    if (Date.now() > deadline) {
      this.checkoutError = "Payment confirmation window timed out — check your UPI app or tap Check status now.";
      this.render();
      return;
    }
    this._pollTimer = setTimeout(() => {
      if (this.dialog.open && this.pendingUpiOrder) {
        this.checkPendingPaymentNow(true);
      }
    }, interval);
  }

  async checkPendingPaymentNow(autoContinue = false) {
    const p = this.pendingUpiOrder;
    if (!p) return;
    const prefs = this.cb.getDeliveryPrefs?.() || {};

    try {
      const st = await pollPaymentStatus(
        {
          provider: p.provider,
          orderId: p.orderId,
          paasId: p.paasId,
          ...(p.foodContext || {})
        },
        prefs
      );

      const sLower = String(st.status || "").toLowerCase();
      if (st.terminal && (sLower === "success" || sLower === "paid" || st.confirmed)) {
        let finalMsg = st.message || "";
        if (!st.confirmed) {
          const conf = await confirmPaidOrder(
            {
              provider: p.provider,
              orderId: p.orderId,
              paasId: p.paasId,
              transactionId: p.transactionId,
              ...(p.foodContext || {})
            },
            prefs
          );
          finalMsg = conf.message || finalMsg;
        }
        this.stopTimers();
        this.pendingUpiOrder = null;
        this.activeOrder = {
          provider: p.provider,
          orderId: p.orderId,
          status: "PLACED",
          etaText: "",
          delivered: false,
          cancelled: false,
          brandMessage: finalMsg || `${p.provider === "swiggy-food" ? "Swiggy" : "Instamart"} order placed successfully`,
          addressId: p.foodContext?.addressId || this.getActiveAddressId(p.provider)
        };
        if (p.provider === "swiggy-food") this.foodCart = null;
        else this.groceryCarts[p.provider] = null;
        this.notifyParentCounts();
        this.render();
        return;
      }

      if (st.terminal) {
        this.stopTimers();
        this.pendingUpiOrder = null;
        this.checkoutError =
          sLower === "cart_changed"
            ? "Cart price or stock changed before payment finished. Review your cart and try again."
            : st.message || `Payment ended with status: ${st.status}.`;
        this.render();
        return;
      }

      if (autoContinue && this.dialog.open) {
        this.schedulePaymentPoll(p);
      }
    } catch (err) {
      if (autoContinue && this.dialog.open) {
        this.schedulePaymentPoll(p);
      } else {
        this.checkoutError = err?.message || "Could not check payment status.";
        this.render();
      }
    }
  }

  async refreshActiveOrderTracking() {
    if (!this.activeOrder) return;
    const prefs = this.cb.getDeliveryPrefs?.() || {};
    this.checkoutLoading = true;
    this.checkoutLoadingLabel = "Refreshing delivery status…";
    this.render();
    try {
      const tr = await trackLiveOrder(
        {
          provider: this.activeOrder.provider,
          orderId: this.activeOrder.orderId,
          addressId: this.activeOrder.addressId || ""
        },
        prefs
      );
      this.activeOrder = {
        ...this.activeOrder,
        status: tr.status || this.activeOrder.status,
        etaText: tr.etaText || this.activeOrder.etaText,
        delivered: Boolean(tr.delivered),
        cancelled: Boolean(tr.cancelled)
      };
      this.notifyParentCounts();
    } catch (err) {
      this.checkoutError = err?.message || "Could not refresh delivery status.";
    } finally {
      this.checkoutLoading = false;
      this.render();
    }
  }

  getGroceryPlatformObj() {
    return GROCERY_PLATFORMS.find((p) => p.id === this.groceryPlatform) || GROCERY_PLATFORMS[0];
  }

  getFoodPlatformObj() {
    return FOOD_PLATFORMS.find((p) => p.id === this.foodPlatform) || FOOD_PLATFORMS[0];
  }

  renderProductCard(item, attrName, attrVal, cartObj) {
    const qty = getCartQtyForProduct(cartObj, item);
    const meta = [item.variant, formatPrice(item.price), item.mrp && item.mrp !== item.price ? `<s>${esc(formatPrice(item.mrp))}</s>` : "", item.inStock === false ? "Out of stock" : ""]
      .filter(Boolean)
      .join(" · ");

    return `
      <div class="ord-product-card">
        ${item.imageUrl ? `<img class="ord-thumb" src="${esc(item.imageUrl)}" alt="" loading="lazy" width="44" height="44">` : ""}
        <div class="ord-product-meta">
          <strong>${esc(item.name)}</strong>
          <small>${meta}</small>
        </div>
        ${
          qty > 0
            ? `<div class="ord-qty-ctl">
                <button type="button" class="m3-step-btn" data-g-dec="${esc(attrVal)}" aria-label="Decrease ${esc(item.name)}">−</button>
                <span>${qty}</span>
                <button type="button" class="m3-step-btn" data-g-inc="${esc(attrVal)}" ${item.inStock === false || this.groceryLoading ? "disabled" : ""} aria-label="Increase ${esc(item.name)}">+</button>
              </div>`
            : `<button type="button" class="tbtn ord-add-btn" ${attrName}="${esc(attrVal)}" ${item.inStock === false || this.groceryLoading ? "disabled" : ""}>+ Add</button>`
        }
      </div>
    `;
  }

  renderStickyBar(cart, providerLabel) {
    if (!cart?.items?.length) return "";
    const count = cart.items.reduce((s, it) => s + Number(it.quantity || 1), 0);
    return `
      <div class="ord-sticky-bar">
        <div>
          <strong>${count} item${count === 1 ? "" : "s"}${cart.total != null ? ` · ${esc(formatPrice(cart.total))}` : ""}</strong>
          <small>${esc(providerLabel)} Cart ready</small>
        </div>
        <button type="button" class="go ord-sm-btn" id="ord-go-cart-btn">Review Cart &amp; Pay →</button>
      </div>
    `;
  }

  renderGroceriesTab(rows) {
    const mcp = this.cb.getMcpStatus?.();
    const profile = this.cb.getProfile?.() || {};
    const hasPantry = Boolean(String(profile.pantry || "").trim());
    const neededRows = rows.filter((r) => r.needed);
    const platformObj = this.getGroceryPlatformObj();
    const connected = isPlatformMcpConnected(this.groceryPlatform, mcp);
    const addresses = this.groceryAddresses[this.groceryPlatform] || [];
    const currentCart = this.groceryCarts[this.groceryPlatform];

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
              ? `<label class="ord-addr-wrap">
                  <span class="visually-hidden">Delivery address</span>
                  <select class="m3-select ord-addr-select" id="ord-g-addr">
                    ${addresses
                      .map(
                        (a) =>
                          `<option value="${esc(a.id)}" ${String(this.selectedGroceryAddr[this.groceryPlatform]) === String(a.id) ? "selected" : ""}>${esc(a.label)}${a.details ? ` — ${esc(a.details.slice(0, 44))}` : ""}</option>`
                      )
                      .join("")}
                  </select>
                </label>`
              : `<button type="button" class="tbtn" id="ord-g-load-addr">Load addresses</button>`
          }
          ${this.groceryPlatform === "swiggy-im" ? `<button type="button" class="tbtn" id="ord-g-goto" ${this.groceryLoading ? "disabled" : ""}>Quick reorders</button>` : ""}
          <button type="button" class="go ord-sm-btn" id="ord-g-search-all" ${neededRows.length === 0 || this.groceryLoading ? "disabled" : ""}>Search missing (${neededRows.length})</button>
        </div>
      `
      : "";

    const goToHtml =
      connected && this.goToItems.length
        ? `<details class="ord-goto-box" open>
            <summary>Frequent go-to items (${this.goToItems.length})</summary>
            <div class="ord-product-grid">
              ${this.goToItems
                .map((item, idx) => this.renderProductCard(item, "data-goto-add", idx, currentCart))
                .join("")}
            </div>
          </details>`
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
                      .map((item, mIdx) => this.renderProductCard(item, "data-g-add", `${row.index}:${mIdx}`, currentCart))
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
                    ${connected ? `<button type="button" class="tbtn" data-g-find="${row.index}" ${this.groceryLoading ? "disabled" : ""}>Find</button>` : ""}
                    <a class="quiet-act ord-ext-link" href="${esc(deepUrl)}" target="_blank" rel="noopener noreferrer">${esc(platformObj.shortLabel)} ↗</a>
                  </div>
                </div>
                ${resultsHtml}
              </div>
            `;
          })
          .join("")
      : `<p class="ord-empty">Open a recipe first to view missing ingredients, or browse Cart &amp; Pay.</p>`;

    const bannerHtml = !connected
      ? mcp?.available
        ? `<div class="ord-banner">
            <span>Connected to Companion — sign in to <strong>${esc(platformObj.label)}</strong> to search live inventory, manage your cart, and pay via UPI/COD.</span>
            <button type="button" class="tbtn" id="ord-open-settings-btn">Sign in →</button>
          </div>`
        : `<div class="ord-banner">
            <span>Smart search links work everywhere. Configure <code>MISE_SESSION_SECRET</code> on Vercel (or run <code>npm start</code>) to build carts and pay inside Mise.</span>
            <button type="button" class="tbtn" id="ord-open-settings-btn">Delivery &amp; MCP →</button>
          </div>`
      : "";

    return `
      <div class="ord-top-meta">
        <span class="ord-count">${neededRows.length} missing of ${rows.length} ingredient${rows.length === 1 ? "" : "s"}</span>
        <div class="ord-top-tools">
          ${hasPantry ? `<button type="button" class="chip ${this.autoMatchPantry ? "is-active" : ""}" id="ord-pantry-toggle" aria-pressed="${this.autoMatchPantry}">Skip pantry staples</button>` : ""}
          <button type="button" class="tbtn" id="ord-copy-list">Copy checklist</button>
        </div>
      </div>

      <div class="ord-app-pills" role="tablist" aria-label="Grocery delivery app">${pillsHtml}</div>
      ${mcpToolbarHtml}
      ${this.groceryLoading ? `<div class="ord-loading">${renderCookingLoader({ compact: true, label: this.groceryLoadingLabel || "Working…" })}</div>` : ""}
      ${this.groceryError ? `<p class="ord-err">${esc(this.groceryError)}</p>` : ""}
      ${goToHtml}
      <div class="ord-ing-list">${rowsHtml}</div>
      ${connected ? this.renderStickyBar(currentCart, platformObj.shortLabel) : ""}
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
                          `<option value="${esc(a.id)}" ${String(this.selectedFoodAddr) === String(a.id) ? "selected" : ""}>${esc(a.label)}${a.details ? ` — ${esc(a.details.slice(0, 44))}` : ""}</option>`
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
                        .map((dish, idx) => {
                          const qty = getCartQtyForProduct(this.foodCart, dish);
                          return `
                      <div class="ord-product-card">
                        <div class="ord-product-meta">
                          <strong>${esc(dish.name)}</strong>
                          <small>${[formatPrice(dish.price), dish.category, dish.inStock === false ? "Unavailable" : ""].filter(Boolean).join(" · ")}</small>
                        </div>
                        ${
                          qty > 0
                            ? `<div class="ord-qty-ctl">
                                <button type="button" class="m3-step-btn" data-f-dec="${idx}" aria-label="Decrease ${esc(dish.name)}">−</button>
                                <span>${qty}</span>
                                <button type="button" class="m3-step-btn" data-f-inc="${idx}" ${this.foodLoading ? "disabled" : ""} aria-label="Increase ${esc(dish.name)}">+</button>
                              </div>`
                            : `<button type="button" class="tbtn ord-add-btn" data-f-add="${idx}" ${dish.inStock === false || this.foodLoading ? "disabled" : ""}>+ Add</button>`
                        }
                      </div>
                    `;
                        })
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
                      <small>${[rest.availabilityStatus, rest.rating ? `★ ${rest.rating}` : "", rest.eta, rest.distance, rest.costForTwo].filter(Boolean).join(" · ")}</small>
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
          ${this.renderStickyBar(this.foodCart, this.foodCart?.restaurantName || "Swiggy Food")}
        `
        : `
          <div class="ord-launch-card">
            <div class="ord-launch-acts">
              <a class="go" href="${esc(primaryUrl)}" target="_blank" rel="noopener noreferrer">Search “${esc(this.dishQuery || this.recipe?.title || "dish")}” on ${esc(this.getFoodPlatformObj().label)} ↗</a>
              <a class="tbtn" href="${esc(altUrl)}" target="_blank" rel="noopener noreferrer">Also search on ${esc(altName)} ↗</a>
            </div>
            <p class="st-help">
              ${
                this.foodPlatform === "zomato"
                  ? "Zomato’s official MCP server restricts OAuth callbacks to 6 approved clients (ChatGPT, Claude, VS Code, Postman), so Mise opens Zomato delivery search directly for your dish and city."
                  : mcp?.available
                  ? "Sign in to Swiggy in Settings to browse live nearby restaurant menus, apply coupons, and pay inside Mise."
                  : "Smart deep-links open Swiggy & Zomato directly. Connect a Local Companion or free Vercel backend in Settings for live Swiggy menus & UPI checkout."
              }
            </p>
            ${this.foodPlatform === "swiggy-food" ? `<button type="button" class="quiet-act" id="ord-open-settings-btn">Configure accounts in Settings →</button>` : ""}
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

  renderCartAndPayTab() {
    const mcp = this.cb.getMcpStatus?.();
    const providers = [
      { id: "swiggy-im", label: "Swiggy Instamart" },
      { id: "swiggy-food", label: "Swiggy Food" },
      { id: "zepto", label: "Zepto" }
    ];

    const pillsHtml = providers
      .map((p) => {
        const on = isPlatformMcpConnected(p.id, mcp);
        const count =
          p.id === "swiggy-food"
            ? (this.foodCart?.items || []).reduce((s, it) => s + Number(it.quantity || 1), 0)
            : (this.groceryCarts[p.id]?.items || []).reduce((s, it) => s + Number(it.quantity || 1), 0);
        return `
          <button type="button" class="ord-app-pill ${this.checkoutProvider === p.id ? "is-active" : ""}" data-ord-cprov="${esc(p.id)}">
            ${on ? `<span class="mcp-dot is-on" aria-label="Connected"></span>` : ""}
            <span>${esc(p.label)}</span>
            <small>${count > 0 ? `${count} item${count === 1 ? "" : "s"}` : on ? "Ready" : "Off"}</small>
          </button>
        `;
      })
      .join("");

    // Active Live Order Tracker screen
    if (this.activeOrder && this.activeOrder.provider === this.checkoutProvider) {
      const ao = this.activeOrder;
      return `
        <div class="ord-app-pills" role="tablist" aria-label="Checkout service">${pillsHtml}</div>
        <section class="ord-track-card">
          <div class="ord-cart-head">
            <div>
              <span class="ord-kicker">${esc(ao.provider === "swiggy-food" ? "Swiggy Food" : ao.provider === "zepto" ? "Zepto" : "Swiggy Instamart")}</span>
              <h3>${esc(ao.brandMessage || "Order placed successfully")}</h3>
            </div>
            <span class="mcp-badge is-on">${esc(ao.status || "PLACED")}</span>
          </div>
          <dl class="ord-bill">
            ${ao.orderId ? `<div><dt>Order ID</dt><dd><code>${esc(ao.orderId)}</code></dd></div>` : ""}
            ${ao.etaText ? `<div><dt>Estimated arrival</dt><dd><strong>${esc(ao.etaText)}</strong></dd></div>` : ""}
          </dl>
          ${this.checkoutError ? `<p class="ord-err">${esc(this.checkoutError)}</p>` : ""}
          <div class="ord-cart-acts">
            <button type="button" class="go ord-sm-btn" id="ord-c-track-refresh" ${this.checkoutLoading ? "disabled" : ""}>Refresh live status</button>
            <button type="button" class="tbtn" id="ord-c-new-order">Start another order</button>
          </div>
          ${ao.provider === "swiggy-food" ? `<p class="st-help">To cancel a placed Swiggy Food order, call Swiggy customer care at <code>080-67466729</code>.</p>` : ""}
        </section>
      `;
    }

    // Pending UPI Payment Screen (QR + App Intent + Status Poll)
    if (this.pendingUpiOrder) {
      const pu = this.pendingUpiOrder;
      let qrSvgHtml = "";
      if (pu.upiIntentUrl) {
        try {
          qrSvgHtml = renderQrSvg(pu.upiIntentUrl, { size: 220, label: "Scan UPI QR to pay" });
        } catch {
          qrSvgHtml = "";
        }
      }
      return `
        <div class="ord-app-pills" role="tablist" aria-label="Checkout service">${pillsHtml}</div>
        <section class="ord-qr-card">
          <div class="ord-cart-head">
            <div>
              <span class="ord-kicker">Awaiting UPI Payment</span>
              <h3>${pu.totalAmount != null ? `Pay ${esc(formatPrice(pu.totalAmount))}` : "Complete payment in UPI app"}</h3>
              <small>Order is created as <code>PENDING_PAYMENT</code> and confirms automatically once UPI settles.</small>
            </div>
            <span class="mcp-badge">Polling live</span>
          </div>
          ${qrSvgHtml ? `<div class="ord-qr-frame">${qrSvgHtml}</div>` : ""}
          <div class="ord-launch-acts">
            ${pu.upiIntentUrl ? `<a class="go" href="${esc(pu.upiIntentUrl)}" target="_blank" rel="noopener noreferrer">Open in UPI App ↗</a>` : ""}
            ${pu.paymentUrl && pu.paymentUrl !== pu.upiIntentUrl ? `<a class="tbtn" href="${esc(pu.paymentUrl)}" target="_blank" rel="noopener noreferrer">Open Payment Link ↗</a>` : ""}
          </div>
          ${this.checkoutError ? `<p class="ord-err">${esc(this.checkoutError)}</p>` : ""}
          <div class="ord-cart-acts">
            <button type="button" class="tbtn" id="ord-c-pay-check">Check payment status</button>
            <button type="button" class="quiet-act" id="ord-c-pay-cancel">Back to cart</button>
          </div>
        </section>
      `;
    }

    const connected = isPlatformMcpConnected(this.checkoutProvider, mcp);
    if (!connected) {
      return `
        <div class="ord-app-pills" role="tablist" aria-label="Checkout service">${pillsHtml}</div>
        <div class="ord-banner">
          <span>Sign in to <strong>${esc(providers.find((x) => x.id === this.checkoutProvider)?.label || this.checkoutProvider)}</strong> to view your live cart, bill breakdown, and pay inside Mise.</span>
          <button type="button" class="go ord-sm-btn" id="ord-open-settings-btn">Sign in in Settings →</button>
        </div>
      `;
    }

    const cart = this.getActiveCheckoutCart();
    const addresses = this.getActiveAddressList(this.checkoutProvider);
    const activeAddrId = this.getActiveAddressId(this.checkoutProvider);
    const activeAddr = addresses.find((a) => String(a.id) === String(activeAddrId));

    if (!cart || !cart.items?.length) {
      return `
        <div class="ord-app-pills" role="tablist" aria-label="Checkout service">${pillsHtml}</div>
        <div class="ord-banner">
          <span>Your ${esc(providers.find((x) => x.id === this.checkoutProvider)?.label)} cart is empty. Add items from Groceries or Restaurants first.</span>
          <button type="button" class="tbtn" id="ord-c-refresh-cart">Refresh cart</button>
        </div>
      `;
    }

    const opts = this.paymentOptions[this.checkoutProvider];
    const payMethods = [];
    if (opts) {
      if (opts.desktopQr?.length) {
        payMethods.push({
          provider: this.checkoutProvider,
          methodType: "upi_qr",
          paymentMethod: "UPI",
          label: opts.desktopQr[0].displayName || "Scan UPI QR (Desktop)",
          hint: "Shows scannable QR right in Mise"
        });
      }
      for (const m of opts.mobileUpiApps || []) {
        payMethods.push({
          provider: this.checkoutProvider,
          methodType: "upi_intent",
          paymentMethod: "UPI",
          intentApp: m.id,
          label: m.displayName || m.id,
          hint: "Launches UPI app intent"
        });
      }
      if (opts.swiggyMoney?.available) {
        payMethods.push({
          provider: this.checkoutProvider,
          methodType: "swiggy_money",
          paymentMethod: "SwiggyPay",
          label: opts.swiggyMoney.displayName || "Swiggy Money",
          hint: "Instant wallet debit"
        });
      }
      if (opts.cod) {
        payMethods.push({
          provider: this.checkoutProvider,
          methodType: "cod",
          paymentMethod: opts.cod.id || (this.checkoutProvider === "swiggy-food" ? "Cash" : "COD"),
          label: opts.cod.displayName || "Cash on Delivery",
          hint: "Pay at doorstep"
        });
      }
      for (const zm of opts.zeptoMethods || []) {
        payMethods.push({
          provider: "zepto",
          methodType: "zepto",
          paymentMethod: zm.id,
          label: zm.displayName || zm.id,
          hint: zm.kind === "link" ? "Payment link in chat/Mise" : "Zepto checkout"
        });
      }
    }

    const bill = cart.bill || {};
    const totalPay = bill.toPay ?? cart.total;

    return `
      <div class="ord-app-pills" role="tablist" aria-label="Checkout service">${pillsHtml}</div>
      ${
        addresses.length
          ? `<div class="ord-mcp-bar">
              <label class="ord-addr-wrap">
                <span class="visually-hidden">Delivery address</span>
                <select class="m3-select ord-addr-select" id="ord-c-addr">
                  ${addresses
                    .map(
                      (a) =>
                        `<option value="${esc(a.id)}" ${String(activeAddrId) === String(a.id) ? "selected" : ""}>${esc(a.label)}${a.details ? ` — ${esc(a.details.slice(0, 56))}` : ""}</option>`
                    )
                    .join("")}
                </select>
              </label>
              <button type="button" class="tbtn" id="ord-c-refresh-cart">Refresh</button>
              <button type="button" class="tbtn" id="ord-c-clear-cart">Clear cart</button>
            </div>`
          : ""
      }

      ${this.checkoutLoading || this.groceryLoading || this.foodLoading ? `<div class="ord-loading">${renderCookingLoader({ compact: true, label: this.checkoutLoadingLabel || this.groceryLoadingLabel || this.foodLoadingLabel || "Updating…" })}</div>` : ""}
      ${this.checkoutError ? `<p class="ord-err">${esc(this.checkoutError)}</p>` : ""}

      <div class="ord-ing-list">
        ${cart.items
          .map(
            (it, idx) => `
          <div class="ord-ing-item">
            <div class="ord-ing-row">
              <div class="t">
                <strong>${esc(it.name)}</strong>
                ${it.variant || it.price != null ? `<span class="sub">· ${[it.variant, formatPrice(it.price)].filter(Boolean).join(" · ")}</span>` : ""}
              </div>
              <div class="ord-qty-ctl">
                <button type="button" class="m3-step-btn" data-c-dec="${idx}" aria-label="Decrease ${esc(it.name)}">−</button>
                <span>${it.quantity}</span>
                <button type="button" class="m3-step-btn" data-c-inc="${idx}" aria-label="Increase ${esc(it.name)}">+</button>
              </div>
            </div>
          </div>
        `
          )
          .join("")}
      </div>

      ${
        this.checkoutProvider === "swiggy-food"
          ? `<div class="ord-cart-acts">
              <button type="button" class="tbtn" id="ord-c-coupons">Browse coupons</button>
              ${cart.appliedCoupon ? `<span class="mcp-badge is-on">Applied: ${esc(cart.appliedCoupon)}</span>` : ""}
            </div>
            ${
              this.foodCoupons.length
                ? `<div class="preset-chips">${this.foodCoupons
                    .slice(0, 5)
                    .map((c) => `<button type="button" class="chip" data-c-coupon="${esc(c.id || c.code)}">${esc(c.id || c.code)}${c.description ? ` — ${esc(c.description.slice(0, 36))}` : ""}</button>`)
                    .join("")}</div>`
                : ""
            }`
          : ""
      }

      <section class="ord-cart-card" aria-label="Bill breakdown">
        <dl class="ord-bill">
          ${bill.itemTotal != null ? `<div><dt>Items</dt><dd>${esc(formatPrice(bill.itemTotal))}</dd></div>` : ""}
          ${bill.deliveryFee != null ? `<div><dt>Delivery fee</dt><dd>${esc(formatPrice(bill.deliveryFee))}</dd></div>` : ""}
          ${bill.handlingFee != null ? `<div><dt>Handling</dt><dd>${esc(formatPrice(bill.handlingFee))}</dd></div>` : ""}
          ${bill.taxes != null ? `<div><dt>Taxes &amp; charges</dt><dd>${esc(formatPrice(bill.taxes))}</dd></div>` : ""}
          ${bill.discount != null && bill.discount > 0 ? `<div><dt>Discount</dt><dd>−${esc(formatPrice(bill.discount))}</dd></div>` : ""}
          <div class="is-total"><dt>To Pay</dt><dd>${totalPay != null ? esc(formatPrice(totalPay)) : "Calculated at checkout"}</dd></div>
        </dl>
        ${cart.warnings?.length ? `<p class="ord-warn">${esc(cart.warnings.join(" "))}</p>` : ""}
      </section>

      <section class="ord-cart-card" aria-label="Payment method">
        <div class="ord-cart-head">
          <div>
            <strong>Choose payment method</strong>
            <small>${activeAddr ? `Delivering to ${esc(activeAddr.label)}${activeAddr.details ? ` — ${esc(activeAddr.details.slice(0, 52))}` : ""}` : "Live methods returned by merchant"}</small>
          </div>
          <button type="button" class="tbtn" id="ord-c-load-pay">Refresh methods</button>
        </div>
        ${
          payMethods.length
            ? `<div class="ord-pay-grid">
                ${payMethods
                  .map((m, idx) => {
                    const isSel =
                      this.selectedPayment &&
                      this.selectedPayment.methodType === m.methodType &&
                      this.selectedPayment.paymentMethod === m.paymentMethod &&
                      (this.selectedPayment.intentApp || "") === (m.intentApp || "");
                    return `
                      <button type="button" class="ord-pay-opt ${isSel ? "is-active" : ""}" data-pay-idx="${idx}">
                        <strong>${esc(m.label)}</strong>
                        <small>${esc(m.hint)}</small>
                      </button>
                    `;
                  })
                  .join("")}
              </div>`
            : `<p class="ord-empty">No live payment options loaded yet.</p>`
        }

        ${
          this.confirmRealOrder
            ? `
          <div class="ord-confirm-box" role="alert">
            <p>
              <strong>Confirm real payment:</strong>
              Place order${totalPay != null ? ` for <strong>${esc(formatPrice(totalPay))}</strong>` : ""} via
              <strong>${esc(this.selectedPayment?.label || "selected method")}</strong>
              ${activeAddr ? `to <strong>${esc(activeAddr.label)}</strong> (${esc(activeAddr.details || "")})` : "to your saved address"}?
            </p>
            <div class="ord-confirm-acts">
              <button type="button" class="tbtn" id="ord-c-cancel-pay" autofocus>Cancel</button>
              <button type="button" class="go" id="ord-c-confirm-pay" ${this.checkoutLoading || cart.exceedsCap ? "disabled" : ""}>Pay &amp; Place Real Order</button>
            </div>
          </div>
        `
            : `<button type="button" class="go" id="ord-c-start-pay" ${!this.selectedPayment || this.checkoutLoading || cart.exceedsCap ? "disabled" : ""}>Continue to Pay${totalPay != null ? ` ${esc(formatPrice(totalPay))}` : ""} →</button>`
        }
      </section>
    `;
  }

  render() {
    if (!this.dialog) return;
    const rows = this.getMissingRows();
    const cartCount = this.getTotalCartCount();
    let bodyHtml = "";
    if (this.activeTab === "restaurants") bodyHtml = this.renderRestaurantsTab();
    else if (this.activeTab === "cart") bodyHtml = this.renderCartAndPayTab();
    else bodyHtml = this.renderGroceriesTab(rows);

    this.dialog.innerHTML = `
      <div class="ord-shell">
        <header class="ord-head">
          <div>
            <small class="ord-kicker">${esc(this.recipe?.title || "Mise Kitchen Companion")}</small>
            <h2 id="order-dialog-title">Order for this dish</h2>
          </div>
          <button type="button" class="pop-close" id="ord-close-btn" aria-label="Close ordering sheet">×</button>
        </header>

        <div class="m3-seg ord-tabs" role="tablist" aria-label="Ordering mode">
          <button type="button" role="tab" aria-selected="${this.activeTab === "groceries"}" class="m3-seg-btn ${this.activeTab === "groceries" ? "is-active" : ""}" data-ord-tab="groceries">Groceries</button>
          <button type="button" role="tab" aria-selected="${this.activeTab === "restaurants"}" class="m3-seg-btn ${this.activeTab === "restaurants" ? "is-active" : ""}" data-ord-tab="restaurants">Restaurants</button>
          <button type="button" role="tab" aria-selected="${this.activeTab === "cart"}" class="m3-seg-btn ${this.activeTab === "cart" ? "is-active" : ""}" data-ord-tab="cart">Cart &amp; Pay${cartCount > 0 ? ` (${cartCount})` : ""}</button>
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
        if (this.activeTab === "cart") {
          this.checkoutProvider = this.pickBestCheckoutProvider();
        }
        this.render();
        this.hydrateActiveView();
      });
    });

    d.querySelector("#ord-go-cart-btn")?.addEventListener("click", () => {
      const prevTab = this.activeTab;
      this.activeTab = "cart";
      this.checkoutProvider = prevTab === "restaurants"
        ? "swiggy-food"
        : (this.groceryPlatform !== "blinkit" && this.groceryCarts[this.groceryPlatform]?.items?.length
          ? this.groceryPlatform
          : this.pickBestCheckoutProvider());
      this.render();
      this.hydrateActiveView();
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
          this.goToItems = [];
          this.render();
          this.hydrateActiveView();
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
        await this.ensureAddressesAndCart(this.groceryPlatform);
      });

      d.querySelector("#ord-g-goto")?.addEventListener("click", () => this.loadQuickReorders());

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

      const resolveSearchItem = (val) => {
        if (String(val).startsWith("goto:")) {
          return this.goToItems[Number(String(val).slice(5))] || null;
        }
        const [ingIdx, matchIdx] = String(val).split(":").map(Number);
        return (this.groceryResults[`${this.groceryPlatform}:${ingIdx}`] || [])[matchIdx] || null;
      };

      d.querySelectorAll("[data-goto-add]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const item = this.goToItems[Number(btn.dataset.gotoAdd)];
          if (item) this.mutateGroceryCart({ action: "add", item, quantity: 1 });
        });
      });

      d.querySelectorAll("[data-g-add]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const item = resolveSearchItem(btn.dataset.gAdd);
          if (item) this.mutateGroceryCart({ action: "add", item, quantity: 1 });
        });
      });

      d.querySelectorAll("[data-g-inc]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const item = resolveSearchItem(btn.dataset.gInc) || this.goToItems[Number(btn.dataset.gInc)];
          if (!item) return;
          const curQty = getCartQtyForProduct(this.groceryCarts[this.groceryPlatform], item);
          this.mutateGroceryCart({ action: "set_qty", item, quantity: curQty + 1 });
        });
      });

      d.querySelectorAll("[data-g-dec]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const item = resolveSearchItem(btn.dataset.gDec) || this.goToItems[Number(btn.dataset.gDec)];
          if (!item) return;
          const curQty = getCartQtyForProduct(this.groceryCarts[this.groceryPlatform], item);
          this.mutateGroceryCart({ action: "set_qty", item, quantity: Math.max(0, curQty - 1) });
        });
      });
    } else if (this.activeTab === "restaurants") {
      d.querySelectorAll("[data-ord-fprov]").forEach((btn) => {
        btn.addEventListener("click", () => {
          this.foodPlatform = btn.dataset.ordFprov;
          this.foodError = "";
          this.render();
          this.hydrateActiveView();
        });
      });

      d.querySelector("#ord-dish-q")?.addEventListener("input", (e) => {
        this.dishQuery = e.target.value;
        const anchors = d.querySelectorAll(".ord-launch-acts a");
        if (anchors.length >= 2) {
          const zUrl = buildRestaurantDeepLink("zomato", this.dishQuery || this.recipe?.title || "", this.city);
          const sUrl = buildRestaurantDeepLink("swiggy-food", this.dishQuery || this.recipe?.title || "", this.city);
          anchors[0].href = this.foodPlatform === "zomato" ? zUrl : sUrl;
          anchors[0].textContent = `Search “${this.dishQuery || this.recipe?.title || "dish"}” on ${this.getFoodPlatformObj().label} ↗`;
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
          if (dish) this.mutateFoodCart({ action: "add", dish, quantity: 1 });
        });
      });

      d.querySelectorAll("[data-f-inc]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const dish = this.menuItems[Number(btn.dataset.fInc)];
          if (!dish) return;
          const q = getCartQtyForProduct(this.foodCart, dish);
          this.mutateFoodCart({ action: "set_qty", dish, quantity: q + 1 });
        });
      });

      d.querySelectorAll("[data-f-dec]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const dish = this.menuItems[Number(btn.dataset.fDec)];
          if (!dish) return;
          const q = getCartQtyForProduct(this.foodCart, dish);
          this.mutateFoodCart({ action: "set_qty", dish, quantity: Math.max(0, q - 1) });
        });
      });
    } else {
      // Cart & Pay Tab
      d.querySelectorAll("[data-ord-cprov]").forEach((btn) => {
        btn.addEventListener("click", () => {
          this.checkoutProvider = btn.dataset.ordCprov;
          this.checkoutError = "";
          this.confirmRealOrder = false;
          this.selectedPayment = null;
          this.render();
          this.hydrateActiveView();
        });
      });

      d.querySelector("#ord-c-addr")?.addEventListener("change", (e) => {
        if (this.checkoutProvider === "swiggy-food") this.selectedFoodAddr = e.target.value;
        else this.selectedGroceryAddr[this.checkoutProvider] = e.target.value;
      });

      d.querySelector("#ord-c-refresh-cart")?.addEventListener("click", async () => {
        const prefs = this.cb.getDeliveryPrefs?.() || {};
        this.checkoutError = "";
        try {
          if (this.checkoutProvider === "swiggy-food") {
            this.foodCart = await manageFoodCart({ action: "get", addressId: this.selectedFoodAddr }, prefs);
          } else {
            this.groceryCarts[this.checkoutProvider] = await manageGroceryCart(
              { provider: this.checkoutProvider, action: "get" },
              prefs
            );
          }
          this.notifyParentCounts();
          this.render();
        } catch (err) {
          this.checkoutError = err?.message || "Could not refresh cart.";
          this.render();
        }
      });

      d.querySelector("#ord-c-clear-cart")?.addEventListener("click", async () => {
        if (this.checkoutProvider === "swiggy-food") {
          await this.mutateFoodCart({ action: "flush" });
        } else {
          await this.mutateGroceryCart({ provider: this.checkoutProvider, action: "clear" });
        }
      });

      const activeCart = this.getActiveCheckoutCart();
      d.querySelectorAll("[data-c-inc]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const it = activeCart?.items?.[Number(btn.dataset.cInc)];
          if (!it) return;
          if (this.checkoutProvider === "swiggy-food") {
            this.mutateFoodCart({ action: "set_qty", dish: it, quantity: (it.quantity || 1) + 1 });
          } else {
            this.mutateGroceryCart({
              provider: this.checkoutProvider,
              action: "set_qty",
              item: it,
              quantity: (it.quantity || 1) + 1
            });
          }
        });
      });

      d.querySelectorAll("[data-c-dec]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const it = activeCart?.items?.[Number(btn.dataset.cDec)];
          if (!it) return;
          const nextQ = Math.max(0, (it.quantity || 1) - 1);
          if (this.checkoutProvider === "swiggy-food") {
            this.mutateFoodCart({ action: "set_qty", dish: it, quantity: nextQ });
          } else {
            this.mutateGroceryCart({
              provider: this.checkoutProvider,
              action: "set_qty",
              item: it,
              quantity: nextQ
            });
          }
        });
      });

      d.querySelector("#ord-c-coupons")?.addEventListener("click", async () => {
        try {
          const res = await manageFoodCart(
            {
              action: "coupons",
              addressId: this.selectedFoodAddr,
              restaurantId: this.foodCart?.restaurantId || ""
            },
            this.cb.getDeliveryPrefs?.()
          );
          this.foodCoupons = res.coupons || [];
          this.render();
        } catch (err) {
          this.checkoutError = err?.message || "Could not load coupons.";
          this.render();
        }
      });

      d.querySelectorAll("[data-c-coupon]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            this.foodCart = await manageFoodCart(
              {
                action: "apply_coupon",
                addressId: this.selectedFoodAddr,
                restaurantName: this.foodCart?.restaurantName || "",
                couponCode: btn.dataset.cCoupon
              },
              this.cb.getDeliveryPrefs?.()
            );
            this.notifyParentCounts();
            this.render();
          } catch (err) {
            this.checkoutError = err?.message || "Coupon could not be applied.";
            this.render();
          }
        });
      });

      d.querySelector("#ord-c-load-pay")?.addEventListener("click", () => {
        this.loadPaymentOptions(this.checkoutProvider);
      });

      d.querySelectorAll("[data-pay-idx]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const opts = this.paymentOptions[this.checkoutProvider];
          const all = [];
          if (opts?.desktopQr?.length) {
            all.push({
              provider: this.checkoutProvider,
              methodType: "upi_qr",
              paymentMethod: "UPI",
              label: opts.desktopQr[0].displayName || "Scan UPI QR (Desktop)"
            });
          }
          for (const m of opts?.mobileUpiApps || []) {
            all.push({
              provider: this.checkoutProvider,
              methodType: "upi_intent",
              paymentMethod: "UPI",
              intentApp: m.id,
              label: m.displayName || m.id
            });
          }
          if (opts?.swiggyMoney?.available) {
            all.push({
              provider: this.checkoutProvider,
              methodType: "swiggy_money",
              paymentMethod: "SwiggyPay",
              label: opts.swiggyMoney.displayName || "Swiggy Money"
            });
          }
          if (opts?.cod) {
            all.push({
              provider: this.checkoutProvider,
              methodType: "cod",
              paymentMethod: opts.cod.id || (this.checkoutProvider === "swiggy-food" ? "Cash" : "COD"),
              label: opts.cod.displayName || "Cash on Delivery"
            });
          }
          for (const zm of opts?.zeptoMethods || []) {
            all.push({
              provider: "zepto",
              methodType: "zepto",
              paymentMethod: zm.id,
              label: zm.displayName || zm.id
            });
          }
          this.selectedPayment = all[Number(btn.dataset.payIdx)] || null;
          this.confirmRealOrder = false;
          this.render();
        });
      });

      d.querySelector("#ord-c-start-pay")?.addEventListener("click", () => {
        this.confirmRealOrder = true;
        this.render();
        d.querySelector("#ord-c-cancel-pay")?.focus();
      });

      d.querySelector("#ord-c-cancel-pay")?.addEventListener("click", () => {
        this.confirmRealOrder = false;
        this.render();
      });

      d.querySelector("#ord-c-confirm-pay")?.addEventListener("click", () => {
        this.executeConfirmedPayment();
      });

      d.querySelector("#ord-c-pay-check")?.addEventListener("click", () => {
        this.checkPendingPaymentNow(false);
      });

      d.querySelector("#ord-c-pay-cancel")?.addEventListener("click", () => {
        this.stopTimers();
        this.pendingUpiOrder = null;
        this.render();
      });

      d.querySelector("#ord-c-track-refresh")?.addEventListener("click", () => {
        this.refreshActiveOrderTracking();
      });

      d.querySelector("#ord-c-new-order")?.addEventListener("click", () => {
        this.activeOrder = null;
        this.notifyParentCounts();
        this.render();
      });
    }
  }
}
