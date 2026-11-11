/**
 * The receipt's stylesheet.
 *
 * It is a string rather than a CSS module because two documents read it: the page, which shows the
 * receipt, and the standalone SVG the receipt is rasterised from when it is copied or exported. One
 * sheet for both is what makes the picture the reader shares exactly the receipt they looked at.
 *
 * The paper keeps its own fixed colours in both themes, the way a slip of paper is the same colour
 * whatever room it is read in. The face is `--receipt-font`: the console's monospace on the page,
 * and an embedded copy of it in the exported picture.
 */
export const RECEIPT_CSS = `
.omc-receipt {
  --paper: #f6f4ef;
  --ink: #1c1c1e;
  --ink-2: #4b4b50;
  --muted: #6b6964;
  --rule: rgba(28, 28, 30, 0.22);
  --up: #b4462f;
  --down: #2f7a4a;
  position: relative;
  box-sizing: border-box;
  width: 400px;
  max-width: 100%;
  padding: 36px 30px 34px;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--receipt-font, var(--font-mono, monospace));
  font-size: 13px;
  line-height: 1.6;
  font-variant-numeric: tabular-nums;
  text-align: left;
  -webkit-font-smoothing: antialiased;
}
/* The torn foot: a row of small teeth in the paper's colour, hung below its last line. */
.omc-receipt::after {
  content: "";
  position: absolute;
  inset: 100% 0 auto;
  height: 7px;
  background: conic-gradient(from -45deg at bottom, var(--paper) 90deg, transparent 0) 0 0 / 14px 7px repeat-x;
}
.omc-receipt * { box-sizing: border-box; margin: 0; padding: 0; }

.omc-receipt-head { display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; }
.omc-receipt-logo { display: block; height: 17px; width: auto; }
.omc-receipt-title { margin-top: 6px; font-size: 26px; font-weight: 700; line-height: 1.2; letter-spacing: 0.08em; }
.omc-receipt-tagline { color: var(--muted); font-size: 12px; }

.omc-receipt-rule { margin: 16px 0; border: 0; border-top: 1px dashed var(--rule); }

.omc-receipt-rows { display: flex; flex-direction: column; gap: 3px; }
.omc-receipt-row { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
.omc-receipt-row dt { flex: none; color: var(--ink-2); }
.omc-receipt-row dd { min-width: 0; text-align: right; overflow-wrap: anywhere; }
.omc-receipt-row.is-muted dd { color: var(--muted); }
.omc-receipt-row.is-up dd { color: var(--up); }
.omc-receipt-row.is-down dd { color: var(--down); }

.omc-receipt-total { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 4px 0; text-align: center; }
.omc-receipt-total-label { color: var(--ink-2); font-size: 12px; letter-spacing: 0.16em; }
.omc-receipt-total-value { font-size: 46px; font-weight: 700; line-height: 1.1; letter-spacing: -0.01em; }
.omc-receipt-total-note { color: var(--muted); font-size: 11px; letter-spacing: 0.08em; }

.omc-receipt-items { display: flex; flex-direction: column; }
.omc-receipt-line {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 52px 84px;
  column-gap: 12px;
  align-items: baseline;
}
.omc-receipt-line > :not(:first-child) { text-align: right; white-space: nowrap; }
.omc-receipt-line-name { display: flex; align-items: center; gap: 8px; min-width: 0; }
.omc-receipt-line-name > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.omc-receipt-items-head { margin-bottom: 6px; color: var(--muted); font-size: 11px; letter-spacing: 0.08em; }
.omc-receipt-key { margin-top: 10px; font-weight: 700; }
.omc-receipt-key > :nth-child(2) { color: var(--ink-2); font-weight: 400; }
.omc-receipt-key-detail { margin: -2px 0 2px; color: var(--muted); font-size: 11px; }
.omc-receipt-model { padding-left: 14px; color: var(--ink-2); font-size: 12px; line-height: 1.75; }
.omc-receipt-model > :nth-child(2) { color: var(--muted); }
.omc-receipt-line.is-muted, .omc-receipt-line.is-muted > * { color: var(--muted); }
.omc-receipt-mark { display: inline-block; flex: none; width: 13px; height: 13px; }
.omc-receipt-mark.is-mono { background: var(--ink-2); -webkit-mask: var(--mark) center / contain no-repeat; mask: var(--mark) center / contain no-repeat; }
.omc-receipt-mark.is-blank { display: inline-flex; align-items: center; justify-content: center; }
.omc-receipt-mark.is-blank::before { content: ""; width: 4px; height: 4px; border-radius: 50%; background: var(--muted); }
.omc-receipt-placeholder { padding: 14px 0 4px; color: var(--muted); text-align: center; }

.omc-receipt-notes { margin-top: 8px; color: var(--muted); font-size: 11px; }

.omc-receipt-foot { display: flex; align-items: center; justify-content: center; gap: 6px; color: var(--muted); font-size: 12px; }
.omc-receipt-foot-mark { display: block; flex: none; font-size: 13px; }
`;
