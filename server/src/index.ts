import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
import express, { NextFunction, Request, Response } from 'express';
import session from 'express-session';
import cors from 'cors';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import connectMySQLSession from 'express-mysql-session';
import { Prisma, PrismaClient, Role, MovementType, AccountType, AccountStatus } from '@prisma/client';
import { z, ZodError } from 'zod';
import { hasRole, isAuthenticated } from './auth-rules.js';
import { assertSufficientStock } from './sale-rules.js';

const prisma = new PrismaClient();
const app = express();
const databaseUrl = new URL(process.env.DATABASE_URL ?? 'mysql://erp:erp_dev@localhost:3306/erp_lite');
const MySQLStore = connectMySQLSession(session);
const sessionStore = new MySQLStore({
  host: databaseUrl.hostname,
  port: Number(databaseUrl.port || 3306),
  user: decodeURIComponent(databaseUrl.username),
  password: decodeURIComponent(databaseUrl.password),
  database: databaseUrl.pathname.slice(1),
  clearExpired: true,
  expiration: 8 * 60 * 60 * 1000,
  createDatabaseTable: true
});
app.use(helmet());
app.set('trust proxy', 1);
app.use(cors({ origin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173', credentials: true }));
app.use(express.json());
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.use(session({ name: 'erp.sid', secret: process.env.SESSION_SECRET ?? '', store: sessionStore, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 } }));

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!isAuthenticated(req.session.user)) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Faça login para continuar.' } });
  next();
}
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!hasRole(req.session.user, 'ADMIN')) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Acesso restrito ao administrador.' } });
  next();
}
const positiveMoney = z.number().finite().nonnegative().max(9999999999.99);
const productInput = z.object({ sku: z.string().trim().min(1).max(40), name: z.string().trim().min(2).max(120), description: z.string().max(500).optional(), price: positiveMoney, cost: positiveMoney, stock: z.number().int().nonnegative().max(10000000).default(0), minStock: z.number().int().nonnegative().max(10000000).default(0), categoryId: z.string().optional().nullable(), supplierId: z.string().optional().nullable() });
const saleInput = z.object({ items: z.array(z.object({ productId: z.string().min(1), quantity: z.number().int().positive().max(1000000) })).min(1).max(100) });
const accountInput = z.object({ type: z.nativeEnum(AccountType), description: z.string().trim().min(2).max(160), amount: z.number().finite().positive().max(9999999999.99), dueDate: z.coerce.date() });
const asyncRoute = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res, next)).catch(next);
const toProduct = (p: any) => ({ ...p, price: Number(p.price), cost: Number(p.cost) });

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const input = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
  if (!user || !user.active || !await bcrypt.compare(input.password, user.passwordHash)) return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'E-mail ou senha inválidos.' } });
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  res.json({ user: req.session.user });
}));
app.post('/api/auth/logout', requireAuth, (req, res) => req.session.destroy(() => { res.clearCookie('erp.sid'); res.status(204).end(); }));
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.session.user }));
app.get('/api/users', requireAuth, requireAdmin, asyncRoute(async (_req, res) => res.json(await prisma.user.findMany({ select: { id: true, name: true, email: true, role: true, active: true, createdAt: true } }))));
app.post('/api/users', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const input = z.object({ name: z.string().trim().min(2).max(120), email: z.string().email(), password: z.string().min(12).max(100), role: z.nativeEnum(Role) }).parse(req.body);
  const user = await prisma.user.create({ data: { name: input.name, email: input.email.toLowerCase(), passwordHash: await bcrypt.hash(input.password, 12), role: input.role }, select: { id: true, name: true, email: true, role: true, active: true, createdAt: true } });
  res.status(201).json(user);
}));

app.get('/api/products', requireAuth, asyncRoute(async (req, res) => {
  const q = String(req.query.q ?? ''); const active = req.query.active === 'all' ? undefined : req.query.active === 'false' ? false : true;
  const rows = await prisma.product.findMany({ where: { active, ...(q ? { OR: [{ name: { contains: q } }, { sku: { contains: q } }] } : {}) }, include: { category: true, supplier: true }, orderBy: { name: 'asc' } });
  res.json(rows.map(toProduct));
}));
app.post('/api/products', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const input = productInput.parse(req.body); const row = await prisma.$transaction(async tx => {
    const created = await tx.product.create({ data: input });
    if (input.stock > 0) await tx.stockMovement.create({ data: { productId: created.id, userId: req.session.user!.id, type: MovementType.IN, quantity: input.stock, reason: 'Saldo inicial no cadastro do produto' } });
    return created;
  });
  res.status(201).json(toProduct(row));
}));
app.patch('/api/products/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const input = productInput.partial().omit({ stock: true }).parse(req.body); const row = await prisma.product.update({ where: { id: String(req.params.id) }, data: input }); res.json(toProduct(row));
}));
app.delete('/api/products/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  await prisma.product.update({ where: { id: String(req.params.id) }, data: { active: false } }); res.status(204).end();
}));
app.get('/api/categories', requireAuth, asyncRoute(async (_req, res) => res.json(await prisma.category.findMany({ orderBy: { name: 'asc' } }))));
app.post('/api/categories', requireAuth, requireAdmin, asyncRoute(async (req, res) => { const data = z.object({ name: z.string().trim().min(2).max(80) }).parse(req.body); res.status(201).json(await prisma.category.create({ data })); }));
app.get('/api/suppliers', requireAuth, asyncRoute(async (_req, res) => res.json(await prisma.supplier.findMany({ where: { active: true }, orderBy: { name: 'asc' } }))));
app.post('/api/suppliers', requireAuth, requireAdmin, asyncRoute(async (req, res) => { const data = z.object({ name: z.string().trim().min(2).max(120), email: z.string().email().optional().or(z.literal('')), phone: z.string().max(30).optional() }).parse(req.body); res.status(201).json(await prisma.supplier.create({ data })); }));

app.post('/api/stock/movements', requireAuth, asyncRoute(async (req, res) => {
  const input = z.object({ productId: z.string(), type: z.enum(['IN','OUT','ADJUSTMENT']), quantity: z.number().int().positive().max(1000000), reason: z.string().trim().min(3).max(200) }).parse(req.body);
  const movement = await prisma.$transaction(async tx => {
    const product = await tx.product.findUnique({ where: { id: input.productId } });
    if (!product || !product.active) throw Object.assign(new Error('Produto não encontrado ou inativo.'), { status: 404 });
    const change = input.type === 'IN' ? input.quantity : -input.quantity;
    if (product.stock + change > 10000000) throw Object.assign(new Error('O saldo excede o limite permitido de 10.000.000 unidades.'), { status: 400 });
    if (product.stock + change < 0) throw Object.assign(new Error('Estoque insuficiente para esta saída.'), { status: 409 });
    await tx.product.update({ where: { id: product.id }, data: { stock: product.stock + change } });
    return tx.stockMovement.create({ data: { productId: product.id, userId: req.session.user!.id, type: input.type as MovementType, quantity: input.quantity, reason: input.reason } });
  });
  res.status(201).json(movement);
}));
app.get('/api/stock/movements', requireAuth, asyncRoute(async (req, res) => {
  const since = req.query.from ? new Date(String(req.query.from)) : undefined, until = req.query.to ? new Date(String(req.query.to)) : undefined;
  const rows = await prisma.stockMovement.findMany({ where: { ...(req.query.productId ? { productId: String(req.query.productId) } : {}), ...(since || until ? { createdAt: { ...(since ? { gte: since } : {}), ...(until ? { lte: until } : {}) } } : {}) }, include: { product: { select: { id: true, name: true, sku: true } }, user: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 500 }); res.json(rows);
}));

app.post('/api/sales', requireAuth, asyncRoute(async (req, res) => {
  const input = saleInput.parse(req.body); const grouped = new Map<string, number>();
  for (const item of input.items) grouped.set(item.productId, (grouped.get(item.productId) ?? 0) + item.quantity);
  const sale = await prisma.$transaction(async tx => {
    const products = await tx.product.findMany({ where: { id: { in: [...grouped.keys()] }, active: true } });
    if (products.length !== grouped.size) throw Object.assign(new Error('Um ou mais produtos não existem ou estão inativos.'), { status: 400 });
    let total = new Prisma.Decimal(0);
    const entries = products.map(p => {
      const quantity = grouped.get(p.id)!;
      assertSufficientStock(p.name, p.stock, quantity);
      const subtotal = p.price.mul(quantity); total = total.add(subtotal);
      return { product: p, quantity, subtotal };
    });
    if (total.greaterThan('9999999999.99')) throw Object.assign(new Error('O total da venda excede o limite permitido.'), { status: 400 });
    const created = await tx.sale.create({ data: { userId: req.session.user!.id, total, items: { create: entries.map(({product, quantity, subtotal}) => ({ productId: product.id, productName: product.name, sku: product.sku, quantity, unitPrice: product.price, subtotal })) } } });
    for (const { product, quantity } of entries) {
      const changed = await tx.product.updateMany({ where: { id: product.id, stock: { gte: quantity }, active: true }, data: { stock: { decrement: quantity } } });
      if (changed.count !== 1) throw Object.assign(new Error(`Estoque insuficiente para ${product.name}.`), { status: 409 });
      await tx.stockMovement.create({ data: { productId: product.id, userId: req.session.user!.id, type: MovementType.SALE, quantity, reason: `Venda #${created.number}`, referenceId: created.id } });
    }
    await tx.account.create({ data: { type: AccountType.RECEIVABLE, description: `Venda #${created.number}`, amount: total, dueDate: new Date(), saleId: created.id, status: AccountStatus.PAID } });
    return tx.sale.findUnique({ where: { id: created.id }, include: { items: true, user: { select: { name: true } } } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  res.status(201).json(sale);
}));
app.get('/api/sales', requireAuth, asyncRoute(async (req, res) => { const from = req.query.from ? new Date(String(req.query.from)) : undefined, to = req.query.to ? new Date(String(req.query.to)) : undefined; res.json(await prisma.sale.findMany({ where: { ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}) }, include: { items: true, user: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 500 })); }));

app.get('/api/accounts', requireAuth, asyncRoute(async (req, res) => res.json(await prisma.account.findMany({ where: { ...(req.query.type ? { type: String(req.query.type) as AccountType } : {}), ...(req.query.status ? { status: String(req.query.status) as AccountStatus } : {}) }, include: { sale: { select: { number: true } } }, orderBy: { dueDate: 'asc' } }))));
app.post('/api/accounts', requireAuth, requireAdmin, asyncRoute(async (req, res) => { const input = accountInput.parse(req.body); res.status(201).json(await prisma.account.create({ data: input })); }));
app.patch('/api/accounts/:id/pay', requireAuth, requireAdmin, asyncRoute(async (req, res) => res.json(await prisma.account.update({ where: { id: String(req.params.id) }, data: { status: AccountStatus.PAID } }))));

app.get('/api/dashboard', requireAuth, asyncRoute(async (_req, res) => {
  const start = new Date(); start.setHours(0,0,0,0);
  const [sales, todayCount, lowStock, openPayable, openReceivable] = await Promise.all([
    prisma.sale.aggregate({ where: { createdAt: { gte: start } }, _sum: { total: true } }), prisma.sale.count({ where: { createdAt: { gte: start } } }), prisma.product.findMany({ where: { active: true, stock: { lte: 1000000 } }, select: { id: true, sku: true, name: true, stock: true, minStock: true } }), prisma.account.aggregate({ where: { type: AccountType.PAYABLE, status: AccountStatus.OPEN }, _sum: { amount: true } }), prisma.account.aggregate({ where: { type: AccountType.RECEIVABLE, status: AccountStatus.OPEN }, _sum: { amount: true } })
  ]);
  res.json({ todayRevenue: Number(sales._sum.total ?? 0), todaySales: todayCount, lowStock: lowStock.filter(p => p.stock <= p.minStock), openPayable: Number(openPayable._sum.amount ?? 0), openReceivable: Number(openReceivable._sum.amount ?? 0) });
}));
app.get('/api/reports/sales', requireAuth, asyncRoute(async (req, res) => {
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(new Date().setDate(1)); const to = req.query.to ? new Date(String(req.query.to)) : new Date(); to.setHours(23,59,59,999);
  const rows = await prisma.sale.findMany({ where: { createdAt: { gte: from, lte: to } }, include: { items: true, user: { select: { name: true } } }, orderBy: { createdAt: 'desc' } });
  res.json({ from, to, count: rows.length, revenue: rows.reduce((sum, s) => sum + Number(s.total), 0), sales: rows });
}));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Dados inválidos.', details: err.flatten() } });
  if (err instanceof Prisma.PrismaClientKnownRequestError) { const conflict = err.code === 'P2002' || err.code === 'P2034'; return res.status(conflict ? 409 : err.code === 'P2025' ? 404 : 400).json({ error: { code: err.code, message: err.code === 'P2034' ? 'A operação concorrente alterou o estoque. Tente novamente.' : conflict ? 'Já existe um registro com este valor.' : err.code === 'P2025' ? 'Registro não encontrado.' : 'Não foi possível processar a solicitação.' } }); }
  const status = (err as any)?.status ?? 500; res.status(status).json({ error: { code: status >= 500 ? 'INTERNAL_ERROR' : 'BUSINESS_RULE', message: status >= 500 ? 'Erro interno do servidor.' : (err as Error).message } });
});

const port = Number(process.env.PORT ?? 3001);
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET deve ter ao menos 32 caracteres. Configure o .env.');
if (process.env.NODE_ENV !== 'test') {
  void sessionStore.onReady().then(() => app.listen(port, () => console.log(`ERP Lite API em http://localhost:${port}`))).catch(error => {
    console.error('Não foi possível inicializar o armazenamento de sessões MySQL.', error);
    process.exitCode = 1;
  });
}
export { app, prisma, sessionStore };
