import { render } from 'solid-js/web';
import { App } from './App';
import { Extras } from './components/Extras';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');

render(
  () => (
    <>
      <App />
      <Extras />
    </>
  ),
  root,
);
