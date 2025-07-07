// quick-fix.js
// Emergency database setup script - run this immediately in Render shell
// This creates tables in the correct order without file dependencies

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function quickFix() {
  const client = await pool.connect();
  
  try {
    console.log('🚑 Running quick database fix...\n');
    
    // Execute each table creation in correct order
    const tables = [
      {
        name: 'surveys',
        sql: `CREATE TABLE IF NOT EXISTS surveys (
          id VARCHAR(50) PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          estimated_time VARCHAR(50),
          is_active BOOLEAN DEFAULT FALSE,
          participant_counter INTEGER DEFAULT 0,
          participant_prefix VARCHAR(50),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )`
      },
      {
        name: 'questions',
        sql: `CREATE TABLE IF NOT EXISTS questions (
          id SERIAL PRIMARY KEY,
          survey_id VARCHAR(50) REFERENCES surveys(id) ON DELETE CASCADE,
          question_number INTEGER NOT NULL,
          question_type VARCHAR(20) NOT NULL CHECK (question_type IN ('curated', 'multiple', 'likert', 'text')),
          question_text TEXT NOT NULL,
          options JSONB,
          scale JSONB,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )`
      },
      {
        name: 'participants',
        sql: `CREATE TABLE IF NOT EXISTS participants (
          id SERIAL PRIMARY KEY,
          phone_number VARCHAR(50) UNIQUE NOT NULL,
          participant_code VARCHAR(50) NOT NULL,
          first_survey_id VARCHAR(50) REFERENCES surveys(id),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )`
      },
      {
        name: 'survey_participants',
        sql: `CREATE TABLE IF NOT EXISTS survey_participants (
          id SERIAL PRIMARY KEY,
          survey_id VARCHAR(50) REFERENCES surveys(id) ON DELETE CASCADE,
          participant_id INTEGER REFERENCES participants(id) ON DELETE CASCADE,
          participant_survey_code VARCHAR(50) NOT NULL,
          started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          completed_at TIMESTAMP WITH TIME ZONE,
          completion_duration_seconds INTEGER,
          is_completed BOOLEAN DEFAULT FALSE,
          UNIQUE(survey_id, participant_id)
        )`
      },
      {
        name: 'responses',
        sql: `CREATE TABLE IF NOT EXISTS responses (
          id SERIAL PRIMARY KEY,
          survey_id VARCHAR(50) REFERENCES surveys(id) ON DELETE CASCADE,
          participant_id INTEGER REFERENCES participants(id) ON DELETE CASCADE,
          question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
          answer TEXT NOT NULL,
          follow_up_comment TEXT,
          voice_metadata JSONB,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )`
      },
      {
        name: 'sessions',
        sql: `CREATE TABLE IF NOT EXISTS sessions (
          id SERIAL PRIMARY KEY,
          phone_number VARCHAR(50) NOT NULL,
          survey_id VARCHAR(50) REFERENCES surveys(id) ON DELETE CASCADE,
          participant_id INTEGER REFERENCES participants(id) ON DELETE CASCADE,
          current_question INTEGER DEFAULT 0,
          stage VARCHAR(50) DEFAULT 'initial',
          session_data JSONB,
          started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )`
      }
    ];
    
    // Create tables
    for (const table of tables) {
      try {
        await client.query(table.sql);
        console.log(`✅ Table '${table.name}' created or verified`);
      } catch (err) {
        if (err.code === '42P07') {
          console.log(`✓ Table '${table.name}' already exists`);
        } else {
          throw err;
        }
      }
    }
    
    // Create indexes
    console.log('\n📇 Creating indexes...');
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_surveys_active ON surveys(is_active)',
      'CREATE INDEX IF NOT EXISTS idx_responses_survey ON responses(survey_id)',
      'CREATE INDEX IF NOT EXISTS idx_responses_participant ON responses(participant_id)',
      'CREATE INDEX IF NOT EXISTS idx_survey_participants_survey ON survey_participants(survey_id)',
      'CREATE INDEX IF NOT EXISTS idx_survey_participants_completed ON survey_participants(is_completed)',
      'CREATE INDEX IF NOT EXISTS idx_sessions_phone ON sessions(phone_number)'
    ];
    
    for (const index of indexes) {
      await client.query(index);
    }
    console.log('✅ Indexes created');
    
    // Create function for participant codes
    console.log('\n🔧 Creating functions...');
    await client.query(`
      CREATE OR REPLACE FUNCTION get_next_participant_code(survey_id_param VARCHAR(50))
      RETURNS VARCHAR(50) AS $$
      DECLARE
          prefix VARCHAR(50);
          counter INTEGER;
          new_code VARCHAR(50);
      BEGIN
          UPDATE surveys 
          SET participant_counter = participant_counter + 1
          WHERE id = survey_id_param
          RETURNING participant_prefix, participant_counter INTO prefix, counter;
          
          new_code := prefix || '-' || LPAD(counter::TEXT, 4, '0');
          
          RETURN new_code;
      END;
      $$ LANGUAGE plpgsql;
    `);
    console.log('✅ Functions created');
    
    // Create view
    console.log('\n👁️  Creating views...');
    await client.query(`
      CREATE OR REPLACE VIEW survey_statistics AS
      SELECT 
          s.id,
          s.title,
          s.is_active,
          COUNT(DISTINCT sp.participant_id) as total_participants,
          COUNT(DISTINCT CASE WHEN sp.is_completed THEN sp.participant_id END) as completed_participants,
          COUNT(DISTINCT r.id) as total_responses,
          CASE 
              WHEN COUNT(DISTINCT sp.participant_id) > 0 
              THEN ROUND(100.0 * COUNT(DISTINCT CASE WHEN sp.is_completed THEN sp.participant_id END) / COUNT(DISTINCT sp.participant_id), 2)
              ELSE 0
          END as completion_rate,
          AVG(sp.completion_duration_seconds) as avg_completion_seconds
      FROM surveys s
      LEFT JOIN survey_participants sp ON s.id = sp.survey_id
      LEFT JOIN responses r ON s.id = r.survey_id
      GROUP BY s.id, s.title, s.is_active;
    `);
    console.log('✅ Views created');
    
    // Verify everything
    console.log('\n✨ Verifying database structure...');
    const verification = await client.query(`
      SELECT table_name, table_type
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);
    
    console.log('\n📊 Database objects:');
    verification.rows.forEach(row => {
      console.log(`   ✓ ${row.table_name} (${row.table_type})`);
    });
    
    console.log('\n🎉 Database setup completed successfully!');
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run immediately
quickFix().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
