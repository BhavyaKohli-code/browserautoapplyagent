// Auto Apply orchestrator for LinkedIn Easy Apply, Indeed "Easily apply" and Naukri. Runs inside the
// side panel page (which, unlike the MV3 service worker, stays alive for long runs and can
// call Ollama directly).
//
// Flow per site: search URL -> for each job: open, (optional AI fit check), open the apply form ->
// for each step: read questions, answer from saved answers / profile rules / local LLM,
// fill, Next/Continue -> Submit (depending on mode) -> record result -> human-ish delay.
(function() {
  var OLLAMA_URL = 'http://localhost:11434';

  var GEO_IDS = {
    'India': '102713980',
    'Worldwide': '92000000',
    'United States': '103644278',
    'United Kingdom': '101165590',
    'Canada': '101174742',
    'Germany': '101282230',
    'Netherlands': '102890719',
    'Spain': '105646813',
    'United Arab Emirates': '104305776',
    'Singapore': '102454443',
    'Australia': '101452733'
  };

  var DEFAULT_SETTINGS = {
    keywords: 'Generative AI Engineer\nAI Engineer\nLLM Engineer',
    location: 'India',
    customGeoId: '',
    workType: { onsite: true, remote: true, hybrid: true },
    datePosted: 'r604800',
    experience: { '2': true, '3': true, '4': true },
    excludeTitle: 'senior staff, principal, director, head of, intern',
    excludeCompanies: '',
    mode: 'confirm', // dry | confirm | auto
    maxApplications: 20,
    minDelay: 8,
    maxDelay: 20,
    fitCheck: false,
    sites: 'linkedin', // linkedin | indeed | naukri | both (LinkedIn + Indeed) | all
    cities: [], // searched one by one on every site; "Remote" = remote jobs; empty = whole country
    indeedLocation: '', // older single-city fields, moved into cities on first load
    naukriLocation: ''
  };

  var DEFAULT_PROFILE = {
    firstName: '', lastName: '', email: '', phone: '', city: '', country: 'India',
    currentTitle: '', currentCompany: '', dob: '', totalYears: '', skills: '',
    currentCtc: '', expectedCtc: '', salaryCurrency: 'INR', noticeDays: '30',
    workAuthorized: 'Yes', needSponsorship: 'No', willingRelocate: 'Yes', onsiteOk: 'Yes',
    linkedinUrl: '', githubUrl: '', portfolioUrl: '',
    gender: '', postalCode: '', streetAddress: '', // only used when a form requires them
    education: '', notes: '', resumeText: '',
    minSkillYears: '3' // any "years of experience with X" answer is at least this
  };
  // Personal defaults from profile-default.js (loaded before this file)
  Object.assign(DEFAULT_PROFILE, window.AA_DEFAULT_PROFILE || {});

  var state = {
    running: false,
    stop: false,
    tabId: null,
    formTabId: null,
    site: null,
    settings: null,
    profile: null,
    applied: 0,
    skipped: 0,
    pendingConfirm: null
  };

  // ---------- storage ----------
  async function load(key, def) {
    var r = await chrome.storage.local.get(key);
    if (r[key] === undefined) return JSON.parse(JSON.stringify(def));
    if (def && typeof def === 'object' && !Array.isArray(def)) {
      // Stored values win, except empty strings, which fall back to the defaults
      var merged = JSON.parse(JSON.stringify(def));
      Object.keys(r[key]).forEach(function(k) { if (r[key][k] !== '') merged[k] = r[key][k]; });
      return merged;
    }
    return r[key];
  }
  function save(key, val) { var o = {}; o[key] = val; return chrome.storage.local.set(o); }

  function normLabel(s) {
    return (s || '').toLowerCase().replace(/\*/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };

  // ---------- UI hooks (set by sidepanel) ----------
  var ui = {
    log: function() {},
    status: function() {},
    confirm: function() { return Promise.resolve('skip'); },
    refresh: function() {}
  };

  // ---------- sites ----------
  // Each site has a page-helper file exposing the same functions under its own namespace.
  // LinkedIn applies in a modal on the search tab; Indeed applies in a separate smartapply tab.
  var INDEED_DOMAINS = {
    'India': 'in.indeed.com', 'United States': 'www.indeed.com', 'United Kingdom': 'uk.indeed.com',
    'Canada': 'ca.indeed.com', 'Germany': 'de.indeed.com', 'Netherlands': 'nl.indeed.com',
    'Spain': 'es.indeed.com', 'United Arab Emirates': 'ae.indeed.com', 'Singapore': 'sg.indeed.com',
    'Australia': 'au.indeed.com', 'Worldwide': 'www.indeed.com'
  };

  var SITES = {
    linkedin: {
      name: 'LinkedIn', file: 'linkedin-dom.js', ns: '__liAA', applyInNewTab: false,
      tabQuery: 'https://www.linkedin.com/*', home: 'https://www.linkedin.com/jobs/',
      seenKey: function(id) { return id; },
      jobUrl: function(id) { return 'https://www.linkedin.com/jobs/view/' + id + '/'; },
      searchUrl: async function(s, k, city) {
        if (isRemote(city)) return buildSearchUrl(s, k, null, true);
        return buildSearchUrl(s, k, city ? await linkedinGeoId(city) : null, false);
      }
    },
    indeed: {
      name: 'Indeed', file: 'indeed-dom.js', ns: '__inAA', applyInNewTab: true, trustedClicks: true, pageByUrl: true,
      tabQuery: 'https://*.indeed.com/*',
      seenKey: function(id) { return 'indeed:' + id; },
      jobUrl: function(id, s) { return 'https://' + indeedDomain(s) + '/viewjob?jk=' + id; },
      searchUrl: function(s, k, city) { return buildIndeedUrl(s, k, city); }
    },
    // Naukri: each job opens in its own tab; applying happens there through a chatbot
    // (applyNaukri) instead of a form with a Submit step.
    naukri: {
      name: 'Naukri', file: 'naukri-dom.js', ns: '__nkAA', applyInNewTab: true, chatApply: true,
      tabQuery: 'https://www.naukri.com/*', home: 'https://www.naukri.com/',
      seenKey: function(id) { return 'naukri:' + id; },
      jobUrl: function(id) { return 'https://www.naukri.com/job-listings-' + id; },
      searchUrl: function(s, k, city) { return buildNaukriUrl(s, k, city); }
    }
  };

  function siteFor(url) {
    if (/linkedin\.com/.test(url)) return SITES.linkedin;
    if (/indeed\.com/.test(url)) return SITES.indeed;
    if (/naukri\.com/.test(url)) return SITES.naukri;
    return state.site;
  }

  // ---------- tab / page calls ----------
  async function ensureHelpers(tabId, site) {
    var r = await chrome.scripting.executeScript({ target: { tabId: tabId }, func: function(ns) { return !!window[ns] && !!window.__humanAA; }, args: [site.ns] });
    if (!r[0].result) {
      // human.js first: the site file uses its cursor and typing helpers
      await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['human.js', site.file] });
    }
  }

  // Let the cursor drift around the tab for ms milliseconds (between applications)
  async function wanderOn(tabId, ms) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function(t) { return window.__humanAA ? window.__humanAA.wander(t) : null; },
        args: [ms]
      });
    } catch (e) {
      await sleep(ms);
    }
  }

  // Runs window.<ns>[name](...args) in a tab. Retries while the tab is mid-navigation
  // (Indeed's apply steps and result pages are full page loads).
  async function callOn(tabId, name, args) {
    var tab = await chrome.tabs.get(tabId);
    var site = siteFor(tab.url || '');
    var lastErr;
    for (var attempt = 0; attempt < 4; attempt++) {
      try {
        await ensureHelpers(tabId, site);
        var r = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: function(ns, n, a) { return window[ns][n].apply(null, a); },
          args: [site.ns, name, args]
        });
        return r[0].result;
      } catch (e) {
        lastErr = e;
        await sleep(800);
        await waitForLoad(tabId);
      }
    }
    throw lastErr;
  }

  // Search-results tab
  async function call(name) { return callOn(state.tabId, name, Array.prototype.slice.call(arguments, 1)); }
  // Tab holding the application form (same as the search tab on LinkedIn)
  async function formCall(name) { return callOn(state.formTabId, name, Array.prototype.slice.call(arguments, 1)); }

  async function waitForLoad(tabId) {
    for (var i = 0; i < 60; i++) {
      var t;
      try { t = await chrome.tabs.get(tabId); } catch (e) { return; }
      if (t.status === 'complete') return;
      await sleep(250);
    }
  }

  async function getSiteTab(site) {
    var tabs = await chrome.tabs.query({ url: site.tabQuery, currentWindow: true });
    tabs = tabs.filter(function(t) { return !/smartapply\.|\/job-listings-|\/myapply\//.test(t.url || ''); });
    if (tabs.length) return tabs[0].id;
    var t = await chrome.tabs.create({ url: site.home || 'about:blank', active: true });
    await waitForLoad(t.id);
    return t.id;
  }

  // Pause while the site shows a CAPTCHA / verification: the user solves it, never the bot
  async function waitForHuman(tabId, siteName) {
    var st = await callOn(tabId, 'pageStatus', []);
    if (!st.checkpoint) return;
    ui.log(siteName + ' is asking for a human verification. Please complete it in the tab – waiting up to 3 minutes…', 'error');
    try { await chrome.tabs.update(tabId, { active: true }); } catch (e) {}
    for (var i = 0; i < 90 && !state.stop; i++) {
      await sleep(2000);
      st = await callOn(tabId, 'pageStatus', []);
      if (!st.checkpoint) { ui.log('Verification done, continuing.', 'info'); return; }
    }
    throw new Error(siteName + ' verification was not completed.');
  }

  function isRemote(city) { return /^\s*(remote|work from home|wfh)\s*$/i.test(city || ''); }

  // LinkedIn ignores city names in search URLs; it needs the city's geoId. Its public location
  // typeahead (no login needed) gives it; results are cached.
  async function linkedinGeoId(city) {
    var key = city.trim().toLowerCase();
    var cache = await load('aaGeoCache', {});
    if (cache[key]) return cache[key];
    try {
      var res = await fetch('https://www.linkedin.com/jobs-guest/api/typeaheadHits?typeaheadType=GEO' +
        '&geoTypes=POPULATED_PLACE,ADMIN_DIVISION_2,MARKET_AREA,COUNTRY_REGION&query=' + encodeURIComponent(city.trim()));
      var hits = res.ok ? await res.json() : [];
      if (hits.length && hits[0].id) {
        cache[key] = hits[0].id;
        await save('aaGeoCache', cache);
        return hits[0].id;
      }
    } catch (e) {}
    ui.log('LinkedIn does not know the city "' + city + '" – searching the whole country instead.', 'error');
    return null;
  }

  // Indeed has one site per country and none for "Worldwide" (www.indeed.com is the US site):
  // Worldwide / unknown -> the Indeed site of the country in your Profile
  function indeedDomain(settings) {
    if (settings.location && settings.location !== 'Worldwide' && INDEED_DOMAINS[settings.location]) return INDEED_DOMAINS[settings.location];
    var country = state.profile && state.profile.country;
    return (country && country !== 'Worldwide' && INDEED_DOMAINS[country]) || 'in.indeed.com';
  }

  function buildIndeedUrl(settings, keyword, city) {
    var domain = indeedDomain(settings);
    var p = new URLSearchParams();
    p.set('q', keyword);
    p.set('l', isRemote(city) ? 'Remote' : (city || '').trim());
    p.set('iafilter', '1'); // "Easily apply" only
    var days = { r86400: '1', r604800: '7', r2592000: '14' }[settings.datePosted];
    if (days) p.set('fromage', days);
    var wt = settings.workType;
    if (isRemote(city) || (wt.remote && !wt.onsite && !wt.hybrid)) p.set('sc', '0kf:attr(DSQF7);');
    p.set('sort', 'date');
    return 'https://' + domain + '/jobs?' + p.toString();
  }

  // naukri.com/<keyword>-jobs-in-<city>?k=..&l=..&experience=N&jobAge=D&wfhType=..
  function buildNaukriUrl(settings, keyword, city) {
    var slug = function(x) { return x.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); };
    var remote = isRemote(city);
    var loc = remote ? '' : (city || '').trim();
    var p = new URLSearchParams();
    p.set('k', keyword);
    if (loc) p.set('l', loc);
    var yrs = Math.floor(parseFloat(state.profile && state.profile.totalYears));
    if (!isNaN(yrs)) p.set('experience', String(yrs)); // jobs whose experience range includes yours
    var days = { r86400: '1', r604800: '7', r2592000: '30' }[settings.datePosted];
    if (days) p.set('jobAge', days);
    var wt = remote ? { remote: true } : settings.workType, w = [];
    if (wt.onsite) w.push('0');
    if (wt.remote) w.push('2');
    if (wt.hybrid) w.push('3');
    if (w.length && w.length < 3) w.forEach(function(x) { p.append('wfhType', x); });
    return 'https://www.naukri.com/' + slug(keyword) + '-jobs' + (loc ? '-in-' + slug(loc) : '') + '?' + p.toString();
  }

  function buildSearchUrl(settings, keyword, cityGeoId, remoteOnly) {
    var geo = cityGeoId || settings.customGeoId.trim() || GEO_IDS[settings.location] || GEO_IDS.India;
    var p = new URLSearchParams();
    // LinkedIn's AI search drops f_WT (and f_E) from the URL, but understands "remote" in the
    // query: "<keyword> remote" returns only remote jobs (verified Oct 2026)
    var wtOnlyRemote = remoteOnly || (settings.workType.remote && !settings.workType.onsite && !settings.workType.hybrid);
    p.set('keywords', wtOnlyRemote && !/\bremote\b/i.test(keyword) ? keyword + ' remote' : keyword);
    p.set('geoId', geo);
    p.set('f_AL', 'true');
    if (settings.datePosted) p.set('f_TPR', settings.datePosted);
    var wt = [];
    if (remoteOnly) wt.push('2');
    else {
      if (settings.workType.onsite) wt.push('1');
      if (settings.workType.remote) wt.push('2');
      if (settings.workType.hybrid) wt.push('3');
    }
    if (wt.length && wt.length < 3) p.set('f_WT', wt.join(','));
    var ex = Object.keys(settings.experience).filter(function(k) { return settings.experience[k]; });
    if (ex.length && ex.length < 6) p.set('f_E', ex.join(','));
    p.set('sortBy', 'DD');
    return 'https://www.linkedin.com/jobs/search-results/?' + p.toString();
  }

  // ---------- Ollama ----------
  function currentModel() {
    var el = document.getElementById('model');
    return (el && el.value) || 'qwen2.5:7b-instruct';
  }

  async function ollamaJSON(system, user, schema) {
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 120000);
    try {
      var res = await fetch(OLLAMA_URL + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: currentModel(),
          stream: false,
          keep_alive: '30m',
          // Qwen3 "thinks" by default: ~10x more tokens per answer, minutes per form on a laptop CPU
          think: false,
          format: schema,
          options: { temperature: 0, num_ctx: 4096 },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
        }),
        signal: controller.signal
      });
      if (!res.ok) throw new Error('Ollama HTTP ' + res.status);
      var data = await res.json();
      return JSON.parse(data.message.content);
    } finally {
      clearTimeout(timeout);
    }
  }

  function profileText(p) {
    var lines = [
      'Name: ' + p.firstName + ' ' + p.lastName,
      'Email: ' + p.email,
      'Phone: ' + p.phone,
      'Location: ' + p.city + ', ' + p.country,
      'Current title: ' + p.currentTitle + (p.currentCompany ? ' at ' + p.currentCompany : ''),
      'Total professional experience (years): ' + p.totalYears,
      'Skills with years of experience: ' + p.skills,
      'Highest education: ' + p.education,
      'Current CTC / salary (yearly, ' + p.salaryCurrency + '): ' + p.currentCtc,
      'Expected CTC / salary (yearly, ' + p.salaryCurrency + '): ' + p.expectedCtc,
      'Notice period (days): ' + p.noticeDays,
      'Authorized to work in ' + p.country + ': ' + p.workAuthorized,
      'Needs visa sponsorship: ' + p.needSponsorship,
      'Willing to relocate: ' + p.willingRelocate,
      'Comfortable working on-site / hybrid: ' + p.onsiteOk,
      'LinkedIn: ' + p.linkedinUrl,
      'GitHub: ' + p.githubUrl,
      'Portfolio: ' + p.portfolioUrl
    ];
    if (parseFloat(p.minSkillYears)) lines.push('Minimum years of experience to state for ANY skill, tool or domain: ' + p.minSkillYears);
    if (p.notes) lines.push('Other facts: ' + p.notes);
    var out = lines.join('\n');
    if (p.resumeText) out += '\n\nRESUME (excerpt):\n' + p.resumeText.slice(0, 5000);
    return out;
  }

  var ANSWER_SYSTEM = 'You fill out job application forms on behalf of the candidate described below. ' +
    'Answer every question as the candidate, using only their facts. ' +
    'Rules: (1) Be truthful - never invent degrees, certifications, clearances or employers. ' +
    '(2) For "years of experience with X" (any skill, tool or domain): answer the candidate\'s minimum skill years given in the profile, or more if the skills list says more. Never answer less. ' +
    '(3) For yes/no "do you have experience / worked with / know X" about any skill, tool or domain, answer Yes. ' +
    '(4) Numeric questions get a plain number only, no units. If a salary question uses a different currency or period than the profile, convert approximately (1 EUR ≈ 95 INR, 1 USD ≈ 88 INR, 1 GBP ≈ 112 INR). ' +
    '(5) Text answers: short and direct, one line unless a paragraph is clearly expected. ' +
    '(6) Never invent URLs, usernames, phone numbers, emails, dates of birth, ID or document numbers. ' +
    '(7) For questions about availability on a date or joining, use the notice period and today\'s date. ' +
    'Reply with JSON only.';

  function expectsNumber(field) {
    if (field.kind === 'number') return true;
    var l = field.label.toLowerCase();
    if (/invalid input|whole number|decimal number|enter a number|numeric/i.test(field.error || '')) return true;
    if (field.kind !== 'text') return false;
    return /how many|years? of|number of|\bctc\b|salary|compensation|notice period.*(day|week|month)|in days|\blpa\b|lakhs?|amount|\brate\b|percentage|\bgpa\b|\bcgpa\b|score|how much/.test(l);
  }

  // The form rejected a decimal ("Invalid input" on LinkedIn, "whole number" elsewhere) -> 3.5 becomes 4
  function fixNumberForError(field, ans) {
    if (field.error && /invalid|whole|integer|number/i.test(field.error) && /^\d+\.\d+$/.test(String(ans))) {
      return String(Math.round(parseFloat(ans)));
    }
    return ans;
  }

  async function answerWithLLM(field, profile, job, extraHint) {
    var schema;
    var q = 'QUESTION: ' + field.label;
    if (field.context && field.kind !== 'text') q += '\nCONTEXT: ' + field.context.slice(0, 300);
    if (field.options && field.options.length) {
      var opts = field.options.slice(0, 60);
      q += '\nOPTIONS (pick exactly as written): ' + opts.join(' | ');
      if (field.kind === 'checkboxes') {
        schema = { type: 'object', properties: { answers: { type: 'array', items: { type: 'string', enum: opts } } }, required: ['answers'] };
      } else {
        schema = { type: 'object', properties: { answer: { type: 'string', enum: opts } }, required: ['answer'] };
      }
    } else if (expectsNumber(field)) {
      q += '\nAnswer with a number only.';
      schema = { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] };
    } else {
      if (field.maxLength) q += '\nMaximum length: ' + field.maxLength + ' characters.';
      schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    }
    if (field.error) q += '\nThe form rejected the previous answer with: "' + field.error + '". Fix it.';
    if (extraHint) q += '\n' + extraHint;

    var user = 'TODAY: ' + new Date().toDateString() +
      '\n\nCANDIDATE PROFILE:\n' + profileText(profile) +
      '\n\nJOB: ' + job.title + ' at ' + job.company +
      '\n\n' + q;
    var out = await ollamaJSON(ANSWER_SYSTEM, user, schema);
    var ans = field.kind === 'checkboxes' ? out.answers : out.answer;
    if (typeof ans === 'number') ans = Number.isInteger(ans) ? String(ans) : String(Math.round(ans * 10) / 10);
    if (typeof ans === 'string' && !(field.options && field.options.length) && isExperienceYears(field.label)) ans = atLeastMinYears(ans, profile);
    ans = fixNumberForError(field, ans);
    if (typeof ans === 'string' && field.maxLength) ans = ans.slice(0, field.maxLength);
    return ans;
  }

  async function checkFit(profile, job, description) {
    var system = 'You screen job postings for a candidate. Decide if the candidate is a reasonable match ' +
      '(role type, seniority within ~2 years of their experience, core skills overlap). Be lenient. Reply JSON.';
    var user = 'CANDIDATE:\nTitle: ' + profile.currentTitle + '\nExperience: ' + profile.totalYears + ' years\nSkills: ' +
      profile.skills + '\n' + (profile.resumeText ? profile.resumeText.slice(0, 1500) : '') +
      '\n\nJOB: ' + job.title + ' at ' + job.company + '\n' + (description || '').slice(0, 2500);
    return ollamaJSON(system, user, {
      type: 'object',
      properties: { fit: { type: 'boolean' }, reason: { type: 'string' } },
      required: ['fit', 'reason']
    });
  }

  // ---------- rule-based answers ----------
  function pickOption(options, re) {
    for (var i = 0; i < options.length; i++) if (re.test(options[i])) return options[i];
    return null;
  }

  function yesNo(field, val) {
    if (!val) return null;
    var yes = /^y/i.test(val);
    if (field.options && field.options.length) return pickOption(field.options, yes ? /^yes\b|^sí\b|^si\b/i : /^no\b/i);
    if (field.kind === 'text') return yes ? 'Yes' : 'No';
    return null;
  }

  function parseSkills(s) {
    var map = {};
    (s || '').split(/[,;\n]/).forEach(function(part) {
      var m = part.match(/^\s*(.+?)\s*[:=\-]\s*(\d+(?:\.\d+)?)\s*(?:y|yr|yrs|years?)?\s*$/i);
      if (m) map[m[1].toLowerCase()] = m[2];
    });
    return map;
  }

  function numberOnly(v) {
    var m = String(v || '').replace(/,/g, '').match(/\d+(\.\d+)?/);
    return m ? m[0] : '';
  }

  var INR_PER = { INR: 1, USD: 88, EUR: 95, GBP: 112, AED: 24 };
  var CURRENCY_RE = { INR: /\binr\b|₹|rupee|\blpa\b|lakh|\bctc\b/, USD: /\busd\b|\$|dollar/, EUR: /\beur\b|€|euro/, GBP: /\bgbp\b|£|pound/, AED: /\baed\b|dirham/ };

  function salaryFor(field, raw, currency) {
    var n = parseFloat(numberOnly(raw));
    if (!n) return null;
    var l = field.label.toLowerCase();
    // Question asks in a different currency than the profile -> convert (approximate rates)
    var mine = (currency || 'INR').toUpperCase();
    if (!(CURRENCY_RE[mine] && CURRENCY_RE[mine].test(l))) {
      for (var cur in CURRENCY_RE) {
        if (cur !== mine && CURRENCY_RE[cur].test(l)) {
          n = n * (INR_PER[mine] || 1) / INR_PER[cur];
          n = n >= 1000 ? Math.round(n / 100) * 100 : n; // tidy round number
          break;
        }
      }
    }
    // Questions asking in lakhs/LPA want e.g. 12, not 1200000
    if (/\blpa\b|lakh|lac\b/.test(l) && n >= 1000) n = n / 100000;
    if (/per month|\/ ?month|monthly|\bpm\b/.test(l)) n = n / 12;
    n = n >= 1000 ? Math.round(n / 100) * 100 : Math.round(n * 100) / 100;
    return String(n);
  }

  // ---- numbers inside dropdown/radio options ("14 - 15 LPA", "3 years", "10+", "Less than 1") ----
  function optionRange(o) {
    var t = o.toLowerCase().replace(/,/g, '');
    if (/immediate|fresher|^none$|^no experience/.test(t)) return [0, 0];
    var nums = (t.match(/\d+(\.\d+)?/g) || []).map(parseFloat);
    if (!nums.length) return null;
    if (/less than|below|under|upto|up to|<|max/.test(t)) return [-Infinity, nums[0]];
    if (/\+|more than|above|over|greater|or more|>|min/.test(t) && nums.length === 1) return [nums[0], Infinity];
    if (nums.length >= 2) return [nums[0], nums[1]];
    return [nums[0], nums[0]];
  }

  function pickNumericOption(options, n) {
    var best = null, bestDist = Infinity;
    for (var i = 0; i < options.length; i++) {
      var r = optionRange(options[i]);
      if (!r) continue;
      var d = n < r[0] ? r[0] - n : n > r[1] ? n - r[1] : 0;
      // ties go to the lower option (3.5 years -> "3 years", not "4 years")
      if (d < bestDist) { best = options[i]; bestDist = d; }
    }
    return best;
  }

  function pickNoticeOption(options, days) {
    var inDays = options.map(function(o) {
      var r = optionRange(o);
      if (!r || /serving/i.test(o)) return null;
      var mult = /month/i.test(o) ? 30 : /week/i.test(o) ? 7 : 1;
      return [r[0] * mult, r[1] * mult];
    });
    var best = null, bestDist = Infinity;
    inDays.forEach(function(r, i) {
      if (!r) return;
      var d = days < r[0] ? r[0] - days : days > r[1] ? days - r[1] : 0;
      if (d < bestDist) { best = options[i]; bestDist = d; }
    });
    return best;
  }

  function hasNumericOptions(options) {
    return (options || []).filter(function(o) { return optionRange(o); }).length >= 2;
  }

  // ---- dates ----
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function formatDate(d, field) {
    var ph = (field.placeholder || '').toLowerCase();
    if (field.kind === 'date' || /yyyy-mm-dd/.test(ph)) return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    if (/mm\/dd\/yyyy/.test(ph)) return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + '/' + d.getFullYear();
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
  }
  function joinDate(p) {
    var d = new Date();
    d.setDate(d.getDate() + (parseInt(p.noticeDays, 10) || 0));
    return d;
  }

  // "How many years of experience with X" style questions
  var EXPERIENCE_YEARS_RE = /years?.{0,20}experience|experience.{0,20}years?|how many years|^(total|overall|relevant|professional|work) .{0,15}experience/;
  function isExperienceYears(label) {
    var l = (label || '').toLowerCase();
    return EXPERIENCE_YEARS_RE.test(l) && !/months/.test(l);
  }

  // Never state less than the profile's minimum skill years (default 3) for anything
  function atLeastMinYears(v, p) {
    var floor = parseFloat(p.minSkillYears) || 0;
    var n = parseFloat(numberOnly(v));
    if (!floor || isNaN(n) || n >= floor) return v;
    return String(floor);
  }

  // Personal data the LLM must never make up: only the profile may answer these
  var PERSONAL_RE = /date of birth|\bdob\b|birth ?date|aadhaa?r|\bpan\b|passport|social security|\bssn\b|national id|linkedin|github|portfolio|website|\burl\b|e-?mail|phone|mobile|whatsapp|postal|zip ?code|\bpin ?code|street|address|house (no|number)/;

  // Demographic questions: never answered by the AI (decline option, or your Profile, or skip)
  var EEO_RE = /gender|\bsex\b|race|ethnic|hispanic|latino|veteran|disabilit|sexual orientation|pronoun|transgender/;

  // A country named in the question that is not yours ("authorized to work in the United States")
  var COUNTRY_RE = /\b(united states|u\.s\.a?\.?|usa|america|canada|united kingdom|\buk\b|england|ireland|germany|france|netherlands|spain|europe|european union|\beu\b|australia|new zealand|singapore|uae|united arab emirates|dubai|saudi|qatar|japan|india)\b/;
  function foreignCountryIn(l, p) {
    // "in the US" / "within the US" (plain "us" elsewhere is the pronoun: "tell us")
    l = l.replace(/\b(in|within|the|for) us\b/g, '$1 united states');
    var m = l.match(COUNTRY_RE);
    if (!m) return false;
    var mine = (p.country || 'India').toLowerCase();
    var c = m[1].replace(/\./g, '');
    var alias = { 'us': 'united states', 'usa': 'united states', 'usa ': 'united states', 'america': 'united states', 'uk': 'united kingdom', 'england': 'united kingdom', 'uae': 'united arab emirates', 'dubai': 'united arab emirates' };
    c = alias[c] || c;
    return c !== mine;
  }

  function ruleAnswer(field, p) {
    // "Please select your total years of experience:" -> "total years of experience"
    var l = field.label.toLowerCase()
      .replace(/^(please |kindly )?(select|enter|mention|provide|specify|share|state|confirm)( your| the)?\s+/, '')
      .replace(/^(what is|what's|what are) (your|the) /, '')
      .replace(/[\s:.?*]+$/, '').trim();
    var kind = field.kind;
    var hasOpts = field.options && field.options.length;

    // Notice-period options mix units ("15 Days or less", "1 Month", "3 Months") -> compare in days
    if ((kind === 'select' || kind === 'radio') && hasOpts && /notice/.test(l) && p.noticeDays &&
        field.options.some(function(o) { return /month|week/i.test(o); })) {
      var noticeOpt = pickNoticeOption(field.options, parseFloat(p.noticeDays));
      if (noticeOpt) return noticeOpt;
    }

    // Dropdowns/radios whose options are numeric ranges: work out the number with the text rules,
    // then pick the matching range (e.g. 14 LPA -> "14 - 15 LPA", 3.5 years -> "3 years")
    if ((kind === 'select' || kind === 'radio') && hasNumericOptions(field.options) &&
        /salary|ctc|compensation|package|lpa|experience|years?|notice|months?/.test(l)) {
      var asText = ruleAnswer({ label: field.label + (/lpa|lakh/i.test(field.options.join(' ')) ? ' (LPA)' : ''), kind: 'text', required: true }, p);
      var num = parseFloat(numberOnly(asText));
      if (!isNaN(num)) {
        var hit = pickNumericOption(field.options, num);
        if (hit) return hit;
      }
    }

    // EEO / demographic questions -> decline if possible, else your Profile, else nothing (skip job)
    if (EEO_RE.test(l) && hasOpts) {
      var dec = pickOption(field.options, /decline|prefer not|don.?t wish|do not wish|not to (say|disclose|answer|identify)|rather not|choose not/i);
      if (dec) return dec;
      if (/veteran/.test(l)) {
        var nv = pickOption(field.options, /not a (protected )?veteran|i am not a veteran|^no\b/i);
        if (nv) return nv;
      }
      if (/gender|\bsex\b/.test(l) && p.gender) {
        var g = pickOption(field.options, new RegExp('^' + p.gender.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
        if (g) return g;
      }
    }

    if (kind === 'checkbox') {
      if (/agree|consent|terms|privacy|confirm|acknowledge|certify|accept|declare/.test(l + ' ' + (field.options || []).join(' ').toLowerCase())) return true;
      if (field.required) return true;
      return null;
    }

    if (kind === 'text' || kind === 'typeahead' || kind === 'number' || kind === 'date') {
      if (/first name/.test(l)) return p.firstName || null;
      if (/last name|surname|family name/.test(l)) return p.lastName || null;
      if (/full name|^name$|your name/.test(l)) return (p.firstName + ' ' + p.lastName).trim() || null;
      if (/e-?mail/.test(l)) return p.email || null;
      if (/phone|mobile|contact number/.test(l)) return p.phone || null;
      if (/linkedin/.test(l)) return p.linkedinUrl || null;
      if (/github/.test(l)) return p.githubUrl || null;
      if (/portfolio|website|personal (site|url)/.test(l)) return p.portfolioUrl || p.githubUrl || null;
      if (/^(city|location|current location)|where are you (currently )?(based|located)|current city/.test(l)) return p.city || null;
      if (/date of birth|\bdob\b|birth ?date/.test(l)) return p.dob || null;
      if (/postal|zip ?code|\bpin ?code/.test(l)) return p.postalCode || null;
      if (/street|address|house (no|number)/.test(l) && !/e-?mail/.test(l)) return p.streetAddress || null;
      if (/last working day|joining date|date of joining|start date|join(ing)? by|available (to|from)|earliest (start|joining)|when can you (join|start)/.test(l) && !/how many|days/.test(l)) {
        return formatDate(joinDate(p), field);
      }
      if (/additional months|months of experience|experience.{0,20}months/.test(l) && !/years/.test(l)) {
        var yrs = parseFloat(p.totalYears) || 0;
        return String(Math.round((yrs - Math.floor(yrs)) * 12));
      }
      if (/current (company|employer|organi[sz]ation)|present (company|employer)/.test(l)) return (p.currentCompany || '') || null;
      if (/notice/.test(l)) {
        if (!p.noticeDays) return null;
        if (/month/.test(l)) return String(Math.round(parseFloat(p.noticeDays) / 30 * 10) / 10);
        if (/week/.test(l)) return String(Math.round(parseFloat(p.noticeDays) / 7));
        return expectsNumber(field) || /day/.test(l) ? numberOnly(p.noticeDays) : p.noticeDays + ' days';
      }
      if (/(current|present|last|existing).{0,15}(ctc|salary|compensation|package)|^ctc/.test(l)) return salaryFor(field, p.currentCtc, p.salaryCurrency);
      if (/(expected|desired|expectation).{0,15}(ctc|salary|compensation|package)|salary expectation/.test(l)) return salaryFor(field, p.expectedCtc, p.salaryCurrency);
      if (/years?.{0,20}experience|experience.{0,20}years?|how many years|^(total|overall|relevant|professional|work) .{0,15}experience/.test(l)) {
        var skills = parseSkills(p.skills);
        var mentioned = Object.keys(skills).filter(function(s) {
          return s.length > 1 && new RegExp('(^|[^a-z0-9+#])' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9+#])').test(l);
        });
        if (mentioned.length) return atLeastMinYears(skills[mentioned.sort(function(a, b) { return b.length - a.length; })[0]], p);
        // Skill/domain-specific ("... experience with Kubernetes?") and not in the skills list -> LLM decides
        // Only clearly generic questions get total experience; "years of startup/Java/... experience" -> LLM
        var generic = /^(how many |total |overall )?(years of )?(total |overall |professional |relevant |work |full[- ]time |industry )*(work )?experience( in years)?( do you (currently )?have)?\??$/;
        var generic2 = /^how many years of (total |overall |professional |relevant |work )*(work )?experience do you (currently )?have\??$/;
        if (generic.test(l) || generic2.test(l) || /^(total|overall) (years of )?experience/.test(l)) return numberOnly(p.totalYears) || null;
        // Any other skill / tool / domain: the minimum skill years (default 3), never less
        return parseFloat(p.minSkillYears) ? String(parseFloat(p.minSkillYears)) : null;
      }
    }

    // "Can you join within 15 days?" / "Are you an immediate joiner?" -> compare with the notice period
    var within = l.match(/(join|start|available).{0,25}?(within|in|before) (\d+) (day|week|month)/);
    if (within && p.noticeDays) {
      var limit = parseInt(within[3], 10) * ({ day: 1, week: 7, month: 30 })[within[4]];
      return yesNo(field, parseInt(p.noticeDays, 10) <= limit ? 'Yes' : 'No');
    }
    if (/immediate(ly)? (joiner|join|available)|join immediately/.test(l) && p.noticeDays) {
      return yesNo(field, parseInt(p.noticeDays, 10) <= 7 ? 'Yes' : 'No');
    }

    // "Do you have experience with X?" / "Have you worked on X?" -> Yes, unless it asks for more
    // years than the candidate states (minimum skill years or total experience, whichever is more)
    if ((kind === 'radio' || kind === 'select') && hasOpts && pickOption(field.options, /^yes\b/i) &&
        /experience|worked (with|on|in)|hands.?on|exposure|familiar|proficien|knowledge of|skilled in/.test(l) &&
        /^(do|have|are|did|can) you|^(any )?(prior |previous )?experience/.test(l)) {
      var need = l.match(/(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs)/);
      var have = Math.max(parseFloat(p.minSkillYears) || 0, parseFloat(p.totalYears) || 0);
      if (!need || parseFloat(need[1]) <= have) return yesNo(field, 'Yes');
    }

    if (kind === 'radio' || kind === 'select') {
      // Resume picker: options are file names -> LinkedIn lists the most recent first
      if (hasOpts && field.options.every(function(o) { return /\.(pdf|docx?)\b/i.test(o); })) return field.options[0];
      // Work authorization / sponsorship for ANOTHER country than yours -> not authorized, needs sponsorship
      var foreign = foreignCountryIn(l, p);
      if (/sponsor/.test(l)) return yesNo(field, foreign ? 'Yes' : p.needSponsorship);
      if (/authori[sz]ed|legally (allowed|eligible|able|permitted)|right to work|work permit|eligible to work/.test(l)) return yesNo(field, foreign ? 'No' : p.workAuthorized);
      if (/relocat/.test(l)) return yesNo(field, p.willingRelocate);
      if (/commut|on-?site|in.office|hybrid|work from (the )?office|in person/.test(l)) return yesNo(field, p.onsiteOk);
      if (/background check|drug (test|screen)|18 years|eighteen/.test(l)) return yesNo(field, 'Yes');
      if (/country code/.test(l) && hasOpts) return pickOption(field.options, new RegExp('^' + (p.country || 'India')));
      if (/e-?mail/.test(l) && hasOpts) return pickOption(field.options, new RegExp(p.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    }
    return null;
  }

  function shouldAnswer(field) {
    if (field.kind === 'file') return false; // resume is chosen on LinkedIn already
    if (/^follow\b/i.test(field.label) || (field.options && field.options.length === 1 && /^follow\b/i.test(field.options[0]))) return false;
    var empty = Array.isArray(field.value) ? field.value.length === 0 : !field.value;
    if (!empty && !field.error) return false;
    if (field.required || field.error) return true;
    // Optional: answer radios/selects (cheap, often "soft required"), skip optional free text
    if (field.kind === 'radio' || field.kind === 'select') return true;
    if (/cover letter|summary|headline|message to (the )?hiring/i.test(field.label)) return false;
    return false;
  }

  // Resolve one field: saved answer -> profile rule -> LLM
  async function resolveAnswer(field, profile, answers, job, forceLLM) {
    var key = normLabel(field.label) + '|' + field.kind;
    var r = ruleAnswer(field, profile);
    var hasRule = r !== null && r !== undefined && r !== '';
    if (!forceLLM && !field.error) {
      var saved = answers[key];
      // Answers you edited yourself always win; otherwise profile rules beat cached AI guesses
      if (saved !== undefined && (saved.source === 'you' || !hasRule)) {
        if (!field.options || !field.options.length || [].concat(saved.answer).every(function(a) {
          return field.options.some(function(o) { return o.toLowerCase().indexOf(String(a).toLowerCase()) >= 0; });
        })) return { answer: saved.answer, source: 'saved' };
      }
      if (hasRule) return { answer: r, source: 'profile' };
    } else if (hasRule) {
      // Rejected by the form: a decimal that must be whole (3.5 -> 4) is fixed without the LLM
      var fixed = fixNumberForError(field, r);
      if (fixed !== r) return { answer: fixed, source: 'profile' };
    }
    if (EEO_RE.test(field.label.toLowerCase())) {
      throw new Error('"' + field.label + '" has no "prefer not to say" option (set Gender in your Profile if you want it answered)');
    }
    // (Only free-text fields: a Yes/No "Do you have a portfolio?" is fine for the LLM)
    if (!(field.options && field.options.length) && PERSONAL_RE.test(field.label.toLowerCase())) {
      throw new Error('no profile value for "' + field.label + '" (the AI is not allowed to guess personal data – add it to your Profile)');
    }
    var a = await answerWithLLM(field, profile, job);
    answers[key] = { label: field.label, kind: field.kind, answer: a, options: field.options || null, source: 'ai', ts: Date.now() };
    return { answer: a, source: 'ai' };
  }

  // ---------- opening / closing the application form ----------
  async function openForm(details) {
    if (!state.site.applyInNewTab) {
      state.formTabId = state.tabId;
      return call('openEasyApply');
    }
    if (!details.applyUrl) return { ok: false, message: 'No apply link' };
    var t = await chrome.tabs.create({ url: details.applyUrl, active: true });
    state.formTabId = t.id;
    await waitForLoad(t.id);
    for (var i = 0; i < 30; i++) {
      await sleep(500);
      var st;
      try { st = await formCall('pageStatus'); } catch (e) { continue; }
      if (st.alreadyApplied) { await finishForm(); return { ok: false, message: 'Already applied' }; }
      if (st.checkpoint) { await waitForHuman(state.formTabId, state.site.name); continue; }
      if (st.onForm && /\/form\//.test(st.url)) return { ok: true };
    }
    await finishForm();
    return { ok: false, message: 'Apply page did not load' };
  }

  // Abandon the application (LinkedIn: Discard the draft; Indeed: close the apply tab)
  async function discardForm() {
    if (!state.site.applyInNewTab) return call('discardApplication');
    return finishForm();
  }

  // Close whatever is left of the application and go back to the results
  async function finishForm() {
    if (!state.site.applyInNewTab) { try { await call('closeAllDialogs'); } catch (e) {} return; }
    if (state.formTabId && state.formTabId !== state.tabId) {
      var id = state.formTabId;
      // After real clicks Indeed arms a "Leave site?" prompt; the debugger auto-accepts it
      if (state.site.trustedClicks) { try { await dbgAttach(id); } catch (e) {} }
      try { await chrome.tabs.remove(id); } catch (e) {}
      await dbgDetach(id);
    }
    state.formTabId = state.tabId;
    try { await chrome.tabs.update(state.tabId, { active: true }); } catch (e) {}
  }

  // ---------- real mouse clicks (chrome.debugger) ----------
  // Indeed ignores element.click() on its Continue/Submit buttons, so for sites marked
  // trustedClicks we press the button with real input events, like Playwright/Puppeteer do.
  // While attached, the browser shows a "started debugging this browser" bar.
  var attached = {};

  async function dbgAttach(tabId) {
    if (attached[tabId]) return;
    await chrome.debugger.attach({ tabId: tabId }, '1.3');
    attached[tabId] = true;
    await chrome.debugger.sendCommand({ tabId: tabId }, 'Page.enable');
    // Attaching shows the browser's "started debugging" bar, which shifts the page down.
    // Let the layout settle before anything measures button positions.
    await sleep(1200);
  }

  async function dbgDetach(tabId) {
    if (!attached[tabId]) return;
    delete attached[tabId];
    try { await chrome.debugger.detach({ tabId: tabId }); } catch (e) {}
  }

  if (chrome.debugger) {
    chrome.debugger.onEvent.addListener(function(src, method, params) {
      if (method !== 'Page.javascriptDialogOpening' || !attached[src.tabId]) return;
      // Leave-page prompts and alerts: accept. Confirms/prompts: cancel (never agree blindly).
      var accept = params.type === 'beforeunload' || params.type === 'alert';
      chrome.debugger.sendCommand({ tabId: src.tabId }, 'Page.handleJavaScriptDialog', { accept: accept }).catch(function() {});
    });
    chrome.debugger.onDetach.addListener(function(src) { delete attached[src.tabId]; });
  }

  // Glide the real mouse from the page's drawn cursor (or a random point) to (x, y) along a curve
  async function trustedMove(tabId, x, y) {
    var t = { tabId: tabId };
    var from = null;
    try {
      var r = await chrome.scripting.executeScript({ target: { tabId: tabId }, func: function() { return window.__humanAA ? window.__humanAA.cursorPos() : null; } });
      from = r[0].result;
    } catch (e) {}
    if (!from) from = { x: x + (Math.random() - 0.5) * 400, y: y + (Math.random() - 0.5) * 300 };
    var dist = Math.hypot(x - from.x, y - from.y);
    var bend = (Math.random() - 0.5) * 0.5 * dist;
    var nx = dist ? -(y - from.y) / dist : 0, ny = dist ? (x - from.x) / dist : 0;
    var cx = (from.x + x) / 2 + nx * bend, cy = (from.y + y) / 2 + ny * bend;
    var steps = Math.max(10, Math.min(40, Math.round(dist / 15)));
    for (var i = 1; i <= steps; i++) {
      var p = i / steps;
      p = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      var px = (1 - p) * (1 - p) * from.x + 2 * (1 - p) * p * cx + p * p * x;
      var py = (1 - p) * (1 - p) * from.y + 2 * (1 - p) * p * cy + p * p * y;
      await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(px), y: Math.round(py) });
      await sleep(10 + Math.random() * 20);
    }
    // Keep the drawn cursor where the real mouse ended up
    try {
      await chrome.scripting.executeScript({ target: { tabId: tabId }, func: function(a, b) { if (window.__humanAA) window.__humanAA.place(a, b); }, args: [x, y] });
    } catch (e) {}
  }

  async function trustedClick(tabId, x, y) {
    await dbgAttach(tabId);
    var t = { tabId: tabId };
    await trustedMove(tabId, x, y);
    await sleep(60 + Math.random() * 120);
    await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: x, y: y, button: 'left', clickCount: 1 });
    await sleep(40 + Math.random() * 80);
    await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: x, y: y, button: 'left', clickCount: 1 });
  }

  // Short alert sound in the side panel so you notice the robot check
  function beep() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.35].forEach(function(at) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 880; g.gain.value = 0.15;
        o.connect(g); g.connect(ctx.destination);
        o.start(ctx.currentTime + at); o.stop(ctx.currentTime + at + 0.2);
      });
    } catch (e) {}
  }

  // Indeed's "I'm not a robot" checkbox: the bot never touches it. It shows you the tab and waits
  // (up to 3 minutes) until you have ticked it and Submit is enabled - or you submitted yourself.
  async function waitForRobotCheck() {
    ui.log('  ✋ Indeed wants a human check: tick "I\'m not a robot" in the tab (the bot submits right after).', 'error');
    try {
      var tab = await chrome.tabs.update(state.formTabId, { active: true });
      if (tab && tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    } catch (e) {}
    beep();
    for (var i = 0; i < 180 && !state.stop; i++) {
      await sleep(1000);
      if (i === 60 || i === 120) beep();
      var st;
      try { st = await formCall('submitState'); } catch (e) { continue; }
      if (st.submitted) return 'submitted';
      if (st.submit && !st.disabled) { ui.log('  Thanks – submitting.', 'info'); return 'ready'; }
    }
    return 'timeout';
  }

  // Press Next/Continue/Review/Submit. Returns { ok, clicked: 'next'|'submit'|'submit-ready' }
  async function pressPrimary(allowSubmit) {
    if (!state.site.trustedClicks) return formCall('clickPrimary', allowSubmit);
    await dbgAttach(state.formTabId); // before measuring: attaching moves the page
    var t = await formCall('primaryTarget', allowSubmit);
    if (t.clicked === 'needs-human') {
      var human = await waitForRobotCheck();
      if (human === 'submitted') return { ok: true, clicked: 'submit' };
      if (human !== 'ready') return { ok: false, clicked: null, message: 'Robot check ("I\'m not a robot") was not completed within 3 minutes' };
      t = await formCall('primaryTarget', allowSubmit);
      if (t.clicked === 'needs-human') return { ok: false, clicked: null, message: 'Submit stayed disabled after the robot check' };
    }
    if (!t.ok || t.clicked === 'submit-ready') return t;
    await trustedClick(state.formTabId, t.x, t.y);
    return t;
  }

  // After Submit: wait for the confirmation page. If none appears and the Submit button is
  // still there, the click did not register (nothing was sent) - press it again.
  async function confirmSubmitted() {
    var done = { ok: false, message: 'No confirmation seen' };
    for (var attempt = 0; attempt < 3; attempt++) {
      try { done = await formCall('waitForSubmitted'); } catch (e) { done = { ok: false, message: e.message }; }
      if (done.ok || !state.site.trustedClicks) return done;
      var t;
      try { t = await formCall('primaryTarget', true); } catch (e) { return done; }
      if (t.clicked === 'needs-human') {
        // The robot check appeared only after the first Submit
        var human = await waitForRobotCheck();
        if (human === 'submitted') continue;
        if (human !== 'ready') return { ok: false, message: 'Robot check ("I\'m not a robot") was not completed within 3 minutes' };
        try { t = await formCall('primaryTarget', true); } catch (e) { return done; }
      }
      if (!t.ok || t.clicked !== 'submit') return done;
      ui.log('  Submit did not register, clicking it again…');
      await trustedClick(state.formTabId, t.x, t.y);
    }
    return done;
  }

  // After Next/Continue: wait until the step actually changes (or the form shows errors)
  async function waitForStepChange(oldProgress) {
    for (var i = 0; i < 30; i++) {
      await sleep(500);
      if (state.site.applyInNewTab) await waitForLoad(state.formTabId);
      var f;
      try { f = await formCall('readForm'); } catch (e) { continue; }
      if (!f.open || f.progress !== oldProgress) return;
      if (f.fields.some(function(x) { return x.error; })) return;
    }
  }

  // ---------- one application ----------
  async function applyToJob(job, details, profile, settings, answers) {
    var qa = [];
    var opened = await openForm(details);
    if (!opened.ok) return { status: 'skipped', reason: opened.message, qa: qa };

    var lastProgress = null;
    var sameCount = 0;

    for (var page = 0; page < 20; page++) {
      if (state.stop) { await discardForm(); return { status: 'stopped', reason: 'Stopped by user', qa: qa }; }
      await sleep(900);
      if (state.site.applyInNewTab) { await waitForLoad(state.formTabId); await waitForHuman(state.formTabId, state.site.name); }
      var form = await formCall('readForm');
      if (!form.open) { await finishForm(); return { status: 'unknown', reason: 'Form closed unexpectedly', qa: qa }; }

      // Stuck on the same page twice -> force LLM on errored fields; three times -> give up
      if (form.progress !== null && form.progress === lastProgress) sameCount++; else sameCount = 0;
      lastProgress = form.progress;
      if (sameCount >= 3) {
        var bad = form.fields.filter(function(f) { return f.error; }).map(function(f) { return f.label + ' (' + f.error + ')'; });
        await discardForm();
        return { status: 'skipped', reason: 'Could not complete: ' + (bad.join('; ') || 'form would not advance'), qa: qa };
      }

      for (var i = 0; i < form.fields.length; i++) {
        var f = form.fields[i];
        if (!shouldAnswer(f)) continue;
        var res;
        try {
          res = await resolveAnswer(f, profile, answers, job, sameCount > 0 && !!f.error);
        } catch (e) {
          ui.log('  ✗ "' + f.label.slice(0, 60) + '": ' + e.message, 'error');
          continue;
        }
        var fill = await formCall('fillField', f.key, f.kind, res.answer);
        var shown = Array.isArray(res.answer) ? res.answer.join(', ') : String(res.answer);
        ui.log('  ' + f.label.slice(0, 70) + ' → ' + shown.slice(0, 60) + ' [' + res.source + ']' + (fill.ok ? '' : ' ✗ ' + fill.message), fill.ok ? 'qa' : 'error');
        qa.push({ q: f.label, a: shown, source: res.source });
        if (!fill.ok && res.source !== 'ai') {
          // Saved/profile answer did not fit this form -> ask the LLM instead
          try {
            var retry = await answerWithLLM(f, profile, job, 'The answer "' + shown + '" did not match the form.');
            await formCall('fillField', f.key, f.kind, retry);
            ui.log('  ↳ retried → ' + String(retry).slice(0, 60) + ' [ai]', 'qa');
          } catch (e) {}
        }
      }
      await save('aaAnswers', answers);

      var allowSubmit = settings.mode === 'auto';
      var click = await pressPrimary(allowSubmit);
      if (!click.ok) {
        await discardForm();
        return { status: 'skipped', reason: click.message, qa: qa };
      }

      if (click.clicked === 'submit-ready') {
        if (settings.mode === 'dry') {
          await discardForm();
          return { status: 'dry-run', reason: 'Reached Submit (dry run, discarded)', qa: qa };
        }
        // confirm mode
        var decision = await ui.confirm(job, qa);
        if (decision === 'submit') {
          var c2 = await pressPrimary(true);
          if (c2.clicked !== 'submit') { await discardForm(); return { status: 'skipped', reason: 'Submit button vanished', qa: qa }; }
        } else if (decision === 'manual') {
          await finishForm();
          return { status: 'applied', reason: 'Submitted manually', qa: qa };
        } else {
          await discardForm();
          return { status: 'skipped', reason: decision === 'stop' ? 'Stopped by user' : 'Skipped by you', qa: qa };
        }
        var done = await confirmSubmitted();
        await finishForm();
        return { status: done.ok ? 'applied' : 'unknown', reason: done.ok ? '' : done.message, qa: qa };
      }
      if (click.clicked === 'submit') {
        var ok = await confirmSubmitted();
        await finishForm();
        return { status: ok.ok ? 'applied' : 'unknown', reason: ok.ok ? '' : ok.message, qa: qa };
      }
      await waitForStepChange(form.progress);
    }
    await discardForm();
    return { status: 'skipped', reason: 'Too many pages', qa: qa };
  }

  // ---------- Naukri (chatbot apply) ----------
  // Naukri has no review step: pressing Apply either applies at once or opens a chatbot whose
  // last answer submits. So "dry run" never presses Apply, and "ask me" asks before pressing it.
  // Leaving the chatbot (closing the tab) before the last answer means nothing is submitted.
  var NAUKRI_KIND = { chips: 'radio', radio: 'radio', checkboxes: 'checkboxes', text: 'text' };

  // Naukri confirms a successful apply by navigating to /myapply/saveApply?strJobsarr=[id]
  async function onNaukriConfirmation() {
    try { return /naukri\.com\/myapply\/saveApply/i.test((await chrome.tabs.get(state.formTabId)).url || ''); }
    catch (e) { return false; }
  }

  async function waitChat(oldStep, seconds) {
    var st = { state: 'waiting' };
    for (var i = 0; i < seconds * 2 && !state.stop; i++) {
      await sleep(500);
      if (await onNaukriConfirmation()) return { state: 'success' };
      try { st = await formCall('readChat'); } catch (e) { continue; }
      if (st.state === 'success' || st.state === 'quota') return st;
      if (st.state === 'chat' && st.kind !== 'none' && st.step !== oldStep) return st;
    }
    return st;
  }

  async function applyNaukri(job, details, profile, settings, answers) {
    var qa = [];
    if (!details.applyUrl) return { status: 'skipped', reason: 'No job link', qa: qa };
    var t = await chrome.tabs.create({ url: details.applyUrl, active: true });
    state.formTabId = t.id;
    await waitForLoad(t.id);

    var js = null;
    for (var i = 0; i < 20; i++) {
      await sleep(500);
      try { js = await formCall('jobStatus'); } catch (e) { continue; }
      if (js.status !== 'none') break;
    }
    await waitForHuman(state.formTabId, 'Naukri');
    if (js && js.status === 'login') { await finishForm(); throw new Error('You are logged out of Naukri. Log in, then press Start again.'); }
    if (js && js.quota) { await finishForm(); throw new Error('Naukri says the daily apply limit is reached.'); }
    var why = !js || js.status === 'none' ? 'No Apply button on the job page'
      : js.status === 'applied' ? 'Already applied'
      : js.status === 'company' ? 'Applies on the company website (not on Naukri)' : '';
    if (why) { await finishForm(); return { status: 'skipped', reason: why, qa: qa }; }

    if (settings.fitCheck) {
      try {
        var fit = await checkFit(profile, job, js.description);
        if (!fit.fit) { await finishForm(); return { status: 'skipped', reason: 'AI fit check: ' + fit.reason, qa: qa }; }
        ui.log('  Fit: ' + fit.reason, 'info');
      } catch (e) { ui.log('  Fit check failed (' + e.message + '), applying anyway', 'error'); }
    }

    if (settings.mode === 'dry') {
      await finishForm();
      return { status: 'dry-run', reason: 'Naukri Apply button found – not pressed (Naukri submits on click)', qa: qa };
    }
    if (settings.mode === 'confirm') {
      var decision = await ui.confirm(job, qa, {
        action: 'Apply',
        note: 'Naukri submits as soon as Apply is pressed, or when its chatbot\'s last question is answered. ' +
          'Chatbot questions are answered automatically from your profile, saved answers and the local AI.'
      });
      if (decision === 'manual') { await finishForm(); return { status: 'applied', reason: 'Applied manually', qa: qa }; }
      if (decision !== 'submit') {
        await finishForm();
        return { status: 'skipped', reason: decision === 'stop' ? 'Stopped by user' : 'Skipped by you', qa: qa };
      }
    }

    var c = await formCall('clickApply', false);
    if (!c.ok) { await finishForm(); return { status: 'skipped', reason: c.message, qa: qa }; }
    var st = await waitChat(null, 6);
    if (st.state === 'waiting' && !state.stop) {
      // The page ignored the script click -> press Apply with a real mouse click
      await dbgAttach(state.formTabId);
      var pos = await formCall('clickApply', true);
      if (pos.ok) await trustedClick(state.formTabId, pos.x, pos.y);
      st = await waitChat(null, 10);
    }

    var lastStep = null, sameCount = 0;
    for (var n = 0; n < 30; n++) {
      if (state.stop) { await finishForm(); return { status: 'stopped', reason: 'Stopped by user (chatbot left unfinished, nothing submitted)', qa: qa }; }
      if (st.state === 'success') { await finishForm(); return { status: 'applied', reason: '', qa: qa }; }
      if (st.state === 'quota') { await finishForm(); throw new Error('Naukri says the daily apply limit is reached.'); }
      if (st.state !== 'chat' || st.kind === 'none') {
        if (await onNaukriConfirmation()) { await finishForm(); return { status: 'applied', reason: '', qa: qa }; }
        await finishForm();
        return { status: 'unknown', reason: 'No confirmation or chatbot question after Apply', qa: qa };
      }

      if (st.step === lastStep) sameCount++; else sameCount = 0;
      lastStep = st.step;
      if (sameCount >= 2) {
        await finishForm();
        return { status: 'skipped', reason: 'Chatbot did not accept an answer to "' + st.question.slice(0, 80) + '" (left unfinished, nothing submitted)', qa: qa };
      }

      var field = {
        key: 'chat', kind: NAUKRI_KIND[st.kind] || 'text', label: st.question, options: st.options || null,
        required: true, value: '', context: st.context || '', placeholder: st.placeholder || '',
        error: sameCount > 0 ? 'The chatbot did not accept the previous answer' : ''
      };
      var res;
      try {
        res = await resolveAnswer(field, profile, answers, job, sameCount > 0);
      } catch (e) {
        if (st.canSkip) {
          ui.log('  ✗ "' + st.question.slice(0, 60) + '": ' + e.message + ' – skipping the question', 'error');
          await formCall('answerChat', 'chips', 'Skip');
          st = await waitChat(st.step, 15);
          continue;
        }
        await finishForm();
        return { status: 'skipped', reason: e.message + ' (chatbot left unfinished, nothing submitted)', qa: qa };
      }
      var fill = await formCall('answerChat', st.kind, res.answer);
      var shown = Array.isArray(res.answer) ? res.answer.join(', ') : String(res.answer);
      ui.log('  ' + st.question.slice(0, 70) + ' → ' + shown.slice(0, 60) + ' [' + res.source + ']' + (fill.ok ? '' : ' ✗ ' + fill.message), fill.ok ? 'qa' : 'error');
      qa.push({ q: st.question, a: shown, source: res.source });
      if (!fill.ok && res.source !== 'ai') {
        try {
          var retry = await answerWithLLM(field, profile, job, 'The answer "' + shown + '" did not match the options.');
          await formCall('answerChat', st.kind, retry);
          ui.log('  ↳ retried → ' + String(retry).slice(0, 60) + ' [ai]', 'qa');
        } catch (e) {}
      }
      await save('aaAnswers', answers);
      st = await waitChat(st.step, 15);
    }
    await finishForm();
    return { status: 'skipped', reason: 'Too many chatbot questions (left unfinished)', qa: qa };
  }

  // ---------- main loop ----------
  function listFromCsv(s) {
    return (s || '').split(/[,\n]/).map(function(x) { return x.trim().toLowerCase(); }).filter(Boolean);
  }

  async function recordResult(job, result, history, seen) {
    var site = state.site;
    history.unshift({
      id: job.id, site: site.name, url: job.url || site.jobUrl(job.id, state.settings), title: job.title, company: job.company,
      status: result.status, reason: result.reason || '', qa: result.qa || [], ts: Date.now()
    });
    if (history.length > 500) history.length = 500;
    if (result.status === 'applied' || result.status === 'skipped') seen[site.seenKey(job.id)] = result.status;
    await save('aaHistory', history);
    await save('aaSeen', seen);
    ui.refresh();
  }

  async function run() {
    if (state.running) return;
    var settings = await load('aaSettings', DEFAULT_SETTINGS);
    var profile = await load('aaProfile', DEFAULT_PROFILE);
    var answers = await load('aaAnswers', {});
    var history = await load('aaHistory', []);
    var seen = await load('aaSeen', {});
    if (!Array.isArray(settings.cities)) settings.cities = [];
    if (!settings.cities.length && (settings.naukriLocation || settings.indeedLocation)) {
      settings.cities = [settings.naukriLocation || settings.indeedLocation];
      settings.naukriLocation = settings.indeedLocation = '';
      await save('aaSettings', settings);
    }
    state.settings = settings;
    state.profile = profile;

    // One-time cleanup (v0.7): AI-made answers for things profile rules now handle - salary,
    // URLs, dates, contact data - were sometimes wrong (e.g. "140 - 145 LPA"); drop them.
    var mig = await chrome.storage.local.get('aaMigratedV07');
    if (!mig.aaMigratedV07) {
      var dropped = 0;
      Object.keys(answers).forEach(function(k) {
        var a = answers[k];
        if (a && a.source === 'ai' && /salary|ctc|compensation|package|lpa|linkedin|github|portfolio|website|url|birth|dob|last working|joining|start date|notice|experience|email|phone/i.test(a.label)) {
          delete answers[k];
          dropped++;
        }
      });
      await save('aaAnswers', answers);
      await save('aaMigratedV07', true);
      if (dropped) ui.log('Cleaned ' + dropped + ' AI answers that profile rules now handle.', 'info');
    }

    // One-time fix (v0.8.1): Naukri applications that went through but were logged as "unknown"
    // because the confirmation page (/myapply/saveApply) was not recognised
    var mig81 = await chrome.storage.local.get('aaMigratedV081');
    if (!mig81.aaMigratedV081) {
      var fixed = 0;
      history.forEach(function(h) {
        if (h.site === 'Naukri' && h.status === 'unknown' && /No confirmation or chatbot question after Apply/.test(h.reason || '')) {
          h.status = 'applied';
          h.reason = 'Applied (confirmation page detected later)';
          seen['naukri:' + h.id] = 'applied';
          fixed++;
        }
      });
      await save('aaHistory', history);
      await save('aaSeen', seen);
      await save('aaMigratedV081', true);
      if (fixed) { ui.log('Corrected ' + fixed + ' earlier Naukri applications from "unknown" to "applied".', 'info'); ui.refresh(); }
    }

    if (!profile.firstName || !profile.totalYears) {
      ui.log('Fill in at least your name and total years of experience in the Profile section first.', 'error');
      return;
    }

    var siteKeys = settings.sites === 'both' ? ['linkedin', 'indeed']
      : settings.sites === 'all' ? ['linkedin', 'indeed', 'naukri']
      : [SITES[settings.sites] ? settings.sites : 'linkedin'];

    state.running = true;
    state.stop = false;
    state.applied = 0;
    state.skipped = 0;
    ui.status('running');

    try {
      ui.log('Warming up ' + currentModel() + '…', 'info');
      try { await ollamaJSON('Reply JSON.', 'Say ok', { type: 'object', properties: { ok: { type: 'boolean' } } }); }
      catch (e) { throw new Error('Ollama not reachable: ' + e.message); }

      for (var s = 0; s < siteKeys.length && !state.stop; s++) {
        state.site = SITES[siteKeys[s]];
        try {
          await runSite(settings, profile, answers, history, seen);
        } catch (e) {
          ui.log(state.site.name + ' stopped: ' + e.message, 'error');
        } finally {
          if (state.tabId) { try { await chrome.tabs.sendMessage(state.tabId, { type: 'HIDE_AGENT_ACTIVE' }); } catch (e) {} }
        }
      }
      ui.log('Finished. ' + state.applied + ' ' + (settings.mode === 'dry' ? 'dry runs' : 'applied') + ', ' + state.skipped + ' skipped.', 'done');
    } catch (e) {
      ui.log('Stopped: ' + e.message, 'error');
    } finally {
      state.running = false;
      ui.status('idle');
    }
  }

  // Applies on one site until its quota (Max applications is per site) is reached
  async function runSite(settings, profile, answers, history, seen) {
    var site = state.site;
    var excludeTitle = listFromCsv(settings.excludeTitle);
    var excludeCompanies = listFromCsv(settings.excludeCompanies);
    var keywords = settings.keywords.split('\n').map(function(x) { return x.trim(); }).filter(Boolean);
    var target = parseInt(settings.maxApplications, 10) || 10;
    var done = 0;

    ui.log('── ' + site.name + ' ──', 'job');
    state.tabId = await getSiteTab(site);
    state.formTabId = state.tabId;
    await chrome.tabs.update(state.tabId, { active: true });

    var cities = (settings.cities || []).map(function(c) { return String(c).trim(); }).filter(Boolean);
    // City by city: all keywords in the first city (e.g. Remote), then all keywords in the next...
    var searches = [];
    (cities.length ? cities : ['']).forEach(function(city) {
      keywords.forEach(function(kw) { searches.push({ keyword: kw, city: city }); });
    });

    for (var k = 0; k < searches.length; k++) {
      if (state.stop || done >= target) return;
      var url = await site.searchUrl(settings, searches[k].keyword, searches[k].city);
      ui.log('Searching: "' + searches[k].keyword + '"' + (searches[k].city ? ' in ' + searches[k].city : ''), 'info');
      await chrome.tabs.update(state.tabId, { url: url });
      await waitForLoad(state.tabId);
      await sleep(3000);

      for (var resultsPage = 0; resultsPage < 10; resultsPage++) {
        try { await chrome.tabs.sendMessage(state.tabId, { type: 'SHOW_AGENT_ACTIVE' }); } catch (e) {}
        await waitForHuman(state.tabId, site.name);
        var status = await call('pageStatus');
        if (status.loggedOut) throw new Error('You are logged out of ' + site.name + '. Log in, then press Start again.');
        if (status.dialogOpen) await call('discardApplication');

        var cards = await call('listCards');
        if (!cards.length) { ui.log('No results on this page.', 'info'); break; }

        for (var c = 0; c < cards.length; c++) {
          if (state.stop || done >= target) return;
          var job = cards[c];
          if (job.applied || seen[site.seenKey(job.id)]) continue;
          var tl = job.title.toLowerCase();
          var bannedWord = excludeTitle.find(function(w) { return tl.indexOf(w) >= 0; });
          if (bannedWord) { ui.log('Skip "' + job.title + '" (title has "' + bannedWord + '")', 'skip'); continue; }
          if (excludeCompanies.some(function(w) { return job.company.toLowerCase().indexOf(w) >= 0; })) {
            ui.log('Skip ' + job.company + ' (excluded company)', 'skip');
            continue;
          }

          ui.log('▶ ' + job.title + ' — ' + job.company, 'job');
          await call('selectCard', job.id);
          var details = await call('getJobDetails');
          if (!details.hasEasyApply) {
            ui.log('  No quick-apply button (already applied or external site).', 'skip');
            seen[site.seenKey(job.id)] = 'skipped';
            continue;
          }

          if (settings.fitCheck && !site.chatApply) { // Naukri checks fit on the job page
            try {
              var fit = await checkFit(profile, job, details.description);
              if (!fit.fit) {
                ui.log('  Not a fit: ' + fit.reason, 'skip');
                await recordResult(job, { status: 'skipped', reason: 'AI fit check: ' + fit.reason }, history, seen);
                continue;
              }
              ui.log('  Fit: ' + fit.reason, 'info');
            } catch (e) { ui.log('  Fit check failed (' + e.message + '), applying anyway', 'error'); }
          }

          var result;
          try {
            result = site.chatApply ? await applyNaukri(job, details, profile, settings, answers)
              : await applyToJob(job, details, profile, settings, answers);
          } catch (e) {
            result = { status: 'skipped', reason: 'Error: ' + e.message, qa: [] };
            try { await discardForm(); } catch (e2) {}
          }

          if (result.status === 'stopped') return;
          if (result.status === 'applied' || result.status === 'dry-run') { state.applied++; done++; }
          else state.skipped++;
          ui.log('  ' + result.status.toUpperCase() + (result.reason ? ': ' + result.reason : ''), result.status === 'applied' || result.status === 'dry-run' ? 'done' : 'skip');
          await recordResult(job, result, history, seen);
          ui.status('running');

          if (done >= target) return;
          var delay = (parseFloat(settings.minDelay) || 5) + Math.random() * Math.max(0, (parseFloat(settings.maxDelay) || 10) - (parseFloat(settings.minDelay) || 5));
          ui.log('  waiting ' + Math.round(delay) + 's…', 'info');
          // Move the cursor around in chunks so Stop still reacts within a couple of seconds
          var waitUntil = Date.now() + delay * 1000;
          while (Date.now() < waitUntil && !state.stop) {
            var chunk = Math.min(2000, waitUntil - Date.now());
            if (Math.random() < 0.75) await wanderOn(state.tabId, chunk);
            else await sleep(chunk);
          }
        }

        // Next page of results: Indeed through a link; LinkedIn and Naukri by clicking Next in the page
        if (site.pageByUrl) {
          var nx = await call('nextPageUrl');
          if (!nx.url) break;
          await chrome.tabs.update(state.tabId, { url: nx.url });
          await waitForLoad(state.tabId);
          await sleep(2500);
        } else {
          var nxt = await call('nextResultsPage');
          if (!nxt.ok) break;
          await sleep(2000);
        }
        ui.log('Next results page…', 'info');
      }
    }
  }

  function stop() {
    state.stop = true;
    if (state.pendingConfirm) state.pendingConfirm('stop');
  }

  window.AutoApply = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    DEFAULT_PROFILE: DEFAULT_PROFILE,
    GEO_IDS: GEO_IDS,
    state: state,
    ui: ui,
    load: load,
    save: save,
    run: run,
    stop: stop,
    buildSearchUrl: buildSearchUrl,
    buildIndeedUrl: buildIndeedUrl,
    buildNaukriUrl: buildNaukriUrl,
    // exported for testing
    _ruleAnswer: ruleAnswer,
    _resolveAnswer: resolveAnswer,
    _answerWithLLM: answerWithLLM,
    _expectsNumber: expectsNumber,
    _indeedDomain: indeedDomain,
    _linkedinGeoId: linkedinGeoId
  };
})();
