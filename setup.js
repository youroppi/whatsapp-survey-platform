// setup.js - Simple database setup that works in Render shell
// This script creates tables one by one with clear progress

const { Client } = require('pg');

async function setup() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('Connected to database\n');

    // Create each table separately
    console.log('Creating questions table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS questions (
        id SERIAL PRIMARY KEY,
        survey_id VARCHAR(50) REFERENCES surveys(id) ON DELETE CASCADE,
        question_number INTEGER NOT NULL,
        question_type VARCHAR(20) NOT NULL,
        question_text TEXT NOT NULL,
        options JSONB,
        scale JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✓ questions created\n');

    console.log('Creating participants table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS participants (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR(50) UNIQUE NOT NULL,
        participant_code VARCHAR(50) NOT NULL,
        first_survey_id VARCHAR(50) REFERENCES surveys(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✓ participants created\n');

    console.log('Creating survey_participants table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS survey_participants (
        id SERIAL PRIMARY KEY,
        survey_id VARCHAR(50) REFERENCES surveys(id) ON DELETE CASCADE,
        participant_id INTEGER REFERENCES participants(id) ON DELETE CASCADE,
        participant_survey_code VARCHAR(50) NOT NULL,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        completion_duration_seconds INTEGER,
        is_completed BOOLEAN DEFAULT FALSE,
        UNIQUE(survey_id, participant_id)
      )
    `);
    console.log('✓ survey_participants created\n');

    console.log('Creating responses table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS responses (
        id SERIAL PRIMARY KEY,
        survey_id VARCHAR(50) REFERENCES surveys(id) ON DELETE CASCADE,
        participant_id INTEGER REFERENCES participants(id) ON DELETE CASCADE,
        question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
        answer TEXT NOT NULL,
        follow_up_comment TEXT,
        voice_metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✓ responses created\n');

    console.log('Creating sessions table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR(50) NOT NULL,
        survey_id VARCHAR(50) REFERENCES surveys(id) ON DELETE CASCADE,
        participant_id INTEGER REFERENCES participants(id) ON DELETE CASCADE,
        current_question INTEGER DEFAULT 0,
        stage VARCHAR(50) DEFAULT 'initial',
        session_data JSONB,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✓ sessions created\n');

    console.log('Creating indexes...');
    await client.query('CREATE INDEX IF NOT EXISTS idx_surveys_active ON surveys(is_active)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_responses_survey ON responses(survey_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_sessions_phone ON sessions(phone_number)');
    console.log('✓ indexes created\n');

    console.log('Creating participant code function...');
    await client.query(`
      CREATE OR REPLACE FUNCTION get_next_participant_code(survey_id_param VARCHAR(50))
      RETURNS VARCHAR(50) AS $$
      DECLARE
        prefix VARCHAR(50);
        counter INTEGER;
      BEGIN
        UPDATE surveys 
        SET participant_counter = participant_counter + 1
        WHERE id = survey_id_param
        RETURNING participant_prefix, participant_counter INTO prefix, counter;
        RETURN prefix || '-' || LPAD(counter::TEXT, 4, '0');
      END;
      $$ LANGUAGE plpgsql
    `);
    console.log('✓ function created\n');

    console.log('Creating view...');
    await client.query(`
      CREATE OR REPLACE VIEW survey_statistics AS
      SELECT 
        s.id,
        s.title,
        s.is_active,
        COUNT(DISTINCT sp.participant_id)::INTEGER as total_participants,
        COUNT(DISTINCT CASE WHEN sp.is_completed THEN sp.participant_id END)::INTEGER as completed_participants,
        COUNT(DISTINCT r.id)::INTEGER as total_responses,
        CASE 
          WHEN COUNT(DISTINCT sp.participant_id) > 0 
          THEN ROUND(100.0 * COUNT(DISTINCT CASE WHEN sp.is_completed THEN sp.participant_id END) / COUNT(DISTINCT sp.participant_id), 2)
          ELSE 0
        END as completion_rate,
        COALESCE(AVG(sp.completion_duration_seconds), 0)::INTEGER as avg_completion_seconds
      FROM surveys s
      LEFT JOIN survey_participants sp ON s.id = sp.survey_id
      LEFT JOIN responses r ON s.id = r.survey_id
      GROUP BY s.id, s.title, s.is_active
    `);
    console.log('✓ view created\n');

    // Show final state
    const tables = await client.query(`
      SELECT table_name, table_type 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_type, table_name
    `);

    console.log('Database setup complete!\n');
    console.log('Objects created:');
    tables.rows.forEach(t => console.log(`  ${t.table_type}: ${t.table_name}`));

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await client.end();
  }
}

setup();
