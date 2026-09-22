# Plan: E. Goodhart's Law (Starre 85er-Schwelle) – In Überarbeitung

## Ziel
Ersatz statischer Scores (starre 85er-Schwelle) durch strukturierte Evaluierungs-Pipelines mit `defineEval` über echte historische `rlhf_samples`-Datensätze.

## Hintergrund (Goodhart's Law)
- Eine starre Schwelle (z. B. 85 %) als Optimierungsziel führt zu Goodharting: Die Metrik verliert ihre Aussagekraft (Reward Hacking, Overfitting auf Proxy-Score im RLHF-Kontext).
- Statt einer einzigen Zahl (`score >= 0.85`) wird eine strukturierte, interpretierbare Pipeline benötigt.

## Schritte zur Lösung

### 1. Bestandsaufnahme (Repo-Analyse)
- [ ] Dateien und Ordner prüfen (z. B. `eval/`, `rlhf_samples/`, Konfigurationsdateien).
- [ ] Identifizieren, wo die statische 85er-Schwelle definiert und verwendet wird.
- [ ] Prüfen, ob `defineEval`-Referenzen, Module oder Frameworks existieren.

### 2. Datenbasis: Echte historische `rlhf_samples`
- [ ] Historische RLHF-Feedback-Daten (Präferenzen, Ratings, Annotationen) als Grundlage identifizieren.
- [ ] Datenpipeline aufbauen: Laden, Filtern und Strukturieren der `rlhf_samples` für die Evaluation.
- [ ] Sicherstellen, dass echte historische Daten (nicht synthetische Benchmarks) als Eingabe dienen.

### 3. Strukturierte Evaluierungs-Pipeline (`defineEval`)
- [ ] `defineEval`-Schnittstelle/Modul definieren oder erweitern.
- [ ] Mehrere Evaluationsdimensionen definieren (z. B. Korrektheit, Sicherheit, Nützlichkeit, Konsistenz mit menschlichem Feedback).
- [ ] Jede Dimension mit eigenen Kriterien und Audit-Trails ausstatten.
- [ ] Pipeline strukturieren: Input (`rlhf_samples`) → Evaluatoren (`defineEval`) → Aggregierte, interpretierbare Ergebnisse.

### 4. Ersatz der statischen Scores
- [ ] Starre Schwelle (`score >= 85` oder ähnlich) identifizieren und dokumentieren.
- [ ] Statische Scores durch die Ergebnisse der `defineEval`-Pipeline ersetzen.
- [ ] Aggregierte Ergebnisse interpretierbar gestalten (z. B. mehrdimensionale Berichte statt einer einzigen Zahl).

### 5. Validierung und Dokumentation
- [ ] Pipeline mit echten `rlhf_samples` testen.
- [ ] Ergebnisse dokumentieren und Vergleiche zur alten statischen Schwelle ziehen.
- [ ] Änderungen im Code und in der Dokumentation festhalten.

## Abhängigkeiten / Offene Fragen
- Zugriff auf das Repository (`Finnlayy/NIO`) erforderlich.
- Klärung: Existiert ein `defineEval`-Framework oder muss es neu erstellt werden?
- Klärung: Wo genau liegen die `rlhf_samples` (Dateipfad, Format, Struktur)?
- Klärung: Welche Dateien müssen konkret geändert werden?

## Hinweis zur aktuellen Situation
Das System blockiert jede Bash-/Prozess-Ausführung durch einen fehlgeschlagenen `git clone` (`Finnlayy/NIO`). Der Plan kann umgesetzt werden, sobald das Repository zugänglich ist.
