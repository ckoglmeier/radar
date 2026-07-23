// Deterministic scoring for headless Council artifacts.
//
// The model chooses a 1–5 Likert value for each rubric dimension. Radar—not
// the model—converts those choices into weighted points and a verdict. This
// keeps arithmetic and band selection reproducible across Council runs.

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/[^a-z0-9]+/g, '');
}

function sectionBody(content, sectionName, nextSectionName) {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const next = nextSectionName
    ? `(?=\\n##\\s+${nextSectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$)`
    : '(?=\\n##\\s+Total\\s*:)';
  const match = content.match(new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)${next}`, 'mi'));
  return match?.[1] || null;
}

function dimensionScores(body) {
  const scores = new Map();
  for (const line of body.split('\n')) {
    const match = line.match(/^\s*-\s+(?:\*{0,2})([^:*]+?)(?:\*{0,2})\s*:\s*(\d+(?:\.\d+)?)\s*\/\s*5\b/i);
    if (match) scores.set(normalizeName(match[1]), Number(match[2]));
  }
  return scores;
}

function verdictFor(total, bands) {
  const band = (bands || []).find(({ range }) =>
    Array.isArray(range) && total >= Number(range[0]) && total <= Number(range[1]));
  if (!band) throw new Error(`No verdict band covers Council score ${total}`);
  return band.verdict;
}

/**
 * Recompute the canonical Council score from the model's dimension choices.
 * Throws when a required dimension is absent or outside the configured scale.
 */
export function scoreCouncilArtifact(content, rubric) {
  if (!rubric?.sections?.length) throw new Error('Council scoring requires an active rubric');

  const sectionScores = [];
  for (let index = 0; index < rubric.sections.length; index++) {
    const section = rubric.sections[index];
    const nextSection = rubric.sections[index + 1];
    const body = sectionBody(content, section.name, nextSection?.name);
    if (!body) throw new Error(`Council artifact is missing the ${section.name} section`);

    const choices = dimensionScores(body);
    let points = 0;
    for (const dimension of section.dimensions || []) {
      const likert = choices.get(normalizeName(dimension.name));
      const [minimum, maximum] = dimension.scale || [1, 5];
      if (likert == null) {
        throw new Error(`Council artifact is missing the ${dimension.name} score`);
      }
      if (likert < minimum || likert > maximum) {
        throw new Error(
          `Council artifact score for ${dimension.name} must be ${minimum}–${maximum}`,
        );
      }
      points += Math.round((likert / maximum) * Number(dimension.max_points));
    }
    sectionScores.push({ name: section.name, points });
  }

  const total = sectionScores.reduce((sum, section) => sum + section.points, 0);
  const byName = Object.fromEntries(
    sectionScores.map(section => [normalizeName(section.name), section.points]),
  );

  return {
    thesisFitScore: byName[normalizeName('Thesis Fit')],
    viabilityScore: byName[normalizeName('Viability')],
    totalScore: total,
    verdict: verdictFor(total, rubric.verdict_bands),
  };
}
