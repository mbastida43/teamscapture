const $ = id => document.getElementById(id);

function render(s) {
  if (!s) return;
  $('phase').textContent = s.phase || 'Parado';
  if (s.pct == null) $('bar').removeAttribute('value'); // barra "indeterminada" enquanto sobe
  else $('bar').value = s.pct;
  $('msgs').textContent = `${s.msgs} mensagens`;
  $('log').textContent = s.log.join('\n');
  $('log').scrollTop = $('log').scrollHeight;
  $('start').disabled = !s.done;
}

chrome.storage.local.get('cap', r => render(r.cap || { done: true, msgs: 0, log: [] }));
chrome.storage.onChanged.addListener(ch => ch.cap && render(ch.cap.newValue));

$('start').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.storage.local.set({ cap: { phase: 'Iniciando…', pct: null, msgs: 0, log: [], done: false } });
  let out;
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['capture.js'] });
    out = res.map(r => r.result);
  } catch (e) {
    return render({ phase: 'Erro ao iniciar', msgs: 0, log: [`❌ ${e.message}`], done: true });
  }
  if (out.includes('running')) render({ phase: 'Já existe uma captura rodando nesta aba', msgs: 0, log: [], done: true });
  else if (!out.includes('started')) render({ phase: 'Nenhuma mensagem do Teams encontrada nesta aba', pct: 0, msgs: 0, log: [], done: true });
};
