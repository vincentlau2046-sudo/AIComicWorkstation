-- 0060: Add environment_prompts, characters, time_of_day, timeline columns to shots
ALTER TABLE shots ADD COLUMN environment_prompts TEXT;
ALTER TABLE shots ADD COLUMN characters TEXT;
ALTER TABLE shots ADD COLUMN time_of_day TEXT DEFAULT '深夜';
ALTER TABLE shots ADD COLUMN timeline TEXT DEFAULT '主线';