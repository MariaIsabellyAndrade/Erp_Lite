import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
const prisma = new PrismaClient();
async function main() {
  const admin = await prisma.user.upsert({ where: { email: 'admin@erplite.local' }, update: {}, create: { name: 'Admin ERP Lite', email: 'admin@erplite.local', passwordHash: await bcrypt.hash('Admin123!', 12), role: 'ADMIN' } });
  const category = await prisma.category.upsert({ where: { name: 'Geral' }, update: {}, create: { name: 'Geral' } });
  const supplier = await prisma.supplier.findFirst({ where: { name: 'Fornecedor de demonstração' } }) ?? await prisma.supplier.create({ data: { name: 'Fornecedor de demonstração' } });
  const product = await prisma.product.upsert({ where: { sku: 'DEMO-001' }, update: {}, create: { sku: 'DEMO-001', name: 'Produto de demonstração', description: 'Item fictício para validar o fluxo de venda.', price: 29.9, cost: 15, stock: 20, minStock: 5, categoryId: category.id, supplierId: supplier.id } });
  const initialMovement = await prisma.stockMovement.findFirst({ where: { productId: product.id, reason: 'Saldo inicial do seed de demonstração' } });
  if (!initialMovement) await prisma.stockMovement.create({ data: { productId: product.id, userId: admin.id, type: 'IN', quantity: product.stock, reason: 'Saldo inicial do seed de demonstração' } });
  console.log(`Seed pronto. Usuário: ${admin.email}; senha fictícia: Admin123!`);
}
main().finally(() => prisma.$disconnect());
