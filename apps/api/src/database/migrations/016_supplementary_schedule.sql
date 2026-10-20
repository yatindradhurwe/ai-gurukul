-- Supplementary exams can be scheduled ahead of time, so students and parents
-- see the date, time and room before the re-exam (exam_date already exists).
ALTER TABLE supplementary_exams
  ADD COLUMN start_time time,
  ADD COLUMN room       text;
