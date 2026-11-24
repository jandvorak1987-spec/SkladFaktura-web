import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Prevent accidental value changes on numeric inputs when scrolling with mouse wheel
document.addEventListener(
  'wheel',
  () => {
    const el = document.activeElement;
    if (el instanceof HTMLInputElement && el.type === 'number') {
      el.blur();
    }
  },
  { passive: true }
);

createRoot(document.getElementById('root')!).render(<App />);

