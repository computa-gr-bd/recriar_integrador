require('dotenv').config();

const readline = require('node:readline');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL não foi configurada');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 10000,
  enableChannelBinding: true,
});

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => {
    rl.close();
    resolve(answer.trim());
  }));
}

function askPassword(question) {
  const input = process.stdin;
  const output = process.stdout;
  output.write(question);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');

  return new Promise(resolve => {
    let password = '';
    const onData = character => {
      if (character === '\u0003') process.exit(1);
      if (character === '\r' || character === '\n') {
        input.removeListener('data', onData);
        input.setRawMode(false);
        input.pause();
        output.write('\n');
        resolve(password);
      } else if (character === '\u007f' || character === '\b') {
        password = password.slice(0, -1);
      } else {
        password += character;
      }
    };
    input.on('data', onData);
  });
}

async function createAdmin() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Execute este comando em um terminal interativo.');
  }

  const email = (await ask('E-mail do administrador: ')).toLowerCase();
  const password = await askPassword('Senha (mínimo 12 caracteres; não será exibida): ');
  const confirmation = await askPassword('Confirme a senha: ');
  if (!email || password.length < 12 || password !== confirmation) {
    throw new Error('E-mail inválido, senha curta ou confirmação diferente.');
  }

  await pool.query(
    `INSERT INTO usuarios_dash (nome, email, senha, perfil)
     VALUES ('Administrador', $1, $2, 'admin')`,
    [email, bcrypt.hashSync(password, 10)],
  );
  console.log('Administrador criado.');
}

createAdmin()
  .catch(error => {
    console.error('Não foi possível criar o administrador:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
