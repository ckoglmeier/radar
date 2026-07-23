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

export function scoreCouncilChoices(choices, rubric) {
  if (!rubric?.sections?.length) throw new Error('Council scoring requires an active rubric');
  const expected = rubric.sections.flatMap(section => section.dimensions || []);
  if ((choices || []).length !== expected.length) {
    throw new Error(`Council output must contain exactly ${expected.length} dimension scores`);
  }
  const byName = new Map();
  for (const choice of choices || []) {
    const name = normalizeName(choice.name);
    if (byName.has(name)) throw new Error(`Council output repeats the ${choice.name} score`);
    byName.set(name, Number(choice.likert));
  }
  const sections = rubric.sections.map(section => {
    const dimensions = (section.dimensions || []).map(dimension => {
      const likert = byName.get(normalizeName(dimension.name));
      const [minimum, maximum] = dimension.scale || [1, 5];
      const configuredMax = Number(dimension.max_points);
      const derivedMax = Number(rubric.total_points || 50) * Number(dimension.weight_pct || 0) / 100;
      const maxPoints = Number.isFinite(configuredMax) ? configuredMax : derivedMax;
      if (likert == null) throw new Error(`Council output is missing the ${dimension.name} score`);
      if (likert < minimum || likert > maximum) {
        throw new Error(`Council score for ${dimension.name} must be ${minimum}–${maximum}`);
      }
      if (!Number.isFinite(maxPoints) || maxPoints <= 0) {
        throw new Error(`Council rubric is missing a weight for ${dimension.name}`);
      }
      return {
        name: dimension.name,
        likert,
        points: Number.isFinite(configuredMax)
          ? Math.round((likert / maximum) * maxPoints)
          : Math.round((likert / maximum) * maxPoints * 10) / 10,
      };
    });
    return {
      name: section.name,
      dimensions,
      points: dimensions.reduce((sum, dimension) => sum + dimension.points, 0),
    };
  });
  const total = sections.reduce((sum, section) => sum + section.points, 0);
  return {
    sections,
    thesisFitScore: sections.find(section => normalizeName(section.name) === normalizeName('Thesis Fit'))?.points,
    viabilityScore: sections.find(section => normalizeName(section.name) === normalizeName('Viability'))?.points,
    totalScore: total,
    verdict: verdictFor(total, rubric.verdict_bands),
  };
}

/**
 * Recompute the canonical Council score from the model's dimension choices.
 * Throws when a required dimension is absent or outside the configured scale.
 */
export function scoreCouncilArtifact(content, rubric) {
  const choices = [];
  for (let index = 0; index < rubric.sections.length; index++) {
    const section = rubric.sections[index];
    const nextSection = rubric.sections[index + 1];
    const body = sectionBody(content, section.name, nextSection?.name);
    if (!body) throw new Error(`Council artifact is missing the ${section.name} section`);

    const sectionChoices = dimensionScores(body);
    for (const dimension of section.dimensions || []) {
      const likert = sectionChoices.get(normalizeName(dimension.name));
      const [minimum, maximum] = dimension.scale || [1, 5];
      if (likert == null) {
        throw new Error(`Council artifact is missing the ${dimension.name} score`);
      }
      if (likert < minimum || likert > maximum) {
        throw new Error(
          `Council artifact score for ${dimension.name} must be ${minimum}–${maximum}`,
        );
      }
      choices.push({ name: dimension.name, likert });
    }
  }
  return scoreCouncilChoices(choices, rubric);
}
