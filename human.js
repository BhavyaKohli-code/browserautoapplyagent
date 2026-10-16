// Human-like input helpers shared by the site scripts (linkedin/indeed/naukri-dom.js).
// Injected before the site file. Page JavaScript cannot move the real OS mouse pointer, so
// the cursor here is a drawn arrow that glides along curved paths while the page receives
// matching mousemove/mouseover events. Text is typed one character at a time with
// keydown/input/keyup and irregular delays instead of setting the whole value at once.
(function() {
  if (window.__humanAA) return;

  var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };
  var rand = function(a, b) { return a + Math.random() * (b - a); };

  var pos = { x: rand(0.3, 0.7) * innerWidth, y: rand(0.3, 0.7) * innerHeight };
  var cursorEl = null;
  var hideTimer = null;

  function cursor() {
    if (cursorEl && cursorEl.isConnected) return cursorEl;
    cursorEl = document.createElement('div');
    cursorEl.id = 'aa-human-cursor';
    cursorEl.style.cssText = 'position:fixed;left:0;top:0;width:18px;height:24px;pointer-events:none;' +
      'z-index:2147483647;transition:opacity .4s;opacity:0;will-change:transform';
    cursorEl.innerHTML = '<svg width="18" height="24" viewBox="0 0 18 24"><path d="M1 1 L1 19 L5.5 14.5 L8.5 22 L11.5 20.8 L8.6 13.5 L15 13.5 Z" ' +
      'fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    (document.body || document.documentElement).appendChild(cursorEl);
    return cursorEl;
  }

  function place(x, y) {
    pos.x = x; pos.y = y;
    var c = cursor();
    c.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    c.style.opacity = '1';
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function() { if (cursorEl) cursorEl.style.opacity = '0'; }, 6000);
  }

  var lastHover = null;
  function emitMove(x, y) {
    var target = document.elementFromPoint(x, y);
    if (!target) return;
    var init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x + screenX, screenY: y + screenY, view: window };
    if (target !== lastHover) {
      if (lastHover) lastHover.dispatchEvent(new MouseEvent('mouseout', Object.assign({ relatedTarget: target }, init)));
      target.dispatchEvent(new MouseEvent('mouseover', Object.assign({ relatedTarget: lastHover }, init)));
      lastHover = target;
    }
    target.dispatchEvent(new PointerEvent('pointermove', Object.assign({ pointerType: 'mouse', isPrimary: true }, init)));
    target.dispatchEvent(new MouseEvent('mousemove', init));
  }

  // Glide from the current position to (x, y) along a curved path with ease-in-out speed,
  // a little jitter, and sometimes a small overshoot that gets corrected.
  async function moveTo(x, y, opts) {
    opts = opts || {};
    x = Math.max(2, Math.min(innerWidth - 2, x));
    y = Math.max(2, Math.min(innerHeight - 2, y));
    var sx = pos.x, sy = pos.y;
    var dist = Math.hypot(x - sx, y - sy);
    if (dist < 2) { place(x, y); return; }
    // Bend the path sideways by up to ~25% of its length
    var nx = -(y - sy) / dist, ny = (x - sx) / dist;
    var bend = rand(-0.25, 0.25) * dist;
    var c1x = sx + (x - sx) * 0.3 + nx * bend, c1y = sy + (y - sy) * 0.3 + ny * bend;
    var c2x = sx + (x - sx) * 0.7 + nx * bend * 0.5, c2y = sy + (y - sy) * 0.7 + ny * bend * 0.5;
    var duration = opts.duration || Math.min(1100, 250 + dist * rand(0.9, 1.6));
    var steps = Math.max(8, Math.round(duration / 16));
    for (var i = 1; i <= steps; i++) {
      var t = i / steps;
      t = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      var u = 1 - t;
      var px = u * u * u * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x;
      var py = u * u * u * sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y;
      if (i < steps) { px += rand(-0.8, 0.8); py += rand(-0.8, 0.8); }
      place(px, py);
      emitMove(px, py);
      await sleep(duration / steps);
    }
    if (dist > 150 && !opts.noOvershoot && Math.random() < 0.3) {
      await moveTo(x + rand(-6, 6), y + rand(-6, 6), { duration: 90, noOvershoot: true });
      await moveTo(x, y, { duration: 110, noOvershoot: true });
    }
  }

  // Move onto an element at a random spot near its centre (scrolls it into view first)
  async function moveToEl(el) {
    if (!el || !el.getBoundingClientRect) return;
    var r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(rand(350, 600));
      r = el.getBoundingClientRect();
    }
    if (!r.width || !r.height) return;
    await moveTo(r.left + r.width * rand(0.35, 0.65), r.top + r.height * rand(0.35, 0.65));
    await sleep(rand(60, 180));
  }

  // Move onto an element, then click it (el.click() is what the sites already respond to)
  async function clickEl(el) {
    await moveToEl(el);
    var r = el.getBoundingClientRect();
    var init = { bubbles: true, cancelable: true, composed: true, clientX: pos.x, clientY: pos.y, view: window, button: 0 };
    if (pos.x >= r.left && pos.x <= r.right && pos.y >= r.top && pos.y <= r.bottom) {
      el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerType: 'mouse', isPrimary: true }, init)));
      el.dispatchEvent(new MouseEvent('mousedown', init));
      await sleep(rand(50, 120));
      el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerType: 'mouse', isPrimary: true }, init)));
      el.dispatchEvent(new MouseEvent('mouseup', init));
    }
    el.click();
  }

  // Drift the cursor around the page for ms milliseconds, like someone reading
  async function wander(ms) {
    var end = Date.now() + (ms || 2000);
    while (Date.now() < end) {
      var r = Math.random();
      if (r < 0.6) {
        await moveTo(pos.x + rand(-180, 180), pos.y + rand(-120, 120));
      } else if (r < 0.8) {
        await moveTo(rand(0.15, 0.85) * innerWidth, rand(0.15, 0.85) * innerHeight);
      } else if (r < 0.9) {
        window.scrollBy({ top: rand(-120, 220), behavior: 'smooth' });
      }
      await sleep(Math.min(Math.max(0, end - Date.now()), rand(250, 1200)));
    }
  }

  // Delay before the next keystroke: faster inside a word, slower after spaces/punctuation,
  // and now and then a longer "thinking" pause. Long answers are typed faster (practised typist).
  function keyDelay(ch, fast) {
    var d = rand(55, 160);
    if (/[\s.,;:!?@\-]/.test(ch)) d += rand(40, 140);
    if (Math.random() < 0.06) d += rand(250, 650);
    return fast ? d * 0.35 : d;
  }

  function keyInfo(ch) {
    var code = /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : /[0-9]/.test(ch) ? 'Digit' + ch : ch === ' ' ? 'Space' : '';
    return { key: ch, code: code, keyCode: ch.toUpperCase().charCodeAt(0), which: ch.toUpperCase().charCodeAt(0), bubbles: true, cancelable: true, composed: true };
  }

  function setValue(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  }

  // Types text into an input, textarea or contenteditable one character at a time.
  // Replaces whatever was there before. Fires change at the end like a real edit.
  async function typeInto(el, text) {
    text = String(text);
    el.focus();
    await sleep(rand(120, 300));
    var editable = el.isContentEditable;

    // Clear the old value (select all + delete)
    var had = editable ? el.innerText : el.value;
    if (had) {
      if (editable) {
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
      } else {
        try { el.select(); } catch (e) {}
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8, bubbles: true }));
        setValue(el, '');
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Backspace', code: 'Backspace', keyCode: 8, bubbles: true }));
      }
      await sleep(rand(150, 300));
    }

    // Build the value from our own buffer: number inputs read back "" for partial values like "3."
    var typed = '';
    var fast = text.length > 60;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      var k = keyInfo(ch);
      el.dispatchEvent(new KeyboardEvent('keydown', k));
      el.dispatchEvent(new KeyboardEvent('keypress', Object.assign({}, k, { charCode: ch.charCodeAt(0) })));
      if (editable) {
        document.execCommand('insertText', false, ch);
      } else {
        el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: ch, inputType: 'insertText' }));
        typed += ch;
        setValue(el, typed);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      }
      await sleep(rand(20, 70));
      el.dispatchEvent(new KeyboardEvent('keyup', k));
      await sleep(keyDelay(ch, fast));
    }

    // Number inputs and some React fields reject partial values; make sure the end result is right
    if (editable) {
      if (el.innerText.replace(/\s+/g, ' ').trim() !== text.replace(/\s+/g, ' ').trim()) {
        el.innerText = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      }
    } else if (el.value !== text) {
      setValue(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (!editable) el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Current cursor position, so the orchestrator's real (debugger) mouse can start from it
  function cursorPos() { return { x: Math.round(pos.x), y: Math.round(pos.y) }; }

  window.__humanAA = {
    moveTo: moveTo,
    moveToEl: moveToEl,
    clickEl: clickEl,
    wander: wander,
    typeInto: typeInto,
    cursorPos: cursorPos,
    place: place
  };
})();
