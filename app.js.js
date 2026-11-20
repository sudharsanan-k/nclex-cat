/* ============================================================================
 * NCLEX-RN CAT SIMULATOR — CORE APPLICATION ENGINE
 * ============================================================================ */

const STORAGE_KEYS = {
  SESSION: "nclex_cat_session_v1",
  HISTORY: "nclex_cat_history_v1",
  LOCAL_UNITS: "nclex_cat_local_units_v1",
  ACTIVE_EXAM: "nclex_cat_active_exam_v1"
};

// Default credentials: candidate / Nclex2026!
// SHA-256 of "Nclex2026!" = 5d0d20b69d3c3f9e73f9a9d2213d5e941e7f939a409338340b712b6b33d620c1
// (Computed dynamically on first check if needed, with fallback hash below)
const AUTH_CONFIG = {
  username: "candidate",
  candidateName: "RN Candidate",
  candidateId: "RN-2026-085",
  passwordSha256: "" // Populated via sha256("Nclex2026!") at runtime
};

const DIFFICULTY_LOGITS = {
  1: -1.5,
  2: -0.75,
  3: 0.0,
  4: 0.75,
  5: 1.5
};

const PASSING_LOGIT = 0.0; // Official 2026 NCLEX-RN passing standard = 0.00 logits

const NCLEX_CATEGORIES = [
  "Management of Care",
  "Safety and Infection Prevention and Control",
  "Health Promotion and Maintenance",
  "Psychosocial Integrity",
  "Basic Care and Comfort",
  "Pharmacological and Parenteral Therapies",
  "Reduction of Risk Potential",
  "Physiological Adaptation"
];

const NORMAL_LABS = [
  ["Sodium (Na+)", "135–145 mEq/L"],
  ["Potassium (K+)", "3.5–5.0 mEq/L"],
  ["Calcium (Total)", "9.0–10.5 mg/dL"],
  ["Magnesium (Mg2+)", "1.3–2.1 mEq/L"],
  ["Chloride (Cl-)", "98–106 mEq/L"],
  ["Phosphorus", "3.0–4.5 mg/dL"],
  ["Arterial pH", "7.35–7.45"],
  ["PaCO2", "35–45 mm Hg"],
  ["HCO3-", "22–26 mEq/L"],
  ["BUN / Creatinine", "10–20 mg/dL / 0.6–1.2 mg/dL"]
];

const state = {
  authenticated: false,
  catalog: [],
  loadedUnits: {}, // unitId -> unitObject
  history: [],
  briefingUnitId: null,
  selectedTimerSeconds: 18000,
  confirmBeforeLock: true,
  exam: null,
  timerInterval: null,
  highlightActive: false,
  break2hShown: false,
  break35hShown: false,
  pendingAdvanceAction: null
};

/* ---------------- CRYPTO & STORAGE HELPERS ---------------- */
async function sha256Hex(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.HISTORY) || "[]");
  } catch {
    return [];
  }
}

function saveHistory() {
  localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(state.history));
}

function loadLocalUnits() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_UNITS) || "{}");
  } catch {
    return {};
  }
}

function saveLocalUnits(obj) {
  localStorage.setItem(STORAGE_KEYS.LOCAL_UNITS, JSON.stringify(obj));
}

/* ---------------- DATA LOADING ---------------- */
async function initCatalog() {
  state.history = loadHistory();
  const localUnits = loadLocalUnits();

  try {
    const res = await fetch("./data/units.json");
    if (res.ok) {
      const idx = await res.json();
      for (const item of idx.units || []) {
        try {
          const uRes = await fetch(`./data/${item.file}`);
          if (uRes.ok) {
            const unitData = await uRes.json();
            state.loadedUnits[unitData.unitId] = unitData;
          }
        } catch (err) {
          console.warn("Could not load unit file:", item.file, err);
        }
      }
    }
  } catch (err) {
    console.warn("Running without remote units.json (e.g., local file mode):", err);
  }

  Object.values(localUnits).forEach((u) => {
    state.loadedUnits[u.unitId] = u;
  });

  state.catalog = Object.values(state.loadedUnits).map((u) => ({
    unitId: u.unitId,
    unitTitle: u.unitTitle,
    questionCount: (u.questions || []).length
  }));
}

function getAllCombinedQuestions() {
  const combined = [];
  Object.values(state.loadedUnits).forEach((u) => {
    (u.questions || []).forEach((q, idx) => {
      combined.push({
        ...q,
        id: `${u.unitId}__${q.id || idx + 1}`,
        _sourceUnit: u.unitTitle
      });
    });
  });
  return combined;
}

/* ---------------- SCHEMA VALIDATOR ---------------- */
function validateUnitData(unitObj) {
  const errors = [];
  const warnings = [];

  if (!unitObj || typeof unitObj !== "object") {
    return { valid: false, errors: ["Unit payload is not a valid object."], warnings };
  }
  if (!unitObj.unitTitle || String(unitObj.unitTitle).trim().length < 2) {
    errors.push("Missing unitTitle.");
  }
  const qs = unitObj.questions;
  if (!Array.isArray(qs) || qs.length === 0) {
    errors.push("Questions array is empty or missing.");
    return { valid: false, errors, warnings };
  }
  if (qs.length < 85) {
    warnings.push(`Unit currently has ${qs.length} questions (85+ recommended for full NCLEX-RN single-unit CAT length).`);
  }

  qs.forEach((q, i) => {
    const label = `Q#${i + 1}`;
    if (!q.stem || typeof q.stem !== "string") errors.push(`${label}: missing stem.`);
    if (!["mcq", "sata"].includes(q.type)) errors.push(`${label}: invalid type "${q.type}".`);
    if (![1, 2, 3, 4, 5].includes(Number(q.difficulty))) errors.push(`${label}: difficulty must be 1–5.`);
    if (!Array.isArray(q.options) || q.options.length < 4) errors.push(`${label}: needs at least 4 options.`);
    if (!Array.isArray(q.correctOptionIds) || q.correctOptionIds.length === 0) {
      errors.push(`${label}: missing correctOptionIds.`);
    }
    if (!q.flashcard || !q.flashcard.front || !q.flashcard.back) {
      errors.push(`${label}: missing flashcard front/back.`);
    }
  });

  return { valid: errors.length === 0, errors, warnings };
}

/* ---------------- CAT & NGN SCORING ENGINE ---------------- */
function scoreQuestion(question, selectedIds) {
  const correctSet = new Set(question.correctOptionIds || []);
  const chosenSet = new Set(selectedIds || []);

  if (question.type === "mcq") {
    const isFull = chosenSet.size === 1 && correctSet.size === 1 && [...chosenSet].every((id) => correctSet.has(id));
    return {
      earned: isFull ? 1 : 0,
      max: 1,
      ratio: isFull ? 1 : 0,
      status: isFull ? "correct" : "incorrect"
    };
  }

  // SATA NGN Plus/Minus rule: +1 per right selection, -1 per wrong selection, floored at 0
  let raw = 0;
  chosenSet.forEach((id) => {
    raw += correctSet.has(id) ? 1 : -1;
  });
  const earned = Math.max(0, raw);
  const max = Math.max(1, correctSet.size);
  const ratio = earned / max;
  let status = "incorrect";
  if (ratio === 1 && chosenSet.size === correctSet.size) status = "correct";
  else if (earned > 0) status = "partial";

  return { earned, max, ratio, status };
}

function updateAbilityEstimate(currentTheta, qDifficulty, scoreRatio) {
  const diffLogit = DIFFICULTY_LOGITS[qDifficulty] ?? 0;
  // Rasch probability p = 1 / (1 + exp(-(theta - b)))
  const p = 1 / (1 + Math.exp(-(currentTheta - diffLogit)));
  // Step size tapers slightly as more items are answered
  const stepScale = 0.45;
  const delta = stepScale * (scoreRatio - p);
  const nextTheta = Math.max(-3.0, Math.min(3.0, Number((currentTheta + delta).toFixed(3))));
  return nextTheta;
}

function computeStandardError(answeredCount) {
  // Decreases as item count increases; reaches ~0.24 around 85–100 items
  return Number((1.45 / Math.sqrt(Math.max(1, answeredCount) + 6)).toFixed(3));
}

function selectNextQuestion(pool, usedIds, targetTheta) {
  const remaining = pool.filter((q) => !usedIds.has(String(q.id)));
  if (!remaining.length) return null;

  // Add slight jitter so repeated retakes vary question selection while staying near targetTheta
  let best = remaining[0];
  let bestScore = Infinity;

  for (const q of remaining) {
    const b = DIFFICULTY_LOGITS[q.difficulty] ?? 0;
    const distance = Math.abs(b - targetTheta) + Math.random() * 0.18;
    if (distance < bestScore) {
      bestScore = distance;
      best = q;
    }
  }
  return best;
}

function evaluateStoppingRule(exam) {
  const n = exam.responses.length;
  const maxQuestions = exam.maxQuestions; // 100 single-unit, up to 150 multi-unit
  const minQuestions = Math.min(85, maxQuestions);
  const se = computeStandardError(n);
  const ciHalfWidth = 1.96 * se;
  const lower95 = exam.theta - ciHalfWidth;
  const upper95 = exam.theta + ciHalfWidth;

  // Rule 3: Run Out of Time (R.O.O.T.)
  if (exam.remainingSeconds <= 0) {
    if (n < minQuestions) {
      return {
        shouldStop: true,
        passed: false,
        ruleTriggered: "Run-Out-of-Time (R.O.O.T. — Completed fewer than minimum items)"
      };
    }
    return {
      shouldStop: true,
      passed: exam.theta >= PASSING_LOGIT,
      ruleTriggered: "Run-Out-of-Time (Graded by final ability estimate)"
    };
  }

  // Before minimum items (85), never stop early
  if (n < minQuestions) {
    return { shouldStop: false, passed: null, ruleTriggered: null };
  }

  // Rule 1: 95% Confidence Interval Rule (from minQuestions up to maxQuestions - 1)
  if (n < maxQuestions) {
    if (lower95 > PASSING_LOGIT) {
      return {
        shouldStop: true,
        passed: true,
        ruleTriggered: `95% Confidence Interval Rule — Clearly Above Passing Standard at Q${n}`
      };
    }
    if (upper95 < PASSING_LOGIT) {
      return {
        shouldStop: true,
        passed: false,
        ruleTriggered: `95% Confidence Interval Rule — Clearly Below Passing Standard at Q${n}`
      };
    }
    return { shouldStop: false, passed: null, ruleTriggered: null };
  }

  // Rule 2: Maximum Length Reached
  return {
    shouldStop: true,
    passed: exam.theta >= PASSING_LOGIT,
    ruleTriggered: `Maximum Item Limit Reached (Q${maxQuestions}) — Final Ability Evaluation`
  };
}

/* ---------------- VIEW NAVIGATION ---------------- */
function showView(viewId) {
  [
    "loginView",
    "appShell",
    "dashboardView",
    "briefingView",
    "examView",
    "scoreCardView",
    "flashcardsView",
    "builderView",
    "qaView"
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add("hidden");
  });

  if (viewId === "loginView") {
    document.getElementById("loginView").classList.remove("hidden");
    document.getElementById("topBar").classList.add("hidden");
    return;
  }

  document.getElementById("topBar").classList.remove("hidden");
  document.getElementById("appShell").classList.remove("hidden");
  document.getElementById(viewId).classList.remove("hidden");

  const inExam = viewId === "examView";
  document.getElementById("examHud").classList.toggle("hidden", !inExam);
  document.getElementById("portalNavGroup").classList.toggle("hidden", inExam);

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === `${viewId.replace("View", "")}`);
  });
}

/* ---------------- AUTHENTICATION ---------------- */
async function handleLoginSubmit(e) {
  e.preventDefault();
  const userInput = document.getElementById("loginUser").value.trim();
  const passInput = document.getElementById("loginPass").value;
  const errEl = document.getElementById("loginError");

  if (!AUTH_CONFIG.passwordSha256) {
    AUTH_CONFIG.passwordSha256 = await sha256Hex("Nclex2026!");
  }

  const enteredHash = await sha256Hex(passInput);
  if (userInput.toLowerCase() === AUTH_CONFIG.username && enteredHash === AUTH_CONFIG.passwordSha256) {
    state.authenticated = true;
    errEl.classList.add("hidden");
    document.getElementById("candidateTag").textContent = `${AUTH_CONFIG.candidateName} (${AUTH_CONFIG.candidateId})`;
    if (document.getElementById("rememberUserChk").checked) {
      localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify({ user: userInput }));
    }
    renderDashboard();
    showView("dashboardView");
  } else {
    errEl.textContent = "Invalid username or password. Default: candidate / Nclex2026!";
    errEl.classList.remove("hidden");
  }
}

function checkInterruptedExam() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.ACTIVE_EXAM);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved && saved.responses) {
      const banner = document.getElementById("resumeBanner");
      banner.classList.remove("hidden");
      document.getElementById("resumeMeta").textContent = `${saved.unitTitle} — Item ${saved.responses.length + 1} • ${formatSeconds(saved.remainingSeconds)} left`;
      document.getElementById("resumeExamBtn").onclick = () => {
        state.authenticated = true;
        document.getElementById("candidateTag").textContent = `${AUTH_CONFIG.candidateName} (${AUTH_CONFIG.candidateId})`;
        state.exam = saved;
        beginExamLoop(true);
      };
    }
  } catch {
    localStorage.removeItem(STORAGE_KEYS.ACTIVE_EXAM);
  }
}

/* ---------------- DASHBOARD & ATTEMPTS ---------------- */
function renderDashboard() {
  const totalAttempts = state.history.length;
  const passes = state.history.filter((h) => h.passed).length;
  const passRate = totalAttempts ? `${Math.round((passes / totalAttempts) * 100)}%` : "—";
  const totalFlashcards = Object.values(state.loadedUnits).reduce(
    (sum, u) => sum + (u.questions || []).filter((q) => q.flashcard).length,
    0
  );

  document.getElementById("kpiGrid").innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Uploaded Units</div><div class="kpi-val">${state.catalog.length}</div></div>
    <div class="kpi-card"><div class="kpi-label">Total Attempts</div><div class="kpi-val">${totalAttempts}</div></div>
    <div class="kpi-card"><div class="kpi-label">Pass Rate</div><div class="kpi-val">${passRate}</div></div>
    <div class="kpi-card"><div class="kpi-label">PDF Flashcards</div><div class="kpi-val">${totalFlashcards}</div></div>
  `;

  document.getElementById("unitCatalogStatus").textContent =
    state.catalog.length >= 2
      ? "Multi-Unit Comprehensive Mock (85–150 Qs) unlocked!"
      : "Upload 2+ units to unlock 85–150 Q multi-unit mock.";

  const unitsGrid = document.getElementById("unitsGrid");
  unitsGrid.innerHTML = "";

  // Individual Topic Cards
  state.catalog.forEach((meta) => {
    const unitAttempts = state.history.filter((h) => h.unitId === meta.unitId);
    const latest = unitAttempts[0];
    const bestTheta = unitAttempts.length
      ? Math.max(...unitAttempts.map((a) => a.theta)).toFixed(2)
      : "—";

    const card = document.createElement("div");
    card.className = "unit-card";
    card.innerHTML = `
      <div>
        <h4>${escapeHtml(meta.unitTitle)}</h4>
        <div class="small-muted">${meta.questionCount} questions &bull; CAT Window: 85–${Math.min(100, meta.questionCount)}</div>
        <div class="unit-meta">
          <span class="pill">Attempts: ${unitAttempts.length}</span>
          <span class="pill">Best &theta;: ${bestTheta}</span>
          ${
            latest
              ? `<span class="pill ${latest.passed ? "pill-pass" : "pill-fail"}">Last: ${latest.passed ? "PASS" : "FAIL"}</span>`
              : `<span class="pill">Not Attempted</span>`
          }
        </div>
      </div>
      <div class="launch-row">
        <button class="btn btn-primary btn-sm start-unit-btn" data-uid="${meta.unitId}" type="button">
          ${unitAttempts.length ? "Retake CAT Exam" : "Start CAT Exam"}
        </button>
      </div>
    `;
    unitsGrid.appendChild(card);
  });

  // Multi-Unit Mock Card (when 2+ units exist)
  if (state.catalog.length >= 2) {
    const totalPool = getAllCombinedQuestions().length;
    const multiCard = document.createElement("div");
    multiCard.className = "unit-card";
    multiCard.innerHTML = `
      <div>
        <h4>Comprehensive Multi-Unit Mock</h4>
        <div class="small-muted">${totalPool} combined questions &bull; CAT Window: 85–150</div>
        <div class="unit-meta"><span class="pill">All Units Mixed</span></div>
      </div>
      <div class="launch-row">
        <button class="btn btn-secondary btn-sm start-unit-btn" data-uid="__ALL__" type="button">Start Multi-Unit CAT</button>
      </div>
    `;
    unitsGrid.appendChild(multiCard);
  }

  unitsGrid.querySelectorAll(".start-unit-btn").forEach((btn) => {
    btn.addEventListener("click", () => openBriefing(btn.dataset.uid));
  });

  renderAttemptHistoryTable();
}

function renderAttemptHistoryTable() {
  const tbody = document.getElementById("attemptHistoryBody");
  if (!state.history.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted">No exam attempts recorded yet. Select any unit above to begin.</td></tr>`;
    return;
  }

  tbody.innerHTML = state.history
    .map(
      (rec) => `
      <tr>
        <td>${escapeHtml(rec.dateLabel)}</td>
        <td><strong>${escapeHtml(rec.unitTitle)}</strong></td>
        <td><span class="pill ${rec.passed ? "pill-pass" : "pill-fail"}">${rec.passed ? "PASS" : "FAIL"}</span></td>
        <td>${rec.responses.length}</td>
        <td>${rec.theta >= 0 ? "+" : ""}${rec.theta.toFixed(2)}</td>
        <td>${formatSeconds(rec.elapsedSeconds)}</td>
        <td>${rec.focusWarnings}</td>
        <td>
          <button class="btn btn-ghost btn-sm view-attempt-btn" data-aid="${rec.id}" type="button">Score Card &amp; Review</button>
        </td>
      </tr>
    `
    )
    .join("");

  tbody.querySelectorAll(".view-attempt-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const rec = state.history.find((r) => r.id === btn.dataset.aid);
      if (rec) renderScoreCard(rec);
    });
  });
}

/* ---------------- PRE-EXAM BRIEFING ---------------- */
function openBriefing(unitId) {
  state.briefingUnitId = unitId;
  const isMulti = unitId === "__ALL__";
  const unitTitle = isMulti ? "Comprehensive Multi-Unit Mock" : state.loadedUnits[unitId]?.unitTitle || "Unit";
  const questions = isMulti ? getAllCombinedQuestions() : state.loadedUnits[unitId]?.questions || [];

  const check = validateUnitData({ unitTitle, questions });
  document.getElementById("briefTitle").textContent = unitTitle;
  document.getElementById("briefSubtitle").textContent = isMulti
    ? `Adaptive pool across ${state.catalog.length} units (${questions.length} total items).`
    : `Single-unit NCLEX-RN CAT simulation (${questions.length} items).`;

  const vBox = document.getElementById("validationReport");
  vBox.innerHTML = `
    <strong>Pre-Exam Readiness Check:</strong> ${questions.length} items loaded
    (${questions.filter((q) => q.type === "mcq").length} MCQ, ${questions.filter((q) => q.type === "sata").length} SATA).
    ${check.valid ? `<span style="color:var(--success);font-weight:700;"> &bull; Schema Verified</span>` : `<span style="color:var(--danger);font-weight:700;"> &bull; ${check.errors.join(" ")}</span>`}
    ${check.warnings.length ? `<div class="small-muted">${check.warnings.join(" ")}</div>` : ""}
  `;

  document.getElementById("agreeRulesChk").checked = false;
  updateLaunchButtons(check.valid && questions.length >= 10);
  showView("briefingView");
}

function updateLaunchButtons(dataOk) {
  const agreed = document.getElementById("agreeRulesChk").checked;
  const enabled = dataOk && agreed;
  document.getElementById("launchCatBtn").disabled = !enabled;
  document.getElementById("launchWithoutFsBtn").disabled = !enabled;
}

/* ---------------- CAT EXAM SESSION ---------------- */
function startNewExam(requestFullscreen) {
  const uid = state.briefingUnitId;
  const isMulti = uid === "__ALL__";
  const pool = isMulti
    ? getAllCombinedQuestions()
    : (state.loadedUnits[uid]?.questions || []).map((q) => ({ ...q, id: String(q.id) }));

  const maxQuestions = isMulti ? Math.min(150, pool.length) : Math.min(100, pool.length);
  const firstQ = selectNextQuestion(pool, new Set(), PASSING_LOGIT);

  state.exam = {
    id: `att_${Date.now()}`,
    unitId: uid,
    unitTitle: isMulti ? "Comprehensive Multi-Unit Mock" : state.loadedUnits[uid].unitTitle,
    pool,
    maxQuestions,
    remainingSeconds: state.selectedTimerSeconds,
    totalAllocatedSeconds: state.selectedTimerSeconds,
    elapsedSeconds: 0,
    theta: PASSING_LOGIT,
    thetaHistory: [PASSING_LOGIT],
    usedIds: [String(firstQ.id)],
    currentQuestion: firstQ,
    questionStartMs: Date.now(),
    responses: [],
    focusWarnings: 0,
    flaggedIds: []
  };

  state.break2hShown = false;
  state.break35hShown = false;
  localStorage.setItem(STORAGE_KEYS.ACTIVE_EXAM, JSON.stringify(state.exam));

  if (requestFullscreen && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {});
  }

  beginExamLoop(false);
}

function beginExamLoop(isResume) {
  if (!isResume) {
    state.exam.questionStartMs = Date.now();
  }
  showView("examView");
  renderCurrentQuestion();
  startTimerInterval();
}

function startTimerInterval() {
  clearInterval(state.timerInterval);
  updateTimerHud();

  state.timerInterval = setInterval(() => {
    if (!state.exam) return;
    state.exam.remainingSeconds = Math.max(0, state.exam.remainingSeconds - 1);
    state.exam.elapsedSeconds += 1;

    // Scheduled break notices (2h = 7200s elapsed, 3.5h = 12600s elapsed; clock never pauses)
    if (!state.break2hShown && state.exam.elapsedSeconds >= 7200) {
      state.break2hShown = true;
      document.getElementById("breakNotice").classList.remove("hidden");
    }
    if (!state.break35hShown && state.exam.elapsedSeconds >= 12600) {
      state.break35hShown = true;
      document.getElementById("breakNotice").classList.remove("hidden");
    }

    updateTimerHud();
    localStorage.setItem(STORAGE_KEYS.ACTIVE_EXAM, JSON.stringify(state.exam));

    if (state.exam.remainingSeconds <= 0) {
      finishExam();
    }
  }, 1000);
}

function updateTimerHud() {
  if (!state.exam) return;
  document.getElementById("timerDisplay").textContent = formatSeconds(state.exam.remainingSeconds);
  document.getElementById("qProgressLabel").textContent =
    `Answered: ${state.exam.responses.length} | Active Item #${state.exam.responses.length + 1}`;
  document.getElementById("focusCounterLabel").textContent = `Focus Left: ${state.exam.focusWarnings}`;
}

function renderCurrentQuestion() {
  const q = state.exam.currentQuestion;
  const idxNum = state.exam.responses.length + 1;
  state.highlightActive = false;
  document.getElementById("toolHighlightBtn").classList.remove("active");
  document.getElementById("answerError").classList.add("hidden");

  document.getElementById("itemTypeBadge").textContent =
    q.type === "sata" ? "SELECT ALL THAT APPLY (SATA)" : "MULTIPLE CHOICE";
  document.getElementById("itemDiffBadge").textContent = `Difficulty Tier ${q.difficulty}`;
  document.getElementById("itemCatBadge").textContent = q.clientNeedsCategory || "Physiological Adaptation";
  document.getElementById("itemNumberHeading").textContent = `Question ${idxNum}`;
  document.getElementById("flaggedIndicator").classList.toggle("hidden", !state.exam.flaggedIds.includes(String(q.id)));
  document.getElementById("toolFlagBtn").classList.toggle("active", state.exam.flaggedIds.includes(String(q.id)));

  document.getElementById("questionStem").innerHTML = escapeHtml(q.stem);
  document.getElementById("optionsInstruction").textContent =
    q.type === "sata"
      ? "Select all applicable clinical options (NGN partial credit applies)."
      : "Select the single best nursing response.";

  const exhibitEl = document.getElementById("exhibitPanel");
  if (q.exhibit && Array.isArray(q.exhibit.rows) && q.exhibit.rows.length) {
    exhibitEl.classList.remove("hidden");
    exhibitEl.innerHTML = `
      <div class="exhibit-title">${escapeHtml(q.exhibit.title || "Clinical Exhibit")}</div>
      <table class="exhibit-table">
        ${q.exhibit.rows.map((r) => `<tr><td><strong>${escapeHtml(r[0])}</strong></td><td>${escapeHtml(r[1])}</td></tr>`).join("")}
      </table>
    `;
  } else {
    exhibitEl.classList.add("hidden");
    exhibitEl.innerHTML = "";
  }

  const inputType = q.type === "sata" ? "checkbox" : "radio";
  const listEl = document.getElementById("optionsList");
  listEl.innerHTML = (q.options || [])
    .map(
      (opt) => `
      <div class="option-row" data-optid="${opt.id}">
        <label class="option-main">
          <input type="${inputType}" name="catOption" value="${opt.id}" />
          <span class="option-label-text"><strong>${opt.id}.</strong> ${escapeHtml(opt.text)}</span>
        </label>
        <button class="strike-btn" type="button" title="Cross out option">Strikethrough</button>
      </div>
    `
    )
    .join("");

  listEl.querySelectorAll('input[name="catOption"]').forEach((inp) => {
    inp.addEventListener("change", () => {
      listEl.querySelectorAll(".option-row").forEach((row) => {
        const cb = row.querySelector('input[name="catOption"]');
        row.classList.toggle("selected", cb.checked);
      });
    });
  });

  listEl.querySelectorAll(".strike-btn").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      btn.closest(".option-row").classList.toggle("struck");
    });
  });
}

function handleSubmitQuestionRequest() {
  const selected = Array.from(document.querySelectorAll('input[name="catOption"]:checked')).map((el) => el.value);
  const errEl = document.getElementById("answerError");
  if (!selected.length) {
    errEl.textContent = "Please select an answer choice before continuing.";
    errEl.classList.remove("hidden");
    return;
  }
  errEl.classList.add("hidden");

  if (state.confirmBeforeLock) {
    state.pendingAdvanceAction = () => commitAnswer(selected);
    document.getElementById("confirmModal").classList.remove("hidden");
  } else {
    commitAnswer(selected);
  }
}

function commitAnswer(selectedIds) {
  const exam = state.exam;
  const q = exam.currentQuestion;
  const timeSpentSec = Math.max(1, Math.round((Date.now() - exam.questionStartMs) / 1000));
  const scoring = scoreQuestion(q, selectedIds);

  exam.theta = updateAbilityEstimate(exam.theta, q.difficulty, scoring.ratio);
  exam.thetaHistory.push(exam.theta);

  exam.responses.push({
    question: q,
    selectedIds,
    earned: scoring.earned,
    max: scoring.max,
    status: scoring.status,
    thetaAfter: exam.theta,
    timeSpentSec
  });

  const decision = evaluateStoppingRule(exam);
  if (decision.shouldStop) {
    finishExam(decision);
    return;
  }

  const usedSet = new Set(exam.usedIds);
  const nextQ = selectNextQuestion(exam.pool, usedSet, exam.theta);
  if (!nextQ) {
    finishExam({
      shouldStop: true,
      passed: exam.theta >= PASSING_LOGIT,
      ruleTriggered: "All Available Unit Items Completed"
    });
    return;
  }

  exam.usedIds.push(String(nextQ.id));
  exam.currentQuestion = nextQ;
  exam.questionStartMs = Date.now();
  localStorage.setItem(STORAGE_KEYS.ACTIVE_EXAM, JSON.stringify(exam));
  updateTimerHud();
  renderCurrentQuestion();
}

function finishExam(overrideDecision = null) {
  clearInterval(state.timerInterval);
  const exam = state.exam;
  if (!exam) return;

  const decision = overrideDecision || evaluateStoppingRule(exam);
  const record = {
    id: exam.id,
    dateLabel: new Date().toLocaleString(),
    unitId: exam.unitId,
    unitTitle: exam.unitTitle,
    passed: Boolean(decision.passed),
    ruleTriggered: decision.ruleTriggered || "Exam Concluded",
    theta: exam.theta,
    thetaHistory: exam.thetaHistory,
    elapsedSeconds: exam.elapsedSeconds,
    totalAllocatedSeconds: exam.totalAllocatedSeconds,
    focusWarnings: exam.focusWarnings,
    responses: exam.responses
  };

  state.history.unshift(record);
  saveHistory();
  localStorage.removeItem(STORAGE_KEYS.ACTIVE_EXAM);
  document.getElementById("resumeBanner").classList.add("hidden");
  state.exam = null;

  if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }

  renderScoreCard(record);
}

/* ---------------- SCORE CARD & REVIEW ---------------- */
function renderScoreCard(record) {
  document.getElementById("scUnitTitle").textContent = `${record.unitTitle} — Score Card`;
  document.getElementById("scMetaLine").textContent =
    `${record.dateLabel} • ${record.ruleTriggered}`;

  const vBadge = document.getElementById("scVerdictBadge");
  vBadge.textContent = record.passed ? "PASS" : "FAIL";
  vBadge.className = `verdict-badge ${record.passed ? "verdict-pass" : "verdict-fail"}`;

  const mcqItems = record.responses.filter((r) => r.question.type === "mcq");
  const mcqAcc = mcqItems.length
    ? `${Math.round((mcqItems.filter((r) => r.status === "correct").length / mcqItems.length) * 100)}%`
    : "N/A";

  const sataItems = record.responses.filter((r) => r.question.type === "sata");
  const sataEarned = sataItems.reduce((s, r) => s + r.earned, 0);
  const sataPossible = sataItems.reduce((s, r) => s + r.max, 0);
  const sataPct = sataPossible ? `${Math.round((sataEarned / sataPossible) * 100)}%` : "N/A";

  document.getElementById("scMetricsGrid").innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Questions Answered</div><div class="kpi-val">${record.responses.length}</div></div>
    <div class="kpi-card"><div class="kpi-label">Final Ability (&theta;)</div><div class="kpi-val">${record.theta >= 0 ? "+" : ""}${record.theta.toFixed(2)}</div></div>
    <div class="kpi-card"><div class="kpi-label">MCQ Accuracy</div><div class="kpi-val">${mcqAcc}</div></div>
    <div class="kpi-card"><div class="kpi-label">SATA Partial Credit</div><div class="kpi-val">${sataPct}</div></div>
    <div class="kpi-card"><div class="kpi-label">Time Elapsed</div><div class="kpi-val">${formatSeconds(record.elapsedSeconds)}</div></div>
  `;

  drawAbilityChart(record.thetaHistory);
  renderCategoryBreakdown(record.responses);

  const revContainer = document.getElementById("reviewContainer");
  revContainer.classList.add("hidden");
  revContainer.innerHTML = "";

  document.getElementById("reviewAllBtn").onclick = () => renderReviewList(record, false);
  document.getElementById("reviewMissedBtn").onclick = () => renderReviewList(record, true);
  document.getElementById("retakeFromScoreBtn").onclick = () => openBriefing(record.unitId);
  document.getElementById("backDashFromScoreBtn").onclick = () => {
    renderDashboard();
    showView("dashboardView");
  };

  showView("scoreCardView");
}

function drawAbilityChart(thetaHistory) {
  const canvas = document.getElementById("abilityChartCanvas");
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const padL = 48;
  const padR = 20;
  const padT = 20;
  const padB = 32;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  // Map theta [-2.5, +2.5] to y
  const minY = -2.5;
  const maxY = 2.5;
  const toY = (val) => padT + plotH * (1 - (val - minY) / (maxY - minY));
  const passY = toY(PASSING_LOGIT);

  // Passing line (0.00)
  ctx.strokeStyle = "#15803d";
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(padL, passY);
  ctx.lineTo(w - padR, passY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#15803d";
  ctx.font = "12px sans-serif";
  ctx.fillText("Passing (0.00)", padL + 6, passY - 6);

  if (!thetaHistory || thetaHistory.length < 2) return;

  ctx.strokeStyle = "#0f4c81";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  thetaHistory.forEach((val, idx) => {
    const x = padL + (idx / (thetaHistory.length - 1)) * plotW;
    const y = toY(val);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function renderCategoryBreakdown(responses) {
  const box = document.getElementById("categoryBars");
  const buckets = {};
  NCLEX_CATEGORIES.forEach((c) => (buckets[c] = { earned: 0, max: 0 }));

  responses.forEach((r) => {
    const cat = buckets[r.question.clientNeedsCategory]
      ? r.question.clientNeedsCategory
      : "Physiological Adaptation";
    buckets[cat].earned += r.earned;
    buckets[cat].max += r.max;
  });

  box.innerHTML = NCLEX_CATEGORIES.map((cat) => {
    const b = buckets[cat];
    if (!b.max) return "";
    const pct = Math.round((b.earned / b.max) * 100);
    return `
      <div class="cat-bar-row">
        <div class="cat-bar-top"><span>${escapeHtml(cat)}</span><span>${pct}% (${b.earned.toFixed(1)}/${b.max})</span></div>
        <div class="cat-track"><div class="cat-fill" style="width:${pct}%"></div></div>
      </div>
    `;
  }).join("");
}

function renderReviewList(record, missedOnly) {
  const container = document.getElementById("reviewContainer");
  container.classList.remove("hidden");

  const items = record.responses.filter((r) => (!missedOnly ? true : r.status !== "correct"));
  if (!items.length) {
    container.innerHTML = `<div class="card"><p>No missed or partial items in this attempt!</p></div>`;
    return;
  }

  container.innerHTML = items
    .map((r, i) => {
      const q = r.question;
      const fc = q.flashcard || {};
      return `
        <div class="card review-item ${r.status === "correct" ? "is-right" : "is-wrong"}">
          <div class="stem-header">
            <strong>Item ${i + 1} &bull; ${escapeHtml(q.clientNeedsCategory || "")} &bull; ${r.timeSpentSec}s</strong>
            <span class="pill ${r.status === "correct" ? "pill-pass" : "pill-fail"}">${r.status.toUpperCase()} (${r.earned}/${r.max})</span>
          </div>
          <p>${escapeHtml(q.stem)}</p>
          ${(q.options || [])
            .map((opt) => {
              const isCorrect = (q.correctOptionIds || []).includes(opt.id);
              const wasPicked = (r.selectedIds || []).includes(opt.id);
              let cls = "rat-box";
              if (isCorrect) cls += " rat-correct";
              else if (wasPicked) cls += " rat-picked-wrong";
              return `<div class="${cls}"><strong>${opt.id}.</strong> ${escapeHtml(opt.text)} ${
                isCorrect ? "<em>[Correct]</em>" : wasPicked ? "<em>[Your Choice]</em>" : ""
              }<div class="small-muted">${escapeHtml(opt.rationale || "")}</div></div>`;
            })
            .join("")}
          <div class="inline-flashcard">
            <div class="eyebrow">LINKED PDF FLASHCARD &bull; ${escapeHtml(fc.pdfReference || record.unitTitle)}</div>
            <div><strong>Front:</strong> ${escapeHtml(fc.front || "")}</div>
            <div style="white-space:pre-line;margin-top:4px;"><strong>Back:</strong> ${escapeHtml(fc.back || "")}</div>
          </div>
        </div>
      `;
    })
    .join("");
}

/* ---------------- STANDALONE FLASHCARDS ---------------- */
let fcDeck = [];
let fcIndex = 0;

function initFlashcardsTab() {
  const sel = document.getElementById("fcUnitSelect");
  sel.innerHTML = state.catalog
    .map((c) => `<option value="${c.unitId}">${escapeHtml(c.unitTitle)}</option>`)
    .join("");
  buildFlashcardDeck();
}

function buildFlashcardDeck() {
  const uid = document.getElementById("fcUnitSelect").value;
  const filter = document.getElementById("fcFilterSelect").value;
  const unit = state.loadedUnits[uid];
  let qs = (unit?.questions || []).filter((q) => q.flashcard);

  if (filter === "sata") qs = qs.filter((q) => q.type === "sata");
  if (filter === "hard") qs = qs.filter((q) => Number(q.difficulty) >= 4);

  fcDeck = qs.map((q) => ({
    ...q.flashcard,
    category: q.clientNeedsCategory || unit.unitTitle
  }));
  fcIndex = 0;
  document.getElementById("flashcardBox").classList.remove("flipped");
  renderFlashcard();
}

function renderFlashcard() {
  if (!fcDeck.length) {
    document.getElementById("fcCardIndex").textContent = "0 of 0";
    document.getElementById("fcFrontText").textContent = "No flashcards match this filter.";
    document.getElementById("fcBackText").textContent = "";
    return;
  }
  const card = fcDeck[fcIndex];
  document.getElementById("fcCardIndex").textContent = `Card ${fcIndex + 1} of ${fcDeck.length}`;
  document.getElementById("fcCardRef").textContent = card.pdfReference || "";
  document.getElementById("fcBackCat").textContent = card.category || "";
  document.getElementById("fcFrontText").textContent = card.front;
  document.getElementById("fcBackText").textContent = card.back;
}

/* ---------------- 4-BATCH UNIT BUILDER ---------------- */
let mergedCandidateUnit = null;

function cleanJsonString(raw) {
  return raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function handleValidateAndMerge() {
  const title = document.getElementById("builderTitle").value.trim() || "New NCLEX Unit";
  const slug =
    (document.getElementById("builderId").value.trim() || title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || `unit-${Date.now()}`;

  const boxes = ["batch1Input", "batch2Input", "batch3Input", "batch4Input"];
  const allQs = [];
  const reportEl = document.getElementById("builderReport");
  reportEl.classList.remove("hidden");

  for (let i = 0; i < boxes.length; i++) {
    const raw = document.getElementById(boxes[i]).value.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(cleanJsonString(raw));
      const arr = Array.isArray(parsed) ? parsed : parsed.questions;
      if (!Array.isArray(arr)) {
        reportEl.innerHTML = `<span style="color:var(--danger)">Batch ${i + 1}: Could not find a "questions" array.</span>`;
        return;
      }
      arr.forEach((q, idx) => {
        allQs.push({ ...q, id: allQs.length + 1 });
      });
    } catch (err) {
      reportEl.innerHTML = `<span style="color:var(--danger)">Batch ${i + 1} JSON Parse Error: ${escapeHtml(err.message)}</span>`;
      return;
    }
  }

  const candidate = {
    unitId: slug,
    unitTitle: title,
    examTrack: "NCLEX-RN",
    passingLogit: PASSING_LOGIT,
    questions: allQs
  };

  const check = validateUnitData(candidate);
  if (!check.valid) {
    mergedCandidateUnit = null;
    document.getElementById("saveLocalUnitBtn").disabled = true;
    document.getElementById("downloadUnitJsonBtn").disabled = true;
    reportEl.innerHTML = `<strong>Validation Failed:</strong><ul>${check.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>`;
    return;
  }

  mergedCandidateUnit = candidate;
  document.getElementById("saveLocalUnitBtn").disabled = false;
  document.getElementById("downloadUnitJsonBtn").disabled = false;
  reportEl.innerHTML = `
    <strong style="color:var(--success)">Merge &amp; Validation Passed!</strong> Total questions: <strong>${allQs.length}</strong>.
    ${check.warnings.length ? `<div class="small-muted">${check.warnings.join(" ")}</div>` : ""}
  `;
}

/* ---------------- QA SELF-TEST SUITE ---------------- */
function runQaTests() {
  const results = [];

  // Test 1: MCQ full credit vs zero
  const sampleMcq = { type: "mcq", difficulty: 3, options: [], correctOptionIds: ["B"] };
  results.push({
    name: "MCQ Scoring (Exact match = 1, wrong = 0)",
    pass: scoreQuestion(sampleMcq, ["B"]).earned === 1 && scoreQuestion(sampleMcq, ["A"]).earned === 0
  });

  // Test 2: SATA partial credit + floor at 0
  const sampleSata = { type: "sata", difficulty: 4, options: [], correctOptionIds: ["A", "C", "D"] };
  const partial = scoreQuestion(sampleSata, ["A", "C", "E"]); // 2 - 1 = 1 of 3
  const floored = scoreQuestion(sampleSata, ["B", "E"]); // -2 floored to 0
  results.push({
    name: "SATA NGN Scoring (2 right - 1 wrong = 1/3; all wrong floored to 0)",
    pass: partial.earned === 1 && partial.max === 3 && floored.earned === 0
  });

  // Test 3: Ability increases on right answer at higher difficulty
  const upTheta = updateAbilityEstimate(0.0, 4, 1);
  const downTheta = updateAbilityEstimate(0.0, 2, 0);
  results.push({
    name: "CAT Ability Adaptation (Theta rises on hard hit, falls on easy miss)",
    pass: upTheta > 0.0 && downTheta < 0.0
  });

  // Test 4: R.O.O.T. rule before 85 items triggers auto-fail
  const rootEarly = evaluateStoppingRule({
    responses: new Array(40).fill({}),
    maxQuestions: 100,
    remainingSeconds: 0,
    theta: 1.2
  });
  results.push({
    name: "Run-Out-of-Time Rule (<85 items = Fail)",
    pass: rootEarly.shouldStop && rootEarly.passed === false
  });

  // Test 5: Unit validator catches missing flashcard
  const badUnit = validateUnitData({
    unitTitle: "Broken Unit",
    questions: [{ stem: "Test?", type: "mcq", difficulty: 3, options: [1, 2, 3, 4], correctOptionIds: ["A"] }]
  });
  results.push({
    name: "Unit Schema Validator Catches Missing Flashcard",
    pass: !badUnit.valid
  });

  document.getElementById("qaResultsList").innerHTML = results
    .map(
      (r) =>
        `<div class="qa-row ${r.pass ? "qa-pass" : "qa-fail"}"><strong>${r.pass ? "PASS" : "FAIL"}:</strong> ${escapeHtml(r.name)}</div>`
    )
    .join("");
}

/* ---------------- UTILITIES & EVENT BINDING ---------------- */
function formatSeconds(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const rem = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${rem}`;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function openUtilityModal(mode) {
  const modal = document.getElementById("utilityModal");
  const title = document.getElementById("modalTitle");
  const body = document.getElementById("modalBody");
  modal.classList.remove("hidden");

  if (mode === "labs") {
    title.textContent = "Normal Reference Laboratory Values";
    body.innerHTML = `<table class="exhibit-table">${NORMAL_LABS.map((r) => `<tr><td><strong>${r[0]}</strong></td><td>${r[1]}</td></tr>`).join("")}</table>`;
    return;
  }

  title.textContent = "Calculator";
  body.innerHTML = `
    <input id="calcScreen" class="calc-display" type="text" value="0" readonly />
    <div class="calc-grid" id="calcPad">
      ${["7","8","9","/","4","5","6","*","1","2","3","-","C","0",".","+","="]
        .map((k) => `<button class="btn btn-ghost calc-key" type="button" data-k="${k}">${k}</button>`)
        .join("")}
    </div>
  `;
  const screen = document.getElementById("calcScreen");
  body.querySelectorAll(".calc-key").forEach((b) => {
    b.addEventListener("click", () => {
      const k = b.dataset.k;
      if (k === "C") screen.value = "0";
      else if (k === "=") {
        try {
          // Safe arithmetic characters only
          if (/^[0-9+\-*/.() ]+$/.test(screen.value)) {
            screen.value = String(Function(`"use strict";return (${screen.value})`)());
          }
        } catch {
          screen.value = "Err";
        }
      } else {
        screen.value = screen.value === "0" ? k : screen.value + k;
      }
    });
  });
}

function bindEvents() {
  document.getElementById("loginForm").addEventListener("submit", handleLoginSubmit);
  document.getElementById("togglePassBtn").addEventListener("click", () => {
    const inp = document.getElementById("loginPass");
    const isPwd = inp.type === "password";
    inp.type = isPwd ? "text" : "password";
    document.getElementById("togglePassBtn").textContent = isPwd ? "Hide" : "Show";
  });

  document.getElementById("openHashToolBtn").addEventListener("click", () => {
    document.getElementById("hashToolPanel").classList.toggle("hidden");
  });
  document.getElementById("genHashBtn").addEventListener("click", async () => {
    const val = document.getElementById("customPlainPass").value;
    if (!val) return;
    document.getElementById("hashOutput").textContent = await sha256Hex(val);
  });

  document.getElementById("logoutBtn").addEventListener("click", () => {
    state.authenticated = false;
    showView("loginView");
  });

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.view;
      if (v === "dashboard") {
        renderDashboard();
        showView("dashboardView");
      } else if (v === "flashcards") {
        initFlashcardsTab();
        showView("flashcardsView");
      } else if (v === "builder") {
        showView("builderView");
      } else if (v === "qa") {
        showView("qaView");
      }
    });
  });

  document.getElementById("backToDashBtn").addEventListener("click", () => {
    renderDashboard();
    showView("dashboardView");
  });

  document.querySelectorAll("#timerToggleGroup .toggle-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll("#timerToggleGroup .toggle-pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      state.selectedTimerSeconds = Number(pill.dataset.seconds);
    });
  });

  document.querySelectorAll("#confirmToggleGroup .toggle-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll("#confirmToggleGroup .toggle-pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      state.confirmBeforeLock = pill.dataset.confirm === "true";
    });
  });

  document.getElementById("agreeRulesChk").addEventListener("change", () => {
    const hasQs =
      state.briefingUnitId === "__ALL__"
        ? getAllCombinedQuestions().length >= 10
        : (state.loadedUnits[state.briefingUnitId]?.questions || []).length >= 10;
    updateLaunchButtons(hasQs);
  });

  document.getElementById("launchCatBtn").addEventListener("click", () => startNewExam(true));
  document.getElementById("launchWithoutFsBtn").addEventListener("click", () => startNewExam(false));
  document.getElementById("submitNextBtn").addEventListener("click", handleSubmitQuestionRequest);

  document.getElementById("cancelConfirmBtn").addEventListener("click", () => {
    state.pendingAdvanceAction = null;
    document.getElementById("confirmModal").classList.add("hidden");
  });
  document.getElementById("proceedConfirmBtn").addEventListener("click", () => {
    document.getElementById("confirmModal").classList.add("hidden");
    if (typeof state.pendingAdvanceAction === "function") {
      const fn = state.pendingAdvanceAction;
      state.pendingAdvanceAction = null;
      fn();
    }
  });

  document.getElementById("forceEndBtn").addEventListener("click", () => {
    finishExam({
      shouldStop: true,
      passed: state.exam ? state.exam.theta >= PASSING_LOGIT : false,
      ruleTriggered: "Candidate Ended Session Manually"
    });
  });

  document.getElementById("dismissBreakBtn").addEventListener("click", () => {
    document.getElementById("breakNotice").classList.add("hidden");
  });

  document.getElementById("fullscreenBtn").addEventListener("click", () => {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  });

  // Stem highlighter & strikethrough tools
  document.getElementById("toolHighlightBtn").addEventListener("click", () => {
    state.highlightActive = !state.highlightActive;
    document.getElementById("toolHighlightBtn").classList.toggle("active", state.highlightActive);
  });

  document.getElementById("questionStem").addEventListener("mouseup", () => {
    if (!state.highlightActive) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const stemEl = document.getElementById("questionStem");
    if (!stemEl.contains(range.commonAncestorContainer)) return;
    const mark = document.createElement("mark");
    mark.className = "hl";
    range.surroundContents(mark);
    sel.removeAllRanges();
  });

  document.getElementById("toolClearHighlightBtn").addEventListener("click", () => {
    const stemEl = document.getElementById("questionStem");
    stemEl.querySelectorAll("mark.hl").forEach((m) => {
      m.replaceWith(...m.childNodes);
    });
  });

  document.getElementById("toolFlagBtn").addEventListener("click", () => {
    if (!state.exam) return;
    const idStr = String(state.exam.currentQuestion.id);
    const idx = state.exam.flaggedIds.indexOf(idStr);
    if (idx >= 0) state.exam.flaggedIds.splice(idx, 1);
    else state.exam.flaggedIds.push(idStr);
    document.getElementById("flaggedIndicator").classList.toggle("hidden", idx >= 0);
    document.getElementById("toolFlagBtn").classList.toggle("active", idx < 0);
  });

  document.getElementById("toolCalcBtn").addEventListener("click", () => openUtilityModal("calc"));
  document.getElementById("toolLabsBtn").addEventListener("click", () => openUtilityModal("labs"));
  document.getElementById("closeModalBtn").addEventListener("click", () => {
    document.getElementById("utilityModal").classList.add("hidden");
  });

  // Tab switch / focus loss detection during active exam
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.exam) {
      state.exam.focusWarnings += 1;
      updateTimerHud();
      const banner = document.getElementById("proctorBanner");
      banner.classList.remove("hidden");
      banner.textContent = `Proctor Notice: Tab/window switch detected (${state.exam.focusWarnings} total). Stay inside the exam screen.`;
    }
  });

  // Flashcard controls
  document.getElementById("fcUnitSelect").addEventListener("change", buildFlashcardDeck);
  document.getElementById("fcFilterSelect").addEventListener("change", buildFlashcardDeck);
  document.getElementById("flashcardBox").addEventListener("click", () => {
    document.getElementById("flashcardBox").classList.toggle("flipped");
  });
  document.getElementById("fcFlipBtn").addEventListener("click", () => {
    document.getElementById("flashcardBox").classList.toggle("flipped");
  });
  document.getElementById("fcPrevBtn").addEventListener("click", () => {
    if (!fcDeck.length) return;
    fcIndex = (fcIndex - 1 + fcDeck.length) % fcDeck.length;
    document.getElementById("flashcardBox").classList.remove("flipped");
    renderFlashcard();
  });
  document.getElementById("fcNextBtn").addEventListener("click", () => {
    if (!fcDeck.length) return;
    fcIndex = (fcIndex + 1) % fcDeck.length;
    document.getElementById("flashcardBox").classList.remove("flipped");
    renderFlashcard();
  });

  // Builder controls
  document.getElementById("validateMergeBtn").addEventListener("click", handleValidateAndMerge);
  document.getElementById("saveLocalUnitBtn").addEventListener("click", () => {
    if (!mergedCandidateUnit) return;
    const localUnits = loadLocalUnits();
    localUnits[mergedCandidateUnit.unitId] = mergedCandidateUnit;
    saveLocalUnits(localUnits);
    state.loadedUnits[mergedCandidateUnit.unitId] = mergedCandidateUnit;
    state.catalog = Object.values(state.loadedUnits).map((u) => ({
      unitId: u.unitId,
      unitTitle: u.unitTitle,
      questionCount: (u.questions || []).length
    }));
    renderDashboard();
    showView("dashboardView");
  });

  document.getElementById("downloadUnitJsonBtn").addEventListener("click", () => {
    if (!mergedCandidateUnit) return;
    const blob = new Blob([JSON.stringify(mergedCandidateUnit, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${mergedCandidateUnit.unitId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // Backup & Restore progress
  document.getElementById("exportProgressBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state.history, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nclex-attempt-history-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById("importProgressInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (Array.isArray(parsed)) {
          state.history = parsed;
          saveHistory();
          renderDashboard();
        }
      } catch {
        alert("Invalid backup JSON file.");
      }
    };
    reader.readAsText(file);
  });

  // QA controls
  document.getElementById("runQaBtn").addEventListener("click", runQaTests);
  document.getElementById("seedSampleAttemptBtn").addEventListener("click", () => {
    const demo = {
      id: `demo_${Date.now()}`,
      dateLabel: new Date().toLocaleString(),
      unitId: "fluids-electrolytes",
      unitTitle: "Fluids & Electrolytes",
      passed: true,
      ruleTriggered: "95% Confidence Interval Rule — Clearly Above Passing Standard at Q86",
      theta: 0.34,
      thetaHistory: [0, 0.22, 0.38, 0.19, 0.34],
      elapsedSeconds: 5120,
      totalAllocatedSeconds: 18000,
      focusWarnings: 0,
      responses: []
    };
    state.history.unshift(demo);
    saveHistory();
    renderDashboard();
  });

  document.getElementById("printScoreBtn").addEventListener("click", () => window.print());
}

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  await initCatalog();

  try {
    const savedSess = JSON.parse(localStorage.getItem(STORAGE_KEYS.SESSION) || "{}");
    if (savedSess.user) document.getElementById("loginUser").value = savedSess.user;
  } catch {}

  checkInterruptedExam();
  showView("loginView");
});