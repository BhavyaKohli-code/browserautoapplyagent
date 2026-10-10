// Indeed page helpers for Auto Apply. Same interface as linkedin-dom.js, so the orchestrator
// (autoapply.js) drives both sites the same way.
// Two kinds of pages:
//   - search results (*.indeed.com/jobs): listCards, selectCard, getJobDetails, nextPageUrl
//   - the apply flow (smartapply.indeed.com/.../form/...): readForm, fillField, clickPrimary
// Selectors verified against Indeed's October 2026 UI. Smartapply pages contain hidden
// "hp-continue-button-N" honeypot buttons - never click those.
(function() {
  if (window.__inAA) return;

  var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };
  var norm = function(s) { return (s || '').replace(/\s+/g, ' ').trim(); };
  var PLACEHOLDER_RE = /^(select an option|select|choose|choose an option|--|please select|select one)$/i;
  var ERROR_RE = /required|invalid|answer this question|please (enter|select|make|answer)|must be|enter a (whole|decimal|valid)|larger than|less than/i;

  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity) > 0.05;
  }

  function isHoneypot(el) {
    return /^hp-/.test(el.getAttribute('data-testid') || '') || !visible(el);
  }

  function buttonByText(root, re) {
    var btns = root.querySelectorAll('button, [role=button]');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (isHoneypot(b) || b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
      var t = norm(b.innerText) || norm(b.getAttribute('aria-label'));
      if (re.test(t)) return b;
    }
    return null;
  }

  function setNativeValue(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---------- Search results ----------

  function titleLinks() {
    return Array.prototype.slice.call(document.querySelectorAll('a.jcs-JobTitle[data-jk]'));
  }

  function cardOf(a) {
    return a.closest('.job_seen_beacon') || a.closest('.cardOutline') || a.closest('li') || a.parentElement;
  }

  function listCards() {
    var seen = {};
    return titleLinks().map(function(a) {
      var card = cardOf(a);
      var lines = norm(card.innerText) ? card.innerText.split('\n').map(norm).filter(Boolean) : [];
      var company = card.querySelector('[data-testid="company-name"]');
      var loc = card.querySelector('[data-testid="text-location"]');
      return {
        id: a.getAttribute('data-jk'),
        title: norm(a.innerText),
        company: company ? norm(company.innerText) : (lines[1] || ''),
        location: loc ? norm(loc.innerText) : '',
        applied: lines.some(function(l) { return /^applied\b|^you applied/i.test(l); }),
        easyApply: lines.some(function(l) { return /^easily apply$/i.test(l); })
      };
    }).filter(function(c) {
      if (seen[c.id]) return false;
      seen[c.id] = true;
      return true;
    });
  }

  function applyButton() {
    return document.querySelector('[data-testid="viewjob-indeed-apply"]') ||
      document.querySelector('#indeedApplyButton') ||
      buttonByText(document.querySelector('#jobsearch-ViewjobPaneWrapper') || document, /^(apply now|easily apply)$/i);
  }

  async function selectCard(id) {
    var a = titleLinks().find(function(x) { return x.getAttribute('data-jk') === id; });
    if (!a) return { ok: false, message: 'Card not found' };
    a.scrollIntoView({ block: 'center' });
    await sleep(300);
    var want = norm(a.innerText).slice(0, 30);
    a.click();
    // Wait until the detail pane shows this job and its apply button has rendered
    for (var i = 0; i < 25; i++) {
      await sleep(300);
      var h = document.querySelector('[data-testid="vj-job-title"]');
      var shown = h ? norm(h.innerText).slice(0, 30) : '';
      if (shown === want && document.querySelector('[data-testid="viewjob-indeed-apply"], [data-testid="viewjob-apply"]')) break;
    }
    await sleep(600);
    return { ok: true };
  }

  async function getJobDetails() {
    var desc = null;
    for (var i = 0; i < 10 && !desc; i++) {
      desc = document.querySelector('[data-testid="viewjob-job-content"]') || document.querySelector('#jobDescriptionText');
      if (!desc) await sleep(300);
    }
    var btn = applyButton();
    var text = btn ? norm(btn.innerText) : '';
    var href = btn ? (btn.href || btn.getAttribute('href') || '') : '';
    return {
      description: desc ? desc.innerText.slice(0, 6000) : '',
      hasEasyApply: !!btn && /smartapply\.indeed\.com|indeedapply/i.test(href) && !/applied/i.test(text),
      alreadyApplied: /applied/i.test(text),
      applyUrl: href
    };
  }

  function nextPageUrl() {
    var a = document.querySelector('[data-testid="pagination-page-next"]');
    return { url: a ? (a.href || '') : '' };
  }

  // ---------- Apply flow (smartapply) ----------

  function formRoot() {
    return document.querySelector('main') || document.body;
  }

  function labelFor(el) {
    if (el.labels && el.labels.length) {
      var t = norm(el.labels[0].innerText);
      if (t) return t;
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

  function optionText(input) {
    if (input.labels && input.labels.length && norm(input.labels[0].innerText)) return norm(input.labels[0].innerText);
    var p = input.parentElement;
    for (var i = 0; i < 4 && p; i++) {
      var count = p.querySelectorAll('input[type=radio], input[type=checkbox]').length;
      if (count > 1) break;
      var txt = norm(p.innerText);
      if (txt) return txt;
      p = p.parentElement;
    }
    return norm(input.value) || '';
  }

  function describedError(el) {
    var ids = (el.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
    for (var i = 0; i < ids.length; i++) {
      var n = document.getElementById(ids[i]);
      if (n && ERROR_RE.test(n.innerText || '')) return norm(n.innerText);
    }
    return '';
  }

  function containerError(container) {
    var leaves = container.querySelectorAll('p, span, div');
    for (var i = 0; i < leaves.length; i++) {
      var n = leaves[i];
      if (n.children.length > 0) continue;
      var t = norm(n.textContent);
      if (t && t.length < 120 && ERROR_RE.test(t) && visible(n)) return t;
    }
    return '';
  }

  function questionContainer(el, root) {
    var group = el.closest('fieldset') || el;
    var p = group;
    while (p.parentElement && p.parentElement !== root) {
      var inputs = p.parentElement.querySelectorAll('input:not([type=hidden]), select, textarea');
      var allMine = true;
      for (var i = 0; i < inputs.length; i++) {
        if (!group.contains(inputs[i]) && !/recaptcha/.test(inputs[i].name || '')) { allMine = false; break; }
      }
      if (!allMine) break;
      p = p.parentElement;
    }
    return p;
  }

  function stripStar(s) { return (s || '').replace(/\s*\*\s*$/, '').replace(/\s*\(optional\)\s*$/i, '').trim(); }

  function readForm() {
    var root = formRoot();
    var fields = [];
    var seenGroups = new Set();
    var counter = 0;
    var els = root.querySelectorAll('input, select, textarea');

    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var type = (el.getAttribute('type') || el.tagName).toLowerCase();
      if (type === 'hidden' || type === 'submit' || type === 'button' || el.disabled) continue;
      if (/recaptcha|captcha/i.test(el.name || el.id || '')) continue;
      if (!visible(el) && type !== 'radio' && type !== 'checkbox') continue;

      if (type === 'radio' || type === 'checkbox') {
        var fs = el.closest('fieldset') || el.closest('[role=radiogroup], [role=group]');
        var groupKey = fs || el.name || el;
        if (seenGroups.has(groupKey)) continue;
        seenGroups.add(groupKey);
        var members = fs ? Array.prototype.slice.call(fs.querySelectorAll('input[type=' + type + ']'))
          : (el.name ? Array.prototype.slice.call(root.querySelectorAll('input[name="' + CSS.escape(el.name) + '"]')) : [el]);
        var gid = 'aa' + (++counter);
        var options = members.map(function(m, idx) {
          m.setAttribute('data-aa-id', gid + '_' + idx);
          return optionText(m);
        });
        var legend = fs && fs.querySelector('legend');
        var isSingle = type === 'checkbox' && members.length === 1;
        var q = (legend && norm(legend.innerText)) || (isSingle ? '' : labelFor(members[0]));
        if (!q && fs) q = norm((fs.innerText || '').split('\n')[0]);
        if (!q) q = options[0] || '';
        var container = questionContainer(members[0], root);
        fields.push({
          key: gid,
          kind: type === 'radio' ? 'radio' : (isSingle ? 'checkbox' : 'checkboxes'),
          label: stripStar(q),
          options: options,
          required: /\*\s*$/.test(q) || members.some(function(m) { return m.required || m.getAttribute('aria-required') === 'true'; }),
          value: members.filter(function(m) { return m.checked; }).map(function(m) { return options[members.indexOf(m)]; }),
          error: members.map(describedError).find(Boolean) || containerError(container),
          context: norm(container.innerText).slice(0, 400)
        });
        continue;
      }

      var key = 'aa' + (++counter);
      el.setAttribute('data-aa-id', key);
      var label = labelFor(el);
      var kind;
      if (el.tagName === 'SELECT') kind = 'select';
      else if (el.tagName === 'TEXTAREA') kind = 'textarea';
      else if (type === 'file') kind = 'file';
      else if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list') kind = 'typeahead';
      else if (type === 'number' || /^number-input/.test(el.id)) kind = 'number';
      else if (type === 'date') kind = 'date';
      else kind = 'text';

      var f = {
        key: key,
        kind: kind,
        label: stripStar(label),
        required: el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label),
        error: describedError(el) || (el.getAttribute('aria-invalid') === 'true' ? containerError(questionContainer(el, root)) || 'Invalid' : ''),
        maxLength: el.maxLength > 0 ? el.maxLength : null,
        placeholder: el.getAttribute('placeholder') || ''
      };
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

    var headings = Array.prototype.slice.call(root.querySelectorAll('h1, h2')).map(function(h) { return norm(h.innerText); });
    return {
      open: /smartapply\.indeed\.com/.test(location.host) && !/post-apply/.test(location.pathname),
      // Each step has its own path (resume-selection, questions/1, review-module ...)
      progress: location.pathname,
      heading: headings.join(' | ').slice(0, 200),
      fields: fields
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
    var root = formRoot();
    if (kind === 'radio' || kind === 'checkbox' || kind === 'checkboxes') {
      var members = Array.prototype.slice.call(root.querySelectorAll('[data-aa-id^="' + key + '_"]'));
      if (!members.length) return { ok: false, message: 'Field gone' };
      if (kind === 'checkbox') {
        var want = answer === true || /^(yes|true|checked|agree|y|1)$/i.test(String(answer));
        if (members[0].checked !== want) members[0].click();
        return { ok: true };
      }
      var opts = members.map(optionText);
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

    var el = root.querySelector('[data-aa-id="' + key + '"]');
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
      for (var w = 0; w < 10; w++) {
        await sleep(300);
        var lbId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
        var lb = lbId ? document.getElementById(lbId) : null;
        var opt = (lb || document).querySelector('[role=option]');
        if (opt && visible(opt)) { opt.click(); await sleep(300); return { ok: true }; }
      }
    }
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return { ok: true };
  }

  async function clickPrimary(allowSubmit) {
    var root = formRoot();
    var submit = root.querySelector('[data-testid="submit-application-button"]');
    if (!submit || isHoneypot(submit)) submit = buttonByText(root, /^(submit your application|submit application|submit)$/i);
    if (submit) {
      if (!allowSubmit) return { ok: true, clicked: 'submit-ready' };
      submit.click();
      return { ok: true, clicked: 'submit' };
    }
    var cont = root.querySelector('[data-testid="continue-button"]');
    if (!cont || isHoneypot(cont)) cont = buttonByText(root, /^(continue|review your application|next)$/i);
    if (cont) { cont.click(); return { ok: true, clicked: 'next' }; }
    return { ok: false, clicked: null, message: 'No Continue/Submit button' };
  }

  // Submit, including a disabled one (buttonByText skips disabled buttons)
  function submitButton() {
    var s = formRoot().querySelector('[data-testid="submit-application-button"]');
    if (s && !isHoneypot(s)) return s;
    var all = document.querySelectorAll('button');
    for (var i = 0; i < all.length; i++) {
      if (!isHoneypot(all[i]) && /^(submit your application|submit application|submit)$/i.test(norm(all[i].innerText))) return all[i];
    }
    return null;
  }

  function isDisabled(b) { return !!b && (b.disabled || b.getAttribute('aria-disabled') === 'true'); }

  // "I'm not a robot" reCAPTCHA checkbox on the review page (Oct 2026): Submit stays disabled
  // until a person ticks it. The bot never touches it - it waits for the user.
  function robotCheckVisible() {
    return Array.prototype.slice.call(document.querySelectorAll('iframe')).some(function(f) {
      return /recaptcha\/(enterprise\/)?(anchor|bframe)|hcaptcha|challenges\.cloudflare/.test(f.src || '') && visible(f);
    });
  }

  function submitState() {
    var s = submitButton();
    return {
      submit: !!s,
      disabled: isDisabled(s),
      robotCheck: robotCheckVisible(),
      submitted: /post-apply/.test(location.pathname)
    };
  }

  // Optional "update your Indeed resume" steps (resume-module/profile-education,
  // profile-work-experience/create ...): "Save and continue" is blocked when Indeed thinks
  // details are missing, so take the step's Skip button.
  function profileSkipButton() {
    if (!/\/resume-module\/profile-/.test(location.pathname)) return null;
    var skip = Array.prototype.slice.call(document.querySelectorAll('[data-testid$="-skip-button"]')).find(function(b) {
      return !isHoneypot(b) && !isDisabled(b);
    });
    return skip || buttonByText(formRoot(), /^skip$/i);
  }

  // Indeed ignores synthetic clicks on Continue/Submit, so the orchestrator clicks with real
  // mouse events (chrome.debugger). This finds the button - waiting through "Preparing review"
  // style loading states - scrolls it into view and returns its viewport centre.
  async function primaryTarget(allowSubmit) {
    for (var i = 0; i < 40; i++) {
      var root = formRoot();
      var submit = submitButton();
      var cont = null;
      if (!submit) {
        cont = profileSkipButton();
        if (!cont) cont = root.querySelector('[data-testid="continue-button"]');
        if (!cont || isHoneypot(cont)) cont = buttonByText(document, /^(continue|continue to .{1,30}|review your application|review|next|save and continue)$/i);
      }
      var btn = submit || cont;
      if (btn) {
        if (submit && !allowSubmit) return { ok: true, clicked: 'submit-ready' };
        // Greyed-out Submit: a person has to tick "I'm not a robot" first - never click it
        if (submit && isDisabled(submit)) return { ok: true, clicked: 'needs-human', robotCheck: robotCheckVisible() };
        btn.scrollIntoView({ block: 'center' });
        await sleep(400);
        // Coordinates must hit the button itself (layout can shift, e.g. when the browser's
        // debugging bar appears); re-measure until the button is the element at that point.
        var x = 0, y = 0;
        for (var k = 0; k < 6; k++) {
          var r = btn.getBoundingClientRect();
          x = Math.round(r.left + r.width / 2); y = Math.round(r.top + r.height / 2);
          var hit = document.elementFromPoint(x, y);
          if (hit && (hit === btn || btn.contains(hit))) break;
          btn.scrollIntoView({ block: 'center' });
          await sleep(300);
        }
        return { ok: true, clicked: submit ? 'submit' : 'next', x: x, y: y };
      }
      await sleep(500);
    }
    return { ok: false, clicked: null, message: 'No Continue/Submit button after waiting 20s' };
  }

  async function waitForSubmitted() {
    for (var i = 0; i < 40; i++) {
      await sleep(500);
      var text = document.body ? document.body.innerText.slice(0, 3000) : '';
      if (/post-apply/.test(location.pathname) || /application has been submitted|your application has been sent|application submitted/i.test(text)) {
        return { ok: true };
      }
    }
    return { ok: false, message: 'No confirmation seen' };
  }

  function pageStatus() {
    var text = document.body ? document.body.innerText.slice(0, 3000) : '';
    var challenge = Array.prototype.slice.call(document.querySelectorAll('iframe')).some(function(f) {
      return /recaptcha\/.*bframe|hcaptcha|challenges\.cloudflare/.test(f.src || '') && visible(f);
    }) || /verify you are human|additional verification required|security check/i.test(text);
    return {
      url: location.href,
      loggedOut: /secure\.indeed\.com\/(auth|account\/login)/.test(location.href),
      checkpoint: challenge,
      cards: titleLinks().length,
      dialogOpen: false,
      onForm: /smartapply\.indeed\.com/.test(location.host),
      alreadyApplied: /you('ve| have) (already )?applied/i.test(text)
    };
  }

  window.__inAA = {
    listCards: listCards,
    selectCard: selectCard,
    getJobDetails: getJobDetails,
    nextPageUrl: nextPageUrl,
    readForm: readForm,
    fillField: fillField,
    clickPrimary: clickPrimary,
    primaryTarget: primaryTarget,
    submitState: submitState,
    waitForSubmitted: waitForSubmitted,
    pageStatus: pageStatus
  };
})();
