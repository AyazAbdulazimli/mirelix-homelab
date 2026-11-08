(() => {
  const catalog = window.MirelixTranslations || {};
  const languages = ['az', 'en', 'tr'];
  const storageKey = 'mirelix_language';
  let language = 'az';
  try { const saved = localStorage.getItem(storageKey); if (languages.includes(saved)) language = saved; } catch {}
  const normalize = value => value.replace(/\s+/g, ' ').trim();
  const textSources = new WeakMap();
  const attributeSources = new WeakMap();
  const bindings = new Map();
  const attributes = ['title', 'placeholder', 'aria-label'];
  const ignored = 'script,style,svg,option,[data-i18n-skip],.msg-body,.msg-sender:not([data-i18n]),#displayRoomId,#typingName';

  function t(source, params = {}) {
    const template = language === 'az' ? source : catalog[source]?.[language] || source;
    return template.replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(params, key) ? String(params[key]) : match);
  }
  function renderBinding(element, binding) {
    const params = { ...binding.params };
    if (params.view) params.view = t(params.view);
    element.textContent = t(binding.source, params);
  }
  function bindText(element, source, params = {}) {
    if (!element) return;
    element.setAttribute('data-i18n-bound', '');
    const binding = { source, params };
    bindings.set(element, binding);
    renderBinding(element, binding);
  }
  function translateText(node) {
    if (!node.parentElement || node.parentElement.closest(ignored + ',[data-i18n-bound]')) return;
    let record = textSources.get(node);
    if (!record || record.rendered !== node.nodeValue) record = { source: node.nodeValue };
    const key = normalize(record.source);
    if (!catalog[key]) return;
    const value = record.source.replace(/\S[\s\S]*\S|\S/, t(key));
    record.rendered = value;
    textSources.set(node, record);
    if (node.nodeValue !== value) node.nodeValue = value;
  }
  function translateAttributes(element) {
    let records = attributeSources.get(element);
    if (!records) { records = {}; attributeSources.set(element, records); }
    for (const attr of attributes) {
      const value = element.getAttribute(attr);
      if (value === null) continue;
      let record = records[attr];
      if (!record || record.rendered !== value) record = { source: value };
      const key = normalize(record.source);
      if (!catalog[key]) continue;
      record.rendered = t(key);
      records[attr] = record;
      if (value !== record.rendered) element.setAttribute(attr, record.rendered);
    }
  }
  function translate(root) {
    if (root.nodeType === Node.TEXT_NODE) return translateText(root);
    if (root.nodeType === Node.ELEMENT_NODE) {
      if (root.matches(ignored)) return;
      translateAttributes(root);
      if (root.hasAttribute('data-i18n-bound')) return;
    }
    for (const child of root.childNodes) translate(child);
  }
  function setLanguage(next, persist = true) {
    if (!languages.includes(next)) return;
    language = next;
    document.documentElement.lang = next;
    if (persist) { try { localStorage.setItem(storageKey, next); } catch {} }
    translate(document.documentElement);
    for (const [element, binding] of bindings) {
      if (element.isConnected) renderBinding(element, binding);
      else bindings.delete(element);
    }
    document.querySelectorAll('[data-language-select]').forEach(select => { select.value = next; });
  }
  window.I18n = { t, bindText, setLanguage, get language() { return language; } };
  document.documentElement.lang = language;
  window.addEventListener('storage', event => {
    if (event.key === storageKey) setLanguage(event.newValue || 'az', false);
  });
  document.addEventListener('DOMContentLoaded', () => {
    setLanguage(language, false);
    document.querySelectorAll('[data-language-select]').forEach(select => {
      select.addEventListener('change', () => setLanguage(select.value));
    });
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'childList') {
          for (const node of record.addedNodes) translate(node);
          for (const node of record.removedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (!node.isConnected) {
              bindings.delete(node);
              node.querySelectorAll('[data-i18n-bound]').forEach(element => bindings.delete(element));
            }
          }
        } else if (record.type === 'attributes') translateAttributes(record.target);
        else translateText(record.target);
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attributes });
  });
})();
