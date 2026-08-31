-- Migration 068: classify Direct positions by the round that priced the
-- acquisition, not by the security class that happens to be held.
--
-- Example: Series B preferred purchased in a Series D secondary remains
-- Series B security, while its portfolio stage is Growth (Series D+).

WITH classified AS (
  SELECT
    p.investment_id,
    CASE
      WHEN normalized_round IN ('pre-seed', 'preseed', 'pre seed') THEN 'pre-seed'
      WHEN normalized_round = 'seed' THEN 'seed'
      WHEN normalized_round = 'seed+' THEN 'seed-ext'
      WHEN normalized_round IN ('series a', 'series a+') THEN 'series-a'
      WHEN normalized_round IN ('series b', 'series b+') THEN 'series-b'
      WHEN normalized_round IN ('series c', 'series c+') THEN 'series-c'
      WHEN normalized_round IN (
        'series d', 'series d+', 'series e', 'series e+',
        'series f', 'series f+', 'growth', 'late stage', 'late-stage'
      ) THEN 'growth'
      ELSE NULL
    END AS stage_bucket
  FROM (
    SELECT
      investment_id,
      LOWER(TRIM(REGEXP_REPLACE(pricing_reference_round, '\\s+', ' ', 'g'))) AS normalized_round
    FROM direct_acquisition_profiles
    WHERE pricing_reference_round IS NOT NULL
  ) p
)
UPDATE investments i
   SET stage_bucket = classified.stage_bucket,
       updated_at = NOW()
  FROM classified
 WHERE i.id = classified.investment_id
   AND i.asset_class = 'direct'
   AND classified.stage_bucket IS NOT NULL
   AND i.stage_bucket IS DISTINCT FROM classified.stage_bucket;
