/**
 * Hazard alarm on the Web Audio API. Browsers keep an AudioContext suspended
 * until a user gesture, so `arm` must run from the click that starts monitoring,
 * or the first alarm would be silent.
 */
export class Alarm {
  private context: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  arm(): void {
    this.context ??= new AudioContext();
    void this.context.resume();
  }

  get ready(): boolean {
    return this.context?.state === "running";
  }

  start(): void {
    if (this.timer || !this.context) return;
    this.beep();
    this.timer = setInterval(() => this.beep(), 700);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private beep(): void {
    const context = this.context;
    if (!context) return;
    const now = context.currentTime;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.5, now + 0.01);
    gain.gain.setValueAtTime(0.5, now + 0.42);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.48);
    gain.connect(context.destination);
    for (const [frequency, start] of [[1040, 0], [780, 0.24]] as const) {
      const oscillator = context.createOscillator();
      oscillator.type = "square";
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start(now + start);
      oscillator.stop(now + start + 0.22);
    }
  }
}
