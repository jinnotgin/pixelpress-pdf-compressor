import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/app/app';

import '@/styles/index.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('Unable to bootstrap PixelPress: no #root element found in index.html.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
