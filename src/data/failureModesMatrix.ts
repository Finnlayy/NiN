export interface FailureModeItem {
  id: number;
  riskTitle: string;
  category: 'BIAS_MODEL' | 'EXCHANGE_NETWORK' | 'ORCHESTRATION_COST' | 'DATA_INTEGRITY' | 'SYSTEMIC_CASCADE';
  probability: 'Hoch' | 'Mittel' | 'Niedrig';
  impact: 'Sehr hoch' | 'Hoch' | 'Mittel';
  probabilityScore: 1 | 2 | 3; // 1 = Niedrig, 2 = Mittel, 3 = Hoch
  impactScore: 1 | 2 | 3;      // 1 = Mittel, 2 = Hoch, 3 = Sehr hoch
  earlyDetection: string;
  mitigation: string;
  pillar: string;
  isKillSwitchRelated: boolean;
  citation?: {
    title: string;
    url: string;
  };
  technicalDetails: {
    failureSignature: string;
    automatedAction: string;
    verificationTest: string;
    metricThreshold: string;
    circuitBreakerState: 'CLOSED' | 'HALF_OPEN' | 'OPEN';
  };
}

export const FAILURE_MODES_MATRIX: FailureModeItem[] = [
  {
    id: 1,
    riskTitle: "Parametrischer Look-ahead-Bias (Modell „erinnert“ Marktverläufe)",
    category: "BIAS_MODEL",
    probability: "Hoch",
    impact: "Hoch",
    probabilityScore: 3,
    impactScore: 2,
    earlyDetection: "Divergenz Prior- vs. Kontext-Antwort; In-Sample ≫ OOS Performance-Kluft",
    mitigation: "FinCAD-LogitsProcessor, α(s,t)-Kalibrierung, Post-Cutoff-Evaluierung",
    pillar: "Pfeiler 1: Kausale Datenintegrität & LLM-Entbiasierung",
    isKillSwitchRelated: false,
    citation: {
      title: "arXiv:2605.24564",
      url: "https://arxiv.org/abs/2605.24564"
    },
    technicalDetails: {
      failureSignature: "KL-Divergenz D_KL(P_prior || P_context) überschreitet empirisches Signifikanzniveau α=0.05 bei identischen Pre-Cutoff Timestamps.",
      automatedAction: "Aktivierung des FinCAD-LogitsProcessor mit dynamischer Bestrafung memorierter Token-Sequenzen; automatische Umschaltung auf synthetische Permutations-Validierung.",
      verificationTest: "Synthetische Time-Reversal- & Token-Shuffling-Tests: Modell darf keine unbegründete Gewinnrate bei randomisierten Zeitreihen aufweisen.",
      metricThreshold: "D_KL(Prior || Context) < 0.12 bit; In-Sample/OOS Sharpe-Ratio Ratio < 1.35x.",
      circuitBreakerState: "CLOSED"
    }
  },
  {
    id: 2,
    riskTitle: "„Debiasing-Theater“ im Two-Pass-Fallback",
    category: "BIAS_MODEL",
    probability: "Mittel",
    impact: "Mittel",
    probabilityScore: 2,
    impactScore: 1,
    earlyDetection: "Two-Pass ↔ FinCAD-Abweichung; Scheinkompensation ohne kausale Signalveränderung",
    mitigation: "Two-Pass nur als Kontrollkanal/Fallback, nie als alleinige Entscheidungsgrundlage",
    pillar: "Pfeiler 1: Kausale Datenintegrität & LLM-Entbiasierung",
    isKillSwitchRelated: false,
    technicalDetails: {
      failureSignature: "Two-Pass-Prompting erzeugt syntaktisch variierte Begründung, behält jedoch die memorierten Alpha-Positionen 1:1 bei.",
      automatedAction: "Hard Gate: Two-Pass-Entscheidungen erfordern zwingende Übereinstimmung mit mathematischem FinCAD-Logits-Filter; Diskrepanz sperrt Trade-Signal.",
      verificationTest: "Cross-Channel Parity Test: FinCAD Logits-Scan gegen Two-Pass Refinement mit kontrollierten Poison-Tokens.",
      metricThreshold: "Jaccard-Similarity der gefilterten Token-Begründung > 0.85 bei identischer Delta-Direction.",
      circuitBreakerState: "CLOSED"
    }
  },
  {
    id: 3,
    riskTitle: "Kraken-Rate-Limit-Rejection (EOrder:Rate limit exceeded)",
    category: "EXCHANGE_NETWORK",
    probability: "Hoch",
    impact: "Mittel",
    probabilityScore: 3,
    impactScore: 1,
    earlyDetection: "Counter-Stand nahe Limit (Kostenbasiertes Budget > 80% des Sliding-Window-Tiers)",
    mitigation: "Clientseitiges Counter+Decay-Spiegelbild, kostenbasiertes Budget",
    pillar: "Pfeiler 2: Venue-Gateway & Microstructure-Execution",
    isKillSwitchRelated: false,
    citation: {
      title: "Kraken Docs: Rate Limits",
      url: "https://docs.kraken.com/exchange/guides/rest/ratelimits"
    },
    technicalDetails: {
      failureSignature: "HTTP 429 oder WebSocket Response {'error': ['EOrder:Rate limit exceeded']}.",
      automatedAction: "Clientseitiger Leaky-Bucket Token-Spiegel drosselt Request-Rate; unkritische Market-Data-Pings werden pausiert, um Order-Cancel-Budget zu reservieren.",
      verificationTest: "Stress-Test mit künstlichem 100-Burst Requests: Gateway muss Requests clientseitig vor dem Netzwerk-Socket puffern und 0x 429 werfen.",
      metricThreshold: "Client-Counter < 0.80 * MaxTierPoints (z. B. Tier 4 max 45 Punkte, Dämpfung ab 36 Punkten).",
      circuitBreakerState: "CLOSED"
    }
  },
  {
    id: 4,
    riskTitle: "Runaway Loop / Token-Erschöpfung des Orchestrierers",
    category: "ORCHESTRATION_COST",
    probability: "Mittel",
    impact: "Hoch",
    probabilityScore: 2,
    impactScore: 2,
    earlyDetection: "Steigende Iterationsfrequenz (>5 Hz), rapid steigender LLM-Budget-Verbrauch",
    mitigation: "Token Bucket pro Loop, loop_count-Limit, Meta-Breaker",
    pillar: "Pfeiler 3: Deterministische FSM & Resource-Containment",
    isKillSwitchRelated: true,
    citation: {
      title: "TechTarget: AI Agent Kill Switch",
      url: "https://www.techtarget.com/ai/tip/Why-businesses-need-an-AI-agent-kill-switch"
    },
    technicalDetails: {
      failureSignature: "Zustandstransitionen zwischen ReAct-Tools steigen ohne State-Mutation über MAX_LOOP_COUNT.",
      automatedAction: "Hartes Kill-Switch-Signal: Unterbrechung des LLM-Agenten-Loops, Fallback auf deterministische No-Op Policy und Notifier an Sentry/PagerDuty.",
      verificationTest: "Endlosschleifen-Injektion: Loop-Breaker muss nach exakt 5 unproduktiven Iterationen SAFE-HALT auslösen.",
      metricThreshold: "loop_count <= 5 Iterationen pro Trade-Cycle; Token-Rate <= 4000 Tokens/Min.",
      circuitBreakerState: "CLOSED"
    }
  },
  {
    id: 5,
    riskTitle: "Orchestrierer-Absturz mit offenen Orders",
    category: "EXCHANGE_NETWORK",
    probability: "Niedrig",
    impact: "Sehr hoch",
    probabilityScore: 1,
    impactScore: 3,
    earlyDetection: "Watchdog-Heartbeat-Ausfall (Missed Heartbeat > 5000 ms)",
    mitigation: "Börsenseitiger Dead-Man-Switch cancel_all_orders_after (60 s)",
    pillar: "Pfeiler 2: Venue-Gateway & Microstructure-Execution",
    isKillSwitchRelated: true,
    citation: {
      title: "Kraken WebSocket API: cancel_after",
      url: "https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/cancel_after"
    },
    technicalDetails: {
      failureSignature: "Heartbeat-Signal vom Orchestrator an Kraken WebSocket bleibt aus; Prozess stirbt unerwartet mit ungedeckten Limit-Orders.",
      automatedAction: "Börsenseitiger Dead-Man-Switch greift autonom bei 60s Time-out und löscht sämtliche aktiven Limit- und Pegged-Orders auf Exchange-Ebene.",
      verificationTest: "SIGKILL-Simulation auf Live-Dry-Run-Instanz: Verifikation, dass Kraken nach 60s alle offenen Orders ohne Client-Zutun annulliert.",
      metricThreshold: "Heartbeat-Interval <= 15 s; Dead-Man Timeout = 60 s.",
      circuitBreakerState: "CLOSED"
    }
  },
  {
    id: 6,
    riskTitle: "LLM halluziniert Zustandsübergang / ungültiges JSON",
    category: "ORCHESTRATION_COST",
    probability: "Mittel",
    impact: "Mittel",
    probabilityScore: 2,
    impactScore: 1,
    earlyDetection: "Schema-Validierungsfehler (Zod / Pydantic Parse-Exception)",
    mitigation: "FSM mit erlaubten Kanten, Structured Outputs, Retry → Eskalation",
    pillar: "Pfeiler 3: Deterministische FSM & Resource-Containment",
    isKillSwitchRelated: false,
    citation: {
      title: "Hackernoon: Deterministic Orchestration",
      url: "https://hackernoon.com/deterministic-orchestration-how-state-machines-are-replacing-agent-loops-in-regulated-ai"
    },
    technicalDetails: {
      failureSignature: "Output enthält unerlaubte JSON-Keys, ungültige Enums oder Transitionen, die nicht im FSM-Adjazenzgraphen existieren.",
      automatedAction: "Sofortige Reject-Kaskade: 1x Re-Prompt mit JSON-Schema-Fehlerbeschreibung; bei zweitem Fehlschlag Transition in HALT-Status.",
      verificationTest: "Malformed JSON Injection Fuzzing: FSM fängt 100% syntaktisch unzulässiger Payloads vor der Ausführungsstufe ab.",
      metricThreshold: "Schema-Parsing-Success >= 99.8%; Max Retry = 1.",
      circuitBreakerState: "CLOSED"
    }
  },
  {
    id: 7,
    riskTitle: "Kontext-Kollaps (Context Window voll, Entscheidungen auf Stümpfen)",
    category: "DATA_INTEGRITY",
    probability: "Hoch",
    impact: "Hoch",
    probabilityScore: 3,
    impactScore: 2,
    earlyDetection: "Token-Füllstand > 80% des effektiven Modells-Kontextfensters",
    mitigation: "CSV/TOON-Serialisierung, LLMLingua-2 für Historie, DuckDB-Résumé statt Rohhistorie",
    pillar: "Pfeiler 4: Context Optimization & Memory Architecture",
    isKillSwitchRelated: false,
    technicalDetails: {
      failureSignature: "Prompt-Token-Count nähert sich der Window-Grenze, was zu Trunkierung und Verlust der System-Prompts führt.",
      automatedAction: "Automatisches Kompaktieren: Tabellarische Daten werden als TOON/kompaktes CSV serialisiert; alte Trade-Turns durch DuckDB-Zusammenfassung ersetzt.",
      verificationTest: "24-Stunden Continuous Run Simulation: Context-Token-Count bleibt asymptotisch stabil unterhalb der 60%-Marke.",
      metricThreshold: "Effektiver Token-Füllstand <= 80%; Information Density Ratio >= 2.4x.",
      circuitBreakerState: "CLOSED"
    }
  },
  {
    id: 8,
    riskTitle: "Kompressions-Halluzination in Finanzdaten (ASH / ILH)",
    category: "DATA_INTEGRITY",
    probability: "Mittel",
    impact: "Sehr hoch",
    probabilityScore: 2,
    impactScore: 3,
    earlyDetection: "Diskrepanz-Abgleich komprimiert ↔ Original-Rohdaten vor Prompt-Injektion",
    mitigation: "Zahlen/Preise/Entscheidungen nie komprimieren; nur Prosa, force_tokens-Whitelist",
    pillar: "Pfeiler 4: Context Optimization & Memory Architecture",
    isKillSwitchRelated: false,
    citation: {
      title: "ICLR-WS: Selective Context Compression",
      url: "https://openreview.net/pdf?id=lbFVTPv4s6"
    },
    technicalDetails: {
      failureSignature: "Kompressionstool verändert Ziffern (z. B. 64280 -> 64200) oder entfernt Vorzeichen bei PnL/Delta-Werten.",
      automatedAction: "Whitelist-Guard: Ziffern, Floating-Points, Order-Actions und Stop-Loss-Marken werden in `force_tokens` gesperrt und 1:1 unberührt durchgeleitet.",
      verificationTest: "Numerical Integrity Check: Assert diff(reconstructed_numbers, raw_numbers) == 0 über 100.000 generierte Ticks.",
      metricThreshold: "Numerical Reconstruction Error = 0.000000%; Zero tolerance für Zahlentransformationen.",
      circuitBreakerState: "CLOSED"
    }
  },
  {
    id: 9,
    riskTitle: "Veralteter Marktdaten-Feed (Staleness) bei laufendem Trading",
    category: "DATA_INTEGRITY",
    probability: "Mittel",
    impact: "Hoch",
    probabilityScore: 2,
    impactScore: 2,
    earlyDetection: "Zeitstempel-Delta (t_now - t_tick) > definierte Staleness-Schwelle (500 ms)",
    mitigation: "Staleness-Gate in INGEST; bei Verletzung nur Positionserhaltung",
    pillar: "Pfeiler 2: Venue-Gateway & Microstructure-Execution",
    isKillSwitchRelated: true,
    technicalDetails: {
      failureSignature: "WebSocket Lag oder Freeze: Marktdaten-Pakete haben Timestamp t_tick mit Delta > 500 ms zur monotonic system time.",
      automatedAction: "Atomic Lua Gate & Execution Guard blockieren neue Orders; System schaltet automatisch in reinen Passive-Protect / Safe-Zone Modus.",
      verificationTest: "Lag-Injektion: Bei künstlicher Verzögerung von 600 ms muss das Lua-Skript Statuscode -1 ('REJECT_STALE_MARKET_TICK') liefern.",
      metricThreshold: "Max Staleness Delta <= 500 ms; Monotonie-Verletzung t_tick < t_last = 0.",
      circuitBreakerState: "CLOSED"
    }
  },
  {
    id: 10,
    riskTitle: "Kaskadenfehler (Venue + LLM + DB gleichzeitig gestört)",
    category: "SYSTEMIC_CASCADE",
    probability: "Niedrig",
    impact: "Sehr hoch",
    probabilityScore: 1,
    impactScore: 3,
    earlyDetection: "≥ 2 Circuit Breaker gleichzeitig im Status OPEN",
    mitigation: "Meta-Breaker → SAFE-HALT, offene Orders stornieren, State einfrieren, eskalieren",
    pillar: "Pfeiler 5: Systemic Resilience & Meta-Governance",
    isKillSwitchRelated: true,
    technicalDetails: {
      failureSignature: "Kombinierter Meta-Fehler: Gleichzeitiger Ausfall von Order-Routing (Kraken 5xx), LLM-API Timeout und Redis/DB-Verbindungsabbruch.",
      automatedAction: "META-KILL-SWITCH ENGAGED: Kein lokaler Retry erlaubt. Notfall-Storno via REST/WS, Einfrieren aller Positionen, PagerDuty P1 Alarmierung.",
      verificationTest: "Multi-Breaker Sim: Auslösen von Breaker A (Venue) und Breaker B (LLM) aktiviert sofort den globalen Safe-Halt ohne Übergangsfrist.",
      metricThreshold: "Offene Breaker Count < 2; Bei Count >= 2 sofortiger Notstopp.",
      circuitBreakerState: "CLOSED"
    }
  },
  {
    id: 11,
    riskTitle: "Catastrophic Forgetting der eigenen Performance",
    category: "DATA_INTEGRITY",
    probability: "Hoch",
    impact: "Mittel",
    probabilityScore: 3,
    impactScore: 1,
    earlyDetection: "Wiederholte identische Fehl-Trades in ähnlichen Marktregimen",
    mitigation: "MemGPT-Schichten: DuckDB (episodisch) + VectorDB (semantisch) + Résumé im Prompt",
    pillar: "Pfeiler 4: Context Optimization & Memory Architecture",
    isKillSwitchRelated: false,
    technicalDetails: {
      failureSignature: "Agent wiederholt dokumentierte Trading-Fehler bei identischen Marktkonstellationen (z. B. Fakeout an S1-Support).",
      automatedAction: "Vor Trade-Generierung: Semantischer Vektorabruf ähnlicher historischer Fehlerfälle; Einspeisung als 'Negative Few-Shot Examples'.",
      verificationTest: "Historical Repetition Test: Modell vermeidet nach Einspeisung der Episode den gleichen Fehlschluss zu 98.4%.",
      metricThreshold: "Negative Recall Parity >= 95%; Memory Query Latency <= 8 ms.",
      circuitBreakerState: "CLOSED"
    }
  },
  {
    id: 12,
    riskTitle: "Fehlkalibriertes α in FinCAD (zu stark → Kontext ignoriert; zu schwach → Bias bleibt)",
    category: "BIAS_MODEL",
    probability: "Mittel",
    impact: "Mittel",
    probabilityScore: 2,
    impactScore: 1,
    earlyDetection: "OOS-Performance driftet ab; α(s,t) saturiert nahe Max-Wert über alle Segmente",
    mitigation: "Offline-Probe-Kalibrierung, α → 0 außerhalb Memorisation-Zonen, Two-Pass Cross-Check",
    pillar: "Pfeiler 1: Kausale Datenintegrität & LLM-Entbiasierung",
    isKillSwitchRelated: false,
    technicalDetails: {
      failureSignature: "α-Parameter blockiert legitime Marktbewegungs-Signale oder lässt verdeckte Pre-Cutoff-Muster ungefiltert passieren.",
      automatedAction: "Automatische Re-Kalibrierung: Bei anhaltender Sättigung wird α auf Nullniveau gedrosselt und ein Offline-Probe-Lauf initiiert.",
      verificationTest: "Probe-Grid-Search auf synthetischen und historischen Kontroll-Datensätzen mit bekanntem Information-Leakage.",
      metricThreshold: "α(s,t) Mean in [0.15, 0.65]; Keine stationäre Sättigung bei 1.0 über > 10 aufeinanderfolgende Ticks.",
      circuitBreakerState: "CLOSED"
    }
  }
];

export const PILLARS_LIST = [
  "Pfeiler 1: Kausale Datenintegrität & LLM-Entbiasierung",
  "Pfeiler 2: Venue-Gateway & Microstructure-Execution",
  "Pfeiler 3: Deterministische FSM & Resource-Containment",
  "Pfeiler 4: Context Optimization & Memory Architecture",
  "Pfeiler 5: Systemic Resilience & Meta-Governance"
];
