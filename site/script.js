document.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('cta-button');
  if (button) {
    button.addEventListener('click', () => {
      window.open('https://example.com', '_blank', 'noopener');
    });
  }
});
