'use strict';

const { task, lines } = require('./_base');

module.exports = [
  task({
    id: 'spreadsheets-01', category: 'spreadsheets', title: 'Total expenses by category',
    goal: 'From work/expenses.csv, create work/totals.csv with columns category,total (one row per category, totals to 2 decimals, sorted by category).',
    files: { 'work/expenses.csv': lines('date,category,amount', '2026-10-01,travel,120.50', '2026-10-02,food,18.20', '2026-10-05,travel,79.50', '2026-10-09,office,45.00', '2026-10-11,food,22.30') },
    verify: [{ type: 'csvRows', path: 'work/totals.csv', n: 3 }, { type: 'csv', path: 'work/totals.csv', row: 1, col: 0, re: '^food$' }, { type: 'csv', path: 'work/totals.csv', row: 1, col: 1, eq: '40.50' }, { type: 'csv', path: 'work/totals.csv', row: 3, col: 1, eq: '200.00' }],
    solution: [{ op: 'write', path: 'work/totals.csv', text: 'category,total\nfood,40.50\noffice,45.00\ntravel,200.00\n' }],
  }),
  task({
    id: 'spreadsheets-02', category: 'spreadsheets', title: 'Clean a contact list',
    goal: 'Clean work/contacts.csv into work/contacts-clean.csv: trim spaces, lowercase emails, remove exact duplicate rows and rows without an email. Keep the header.',
    files: { 'work/contacts.csv': lines('name,email', ' Ana Silva ,ANA@Example.com', 'Ben Ode,ben@example.com', 'Ben Ode,ben@example.com', 'No Mail,', 'Chloe Wu, chloe@example.com ') },
    verify: [{ type: 'csvRows', path: 'work/contacts-clean.csv', n: 3 }, { type: 'csv', path: 'work/contacts-clean.csv', row: 1, col: 0, eq: 'Ana Silva' }, { type: 'csv', path: 'work/contacts-clean.csv', row: 1, col: 1, eq: 'ana@example.com' }, { type: 'notContains', path: 'work/contacts-clean.csv', re: 'No Mail' }],
    solution: [{ op: 'write', path: 'work/contacts-clean.csv', text: 'name,email\nAna Silva,ana@example.com\nBen Ode,ben@example.com\nChloe Wu,chloe@example.com\n' }],
  }),
  task({
    id: 'spreadsheets-03', category: 'spreadsheets', title: 'Add a computed column',
    goal: 'Add a column "area" (width × depth, in square metres, 2 decimals) to work/rooms.csv and save it as work/rooms-area.csv.',
    files: { 'work/rooms.csv': lines('room,width,depth', 'Kitchen,3.2,4.1', 'Bedroom,3.5,3.5', 'Bath,2,2.25') },
    verify: [{ type: 'csv', path: 'work/rooms-area.csv', row: 0, col: 3, re: '^area$' }, { type: 'csv', path: 'work/rooms-area.csv', row: 1, col: 3, eq: '13.12' }, { type: 'csv', path: 'work/rooms-area.csv', row: 2, col: 3, eq: '12.25' }, { type: 'csv', path: 'work/rooms-area.csv', row: 3, col: 3, eq: '4.50' }],
    solution: [{ op: 'write', path: 'work/rooms-area.csv', text: 'room,width,depth,area\nKitchen,3.2,4.1,13.12\nBedroom,3.5,3.5,12.25\nBath,2,2.25,4.50\n' }],
  }),
  task({
    id: 'spreadsheets-04', category: 'spreadsheets', title: 'Join two tables',
    goal: 'Create work/orders-full.csv by adding the customer name from work/customers.csv to each row of work/orders.csv (match on customer_id).',
    files: { 'work/orders.csv': lines('order,customer_id,total', '1001,C2,250', '1002,C1,90', '1003,C2,40'), 'work/customers.csv': lines('customer_id,name', 'C1,Lakeside', 'C2,Northwind') },
    verify: [{ type: 'csvRows', path: 'work/orders-full.csv', n: 3 }, { type: 'contains', path: 'work/orders-full.csv', re: '1001[^\\n]*Northwind' }, { type: 'contains', path: 'work/orders-full.csv', re: '1002[^\\n]*Lakeside' }, { type: 'contains', path: 'work/orders-full.csv', re: '1003[^\\n]*Northwind' }],
    solution: [{ op: 'write', path: 'work/orders-full.csv', text: 'order,customer_id,total,name\n1001,C2,250,Northwind\n1002,C1,90,Lakeside\n1003,C2,40,Northwind\n' }],
  }),
  task({
    id: 'spreadsheets-05', category: 'spreadsheets', title: 'Filter rows by condition',
    goal: 'Write work/overdue.csv with only the invoices in work/invoices.csv that are unpaid and due before 2026-11-01.',
    files: { 'work/invoices.csv': lines('invoice,due,paid', 'A1,2026-10-15,no', 'A2,2026-10-20,yes', 'A3,2026-11-05,no', 'A4,2026-09-30,no') },
    verify: [{ type: 'csvRows', path: 'work/overdue.csv', n: 2 }, { type: 'contains', path: 'work/overdue.csv', re: 'A1' }, { type: 'contains', path: 'work/overdue.csv', re: 'A4' }, { type: 'notContains', path: 'work/overdue.csv', re: 'A2|A3' }],
    solution: [{ op: 'write', path: 'work/overdue.csv', text: 'invoice,due,paid\nA1,2026-10-15,no\nA4,2026-09-30,no\n' }],
  }),
  task({
    id: 'spreadsheets-06', category: 'spreadsheets', title: 'Pivot monthly sales',
    goal: 'From work/sales.csv build work/pivot.csv with one row per region and columns region,Jan,Feb (sum of units).',
    files: { 'work/sales.csv': lines('month,region,units', 'Jan,North,10', 'Jan,South,4', 'Feb,North,7', 'Jan,North,5', 'Feb,South,9') },
    verify: [{ type: 'contains', path: 'work/pivot.csv', re: 'region,Jan,Feb' }, { type: 'contains', path: 'work/pivot.csv', re: 'North,15,7' }, { type: 'contains', path: 'work/pivot.csv', re: 'South,4,9' }],
    solution: [{ op: 'write', path: 'work/pivot.csv', text: 'region,Jan,Feb\nNorth,15,7\nSouth,4,9\n' }],
  }),
  task({
    id: 'spreadsheets-07', category: 'spreadsheets', title: 'Convert units',
    goal: 'work/materials.csv lists lengths in feet. Write work/materials-m.csv with the same rows and lengths converted to metres (2 decimals), column renamed to length_m.',
    files: { 'work/materials.csv': lines('item,length_ft', 'beam,10', 'joist,12.5', 'post,8') },
    verify: [{ type: 'csv', path: 'work/materials-m.csv', row: 0, col: 1, re: '^length_m$' }, { type: 'csv', path: 'work/materials-m.csv', row: 1, col: 1, eq: '3.05' }, { type: 'csv', path: 'work/materials-m.csv', row: 2, col: 1, eq: '3.81' }, { type: 'csv', path: 'work/materials-m.csv', row: 3, col: 1, eq: '2.44' }],
    solution: [{ op: 'write', path: 'work/materials-m.csv', text: 'item,length_m\nbeam,3.05\njoist,3.81\npost,2.44\n' }],
  }),
  task({
    id: 'spreadsheets-08', category: 'spreadsheets', title: 'Spot data errors',
    goal: 'Check work/timesheet.csv for rows where hours are negative or above 16 and list those rows (by date) in work/errors.txt.',
    files: { 'work/timesheet.csv': lines('date,hours', '2026-11-02,8', '2026-11-03,-2', '2026-11-04,7.5', '2026-11-05,19', '2026-11-06,8') },
    verify: [{ type: 'contains', path: 'work/errors.txt', re: '2026-11-03' }, { type: 'contains', path: 'work/errors.txt', re: '2026-11-05' }, { type: 'notContains', path: 'work/errors.txt', re: '2026-11-0[246]' }],
    solution: [{ op: 'write', path: 'work/errors.txt', text: '2026-11-03 (-2)\n2026-11-05 (19)\n' }],
  }),
  task({
    id: 'spreadsheets-09', category: 'spreadsheets', title: 'JSON to CSV',
    goal: 'Convert work/tasks.json (an array of objects) into work/tasks.csv with columns id,title,done.',
    files: { 'work/tasks.json': JSON.stringify([{ id: 1, title: 'Survey site', done: true }, { id: 2, title: 'Draft plan, v1', done: false }]) },
    verify: [{ type: 'csvRows', path: 'work/tasks.csv', n: 2 }, { type: 'csv', path: 'work/tasks.csv', row: 2, col: 1, eq: 'Draft plan, v1' }, { type: 'csv', path: 'work/tasks.csv', row: 1, col: 2, re: '^true$' }],
    solution: [{ op: 'write', path: 'work/tasks.csv', text: 'id,title,done\n1,Survey site,true\n2,"Draft plan, v1",false\n' }],
  }),
  task({
    id: 'spreadsheets-10', category: 'spreadsheets', tier: 'T3', title: 'Edit a sheet in LibreOffice Calc',
    goal: 'Open work/budget.xlsx in LibreOffice Calc, add a row "Contingency" with 5000 at the bottom, and save it as xlsx.',
    grant: { apps: ['libreoffice'] },
    files: { 'work/budget.xlsx': { xlsx: [['item', 'amount'], ['Design', 12000], ['Build', 85000]] } },
    verify: [{ type: 'contains', path: 'work/budget.xlsx', re: 'Contingency,5000' }, { type: 'contains', path: 'work/budget.xlsx', re: 'Design,12000' }],
  }),
  task({
    id: 'spreadsheets-11', category: 'spreadsheets', tier: 'T4', title: 'Excel formula and chart',
    goal: 'In Microsoft Excel open work/costs.xlsx, add a Total row summing the amount column with a formula, add a column chart of the amounts, and save.',
    grant: { apps: ['excel'] },
    files: { 'work/costs.xlsx': { xlsx: [['phase', 'amount'], ['Design', 12000], ['Build', 85000], ['Fit-out', 23000]] } },
    verify: [{ type: 'contains', path: 'work/costs.xlsx', re: 'Total,120000' }],
  }),
  task({
    id: 'spreadsheets-12', category: 'spreadsheets', tier: 'T4', title: 'Excel report from CSV',
    goal: 'Import work/visits.csv into a new Excel workbook work/visits.xlsx, format the header bold, and add a count of visits per site on a second sheet.',
    grant: { apps: ['excel'] },
    files: { 'work/visits.csv': lines('date,site', '2026-11-01,Tower', '2026-11-02,Lakeside', '2026-11-03,Tower') },
    verify: [{ type: 'exists', path: 'work/visits.xlsx' }, { type: 'contains', path: 'work/visits.xlsx', re: 'Tower' }],
  }),
];
