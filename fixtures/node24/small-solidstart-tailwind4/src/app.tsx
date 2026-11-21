import { Router } from '@solidjs/router';
import { FileRoutes } from '@solidjs/start/router';
import { Suspense } from 'solid-js';
import { Extras } from './components/Extras';
import './app.css';

export default function App() {
  return (
    <Router
      root={(props) => (
        <Suspense>
          {props.children}
          <Extras />
        </Suspense>
      )}
    >
      <FileRoutes />
    </Router>
  );
}
