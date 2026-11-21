const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  }[c]));

export const COOKING_PHASES = [
  "Warming the pan…",
  "Balancing salt & acid…",
  "Testing proportions…",
  "Plating your recipe…"
];

export function renderPotSvg(className = "cook-pot-svg") {
  return `
    <svg class="${esc(className)}" viewBox="0 0 64 56" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path class="pot-steam pot-steam-1" d="M23 14c-1.8-2.2 1.8-4.2 0-6.5" />
      <path class="pot-steam pot-steam-2" d="M32 13c-1.8-2.4 1.8-4.6 0-7.2" />
      <path class="pot-steam pot-steam-3" d="M41 14c-1.8-2.2 1.8-4.2 0-6.5" />
      <g class="pot-lid">
        <path d="M29.5 18.5a2.5 2.5 0 0 1 5 0" />
        <path d="M16 23c2-3.4 8-5 16-5s14 1.6 16 5" />
        <line x1="14" y1="23.5" x2="50" y2="23.5" />
      </g>
      <g class="pot-body">
        <path d="M10.5 27.5h4.5m34 0h4.5" />
        <path d="M10.5 27.5c-1.8 0-1.8 3.5 0 3.5H15M53.5 27.5c1.8 0 1.8 3.5 0 3.5H49" />
        <path d="M15 26.5h34v10.5c0 5-3.8 8.5-9.5 8.5h-15C18.8 45.5 15 42 15 37V26.5z" />
      </g>
      <path class="pot-heat" d="M21 50.5h22" />
    </svg>
  `;
}

/**
 * Renders a calming monochrome culinary Dutch-oven loading indicator.
 */
export function renderCookingLoader({
  label = "Simmering your recipe…",
  detail = "",
  compact = false
} = {}) {
  if (compact) {
    return `
      <span class="cook-loader is-compact" role="status" aria-live="polite">
        ${renderPotSvg("cook-pot-svg is-sm")}
        <span class="cook-loader-label">${esc(label)}</span>
      </span>
    `;
  }

  return `
    <div class="cook-loader-card" role="status" aria-live="polite">
      <div class="cook-loader-emblem">${renderPotSvg("cook-pot-svg")}</div>
      <div class="cook-loader-title">${esc(label)}</div>
      ${detail ? `<p class="cook-loader-detail">${esc(detail)}</p>` : ""}
    </div>
  `;
}
