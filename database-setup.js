-- Database Schema Check - Run this to ensure your tables exist with correct structure

-- Check if sessions table exists with correct structure
SELECT 
    column_name, 
    data_type, 
    is_nullable,
    column_default
FROM information_schema.columns 
WHERE table_name = 'sessions' 
ORDER BY ordinal_position;

-- If sessions table doesn't exist or is missing columns, create/fix it:
CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(50) NOT NULL,
    survey_id VARCHAR(50) NOT NULL,
    participant_id INTEGER NOT NULL,
    current_question INTEGER DEFAULT 0,
    stage VARCHAR(50) DEFAULT 'initial',
    session_data JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_sessions_phone_survey ON sessions(phone_number, survey_id);
CREATE INDEX IF NOT EXISTS idx_sessions_stage ON sessions(stage);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

-- Check if other required tables exist
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('surveys', 'questions', 'participants', 'survey_participants', 'responses');

-- Create participants table if missing
CREATE TABLE IF NOT EXISTS participants (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(50) UNIQUE NOT NULL,
    participant_code VARCHAR(20) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create surveys table if missing
CREATE TABLE IF NOT EXISTS surveys (
    id VARCHAR(50) PRIMARY KEY,
    title VARCHAR(500) NOT NULL,
    description TEXT,
    estimated_time VARCHAR(50),
    participant_prefix VARCHAR(20),
    is_active BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create questions table if missing
CREATE TABLE IF NOT EXISTS questions (
    id SERIAL PRIMARY KEY,
    survey_id VARCHAR(50) REFERENCES surveys(id),
    question_number INTEGER NOT NULL,
    question_type VARCHAR(50) NOT NULL,
    question_text TEXT NOT NULL,
    options JSONB,
    scale JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create survey_participants table if missing
CREATE TABLE IF NOT EXISTS survey_participants (
    id SERIAL PRIMARY KEY,
    survey_id VARCHAR(50) REFERENCES surveys(id),
    participant_id INTEGER REFERENCES participants(id),
    participant_survey_code VARCHAR(20) NOT NULL,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    is_completed BOOLEAN DEFAULT FALSE,
    completion_duration_seconds INTEGER,
    UNIQUE(survey_id, participant_id)
);

-- Create responses table if missing
CREATE TABLE IF NOT EXISTS responses (
    id SERIAL PRIMARY KEY,
    survey_id VARCHAR(50) REFERENCES surveys(id),
    participant_id INTEGER REFERENCES participants(id),
    question_id INTEGER REFERENCES questions(id),
    answer TEXT NOT NULL,
    follow_up_comment TEXT,
    voice_metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create the function for participant codes if missing
CREATE OR REPLACE FUNCTION get_next_participant_code(survey_id VARCHAR)
RETURNS VARCHAR AS $$
DECLARE
    next_code VARCHAR;
    prefix VARCHAR;
    counter INTEGER;
BEGIN
    -- Get survey prefix
    SELECT participant_prefix INTO prefix FROM surveys WHERE id = survey_id;
    
    -- Get current max counter for this survey
    SELECT COALESCE(MAX(SUBSTRING(participant_survey_code FROM '[0-9]+')::INTEGER), 0) + 1
    INTO counter
    FROM survey_participants sp
    JOIN surveys s ON sp.survey_id = s.id
    WHERE sp.survey_id = survey_id;
    
    -- Format: PREFIX001, PREFIX002, etc.
    next_code := prefix || LPAD(counter::TEXT, 3, '0');
    
    RETURN next_code;
END;
$$ LANGUAGE plpgsql;
