// fix-duplicate-responses.js
// Run this script to clean up duplicate response issues
// Usage: node fix-duplicate-responses.js

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function fixDuplicateResponses() {
  const client = await pool.connect();
  
  try {
    console.log('🔧 Fixing duplicate response issues...\n');
    
    await client.query('BEGIN');
    
    // 1. Find and report duplicates
    console.log('1. Checking for duplicate responses...');
    const duplicates = await client.query(`
      SELECT 
        survey_id, 
        participant_id, 
        question_id, 
        COUNT(*) as count
      FROM responses
      GROUP BY survey_id, participant_id, question_id
      HAVING COUNT(*) > 1
    `);
    
    if (duplicates.rows.length > 0) {
      console.log(`Found ${duplicates.rows.length} duplicate response sets:`);
      duplicates.rows.forEach(row => {
        console.log(`  - Survey: ${row.survey_id}, Participant: ${row.participant_id}, Question: ${row.question_id} (${row.count} responses)`);
      });
      
      // 2. Keep only the most recent response for each duplicate
      console.log('\n2. Removing older duplicate responses...');
      const deleteResult = await client.query(`
        DELETE FROM responses r1
        WHERE EXISTS (
          SELECT 1
          FROM responses r2
          WHERE r1.survey_id = r2.survey_id
            AND r1.participant_id = r2.participant_id
            AND r1.question_id = r2.question_id
            AND r1.created_at < r2.created_at
        )
      `);
      
      console.log(`✅ Removed ${deleteResult.rowCount} duplicate responses`);
    } else {
      console.log('✅ No duplicate responses found');
    }
    
    // 3. Fix orphaned sessions
    console.log('\n3. Checking for orphaned sessions...');
    const orphanedSessions = await client.query(`
      SELECT s.*, 
             (SELECT MAX(q.question_number) 
              FROM questions q 
              JOIN responses r ON q.id = r.question_id 
              WHERE r.survey_id = s.survey_id 
              AND r.participant_id = s.participant_id) as last_answered_question
      FROM sessions s
      WHERE s.stage != 'completed'
    `);
    
    if (orphanedSessions.rows.length > 0) {
      console.log(`Found ${orphanedSessions.rows.length} active sessions to check`);
      
      for (const session of orphanedSessions.rows) {
        if (session.last_answered_question && session.current_question <= session.last_answered_question) {
          // Update session to next unanswered question
          await client.query(
            'UPDATE sessions SET current_question = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [session.last_answered_question + 1, session.id]
          );
          console.log(`  ✅ Fixed session ${session.id}: moved to question ${session.last_answered_question + 1}`);
        }
      }
    }
    
    // 4. Add database trigger to prevent future duplicates
    console.log('\n4. Creating database trigger to handle duplicates...');
    
    // Drop existing trigger if exists
    await client.query('DROP TRIGGER IF EXISTS prevent_duplicate_responses ON responses');
    
    // Create function to handle duplicates
    await client.query(`
      CREATE OR REPLACE FUNCTION handle_duplicate_response()
      RETURNS TRIGGER AS $$
      BEGIN
        -- Check if response already exists
        IF EXISTS (
          SELECT 1 FROM responses 
          WHERE survey_id = NEW.survey_id 
          AND participant_id = NEW.participant_id 
          AND question_id = NEW.question_id
        ) THEN
          -- Update existing response instead
          UPDATE responses 
          SET answer = NEW.answer,
              follow_up_comment = COALESCE(NEW.follow_up_comment, follow_up_comment),
              voice_metadata = COALESCE(NEW.voice_metadata, voice_metadata),
              created_at = CURRENT_TIMESTAMP
          WHERE survey_id = NEW.survey_id 
          AND participant_id = NEW.participant_id 
          AND question_id = NEW.question_id;
          
          -- Return NULL to skip the insert
          RETURN NULL;
        END IF;
        
        -- Allow the insert if no duplicate
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    
    // Create trigger
    await client.query(`
      CREATE TRIGGER prevent_duplicate_responses
      BEFORE INSERT ON responses
      FOR EACH ROW
      EXECUTE FUNCTION handle_duplicate_response()
    `);
    
    console.log('✅ Database trigger created');
    
    // 5. Add helpful indexes if not exists
    console.log('\n5. Optimizing database indexes...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_responses_composite 
      ON responses(survey_id, participant_id, question_id)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_composite 
      ON sessions(phone_number, survey_id, stage)
    `);
    
    console.log('✅ Indexes optimized');
    
    // Commit all changes
    await client.query('COMMIT');
    
    // 6. Report current database health
    console.log('\n📊 Database Health Check:');
    
    const stats = await client.query(`
      SELECT 
        (SELECT COUNT(DISTINCT participant_id) FROM responses) as unique_participants,
        (SELECT COUNT(*) FROM responses) as total_responses,
        (SELECT COUNT(*) FROM sessions WHERE stage = 'completed') as completed_sessions,
        (SELECT COUNT(*) FROM sessions WHERE stage != 'completed') as active_sessions
    `);
    
    const health = stats.rows[0];
    console.log(`  - Unique participants: ${health.unique_participants}`);
    console.log(`  - Total responses: ${health.total_responses}`);
    console.log(`  - Completed sessions: ${health.completed_sessions}`);
    console.log(`  - Active sessions: ${health.active_sessions}`);
    
    console.log('\n✅ Database fix completed successfully!');
    console.log('Your WhatsApp Survey Platform should now handle responses properly.');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('\n❌ Error fixing database:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run the fix
fixDuplicateResponses().catch(console.error);
