'use strict';
const form = document.getElementById('form');
const errBox = document.getElementById('err');
const submit = document.getElementById('submit');
const idInput = document.getElementById('id');

(async () => {
  try {
    const d = await window.falcon.defaults();
    if (d.personId) idInput.value = d.personId;
  } catch {}
})();

function showError(message) {
  errBox.textContent = message;
  errBox.classList.add('show');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errBox.classList.remove('show');
  submit.disabled = true;
  submit.textContent = 'Проверяем…';
  try {
    const data = {
      id: idInput.value,
      code: document.getElementById('code').value,
    };
    const result = await window.falcon.login(data);
    if (!result.ok) {
      showError(result.error || 'Не удалось войти');
      submit.disabled = false;
      submit.textContent = 'Войти';
    }
    // On success the main process closes this window.
  } catch (err) {
    showError('Нет связи. Попробуйте ещё раз.');
    submit.disabled = false;
    submit.textContent = 'Войти';
  }
});
