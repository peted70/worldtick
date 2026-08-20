/* Scroll reveals: fade and 12px rise, fire once, never re-animate on the way
 * back up. The stagger lives in CSS (.caps .reveal:nth-child) so this stays
 * a pure visibility concern. */

export function initReveals({ reducedMotion = false } = {}) {
  const items = document.querySelectorAll('.reveal');
  if (!items.length) return;

  if (reducedMotion || !('IntersectionObserver' in window)) {
    for (const el of items) el.classList.add('is-in');
    return;
  }

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-in');
      io.unobserve(entry.target);
    }
  }, {
    // Trigger a little before the element reaches the fold, so the motion has
    // finished by the time it is properly in view rather than starting then.
    rootMargin: '0px 0px -12% 0px',
    threshold: 0.15,
  });

  for (const el of items) io.observe(el);
}
