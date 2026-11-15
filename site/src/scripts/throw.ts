import { gsap } from 'gsap'
import { CustomEase } from 'gsap/CustomEase'

gsap.registerPlugin(CustomEase)

/** Motion tokens (icons8 motion skill): entering or exiting, and moving on screen. */
export const EASE_OUT = CustomEase.create('loombox-out', '0.23,1,0.32,1')
export const EASE_IN_OUT = CustomEase.create('loombox-in-out', '0.77,0,0.175,1')

type Point = { x: number; y: number }

/** The Close button's diameter; the drop is drawn at this size and scaled. */
const DROP = 32
/** The motion skill's spring: bounce 0.2. */
const ZETA = 0.8
/** The drop's own give: a stiffer spring (bounce 0.3) driven by acceleration. */
const JELLY = { omega: 26, zeta: 0.7, gain: 0.16 }
/** How far speed stretches the drop and how far the wind-up compresses it. */
const STRETCH = 0.3
const WIND_UP = { distance: 6, squash: 0.9, seconds: 0.08 }
/** Time the shape takes to relax once the drop has arrived. */
const SETTLE = 0.25

/** The decorative copy that flies; the real controls stay put and swap in at each end. */
export type Flight = { layer: HTMLElement; drop: HTMLElement; body: HTMLElement; mark: HTMLElement }

export function createFlight(): Flight {
  const layer = document.createElement('div')
  layer.className = 'flight'
  layer.setAttribute('aria-hidden', 'true')
  layer.innerHTML =
    '<div class="flight-drop"><div class="flight-body"></div></div>' +
    '<div class="flight-mark"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" /></svg></div>'
  document.body.append(layer)
  const flight = {
    layer,
    drop: layer.querySelector<HTMLElement>('.flight-drop')!,
    body: layer.querySelector<HTMLElement>('.flight-body')!,
    mark: layer.querySelector<HTMLElement>('.flight-mark')!
  }
  gsap.set([flight.drop, flight.mark], { xPercent: -50, yPercent: -50, autoAlpha: 0 })
  return flight
}

export const centre = (r: DOMRect): Point => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })

/** A replica of the button at `rect`, for the rectangle-to-circle change at either end. */
function skinOf(button: HTMLElement, rect: DOMRect, flight: Flight): HTMLElement {
  const skin = button.cloneNode(true) as HTMLElement
  skin.removeAttribute('href')
  skin.classList.add('flight-skin')
  Object.assign(skin.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`
  })
  flight.layer.append(skin)
  return skin
}

const squareClip = 'inset(0px 0px round 0px)'
/** The button's own height as a circle, centred in it. */
const circleClip = (rect: DOMRect) => `inset(0px ${(rect.width - rect.height) / 2}px round ${rect.height / 2}px)`

/** The control point that bows the path from `from` to `to` upward by 30% of its length. */
function bow(from: Point, to: Point): Point {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  const up = dx / length > 0 ? { x: dy / length, y: -dx / length } : { x: -dy / length, y: dx / length }
  return { x: from.x + dx / 2 + up.x * length * 0.3, y: from.y + dy / 2 + up.y * length * 0.3 }
}

/**
 * Throws the drop from `from` toward `to` on an arc bowed upward, like a toss. `to` is read
 * every frame, so a target that is still moving (the growing window's corner) is met where it
 * is, not where it will be. Progress along the arc follows a damped spring: it leaves from
 * rest, overshoots a little and settles. Speed stretches the drop along its path and sharpens a
 * trailing tail; acceleration drives a second, stiffer spring, so the drop stretches on release
 * and squashes as it brakes. Both shape changes lag the motion, so the tail catches up last.
 */
function toss(flight: Flight, from: Point, to: () => Point, sizes: [number, number], seconds: number): gsap.core.Timeline {
  const { drop, body } = flight
  // Anticipation: back away from the launch direction before leaving.
  const aim = bow(from, to())
  const reach = Math.hypot(aim.x - from.x, aim.y - from.y)
  const wound = {
    x: from.x - ((aim.x - from.x) / reach) * WIND_UP.distance,
    y: from.y - ((aim.y - from.y) / reach) * WIND_UP.distance
  }
  const curve = (target: Point) => {
    const control = bow(from, target)
    return {
      point: (t: number): Point => ({
        x: (1 - t) ** 2 * wound.x + 2 * (1 - t) * t * control.x + t ** 2 * target.x,
        y: (1 - t) ** 2 * wound.y + 2 * (1 - t) * t * control.y + t ** 2 * target.y
      }),
      heading: (t: number) =>
        (Math.atan2(
          2 * (1 - t) * (control.y - wound.y) + 2 * t * (target.y - control.y),
          2 * (1 - t) * (control.x - wound.x) + 2 * t * (target.x - control.x)
        ) *
          180) /
        Math.PI
    }
  }

  // Step response of the spring and its derivatives; it has decayed to 0.2% by `seconds`.
  const omega = 6.2 / (ZETA * seconds)
  const damped = omega * Math.sqrt(1 - ZETA ** 2)
  const decay = (t: number) => Math.exp(-ZETA * omega * t)
  const raw = (t: number) => 1 - decay(t) * (Math.cos(damped * t) + ((ZETA * omega) / damped) * Math.sin(damped * t))
  const speed = (t: number) => (omega ** 2 / damped) * decay(t) * Math.sin(damped * t)
  const accel = (t: number) =>
    (omega ** 2 / damped) * decay(t) * (damped * Math.cos(damped * t) - ZETA * omega * Math.sin(damped * t))
  const samples = Array.from({ length: 400 }, (_, i) => (i / 399) * seconds)
  const peakSpeed = Math.max(...samples.map(speed))
  const peakAccel = Math.max(...samples.map((t) => Math.abs(accel(t))))
  const end = raw(seconds)

  const size = (p: number) => (sizes[0] + (sizes[1] - sizes[0]) * Math.min(p, 1)) / DROP
  const shape = { stretch: WIND_UP.squash, tail: 0, give: 0, giveRate: 0 }
  let clock = 0
  const render = (t: number) => {
    // Shape physics in 1 ms steps of animation time, so slowed replays match real speed.
    for (; clock < t; clock += 0.001) {
      const moving = clock < seconds
      const v = moving ? speed(clock) / peakSpeed : 0
      const a = moving ? accel(clock) / peakAccel : 0
      shape.stretch += (1 + STRETCH * v - shape.stretch) * (1 - Math.exp(-0.001 / 0.04))
      shape.tail += (v - shape.tail) * (1 - Math.exp(-0.001 / 0.07))
      const pull = JELLY.gain * JELLY.omega ** 2 * a - JELLY.omega ** 2 * shape.give - 2 * JELLY.zeta * JELLY.omega * shape.giveRate
      shape.giveRate += pull * 0.001
      shape.give += shape.giveRate * 0.001
    }
    const p = Math.min(t, seconds) === seconds ? 1 : raw(t) / end
    const { point, heading } = curve(to())
    const at = point(p)
    const stretch = Math.max(shape.stretch + shape.give, 0.8)
    gsap.set(drop, {
      x: at.x,
      y: at.y,
      rotation: heading(Math.min(Math.max(p, 0), 1)),
      scaleX: size(p) * stretch,
      scaleY: size(p) / stretch
    })
    gsap.set(body, { borderBottomLeftRadius: `${50 - 40 * Math.min(shape.tail, 1)}%` })
  }

  const start = size(0)
  const time = { t: 0 }
  return gsap
    .timeline()
    .set(drop, { x: from.x, y: from.y, rotation: curve(to()).heading(0), scaleX: start, scaleY: start, autoAlpha: 1 })
    .to(drop, {
      x: wound.x,
      y: wound.y,
      scaleX: start * WIND_UP.squash,
      scaleY: start / WIND_UP.squash,
      duration: WIND_UP.seconds,
      ease: EASE_IN_OUT
    })
    .to(time, { t: seconds + SETTLE, duration: seconds + SETTLE, ease: 'none', onUpdate: () => render(time.t) })
}

/**
 * Download becomes Close: a press, the rectangle closes into a circle, then a toss that meets
 * the window's corner as it grows, landing at 1.12 s as it stops. The × comes in after.
 */
export function launch(flight: Flight, button: HTMLElement, landing: () => Point): gsap.core.Timeline {
  const rect = button.getBoundingClientRect()
  const skin = skinOf(button, rect, flight)
  gsap.set(button, { opacity: 0 })
  gsap.set(skin, { clipPath: squareClip })
  return gsap
    .timeline()
    .to(skin, { scaleX: 1.02, scaleY: 0.94, duration: 0.12, ease: EASE_OUT }, 0)
    .to(skin, { color: 'rgba(10, 10, 11, 0)', duration: 0.18, ease: EASE_OUT }, 0)
    .to(skin, { clipPath: circleClip(rect), scaleX: 1, scaleY: 1, duration: 0.18, ease: EASE_IN_OUT }, 0.12)
    .set(skin, { autoAlpha: 0 }, 0.3)
    .add(toss(flight, centre(rect), landing, [rect.height, DROP], 0.74), 0.3)
    .set(flight.mark, { x: () => landing().x, y: () => landing().y }, 1.24)
    .fromTo(flight.mark, { scale: 0.9, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.2, ease: EASE_OUT }, 1.25)
}

/**
 * Close becomes Download again: a fresh toss, never a rewind, so the tail still trails. The
 * circle lands where Download sat and opens back into the button as its label returns.
 */
export function land(flight: Flight, from: Point, button: HTMLElement, home: DOMRect): gsap.core.Timeline {
  const skin = skinOf(button, home, flight)
  gsap.set(skin, { clipPath: circleClip(home), color: 'rgba(10, 10, 11, 0)', autoAlpha: 0 })
  return gsap
    .timeline()
    .set(flight.drop, { x: from.x, y: from.y, scaleX: 1, scaleY: 1, autoAlpha: 1 }, 0)
    .set(flight.mark, { x: from.x, y: from.y, scale: 1, autoAlpha: 1 }, 0)
    .to(flight.drop, { scaleX: 0.94, scaleY: 0.94, duration: 0.12, ease: EASE_OUT }, 0)
    .to(flight.mark, { autoAlpha: 0, duration: 0.12, ease: EASE_OUT }, 0)
    .add(toss(flight, from, () => centre(home), [DROP * 0.94, home.height], 0.92), 0.12)
    .set(flight.drop, { autoAlpha: 0 }, 1.37)
    .set(skin, { autoAlpha: 1 }, 1.37)
    .to(skin, { clipPath: squareClip, duration: 0.18, ease: EASE_IN_OUT }, 1.37)
    .to(skin, { color: 'rgb(10, 10, 11)', duration: 0.2, ease: EASE_OUT }, 1.42)
    .set(button, { clearProps: 'opacity' })
}
