import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';
import { PhoneApp } from './phone/PhoneApp';

// Audience phones (QR invite) get a separate, minimal app with its own session.
const isPhone = /^\/(join|drive)(\/|$)/.test(location.pathname);

createRoot(document.getElementById('root')!).render(<StrictMode>{isPhone ? <PhoneApp /> : <App />}</StrictMode>);
