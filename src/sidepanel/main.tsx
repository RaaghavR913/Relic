import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LazyMotion, domMax } from 'framer-motion';
import './index.css';
import App from './App';

const root = document.getElementById('root');
if (!root) throw new Error('Disclora: #root element missing from side panel HTML');

createRoot(root).render(
  <LazyMotion features={domMax} strict>
    <StrictMode>
      <App />
    </StrictMode>
  </LazyMotion>,
);
