/**
 * Multi-timer engine with Web Audio harmonic chime and synced listener notifications.
 */
export function formatClock(totalSeconds) {
  const sec = Math.max(0, Math.round(totalSeconds));
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const rem = sec % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

export function playTimerChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const notes = [523.25, 659.25, 783.99];
    const now = ctx.currentTime;
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + idx * 0.16);
      gain.gain.setValueAtTime(0.001, now + idx * 0.16);
      gain.gain.exponentialRampToValueAtTime(0.14, now + idx * 0.16 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.16 + 0.75);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.16);
      osc.stop(now + idx * 0.16 + 0.8);
    });
    setTimeout(() => ctx.close().catch(() => {}), 1500);
  } catch {
    // Audio playback blocked or unavailable
  }
}

export class TimerManager {
  constructor() {
    this.timers = new Map();
    this.listeners = new Set();
    this.intervalId = null;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  emit() {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }

  snapshot() {
    return Array.from(this.timers.values()).map((t) => ({ ...t }));
  }

  get(id) {
    const t = this.timers.get(id);
    return t ? { ...t } : null;
  }

  startOrToggle(id, label, totalSec) {
    const existing = this.timers.get(id);
    if (!existing) {
      this.timers.set(id, {
        id,
        label,
        totalSec,
        remainingSec: totalSec,
        running: true,
        done: false
      });
      this.ensureTicking();
      this.emit();
      return;
    }

    if (existing.done) {
      existing.remainingSec = existing.totalSec;
      existing.done = false;
      existing.running = true;
      this.ensureTicking();
      this.emit();
      return;
    }

    existing.running = !existing.running;
    this.syncInterval();
    this.emit();
  }

  reset(id) {
    const existing = this.timers.get(id);
    if (!existing) return;
    existing.remainingSec = existing.totalSec;
    existing.running = false;
    existing.done = false;
    this.syncInterval();
    this.emit();
  }

  remove(id) {
    this.timers.delete(id);
    this.syncInterval();
    this.emit();
  }

  clearAll() {
    this.timers.clear();
    this.syncInterval();
    this.emit();
  }

  ensureTicking() {
    if (this.intervalId != null) return;
    this.intervalId = setInterval(() => this.tick(), 1000);
  }

  syncInterval() {
    const anyRunning = Array.from(this.timers.values()).some((t) => t.running);
    if (anyRunning) {
      this.ensureTicking();
    } else if (this.intervalId != null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  tick() {
    let anyChanged = false;
    let chimeNeeded = false;
    for (const t of this.timers.values()) {
      if (!t.running) continue;
      anyChanged = true;
      t.remainingSec = Math.max(0, t.remainingSec - 1);
      if (t.remainingSec === 0) {
        t.running = false;
        t.done = true;
        chimeNeeded = true;
      }
    }
    if (chimeNeeded) playTimerChime();
    this.syncInterval();
    if (anyChanged) this.emit();
  }
}
