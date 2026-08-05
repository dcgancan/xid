export type Vec2 = { x: number; y: number };

/**
 * - `unsupported` — no motion sensor, or the browser never emitted a reading.
 * - `prompt`      — iOS 13+: sensor exists but needs `requestPermission()` from a tap.
 * - `granted`     — readings are flowing.
 * - `denied`      — the user said no, or the page is not a secure context.
 */
export type MotionState = "unsupported" | "prompt" | "granted" | "denied";

export type TiltController = {
  readonly motion: MotionState;
  /** Must be called from inside a user gesture; a no-op unless `motion === "prompt"`. */
  requestMotion(): Promise<MotionState>;
  /** Re-zeroes gyroscope readings against the phone's current resting angle. */
  recenter(): void;
  destroy(): void;
};

/** Degrees of physical tilt that map to the full -1..1 range. */
const RANGE_DEG = 26;
/**
 * Time constant of the approach toward the target, in seconds: after TAU the
 * card has covered 63% of the remaining distance, and settles at ~3x that.
 *
 * Seconds, deliberately, not a per-frame fraction. The previous form eased by a
 * fixed 14% PER ANIMATION FRAME, which ties the gesture's feel to how fast the
 * browser can paint the card. Measured in WebKit on the same drag: 58.8fps
 * settled in 353ms, 32.3fps in 683ms, 14.1fps in 1565ms -- the same hand
 * movement, a 4.4x spread. Safari composites this card in software (see the
 * blend-mode notes in styles.css) and drops frames, so it landed at the slow
 * end: the card trailed so far behind the cursor that it read as following its
 * own mind rather than the pointer. 0.119s is what 14%/frame gave at 60Hz, so
 * a browser that was already fast feels exactly as it did before.
 */
const TAU = 0.119;
/** Pointer travel, as a fraction of the surface's half-diagonal, for full deflection. */
const DRAG_SPAN = 0.55;

/**
 * Sensors belong to phones. Only touch-primary devices may listen to
 * `deviceorientation` -- Safari 16.4+ on macOS fires it from the laptop's
 * accelerometer, and letting it write `target` while the mouse drags the same
 * target produces exactly the reversed, erratic controller Doğancan saw.
 * Deliberately NOT `maxTouchPoints > 0`: some MacBooks report 5 (the trackpad)
 * and would reopen the leak.
 */
const hasOrientationSensor = window.matchMedia("(pointer: coarse)").matches;

type PermissionCapableDOE = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

/**
 * A single tilt signal fed by two very different inputs: press-and-drag on
 * desktop, device orientation on phones. Consumers never learn which one is
 * driving -- they get a smoothed `{x, y}` in -1..1 plus an `engaged` flag.
 *
 * `onChange` fires once per animation frame while the value is still moving,
 * then stops until the next input. It does not spin when idle.
 */
export function createTilt(
  surface: HTMLElement,
  onChange: (tilt: Vec2, engaged: boolean) => void,
): TiltController {
  const target: Vec2 = { x: 0, y: 0 };
  const current: Vec2 = { x: 0, y: 0 };

  let engaged = false;
  let frame = 0;
  let motion: MotionState = "unsupported";
  let baseline: { beta: number; gamma: number } | null = null;
  let destroyed = false;
  /** Timestamp of the previous frame; null whenever the loop is asleep. */
  let last: number | null = null;

  const tick = (now: number) => {
    frame = 0;
    // Clamped, because the gap across a stall -- a tab in the background, a long
    // paint, a jankier machine -- would otherwise snap the card straight to the
    // target and lose the whole point of the filter. 100ms is 1.4 time constants.
    // `schedule` seeds `last` from the input that woke the loop, so a tick always
    // has a previous timestamp to measure against.
    const prev = last ?? now;
    last = now;
    const dt = Math.min(0.1, (now - prev) / 1000);
    // The discrete form of an exponential approach: exact for any dt, so the card
    // covers the same ground in the same wall-clock time at 15fps as at 120.
    const step = 1 - Math.exp(-dt / TAU);
    current.x += (target.x - current.x) * step;
    current.y += (target.y - current.y) * step;

    const settled = Math.abs(target.x - current.x) < 0.0008 && Math.abs(target.y - current.y) < 0.0008;
    if (settled) {
      current.x = target.x;
      current.y = target.y;
      last = null;
    }

    onChange(current, engaged);
    if (!settled && !destroyed) frame = requestAnimationFrame(tick);
  };

  const schedule = () => {
    if (frame || destroyed) return;
    // Start the clock at the INPUT, not at the frame that serves it. rAF shares
    // performance.now()'s time origin, so the first tick then measures the real
    // gap it waited instead of assuming a 60Hz one -- which is precisely the gap
    // that is long on the browsers this exists for.
    if (last === null) last = performance.now();
    frame = requestAnimationFrame(tick);
  };

  const clamp = (n: number) => (n < -1 ? -1 : n > 1 ? 1 : n);

  // --- pointer: press and drag -------------------------------------------

  let origin: Vec2 | null = null;
  let span = 1;
  let activePointer: number | null = null;

  const endDrag = () => {
    if (!origin) return;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("blur", endDrag);
    origin = null;
    activePointer = null;
    engaged = false;
    target.x = 0;
    target.y = 0;
    surface.classList.remove("is-grabbed");
    schedule();
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    // While the gyroscope is live, dragging would fight the sensor.
    if (motion === "granted") return;

    // `.card` itself is never transformed -- only `.card__plate` inside it is --
    // so this rect does not shrink as the card turns and the drag keeps one
    // constant sensitivity from the first pixel to the last.
    const rect = surface.getBoundingClientRect();
    span = Math.max(1, Math.hypot(rect.width, rect.height) * 0.5 * DRAG_SPAN);
    origin = { x: event.clientX, y: event.clientY };
    activePointer = event.pointerId;
    engaged = true;
    surface.classList.add("is-grabbed");
    try {
      surface.setPointerCapture(event.pointerId);
    } catch {
      // Safari can refuse capture; the window-level move/up listeners below
      // keep the drag alive regardless.
    }
    // Move/up on WINDOW, not the surface: Safari has a habit of losing pointer
    // capture mid-drag (spurious pointerup/cancel when the element is under a
    // changing transform), which used to zero the origin and make the card
    // spring back and forth erratically. Window listeners survive any capture
    // hiccup, and the gesture dies only when the button is really released.
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    // Cmd+Tab mid-drag delivers no pointerup at all. Without this the press
    // stayed latched and the card tracked an unpressed cursor on return.
    window.addEventListener("blur", endDrag);
    schedule();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!origin || event.pointerId !== activePointer) return;
    // Self-heal a release we never heard about. When `setPointerCapture` is
    // refused (Safari does refuse it) and the button comes up outside the window,
    // no pointerup is delivered anywhere -- the gesture stayed live and the card
    // kept following a cursor that was no longer pressed. `buttons` is
    // authoritative: 0 means nothing is held down right now.
    if (event.pointerType === "mouse" && event.buttons === 0) {
      endDrag();
      return;
    }
    event.preventDefault();
    target.x = clamp((event.clientX - origin.x) / span);
    target.y = clamp((event.clientY - origin.y) / span);
    schedule();
  };

  const onPointerUp = (event: PointerEvent) => {
    if (event.pointerId !== activePointer) return;
    endDrag();
  };

  /**
   * A canceled pointer is only authoritative for touch and pen, where the OS
   * genuinely took the gesture over (a scroll, a system edge swipe).
   *
   * For a MOUSE it is not. WebKit cancels the pointer the instant a native drag
   * begins, and until `onDragStart` below the card's portrait -- an `<img>`, and
   * images are draggable by default -- started one on every press that landed on
   * the face. The cancel then ran the full teardown: the card snapped back to
   * centre and ignored the rest of the gesture, while a press on the plate a few
   * pixels away worked normally. That is the erratic desktop controller, and it
   * was erratic because the outcome depended on where the press landed.
   *
   * The native drag is prevented at the source now, so a mouse cancel is
   * spurious by construction and the press stays live. `buttons === 0` in
   * onPointerMove and the real pointerup remain the only ways a drag ends.
   */
  const onPointerCancel = (event: PointerEvent) => {
    if (event.pointerId !== activePointer) return;
    if (event.pointerType === "mouse") return;
    endDrag();
  };

  /**
   * Nothing inside the card is meant to be dragged out of it. Both portraits are
   * `<img>` elements, which carry `draggable` by default, so without this the
   * browser answers a press-and-move over the face with a native image drag
   * instead of a tilt -- taking the pointer with it (see onPointerCancel).
   */
  const onDragStart = (event: Event) => event.preventDefault();

  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 0.4 : 0.18;
    const delta: Record<string, Vec2> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const move = delta[event.key];
    if (!move) {
      if (event.key === "Escape") {
        target.x = 0;
        target.y = 0;
        engaged = false;
        schedule();
      }
      return;
    }
    event.preventDefault();
    target.x = clamp(target.x + move.x);
    target.y = clamp(target.y + move.y);
    engaged = true;
    schedule();
  };

  // --- device orientation -------------------------------------------------

  const onOrientation = (event: DeviceOrientationEvent) => {
    const { beta, gamma } = event;
    if (beta === null || gamma === null) return;

    if (!baseline) {
      baseline = { beta, gamma };
      motion = "granted";
      engaged = true;
      surface.classList.add("is-motion");
    }

    // beta wraps at ±180; keep the delta on the short arc.
    let dy = beta - baseline.beta;
    if (dy > 180) dy -= 360;
    else if (dy < -180) dy += 360;
    let dx = gamma - baseline.gamma;

    // Sensor axes are device-fixed; rotate them into screen space.
    const angle = screen.orientation?.angle ?? 0;
    if (angle === 90) [dx, dy] = [dy, -dx];
    else if (angle === 180) [dx, dy] = [-dx, -dy];
    else if (angle === 270) [dx, dy] = [-dy, dx];

    target.x = clamp(dx / RANGE_DEG);
    target.y = clamp(dy / RANGE_DEG);
    schedule();
  };

  const DOE = typeof DeviceOrientationEvent === "undefined"
    ? null
    : (DeviceOrientationEvent as PermissionCapableDOE);

  if (DOE) {
    if (typeof DOE.requestPermission === "function") {
      motion = "prompt";
    } else if (hasOrientationSensor) {
      // Desktop browsers define the event but never fire it -- except Safari
      // 16.4+ on macOS, which DOES fire it from the laptop's accelerometer.
      // Without the touch gate below, the first reading would promote the
      // card to `granted`, silently disable the drag, and steer the card by
      // the laptop's screen angle -- which reads exactly like a reversed,
      // erratic controller. Sensors only drive the card on phones.
      window.addEventListener("deviceorientation", onOrientation);
    }
  }

  // Only pointerdown, dragstart and keydown live on the surface. The move/up
  // pair is deliberately window-only: a duplicate set here meant every drag
  // event ran the handler twice, and the surface's own `pointercancel` was a
  // second, unguarded route into the teardown that mouse drags must not take.
  surface.addEventListener("pointerdown", onPointerDown);
  surface.addEventListener("dragstart", onDragStart);
  surface.addEventListener("keydown", onKeyDown);

  return {
    get motion() {
      return motion;
    },

    async requestMotion() {
      if (motion !== "prompt" || !DOE?.requestPermission) return motion;
      try {
        const verdict = await DOE.requestPermission();
        if (verdict !== "granted") {
          motion = "denied";
          return motion;
        }
        // Stays `prompt` until the first reading lands, which flips it to `granted`.
        window.addEventListener("deviceorientation", onOrientation);
        return motion;
      } catch {
        // Thrown when not called from a user gesture, or on an insecure origin.
        motion = "denied";
        return motion;
      }
    },

    recenter() {
      baseline = null;
      target.x = 0;
      target.y = 0;
      schedule();
    },

    destroy() {
      destroyed = true;
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("deviceorientation", onOrientation);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("blur", endDrag);
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("dragstart", onDragStart);
      surface.removeEventListener("keydown", onKeyDown);
    },
  };
}
