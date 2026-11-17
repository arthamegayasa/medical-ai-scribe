/* Classic (non-module) script loaded in <head> so the saved theme and language
   apply before first paint. Keep it tiny and dependency-free. */
(function () {
  var root = document.documentElement;
  root.classList.remove('no-js');
  root.classList.add('js');
  try {
    var theme = localStorage.getItem('scribe.ui.theme');
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    var lang = localStorage.getItem('scribe.ui.lang');
    if (lang === 'en' || lang === 'id') root.setAttribute('lang', lang);
  } catch (error) {
    /* Storage can be unavailable (private mode, blocked). Defaults apply. */
  }
})();
