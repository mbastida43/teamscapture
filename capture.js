// Injetado na aba do Teams pelo popup. IIFE pra poder injetar de novo sem "already declared".
(() => {
  // Só mensagens da conversa. [role="listitem"] genérico pegava a lista de chats da barra lateral.
  const ITEM = '[data-tid="chat-pane-item"], [data-tid="channel-pane-message"], [data-tid="chat-pane-message"]';
  const items = () => [...document.querySelectorAll(ITEM)].filter(el => !el.parentElement.closest(ITEM));
  if (!items().length) return 'none'; // frame sem conversa
  if (window.__teamsCaptureRunning) return 'running';
  window.__teamsCaptureRunning = true;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const scrollable = el => { while (el && !(el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement; return el; };

  // Progresso: vai pro popup (chrome.storage) e pra uma faixa fixa na página
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:999999;background:#6264a7;color:#fff;padding:8px 16px;border-radius:6px;font:14px Segoe UI,sans-serif;box-shadow:0 2px 8px #0004';
  document.body.appendChild(bar);
  const state = { phase: '', pct: null, msgs: 0, log: [], done: false };
  const report = (patch, line) => {
    Object.assign(state, patch);
    if (line) state.log = state.log.concat(`${new Date().toLocaleTimeString()}  ${line}`).slice(-200);
    bar.textContent = `📥 ${state.phase}${state.pct != null ? ` ${Math.round(state.pct * 100)}%` : ''} · ${state.msgs} mensagens`;
    chrome.storage.local.set({ cap: state });
  };
  // Posição da rolagem em 0..1 (funciona em lista normal e invertida/column-reverse)
  const position = box => {
    const max = box.scrollHeight - box.clientHeight;
    if (max <= 0) return 1;
    return Math.min(1, Math.max(0, (box.scrollTop < 0 ? box.scrollTop + max : box.scrollTop) / max));
  };

  const toDataUrl = async (url) => {
    try {
      const blob = await (await fetch(url, { credentials: 'include' })).blob();
      return await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
    } catch { return url; }
  };
  const key = el => el.querySelector('[data-mid]')?.dataset.mid || el.dataset.mid || el.id || el.innerText.slice(0, 200);

  // Expande "Ver mais" / "See more" de mensagens longas
  const expand = (root) => root.querySelectorAll('button').forEach(b => {
    if (/^(ver mais|see more|mostrar mais|show more)$/i.test(b.innerText.trim())) b.click();
  });

  // Clona a mensagem e embute as imagens (blob:/autenticadas somem depois)
  const snapshot = async (el) => {
    const clone = el.cloneNode(true);
    const src = [...el.querySelectorAll('img')], dst = [...clone.querySelectorAll('img')];
    await Promise.all(src.map(async (img, i) => {
      const url = img.currentSrc || img.src;
      if (url && !url.startsWith('data:')) dst[i].src = await toDataUrl(url);
      dst[i].removeAttribute('srcset');
      dst[i].removeAttribute('loading');
    }));
    return clone.outerHTML;
  };

  let total = 0; // mensagens capturadas, somando threads

  // Sobe até o início e desce até o fim capturando os itens de um container.
  // onItem(el) é chamado uma vez por item novo (usado pra abrir respostas de canal).
  async function collect(box, onItem, label = 'Conversa') {
    const inBox = i => box.contains(i);
    const order = [], html = new Map(), extra = new Map();
    const firstKey = () => { const f = items().find(inBox); return f && key(f); };

    // Fase 1: sobe até o início. Só considera "início" depois de 20s (10 rodadas)
    // com a 1ª mensagem e a altura da lista paradas.
    // scrollTop = -scrollHeight vai pro topo tanto em lista normal quanto em column-reverse (Teams v2).
    report({ phase: `${label}: subindo até o início`, pct: null }, `${label}: subindo até o início`);
    for (let idle = 0, last = '', round = 0; idle < 10; round++) {
      box.scrollTop = -box.scrollHeight;
      box.dispatchEvent(new WheelEvent('wheel', { deltaY: -1000, bubbles: true }));
      await sleep(2000);
      const now = `${firstKey()}|${box.scrollHeight}`;
      if (now !== last && round) report({}, `${label}: histórico carregou mais (altura ${box.scrollHeight}px)`);
      idle = now === last ? idle + 1 : 0;
      last = now;
      report({ phase: `${label}: confirmando início ${idle}/10` });
    }
    report({}, `${label}: início alcançado`);

    // Retorna quantos itens novos apareceram e quantos já eram conhecidos (sobreposição)
    const grab = async () => {
      expand(box);
      await sleep(300);
      let fresh = 0, known = 0;
      for (const el of items().filter(inBox)) {
        if (!el.isConnected || (!el.innerText.trim() && !el.querySelector('img'))) continue;
        const k = key(el), h = await snapshot(el);
        if (html.has(k)) known++;
        else {
          order.push(k); fresh++; total++;
          if (onItem) {
            const pos = box.scrollTop;
            extra.set(k, await onItem(el));
            // a thread pode ter trocado a tela: reencontra o container e volta pra posição
            if (!box.isConnected) box = scrollable(items()[0]?.parentElement) || box;
            box.scrollTop = pos;
            await sleep(800);
          }
        }
        if (!html.has(k) || h.length > html.get(k).length) html.set(k, h);
      }
      return { fresh, known };
    };

    // Fase 2: desce do início até o fim, em passos de meia tela.
    // Cada passo TEM que enxergar mensagens já capturadas (sobreposição); se não enxergar,
    // pode ter pulado algo: volta um pouco e espera renderizar antes de seguir.
    await grab();
    for (let idle = 0; idle < 5;) {
      const before = box.scrollTop;
      box.scrollTop += box.clientHeight * 0.5;
      await sleep(1500);
      const atEnd = Math.abs(box.scrollTop - before) < 2; // não andou = chegou no fim
      let r = await grab();
      for (let retry = 0; r.known === 0 && order.length && retry < 10; retry++) {
        report({}, `${label}: sem sobreposição, voltando um pouco (tentativa ${retry + 1}/10)`);
        box.scrollTop -= box.clientHeight * 0.25;
        await sleep(2000);
        r = await grab();
      }
      if (r.known === 0 && order.length) report({}, `⚠️ ${label}: possível falha de continuidade perto da mensagem ${order.length}`);
      if (r.fresh) report({}, `${label}: +${r.fresh} mensagens (total ${order.length})`);
      idle = (r.fresh === 0 && atEnd) ? idle + 1 : 0;
      report({ phase: `${label}: descendo e capturando${idle ? ` (confirmando fim ${idle}/5)` : ''}`, pct: position(box), msgs: total });
    }
    report({}, `${label}: fim alcançado, ${order.length} mensagens`);
    return order.map(k => html.get(k) + (extra.get(k) || ''));
  }

  // Abre as respostas de um post de canal e captura a thread
  const REPLY_BTN = /(\d+\s*(respostas?|repl(y|ies)))|((ver|mostrar|expandir|abrir|show|view|expand|open).*(respost|repl|conversa|conversation))/i;
  async function openReplies(post) {
    const btn = [...post.querySelectorAll('button, [role="button"]')]
      .find(b => REPLY_BTN.test(b.innerText || b.getAttribute('aria-label') || ''));
    if (!btn) return '';
    report({}, `Abrindo respostas: "${(btn.innerText || btn.getAttribute('aria-label')).trim()}"`);
    const postBox = scrollable(post.parentElement);
    const before = new Set(items());
    const mainPhase = state.phase, mainPct = state.pct;
    btn.click();
    await sleep(2500);

    // Respostas que abriram num painel/tela separada
    const pane = items().filter(i => !before.has(i) && !(postBox?.isConnected && postBox.contains(i)));
    if (!pane.length) { report({}, 'Respostas expandidas no próprio post'); return ''; }
    const paneBox = scrollable(pane[0].parentElement);
    let replies = [];
    if (paneBox) replies = await collect(paneBox, null, 'Respostas');

    // Fecha o painel: botão fechar/voltar mais próximo, senão Esc
    let closeBtn = null;
    for (let p = paneBox; p && !closeBtn; p = p.parentElement)
      closeBtn = p.querySelector('button[aria-label*="Fechar" i], button[aria-label*="Close" i], button[aria-label*="Voltar" i], button[aria-label*="Back" i]');
    if (closeBtn) closeBtn.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(1500);
    report({ phase: mainPhase, pct: mainPct }, `Painel de respostas fechado (${replies.length} respostas)`);

    return replies.length ? `<div style="margin-left:48px;border-left:3px solid #6264a7;padding-left:8px">${replies.join('\n')}</div>` : '';
  }

  async function run() {
    const mainBox = scrollable(items()[0].parentElement);
    if (!mainBox) return report({ phase: 'Erro', done: true }, '❌ Container de rolagem não encontrado');
    const isChannel = !!document.querySelector('[data-tid="channel-pane-message"]') || /channel|canal/i.test(location.href);
    report({}, `Iniciado em: ${document.title} (${isChannel ? 'canal' : 'chat'})`);
    const all = await collect(mainBox, isChannel ? openReplies : null);
    report({ phase: 'Gerando HTML', pct: 1 }, `Gerando HTML com ${all.length} mensagens…`);
    bar.remove();

    // Página final = cópia da tela do Teams, com a lista virtual trocada pela conversa inteira
    const list = items()[0].parentElement;
    list.setAttribute('data-capture-list', '');
    const doc = document.documentElement.cloneNode(true);
    list.removeAttribute('data-capture-list');
    doc.querySelector('[data-capture-list]').innerHTML = all.join('\n');
    // Remove scripts e os "esqueletos" cinzas da lista virtual (ficavam no topo, antes das mensagens)
    doc.querySelectorAll('script, noscript, [data-testid="vl-placeholders"], [data-testid="virtual-list-loader"], .vl-buffer').forEach(s => s.remove());

    // Embute o CSS do Teams (o que for acessível); o resto vai como <link>
    doc.querySelectorAll('style, link[rel="stylesheet"]').forEach(s => s.remove());
    const css = [...document.styleSheets].map(s => {
      try { return `<style>${[...s.cssRules].map(r => r.cssText).join('\n')}</style>`; }
      catch { return s.href ? `<link rel="stylesheet" href="${s.href}">` : ''; }
    }).join('\n');
    // Lista virtual usa alturas/posições fixas: libera pra mostrar tudo
    doc.querySelector('head').insertAdjacentHTML('beforeend', `<meta charset="utf-8"><base href="${location.origin}/">${css}
<style>[data-capture-list]{height:auto!important;max-height:none!important}
[data-capture-list]>*{position:relative!important;top:auto!important;transform:none!important}</style>`);

    // Imagens fora das mensagens (avatares, ícones) também embutidas
    await Promise.all([...doc.querySelectorAll('img')].map(async img => {
      const url = img.getAttribute('src');
      if (url && !url.startsWith('data:')) img.src = await toDataUrl(new URL(url, location.href).href);
      img.removeAttribute('srcset');
    }));

    const title = (document.title || 'teams').replace(/[\\/:*?"<>|]/g, '_');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['<!doctype html>\n' + doc.outerHTML], { type: 'text/html' }));
    a.download = `${title}.html`;
    a.click();
    report({ phase: 'Concluído', pct: 1, done: true }, `✅ Concluído: ${all.length} mensagens salvas em ${title}.html`);
  }

  run()
    .catch(e => report({ phase: 'Erro', done: true }, `❌ ${e.message}`))
    .finally(() => { bar.remove(); window.__teamsCaptureRunning = false; });
  return 'started';
})();
