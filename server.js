const express=require('express'),session=require('express-session'),bcrypt=require('bcryptjs'),Db=require('better-sqlite3');
const db=new Db('clinica.db');db.pragma('foreign_keys=ON');
db.exec(`
CREATE TABLE IF NOT EXISTS clientes(id INTEGER PRIMARY KEY,nome,email UNIQUE,telefone,senha,criado DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS usuarios_dash(id INTEGER PRIMARY KEY,nome,email UNIQUE,senha,perfil,criado DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS profissionais(id INTEGER PRIMARY KEY,nome,especialidade,ativo INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS horarios(id INTEGER PRIMARY KEY,hora UNIQUE);
CREATE TABLE IF NOT EXISTS agendamentos(id INTEGER PRIMARY KEY,cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE,prof_id INTEGER REFERENCES profissionais(id),modalidade,data,hora,status DEFAULT 'pendente',criado DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS mensagens(id INTEGER PRIMARY KEY,nome,email,telefone,texto,criado DEFAULT CURRENT_TIMESTAMP);`);
if(!db.prepare('SELECT 1 FROM usuarios_dash').get()){
 db.prepare('INSERT INTO usuarios_dash(nome,email,senha,perfil) VALUES(?,?,?,?)').run('Administrador','admin@recriarmentes.com.br',bcrypt.hashSync('admin123',10),'admin');
 ['08:00','09:00','10:00','11:00','14:00','15:00','16:00','17:00','18:00'].forEach(h=>db.prepare('INSERT INTO horarios(hora) VALUES(?)').run(h));
 console.log('Admin criado: admin@recriarmentes.com.br / admin123 (TROQUE A SENHA)');}
// perfis: admin = tudo | gerente = agenda, clientes, profissionais, horarios, mensagens | atendente = agenda, clientes, mensagens
const PERMS={admin:['*'],gerente:['agenda','clientes','prof','horarios','msgs'],atendente:['agenda','clientes','msgs']};
const can=(u,p)=>u&&(PERMS[u.perfil].includes('*')||PERMS[u.perfil].includes(p));
const need=p=>(q,s,n)=>can(q.session.staff,p)?n():s.status(403).json({erro:'Sem permissão'});
const app=express();app.use(express.json());
app.use(session({secret:process.env.SECRET||'troque-este-segredo',resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax'}}));
app.use(express.static('public'));
const A=(f)=>(q,s)=>{try{s.json(f(q,s)??{ok:1})}catch(e){s.status(400).json({erro:e.message.includes('UNIQUE')?'E-mail já cadastrado':e.message})}};
// ---------- público ----------
app.get('/api/profissionais',A(()=>db.prepare('SELECT id,nome,especialidade FROM profissionais WHERE ativo=1').all()));
app.get('/api/slots',A(q=>{const{prof,data}=q.query;const u=db.prepare("SELECT hora FROM agendamentos WHERE prof_id=? AND data=? AND status!='cancelado'").all(prof,data).map(x=>x.hora);
 return db.prepare('SELECT hora FROM horarios ORDER BY hora').all().map(x=>x.hora).filter(h=>!u.includes(h))}));
app.post('/api/register',A((q,s)=>{const{nome,email,telefone,senha}=q.body;if(!nome||!email||!senha||senha.length<6)throw Error('Preencha tudo (senha mín. 6)');
 const r=db.prepare('INSERT INTO clientes(nome,email,telefone,senha) VALUES(?,?,?,?)').run(nome,email.toLowerCase(),telefone,bcrypt.hashSync(senha,10));
 q.session.cli={id:r.lastInsertRowid,nome};return{nome}}));
app.post('/api/login',A((q)=>{const c=db.prepare('SELECT * FROM clientes WHERE email=?').get((q.body.email||'').toLowerCase());
 if(!c||!bcrypt.compareSync(q.body.senha||'',c.senha))throw Error('E-mail ou senha inválidos');q.session.cli={id:c.id,nome:c.nome};return{nome:c.nome}}));
app.get('/api/me',A(q=>q.session.cli||{}));
app.post('/api/logout',A(q=>{q.session.cli=null}));
app.post('/api/contato',A(q=>{const{nome,email,telefone,texto}=q.body;db.prepare('INSERT INTO mensagens(nome,email,telefone,texto) VALUES(?,?,?,?)').run(nome,email,telefone,texto)}));
app.post('/api/agendar',A(q=>{if(!q.session.cli)throw Error('Faça login para agendar');const{prof_id,modalidade,data,hora}=q.body;
 if(db.prepare("SELECT 1 FROM agendamentos WHERE prof_id=? AND data=? AND hora=? AND status!='cancelado'").get(prof_id,data,hora))throw Error('Horário já ocupado');
 db.prepare('INSERT INTO agendamentos(cliente_id,prof_id,modalidade,data,hora) VALUES(?,?,?,?,?)').run(q.session.cli.id,prof_id,modalidade,data,hora)}));
app.get('/api/meus',A(q=>db.prepare('SELECT a.*,p.nome prof FROM agendamentos a JOIN profissionais p ON p.id=prof_id WHERE cliente_id=? ORDER BY data DESC').all(q.session.cli?.id)));
// ---------- dashboard ----------
app.post('/api/admin/login',A(q=>{const u=db.prepare('SELECT * FROM usuarios_dash WHERE email=?').get((q.body.email||'').toLowerCase());
 if(!u||!bcrypt.compareSync(q.body.senha||'',u.senha))throw Error('Credenciais inválidas');q.session.staff={id:u.id,nome:u.nome,perfil:u.perfil};return q.session.staff}));
app.get('/api/admin/me',(q,s)=>q.session.staff?s.json({...q.session.staff,perms:PERMS[q.session.staff.perfil]}):s.status(401).json({}));
app.post('/api/admin/logout',A(q=>{q.session.staff=null}));
app.get('/api/admin/stats',need('agenda'),A(()=>({clientes:db.prepare('SELECT COUNT(*) n FROM clientes').get().n,hoje:db.prepare("SELECT COUNT(*) n FROM agendamentos WHERE data=date('now')").get().n,pend:db.prepare("SELECT COUNT(*) n FROM agendamentos WHERE status='pendente'").get().n})));
app.get('/api/admin/charts',need('agenda'),A(()=>({
 dia:db.prepare("SELECT data d,COUNT(*) n FROM agendamentos WHERE data BETWEEN date('now','-6 days') AND date('now','+7 days') AND status!='cancelado' GROUP BY data").all(),
 status:db.prepare('SELECT status s,COUNT(*) n FROM agendamentos GROUP BY status').all(),
 prof:db.prepare('SELECT p.nome n,COUNT(a.id) c FROM profissionais p LEFT JOIN agendamentos a ON a.prof_id=p.id GROUP BY p.id').all(),
 total:db.prepare('SELECT COUNT(*) n FROM agendamentos').get().n,
 online:db.prepare("SELECT COUNT(*) n FROM agendamentos WHERE modalidade='Online'").get().n,
 prox:db.prepare("SELECT a.data,a.hora,c.nome cliente,p.nome prof,a.status FROM agendamentos a JOIN clientes c ON c.id=cliente_id JOIN profissionais p ON p.id=prof_id WHERE data>=date('now') AND status!='cancelado' ORDER BY data,hora LIMIT 6").all()})));
app.get('/api/admin/agenda',need('agenda'),A(()=>db.prepare('SELECT a.*,c.nome cliente,c.telefone,p.nome prof FROM agendamentos a JOIN clientes c ON c.id=cliente_id JOIN profissionais p ON p.id=prof_id ORDER BY data DESC,hora').all()));
app.patch('/api/admin/agenda/:id',need('agenda'),A(q=>db.prepare('UPDATE agendamentos SET status=? WHERE id=?').run(q.body.status,q.params.id)));
app.get('/api/admin/clientes',need('clientes'),A(()=>db.prepare('SELECT id,nome,email,telefone,criado FROM clientes ORDER BY nome').all()));
app.delete('/api/admin/clientes/:id',need('clientes'),A(q=>db.prepare('DELETE FROM clientes WHERE id=?').run(q.params.id)));
app.get('/api/admin/prof',need('prof'),A(()=>db.prepare('SELECT * FROM profissionais').all()));
app.post('/api/admin/prof',need('prof'),A(q=>db.prepare('INSERT INTO profissionais(nome,especialidade) VALUES(?,?)').run(q.body.nome,q.body.especialidade)));
app.patch('/api/admin/prof/:id',need('prof'),A(q=>db.prepare('UPDATE profissionais SET ativo=? WHERE id=?').run(q.body.ativo,q.params.id)));
app.get('/api/admin/horarios',need('horarios'),A(()=>db.prepare('SELECT * FROM horarios ORDER BY hora').all()));
app.post('/api/admin/horarios',need('horarios'),A(q=>db.prepare('INSERT INTO horarios(hora) VALUES(?)').run(q.body.hora)));
app.delete('/api/admin/horarios/:id',need('horarios'),A(q=>db.prepare('DELETE FROM horarios WHERE id=?').run(q.params.id)));
app.get('/api/admin/msgs',need('msgs'),A(()=>db.prepare('SELECT * FROM mensagens ORDER BY id DESC').all()));
// só admin gerencia usuários do dashboard
app.get('/api/admin/usuarios',need('*'),A(()=>db.prepare('SELECT id,nome,email,perfil FROM usuarios_dash').all()));
app.post('/api/admin/usuarios',need('*'),A(q=>{const{nome,email,senha,perfil}=q.body;if(!PERMS[perfil]||senha?.length<6)throw Error('Dados inválidos');
 db.prepare('INSERT INTO usuarios_dash(nome,email,senha,perfil) VALUES(?,?,?,?)').run(nome,email.toLowerCase(),bcrypt.hashSync(senha,10),perfil)}));
app.delete('/api/admin/usuarios/:id',need('*'),A(q=>{if(+q.params.id===q.session.staff.id)throw Error('Não pode excluir a si mesmo');db.prepare('DELETE FROM usuarios_dash WHERE id=?').run(q.params.id)}));
app.listen(3000,()=>console.log('Site: http://localhost:3000  |  Dashboard: http://localhost:3000/admin.html'));
