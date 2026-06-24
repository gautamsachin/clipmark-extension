// config.js
// Set to 'local' for development, 'prod' for production.
const ENV = 'local';

const DASHBOARD_URL = ENV === 'prod'
  ? 'http://localhost:3000'
  : 'https://clipmark-fawn.vercel.app'; // Change to production URL later

const API_BASE = `${DASHBOARD_URL}/api`;
