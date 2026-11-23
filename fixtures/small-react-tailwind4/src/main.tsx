import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Extras } from './components/Extras';
import { RewardsSignup } from './features/rewards/RewardsSignup';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
    <Extras />
    <RewardsSignup />
  </StrictMode>,
);
