// LinkedIn page helpers for Auto Apply.
// Injected into the LinkedIn tab; the orchestrator (autoapply.js, in the side panel)
// calls these one at a time via chrome.scripting.executeScript.
// Selectors target LinkedIn's 2026 jobs UI (/jobs/search-results/), which uses hashed
// class names - so everything here keys off roles, aria-labels, componentkey and text.
(function() {
  if (window.__liAA) return;

  var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };
  var norm = function(s) { return (s || '').replace(/\s+/g, ' ').trim(); };
  var PLACEHOLDER_RE = /^(select an option|select|choose|choose an option|--|selecciona una opción|seleccionar)$/i;
  var ERROR_RE = /required|invalid|please (enter|select|make)|must be|enter a (whole|decimal|valid)|larger than|less than|obligatorio|no válid/i;

  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function cardEls() {
    return Array.prototype.slice.call(
      document.querySelectorAll('div[role=button][componentkey^="job-card-component-ref-"]'));
  }

  function cardId(el) {
    return (el.getAttribute('componentkey') || '').replace('job-card-component-ref-', '');
  }

  function applyDialog() {
    var d = document.querySelector('dialog[aria-labelledby=dialog-header]');
    if (d && visible(d)) return d;
    // Fallback for older/alternate layouts
    var all = document.querySelectorAll('dialog, [role=dialog]');
    for (var i = 0; i < all.length; i++) {
      if (visible(all[i]) && /apply to|solicitar/i.test(all[i].innerText.slice(0, 200))) return all[i];
    }
    return null;
  }

  function openDialogs() {
    return Array.prototype.slice.call(document.querySelectorAll('dialog, [role=dialog], [role=alertdialog]'))
      .filter(visible);
  }

  function buttonByText(root, re) {
    var btns = root.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var t = norm(btns[i].innerText) || norm(btns[i].getAttribute('aria-label'));
      if (re.test(t) && !btns[i].disabled && visible(btns[i])) return btns[i];
    }
    return null;
  }

  function easyApplyButton() {
    var btns = document.querySelectorAll('button, a');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var label = (b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '');
      if (/easy apply|solicitud sencilla/i.test(label) && visible(b) && !b.closest('[componentkey^="job-card-component-ref-"]')) return b;
    }
    return null;
  }

  function setNativeValue(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---------- Search results ----------

  function listCards() {
    return cardEls().map(function(el) {
      var lines = el.innerText.split('\n').map(norm).filter(Boolean);
      // Some cards start with an a11y line ("Selected, Title" / "Title (Verified job)") followed by the title again
      if (lines.length > 1 && (/^selected, /i.test(lines[0]) || /\(verified job\)$/i.test(lines[0]) || lines[0].indexOf(lines[1]) >= 0)) {
        lines.shift();
      }
      var applied = lines.some(function(l) { return /^applied( \d.*ago)?$/i.test(l) || /^solicitado/i.test(l); });
      return {
        id: cardId(el),
        title: lines[0] || '',
        company: lines[1] || '',
        location: lines[2] || '',
        applied: applied,
        easyApply: lines.some(function(l) { return /^easy apply$/i.test(l); })
      };
    });
  }

  async function selectCard(id) {
    var el = cardEls().find(function(c) { return cardId(c) === id; });
    if (!el) return { ok: false, message: 'Card not found' };
    el.scrollIntoView({ block: 'center' });
    await sleep(300);
    el.click();
    // Wait for the detail pane to switch to this job
    for (var i = 0; i < 20; i++) {
      await sleep(300);
      if (location.href.indexOf(id) >= 0) break;
    }
    await sleep(1200);
    return { ok: true };
  }

  function scrollableAncestor(el) {
    var p = el;
    while (p && !(p.scrollHeight > p.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
    return p;
  }

  async function getJobDetails() {
    var ea = easyApplyButton();
    // The description is lazy-loaded; scroll the detail pane until it renders
    var desc = document.querySelector('[data-testid="expandable-text-box"]');
    var anchor = ea || document.querySelector('[data-testid="lazy-column"]');
    var scroller = anchor ? scrollableAncestor(anchor) : null;
    var paneText = '';
    if (scroller) {
      for (var s = 0; s < 20 && !desc; s++) {
        scroller.scrollTop += 400;
        await sleep(350);
        desc = document.querySelector('[data-testid="expandable-text-box"]');
      }
      paneText = scroller.innerText || '';
      scroller.scrollTop = 0;
    }
    var top = '';
    if (ea) {
      var p = ea;
      for (var i = 0; i < 6 && p.parentElement; i++) p = p.parentElement;
      top = norm(p.innerText).slice(0, 400);
    }
    var bodyText = document.body.innerText;
    return {
      header: top,
      description: desc ? desc.innerText.slice(0, 6000) : paneText.slice(0, 6000),
      hasEasyApply: !!ea,
      alreadyApplied: /\bApplied \d+ \w+ ago\b|Application submitted|Solicitado hace/i.test(bodyText.slice(0, 20000)) && !ea
    };
  }

  async function nextResultsPage() {
    var btn = document.querySelector('[data-testid="pagination-controls-next-button-visible"]');
    if (!btn) btn = buttonByText(document, /^(next|siguiente)$/i);
    if (!btn) return { ok: false };
    var before = cardEls().map(cardId).join(',');
    btn.click();
    for (var i = 0; i < 30; i++) {
      await sleep(300);
      var now = cardEls().map(cardId).join(',');
      if (now && now !== before) return { ok: true };
    }
    return { ok: false };
  }

  // ---------- Easy Apply modal ----------

  async function openEasyApply() {
    var btn = easyApplyButton();
    if (!btn) return { ok: false, message: 'No Easy Apply button' };
    btn.click();
    for (var i = 0; i < 25; i++) {
      await sleep(300);
      if (applyDialog()) return { ok: true };
    }
    return { ok: false, message: 'Easy Apply dialog did not open' };
  }

  function labelFor(el, dlg) {
    if (el.labels && el.labels.length) {
      var t = norm(el.labels[0].innerText);
      if (t) return t;
    }
    if (el.id) {
      var l = dlg.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l && norm(l.innerText)) return norm(l.innerText);
    }
    var aria = el.getAttribute('aria-label');
    if (aria) return norm(aria);
    var lb = el.getAttribute('aria-labelledby');
    if (lb) {
      var txt = lb.split(' ').map(function(id) { var n = document.getElementById(id); return n ? n.innerText : ''; }).join(' ');
      if (norm(txt)) return norm(txt);
    }
    return '';
  }

  function optionText(input, group) {
    if (input.labels && input.labels.length && norm(input.labels[0].innerText)) return norm(input.labels[0].innerText);
    // Climb until an ancestor has text but still contains only this one input of the group
    var p = input.parentElement;
    for (var i = 0; i < 4 && p; i++) {
      var txt = norm(p.innerText);
      var count = p.querySelectorAll('input[type=radio], input[type=checkbox]').length;
      if (count > 1) break;
      if (txt) return txt;
      p = p.parentElement;
    }
    return norm(input.value) || '';
  }

  function questionContainer(el, dlg) {
    // Largest ancestor (below the form) that holds only this question's inputs
    var group = el.closest('fieldset') || el;
    var p = group;
    while (p.parentElement && p.parentElement !== dlg) {
      var inputs = p.parentElement.querySelectorAll('input, select, textarea');
      var allMine = true;
      for (var i = 0; i < inputs.length; i++) {
        if (!group.contains(inputs[i]) && inputs[i].type !== 'hidden') { allMine = false; break; }
      }
      if (!allMine) break;
      p = p.parentElement;
    }
    return p;
  }

  function errorText(container) {
    var leaves = container.querySelectorAll('p, span, div');
    for (var i = 0; i < leaves.length; i++) {
      var n = leaves[i];
      if (n.children.length > 0) continue;
      var t = norm(n.textContent);
      if (t && t.length < 120 && ERROR_RE.test(t) && visible(n)) return t;
    }
    return '';
  }

  // Reads every question on the current modal page.
  function readForm() {
    var dlg = applyDialog();
    if (!dlg) return { open: false };
    var fields = [];
    var seenGroups = new Set();
    var counter = 0;
    var els = dlg.querySelectorAll('input, select, textarea');

    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var type = (el.getAttribute('type') || el.tagName).toLowerCase();
      if (type === 'hidden' || type === 'submit' || type === 'button' || el.disabled) continue;
      if (!visible(el) && type !== 'radio' && type !== 'checkbox') continue;

      if (type === 'radio' || type === 'checkbox') {
        var fs = el.closest('fieldset') || el.closest('[role=radiogroup], [role=group]');
        var groupKey = fs || el.name || el;
        if (seenGroups.has(groupKey)) continue;
        seenGroups.add(groupKey);
        var members = fs ? Array.prototype.slice.call(fs.querySelectorAll('input[type=' + type + ']'))
          : (el.name ? Array.prototype.slice.call(dlg.querySelectorAll('input[name="' + CSS.escape(el.name) + '"]')) : [el]);
        var gid = 'aa' + (++counter);
        var options = members.map(function(m, idx) {
          m.setAttribute('data-aa-id', gid + '_' + idx);
          return optionText(m, fs);
        });
        var legend = fs && fs.querySelector('legend');
        var q = (legend && norm(legend.innerText)) || labelFor(members[0], dlg);
        if (!q && fs) {
          // Question text lives in the first text node above the options
          q = norm((fs.parentElement || fs).innerText.split('\n')[0]);
        }
        var isSingleCheckbox = type === 'checkbox' && members.length === 1;
        if (isSingleCheckbox && !q) q = options[0];
        if (isSingleCheckbox && fs && fs.parentElement) {
          var heading = norm(fs.parentElement.innerText.split('\n')[0]);
          if (heading && heading !== options[0]) q = heading;
        }
        var container = questionContainer(members[0], dlg);
        fields.push({
          key: gid,
          kind: type === 'radio' ? 'radio' : (isSingleCheckbox ? 'checkbox' : 'checkboxes'),
          label: q.replace(/\*$/, '').trim(),
          options: options,
          required: /\*\s*$/.test(q) || members.some(function(m) { return m.required || m.getAttribute('aria-required') === 'true'; }) || /\*/.test(norm(container.innerText).slice(0, 300)),
          value: members.filter(function(m) { return m.checked; }).map(function(m, idx) { return options[members.indexOf(m)]; }),
          error: errorText(container),
          context: norm(container.innerText).slice(0, 400)
        });
        continue;
      }

      var key = 'aa' + (++counter);
      el.setAttribute('data-aa-id', key);
      var label = labelFor(el, dlg);
      var kind;
      if (el.tagName === 'SELECT') kind = 'select';
      else if (el.tagName === 'TEXTAREA') kind = 'textarea';
      else if (type === 'file') kind = 'file';
      else if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete')) kind = 'typeahead';
      else if (type === 'number') kind = 'number';
      else if (type === 'date') kind = 'date';
      else kind = 'text';

      var cont = questionContainer(el, dlg);
      var info = el.id ? document.getElementById(el.id + '-info') : null;
      var f = {
        key: key,
        kind: kind,
        label: label.replace(/\*$/, '').trim(),
        required: el.required || el.getAttribute('aria-required') === 'true' || /\*$/.test(label),
        error: (info && ERROR_RE.test(info.innerText) ? norm(info.innerText.split('\n')[0]) : '') || errorText(cont),
        maxLength: el.maxLength > 0 ? el.maxLength : null,
        placeholder: el.getAttribute('placeholder') || ''
      };
      if (!f.maxLength && info) {
        var m = info.innerText.match(/\d+\s*\/\s*(\d+)/);
        if (m) f.maxLength = parseInt(m[1], 10);
      }
      if (kind === 'select') {
        f.options = Array.prototype.slice.call(el.options).map(function(o) { return norm(o.text); })
          .filter(function(t) { return t && !PLACEHOLDER_RE.test(t); });
        var sel = el.options[el.selectedIndex];
        f.value = sel && !PLACEHOLDER_RE.test(norm(sel.text)) && el.value !== '' ? norm(sel.text) : '';
      } else if (kind === 'file') {
        f.value = '';
      } else {
        f.value = el.value || '';
      }
      fields.push(f);
    }

    var pb = dlg.querySelector('[role=progressbar]');
    var pageText = norm(dlg.innerText);
    return {
      open: true,
      progress: pb ? pb.getAttribute('aria-valuenow') : null,
      heading: norm((dlg.querySelector('h3') || {}).innerText || ''),
      fields: fields,
      hasResumeChoice: /resume|cv|currículum/i.test(pageText) && !!dlg.querySelector('input[type=radio]'),
      buttons: Array.prototype.slice.call(dlg.querySelectorAll('button')).map(function(b) { return norm(b.innerText); }).filter(Boolean)
    };
  }

  function matchOption(options, answer) {
    var a = norm(String(answer)).toLowerCase();
    if (!a) return -1;
    var i;
    for (i = 0; i < options.length; i++) if (options[i].toLowerCase() === a) return i;
    for (i = 0; i < options.length; i++) if (options[i].toLowerCase().indexOf(a) === 0 || a.indexOf(options[i].toLowerCase()) === 0) return i;
    for (i = 0; i < options.length; i++) if (options[i].toLowerCase().indexOf(a) >= 0) return i;
    return -1;
  }

  async function fillField(key, kind, answer) {
    var dlg = applyDialog();
    if (!dlg) return { ok: false, message: 'Dialog closed' };

    if (kind === 'radio' || kind === 'checkbox' || kind === 'checkboxes') {
      var members = Array.prototype.slice.call(dlg.querySelectorAll('[data-aa-id^="' + key + '_"]'));
      if (!members.length) return { ok: false, message: 'Field gone' };
      if (kind === 'checkbox') {
        var want = answer === true || /^(yes|true|checked|agree|y|1)$/i.test(String(answer));
        if (members[0].checked !== want) members[0].click();
        return { ok: true };
      }
      var opts = members.map(function(m) { return optionText(m); });
      var answers = Array.isArray(answer) ? answer : [answer];
      var hit = false;
      for (var j = 0; j < answers.length; j++) {
        var idx = matchOption(opts, answers[j]);
        if (idx >= 0) {
          if (!members[idx].checked) members[idx].click();
          hit = true;
          if (kind === 'radio') break;
        }
      }
      return hit ? { ok: true } : { ok: false, message: 'No option matches "' + answers.join(', ') + '"' };
    }

    var el = dlg.querySelector('[data-aa-id="' + key + '"]');
    if (!el) return { ok: false, message: 'Field gone' };
    el.scrollIntoView({ block: 'center' });

    if (kind === 'select') {
      var texts = Array.prototype.slice.call(el.options).map(function(o) { return norm(o.text); });
      var k = matchOption(texts.map(function(t) { return PLACEHOLDER_RE.test(t) ? '\u0000' : t; }), answer);
      if (k < 0) return { ok: false, message: 'No option matches "' + answer + '"' };
      setNativeValue(el, el.options[k].value);
      return { ok: true };
    }

    el.focus();
    setNativeValue(el, String(answer));
    if (kind === 'typeahead') {
      // Pick the first suggestion LinkedIn offers
      for (var w = 0; w < 10; w++) {
        await sleep(300);
        var lbId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
        var lb = lbId ? document.getElementById(lbId) : null;
        var opt = (lb || document).querySelector('[role=option]');
        if (opt && visible(opt)) {
          opt.click();
          await sleep(300);
          return { ok: true };
        }
      }
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return { ok: true };
  }

  // Clicks the dialog's forward button. Returns which one was clicked.
  async function clickPrimary(allowSubmit) {
    var dlg = applyDialog();
    if (!dlg) return { ok: false, clicked: null, message: 'Dialog closed' };
    var submit = buttonByText(dlg, /^(submit application|submit|enviar solicitud|enviar)$/i);
    if (submit) {
      if (!allowSubmit) return { ok: true, clicked: 'submit-ready' };
      // Untick "Follow <company> to stay up to date" if present
      Array.prototype.slice.call(dlg.querySelectorAll('input[type=checkbox]')).forEach(function(cb) {
        if (cb.checked && /^follow\b/i.test(optionText(cb))) cb.click();
      });
      submit.click();
      return { ok: true, clicked: 'submit' };
    }
    var review = buttonByText(dlg, /^(review|review your application|revisar)$/i);
    if (review) { review.click(); return { ok: true, clicked: 'review' }; }
    var next = buttonByText(dlg, /^(next|continue|continue to next step|siguiente|continuar)$/i);
    if (next) { next.click(); return { ok: true, clicked: 'next' }; }
    return { ok: false, clicked: null, message: 'No Next/Review/Submit button' };
  }

  // After submit: wait for the confirmation, then close it.
  async function waitForSubmitted() {
    for (var i = 0; i < 30; i++) {
      await sleep(400);
      var dialogs = openDialogs();
      var text = dialogs.map(function(d) { return d.innerText; }).join('\n');
      if (/application (was )?sent|applied|application submitted|your application|solicitud enviada/i.test(text) && !/submit application/i.test(text)) {
        await sleep(800);
        await closeAllDialogs();
        return { ok: true };
      }
      if (!applyDialog()) {
        await sleep(800);
        await closeAllDialogs();
        return { ok: true };
      }
    }
    return { ok: false, message: 'No confirmation seen' };
  }

  async function closeAllDialogs() {
    for (var i = 0; i < 4; i++) {
      var dlgs = openDialogs();
      if (!dlgs.length) return;
      var d = dlgs[dlgs.length - 1];
      var btn = buttonByText(d, /^(done|close|not now|ok|got it|listo|cerrar|ahora no)$/i) ||
                d.querySelector('button[aria-label=Dismiss], button[aria-label=Close], button[aria-label^="Dismiss"], button[aria-label="Cerrar"]');
      if (btn) btn.click();
      await sleep(700);
    }
  }

  // Close the Easy Apply modal and discard the draft
  async function discardApplication() {
    var dlg = applyDialog();
    if (!dlg) return { ok: true };
    var dismiss = dlg.querySelector('button[aria-label=Dismiss], button[aria-label^="Dismiss"], button[aria-label="Cerrar"]');
    if (dismiss) dismiss.click();
    for (var i = 0; i < 10; i++) {
      await sleep(300);
      var disc = buttonByText(document, /^(discard|descartar)$/i);
      if (disc) { disc.click(); await sleep(800); return { ok: true }; }
      if (!applyDialog()) return { ok: true };
    }
    await closeAllDialogs();
    return { ok: !applyDialog() };
  }

  function pageStatus() {
    return {
      url: location.href,
      loggedOut: /\/login|\/signup|\/authwall|\/uas\//.test(location.pathname),
      checkpoint: /\/checkpoint\//.test(location.pathname),
      cards: cardEls().length,
      dialogOpen: !!applyDialog()
    };
  }

  window.__liAA = {
    listCards: listCards,
    selectCard: selectCard,
    getJobDetails: getJobDetails,
    nextResultsPage: nextResultsPage,
    openEasyApply: openEasyApply,
    readForm: readForm,
    fillField: fillField,
    clickPrimary: clickPrimary,
    waitForSubmitted: waitForSubmitted,
    discardApplication: discardApplication,
    closeAllDialogs: closeAllDialogs,
    pageStatus: pageStatus
  };
})();
