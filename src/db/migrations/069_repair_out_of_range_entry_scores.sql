-- Migration 069: repair impossible entry grades from the final /50 Total in
-- their preserved evaluation memo. This targets only rows already above the
-- 50-point product scale and leaves the original memo untouched.

WITH declared_totals AS (
  SELECT
    de.id,
    match.parts[2]::numeric AS score,
    match.ordinality
  FROM deal_evaluations de
  CROSS JOIN LATERAL REGEXP_MATCHES(
    COALESCE(de.raw_content, ''),
    '^[[:space:]]*(#{1,6}[[:space:]]*)?[*]{0,2}Total:[*]{0,2}[[:space:]]*[*]{0,2}([0-9]+([.][0-9]+)?)[[:space:]]*/[[:space:]]*50',
    'gim'
  ) WITH ORDINALITY AS match(parts, ordinality)
  WHERE de.total_score > 50
), final_totals AS (
  SELECT DISTINCT ON (id)
    id,
    -- The optional heading is capture 1; the numeric score is capture 2.
    score
  FROM declared_totals
  WHERE score BETWEEN 0 AND 50
  ORDER BY id, ordinality DESC
)
UPDATE deal_evaluations de
   SET total_score = final_totals.score
  FROM final_totals
 WHERE de.id = final_totals.id
   AND de.total_score > 50;
