-- WhatsApp Survey Platform Database Schema
-- Production-ready PostgreSQL schema with proper constraints and indexes

-- Enable UUID extension if needed
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Drop existing tables if they exist (for clean setup)
DROP TABLE IF EXISTS responses CASCADE;
DROP TABLE IF EXISTS survey_participants CASCADE;
DROP TABLE IF EXISTS questions CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS participants CASCADE;
DROP TABLE IF EXISTS surveys CASCADE;

-- Create surveys table
CREATE TABLE surveys (
    id VARCHAR(50) PRIMARY KEY,
    title VARCHAR(500) NOT NULL CHECK (length(trim(title)) > 0),
    description TEXT DEFAULT '',
    estimated_time VARCHAR(50) DEFAULT '3-5 minutes',
    participant_prefix VARCHAR(20) NOT NULL CHECK (length(trim(participant_prefix)) > 0),
    is_active BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create participants table
CREATE TABLE participants (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(50) UNIQUE NOT NULL CHECK (length(trim(phone_number)) > 0),
    participant_code VARCHAR(20) UNIQUE NOT NULL CHECK (length(trim(participant_code)) > 0),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create questions table
CREATE TABLE questions (
    id SERIAL PRIMARY KEY,
    survey_id VARCHAR(50) NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    question_number INTEGER NOT NULL CHECK (question_number > 0),
    question_type VARCHAR(50) NOT NULL CHECK (question_type IN ('curated', 'multiple', 'likert', 'text')),
    question_text TEXT NOT NULL CHECK (length(trim(question_text)) > 0),
    options JSONB,
    scale JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(survey_id, question_number)
);

-- Create survey_participants table
CREATE TABLE survey_participants (
    id SERIAL PRIMARY KEY,
    survey_id VARCHAR(50) NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    participant_survey_code VARCHAR(20) NOT NULL CHECK (length(trim(participant_survey_code)) > 0),
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    is_completed BOOLEAN DEFAULT FALSE,
    completion_duration_seconds INTEGER CHECK (completion_duration_seconds >= 0),
    UNIQUE(survey_id, participant_id),
    UNIQUE(survey_id, participant_survey_code)
);

-- Create sessions table
CREATE TABLE sessions (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(50) NOT NULL CHECK (length(trim(phone_number)) > 0),
    survey_id VARCHAR(50) NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    current_question INTEGER DEFAULT 0 CHECK (current_question >= 0),
    stage VARCHAR(50) DEFAULT 'initial' CHECK (stage IN ('initial', 'survey', 'followup', 'voice_confirmation', 'completed')),
    session_data JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(phone_number, survey_id)
);

-- Create responses table
CREATE TABLE responses (
    id SERIAL PRIMARY KEY,
    survey_id VARCHAR(50) NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    answer TEXT NOT NULL CHECK (length(trim(answer)) > 0),
    follow_up_comment TEXT,
    voice_metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(survey_id, participant_id, question_id)
);

-- Create indexes for performance
CREATE INDEX idx_surveys_active ON surveys(is_active) WHERE is_active = true;
CREATE INDEX idx_surveys_created ON surveys(created_at DESC);

CREATE INDEX idx_participants_phone ON participants(phone_number);
CREATE INDEX idx_participants_code ON participants(participant_code);

CREATE INDEX idx_questions_survey ON questions(survey_id, question_number);
CREATE INDEX idx_questions_type ON questions(question_type);

CREATE INDEX idx_survey_participants_survey ON survey_participants(survey_id);
CREATE INDEX idx_survey_participants_participant ON survey_participants(participant_id);
CREATE INDEX idx_survey_participants_completed ON survey_participants(is_completed);
CREATE INDEX idx_survey_participants_started ON survey_participants(started_at);

CREATE INDEX idx_sessions_phone_survey ON sessions(phone_number, survey_id);
CREATE INDEX idx_sessions_stage ON sessions(stage);
CREATE INDEX idx_sessions_updated ON sessions(updated_at);
CREATE INDEX idx_sessions_survey ON sessions(survey_id);

CREATE INDEX idx_responses_survey ON responses(survey_id);
CREATE INDEX idx_responses_participant ON responses(participant_id);
CREATE INDEX idx_responses_question ON responses(question_id);
CREATE INDEX idx_responses_created ON responses(created_at DESC);
CREATE INDEX idx_responses_voice ON responses(voice_metadata) WHERE voice_metadata IS NOT NULL;

-- Create function to generate next participant code
CREATE OR REPLACE FUNCTION get_next_participant_code(survey_id VARCHAR)
RETURNS VARCHAR AS $$
DECLARE
    next_code VARCHAR;
    prefix VARCHAR;
    counter INTEGER;
BEGIN
    -- Get survey prefix
    SELECT participant_prefix INTO prefix FROM surveys WHERE id = survey_id;
    
    IF prefix IS NULL THEN
        RAISE EXCEPTION 'Survey not found: %', survey_id;
    END IF;
    
    -- Get current max counter for this survey
    SELECT COALESCE(MAX(SUBSTRING(participant_survey_code FROM '[0-9]+')::INTEGER), 0) + 1
    INTO counter
    FROM survey_participants sp
    WHERE sp.survey_id = survey_id;
    
    -- Format: PREFIX001, PREFIX002, etc.
    next_code := prefix || LPAD(counter::TEXT, 3, '0');
    
    RETURN next_code;
END;
$$ LANGUAGE plpgsql;

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers for updated_at
CREATE TRIGGER update_surveys_updated_at 
    BEFORE UPDATE ON surveys
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_sessions_updated_at 
    BEFORE UPDATE ON sessions
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Create view for survey statistics
CREATE OR REPLACE VIEW survey_statistics AS
SELECT 
    s.id,
    s.title,
    s.is_active,
    s.created_at,
    COUNT(DISTINCT sp.participant_id) as total_participants,
    COUNT(DISTINCT CASE WHEN sp.is_completed THEN sp.participant_id END) as completed_participants,
    COUNT(r.id) as total_responses,
    CASE 
        WHEN COUNT(DISTINCT sp.participant_id) > 0 
        THEN ROUND((COUNT(DISTINCT CASE WHEN sp.is_completed THEN sp.participant_id END) * 100.0 / COUNT(DISTINCT sp.participant_id)), 2)
        ELSE 0 
    END as completion_rate,
    ROUND(AVG(CASE WHEN sp.completion_duration_seconds IS NOT NULL THEN sp.completion_duration_seconds END)) as avg_completion_seconds
FROM surveys s
LEFT JOIN survey_participants sp ON s.id = sp.survey_id
LEFT JOIN responses r ON sp.survey_id = r.survey_id AND sp.participant_id = r.participant_id
GROUP BY s.id, s.title, s.is_active, s.created_at;

-- Create function to clean up old sessions (older than 24 hours)
CREATE OR REPLACE FUNCTION cleanup_old_sessions()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM sessions 
    WHERE updated_at < CURRENT_TIMESTAMP - INTERVAL '24 hours';
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Create function to validate question options
CREATE OR REPLACE FUNCTION validate_question_options()
RETURNS TRIGGER AS $$
BEGIN
    -- Validate multiple choice and curated questions have options
    IF NEW.question_type IN ('multiple', 'curated') THEN
        IF NEW.options IS NULL OR jsonb_array_length(NEW.options) = 0 THEN
            RAISE EXCEPTION 'Question type % requires options array', NEW.question_type;
        END IF;
    END IF;
    
    -- Validate likert questions have scale
    IF NEW.question_type = 'likert' THEN
        IF NEW.scale IS NULL THEN
            RAISE EXCEPTION 'Question type likert requires scale object';
        END IF;
        
        -- Validate scale structure
        IF NOT (NEW.scale ? 'min' AND NEW.scale ? 'max' AND NEW.scale ? 'labels') THEN
            RAISE EXCEPTION 'Likert scale must have min, max, and labels properties';
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for question validation
CREATE TRIGGER validate_question_options_trigger
    BEFORE INSERT OR UPDATE ON questions
    FOR EACH ROW
    EXECUTE FUNCTION validate_question_options();

-- Create function to ensure only one active survey
CREATE OR REPLACE FUNCTION ensure_single_active_survey()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.is_active = TRUE THEN
        -- Deactivate all other surveys
        UPDATE surveys SET is_active = FALSE WHERE id != NEW.id;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for single active survey
CREATE TRIGGER ensure_single_active_survey_trigger
    BEFORE UPDATE ON surveys
    FOR EACH ROW
    WHEN (NEW.is_active = TRUE)
    EXECUTE FUNCTION ensure_single_active_survey();

-- Insert some sample data for testing (optional)
-- This can be commented out in production

INSERT INTO surveys (id, title, description, estimated_time, participant_prefix, is_active) 
VALUES 
    ('sample_001', 'Platform Test Survey', 'A simple test survey to verify the platform is working correctly', '2-3 minutes', 'TEST', false);

INSERT INTO questions (survey_id, question_number, question_type, question_text, options) 
VALUES 
    ('sample_001', 1, 'curated', 'Do you think this survey platform is easy to use?', '["Agree", "Undecided", "Disagree"]'),
    ('sample_001', 2, 'multiple', 'How did you hear about this platform?', '["Social media", "Word of mouth", "Online search", "Other"]'),
    ('sample_001', 3, 'likert', 'How likely are you to recommend this platform to others?', '{"min": 1, "max": 10, "labels": ["Not likely", "Very likely"]}'),
    ('sample_001', 4, 'text', 'Any additional feedback or suggestions?', null);

-- Grant permissions (adjust as needed for your deployment)
-- These are examples - adjust based on your specific user setup

-- GRANT USAGE ON SCHEMA public TO your_app_user;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO your_app_user;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO your_app_user;

-- Create a monitoring query for database health
CREATE OR REPLACE VIEW database_health AS
SELECT 
    'surveys' as table_name,
    COUNT(*) as row_count,
    COUNT(CASE WHEN is_active THEN 1 END) as active_count
FROM surveys
UNION ALL
SELECT 
    'participants' as table_name,
    COUNT(*) as row_count,
    COUNT(CASE WHEN created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours' THEN 1 END) as recent_count
FROM participants
UNION ALL
SELECT 
    'sessions' as table_name,
    COUNT(*) as row_count,
    COUNT(CASE WHEN updated_at > CURRENT_TIMESTAMP - INTERVAL '1 hour' THEN 1 END) as active_count
FROM sessions
UNION ALL
SELECT 
    'responses' as table_name,
    COUNT(*) as row_count,
    COUNT(CASE WHEN created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours' THEN 1 END) as recent_count
FROM responses;
