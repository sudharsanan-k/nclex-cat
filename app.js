/* ============================================================================
 * NCLEX-RN CAT TEMPLATE ENGINE
 * - Automatic GitHub data/ folder discovery (zero units.json required)
 * - 1-Shot Compact JSON Auto-Expander + Full Schema Validator
 * - Pre-Test Unit Selector Dropdown + Multi-Attempt Dashboard + Score Card
 * ============================================================================ */

const STORAGE_KEYS = {
  SESSION: "nclex_cat_session_v2",
  HISTORY: "nclex_cat_history_v2",
  LOCAL_UNITS: "nclex_cat_local_units_v2",
  GH_INDEX_CACHE: "nclex_cat_gh_index_v2",
  GH_REPO_OVERRIDE: "nclex_cat_gh_repo_v2",
  ACTIVE_EXAM: "nclex_cat_active_exam_v2"
};

const AUTH_CONFIG = {
  username: "candidate",
  candidateName: "RN Candidate",
  candidateId: "RN-2026-085",
  passwordSha256: "" // Default "Nclex2026!" hashed on runtime
};

const DIFFICULTY_LOGITS = {
  1: -1.5,
  2: -0.75,
  3: 0.0,
  4: 0.75,
  5: 1.5
};

const PASSING_LOGIT = 0.0;

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

const CJMM_SKILLS = [
  "Recognize Cues",
  "Analyze Cues",
  "Prioritize Hypotheses",
  "Generate Solutions",
  "Take Action",
  "Evaluate Outcomes"
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
  discoveredGithubFiles: [], // [{ fileName, slug, displayTitle, downloadUrl }]
  loadedUnits: {}, // unitId -> normalized unitObject
  history: [],
  selectedDropdownUnitId: "",
  briefingUnitId: null,
  selectedTimerSeconds: 18000,
  confirmBeforeLock: true,
  exam: null,
  timerInterval: null,
  highlightActive: false,
  break2hShown: false,
  break35hShown: false,
  pendingAdvanceAction: null,
  lastValidatedNormalizedUnit: null
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

function slugify(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/\.json$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || `unit-${Date.now()}`;
}

function titleFromFilename(fileName) {
  return String(fileName || "")
    .replace(/\.json$/i, "")
    .split(/[-_]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" ");
}

/* ---------------- COMPACT JSON AUTO-EXPANDER ---------------- */
function normalizeUnitPayload(rawObj, fallbackTitle = "Uploaded NCLEX Unit") {
  if (!rawObj || typeof rawObj !== "object") return null;

  // Detect 1-Shot Compact Schema (Workaround A: keys "u" and "q")
  const isCompact = Array.isArray(rawObj.q) && !Array.isArray(rawObj.questions);
  if (!isCompact) {
    const unitTitle = String(rawObj.unitTitle || rawObj.u || fallbackTitle).trim();
    const unitId = slugify(rawObj.unitId || unitTitle);
    return {
      unitId,
      unitTitle,
      examTrack: rawObj.examTrack || "NCLEX-RN",
      passingLogit: PASSING_LOGIT,
      source: rawObj.source || "Local Upload",
      questions: Array.isArray(rawObj.questions) ? rawObj.questions : []
    };
  }

  const unitTitle = String(rawObj.u || fallbackTitle).trim();
  const unitId = slugify(rawObj.unitId || unitTitle);

  const expandedQuestions = (rawObj.q || []).map((item, idx) => {
    const qType = item.t === "s" || item.t === "sata" ? "sata" : "mcq";
    const catIdx = Number(item.c) - 1;
    const category =
      NCLEX_CATEGORIES[catIdx] ||
      (typeof item.c === "string" ? item.c : "Physiological Adaptation");

    const cjmmIdx = Number(item.j) - 1;
    const cjmmSkill =
      CJMM_SKILLS[cjmmIdx] ||
      (typeof item.j === "string" ? item.j : "Analyze Cues");

    const options = Array.isArray(item.o)
      ? item.o.map((opt) =>
          Array.isArray(opt)
            ? { id: String(opt[0]), text: String(opt[1] ?? ""), rationale: String(opt[2] ?? "") }
            : opt
        )
      : [];

    let exhibit = null;
    if (item.ex && typeof item.ex === "object") {
      exhibit = {
        title: item.ex.title || item.ex.t || "Clinical Exhibit",
        rows: Array.isArray(item.ex.rows) ? item.ex.rows : Array.isArray(item.ex.r) ? item.ex.r : []
      };
    }

    let flashcard = { front: "", back: "", pdfReference: unitTitle };
    if (Array.isArray(item.fc)) {
      const bullets = String(item.fc[1] ?? "")
        .split(/\s*\|\s*/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => (line.startsWith("•") ? line : `• ${line}`))
        .join("\n");
      flashcard = {
        front: String(item.fc[0] ?? ""),
        back: bullets,
        pdfReference: String(item.fc[2] ?? unitTitle)
      };
    } else if (item.fc && typeof item.fc === "object") {
      flashcard = item.fc;
    }

    return {
      id: item.i ?? idx + 1,
      type: qType,
      difficulty: Number(item.d) || 3,
      clientNeedsCategory: category,
      clinicalJudgmentSkill: cjmmSkill,
      stem: String(item.st ?? ""),
      exhibit,
      options,
      correctOptionIds: Array.isArray(item.a) ? item.a.map(String) : [],
      educationalObjective: String(item.obj ?? ""),
      flashcard
    };
  });

  return {
    unitId,
    unitTitle,
    examTrack: "NCLEX-RN",
    passingLogit: PASSING_LOGIT,
    source: "Local Upload",
    questions: expandedQuestions
  };
}

/* ---------------- SCHEMA VALIDATOR ---------------- */
function validateUnitData(unitObj) {
  const errors = [];
  const warnings = [];

  if (!unitObj || typeof unitObj !== "object") {
    return { valid: false, errors: ["Unit payload is not a valid JSON object."], warnings };
  }
  if (!unitObj.unitTitle || String(unitObj.unitTitle).trim().length < 2) {
    errors.push("Missing unit title.");
  }
  const qs = unitObj.questions;
  if (!Array.isArray(qs) || qs.length === 0) {
    errors.push("Questions list is empty or missing.");
    return { valid: false, errors, warnings };
  }
  if (qs.length < 85) {
    warnings.push(`Contains ${qs.length} items (85–100 recommended for full single-unit NCLEX CAT stamina).`);
  }

  qs.forEach((q, i) => {
    const label = `Item #${i + 1}`;
    if (!q.stem || typeof q.stem !== "string") errors.push(`${label}: missing question stem.`);
    if (!["mcq", "sata"].includes(q.type)) errors.push(`${label}: invalid format "${q.type}".`);
    if (![1, 2, 3, 4, 5].includes(Number(q.difficulty))) errors.push(`${label}: difficulty must be 1–5.`);
    if (!Array.isArray(q.options) || q.options.length < 4) {
      errors.push(`${label}: requires at least 4 answer options.`);
    }
    if (!Array.isArray(q.correctOptionIds) || q.correctOptionIds.length === 0) {
      errors.push(`${label}: missing correctOptionIds.`);
    } else if (Array.isArray(q.options)) {
      const validIds = new Set(q.options.map((o) => String(o.id)));
      const invalidRefs = q.correctOptionIds.filter((cid) => !validIds.has(String(cid)));
      if (invalidRefs.length) {
        errors.push(`${label}: answer key references missing option ID(s): ${invalidRefs.join(", ")}.`);
      }
    }
    if (!q.flashcard || !q.flashcard.front || !q.flashcard.back) {
      errors.push(`${label}: missing attached PDF flashcard.`);
    }
  });

  return { valid: errors.length === 0, errors, warnings };
}

/* ---------------- GITHUB DATA/ AUTO-DISCOVERY ---------------- */
function detectGithubRepo() {
  const override = (localStorage.getItem(STORAGE_KEYS.GH_REPO_OVERRIDE) || "").trim();
  if (override && override.includes("/")) {
    const [owner, repo] = override.split("/");
    return { owner: owner.trim(), repo: repo.trim(), isLivePages: false };
  }

  const host = window.location.hostname || "";
  if (host.endsWith(".github.io")) {
    const owner = host.split(".")[0];
    const parts = (window.location.pathname || "").split("/").filter(Boolean);
    const repo = parts.length > 0 ? parts[0] : `${owner}.github.io`;
    return { owner, repo, isLivePages: true };
  }
  return null;
}

async function discoverGithubDataFolder(forceRefresh = false) {
  const repoInfo = detectGithubRepo();
  const statusEl = document.getElementById("githubDiscoveryStatus");

  // Load any locally uploaded units first
  const localUnits = loadLocalUnits();
  Object.values(localUnits).forEach((u) => {
    u.source = "Browser Storage";
    state.loadedUnits[u.unitId] = u;
  });

  if (!repoInfo) {
    if (statusEl) {
      statusEl.textContent = "Local preview mode (use Load Unit .json or set GitHub repo override).";
    }
    return;
  }

  const apiUrl = `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}/contents/data`;
  try {
    const res = await fetch(apiUrl, { cache: forceRefresh ? "no-store" : "default" });
    if (res.ok) {
      const entries = await res.json();
      const jsonFiles = (Array.isArray(entries) ? entries : [])
        .filter((f) => f.type === "file" && f.name.toLowerCase().endsWith(".json"))
        .map((f) => ({
          fileName: f.name,
          slug: slugify(f.name),
          displayTitle: titleFromFilename(f.name),
          downloadUrl: f.download_url
        }));

      state.discoveredGithubFiles = jsonFiles;
      localStorage.setItem(STORAGE_KEYS.GH_INDEX_CACHE, JSON.stringify(jsonFiles));
      if (statusEl) {
        statusEl.textContent = `Synced with GitHub (${repoInfo.owner}/${repoInfo.repo}/data): ${jsonFiles.length} file(s) found.`;
      }
      return;
    }
  } catch (err) {
    console.warn("GitHub API discovery fallback to cache:", err);
  }

  // Fallback to cached GitHub file list if API rate limit or offline
  try {
    const cached = JSON.parse(localStorage.getItem(STORAGE_KEYS.GH_INDEX_CACHE) || "[]");
    state.discoveredGithubFiles = cached;
    if (statusEl) {
      statusEl.textContent = cached.length
        ? `Using cached GitHub unit list (${cached.length} file(s)).`
        : "No GitHub data/ files detected yet.";
    }
  } catch {
    state.discoveredGithubFiles = [];
  }
}

async function ensureUnitLoaded(unitId) {
  if (!unitId || unitId === "__ALL__") return true;
  if (state.loadedUnits[unitId]) return true;

  const ghEntry = state.discoveredGithubFiles.find((f) => f.slug === unitId);
  if (!ghEntry) return false;

  const repoInfo = detectGithubRepo();
  const fetchUrl =
    repoInfo && repoInfo.isLivePages
      ? `./data/${encodeURIComponent(ghEntry.fileName)}`
      : ghEntry.downloadUrl;

  const res = await fetch(fetchUrl);
  if (!res.ok) return false;

  const rawJson = await res.json();
  const normalized = normalizeUnitPayload(rawJson, ghEntry.displayTitle);
  if (!normalized) return false;

  normalized.unitId = ghEntry.slug;
  normalized.source = "GitHub data/";
  state.loadedUnits[normalized.unitId] = normalized;
  return true;
}

function getAllCatalogEntries() {
  const map = new Map();

  state.discoveredGithubFiles.forEach((f) => {
    const loaded = state.loadedUnits[f.slug];
    map.set(f.slug, {
      unitId: f.slug,
      unitTitle: loaded ? loaded.unitTitle : f.displayTitle,
      source: "GitHub data/",
      questionCount: loaded ? loaded.questions.length : null
    });
  });

  Object.values(state.loadedUnits).forEach((u) => {
    if (!map.has(u.unitId)) {
      map.set(u.unitId, {
        unitId: u.unitId,
        unitTitle: u.unitTitle,
        source: u.source || "Browser Storage",
        questionCount: (u.questions || []).length
      });
    }
  });

  return Array.from(map.values());
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

/* ---------------- CAT & NGN SCORING ENGINE ---------------- */
function scoreQuestion(question, selectedIds) {
  const correctSet = new Set(question.correctOptionIds || []);
  const chosenSet = new Set(selectedIds || []);

  if (question.type === "mcq") {
    const isFull =
      chosenSet.size === 1 &&
      correctSet.size === 1 &&
      [...chosenSet].every((id) => correctSet.has(id));
    return {
      earned: isFull ? 1 : 0,
      max: 1,
      ratio: isFull ? 1 : 0,
      status: isFull ? "correct" : "incorrect"
    };
  }

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
  const p = 1 / (1 + Math.exp(-(currentTheta - diffLogit)));
  const delta = 0.45 * (scoreRatio - p);
  return Math.max(-3.0, Math.min(3.0, Number((currentTheta + delta).toFixed(3))));
}

function computeStandardError(answeredCount) {
  return Number((1.45 / Math.sqrt(Math.max(1, answeredCount) + 6)).toFixed(3));
}

function selectNextQuestion(pool, usedIds, targetTheta) {
  const remaining = pool.filter((q) => !usedIds.has(String(q.id)));
  if (!remaining.length) return null;

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
  const maxQuestions = exam.maxQuestions;
  const minQuestions = Math.min(85, maxQuestions);
  const se = computeStandardError(n);
  const ciHalfWidth = 1.96 * se;
  const lower95 = exam.theta - ciHalfWidth;
  const upper95 = exam.theta + ciHalfWidth;

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

  if (n < minQuestions) {
    return { shouldStop: false, passed: null, ruleTriggered: null };
  }

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
    "importerView",
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
    btn.classList.toggle("active", btn.dataset.view === viewId.replace("View", ""));
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
    await renderDashboard();
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
      document.getElementById("resumeMeta").textContent =
        `${saved.unitTitle} — Item ${saved.responses.length + 1} • ${formatSeconds(saved.remainingSeconds)} left`;
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

/* ---------------- DASHBOARD & PRE-TEST UNIT SELECTOR ---------------- */
async function renderDashboard() {
  const entries = getAllCatalogEntries();
  const totalAttempts = state.history.length;
  const passes = state.history.filter((h) => h.passed).length;
  const passRate = totalAttempts ? `${Math.round((passes / totalAttempts) * 100)}%` : "—";
  const totalFlashcards = Object.values(state.loadedUnits).reduce(
    (sum, u) => sum + (u.questions || []).filter((q) => q.flashcard).length,
    0
  );

  document.getElementById("kpiGrid").innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Available Units</div><div class="kpi-val">${entries.length}</div></div>
    <div class="kpi-card"><div class="kpi-label">Total Attempts</div><div class="kpi-val">${totalAttempts}</div></div>
    <div class="kpi-card"><div class="kpi-label">Pass Rate</div><div class="kpi-val">${passRate}</div></div>
    <div class="kpi-card"><div class="kpi-label">Loaded Flashcards</div><div class="kpi-val">${totalFlashcards}</div></div>
  `;

  // Populate Pre-Test Unit Selector Dropdown
  const selectEl = document.getElementById("preTestUnitSelect");
  selectEl.innerHTML = "";

  if (!entries.length) {
    selectEl.innerHTML = `<option value="">-- No units found yet (Load a .json file or add to GitHub data/) --</option>`;
    document.getElementById("launchBriefingFromSelectBtn").disabled = true;
    document.getElementById("selectedUnitPreview").innerHTML =
      `No units loaded yet. Click <strong>Load Unit .json</strong> in the top bar or drop a <code>.json</code> file into your GitHub <code>data/</code> folder.`;
  } else {
    entries.forEach((entry) => {
      const opt = document.createElement("option");
      opt.value = entry.unitId;
      const qLabel = entry.questionCount ? `${entry.questionCount} Qs` : "Fetch from GitHub";
      opt.textContent = `${entry.unitTitle} (${qLabel} • ${entry.source})`;
      selectEl.appendChild(opt);
    });

    if (entries.length >= 2) {
      const multiOpt = document.createElement("option");
      multiOpt.value = "__ALL__";
      multiOpt.textContent = `All Units Combined Mock (85–150 Qs • All ${entries.length} Topics)`;
      selectEl.appendChild(multiOpt);
    }

    if (state.selectedDropdownUnitId && Array.from(selectEl.options).some((o) => o.value === state.selectedDropdownUnitId)) {
      selectEl.value = state.selectedDropdownUnitId;
    } else {
      state.selectedDropdownUnitId = selectEl.value;
    }

    await handleDropdownUnitSelection(selectEl.value);
  }

  document.getElementById("unitCatalogStatus").textContent =
    entries.length >= 2
      ? "Multi-Unit Comprehensive Mock (85–150 Qs) unlocked!"
      : "Add 2+ units to unlock 85–150 Q multi-unit mock.";

  const unitsGrid = document.getElementById("unitsGrid");
  unitsGrid.innerHTML = "";

  entries.forEach((meta) => {
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
        <div class="small-muted">${meta.questionCount ? `${meta.questionCount} questions` : "Ready to fetch from GitHub"}</div>
        <div class="unit-meta">
          <span class="pill pill-source">${escapeHtml(meta.source)}</span>
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

  unitsGrid.querySelectorAll(".start-unit-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await openBriefing(btn.dataset.uid);
    });
  });

  renderAttemptHistoryTable();
}

async function handleDropdownUnitSelection(unitId) {
  state.selectedDropdownUnitId = unitId;
  const previewEl = document.getElementById("selectedUnitPreview");
  const launchBtn = document.getElementById("launchBriefingFromSelectBtn");

  if (!unitId) {
    launchBtn.disabled = true;
    return;
  }

  previewEl.innerHTML = `<span class="small-muted">Fetching &amp; validating unit schema...</span>`;
  launchBtn.disabled = true;

  if (unitId === "__ALL__") {
    for (const f of state.discoveredGithubFiles) {
      await ensureUnitLoaded(f.slug);
    }
    const allQs = getAllCombinedQuestions();
    previewEl.innerHTML = `
      <strong>Selected: Comprehensive Multi-Unit Mock</strong> &bull; ${allQs.length} combined questions across ${Object.keys(state.loadedUnits).length} units &bull;
      <span style="color:var(--success);font-weight:700;">Ready for 85–150 Q CAT</span>
    `;
    launchBtn.disabled = allQs.length < 10;
    return;
  }

  const ok = await ensureUnitLoaded(unitId);
  const unit = state.loadedUnits[unitId];
  if (!ok || !unit) {
    previewEl.innerHTML = `<span style="color:var(--danger);font-weight:700;">Could not load unit file. Check network or re-upload the .json file.</span>`;
    return;
  }

  const check = validateUnitData(unit);
  const unitAttempts = state.history.filter((h) => h.unitId === unitId);
  const mcqCount = unit.questions.filter((q) => q.type === "mcq").length;
  const sataCount = unit.questions.filter((q) => q.type === "sata").length;

  previewEl.innerHTML = `
    <strong>${escapeHtml(unit.unitTitle)}</strong> (${unit.questions.length} items: ${mcqCount} MCQ, ${sataCount} SATA) &bull;
    Past Attempts: <strong>${unitAttempts.length}</strong> &bull;
    ${
      check.valid
        ? `<span style="color:var(--success);font-weight:700;">Schema Validated &amp; Integrated</span>`
        : `<span style="color:var(--danger);font-weight:700;">Validation Errors: ${escapeHtml(check.errors[0])}</span>`
    }
  `;
  launchBtn.disabled = !check.valid || unit.questions.length < 10;
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
async function openBriefing(unitId) {
  if (unitId === "__ALL__") {
    for (const f of state.discoveredGithubFiles) {
      await ensureUnitLoaded(f.slug);
    }
  } else {
    await ensureUnitLoaded(unitId);
  }

  state.briefingUnitId = unitId;
  const isMulti = unitId === "__ALL__";
  const unitTitle = isMulti ? "Comprehensive Multi-Unit Mock" : state.loadedUnits[unitId]?.unitTitle || "Unit";
  const questions = isMulti ? getAllCombinedQuestions() : state.loadedUnits[unitId]?.questions || [];

  const check = validateUnitData({ unitTitle, questions });
  document.getElementById("briefTitle").textContent = unitTitle;
  document.getElementById("briefSubtitle").textContent = isMulti
    ? `Adaptive pool across ${Object.keys(state.loadedUnits).length} units (${questions.length} total items).`
    : `Single-unit NCLEX-RN CAT simulation (${questions.length} items).`;

  const vBox = document.getElementById("validationReport");
  vBox.innerHTML = `
    <strong>Pre-Exam Readiness Check:</strong> ${questions.length} items loaded
    (${questions.filter((q) => q.type === "mcq").length} MCQ, ${questions.filter((q) => q.type === "sata").length} SATA).
    ${check.valid ? `<span style="color:var(--success);font-weight:700;"> &bull; Schema Verified</span>` : `<span style="color:var(--danger);font-weight:700;"> &bull; ${escapeHtml(check.errors.join(" "))}</span>`}
    ${check.warnings.length ? `<div class="small-muted">${escapeHtml(check.warnings.join(" "))}</div>` : ""}
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
  document.getElementById("scMetaLine").textContent = `${record.dateLabel} • ${record.ruleTriggered}`;

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
  document.getElementById("backDashFromScoreBtn").onclick = async () => {
    await renderDashboard();
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

  const minY = -2.5;
  const maxY = 2.5;
  const toY = (val) => padT + plotH * (1 - (val - minY) / (maxY - minY));
  const passY = toY(PASSING_LOGIT);

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

async function initFlashcardsTab() {
  for (const f of state.discoveredGithubFiles) {
    await ensureUnitLoaded(f.slug);
  }
  const entries = getAllCatalogEntries();
  const sel = document.getElementById("fcUnitSelect");
  sel.innerHTML = entries.length
    ? entries.map((c) => `<option value="${c.unitId}">${escapeHtml(c.unitTitle)}</option>`).join("")
    : `<option value="">No units loaded yet</option>`;
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
    document.getElementById("fcFrontText").textContent = "Load a unit .json file to study its linked PDF flashcards.";
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

/* ---------------- TEMPLATE .JSON IMPORTER ---------------- */
function cleanJsonString(raw) {
  return String(raw || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function processAndIntegrateJson(rawText, fallbackName = "Uploaded NCLEX Unit") {
  const reportEl = document.getElementById("importerReport");
  reportEl.classList.remove("hidden");

  let parsed;
  try {
    parsed = JSON.parse(cleanJsonString(rawText));
  } catch (err) {
    state.lastValidatedNormalizedUnit = null;
    document.getElementById("downloadNormalizedBtn").disabled = true;
    reportEl.innerHTML = `<strong style="color:var(--danger)">JSON Syntax Error:</strong> ${escapeHtml(err.message)}`;
    return;
  }

  const normalized = normalizeUnitPayload(parsed, fallbackName);
  const check = validateUnitData(normalized);

  if (!check.valid) {
    state.lastValidatedNormalizedUnit = null;
    document.getElementById("downloadNormalizedBtn").disabled = true;
    reportEl.innerHTML = `
      <strong style="color:var(--danger)">Validation Failed (${check.errors.length} issue(s)):</strong>
      <ul>${check.errors.slice(0, 12).map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>
    `;
    return;
  }

  normalized.source = "Browser Storage";
  const localUnits = loadLocalUnits();
  localUnits[normalized.unitId] = normalized;
  saveLocalUnits(localUnits);
  state.loadedUnits[normalized.unitId] = normalized;
  state.selectedDropdownUnitId = normalized.unitId;
  state.lastValidatedNormalizedUnit = normalized;

  document.getElementById("downloadNormalizedBtn").disabled = false;
  reportEl.innerHTML = `
    <strong style="color:var(--success)">Validated &amp; Integrated: "${escapeHtml(normalized.unitTitle)}"</strong>
    (${normalized.questions.length} items ready in the Pre-Test Unit Dropdown).
    ${check.warnings.length ? `<div class="small-muted">${escapeHtml(check.warnings.join(" "))}</div>` : ""}
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
  const partial = scoreQuestion(sampleSata, ["A", "C", "E"]);
  const floored = scoreQuestion(sampleSata, ["B", "E"]);
  results.push({
    name: "SATA NGN Scoring (2 right - 1 wrong = 1/3; all wrong floored to 0)",
    pass: partial.earned === 1 && partial.max === 3 && floored.earned === 0
  });

  // Test 3: Ability adaptation
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

  // Test 5: 1-Shot Compact JSON Auto-Expander (Workaround A)
  const compactSample = {
    u: "Test Electrolytes",
    q: [
      {
        i: 1,
        t: "s",
        d: 4,
        c: 8,
        j: 1,
        st: "Which signs indicate hypocalcemia? Select all that apply.",
        ex: null,
        o: [
          ["A", "Trousseau sign", "Correct."],
          ["B", "Chvostek sign", "Correct."],
          ["C", "Constipation", "Incorrect."],
          ["D", "Lethargy", "Incorrect."],
          ["E", "Hyporeflexia", "Incorrect."]
        ],
        a: ["A", "B"],
        obj: "Hypocalcemia increases neuromuscular excitability.",
        fc: ["Hypocalcemia Signs", "Positive Trousseau | Positive Chvostek", "Section 2"]
      }
    ]
  };
  const expanded = normalizeUnitPayload(compactSample);
  const checkExpanded = validateUnitData(expanded);
  results.push({
    name: "Compact JSON Auto-Expander & Schema Validator",
    pass:
      checkExpanded.valid &&
      expanded.questions[0].type === "sata" &&
      expanded.questions[0].clientNeedsCategory === "Physiological Adaptation" &&
      expanded.questions[0].flashcard.back.includes("• Positive Trousseau")
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
    btn.addEventListener("click", async () => {
      const v = btn.dataset.view;
      if (v === "dashboard") {
        await renderDashboard();
        showView("dashboardView");
      } else if (v === "importer") {
        showView("importerView");
      } else if (v === "flashcards") {
        await initFlashcardsTab();
        showView("flashcardsView");
      } else if (v === "qa") {
        showView("qaView");
      }
    });
  });

  // Pre-Test Unit Selector Dropdown events
  document.getElementById("preTestUnitSelect").addEventListener("change", async (e) => {
    await handleDropdownUnitSelection(e.target.value);
  });

  document.getElementById("launchBriefingFromSelectBtn").addEventListener("click", async () => {
    const uid = document.getElementById("preTestUnitSelect").value;
    if (uid) await openBriefing(uid);
  });

  document.getElementById("refreshGithubBtn").addEventListener("click", async () => {
    await discoverGithubDataFolder(true);
    await renderDashboard();
  });

  document.getElementById("backToDashBtn").addEventListener("click", async () => {
    await renderDashboard();
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

  // Stem highlighter
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
  document.getElementById("fcUnitSelect").addEventListener("change", async (e) => {
    await ensureUnitLoaded(e.target.value);
    buildFlashcardDeck();
  });
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

  // .json Importer (Dropzone + File Picker + Raw Paste)
  const dropZone = document.getElementById("jsonFileDropZone");
  const fileInp = document.getElementById("jsonFileInput");

  dropZone.addEventListener("click", () => fileInp.click());
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    const file = e.dataTransfer.files[0];
    if (file) readUploadedJsonFile(file);
  });
  fileInp.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) readUploadedJsonFile(file);
  });

  function readUploadedJsonFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      document.getElementById("rawJsonPasteInput").value = reader.result;
      processAndIntegrateJson(reader.result, titleFromFilename(file.name));
    };
    reader.readAsText(file);
  }

  document.getElementById("validateIntegrateBtn").addEventListener("click", () => {
    const raw = document.getElementById("rawJsonPasteInput").value;
    processAndIntegrateJson(raw);
  });

  document.getElementById("downloadNormalizedBtn").addEventListener("click", () => {
    if (!state.lastValidatedNormalizedUnit) return;
    const blob = new Blob([JSON.stringify(state.lastValidatedNormalizedUnit, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${state.lastValidatedNormalizedUnit.unitId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById("saveRepoOverrideBtn").addEventListener("click", async () => {
    const val = document.getElementById("repoOverrideInput").value.trim();
    localStorage.setItem(STORAGE_KEYS.GH_REPO_OVERRIDE, val);
    await discoverGithubDataFolder(true);
    await renderDashboard();
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
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (Array.isArray(parsed)) {
          state.history = parsed;
          saveHistory();
          await renderDashboard();
        }
      } catch {
        alert("Invalid backup JSON file.");
      }
    };
    reader.readAsText(file);
  });

  document.getElementById("runQaBtn").addEventListener("click", runQaTests);
  document.getElementById("printScoreBtn").addEventListener("click", () => window.print());
}

document.addEventListener("DOMContentLoaded", async () => {
  state.history = loadHistory();
  bindEvents();

  const savedOverride = localStorage.getItem(STORAGE_KEYS.GH_REPO_OVERRIDE) || "";
  if (savedOverride) document.getElementById("repoOverrideInput").value = savedOverride;

  await discoverGithubDataFolder(false);

  try {
    const savedSess = JSON.parse(localStorage.getItem(STORAGE_KEYS.SESSION) || "{}");
    if (savedSess.user) document.getElementById("loginUser").value = savedSess.user;
  } catch {}

  checkInterruptedExam();
  showView("loginView");
});
