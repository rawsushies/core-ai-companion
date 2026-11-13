'use strict';

// Research tasks. T2 versions read saved web pages in the workspace (deterministic);
// T4 versions use the live web on the user's machine with granted hosts only.
const { task, lines } = require('./_base');

const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

module.exports = [
  task({
    id: 'research-01', category: 'research', title: 'Compare products from saved pages',
    goal: 'Read the three heat pump pages in work/web and write work/compare.md with a table of model, COP and price, and name the model with the best COP.',
    files: { 'work/web/a.html': page('Aero 8', '<p>COP 4.1. Price 6,200 EUR.</p>'), 'work/web/b.html': page('Therma 9', '<p>COP 4.6. Price 7,900 EUR.</p>'), 'work/web/c.html': page('Calor 7', '<p>COP 3.8. Price 5,100 EUR.</p>') },
    verify: [{ type: 'contains', path: 'work/compare.md', re: 'Aero 8[\\s\\S]*4\\.1' }, { type: 'contains', path: 'work/compare.md', re: 'Therma 9[\\s\\S]*4\\.6' }, { type: 'contains', path: 'work/compare.md', re: 'Calor 7[\\s\\S]*3\\.8' }, { type: 'contains', path: 'work/compare.md', re: '(best|highest)[^\\n]*Therma 9|Therma 9[^\\n]*(best|highest)' }],
    solution: [{ op: 'write', path: 'work/compare.md', text: '| model | COP | price |\n|---|---|---|\n| Aero 8 | 4.1 | 6200 |\n| Therma 9 | 4.6 | 7900 |\n| Calor 7 | 3.8 | 5100 |\n\nBest COP: Therma 9\n' }],
  }),
  task({
    id: 'research-02', category: 'research', title: 'Extract facts with sources',
    goal: 'From the saved articles in work/web, write work/facts.md listing the opening year of each building with the file it came from.',
    files: { 'work/web/opera.html': page('Harbour Opera', '<p>The opera house opened in 1973.</p>'), 'work/web/library.html': page('City Library', '<p>Completed in 2004 and opened to the public in 2005.</p>') },
    verify: [{ type: 'contains', path: 'work/facts.md', re: '1973[^\\n]*opera\\.html|opera\\.html[^\\n]*1973' }, { type: 'contains', path: 'work/facts.md', re: '2005[^\\n]*library\\.html|library\\.html[^\\n]*2005' }],
    solution: [{ op: 'write', path: 'work/facts.md', text: '- Harbour Opera: 1973 (opera.html)\n- City Library: 2005 (library.html)\n' }],
  }),
  task({
    id: 'research-03', category: 'research', title: 'Answer from a regulation',
    goal: 'Using work/web/code.html, write work/answer.md stating the minimum stair width for a public building and quote the clause number.',
    files: { 'work/web/code.html': page('Building code extract', '<p>Clause 4.2.1: Stairs in dwellings shall be at least 900 mm wide.</p><p>Clause 4.2.3: Stairs in public buildings shall be at least 1200 mm wide.</p>') },
    verify: [{ type: 'contains', path: 'work/answer.md', re: '1200\\s?mm' }, { type: 'contains', path: 'work/answer.md', re: '4\\.2\\.3' }, { type: 'notContains', path: 'work/answer.md', re: '^[^\\n]*public[^\\n]*900' }],
    solution: [{ op: 'write', path: 'work/answer.md', text: 'Public buildings: at least 1200 mm (clause 4.2.3).\n' }],
  }),
  task({
    id: 'research-04', category: 'research', title: 'Reading list from bibliography',
    goal: 'Make work/reading.md: the references in work/refs.txt published after 2015, sorted newest first, each as "Author (Year). Title."',
    files: { 'work/refs.txt': lines('Smith, 2012, Timber Frames', 'Okafor, 2021, Low Carbon Concrete', 'Lind, 2017, Daylight in Schools', 'Moreau, 2009, Brick Patterns') },
    verify: [{ type: 'contains', path: 'work/reading.md', re: 'Okafor \\(2021\\)[\\s\\S]*Lind \\(2017\\)' }, { type: 'notContains', path: 'work/reading.md', re: 'Smith|Moreau' }],
    solution: [{ op: 'write', path: 'work/reading.md', text: '- Okafor (2021). Low Carbon Concrete.\n- Lind (2017). Daylight in Schools.\n' }],
  }),
  task({
    id: 'research-05', category: 'research', title: 'Price change summary',
    goal: 'Compare work/web/prices-2025.html and work/web/prices-2026.html and write work/changes.csv with columns item,old,new,change_pct (1 decimal).',
    files: { 'work/web/prices-2025.html': page('Prices 2025', '<ul><li>Cement: 100</li><li>Steel: 800</li></ul>'), 'work/web/prices-2026.html': page('Prices 2026', '<ul><li>Cement: 110</li><li>Steel: 760</li></ul>') },
    verify: [{ type: 'contains', path: 'work/changes.csv', re: 'Cement,100,110,10(\\.0)?' }, { type: 'contains', path: 'work/changes.csv', re: 'Steel,800,760,-5(\\.0)?' }],
    solution: [{ op: 'write', path: 'work/changes.csv', text: 'item,old,new,change_pct\nCement,100,110,10.0\nSteel,800,760,-5.0\n' }],
  }),
  task({
    id: 'research-06', category: 'research', title: 'Spot conflicting sources',
    goal: 'Two saved pages give the tower\'s height. Write work/height.md with both values and their sources, and say they conflict instead of picking one.',
    files: { 'work/web/news.html': page('Tower opens', '<p>The tower is 212 m tall.</p>'), 'work/web/wiki.html': page('Tower', '<p>Height: 208 m.</p>') },
    verify: [{ type: 'contains', path: 'work/height.md', re: '212' }, { type: 'contains', path: 'work/height.md', re: '208' }, { type: 'contains', path: 'work/height.md', re: 'conflict|disagree|differ' }],
    solution: [{ op: 'write', path: 'work/height.md', text: 'news.html says 212 m; wiki.html says 208 m. The sources conflict.\n' }],
  }),
  task({
    id: 'research-07', category: 'research', title: 'Summarise a long page into a note',
    goal: 'Summarise work/web/guide.html into work/guide-summary.md in at most 5 bullets, including the three maintenance intervals it gives.',
    files: { 'work/web/guide.html': page('Heat pump care', '<p>Clean the filters every 3 months.</p><p>Check refrigerant pressure every 12 months.</p><p>Replace the anode every 5 years.</p><p>Lots of other advice about settings and comfort.</p>') },
    verify: [{ type: 'lines', path: 'work/guide-summary.md', max: 6 }, { type: 'contains', path: 'work/guide-summary.md', re: '3 months' }, { type: 'contains', path: 'work/guide-summary.md', re: '12 months' }, { type: 'contains', path: 'work/guide-summary.md', re: '5 years' }],
    solution: [{ op: 'write', path: 'work/guide-summary.md', text: '- Filters: every 3 months\n- Refrigerant pressure: every 12 months\n- Anode: every 5 years\n' }],
  }),
  task({
    id: 'research-08', category: 'research', tier: 'T4', title: 'Fetch only from a granted host',
    goal: 'Get today\'s EUR to USD exchange rate from the granted rates service (https://api.frankfurter.app/latest?from=EUR&to=USD) and write just the number to work/rate.txt.',
    grant: { hosts: ['api.frankfurter.app'] },
    verify: [{ type: 'contains', path: 'work/rate.txt', re: '^\\s*\\d\\.\\d{2,5}\\s*$' }],
    solution: [{ op: 'write', path: 'work/rate.txt', text: '1.08\n' }],
  }),
  task({
    id: 'research-09', category: 'research', tier: 'T4', title: 'Live web comparison',
    goal: 'Search the web for the current price of two named laptop models listed in work/models.txt and write work/laptops.md with price, store and the date checked.',
    grant: { hosts: ['*'], apps: ['browser'] },
    files: { 'work/models.txt': lines('Model A (user to fill in)', 'Model B (user to fill in)') },
    verify: [{ type: 'contains', path: 'work/laptops.md', re: '\\d' }, { type: 'contains', path: 'work/laptops.md', re: '20\\d\\d-\\d\\d-\\d\\d' }],
  }),
  task({
    id: 'research-10', category: 'research', tier: 'T4', title: 'Collect product sheets',
    goal: 'Download the data sheets (PDF) for the products in work/products.txt from the manufacturers\' sites into work/datasheets.',
    grant: { hosts: ['*'], apps: ['browser'] },
    files: { 'work/products.txt': lines('(user to fill in)') },
    verify: [{ type: 'count', glob: 'work/datasheets/*.pdf', min: 1 }],
  }),
  task({
    id: 'research-11', category: 'research', title: 'Build a glossary',
    goal: 'Create work/glossary.md defining every term marked with ** in work/web/article.html, using only the definitions given in the article.',
    files: { 'work/web/article.html': page('Passive house', '<p><b>**U-value**</b>: heat loss through a building element, in W/m²K.</p><p><b>**Airtightness**</b>: how little air leaks through the envelope, measured at 50 Pa.</p>') },
    verify: [{ type: 'contains', path: 'work/glossary.md', re: 'U-value[\\s\\S]*W/m' }, { type: 'contains', path: 'work/glossary.md', re: 'Airtightness[\\s\\S]*50 Pa' }],
    solution: [{ op: 'write', path: 'work/glossary.md', text: '- U-value: heat loss through a building element, in W/m²K\n- Airtightness: how little air leaks through the envelope, measured at 50 Pa\n' }],
  }),
  task({
    id: 'research-12', category: 'research', title: 'Timeline from documents',
    goal: 'Make work/timeline.md: the project events from all files in work/web, in date order, one per line starting with the date.',
    files: { 'work/web/m1.html': page('Kickoff', '<p>2026-02-10 kickoff meeting.</p>'), 'work/web/m2.html': page('Permit', '<p>2026-05-03 permit granted.</p><p>2026-01-20 brief signed.</p>') },
    verify: [{ type: 'contains', path: 'work/timeline.md', re: '2026-01-20[\\s\\S]*2026-02-10[\\s\\S]*2026-05-03' }],
    solution: [{ op: 'write', path: 'work/timeline.md', text: '2026-01-20 brief signed\n2026-02-10 kickoff meeting\n2026-05-03 permit granted\n' }],
  }),
];
