// Side panel UI for Auto Apply (LinkedIn / Indeed / Naukri): settings/profile forms, live log, confirm prompt,
// saved-answer editor and history. The actual work happens in autoapply.js.
(function() {
  var AA = window.AutoApply;
  var $ = function(id) { return document.getElementById(id); };
  var settings, profile;

  // ---------- tabs ----------
  document.querySelectorAll('.tabs button').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.tabs button').forEach(function(b) { b.classList.remove('active'); });
      document.querySelectorAll('.view').forEach(function(v) { v.classList.remove('active'); });
      btn.classList.add('active');
      $(btn.dataset.view).classList.add('active');
    });
  });

  // ---------- form binding ----------
  function getPath(obj, path) {
    return path.split('.').reduce(function(o, k) { return o == null ? undefined : o[k]; }, obj);
  }
  function setPath(obj, path, val) {
    var keys = path.split('.');
    var last = keys.pop();
    var o = keys.reduce(function(acc, k) { return acc[k] = acc[k] || {}; }, obj);
    o[last] = val;
  }

  // Puts obj's values into every [attr] input (also used to refresh a form after obj changed elsewhere)
  function fill(attr, obj) {
    document.querySelectorAll('[' + attr + ']').forEach(function(el) {
      var v = getPath(obj, el.getAttribute(attr));
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v === undefined || v === null ? '' : String(v);
      showRange(el);
    });
  }

  // Sliders show their value next to the label ("3 years")
  function showRange(el) {
    if (el.type !== 'range') return;
    var out = el.closest('label').querySelector('.rv');
    if (out) out.textContent = el.value + (el.value === '1' ? ' year' : ' years');
  }

  function bind(attr, objGetter, storageKey, onChange) {
    fill(attr, objGetter());
    document.querySelectorAll('[' + attr + ']').forEach(function(el) {
      var path = el.getAttribute(attr);
      el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', function() {
        var val = el.type === 'checkbox' ? el.checked : el.value;
        if (path === 'fitCheck') val = val === 'true';
        setPath(objGetter(), path, val);
        showRange(el);
        AA.save(storageKey, objGetter());
        if (onChange) onChange(path);
      });
    });
  }

  // ---------- log ----------
  function log(text, cls) {
    var box = $('aaLog');
    var line = document.createElement('div');
    line.className = cls || '';
    line.textContent = text;
    box.appendChild(line);
    while (box.childNodes.length > 600) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  function status(s) {
    var running = s === 'running';
    $('aaStart').style.display = running ? 'none' : '';
    $('aaStop').style.display = running ? '' : 'none';
    var dot = $('dot');
    if (dot) dot.className = 'dot ' + (running ? 'running' : 'ok');
    var st = AA.state;
    var modeLabel = { dry: 'dry runs', confirm: 'applied', auto: 'applied' }[settings.mode] || 'applied';
    $('aaStats').innerHTML = running || st.applied || st.skipped
      ? 'This run: <b>' + st.applied + '</b>&nbsp;' + modeLabel + ' · <b>' + st.skipped + '</b>&nbsp;skipped'
      : '';
  }

  // ---------- confirm-before-submit ----------
  // opts (Naukri): { action: button label, note: shown instead of the LinkedIn hints }
  function confirmSubmit(job, qa, opts) {
    opts = opts || {};
    var action = opts.action || 'Submit';
    return new Promise(function(resolve) {
      var box = $('aaConfirm');
      var html = '<div class="confirm-box"><h4>Ready to ' + esc(action.toLowerCase()) + ': ' + esc(job.title) + ' — ' + esc(job.company) + '</h4>';
      if (opts.note) {
        html += '<div class="hint" style="margin-bottom:8px">' + esc(opts.note) + '</div>';
      } else if (qa.length) {
        html += '<ul>' + qa.map(function(x) { return '<li>' + esc(x.q.slice(0, 80)) + ' → <b>' + esc(x.a.slice(0, 60)) + '</b> <span class="src">[' + x.source + ']</span></li>'; }).join('') + '</ul>';
      } else {
        html += '<div class="hint" style="margin-bottom:8px">No extra questions – LinkedIn prefilled everything.</div>';
      }
      if (!opts.note) html += '<div class="hint" style="margin-bottom:8px">You can review/edit the form in the job tab before choosing.</div>';
      html += '<div class="row"><button class="btn primary" data-d="submit">' + esc(action) + '</button><button class="btn ghost" data-d="skip">Skip job</button><button class="btn ghost" data-d="manual">I did it myself</button></div></div>';
      box.innerHTML = html;
      $('aaLog').scrollTop = $('aaLog').scrollHeight;
      box.scrollIntoView({ block: 'nearest' });
      var done = function(d) {
        AA.state.pendingConfirm = null;
        box.innerHTML = '';
        resolve(d);
      };
      AA.state.pendingConfirm = done;
      box.querySelectorAll('button').forEach(function(b) {
        b.addEventListener('click', function() { done(b.dataset.d); });
      });
    });
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // ---------- saved answers ----------
  async function renderAnswers() {
    var answers = await AA.load('aaAnswers', {});
    var keys = Object.keys(answers).sort(function(a, b) { return (answers[b].ts || 0) - (answers[a].ts || 0); });
    $('aaAnsCount').textContent = keys.length ? '(' + keys.length + ')' : '';
    var box = $('aaAnswers');
    box.innerHTML = '';
    if (!keys.length) { box.innerHTML = '<div class="hint">None yet.</div>'; return; }
    keys.forEach(function(k) {
      var a = answers[k];
      var row = document.createElement('div');
      row.className = 'ans-row';
      var val = Array.isArray(a.answer) ? a.answer.join(', ') : String(a.answer);
      row.innerHTML = '<div title="' + esc(a.label) + '">' + esc(a.label.slice(0, 90)) + ' <span class="src">[' + esc(a.source || '') + ']</span></div>' +
        (a.options && a.options.length
          ? '<select>' + a.options.map(function(o) { return '<option' + (o === val ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>'
          : '<input type="text" value="' + esc(val) + '">') +
        '<span class="del" title="Forget">✕</span>';
      var input = row.querySelector('input, select');
      input.addEventListener('change', async function() {
        var all = await AA.load('aaAnswers', {});
        if (!all[k]) return;
        all[k].answer = a.kind === 'checkboxes' ? input.value.split(',').map(function(s) { return s.trim(); }) : input.value;
        all[k].source = 'you';
        await AA.save('aaAnswers', all);
        row.querySelector('.src').textContent = '[you]';
      });
      row.querySelector('.del').addEventListener('click', async function() {
        var all = await AA.load('aaAnswers', {});
        delete all[k];
        await AA.save('aaAnswers', all);
        renderAnswers();
      });
      box.appendChild(row);
    });
  }

  // ---------- history ----------
  async function renderHistory() {
    var history = await AA.load('aaHistory', []);
    var applied = history.filter(function(h) { return h.status === 'applied'; }).length;
    $('aaHistCount').textContent = history.length ? '(' + applied + ' applied, ' + history.length + ' total)' : '';
    var t = $('aaHistory');
    t.innerHTML = history.slice(0, 150).map(function(h) {
      var d = new Date(h.ts);
      return '<tr><td>' + (d.getMonth() + 1) + '/' + d.getDate() + '</td>' +
        '<td><a href="' + esc(h.url || ('https://www.linkedin.com/jobs/view/' + encodeURIComponent(h.id) + '/')) + '" target="_blank">' + esc(h.title.slice(0, 50)) + '</a><br><span class="src">' + esc(h.site || 'LinkedIn') + ' · ' + esc(h.company) + (h.reason ? ' · ' + esc(h.reason.slice(0, 90)) : '') + '</span></td>' +
        '<td class="st-' + esc(h.status) + '">' + esc(h.status) + '</td></tr>';
    }).join('') || '<tr><td class="hint">Nothing yet.</td></tr>';
  }

  function refresh() { renderAnswers(); renderHistory(); }

  // ---------- cities list ----------
  function renderCities() {
    var box = $('aaCities');
    box.innerHTML = '';
    (settings.cities || []).forEach(function(city, i) {
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = esc(city) + '<button title="Remove">✕</button>';
      chip.querySelector('button').addEventListener('click', function() {
        settings.cities.splice(i, 1);
        AA.save('aaSettings', settings);
        renderCities();
      });
      box.appendChild(chip);
    });
  }

  // "Delhi, Gurugram, Remote" adds three cities; duplicates are ignored
  function addCities() {
    var input = $('aaCityInput');
    settings.cities = Array.isArray(settings.cities) ? settings.cities : [];
    input.value.split(/[,;\n]/).map(function(c) { return c.trim(); }).filter(Boolean).forEach(function(c) {
      if (!settings.cities.some(function(x) { return x.toLowerCase() === c.toLowerCase(); })) settings.cities.push(c);
    });
    input.value = '';
    AA.save('aaSettings', settings);
    renderCities();
  }
  $('aaCityAdd').addEventListener('click', addCities);
  $('aaCityInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); addCities(); }
  });

  // ---------- resume upload ----------
  async function loadResume(f) {
    var text = await window.extractFileText(f);
    text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    profile.resumeText = text;
    document.querySelectorAll('[data-p="resumeText"], [data-o="resumeText"]').forEach(function(el) { el.value = text; });
    await AA.save('aaProfile', profile);
    return text;
  }

  $('aaResumeFile').addEventListener('change', async function() {
    var f = this.files[0];
    this.value = '';
    if (!f) return;
    try {
      var text = await loadResume(f);
      log('Resume loaded (' + text.length + ' characters).', 'done');
    } catch (e) {
      log('Could not read resume: ' + e.message, 'error');
    }
  });

  // ---------- first-run profile setup ----------
  // Until these are filled in, the panel shows the setup screen instead of the tabs
  var REQUIRED = {
    resumeText: 'Resume', firstName: 'First name', lastName: 'Last name', email: 'Email', city: 'City',
    currentTitle: 'Current title', currentCompany: 'Current company', dob: 'Date of birth',
    totalYears: 'Total years of experience', education: 'Highest education',
    currentCtc: 'Last drawn CTC', expectedCtc: 'Expected CTC'
  };

  function missingFields(p) {
    return Object.keys(REQUIRED).filter(function(k) {
      var v = String(p[k] == null ? '' : p[k]).trim();
      if (k === 'totalYears') return isNaN(parseFloat(v));
      if (k === 'email') return !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
      if (k === 'dob') return !/^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}$/.test(v);
      return !v;
    });
  }

  function showSetup(on) {
    $('viewSetup').hidden = !on;
    document.querySelector('.tabs').hidden = on;
    $('viewApply').hidden = on;
    $('viewChat').hidden = on;
    // Nothing to point at before setup is done
    $('aaHelp').hidden = on;
    if (on) $('aaHelpPop').hidden = true;
    if (on) fill('data-o', profile);
  }

  // Inputs flagged by a failed "Get started" (red) or filled from the resume (orange) lose the mark once edited
  function setupChanged(path) {
    var el = document.querySelector('[data-o="' + path + '"]');
    if (el && el.closest('label')) el.closest('label').classList.remove('bad', 'auto');
  }

  function resumeStatus(text, isError) {
    busy(false);
    $('obResumeStatus').style.color = isError ? '#ef4444' : '';
    $('obResumeStatus').textContent = text;
  }

  // Spinner + seconds counter while the resume is read; "Get started" waits for it
  var busyTimer = null;
  function busy(text) {
    clearInterval(busyTimer);
    busyTimer = null;
    var box = $('obLoader');
    var btn = $('obStart');
    if (!text) {
      box.hidden = true;
      btn.disabled = false;
      btn.textContent = 'Get started';
      return;
    }
    var t0 = Date.now();
    var tick = function() { $('obLoaderTime').textContent = Math.round((Date.now() - t0) / 1000) + 's'; };
    $('obResumeStatus').textContent = '';
    $('obLoaderText').textContent = text;
    tick();
    busyTimer = setInterval(tick, 1000);
    box.hidden = false;
    btn.disabled = true;
    btn.textContent = 'Reading your resume…';
  }

  // Fills the still-empty profile fields with what the resume says. Fields the user typed are never touched.
  var autofillRun = 0;
  async function autofillFromResume(text) {
    var run = ++autofillRun;
    busy('Step 2 of 2 · Finding your name, job, education and links with the local AI. This can take a minute…');
    var r;
    try {
      r = await AA.extractProfile(text);
    } catch (e) {
      if (run === autofillRun) resumeStatus('Could not read details from the resume: ' + e.message, true);
      return;
    }
    if (run !== autofillRun) return; // a newer resume came in meanwhile
    var filled = [];
    Object.keys(r.fields).forEach(function(k) {
      if (String(profile[k] == null ? '' : profile[k]).trim()) return;
      profile[k] = r.fields[k];
      filled.push(k);
    });
    if (filled.length) await AA.save('aaProfile', profile);
    filled.forEach(function(k) {
      document.querySelectorAll('[data-o="' + k + '"], [data-p="' + k + '"]').forEach(function(el) { el.value = profile[k]; });
      var el = document.querySelector('[data-o="' + k + '"]');
      if (el && el.closest('label')) { el.closest('label').classList.remove('bad'); el.closest('label').classList.add('auto'); }
    });
    var shown = filled.filter(function(k) { return document.querySelector('[data-o="' + k + '"]'); }).length;
    var miss = missingFields(profile).map(function(k) { return REQUIRED[k]; });
    resumeStatus(
      (shown ? 'Filled ' + shown + ' detail' + (shown === 1 ? '' : 's') + ' from your resume (orange) – please check them. '
        : 'No new details found in the resume. ') +
      (miss.length ? 'Still needed: ' + miss.join(', ') + '.' : 'Everything required is filled in.') +
      (r.aiError ? ' (Local AI not reachable – ' + r.aiError + ' – so only contact details and links were read. Is Ollama running?)' : ''),
      false);
  }

  $('obResumeFile').addEventListener('change', async function() {
    var f = this.files[0];
    this.value = '';
    if (!f) return;
    autofillRun++; // a reading still in progress is no longer wanted
    busy('Step 1 of 2 · Reading ' + f.name + '…');
    var text;
    try {
      text = await loadResume(f);
    } catch (e) {
      resumeStatus('Could not read ' + f.name + ': ' + e.message, true);
      return;
    }
    setupChanged('resumeText');
    lastAutofilled = text;
    autofillFromResume(text);
  });

  // Pasted resume text: read it once the box loses focus
  var lastAutofilled = '';
  document.querySelector('[data-o="resumeText"]').addEventListener('change', function() {
    var text = this.value.trim();
    if (text.length < 200 || text === lastAutofilled) return;
    lastAutofilled = text;
    autofillFromResume(text);
  });

  $('obStart').addEventListener('click', async function() {
    var miss = missingFields(profile);
    document.querySelectorAll('[data-o]').forEach(function(el) {
      var label = el.closest('label');
      if (label) label.classList.toggle('bad', miss.indexOf(el.getAttribute('data-o')) >= 0);
    });
    if (miss.length) {
      $('obErr').textContent = 'Still needed: ' + miss.map(function(k) { return REQUIRED[k]; }).join(', ') + '.';
      var first = document.querySelector('.setup label.f.bad');
      if (first) { first.scrollIntoView({ block: 'center', behavior: 'smooth' }); first.querySelector('input, textarea').focus({ preventScroll: true }); }
      return;
    }
    $('obErr').textContent = '';
    await AA.save('aaProfile', profile);
    fill('data-p', profile);
    showSetup(false);
    $('secProfile').open = true;
    log('Profile saved, ' + profile.firstName + '. Add your phone number under "Profile" and job titles under "Job search", then press Start (try a Dry run first).', 'done');
  });

  // Two clicks, no window.confirm (it blocks the panel)
  $('aaResetProfile').addEventListener('click', async function() {
    var btn = this;
    if (AA.state.running) { log('Stop the current run before starting over.', 'error'); return; }
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = 'Click again to clear the profile';
      setTimeout(function() { delete btn.dataset.armed; btn.textContent = 'Start over as a new user'; }, 4000);
      return;
    }
    delete btn.dataset.armed;
    btn.textContent = 'Start over as a new user';
    await chrome.storage.local.remove('aaProfile');
    profile = await AA.load('aaProfile', AA.DEFAULT_PROFILE);
    fill('data-p', profile);
    autofillRun++;
    resumeStatus('');
    $('obErr').textContent = '';
    document.querySelectorAll('.setup label.f.bad, .setup label.f.auto').forEach(function(l) { l.classList.remove('bad', 'auto'); });
    lastAutofilled = '';
    showSetup(true);
  });

  $('aaClearSkipped').addEventListener('click', async function() {
    var seen = await AA.load('aaSeen', {});
    Object.keys(seen).forEach(function(k) { if (seen[k] !== 'applied') delete seen[k]; });
    await AA.save('aaSeen', seen);
    log('Skipped jobs will be retried on the next run.', 'info');
  });

  // ---------- saved-answers reminder ----------
  // The "?" next to the title turns red every 6 hours until it is opened
  var HELP_EVERY = 6 * 60 * 60 * 1000;
  async function helpCheck() {
    var seen = (await chrome.storage.local.get('aaHelpSeenAt')).aaHelpSeenAt || 0;
    $('aaHelp').classList.toggle('due', Date.now() - seen >= HELP_EVERY);
  }
  function helpShow(on) {
    $('aaHelpPop').hidden = !on;
    if (on) {
      $('aaHelp').classList.remove('due');
      AA.save('aaHelpSeenAt', Date.now());
    }
  }
  $('aaHelp').addEventListener('click', function(e) {
    e.stopPropagation();
    helpShow($('aaHelpPop').hidden);
  });
  $('aaHelpClose').addEventListener('click', function() { helpShow(false); });
  $('aaHelpGo').addEventListener('click', function() {
    helpShow(false);
    document.querySelector('.tabs button[data-view="viewApply"]').click();
    $('secAnswers').open = true;
    $('secAnswers').scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  document.addEventListener('click', function(e) {
    if (!$('aaHelpPop').hidden && !$('aaHelpPop').contains(e.target)) helpShow(false);
  });
  setInterval(helpCheck, 60 * 1000);

  // ---------- start / stop ----------
  $('aaStart').addEventListener('click', async function() {
    // A required field may have been cleared in the Profile section since setup
    if (missingFields(profile).length) { showSetup(true); return; }
    var warnings = await limitWarnings();
    if (warnings.length) { confirmLimits(warnings); return; }
    startRun();
  });

  function startRun() {
    if (settings.mode === 'auto' && !confirm_auto()) return;
    $('aaConfirm').innerHTML = '';
    AA.run();
  }

  // ---------- safe limits ----------
  // Over the tested limits is allowed, but the user is told the risk first
  var LIMIT_RE = /^max(Linkedin|Indeed|Naukri)$/;

  function overSafe(key) { return AA.siteLimit(settings, key) > AA.SAFE_LIMITS[key].max; }

  function showLimitHints() {
    var any = false;
    Object.keys(AA.SAFE_LIMITS).forEach(function(key) {
      var risky = overSafe(key);
      any = any || risky;
      document.querySelector('[data-s="' + AA.SAFE_LIMITS[key].setting + '"]').closest('label').classList.toggle('risky', risky);
    });
    $('aaLimitHint').classList.toggle('risky', any);
  }

  async function limitWarnings() {
    var history = await AA.load('aaHistory', []);
    var out = [];
    AA.siteKeysFor(settings).forEach(function(key) {
      var safe = AA.SAFE_LIMITS[key], limit = AA.siteLimit(settings, key);
      if (key === 'linkedin') {
        if (limit > safe.max) out.push('LinkedIn is set to ' + limit + ' applications in one run. We advise at most 25 at a time: 25 in the morning and 25 in the evening.');
        var today = AA.appliedToday(history, 'LinkedIn');
        if (today + limit > safe.perDay) out.push('You have already sent ' + today + ' LinkedIn applications today. We advise no more than ' + safe.perDay + ' a day (25 in the morning, 25 in the evening).');
      } else if (limit > safe.max) {
        out.push(AA.SITES[key].name + ' is set to ' + limit + ' applications a day. We advise at most ' + safe.max + ' a day.');
      }
    });
    return out;
  }

  function confirmLimits(warnings) {
    var fixable = Object.keys(AA.SAFE_LIMITS).some(overSafe);
    var box = $('aaConfirm');
    box.innerHTML = '<div class="confirm-box"><h4>Above the safe limit</h4><ul></ul>' +
      '<div class="hint" style="margin-bottom:8px">These limits were tested by the tool\'s author. Going higher is up to you, but sites may slow down, block or restrict your account.</div>' +
      '<div class="row">' + (fixable ? '<button class="btn primary" id="aaSafe">Use safe limits and start</button>' : '') +
      '<button class="btn ghost" id="aaRisk">Start anyway</button><button class="btn ghost" id="aaRiskNo">Cancel</button></div></div>';
    var ul = box.querySelector('ul');
    warnings.forEach(function(w) { var li = document.createElement('li'); li.textContent = w; ul.appendChild(li); });
    if (fixable) $('aaSafe').addEventListener('click', function() {
      Object.keys(AA.SAFE_LIMITS).forEach(function(key) {
        if (overSafe(key)) settings[AA.SAFE_LIMITS[key].setting] = AA.SAFE_LIMITS[key].max;
      });
      AA.save('aaSettings', settings);
      fill('data-s', settings);
      showLimitHints();
      startRun();
    });
    $('aaRisk').addEventListener('click', startRun);
    $('aaRiskNo').addEventListener('click', function() { box.innerHTML = ''; });
  }
  $('aaStop').addEventListener('click', function() {
    AA.stop();
    log('Stopping after the current step…', 'error');
  });

  function confirm_auto() {
    // One-time acknowledgement stored in settings; no window.confirm (it blocks the panel)
    if (settings.autoAcknowledged) return true;
    var box = $('aaConfirm');
    box.innerHTML = '<div class="confirm-box"><h4>Fully automatic mode</h4><div class="hint" style="margin-bottom:8px">The bot will submit real applications under your name without asking. Do a dry run first and check Saved answers. LinkedIn may restrict accounts that apply too fast – keep the delays and a sensible daily limit.</div><div class="row"><button class="btn primary" id="aaAck">I understand, start</button><button class="btn ghost" id="aaAckNo">Cancel</button></div></div>';
    $('aaAck').addEventListener('click', function() {
      settings.autoAcknowledged = true;
      AA.save('aaSettings', settings);
      box.innerHTML = '';
      AA.run();
    });
    $('aaAckNo').addEventListener('click', function() { box.innerHTML = ''; });
    return false;
  }

  // Stop button injected on the page by visual-indicator.js
  chrome.runtime.onMessage.addListener(function(msg) {
    if (msg && msg.type === 'stop_task' && AA.state.running) {
      AA.stop();
      log('Stopped from the page.', 'error');
    }
  });

  // ---------- init ----------
  async function init() {
    // One-time (v0.10): the built-in personal profile is gone and every user goes through the
    // setup screen, so clear the profile stored by older versions. A copy stays in aaProfileBackup.
    var mig = await chrome.storage.local.get(['aaSetupV1', 'aaSetupV2', 'aaSetupV3', 'aaProfile']);
    if (!mig.aaSetupV1) {
      if (mig.aaProfile) await AA.save('aaProfileBackup', mig.aaProfile);
      await chrome.storage.local.remove('aaProfile');
      await AA.save('aaSetupV1', true);
    }
    // One-time (v0.11): start every profile from nothing again, including the v0.10 backup copy
    if (!mig.aaSetupV2) {
      await chrome.storage.local.remove(['aaProfile', 'aaProfileBackup']);
      await AA.save('aaSetupV2', true);
    }
    // One-time (v0.12): clear the profile entered while testing v0.11, so setup starts empty again
    if (!mig.aaSetupV3) {
      await chrome.storage.local.remove(['aaProfile', 'aaProfileBackup']);
      await AA.save('aaSetupV3', true);
    }

    settings = await AA.load('aaSettings', AA.DEFAULT_SETTINGS);
    profile = await AA.load('aaProfile', AA.DEFAULT_PROFILE);

    var locSel = $('aaLocation');
    Object.keys(AA.GEO_IDS).forEach(function(name) {
      var o = document.createElement('option');
      o.value = name; o.textContent = name;
      locSel.appendChild(o);
    });

    // Older versions had one city per site; fold it into the list
    if (!Array.isArray(settings.cities)) settings.cities = [];
    if (!settings.cities.length && (settings.naukriLocation || settings.indeedLocation)) {
      settings.cities = [settings.naukriLocation || settings.indeedLocation];
      settings.naukriLocation = settings.indeedLocation = '';
      AA.save('aaSettings', settings);
    }
    renderCities();

    bind('data-s', function() { return settings; }, 'aaSettings', function(path) { if (LIMIT_RE.test(path)) showLimitHints(); });
    showLimitHints();
    bind('data-p', function() { return profile; }, 'aaProfile');
    bind('data-o', function() { return profile; }, 'aaProfile', setupChanged);
    document.querySelector('[data-s="fitCheck"]').value = String(!!settings.fitCheck);

    // New user (or incomplete profile): the setup screen comes first
    if (missingFields(profile).length) showSetup(true);

    // Never opened yet counts as due, so a new user sees it red right after setup
    helpCheck();

    AA.ui.log = log;
    AA.ui.status = status;
    AA.ui.confirm = confirmSubmit;
    AA.ui.refresh = refresh;
    status('idle');
    refresh();
  }

  init();
})();
