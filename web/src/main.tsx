import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';

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
