require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
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

async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(schema);
    await client.query('COMMIT');
    console.log('Schema PostgreSQL aplicado com sucesso.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

migrate()
  .catch(error => {
    const causes = Array.isArray(error.errors)
      ? error.errors.map(cause => [cause.code, cause.message].filter(Boolean).join(': '))
      : [];
    const details = [error.code, error.message, ...causes].filter(Boolean).join('; ');
    console.error('Falha ao aplicar schema PostgreSQL:', details || error.name || 'Erro desconhecido');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
