// purge-database.js
// WARNING: This will delete ALL data from your database!
// Make sure to backup any important data before running this.

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function purgeAllData() {
  const client = await pool.connect();
  
  try {
    console.log('⚠️  WARNING: This will DELETE ALL DATA from your database!');
    console.log('Press Ctrl+C to cancel, or wait 5 seconds to continue...\n');
    
    // Give user time to cancel
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    console.log('🗑️  Starting data purge...\n');
    
    await client.query('BEGIN');
    
    // Delete data in correct order (respecting foreign key constraints)
    const deletions = [
      { table: 'responses', name: 'Survey responses' },
      { table: 'sessions', name: 'Active sessions' },
      { table: 'survey_participants', name: 'Survey participants' },
      { table: 'questions', name: 'Survey questions' },
      { table: 'participants', name: 'Participants' },
      { table: 'surveys', name: 'Surveys' }
    ];
    
    for (const { table, name } of deletions) {
      const result = await client.query(`DELETE FROM ${table}`);
      console.log(`✓ Deleted ${result.rowCount} records from ${name}`);
    }
    
    // Reset participant counter sequences
    await client.query(`ALTER SEQUENCE participants_id_seq RESTART WITH 1`);
    await client.query(`ALTER SEQUENCE questions_id_seq RESTART WITH 1`);
    await client.query(`ALTER SEQUENCE survey_participants_id_seq RESTART WITH 1`);
    await client.query(`ALTER SEQUENCE responses_id_seq RESTART WITH 1`);
    await client.query(`ALTER SEQUENCE sessions_id_seq RESTART WITH 1`);
    
    console.log('\n✓ Reset all ID sequences');
    
    await client.query('COMMIT');
    
    console.log('\n✅ Database purged successfully!');
    console.log('All data has been deleted. Tables and structure remain intact.');
    
    // Show current state
    const tableCount = await client.query(`
      SELECT table_name, 
             (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name) as columns
      FROM information_schema.tables t
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    
    console.log('\n📊 Database structure (empty tables):');
    tableCount.rows.forEach(row => {
      console.log(`   - ${row.table_name} (${row.columns} columns)`);
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('\n❌ Error purging database:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Alternative: Purge only response data (keep surveys)
async function purgeResponsesOnly() {
  const client = await pool.connect();
  
  try {
    console.log('🗑️  Purging response data only (keeping surveys)...\n');
    
    await client.query('BEGIN');
    
    // Delete only response-related data
    const deletions = [
      { table: 'responses', name: 'Survey responses' },
      { table: 'sessions', name: 'Active sessions' },
      { table: 'survey_participants', name: 'Survey participants' }
    ];
    
    for (const { table, name } of deletions) {
      const result = await client.query(`DELETE FROM ${table}`);
      console.log(`✓ Deleted ${result.rowCount} records from ${name}`);
    }
    
    // Reset participant counters in surveys
    await client.query(`UPDATE surveys SET participant_counter = 0`);
    console.log('✓ Reset survey participant counters');
    
    await client.query('COMMIT');
    
    console.log('\n✅ Response data purged successfully!');
    console.log('Surveys and questions remain intact.');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('\n❌ Error:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Choose which purge to run based on command line argument
const args = process.argv.slice(2);
const purgeType = args[0];

if (purgeType === 'responses') {
  console.log('Running response-only purge...');
  purgeResponsesOnly().catch(console.error);
} else if (purgeType === 'all') {
  console.log('Running full data purge...');
  purgeAllData().catch(console.error);
} else {
  console.log(`
Database Purge Utility
======================

Usage:
  node purge-database.js all        # Delete ALL data (surveys, responses, everything)
  node purge-database.js responses  # Delete only responses (keep surveys)

WARNING: This action cannot be undone!
  `);
}
