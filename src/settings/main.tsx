import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../sidepanel/index.css';
import SettingsApp from './SettingsApp';

const root = document.getElementById('root');
if (!root) throw new Error('Disclora: #root element missing from settings HTML');

createRoot(root).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>,
);
