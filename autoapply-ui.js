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

  function bind(attr, objGetter, storageKey) {
    document.querySelectorAll('[' + attr + ']').forEach(function(el) {
      var path = el.getAttribute(attr);
      var v = getPath(objGetter(), path);
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v === undefined || v === null ? '' : String(v);
      el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', function() {
        var val = el.type === 'checkbox' ? el.checked : el.value;
        if (path === 'fitCheck') val = val === 'true';
        setPath(objGetter(), path, val);
        AA.save(storageKey, objGetter());
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

  // ---------- resume upload ----------
  $('aaResumeFile').addEventListener('change', async function() {
    var f = this.files[0];
    this.value = '';
    if (!f) return;
    try {
      var text = await window.extractFileText(f);
      text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      profile.resumeText = text;
      document.querySelector('[data-p="resumeText"]').value = text;
      await AA.save('aaProfile', profile);
      log('Resume loaded (' + text.length + ' characters).', 'done');
    } catch (e) {
      log('Could not read resume: ' + e.message, 'error');
    }
  });

  $('aaClearSkipped').addEventListener('click', async function() {
    var seen = await AA.load('aaSeen', {});
    Object.keys(seen).forEach(function(k) { if (seen[k] !== 'applied') delete seen[k]; });
    await AA.save('aaSeen', seen);
    log('Skipped jobs will be retried on the next run.', 'info');
  });

  // ---------- start / stop ----------
  $('aaStart').addEventListener('click', function() {
    if (settings.mode === 'auto' && !confirm_auto()) return;
    $('aaConfirm').innerHTML = '';
    AA.run();
  });
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
    settings = await AA.load('aaSettings', AA.DEFAULT_SETTINGS);
    profile = await AA.load('aaProfile', AA.DEFAULT_PROFILE);

    var locSel = $('aaLocation');
    Object.keys(AA.GEO_IDS).forEach(function(name) {
      var o = document.createElement('option');
      o.value = name; o.textContent = name;
      locSel.appendChild(o);
    });

    bind('data-s', function() { return settings; }, 'aaSettings');
    bind('data-p', function() { return profile; }, 'aaProfile');
    document.querySelector('[data-s="fitCheck"]').value = String(!!settings.fitCheck);

    // First run: open the profile section so it gets filled in
    if (!profile.firstName) {
      $('secProfile').open = true;
      log('First time? Open "Profile", fill it in and upload your resume. Then run a Dry run.', 'info');
    }

    AA.ui.log = log;
    AA.ui.status = status;
    AA.ui.confirm = confirmSubmit;
    AA.ui.refresh = refresh;
    status('idle');
    refresh();
  }

  init();
})();
