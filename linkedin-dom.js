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
  // Search results use the 2026 UI; suggested jobs (/jobs/collections/recommended/) still use the classic one
  var CARD_SEL = 'div[role=button][componentkey^="job-card-component-ref-"], [data-occludable-job-id]';

  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function cardEls() {
    return Array.prototype.slice.call(document.querySelectorAll(CARD_SEL));
  }

  function cardId(el) {
    return el.getAttribute('data-occludable-job-id') ||
      (el.getAttribute('componentkey') || '').replace('job-card-component-ref-', '');
  }

  // Classic UI: the detail pane, once it shows this job
  function classicPane(id) {
    var pane = document.querySelector('.jobs-search__job-details--wrapper');
    return pane && pane.querySelector('a[href*="/jobs/view/' + id + '"]') ? pane : null;
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
      if (/easy apply|solicitud sencilla/i.test(label) && visible(b) && !b.closest(CARD_SEL)) return b;
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

  // Classic cards are empty until scrolled into view
  async function renderCards() {
    var els = cardEls().filter(function(el) { return el.hasAttribute('data-occludable-job-id'); });
    for (var i = 0; i < els.length; i++) {
      els[i].scrollIntoView({ block: 'center' });
      for (var w = 0; w < 6 && !norm(els[i].innerText); w++) await sleep(150);
    }
    if (els.length) els[0].scrollIntoView({ block: 'center' });
  }

  async function listCards() {
    await renderCards();
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
    }).filter(function(c) { return c.title; });
  }

  async function selectCard(id) {
    var el = cardEls().find(function(c) { return cardId(c) === id; });
    if (!el) return { ok: false, message: 'Card not found' };
    el.scrollIntoView({ block: 'center' });
    await sleep(300);
    var classic = el.hasAttribute('data-occludable-job-id');
    await window.__humanAA.clickEl((classic && el.querySelector('a[href*="/jobs/view/"]')) || el);
    // Wait for the detail pane to switch to this job
    for (var i = 0; i < 20; i++) {
      await sleep(300);
      if (location.href.indexOf(id) >= 0) break;
    }
    for (var p = 0; classic && p < 10 && !classicPane(id); p++) await sleep(300);
    await sleep(1200);
    return { ok: true };
  }

  function scrollableAncestor(el) {
    var p = el;
    while (p && !(p.scrollHeight > p.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
    return p;
  }

  // A plain "Apply" (company website) button in the detail pane, i.e. the pane has rendered its buttons
  function externalApplyButton() {
    var btns = document.querySelectorAll('button, a');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var label = norm((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || ''));
      if (/^apply\b|\bapply on company website\b/i.test(label) && !/easy apply/i.test(label) &&
          visible(b) && !b.closest(CARD_SEL)) return b;
    }
    return null;
  }

  // The results list is a lazy-column too (and comes first), so the detail pane is found from its Apply button
  function paneScroller(applyBtn) {
    var anchor = applyBtn || externalApplyButton() || easyApplyButton();
    if (!anchor) {
      anchor = Array.prototype.slice.call(document.querySelectorAll('[data-testid="lazy-column"]')).find(function(c) {
        return !c.querySelector(CARD_SEL);
      });
    }
    return anchor ? scrollableAncestor(anchor) : null;
  }

  async function getJobDetails() {
    // The pane's buttons can render seconds after the URL switches; checking once skipped Easy Apply jobs
    var ea = easyApplyButton();
    for (var w = 0; w < 25 && !ea && !externalApplyButton(); w++) {
      await sleep(300);
      ea = easyApplyButton();
    }
    if (!ea) { await sleep(800); ea = easyApplyButton(); }
    // The description is lazy-loaded; scroll the detail pane until it renders
    var DESC_SEL = '[data-testid="expandable-text-box"], #job-details';
    var desc = document.querySelector(DESC_SEL);
    var scroller = paneScroller(ea);
    var paneText = '';
    if (scroller) {
      for (var s = 0; s < 20 && !desc; s++) {
        scroller.scrollTop += 400;
        await sleep(350);
        desc = document.querySelector(DESC_SEL);
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

  // ---------- Contacts for cold outreach ----------

  var EMAIL_RE = /[a-z0-9][\w.+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
  // "jane [at] acme [dot] com", "jane(at)acme.com"
  var HIDDEN_EMAIL_RE = /([a-z0-9][\w.+-]*)\s*[\[(]\s*at\s*[\])]\s*([a-z0-9-]+(?:(?:\.|\s*[\[(]\s*dot\s*[\])]\s*)[a-z0-9-]+)+)/gi;
  // Mailboxes nobody hires from, image names and placeholder addresses
  var NOT_A_CONTACT_RE = /^(no-?reply|do-?not-?reply|legal|dpo|gdpr|data-?protection|accommodations?|accessibility|abuse|security|ethics|sales)\b|(privacy|fraud|compliance)[^@]*@|\.(png|jpe?g|gif|svg|webp)$|@(example|email|domain|company|yourcompany)\./i;

  function findEmails(text) {
    var found = (text.match(EMAIL_RE) || []).slice();
    var m;
    HIDDEN_EMAIL_RE.lastIndex = 0;
    while ((m = HIDDEN_EMAIL_RE.exec(text))) {
      found.push(m[1] + '@' + m[2].replace(/\s*[\[(]\s*dot\s*[\])]\s*/gi, '.').replace(/\s+/g, ''));
    }
    var out = [];
    found.forEach(function(e) {
      e = e.toLowerCase();
      if (!NOT_A_CONTACT_RE.test(e) && out.indexOf(e) < 0) out.push(e);
    });
    return out;
  }

  // [name, headline]. The 2026 link holds name, "• 2nd", headline, "Job poster"; the classic link
  // holds only the name, so the headline is found in the surrounding box.
  function personLines(a, slot) {
    var lines = [];
    for (var box = a; box && box !== slot && lines.length < 2; box = box.parentElement) {
      // Some cards repeat the name, hence the indexOf
      lines = box.innerText.split('\n').map(norm).filter(function(l, i, all) {
        return l && all.indexOf(l) === i && !/^([•·].*|\d(st|nd|rd|th)\+?|job poster.*|message|connect|follow)$/i.test(l);
      });
    }
    return lines;
  }

  function hiringSlot(id) {
    var slot = document.querySelector('[componentkey="JobDetailsPeopleWhoCanHelpSlot_' + CSS.escape(id) + '"]');
    if (slot) return slot;
    var pane = classicPane(id);
    if (!pane) return null;
    // "People you can reach out to" is a section with the same class, so go by the heading
    return Array.prototype.slice.call(pane.querySelectorAll('.job-details-people-who-can-help__section--two-pane')).find(function(s) {
      return /meet the hiring team/i.test(s.innerText);
    }) || null;
  }

  // Only people after the "Meet the hiring team" label: the same block also lists alumni and connections
  function hiringTeam(slot) {
    var label = Array.prototype.slice.call(slot.querySelectorAll('h2, h3, p, span')).find(function(n) {
      return /^meet the hiring team$/i.test(norm(n.textContent));
    });
    if (!label) return [];
    var people = [];
    slot.querySelectorAll('a[href*="/in/"]').forEach(function(a) {
      if (!(label.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
      var url = a.origin + a.pathname;
      if (!/^https:\/\/[a-z]+\.linkedin\.com\/in\/[^\s"'<>]+$/.test(url)) return;
      if (people.some(function(p) { return p.url === url; })) return;
      var lines = personLines(a, slot);
      var name = (lines[0] || '').replace(/\s*\(.*\)\s*$/, '').replace(/,.*$/, '').trim();
      if (name) people.push({ name: name, title: lines[1] || '', url: url });
    });
    return people;
  }

  // Reads the open job's pane, so call after getJobDetails. Only reads: nothing is clicked.
  async function getContacts(id) {
    var people = [];
    // The block loads late, then the pane re-renders and it can vanish and return, so one look is not
    // enough. Its key names the job, so finding it also proves the pane shows this job. A job with
    // no hiring team uses up the whole wait.
    for (var s = 0; s < 14 && !people.length; s++) {
      var slot = hiringSlot(id);
      if (slot) people = hiringTeam(slot);
      else {
        var sc = paneScroller();
        if (sc) sc.scrollTop += 500;
      }
      if (!people.length) await sleep(300);
    }
    // Looked up again: the re-render replaces the pane's nodes
    var scroller = paneScroller();
    var text = scroller ? scroller.innerText : '';
    var mailtos = scroller ? Array.prototype.slice.call(scroller.querySelectorAll('a[href^="mailto:"]')).map(function(a) {
      return a.getAttribute('href').slice(7).split('?')[0] + ' ';
    }).join('') : '';
    if (scroller) scroller.scrollTop = 0;
    return { emails: findEmails(text + ' ' + mailtos), people: people };
  }

  async function nextResultsPage() {
    var btn = document.querySelector('[data-testid="pagination-controls-next-button-visible"]');
    if (!btn) btn = buttonByText(document, /^(next|siguiente)$/i);
    if (!btn) return { ok: false };
    var before = cardEls().map(cardId).join(',');
    await window.__humanAA.clickEl(btn);
    for (var i = 0; i < 30; i++) {
      await sleep(300);
      var now = cardEls().map(cardId).join(',');
      if (now && now !== before) return { ok: true };
    }
    return { ok: false };
  }

  // ---------- Easy Apply modal ----------

  async function openEasyApply() {
    if (applyDialog()) return { ok: true };
    // A confirmation or "Save this application?" prompt left over from the last job swallows the click
    if (openDialogs().length) await closeAllDialogs();
    var btn = null;
    // The detail pane can re-render while the cursor travels to the button, leaving us
    // holding a detached node whose click does nothing - so re-find it and click again
    for (var attempt = 0; attempt < 3; attempt++) {
      for (var w = 0; w < 10 && !(btn = easyApplyButton()); w++) await sleep(300);
      if (!btn) break;
      btn.scrollIntoView({ block: 'center' });
      await sleep(300);
      await window.__humanAA.clickEl(btn);
      if (!btn.isConnected && (btn = easyApplyButton())) btn.click();
      for (var i = 0; i < 15; i++) {
        await sleep(300);
        // Click through the safety-reminder style interstitial if it comes first
        var dlgs = openDialogs();
        for (var d = 0; d < dlgs.length; d++) {
          var inter = buttonByText(dlgs[d], INTERSTITIAL_RE);
          if (inter) { await window.__humanAA.clickEl(inter); await sleep(1200); break; }
        }
        if (applyDialog() && !buttonByText(applyDialog(), INTERSTITIAL_RE)) {
          await sleep(600); // let the first step's fields and footer render
          return { ok: true };
        }
      }
      if (applyDialog()) return { ok: true };
      if (openDialogs().length) await closeAllDialogs();
    }
    if (!btn) return { ok: false, message: 'No Easy Apply button' };
    // Say what was on screen instead, so the next failure can be pinned down
    var other = openDialogs().map(function(x) { return norm(x.innerText).slice(0, 80); }).join(' | ');
    var notice = (document.body.innerText.match(/[^\n]{0,80}\b(limit|no longer accepting|try again later|something went wrong)\b[^\n]{0,80}/i) || [''])[0];
    return { ok: false, message: 'Easy Apply dialog did not open after 3 clicks' +
      (other ? ' (saw dialog: ' + other + ')' : '') + (notice ? ' (page says: ' + norm(notice).slice(0, 160) + ')' : '') };
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

    var pb = dlg.querySelector('[role=progressbar], progress');
    var pageText = norm(dlg.innerText);
    return {
      open: true,
      progress: pb ? pb.getAttribute('aria-valuenow') || pb.getAttribute('value') : null,
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
        if (members[0].checked !== want) await window.__humanAA.clickEl(members[0]);
        return { ok: true };
      }
      var opts = members.map(function(m) { return optionText(m); });
      var answers = Array.isArray(answer) ? answer : [answer];
      var hit = false;
      for (var j = 0; j < answers.length; j++) {
        var idx = matchOption(opts, answers[j]);
        if (idx >= 0) {
          if (!members[idx].checked) await window.__humanAA.clickEl(members[idx]);
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
      await window.__humanAA.clickEl(el);
      await sleep(300 + Math.random() * 400);
      setNativeValue(el, el.options[k].value);
      return { ok: true };
    }

    await window.__humanAA.clickEl(el);
    await window.__humanAA.typeInto(el, String(answer));
    if (kind === 'typeahead') {
      // Pick the first suggestion LinkedIn offers
      for (var w = 0; w < 10; w++) {
        await sleep(300);
        var lbId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
        var lb = lbId ? document.getElementById(lbId) : null;
        var opt = (lb || document).querySelector('[role=option]');
        if (opt && visible(opt)) {
          await window.__humanAA.clickEl(opt);
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

  var SUBMIT_RE = /^(submit application|submit|enviar solicitud|enviar)\b/i;
  var REVIEW_RE = /^(review|review your application|revisar)\b/i;
  var NEXT_RE = /^(next|continue|continue to next step|siguiente|continuar)\b/i;
  // Interstitials LinkedIn shows before/inside Easy Apply (safety reminder, "share profile?", etc.)
  var INTERSTITIAL_RE = /^(continue applying|apply anyway|i understand|got it|continuar solicitud)\b/i;

  // Any visible dialog that has a forward button - the apply form's footer can render
  // in a sibling dialog/overlay, and interstitials use their own dialog.
  function forwardDialogs() {
    var list = [];
    var a = applyDialog();
    if (a) list.push(a);
    openDialogs().forEach(function(d) { if (list.indexOf(d) < 0) list.push(d); });
    return list;
  }

  // Clicks the dialog's forward button. Returns which one was clicked.
  async function clickPrimary(allowSubmit) {
    // The page's buttons can render (or re-enable) a few seconds after the step loads
    for (var tries = 0; tries < 20; tries++) {
      var dlgs = forwardDialogs();
      if (!dlgs.length) return { ok: false, clicked: null, message: 'Dialog closed' };
      for (var d = 0; d < dlgs.length; d++) {
        var dlg = dlgs[d];
        var inter = buttonByText(dlg, INTERSTITIAL_RE);
        if (inter) {
          await window.__humanAA.clickEl(inter);
          await sleep(1500);
          return { ok: true, clicked: 'next' };
        }
        var submit = buttonByText(dlg, SUBMIT_RE);
        if (submit) {
          if (!allowSubmit) return { ok: true, clicked: 'submit-ready' };
          // Untick "Follow <company> to stay up to date" if present
          Array.prototype.slice.call(dlg.querySelectorAll('input[type=checkbox]')).forEach(function(cb) {
            if (cb.checked && /^follow\b/i.test(optionText(cb))) cb.click();
          });
          await window.__humanAA.clickEl(submit);
          return { ok: true, clicked: 'submit' };
        }
        var review = buttonByText(dlg, REVIEW_RE);
        if (review) { await window.__humanAA.clickEl(review); return { ok: true, clicked: 'review' }; }
        var next = buttonByText(dlg, NEXT_RE);
        if (next) { await window.__humanAA.clickEl(next); return { ok: true, clicked: 'next' }; }
      }
      await sleep(400);
    }
    var seen = [];
    forwardDialogs().forEach(function(dl) {
      Array.prototype.slice.call(dl.querySelectorAll('button')).forEach(function(b) {
        var t = norm(b.innerText) || norm(b.getAttribute('aria-label'));
        if (t && visible(b)) seen.push(t + (b.disabled ? ' (disabled)' : ''));
      });
    });
    return { ok: false, clicked: null, message: 'No Next/Review/Submit button (saw: ' + (seen.join(' | ').slice(0, 200) || 'none') + ')' };
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
    getContacts: getContacts,
    nextResultsPage: nextResultsPage,
    openEasyApply: openEasyApply,
    readForm: readForm,
    fillField: fillField,
    clickPrimary: clickPrimary,
    waitForSubmitted: waitForSubmitted,
    discardApplication: discardApplication,
    closeAllDialogs: closeAllDialogs,
    pageStatus: pageStatus,
    // exported for testing
    _findEmails: findEmails
  };
})();
