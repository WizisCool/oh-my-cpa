// Landing page behaviour: theme, language preference, copy buttons, install tabs, and the
// scripted stories that replay the console. The page is complete without it: every story is
// rendered in its finished state, and each block below only replays or enhances that markup.
(function () {
  document.documentElement.classList.add('is-ready');
  var THEME_KEY = 'omc-site-theme';
  var schemeMeta = document.querySelector('meta[name="color-scheme"]');
  var systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var phone = window.matchMedia('(max-width: 640px)');

  function read(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function write(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (error) {
      // Storage can be blocked; the choice then lasts for this page only.
    }
  }

  function storedScheme() {
    var value = read(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  }

  function applyScheme(value) {
    schemeMeta.content = value || 'light dark';
    if (value === 'light' || value === 'dark') document.documentElement.dataset.theme = value;
    else delete document.documentElement.dataset.theme;
  }

  // Two states: the system scheme, or its opposite stored literally. Switching back to what the
  // system shows clears the override, so the page follows the system again.
  var toggle = document.querySelector('[data-theme-toggle]');
  if (toggle && schemeMeta) {
    toggle.addEventListener('click', function () {
      var system = systemDark.matches ? 'dark' : 'light';
      var rendered = schemeMeta.content === 'light' || schemeMeta.content === 'dark' ? schemeMeta.content : system;
      var target = rendered === 'dark' ? 'light' : 'dark';
      var override = target === system ? null : target;
      write(THEME_KEY, override);
      applyScheme(override);
    });
    window.addEventListener('storage', function (event) {
      if (event.key === THEME_KEY || event.key === null) applyScheme(storedScheme());
    });
  }

  document.querySelectorAll('[data-set-lang]').forEach(function (link) {
    link.addEventListener('click', function () {
      write('omc-docs-locale', link.getAttribute('data-set-lang'));
    });
  });

  var dismissStar = document.querySelector('[data-dismiss-star]');
  if (dismissStar) {
    dismissStar.addEventListener('click', function () {
      document.documentElement.classList.add('is-star-dismissed');
      try {
        sessionStorage.setItem('omc-site-star-dismissed', '1');
      } catch (error) {}
    });
  }

  /* ---------------------------------------------------------------- copy */

  var timers = new WeakMap();
  var lastMessage = '';

  function report(button, isCopied) {
    var wrapper = button.parentElement;
    var tip = wrapper.querySelector('[role="status"]');
    var message = wrapper.getAttribute(isCopied ? 'data-copied' : 'data-failed');
    // VoiceOver skips a message identical to the previous one from the same region.
    if (message === lastMessage) message += ' ';
    lastMessage = message;
    clearTimeout(timers.get(button));
    tip.textContent = '';
    button.setAttribute('data-state', isCopied ? 'copied' : 'failed');
    requestAnimationFrame(function () {
      tip.textContent = message;
    });
    timers.set(
      button,
      setTimeout(function () {
        button.removeAttribute('data-state');
        tip.textContent = '';
      }, 1600),
    );
  }

  function copy(button, target) {
    var text = target.textContent.trim();
    if (!text) return;
    Promise.resolve()
      .then(function () {
        return navigator.clipboard.writeText(text);
      })
      .then(
        function () {
          report(button, true);
        },
        function () {
          report(button, false);
        },
      );
  }

  // Copy buttons declare their source with `command="--copy" commandfor`; older browsers get the
  // same behaviour from a click listener. Only one path is registered, so a click never copies twice.
  if ('CommandEvent' in window) {
    document.addEventListener(
      'command',
      function (event) {
        if (event.command === '--copy') copy(event.source, event.target);
      },
      true,
    );
  } else {
    document.addEventListener('click', function (event) {
      var button = event.target.closest('button[command="--copy"]');
      if (!button) return;
      var target = document.getElementById(button.getAttribute('commandfor'));
      if (target) copy(button, target);
    });
  }

  /* ---------------------------------------------------------------- shared timing */

  var isAnimated = !reducedMotion.matches;
  var hasInteracted = false;
  var hero = document.querySelector('.hero');
  var heroDoneAt = performance.now() + 1750;
  var heroStarted = false;

  function startHero() {
    if (heroStarted || !hero) return;
    heroStarted = true;
    heroDoneAt = performance.now() + 1500;
    hero.classList.add('is-live');
  }

  if (hero && isAnimated) {
    var beatTimer = setTimeout(startHero, 240);
    ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(function (type) {
      window.addEventListener(
        type,
        function () {
          hasInteracted = true;
          clearTimeout(beatTimer);
          startHero();
        },
        { once: true, passive: true },
      );
    });
  } else {
    if (hero) hero.classList.add('is-live');
    heroDoneAt = 0;
  }

  /** Calls `onChange(isVisible)` as an element enters and leaves the viewport. */
  function watch(element, onChange, threshold) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          onChange(entry.isIntersecting);
        });
      },
      { threshold: threshold || 0 },
    );
    observer.observe(element);
  }

  /** Marks an element `.is-in` the first time enough of it is on screen. */
  function revealOnce(element, threshold, then) {
    var observer = new IntersectionObserver(
      function (entries) {
        var isVisible = entries.some(function (entry) {
          return entry.isIntersecting;
        });
        if (!isVisible) return;
        observer.disconnect();
        element.classList.add('is-in');
        if (then) then();
      },
      { threshold: threshold },
    );
    observer.observe(element);
  }

  /**
   * A loop that runs only while its element is on screen and the tab is visible. `step` gets
   * the milliseconds of play since the last call and returns nothing.
   */
  function visibleLoop(element, step, threshold) {
    var isOnScreen = false;
    var frame = 0;
    var last = 0;
    function tick(now) {
      var delta = last ? Math.min(now - last, 100) : 0;
      last = now;
      step(delta, now);
      frame = requestAnimationFrame(tick);
    }
    function update() {
      var shouldRun = isOnScreen && !document.hidden;
      if (shouldRun && !frame) {
        last = 0;
        frame = requestAnimationFrame(tick);
      } else if (!shouldRun && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    }
    watch(
      element,
      function (isVisible) {
        isOnScreen = isVisible;
        update();
      },
      threshold,
    );
    document.addEventListener('visibilitychange', update);
  }

  /* ---------------------------------------------------------------- console story */

  var COMPOSER_MODELS = [
    ['deepseek', 'Deepseek Flash'],
    ['claude', 'Claude Opus 5.5'],
    ['gemini', 'Gemini 4 Carbon'],
    ['openai', 'GPT 6 Astra'],
  ];

  function playStory(root) {
    var thread = root.querySelector('[data-thread]');
    var modelPill = root.querySelector('[data-model-pill]');
    var modelUse = modelPill ? modelPill.querySelector('use') : null;
    var modelNameEl = modelPill ? modelPill.querySelector('[data-model-name]') : null;
    var currentModelName = modelNameEl ? modelNameEl.textContent : '';

    function pickModel(excludeCurrent) {
      if (!modelUse || !modelNameEl) return;
      var pool = excludeCurrent
        ? COMPOSER_MODELS.filter(function (entry) {
            return entry[1] !== currentModelName;
          })
        : COMPOSER_MODELS;
      var choice = pool[Math.floor(Math.random() * pool.length)];
      currentModelName = choice[1];
      modelUse.setAttribute('href', '#pm-' + choice[0]);
      modelNameEl.textContent = choice[1];
    }

    pickModel(false);
    root.setAttribute('data-live', '');
    if (!isAnimated) {
      // A still page shows how the story ends.
      thread.scrollTop = thread.scrollHeight;
      return;
    }
    var composer = root.querySelector('[data-composer]');
    var panel = root;
    var cursor = root.querySelector('[data-cursor]');
    var send = root.querySelector('.c-send');
    var placeholder = composer.getAttribute('data-placeholder');
    var length = Number(root.getAttribute('data-length'));
    var steps = Array.prototype.slice.call(root.querySelectorAll('[data-at]'));
    var events = [];
    var typing = null;

    function at(time, run) {
      events.push({ time: time, run: run });
    }

    function setComposer(text, isTyping) {
      composer.textContent = text;
      composer.classList.toggle('is-typing', isTyping);
    }

    function hideCursor() {
      if (!cursor) return;
      cursor.style.transition = 'none';
      cursor.classList.remove('is-shown', 'is-clicking');
      cursor.style.transform = 'translate3d(0, 0, 0)';
      void cursor.offsetWidth;
      cursor.style.transition = '';
    }

    steps.forEach(function (step) {
      if (step.hasAttribute('data-initial')) return;
      var time = Number(step.getAttribute('data-at'));
      var compose = Number(step.getAttribute('data-compose') || 0);
      if (compose) {
        at(time - compose, function () {
          typing = { text: step.textContent, start: time - compose, duration: compose - 250 };
        });
      }
      at(time, function () {
        if (compose) {
          typing = null;
          setComposer(placeholder, false);
          send.classList.remove('is-sending');
          void send.offsetWidth;
          send.classList.add('is-sending');
        }
        step.classList.remove('is-pending');
        step.classList.add('is-shown', 'is-landing');
        if (step.hasAttribute('data-done')) step.classList.add('is-running');
      });
      if (step.hasAttribute('data-gone')) {
        at(Number(step.getAttribute('data-gone')), function () {
          step.classList.add('is-pending');
        });
      }
      if (step.hasAttribute('data-done')) {
        at(Number(step.getAttribute('data-done')), function () {
          step.classList.remove('is-running');
        });
      }
      if (step.hasAttribute('data-approve-at')) {
        var approveAt = Number(step.getAttribute('data-approve-at'));
        var cursorAt = Number(step.getAttribute('data-cursor-at') || approveAt - 850);
        var targetX = 0;
        var targetY = 0;
        at(cursorAt, function () {
          if (!cursor || !panel) return;
          var btn = step.querySelector('[data-approve-btn]');
          if (!btn) return;
          var pRect = panel.getBoundingClientRect();
          var bRect = btn.getBoundingClientRect();
          // Offset by the macOS arrow tip (5.5, 2.5) so the tip lands right inside the button.
          targetX = bRect.left - pRect.left + bRect.width * 0.56 - 5.5;
          targetY = bRect.top - pRect.top + bRect.height * 0.54 - 2.5;
          cursor.style.transition = 'none';
          cursor.style.transform = 'translate3d(' + (targetX + 116) + 'px, ' + (targetY + 68) + 'px, 0)';
          cursor.classList.remove('is-shown', 'is-clicking');
          void cursor.offsetWidth;
          cursor.style.transition = '';
          cursor.classList.add('is-shown');
          cursor.style.transform = 'translate3d(' + targetX + 'px, ' + targetY + 'px, 0)';
        });
        at(approveAt - 180, function () {
          if (cursor) cursor.classList.add('is-clicking');
          step.classList.add('is-pressing');
        });
        at(approveAt, function () {
          if (cursor) {
            cursor.classList.remove('is-clicking', 'is-shown');
            cursor.style.transform = 'translate3d(' + (targetX + 26) + 'px, ' + (targetY + 18) + 'px, 0)';
          }
          step.classList.remove('is-pressing', 'is-waiting');
          step.classList.add('is-approved');
        });
      }
    });
    at(length - 500, function () {
      thread.classList.add('is-fading');
    });
    events.sort(function (a, b) {
      return a.time - b.time;
    });

    var elapsed = 0;
    var next = 0;
    var armedAt = 0;

    function scrollThread(instant) {
      requestAnimationFrame(function () {
        var target = Math.max(0, thread.scrollHeight - thread.clientHeight);
        if (instant || typeof thread.scrollTo !== 'function') {
          thread.scrollTop = target;
        } else {
          thread.scrollTo({ top: target, behavior: 'smooth' });
        }
      });
    }

    function reset() {
      elapsed = 0;
      next = 0;
      typing = null;
      hideCursor();
      setComposer(placeholder, false);
      pickModel(true);
      thread.classList.remove('is-fading');
      thread.scrollTop = 0;
      steps.forEach(function (step) {
        var isInitial = step.hasAttribute('data-initial');
        step.classList.toggle('is-pending', !isInitial);
        step.classList.toggle('is-shown', isInitial);
        step.classList.remove('is-landing', 'is-running', 'is-pressing', 'is-approved');
        if (step.hasAttribute('data-approve-at')) step.classList.add('is-waiting');
      });
    }

    reset();
    visibleLoop(
      root,
      function (delta, now) {
        if (!hasInteracted && now < heroDoneAt) return;
        if (!armedAt) armedAt = now;
        if (now - armedAt < 300) return;
        elapsed += delta;
        var hasChanged = false;
        while (next < events.length && events[next].time <= elapsed) {
          events[next++].run();
          hasChanged = true;
        }
        if (hasChanged) scrollThread(false);
        if (typing) {
          var share = Math.min(1, (elapsed - typing.start) / typing.duration);
          setComposer(typing.text.slice(0, Math.round(typing.text.length * share)), true);
        }
        if (elapsed >= length) reset();
      },
      0.4,
    );
  }

  document.querySelectorAll('[data-story]').forEach(playStory);

  /* ---------------------------------------------------------------- routing map */

  function playMap(card) {
    var svg = card.querySelector('svg.map');
    var layer = card.querySelector('[data-pulses]');
    var gateway = card.querySelector('.is-gateway');
    var clientLanes = Array.prototype.slice.call(card.querySelectorAll('[data-lane^="c"]'));
    var keyLanes = Array.prototype.slice.call(card.querySelectorAll('[data-lane^="k"]'));
    var stats = {
      requests: card.querySelector('[data-stat="requests"]'),
      success: card.querySelector('[data-stat="success"]'),
      cost: card.querySelector('[data-stat="cost"]'),
    };
    var tally = { requests: 1284, ok: 1274, cost: 18.42 };
    // team-2 (index 2) is nearly out of quota, so it answers rarely and fails more often.
    var weights = [3, 4, 1, 3, 2];
    var SEGMENT = 760;

    function node(id) {
      return svg.querySelector('[data-node="' + id + '"]');
    }

    function pickKey(pool, except) {
      var candidates = pool.filter(function (index) {
        return index !== except;
      });
      if (!candidates.length) candidates = pool;
      var total = 0;
      candidates.forEach(function (index) {
        total += weights[index] || 1;
      });
      var roll = Math.random() * total;
      for (var i = 0; i < candidates.length; i++) {
        roll -= weights[candidates[i]] || 1;
        if (roll <= 0) return candidates[i];
      }
      return candidates[0];
    }

    function pulse(lane, kind, isReturn) {
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', lane.getAttribute('d'));
      path.setAttribute('pathLength', '1');
      path.setAttribute('class', 'pulse is-' + kind);
      layer.appendChild(path);
      var frames = isReturn ? [{ strokeDashoffset: -1 }, { strokeDashoffset: 0.12 }] : [{ strokeDashoffset: 0.12 }, { strokeDashoffset: -1 }];
      var animation = path.animate(frames, { duration: SEGMENT, easing: 'cubic-bezier(0.45, 0, 0.55, 1)', fill: 'both' });
      return animation.finished.then(function () {
        path.remove();
      });
    }

    function hit() {
      gateway.classList.add('is-hit');
      setTimeout(function () {
        gateway.classList.remove('is-hit');
      }, 120);
    }

    function flash(element, className, duration) {
      element.classList.add(className);
      setTimeout(function () {
        element.classList.remove(className);
      }, duration);
    }

    function render() {
      stats.requests.textContent = tally.requests.toLocaleString('en-US');
      stats.success.textContent = ((tally.ok / tally.requests) * 100).toFixed(1) + '%';
      stats.cost.textContent = '$' + tally.cost.toFixed(2);
    }

    function attempt(pool, keyIndex, isRetry) {
      var keyLane = keyLanes[keyIndex];
      var keyNode = node('k' + keyIndex);
      return pulse(keyLane, 'out').then(function () {
        flash(keyNode, 'is-busy', 500);
        var fails = !isRetry && pool.length > 1 && Math.random() < (keyIndex === 2 ? 0.55 : 0.06);
        if (fails) flash(keyNode, 'is-failing', 2200);
        return pulse(keyLane, fails ? 'fail' : 'ok', true).then(function () {
          hit();
          return fails ? attempt(pool, pickKey(pool, keyIndex), true) : true;
        });
      });
    }

    function request() {
      var clientIndex = Math.floor(Math.random() * clientLanes.length);
      var clientNode = node('c' + clientIndex);
      var clientLane = clientLanes[clientIndex];
      var pool = (clientNode.getAttribute('data-targets') || '0')
        .split(',')
        .map(Number);
      flash(clientNode, 'is-busy', 400);
      pulse(clientLane, 'out')
        .then(function () {
          hit();
          return attempt(pool, pickKey(pool, -1), false);
        })
        .then(function () {
          return pulse(clientLane, 'ok', true);
        })
        .then(function () {
          tally.requests += 1;
          tally.ok += 1;
          tally.cost += 0.004 + Math.random() * 0.16;
          render();
        });
    }

    var untilNext = 600;
    visibleLoop(
      card,
      function (delta) {
        untilNext -= delta;
        if (untilNext > 0) return;
        untilNext = 520 + Math.random() * 520;
        request();
      },
      0.25,
    );
  }

  var mapsStarted = false;
  function startMaps() {
    if (mapsStarted || !isAnimated || phone.matches || typeof SVGElement.prototype.animate !== 'function') return;
    mapsStarted = true;
    document.querySelectorAll('[data-map]').forEach(playMap);
  }
  startMaps();
  if (typeof phone.addEventListener === 'function') phone.addEventListener('change', startMaps);

  /* ---------------------------------------------------------------- feature cards */

  function playRequests(list) {
    var pool = JSON.parse(list.getAttribute('data-requests'));
    var clock = 9 * 3600 + 47 * 60 + 52;
    // The first rows are already on the page, so new ones continue the sample after them.
    var cursor = list.children.length;
    var untilNext = 900;

    function stamp(seconds) {
      return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
        .map(function (part) {
          return String(part).padStart(2, '0');
        })
        .join(':');
    }

    function cell(className, text) {
      var span = document.createElement('span');
      span.className = className;
      span.textContent = text;
      return span;
    }

    function add() {
      var item = pool[cursor++ % pool.length];
      clock += 2 + Math.floor(Math.random() * 7);
      var row = document.createElement('li');
      row.className = 'r-row is-landing' + (item[5] === 'fail' ? ' is-fail' : '');
      var model = cell('r-model', item[1]);
      model.insertAdjacentHTML('afterbegin', '<svg class="pmark" fill="currentColor" aria-hidden="true"><use href="#pm-' + item[0] + '"/></svg>');
      row.append(cell('r-time', stamp(clock)), model, cell('r-account', item[2]), cell('r-num', item[3]), cell('r-num', item[4]), cell('r-pip', ''));
      list.prepend(row);
      while (list.children.length > 6) list.lastElementChild.remove();
    }

    visibleLoop(list, function (delta) {
      untilNext -= delta;
      if (untilNext > 0) return;
      untilNext = 1300 + Math.random() * 1200;
      add();
    });
  }

  function countUp(element) {
    var target = Number(element.getAttribute('data-count'));
    var prefix = element.getAttribute('data-prefix') || '';
    var start = performance.now();
    var duration = 1400;
    function frame(now) {
      var share = Math.min(1, (now - start) / duration);
      var eased = 1 - Math.pow(1 - share, 4);
      element.textContent = prefix + (target * eased).toFixed(2);
      if (share < 1) requestAnimationFrame(frame);
    }
    element.textContent = prefix + '0.00';
    requestAnimationFrame(frame);
  }

  function playWarmup(row) {
    var elapsed = 0;
    var CYCLE = 7800;
    visibleLoop(row, function (delta) {
      elapsed = (elapsed + delta) % CYCLE;
      row.classList.toggle('is-warming', elapsed > 3800 && elapsed < 6400);
    });
  }

  document.querySelectorAll('[data-reveal]').forEach(function (card) {
    if (!isAnimated) {
      card.classList.add('is-in');
      return;
    }
    revealOnce(card, 0.35, function () {
      var counter = card.querySelector('[data-count]');
      if (counter) countUp(counter);
      var requests = card.querySelector('[data-requests]');
      if (requests) playRequests(requests);
      var warm = card.querySelector('.o-row.is-warm');
      if (warm) playWarmup(warm);
    });
  });

  /* ---------------------------------------------------------------- install terminal */

  var terminal = document.querySelector('[data-terminal]');
  var typingRun = 0;

  function playTerminal(screen) {
    var run = ++typingRun;
    var lines = Array.prototype.slice.call(screen.querySelectorAll('.t-line'));
    var queue = [];
    lines.forEach(function (line, lineIndex) {
      var text = line.querySelector('.t-text');
      if (line.hasAttribute('data-type')) {
        if (!text._segments) {
          text._segments = Array.prototype.map.call(text.childNodes, function (node) {
            return { cls: node.nodeType === 1 ? node.className : '', text: node.textContent };
          });
          text._full = text._segments.map(function (seg) { return seg.text; }).join('');
        }
        text.textContent = '';
        var typed = document.createElement('span');
        var rest = document.createElement('span');
        typed.className = 't-typed';
        rest.className = 't-rest';
        rest.textContent = text._full;
        var parts = text._segments.map(function (seg) {
          var el = document.createElement('span');
          if (seg.cls) el.className = seg.cls;
          typed.appendChild(el);
          return { el: el, text: seg.text };
        });
        text.append(typed, rest);
        queue.push({ line: line, parts: parts, rest: rest, full: text._full });
      } else {
        queue.push({ line: line });
      }
      line.classList.remove('is-landing', 'is-caret');
      // Keep the first line mounted so the terminal starts at 1 line and grows line by line.
      line.classList.toggle('is-waiting', lineIndex > 0);
    });

    var index = 0;
    function nextLine() {
      if (run !== typingRun || index >= queue.length) return;
      var item = queue[index++];
      if (item.line.classList.contains('is-waiting')) {
        item.line.classList.remove('is-waiting');
        if (item.parts) item.line.classList.add('is-landing');
      }
      if (!item.parts) {
        item.line.classList.add('is-landing');
        setTimeout(nextLine, 400);
        return;
      }
      item.line.classList.add('is-caret');
      var start = performance.now();
      function type(now) {
        if (run !== typingRun) return;
        var count = Math.min(item.full.length, Math.round((now - start) * 0.16));
        var left = count;
        for (var i = 0; i < item.parts.length; i++) {
          var seg = item.parts[i];
          if (left <= 0) {
            seg.el.textContent = '';
          } else if (left >= seg.text.length) {
            seg.el.textContent = seg.text;
            left -= seg.text.length;
          } else {
            seg.el.textContent = seg.text.slice(0, left);
            left = 0;
          }
        }
        item.rest.textContent = item.full.slice(count);
        if (count < item.full.length) {
          requestAnimationFrame(type);
          return;
        }
        setTimeout(function () {
          item.line.classList.remove('is-caret');
          nextLine();
        }, 260);
      }
      requestAnimationFrame(type);
    }
    setTimeout(nextLine, 260);
  }

  function activeScreen() {
    return terminal.querySelector('[data-screen]:not([hidden])');
  }

  var closingMark = document.querySelector('.closing-mark');
  if (closingMark && isAnimated) revealOnce(closingMark, 0.3);

  var terminalSeen = false;
  if (terminal && isAnimated) {
    revealOnce(terminal, 0.4, function () {
      terminalSeen = true;
      playTerminal(activeScreen());
    });
  }

  /* ---------------------------------------------------------------- install tabs */

  // Inactive text panels are `hidden="until-found"`: find in page can reveal one, and the tab
  // follows. Terminal screens are plain `hidden`; their commands are also in the docs.
  var tablist = document.querySelector('.chips[role="tablist"]');
  var thumb = null;
  if (tablist) {
    thumb = document.createElement('span');
    thumb.className = 'chips-thumb';
    thumb.setAttribute('aria-hidden', 'true');
    tablist.prepend(thumb);
  }
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
  function moveThumb(tab, instant) {
    if (!tablist || !thumb || !tab) return;
    if (instant) thumb.style.transition = 'none';
    thumb.style.width = tab.offsetWidth + 'px';
    thumb.style.height = tab.offsetHeight + 'px';
    thumb.style.transform = 'translate3d(' + tab.offsetLeft + 'px, ' + tab.offsetTop + 'px, 0)';
    if (instant) {
      thumb.getBoundingClientRect();
      thumb.style.transition = '';
    }
    tablist.classList.add('has-thumb');
  }
  function selectedTab() {
    return tabs.find(function (candidate) {
      return candidate.getAttribute('aria-selected') === 'true';
    }) || tabs[0];
  }
  if (tablist) {
    moveThumb(selectedTab(), true);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        moveThumb(selectedTab(), true);
      });
    }
    window.addEventListener('resize', function () {
      moveThumb(selectedTab(), true);
    });
  }
  function select(tab, shouldFocus) {
    if (tab.getAttribute('aria-selected') === 'true') {
      if (shouldFocus) tab.focus();
      return;
    }
    tabs.forEach(function (other) {
      var isSelected = other === tab;
      other.setAttribute('aria-selected', String(isSelected));
      other.tabIndex = isSelected ? 0 : -1;
      other
        .getAttribute('aria-controls')
        .split(' ')
        .forEach(function (id) {
          var panel = document.getElementById(id);
          if (panel.hasAttribute('data-screen')) panel.hidden = !isSelected;
          else if (isSelected) panel.removeAttribute('hidden');
          else panel.setAttribute('hidden', 'until-found');
        });
    });
    moveThumb(tab, false);
    if (shouldFocus) tab.focus();
    if (terminalSeen && isAnimated) playTerminal(activeScreen());
  }
  tabs.forEach(function (tab, index) {
    tab.addEventListener('click', function () {
      select(tab, false);
    });
    tab.addEventListener('keydown', function (event) {
      var step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (event.key === 'Home') select(tabs[0], true);
      else if (event.key === 'End') select(tabs[tabs.length - 1], true);
      else if (step) select(tabs[(index + step + tabs.length) % tabs.length], true);
      else return;
      event.preventDefault();
    });
  });
  document.addEventListener('beforematch', function (event) {
    var tab = tabs.find(function (candidate) {
      return candidate.getAttribute('aria-controls').split(' ').indexOf(event.target.id) !== -1;
    });
    if (tab) select(tab, false);
  });
})();
