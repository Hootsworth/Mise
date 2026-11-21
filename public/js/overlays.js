let supportsDisplayTransition;

function canTransitionDisplay() {
  if (supportsDisplayTransition !== undefined) return supportsDisplayTransition;
  if (!window.CSS?.supports?.("transition-behavior", "allow-discrete") || !document.body) {
    return false;
  }
  const probe = document.createElement("div");
  probe.style.cssText = "transition: display 1s allow-discrete !important; display: block;";
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = "none";
  supportsDisplayTransition = getComputedStyle(probe).display === "block";
  probe.remove();
  return supportsDisplayTransition;
}

export function supportsTopLayerExit() {
  return Boolean(window.CSS?.supports?.("overlay", "auto") && canTransitionDisplay());
}

/**
 * Smoothly exits top-layer <dialog> or [popover] elements, falling back to
 * data-closing + getAnimations() when overlay/discrete display transitions are missing.
 */
export async function closeTopLayer(element, returnValue) {
  if (!element) return;
  const isDialog = element instanceof HTMLDialogElement;
  if (isDialog && !element.open) return;

  if (!supportsTopLayerExit()) {
    if (!element.hasAttribute("data-closing")) {
      element.setAttribute("data-closing", "");
      const animations = element.getAnimations({ subtree: true });
      if (animations.length > 0) {
        await Promise.race([
          Promise.allSettled(animations.map((a) => a.finished)),
          new Promise((r) => setTimeout(r, 1500))
        ]);
      }
      if (!element.hasAttribute("data-closing")) return;
      element.removeAttribute("data-closing");
    }
  }

  if (isDialog) {
    if (element.open) element.close(returnValue);
  } else if (typeof element.hidePopover === "function") {
    try {
      element.hidePopover();
    } catch {
      // Already hidden
    }
  }
}

/**
 * Wires light-dismiss fallback, close returnValue cleanup, and animated Esc dismissal.
 */
export function setupModalDialog(dialog, { onClose } = {}) {
  if (!dialog) return;

  if (dialog.getAttribute("closedby") === "any" && !("closedBy" in HTMLDialogElement.prototype)) {
    const outside = (e) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let pressedOutside = false;
    dialog.addEventListener("pointerdown", (e) => {
      pressedOutside = outside(e);
    });
    dialog.addEventListener("pointerup", (e) => {
      if (pressedOutside && outside(e)) {
        closeTopLayer(dialog);
      }
    });
  }

  dialog.addEventListener("cancel", (event) => {
    if (!supportsTopLayerExit() && event.cancelable) {
      event.preventDefault();
      closeTopLayer(dialog);
    }
  });

  dialog.addEventListener("close", () => {
    dialog.removeAttribute("data-closing");
    const rv = dialog.returnValue;
    dialog.returnValue = "";
    if (onClose) onClose(rv);
  });
}

let activeAnchorTrigger = null;

/**
 * Tethers a native [popover="auto"] element to a trigger button using CSS Anchor Positioning
 * (when supported) with safe cleanup across repeated openings.
 */
export function openAnchoredPopover(popoverEl, triggerEl) {
  if (!popoverEl || !triggerEl) return;
  if (activeAnchorTrigger && activeAnchorTrigger !== triggerEl) {
    activeAnchorTrigger.style.removeProperty("anchor-name");
  }
  activeAnchorTrigger = triggerEl;
  triggerEl.style.setProperty("anchor-name", "--mise-anchor");

  if (popoverEl.matches(":popover-open")) {
    popoverEl.hidePopover();
  }
  popoverEl.showPopover({ source: triggerEl });
}

/**
 * Two-state theme toggle controller synchronized with <meta name="color-scheme">.
 * Divergence is checked strictly at storage time, never retroactively on system changes.
 */
export function initThemeToggle(buttonEl) {
  const meta = document.querySelector('meta[name="color-scheme"]');
  const mql = window.matchMedia("(prefers-color-scheme: dark)");

  const getStored = () => {
    try {
      const v = localStorage.getItem("color-scheme");
      return v === "light" || v === "dark" ? v : null;
    } catch {
      return null;
    }
  };

  const getRendered = () => getStored() || (mql.matches ? "dark" : "light");

  const syncMeta = () => {
    const stored = getStored();
    if (meta) meta.content = stored || "light dark";
    if (buttonEl) {
      const next = getRendered() === "dark" ? "light" : "dark";
      buttonEl.setAttribute("aria-label", `Switch to ${next} theme`);
    }
  };

  if (buttonEl) {
    buttonEl.addEventListener("click", () => {
      const system = mql.matches ? "dark" : "light";
      const target = getRendered() === "dark" ? "light" : "dark";
      try {
        if (target !== system) {
          localStorage.setItem("color-scheme", target);
        } else {
          localStorage.removeItem("color-scheme");
        }
      } catch {
        if (meta) meta.content = target;
      }
      syncMeta();
    });
  }

  window.addEventListener("storage", (e) => {
    if (e.key === "color-scheme") syncMeta();
  });

  syncMeta();
}
