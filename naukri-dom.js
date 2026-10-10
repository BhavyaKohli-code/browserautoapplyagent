// Naukri page helpers for Auto Apply.
// Naukri works differently from LinkedIn/Indeed: there is no form with a final Submit step.
// Pressing "Apply" on a job page either applies immediately, or opens a chatbot drawer that
// asks recruiter questions one at a time - and answering the last one submits the application.
// Two kinds of pages:
//   - search results (www.naukri.com/<keyword>-jobs...): listCards, selectCard, getJobDetails, nextPageUrl
//   - a job page (www.naukri.com/job-listings-...): jobStatus, clickApply, readChat, answerChat
// Naukri's class names carry build hashes (styles_xxx__AbC12), so selectors match on the
// stable part ([class*=...]) and fall back to button/link text.
(function() {
  if (window.__nkAA) return;

  var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };
  var norm = function(s) { return (s || '').replace(/\s+/g, ' ').trim(); };

  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && !(parseFloat(s.opacity) <= 0.05);
  }

  function q(sel, root) { return (root || document).querySelector(sel); }
  function qa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // [class*=x] also matches wrappers like "x_container" - keep only the innermost matches
  function leaves(els) {
    return els.filter(function(el) { return !els.some(function(o) { return o !== el && el.contains(o); }); });
  }

  function byText(root, sel, re) {
    return qa(sel, root).find(function(el) {
      return visible(el) && re.test(norm(el.innerText) || norm(el.getAttribute('aria-label')));
    }) || null;
  }

  // ---------- Search results ----------

  function cardEls() {
    var cards = qa('.srp-jobtuple-wrapper[data-job-id], [class*="jobTuple"][data-job-id], article[data-job-id], div[data-job-id]');
    // Nested matches (wrapper + inner tuple share the id) -> keep the outermost
    return cards.filter(function(c) {
      return !cards.some(function(o) { return o !== c && o.contains(c); });
    });
  }

  function titleLink(card) {
    return q('a.title', card) || q('a[class*="title"]', card) || q('a[href*="/job-listings-"]', card);
  }

  function listCards() {
    var seen = {};
    return cardEls().map(function(card) {
      var a = titleLink(card);
      var comp = q('a.comp-name, [class*="comp-name"], a[class*="company"]', card);
      var loc = q('.locWdth, [class*="locWdth"], [class*="loc-wrap"], [class*="location"]', card);
      return {
        id: card.getAttribute('data-job-id'),
        title: a ? norm(a.innerText) : '',
        company: comp ? norm(comp.innerText) : '',
        location: loc ? norm(loc.innerText) : '',
        url: a ? a.href : '',
        applied: false, // Naukri only shows this on the job page
        easyApply: true
      };
    }).filter(function(c) {
      if (!c.id || !c.url || seen[c.id]) return false;
      seen[c.id] = true;
      return true;
    });
  }

  // Naukri opens jobs in a new tab, so "selecting" a card only remembers it; the orchestrator
  // opens getJobDetails().applyUrl (the job page) in its own tab and decides there.
  var selected = null;

  async function selectCard(id) {
    var card = cardEls().find(function(c) { return c.getAttribute('data-job-id') === id; });
    if (!card) return { ok: false, message: 'Card not found' };
    card.scrollIntoView({ block: 'center' });
    selected = card;
    await sleep(300);
    return { ok: true };
  }

  async function getJobDetails() {
    var a = selected && titleLink(selected);
    var snippet = selected ? q('[class*="job-desc"], [class*="job-description"]', selected) : null;
    return {
      description: snippet ? norm(snippet.innerText) : '',
      // Unknown until the job page is open (Naukri apply vs. company site) -> the job page decides
      hasEasyApply: !!a,
      alreadyApplied: false,
      applyUrl: a ? a.href : ''
    };
  }

  // Naukri's "Next" link (/x-jobs-2) drops the search filters when opened as a URL - opening it
  // redirects to the unfiltered page 1. Clicking it in the page keeps them (verified Oct 2026).
  async function nextResultsPage() {
    var pag = q('[class*="pagination"]') || document;
    var a = byText(pag, 'a', /^next$/i);
    if (!a || a.getAttribute('disabled') !== null || /disabled/i.test(a.className)) return { ok: false };
    var ids = function() { return cardEls().map(function(c) { return c.getAttribute('data-job-id'); }).join(','); };
    var before = ids();
    a.click();
    for (var i = 0; i < 40; i++) {
      await sleep(300);
      var now = ids();
      if (now && now !== before) { await sleep(800); return { ok: true }; }
    }
    return { ok: false };
  }

  function nextPageUrl() {
    var pag = q('[class*="pagination"]') || document;
    var a = byText(pag, 'a', /^next$/i);
    if (!a || a.getAttribute('disabled') !== null || /disabled/i.test(a.className)) return { url: '' };
    return { url: a.href || '' };
  }

  // ---------- Job page ----------

  function applyButton() {
    return q('#apply-button') ||
      byText(document, 'button, a', /^(apply|apply now|easy apply)$/i);
  }

  function companySiteButton() {
    return q('#company-site-button') || byText(document, 'button, a', /apply on company (site|website)/i);
  }

  function jobStatus() {
    var text = document.body ? document.body.innerText.slice(0, 6000) : '';
    var desc = q('[class*="job-desc"], [class*="JDC__dang-inner-html"], section[class*="description"]');
    var title = q('h1');
    var applied = q('#already-applied') || byText(document, 'button, span, a', /^applied$/i);
    var status;
    if (applied) status = 'applied';
    else if (byText(document, 'button, a', /^(login|register) to apply$/i)) status = 'login';
    else if (applyButton()) status = 'naukri';
    else if (companySiteButton()) status = 'company';
    else status = 'none';
    return {
      status: status,
      title: title ? norm(title.innerText) : '',
      description: desc ? desc.innerText.slice(0, 6000) : text.slice(0, 3000),
      quota: /daily (apply )?(quota|limit)|reached (your|the) (daily )?(limit|quota)/i.test(text)
    };
  }

  // Returns the button's centre too, so the orchestrator can fall back to a real mouse click
  async function clickApply(dryMeasureOnly) {
    var btn = applyButton();
    if (!btn) return { ok: false, message: 'No Apply button' };
    btn.scrollIntoView({ block: 'center' });
    await sleep(400);
    var r = btn.getBoundingClientRect();
    var pos = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    if (!dryMeasureOnly) btn.click();
    return { ok: true, x: pos.x, y: pos.y };
  }

  // ---------- Chatbot drawer ----------

  function drawer() {
    var d = q('[class*="chatbot_Drawer"]') || q('[class*="chatbot_DrawerContentWrapper"]') ||
      q('[class*="chatbot_"]') || q('[class*="chatBot"]');
    if (!d) return null;
    // climb to the drawer that also holds the input area
    var p = d;
    for (var i = 0; i < 6 && p.parentElement; i++) {
      if (q('[contenteditable="true"], input[type=radio], input[type=checkbox], [class*="chatbot_Chip"]', p)) break;
      p = p.parentElement;
    }
    return visible(p) ? p : null;
  }

  function botMessages(root) {
    var items = qa('li.botItem, [class*="botItem"]', root);
    return items.length ? items : qa('[class*="botMsg"]', root);
  }

  function userMessageCount(root) {
    var items = qa('li.userItem, [class*="userItem"]', root);
    return (items.length ? items : qa('[class*="userMsg"]', root)).length;
  }

  function chipEls(root) {
    return leaves(qa('[class*="chatbot_Chip"], [class*="chipItem"], .chip', root)).filter(visible);
  }

  function labelText(input) {
    if (input.labels && input.labels.length && norm(input.labels[0].innerText)) return norm(input.labels[0].innerText);
    var id = input.id && document.querySelector('label[for="' + CSS.escape(input.id) + '"]');
    if (id && norm(id.innerText)) return norm(id.innerText);
    var p = input.parentElement;
    for (var i = 0; i < 3 && p; i++) {
      if (norm(p.innerText)) return norm(p.innerText);
      p = p.parentElement;
    }
    return norm(input.value);
  }

  // After a successful apply Naukri leaves the job page for an "Apply Confirmation" page:
  // /myapply/saveApply?strJobsarr=[<jobId>]&applytype=single...
  function onConfirmationPage() {
    return /\/myapply\/saveApply/i.test(location.pathname);
  }

  function successText() {
    var text = document.body ? document.body.innerText.slice(0, 8000) : '';
    return /you have successfully applied|successfully applied|application (has been )?(sent|submitted)|applied successfully/i.test(text);
  }

  // Current state of the apply flow on the job page:
  //   { state: 'success' } | { state: 'quota' } | { state: 'waiting' }
  //   { state: 'chat', question, context, kind: 'radio'|'checkboxes'|'chips'|'text', options, step }
  function readChat() {
    if (onConfirmationPage()) return { state: 'success' };
    var text = document.body ? document.body.innerText.slice(0, 8000) : '';
    var d = drawer();
    if (!d) {
      if (successText() || q('#already-applied') || byText(document, 'button, span', /^applied$/i)) return { state: 'success' };
      if (/daily (apply )?(quota|limit)|reached (your|the) (daily )?(limit|quota)/i.test(text)) return { state: 'quota' };
      return { state: 'waiting' };
    }
    var msgs = botMessages(d).map(function(m) { return norm(m.innerText); }).filter(Boolean);
    var question = msgs[msgs.length - 1] || '';
    var context = msgs.slice(-3, -1).join(' ');

    var radios = qa('input[type=radio]', d).filter(function(i) { return visible(i) || visible(i.parentElement); });
    var checks = qa('input[type=checkbox]', d).filter(function(i) { return visible(i) || visible(i.parentElement); });
    var chips = chipEls(d);
    var input = qa('[contenteditable="true"], textarea, input[type=text], input[type=number], input:not([type])', d).filter(visible)[0];

    var res = { state: 'chat', question: question, context: context, step: userMessageCount(d) + '|' + question.slice(0, 80) };
    if (radios.length) { res.kind = 'radio'; res.options = radios.map(labelText); }
    else if (checks.length) { res.kind = 'checkboxes'; res.options = checks.map(labelText); }
    else if (chips.length) {
      res.kind = 'chips';
      res.options = chips.map(function(c) { return norm(c.innerText); }).filter(function(t) { return t && !/^skip/i.test(t); });
      res.canSkip = chips.some(function(c) { return /^skip/i.test(norm(c.innerText)); });
      if (!res.options.length) { res.kind = input ? 'text' : 'chips'; }
    }
    else if (input) res.kind = 'text';
    else res.kind = 'none';
    if (res.kind === 'text' && input) res.placeholder = input.getAttribute('placeholder') || input.getAttribute('data-placeholder') || '';
    // Success text can show up while the drawer animates closed
    if (res.kind === 'none' && successText()) return { state: 'success' };
    return res;
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

  function saveButton(d) {
    return q('.sendMsg', d) || leaves(qa('[class*="sendMsg"]', d))[0] ||
      leaves(qa('button, div[role=button], div, span', d).filter(function(el) {
        return visible(el) && /^(save|send|submit|next)$/i.test(norm(el.innerText));
      }))[0] || null;
  }

  async function pressSave(d) {
    for (var i = 0; i < 10; i++) {
      var b = saveButton(d);
      if (b && !b.disabled && !/disabled/i.test(b.className)) { b.click(); return true; }
      await sleep(250);
    }
    return false;
  }

  // Answers the current chatbot question. Chips send on click; radios/checkboxes/text need Save.
  async function answerChat(kind, answer) {
    var d = drawer();
    if (!d) return { ok: false, message: 'Chat closed' };
    var answers = Array.isArray(answer) ? answer : [answer];

    if (kind === 'chips') {
      var chips = chipEls(d);
      var k = matchOption(chips.map(function(c) { return norm(c.innerText); }), answers[0]);
      if (k < 0) return { ok: false, message: 'No chip matches "' + answers[0] + '"' };
      chips[k].click();
      return { ok: true };
    }

    if (kind === 'radio' || kind === 'checkboxes') {
      var type = kind === 'radio' ? 'radio' : 'checkbox';
      var inputs = qa('input[type=' + type + ']', d);
      var opts = inputs.map(labelText);
      var hit = false;
      for (var j = 0; j < answers.length; j++) {
        var idx = matchOption(opts, answers[j]);
        if (idx < 0) continue;
        if (!inputs[idx].checked) {
          var lab = inputs[idx].labels && inputs[idx].labels[0];
          (lab || inputs[idx]).click();
          if (!inputs[idx].checked) inputs[idx].click();
        }
        hit = true;
        if (kind === 'radio') break;
      }
      if (!hit) return { ok: false, message: 'No option matches "' + answers.join(', ') + '"' };
      await sleep(300);
      return (await pressSave(d)) ? { ok: true } : { ok: false, message: 'No Save button' };
    }

    var input = qa('[contenteditable="true"], textarea, input[type=text], input[type=number], input:not([type])', d).filter(visible)[0];
    if (!input) return { ok: false, message: 'No text box' };
    input.focus();
    var val = String(answers[0]);
    if (input.isContentEditable) {
      // execCommand goes through the editor's normal input pipeline, so React sees the text
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, val);
      if (norm(input.innerText) !== norm(val)) {
        input.innerText = val;
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }));
      }
    } else {
      var proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, val);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await sleep(400);
    // Some questions open a suggestion list under the box (cities, skills) - pick the first match
    var sugg = qa('[class*="suggestor"] li, [class*="sugg"] li, [role=option]', d).filter(visible);
    if (sugg.length) {
      var si = matchOption(sugg.map(function(s) { return norm(s.innerText); }), val);
      (sugg[si >= 0 ? si : 0]).click();
      await sleep(300);
    }
    return (await pressSave(d)) ? { ok: true } : { ok: false, message: 'No Save button' };
  }

  function pageStatus() {
    var text = document.body ? document.body.innerText.slice(0, 3000) : '';
    var challenge = qa('iframe').some(function(f) {
      return /recaptcha\/.*bframe|hcaptcha|challenges\.cloudflare/.test(f.src || '') && visible(f);
    }) || /verify you are human|access denied|are you a robot/i.test(text);
    var loginLink = q('#login_Layer');
    return {
      url: location.href,
      loggedOut: /\/nlogin\/login/.test(location.pathname) || !!(loginLink && visible(loginLink)),
      checkpoint: challenge,
      cards: cardEls().length,
      dialogOpen: false,
      onForm: /\/job-listings-/.test(location.pathname),
      alreadyApplied: !!q('#already-applied')
    };
  }

  window.__nkAA = {
    listCards: listCards,
    selectCard: selectCard,
    getJobDetails: getJobDetails,
    nextPageUrl: nextPageUrl,
    nextResultsPage: nextResultsPage,
    jobStatus: jobStatus,
    clickApply: clickApply,
    readChat: readChat,
    answerChat: answerChat,
    pageStatus: pageStatus
  };
})();
