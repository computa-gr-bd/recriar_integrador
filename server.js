require('dotenv').config();

const path = require('node:path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const PgSession = require('connect-pg-simple')(session);

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL não foi configurada');
}

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET não foi configurada');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 10000,
  enableChannelBinding: true,
});

pool.on('error', error => console.error('Erro inesperado no pool PostgreSQL:', error));

const PERMS = {
  admin: ['*'],
  gerente: ['agenda', 'clientes', 'prof', 'horarios', 'msgs'],
  atendente: ['agenda', 'clientes', 'msgs'],
};

const can = (user, permission) =>
  user && (PERMS[user.perfil]?.includes('*') || PERMS[user.perfil]?.includes(permission));

const need = permission => (req, res, next) =>
  can(req.session.staff, permission)
    ? next()
    : res.status(403).json({ erro: 'Sem permissão' });

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  store: new PgSession({ pool, tableName: 'user_sessions' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  },
}));
app.use(express.static(path.join(__dirname, 'public')));

const httpError = (status, message) => Object.assign(new Error(message), { status });
const isValidHour = hour => typeof hour === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(hour);

const A = handler => async (req, res) => {
  try {
    const result = await handler(req, res);
    res.json(result?.command ? { ok: 1 } : result ?? { ok: 1 });
  } catch (error) {
    if (error.code === '23505') {
      const message = error.constraint === 'agendamentos_slot_ativo_idx'
        ? 'Horário já ocupado'
        : 'Registro já cadastrado';
      return res.status(409).json({ erro: message });
    }

    if (error.status) {
      return res.status(error.status).json({ erro: error.message });
    }

    console.error('Erro ao processar requisição:', error);
    return res.status(500).json({ erro: 'Erro interno do servidor' });
  }
};

const rows = async (text, values) => (await pool.query(text, values)).rows;
const one = async (text, values) => (await pool.query(text, values)).rows[0];

// ---------- público ----------
app.get('/api/profissionais', A(() =>
  rows('SELECT id, nome, especialidade FROM profissionais WHERE ativo = 1')));

app.get('/api/slots', A(async req => {
  const { prof, data } = req.query;
  const ocupados = await rows(
    "SELECT hora FROM agendamentos WHERE prof_id = $1 AND data = $2 AND status <> 'cancelado'",
    [prof, data],
  );
  const horarios = await rows('SELECT hora FROM horarios ORDER BY hora');
  const usados = new Set(ocupados.map(row => row.hora));
  return horarios.map(row => row.hora).filter(hora => !usados.has(hora));
}));

app.post('/api/register', A(async (req, res) => {
  const { nome, email, telefone, senha } = req.body;
  if (!nome || !email || !senha || senha.length < 6) {
    throw httpError(400, 'Preencha tudo (senha mín. 6)');
  }

  const cliente = await one(
    'INSERT INTO clientes (nome, email, telefone, senha) VALUES ($1, $2, $3, $4) RETURNING id, nome',
    [nome, email.toLowerCase(), telefone, bcrypt.hashSync(senha, 10)],
  );
  req.session.cli = { id: cliente.id, nome: cliente.nome };
  return { nome: cliente.nome };
}));

app.post('/api/login', A(async req => {
  const cliente = await one('SELECT * FROM clientes WHERE email = $1', [
    (req.body.email || '').toLowerCase(),
  ]);
  if (!cliente || !bcrypt.compareSync(req.body.senha || '', cliente.senha)) {
    throw httpError(400, 'E-mail ou senha inválidos');
  }
  req.session.cli = { id: cliente.id, nome: cliente.nome };
  return { nome: cliente.nome };
}));

app.get('/api/me', A(req => req.session.cli || {}));
app.post('/api/logout', A(req => { req.session.cli = null; }));

app.post('/api/contato', A(async req => {
  const { nome, email, telefone, texto } = req.body;
  await pool.query(
    'INSERT INTO mensagens (nome, email, telefone, texto) VALUES ($1, $2, $3, $4)',
    [nome, email, telefone, texto],
  );
}));

app.post('/api/agendar', A(async req => {
  if (!req.session.cli) throw httpError(400, 'Faça login para agendar');
  const { prof_id, modalidade, data, hora } = req.body;
  if (!isValidHour(hora)) throw httpError(400, 'Horário inválido');
  await pool.query(
    `INSERT INTO agendamentos (cliente_id, prof_id, modalidade, data, hora)
     VALUES ($1, $2, $3, $4, $5)`,
    [req.session.cli.id, prof_id, modalidade, data, hora],
  );
}));

app.get('/api/meus', A(req => rows(
  `SELECT a.*, p.nome AS prof
   FROM agendamentos a
   JOIN profissionais p ON p.id = a.prof_id
   WHERE a.cliente_id = $1
   ORDER BY a.data DESC`,
  [req.session.cli?.id],
)));

// ---------- dashboard ----------
app.post('/api/admin/login', A(async req => {
  const usuario = await one('SELECT * FROM usuarios_dash WHERE email = $1', [
    (req.body.email || '').toLowerCase(),
  ]);
  if (!usuario || !bcrypt.compareSync(req.body.senha || '', usuario.senha)) {
    throw httpError(400, 'Credenciais inválidas');
  }
  req.session.staff = {
    id: usuario.id,
    nome: usuario.nome,
    perfil: usuario.perfil,
  };
  return req.session.staff;
}));

app.get('/api/admin/me', (req, res) => req.session.staff
  ? res.json({ ...req.session.staff, perms: PERMS[req.session.staff.perfil] })
  : res.status(401).json({}));

app.post('/api/admin/logout', A(req => { req.session.staff = null; }));

app.get('/api/admin/stats', need('agenda'), A(async () => {
  const [clientes, hoje, pend] = await Promise.all([
    one('SELECT COUNT(*)::int AS n FROM clientes'),
    one('SELECT COUNT(*)::int AS n FROM agendamentos WHERE data = CURRENT_DATE'),
    one("SELECT COUNT(*)::int AS n FROM agendamentos WHERE status = 'pendente'"),
  ]);
  return { clientes: clientes.n, hoje: hoje.n, pend: pend.n };
}));

app.get('/api/admin/charts', need('agenda'), A(async () => {
  const [dia, status, prof, total, online, prox] = await Promise.all([
    rows(
      `SELECT data AS d, COUNT(*)::int AS n FROM agendamentos
       WHERE data BETWEEN CURRENT_DATE - 6 AND CURRENT_DATE + 7
         AND status <> 'cancelado'
       GROUP BY data`,
    ),
    rows('SELECT status AS s, COUNT(*)::int AS n FROM agendamentos GROUP BY status'),
    rows(
      `SELECT p.nome AS n, COUNT(a.id)::int AS c
       FROM profissionais p LEFT JOIN agendamentos a ON a.prof_id = p.id
       GROUP BY p.id`,
    ),
    one('SELECT COUNT(*)::int AS n FROM agendamentos'),
    one("SELECT COUNT(*)::int AS n FROM agendamentos WHERE modalidade = 'Online'"),
    rows(
      `SELECT a.data, a.hora, c.nome AS cliente, p.nome AS prof, a.status
       FROM agendamentos a
       JOIN clientes c ON c.id = a.cliente_id
       JOIN profissionais p ON p.id = a.prof_id
       WHERE a.data >= CURRENT_DATE AND a.status <> 'cancelado'
       ORDER BY a.data, a.hora LIMIT 6`,
    ),
  ]);
  return { dia, status, prof, total: total.n, online: online.n, prox };
}));

app.get('/api/admin/agenda', need('agenda'), A(() => rows(
  `SELECT a.*, c.nome AS cliente, c.telefone, p.nome AS prof
   FROM agendamentos a
   JOIN clientes c ON c.id = a.cliente_id
   JOIN profissionais p ON p.id = a.prof_id
   ORDER BY a.data DESC, a.hora`,
)));

app.patch('/api/admin/agenda/:id', need('agenda'), A(req =>
  pool.query('UPDATE agendamentos SET status = $1 WHERE id = $2', [
    req.body.status,
    req.params.id,
  ])));

app.get('/api/admin/clientes', need('clientes'), A(() =>
  rows('SELECT id, nome, email, telefone, criado FROM clientes ORDER BY nome')));

app.delete('/api/admin/clientes/:id', need('clientes'), A(req =>
  pool.query('DELETE FROM clientes WHERE id = $1', [req.params.id])));

app.get('/api/admin/prof', need('prof'), A(() =>
  rows('SELECT * FROM profissionais')));

app.post('/api/admin/prof', need('prof'), A(req =>
  pool.query(
    'INSERT INTO profissionais (nome, especialidade) VALUES ($1, $2)',
    [req.body.nome, req.body.especialidade],
  )));

app.patch('/api/admin/prof/:id', need('prof'), A(req =>
  pool.query('UPDATE profissionais SET ativo = $1 WHERE id = $2', [
    req.body.ativo,
    req.params.id,
  ])));

app.get('/api/admin/horarios', need('horarios'), A(() =>
  rows('SELECT * FROM horarios ORDER BY hora')));

app.post('/api/admin/horarios', need('horarios'), A(req => {
  if (!isValidHour(req.body.hora)) throw httpError(400, 'Horário inválido');
  return pool.query('INSERT INTO horarios (hora) VALUES ($1)', [req.body.hora]);
}));

app.delete('/api/admin/horarios/:id', need('horarios'), A(req =>
  pool.query('DELETE FROM horarios WHERE id = $1', [req.params.id])));

app.get('/api/admin/msgs', need('msgs'), A(() =>
  rows('SELECT * FROM mensagens ORDER BY id DESC')));

// só admin gerencia usuários do dashboard
app.get('/api/admin/usuarios', need('*'), A(() =>
  rows('SELECT id, nome, email, perfil FROM usuarios_dash')));

app.post('/api/admin/usuarios', need('*'), A(async req => {
  const { nome, email, senha, perfil } = req.body;
  if (!PERMS[perfil] || senha?.length < 6) {
    throw httpError(400, 'Dados inválidos');
  }
  await pool.query(
    'INSERT INTO usuarios_dash (nome, email, senha, perfil) VALUES ($1, $2, $3, $4)',
    [nome, email.toLowerCase(), bcrypt.hashSync(senha, 10), perfil],
  );
}));

app.delete('/api/admin/usuarios/:id', need('*'), A(async req => {
  if (+req.params.id === req.session.staff.id) {
    throw httpError(400, 'Não pode excluir a si mesmo');
  }
  await pool.query('DELETE FROM usuarios_dash WHERE id = $1', [req.params.id]);
}));

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Site: http://localhost:${port}  |  Dashboard: http://localhost:${port}/admin.html`));
}

module.exports = app;
