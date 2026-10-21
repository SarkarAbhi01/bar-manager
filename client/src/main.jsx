import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import Menu from './Menu.jsx';
import './styles.css';
createRoot(document.getElementById('root')).render(location.pathname.startsWith('/menu') ? <Menu /> : <App />);
