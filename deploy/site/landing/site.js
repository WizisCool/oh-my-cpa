// Landing page behaviour: theme, language preference, copy buttons, install tabs, and the
// scripted stories that replay the console. The page is complete without it: every story is
// rendered in its finished state, and each block below only replays or enhances that markup.
(function () {
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

  /*
   * The hero mark turns a few degrees to face the pointer, and the accent piece slides a
   * little further than the ring so the two read as separate layers. A damped follow keeps
   * it calm; it rests flat again when the pointer leaves the window or the hero scrolls away.
   */
  var heroArt = document.querySelector('.hero-art');
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  if (heroArt && isAnimated && finePointer.matches) {
    var TILT_REACH = 520;
    var tilt = { x: 0, y: 0 };
    var tiltTarget = { x: 0, y: 0 };
    var tiltFrame = 0;

    var stepTilt = function () {
      tilt.x += (tiltTarget.x - tilt.x) * 0.09;
      tilt.y += (tiltTarget.y - tilt.y) * 0.09;
      var isSettled = Math.abs(tiltTarget.x - tilt.x) < 0.001 && Math.abs(tiltTarget.y - tilt.y) < 0.001;
      if (isSettled) {
        tilt.x = tiltTarget.x;
        tilt.y = tiltTarget.y;
      }
      heroArt.style.setProperty('--tilt-x', tilt.x.toFixed(4));
      heroArt.style.setProperty('--tilt-y', tilt.y.toFixed(4));
      tiltFrame = isSettled ? 0 : requestAnimationFrame(stepTilt);
    };

    var aimTilt = function (x, y) {
      tiltTarget.x = x;
      tiltTarget.y = y;
      if (!tiltFrame) tiltFrame = requestAnimationFrame(stepTilt);
    };

    var clampUnit = function (value) {
      return Math.max(-1, Math.min(1, value));
    };

    window.addEventListener(
      'pointermove',
      function (event) {
        if (event.pointerType !== 'mouse') return;
        var box = heroArt.getBoundingClientRect();
        if (box.bottom < 0) return aimTilt(0, 0);
        var dx = (event.clientX - (box.left + box.width / 2)) / TILT_REACH;
        var dy = (event.clientY - (box.top + box.height / 2)) / TILT_REACH;
        aimTilt(clampUnit(dx), clampUnit(dy));
      },
      { passive: true },
    );
    document.documentElement.addEventListener('pointerleave', function () {
      aimTilt(0, 0);
    });
  }

  /** Calls `onChange(isVisible)` as an element enters and leaves the viewport. */
  function watch(element, onChange, threshold) {
    if (typeof IntersectionObserver !== 'function') {
      onChange(true);
      return;
    }
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

  /**
   * Marks an element `.is-in` each time enough of it comes on screen, and clears the mark once
   * it has left entirely, so a story replays whenever the reader scrolls back to it. Leaving
   * only when fully off screen keeps a block that sits on the edge from flickering.
   */
  function revealEach(element, threshold, onEnter, onLeave) {
    if (typeof IntersectionObserver !== 'function') {
      element.classList.add('is-in');
      if (onEnter) onEnter();
      return;
    }
    var observer = new IntersectionObserver(
      function (entries) {
        var entry = entries[entries.length - 1];
        var isIn = element.classList.contains('is-in');
        if (!isIn && entry.isIntersecting && entry.intersectionRatio >= threshold) {
          element.classList.add('is-in');
          if (onEnter) onEnter();
        } else if (isIn && !entry.isIntersecting) {
          element.classList.remove('is-in');
          if (onLeave) onLeave();
        }
      },
      { threshold: [0, threshold] },
    );
    observer.observe(element);
  }

  // Without scroll timelines (site.css), blocks fade in from whichever edge they enter by.
  var hasScrollTimeline = Boolean(window.CSS && CSS.supports('(animation-timeline: view()) and (animation-range: entry)'));
  if (isAnimated && !hasScrollTimeline && typeof IntersectionObserver === 'function') {
    var seen = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          var block = entry.target;
          if (entry.isIntersecting && entry.intersectionRatio >= 0.12) {
            block.classList.add('is-seen');
          } else if (!entry.isIntersecting) {
            block.classList.remove('is-seen');
            block.setAttribute('data-from', entry.boundingClientRect.top < 0 ? 'top' : 'bottom');
          }
        });
      },
      { threshold: [0, 0.12] },
    );
    document.querySelectorAll('.reveal, .qa, .marquee, .feature, .map-card, .step').forEach(function (block) {
      seen.observe(block);
    });
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

  /* ---------------------------------------------------------------- rolling counters */

  /**
   * Turns an element's text into a counter whose digits roll to each new value, like an
   * odometer: every digit is a strip of 0-9 that slides to its place. Separators stay put. A
   * screen reader reads the plain value beside the strips, never the strips themselves.
   */
  function rollingCounter(element) {
    var spoken = document.createElement('span');
    spoken.className = 'sr-only';
    var face = document.createElement('span');
    face.className = 'roll';
    face.setAttribute('aria-hidden', 'true');
    var shape = '';
    var strips = [];

    function build(text) {
      face.textContent = '';
      strips = [];
      text.split('').forEach(function (char) {
        if (!/\d/.test(char)) {
          var mark = document.createElement('span');
          mark.className = 'roll-mark';
          mark.textContent = char;
          face.appendChild(mark);
          return;
        }
        var slot = document.createElement('span');
        slot.className = 'roll-digit';
        var strip = document.createElement('span');
        strip.className = 'roll-strip';
        strip.textContent = '0123456789';
        slot.appendChild(strip);
        face.appendChild(slot);
        strips.push(strip);
      });
    }

    function set(text) {
      spoken.textContent = text;
      var nextShape = text.replace(/\d/g, '0');
      if (nextShape !== shape) {
        shape = nextShape;
        build(text);
      }
      var digits = text.replace(/\D/g, '');
      strips.forEach(function (strip, index) {
        strip.style.setProperty('--digit', digits.charAt(index));
      });
    }

    var initial = element.textContent;
    element.textContent = '';
    element.append(spoken, face);
    set(initial);
    return set;
  }

  /* ---------------------------------------------------------------- routing map */

  // The console's packet player (web/src/components/dashboard/routing/routingPackets.ts) on a
  // made-up minute of traffic: a stroke of light leaves the model, passes the gateway to a
  // credential, waits while it answers and comes back green. Everything runs on the map's own
  // clock, so it freezes off screen.
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var LANE_HOP_MS = 391;
  var EDGE_HOP_MS = 460;
  var GLOW_MS = 1200;
  var HEAD_PX = 18;
  var TAIL_PX = 56;
  var MAX_LIVE = 16;
  var LIGHT = 'var(--map-light)';
  var ANSWER = 'var(--success)';

  function easeInOutQuad(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  function playMap(card) {
    var layer = card.querySelector('[data-pulses]');
    var hub = card.querySelector('[data-hub]');
    var gateway = card.querySelector('[data-node="gateway"]');
    var requestsText = card.getAttribute('data-requests-text');
    var showRequests = rollingCounter(card.querySelector('[data-stat="requests"]'));
    var showCost = rollingCounter(card.querySelector('[data-stat="cost"]'));
    var tally = { requests: 1284, cost: 18.42 };
    var weights = [3, 4, 2, 3, 2];

    function lane(id) {
      var path = card.querySelector('[data-lane="' + id + '"]');
      var length = path.getTotalLength();
      var gap = (length + 2 * TAIL_PX).toFixed(1);
      return { d: path.getAttribute('d'), length: length, dash: [HEAD_PX + ' ' + gap, TAIL_PX + ' ' + gap] };
    }

    var models = Array.prototype.map.call(card.querySelectorAll('.route-node.is-model'), function (el, index) {
      return {
        el: el,
        lane: lane('c' + index),
        count: Number(el.getAttribute('data-requests')),
        countEl: el.querySelector('[data-count]'),
        targets: el.getAttribute('data-targets').split(',').map(Number),
      };
    });
    var keys = Array.prototype.map.call(card.querySelectorAll('.route-node.is-credential'), function (el, index) {
      return { el: el, lane: lane('k' + index) };
    });

    var timers = [];
    var flights = [];
    var packets = new Set();
    var clock = 0;
    var inFlight = 0;

    function wait(ms) {
      return new Promise(function (resolve) {
        timers.push({ at: clock + ms, run: resolve });
      });
    }

    function glow(element, peak) {
      var from = Number(getComputedStyle(element).opacity) || 0;
      element.getAnimations().forEach(function (running) {
        running.cancel();
      });
      element.animate(
        [
          { opacity: from, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
          { opacity: Math.max(from, peak), offset: 1 / 6, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' },
          { opacity: 0 },
        ],
        { duration: GLOW_MS },
      );
    }

    function acknowledge(node, isAnswer, isWashed) {
      glow(node.querySelector('.route-halo'), 0.85);
      if (isWashed === false) return;
      var wash = node.querySelector('.route-wash');
      wash.classList.toggle('is-success', isAnswer);
      glow(wash, 1);
    }

    function fly(packet, route, color, isBack, duration) {
      packet.holder.style.setProperty('--packet-color', color);
      packet.strokes.forEach(function (stroke, index) {
        stroke.setAttribute('d', route.d);
        stroke.style.strokeDasharray = route.dash[index];
      });
      return new Promise(function (resolve) {
        flights.push({ packet: packet, route: route, isBack: isBack, elapsed: 0, duration: duration, resolve: resolve });
      });
    }

    function pickKey(pool) {
      var total = 0;
      pool.forEach(function (index) {
        total += weights[index];
      });
      var roll = Math.random() * total;
      for (var i = 0; i < pool.length; i++) {
        roll -= weights[pool[i]];
        if (roll <= 0) return pool[i];
      }
      return pool[0];
    }

    function launch() {
      var holder = document.createElementNS(SVG_NS, 'g');
      holder.setAttribute('class', 'pulse');
      var strokes = ['pulse-head', 'pulse-tail'].map(function (name) {
        var stroke = document.createElementNS(SVG_NS, 'path');
        stroke.setAttribute('class', name);
        return stroke;
      });
      holder.append(strokes[1], strokes[0]);
      layer.appendChild(holder);
      packets.add(holder);
      return { holder: holder, strokes: strokes };
    }

    function setBusy() {
      hub.classList.toggle('is-busy', inFlight > 0);
    }

    function request() {
      if (inFlight >= MAX_LIVE) return;
      var model = models[Math.floor(Math.random() * models.length)];
      var key = keys[pickKey(model.targets)];
      var packet = launch();
      inFlight += 1;
      setBusy();
      acknowledge(model.el, false);
      fly(packet, model.lane, LIGHT, false, LANE_HOP_MS)
        .then(function () {
          acknowledge(gateway, false);
          return fly(packet, key.lane, LIGHT, false, EDGE_HOP_MS);
        })
        .then(function () {
          acknowledge(key.el, false, false);
          return wait(Math.round(120 + Math.random() * 360));
        })
        .then(function () {
          acknowledge(key.el, true);
          return fly(packet, key.lane, ANSWER, true, EDGE_HOP_MS);
        })
        .then(function () {
          acknowledge(gateway, true);
          return fly(packet, model.lane, ANSWER, true, LANE_HOP_MS);
        })
        .then(function () {
          acknowledge(model.el, true);
          model.count += 1;
          model.countEl.textContent = requestsText.replace('{count}', model.count.toLocaleString('en-US'));
          tally.requests += 1;
          tally.cost += 0.004 + Math.random() * 0.16;
          showRequests(tally.requests.toLocaleString('en-US'));
          showCost('$' + tally.cost.toFixed(2));
          inFlight -= 1;
          setBusy();
          packet.holder.remove();
          packets.delete(packet.holder);
        });
    }

    function advance(delta) {
      clock += delta;
      var due = timers.filter(function (timer) {
        return timer.at <= clock;
      });
      timers = timers.filter(function (timer) {
        return timer.at > clock;
      });
      due.forEach(function (timer) {
        timer.run();
      });
      flights = flights.filter(function (flight) {
        flight.elapsed += delta;
        var progress = Math.min(1, flight.elapsed / flight.duration);
        var travelled = easeInOutQuad(progress) * (flight.route.length + TAIL_PX);
        flight.packet.strokes.forEach(function (stroke, index) {
          var dash = index === 0 ? HEAD_PX : TAIL_PX;
          stroke.style.strokeDashoffset = (flight.isBack ? travelled - flight.route.length : dash - travelled).toFixed(1);
        });
        if (progress < 1) return true;
        flight.resolve();
        return false;
      });
    }

    var untilNext = 300;
    var holdUntil = 0;
    visibleLoop(
      card,
      function (delta, now) {
        if (now < holdUntil) return;
        advance(delta);
        untilNext -= delta;
        if (untilNext > 0) return;
        untilNext = 520 + Math.random() * 520;
        request();
      },
      0.25,
    );

    return {
      /** Keeps the traffic still while the map assembles. */
      hold: function (ms) {
        holdUntil = performance.now() + ms;
      },
      /** Clears the map as it leaves, so it comes back empty and assembles again. */
      clear: function () {
        packets.forEach(function (holder) {
          holder.remove();
        });
        packets.clear();
        flights = [];
        timers = [];
        inFlight = 0;
        setBusy();
        untilNext = 300;
      },
    };
  }

  // The map assembles each time it comes into view (site.css), and traffic waits until it has.
  var MAP_ASSEMBLY_MS = 760;
  document.querySelectorAll('[data-map]').forEach(function (card) {
    var canPlay = isAnimated && typeof SVGElement.prototype.animate === 'function';
    if (!canPlay) {
      card.classList.add('is-in');
      return;
    }
    var player = null;
    function start() {
      if (!player && !phone.matches && card.classList.contains('is-in')) player = playMap(card);
      if (player) player.hold(MAP_ASSEMBLY_MS);
    }
    revealEach(card, 0.35, start, function () {
      if (player) player.clear();
    });
    if (typeof phone.addEventListener === 'function') phone.addEventListener('change', start);
  });

  /* ---------------------------------------------------------------- providers marquee */

  // A pointer over the strip eases it to rest and away eases it back, rather than the strip
  // stopping dead under the pointer. It keeps one pace otherwise: tying its speed to the
  // scroll read as lurching. Without the script, CSS pauses it on hover.
  document.querySelectorAll('[data-marquee]').forEach(function (marquee) {
    var track = marquee.querySelector('.marquee-track');
    if (!isAnimated || typeof track.getAnimations !== 'function') return;
    var animation = track.getAnimations()[0];
    if (!animation) return;
    marquee.classList.add('is-eased');
    var rate = 1;
    var target = 1;
    var frame = 0;
    var last = 0;
    function step(now) {
      var delta = last ? Math.min(now - last, 64) : 16;
      last = now;
      rate += (target - rate) * (1 - Math.exp(-delta / 260));
      if (Math.abs(target - rate) < 0.004) rate = target;
      animation.playbackRate = rate;
      frame = rate === target ? 0 : requestAnimationFrame(step);
    }
    function ease(to) {
      target = to;
      if (!frame) {
        last = 0;
        frame = requestAnimationFrame(step);
      }
    }
    marquee.addEventListener('pointerenter', function (event) {
      if (event.pointerType === 'mouse' || event.pointerType === 'pen') ease(0);
    });
    marquee.addEventListener('pointerleave', function () {
      ease(1);
    });
  });

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
    // A replay takes over from a count still running.
    var run = (element.countRun || 0) + 1;
    element.countRun = run;
    function frame(now) {
      if (element.countRun !== run) return;
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
    var hasStarted = false;
    revealEach(card, 0.35, function () {
      var counter = card.querySelector('[data-count]');
      if (counter) countUp(counter);
      if (hasStarted) return;
      hasStarted = true;
      var requests = card.querySelector('[data-requests]');
      if (requests) playRequests(requests);
      var warm = card.querySelector('.o-row.is-warm');
      if (warm) playWarmup(warm);
    });
  });

  var closingMark = document.querySelector('.closing-mark');
  if (closingMark && isAnimated) revealEach(closingMark, 0.3);

  /* ---------------------------------------------------------------- install tabs */

  // Install paths stay laid out and an unselected one is only made `inert`, so the section
  // keeps its size and a switch is a crossfade. Their commands are also in the docs.
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
      document.getElementById(other.getAttribute('aria-controls')).inert = !isSelected;
    });
    moveThumb(tab, false);
    if (shouldFocus) tab.focus();
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
  document.documentElement.classList.add('is-ready');
})();
