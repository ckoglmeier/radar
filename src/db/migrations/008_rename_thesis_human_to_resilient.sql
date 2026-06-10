-- Merge stale "Human Systems" (id 25) into "Resilient Systems" (id 4)
-- DB already has id 4 as "Resilient Systems"; id 25 is a leftover from re-import

-- Update description on the canonical row
UPDATE theses
SET description = 'Human systems resilience (skills, workforce, credentialing) and ecological systems resilience (pollination, food systems, environmental monitoring)'
WHERE name = 'Resilient Systems';

-- Move investment_theses from id 25 → id 4 where no duplicate exists
UPDATE investment_theses
SET thesis_id = (SELECT id FROM theses WHERE name = 'Resilient Systems')
WHERE thesis_id = (SELECT id FROM theses WHERE name = 'Human Systems')
  AND investment_id NOT IN (
    SELECT investment_id FROM investment_theses
    WHERE thesis_id = (SELECT id FROM theses WHERE name = 'Resilient Systems')
  );

-- Delete remaining duplicates (investment already linked to id 4)
DELETE FROM investment_theses
WHERE thesis_id = (SELECT id FROM theses WHERE name = 'Human Systems');

-- Remove the stale thesis row
DELETE FROM theses WHERE name = 'Human Systems';
