# Clínica RecriarMentes

## Configuração local

1. Instale as dependências com `npm install`.
2. Copie `.env.example` para `.env` e preencha `DATABASE_URL` e `SESSION_SECRET`.
3. Crie as tabelas e os horários iniciais com `npm run db:migrate`.
4. Crie o primeiro usuário administrador com `npm run admin:create`. A senha é digitada sem aparecer no terminal.
5. Inicie o app com `npm start`.

- Site: http://localhost:3000
- Dashboard: http://localhost:3000/admin.html

## Banco e deploy

O PostgreSQL do Neon é compartilhado pelo site, dashboard e sessões. A migração cria, sem apagar dados, as tabelas `clientes`, `usuarios_dash`, `profissionais`, `horarios`, `agendamentos`, `mensagens` e `user_sessions`, além dos horários iniciais. Ela pode ser executada novamente com segurança.

No Vercel, configure `DATABASE_URL` e `SESSION_SECRET` como variáveis de ambiente em cada ambiente necessário. Gere um segredo de sessão longo e aleatório; nunca publique `.env`. Antes do primeiro deploy, rode `npm run db:migrate` localmente contra o banco de destino e crie o administrador com `npm run admin:create`.

Perfis: admin (tudo + cria usuários) · gerente (agenda, clientes, profissionais, horários, mensagens) · atendente (agenda, clientes, mensagens).
