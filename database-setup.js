// database-setup.js - Complete WhatsApp Survey Platform Database Setup
// This script creates all required tables and indexes
// Usage: node database-setup.js
require('dotenv').config();
const { Pool } = require('pg');

// Database connection configuration
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function runDatabaseSetup() {
  console.log('🔧 Starting WhatsApp Survey Platform database setup...\n');
  
  const client = await pool.connect();
  
  try {
    // Test connection first
    await client.query('SELECT NOW()');
    console.log('✅ Database connection successful\n');
    
    // Begin transaction
    await client.query('BEGIN');
    console.log('🔄 Starting database transaction...\n');
    
    // 1. Create surveys table
    console.log('Creating surveys table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS surveys (
        id VARCHAR(50) PRIMARY KEY,
        title VARCHAR(500) NOT NULL CHECK (length(trim(title)) > 0),
        description TEXT DEFAULT '',
        estimated_time VARCHAR(50) DEFAULT '3-5 minutes',
        participant_prefix VARCHAR(20) NOT NULL CHECK (length(trim(participant_prefix)) > 0),
        is_active BOOLEAN DEFAULT FALSE,
        participant_counter INTEGER DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Surveys table created\n');

    // 2. Create participants table
    console.log('Creating participants table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS participants (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR(50) UNIQUE NOT NULL CHECK (length(trim(phone_number)) > 0),
        participant_code VARCHAR(50) UNIQUE NOT NULL CHECK (length(trim(participant_code)) > 0),
        first_survey_id VARCHAR(50) REFERENCES surveys(id),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Participants table created\n');

    // 3. Create questions table
    console.log('Creating questions table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS questions (
        id SERIAL PRIMARY KEY,
        survey_id VARCHAR(50) NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
        question_number INTEGER NOT NULL CHECK (question_number > 0),
        question_type VARCHAR(50) NOT NULL CHECK (question_type IN ('curated', 'multiple', 'likert', 'text')),
        question_text TEXT NOT NULL CHECK (length(trim(question_text)) > 0),
        options JSONB,
        scale JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(survey_id, question_number)
      )
    `);
    console.log('✅ Questions table created\n');

    // 4. Create survey_participants table
    console.log('Creating survey_participants table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS survey_participants (
        id SERIAL PRIMARY KEY,
        survey_id VARCHAR(50) NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
        participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
        participant_survey_code VARCHAR(50) NOT NULL CHECK (length(trim(participant_survey_code)) > 0),
        started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP WITH TIME ZONE,
        is_completed BOOLEAN DEFAULT FALSE,
        completion_duration_seconds INTEGER CHECK (completion_duration_seconds >= 0),
        UNIQUE(survey_id, participant_id),
        UNIQUE(survey_id, participant_survey_code)
      )
    `);
    console.log('✅ Survey_participants table created\n');

    // 5. Create sessions table
    console.log('Creating sessions table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR(50) NOT NULL CHECK (length(trim(phone_number)) > 0),
        survey_id VARCHAR(50) NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
        participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
        current_question INTEGER DEFAULT 0 CHECK (current_question >= 0),
        stage VARCHAR(50) DEFAULT 'initial' CHECK (stage IN ('initial', 'survey', 'followup', 'voice_confirmation', 'completed')),
        session_data JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(phone_number, survey_id)
      )
    `);
    console.log('✅ Sessions table created\n');

    // 6. Create responses table
    console.log('Creating responses table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS responses (
        id SERIAL PRIMARY KEY,
        survey_id VARCHAR(50) NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
        participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
        question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        answer TEXT NOT NULL CHECK (length(trim(answer)) > 0),
        follow_up_comment TEXT,
        voice_metadata JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(survey_id, participant_id, question_id)
      )
    `);
    console.log('✅ Responses table created\n');

    // 7. Create indexes for performance
    console.log('Creating database indexes...');
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_surveys_active ON surveys(is_active) WHERE is_active = true',
      'CREATE INDEX IF NOT EXISTS idx_surveys_created ON surveys(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_questions_survey ON questions(survey_id)',
      'CREATE INDEX IF NOT EXISTS idx_questions_type ON questions(question_type)',
      'CREATE INDEX IF NOT EXISTS idx_participants_phone ON participants(phone_number)',
      'CREATE INDEX IF NOT EXISTS idx_participants_code ON participants(participant_code)',
      'CREATE INDEX IF NOT EXISTS idx_survey_participants_survey ON survey_participants(survey_id)',
      'CREATE INDEX IF NOT EXISTS idx_survey_participants_participant ON survey_participants(participant_id)',
      'CREATE INDEX IF NOT EXISTS idx_survey_participants_completed ON survey_participants(is_completed)',
      'CREATE INDEX IF NOT EXISTS idx_sessions_phone_survey ON sessions(phone_number, survey_id)',
      'CREATE INDEX IF NOT EXISTS idx_sessions_stage ON sessions(stage)',
      'CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at)',
      'CREATE INDEX IF NOT EXISTS idx_responses_survey ON responses(survey_id)',
      'CREATE INDEX IF NOT EXISTS idx_responses_participant ON responses(participant_id)',
      'CREATE INDEX IF NOT EXISTS idx_responses_question ON responses(question_id)',
      'CREATE INDEX IF NOT EXISTS idx_responses_created ON responses(created_at)'
    ];
    
    for (const indexSQL of indexes) {
      await client.query(indexSQL);
    }
    console.log('✅ Database indexes created\n');

    // 8. Create utility functions
    console.log('Creating utility functions...');
    
    // Function to update timestamps
    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ language 'plpgsql'
    `);
    
    // Add trigger for surveys table
    await client.query(`
      DROP TRIGGER IF EXISTS update_surveys_updated_at ON surveys;
      CREATE TRIGGER update_surveys_updated_at
        BEFORE UPDATE ON surveys
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column()
    `);
    
    // Add trigger for sessions table
    await client.query(`
      DROP TRIGGER IF EXISTS update_sessions_updated_at ON sessions;
      CREATE TRIGGER update_sessions_updated_at
        BEFORE UPDATE ON sessions
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column()
    `);
    
    // Function to get next participant code
    await client.query(`
      CREATE OR REPLACE FUNCTION get_next_participant_code(survey_id_param VARCHAR(50))
      RETURNS VARCHAR(50) AS $$
      DECLARE
        prefix VARCHAR(50);
        counter INTEGER;
        new_code VARCHAR(50);
      BEGIN
        -- Get current counter and increment it
        UPDATE surveys 
        SET participant_counter = participant_counter + 1
        WHERE id = survey_id_param
        RETURNING participant_prefix, participant_counter INTO prefix, counter;
        
        -- Generate code with format: PREFIX-0001
        new_code := prefix || '-' || LPAD(counter::TEXT, 4, '0');
        
        RETURN new_code;
      END;
      $$ LANGUAGE plpgsql
    `);
    
    console.log('✅ Utility functions created\n');

    // 9. Create views for analytics
    console.log('Creating analytics views...');
    await client.query(`
      CREATE OR REPLACE VIEW survey_statistics AS
      SELECT 
        s.id,
        s.title,
        s.is_active,
        s.created_at,
        COUNT(DISTINCT sp.participant_id) as total_participants,
        COUNT(DISTINCT CASE WHEN sp.is_completed THEN sp.participant_id END) as completed_participants,
        COUNT(DISTINCT r.id) as total_responses,
        COUNT(DISTINCT q.id) as total_questions,
        CASE 
          WHEN COUNT(DISTINCT sp.participant_id) > 0 
          THEN ROUND(100.0 * COUNT(DISTINCT CASE WHEN sp.is_completed THEN sp.participant_id END) / COUNT(DISTINCT sp.participant_id), 2)
          ELSE 0
        END as completion_rate_percent,
        CASE 
          WHEN COUNT(DISTINCT CASE WHEN sp.is_completed THEN sp.participant_id END) > 0
          THEN ROUND(AVG(sp.completion_duration_seconds) / 60.0, 2)
          ELSE 0
        END as avg_completion_minutes
      FROM surveys s
      LEFT JOIN survey_participants sp ON s.id = sp.survey_id
      LEFT JOIN responses r ON s.id = r.survey_id
      LEFT JOIN questions q ON s.id = q.survey_id
      GROUP BY s.id, s.title, s.is_active, s.created_at
      ORDER BY s.created_at DESC
    `);
    
    await client.query(`
      CREATE OR REPLACE VIEW database_health AS
      SELECT 
        'surveys' as table_name,
        COUNT(*) as total_records,
        COUNT(CASE WHEN is_active THEN 1 END) as active_records,
        'Active surveys' as description
      FROM surveys
      UNION ALL
      SELECT 
        'participants' as table_name,
        COUNT(*) as total_records,
        COUNT(CASE WHEN created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours' THEN 1 END) as recent_records,
        'Recent participants (24h)' as description
      FROM participants
      UNION ALL
      SELECT 
        'sessions' as table_name,
        COUNT(*) as total_records,
        COUNT(CASE WHEN updated_at > CURRENT_TIMESTAMP - INTERVAL '1 hour' THEN 1 END) as active_records,
        'Active sessions (1h)' as description
      FROM sessions
      UNION ALL
      SELECT 
        'responses' as table_name,
        COUNT(*) as total_records,
        COUNT(CASE WHEN created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours' THEN 1 END) as recent_records,
        'Recent responses (24h)' as description
      FROM responses
    `);
    
    console.log('✅ Analytics views created\n');

    // 10. Insert sample data for testing
    console.log('Creating sample survey for testing...');
    await client.query(`
      INSERT INTO surveys (id, title, description, estimated_time, participant_prefix, is_active) 
      VALUES ('sample_001', 'Platform Test Survey', 'Test survey to validate WhatsApp integration', '2-3 minutes', 'TEST', false)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        updated_at = CURRENT_TIMESTAMP
    `);
    
    // Insert sample questions
    const sampleQuestions = [
      {
        number: 1,
        type: 'curated',
        text: 'Do you agree that WhatsApp surveys are convenient?',
        options: '["Agree", "Neutral", "Disagree"]'
      },
      {
        number: 2,
        type: 'multiple',
        text: 'How did you hear about this survey platform?',
        options: '["Social Media", "Word of Mouth", "Online Search", "Other"]'
      },
      {
        number: 3,
        type: 'likert',
        text: 'Rate your overall satisfaction with this platform',
        options: '{"min": 1, "max": 5, "labels": ["Very Dissatisfied", "Very Satisfied"]}'
      },
      {
        number: 4,
        type: 'text',
        text: 'Any additional feedback or suggestions?',
        options: null
      }
    ];
    
    for (const question of sampleQuestions) {
      await client.query(`
        INSERT INTO questions (survey_id, question_number, question_type, question_text, options) 
        VALUES ('sample_001', $1, $2, $3, $4)
        ON CONFLICT (survey_id, question_number) DO UPDATE SET
          question_text = EXCLUDED.question_text,
          options = EXCLUDED.options
      `, [question.number, question.type, question.text, question.options]);
    }
    
    console.log('✅ Sample survey created\n');

    // Commit transaction
    await client.query('COMMIT');
    console.log('✅ Database transaction committed\n');

    // 11. Verify setup
    console.log('Verifying database setup...');
    
    const tablesResult = await client.query(`
      SELECT 
        table_name,
        (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name) as column_count
      FROM information_schema.tables t
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    
    console.log('📊 Database tables created:');
    tablesResult.rows.forEach(row => {
      console.log(`   ✓ ${row.table_name} (${row.column_count} columns)`);
    });
    
    const viewsResult = await client.query(`
      SELECT table_name as view_name
      FROM information_schema.views 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    
    if (viewsResult.rows.length > 0) {
      console.log('\n👁️  Database views created:');
      viewsResult.rows.forEach(row => {
        console.log(`   ✓ ${row.view_name}`);
      });
    }
    
    const indexesResult = await client.query(`
      SELECT indexname, tablename 
      FROM pg_indexes 
      WHERE schemaname = 'public'
      AND indexname LIKE 'idx_%'
      ORDER BY tablename, indexname
    `);
    
    if (indexesResult.rows.length > 0) {
      console.log('\n🔍 Database indexes created:');
      indexesResult.rows.forEach(row => {
        console.log(`   ✓ ${row.tablename}.${row.indexname}`);
      });
    }
    
    console.log('\n🎉 DATABASE SETUP COMPLETED SUCCESSFULLY!');
    console.log('====================================');
    console.log('✅ All tables created with proper constraints');
    console.log('✅ Indexes created for optimal performance');
    console.log('✅ Utility functions and triggers installed');
    console.log('✅ Analytics views ready for reporting');
    console.log('✅ Sample survey created for testing');
    console.log('\nYour WhatsApp Survey Platform database is ready to use!');
    console.log('\nNext steps:');
    console.log('1. Start your application: npm start');
    console.log('2. Access the admin dashboard');
    console.log('3. Connect WhatsApp by scanning the QR code');
    console.log('4. Create and activate your first survey');
    
  } catch (error) {
    // Rollback transaction on error
    await client.query('ROLLBACK');
    console.error('\n❌ Database setup failed:', error);
    console.error('\nError details:', error.message);
    
    console.log('\n🔧 Troubleshooting steps:');
    console.log('1. Check your DATABASE_URL environment variable');
    console.log('2. Ensure PostgreSQL is running and accessible');
    console.log('3. Verify database credentials are correct');
    console.log('4. Check if the database exists and you have permissions');
    
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run setup if this file is executed directly
if (require.main === module) {
  console.log('🚀 WhatsApp Survey Platform - Database Setup');
  console.log('===========================================\n');
  
  runDatabaseSetup()
    .then(() => {
      console.log('\n✨ Setup process completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Setup process failed!');
      console.error('Please check the error details above and try again.');
      process.exit(1);
    });
}

module.exports = { runDatabaseSetup };
