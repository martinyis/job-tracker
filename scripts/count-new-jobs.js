const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.job.count({ where: { status: 'new' } }).then(c => {
  console.log(c);
  p.$disconnect();
});
