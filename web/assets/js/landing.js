// Landing page behaviour: language, theme, mobile nav, and the evidence specimen.
import { initI18n, onLangChange, t } from './i18n.js';
import { toggleTheme, resolvedTheme, onThemeChange } from './theme.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function initChrome() {
  const header = $('.site-header');
  const onScroll = () => header.setAttribute('data-elevated', String(window.scrollY > 8));
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const syncThemeLabel = () => {
    $$('[data-action="toggle-theme"]').forEach((btn) => {
      btn.setAttribute('aria-label', t(resolvedTheme() === 'dark' ? 'common.themeToLight' : 'common.themeToDark'));
    });
  };
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="toggle-theme"]')) toggleTheme();
  });
  onThemeChange(syncThemeLabel);
  onLangChange(syncThemeLabel);
  syncThemeLabel();

  const toggle = $('.site-nav-toggle');
  const nav = $('#site-nav');
  const setOpen = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    nav.dataset.open = String(open);
  };
  toggle?.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  nav?.addEventListener('click', (event) => {
    if (event.target.closest('a')) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && toggle?.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      toggle.focus();
    }
  });
}

/* ---------- Specimen: statement -> transcript evidence ---------- */

function initSpecimen() {
  const fig = $('#specimen');
  if (!fig) return;
  const grid = $('.specimen__grid', fig);
  const live = $('#specimen-live');
  const statements = $$('.spec-st', fig);

  // The connecting wire is decorative; built here so the static page stays clean.
  const ns = 'http://www.w3.org/2000/svg';
  const wire = document.createElementNS(ns, 'svg');
  wire.setAttribute('class', 'specimen__wire');
  wire.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  const dotA = document.createElementNS(ns, 'circle');
  const dotB = document.createElementNS(ns, 'circle');
  dotA.setAttribute('r', '3');
  dotB.setAttribute('r', '3');
  wire.append(path, dotA, dotB);
  grid.append(wire);

  let active = null;

  function drawWire(statement, turn) {
    if (!turn || window.matchMedia('(max-width: 760px)').matches) {
      wire.classList.remove('is-visible');
      return;
    }
    const g = grid.getBoundingClientRect();
    const s = statement.getBoundingClientRect();
    const tr = turn.getBoundingClientRect();
    const x1 = tr.right - g.left - 6;
    const y1 = tr.top - g.top + Math.min(tr.height / 2, 22);
    const x2 = s.left - g.left + 2;
    const y2 = s.top - g.top + Math.min(s.height / 2, 18);
    const mid = (x1 + x2) / 2;
    wire.setAttribute('viewBox', `0 0 ${Math.round(g.width)} ${Math.round(g.height)}`);
    path.setAttribute('d', `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`);
    dotA.setAttribute('cx', x1);
    dotA.setAttribute('cy', y1);
    dotB.setAttribute('cx', x2);
    dotB.setAttribute('cy', y2);
    wire.classList.add('is-visible');
  }

  function activate(statement, { announceIt = false } = {}) {
    if (active === statement) return;
    active = statement;
    statements.forEach((el) => el.classList.toggle('is-active', el === statement));
    $$('.spec-turn', fig).forEach((el) => el.classList.remove('is-linked'));
    if (!statement) {
      wire.classList.remove('is-visible');
      return;
    }
    const turn = statement.dataset.evidence ? document.getElementById(statement.dataset.evidence) : null;
    turn?.classList.add('is-linked');
    drawWire(statement, turn);
    if (announceIt) {
      live.textContent = turn
        ? t('landing.specimen.announce', { who: $('.spec-turn__who', turn).textContent, text: $('p', turn).textContent })
        : t('note.unverifiedLong');
    }
  }

  // Autoplay: walk through the statements once when the specimen first comes into view.
  let autoplay = null;
  let touched = false; // once the reader interacts, autoplay never (re)starts
  const stopAutoplay = () => {
    touched = true;
    if (autoplay) clearInterval(autoplay);
    autoplay = null;
  };
  const startAutoplay = () => {
    if (reduceMotion.matches || autoplay || touched) return;
    let i = 0;
    activate(statements[0]);
    autoplay = setInterval(() => {
      i += 1;
      if (i >= statements.length) {
        clearInterval(autoplay);
        autoplay = null;
        activate(statements[0]);
        return;
      }
      activate(statements[i]);
    }, 1900);
  };
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          setTimeout(startAutoplay, reduceMotion.matches ? 0 : 1200);
        }
      },
      { threshold: 0.45 },
    );
    io.observe(fig);
  }
  if (reduceMotion.matches) activate(statements[0]);

  fig.addEventListener('pointerover', (event) => {
    const statement = event.target.closest('.spec-st');
    if (!statement) return;
    stopAutoplay();
    activate(statement);
  });
  fig.addEventListener('focusin', (event) => {
    const statement = event.target.closest('.spec-st');
    if (!statement) return;
    stopAutoplay();
    activate(statement, { announceIt: true });
  });
  fig.addEventListener('click', (event) => {
    const chip = event.target.closest('.ev-chip');
    if (!chip) return;
    stopAutoplay();
    active = null;
    activate(chip.closest('.spec-st'), { announceIt: true });
  });
  // Re-measure the wire for whatever is selected now; never change the selection here.
  const redraw = () => {
    if (!active) return;
    const turn = active.dataset.evidence ? document.getElementById(active.dataset.evidence) : null;
    drawWire(active, turn);
  };
  window.addEventListener('resize', redraw);
  onLangChange(() => requestAnimationFrame(redraw));
}

initI18n();
initChrome();
initSpecimen();
