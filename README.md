# NCLEX-RN Computerized Adaptive Testing (CAT) Prep Portal

A self-hosted, UWorld-inspired **NCLEX-RN Computerized Adaptive Testing (CAT)** web application built for **GitHub Pages**. This template separates the adaptive exam engine from study content—allowing you to generate 100-question unit banks (with option-by-option rationales and PDF-sourced flashcards) from any nursing study unit in `.json` format and load them into the simulator with zero backend servers or recurring costs.

> **Educational Disclaimer:** This project is a personal study and exam-simulation tool created for educational purposes. It is not affiliated with, endorsed by, or sponsored by the National Council of State Boards of Nursing (NCSBN), Pearson VUE, or UWorld.

---

## Key Features

- **Adaptive CAT Engine (2026 NCLEX-RN Blueprint):**
  - Dynamically adjusts question difficulty using Rasch Item Response Theory (IRT) around the `0.00` logit passing standard.
  - Enforces official stopping conditions: minimum 85 items, early **95% Confidence Interval** stop (Q85–Q99), maximum item limit (Q100 single-unit / Q150 multi-unit mock), and **Run-Out-of-Time (R.O.O.T.)** rules.
- **NGN Question Formats & Partial-Credit Scoring:**
  - Supports standard **Multiple Choice (MCQ)** (`0/1` scoring) and **Select All That Apply (SATA)** using the official NGN plus/minus rule (`+1` per correct choice, `-1` per incorrect choice, floored at `0`).
  - Tags items across all **8 NCLEX-RN Client Needs categories** and **6 Clinical Judgment Measurement Model (CJMM) skills**.
- **UWorld-Style Exam Interface & Proctor Controls:**
  - Selectable exam clock: **05:00:00 (Official NCLEX)** or **03:20:00 (2 min/question paced)** with non-pausing break reminders at 2h and 3.5h.
  - Built-in **Text Highlighter**, **Answer Strikethrough**, **On-Screen Calculator**, **Normal Reference Lab Values**, **Clinical Exhibits**, and **Item Flagging**.
  - Enforces forward-only navigation, answer lock confirmation, fullscreen mode, tab-switch focus tracking (`Focus Left`), and 1-second crash recovery auto-save.
- **Plug-and-Play `.json` Template & GitHub Auto-Discovery:**
  - Automatically scans the repository's `data/` folder for `.json` unit files (no manual index file required) and populates the **Pre-Test Unit Selector Dropdown**.
  - Supports both **1-Shot Compact JSON** and **Full Schema JSON** via drag-and-drop upload or direct paste, running automated schema and answer-key validation before integration.
- **Multi-Attempt Dashboard, Score Card & Flashcards:**
  - Tracks unlimited attempts per topic without overwriting prior runs, with `.json` backup/restore for cross-device portability.
  - Generates printable **Candidate Score Cards** featuring a live Ability Trajectory ($\theta$) chart and 8-category mastery breakdown.
  - Pairs every reviewed question with its source-grounded **PDF Flashcard** and provides a standalone **Flashcards** study deck.

---

## Repository Structure

```text
├── index.html      # Portal UI: Login, Pre-Test Dropdown, Importer, CAT Exam, Score Card, Flashcards & QA
├── styles.css      # Responsive exam interface & print-ready score card stylesheet
├── app.js          # GitHub data/ auto-discovery, Compact JSON auto-expander, validator & CAT engine
├── README.md       # Documentation and setup guide
└── data/           # Drop any validated unit .json files here (auto-detected on load)
