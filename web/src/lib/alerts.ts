import { INCIDENT_LABEL, type Incident } from '@coldguard/shared';

/**
 * Operator attention aids for new incidents: a short tone, a desktop notification
 * (when the tab is in the background) and an unread count in the tab title.
 * Off by default; the preference is per browser. Everything degrades silently when
 * the browser blocks audio, notifications or storage.
 */
const KEY = 'coldguard.alerts';
const BASE_TITLE = typeof document !== 'undefined' ? document.title : 'ColdGuard';

let enabled = false;
try {
  enabled = localStorage.getItem(KEY) === 'on';
} catch {
  /* storage unavailable */
}
let ctx: AudioContext | null = null;
let lastToneAt = 0;

export const alertPrefs = {
  get enabled() {
    return enabled;
  },
  /** Call from a click handler: browsers only allow audio and permission prompts after a user gesture. */
  async set(on: boolean) {
    enabled = on;
    try {
      localStorage.setItem(KEY, on ? 'on' : 'off');
    } catch {
      /* ignore */
    }
    if (!on) return;
    try {
      ctx ??= new AudioContext();
      await ctx.resume();
    } catch {
      /* no audio */
    }
    try {
      if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    } catch {
      /* no notifications */
    }
    tone(false); // confirmation blip so the operator knows what it sounds like
  },
};

function tone(critical: boolean) {
  const now = Date.now();
  if (now - lastToneAt < 1500) return; // a burst of incidents is one sound, not a siren
  lastToneAt = now;
  try {
    ctx ??= new AudioContext();
    const t0 = ctx.currentTime;
    const beeps = critical ? [0, 0.22, 0.44] : [0];
    for (const off of beeps) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = critical ? 880 : 587;
      gain.gain.setValueAtTime(0.0001, t0 + off);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + off + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + off);
      osc.stop(t0 + off + 0.18);
    }
  } catch {
    /* audio blocked */
  }
}

/** Called once for each newly opened incident pushed over Socket.IO. */
export function announceIncident(i: Incident) {
  if (!enabled) return;
  tone(i.severity === 'critical');
  try {
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(`${INCIDENT_LABEL[i.type]} · ${i.deviceId}`, { body: i.explanation.slice(0, 180), tag: i.id });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    }
  } catch {
    /* notifications blocked */
  }
}

/** Unacknowledged-incident count in the tab title, so a background tab still signals. */
export function setTitleBadge(unacked: number) {
  document.title = unacked > 0 ? `(${unacked}) ${BASE_TITLE}` : BASE_TITLE;
}
