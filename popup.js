const $ = id => document.getElementById(id);

function render(s) {
  if (!s) return;
  $('phase').textContent = s.phase || 'Idle';
  if (s.pct == null) $('bar').removeAttribute('value'); // indeterminate bar while scrolling up
  else $('bar').value = s.pct;
  $('msgs').textContent = `${s.msgs} messages`;
  $('log').textContent = s.log.join('\n');
  $('log').scrollTop = $('log').scrollHeight;
  $('start').disabled = !s.done;
}

chrome.storage.local.get('cap', r => render(r.cap || { done: true, msgs: 0, log: [] }));
chrome.storage.onChanged.addListener(ch => ch.cap && render(ch.cap.newValue));

$('start').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.storage.local.set({ cap: { phase: 'Starting…', pct: null, msgs: 0, log: [], done: false } });
  let out;
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['capture.js'] });
    out = res.map(r => r.result);
  } catch (e) {
    return render({ phase: 'Failed to start', msgs: 0, log: [`❌ ${e.message}`], done: true });
  }
  if (out.includes('running')) render({ phase: 'A capture is already running in this tab', msgs: 0, log: [], done: true });
  else if (!out.includes('started')) render({ phase: 'No Teams messages found in this tab', pct: 0, msgs: 0, log: [], done: true });
};
