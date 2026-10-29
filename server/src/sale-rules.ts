export function assertSufficientStock(name: string, stock: number, quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error('Quantidade inválida.');
  if (stock < quantity) throw Object.assign(new Error(`Estoque insuficiente para ${name}. Disponível: ${stock}.`), { status: 409 });
}
