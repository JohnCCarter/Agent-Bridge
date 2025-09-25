document.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('cta-button');
  if (!button) {
    return;
  }

  button.addEventListener('click', () => {
    const features = document.getElementById('features');
    if (features) {
      features.scrollIntoView({ behavior: 'smooth' });
    }
  });
});