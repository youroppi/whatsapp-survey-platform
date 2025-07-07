// render-setup.js - Optimized for Render.com deployment
// This script is designed to work specifically in Render's environment
// Usage: node render-setup.js (run this in Render Shell)

const { Client } = require('pg');

async function renderSetup() {
  console.log('🚀 Setting up WhatsApp Survey Platform for Render.com...\n');
  
  // Render provides DATABASE_URL automatically
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL not found. Make sure you\'re running this on Render.');
    process.exit(1);
  }
  
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for Render PostgreSQL
  });
  
  try {
    await client.connect();
    console.log('✅ Connected to Render PostgreSQL database\n');
    
    // Execute setup in order (avoiding foreign key issues)
    const setupSteps = [
      {
        name: 'surveys',
        sql: `
          CREATE TABLE IF NOT EXISTS surveys (
            id VARCHAR(50) PRIMARY KEY,
            title VARCHAR(500) NOT NULL,
            description TEXT DEFAULT '',
            estimated_time VARCHAR(50) DEFAULT '3-5 minutes',
            participant_prefix VARCHAR(20) NOT NULL,
            is_active BOOLEAN DEFAULT FALSE,
            participant_counter INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `
      },
      {
        name: 'participants',
        sql: `
          CREATE TABLE IF NOT EXISTS participants (
            id SERIAL PRIMARY KEY,
            phone_number VARCHAR(50) UNIQUE NOT NULL,
            participant_code VARCHAR(50) UNIQUE NOT NULL,
            first_survey_id VARCHAR(50),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `
      },
      {
        name: 'questions',
        sql: `
          CREATE TABLE IF NOT EXISTS questions (
            id SERIAL PRIMARY KEY,
            survey_id VARCHAR(50) NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
            question_number INTEGER NOT NULL,
            question_type VARCHAR(50) NOT NULL,
            question_text TEXT NOT NULL,
            options JSONB,
            scale JSONB,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(survey_id, question_number)
          )
        `
      },
      {
        name: 'survey_participants',
        sql: `
          CREATE TABLE IF NOT EXISTS survey_participants (
            id SERIAL PRIMARY KEY,
            survey_id VARCHAR(50) NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
            participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
            participant_survey_code VARCHAR(50) NOT NULL,
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMP,
            is_completed BOOLEAN DEFAULT FALSE,
            completion_duration_seconds INTEGER,
            UNIQUE(survey_id, participant_id)
          )
        `
      },
      {
        name: 'sessions',
        sql: `
          CREATE TABLE IF NOT EXISTS sessions (
            id SERIAL PRIMARY KEY,
            phone_number VARCHAR(50) NOT NULL,
            survey_id VARCHAR(50) NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
            participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
            current_question INTEGER DEFAULT 0,
            stage VARCHAR(50) DEFAULT 'initial',
            session_data JSONB DEFAULT '{}',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `
      },
      {
        name: 'responses',
        sql: `
          CREATE TABLE IF NOT EXISTS responses (
            id SERIAL PRIMARY KEY,
            survey_id VARCHAR(50) NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
            participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
            question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
            answer TEXT NOT NULL,
            follow_up_comment TEXT,
            voice_metadata JSONB,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `
      }
    ];
    
    // Create tables
    for (const step of setupSteps) {
      console.log(`Creating ${step.name} table...`);
      await client.query(step.sql);
      console.log(`✅ ${step.name} table ready`);
    }
    
    console.log('\n📈 Creating indexes...');
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_surveys_active ON surveys(is_active)',
      'CREATE INDEX IF NOT EXISTS idx_sessions_phone_survey ON sessions(phone_number, survey_id)',
      'CREATE INDEX IF NOT EXISTS idx_responses_survey ON responses(survey_id)',
      'CREATE INDEX IF NOT EXISTS idx_participants_phone ON participants(phone_number)'
    ];
    
    for (const indexSQL of indexes) {
      await client.query(indexSQL);
    }
    console.log('✅ Indexes created');
    
    // Create sample survey
    console.log('\n🧪 Creating test survey...');
    await client.query(`
      INSERT INTO surveys (id, title, participant_prefix, is_active) 
      VALUES ('welcome_001', 'Welcome Survey', 'WELCOME', false)
      ON CONFLICT (id) DO NOTHING
    `);
    
    await client.query(`
      INSERT INTO questions (survey_id, question_number, question_type, question_text, options) 
      VALUES ('welcome_001', 1, 'multiple', 'How did you find our platform?', '["Social Media", "Friend", "Search", "Other"]')
      ON CONFLICT (survey_id, question_number) DO NOTHING
    `);
    console.log('✅ Test survey created');
    
    // Verify setup
    console.log('\n🔍 Verifying setup...');
    const verification = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `);
    
    console.log('📊 Tables created:');
    verification.rows.forEach(row => {
      console.log(`   ✓ ${row.table_name}`);
    });
    
    const sampleCheck = await client.query(`
      SELECT COUNT(*) as survey_count, 
             (SELECT COUNT(*) FROM questions WHERE survey_id = 'welcome_001') as question_count
      FROM surveys WHERE id = 'welcome_001'
    `);
    
    console.log(`\n🎉 SETUP COMPLETE!`);
    console.log(`   📋 ${sampleCheck.rows[0].survey_count} test survey created`);
    console.log(`   ❓ ${sampleCheck.rows[0].question_count} test questions added`);
    console.log(`\n🚀 Your WhatsApp Survey Platform is ready on Render!`);
    console.log(`\nNext steps:`);
    console.log(`1. Your app should be running at your Render URL`);
    console.log(`2. Access the admin dashboard`);
    console.log(`3. Connect WhatsApp by scanning the QR code`);
    console.log(`4. Create your first survey!`);
    
  } catch (error) {
    console.error('\n❌ Setup failed:', error.message);
    console.log('\n🔧 Common solutions:');
    console.log('1. Wait 30 seconds and try again (database may still be initializing)');
    console.log('2. Check that your app deployed successfully');
    console.log('3. Verify environment variables are set');
    throw error;
  } finally {
    await client.end();
  }
}

// Run setup
renderSetup().catch(error => {
  console.error('\n💥 Setup process failed!');
  process.exit(1);
});
