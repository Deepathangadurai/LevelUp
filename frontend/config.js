
const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(
  window.location.hostname
);

window.LEVELUP_CONFIG = {
  API_BASE_URL: isLocalHost
    ? 'http://127.0.0.1:8000'
    : 'https://levelup-backend-0f2n.onrender.com'
};
