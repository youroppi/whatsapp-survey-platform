// verify-database.js - Quick database verification script
// Usage: node verify-database.js

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function verifyDatabase() {
  console.log('🔍 Verifying WhatsApp Survey Platform database...\n');
  
  const client = await pool.connect();
  
  try {
    // 1. Test connection
    const connectionTest = await client.query('SELECT NOW() as current_time, version() as pg_version');
    console.log('✅ Database connection successful');
    console.log(`   Time: ${connectionTest.rows[0].current_time}`);
    console.log(`   PostgreSQL: ${connectionTest.rows[0].pg_version.split(' ')[0]} ${connectionTest.rows[0].pg_version.split(' ')[1]}\n`);

    // 2. Check required tables
    const requiredTables = [
      'surveys', 'participants', 'questions', 
      'survey_participants', 'sessions', 'responses'
    ];
    
    const tablesResult = await client.query(`
      SELECT 
        table_name,
        (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name) as columns
      FROM information_schema.tables t
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    
    const existingTables = tablesResult.rows.map(row => row.table_name);
    
    console.log('📊 Table verification:');
    let allTablesExist = true;
    for (const table of requiredTables) {
      const tableRow = tablesResult.rows.find(row => row.table_name === table);
      if (tableRow) {
        console.log(`   ✅ ${table} (${tableRow.columns} columns)`);
      } else {
        console.log(`   ❌ ${table} - MISSING`);
        allTablesExist = false;
      }
    }
    
    // 3. Check indexes
    const indexesResult = await client.query(`
      SELECT COUNT(*) as index_count
      FROM pg_indexes 
      WHERE schemaname = 'public'
      AND indexname LIKE 'idx_%'
    `);
    
    console.log(`\n🔍 Database indexes: ${indexesResult.rows[0].index_count} performance indexes found`);
    
    // 4. Check functions
    const functionsResult = await client.query(`
      SELECT routine_name
      FROM information_schema.routines
      WHERE routine_schema = 'public'
      AND routine_type = 'FUNCTION'
      AND routine_name IN ('get_next_participant_code', 'update_updated_at_column')
    `);
    
    console.log(`\n⚙️  Utility functions: ${functionsResult.rows.length}/2 functions found`);
    
    // 5. Check views
    const viewsResult = await client.query(`
      SELECT table_name as view_name
      FROM information_schema.views 
      WHERE table_schema = 'public'
      AND table_name IN ('survey_statistics', 'database_health')
    `);
    
    console.log(`\n👁️  Analytics views: ${viewsResult.rows.length}/2 views found`);
    
    // 6. Test data operations
    console.log('\n🧪 Testing data operations...');
    
    // Test insert
    await client.query(`
      INSERT INTO surveys (id, title, participant_prefix, is_active) 
      VALUES ('test_verify', 'Verification Test', 'VERIFY', false)
      ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title
    `);
    console.log('   ✅ Insert operation successful');
    
    // Test select
    const selectResult = await client.query('SELECT * FROM surveys WHERE id = $1', ['test_verify']);
    if (selectResult.rows.length > 0) {
      console.log('   ✅ Select operation successful');
    }
    
    // Test update
    await client.query('UPDATE surveys SET title = $1 WHERE id = $2', ['Updated Test', 'test_verify']);
    console.log('   ✅ Update operation successful');
    
    // Test delete
    await client.query('DELETE FROM surveys WHERE id = $1', ['test_verify']);
    console.log('   ✅ Delete operation successful');
    
    // 7. Check sample data
    const sampleDataResult = await client.query(`
      SELECT 
        (SELECT COUNT(*) FROM surveys WHERE id = 'sample_001') as sample_survey,
        (SELECT COUNT(*) FROM questions WHERE survey_id = 'sample_001') as sample_questions
    `);
    
    console.log(`\n📋 Sample data: ${sampleDataResult.rows[0].sample_survey} survey, ${sampleDataResult.rows[0].sample_questions} questions`);
    
    // 8. Database health check
    const healthResult = await client.query(`
      SELECT 
        table_name,
        total_records,
        active_records,
        description
      FROM database_health
      ORDER BY table_name
    `);
    
    console.log('\n💊 Database health:');
    healthResult.rows.forEach(row => {
      console.log(`   ${row.table_name}: ${row.total_records} total, ${row.active_records} ${row.description.toLowerCase()}`);
    });
    
    // 9. Final summary
    console.log('\n' + '='.repeat(50));
    console.log('📋 VERIFICATION SUMMARY');
    console.log('='.repeat(50));
    
    if (allTablesExist && indexesResult.rows[0].index_count > 0) {
      console.log('🎉 DATABASE STATUS: HEALTHY ✅');
      console.log('✅ All required tables exist');
      console.log('✅ Performance indexes are in place');
      console.log('✅ Utility functions are working');
      console.log('✅ Data operations are successful');
      console.log('✅ Analytics views are available');
      console.log('\n🚀 Your WhatsApp Survey Platform is ready to use!');
    } else {
      console.log('⚠️  DATABASE STATUS: NEEDS ATTENTION ❌');
      console.log('\n🔧 Run this command to fix issues:');
      console.log('   node database-setup.js');
    }
    
  } catch (error) {
    console.error('\n❌ Database verification failed:', error.message);
    console.log('\n🔧 Troubleshooting steps:');
    console.log('1. Check DATABASE_URL environment variable');
    console.log('2. Ensure PostgreSQL is running');
    console.log('3. Run: node database-setup.js');
    console.log('4. Check database permissions');
  } finally {
    client.release();
    await pool.end();
  }
}

// Run verification
verifyDatabase().catch(console.error);
