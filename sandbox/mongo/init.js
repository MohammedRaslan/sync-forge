// Sandbox MongoDB data: the "old CRM" that keeps customers as documents.
const crm = db.getSiblingDB('crm');
const cities = ['Cairo', 'Cologne', 'Berlin', 'Alexandria', 'Hamburg'];
const docs = [];
for (let n = 1; n <= 40; n++) {
  docs.push({
    customerRef: 'CUS-' + String(n).padStart(4, '0'),
    email: '  Customer' + n + '@Example.com ',
    name: { first: 'First' + n, last: 'Last' + n },
    address: { city: cities[n % cities.length], zip: String(10000 + n) },
    active: n % 7 === 0 ? 'no' : 'yes',
    createdAt: new Date(Date.UTC(2024, n % 12, (n % 27) + 1)),
    tags: n % 3 === 0 ? ['vip'] : [],
  });
}
crm.customers.insertMany(docs);
crm.customers.createIndex({ customerRef: 1 }, { unique: true });
