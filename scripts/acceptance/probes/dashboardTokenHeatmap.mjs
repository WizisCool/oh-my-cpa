/**
 * Probes for the dashboard's token-activity grid: its day geometry and ramp, the
 * phone layout, the failure state of one panel, and the grid over pruned history.
 */

import {
  HEATMAP_TODAY,
  HEATMAP_TOTAL_DAYS,
  HEATMAP_WEEKS,
  chartTokenHeatmap,
  heatmapGridDays,
  heatmapMarked,
} from './dashboardFixtures.mjs';



export async function dashboardTokenHeatmap({ base, page, check }) {
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.heatmap-grid').waitFor({ timeout: 20_000 });

  const shape = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.heatmap-grid .heatmap-cell')];
    return {
      cells: cells.length,
      rows: new Set(cells.map((cell) => getComputedStyle(cell).gridRowStart)).size,
      columns: new Set(cells.map((cell) => getComputedStyle(cell).gridColumnStart)).size,
      days: cells.map((cell) => cell.getAttribute('data-day')),
      weekdays: document.querySelectorAll('.heatmap-weekday').length,
      months: document.querySelectorAll('.heatmap-month').length,
    };
  });

  // Seven rows is the whole point of the layout: it is what makes a weekly rhythm a row and a
  // trend a direction. A single-row strip satisfies "cells rendered" and fails here.
  check('the grid has one row per weekday', shape.rows === 7, `rows=${shape.rows}`);
  check('the grid labels all seven rows', shape.weekdays === 7, `weekdays=${shape.weekdays}`);
  check('the grid is 53 whole weeks', shape.columns === HEATMAP_WEEKS, `columns=${shape.columns}`);
  check('the grid has a month axis', shape.months >= 8, `months=${shape.months}`);
  check(
    'the grid renders every day of its span, oldest first',
    shape.cells === HEATMAP_TOTAL_DAYS && shape.days[0] === heatmapGridDays()[0].day,
    `cells=${shape.cells} want=${HEATMAP_TOTAL_DAYS} first=${shape.days[0]}`,
  );

  // Each day has to sit on its own weekday's row, or the rows mean nothing while still looking
  // plausible.
  const misrowed = await page.evaluate(() => {
    const wrong = [];
    for (const cell of document.querySelectorAll('.heatmap-grid .heatmap-cell')) {
      const day = cell.getAttribute('data-day');
      const [year, month, date] = day.split('-').map(Number);
      const weekday = (new Date(Date.UTC(year, month - 1, date)).getUTCDay() + 6) % 7;
      if (Number(getComputedStyle(cell).gridRowStart) !== weekday + 1) {
        wrong.push(`${day} expectedRow=${weekday + 1} got=${getComputedStyle(cell).gridRowStart}`);
      }
    }
    return wrong;
  });
  check('each day sits on its own weekday row', misrowed.length === 0, misrowed.slice(0, 3).join('; '));

  // The days after today in the final column are days nothing is stored for: present, unqueried, and
  // drawn exactly like any other day with no record. The panel does not invent a separate "pending"
  // state - a reader comparing days can only act on whether there is data for one.
  //
  // Whether there *are* any depends on the day the run happens: the grid's final column is the current
  // week drawn in full, so a run on the week's last day - a Sunday, which is when this was written -
  // finds today at the end of the column and no day after it. Asserting a count of future days was
  // therefore an assertion that fails every Sunday, and it did. What the grid owes the reader on a
  // Sunday is the same complete final week, so the span is asserted unconditionally below and the
  // per-day checks run over whatever days are there.
  const future = await page.evaluate((today) => {
    const cells = [...document.querySelectorAll('.heatmap-grid .heatmap-cell')];
    const after = cells.filter((cell) => cell.getAttribute('data-day') > today);
    const quiet = cells.filter((cell) => cell.getAttribute('data-day') <= today && !cell.classList.contains('is-measured'));
    return {
      count: after.length,
      interactive: after.filter((cell) => cell.classList.contains('is-interactive')).length,
      // The one thing that must not survive: a pending state of its own.
      pendingClasses: after.filter((cell) => cell.className.includes('pending')).length,
      // A future day carries nothing, so it takes the *unrecorded* fill - the one a trimmed day
      // takes - and not the `empty` fill, which would claim a measurement of zero that was never
      // stored. Naming the expected class rather than comparing against a union of quiet fills is
      // the point: the two fills are near-identical in value, so a set-union comparison passes
      // whichever of them the cell happens to take, which is how this went unnoticed.
      futureClasses: [...new Set([...after].map((cell) => [...cell.classList].find((name) => name.startsWith('is-') && name !== 'is-interactive')))].sort(),
      futureFills: [...new Set(after.map((cell) => getComputedStyle(cell).backgroundColor))].sort(),
      // The days that were asked about and had nothing: the fill a future day must *not* take,
      // because taking it would claim a measurement of zero that was never stored.
      zeroFills: [...new Set(cells
        .filter((cell) => !cell.classList.contains('is-measured') && !cell.classList.contains('is-unrecorded'))
        .map((cell) => getComputedStyle(cell).backgroundColor))].sort(),
    };
  }, HEATMAP_TODAY);
  // The final week is complete either way: its last day is today when today ends the week, and a day
  // after today when it does not. This is the invariant the count above used to stand in for.
  const lastGridDay = shape.days[shape.days.length - 1];
  check(
    'the final week is drawn to its own end, never cut at today',
    future.count > 0 || lastGridDay === HEATMAP_TODAY,
    `futureCells=${future.count} lastGridDay=${lastGridDay} today=${HEATMAP_TODAY}`,
  );
  check(
    'a day after today carries no pending state of its own',
    future.pendingClasses === 0,
    `future=${future.count} pendingClasses=${future.pendingClasses}`,
  );
  // Every cell is clickable now, including a day with nothing stored: its tooltip says so, which is
  // the answer to "what happened on this date" rather than a reason to refuse the question.
  check('a day after today is still clickable', future.interactive === future.count, `interactive=${future.interactive} of ${future.count}`);
  check(
    'a day after today takes the unrecorded state, not a recorded zero',
    future.futureClasses.every((name) => name === 'is-unrecorded'),
    `futureClasses=[${future.futureClasses.join(', ')}]`,
  );
  // Compared against the zeros rather than against the other unrecorded cells: a future day *is* an
  // unrecorded cell, so naming that set made the check compare a cell with itself. What is worth
  // pinning is the distinction the two tokens exist for - a day nobody asked about must not paint
  // like a day that was asked about and answered zero.
  check(
    'a day after today does not paint like a day that was measured as zero',
    future.count === 0 || (future.futureFills.length === 1 && future.futureFills.every((fill) => !future.zeroFills.includes(fill))),
    `future=[${future.futureFills.join(', ')}] zeros=[${future.zeroFills.join(', ')}]`,
  );

  // The field has to reach its panel's edges, and it must never scroll: a field that only shows
  // part of the year is not the reading it was built for.
  const fit = await page.evaluate(() => {
    const scroll = document.querySelector('.heatmap-scroll');
    const panel = scroll.parentElement;
    const body = document.querySelector('.heatmap-body');
    const grid = document.querySelector('.heatmap-grid');
    const months = document.querySelector('.heatmap-months');
    return {
      panelWidth: panel.clientWidth,
      bodyWidth: body.getBoundingClientRect().width,
      gridWidth: grid.getBoundingClientRect().width,
      horizontalOverflow: scroll.scrollWidth - scroll.clientWidth,
      verticalOverflow: scroll.scrollHeight - scroll.clientHeight,
      monthsOverflow: months.scrollWidth - months.clientWidth,
      // Each label against the column it names. Comparing widths cannot see this: the axis was 30px
      // wider than the grid for as long as it drifted, and an overflow check passes on a misaligned
      // axis because both are still inside the scroll container. Measured per label, the drift
      // reached 17px on a desktop and 27px on a phone.
      monthDrift: (() => {
        const cells = [...grid.querySelectorAll('.heatmap-cell')];
        const columnOf = (el) => Number(getComputedStyle(el).gridColumn.split('/')[0].trim());
        return [...months.querySelectorAll('.heatmap-month')].map((label) => {
          const cell = cells.find((c) => columnOf(c) === columnOf(label));
          if (!cell) return 0;
          return Math.round(label.getBoundingClientRect().left - cell.getBoundingClientRect().left);
        });
      })(),
      cell: Number(getComputedStyle(grid.querySelector('.heatmap-cell')).width.replace('px', '')),
      cellRatio: (() => {
        const box = grid.querySelector('.heatmap-cell').getBoundingClientRect();
        return box.height / box.width;
      })(),
    };
  });
  check(
    'the grid fills the panel rather than leaving a gutter',
    fit.bodyWidth >= fit.panelWidth - 1 && fit.gridWidth / fit.panelWidth > 0.95,
    `panel=${fit.panelWidth} body=${Math.round(fit.bodyWidth)} grid=${Math.round(fit.gridWidth)}`,
  );
  check('the field never scrolls horizontally', fit.horizontalOverflow <= 0, `horizontalOverflow=${fit.horizontalOverflow}`);
  check('the field never scrolls vertically', fit.verticalOverflow <= 0, `verticalOverflow=${fit.verticalOverflow}`);
  // The axis is aligned with the columns it names. Measured per label rather than by comparing
  // widths, which passes on a drifting axis.
  check(
    'the month axis lines up with the columns it names',
    fit.monthsOverflow <= 0 && fit.monthDrift.length > 0 && fit.monthDrift.every((drift) => Math.abs(drift) <= 1),
    `monthsOverflow=${fit.monthsOverflow} maxDrift=${Math.max(...fit.monthDrift.map(Math.abs))}`,
  );
  check('the cells are square', Math.abs(fit.cellRatio - 1) < 0.02, `height/width=${fit.cellRatio.toFixed(3)}`);
  check('the cells are large enough to read', fit.cell >= 12, `cell=${fit.cell}px`);

  // The panel carries the title, the grid and the legend and nothing else: the three readouts the
  // earlier versions had were restating what a tooltip says on demand.
  const chrome = await page.evaluate(() => ({
    title: document.querySelector('.heatmap-panel .tile-label')?.textContent ?? null,
    readout: document.querySelectorAll('.heatmap-readout').length,
    caption: document.querySelectorAll('.heatmap-caption').length,
    metricSwitcher: document.querySelectorAll('.heatmap-metric').length,
    range: document.querySelectorAll('.heatmap-span').length,
    legend: document.querySelectorAll('.heatmap-legend').length,
    foot: document.querySelectorAll('.heatmap-foot').length,
  }));
  check('the panel is titled', (chrome.title ?? '').length > 0, `title=${JSON.stringify(chrome.title)}`);
  check(
    'the panel carries no readout, caption, range or metric switcher',
    chrome.readout === 0 && chrome.caption === 0 && chrome.range === 0 && chrome.metricSwitcher === 0,
    JSON.stringify(chrome),
  );
  // No legend either. A key explains what a stepped scale's bands mean, and a continuous ramp has
  // none: the shade is relative to the window, so a swatch ladder would describe the field's own
  // range rather than a fixed quantity. The numbers are in each cell's tooltip and accessible name.
  check(
    'the panel carries no legend, because a continuous ramp has no bands to explain',
    chrome.legend === 0 && chrome.foot === 0,
    `legend=${chrome.legend} foot=${chrome.foot}`,
  );

  // The ramp is continuous, so the assertion is that distinct volumes paint distinct fills rather
  // than the four fixed shades it used to. Read from the painted colour, not the class: a class can
  // be right while the mix resolves to one shade, which is the regression this catches.
  const measuredFills = await page.evaluate(() => {
    const sets = [...document.querySelectorAll('.heatmap-grid .heatmap-cell.is-measured')];
    return {
      fills: [...new Set(sets.map((cell) => getComputedStyle(cell).backgroundColor))],
      shares: [...new Set(sets.map((cell) => cell.style.getPropertyValue('--heatmap-quiet-share')))],
    };
  });
  check(
    'every marked day with a distinct volume paints a distinct fill',
    measuredFills.fills.length === heatmapMarked.filter((entry) => entry.tokens > 0).length,
    `fills=${measuredFills.fills.length} shares=${measuredFills.shares.length} (${measuredFills.fills.join(', ')})`,
  );
  // And those fills really are interpolations of one hue rather than unrelated colours.
  const rampShape = await page.evaluate(() => {
    const cell = document.querySelector('.heatmap-grid .heatmap-cell.is-measured');
    const busyStop = getComputedStyle(document.documentElement).getPropertyValue('--heatmap-busy').trim();
    return { busyStop, share: cell.style.getPropertyValue('--heatmap-quiet-share') };
  });
  check(
    'a measured cell carries its own position on the ramp',
    /%$/.test(rampShape.share),
    `share=${rampShape.share} busyStop=${rampShape.busyStop}`,
  );

  // The ramp must stay off the status hues. design.md reserves green/amber/red for state, and a
  // busy day painted in the success token would read as a healthy day - a verdict the grid has no
  // basis for. Only a pixel reading can enforce this.
  const statusFills = await page.evaluate(() => {
    const read = (name) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${name})`;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };
    const status = new Set([read('--success'), read('--warn'), read('--danger')]);
    const offenders = new Set();
    for (const cell of document.querySelectorAll('.heatmap-grid .heatmap-cell')) {
      const fill = getComputedStyle(cell).backgroundColor;
      if (status.has(fill)) offenders.add(fill);
    }
    return [...offenders];
  });
  check('the density ramp uses no status colour', statusFills.length === 0, `statusFills=${statusFills.join(',')}`);

  // The tooltip opens on click and carries the date, the request count, the token volume and the
  // link that opens the day. Click, not hover: a hover tooltip on a field this dense fires
  // continuously as the pointer crosses it, and it competes with the hover ring for the gesture.
  const busiest = heatmapMarked[0];
  const busiestCell = page.locator(`.heatmap-cell[data-day="${busiest.day}"]`);
  const tooltip = page.locator('.ant-tooltip:not(.ant-tooltip-hidden) .heatmap-tip');
  // Hover must NOT open it: that is the behaviour this replaced.
  await busiestCell.hover();
  await page.waitForTimeout(300);
  check(
    'hovering a cell does not open its tooltip',
    (await page.locator('.ant-tooltip:not(.ant-tooltip-hidden)').count()) === 0,
    'tooltip opened on hover',
  );

  await busiestCell.click();
  await tooltip.waitFor({ state: 'visible', timeout: 5000 });
  const tooltipText = await tooltip.innerText();
  check('the tooltip names the day', /\d{4}/.test(tooltipText), `tooltip=${JSON.stringify(tooltipText)}`);
  check('the tooltip reports the request count', tooltipText.includes(busiest.requests.toLocaleString('en')), `tooltip=${JSON.stringify(tooltipText)}`);
  check('the tooltip offers the drill-down as a link', tooltipText.toLowerCase().includes('view requests'), `tooltip=${JSON.stringify(tooltipText)}`);

  // The token volume reads in the console's unit style, and the exact count stays reachable.
  //
  // This is the one token readout on the page that used to bypass the shared display layer and print
  // its own exact form, so the KPI tiles directly above it obeyed `omc_token_style` while the tooltip
  // did not - the defect this asserts against. One reader serves both this block and the stored-style
  // check at the end of the scenario, and it finds the row by its own label rather than by position so
  // an assertion names the quantity it is about.
  const tooltipRows = () => tooltip.evaluate((node) => [...node.querySelectorAll('.heatmap-tip-row')].map((row) => ({
    label: row.querySelector('dt')?.textContent?.trim() ?? '',
    value: row.querySelector('dd')?.textContent?.trim() ?? '',
    // The exact count an abbreviated value carries, or null when the row prints it directly.
    exact: row.querySelector('dd')?.getAttribute('title'),
  })));
  const tokenRowOf = (rows) => rows.find((row) => /^(Tokens|Token \u7528\u91cf)$/.test(row.label));

  const styledTokens = tokenRowOf(await tooltipRows());
  // The default style is the compact one, so the fixture's busiest day (100,000) must read as a
  // suffixed abbreviation. Asserted as a positive shape for the reason the OMC-settings scenario
  // states: "not the grouped digits" would also pass on a value that never rendered at all.
  check(
    'the tooltip prints its token volume in the console\'s unit style',
    styledTokens !== undefined && /^\d+(\.\d+)?[KMBT]$/.test(styledTokens.value),
    `tokens=${JSON.stringify(styledTokens)}`,
  );
  // An abbreviation is a rounded claim, so the number it rounded must remain reachable - the same
  // arrangement the model panels' tooltips use.
  check(
    'the abbreviated volume keeps its exact count',
    styledTokens?.exact === busiest.tokens.toLocaleString('en'),
    `exact=${JSON.stringify(styledTokens?.exact)} expected=${busiest.tokens.toLocaleString('en')}`,
  );

  // The drill-down is a real anchor: it can be opened in a new tab and copied, and clicking the
  // cell itself must not navigate - that is what the link is for.
  const link = tooltip.locator('a.heatmap-tip-link');
  check('the drill-down is an anchor rather than a handler', (await link.count()) === 1);
  // The href must carry the router's basename. A bare anchor with the router-internal path skips
  // the `/omc` prefix and lands outside the app, and an assertion that only checked the suffix
  // would pass on the broken URL - which is exactly how that shipped once.
  const href = await link.getAttribute('href');
  const expectedHref = `/omc/usage/events?from=${busiest.from_ms}&to=${busiest.to_ms}`;
  check('the link points at that day\'s request list, under the app basename', href === expectedHref, `href=${href}`);
  check('the link carries both day bounds', href?.includes(`from=${busiest.from_ms}`) && href?.includes(`to=${busiest.to_ms}`), `href=${href}`);
  check('the link is keyboard-reachable', await link.evaluate((node) => node.tabIndex >= 0 || node.nodeName === 'A'));

  // Every line of the tooltip clears WCAG AA against the popper's own background, in both themes.
  // This shipped broken twice: the light theme's spotlight background was dark while the text was
  // the dark-theme foreground (ratio 1.0 - invisible), and the label and link steps sat at 4.4 and
  // 3.4. The ratio is computed here rather than eyeballed, because a colour token that reads fine
  // in one theme is exactly the thing a screenshot in the other theme will not catch.
  const contrast = await page.evaluate(() => {
    const tip = document.querySelector('.ant-tooltip:not(.ant-tooltip-hidden)');
    const luminance = (colour) => {
      const parts = colour.match(/[\d.]+/g).map(Number);
      const [r, g, b] = parts.slice(0, 3).map((value) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (foreground, background) => {
      const first = luminance(foreground) + 0.05;
      const second = luminance(background) + 0.05;
      return Math.max(first, second) / Math.min(first, second);
    };
    // The first opaque background above the text is the popper's own fill.
    let background = 'rgba(0, 0, 0, 0)';
    let node = tip.querySelector('.ant-tooltip-container');
    while (node && background === 'rgba(0, 0, 0, 0)') {
      background = getComputedStyle(node).backgroundColor;
      node = node.parentElement;
    }
    const samples = {
      day: tip.querySelector('.heatmap-tip-day'),
      label: tip.querySelector('.heatmap-tip-row dt'),
      value: tip.querySelector('.heatmap-tip-row dd'),
      link: tip.querySelector('.heatmap-tip-link'),
    };
    const out = { background };
    for (const [name, element] of Object.entries(samples)) {
      out[name] = Number(ratio(getComputedStyle(element).color, background).toFixed(2));
    }
    return out;
  });
  for (const part of ['day', 'label', 'value', 'link']) {
    check(
      `the tooltip's ${part} text clears WCAG AA contrast`,
      contrast[part] >= 4.5,
      `ratio=${contrast[part]} on ${contrast.background}`,
    );
  }


  // Clicking the cell opened the tooltip and nothing else.
  const stillOnDashboard = await page.evaluate(() => location.pathname.endsWith('/dashboard'));
  check('clicking a day opens the tooltip without navigating', stillOnDashboard, `path=${await page.evaluate(() => location.pathname)}`);

  // Hovering an interactive cell lifts it.
  //
  // Every probe context runs with `prefers-reduced-motion: reduce` so geometry is deterministic, so
  // this asserts the *reduced-motion* contract: the acknowledgement survives and the movement does
  // not. That is the half of the pair that must not regress silently - a motion rule added without
  // the matching reduced-motion override would make the panel move for readers who asked it not to,
  // and no other check in the suite would notice.
  // The motion is on the inner mark, not the cell: the cell is antd's placement anchor and must
  // not move under an open popper.
  const motion = await page.evaluate((day) => {
    const cell = document.querySelector(`.heatmap-cell[data-day="${day}"]`);
    const mark = cell.querySelector('.heatmap-cell-mark');
    return {
      cellTransform: getComputedStyle(cell).transform,
      mark: mark ? getComputedStyle(mark).transform : null,
      transition: mark ? getComputedStyle(mark).transitionProperty : null,
      pointerEvents: mark ? getComputedStyle(mark).pointerEvents : null,
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
  }, busiest.day);
  check('the probe context is a reduced-motion one', motion.reduced === true, `reduced=${motion.reduced}`);
  // The anchor itself must never be transformed, whatever the motion does.
  check('the tooltip\'s anchor is never transformed', motion.cellTransform === 'none', `transform=${motion.cellTransform}`);
  check('the mark does not intercept the pointer', motion.pointerEvents === 'none', `pointerEvents=${motion.pointerEvents}`);
  check(
    'reduced motion suppresses the hover transition',
    motion.transition === 'none',
    `transitionProperty=${motion.transition}`,
  );
  await busiestCell.hover();
  await page.waitForTimeout(200);
  const held = await page.evaluate((day) => {
    const cell = document.querySelector(`.heatmap-cell[data-day="${day}"]`);
    const mark = cell.querySelector('.heatmap-cell-mark');
    return {
      markTransform: mark ? getComputedStyle(mark).transform : null,
      cursor: getComputedStyle(cell).cursor,
    };
  }, busiest.day);
  check('reduced motion suppresses the lift', held.markTransform === 'none', `transform=${held.markTransform}`);
  // The pointer affordance is what remains, and it is the acknowledgement that must survive.
  check('the cell still advertises that it is interactive', held.cursor === 'pointer', `cursor=${held.cursor}`);

  // The declared motion is asserted from the stylesheet rather than from a rendered frame, because
  // no probe context can render it: `prefers-reduced-motion` is forced on for determinism. The rule
  // itself is what matters - a colour transition on hover would smear behind a fast sweep, which is
  // what design.md §7 rule 7 forbids, and only the declaration can say which property animates.
  const declaredMotion = await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of rules) {
        // The mark's own rule: the transition belongs to the element that scales, not to the
        // stationary anchor.
        if (rule.selectorText === '.heatmap-cell-mark' && rule.style.transition) {
          return rule.style.transition;
        }
        if (rule.selectorText === '.heatmap-cell.is-interactive:hover .heatmap-cell-mark' && rule.style.transform) {
          return { transition: null, transform: rule.style.transform };
        }
      }
    }
    return null;
  });
  const declared = typeof declaredMotion === 'string' ? declaredMotion : declaredMotion?.transition ?? null;
  check('the stylesheet declares a hover transition', declared !== null, `transition=${declared}`);
  check(
    'the declared hover motion animates only the transform',
    typeof declared === 'string' && declared.includes('transform') && !/color|background|box-shadow/.test(declared),
    `transition=${declared}`,
  );
  const declaredScale = await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of rules) {
        if (rule.selectorText === '.heatmap-cell.is-interactive:hover .heatmap-cell-mark' && rule.style.transform) {
          const match = /scale\(([\d.]+)\)/.exec(rule.style.transform);
          return match ? Number(match[1]) : null;
        }
      }
    }
    return null;
  });
  check(
    'the declared hover lift is restrained and cannot clip the edge',
    declaredScale !== null && declaredScale <= 1.2,
    `scale=${declaredScale}`,
  );

  // A cell with no requests is clickable too, and its tooltip reports the absence rather than the two
  // counts. That is the point: "no requests on this date" is a fact the panel can state, while
  // "Requests 0 / Tokens 0" would be a measurement nothing is stored to support.
  const quietDay = heatmapMarked.find((entry) => entry.tokens === 0).day;
  const quietCell = page.locator(`.heatmap-cell[data-day="${quietDay}"]`);
  check('a trafficless cell advertises that it is clickable', (await quietCell.evaluate((node) => getComputedStyle(node).cursor)) === 'pointer');
  check('a trafficless cell takes a tab stop when focused', (await quietCell.evaluate((node) => Number(node.getAttribute('tabindex')) <= 0)) === true);
  await quietCell.click();
  await page.waitForTimeout(300);
  const quietTip = page.locator('.ant-tooltip:not(.ant-tooltip-hidden) .heatmap-tip');
  await quietTip.waitFor({ state: 'visible', timeout: 5000 });
  const quietText = await quietTip.innerText();
  check('a trafficless cell opens a tooltip', (await quietTip.count()) === 1, `text=${JSON.stringify(quietText)}`);
  check(
    'the trafficless tooltip says there were no requests',
    /no requests/i.test(quietText),
    `text=${JSON.stringify(quietText)}`,
  );
  // It states the absence *instead of* the counts. The date line carries digits of its own, so the
  // check is that no line reports a zero count - not that the tooltip contains no zero anywhere.
  const zeroLines = quietText.split('\n').filter((line) => /^\s*(requests|tokens|请求次数|Token)\b/i.test(line) && /(^|\D)0(\D|$)/.test(line));
  check(
    'the trafficless tooltip prints no zero counts',
    zeroLines.length === 0,
    `zeroLines=${JSON.stringify(zeroLines)} text=${JSON.stringify(quietText)}`,
  );
  check(
    'the trafficless tooltip offers no drill-down link',
    (await quietTip.locator('a.heatmap-tip-link').count()) === 0,
    `links=${await quietTip.locator('a.heatmap-tip-link').count()}`,
  );
  // The accessible name follows the cell's state, not the response's shape. The server emits a
  // zero-valued entry for every day in the window, so a name built from the entry's presence
  // announced "0 requests, 0 tokens" for days nothing is stored for - telling a screen reader a
  // measurement exists where the colour and the tooltip both say none does.
  const quietName = await quietCell.getAttribute('aria-label');
  check(
    'a trafficless cell is named as carrying no measurement, not as a measured zero',
    Boolean(quietName) && /no requests/i.test(quietName) && !/(^|\D)0(\D|$)/.test(quietName.replace(/\d{4}/g, '')),
    `name=${JSON.stringify(quietName)}`,
  );
  const measuredName = await page.locator('.heatmap-cell.is-measured').first().getAttribute('aria-label');
  check(
    'a measured cell is still named with its own counts',
    Boolean(measuredName) && /\d/.test(measuredName) && !/no requests/i.test(measuredName),
    `name=${JSON.stringify(measuredName)}`,
  );
  // Legible against the popper it sits on, measured rather than assumed. This is the assertion that
  // was missing: the empty state's text had no colour rule of its own, so it inherited antd's white
  // - meant for antd's own dark spotlight - while this popper's fill is the light theme's surface.
  // The text assertions above all passed on an invisible tooltip, because `innerText` reads text
  // that is painted, not text a reader can see.
  const quietContrast = await quietTip.evaluate((node) => {
    const parse = (value) => (String(value).match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const linear = (channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (rgb) => 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
    // Walk up for the painted fill: the tooltip's own background is transparent.
    let box = node;
    let background = 'rgba(0, 0, 0, 0)';
    while (box && background === 'rgba(0, 0, 0, 0)') {
      background = getComputedStyle(box).backgroundColor;
      box = box.parentElement;
    }
    const empty = node.querySelector('.heatmap-tip-empty') ?? node;
    const fg = luminance(parse(getComputedStyle(empty).color));
    const bg = luminance(parse(background));
    return { ratio: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05), background };
  });
  check(
    'the trafficless tooltip text is legible against its own background',
    quietContrast.ratio >= 4.5,
    `ratio=${quietContrast.ratio.toFixed(2)} on ${quietContrast.background}`,
  );
  // Close it again so the following assertions start from a known state.
  await quietCell.click();
  await page.waitForTimeout(200);

  // The tooltip is centred on its cell and placed above it. Measured on a cell with room on both
  // sides: antd shifts a popper that would leave the viewport inward, which is correct and would
  // read here as a centring failure.
  //
  // "Room on both sides" is a fact about the viewport, not about the column index or a position in
  // the DOM. The assessed cells are spread across the year, and the grid is ordered by weekday row
  // rather than by date, so an index into that list lands on whatever weekday the fixture's marks
  // happen to occupy - on today's date it landed on today's own cell, the final column, which is
  // exactly the clamped case this measurement has to avoid. The central half of the viewport is
  // roomy by more than a popper's width and does not depend on either the calendar or the fixture.
  const interior = await page.evaluate(() => {
    const midViewport = window.innerWidth / 2;
    const hasRoom = (cell) => {
      const rect = cell.getBoundingClientRect();
      const centre = rect.left + rect.width / 2;
      const quarter = window.innerWidth / 4;
      return centre > quarter && centre < window.innerWidth - quarter;
    };
    const measured = [...document.querySelectorAll('.heatmap-grid .heatmap-cell.is-measured')];
    // A measured cell is preferred because it carries counts and a drill-down link; every cell opens
    // a tooltip, so any cell with room is still a valid anchor for a placement measurement.
    const candidates = measured.some(hasRoom)
      ? measured.filter(hasRoom)
      : [...document.querySelectorAll('.heatmap-grid .heatmap-cell')].filter(hasRoom);
    const closestToCentre = candidates.reduce(
      (best, cell) => {
        const rect = cell.getBoundingClientRect();
        const distance = Math.abs(rect.left + rect.width / 2 - midViewport);
        return best === null || distance < best.distance ? { cell, distance } : best;
      },
      null,
    );
    return closestToCentre?.cell.getAttribute('data-day') ?? null;
  });
  check('the fixture places a measured cell clear of the viewport edges', interior !== null, `interior=${interior}`);
  await page.locator(`.heatmap-cell[data-day="${interior}"]`).click();
  await page.waitForTimeout(250);
  const anchored = await page.evaluate((day) => {
    const cell = document.querySelector(`.heatmap-cell[data-day="${day}"]`);
    const tip = document.querySelector('.ant-tooltip:not(.ant-tooltip-hidden)');
    if (!tip || !cell?.closest('.ant-tooltip-open')) return { error: 'no open tooltip' };
    const cb = cell.getBoundingClientRect();
    const tb = tip.getBoundingClientRect();
    return {
      dx: Math.abs((tb.left + tb.width / 2) - (cb.left + cb.width / 2)),
      above: tb.bottom <= cb.top + 2,
      arrow: Boolean(tip.querySelector('.ant-tooltip-arrow')),
      withinViewport: tb.left >= 0 && tb.right <= window.innerWidth,
    };
  }, interior);
  check('the tooltip is centred on its cell', !anchored.error && anchored.dx <= 2, anchored.error ?? `dx=${anchored.dx.toFixed(2)}`);
  check('the tooltip is placed above the cell', anchored.above === true, `above=${anchored.above}`);
  check('the tooltip carries antd\'s arrow, so the panel inherits the app tooltip chrome', anchored.arrow === true, `arrow=${anchored.arrow}`);

  // A cell in the final column has nowhere to put a centred tooltip, so antd shifts it inward
  // rather than letting it overflow. The centred form is what the check above pins, so a regression
  // that removed the clamp would push this one off screen.
  //
  // The link check above left a tooltip open on the interior cell. Opening the last column's
  // tooltip for this check means clicking that cell, and the trigger toggles - so this relies on
  // antd closing the previous one, which it does when the trigger moves. Asserted rather than
  // assumed, because a stale tooltip would make the final navigation check click the wrong link.
  await busiestCell.click();
  await page.waitForTimeout(300);
  const clamped = await page.evaluate(() => {
    const tip = document.querySelector('.ant-tooltip:not(.ant-tooltip-hidden)');
    if (!tip) return { error: 'no open tooltip' };
    const tb = tip.getBoundingClientRect();
    return { withinViewport: tb.left >= 0 && tb.right <= window.innerWidth, right: Math.round(tb.right), viewport: window.innerWidth };
  });
  check(
    'a tooltip on the last column stays inside the viewport',
    clamped.withinViewport === true,
    clamped.error ?? `right=${clamped.right} viewport=${clamped.viewport}`,
  );

  // Hovering must not rebuild the cells. The hovered day is state (the tooltip names it), so
  // without memoizing the elements every pointer move reconciles ~370 nodes - which is what made a
  // fast sweep stutter. A marker on an untouched cell survives only if React re-used the element.
  const stability = await page.evaluate((day) => {
    const cells = [...document.querySelectorAll('.heatmap-grid .heatmap-cell')];
    const untouched = cells[100];
    untouched.dataset.stabilityMarker = 'original';
    window.__stabilityNode = untouched;
    return day;
  }, shape.days[200]);
  await page.locator(`.heatmap-cell[data-day="${stability}"]`).hover();
  await page.waitForTimeout(150);
  const survived = await page.evaluate(() => {
    const untouched = document.querySelectorAll('.heatmap-grid .heatmap-cell')[100];
    return { marker: untouched.dataset.stabilityMarker ?? null, sameNode: untouched === window.__stabilityNode };
  });
  check(
    'hovering re-uses the cells instead of rebuilding them all',
    survived.marker === 'original' && survived.sameNode,
    `marker=${survived.marker} sameNode=${survived.sameNode}`,
  );

  // Keyboard access: one cell in the tab order, the arrow keys walking the two axes, and the
  // tooltip following the focused day.
  // The tab stop lives on an interactive cell, so this is also the assertion that dead cells are
  // excluded from the tab order rather than merely looking inert.
  const tabStops = await page.locator('.heatmap-grid .heatmap-cell[tabindex="0"]').count();
  check('the grid keeps exactly one cell in the tab order', tabStops === 1, `tabStops=${tabStops}`);
  check(
    'the tab stop is on a cell that carried traffic',
    (await page.locator('.heatmap-grid .heatmap-cell[tabindex="0"].is-interactive').count()) === 1,
  );
  await page.locator('.heatmap-grid .heatmap-cell[tabindex="0"]').focus();
  const focusedDay = await page.evaluate(() => document.activeElement?.getAttribute('data-day') ?? null);
  check('the tab stop is a cell the browser will actually focus', focusedDay !== null, `focused=${focusedDay}`);

  // The starting cell has to be *interior*: mid-week and away from the first and last columns.
  // Movement deliberately does not wrap, so a key pressed on an edge is a legal no-op - and a probe
  // that started there would have asserted the axis by exercising nothing.
  const midWeek = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.heatmap-grid .heatmap-cell')];
    const columns = Math.max(...cells.map((cell) => Number(getComputedStyle(cell).gridColumnStart)));
    const target = cells.find((cell) => {
      const [year, month, date] = cell.getAttribute('data-day').split('-').map(Number);
      const weekday = (new Date(Date.UTC(year, month - 1, date)).getUTCDay() + 6) % 7;
      const column = Number(getComputedStyle(cell).gridColumnStart);
      return weekday === 3 && column > 2 && column < columns - 1;
    });
    return target?.getAttribute('data-day') ?? null;
  });
  check('the fixture has an interior mid-week cell to move from', midWeek !== null, `midWeek=${midWeek}`);
  await page.locator(`.heatmap-cell[data-day="${midWeek}"]`).focus();

  const dayDelta = (a, b) => Math.round((new Date(b) - new Date(a)) / 86_400_000);
  await page.keyboard.press('ArrowLeft');
  const weekBack = await page.evaluate(() => document.activeElement?.getAttribute('data-day') ?? null);
  await page.keyboard.press('ArrowRight');
  const weekForward = await page.evaluate(() => document.activeElement?.getAttribute('data-day') ?? null);
  check(
    'left and right move a whole week',
    dayDelta(weekBack, midWeek) === 7 && weekForward === midWeek,
    `from=${midWeek} back=${weekBack} forward=${weekForward}`,
  );
  await page.keyboard.press('ArrowUp');
  const rowUp = await page.evaluate(() => document.activeElement?.getAttribute('data-day') ?? null);
  await page.keyboard.press('ArrowDown');
  const rowDown = await page.evaluate(() => document.activeElement?.getAttribute('data-day') ?? null);
  check(
    'up and down move one weekday rather than one day',
    dayDelta(rowUp, midWeek) === 1 && rowDown === midWeek,
    `from=${midWeek} up=${rowUp} down=${rowDown}`,
  );
  // Movement is not restricted to interactive cells - the operator can walk the calendar to read
  // it - but the tab stop itself stays unique.
  const tabStopsAfterMove = await page.locator('.heatmap-grid .heatmap-cell[tabindex="0"]').count();
  check('the tab stop roves rather than accumulating', tabStopsAfterMove <= 1, `tabStops=${tabStopsAfterMove}`);

  await page.keyboard.press('Home');
  const homeDay = await page.evaluate(() => document.activeElement?.getAttribute('data-day') ?? null);
  check('Home reaches the oldest day', homeDay === shape.days[0], `home=${homeDay} expected=${shape.days[0]}`);
  await page.keyboard.press('End');
  const endDay = await page.evaluate(() => document.activeElement?.getAttribute('data-day') ?? null);
  check('End reaches the newest day', endDay === shape.days[shape.days.length - 1], `end=${endDay}`);

  // The drill-down navigates through the tooltip's link, and nowhere else: the cell itself opens
  // the tooltip. Asserted end to end, because the whole point of the change was that a click on a
  // square should not throw the operator out of the dashboard.
  // One cell is open at a time, and the click trigger toggles: clicking the same cell again would
  // close it, so this clicks once from a known state and waits for the tooltip to settle before
  // reaching inside it - the entrance motion makes the link briefly unstable to Playwright.
  check(
    'exactly one tooltip is open at a time',
    (await page.locator('.ant-tooltip:not(.ant-tooltip-hidden)').count()) === 1,
    `open=${await page.locator('.ant-tooltip:not(.ant-tooltip-hidden)').count()}`,
  );
  const openLink = tooltip.locator('a.heatmap-tip-link');
  await openLink.waitFor({ state: 'visible', timeout: 5000 });
  await openLink.click();
  await page.waitForFunction(() => location.pathname.endsWith('/usage/events'), null, { timeout: 10_000 });
  const query = await page.evaluate(() => Object.fromEntries(new URLSearchParams(location.search).entries()));
  check(
    "the tooltip's link opens the request list on that day's own bounds",
    Number(query.from) === busiest.from_ms && Number(query.to) === busiest.to_ms,
    `day=${busiest.day} from=${query.from} to=${query.to} expected=${busiest.from_ms}-${busiest.to_ms}`,
  );

  // ── the stored unit style governs the tooltip ─────────────────────────────
  //
  // The assertion above fixes this readout's *default* form; this one proves the choice is what drives
  // it. Both directions are needed, and they fail differently: a hardcoded compact form passes the
  // default check and fails this one, while the panel-local exact form this fixes - which obeyed no
  // setting at all - fails the default check. The scenario is re-entered rather than the live panel
  // re-read because the preference is a server-stored document: writing it and refetching is what the
  // console itself does.
  //
  // Run last because it writes a console-wide preference: every earlier check reads the default
  // reading, and a setting stored mid-flow would silently re-point them.
  await page.evaluate(async () => {
    await fetch('/omc/api/v1/preferences/omc_token_style', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify('full'),
    });
  });
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.heatmap-grid').waitFor({ timeout: 20_000 });
  await busiestCell.click();
  await tooltip.waitFor({ state: 'visible', timeout: 5000 });
  const tokenRowUnderStoredStyle = tokenRowOf(await tooltipRows());
  check(
    'storing the explicit-digit style switches the tooltip\'s token volume to it',
    tokenRowUnderStoredStyle?.value === busiest.tokens.toLocaleString('en'),
    `tokens=${JSON.stringify(tokenRowUnderStoredStyle)}`,
  );

  // The Chinese unit style is a real browser path, not a formatter assertion:
  // the previous reports were made while the shared formatter was already
  // present in source. Switching both language and stored style here catches a
  // stale context, cache or render path that a pure unit test cannot see.
  await page.evaluate(async () => {
    localStorage.setItem('omc-lang', 'zh');
    await fetch('/omc/api/v1/preferences/omc_token_style', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify('zh'),
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.heatmap-grid').waitFor({ timeout: 20_000 });
  await busiestCell.click();
  await tooltip.waitFor({ state: 'visible', timeout: 5000 });
  const tokenRowUnderChineseStyle = tokenRowOf(await tooltipRows());
  check(
    'the Chinese unit style reaches the tooltip in the browser',
    tokenRowUnderChineseStyle !== undefined && /^\d+(\.\d+)?(万|亿)$/.test(tokenRowUnderChineseStyle.value),
    `tokens=${JSON.stringify(tokenRowUnderChineseStyle)}`,
  );
  check(
    'the Chinese tooltip keeps the exact token count',
    tokenRowUnderChineseStyle?.exact === busiest.tokens.toLocaleString('en'),
    `exact=${JSON.stringify(tokenRowUnderChineseStyle?.exact)} expected=${busiest.tokens.toLocaleString('en')}`,
  );
}

/**
 * The heatmap on a phone.
 *
 * A year of weeks cannot fit a 390px viewport at a legible cell size, so the field is swipeable
 * there - and that is where it went wrong once already: it opened on the oldest column, leaving
 * today off screen. These are the assertions that would have caught it, plus the two a grid adds:
 * seven rows have to survive the narrow breakpoint, and a tap in the middle of a square must open
 * that square's day rather than a neighbour's.
 */
export async function dashboardTokenHeatmapMobile({ base, page, check }) {
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.heatmap-grid').waitFor({ timeout: 20_000 });

  // The page itself must never scroll sideways; the field swipes inside its own container so the
  // rest of the dashboard keeps its layout.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('the dashboard does not overflow horizontally on a phone', overflow <= 0, `overflow=${overflow}px`);

  // The field keeps its shape at the narrow breakpoint: shrinking the cells must not wrap the grid
  // into a second block of seven rows, which would destroy the row-per-weekday reading.
  const shape = await page.evaluate(() => {
    const grid = document.querySelector('.heatmap-grid');
    const scroll = document.querySelector('.heatmap-scroll');
    const cells = [...grid.querySelectorAll('.heatmap-cell')];
    return {
      rows: new Set(cells.map((cell) => getComputedStyle(cell).gridRowStart)).size,
      columns: new Set(cells.map((cell) => getComputedStyle(cell).gridColumnStart)).size,
      scrollable: scroll.scrollWidth > scroll.clientWidth + 1,
      weekdays: document.querySelectorAll('.heatmap-weekday').length,
      cell: Number(getComputedStyle(cells[0]).width.replace('px', '')),
      // A bar inside a dashboard card is visual noise, and touch has none anyway.
      scrollbarWidth: getComputedStyle(scroll).scrollbarWidth,
      widthDelta: scroll.offsetWidth - scroll.clientWidth,
    };
  });
  check('the grid keeps all seven rows on a phone', shape.rows === 7, `rows=${shape.rows}`);
  check('the grid keeps its 53 columns on a phone', shape.columns === HEATMAP_WEEKS, `columns=${shape.columns}`);
  check('the grid labels all seven rows on a phone', shape.weekdays === 7, `weekdays=${shape.weekdays}`);
  check('the cells stay at the legible floor', shape.cell >= 9, `cell=${shape.cell}px`);
  // A year of weeks cannot fit a phone at a legible size, so the field is swipeable - with the bar
  // hidden, since a scrollbar in the card is noise.
  check('a too-narrow panel is swipeable rather than clipped', shape.scrollable, `scrollable=${shape.scrollable}`);
  check(
    'the swipe leaves no visible scrollbar',
    shape.scrollbarWidth === 'none' && shape.widthDelta === 0,
    `scrollbarWidth=${shape.scrollbarWidth} widthDelta=${shape.widthDelta}`,
  );

  // It opens scrolled to today, which is the column whose total is still growing. Without this the
  // operator lands three months in the past with today off screen.
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${`${today.getMonth() + 1}`.padStart(2, '0')}-${`${today.getDate()}`.padStart(2, '0')}`;
  const opened = await page.evaluate((key) => {
    const scroll = document.querySelector('.heatmap-scroll');
    const bounds = scroll.getBoundingClientRect();
    const cells = [...document.querySelectorAll('.heatmap-grid .heatmap-cell')];
    const cell = cells.find((candidate) => candidate.getAttribute('data-day') === key);
    if (!cell) return { error: 'today is not in the grid' };
    const box = cell.getBoundingClientRect();
    return {
      scrollLeft: Math.round(scroll.scrollLeft),
      maxScroll: scroll.scrollWidth - scroll.clientWidth,
      todayVisible: box.left >= bounds.left - 1 && box.right <= bounds.right + 1,
    };
  }, todayKey);
  check(
    'the field opens scrolled to today rather than to the oldest week',
    opened.todayVisible && opened.scrollLeft === opened.maxScroll,
    `scrollLeft=${opened.scrollLeft}/${opened.maxScroll} todayVisible=${opened.todayVisible}`,
  );

  // A tap in the middle of a square opens that square's day. The panel is brought into view first:
  // `elementFromPoint` cannot resolve a point below the fold.
  await page.locator('.heatmap-panel').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const tap = await page.evaluate(() => {
    // The visible window is the *scroll container's* box, not the grid's: the grid is wider than
    // the panel, so its own rect extends past the viewport and a cell picked from it can sit
    // entirely off-screen.
    const scroll = document.querySelector('.heatmap-scroll');
    const bounds = scroll.getBoundingClientRect();
    const cells = [...document.querySelectorAll('.heatmap-grid .heatmap-cell')];
    const target = cells.find((cell) => {
      const box = cell.getBoundingClientRect();
      return box.left > bounds.left + 40 && box.right < bounds.right - 40
        && box.top >= bounds.top && box.bottom <= bounds.bottom;
    });
    if (!target) return { error: 'no fully visible cell' };
    const box = target.getBoundingClientRect();
    const closestDay = (x, y) => document.elementFromPoint(x, y)?.closest('.heatmap-cell')?.getAttribute('data-day') ?? null;
    const centreDay = closestDay(box.left + box.width / 2, box.top + box.height / 2);
    // Walk the vertical extent to measure how tall the target really is.
    let top = null;
    let bottom = null;
    for (let y = box.top - 20; y <= box.bottom + 20; y += 1) {
      if (closestDay(box.left + box.width / 2, y) === target.getAttribute('data-day')) {
        if (top === null) top = y;
        bottom = y;
      }
    }
    return {
      day: target.getAttribute('data-day'),
      centreDay,
      cellWidth: Math.round(box.width),
      targetHeight: top === null ? 0 : Math.round(bottom - top + 1),
    };
  });
  check(
    'a tap in the middle of a day opens that day, not its neighbour',
    tap.centreDay === tap.day,
    `cell=${tap.day} centreHit=${tap.centreDay} (width=${tap.cellWidth})`,
  );
  check(
    'the tap target is at least as tall as the visible square',
    tap.targetHeight >= tap.cellWidth,
    `targetHeight=${tap.targetHeight} cellWidth=${tap.cellWidth}`,
  );
}

/**
 * The grid as a deployment actually shows it: most cells predate the retention horizon.
 *
 * The assertion that matters is the *mark*: an unrecorded day is a solid fill ordered against the
 * card, never an outline. Outlining them turned a year of cells into a wire mesh - 275 1px boxes
 * competing with the handful of green squares the panel exists to show.
 */
export async function dashboardTokenHeatmapPruned({ base, page, check }) {
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.heatmap-grid').waitFor({ timeout: 20_000 });

  const states = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.heatmap-grid .heatmap-cell')];
    const counts = {};
    for (const cell of cells) {
      const state = ['is-measured', 'is-empty', 'is-unrecorded', 'is-pending']
        .find((name) => cell.classList.contains(name)) ?? 'unknown';
      counts[state] = (counts[state] ?? 0) + 1;
    }
    const card = getComputedStyle(document.querySelector('.heatmap-panel')).backgroundColor;
    const sample = (selector) => {
      const found = document.querySelector(`.heatmap-grid ${selector}`);
      if (!found) return null;
      const style = getComputedStyle(found);
      return { fill: style.backgroundColor, shadow: style.boxShadow };
    };
    // Contrast against the card, which is the surface the cells are read on.
    const luminance = (colour) => {
      const parts = colour.match(/[\d.]+/g).map(Number);
      const [r, g, b] = parts.slice(0, 3).map((value) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const against = (colour) => {
      const first = luminance(colour) + 0.05;
      const second = luminance(card) + 0.05;
      return Number((Math.max(first, second) / Math.min(first, second)).toFixed(3));
    };
    const unrecorded = sample('.heatmap-cell.is-unrecorded');
    const empty = sample('.heatmap-cell.is-empty');
    const measured = sample('.heatmap-cell.is-measured');
    return {
      counts,
      card,
      unrecorded,
      empty,
      measured,
      ratio: {
        unrecorded: unrecorded ? against(unrecorded.fill) : null,
        empty: empty ? against(empty.fill) : null,
        measured: measured ? against(measured.fill) : null,
      },
    };
  });

  // The fixture has to actually produce the case, or everything below passes vacuously.
  check(
    'the pruned fixture produces unrecorded days',
    states.counts['is-unrecorded'] > 200,
    `unrecorded=${states.counts['is-unrecorded']} of ${Object.values(states.counts).reduce((a, b) => a + b, 0)}`,
  );

  // A solid fill, not an outline. This is the defect: 1px boxes over most of the grid read as a mesh.
  check(
    'an unrecorded day is a solid fill rather than an outline',
    states.unrecorded !== null && states.unrecorded.fill !== 'rgba(0, 0, 0, 0)' && states.unrecorded.shadow === 'none',
    `fill=${states.unrecorded?.fill} shadow=${states.unrecorded?.shadow}`,
  );
  check(
    'every zero state is a solid fill rather than an outline',
    states.empty !== null && states.empty.fill !== 'rgba(0, 0, 0, 0)' && states.empty.shadow === 'none',
    `emptyFill=${states.empty?.fill} emptyShadow=${states.empty?.shadow}`,
  );

  // The order carries the meaning: no information is quietest, a measured zero is a step louder, and
  // a day with traffic is the only thing clearly above the card. Asserted as a chain so a token
  // swapped in the wrong direction fails rather than merely looking odd.
  check(
    'the two zero states are quieter than the card and a measured day is louder',
    states.ratio.unrecorded < states.ratio.empty && states.ratio.empty < states.ratio.measured,
    `unrecorded=${states.ratio.unrecorded} empty=${states.ratio.empty} measured=${states.ratio.measured}`,
  );
  // And both zeros stay quiet: they must never compete with the greens that carry the data.
  check(
    'neither zero state competes with the measured cells',
    states.ratio.unrecorded < 1.15 && states.ratio.empty < 1.2,
    `unrecorded=${states.ratio.unrecorded} empty=${states.ratio.empty}`,
  );
}

/**
 * The heatmap's failure paths.
 *
 * Two failures matter and they are different: a first load that never succeeded has
 * no strip to show and must say so (rather than leaving a skeleton up forever, which
 * is indistinguishable from a slow read), while a *refresh* that failed must keep the
 * strip the operator is reading. The second is the one a "the panel rendered"
 * assertion cannot see, because the panel renders either way.
 */
export async function dashboardTokenHeatmapFailure({ base, page, check, context }) {
  // A first load against a failing endpoint: the panel reports it and offers a retry.
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.heatmap-panel .ant-alert-error').waitFor({ timeout: 20_000 });
  const errorText = await page.locator('.heatmap-panel .ant-alert-error').innerText();
  check('a failed first load is reported rather than left loading', errorText.length > 0, `alert=${JSON.stringify(errorText.slice(0, 120))}`);
  check('the failed panel offers a retry', (await page.locator('.heatmap-panel .ant-alert-error button').count()) === 1);
  check(
    'the failed panel does not show a grid it never read',
    (await page.locator('.heatmap-grid').count()) === 0,
  );

  // A load that succeeded and then a refresh that failed: the strip stays, and the
  // warning is additive. The route is re-pointed at the failure after the first read.
  const { page: page2 } = await (async () => {
    const fresh = await context.newPage();
    return { page: fresh };
  })();
  let failNext = false;
  await context.route('**/omc/api/**/dashboard/token-heatmap**', async (route) => {
    if (failNext) return route.fulfill({ status: 503, json: { error: 'database is unavailable' } });
    return route.fulfill({ status: 200, json: chartTokenHeatmap });
  });
  await page2.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page2.locator('.heatmap-grid').waitFor({ timeout: 20_000 });
  const cellsBefore = await page2.locator('.heatmap-grid .heatmap-cell').count();
  check('the grid renders before the refresh failure', cellsBefore === HEATMAP_TOTAL_DAYS, `cells=${cellsBefore}`);

  // Pressing the page's refresh button re-reads the grid, and that read fails.
  failNext = true;
  await page2.locator('.terminal-page-head button:has(.anticon-reload)').first().click();
  await page2.locator('.heatmap-stale-alert').waitFor({ timeout: 20_000 });
  const cellsAfter = await page2.locator('.heatmap-grid .heatmap-cell').count();
  check(
    'a failed refresh keeps the grid the operator was reading',
    cellsAfter === HEATMAP_TOTAL_DAYS,
    `cells=${cellsAfter}`,
  );
  const warningText = await page2.locator('.heatmap-stale-alert').innerText();
  check('the stale grid says the refresh failed', warningText.length > 0, `alert=${JSON.stringify(warningText.slice(0, 120))}`);

  // And a retry that succeeds clears the warning, so the panel does not stay stuck in
  // its degraded state after the read recovers.
  failNext = false;
  await page2.locator('.heatmap-stale-alert button').click();
  await page2.locator('.heatmap-stale-alert').waitFor({ state: 'detached', timeout: 20_000 });
  check('a successful retry clears the warning', (await page2.locator('.heatmap-stale-alert').count()) === 0);
}

// ---------------------------------------------------------------------------
// Dashboard sparkline marks
// ---------------------------------------------------------------------------

