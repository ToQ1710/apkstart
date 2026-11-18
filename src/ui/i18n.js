/*
 * UI language layer (English / Tiếng Việt / 中文).
 *
 * The source code keeps its original Chinese strings (logic, tests and logs depend on them).
 * Translation happens at display time:
 *   - renderer: every text node / tooltip / placeholder is translated as it enters the DOM
 *     (MutationObserver), so strings built in app.js or pushed from the main process via IPC
 *     are covered without touching each call site;
 *   - main process: tray menu, native dialogs, notifications and window titles go through t().
 *
 * Lookup order for a string:
 *   1. exact match of the whole (whitespace-normalised) text;
 *   2. greedy longest-fragment decomposition — template literals such as `${n} 个应用` are stored
 *      as their static fragments, so "3 个应用" becomes "3 apps";
 *   3. if some Chinese is left uncovered (usually a user-provided app name), only long fragments
 *      are substituted so short app names are not mangled.
 * Works both as a browser <script> (window.ApkI18n) and as a CommonJS module (main process).
 */
(function (root) {
  'use strict';

  const LANGS = ['en', 'vi', 'zh'];
  const HAN = /[㐀-鿿豈-﫿]/;
  const CJK = /[　-〿㐀-鿿豈-﫿＀-￯]/;
  const PUNCT = {
    '，': ', ', '。': '. ', '：': ': ', '；': '; ', '！': '! ', '？': '? ', '、': ', ',
    '（': ' (', '）': ') ', '「': '"', '」': '"', '『': '"', '』': '"', '《': '"', '》': '"',
    '“': '"', '”': '"', '‘': "'", '’': "'", '【': '[', '】': ']', '～': '~', '　': ' ',
    '．': '.', '／': '/', '－': '-', '＋': '+', '％': '%', '＝': '=',
  };
  const PUNCT_RE = new RegExp('[' + Object.keys(PUNCT).join('') + ']', 'g');
  const WORD_END = /[\p{L}\p{N}%)\],:;]$/u;
  const WORD_START = /^[\p{L}\p{N}(]/u;

  function normalizeLang(v) {
    const s = String(v || '').toLowerCase();
    if (s.startsWith('zh')) return 'zh';
    if (s.startsWith('vi')) return 'vi';
    if (s.startsWith('en')) return 'en';
    return '';
  }

  /** 'auto' → pick from the OS locale: Chinese stays Chinese, Vietnamese → vi, anything else → en */
  function resolveLang(setting, osLocale) {
    const explicit = normalizeLang(setting);
    if (explicit) return explicit;
    return normalizeLang(osLocale) || 'en';
  }

  function makeTranslator(lang, dict) {
    lang = normalizeLang(lang) || 'en';
    if (lang === 'zh' || !dict) return { lang, active: false, t: (s) => s };
    const col = lang === 'vi' ? 1 : 0;
    const exact = new Map();
    const byFirst = new Map();
    for (const k of Object.keys(dict)) {
      const v = dict[k] && dict[k][col];
      if (typeof v !== 'string') continue;
      exact.set(k, v);
      const c = k[0];
      if (!byFirst.has(c)) byFirst.set(c, []);
      byFirst.get(c).push(k);
    }
    for (const list of byFirst.values()) list.sort((a, b) => b.length - a.length);
    const cache = new Map();

    function decompose(core, minLen) {
      const parts = [];
      let raw = '';
      let i = 0;
      while (i < core.length) {
        const cands = byFirst.get(core[i]);
        let hit = null;
        if (cands) {
          for (const k of cands) {
            if (k.length < minLen) break;
            if (core.startsWith(k, i)) { hit = k; break; }
          }
        }
        if (hit) {
          if (raw) { parts.push({ s: raw, tr: false }); raw = ''; }
          parts.push({ s: exact.get(hit), tr: true });
          i += hit.length;
        } else {
          raw += core[i++];
        }
      }
      if (raw) parts.push({ s: raw, tr: false });
      return parts;
    }

    function join(parts) {
      let out = '';
      for (const p of parts) {
        let s = p.s;
        if (!p.tr) s = s.replace(PUNCT_RE, (m) => PUNCT[m]);
        if (out && s && !/\s$/.test(out) && !/^\s/.test(s)
          && WORD_END.test(out) && WORD_START.test(s)
          && !(/(^|\s)v$/.test(out) && /^\d/.test(s))) {
          out += ' ';
        }
        out += s;
      }
      return out
        .replace(/ {2,}/g, ' ')
        .replace(/ +([,.;:!?])(?=\s|$)/g, '$1')
        .replace(/ +\)/g, ')')
        .replace(/\( +/g, '(')
        .replace(/([,.;:!?])\1+/g, '$1')
        .trim();
    }

    function t(s) {
      if (typeof s !== 'string' || !CJK.test(s)) return s;
      const hit = cache.get(s);
      if (hit !== undefined) return hit;
      const lead = /^\s*/.exec(s)[0];
      const trail = /\s*$/.exec(s)[0];
      const core = s.trim().replace(/\s+/g, ' ');
      let out = exact.get(core);
      if (out === undefined) {
        let parts = decompose(core, 1);
        const leftover = parts.some((p) => !p.tr && HAN.test(p.s));
        // Uncovered Chinese = probably a user-provided name; be conservative.
        if (leftover) parts = decompose(core, 3);
        out = join(parts);
      }
      out = lead + out + trail;
      if (cache.size > 5000) cache.clear();
      cache.set(s, out);
      return out;
    }

    return { lang, active: true, t };
  }

  /* ---------------- browser: live DOM translation ---------------- */

  const ATTRS = ['title', 'placeholder', 'alt', 'aria-label', 'data-tip', 'data-title'];

  function installDom(tr) {
    if (!tr.active || typeof document === 'undefined') return;
    const t = tr.t;
    const skip = (node) => {
      for (let n = node.nodeType === 1 ? node : node.parentNode; n && n.nodeType === 1; n = n.parentNode) {
        if (n.getAttribute('translate') === 'no' || n.tagName === 'SCRIPT' || n.tagName === 'STYLE'
          || n.tagName === 'TEXTAREA' || n.isContentEditable) return true;
      }
      return false;
    };
    // Remember what we wrote so a partially translated value (leftover app name in Chinese)
    // isn't fed back through the translator by our own mutation.
    const mine = new WeakMap();
    const text = (n) => {
      const v = n.nodeValue;
      if (!v || !CJK.test(v) || mine.get(n) === v || skip(n)) return;
      const r = t(v);
      mine.set(n, r);
      if (r !== v) n.nodeValue = r;
    };
    const elem = (e) => {
      if (skip(e)) return;
      let seen = mine.get(e);
      for (const a of ATTRS) {
        const v = e.getAttribute(a);
        if (!v || !CJK.test(v) || (seen && seen[a] === v)) continue;
        const r = t(v);
        if (!seen) { seen = {}; mine.set(e, seen); }
        seen[a] = r;
        if (r !== v) e.setAttribute(a, r);
      }
      // read-only inputs show informational text in their value
      if (e.tagName === 'INPUT' && e.readOnly && e.value && CJK.test(e.value)) e.value = t(e.value);
    };
    const walk = (rootNode) => {
      if (!rootNode) return;
      if (rootNode.nodeType === 3) { text(rootNode); return; }
      if (rootNode.nodeType !== 1 && rootNode.nodeType !== 9 && rootNode.nodeType !== 11) return;
      if (rootNode.nodeType === 1) elem(rootNode);
      const w = document.createTreeWalker(rootNode, 5 /* SHOW_ELEMENT | SHOW_TEXT */);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (n.nodeType === 3) text(n); else elem(n);
      }
    };
    const run = () => {
      walk(document.documentElement);
      if (document.title && CJK.test(document.title)) document.title = t(document.title);
      document.documentElement.lang = tr.lang;
    };
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'characterData') text(m.target);
        else if (m.type === 'attributes') elem(m.target);
        else for (const n of m.addedNodes) walk(n);
      }
    }).observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS,
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    run();
    // Native-looking browser dialogs used by the renderer
    for (const fn of ['alert', 'confirm', 'prompt']) {
      const orig = root[fn];
      if (typeof orig === 'function') {
        root[fn] = function (msg, ...rest) { return orig.call(root, t(String(msg ?? '')), ...rest); };
      }
    }
  }

  const api = { LANGS, normalizeLang, resolveLang, makeTranslator, installDom };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ApkI18n = api;
    // Renderer bootstrap: language comes from the preload (window.apkLang), set by the main process.
    const lang = normalizeLang(root.apkLang) || 'en';
    const tr = makeTranslator(lang, root.__APK_I18N_DICT);
    root.apkT = tr.t;
    root.apkLangCode = tr.lang;
    installDom(tr);
  }
})(typeof window !== 'undefined' ? window : globalThis);
