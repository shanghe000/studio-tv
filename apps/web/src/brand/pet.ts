import './pet.css';
import {installCanvasCompanionAvoidance} from './pet-avoidance';

const PET_SELECTOR = '.agent-fab';
const SVG_NS = 'http://www.w3.org/2000/svg';
const IDLE_AFTER_MS = 35_000;
const HAPPY_FOR_MS = 1_100;
let artworkSequence = 0;
let installation: {disconnect: () => void} | undefined;

/** Neutral Studio companion artwork. */
function createArtwork(): SVGSVGElement {
  const prefix = `studio-mark-${++artworkSequence}`;
  const source = `<svg class="studio-pet-artwork" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 530 530"><rect x="80" y="80" width="370" height="370" rx="96" fill="#5364a7"/><path d="M220 170L365 265L220 360Z" fill="white"/></svg>`;
  return document.importNode(new DOMParser().parseFromString(source, 'image/svg+xml').documentElement, true) as unknown as SVGSVGElement;
}

function part(className: string, tag = 'span') {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

function createOverlay() {
  const overlay = part('studio-pet-overlay');
  overlay.setAttribute('aria-hidden', 'true');
  const art = part('studio-pet-art');
  const orbit = part('studio-pet-orbit');
  orbit.append(part('', 'i'));
  const floating = part('studio-pet-float');
  const leaning = part('studio-pet-lean');
  leaning.append(createArtwork());
  floating.append(leaning);
  const sparks = part('studio-pet-sparks');
  art.append(part('studio-pet-aura'), orbit, floating, part('studio-pet-shadow'), sparks);
  overlay.append(art);
  return {overlay, sparks};
}

function mountPet(pet: HTMLElement, motion: HTMLElement) {
  const {overlay, sparks} = createOverlay();
  const originalAriaLabel = motion.getAttribute('aria-label');
  pet.setAttribute('data-studio-pet', 'true');
  motion.setAttribute('aria-label', 'Studio 画布伙伴');
  motion.append(overlay);

  const events = new AbortController();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let disposed = false;
  let paused = false;
  let frame = 0;
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  let happyTimer: ReturnType<typeof setTimeout> | undefined;
  let lastActivity = Date.now();
  let target = {x: 0, y: 0};
  let gaze = {x: 0, y: 0};
  let pointer: {id: number; x: number; y: number; dragged: boolean} | undefined;
  const clamp = (value: number) => Math.max(-1, Math.min(1, value));

  const resetGaze = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    target = {x: 0, y: 0};
    gaze = {x: 0, y: 0};
    overlay.style.setProperty('--mark-look-x', '0px');
    overlay.style.setProperty('--mark-look-y', '0px');
    overlay.style.setProperty('--mark-lean', '0deg');
  };
  const setAsleep = (asleep: boolean) => {
    overlay.classList.toggle('is-asleep', asleep);
  };
  const clearHappy = () => {
    if (happyTimer) clearTimeout(happyTimer);
    happyTimer = undefined;
    overlay.classList.remove('is-happy');
    sparks.replaceChildren();
  };
  const wake = () => {
    lastActivity = Date.now();
    setAsleep(false);
  };
  const refreshVisibility = () => {
    const style = getComputedStyle(pet);
    const next = document.hidden || !pet.isConnected ||
      pet.classList.contains('is-hidden') || pet.classList.contains('is-inactive') ||
      style.display === 'none' || style.visibility === 'hidden';
    if (next !== paused) {
      paused = next;
      overlay.classList.toggle('is-paused', paused);
      if (paused) {
        pointer = undefined;
        overlay.classList.remove('is-dragging');
        resetGaze();
        clearHappy();
        if (idleTimer) clearInterval(idleTimer);
        idleTimer = undefined;
      } else {
        wake();
        startIdleTimer();
      }
    }
    return !paused && !disposed;
  };
  function startIdleTimer() {
    if (idleTimer || paused || disposed) return;
    idleTimer = setInterval(() => {
      if (refreshVisibility() && Date.now() - lastActivity > IDLE_AFTER_MS && !pointer) {
        setAsleep(true);
        target = {x: 0, y: 0};
        requestGaze();
      }
    }, 4_000);
  }
  const updateGaze = () => {
    frame = 0;
    if (!refreshVisibility() || reducedMotion.matches) {
      resetGaze();
      return;
    }
    gaze.x += (target.x - gaze.x) * .13;
    gaze.y += (target.y - gaze.y) * .13;
    overlay.style.setProperty('--mark-look-x', `${gaze.x * 18}px`);
    overlay.style.setProperty('--mark-look-y', `${gaze.y * 14}px`);
    overlay.style.setProperty('--mark-lean', `${gaze.x * 5}deg`);
    if (Math.abs(target.x - gaze.x) + Math.abs(target.y - gaze.y) > .01) {
      frame = requestAnimationFrame(updateGaze);
    }
  };
  function requestGaze() {
    if (!frame && !reducedMotion.matches && !paused && !disposed) {
      frame = requestAnimationFrame(updateGaze);
    }
  }
  const makeHappy = () => {
    wake();
    clearHappy();
    if (!refreshVisibility() || reducedMotion.matches) return;
    overlay.classList.add('is-happy');
    for (let index = 0; index < 12; index++) {
      const spark = part('', 'i');
      spark.style.setProperty('--spark-x', `${Math.cos(index * Math.PI / 6) * (64 + index % 3 * 17)}px`);
      spark.style.setProperty('--spark-y', `${Math.sin(index * Math.PI / 6) * 70 - 30}px`);
      spark.style.setProperty('--spark-delay', `${index % 3 * 45}ms`);
      spark.textContent = index % 3 === 0 ? '✦' : '·';
      sparks.append(spark);
    }
    happyTimer = setTimeout(clearHappy, HAPPY_FOR_MS);
  };
  const move = (event: PointerEvent) => {
    if (!refreshVisibility()) return;
    wake();
    if (pointer?.id === event.pointerId && !pointer.dragged &&
      Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) >= 6) {
      pointer.dragged = true;
      clearHappy();
      overlay.classList.add('is-dragging');
    }
    if (reducedMotion.matches || event.pointerType === 'touch') return;
    const bounds = pet.getBoundingClientRect();
    target = {
      x: clamp((event.clientX - bounds.left - bounds.width / 2) / 240),
      y: clamp((event.clientY - bounds.top - bounds.height / 2) / 240),
    };
    requestGaze();
  };
  const release = (event: PointerEvent) => {
    if (pointer?.id !== event.pointerId) return;
    pointer = undefined;
    overlay.classList.remove('is-dragging');
    if (event.type === 'pointercancel') clearHappy();
    wake();
  };
  const leave = () => {
    if (!refreshVisibility()) return;
    target = {x: 0, y: 0};
    requestGaze();
  };

  // Observe pointer interaction without canceling it, changing its capture,
  // moving the native element or toggling the assistant.
  pet.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !refreshVisibility()) return;
    pointer = {id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false};
    makeHappy();
  }, {capture: true, signal: events.signal});
  window.addEventListener('pointermove', move, {passive: true, signal: events.signal});
  window.addEventListener('pointerup', release, {capture: true, signal: events.signal});
  window.addEventListener('pointercancel', release, {capture: true, signal: events.signal});
  window.addEventListener('keydown', wake, {signal: events.signal});
  document.documentElement.addEventListener('pointerleave', leave, {signal: events.signal});
  document.addEventListener('visibilitychange', () => {
    if (refreshVisibility()) wake();
  }, {signal: events.signal});
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) {
      resetGaze();
      clearHappy();
    }
  }, {signal: events.signal});
  const stateObserver = new MutationObserver(refreshVisibility);
  stateObserver.observe(pet, {attributes: true, attributeFilter: ['class', 'style']});
  startIdleTimer();
  refreshVisibility();

  return {
    overlay,
    refreshVisibility,
    disconnect() {
      disposed = true;
      events.abort();
      stateObserver.disconnect();
      if (idleTimer) clearInterval(idleTimer);
      idleTimer = undefined;
      clearHappy();
      resetGaze();
      overlay.remove();
      pet.removeAttribute('data-studio-pet');
      if (motion.getAttribute('aria-label') === 'Studio 画布伙伴') {
        if (originalAriaLabel === null) motion.removeAttribute('aria-label');
        else motion.setAttribute('aria-label', originalAriaLabel);
      }
    },
  };
}

export function installStudioPet() {
  if (installation) return installation;
  const avoidControls=installCanvasCompanionAvoidance();
  const pets = new Map<HTMLElement, ReturnType<typeof mountPet>>();
  const decorate = (pet: Element) => {
    if (!(pet instanceof HTMLElement)) return;
    const motion = pet.querySelector<HTMLElement>('.agent-fab__motion');
    if (!motion) return;
    const previous = pets.get(pet);
    if (previous?.overlay.parentElement === motion) return;
    previous?.disconnect();
    pets.set(pet, mountPet(pet, motion));
  };
  const inspect = (root: Element) => {
    const pet = root.matches(PET_SELECTOR) ? root : root.closest(PET_SELECTOR);
    if (pet) decorate(pet);
    root.querySelectorAll(PET_SELECTOR).forEach(decorate);
  };
  const refresh = () => {
    for (const [pet, controller] of pets) {
      if (!pet.isConnected) {
        controller.disconnect();
        pets.delete(pet);
      } else controller.refreshVisibility();
    }
  };
  inspect(document.body);
  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) inspect(node);
      }
    }
    refresh();
  });
  observer.observe(document.body, {childList: true, subtree: true});
  const bodyObserver = new MutationObserver(refresh);
  bodyObserver.observe(document.body, {attributes: true, attributeFilter: ['class']});
  const pageShow = (event: PageTransitionEvent) => {
    if (event.persisted) installStudioPet();
  };
  const pageHide = (event: PageTransitionEvent) => {
    installation?.disconnect();
    // A cached page needs only this one-shot restore listener while frozen;
    // all animation frames, timers, observers and pet listeners are gone.
    if (event.persisted) window.addEventListener('pageshow', pageShow, {once: true});
  };
  window.addEventListener('pagehide', pageHide, {once: true});
  installation = {
    disconnect() {
      avoidControls();
      window.removeEventListener('pagehide', pageHide);
      window.removeEventListener('pageshow', pageShow);
      observer.disconnect();
      bodyObserver.disconnect();
      for (const controller of pets.values()) controller.disconnect();
      pets.clear();
      installation = undefined;
    },
  };
  return installation;
}
