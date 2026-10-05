'use strict';
// Seeds a demo procurement manager, staff member and several vendors with catalogs.
// For evaluation only — do not run against a production database.
// Usage: npm run seed-demo
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb, tx } = require('../src/db');
const { hashPassword } = require('../src/auth');

const VENDORS = [
  {
    company: 'Gulf Valve Industries', email: 'sales@gulfvalve.example', country: 'Saudi Arabia',
    categories: [['discipline', 'Piping'], ['product_type', 'Valves'], ['product_type', 'Flanges & Gaskets']],
    products: [
      ['GV-600-10', '10" 600# RF Gate Valve, API 600, A105', 'product_type', 'Valves', 'EA', 4850, 'USD', 56, 2],
      ['BV-150-06', '6" 150# Floating Ball Valve, API 6D', 'product_type', 'Valves', 'EA', 1320, 'USD', 35, 4],
      ['SW-GKT-08', '8" 300# Spiral Wound Gasket SS316/Graphite', 'product_type', 'Flanges & Gaskets', 'EA', 38.5, 'USD', 10, 50],
    ],
  },
  {
    company: 'Arabian Pipe & Fittings Co.', email: 'rfq@apf.example', country: 'UAE',
    categories: [['discipline', 'Piping'], ['product_type', 'Pipes & Fittings'], ['product_type', 'Valves']],
    products: [
      ['A106B-12-80', 'Seamless Pipe 12" Sch 80 ASTM A106 Gr.B, 3.1 MTC', 'product_type', 'Pipes & Fittings', 'M', 212, 'USD', 21, 60],
      ['WN-FL-10-600', '10" 600# Weld Neck Flange A105', 'product_type', 'Flanges & Gaskets', 'EA', 410, 'USD', 18, 10],
      ['GV-300-08', '8" 300# Gate Valve, cast WCB', 'product_type', 'Valves', 'EA', 2100, 'USD', 42, 2],
    ],
  },
  {
    company: 'Desert Power Systems', email: 'tenders@desertpower.example', country: 'Saudi Arabia',
    categories: [['discipline', 'Electrical'], ['product_type', 'Switchgear & Panels'], ['product_type', 'Cables & Wiring']],
    products: [
      ['MV-SWG-33', '33kV Gas Insulated Switchgear Panel, IEC 62271-200', 'product_type', 'Switchgear & Panels', 'EA', 186000, 'USD', 180, 1],
      ['XLPE-3C-240', '3C x 240mm² XLPE/SWA/PVC 0.6/1kV Cable', 'product_type', 'Cables & Wiring', 'M', 64, 'USD', 30, 500],
    ],
  },
  {
    company: 'Precision Instruments Trading', email: 'quotes@pit.example', country: 'Bahrain',
    categories: [['discipline', 'Instrumentation & Control'], ['product_type', 'Transmitters & Sensors'], ['service', 'Calibration & Testing']],
    products: [
      ['PT-3051-HART', 'Pressure Transmitter 0–100 bar, 4–20mA HART, ATEX', 'product_type', 'Transmitters & Sensors', 'EA', 1480, 'USD', 28, 1],
    ],
  },
];

async function main() {
  const db = openDb(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'astco.db'));
  if (db.prepare("SELECT 1 FROM users WHERE email = 'manager@astco.example'").get()) {
    console.log('Demo data already present. Delete data/astco.db to re-seed.');
    return;
  }
  const password = 'Demo-' + crypto.randomBytes(6).toString('hex') + '1';
  const hash = await hashPassword(password);
  const now = new Date().toISOString();
  const catId = (kind, name) => db.prepare('SELECT id FROM categories WHERE kind = ? AND name = ?').get(kind, name).id;

  tx(db, () => {
    const addUser = db.prepare('INSERT INTO users (email, password_hash, full_name, role, vendor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    addUser.run('manager@astco.example', hash, 'Demo Procurement Manager', 'procurement_manager', null, now);
    addUser.run('staff@astco.example', hash, 'Demo Procurement Staff', 'procurement_staff', null, now);
    for (const v of VENDORS) {
      const vid = Number(db.prepare('INSERT INTO vendors (company_name, contact_email, country, created_at) VALUES (?, ?, ?, ?)')
        .run(v.company, v.email, v.country, now).lastInsertRowid);
      addUser.run(v.email, hash, `${v.company} Sales`, 'vendor', vid, now);
      for (const [kind, name] of v.categories) {
        db.prepare('INSERT INTO vendor_categories (vendor_id, category_id) VALUES (?, ?)').run(vid, catId(kind, name));
      }
      for (const [sku, name, kind, cat, unit, price, cur, lead, moq] of v.products) {
        db.prepare(`INSERT INTO products (vendor_id, sku, name, category_id, unit, unit_price, currency, lead_time_days, moq, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(vid, sku, name, catId(kind, cat), unit, price, cur, lead, moq, now);
      }
    }
  });
  db.close();

  console.log('Demo data created. All demo accounts share this password:\n');
  console.log(`  Password: ${password}\n`);
  console.log('  manager@astco.example   (Procurement Manager)');
  console.log('  staff@astco.example     (Procurement Staff)');
  for (const v of VENDORS) console.log(`  ${v.email.padEnd(30)}(Vendor: ${v.company})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
