import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl) process.env.DATABASE_URL = testDatabaseUrl;
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET ??= 'integration-test-secret-with-more-than-32-characters';

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const password = 'Integration123!';
let adminId = '';
let employeeId = '';
let productId = '';
let app: any;
let prisma: any;
let sessionStore: any;
if (testDatabaseUrl) ({ app, prisma, sessionStore } = await import('./index.js'));

describe.skipIf(!testDatabaseUrl)('integração HTTP de autenticação, permissões, estoque e venda', () => {
  beforeAll(async () => {
    await sessionStore.onReady();
    const hash = await bcrypt.hash(password, 4);
    const admin = await prisma.user.create({ data: { name: 'Admin teste', email: `admin-${suffix}@test.local`, passwordHash: hash, role: 'ADMIN' } });
    const employee = await prisma.user.create({ data: { name: 'Funcionário teste', email: `employee-${suffix}@test.local`, passwordHash: hash, role: 'EMPLOYEE' } });
    adminId = admin.id; employeeId = employee.id;
    const product = await prisma.product.create({ data: { sku: `TEST-${suffix}`, name: 'Produto de integração', price: 10, cost: 5, stock: 2, minStock: 1 } });
    productId = product.id;
  });

  afterAll(async () => {
    if (productId) {
      const sales = await prisma.sale.findMany({ where: { userId: { in: [adminId, employeeId] } }, select: { id: true } });
      const saleIds = sales.map((s: { id: string }) => s.id);
      if (saleIds.length) {
        await prisma.account.deleteMany({ where: { saleId: { in: saleIds } } });
        await prisma.saleItem.deleteMany({ where: { saleId: { in: saleIds } } });
        await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
      }
      await prisma.stockMovement.deleteMany({ where: { productId } });
      await prisma.product.delete({ where: { id: productId } });
    }
    if (adminId || employeeId) await prisma.user.deleteMany({ where: { id: { in: [adminId, employeeId].filter(Boolean) } } });
    await prisma.$disconnect();
    await sessionStore.close();
  });

  it('exige login e aplica permissões administrativas no servidor', async () => {
    const anonymous = await request(app).get('/api/auth/me');
    expect(anonymous.status).toBe(401);

    const employee = request.agent(app);
    const login = await employee.post('/api/auth/login').send({ email: `employee-${suffix}@test.local`, password });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('EMPLOYEE');
    const forbidden = await employee.post('/api/products').send({ sku: `DENIED-${suffix}`, name: 'Sem permissão', price: 1, cost: 1, stock: 0, minStock: 0 });
    expect(forbidden.status).toBe(403);
  });

  it('rejeita excesso sem gravar venda nem baixar saldo, e conclui a venda válida atomicamente', async () => {
    const admin = request.agent(app);
    const login = await admin.post('/api/auth/login').send({ email: `admin-${suffix}@test.local`, password });
    expect(login.status).toBe(200);
    const overstock = await admin.post('/api/sales').send({ items: [{ productId, quantity: 3 }] });
    expect(overstock.status).toBe(409);
    expect(await prisma.sale.count({ where: { userId: adminId } })).toBe(0);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock).toBe(2);

    const completed = await admin.post('/api/sales').send({ items: [{ productId, quantity: 1 }] });
    expect(completed.status).toBe(201);
    expect(Number(completed.body.total)).toBe(10);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock).toBe(1);
    expect(await prisma.stockMovement.count({ where: { productId, type: 'SALE', userId: adminId } })).toBe(1);
  });
});
