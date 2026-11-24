import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Extras } from './components/Extras';
import { FloatingDemo } from './components/FloatingDemo';
import { RewardsSignup } from './features/rewards/RewardsSignup';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');

createRoot(root).render(
  <StrictMode>
    {new URLSearchParams(window.location.search).has('floating') ? <FloatingDemo /> : null}
    <App />
    <Extras />
    <RewardsSignup />
  </StrictMode>,
);
