// Tiny, safe markdown renderer for chat replies: builds DOM nodes with
// textContent only (no innerHTML), so model output can never inject markup.
(function (root) {
  'use strict';

  function inline(parent, text) {
    const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)]+\))/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const tok = m[0];
      let el;
      if (tok.startsWith('`')) { el = document.createElement('code'); el.textContent = tok.slice(1, -1); }
      else if (tok.startsWith('**')) { el = document.createElement('strong'); el.textContent = tok.slice(2, -2); }
      else if (tok.startsWith('*')) { el = document.createElement('em'); el.textContent = tok.slice(1, -1); }
      else {
        const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
        el = document.createElement('span');
        el.className = 'link';
        el.textContent = lm[1];
        el.title = lm[2];
      }
      parent.appendChild(el);
      last = m.index + tok.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function render(text) {
    const frag = document.createDocumentFragment();
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    let i = 0;
    let para = [];
    const flush = () => {
      if (!para.length) return;
      const p = document.createElement('p');
      inline(p, para.join(' '));
      frag.appendChild(p);
      para = [];
    };
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^```(\w*)/.exec(line);
      if (fence) {
        flush();
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
        i++;
        const pre = document.createElement('pre');
        const c = document.createElement('code');
        c.textContent = code.join('\n');
        pre.appendChild(c);
        frag.appendChild(pre);
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { flush(); const el = document.createElement('div'); el.className = 'h'; inline(el, h[2]); frag.appendChild(el); i++; continue; }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        flush();
        const ordered = /^\s*\d/.test(line);
        const list = document.createElement(ordered ? 'ol' : 'ul');
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          const li = document.createElement('li');
          inline(li, lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
          list.appendChild(li);
          i++;
        }
        frag.appendChild(list);
        continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      para.push(line.trim());
      i++;
    }
    flush();
    return frag;
  }

  root.renderMarkdown = render;
})(window);
