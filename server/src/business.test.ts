import { describe, expect, it } from 'vitest';
import { hasRole, isAuthenticated, SessionUser } from './auth-rules.js';
import { assertSufficientStock } from './sale-rules.js';

function calculateSale(items: { stock: number; quantity: number; price: number }[]) {
  if (!items.length) throw new Error('A venda precisa ter itens.');
  return items.reduce((total, item) => {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) throw new Error('Quantidade inválida.');
    if (item.quantity > item.stock) throw new Error('Estoque insuficiente.');
    if (!Number.isFinite(item.price) || item.price < 0) throw new Error('Preço inválido.');
    return total + item.quantity * item.price;
  }, 0);
}

describe('regras centrais de venda', () => {
  it('soma vários itens válidos', () => expect(calculateSale([{ stock: 5, quantity: 2, price: 10 }, { stock: 1, quantity: 1, price: 3.5 }])).toBe(23.5));
  it('rejeita quantidade acima do estoque', () => expect(() => calculateSale([{ stock: 2, quantity: 3, price: 10 }])).toThrow('Estoque insuficiente'));
  it('rejeita quantidade zero e preço inválido', () => { expect(() => calculateSale([{ stock: 2, quantity: 0, price: 10 }])).toThrow('Quantidade inválida'); expect(() => calculateSale([{ stock: 2, quantity: 1, price: -1 }])).toThrow('Preço inválido'); });
  it('compartilha a validação de estoque usada pela rota de venda', () => { expect(() => assertSufficientStock('Café', 2, 3)).toThrow('Estoque insuficiente'); expect(() => assertSufficientStock('Café', 2, 2)).not.toThrow(); });
});

describe('autenticação e autorização', () => {
  const employee: SessionUser = { id: 'u1', name: 'Funcionária', email: 'e@local.test', role: 'EMPLOYEE' };
  it('exige sessão autenticada', () => { expect(isAuthenticated(undefined)).toBe(false); expect(isAuthenticated(employee)).toBe(true); });
  it('restringe rotas administrativas ao perfil ADMIN', () => { expect(hasRole(employee, 'ADMIN')).toBe(false); expect(hasRole({ ...employee, role: 'ADMIN' }, 'ADMIN')).toBe(true); });
});
