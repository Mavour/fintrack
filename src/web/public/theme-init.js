try {
  if (localStorage.getItem('fintrack-theme') === 'dark') document.documentElement.dataset.theme = 'dark';
} catch (e) { /* Storage may be unavailable. */ }
