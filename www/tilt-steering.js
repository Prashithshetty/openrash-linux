// Optional phone tilt input. Orientation data supplies gravity without integrating
// acceleration (which would drift). Permission is requested only by enable(), on a tap.
const RANGES = { gentle: 28, normal: 22, quick: 16 };

function screenAngle() {
  const angle = Number(screen.orientation?.angle ?? window.orientation ?? 0);
  return Number.isFinite(angle) ? angle : 0;
}

function lateralAngle(beta, gamma, angle) {
  const rad = Math.PI / 180, b = beta * rad, g = gamma * rad, a = angle * rad;
  // Project gravity onto the screen's right edge. Using gamma alone jumps near
  // vertical and reverses steering when the phone rotates into landscape.
  const right = Math.cos(b) * Math.sin(g) * Math.cos(a) + Math.sin(b) * Math.sin(a);
  return Math.asin(Math.max(-1, Math.min(1, right))) / rad;
}

export class TiltSteering {
  constructor(onChange = () => {}) {
    this.onChange = onChange;
    this.enabled = false;
    this.waiting = false;
    this.message = "Hold DRIVE to accelerate. Choose Tilt to steer by moving your phone.";
    this.centre = null;
    this.last = null;
    this.lastAt = -Infinity;
    this.angle = null;
    this.generation = 0;
    this.destroyed = false;
    this.sensitivity = "normal";
    try { const saved = localStorage.getItem("rr-tilt-sensitivity"); if (RANGES[saved]) this.sensitivity = saved; } catch {}
    this.handle = e => {
      if (!Number.isFinite(e.beta) || !Number.isFinite(e.gamma)) return;
      const angle = screenAngle();
      if (angle !== this.angle) { this.angle = angle; this.centre = null; }
      this.last = lateralAngle(e.beta, e.gamma, angle);
      this.lastAt = performance.now();
      if (this.centre === null) {
        this.centre = this.last;
        this.enabled = true;
        this.waiting = false;
        clearTimeout(this.timer);
        this.message = "Tilt is on. Hold DRIVE and tilt left or right. Set centre again if you change your grip.";
        this.onChange();
      }
    };
    this.rotate = () => this.recentreNext();
  }

  detach() {
    clearTimeout(this.timer);
    removeEventListener("deviceorientation", this.handle);
    removeEventListener("orientationchange", this.rotate);
    screen.orientation?.removeEventListener("change", this.rotate);
  }

  disable(message = "Thumb steering is on. Hold DRIVE and drag left or right.") {
    this.generation++;
    this.detach();
    this.enabled = this.waiting = false;
    this.last = this.centre = this.angle = null;
    this.lastAt = -Infinity;
    this.message = message;
    this.onChange();
  }

  async enable() {
    if (this.destroyed || this.waiting || this.enabled) return;
    if (!window.isSecureContext || typeof DeviceOrientationEvent === "undefined") {
      this.disable("Tilt is unavailable here. Use thumb steering, or open the game in your phone's browser over HTTPS.");
      return;
    }
    const generation = ++this.generation;
    this.waiting = true;
    this.message = "Hold your phone comfortably. Allow motion access if asked.";
    this.onChange();
    try {
      // Keep this request in the user's click handler: permission prompts require a gesture.
      if (typeof DeviceOrientationEvent.requestPermission === "function") {
        const result = await DeviceOrientationEvent.requestPermission();
        if (generation !== this.generation || this.destroyed) return;
        if (result !== "granted") { this.disable("Motion access was not allowed. Thumb steering is still on."); return; }
      }
      if (generation !== this.generation || this.destroyed) return;
      this.centre = this.last = this.angle = null;
      this.lastAt = -Infinity;
      addEventListener("deviceorientation", this.handle);
      addEventListener("orientationchange", this.rotate);
      screen.orientation?.addEventListener("change", this.rotate);
      this.message = "Hold your phone comfortably while tilt steering finds the centre…";
      this.onChange();
      this.timer = setTimeout(() => {
        if (generation === this.generation && !this.enabled) this.disable("No motion readings arrived. Thumb steering is still on.");
      }, 3000);
    } catch {
      if (generation === this.generation) this.disable("Motion access is unavailable. Thumb steering is still on.");
    }
  }

  value() {
    if (!this.enabled || this.centre === null) return 0;
    if (performance.now() - this.lastAt > 750) { this.disable("Motion readings stopped. Thumb steering is still available."); return 0; }
    const delta = this.last - this.centre;
    const amount = Math.max(0, Math.min(1, (Math.abs(delta) - .8) / (RANGES[this.sensitivity] - .8)));
    // Direct response with a gentle centre; no delayed smoothing or accumulated drift.
    return Math.sign(delta) * Math.pow(amount, 1.5);
  }

  calibrate() {
    if (!this.enabled || performance.now() - this.lastAt > 750) { this.recentreNext(); return; }
    this.centre = this.last;
    this.message = "Centre set. Hold DRIVE and tilt left or right to steer.";
    this.onChange();
  }

  recentreNext() {
    if (!this.enabled) return;
    this.centre = null;
    this.lastAt = -Infinity;
    this.message = "Hold your phone comfortably; the next motion reading will set the centre.";
    this.onChange();
  }

  setSensitivity(value) {
    if (!RANGES[value]) return;
    this.sensitivity = value;
    try { localStorage.setItem("rr-tilt-sensitivity", value); } catch {}
  }

  dispose() {
    this.destroyed = true;
    this.generation++;
    this.detach();
    this.enabled = this.waiting = false;
    this.onChange = () => {};
  }
}
