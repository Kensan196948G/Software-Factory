const form = document.getElementById('form');
const err = document.getElementById('err');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('submit');
  btn.disabled = true;
  btn.textContent = '確認中…';
  err.classList.remove('show');
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error((body && body.error && body.error.message) || 'ログインできませんでした');
    }
    location.href = '/';
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.add('show');
    btn.disabled = false;
    btn.textContent = 'ログイン';
  }
});
