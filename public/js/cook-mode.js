import {
  convertAmount,
  convertStepTemperatures,
  extractTimersFromStep,
  matchStepIngredients
} from "./units.js";
import { formatClock } from "./timers.js";
import { closeTopLayer, setupModalDialog } from "./overlays.js";

const COOK_QUICK_PROMPTS = [
  "How do I know this step is ready?",
  "Mine looks too thick or dry",
  "Too salty or acidic — how to balance?",
  "Can I prep or pause here?"
];

export class CookModeController {
  constructor(dialogEl, { timerManager, onAskStep, onApplyRevision, getUnitSystem, getServings }) {
    this.dialog = dialogEl;
    this.timerManager = timerManager;
    this.onAskStep = onAskStep;
    this.onApplyRevision = onApplyRevision;
    this.getUnitSystem = getUnitSystem;
    this.getServings = getServings;

    this.recipe = null;
    this.stepIndex = 0;
    this.showIngredients = false;
    this.helpState = { loading: false, question: "", data: null, error: "" };
    this.wakeLock = null;
    this.recognition = null;
    this.voiceListening = false;
    this.speaking = false;
    this.timerUnsub = null;

    this.bindEvents();
  }

  bindEvents() {
    setupModalDialog(this.dialog, {
      onClose: () => {
        this.cleanupSession();
      }
    });

    this.onVisibilityChange = () => {
      if (document.visibilityState === "visible" && this.dialog.open && !this.wakeLock) {
        this.acquireWakeLock();
      }
    };
    document.addEventListener("visibilitychange", this.onVisibilityChange);

    this.onKeyDown = (e) => {
      if (!this.dialog.open) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "ArrowRight" || (e.key === " " && tag !== "BUTTON")) {
        e.preventDefault();
        this.next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        this.prev();
      } else if (e.key.toLowerCase() === "t") {
        e.preventDefault();
        this.togglePrimaryTimer();
      } else if (e.key.toLowerCase() === "i") {
        e.preventDefault();
        this.showIngredients = !this.showIngredients;
        this.render();
      } else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        this.toggleReadAloud();
      }
    };
    document.addEventListener("keydown", this.onKeyDown);
  }

  async acquireWakeLock() {
    try {
      if ("wakeLock" in navigator) {
        this.wakeLock = await navigator.wakeLock.request("screen");
        this.wakeLock.addEventListener("release", () => {
          this.wakeLock = null;
        });
      }
    } catch {
      this.wakeLock = null;
    }
  }

  releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
  }

  cleanupSession() {
    this.releaseWakeLock();
    this.stopSpeaking();
    this.stopVoice();
    if (this.timerUnsub) {
      this.timerUnsub();
      this.timerUnsub = null;
    }
  }

  open(recipe, startStep = 0) {
    if (!recipe || !recipe.steps?.length) return;
    this.recipe = recipe;
    this.stepIndex = Math.max(0, Math.min(startStep, recipe.steps.length - 1));
    this.showIngredients = false;
    this.helpState = { loading: false, question: "", data: null, error: "" };

    if (!this.timerUnsub) {
      this.timerUnsub = this.timerManager.subscribe(() => {
        if (this.dialog.open) this.updateTimerBadges();
      });
    }

    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    this.acquireWakeLock();
  }

  updateRecipe(recipe) {
    this.recipe = recipe;
    if (this.stepIndex >= (recipe?.steps?.length || 0)) {
      this.stepIndex = Math.max(0, (recipe?.steps?.length || 1) - 1);
    }
    if (this.dialog.open) this.render();
  }

  prev() {
    if (this.stepIndex > 0) {
      this.stepIndex--;
      this.helpState = { loading: false, question: "", data: null, error: "" };
      this.stopSpeaking();
      this.render();
    }
  }

  next() {
    const total = this.recipe?.steps?.length || 0;
    if (this.stepIndex < total - 1) {
      this.stepIndex++;
      this.helpState = { loading: false, question: "", data: null, error: "" };
      this.stopSpeaking();
      this.render();
    } else {
      closeTopLayer(this.dialog);
    }
  }

  togglePrimaryTimer() {
    const step = this.recipe?.steps?.[this.stepIndex];
    if (!step) return;
    const timers = extractTimersFromStep(step);
    if (!timers.length) return;
    const primary = timers[0];
    const id = `step-${this.stepIndex}-${primary.seconds}`;
    this.timerManager.startOrToggle(id, `${step.title} (${primary.label})`, primary.seconds);
  }

  toggleReadAloud() {
    if (!("speechSynthesis" in window)) return;
    if (this.speaking || window.speechSynthesis.speaking) {
      this.stopSpeaking();
      this.renderTopControls();
      return;
    }
    const step = this.recipe?.steps?.[this.stepIndex];
    if (!step) return;
    const text = convertStepTemperatures(step.text, this.getUnitSystem());
    const utter = new SpeechSynthesisUtterance(`Step ${this.stepIndex + 1}: ${step.title}. ${text}`);
    utter.rate = 0.96;
    utter.onend = () => {
      this.speaking = false;
      this.renderTopControls();
    };
    utter.onerror = () => {
      this.speaking = false;
      this.renderTopControls();
    };
    this.speaking = true;
    window.speechSynthesis.speak(utter);
    this.renderTopControls();
  }

  stopSpeaking() {
    this.speaking = false;
    try {
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    } catch {
      // Ignore
    }
  }

  toggleVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    if (this.voiceListening) {
      this.stopVoice();
      this.renderTopControls();
      return;
    }
    try {
      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = false;
      rec.lang = "en-US";
      rec.onresult = (event) => {
        const latest = event.results[event.results.length - 1]?.[0]?.transcript?.trim().toLowerCase() || "";
        if (!latest) return;
        if (/\b(next|forward)\b/.test(latest)) this.next();
        else if (/\b(back|previous)\b/.test(latest)) this.prev();
        else if (/\b(read|speak)\b/.test(latest)) this.toggleReadAloud();
        else if (/\b(timer|start timer|pause timer)\b/.test(latest)) this.togglePrimaryTimer();
        else if (/\bingredients\b/.test(latest)) {
          this.showIngredients = !this.showIngredients;
          this.render();
        } else if (latest.startsWith("ask chef") || latest.startsWith("chef")) {
          const q = latest.replace(/^(ask\s+)?chef[,:\s]*/i, "").trim();
          if (q) this.askChef(q);
        }
      };
      rec.onend = () => {
        if (this.voiceListening && this.dialog.open) {
          try {
            rec.start();
          } catch {
            this.voiceListening = false;
            this.renderTopControls();
          }
        }
      };
      rec.start();
      this.recognition = rec;
      this.voiceListening = true;
      this.renderTopControls();
    } catch {
      this.voiceListening = false;
    }
  }

  stopVoice() {
    this.voiceListening = false;
    if (this.recognition) {
      try {
        this.recognition.onend = null;
        this.recognition.stop();
      } catch {
        // Ignore
      }
      this.recognition = null;
    }
  }

  async askChef(question) {
    const q = String(question || "").trim();
    if (!q || this.helpState.loading) return;
    this.helpState = { loading: true, question: q, data: null, error: "" };
    this.renderHelpArea();
    try {
      const res = await this.onAskStep(this.stepIndex, q);
      this.helpState = { loading: false, question: q, data: res, error: "" };
    } catch (err) {
      this.helpState = { loading: false, question: q, data: null, error: err?.message || "Could not reach chef." };
    }
    if (this.dialog.open) this.renderHelpArea();
  }

  updateTimerBadges() {
    const btns = this.dialog.querySelectorAll("[data-cook-timer]");
    for (const btn of btns) {
      const id = btn.dataset.cookTimer;
      const defaultLabel = btn.dataset.defaultLabel;
      const t = this.timerManager.get(id);
      if (!t) {
        btn.textContent = `Start ${defaultLabel}`;
        btn.classList.remove("is-running", "is-done");
      } else if (t.done) {
        btn.textContent = `${defaultLabel} — Done`;
        btn.classList.remove("is-running");
        btn.classList.add("is-done");
      } else if (t.running) {
        btn.textContent = `Pause · ${formatClock(t.remainingSec)}`;
        btn.classList.add("is-running");
        btn.classList.remove("is-done");
      } else {
        btn.textContent = `Resume · ${formatClock(t.remainingSec)}`;
        btn.classList.remove("is-running", "is-done");
      }
    }
  }

  renderTopControls() {
    const readBtn = this.dialog.querySelector("#cook-read-btn");
    if (readBtn) readBtn.textContent = this.speaking ? "Stop reading" : "Read";
    const voiceBtn = this.dialog.querySelector("#cook-voice-btn");
    if (voiceBtn) {
      voiceBtn.textContent = this.voiceListening ? "Voice on" : "Voice";
      voiceBtn.classList.toggle("is-active", this.voiceListening);
    }
  }

  renderHelpArea() {
    const container = this.dialog.querySelector("#cook-help-out");
    if (!container) return;
    if (this.helpState.loading) {
      container.innerHTML = `<p class="cook-help-loading">Asking chef…</p>`;
      return;
    }
    if (this.helpState.error) {
      container.innerHTML = `<div class="cook-help-card is-error"><p>${esc(this.helpState.error)}</p></div>`;
      return;
    }
    if (!this.helpState.data) {
      container.innerHTML = "";
      return;
    }
    const d = this.helpState.data;
    container.innerHTML = `
      <div class="cook-help-card">
        <p>${esc(d.answer)}</p>
        ${d.sensory_cue ? `<p class="cook-cue">Check: ${esc(d.sensory_cue)}</p>` : ""}
        ${
          d.suggested_revision
            ? `<button type="button" class="tbtn" id="cook-apply-rev">Apply fix: ${esc(d.suggested_revision)}</button>`
            : ""
        }
      </div>
    `;
    const applyBtn = container.querySelector("#cook-apply-rev");
    if (applyBtn && d.suggested_revision) {
      applyBtn.addEventListener("click", async () => {
        applyBtn.disabled = true;
        applyBtn.textContent = "Adapting recipe…";
        await this.onApplyRevision(d.suggested_revision);
      });
    }
  }

  render() {
    const r = this.recipe;
    if (!r) return;
    const steps = r.steps || [];
    const step = steps[this.stepIndex];
    const total = steps.length;
    const unitSystem = this.getUnitSystem();
    const scaleRatio = this.getServings() / (r.servings || this.getServings() || 1);
    const pct = Math.round(((this.stepIndex + 1) / Math.max(1, total)) * 100);

    const matchedIdx = matchStepIngredients(step.text, r.ingredients || []);
    const timers = extractTimersFromStep(step);
    const hasSpeech = "speechSynthesis" in window;
    const hasVoice = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);

    const matchedHtml = matchedIdx.length
      ? `<div class="cook-ing-pills" aria-label="Ingredients used in this step">
          ${matchedIdx
            .map((i) => {
              const ing = r.ingredients[i];
              const amt = convertAmount(ing, scaleRatio, unitSystem);
              return `<span class="cook-pill"><b>${esc(amt)}</b> ${esc(ing.item)}</span>`;
            })
            .join("")}
        </div>`
      : "";

    const timersHtml = timers.length
      ? `<div class="cook-timers">
          ${timers
            .map((tm) => {
              const id = `step-${this.stepIndex}-${tm.seconds}`;
              return `<button type="button" class="timer-pill" data-cook-timer="${esc(id)}" data-seconds="${tm.seconds}" data-default-label="${esc(tm.label)}" data-step-title="${esc(step.title)}">Start ${esc(tm.label)}</button>`;
            })
            .join("")}
        </div>`
      : "";

    const ingDrawerHtml = this.showIngredients
      ? `<aside class="cook-ing-drawer" aria-label="Full ingredient list">
          <h3>Ingredients (${this.getServings()} servings)</h3>
          <ul>
            ${(r.ingredients || [])
              .map((ing) => {
                const amt = convertAmount(ing, scaleRatio, unitSystem);
                return `<li><b>${esc(amt)}</b> ${esc(ing.item)}${ing.note ? ` <span class="sub">${esc(ing.note)}</span>` : ""}</li>`;
              })
              .join("")}
          </ul>
        </aside>`
      : "";

    this.dialog.innerHTML = `
      <div class="cook-frame">
        <header class="cook-top">
          <div class="cook-title-wrap">
            ${
              r.imageUrl
                ? `<img class="cook-thumb" src="${esc(r.imageUrl)}" alt="${esc(r.title)}" fetchpriority="low" width="44" height="44">`
                : ""
            }
            <div class="cook-title-group">
              <span class="cook-kicker">Step ${this.stepIndex + 1} of ${total}</span>
              <h2 id="cook-dialog-title" class="cook-recipe-name">${esc(r.title)}</h2>
            </div>
          </div>
          <div class="cook-actions">
            ${hasVoice ? `<button type="button" class="tbtn" id="cook-voice-btn" title="Hands-free commands: next, back, timer, read, ingredients, ask chef ...">Voice</button>` : ""}
            ${hasSpeech ? `<button type="button" class="tbtn" id="cook-read-btn" title="Shortcut: R">Read</button>` : ""}
            <button type="button" class="tbtn ${this.showIngredients ? "is-active" : ""}" id="cook-ing-btn" title="Shortcut: I">Ingredients</button>
            <button type="button" class="tbtn" id="cook-exit-btn" autofocus>Exit</button>
          </div>
        </header>

        <div class="cook-progress" aria-hidden="true"><div class="cook-progress-fill" style="width:${pct}%"></div></div>

        <div class="cook-body ${this.showIngredients ? "has-drawer" : ""}">
          <div class="cook-stage">
            <div class="cook-step-num">${String(this.stepIndex + 1).padStart(2, "0")}</div>
            <h3 class="cook-step-title">${esc(step.title)}</h3>
            <p class="cook-step-text">${esc(convertStepTemperatures(step.text, unitSystem))}</p>
            ${matchedHtml}
            ${timersHtml}

            <div class="cook-ask-box">
              <div class="cook-quick-chips">
                ${COOK_QUICK_PROMPTS.map((q) => `<button type="button" class="chip cook-q-chip">${esc(q)}</button>`).join("")}
              </div>
              <form class="ask cook-ask-form" id="cook-ask-form">
                <input type="text" id="cook-ask-input" autocomplete="off" placeholder="Ask chef about this step right now…" aria-label="Ask chef about this step">
                <button type="submit" class="go">Ask</button>
              </form>
              <div id="cook-help-out" aria-live="polite"></div>
            </div>
          </div>
          ${ingDrawerHtml}
        </div>

        <footer class="cook-foot">
          <button type="button" class="tbtn" id="cook-prev-btn" ${this.stepIndex === 0 ? "disabled" : ""}>← Previous</button>
          <div class="cook-dots" aria-label="Jump to step">
            ${steps
              .map(
                (s, idx) =>
                  `<button type="button" class="cook-dot ${idx === this.stepIndex ? "is-active" : ""}" data-jump="${idx}" aria-label="Step ${idx + 1}: ${esc(s.title)}">${idx + 1}</button>`
              )
              .join("")}
          </div>
          <button type="button" class="go" id="cook-next-btn">${this.stepIndex === total - 1 ? "Finish" : "Next →"}</button>
        </footer>
      </div>
    `;

    this.dialog.querySelector("#cook-exit-btn").addEventListener("click", () => closeTopLayer(this.dialog));
    this.dialog.querySelector("#cook-prev-btn").addEventListener("click", () => this.prev());
    this.dialog.querySelector("#cook-next-btn").addEventListener("click", () => this.next());
    this.dialog.querySelector("#cook-ing-btn").addEventListener("click", () => {
      this.showIngredients = !this.showIngredients;
      this.render();
    });
    this.dialog.querySelector("#cook-read-btn")?.addEventListener("click", () => this.toggleReadAloud());
    this.dialog.querySelector("#cook-voice-btn")?.addEventListener("click", () => this.toggleVoice());

    this.dialog.querySelectorAll("[data-jump]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.stepIndex = Number(btn.dataset.jump);
        this.helpState = { loading: false, question: "", data: null, error: "" };
        this.stopSpeaking();
        this.render();
      });
    });

    this.dialog.querySelectorAll("[data-cook-timer]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.timerManager.startOrToggle(
          btn.dataset.cookTimer,
          `${btn.dataset.stepTitle} (${btn.dataset.defaultLabel})`,
          Number(btn.dataset.seconds)
        );
      });
    });

    this.dialog.querySelectorAll(".cook-q-chip").forEach((chip) => {
      chip.addEventListener("click", () => this.askChef(chip.textContent));
    });

    this.dialog.querySelector("#cook-ask-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = this.dialog.querySelector("#cook-ask-input");
      if (input.value.trim()) {
        this.askChef(input.value.trim());
        input.value = "";
      }
    });

    this.renderTopControls();
    this.updateTimerBadges();
    this.renderHelpArea();
  }
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  }[c]));
}
