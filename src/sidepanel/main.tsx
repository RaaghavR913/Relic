import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

const root = document.getElementById('root');
if (!root) throw new Error('FilingLens: #root element missing from side panel HTML');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
