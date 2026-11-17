// Generic UI primitives. No product logic lives here: no provider calls, storage of
// clinical content, recording or generation. See web/app/UI-CONTRACT.md for usage.
import { t } from './i18n.js';

const $ = (sel, root = document) => root.querySelector(sel);
const byId = (idOrEl) => (typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl);

/* ------------------------------------------------------------------ */
/* Dialogs and drawers (native <dialog>)                               */
/* ------------------------------------------------------------------ */

/**
 * Open a <dialog> (dialog or drawer) as modal. Focus moves inside; Esc closes;
 * focus returns to the previously focused element on close.
 * @param {string|HTMLDialogElement} idOrEl
 * @param {{ onClose?: (returnValue: string) => void, focus?: string }} [options]
 */
export function openDialog(idOrEl, options = {}) {
  const dialog = byId(idOrEl);
  if (!dialog || dialog.open) return dialog;
  const opener = document.activeElement;
  closeMenus();
  dialog.showModal();
  if (options.focus) $(options.focus, dialog)?.focus();
  dialog.addEventListener(
    'close',
    () => {
      options.onClose?.(dialog.returnValue);
      if (opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus();
      dialog.dispatchEvent(new CustomEvent('ui:closed', { bubbles: true, detail: { returnValue: dialog.returnValue } }));
    },
    { once: true },
  );
  dialog.dispatchEvent(new CustomEvent('ui:opened', { bubbles: true }));
  return dialog;
}

/** @param {string|HTMLDialogElement} idOrEl @param {string} [returnValue] */
export function closeDialog(idOrEl, returnValue = '') {
  const dialog = byId(idOrEl);
  if (dialog?.open) dialog.close(returnValue);
}

/**
 * Promise-based confirmation using #confirm-dialog.
 * @param {{ title: string, message?: string, confirmLabel?: string, cancelLabel?: string, tone?: 'default'|'danger' }} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, message = '', confirmLabel, cancelLabel, tone = 'default' }) {
  const dialog = byId('confirm-dialog');
  if (!dialog) return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  $('#confirm-title', dialog).textContent = title;
  $('#confirm-message', dialog).textContent = message;
  $('#confirm-message', dialog).hidden = !message;
  $('#confirm-ok', dialog).textContent = confirmLabel || t('common.confirm');
  $('#confirm-cancel', dialog).textContent = cancelLabel || t('common.cancel');
  dialog.dataset.tone = tone;
  dialog.returnValue = '';
  return new Promise((resolve) => {
    openDialog(dialog, {
      focus: tone === 'danger' ? '#confirm-cancel' : '#confirm-ok',
      onClose: (value) => resolve(value === 'ok'),
    });
  });
}

function initDialogs() {
  document.addEventListener('click', (event) => {
    const opener = event.target.closest('[data-open-dialog]');
    if (opener) {
      event.preventDefault();
      openDialog(opener.dataset.openDialog);
      return;
    }
    const closer = event.target.closest('[data-close-dialog]');
    if (closer) {
      closeDialog(closer.closest('dialog'), closer.dataset.closeDialog || closer.id || '');
      return;
    }
    // Click on the backdrop (the dialog element itself, outside its content box) closes it.
    if (event.target instanceof HTMLDialogElement && event.target.open) {
      const rect = event.target.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) closeDialog(event.target, 'backdrop');
    }
  });
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

const TONE_ICON = { info: 'i-info', success: 'i-check-circle', error: 'i-alert-circle', warning: 'i-alert' };

function svgIcon(name, extra = '') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', `icon ${extra}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `/assets/icons/sprite.svg#${name}`);
  svg.append(use);
  return svg;
}

/**
 * Show a toast. Errors stay until dismissed unless a duration is given.
 * @param {string} message
 * @param {{ tone?: 'info'|'success'|'warning'|'error', duration?: number, action?: { label: string, onClick: () => void } }} [opts]
 * @returns {{ dismiss: () => void }}
 */
export function toast(message, { tone = 'info', duration, action } = {}) {
  let region = byId('toast-region');
  if (!region) {
    region = document.createElement('div');
    region.id = 'toast-region';
    region.className = 'toast-region';
    region.setAttribute('aria-live', 'polite');
    document.body.append(region);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.tone = tone;
  if (tone === 'error') el.setAttribute('role', 'alert');
  el.append(svgIcon(TONE_ICON[tone] || TONE_ICON.info));
  const text = document.createElement('p');
  text.className = 'toast__message';
  text.textContent = message;
  el.append(text);
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.add('is-leaving');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => el.remove(), reduce ? 0 : 220);
  };
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast__action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      action.onClick();
      dismiss();
    });
    el.append(btn);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-btn icon-btn--sm toast__close';
  close.setAttribute('aria-label', t('common.dismiss'));
  close.append(svgIcon('i-close', 'icon--sm'));
  close.addEventListener('click', dismiss);
  el.append(close);
  region.append(el);
  const ms = duration ?? (tone === 'error' ? 0 : action ? 8000 : 4500);
  if (ms > 0) {
    timer = setTimeout(dismiss, ms);
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', () => {
      timer = setTimeout(dismiss, 2500);
    });
  }
  return { dismiss };
}

/* ------------------------------------------------------------------ */
/* Screen-reader announcements                                         */
/* ------------------------------------------------------------------ */

/** Announce text via #sr-status (polite) or #sr-alert (assertive). */
export function announce(message, { assertive = false } = {}) {
  const node = byId(assertive ? 'sr-alert' : 'sr-status');
  if (!node) return;
  node.textContent = '';
  // A tick later so repeated identical messages are still announced.
  setTimeout(() => {
    node.textContent = message;
  }, 50);
}

/* ------------------------------------------------------------------ */
/* Tooltips: any element with [data-tooltip]. Text = attribute value,  */
/* or aria-label when empty. Optional [data-shortcut] adds a <kbd>.     */
/* ------------------------------------------------------------------ */

function initTooltips() {
  const tip = byId('tooltip');
  if (!tip) return;
  let current = null;
  let showTimer;
  const hide = () => {
    clearTimeout(showTimer);
    tip.classList.remove('is-visible');
    current?.removeAttribute('aria-describedby');
    current = null;
  };
  const show = (el) => {
    const text = el.dataset.tooltip || el.getAttribute('aria-label');
    if (!text) return;
    current = el;
    tip.textContent = text;
    if (el.dataset.shortcut) {
      const kbd = document.createElement('kbd');
      kbd.textContent = el.dataset.shortcut;
      tip.append(kbd);
    }
    const r = el.getBoundingClientRect();
    tip.style.setProperty('--x', '0px');
    tip.style.setProperty('--y', '0px');
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2;
    x = Math.max(8, Math.min(x, window.innerWidth - tw - 8));
    let y = r.bottom + 8;
    if (y + th > window.innerHeight - 8) y = r.top - th - 8;
    tip.style.setProperty('--x', `${Math.round(x)}px`);
    tip.style.setProperty('--y', `${Math.round(y)}px`);
    tip.classList.add('is-visible');
  };
  const schedule = (el, delay) => {
    clearTimeout(showTimer);
    showTimer = setTimeout(() => show(el), delay);
  };
  document.addEventListener('pointerover', (event) => {
    if (event.pointerType === 'touch') return;
    const el = event.target.closest('[data-tooltip]');
    if (el && el !== current) schedule(el, 350);
    if (!el && current) hide();
  });
  document.addEventListener('focusin', (event) => {
    const el = event.target.closest('[data-tooltip]');
    if (el && el.matches(':focus-visible')) schedule(el, 150);
    else hide();
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
  });
  window.addEventListener('scroll', hide, true);
}

/* ------------------------------------------------------------------ */
/* Tabs: [role=tablist] > [role=tab][aria-controls]                     */
/* Arrow keys move and activate; emits 'ui:tabchange' on the tablist.   */
/* ------------------------------------------------------------------ */

/** Programmatically select a tab element. */
export function selectTab(tab, { focus = false } = {}) {
  const list = tab.closest('[role="tablist"]');
  if (!list) return;
  list.querySelectorAll('[role="tab"]').forEach((other) => {
    const selected = other === tab;
    other.setAttribute('aria-selected', String(selected));
    other.tabIndex = selected ? 0 : -1;
    const panel = other.getAttribute('aria-controls') && document.getElementById(other.getAttribute('aria-controls'));
    if (panel && list.dataset.tabsManual === undefined) panel.hidden = !selected;
  });
  if (focus) tab.focus();
  list.dispatchEvent(new CustomEvent('ui:tabchange', { bubbles: true, detail: { tab, id: tab.id, controls: tab.getAttribute('aria-controls') } }));
}

function initTabs() {
  document.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab && !tab.disabled) selectTab(tab);
  });
  document.addEventListener('keydown', (event) => {
    const tab = event.target.closest?.('[role="tab"]');
    if (!tab) return;
    const list = tab.closest('[role="tablist"]');
    const tabs = [...list.querySelectorAll('[role="tab"]')].filter((el) => !el.hidden && !el.disabled);
    const vertical = list.getAttribute('aria-orientation') === 'vertical';
    const prev = vertical ? 'ArrowUp' : 'ArrowLeft';
    const next = vertical ? 'ArrowDown' : 'ArrowRight';
    let index = tabs.indexOf(tab);
    if (event.key === prev) index = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === next) index = (index + 1) % tabs.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = tabs.length - 1;
    else return;
    event.preventDefault();
    selectTab(tabs[index], { focus: true });
  });
}

/* ------------------------------------------------------------------ */
/* Menus: [data-menu-trigger][aria-controls=menuId] toggles a .menu.    */
/* Items: [role=menuitem]. Arrow keys, Home/End, Esc, outside click.    */
/* ------------------------------------------------------------------ */

export function closeMenus(except) {
  document.querySelectorAll('[data-menu-trigger][aria-expanded="true"]').forEach((trigger) => {
    if (trigger === except) return;
    trigger.setAttribute('aria-expanded', 'false');
    const menu = document.getElementById(trigger.getAttribute('aria-controls'));
    if (menu) menu.hidden = true;
  });
}

function menuItems(menu) {
  return [...menu.querySelectorAll('[role="menuitem"]')].filter((el) => !el.hidden && !el.disabled);
}

export function openMenu(trigger, { focusFirst = true } = {}) {
  const menu = document.getElementById(trigger.getAttribute('aria-controls'));
  if (!menu) return;
  closeMenus(trigger);
  trigger.setAttribute('aria-expanded', 'true');
  menu.hidden = false;
  if (focusFirst) menuItems(menu)[0]?.focus();
}

function initMenus() {
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-menu-trigger]');
    if (trigger) {
      if (trigger.getAttribute('aria-expanded') === 'true') closeMenus();
      else openMenu(trigger, { focusFirst: event.detail === 0 });
      return;
    }
    const item = event.target.closest('[role="menuitem"]');
    if (item || !event.target.closest('.menu')) closeMenus();
  });
  document.addEventListener('keydown', (event) => {
    const trigger = event.target.closest?.('[data-menu-trigger]');
    if (trigger && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      openMenu(trigger);
      return;
    }
    const menu = event.target.closest?.('.menu');
    if (!menu) return;
    const items = menuItems(menu);
    let index = items.indexOf(document.activeElement);
    const owner = document.querySelector(`[aria-controls="${menu.id}"]`);
    if (event.key === 'ArrowDown') index = (index + 1) % items.length;
    else if (event.key === 'ArrowUp') index = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = items.length - 1;
    else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenus();
      owner?.focus();
      return;
    } else if (event.key === 'Tab') {
      closeMenus();
      return;
    } else return;
    event.preventDefault();
    items[index]?.focus();
  });
}

/* ------------------------------------------------------------------ */
/* Password visibility: [data-toggle-password=inputId]                  */
/* ------------------------------------------------------------------ */

function initPasswordToggles() {
  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-toggle-password]');
    if (!btn) return;
    const input = document.getElementById(btn.dataset.togglePassword);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(show));
    btn.dataset.shown = String(show);
  });
}

/* ------------------------------------------------------------------ */
/* Keyboard shortcuts                                                  */
/* ------------------------------------------------------------------ */

const shortcuts = [];

function isTyping(target) {
  return target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;
}

/**
 * Register a shortcut. combo examples: 'mod+enter', 'mod+shift+c', 'alt+1', '?', 'h', 'space'.
 * 'mod' is Ctrl on Windows/Linux and Cmd on macOS. Plain keys are ignored while typing.
 * @param {string} combo @param {(event: KeyboardEvent) => void} handler
 * @param {{ allowInInputs?: boolean, when?: () => boolean }} [opts]
 * @returns {() => void} unregister
 */
export function registerShortcut(combo, handler, opts = {}) {
  const parts = combo.toLowerCase().split('+');
  const entry = {
    key: parts.pop(),
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
    handler,
    allowInInputs: opts.allowInInputs ?? parts.includes('mod'),
    when: opts.when,
  };
  shortcuts.push(entry);
  return () => shortcuts.splice(shortcuts.indexOf(entry), 1);
}

function initShortcuts() {
  const mac = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    const key = event.key === ' ' ? 'space' : event.key.toLowerCase();
    const mod = mac ? event.metaKey : event.ctrlKey;
    const typing = isTyping(event.target);
    const modalOpen = document.querySelector('dialog[open]');
    for (const s of shortcuts) {
      const keyMatch = s.key === key || (s.key === event.code?.toLowerCase().replace('digit', ''));
      if (!keyMatch || s.mod !== mod || s.alt !== event.altKey) continue;
      if (s.shift !== event.shiftKey && s.key !== '?') continue;
      if (typing && !s.allowInInputs) continue;
      if (modalOpen && !s.mod && s.key !== '?') continue;
      if (s.when && !s.when()) continue;
      event.preventDefault();
      s.handler(event);
      return;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Clone a <template> by id and return its first element child.
 * @param {string} templateId @returns {HTMLElement}
 */
export function cloneTemplate(templateId) {
  const tpl = document.getElementById(templateId);
  return tpl.content.firstElementChild.cloneNode(true);
}

/** Set data-state on an element (by id or element). */
export function setState(idOrEl, state) {
  const el = byId(idOrEl);
  if (el) el.dataset.state = state;
  return el;
}

let initialised = false;

/** Install all delegated listeners. Safe to call once per page. */
export function initUI() {
  if (initialised) return;
  initialised = true;
  initDialogs();
  initTooltips();
  initTabs();
  initMenus();
  initPasswordToggles();
  initShortcuts();
}
