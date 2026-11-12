'use strict';

// Agent monitor: live steps of the desktop agent. Click a step to see on
// screen what it worked on. Text only (textContent), never HTML.
(() => {
  const api = window.monitor;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const STATUS = { running: 'Working…', done: 'Finished', ask: 'Needs you', stopped: 'Stopped', failed: 'Failed', limit: 'Step limit reached', idle: 'Idle' };

  function render(m) {
    if (!m) return;
    $('dot').className = `dot ${m.status}`;
    const last = m.steps.filter((s) => s.status !== 'note').slice(-1)[0];
    $('status').textContent = `${STATUS[m.status] || m.status}${m.status === 'running' && last ? ` · step ${last.step}` : ''}`;
    $('goal').textContent = m.goal || 'No task yet. Start one with /do in the chat.';
    $('stop').hidden = m.status !== 'running';
    const pl = $('plan');
    pl.hidden = !m.plan;
    if (m.plan) {
      if (!pl.dataset.shown) { pl.open = true; pl.dataset.shown = '1'; }
      const ps = $('plan-steps');
      ps.textContent = '';
      for (const x of m.plan.steps) ps.append(el('li', '', x));
      $('plan-done').textContent = m.plan.doneWhen ? `Done when: ${m.plan.doneWhen}` : '';
    }
    const ol = $('steps');
    const atBottom = ol.scrollTop + ol.clientHeight >= ol.scrollHeight - 8;
    ol.textContent = '';
    m.steps.forEach((s, i) => {
      const li = el('li', `${s.status}${s.target ? ' has-target' : ''}`);
      const body = el('div');
      body.append(el('div', 'label', s.label));
      if (s.why) body.append(el('div', 'why', s.why));
      if (s.error) body.append(el('div', 'res err', s.error));
      else if (s.result) body.append(el('div', 'res', s.result));
      if (s.target) body.append(el('div', 'tgt', 'Show on screen'));
      li.append(el('span', 'n', s.status === 'note' ? '•' : String(s.step)), body);
      if (s.target) {
        li.tabIndex = 0;
        li.title = 'Show what this step worked on';
        li.addEventListener('click', () => api.highlight(i));
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); api.highlight(i); } });
      }
      ol.append(li);
    });
    if (atBottom) ol.scrollTop = ol.scrollHeight;
    $('summary').hidden = !m.summary || m.status === 'running';
    $('summary').textContent = m.summary || '';
  }

  api.onUpdate(render);
  api.state().then(render).catch(() => {});
  $('stop').addEventListener('click', () => api.stop());
  $('close').addEventListener('click', () => api.close());
  window.__monitorReady = true;
})();
