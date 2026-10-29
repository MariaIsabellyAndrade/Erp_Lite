# ERP Lite

ERP Lite é um sistema de gestão comercial pequeno, com API REST, interface web e MySQL. O MySQL Workbench pode ser usado para visualizar e consultar o banco. O foco do projeto é demonstrar regras de negócio reais: a venda valida o saldo e registra venda, itens, recebível e baixa de estoque na mesma transação; entradas e saídas registram usuário, data e motivo; produtos são inativados logicamente para preservar o histórico.

## Arquitetura

- `client/`: React, Vite e TypeScript. A interface consulta a API, não simula dados.
- `server/`: Node.js, Express e TypeScript, validação com Zod, sessão HTTP-only e autorização no servidor.
- `server/prisma/`: schema relacional, seed e migrations Prisma.
- `openapi.yaml`: contrato OpenAPI 3.0.
- MySQL 8.4: dados transacionais. Preços e valores usam `Decimal(12,2)`; sessões de login também ficam armazenadas no MySQL.

### Diagrama ER

```mermaid
erDiagram
  USER ||--o{ SALE : registra
  USER ||--o{ STOCK_MOVEMENT : realiza
  CATEGORY ||--o{ PRODUCT : classifica
  SUPPLIER ||--o{ PRODUCT : fornece
  PRODUCT ||--o{ SALE_ITEM : vendido_em
  PRODUCT ||--o{ STOCK_MOVEMENT : movimentado
  SALE ||--|{ SALE_ITEM : contem
  SALE ||--o| ACCOUNT : gera_recebivel
  USER { string id PK string name string email UK enum role boolean active }
  CATEGORY { string id PK string name UK }
  SUPPLIER { string id PK string name string email string phone }
  PRODUCT { string id PK string sku UK string name decimal price decimal cost int stock int minStock boolean active string categoryId FK string supplierId FK }
  SALE { string id PK int number UK string userId FK decimal total datetime createdAt }
  SALE_ITEM { string id PK string saleId FK string productId FK string productName string sku int quantity decimal unitPrice decimal subtotal }
  STOCK_MOVEMENT { string id PK string productId FK string userId FK enum type int quantity string reason string referenceId datetime createdAt }
  ACCOUNT { string id PK enum type string description decimal amount datetime dueDate enum status string saleId FK }
```

## Requisitos

- Node.js 20 ou superior e npm 10.
- Docker Desktop / Docker Compose para executar MySQL, API e frontend em containers.
- MySQL Workbench é opcional e serve para consultar o servidor MySQL.

## Instalação local


1. Instale dependências: `npm install`.
2. Inicie o banco MySQL (por exemplo, `docker compose up db -d`) e aplique a migration: `npm run db:migrate -w server`.
3. Carregue dados fictícios: `npm run db:seed`.
4. Inicie frontend e API: `npm run dev`.
5. Abra `http://localhost:5173`. O Vite encaminha `/api` para a porta indicada por `PORT` no `.env` (3001 por padrão).

O seed cria o usuário de demonstração `admin@erplite.local` com senha `Admin123!`, um produto fictício e cadastros auxiliares. Troque/remova a senha de demonstração antes de qualquer implantação compartilhada. Nenhum segredo real deve ser versionado.

## Docker Compose


```bash
docker compose up --build
```

O Compose sobe MySQL, API e frontend Nginx na porta 5173. Para executar só a interface com hot reload em desenvolvimento, use `npm run dev -w client` e mantenha API/banco em execução. Para produção, altere o modo da API para HTTPS atrás de proxy TLS; cookies de sessão ficam `Secure` quando `NODE_ENV=production`.

### Conectar pelo MySQL Workbench

Com o Compose em execução, crie uma conexão no Workbench com host `127.0.0.1`, porta `3306`, usuário `erp` e senha local de desenvolvimento `erp_dev`. Selecione o schema `erp_lite`. O usuário root do container tem senha local `local_root_dev`; prefira a conta `erp` para consultar e editar os dados da aplicação.

## Scripts

```bash
npm run dev                 # frontend e API em modo watch
npm run build               # compila API e frontend
npm test                    # testes unitários de regras, sessão e perfil
npm run test:integration -w server # integração HTTP (requer MySQL isolado)
npm run db:migrate -w server # aplica migrations existentes
npm run db:migrate:dev -w server # cria migration nova (requer permissão de shadow database)
npm run db:baseline:initial -w server # somente após aplicar o SQL inicial manualmente em schema já existente
npm run db:seed              # dados fictícios idempotentes
```

## API e exemplos

Importe [`openapi.yaml`](./openapi.yaml) no Swagger Editor ou Insomnia. A sessão é cookie `erp.sid`, HTTP-only e SameSite Lax; chamadas do navegador usam `credentials: include`. A origem local permitida é `http://localhost:5173`.

Login:

```bash
curl -i -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"email":"admin@erplite.local","password":"Admin123!"}' \
  http://localhost:3001/api/auth/login
```

Venda com múltiplos itens:

```bash
curl -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"items":[{"productId":"ID_DO_PRODUTO","quantity":2}]}' \
  http://localhost:3001/api/sales
```

Entrada de estoque:

```bash
curl -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"productId":"ID_DO_PRODUTO","type":"IN","quantity":10,"reason":"Compra recebida"}' \
  http://localhost:3001/api/stock/movements
```

### Rotas disponíveis

- `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`, `GET/POST /users` (admin; senhas com ao menos 12 caracteres).
- `GET/POST /products`, `PATCH/DELETE /products/:id` (escrita restrita a admin; delete é inativação).
- `GET/POST /categories`, `GET/POST /suppliers` (cadastro restrito a admin).
- `GET/POST /stock/movements`; `POST` aceita entrada, saída e ajuste negativo.
- `GET/POST /sales`; `POST` aceita lista de itens, valida estoque e grava tudo atomicamente.
- `GET/POST /accounts`, `PATCH /accounts/:id/pay` (operações financeiras restritas a admin, leitura autenticada).
- `GET /dashboard`, `GET /reports/sales?from=AAAA-MM-DD&to=AAAA-MM-DD`.

Erros seguem `{ "error": { "code", "message", "details?" } }`. `401` indica falta de sessão, `403` falta de perfil e `409` conflito de estoque ou unicidade.

## Regras implementadas

- Não aceita preço/custo ou quantidade negativa; venda exige inteiro positivo e quantidade disponível.
- Atualização condicional do saldo e transação serializável protegem vendas concorrentes. Venda, itens, movimentações e recebível são atômicos.
- Venda captura nome/SKU/preço unitário do item para preservar o histórico se o cadastro mudar; produto não é apagado fisicamente.
- Toda movimentação guarda usuário, instante, tipo, quantidade e justificativa.
- Sessão em cookie HTTP-only, SameSite Lax, duração limitada e Secure em produção; hashes de senha com bcrypt.
- O servidor valida perfil independentemente do estado da interface.

## Testes e limitações conhecidas

`npm test` cobre regras de venda, estoque e autorização. Para a suíte HTTP, crie um schema MySQL isolado; no PowerShell, defina `$env:TEST_DATABASE_URL` e `$env:DATABASE_URL` com a URL desse schema (por exemplo `mysql://erp:erp_dev@localhost:3306/erp_lite_test`), aplique a migration com `npm run db:migrate -w server` e rode `npm run test:integration -w server`. A suíte cria e remove dados próprios e verifica login, permissão administrativa e atomicidade da venda. O seed inclui somente contas fictícias. A implementação não configura envio de e-mail, meios de pagamento ou emissão fiscal; são extensões fora do escopo atual.

## Evidências visuais

As telas da aplicação podem ser capturadas após subir API, banco e frontend em navegador. Não há screenshots versionados nesta entrega: o ambiente de execução disponível não fornece Docker e será necessário iniciar o banco para produzir evidência real, sem confundir mockups com uma aplicação em execução.
