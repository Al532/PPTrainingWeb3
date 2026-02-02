import {
  BASE_MIDI_RANGE,
  chromas,
  chromaSets,
  instruments,
  instrumentRanges,
} from "./music.js";
import {
  getExerciseTypeFromLabel,
  loadTrialLog,
  logTrialResult,
  refreshStatsIfOpen as refreshStatsIfOpenUtil,
  renderStats as renderStatsUtil,
} from "./stats.js";
import { exportLogs } from "./export_logs.js";
import {
  deleteSeries,
  getSeriesById,
  getSeriesList,
  getSetting,
  saveSeries,
  setSetting,
} from "./storage/indexedDbStore.js";
const CORRECT_FEEDBACK_DURATION = 400;
const INCORRECT_FEEDBACK_DURATION = 1500;
const NEXT_TRIAL_DELAY = 0;
const TRIAL_LOG_STORAGE_KEY = "ppt-trial-log";
const RANDOMIZE_BUTTON_ORDER_KEY = "ppt-randomize-buttons";
const LIMITED_FEEDBACK_STORAGE_KEY = "ppt-limited-feedback";
const FEEDBACK_MODE_STORAGE_KEY = "ppt-feedback-mode";
const SERIES_RANDOMIZE_START_STORAGE_KEY = "ppt-series-randomize-start";
const RANDOMIZE_BUTTON_ORDER_REROLL_INTERVAL = 5;
const FADE_DURATION_MS = 100;
const RECENT_ENTRIES = 1000;
const PREFETCH_TRIAL_COUNT = 10;
// Toggle between "mp3" or "wav" to switch the asset set without exposing UI controls.
const DEFAULT_AUDIO_FORMAT = "mp3";

const buttonsContainer = document.getElementById("chroma-buttons");
const midiStatusEl = document.getElementById("midi-status");
const statsButton = document.getElementById("stats-button");
const statsOutput = document.getElementById("stats-output");
const exportLogsButton = document.getElementById("export-logs-button");
const exportLogsLastButton = document.getElementById("export-logs-last-button");
const exportLogsStatus = document.getElementById("export-logs-status");
const randomizeButtonsToggle = document.getElementById("randomize-buttons-toggle");
const feedbackSelect = document.getElementById("feedback-select");
const replayButton = document.getElementById("replay-button");
const replayRow = document.getElementById("replay-row");
const seriesLengthInput = document.getElementById("series-length-input");
const seriesNameInput = document.getElementById("series-name-input");
const seriesGenerateButton = document.getElementById("series-generate-button");
const seriesSelect = document.getElementById("series-select");
const seriesDeleteButton = document.getElementById("series-delete-button");
const seriesPlayButton = document.getElementById("series-play-button");
const seriesStopButton = document.getElementById("series-stop-button");
const seriesExportButton = document.getElementById("series-export-button");
const seriesImportButton = document.getElementById("series-import-button");
const seriesImportInput = document.getElementById("series-import-input");
const seriesStatus = document.getElementById("series-status");
const seriesActivePill = document.getElementById("series-active-pill");
const seriesRandomizeStartToggle = document.getElementById(
  "series-randomize-start-toggle",
);

let midiRange = { ...BASE_MIDI_RANGE };
let notesByChroma = buildNotesByChroma(midiRange);
const availabilityCache = new Map();
let activeChromaSet = chromaSets[0];
let randomizeButtonsEnabled = false;
let randomizedButtonOrder = [];
let randomizedButtonOrderTrialCount = 0;
let audioFormat = DEFAULT_AUDIO_FORMAT;
let lastClickedChromaIndex = null;
let feedbackMode = "feedback";
let preferredFeedbackMode = feedbackMode;
let currentState = {
  chromaIndex: null,
  midiNote: null,
  instrument: null,
  chromaSetLabel: "",
  exerciseType: "",
  awaitingGuess: false,
};
let feedbackResetTimeout = null;
let currentAudio = null;
let currentAudioGainNode = null;
let nextTrialTimeout = null;
let lastMidiNotePlayed = null;
let trialStartTimestampMs = null;
let replayCount = 0;
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
let audioContext = null;
let pendingTrials = [];
let pendingPreparationPromise = null;
let pendingPreparationToken = 0;
let fadeTimeout = null;
let statsPanelOpen = false;
let currentTrial = null;
let trialLogReady = Promise.resolve();
let isTrialLogLoaded = false;
let exportStatusTimeout = null;
let seriesStatusTimeout = null;
let seriesList = [];
let activeSeries = null;
let seriesPlaybackActive = false;
let seriesPlaybackIndex = 0;
let seriesPlaybackCount = 0;
let currentSeriesTrialIndex = null;
let seriesRandomizeStartEnabled = false;
let settingsLocked = false;
let seriesPendingTrial = null;
let seriesPlaybackRunId = "";
const audioFormats = {
  mp3: { label: "MP3", folder: "MP3", extension: "mp3" },
  wav: { label: "WAV", folder: "WAV", extension: "wav" },
};

const FEEDBACK_MODE_OPTIONS = [
  { value: "feedback", label: "Feedback" },
  { value: "limited", label: "Limited feedback" },
  { value: "none", label: "No feedback" },
];

function normalizeExerciseType(type = "") {
  const trimmed = type.trim();
  if (!trimmed) return "";
  return trimmed.toLowerCase() === "custom" ? "Custom" : trimmed;
}

function getCurrentExerciseType() {
  return normalizeExerciseType(
    activeChromaSet?.exerciseType || getExerciseTypeFromLabel(activeChromaSet?.label)
  );
}

function getModeLabel() {
  return "Recognize";
}

function getFeedbackModeLabel(mode = feedbackMode) {
  return (
    FEEDBACK_MODE_OPTIONS.find((option) => option.value === mode)?.label ??
    FEEDBACK_MODE_OPTIONS[0].label
  );
}

function formatSeriesRunTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function generateSeriesRunId(seriesId) {
  const timestamp = formatSeriesRunTimestamp(new Date());
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  return `${seriesId}__run_${timestamp}__${feedbackMode}__recognize__${randomSuffix}`;
}

const renderStats = () => {
  if (!isTrialLogLoaded) {
    trialLogReady.then(() => {
      renderStatsUtil({
        statsOutput,
        getCurrentExerciseType,
        recentEntriesCount: RECENT_ENTRIES,
      });
    });
    return;
  }
  renderStatsUtil({
    statsOutput,
    getCurrentExerciseType,
    recentEntriesCount: RECENT_ENTRIES,
  });
};

function refreshStatsIfOpen() {
  if (!isTrialLogLoaded) {
    trialLogReady.then(() => {
      refreshStatsIfOpenUtil(statsPanelOpen, renderStats);
    });
    return;
  }
  refreshStatsIfOpenUtil(statsPanelOpen, renderStats);
}

function setStatsPanelOpen(isOpen) {
  statsPanelOpen = isOpen;
  if (statsButton) {
    statsButton.setAttribute("aria-expanded", isOpen ? "true" : "false");
    statsButton.classList.toggle("open", isOpen);
  }
  if (statsOutput) {
    statsOutput.hidden = !isOpen;
  }
  if (isOpen) {
    renderStats();
  }
}

function toggleStatsPanel() {
  setStatsPanelOpen(!statsPanelOpen);
}

function updateExportStatus(message, { autoHide = false } = {}) {
  if (!exportLogsStatus) return;
  exportLogsStatus.textContent = message;
  exportLogsStatus.hidden = false;
  if (exportStatusTimeout) {
    clearTimeout(exportStatusTimeout);
  }
  if (autoHide) {
    exportStatusTimeout = setTimeout(() => {
      exportLogsStatus.hidden = true;
    }, 4000);
  }
}

function setExportButtonsDisabled(disabled) {
  [exportLogsButton, exportLogsLastButton].forEach((button) => {
    if (button) {
      button.disabled = disabled;
    }
  });
}

async function runExportLogs(limit) {
  const label = limit ? `Exporting last ${limit}…` : "Exporting…";
  updateExportStatus(`${label} (0 records)`);

  try {
    const total = await exportLogs({
      dbName: "ppt-training",
      storeName: "trial-log",
      limit,
      onProgress: (count) => {
        updateExportStatus(`${label} (${count} records)`);
      },
    });
    updateExportStatus(`Export complete: ${total} records`, { autoHide: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    updateExportStatus(`Export failed: ${message}`, { autoHide: true });
  }
}

function setupExportLogsButton() {
  if (exportLogsButton) {
    exportLogsButton.addEventListener("click", async () => {
      if (exportLogsButton.disabled) return;
      setExportButtonsDisabled(true);
      try {
        await runExportLogs();
      } finally {
        setExportButtonsDisabled(false);
      }
    });
  }
  if (exportLogsLastButton) {
    exportLogsLastButton.addEventListener("click", async () => {
      if (exportLogsLastButton.disabled) return;
      setExportButtonsDisabled(true);
      try {
        await runExportLogs(RECENT_ENTRIES);
      } finally {
        setExportButtonsDisabled(false);
      }
    });
  }
}

function setupSeriesControls() {
  if (seriesGenerateButton) {
    seriesGenerateButton.addEventListener("click", () => {
      void handleGenerateSeries();
    });
  }
  if (seriesSelect) {
    seriesSelect.addEventListener("change", () => {
      const selected = seriesList.find((entry) => entry.id === seriesSelect.value);
      setActiveSeries(selected ?? null);
    });
  }
  if (seriesPlayButton) {
    seriesPlayButton.addEventListener("click", () => {
      void handlePlaySeries();
    });
  }
  if (seriesStopButton) {
    seriesStopButton.addEventListener("click", handleStopSeries);
  }
  if (seriesDeleteButton) {
    seriesDeleteButton.addEventListener("click", () => {
      void handleDeleteSeries();
    });
  }
  if (seriesExportButton) {
    seriesExportButton.addEventListener("click", handleExportSeries);
  }
  if (seriesImportButton && seriesImportInput) {
    seriesImportButton.addEventListener("click", () => {
      seriesImportInput.click();
    });
    seriesImportInput.addEventListener("change", async (event) => {
      const file = event.target?.files?.[0];
      if (!file) return;
      await handleImportSeriesFile(file);
      seriesImportInput.value = "";
    });
  }
}

function updateSeriesStatus(message, { autoHide = false } = {}) {
  if (!seriesStatus) return;
  seriesStatus.textContent = message;
  seriesStatus.hidden = false;
  if (seriesStatusTimeout) {
    clearTimeout(seriesStatusTimeout);
  }
  if (autoHide) {
    seriesStatusTimeout = setTimeout(() => {
      seriesStatus.hidden = true;
    }, 5000);
  }
}

function clearSeriesStatus() {
  if (!seriesStatus) return;
  seriesStatus.textContent = "";
  seriesStatus.hidden = true;
}

function generateSeriesId() {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `series-${Date.now()}-${randomPart}`;
}

function formatSeriesLabel(series) {
  if (!series) return "Unknown series";
  const name = typeof series.name === "string" ? series.name.trim() : "";
  const date = series.createdAt ? new Date(series.createdAt) : null;
  const dateLabel = date ? date.toLocaleString() : "Unknown date";
  const count = Number.isFinite(series.trials?.length) ? series.trials.length : 0;
  const modeLabel = getModeLabel();
  const details = `${dateLabel} · ${modeLabel} · ${count} trials`;
  return name ? `${name} · ${details}` : details;
}

function updateSeriesSelectOptions({ preserveSelection = true } = {}) {
  if (!seriesSelect) return;
  const currentValue = preserveSelection ? seriesSelect.value : null;
  seriesSelect.innerHTML = "";
  if (!seriesList.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No series available";
    seriesSelect.appendChild(option);
    seriesSelect.value = "";
    return;
  }
  seriesList.forEach((series) => {
    const option = document.createElement("option");
    option.value = series.id;
    option.textContent = formatSeriesLabel(series);
    seriesSelect.appendChild(option);
  });
  if (preserveSelection && currentValue) {
    seriesSelect.value = currentValue;
  }
}

async function loadSeriesList() {
  try {
    const entries = await getSeriesList();
    seriesList = Array.isArray(entries) ? entries.sort((a, b) => {
      const aTime = Number(a?.createdAt ?? 0);
      const bTime = Number(b?.createdAt ?? 0);
      return bTime - aTime;
    }) : [];
  } catch (error) {
    seriesList = [];
  }
  updateSeriesSelectOptions({ preserveSelection: false });
  if (seriesSelect?.value) {
    const selected = seriesList.find((entry) => entry.id === seriesSelect.value);
    setActiveSeries(selected ?? null);
  } else if (!seriesList.length) {
    setActiveSeries(null);
  }
  updateSeriesControlsState();
}

function getSeriesSettingsSnapshot() {
  return {
    randomizeButtonsEnabled,
    audioFormat,
  };
}

function applySeriesSettingsSnapshot(snapshot) {
  if (!snapshot) return;
  if (typeof snapshot.randomizeButtonsEnabled === "boolean") {
    randomizeButtonsEnabled = snapshot.randomizeButtonsEnabled;
    if (randomizeButtonsToggle) {
      randomizeButtonsToggle.checked = snapshot.randomizeButtonsEnabled;
    }
    resetRandomizedButtonOrder();
    refreshButtonOrder();
  }
  if (typeof snapshot.audioFormat === "string") {
    audioFormat = snapshot.audioFormat;
  }
}

function setSettingsLocked(isLocked) {
  settingsLocked = isLocked;
  const lockTargets = [
    randomizeButtonsToggle,
    feedbackSelect,
  ];
  lockTargets.forEach((el) => {
    if (el) {
      el.disabled = isLocked;
    }
  });
  if (seriesActivePill) {
    seriesActivePill.hidden = !isLocked;
  }
}

function updateSeriesControlsState() {
  const hasSeries = seriesList.length > 0;
  const hasActiveSeries = Boolean(activeSeries?.id);
  const selectedSeriesId = seriesSelect?.value;
  if (seriesSelect) {
    seriesSelect.disabled = seriesPlaybackActive || !hasSeries;
  }
  if (seriesGenerateButton) {
    seriesGenerateButton.disabled = seriesPlaybackActive;
  }
  if (seriesPlayButton) {
    seriesPlayButton.disabled = !hasSeries || !selectedSeriesId || seriesPlaybackActive;
  }
  if (seriesStopButton) {
    seriesStopButton.disabled = !seriesPlaybackActive;
  }
  if (seriesExportButton) {
    seriesExportButton.disabled = !hasActiveSeries;
  }
  if (seriesDeleteButton) {
    seriesDeleteButton.disabled = !hasSeries || !selectedSeriesId || seriesPlaybackActive;
  }
  if (seriesImportButton) {
    seriesImportButton.disabled = seriesPlaybackActive;
  }
  if (seriesRandomizeStartToggle) {
    seriesRandomizeStartToggle.disabled = seriesPlaybackActive;
  }
}

function setActiveSeries(series) {
  activeSeries = series ?? null;
  if (seriesSelect && series?.id) {
    seriesSelect.value = series.id;
  }
  if (seriesNameInput) {
    seriesNameInput.value = series?.name ?? "";
  }
  updateSeriesControlsState();
}

async function handleGenerateSeries() {
  if (seriesPlaybackActive) return;
  clearSeriesStatus();
  const count = Number.parseInt(seriesLengthInput?.value ?? "0", 10);
  if (!Number.isFinite(count) || count <= 0) {
    updateSeriesStatus("Enter a valid series length.", { autoHide: true });
    return;
  }
  if (!activeChromaSet?.chromas?.length) {
    updateSeriesStatus("Select a chroma set before generating.", { autoHide: true });
    return;
  }
  const settingsSnapshot = getSeriesSettingsSnapshot();
  updateSeriesStatus("Generating series…");
  const trials = await generateSeriesTrials(count, settingsSnapshot);
  if (!trials.length) {
    updateSeriesStatus("No trials generated.", { autoHide: true });
    return;
  }
  const name = typeof seriesNameInput?.value === "string"
    ? seriesNameInput.value.trim()
    : "";
  const series = {
    id: generateSeriesId(),
    createdAt: Date.now(),
    name: name || undefined,
    settingsSnapshot,
    trials,
  };
  await saveSeries(series);
  await loadSeriesList();
  setActiveSeries(series);
  updateSeriesStatus(`Series saved (${trials.length} trials).`, { autoHide: true });
}

async function handlePlaySeries() {
  if (seriesPlaybackActive) return;
  if (!seriesSelect?.value) {
    updateSeriesStatus("Select a series first.", { autoHide: true });
    return;
  }
  clearSeriesStatus();
  const series = await getSeriesById(seriesSelect.value);
  if (!series) {
    updateSeriesStatus("Series not found.", { autoHide: true });
    return;
  }
  setActiveSeries(series);
  startSeriesPlayback(activeSeries);
}

function handleStopSeries() {
  if (!seriesPlaybackActive) return;
  stopSeriesPlayback({ showStatus: true, message: "Series stopped." });
}

async function handleDeleteSeries() {
  if (seriesPlaybackActive) return;
  if (!seriesSelect?.value) return;
  clearSeriesStatus();
  const seriesId = seriesSelect.value;
  const series = seriesList.find((entry) => entry.id === seriesId);
  const label = series ? formatSeriesLabel(series) : "this series";
  const shouldDelete = window.confirm(`Delete ${label}?`);
  if (!shouldDelete) return;
  await deleteSeries(seriesId);
  if (activeSeries?.id === seriesId) {
    activeSeries = null;
  }
  await loadSeriesList();
  if (!seriesList.length) {
    if (seriesNameInput) {
      seriesNameInput.value = "";
    }
  }
  updateSeriesStatus("Series deleted.", { autoHide: true });
}

function downloadSeriesJson(series) {
  if (!series) return;
  const blob = new Blob([JSON.stringify(series, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${series.id}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function handleExportSeries() {
  if (!activeSeries) {
    updateSeriesStatus("Select a series before exporting.", { autoHide: true });
    return;
  }
  downloadSeriesJson(activeSeries);
  updateSeriesStatus("Series exported.", { autoHide: true });
}

async function handleImportSeriesFile(file) {
  if (!file) return;
  const text = await file.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    updateSeriesStatus("Invalid JSON file.", { autoHide: true });
    return;
  }
  const incoming = Array.isArray(payload) ? payload : [payload];
  const saved = [];
  for (const entry of incoming) {
    if (!entry?.trials || !Array.isArray(entry.trials) || !entry.trials.length) {
      continue;
    }
    const normalized = {
      ...entry,
      id: entry.id && !seriesList.some((series) => series.id === entry.id)
        ? entry.id
        : generateSeriesId(),
      createdAt: Number(entry.createdAt) || Date.now(),
    };
    await saveSeries(normalized);
    saved.push(normalized);
  }
  if (!saved.length) {
    updateSeriesStatus("No valid series found in file.", { autoHide: true });
    return;
  }
  await loadSeriesList();
  setActiveSeries(saved[saved.length - 1]);
  updateSeriesStatus(`Imported ${saved.length} series.`, { autoHide: true });
}

function getSeriesPlaybackLogContext() {
  if (!seriesPlaybackActive || !activeSeries?.id) {
    return { seriesPlaybackActive: false };
  }
  return {
    seriesId: activeSeries.id,
    seriesRunId: seriesPlaybackRunId,
    seriesIndex:
      Number.isInteger(currentSeriesTrialIndex) ? currentSeriesTrialIndex + 1 : null,
    seriesPlaybackActive: true,
  };
}

function getChromaLabelByIndex(chromaIndex) {
  return chromas.find((chroma) => chroma.index === chromaIndex)?.label ?? String(chromaIndex);
}

function getAudioContext() {
  if (!AudioContextClass) return null;

  if (!audioContext) {
    audioContext = new AudioContextClass();
  }

  if (audioContext.state === "suspended") {
    audioContext.resume().catch(() => {
      // Ignore errors resuming the audio context (e.g., autoplay policies).
    });
  }

  return audioContext;
}

function buildNotesByChroma(range = midiRange) {
  const buckets = Array.from({ length: 12 }, () => []);
  for (let note = range.min; note <= range.max; note += 1) {
    buckets[note % 12].push(note);
  }
  return buckets;
}

function setupRandomizeButtonsToggle() {
  if (!randomizeButtonsToggle) return;

  randomizeButtonsToggle.checked = randomizeButtonsEnabled;
  randomizeButtonsToggle.addEventListener("change", (event) => {
    randomizeButtonsEnabled = Boolean(event.target?.checked);
    saveRandomizeButtonsSetting(randomizeButtonsEnabled);
    resetRandomizedButtonOrder();
    refreshButtonOrder();
  });
}

function setupSeriesRandomizeStartToggle() {
  if (!seriesRandomizeStartToggle) return;
  seriesRandomizeStartToggle.checked = seriesRandomizeStartEnabled;
  seriesRandomizeStartToggle.addEventListener("change", (event) => {
    seriesRandomizeStartEnabled = Boolean(event.target?.checked);
    saveSeriesRandomizeStartSetting(seriesRandomizeStartEnabled);
  });
}

function normalizeFeedbackMode(value, fallback = feedbackMode) {
  if (value === "feedback" || value === "limited" || value === "none") {
    return value;
  }
  if (value === true || value === "true") return "limited";
  if (value === false || value === "false") return "feedback";
  return fallback;
}

function setFeedbackMode(mode, { skipSave = false, skipPreference = false } = {}) {
  feedbackMode = normalizeFeedbackMode(mode);
  if (!skipPreference) {
    preferredFeedbackMode = feedbackMode;
  }
  if (feedbackSelect) {
    feedbackSelect.value = feedbackMode;
  }
  if (!skipSave) {
    saveFeedbackModeSetting(feedbackMode);
  }
  if (feedbackMode !== "feedback") {
    resetButtonStates();
  }
}

function renderFeedbackOptions(selectedValue = feedbackMode) {
  if (!feedbackSelect) return;
  feedbackSelect.innerHTML = "";
  FEEDBACK_MODE_OPTIONS.forEach((optionConfig) => {
    const option = document.createElement("option");
    option.value = optionConfig.value;
    option.textContent = optionConfig.label;
    feedbackSelect.appendChild(option);
  });
  feedbackSelect.value = selectedValue;
}

function setupFeedbackSelect() {
  if (!feedbackSelect) return;
  renderFeedbackOptions(feedbackMode);
  feedbackSelect.addEventListener("change", (event) => {
    setFeedbackMode(event.target?.value);
  });
}

function getAudioFormatConfig(format = audioFormat) {
  return audioFormats[format] ?? audioFormats.mp3;
}

function shuffleArray(values = []) {
  const array = [...values];
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function shuffleArrayWithLastClickedGuard(
  values = [],
  previousOrder = [],
  lastClickedIndex = null
) {
  if (!previousOrder?.length || values.length <= 1 || !Number.isInteger(lastClickedIndex)) {
    return shuffleArray(values);
  }

  const previousIndex = previousOrder.indexOf(lastClickedIndex);
  if (previousIndex === -1) {
    return shuffleArray(values);
  }

  const maxAttempts = 20;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const shuffled = shuffleArray(values);
    if (shuffled[previousIndex] !== lastClickedIndex) {
      return shuffled;
    }
  }

  const shuffled = shuffleArray(values);
  if (shuffled[previousIndex] === lastClickedIndex) {
    const swapIndex = shuffled.findIndex(
      (value, idx) => value !== lastClickedIndex && idx !== previousIndex
    );

    if (swapIndex !== -1) {
      [shuffled[swapIndex], shuffled[previousIndex]] = [
        shuffled[previousIndex],
        shuffled[swapIndex],
      ];
    }
  }

  return shuffled;
}

function resetRandomizedButtonOrder() {
  randomizedButtonOrder = [];
  randomizedButtonOrderTrialCount = 0;
}

function getChromaOrderForButtons(chromasForButtons = []) {
  if (!randomizeButtonsEnabled) {
    return chromasForButtons.map((chroma) => chroma.index);
  }

  const chromaIndices = chromasForButtons.map((chroma) => chroma.index);
  const hasSameChromas =
    randomizedButtonOrder.length === chromaIndices.length &&
    chromaIndices.every((index) => randomizedButtonOrder.includes(index));

  const shouldReroll =
    !randomizedButtonOrder.length ||
    randomizedButtonOrderTrialCount >= RANDOMIZE_BUTTON_ORDER_REROLL_INTERVAL ||
    !hasSameChromas;

  if (shouldReroll) {
    const previousOrder = [...randomizedButtonOrder];
    randomizedButtonOrder = shuffleArrayWithLastClickedGuard(
      chromaIndices,
      previousOrder,
      lastClickedChromaIndex
    );
    randomizedButtonOrderTrialCount = 0;
  }

  randomizedButtonOrderTrialCount += 1;
  return randomizedButtonOrder;
}

function getChromasForTrial(chromaIndex) {
  return activeChromaSet?.chromas ?? [];
}

function createButtons(chromasForButtons = activeChromaSet?.chromas) {
  if (!chromasForButtons?.length) return;

  buttonsContainer.innerHTML = "";
  const chromaByIndex = new Map(
    chromasForButtons.map((chroma) => [chroma.index, chroma])
  );

  const chromaOrder = getChromaOrderForButtons(chromasForButtons);

  chromaOrder.forEach((chromaIndex) => {
    const chroma = chromaByIndex.get(chromaIndex);
    if (!chroma) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chroma";
    btn.textContent = chroma.label;
    btn.dataset.index = chroma.index;
    btn.addEventListener("click", () => handleAnswer(chroma.index));
    buttonsContainer.appendChild(btn);
  });
}

function scrollButtonsToBottom() {
  if (!buttonsContainer) return;
  requestAnimationFrame(() => {
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: "smooth",
    });
  });
}


function showStartButton() {
  resetTrialState();
  resetRandomizedButtonOrder();

  buttonsContainer.innerHTML = "";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "start-button";
  btn.className = "start-button";
  btn.textContent = "START";
  btn.addEventListener("click", handleStartClick);
  buttonsContainer.appendChild(btn);
  if (!seriesPlaybackActive) {
    preparePendingTrial();
  }
  updateReplayAvailability();
}

function getChromaButton(chromaIndex) {
  return buttonsContainer.querySelector(`button[data-index="${chromaIndex}"]`);
}

function resetButtonStates() {
  buttonsContainer.querySelectorAll("button.chroma").forEach((btn) => {
    btn.classList.remove("correct", "incorrect");
  });
}


function resetButtonFocus() {
  const activeElement = document.activeElement;
  if (activeElement && typeof activeElement.blur === "function") {
    activeElement.blur();
  }
}


function resetTrialState() {
  cancelNextTrialTimeout();
  cancelScheduledFade();
  fadeOutCurrentAudio();
  trialStartTimestampMs = null;
  replayCount = 0;
  currentTrial = null;
  seriesPendingTrial = null;
  if (feedbackResetTimeout) {
    clearTimeout(feedbackResetTimeout);
    feedbackResetTimeout = null;
  }
  resetButtonStates();
  currentState = {
    chromaIndex: null,
    midiNote: null,
    instrument: null,
    chromaSetLabel: "",
    exerciseType: "",
    awaitingGuess: false,
  };
  clearPendingTrials();
}

function refreshButtonOrder() {
  if (!currentState.awaitingGuess || currentState.chromaIndex == null) return;

  const chromasForButtons = getChromasForTrial(currentState.chromaIndex);
  createButtons(chromasForButtons);
  scrollButtonsToBottom();
}

function handleStartClick() {
  startTrial();
}

function updateReplayAvailability() {
  if (!replayButton) return;

  const canReplay =
    currentState.awaitingGuess &&
    currentTrial?.instrument &&
    Number.isFinite(currentTrial?.midiNote);

  replayButton.disabled = !canReplay;
  updateReplayLabel();
}

function updateReplayLabel() {
  if (!replayButton) return;
  replayButton.textContent = "Replay";
}

function scheduleFeedbackReset(durationMs = CORRECT_FEEDBACK_DURATION) {
  if (feedbackResetTimeout) {
    clearTimeout(feedbackResetTimeout);
  }

  feedbackResetTimeout = setTimeout(() => {
    resetButtonStates();
    feedbackResetTimeout = null;
  }, durationMs);
}

function parseBooleanSetting(value, fallback = false) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return fallback;
}

function parseFeedbackModeSetting(value, fallback = feedbackMode) {
  return normalizeFeedbackMode(value, fallback);
}

function saveRandomizeButtonsSetting(isRandomized) {
  void setSetting(RANDOMIZE_BUTTON_ORDER_KEY, isRandomized ? "true" : "false");
}

function saveSeriesRandomizeStartSetting(isRandomized) {
  void setSetting(SERIES_RANDOMIZE_START_STORAGE_KEY, isRandomized ? "true" : "false");
}

function saveFeedbackModeSetting(value) {
  void setSetting(FEEDBACK_MODE_STORAGE_KEY, value);
}

async function hydrateSavedSettings() {
  const [randomizeStored, seriesRandomizeStored, feedbackModeStored, limitedFeedbackStored] =
    await Promise.all([
      getSetting(RANDOMIZE_BUTTON_ORDER_KEY),
      getSetting(SERIES_RANDOMIZE_START_STORAGE_KEY),
      getSetting(FEEDBACK_MODE_STORAGE_KEY),
      getSetting(LIMITED_FEEDBACK_STORAGE_KEY),
    ]);

  const resolvedFeedbackMode =
    feedbackModeStored ?? limitedFeedbackStored ?? feedbackMode;
  setFeedbackMode(parseFeedbackModeSetting(resolvedFeedbackMode), { skipSave: true });

  randomizeButtonsEnabled = parseBooleanSetting(randomizeStored, randomizeButtonsEnabled);
  if (randomizeButtonsToggle) {
    randomizeButtonsToggle.checked = randomizeButtonsEnabled;
  }
  resetRandomizedButtonOrder();
  refreshButtonOrder();

  seriesRandomizeStartEnabled = parseBooleanSetting(
    seriesRandomizeStored,
    seriesRandomizeStartEnabled
  );
  if (seriesRandomizeStartToggle) {
    seriesRandomizeStartToggle.checked = seriesRandomizeStartEnabled;
  }
}

function getAudioSrc(instrument, midiNote, format = audioFormat) {
  const { folder, extension } = getAudioFormatConfig(format);
  return `assets/${folder}/${instrument}/${midiNote}.${extension}`;
}

async function checkSampleExists(instrument, midiNote) {
  const key = `${audioFormat}-${instrument}-${midiNote}`;
  if (availabilityCache.has(key)) {
    return availabilityCache.get(key);
  }

  const src = getAudioSrc(instrument, midiNote);

  try {
    const response = await fetch(src, {
      method: "HEAD",
    });
    const ok = response.ok;
    availabilityCache.set(key, ok);
    return ok;
  } catch (error) {
    availabilityCache.set(key, false);
    return false;
  }
}

async function pickInstrumentForNote(midiNote) {
  const checks = await Promise.all(
    instruments.map(async (instrument) => {
      const range = instrumentRanges[instrument];
      if (range && (midiNote < range.min || midiNote > range.max)) {
        return null;
      }
      const hasSample = await checkSampleExists(instrument, midiNote);
      return hasSample ? instrument : null;
    })
  );
  const available = checks.filter(Boolean);
  if (!available.length) return null;
  const index = Math.floor(Math.random() * available.length);
  return available[index];
}

function pickRandomChroma() {
  if (!activeChromaSet || !activeChromaSet.chromas.length) return null;
  const idx = Math.floor(Math.random() * activeChromaSet.chromas.length);
  return activeChromaSet.chromas[idx].index;
}

function pickRandomNote(chromaIndex, excludedMidiNote) {
  const notes = notesByChroma[chromaIndex];
  const pool = notes.filter((note) => note !== excludedMidiNote);
  const source = pool.length ? pool : notes;
  const idx = Math.floor(Math.random() * source.length);
  return source[idx];
}

async function buildRecognizeSeriesTrial(excludedMidiNote) {
  const trial = await findPlayableTrial(0, excludedMidiNote);
  if (!trial) return null;
  return {
    chromaIndex: trial.chromaIndex,
    midiNote: trial.midiNote,
    instrument: trial.instrument,
  };
}

async function generateSeriesTrials(count, settingsSnapshot) {
  const trials = [];
  let lastMidiNote = null;

  for (let i = 0; i < count; i += 1) {
    const trial = await buildRecognizeSeriesTrial(lastMidiNote);

    if (!trial) {
      break;
    }

    trials.push(trial);
    lastMidiNote = trial.midiNote;
  }

  return trials;
}

async function startSeriesTrial() {
  if (!activeSeries?.trials?.length) {
    stopSeriesPlayback({ showStatus: true, message: "No trials in series." });
    return;
  }
  if (seriesPlaybackCount >= activeSeries.trials.length) {
    stopSeriesPlayback({ showStatus: true, message: "Series complete." });
    return;
  }

  cancelNextTrialTimeout();
  resetButtonFocus();
  trialStartTimestampMs = null;
  replayCount = 0;

  const totalTrials = activeSeries.trials.length;
  const trialData = activeSeries.trials[seriesPlaybackIndex];
  const trialIndex = seriesPlaybackIndex;
  seriesPlaybackIndex = (seriesPlaybackIndex + 1) % totalTrials;
  seriesPlaybackCount += 1;
  currentSeriesTrialIndex = trialIndex;

  if (!trialData) {
    stopSeriesPlayback({ showStatus: true, message: "Series trial missing." });
    return;
  }

  const audioElement = await prepareAudioElement(trialData.instrument, trialData.midiNote);
  if (!audioElement) {
    stopSeriesPlayback({ showStatus: true, message: "Series audio unavailable." });
    return;
  }

  const baseTrial = {
    chromaIndex: trialData.chromaIndex,
    midiNote: trialData.midiNote,
    instrument: trialData.instrument,
    audioElement,
  };

  const trialChromas = getChromasForTrial(baseTrial.chromaIndex);
  createButtons(trialChromas);
  scrollButtonsToBottom();
  currentState = {
    chromaIndex: baseTrial.chromaIndex,
    midiNote: baseTrial.midiNote,
    instrument: baseTrial.instrument,
    chromaSetLabel: activeChromaSet?.label ?? "",
    exerciseType: normalizeExerciseType(activeChromaSet?.exerciseType ?? ""),
    awaitingGuess: true,
  };
  currentTrial = baseTrial;
  lastMidiNotePlayed = baseTrial.midiNote;
  updateReplayAvailability();
  playPreparedTrial(baseTrial);
}

function startSeriesPlayback(series) {
  if (!series?.trials?.length) {
    updateSeriesStatus("Series is empty.", { autoHide: true });
    return;
  }
  activeSeries = series;
  applySeriesSettingsSnapshot(series.settingsSnapshot);
  seriesPlaybackRunId = generateSeriesRunId(series.id);
  seriesPlaybackActive = true;
  seriesPlaybackIndex = seriesRandomizeStartEnabled
    ? Math.floor(Math.random() * series.trials.length)
    : 0;
  seriesPlaybackCount = 0;
  currentSeriesTrialIndex = null;
  seriesPendingTrial = null;
  setSettingsLocked(true);
  clearPendingTrials();
  updateSeriesControlsState();
  updateSeriesStatus("Series playback started.", { autoHide: true });
  startTrial();
}

function stopSeriesPlayback({ showStatus = false, message } = {}) {
  seriesPlaybackActive = false;
  seriesPlaybackRunId = "";
  seriesPlaybackIndex = 0;
  seriesPlaybackCount = 0;
  currentSeriesTrialIndex = null;
  seriesPendingTrial = null;
  setSettingsLocked(false);
  cancelNextTrialTimeout();
  resetTrialState();
  updateSeriesControlsState();
  if (showStatus && message) {
    updateSeriesStatus(message, { autoHide: true });
  }
}

async function startTrial(attempt = 0) {
  if (seriesPlaybackActive) {
    return startSeriesTrial();
  }
  return startRecognizeTrial(attempt);
}

async function startRecognizeTrial(attempt = 0) {
  cancelNextTrialTimeout();
  resetButtonFocus();
  trialStartTimestampMs = null;
  replayCount = 0;

  if (!activeChromaSet || !activeChromaSet.chromas.length) {
    currentState.awaitingGuess = false;
    clearPendingTrials();
    return;
  }

  let trial = pendingTrials.shift();

  if (!trial && pendingPreparationPromise) {
    await pendingPreparationPromise;
    trial = pendingTrials.shift();
  }

  if (!trial) {
    const lastQueuedNote =
      pendingTrials.length > 0
        ? pendingTrials[pendingTrials.length - 1].midiNote
        : lastMidiNotePlayed;
    trial = await findPlayableTrial(attempt, lastQueuedNote);
  }

  if (!trial) {
    currentState.awaitingGuess = false;
    clearPendingTrials();
    currentTrial = null;
    updateReplayAvailability();
    return;
  }

  const trialChromas = getChromasForTrial(trial.chromaIndex);
  createButtons(trialChromas);
  scrollButtonsToBottom();

  currentState = {
    chromaIndex: trial.chromaIndex,
    midiNote: trial.midiNote,
    instrument: trial.instrument,
    chromaSetLabel: activeChromaSet?.label ?? "",
    exerciseType: normalizeExerciseType(activeChromaSet?.exerciseType ?? ""),
    awaitingGuess: true,
  };
  currentTrial = trial;
  lastMidiNotePlayed = trial.midiNote;
  updateReplayAvailability();
  playPreparedTrial(trial);
  preparePendingTrial();
}

function stopCurrentAudio() {
  cancelScheduledFade();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }

  if (currentAudioGainNode) {
    currentAudioGainNode.disconnect();
    currentAudioGainNode = null;
  }
}

function getAudioElementForTrial(trial) {
  if (trial?.audioElement) {
    try {
      const clone = trial.audioElement.cloneNode(true);
      clone.currentTime = 0;
      return clone;
    } catch (error) {
      // Ignore clone errors and fall back to a fresh audio element.
    }
  }

  const audio = new Audio(getAudioSrc(trial.instrument, trial.midiNote));
  audio.preload = "auto";
  return audio;
}

function playPreparedTrial(trial) {
  const { instrument, midiNote } = trial;
  const audio = getAudioElementForTrial(trial);
  if (!audio) return;

  stopCurrentAudio();
  if (trialStartTimestampMs == null) {
    trialStartTimestampMs = Date.now();
  }

  const context = getAudioContext();
  if (context) {
    const source = context.createMediaElementSource(audio);
    const gainNode = context.createGain();

    gainNode.gain.setValueAtTime(1, context.currentTime);
    source.connect(gainNode).connect(context.destination);

    currentAudioGainNode = gainNode;
  } else {
    currentAudioGainNode = null;
  }

  currentAudio = audio;

  audio
    .play()
    .catch(() => {
      // Fail silently to avoid on-screen feedback.
    });
}

function replayCurrentTrial() {
  if (!currentState.awaitingGuess || !currentTrial) return;

  playPreparedTrial(currentTrial);
}

function handleReplayClick() {
  if (replayButton?.disabled) return;
  if (currentState.awaitingGuess) {
    replayCount += 1;
  }
  replayCurrentTrial();
}

function fadeOutCurrentAudio() {
  cancelScheduledFade();
  const audio = currentAudio;
  const gainNode = currentAudioGainNode;
  if (!audio) return;

  if (!gainNode) {
    audio.pause();
    audio.currentTime = 0;
    if (currentAudio === audio) {
      currentAudio = null;
    }
    return;
  }

  const context = getAudioContext();
  const fadeDurationSeconds = FADE_DURATION_MS / 1000;
  const now = context.currentTime;

  gainNode.gain.cancelScheduledValues(now);
  gainNode.gain.setValueAtTime(gainNode.gain.value, now);
  gainNode.gain.linearRampToValueAtTime(0, now + fadeDurationSeconds);

  const cleanup = () => {
    audio.pause();
    audio.currentTime = 0;
    gainNode.disconnect();
    if (currentAudio === audio) {
      currentAudio = null;
      currentAudioGainNode = null;
    }
  };

  setTimeout(cleanup, FADE_DURATION_MS);
}

function cancelScheduledFade() {
  if (fadeTimeout) {
    clearTimeout(fadeTimeout);
    fadeTimeout = null;
  }
}

function scheduleAudioFade(feedbackDuration) {
  if (!currentAudio) return;

  cancelScheduledFade();

  const fadeDelay = Math.max((feedbackDuration ?? 0) - FADE_DURATION_MS, 0);

  fadeTimeout = setTimeout(() => {
    fadeTimeout = null;
    fadeOutCurrentAudio();
  }, fadeDelay);
}

function playLimitedFeedbackSound() {
  return new Promise((resolve) => {
    const audio = new Audio("assets/feedback.mp3");
    const cleanup = () => resolve();
    audio.addEventListener("ended", cleanup, { once: true });
    audio.addEventListener("error", cleanup, { once: true });
    audio
      .play()
      .then(() => {
        // Playback started; wait for ended event.
      })
      .catch(() => {
        cleanup();
      });
  });
}

function handleAnswer(chosenChroma, { shouldFadeOut = true } = {}) {

  if (!currentState.awaitingGuess) return;

  currentState.awaitingGuess = false;
  lastClickedChromaIndex = chosenChroma;
  currentTrial = null;
  if (feedbackResetTimeout) {
    clearTimeout(feedbackResetTimeout);
    feedbackResetTimeout = null;
  }
  updateReplayAvailability();

  const isCorrect = chosenChroma === currentState.chromaIndex;
  const chosenButton = getChromaButton(chosenChroma);
  const correctButton = getChromaButton(currentState.chromaIndex);
  const timestampMS = Date.now();
  const rtMs =
    trialStartTimestampMs == null ? null : Math.max(0, timestampMS - trialStartTimestampMs);
  const seriesLogContext = getSeriesPlaybackLogContext();

  void logTrialResult({
    chromaSetLabel: currentState.chromaSetLabel,
    targetChromaLabel: getChromaLabelByIndex(currentState.chromaIndex),
    midiNote: currentState.midiNote,
    instrument: currentState.instrument,
    userSelectedChroma: getChromaLabelByIndex(chosenChroma),
    exerciseType: currentState.exerciseType || getCurrentExerciseType(),
    "Feedback mode": getFeedbackModeLabel(),
    Mode: getModeLabel(),
    timestampMS,
    rtMs,
    replayCount,
    isCorrect,
    ...seriesLogContext,
  });

  refreshStatsIfOpen();

  if (feedbackMode === "feedback") {
    if (isCorrect) {
      chosenButton?.classList.add("correct");
    } else {
      chosenButton?.classList.add("incorrect");
      correctButton?.classList.add("correct");
    }
  }

  const feedbackDuration = isCorrect
    ? CORRECT_FEEDBACK_DURATION
    : INCORRECT_FEEDBACK_DURATION;

  if (shouldFadeOut && feedbackMode !== "none") {
    scheduleAudioFade(feedbackDuration);
  }

  if (!seriesPlaybackActive) {
    preparePendingTrial();
  }

  if (feedbackMode === "feedback") {
    scheduleFeedbackReset(feedbackDuration);
    scheduleNextTrial(feedbackDuration);
    return;
  }

  if (feedbackMode === "limited" && !isCorrect) {
    playLimitedFeedbackSound();
  }

  scheduleNextTrial(feedbackMode === "none" ? 0 : feedbackDuration);
}

function cancelNextTrialTimeout() {
  if (nextTrialTimeout) {
    clearTimeout(nextTrialTimeout);
    nextTrialTimeout = null;
  }
}

function scheduleNextTrial(feedbackDuration) {
  cancelNextTrialTimeout();
  const delayUntilNextTrial = (feedbackDuration ?? 0) + NEXT_TRIAL_DELAY;
  nextTrialTimeout = setTimeout(() => {
    nextTrialTimeout = null;
    startTrial();
  }, delayUntilNextTrial);
  if (!seriesPlaybackActive && pendingTrials.length < PREFETCH_TRIAL_COUNT &&
    !pendingPreparationPromise) {
    preparePendingTrial();
  }
}

function clearPendingTrials() {
  pendingTrials = [];
  pendingPreparationPromise = null;
  pendingPreparationToken += 1;
}

async function preparePendingTrial() {
  if (seriesPlaybackActive) return null;
  if (pendingTrials.length >= PREFETCH_TRIAL_COUNT) return pendingTrials[0];
  if (pendingPreparationPromise) return pendingPreparationPromise;

  const token = pendingPreparationToken;
  pendingPreparationPromise = (async () => {
    let lastQueuedNote =
      pendingTrials.length > 0
        ? pendingTrials[pendingTrials.length - 1].midiNote
        : lastMidiNotePlayed;
    while (pendingTrials.length < PREFETCH_TRIAL_COUNT) {
      const trial = await findPlayableTrial(0, lastQueuedNote);
      if (token !== pendingPreparationToken) {
        pendingPreparationPromise = null;
        return null;
      }
      if (!trial) break;
      pendingTrials.push(trial);
      lastQueuedNote = trial.midiNote;
    }
    pendingPreparationPromise = null;
    return pendingTrials[0] ?? null;
  })();

  return pendingPreparationPromise;
}

async function findPlayableTrial(attempt = 0, excludedMidiNote = null) {
  const MAX_ATTEMPTS = 30;
  if (!activeChromaSet || !activeChromaSet.chromas.length) return null;
  if (attempt >= MAX_ATTEMPTS) return null;

  const chromaIndex = pickRandomChroma();
  if (chromaIndex === null) return null;

  const midiNote = pickRandomNote(chromaIndex, excludedMidiNote);
  const instrument = await pickInstrumentForNote(midiNote);

  if (!instrument) {
    return findPlayableTrial(attempt + 1, excludedMidiNote);
  }

  const audioElement = await prepareAudioElement(instrument, midiNote);
  if (!audioElement) {
    return findPlayableTrial(attempt + 1, excludedMidiNote);
  }

  return { chromaIndex, midiNote, instrument, audioElement };
}

async function findPlayableTrialForChroma(chromaIndex, excludedMidiNote = null, attempt = 0) {
  const MAX_ATTEMPTS = 30;
  if (!Number.isInteger(chromaIndex)) return null;
  if (attempt >= MAX_ATTEMPTS) return null;

  const midiNote = pickRandomNote(chromaIndex, excludedMidiNote);
  const instrument = await pickInstrumentForNote(midiNote);

  if (!instrument) {
    return findPlayableTrialForChroma(chromaIndex, excludedMidiNote, attempt + 1);
  }

  const audioElement = await prepareAudioElement(instrument, midiNote);
  if (!audioElement) {
    return findPlayableTrialForChroma(chromaIndex, excludedMidiNote, attempt + 1);
  }

  return { chromaIndex, midiNote, instrument, audioElement };
}

async function prepareAudioElement(instrument, midiNote) {
  const src = getAudioSrc(instrument, midiNote);
  const audio = new Audio(src);
  audio.preload = "auto";

  try {
    await fetch(src, { method: "GET" });
  } catch (error) {
    return null;
  }

  try {
    audio.load();
  } catch (error) {
    // Ignore load errors; rely on the fetch above.
  }

  return audio;
}

function setupMidi() {
  if (!navigator.requestMIDIAccess) {
    midiStatusEl.textContent = "MIDI not supported by this browser";
    midiStatusEl.classList.add("muted");
    return;
  }

  navigator
    .requestMIDIAccess()
    .then((access) => {
      midiStatusEl.textContent = "MIDI connected";
      midiStatusEl.classList.remove("muted");
      access.inputs.forEach((input) => {
        input.onmidimessage = handleMidiMessage;
      });
      access.onstatechange = (event) => {
        const port = event.port;
        if (port.type === "input" && port.state === "connected") {
          port.onmidimessage = handleMidiMessage;
        }
      };
    })
    .catch(() => {
      midiStatusEl.textContent = "MIDI access denied";
      midiStatusEl.classList.add("muted");
    });
}

function handleMidiMessage(message) {
  const [status, data1, data2] = message.data;
  const isNoteOn = (status & 0xf0) === 0x90 && data2 > 0;
  if (!isNoteOn) return;
  const chromaIndex = data1 % 12;

  handleAnswer(chromaIndex);
}


async function init() {
  trialLogReady = loadTrialLog()
    .then(() => {
      isTrialLogLoaded = true;
    })
    .catch(() => {
      isTrialLogLoaded = true;
    });
  await trialLogReady;
  setupRandomizeButtonsToggle();
  setupSeriesRandomizeStartToggle();
  setupFeedbackSelect();
  setFeedbackMode(feedbackMode);
  showStartButton();
  setupMidi();
  if (statsButton) {
    statsButton.addEventListener("click", toggleStatsPanel);
  }
  setupExportLogsButton();
  setupSeriesControls();
  if (replayButton) {
    replayButton.addEventListener("click", handleReplayClick);
  }
  if (statsOutput) {
    statsOutput.textContent = "Start a session to view stats.";
    statsOutput.hidden = true;
  }
  await hydrateSavedSettings();
  await loadSeriesList();
}

document.addEventListener("DOMContentLoaded", () => {
  void init();
});
