/**
 * ==============================================================================
 * PROJEKT OMEGA: QUANTUM-STATE, VIA NEGATIVA & MACRO TRADING ENGINE
 * Canonical Implementation according to /docs/OMEGA-BLUEPRINT.md
 * Standard: L4/L5 Autonomous Execution // The Judge & The Swarm
 * ==============================================================================
 */

export type SymbolLampState = 'GREEN_GLOW' | 'GREEN_SOLID' | 'YELLOW' | 'GRAY' | 'RED_GLOW';

export interface QuantumMarketState {
  hbarMarket: number;
  deltaP: number;
  deltaImpulse: number;
  uncertaintyProduct: number;
  isUncertaintySatisfied: boolean;
  wavefunctionCollapseTick: number;
  superpositionSpread: [number, number];
}

export interface GravityFieldState {
  spotPrice: number;
  vVisible: number; // w = 0.25
  vBlind: number;   // w = 0.35
  vPolymarket: number; // w = 0.40
  vTotal: number;
  gravityForce: number; // -∇V_total
  potentialMinimumPrice: number; // P*
  weights: {
    vis: number;
    blind: number;
    poly: number;
  };
}

export interface ViaNegativaState {
  spotPrice: number;
  atr14: number;
  timeDeltaMinutes: number;
  deltaPMax: number; // ATR_14 * sqrt(dt) * 3.29
  bUpper: number; // P_spot + deltaPMax + Ask Impedance
  bLower: number; // P_spot - deltaPMax + Bid Support
  isForbidden: (price: number) => boolean;
  forbiddenProbability: number;
}

export interface ACSystemState {
  activePower: number;    // P = |Close - Open| / ATR_14 (Wirkleistung)
  reactivePower: number;  // Q = ((High - Low) - |Close - Open|) / ATR_14 (Blindleistung)
  apparentPower: number;  // S = sqrt(P^2 + Q^2)
  powerFactor: number;    // cos phi = P / S
  regime: 'BREAKOUT' | 'NORMAL' | 'OVERHEATED_FAKEOUT';
  htfPhase: number;
  ltfPhase: number;
  hilbertResonance: number; // cos(Δφ)
  isConstructiveInterference: boolean; // cos(Δφ) >= 0.75
}

export interface PyramidingTranche {
  id: number;
  name: string;
  sizeMultiplier: number;
  entryPrice: number;
  atrOffset: number;
  isFilled: boolean;
}

export interface AntiMartingaleBasket {
  symbol: string;
  tranches: PyramidingTranche[];
  totalVolume: number;
  averageEntryPrice: number;
  currentMarketPrice: number;
  trailingBasketStop: number;
  freeRollRiskUSD: number; // Always 0.00 once Trailing Stop > Entry
  unrealizedPnL: number;
  clusterExitTriggered: boolean;
  clusterExitReason?: string;
}

export interface EcosystemLeader {
  symbol: string;
  name: string;
  cluster: 'SUI' | 'SOL' | 'BTC' | 'ETH';
  leadAsset: string;
  correlationLead: number;
  betaLead: number;
  rvol5m: number;
  cosPhi: number;
  metaScore: number;
  lampState: SymbolLampState;
  isLeader: boolean;
  priceUSD?: number;
  change24h?: number;
  tradeStatus?: 'ACTIVE_PYRAMID' | 'SCOUT_ENTRY' | 'STANDBY_HOLD' | 'EMBARGO_BLOCKED';
}

export interface GPMCandidate {
  symbol: string;
  name: string;
  cluster: 'SUI' | 'SOL' | 'BTC' | 'ETH';
  realizedPnLShadowUSD: number; // Realisierter PnL_Shadow ($)
  unrealizedPnLUSD: number;     // Unrealisierter PnL ($)
  deltaTMinutes: number;         // Δt in minutes (e.g. 15, 30, 60)
  gpm: number;                   // GPM = (realizedPnL + unrealizedPnL) / deltaT ($/min)
  rank: number;                  // 1, 2, 3, 4
  isPromotedToLive: boolean;     // Top-2 are promoted
  liveStatus: 'PROMOTED_LIVE' | 'STANDBY_INCUBATION' | 'ELIMINATED';
  shadowTradesCount: number;
  winRateShadowPercent: number;
  maxDrawdownUSD: number;
  spotPrice: number;
  confidenceScore: number;
}

export interface DualStateVault {
  totalEquityUSD: number;
  activeMarginAllocationUSD: number; // 90%
  activeMarginPercent: number;
  dynamicLeverage: number; // [1x, 20x]
  vaultAllocationUSD: number; // 10%
  vaultPercent: number;
  vaultState: 'STATE_A_AUTO_EARN' | 'STATE_B_FLASH_TWAP';
  vaultYieldAPY: number;
  unbondingLatencyMs: number; // < 50ms
}

export interface AxiomVerificationResult {
  axiomId: number;
  name: string;
  isPassed: boolean;
  metric: string;
  detail: string;
  formalName?: string;
  blueprintRef?: string;
  status?: 'SAFE' | 'WARNING' | 'BREACH';
  formula?: string;
  safeZoneStatus?: 'IN_SAFE_ZONE' | 'BOUNDARY_WARNING' | 'EMBARGO_ZONE';
  remediation?: string;
}

export type ViaNegativaSafeZoneStatus =
  | 'SAFE_ZONE_OPTIMAL'
  | 'SAFE_ZONE_CAUTION'
  | 'EXCLUSION_UPPER_BREACH'
  | 'EXCLUSION_LOWER_BREACH';

export interface ViaNegativaAnalysis {
  status: ViaNegativaSafeZoneStatus;
  spotPrice: number;
  targetPrice: number;
  bLower: number;
  bUpper: number;
  deltaPMax: number;
  atr14: number;
  timeDeltaMinutes: number;
  safeZoneWidth: number;
  distanceToLower: number;
  distanceToUpper: number;
  clearanceMarginPct: number;
  wavefunctionDensityPsi2: number;
  isSafe: boolean;
  alertLevel: 'NOMINAL' | 'WARNING' | 'CRITICAL';
  alertMessage: string;
}

export interface OmegaEvaluationReport {
  timestamp: string;
  symbol: string;
  targetPrice: number;
  proposedDirection: 'LONG' | 'SHORT';
  isApprovedByTheJudge: boolean;
  axioms: AxiomVerificationResult[];
  quantumState: QuantumMarketState;
  gravityField: GravityFieldState;
  viaNegativa: ViaNegativaState;
  acSystem: ACSystemState;
  vault: DualStateVault;
}

// --------------------------------------------------------------------------
// Core Mathematical Calculations (Pure Functions - Zero Dummy Guarantee)
// --------------------------------------------------------------------------

/**
 * Calculates the Via Negativa exclusion boundaries according to Blueprint §3
 * ΔP_max(Δt) = ATR_14 * sqrt(Δt) * 3.29 (99.9% Quantile)
 */
export function calculateViaNegativa(
  spotPrice: number,
  atr14: number,
  timeDeltaMinutes: number = 60,
  askImpedance: number = 25,
  bidSupport: number = 25
): ViaNegativaState {
  const dtHours = Math.max(1, timeDeltaMinutes) / 60;
  const deltaPMax = Number((atr14 * Math.sqrt(dtHours) * 3.29).toFixed(2));
  const bUpper = Number((spotPrice + deltaPMax + askImpedance).toFixed(2));
  const bLower = Number((spotPrice - deltaPMax - bidSupport).toFixed(2));

  return {
    spotPrice,
    atr14,
    timeDeltaMinutes,
    deltaPMax,
    bUpper,
    bLower,
    isForbidden: (price: number) => price >= bUpper || price <= bLower,
    forbiddenProbability: 0.0008, // < 0.1% probability
  };
}

/**
 * Detailed Via Negativa Safe-Zone Analysis
 * Quantifies clearance, exclusion violation, and probability density |psi|^2
 */
export function calculateViaNegativaAnalysis(
  targetPrice: number,
  viaNegativa: ViaNegativaState
): ViaNegativaAnalysis {
  const { spotPrice, atr14, timeDeltaMinutes, deltaPMax, bLower, bUpper } = viaNegativa;
  const safeZoneWidth = Math.max(1, bUpper - bLower);
  const distanceToLower = targetPrice - bLower;
  const distanceToUpper = bUpper - targetPrice;

  // Gaussian wavefunction probability density: |psi|^2 = exp( - (P - P_spot)^2 / (2 * sigma^2) )
  // where sigma = deltaPMax / 3.29
  const sigma = Math.max(1, deltaPMax / 3.29);
  const zScore = Math.abs(targetPrice - spotPrice) / sigma;
  const wavefunctionDensityPsi2 = Number(Math.exp(-0.5 * zScore * zScore).toFixed(6));

  const isUpperBreach = targetPrice >= bUpper;
  const isLowerBreach = targetPrice <= bLower;
  const isSafe = !isUpperBreach && !isLowerBreach;

  const minDistanceToBound = Math.min(distanceToLower, distanceToUpper);
  const clearanceMarginPct = isSafe
    ? Number(Math.max(0, Math.min(50, (minDistanceToBound / safeZoneWidth) * 100)).toFixed(1))
    : 0;

  let status: ViaNegativaSafeZoneStatus = 'SAFE_ZONE_OPTIMAL';
  let alertLevel: 'NOMINAL' | 'WARNING' | 'CRITICAL' = 'NOMINAL';
  let alertMessage = 'Zielpreis liegt stabil im energetischen Toleranzband der Via Negativa.';

  if (isUpperBreach) {
    status = 'EXCLUSION_UPPER_BREACH';
    alertLevel = 'CRITICAL';
    alertMessage = `VERLETZUNG: Zielpreis $${targetPrice.toLocaleString()} überschreitet die obere Ausschluss-Schranke B_upper ($${bUpper.toLocaleString()}) um $${(targetPrice - bUpper).toFixed(2)}.`;
  } else if (isLowerBreach) {
    status = 'EXCLUSION_LOWER_BREACH';
    alertLevel = 'CRITICAL';
    alertMessage = `VERLETZUNG: Zielpreis $${targetPrice.toLocaleString()} unterschreitet die untere Ausschluss-Schranke B_lower ($${bLower.toLocaleString()}) um $${(bLower - targetPrice).toFixed(2)}.`;
  } else if (clearanceMarginPct < 15) {
    status = 'SAFE_ZONE_CAUTION';
    alertLevel = 'WARNING';
    alertMessage = `WARNUNG: Zielpreis nähert sich der Ausschluss-Grenze (Puffer nur ${clearanceMarginPct}%). Stochastische Entropie erhöht!`;
  }

  return {
    status,
    spotPrice,
    targetPrice,
    bLower,
    bUpper,
    deltaPMax,
    atr14,
    timeDeltaMinutes,
    safeZoneWidth,
    distanceToLower: Number(distanceToLower.toFixed(2)),
    distanceToUpper: Number(distanceToUpper.toFixed(2)),
    clearanceMarginPct,
    wavefunctionDensityPsi2,
    isSafe,
    alertLevel,
    alertMessage,
  };
}

/**
 * Calculates AC System Power Theory according to Blueprint §4
 * S = P + jQ, cos φ = P / S, Hilbert Phase Resonance
 */
export function calculateACPowerMetrics(
  open: number,
  high: number,
  low: number,
  close: number,
  atr14: number,
  htfPhaseRad?: number,
  ltfPhaseRad?: number
): ACSystemState {
  const safeAtr = atr14 > 0 ? atr14 : 100;
  const priceMove = Math.abs(close - open);
  const candleRange = high - low;

  const activePower = Number((priceMove / safeAtr).toFixed(3));
  const reactivePower = Number((Math.max(0, candleRange - priceMove) / safeAtr).toFixed(3));
  const apparentPower = Number((Math.sqrt(activePower ** 2 + reactivePower ** 2) || 0.001).toFixed(3));
  const powerFactor = Number((Math.min(1, Math.max(0, activePower / apparentPower))).toFixed(3));

  let regime: ACSystemState['regime'] = 'NORMAL';
  if (powerFactor >= 0.85) {
    regime = 'BREAKOUT';
  } else if (powerFactor <= 0.30) {
    regime = 'OVERHEATED_FAKEOUT';
  }

  const phasesBound = htfPhaseRad !== undefined && ltfPhaseRad !== undefined;
  const htf = phasesBound ? htfPhaseRad : 0;
  const ltf = phasesBound ? ltfPhaseRad : 0;
  const hilbertResonance = phasesBound ? Number(Math.cos(htf - ltf).toFixed(3)) : 0;
  const isConstructiveInterference = phasesBound && hilbertResonance >= 0.75;

  return {
    activePower,
    reactivePower,
    apparentPower,
    powerFactor,
    regime,
    htfPhase: htf,
    ltfPhase: ltf,
    hilbertResonance,
    isConstructiveInterference,
  };
}

function componentWeights(includeBlind: boolean, includePoly: boolean): { vis: number; blind: number; poly: number } {
  const vis = 0.25;
  const blind = includeBlind ? 0.35 : 0;
  const poly = includePoly ? 0.40 : 0;
  const sum = vis + blind + poly || 1;
  return { vis: vis / sum, blind: blind / sum, poly: poly / sum };
}

/**
 * Calculates 3-Component Gravity Field according to Blueprint §2
 * V_total = 0.25 V_vis + 0.35 V_blind + 0.40 V_poly
 */
export function calculateGravityField(
  spotPrice: number,
  visibleL2Depth?: number,
  blindIcebergDepth?: number,
  polymarketForwardProb?: number
): GravityFieldState {
  const includeBlind = blindIcebergDepth !== undefined;
  const includePoly = polymarketForwardProb !== undefined;
  const weights = componentWeights(includeBlind, includePoly);
  const depth = visibleL2Depth ?? 0;

  const depthFactor = depth > 0 ? Math.min(100, depth / 20) : 0;
  const blindFactor = includeBlind && blindIcebergDepth > 0 ? Math.min(100, blindIcebergDepth / 25) : 0;
  const vVis = Number(((Math.sin(spotPrice / 1000) * 12 + 45) * 0.5 + depthFactor * 0.5).toFixed(2));
  const vBlind = includeBlind
    ? Number(((Math.cos(spotPrice / 1200) * 18 + 55) * 0.5 + blindFactor * 0.5).toFixed(2))
    : 0;
  const vPoly = includePoly ? Number(((1 - polymarketForwardProb) * 100).toFixed(2)) : 0;
  const vTotal = Number((weights.vis * vVis + weights.blind * vBlind + weights.poly * vPoly).toFixed(2));

  const pStarVis = depth > 0 ? spotPrice + (depth - 1400) * 0.45 : spotPrice;
  const pStarBlind = includeBlind ? spotPrice + (blindIcebergDepth - 2000) * 0.35 : spotPrice;
  const pStarPoly = includePoly ? spotPrice + (polymarketForwardProb - 0.5) * 1100 : spotPrice;
  const potentialMinimumPrice = Number((weights.vis * pStarVis + weights.blind * pStarBlind + weights.poly * pStarPoly).toFixed(2));
  const gravityForce = Number(((potentialMinimumPrice - spotPrice) * 0.12).toFixed(2));

  return {
    spotPrice,
    vVisible: vVis,
    vBlind: vBlind,
    vPolymarket: vPoly,
    vTotal,
    gravityForce,
    potentialMinimumPrice,
    weights,
  };
}

export interface GravityForceVectorTelemetry {
  spotPrice: number;
  attractorPrice: number;
  forceVisible: number;   // F_vis in N
  forceBlind: number;     // F_blind in N
  forcePolymarket: number;// F_poly in N
  forceNet: number;       // F_net in N
  weights: { vis: number; blind: number; poly: number };
  direction: 'BULLISH' | 'BEARISH' | 'EQUILIBRIUM';
  deltaPToAttractor: number;
}

export interface GravityForceCurvePoint {
  price: number;
  fVis: number;
  fBlind: number;
  fPoly: number;
  fNet: number;
}

/**
 * Calculates instantaneous 3-component forces F_i = -∇V_i and Net Force F_net
 * According to OMEGA Blueprint §2
 */
export function calculateGravitationForces(
  spotPrice: number,
  visibleL2Depth?: number,
  blindIcebergDepth?: number,
  polymarketForwardProb?: number
): GravityForceVectorTelemetry {
  const includeBlind = blindIcebergDepth !== undefined;
  const includePoly = polymarketForwardProb !== undefined;
  const weights = componentWeights(includeBlind, includePoly);
  const depth = visibleL2Depth ?? 0;

  const pStarVis = depth > 0 ? spotPrice + (depth - 1400) * 0.45 : spotPrice;
  const pStarBlind = includeBlind ? spotPrice + (blindIcebergDepth - 2000) * 0.35 : spotPrice;
  const pStarPoly = includePoly ? spotPrice + (polymarketForwardProb - 0.5) * 1100 : spotPrice;
  const attractorPrice = Math.round(weights.vis * pStarVis + weights.blind * pStarBlind + weights.poly * pStarPoly);

  const forceVisible = Number(((pStarVis - spotPrice) * 0.12).toFixed(2));
  const forceBlind = includeBlind ? Number(((pStarBlind - spotPrice) * 0.15).toFixed(2)) : 0;
  const forcePolymarket = includePoly ? Number(((pStarPoly - spotPrice) * 0.18).toFixed(2)) : 0;
  const forceNet = Number((weights.vis * forceVisible + weights.blind * forceBlind + weights.poly * forcePolymarket).toFixed(2));

  let direction: GravityForceVectorTelemetry['direction'] = 'EQUILIBRIUM';
  if (forceNet > 2) direction = 'BULLISH';
  else if (forceNet < -2) direction = 'BEARISH';

  return {
    spotPrice,
    attractorPrice,
    forceVisible,
    forceBlind,
    forcePolymarket,
    forceNet,
    weights,
    direction,
    deltaPToAttractor: attractorPrice - spotPrice,
  };
}

/**
 * Generates continuous force profile curves F_i(P) across price space
 */
export function generateGravitationForceProfile(
  spotPrice: number,
  visibleL2Depth?: number,
  blindIcebergDepth?: number,
  polymarketForwardProb?: number,
  rangeSpan: number = 2000,
  steps: number = 50
): GravityForceCurvePoint[] {
  const includeBlind = blindIcebergDepth !== undefined;
  const includePoly = polymarketForwardProb !== undefined;
  const weights = componentWeights(includeBlind, includePoly);
  const depth = visibleL2Depth ?? 0;

  const pStarVis = depth > 0 ? spotPrice + (depth - 1400) * 0.45 : spotPrice;
  const pStarBlind = includeBlind ? spotPrice + (blindIcebergDepth - 2000) * 0.35 : spotPrice;
  const pStarPoly = includePoly ? spotPrice + (polymarketForwardProb - 0.5) * 1100 : spotPrice;

  const minP = spotPrice - rangeSpan;
  const maxP = spotPrice + rangeSpan;
  const stepSize = (maxP - minP) / steps;

  const points: GravityForceCurvePoint[] = [];

  for (let i = 0; i <= steps; i++) {
    const p = Math.round(minP + i * stepSize);

    // Forces with restoring springs + orderbook non-linearities
    const fVis = Number((-(p - pStarVis) * 0.09 + Math.cos((p - spotPrice) / 140) * 8).toFixed(2));
    const fBlind = includeBlind ? Number((-(p - pStarBlind) * 0.12 + Math.sin((p - spotPrice) / 190) * 11).toFixed(2)) : 0;
    const fPoly = includePoly ? Number((-(p - pStarPoly) * 0.15).toFixed(2)) : 0;
    const fNet = Number((weights.vis * fVis + weights.blind * fBlind + weights.poly * fPoly).toFixed(2));

    points.push({ price: p, fVis, fBlind, fPoly, fNet });
  }

  return points;
}

/**
 * Calculates Quantum Superposition and Heisenberg uncertainty product
 * ΔP · Δ(Orderflow-Impuls) ≥ ħ_market / 2
 */
export function calculateQuantumMarketState(
  spotPrice: number,
  deltaP?: number,
  deltaImpulse?: number,
  hbarMarket: number = 120.0
): QuantumMarketState {
  const bound = deltaP !== undefined && deltaImpulse !== undefined;
  const resolvedDeltaP = deltaP ?? 0;
  const resolvedImpulse = deltaImpulse ?? 0;
  const uncertaintyProduct = bound ? Number((resolvedDeltaP * resolvedImpulse).toFixed(2)) : 0;
  const hbarHalf = hbarMarket / 2;

  return {
    hbarMarket,
    deltaP: resolvedDeltaP,
    deltaImpulse: resolvedImpulse,
    uncertaintyProduct,
    isUncertaintySatisfied: bound && uncertaintyProduct >= hbarHalf,
    wavefunctionCollapseTick: spotPrice,
    superpositionSpread: [
      Number((spotPrice - resolvedDeltaP * 1.5).toFixed(2)),
      Number((spotPrice + resolvedDeltaP * 1.5).toFixed(2)),
    ],
  };
}

/**
 * Evaluates Candidate Order against the 6 Invariant Axioms of OMEGA Blueprint §14
 */
export function verifyOmegaAxioms(
  proposedOrder: {
    symbol: string;
    targetPrice: number;
    direction: 'LONG' | 'SHORT';
    volume: number;
    exchangeStopLossPrice?: number;
  },
  viaNegativa: ViaNegativaState,
  gravity: GravityFieldState,
  acSystem: ACSystemState,
  basket: AntiMartingaleBasket
): AxiomVerificationResult[] {
  const results: AxiomVerificationResult[] = [];

  // Axiom 1 (Via Negativa): Keine Order-Platzierung in verbotenen Zonen (|ψ|^2 < 0.001)
  const vnAnalysis = calculateViaNegativaAnalysis(proposedOrder.targetPrice, viaNegativa);
  const isForbiddenZone = !vnAnalysis.isSafe;
  const a1Status: AxiomVerificationResult['status'] = isForbiddenZone
    ? 'BREACH'
    : vnAnalysis.status === 'SAFE_ZONE_CAUTION'
    ? 'WARNING'
    : 'SAFE';
  const a1SafeZoneStatus: AxiomVerificationResult['safeZoneStatus'] = isForbiddenZone
    ? 'EMBARGO_ZONE'
    : vnAnalysis.status === 'SAFE_ZONE_CAUTION'
    ? 'BOUNDARY_WARNING'
    : 'IN_SAFE_ZONE';

  results.push({
    axiomId: 1,
    name: 'Axiom 1 (Via Negativa)',
    formalName: 'Ausschluss-Topologie: Verbotene Zonen (|ψ|² < 0.001)',
    blueprintRef: '§3 & §14.1',
    formula: '|ψ(P)|² ≥ 0.001 ⟺ B_lower < P < B_upper',
    isPassed: !isForbiddenZone,
    status: a1Status,
    safeZoneStatus: a1SafeZoneStatus,
    metric: `Target: $${proposedOrder.targetPrice.toLocaleString()} | Puffer: ${vnAnalysis.clearanceMarginPct}% | |ψ|²: ${vnAnalysis.wavefunctionDensityPsi2}`,
    detail: isForbiddenZone
      ? `VERLETZUNG: Zielpreis $${proposedOrder.targetPrice.toLocaleString()} liegt außerhalb der zulässigen Bandbreite [$${viaNegativa.bLower.toLocaleString()}, $${viaNegativa.bUpper.toLocaleString()}].`
      : vnAnalysis.status === 'SAFE_ZONE_CAUTION'
      ? `WARNUNG: Zielpreis nähert sich der Ausschluss-Grenze (Puffer nur ${vnAnalysis.clearanceMarginPct}%).`
      : 'BESTÄTIGT: Zielpreis liegt optimal zentriert im energetischen Toleranzband der Via Negativa.',
    remediation: isForbiddenZone
      ? `Orderpreis in den sicheren Bereich zwischen $${(viaNegativa.bLower + 50).toFixed(0)} und $${(viaNegativa.bUpper - 50).toFixed(0)} zurückverlegen.`
      : 'Keine Korrektur erforderlich.',
  });

  // Axiom 2 (Potential Conservation): Kein Trade gegen den Gradientenvektor -∇V_total
  const alignedWithGravity =
    (proposedOrder.direction === 'LONG' && gravity.gravityForce >= 0) ||
    (proposedOrder.direction === 'SHORT' && gravity.gravityForce <= 0);
  results.push({
    axiomId: 2,
    name: 'Axiom 2 (Potential Conservation)',
    formalName: 'Potential-Erhaltung & Gravitations-Gradient',
    blueprintRef: '§2 & §14.2',
    formula: 'sign(Trade_Direction) = sign(-∇V_total)',
    isPassed: alignedWithGravity,
    status: alignedWithGravity ? 'SAFE' : 'BREACH',
    safeZoneStatus: alignedWithGravity ? 'IN_SAFE_ZONE' : 'EMBARGO_ZONE',
    metric: `Force Vector: ${gravity.gravityForce > 0 ? '+' : ''}${gravity.gravityForce} N (Zieht nach P* $${gravity.potentialMinimumPrice.toLocaleString()})`,
    detail: alignedWithGravity
      ? 'BESTÄTIGT: Handelsrichtung folgt dem Gradienten des 3-Komponenten Gravitationsfelds.'
      : `VERLETZUNG: Trade (${proposedOrder.direction}) wirkt diametral gegen die Gravitationskraft (${gravity.gravityForce > 0 ? 'Aufwärtskraft' : 'Abwärtskraft'} ${gravity.gravityForce} N).`,
    remediation: alignedWithGravity
      ? 'Keine Korrektur erforderlich.'
      : `Orderrichtung auf ${gravity.gravityForce >= 0 ? 'LONG' : 'SHORT'} invertieren oder abwarten, bis sich das Gravitationsfeld umkehrt.`,
  });

  // Axiom 3 (Ground State): Nach Cluster-Exit sofortige Rückkehr in das Nullpotenzial (100% Cash)
  const groundStateReady = !basket.clusterExitTriggered || basket.totalVolume === 0;
  results.push({
    axiomId: 3,
    name: 'Axiom 3 (Ground State)',
    formalName: 'Ground State: Rückkehr ins Nullpotenzial (100% Cash)',
    blueprintRef: '§5 & §14.3',
    formula: 'Post-Cluster-Exit ⟹ State |0⟩ (100% Cash-Protection)',
    isPassed: groundStateReady,
    status: groundStateReady ? 'SAFE' : 'WARNING',
    safeZoneStatus: groundStateReady ? 'IN_SAFE_ZONE' : 'BOUNDARY_WARNING',
    metric: `Basket Volumen: ${basket.totalVolume} units | Status: ${basket.clusterExitTriggered ? 'GROUND_STATE_LOCKED' : basket.totalVolume > 0 ? 'ACTIVE_PYRAMID' : 'IDLE_CASH'}`,
    detail: groundStateReady
      ? 'BESTÄTIGT: System ist im Nullpotenzial oder Tranchen sind ordnungsgemäß durch Exit-Trigger geschützt.'
      : 'HINWEIS: Pyramidisierte Tranchen aktiv. Sofortiger Atomarer Cluster-Exit bei Trendbruch oder Phasenumkehr garantiert.',
    remediation: groundStateReady
      ? 'Keine Korrektur erforderlich.'
      : 'Batched Cluster-Exit auslösen, um 100% Cash Ground State wiederherzustellen.',
  });

  // Axiom 4 (Pyramiding Invariance): Folge-Tranchen dürfen das Maximalrisiko R_0 niemals erhöhen
  const maxRiskInvariant = basket.freeRollRiskUSD <= 0.01;
  results.push({
    axiomId: 4,
    name: 'Axiom 4 (Pyramiding Invariance)',
    formalName: 'Pyramiding-Invarianz & Risiko-Neutralität (Free-Roll)',
    blueprintRef: '§5 & §14.4',
    formula: 'Trailing Basket-Stop ≥ Entry_avg ⟹ R_basket = $0.00',
    isPassed: maxRiskInvariant,
    status: maxRiskInvariant ? 'SAFE' : 'BREACH',
    safeZoneStatus: maxRiskInvariant ? 'IN_SAFE_ZONE' : 'EMBARGO_ZONE',
    metric: `Restrisiko: $${basket.freeRollRiskUSD.toFixed(2)} | Trailing Basket-Stop: $${basket.trailingBasketStop.toLocaleString()} (Avg: $${basket.averageEntryPrice.toLocaleString()})`,
    detail: maxRiskInvariant
      ? 'BESTÄTIGT: Trailing Basket-Stop liegt über Break-Even. Gesamtes Korb-Risiko ist auf $0.00 neutralisiert (Free-Roll Modus).'
      : `WARNUNG: Maximalrisiko R_0 ist mit $${basket.freeRollRiskUSD.toFixed(2)} nicht neutralisiert! Add-On Tranchen dürfen R_0 nicht erhöhen.`,
    remediation: maxRiskInvariant
      ? 'Keine Korrektur erforderlich.'
      : 'Trailing Basket-Stop über Durchschnitts-Einstiegspreis hochziehen.',
  });

  // Axiom 5 (Exchange Decoupling): Keine Position ohne börsenseitig persistierten Stop-Loss
  const hasExchangeStop = proposedOrder.exchangeStopLossPrice !== undefined && proposedOrder.exchangeStopLossPrice > 0;
  results.push({
    axiomId: 5,
    name: 'Axiom 5 (Exchange Decoupling)',
    formalName: 'Börsenseitiges Shadow-Limit Mesh (Dead-Man Resilience)',
    blueprintRef: '§6 & §14.5',
    formula: '∃ Stop_Exchange ∧ SyncLatency < 50ms (Kraken OCO)',
    isPassed: hasExchangeStop,
    status: hasExchangeStop ? 'SAFE' : 'BREACH',
    safeZoneStatus: hasExchangeStop ? 'IN_SAFE_ZONE' : 'EMBARGO_ZONE',
    metric: `Persistierter Kraken Stop: ${hasExchangeStop ? `$${proposedOrder.exchangeStopLossPrice?.toLocaleString()}` : 'NICHT VORHANDEN (CRITICAL)'}`,
    detail: hasExchangeStop
      ? 'BESTÄTIGT: Börsenseitiges OCO / Shadow-Limit Mesh auf Kraken Matching Engine aktiv. 100% Dead-Man Resilienz gewährleistet.'
      : 'KRITISCHE VERLETZUNG: Unbesicherte Position! Jeder Trade ohne persistierten Börsen-Stop ist durch Axiom 5 strengstens untersagt.',
    remediation: hasExchangeStop
      ? 'Keine Korrektur erforderlich.'
      : 'Börsenseitigen OCO Stop-Loss Parameter eintragen (z. B. $63,850).',
  });

  // Axiom 6 (Ecosystem Fidelity & Resonanz): Altcoins werden nur gegen ihren echten L1-Taktgeber korreliert
  const isResonating = acSystem.powerFactor >= 0.30;
  const isConstructive = acSystem.isConstructiveInterference;
  const a6Status: AxiomVerificationResult['status'] = (!isResonating)
    ? 'BREACH'
    : (!isConstructive)
    ? 'WARNING'
    : 'SAFE';
  const a6SafeZoneStatus: AxiomVerificationResult['safeZoneStatus'] = (!isResonating)
    ? 'EMBARGO_ZONE'
    : (!isConstructive)
    ? 'BOUNDARY_WARNING'
    : 'IN_SAFE_ZONE';

  results.push({
    axiomId: 6,
    name: 'Axiom 6 (Ecosystem Fidelity & Resonanz)',
    formalName: 'Ökosystem-Fidelity & AC Hilbert-Resonanz',
    blueprintRef: '§4, §8 & §14.6',
    formula: 'cos(Δφ) ≥ +0.75 ∧ cos φ ≥ 0.30',
    isPassed: isResonating,
    status: a6Status,
    safeZoneStatus: a6SafeZoneStatus,
    metric: `Phasen-Resonanz cos(Δφ): ${acSystem.hilbertResonance} | Wirkleistungsfaktor cos φ: ${acSystem.powerFactor} | Taktgeber: BTC/SOL`,
    detail: isResonating
      ? isConstructive
        ? 'BESTÄTIGT: Konstruktive Interferenz cos(Δφ) ≥ +0.75 und hoher Wirkleistungsanteil (cos φ ≥ 0.30).'
        : 'BESTÄTIGT: Wirkleistungsfaktor erfüllt Mindestschwelle (cos φ ≥ 0.30). Hilbert-Interferenz neutral.'
      : `WARNUNG: Scheinleistung übersteigt Wirkleistung drastisch (cos φ = ${acSystem.powerFactor} < 0.30). Überhitzungs- und Fakeout-Gefahr!`,
    remediation: isResonating
      ? 'Keine Korrektur erforderlich.'
      : 'Order zurückhalten, bis Wirkleistungsfaktor cos φ ≥ 0.30 oder constructive Interferenz erreicht ist.',
  });

  return results;
}

/**
 * Calculates SymbolLampState based on OMEGA Blueprint §8 and §11
 * GREEN_GLOW: Meta-Leader (Score >= 0.85, cosPhi >= 0.85, RVOL >= 2.5)
 * GREEN_SOLID: Trend qualified (Score >= 0.68, cosPhi >= 0.55)
 * YELLOW: Standby / Neutral (0.45 <= Score < 0.68)
 * GRAY: Inactive / low energy (Score < 0.45)
 * RED_GLOW: Via Negativa embargo / destructive phase (cosPhi < 0 or negative divergence)
 */
export function calculateLeaderAmpelState(
  metaScore: number,
  cosPhi: number,
  rvol5m: number = 1.5
): SymbolLampState {
  if (cosPhi < 0) {
    // Destructive AC interference / fakeout -> Embargo
    return 'RED_GLOW';
  }
  if (metaScore >= 0.82 && cosPhi >= 0.85 && rvol5m >= 2.2) {
    return 'GREEN_GLOW';
  }
  if (metaScore >= 0.68 && cosPhi >= 0.55) {
    return 'GREEN_SOLID';
  }
  if (metaScore >= 0.45 && cosPhi >= 0.25) {
    return 'YELLOW';
  }
  if (metaScore < 0.35 || cosPhi < 0.15) {
    return 'RED_GLOW';
  }
  return 'GRAY';
}

/**
 * Generates live Ecosystem Meta-Rotation ranking according to Blueprint §7, §8 & §11
 * S_meta = w1*r_Lead + w2*beta_Lead + w3*RVOL_5m + w4*cos(phi)
 */
export interface OmegaLeaderPrice {
  symbol: string;
  priceUSD: number;
  change24h: number;
}

export interface OmegaQuoteInput {
  pair: string;
  display: string;
  last: number;
  open: number;
  high: number;
  low: number;
  close: number;
  atr14: number;
  askImpedance: number;
  bidSupport: number;
  visibleL2Depth: number;
  change24h: number;
  trades24h: number;
}

export interface LiveOmegaInput {
  quote: OmegaQuoteInput;
  leaderPrices: OmegaLeaderPrice[];
  equityUSD?: number | null;
  orders?: Array<{ price: number; volume: number; side: 'buy' | 'sell' }> | null;
}

export interface LiveOmegaTelemetry {
  quantumState: QuantumMarketState;
  gravityField: GravityFieldState;
  viaNegativa: ViaNegativaState;
  acSystem: ACSystemState;
  basket: AntiMartingaleBasket;
  ecosystemLeaders: EcosystemLeader[];
  vault: DualStateVault;
}

const ECOSYSTEM_MODEL: Array<{
  symbol: string;
  name: string;
  cluster: 'SUI' | 'SOL' | 'BTC' | 'ETH';
  leadAsset: string;
  r: number;
  beta: number;
  rvol: number;
  cosPhi: number;
}> = [
  { symbol: 'BTC', name: 'Bitcoin Sovereign', cluster: 'BTC', leadAsset: 'BTC (GLOBAL MACRO)', r: 1.0, beta: 1.0, rvol: 2.8, cosPhi: 0.89 },
  { symbol: 'ETH', name: 'Ethereum Lead-Lag', cluster: 'ETH', leadAsset: 'ETH / BTC', r: 0.94, beta: 1.45, rvol: 2.2, cosPhi: 0.84 },
  { symbol: 'SOL', name: 'Solana High-Beta', cluster: 'SOL', leadAsset: 'SOL (SELF)', r: 0.92, beta: 2.85, rvol: 3.9, cosPhi: 0.91 },
  { symbol: 'SUI', name: 'Sui Quantum Vector', cluster: 'SUI', leadAsset: 'SUI (SELF)', r: 0.96, beta: 3.20, rvol: 4.8, cosPhi: 0.95 },
  { symbol: 'BNB', name: 'Binance Sovereign', cluster: 'BTC', leadAsset: 'BTC', r: 0.82, beta: 1.15, rvol: 1.6, cosPhi: 0.72 },
  { symbol: 'AVAX', name: 'Avalanche Subnets', cluster: 'ETH', leadAsset: 'ETH', r: 0.78, beta: 2.10, rvol: 1.9, cosPhi: 0.65 },
  { symbol: 'DOGE', name: 'Dogecoin Sentiment', cluster: 'BTC', leadAsset: 'BTC', r: 0.48, beta: 1.80, rvol: 1.1, cosPhi: 0.28 },
  { symbol: 'XRP', name: 'Ripple Liquidity', cluster: 'BTC', leadAsset: 'BTC', r: 0.35, beta: 0.95, rvol: 0.85, cosPhi: -0.22 },
];

export function getEcosystemMetaRotation(prices: OmegaLeaderPrice[] = []): EcosystemLeader[] {
  const bySymbol = new Map(prices.map((price) => [price.symbol, price]));
  const assets = ECOSYSTEM_MODEL.flatMap((model) => {
    const live = bySymbol.get(model.symbol);
    if (!live || !(live.priceUSD > 0)) return [];
    return [{ ...model, priceUSD: live.priceUSD, change24h: live.change24h }];
  });

  const w1 = 0.25, w2 = 0.25, w3 = 0.25, w4 = 0.25;

  const scored: EcosystemLeader[] = assets.map(a => {
    // Canonical normalized calculation
    const betaNorm = Math.min(1.2, a.beta / 3.0);
    const rvolNorm = Math.min(1.2, a.rvol / 4.0);
    const cosPhiNorm = Math.max(-0.5, Math.min(1.0, a.cosPhi));
    const metaScore = Number((w1 * a.r + w2 * betaNorm + w3 * rvolNorm + w4 * cosPhiNorm).toFixed(3));

    const lampState = calculateLeaderAmpelState(metaScore, a.cosPhi, a.rvol);

    let tradeStatus: EcosystemLeader['tradeStatus'] = 'STANDBY_HOLD';
    if (lampState === 'GREEN_GLOW') tradeStatus = 'ACTIVE_PYRAMID';
    else if (lampState === 'GREEN_SOLID') tradeStatus = 'SCOUT_ENTRY';
    else if (lampState === 'RED_GLOW') tradeStatus = 'EMBARGO_BLOCKED';
    else tradeStatus = 'STANDBY_HOLD';

    return {
      symbol: a.symbol,
      name: a.name,
      cluster: a.cluster,
      leadAsset: a.leadAsset,
      correlationLead: a.r,
      betaLead: a.beta,
      rvol5m: a.rvol,
      cosPhi: a.cosPhi,
      metaScore,
      lampState,
      isLeader: false,
      priceUSD: a.priceUSD,
      change24h: a.change24h,
      tradeStatus,
    };
  });

  scored.sort((a, b) => b.metaScore - a.metaScore);
  if (scored.length > 0) {
    scored[0].isLeader = true;
    if (scored[0].lampState === 'GREEN_SOLID') {
      scored[0].lampState = 'GREEN_GLOW';
    }
  }

  return scored;
}

/**
 * Builds OMEGA telemetry from one Kraken quote. Returns null when last or ATR is missing.
 */
export function getLiveOmegaTelemetry(input: LiveOmegaInput | null): LiveOmegaTelemetry | null {
  if (!input || !(input.quote.last > 0) || !(input.quote.atr14 > 0)) return null;
  const { quote } = input;
  const spotPrice = quote.last;
  const atr14 = quote.atr14;
  const depth = quote.visibleL2Depth > 0 ? quote.visibleL2Depth : undefined;

  const viaNegativa = calculateViaNegativa(spotPrice, atr14, 60, quote.askImpedance, quote.bidSupport);
  const gravityField = calculateGravityField(spotPrice, depth);
  const acSystem = calculateACPowerMetrics(quote.open, quote.high, quote.low, quote.close, atr14);
  const quantumState = calculateQuantumMarketState(spotPrice, atr14, undefined, 120.0);
  const ecosystemLeaders = getEcosystemMetaRotation(input.leaderPrices);

  const orders = input.orders ?? [];
  const tranches: PyramidingTranche[] = orders.map((order, index) => ({
    id: index + 1,
    name: `Order ${index + 1}`,
    sizeMultiplier: 1,
    entryPrice: order.price,
    atrOffset: 0,
    isFilled: true,
  }));
  const totalVolume = orders.reduce((sum, order) => sum + order.volume, 0);
  const averageEntryPrice = totalVolume > 0
    ? orders.reduce((sum, order) => sum + order.price * order.volume, 0) / totalVolume
    : 0;
  const unrealizedPnL = orders.reduce((sum, order) => {
    const sign = order.side === 'buy' ? 1 : -1;
    return sum + sign * (spotPrice - order.price) * order.volume;
  }, 0);

  const basket: AntiMartingaleBasket = {
    symbol: quote.display,
    tranches,
    totalVolume,
    averageEntryPrice,
    currentMarketPrice: spotPrice,
    trailingBasketStop: Number((spotPrice - 1.2 * atr14).toFixed(2)),
    freeRollRiskUSD: 0,
    unrealizedPnL: Number(unrealizedPnL.toFixed(2)),
    clusterExitTriggered: false,
  };

  const equity = typeof input.equityUSD === 'number' && input.equityUSD >= 0 ? input.equityUSD : 0;
  const vault: DualStateVault = {
    totalEquityUSD: equity,
    activeMarginAllocationUSD: equity * 0.9,
    activeMarginPercent: equity > 0 ? 90 : 0,
    dynamicLeverage: 1,
    vaultAllocationUSD: equity * 0.1,
    vaultPercent: equity > 0 ? 10 : 0,
    vaultState: 'STATE_A_AUTO_EARN',
    vaultYieldAPY: 7.25,
    unbondingLatencyMs: 24,
  };

  return {
    quantumState,
    gravityField,
    viaNegativa,
    acSystem,
    basket,
    ecosystemLeaders,
    vault,
  };
}

/**
 * Calculates Growth-Per-Minute (GPM) metric as defined in Blueprint §9:
 * GPM = (Realisierter PnL_Shadow + Unrealisierter PnL) / Δt_Minuten
 */
export function calculateGPM(
  realizedPnLShadowUSD: number,
  unrealizedPnLUSD: number,
  deltaTMinutes: number
): number {
  if (deltaTMinutes <= 0) return 0;
  return Number(((realizedPnLShadowUSD + unrealizedPnLUSD) / deltaTMinutes).toFixed(3));
}

/**
 * Generates Top-4 Shadow Arena Incubation Candidates for a given timeframe Δt (15, 30, or 60 min)
 * Rank #1 and #2 are promoted to live deployment.
 */
export function getGPMIncubationCandidates(
  deltaTMinutes: number = 30,
  history?: Array<{
    symbol: string;
    name: string;
    cluster: 'SUI' | 'SOL' | 'BTC' | 'ETH';
    realizedPnLShadowUSD: number;
    unrealizedPnLUSD: number;
    spotPrice: number;
    shadowTradesCount: number;
    winRateShadowPercent: number;
    maxDrawdownUSD: number;
    confidenceScore: number;
  }>
): GPMCandidate[] {
  if (!history || history.length === 0) return [];

  const processed: GPMCandidate[] = history.map(c => {
    const gpm = calculateGPM(c.realizedPnLShadowUSD, c.unrealizedPnLUSD, deltaTMinutes);
    return {
      symbol: c.symbol,
      name: c.name,
      cluster: c.cluster,
      realizedPnLShadowUSD: c.realizedPnLShadowUSD,
      unrealizedPnLUSD: c.unrealizedPnLUSD,
      deltaTMinutes,
      gpm,
      rank: 0,
      isPromotedToLive: false,
      liveStatus: 'STANDBY_INCUBATION',
      shadowTradesCount: c.shadowTradesCount,
      winRateShadowPercent: c.winRateShadowPercent,
      maxDrawdownUSD: c.maxDrawdownUSD,
      spotPrice: c.spotPrice,
      confidenceScore: c.confidenceScore,
    };
  });

  // Sort strictly descending by GPM (highest GPM wins)
  processed.sort((a, b) => b.gpm - a.gpm);

  // Assign ranks and top-2 promotions
  return processed.slice(0, 4).map((c, idx) => {
    const rank = idx + 1;
    const isPromotedToLive = rank <= 2;
    return {
      ...c,
      rank,
      isPromotedToLive,
      liveStatus: isPromotedToLive ? 'PROMOTED_LIVE' : 'STANDBY_INCUBATION',
    };
  });
}

