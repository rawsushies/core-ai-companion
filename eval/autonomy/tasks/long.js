'use strict';

// Long multi-step missions (many sub-goals, several tools/apps). Each one is also run
// with one injected crash in the recovery suite.
const { task, lines } = require('./_base');

const long = (o) => task({ budget: { steps: 80, minutes: 30 }, ...o });

module.exports = [
  long({
    id: 'long-01', category: 'long', title: 'Project close-out pack',
    goal: 'Prepare the close-out pack for Harbor: (1) copy every final drawing (*-final.*) from work/Harbor/drawings to work/closeout/drawings, (2) make work/closeout/register.csv listing them (file,bytes), (3) write work/closeout/summary.md from work/Harbor/notes.md with sections Scope, Changes and Lessons, (4) add the lessons to work/vault/Lessons.md under 2026-11-12.',
    files: { 'work/Harbor/drawings/A01-final.pdf': 'x'.repeat(100), 'work/Harbor/drawings/A01-draft.pdf': 'x', 'work/Harbor/drawings/A02-final.pdf': 'x'.repeat(250), 'work/Harbor/notes.md': lines('Scope: quay renovation.', 'Change: crane kept as landmark.', 'Lesson: check heritage rules before demolition.'), 'work/vault/Lessons.md': '# Lessons\n' },
    verify: [{ type: 'count', glob: 'work/closeout/drawings/*', n: 2 }, { type: 'csvRows', path: 'work/closeout/register.csv', n: 2 }, { type: 'contains', path: 'work/closeout/summary.md', re: 'Scope[\\s\\S]*Changes[\\s\\S]*Lessons' }, { type: 'contains', path: 'work/vault/Lessons.md', re: '2026-11-12[\\s\\S]*heritage' }, { type: 'exists', path: 'work/Harbor/drawings/A01-final.pdf' }],
    solution: [{ op: 'copy', from: 'work/Harbor/drawings/A01-final.pdf', to: 'work/closeout/drawings/A01-final.pdf' }, { op: 'copy', from: 'work/Harbor/drawings/A02-final.pdf', to: 'work/closeout/drawings/A02-final.pdf' }, { op: 'write', path: 'work/closeout/register.csv', text: 'file,bytes\nA01-final.pdf,100\nA02-final.pdf,250\n' }, { op: 'write', path: 'work/closeout/summary.md', text: '## Scope\nquay renovation\n## Changes\ncrane kept\n## Lessons\ncheck heritage rules\n' }, { op: 'write', path: 'work/vault/Lessons.md', text: '# Lessons\n## 2026-11-12\n- Check heritage rules before demolition.\n' }],
  }),
  long({
    id: 'long-02', category: 'long', title: 'Monthly expense report',
    goal: 'Build the October expense report: merge all CSVs in work/expenses/2026-10 into work/report/october.csv (with a source column), compute totals per category into work/report/totals.csv, flag any single expense above 500 in work/report/flags.txt, and write work/report/README.md describing the three files.',
    files: { 'work/expenses/2026-10/ana.csv': lines('date,category,amount', '2026-10-02,travel,120', '2026-10-07,hotel,640'), 'work/expenses/2026-10/ben.csv': lines('date,category,amount', '2026-10-03,travel,80', '2026-10-15,food,35') },
    verify: [{ type: 'csvRows', path: 'work/report/october.csv', n: 4 }, { type: 'contains', path: 'work/report/october.csv', re: 'source' }, { type: 'contains', path: 'work/report/totals.csv', re: 'travel,200' }, { type: 'contains', path: 'work/report/flags.txt', re: '640' }, { type: 'notContains', path: 'work/report/flags.txt', re: '\\b120\\b' }, { type: 'contains', path: 'work/report/README.md', re: 'october\\.csv[\\s\\S]*totals\\.csv[\\s\\S]*flags\\.txt' }],
    solution: [{ op: 'write', path: 'work/report/october.csv', text: 'date,category,amount,source\n2026-10-02,travel,120,ana\n2026-10-07,hotel,640,ana\n2026-10-03,travel,80,ben\n2026-10-15,food,35,ben\n' }, { op: 'write', path: 'work/report/totals.csv', text: 'category,total\nfood,35\nhotel,640\ntravel,200\n' }, { op: 'write', path: 'work/report/flags.txt', text: '2026-10-07 hotel 640 (ana)\n' }, { op: 'write', path: 'work/report/README.md', text: 'october.csv: all rows. totals.csv: per category. flags.txt: above 500.\n' }],
  }),
  long({
    id: 'long-03', category: 'long', title: 'Release a small library',
    goal: 'Release work/lib: make `node work/lib/test.js` pass by fixing lib.js, bump the version in package.json from 0.3.0 to 0.3.1, add a CHANGELOG entry for 0.3.1 describing the fix, and write the test output into work/lib/test.log.',
    files: { 'work/lib/lib.js': 'exports.double = (n) => n + n + 1;\n', 'work/lib/test.js': "const l = require('./lib'); if (l.double(4) !== 8) { console.log('fail'); process.exit(1); } console.log('pass');\n", 'work/lib/package.json': JSON.stringify({ name: 'lib', version: '0.3.0' }), 'work/lib/CHANGELOG.md': '# Changelog\n' },
    verify: [{ type: 'notContains', path: 'work/lib/lib.js', re: '\\+ 1' }, { type: 'json', path: 'work/lib/package.json', key: 'version', eq: '0.3.1' }, { type: 'contains', path: 'work/lib/CHANGELOG.md', re: '0\\.3\\.1' }, { type: 'contains', path: 'work/lib/test.log', re: 'pass' }, { type: 'unchanged', path: 'work/lib/test.js' }],
    solution: [{ op: 'write', path: 'work/lib/lib.js', text: 'exports.double = (n) => n + n;\n' }, { op: 'write', path: 'work/lib/package.json', text: JSON.stringify({ name: 'lib', version: '0.3.1' }) }, { op: 'write', path: 'work/lib/CHANGELOG.md', text: '# Changelog\n## 0.3.1\n- Fixed double()\n' }, { op: 'write', path: 'work/lib/test.log', text: 'pass\n' }],
  }),
  long({
    id: 'long-04', category: 'long', title: 'Client onboarding folder',
    goal: 'Onboard the client in work/new-client.json: create work/clients/<name>/ with subfolders Brief, Drawings, Invoices; fill work/templates/welcome.md into work/clients/<name>/Brief/welcome.md; add the client to work/clients/index.csv; and create a vault note work/vault/Projects/<project>.md with a Decisions heading.',
    files: { 'work/new-client.json': JSON.stringify({ name: 'Rivera', project: 'Lakeside' }), 'work/templates/welcome.md': 'Welcome {{name}} to the {{project}} project.', 'work/clients/index.csv': lines('name,project', 'Okafor,Harbor') },
    verify: [{ type: 'exists', path: 'work/clients/Rivera/Drawings' }, { type: 'exists', path: 'work/clients/Rivera/Invoices' }, { type: 'contains', path: 'work/clients/Rivera/Brief/welcome.md', re: 'Welcome Rivera to the Lakeside project' }, { type: 'contains', path: 'work/clients/index.csv', re: 'Okafor,Harbor[\\s\\S]*Rivera,Lakeside' }, { type: 'contains', path: 'work/vault/Projects/Lakeside.md', re: 'Decisions' }],
    solution: [{ op: 'mkdir', path: 'work/clients/Rivera/Drawings' }, { op: 'mkdir', path: 'work/clients/Rivera/Invoices' }, { op: 'write', path: 'work/clients/Rivera/Brief/welcome.md', text: 'Welcome Rivera to the Lakeside project.' }, { op: 'write', path: 'work/clients/index.csv', text: 'name,project\nOkafor,Harbor\nRivera,Lakeside\n' }, { op: 'write', path: 'work/vault/Projects/Lakeside.md', text: '# Lakeside\n## Decisions\n' }],
  }),
  long({
    id: 'long-05', category: 'long', title: 'Research brief with sources',
    goal: 'Write a research brief work/brief.md on green roofs from the saved pages in work/web: an overview, a table of three system types with weight per m², a recommendation for a 200 kg/m² roof limit, and a Sources section listing the pages used.',
    files: { 'work/web/extensive.html': '<h1>Extensive green roof</h1><p>Weight: 60 to 150 kg/m². Low maintenance.</p>', 'work/web/semi.html': '<h1>Semi-intensive</h1><p>Weight: 150 to 250 kg/m².</p>', 'work/web/intensive.html': '<h1>Intensive</h1><p>Weight: 300 to 1000 kg/m².</p>' },
    verify: [{ type: 'contains', path: 'work/brief.md', re: 'Extensive[\\s\\S]*60' }, { type: 'contains', path: 'work/brief.md', re: 'Intensive[\\s\\S]*300' }, { type: 'contains', path: 'work/brief.md', re: '(recommend|Recommendation)[\\s\\S]*Extensive' }, { type: 'contains', path: 'work/brief.md', re: 'Sources[\\s\\S]*extensive\\.html' }],
    solution: [{ op: 'write', path: 'work/brief.md', text: '# Green roofs\n## Overview\n...\n| type | kg/m² |\n|---|---|\n| Extensive | 60-150 |\n| Semi-intensive | 150-250 |\n| Intensive | 300-1000 |\n## Recommendation\nExtensive fits a 200 kg/m² limit.\n## Sources\n- extensive.html\n- semi.html\n- intensive.html\n' }],
  }),
  long({
    id: 'long-06', category: 'long', title: 'Clean up and document a messy share',
    goal: 'Tidy work/share: move files into folders by type (Documents, Images, Spreadsheets, Other), rename them to lowercase-with-hyphens, write work/share/INDEX.md listing every file with its new path, and report any duplicate contents in work/share/duplicates.txt (without deleting).',
    files: { 'work/share/Site Photo 1.JPG': 'p1', 'work/share/Site Photo 2.jpg': 'p1', 'work/share/Budget.xlsx': 'b', 'work/share/Brief.docx': 'd', 'work/share/readme': 'r' },
    verify: [{ type: 'exists', path: 'work/share/Images/site-photo-1.jpg' }, { type: 'exists', path: 'work/share/Spreadsheets/budget.xlsx' }, { type: 'exists', path: 'work/share/Documents/brief.docx' }, { type: 'exists', path: 'work/share/Other/readme' }, { type: 'contains', path: 'work/share/INDEX.md', re: 'Images/site-photo-2\\.jpg' }, { type: 'contains', path: 'work/share/duplicates.txt', re: 'site-photo-1[\\s\\S]*site-photo-2|site-photo-2[\\s\\S]*site-photo-1' }],
    solution: [{ op: 'move', from: 'work/share/Site Photo 1.JPG', to: 'work/share/Images/site-photo-1.jpg' }, { op: 'move', from: 'work/share/Site Photo 2.jpg', to: 'work/share/Images/site-photo-2.jpg' }, { op: 'move', from: 'work/share/Budget.xlsx', to: 'work/share/Spreadsheets/budget.xlsx' }, { op: 'move', from: 'work/share/Brief.docx', to: 'work/share/Documents/brief.docx' }, { op: 'move', from: 'work/share/readme', to: 'work/share/Other/readme' }, { op: 'write', path: 'work/share/INDEX.md', text: '- Images/site-photo-1.jpg\n- Images/site-photo-2.jpg\n- Spreadsheets/budget.xlsx\n- Documents/brief.docx\n- Other/readme\n' }, { op: 'write', path: 'work/share/duplicates.txt', text: 'site-photo-1.jpg, site-photo-2.jpg\n' }],
  }),
  long({
    id: 'long-07', category: 'long', tier: 'T3', title: 'Spreadsheet to memo across apps',
    goal: 'Open work/sales.xlsx in LibreOffice Calc, find the best region, write a short memo in Notepad naming it with its total, save the memo as work/memo.txt, and record the finding in work/vault/Projects/Sales.md.',
    grant: { apps: ['libreoffice', 'notepad'] },
    files: { 'work/sales.xlsx': { xlsx: [['region', 'total'], ['North', 4200], ['South', 5100], ['East', 3900]] } },
    verify: [{ type: 'contains', path: 'work/memo.txt', re: 'South[\\s\\S]*5,?100' }, { type: 'contains', path: 'work/vault/Projects/Sales.md', re: 'South' }],
    solution: [{ op: 'write', path: 'work/memo.txt', text: 'Best region: South (5100).\n' }, { op: 'write', path: 'work/vault/Projects/Sales.md', text: '# Sales\nSouth leads with 5100.\n' }],
  }),
  long({
    id: 'long-08', category: 'long', tier: 'T4', title: 'Weekly project report end to end',
    goal: 'Produce this week\'s Tower report: collect the logbook entries for 2026-W46 from the vault, update the cost sheet work/tower/costs.xlsx in Excel with this week\'s invoices from work/tower/invoices, write the report in Word as work/tower/report-W46.docx with a summary and the cost total, and draft (do not send) an email to the client with the report attached.',
    grant: { apps: ['excel', 'word', 'mail'] },
    files: { 'work/vault/Logbook.md': lines('- 2026-11-10 Tower: facade samples arrived', '- 2026-11-13 Tower: client approved samples'), 'work/tower/costs.xlsx': { xlsx: [['item', 'amount'], ['Previous', 120000]] }, 'work/tower/invoices/inv-1.txt': 'Glass samples: 1800' },
    verify: [{ type: 'contains', path: 'work/tower/report-W46.docx', re: 'samples' }, { type: 'contains', path: 'work/tower/costs.xlsx', re: '1800' }],
  }),
];
