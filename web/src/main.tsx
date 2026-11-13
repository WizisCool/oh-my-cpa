import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';
import { applyStoredFonts } from './theme/fontLibrary';

// iOS Safari zooms the whole page into any focused field set under 16px, which every field at the
// console's 13px reading size is. `maximum-scale=1` stops that focus zoom while iOS keeps pinch zoom
// regardless; any other browser would read it as disabling pinch zoom, so only iOS is given it.
const isIOS = /iP(?:hone|od|ad)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
if (isIOS) {
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (viewport && !/maximum-scale/.test(viewport.content)) viewport.content += ', maximum-scale=1';
}

// Before the first render, so the first frame is painted in the typeface this browser last
// saw chosen rather than switching once the preference arrives.
applyStoredFonts();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// An asynchronous chunk, so it never blocks the first frame, but started at once rather than
// after load: every moment the faces are not registered is a moment a character outside the
// core shard is drawn by a fallback font and later swaps, shifting the text around it. If the
// chunk never loads, that fallback simply stays.
void import('./theme/sarasaFont').then((font) => font.registerDeferredShards(), () => undefined);
// The CJK faces come from Google Fonts; until they arrive, or if they never do, CJK text
// outside the console's own copy is drawn by the platform's CJK font.
void import('./theme/cjkFont').then((font) => font.registerCJKFont(), () => undefined);
