'use strict';

const { task, lines } = require('./_base');

module.exports = [
  task({
    id: 'documents-01', category: 'documents', title: 'Fill a letter template',
    goal: 'Fill work/letter-template.md with the client details from work/client.json and save the result as work/letter-Lakeside.md. Replace every {{placeholder}}.',
    files: { 'work/letter-template.md': lines('Dear {{name}},', '', 'Thank you for choosing us for {{project}} in {{city}}.', '', 'Kind regards'), 'work/client.json': JSON.stringify({ name: 'Ms Rivera', project: 'Lakeside Pavilion', city: 'Porto' }) },
    verify: [{ type: 'contains', path: 'work/letter-Lakeside.md', re: 'Dear Ms Rivera' }, { type: 'contains', path: 'work/letter-Lakeside.md', re: 'Lakeside Pavilion in Porto' }, { type: 'notContains', path: 'work/letter-Lakeside.md', re: '\\{\\{' }],
    solution: [{ op: 'write', path: 'work/letter-Lakeside.md', text: 'Dear Ms Rivera,\n\nThank you for choosing us for Lakeside Pavilion in Porto.\n\nKind regards\n' }],
  }),
  task({
    id: 'documents-02', category: 'documents', title: 'Add a table of contents',
    goal: 'Add a "## Contents" section at the top of work/spec.md listing every second-level heading as a bullet, in order. Keep the rest unchanged.',
    files: { 'work/spec.md': lines('# Spec', '', '## Scope', 'text', '', '## Materials', 'text', '', '## Schedule', 'text') },
    verify: [{ type: 'contains', path: 'work/spec.md', re: '## Contents[\\s\\S]*-\\s*Scope[\\s\\S]*-\\s*Materials[\\s\\S]*-\\s*Schedule[\\s\\S]*## Scope' }, { type: 'contains', path: 'work/spec.md', re: '## Schedule\\s*\\ntext' }],
    solution: [{ op: 'write', path: 'work/spec.md', text: '# Spec\n\n## Contents\n- Scope\n- Materials\n- Schedule\n\n## Scope\ntext\n\n## Materials\ntext\n\n## Schedule\ntext\n' }],
  }),
  task({
    id: 'documents-03', category: 'documents', title: 'Convert meeting notes to minutes',
    goal: 'Turn the rough notes in work/notes.txt into work/minutes.md with three sections: Attendees, Decisions and Actions (each action with its owner).',
    files: { 'work/notes.txt': lines('ana, ben and chloe there', 'decided: glass facade', 'decided: terrazzo floor in lobby', 'ben to send revised drawings', 'chloe books the site visit') },
    verify: [{ type: 'contains', path: 'work/minutes.md', re: 'Attendees[\\s\\S]*Ana[\\s\\S]*Ben[\\s\\S]*Chloe', flags: 'i' }, { type: 'contains', path: 'work/minutes.md', re: 'Decisions[\\s\\S]*glass facade[\\s\\S]*terrazzo' }, { type: 'contains', path: 'work/minutes.md', re: 'Actions[\\s\\S]*Ben[\\s\\S]*drawings[\\s\\S]*Chloe[\\s\\S]*site visit|Actions[\\s\\S]*Chloe[\\s\\S]*site visit[\\s\\S]*Ben[\\s\\S]*drawings' }],
    solution: [{ op: 'write', path: 'work/minutes.md', text: '# Minutes\n## Attendees\n- Ana\n- Ben\n- Chloe\n## Decisions\n- glass facade\n- terrazzo floor in lobby\n## Actions\n- Ben: send revised drawings\n- Chloe: book the site visit\n' }],
  }),
  task({
    id: 'documents-04', category: 'documents', title: 'Find and replace a client name',
    goal: 'The client renamed from "Northwind" to "Northwind Studio". Update every .md file in work/docs, but not inside work/docs/archive.',
    files: { 'work/docs/a.md': 'Prepared for Northwind.', 'work/docs/b.md': 'Northwind requested changes. Northwind approved.', 'work/docs/archive/old.md': 'Northwind 2024' },
    verify: [{ type: 'contains', path: 'work/docs/a.md', re: 'Northwind Studio\\.' }, { type: 'contains', path: 'work/docs/b.md', re: 'Northwind Studio requested[\\s\\S]*Northwind Studio approved' }, { type: 'equals', path: 'work/docs/archive/old.md', text: 'Northwind 2024' }],
    solution: [{ op: 'write', path: 'work/docs/a.md', text: 'Prepared for Northwind Studio.' }, { op: 'write', path: 'work/docs/b.md', text: 'Northwind Studio requested changes. Northwind Studio approved.' }],
  }),
  task({
    id: 'documents-05', category: 'documents', title: 'Summarise a report into an executive summary',
    goal: 'Write work/summary.md: a 3 to 6 bullet executive summary of work/report.md that keeps every number in the report correct.',
    files: { 'work/report.md': lines('# Energy report', 'Consumption fell 18% after the retrofit.', 'Payback period is 6.5 years.', 'Solar covers 42% of demand in summer.', 'Two heat pumps were installed.') },
    verify: [{ type: 'lines', path: 'work/summary.md', min: 3 }, { type: 'contains', path: 'work/summary.md', re: '18\\s?%' }, { type: 'contains', path: 'work/summary.md', re: '6\\.5' }, { type: 'contains', path: 'work/summary.md', re: '42\\s?%' }],
    solution: [{ op: 'write', path: 'work/summary.md', text: '- Consumption fell 18% after the retrofit\n- Payback in 6.5 years\n- Solar covers 42% of summer demand\n- Two heat pumps installed\n' }],
  }),
  task({
    id: 'documents-06', category: 'documents', title: 'Merge chapter files',
    goal: 'Combine work/book/ch1.md, ch2.md and ch3.md in order into work/book/manuscript.md with a page break line "---" between chapters.',
    files: { 'work/book/ch1.md': '# One\nA.', 'work/book/ch2.md': '# Two\nB.', 'work/book/ch3.md': '# Three\nC.' },
    verify: [{ type: 'contains', path: 'work/book/manuscript.md', re: '# One[\\s\\S]*---[\\s\\S]*# Two[\\s\\S]*---[\\s\\S]*# Three' }],
    solution: [{ op: 'write', path: 'work/book/manuscript.md', text: '# One\nA.\n\n---\n\n# Two\nB.\n\n---\n\n# Three\nC.\n' }],
  }),
  task({
    id: 'documents-07', category: 'documents', title: 'Build an HTML handout',
    goal: 'Create work/handout.html from work/handout.md: a valid HTML page with a <title> equal to the first heading and each list item as an <li>.',
    files: { 'work/handout.md': lines('# Site safety', '- Wear a helmet', '- Sign in at the gate', '- No entry to zone C') },
    verify: [{ type: 'contains', path: 'work/handout.html', re: '<title>\\s*Site safety\\s*</title>' }, { type: 'contains', path: 'work/handout.html', re: '<li>\\s*Wear a helmet[\\s\\S]*<li>\\s*Sign in at the gate[\\s\\S]*<li>\\s*No entry to zone C' }],
    solution: [{ op: 'write', path: 'work/handout.html', text: '<!doctype html><html><head><title>Site safety</title></head><body><h1>Site safety</h1><ul><li>Wear a helmet</li><li>Sign in at the gate</li><li>No entry to zone C</li></ul></body></html>' }],
  }),
  task({
    id: 'documents-08', category: 'documents', title: 'Fix a numbered list',
    goal: 'The steps in work/procedure.md are numbered 1, 2, 2, 5, 6. Renumber them 1 to 5 without changing their text.',
    files: { 'work/procedure.md': lines('# Procedure', '1. Open the valve', '2. Wait 5 minutes', '2. Check the gauge', '5. Close the valve', '6. Log the reading') },
    verify: [{ type: 'contains', path: 'work/procedure.md', re: '1\\. Open the valve\\s*\\n2\\. Wait 5 minutes\\s*\\n3\\. Check the gauge\\s*\\n4\\. Close the valve\\s*\\n5\\. Log the reading' }],
    solution: [{ op: 'write', path: 'work/procedure.md', text: '# Procedure\n1. Open the valve\n2. Wait 5 minutes\n3. Check the gauge\n4. Close the valve\n5. Log the reading\n' }],
  }),
  task({
    id: 'documents-09', category: 'documents', tier: 'T3', title: 'Write a memo in Notepad',
    goal: 'Open Notepad, write a memo to the team that the site visit moved to Friday 10:00, and save it as work/memo.txt.',
    grant: { apps: ['notepad'] },
    verify: [{ type: 'contains', path: 'work/memo.txt', re: 'Friday' }, { type: 'contains', path: 'work/memo.txt', re: '10[:.]00' }, { type: 'contains', path: 'work/memo.txt', re: 'site visit' }],
    solution: [{ op: 'write', path: 'work/memo.txt', text: 'Team: the site visit moved to Friday 10:00.\n' }],
  }),
  task({
    id: 'documents-10', category: 'documents', tier: 'T3', title: 'Edit a document in LibreOffice Writer',
    goal: 'Open work/brief.odt in LibreOffice Writer, add a line "Budget: 1.2 million EUR" at the end, and save it in the same format.',
    grant: { apps: ['libreoffice'] },
    files: { 'work/brief.odt': { odt: ['Project brief', 'Client: Lakeside', 'Scope: pavilion and landscaping'] } },
    verify: [{ type: 'contains', path: 'work/brief.odt', re: 'Budget: 1\\.2 million EUR' }],
  }),
  task({
    id: 'documents-11', category: 'documents', tier: 'T4', title: 'Format a Word report',
    goal: 'In Microsoft Word, open work/report.docx, apply Heading 1 to the title, add a table of contents after it, and save.',
    grant: { apps: ['word'] },
    files: { 'work/report.docx': { docx: ['Annual site report', 'Introduction', 'The year in numbers.', 'Outlook', 'Next steps.'] } },
    verify: [{ type: 'contains', path: 'work/report.docx', re: 'Contents|Table of Contents' }],
  }),
  task({
    id: 'documents-12', category: 'documents', tier: 'T4', title: 'Export a Word document to PDF',
    goal: 'Export work/proposal.docx to work/proposal.pdf using Microsoft Word.',
    grant: { apps: ['word'] },
    files: { 'work/proposal.docx': { docx: ['Proposal', 'We propose a two-phase renovation.'] } },
    verify: [{ type: 'exists', path: 'work/proposal.pdf' }],
  }),
];
