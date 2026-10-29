// Reason Web's one spring (.agents/skills/apple-motion). Anything on Web that moves and can be
// interrupted runs on it: the Settings theme underline and section arrow, the + sheet, the Ongoing
// margin. Fades, colour, pen-in, stamp-in, the loader and skeletons stay on timed curves.
//
// Apple's parameterisation: `response` (seconds, roughly how long it takes) and `dampingRatio` (1 =
// no overshoot, the default). Retargeted mid-flight it turns round from where it is, keeping its speed,
// so a control tapped twice quickly reverses smoothly instead of restarting. Under reduced motion it
// jumps straight to the end. No library: the same function runs in the page as window.reasonSpring
// (SPRING_JS, sent by webkit.js on every Web page) and in the tests here.

/**
 * A value that springs towards its target. `onUpdate(value)` is called each frame (write it to
 * style.transform or a CSS custom property, never by redrawing); `onRest(value)` once it settles or jumps.
 * Options: response (s, 0.35), dampingRatio (1), precision (0.1), onRest.
 */
export function createSpring(initial, onUpdate, opts) {
  var o = opts || {}, response = o.response || 0.35, ratio = o.dampingRatio == null ? 1 : o.dampingRatio, onRest = o.onRest;
  var precision = o.precision || 0.1; // the smallest step anyone could see: 0.1 for px, 0.001 for 0–1
  var stiffness = Math.pow((2 * Math.PI) / response, 2), damping = (4 * Math.PI * ratio) / response;
  var value = initial, velocity = 0, target = initial, frame = 0, last = 0;
  function calm() { return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches; }
  function rest() { value = target; velocity = 0; frame = 0; onUpdate(value); if (onRest) onRest(value); }
  function step(now) {
    var dt = Math.min((now - last) / 1000, 1 / 30); // a stalled tab doesn't fling it
    last = now;
    for (var i = 0; i < 4; i++) { // substeps keep stiff springs stable
      var h = dt / 4;
      velocity += (-stiffness * (value - target) - damping * velocity) * h;
      value += velocity * h;
    }
    if (Math.abs(velocity) < precision * 10 && Math.abs(value - target) < precision) return rest();
    onUpdate(value);
    frame = requestAnimationFrame(step);
  }
  var api = {
    /** Spring to `next`. Pass a gesture's release velocity (units per second) after a drag. */
    to: function (next, releaseVelocity) {
      if (calm()) return api.set(next);
      target = next;
      if (releaseVelocity !== undefined) velocity = releaseVelocity;
      if (!frame) { last = performance.now(); frame = requestAnimationFrame(step); }
    },
    /** Jump with no motion: first paint, a resize, and reduced motion. */
    set: function (next) { if (frame) cancelAnimationFrame(frame); target = next; rest(); },
    stop: function () { if (frame) cancelAnimationFrame(frame); frame = 0; },
    get value() { return value; },
    get target() { return target; },
    get velocity() { return velocity; },
  };
  return api;
}

/** The page's copy, defined once per page before any page script runs. */
export const SPRING_JS = `window.reasonSpring=window.reasonSpring||${createSpring.toString()};`;
