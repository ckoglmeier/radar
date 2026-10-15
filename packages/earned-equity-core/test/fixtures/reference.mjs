// Independent rational reference for earned-equity-core. Exact until output rounding.
const abs = (x) => (x < 0n ? -x : x);
const gcd = (a, b) => { a = abs(a); b = abs(b); while (b) [a, b] = [b, a % b]; return a || 1n; };
export class Q {
  constructor(n, d = 1n) { if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d); this.n = n / g; this.d = d / g; }
  static of(s) { // decimal string
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s); const fr = m[3] ?? '';
    return new Q((m[1] ? -1n : 1n) * BigInt(m[2] + fr), 10n ** BigInt(fr.length));
  }
  add(o) { return new Q(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { return new Q(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { return new Q(this.n * o.n, this.d * o.d); }
  div(o) { return new Q(this.n * o.d, this.d * o.n); }
  cmp(o) { const x = this.n * o.d - o.n * this.d; return x < 0n ? -1 : x > 0n ? 1 : 0; }
  isZero() { return this.n === 0n; }
}
const Z = new Q(0n);
const qi = (x) => new Q(BigInt(x));
export function fmt(q, dp) {
  if (q === null) return null;
  const s = 10n ** BigInt(dp); const num = q.n * s; const den = q.d;
  let qq = num / den; const r = num % den;
  if (r !== 0n) { const tw = abs(r) * 2n; if (tw > den || (tw === den && qq % 2n !== 0n)) qq += num < 0n ? -1n : 1n; }
  const neg = qq < 0n; let d = abs(qq).toString().padStart(dp + 1, '0');
  d = dp ? `${d.slice(0, d.length - dp)}.${d.slice(d.length - dp)}` : d;
  return neg ? `-${d}` : d;
}
const dim = (y, m) => [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
export function am(iso, n) {
  const [y, m, d] = iso.split('-').map(Number); const t = y * 12 + m - 1 + n; const ny = Math.floor(t / 12); const nm = t - ny * 12 + 1;
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(Math.min(d, dim(ny, nm))).padStart(2, '0')}`;
}
const usable = (f) => f && ['confirmed_by_user', 'supported_by_document', 'user_reported'].includes(f.state) && f.value !== null ? f.value : null;

function vestFrac(g, date) { // returns Q fraction (for floor computation returns m,T)
  const v = g.vesting; const step = { monthly: 1, quarterly: 3, annual: 12 }[v.cadence];
  const C = usable(v.commencementDate); if (!step || C === null) return null;
  const T = v.totalMonths, K = v.cliffMonths;
  if (T === 0) return C <= date ? { m: 1n, T: 1n } : { m: 0n, T: 1n };
  let best = -1;
  for (let m = 0; m <= T; m++) {
    const ev = (m % step === 0 && m >= K) || (m === T && T >= K);
    if (ev && am(C, m) <= date) best = m;
  }
  return best < 0 ? { m: 0n, T: 1n } : { m: BigInt(best), T: BigInt(T) };
}

export function reference({ group, offerRevision: offer, scenarioSet }) {
  const S = usable(offer.serviceStartDate); const H = am(group.startDate, group.horizonMonths);
  const val = (f) => { const v = usable(f); return v === null ? null : Q.of(v); };
  const ob = val(offer.cash.annualBase), obo = val(offer.cash.annualTargetBonus), sign = val(offer.cash.signingBonus);
  const bb = group.baseline.annualBase == null ? null : Q.of(group.baseline.annualBase);
  const bbo = group.baseline.annualCashBonus == null ? null : Q.of(group.baseline.annualCashBonus);
  const rate = group.discountRateAnnual == null ? null : Number(group.discountRateAnnual);
  const monthly = rate === null ? null : Math.pow(1 + rate, 1 / 12) - 1;
  const mb = (iso) => { let n = (Number(iso.slice(0, 4)) - Number(group.startDate.slice(0, 4))) * 12 + Number(iso.slice(5, 7)) - Number(group.startDate.slice(5, 7)); if (am(group.startDate, n) > iso) n--; return n; };
  const out = [];
  for (const sc of scenarioSet.scenarios) {
    const E = am(S, sc.serviceMonths); const L = sc.liquidity.occurs ? am(S, sc.liquidity.monthsFromStart) : null;
    const realizeIn = L !== null && L <= H;
    const post = sc.postServiceAnnualCash == null ? null : Q.of(sc.postServiceAnnualCash);
    let nServ = 0, nPost = 0; const dated = []; // [date, Q]
    for (let k = 0; ; k++) { const d = am(S, k); if (d >= H) break; if (k < sc.serviceMonths) { nServ++; dated.push([d, 'serv']); } else if (post !== null) { nPost++; dated.push([d, 'post']); } }
    const n12 = (a, n) => (a === null ? null : a.mul(qi(n)).div(qi(12)));
    const offerBase = ob === null ? null : n12(ob, nServ).add(post ? n12(post, nPost) : Z);
    const offerBonus = obo === null ? null : n12(obo, nServ);
    const nAll = nServ + nPost;
    const baselineBase = n12(bb, nAll), baselineBonus = n12(bbo, nAll);
    const baseDiff = baselineBase && offerBase ? baselineBase.sub(offerBase) : null;
    const tcd = baseDiff && baselineBonus && offerBonus ? baseDiff.add(baselineBonus.sub(offerBonus)) : null;
    const flows = []; // [date, Q, kind]
    if (ob && bb && obo && bbo) for (const [d, t] of dated) {
      const o = t === 'serv' ? ob.add(obo) : post; flows.push([d, o.sub(bb.add(bbo)).div(qi(12)), 'cash']);
    }
    let signNet = Z;
    if (sign && sign.cmp(Z) > 0) {
      if (S <= H) { flows.push([S, sign, 'signing']); signNet = signNet.add(sign); }
      const rm = offer.cash.signingRepaymentMonths ?? null;
      if (rm !== null && sc.serviceMonths < rm && E <= H) { flows.push([E, Z.sub(sign), 'signing']); signNet = signNet.sub(sign); }
    }
    const grants = []; let allKnown = true; const parts = []; let beKnown = true; const eqFlows = [];
    for (const g of offer.grants) {
      const r = { vestedUnits: null, eligibleUnits: null, exerciseCost: null, realizedProceeds: null, residual: null };
      if (!['iso', 'nso'].includes(g.instrument)) { allKnown = false; beKnown = false; grants.push(r); continue; }
      const path = sc.exercisePath.kind; const method = sc.payout.method;
      const XD = path === 'at_date' ? am(S, sc.exercisePath.exerciseMonthsFromStart) : null;
      const exercising = path === 'at_date' ? XD <= H : realizeIn;
      const exDate = path === 'at_date' ? XD : L;
      const checkAt = exercising ? exDate : H;
      const vd = exercising ? (exDate < E ? exDate : E) : (E < H ? E : H);
      const fr = vestFrac(g, vd); const Us = usable(g.units); const U = Us === null ? null : BigInt(Us);
      const Ks = usable(g.strikePrice); const K = Ks === null ? null : Q.of(Ks);
      const vested = fr && U !== null ? (U * fr.m) / fr.T : null;
      r.vestedUnits = vested === null ? null : vested.toString();
      let unknown = false, expired = false;
      if (checkAt > E) {
        const w = usable(g.exercise.postTerminationWindowMonths);
        if (w === null) unknown = true; else if (am(E, Math.floor(Number(w))) < checkAt) expired = true;
      }
      const gd = usable(g.grantDate), ey = usable(g.exercise.expirationYears);
      if (ey === null) unknown = true;
      else {
        const mo = Q.of(ey).mul(qi(12)); const months = Number(mo.n / mo.d);
        if (gd !== null) { if (checkAt > am(gd, months)) expired = true; }
        else if (checkAt > am(offer.asOfDate, months)) unknown = true;
      }
      const elig = expired ? false : unknown ? null : true;
      if (!exercising) {
        const units = elig === false ? 0n : elig === true ? vested : null;
        Object.assign(r, { eligibleUnits: units === null ? null : units.toString(), realizedProceeds: '0.00', residual: units === null ? null : units.toString() });
        if (units !== null) {
          const cost = units === 0n ? Z : K ? qi(units).mul(K) : null;
          r.exerciseCost = fmt(cost, 2); if (cost) parts.push({ u: units, K: K ?? Z, path }); else beKnown = false;
        } else beKnown = false;
        grants.push(r); continue;
      }
      if (elig === false) {
        Object.assign(r, { eligibleUnits: '0', exerciseCost: '0.00', realizedProceeds: '0.00', residual: realizeIn ? null : '0' }); grants.push(r); continue;
      }
      if (elig === null) { allKnown = false; beKnown = false; grants.push(r); continue; }
      r.eligibleUnits = vested === null ? null : vested.toString();
      const cost = vested === null ? null : vested === 0n ? Z : K ? qi(vested).mul(K) : null;
      r.exerciseCost = fmt(cost, 2);
      if (cost) parts.push({ u: vested, K: K ?? Z, path }); else beKnown = false;
      let gross = null;
      if (method === 'none') gross = Z;
      else if (method === 'common_per_share') gross = vested === null ? null : qi(vested).mul(Q.of(sc.payout.commonProceedsPerShare));
      else if (method === 'pro_rata_shares') gross = vested === null ? null : qi(vested).mul(Q.of(sc.payout.equityExitValue)).div(qi(sc.payout.fullyDilutedExitShares));
      else {
        const pct = usable(g.quotedOwnershipPct);
        if (pct !== null) {
          let ret = new Q(1n); for (const d of sc.payout.dilutionRounds) ret = ret.mul(new Q(1n).sub(Q.of(d)));
          const fraction = U !== null ? (U === 0n ? Z : qi(vested).div(qi(U))) : new Q(fr.m, fr.T);
          gross = Q.of(pct).div(qi(100)).mul(ret).mul(Q.of(sc.payout.equityExitValue)).mul(fraction);
        }
      }
      let realized = null;
      if (path === 'at_liquidity') {
        if (method === 'none') realized = Z;
        else if (gross && cost) { realized = gross.sub(cost); if (realized.cmp(Z) < 0) realized = Z; if (!realized.isZero()) eqFlows.push([L, realized]); }
      } else if (cost) {
        if (!cost.isZero()) eqFlows.push([exDate, Z.sub(cost)]);
        if (!realizeIn) realized = Z; else if (gross) { realized = gross; if (!gross.isZero()) eqFlows.push([L, gross]); }
      }
      if (realized === null) { allKnown = false; }
      r.realizedProceeds = fmt(realized, 2);
      r.residual = realizeIn ? null : (vested === null ? null : vested.toString());
      grants.push(r);
    }
    // Drop equity flows if unknown (matches contract: unknown net)
    const net = tcd && sign !== null && allKnown ? Z.sub(tcd).add(signNet).add(eqFlows.reduce((s, [, a]) => s.add(a), Z)) : null;
    let funding = null;
    if (allKnown) { const srt = [...eqFlows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1].cmp(b[1]))); let run = Z, low = Z; for (const [, a] of srt) { run = run.add(a); if (run.cmp(low) < 0) low = run; } funding = Z.sub(low); }
    let npv = null;
    if (monthly !== null && net !== null) {
      npv = Z;
      for (const [d, a] of [...flows, ...eqFlows]) { const f12 = BigInt(Math.round(Math.pow(1 + monthly, -mb(d)) * 1e12)); npv = npv.add(a.mul(new Q(f12, 10n ** 12n))); }
    }
    let be = null; let beCode = null;
    if (tcd && sign !== null && allKnown && beKnown) {
      const F = tcd.sub(signNet);
      if (F.cmp(Z) <= 0) { be = '0'; beCode = 'offer_pays_more'; }
      else if (!realizeIn) beCode = 'no_solution';
      else {
        // equity(P) = sum at_date u(P-K) + sum at_liq u*max(P-K,0); monotone; search breakpoints.
        const live = parts.filter((p) => p.u > 0n);
        const eq = (P) => live.reduce((s, p) => { const x = P.sub(p.K).mul(qi(p.u)); return s.add(p.path === 'at_date' ? x : (x.cmp(Z) > 0 ? x : Z)); }, Z);
        const slopeAbove = (P) => live.filter((p) => p.path === 'at_date' || p.K.cmp(P) <= 0).reduce((s, p) => s + p.u, 0n);
        const bps = [Z, ...live.map((p) => p.K)].sort((a, b) => a.cmp(b));
        let sol = null;
        // find smallest P >= 0? reference: smallest P (any sign) with eq(P)=F
        const at = live.filter((p) => p.path === 'at_date');
        const startP = at.length ? new Q(-(10n ** 30n)) : Z;
        const pts = [startP, ...bps.filter((b) => b.cmp(startP) > 0)];
        for (let i = 0; i < pts.length && !sol; i++) {
          const lo = pts[i]; const s = slopeAbove(lo); if (s === 0n) continue;
          const P = lo.add(F.sub(eq(lo)).div(qi(s)));
          const hi = pts[i + 1]; if (P.cmp(lo) >= 0 && (!hi || P.cmp(hi) <= 0)) sol = P;
        }
        if (sol) be = fmt(sol, 6); else beCode = 'no_solution';
      }
    }
    out.push({ scenarioId: sc.scenarioId, cash: { offerBase: fmt(offerBase, 2), offerBonus: fmt(offerBonus, 2), baselineBase: fmt(baselineBase, 2), baselineBonus: fmt(baselineBonus, 2), baseDifference: fmt(baseDiff, 2), totalCashDifference: fmt(tcd, 2) }, grants, maxCumulativeFundingNeed: fmt(funding, 2), netPreTax: fmt(net, 2), npv: fmt(npv, 2), breakEvenCommonPrice: be, _net: net, _beCode: beCode });
  }
  const ws = scenarioSet.scenarios.map((s) => s.weightPct);
  let weighted = null;
  if (ws.every((w) => w != null)) { const sum = ws.reduce((s, w) => s.add(Q.of(w)), Z); if (sum.cmp(qi(100)) === 0 && out.every((o) => o._net)) weighted = { expectedNetPreTax: fmt(out.reduce((s, o, i) => s.add(o._net.mul(Q.of(ws[i]))), Z).div(qi(100)), 2) }; }
  return { scenarios: out, weighted };
}
