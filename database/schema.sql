-- WhatsApp Survey Platform Database Schema
-- PostgreSQL Database Setup

-- Enable UUID extension for unique identifiers
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Drop existing tables if needed (comment out in production)
-- DROP TABLE IF EXISTS responses CASCADE;
-- DROP TABLE IF EXISTS sessions CASCADE;
-- DROP TABLE IF EXISTS survey_participants CASCADE;
-- DROP TABLE IF EXISTS questions CASCADE;
-- DROP TABLE IF EXISTS participants CASCADE;
-- DROP TABLE IF EXISTS surveys CASCADE;

-- Surveys table
CREATE TABLE IF NOT EXISTS surveys (
    id VARCHAR(50) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    estimated_time VARCHAR(50),
    is_active BOOLEAN DEFAULT FALSE,
    participant_counter INTEGER DEFAULT 0,
    participant_prefix VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Survey questions table
CREATE TABLE IF NOT EXISTS questions (
    id SERIAL PRIMARY KEY,
    survey_id VARCHAR(50) REFERENCES surveys(id) ON DELETE CASCADE,
    question_number INTEGER NOT NULL,
    question_type VARCHAR(20) NOT NULL CHECK (question_type IN ('curated', 'multiple', 'likert', 'text')),
    question_text TEXT NOT NULL,
    options JSONB,
    scale JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Participants table
CREATE TABLE IF NOT EXISTS participants (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(50) UNIQUE NOT NULL,
    participant_code VARCHAR(50) NOT NULL,
    first_survey_id VARCHAR(50) REFERENCES surveys(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Survey participants mapping
CREATE TABLE IF NOT EXISTS survey_participants (
    id SERIAL PRIMARY KEY,
    survey_id VARCHAR(50) REFERENCES surveys(id) ON DELETE CASCADE,
    participant_id INTEGER REFERENCES participants(id) ON DELETE CASCADE,
    participant_survey_code VARCHAR(50) NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE,
    completion_duration_seconds INTEGER,
    is_completed BOOLEAN DEFAULT FALSE,
    UNIQUE(survey_id, participant_id)
);

-- Responses table
CREATE TABLE IF NOT EXISTS responses (
    id SERIAL PRIMARY KEY,
    survey_id VARCHAR(50) REFERENCES surveys(id) ON DELETE CASCADE,
    participant_id INTEGER REFERENCES participants(id) ON DELETE CASCADE,
    question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
    answer TEXT NOT NULL,
    follow_up_comment TEXT,
    voice_metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Sessions table for active WhatsApp conversations
CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(50) NOT NULL,
    survey_id VARCHAR(50) REFERENCES surveys(id) ON DELETE CASCADE,
    participant_id INTEGER REFERENCES participants(id) ON DELETE CASCADE,
    current_question INTEGER DEFAULT 0,
    stage VARCHAR(50) DEFAULT 'initial',
    session_data JSONB,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_surveys_active ON surveys(is_active);
CREATE INDEX IF NOT EXISTS idx_responses_survey ON responses(survey_id);
CREATE INDEX IF NOT EXISTS idx_responses_participant ON responses(participant_id);
CREATE INDEX IF NOT EXISTS idx_survey_participants_survey ON survey_participants(survey_id);
CREATE INDEX IF NOT EXISTS idx_survey_participants_completed ON survey_participants(is_completed);
CREATE INDEX IF NOT EXISTS idx_sessions_phone ON sessions(phone_number);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
DROP TRIGGER IF EXISTS update_surveys_updated_at ON surveys;
CREATE TRIGGER update_surveys_updated_at BEFORE UPDATE ON surveys
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_sessions_updated_at ON sessions;
CREATE TRIGGER update_sessions_updated_at BEFORE UPDATE ON sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to generate next participant code for a survey
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
$$ LANGUAGE plpgsql;

-- View for survey statistics
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
