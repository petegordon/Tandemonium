-- Migration: 0003_rename_normal_to_adventurous.sql
-- Rename difficulty 'normal' to 'adventurous' in existing records

UPDATE scores SET difficulty = 'adventurous' WHERE difficulty = 'normal';
