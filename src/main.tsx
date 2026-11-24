import React from 'react';
import ReactDOM from 'react-dom/client';
import { inject } from '@vercel/analytics';
import NetworkDashboard from './components/NetworkDashboard';
import './index.css';

inject();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <NetworkDashboard />
  </React.StrictMode>
);
