/*
 * ============================================================================
 *  ZONE B SIMULATION
 * ============================================================================
 *
 * WHAT THIS FILE DOES
 *   It runs everything the user sees and clicks. There is no server logic here:
 *   The page is plain static files; the settings come from config.js.
 *
 * THE FLOW
 *   1. INSTRUCTOR SETUP screen (the first screen on every page load):
 *        the instructor picks the version (corrective only, or corrective +
 *        preventive) and the error chance, then clicks Continue.
 *   2. STUDENT HOME screen: the student clicks Start and goes straight into
 *        the simulation.
 *   3. SIMULATION: the student selects and starts programs, fixes errors and
 *        (preventive version only) records maintenance tasks.
 *   4. SUMMARY screen. Restart returns to the student home screen with the
 *        same instructor settings. Reload the page to change the settings.
 *
 * HOW ERRORS HAPPEN
 *   - CORRECTIVE: each time the student clicks Start Cycler, there is an
 *     X% chance (set by the instructor) that an error occurs a few seconds
 *     later (error_delay_seconds in config.js). No such error can occur
 *     during the instructor's "quiet period" at the start of the run.
 *   - PREVENTIVE (preventive version only): each maintenance task has a
 *     deadline. Once it is missed, that task's own error occurs again every
 *     repeat_minutes until the task is marked completed.
 *
 * THE FOUR "MODES"
 *   The simulation is always in exactly one mode. The mode decides which clock
 *   is running and what colour the page is.
 *
 *     normal       production running   -> UPTIME clock runs, batteries produced
 *     error        an error is active   -> DOWNTIME clock runs, batteries lost
 *     maintenance  user is on the maintenance screen
 *                                       -> DOWNTIME clock runs, batteries lost
 *     ended        summary screen
 *   (There is also "idle", used before the student presses Start.)
 *
 * HOW A "SCREEN" DIFFERS FROM A "MODE"
 *   A mode is what the production line is doing. A screen is which page of the
 *   website is showing. They usually match, but not always. For example, in
 *   "normal" mode the user can be looking at the sim screen or the program
 *   screen.
 *
 * WHEN AN ERROR CAN'T START RIGHT AWAY
 *   If an error comes due while the user is on the maintenance screen, or
 *   while another error is already active, it waits in a queue
 *   (state.pendingErrors) and starts as soon as the line is back in normal
 *   mode. An error CAN pull a user off the program screen, but never off the
 *   maintenance screen or the ticket screens.
 *
 * LAYOUT OF THIS FILE (read top to bottom)
 *    1. Config           settings read from config.js
 *    2. DOM references   links to the HTML elements we change
 *    3. Helpers          small reusable functions
 *    4. Time trackers    the uptime / downtime clocks
 *    5. State            everything that changes while the sim runs
 *    6. Mode switching   normal <-> error, and the error queue
 *    7. Preventive maintenance
 *    8. Program selection (and the chance of a corrective error)
 *    9. Maintenance tickets
 *   10. Instructor setup
 *   11. Start / end / reset
 *   12. Event listeners and init
 */

/*
 * The whole file is wrapped in "(() => { ... })();". This is called an IIFE
 * (immediately-invoked function expression). It runs once, straight away, and
 * keeps all our variables private so they can't clash with anything else on
 * the page.
 */
(() => {
  // "use strict" turns on stricter JavaScript rules. For example, it makes
  // typos in variable names throw an error instead of silently creating a new
  // global variable.
  "use strict";

  /* ========================================================================
   * 1. CONFIG
   * Settings come from config.js (in friendly units) and are converted here
   * into milliseconds, which is what JavaScript timers use.
   * ======================================================================== */

  // Tiny conversion helpers. "n => n * 60 * 1000" is an arrow function: it
  // takes n and returns n * 60 * 1000. So minutes(2) gives 120000 (ms).
  const minutes = n => n * 60 * 1000;
  const seconds = n => n * 1000;

  // config.js (loaded before this file) puts the settings on window.SIM_CONFIG.
  const RAW = window.SIM_CONFIG;

  // CONFIG is the same data, converted to milliseconds and renamed for use in
  // this file. To change a value, edit config.js, not this. The "|| 7" style
  // fallbacks are used if a value is missing from config.js.
  const CONFIG = {
    batteryEveryMs: seconds(RAW.battery_every_seconds || 7),   // one battery per this many ms
    errorDelayMs: seconds(RAW.error_delay_seconds || 15),      // Start Cycler -> error delay
    cellPositionMax: RAW.cell_position_max || 5,               // "{cell}" in a description becomes 1..this
    // "??" only falls back when the value is missing, so 0 is allowed here.
    defaultQuietMinutes: RAW.default_quiet_period_minutes ?? 2, // pre-filled on the instructor screen
    programs: RAW.programs,                                    // names shown on the program screen
    correctProgram: RAW.correct_program,                       // the one that counts as correct
    ticketMaxChars: RAW.ticket_max_chars || 2000,              // max length of a ticket
    errors: RAW.errors,                                        // corrective error codes and descriptions
    versions: RAW.versions,                                    // the two versions the instructor can pick
    defaultVersion: RAW.default_version,
    // .map() builds a new list by running a function on every item. Here it
    // converts each task's minutes into milliseconds.
    maintenanceTasks: RAW.maintenance_tasks.map(t => ({
      name: t.name,
      dueMs: minutes(t.due_minutes),
      // How often this task's error repeats while overdue. The ">" check
      // guards against 0 or a negative number, which would freeze the page.
      repeatMs: minutes(t.repeat_minutes > 0 ? t.repeat_minutes : 2),
      error: t.error,                  // { code, description } shown when the task is overdue
    })),
    tickMs: 250,              // how often the clocks refresh (four times a second)
    deadlineCheckMs: 1000,    // how often maintenance deadlines are checked (once a second)
  };

  /* ========================================================================
   * 2. DOM REFERENCES
   * The "DOM" is the page's HTML as JavaScript sees it. getElementById finds
   * an element by its id="..." in index.html. We look each one up once here,
   * then reuse the variable everywhere else.
   * ======================================================================== */

  // "$" is just a short name for document.getElementById.
  const $ = id => document.getElementById(id);

  // Every full-page "screen". Only the one with class "active" is visible
  // (style.css hides the rest).
  const screens = {
    setup: $("setupScreen"),
    home: $("homeScreen"),
    sim: $("simScreen"),
    maintenance: $("maintenanceScreen"),
    program: $("programScreen"),
    ticket: $("ticketScreen"),
    ticketConfirm: $("ticketConfirmScreen"),
    summary: $("summaryScreen"),
  };

  // Individual elements we read from or change.
  // Build the instructor's version radio buttons and the error-delay text from
  // config.js (they used to be filled in by Flask). Must run before `els` below.
  (function renderSetupFromConfig() {
    const group = document.getElementById("versionGroup");
    Object.entries(CONFIG.versions).forEach(([key, version]) => {
      const label = document.createElement("label");
      label.className = "optionRow";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "version";
      input.value = key;
      const span = document.createElement("span");
      span.textContent = version.label;
      label.append(input, span);
      group.appendChild(label);
    });
    document.getElementById("errorDelayText").textContent = RAW.error_delay_seconds;
  })();

  const els = {
    // Instructor setup screen
    versionOptions: document.querySelectorAll('input[name="version"]'),  // the radio buttons
    chanceInput: $("errorChance"),
    quietInput: $("quietPeriod"),
    setupStatus: $("setupStatus"),
    setupContinueBtn: $("setupContinueBtn"),

    // Text at the top of the sim screen, and the four live counters
    modeTitle: $("modeTitle"),
    modeDesc: $("modeDesc"),
    uptime: $("uptimeTime"),
    produced: $("producedCount"),
    downtime: $("downtimeTime"),
    lost: $("lostCount"),

    // Buttons on the home / sim screens
    startBtn: $("startBtn"),
    endBtn: $("endBtn"),
    fixBtn: $("fixBtn"),
    ticketBtn: $("ticketBtn"),
    selectProgramBtn: $("selectProgramBtn"),
    maintenanceBtn: $("maintenanceBtn"),
    restartBtn: $("restartBtn"),

    // Maintenance screen
    taskList: $("maintenanceTaskList"),
    maintenanceReturnBtn: $("maintenanceReturnBtn"),

    // Program screen
    programList: $("programList"),
    programBackBtn: $("programBackBtn"),
    cyclerStartBtn: $("cyclerStartBtn"),

    // Ticket screen and its confirmation page
    ticketText: $("ticketText"),
    ticketStatus: $("ticketStatus"),
    ticketSubmitBtn: $("ticketSubmitBtn"),
    ticketCancelBtn: $("ticketCancelBtn"),
    ticketConfirmYesBtn: $("ticketConfirmYesBtn"),
    ticketConfirmNoBtn: $("ticketConfirmNoBtn"),

    // Summary screen values
    finalTickets: $("finalTickets"),
    finalUptime: $("finalUptime"),
    finalProduced: $("finalProduced"),
    finalDowntime: $("finalDowntime"),
    finalLost: $("finalLost"),
    finalPrograms: $("finalPrograms"),
    finalProblems: $("finalProblems"),
  };

  /* ========================================================================
   * 3. HELPERS
   * Small, general-purpose functions used in many places.
   * ======================================================================== */

  // Show one screen and hide all the others.
  // Object.entries(screens) turns the object into [["setup", el], ["sim", el], ...].
  // classList.toggle("active", condition) adds the class "active" when the
  // condition is true and removes it when false. So only the screen whose
  // name matches gets "active".
  function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) =>
      el.classList.toggle("active", key === name)
    );
  }

  // Fisher-Yates shuffle: puts a list in random order, in place.
  // It walks backwards through the list, swapping each item with a randomly
  // chosen item at or before it.
  function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));   // random whole number from 0 to i
      [arr[i], arr[j]] = [arr[j], arr[i]];             // swap the two items
    }
    return arr;
  }

  // Turns 5 into "05" (always at least two characters, padded with zeros).
  const pad = n => String(n).padStart(2, "0");

  // A random whole number from min to max, including both ends.
  // Math.random() is 0 up to (not including) 1, so the result is always valid.
  const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  // Replaces "{cell}" in an error description with a random cell position
  // (1 to cellPositionMax). One number is picked per call, so every "{cell}"
  // in the same description gets the same number. Descriptions without
  // "{cell}" come back unchanged. The config itself is never modified, so the
  // next time the error occurs it gets a new random number.
  function fillPlaceholders(text) {
    return text.replace(/\{cell\}/g, String(randomInt(1, CONFIG.cellPositionMax)));
  }

  // Milliseconds -> "HH:MM:SS", for the uptime and downtime clocks.
  function formatTime(ms) {
    const total = Math.floor(ms / 1000);   // whole seconds
    // % is "remainder after dividing". 3725 s -> 1 h, then (3725 % 3600) = 125 s -> 2 min, 5 s.
    return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  }

  // Milliseconds -> "M:SS", for the maintenance deadlines (e.g. "4:30").
  function formatDeadline(ms) {
    const total = Math.floor(ms / 1000);
    return `${Math.floor(total / 60)}:${pad(total % 60)}`;
  }

  /* ========================================================================
   * 4. TIME TRACKERS
   * A tracker is a stopwatch that also counts batteries. We make two: one for
   * uptime (batteries produced) and one for downtime (batteries lost).
   * ======================================================================== */

  // createTracker() builds and returns one stopwatch. Each call gets its own
  // private variables, so the two trackers never interfere with each other.
  function createTracker() {
    let elapsedMs = 0;   // total time this tracker has been running
    let count = 0;       // batteries counted so far
    let tickId = null;   // id of the interval that updates the clock
    let countId = null;  // id of the interval that adds batteries
    let last = null;     // timestamp of the last clock update

    // Adds the real time that has passed since the last update.
    // We measure real time with performance.now() instead of just adding 250
    // each tick, because browsers don't fire timers exactly on schedule.
    function accumulate() {
      if (last === null) return;           // not running, nothing to add
      const now = performance.now();
      elapsedMs += now - last;
      last = now;
    }

    // This object is what createTracker() returns: the tracker's controls.
    return {
      // Start running. setInterval(fn, ms) calls fn again and again every ms.
      start() {
        if (tickId !== null) return;       // already running, don't start twice
        last = performance.now();
        tickId = setInterval(() => { accumulate(); render(); }, CONFIG.tickMs);
        // A battery is only counted after batteryEveryMs of CONTINUOUS running.
        // This timer starts fresh every time start() is called, so partial
        // progress is lost whenever the mode changes.
        countId = setInterval(() => { count += 1; render(); }, CONFIG.batteryEveryMs);
      },
      // Pause. Adds the last bit of time first so nothing is lost.
      stop() {
        accumulate();
        clearInterval(tickId);             // stop the repeating timers
        clearInterval(countId);
        tickId = countId = last = null;
      },
      // Stop and set everything back to zero.
      reset() {
        this.stop();
        elapsedMs = 0;
        count = 0;
      },
      // "get" lets other code read uptime.elapsedMs like a normal value,
      // while keeping the real variable private.
      get elapsedMs() { return elapsedMs; },
      get count() { return count; },
    };
  }

  const uptime = createTracker();    // runs only in "normal" mode
  const downtime = createTracker();  // runs in "error" and "maintenance" modes

  // Copies the current numbers onto the page. Called after every change.
  // textContent sets the visible text of an element.
  function render() {
    els.uptime.textContent = formatTime(uptime.elapsedMs);
    els.produced.textContent = String(uptime.count);
    els.downtime.textContent = formatTime(downtime.elapsedMs);
    els.lost.textContent = String(downtime.count);
  }

  /* ========================================================================
   * 5. STATE
   * "State" is everything that changes while the simulation runs, kept in one
   * object so that resetting is just "make a new object".
   * ======================================================================== */

  // The instructor's choices. Set by applySetup() and kept when the student
  // restarts, so a class can run several rounds with the same settings.
  //   version            key from config.js ("corrective" or "preventive")
  //   preventive         true if the maintenance screen and its errors are on
  //   errorChancePercent chance (0-100) of an error after Start Cycler
  //   quietPeriodMs      no random error may occur this long after the run starts
  let settings = null;

  let state = null;   // filled in by resetAll() at the bottom of the file

  // Builds a brand-new, empty state object.
  function freshState() {
    return {
      mode: "idle",               // current mode (see the top of the file)
      startedAt: null,            // Date.now() when the student pressed Start
      programErrorTimeouts: [],   // ids of timers waiting to raise a corrective error
      deadlineCheckId: null,      // interval that checks maintenance deadlines
      errorDeck: [],              // shuffled corrective errors, used one at a time
      selectedProgram: null,      // program picked on the program screen
      currentError: null,         // the error scenario currently showing
      ticketsRaised: 0,           // tickets confirmed this session (text is not kept)
      programsRun: 0,             // times Start Cycler was pressed
      programsCorrect: 0,         // ...of which used the correct program
      problemsSolved: 0,          // times Error Fixed was pressed
      pendingErrors: [],          // errors waiting for the line to be in normal mode
      // One entry per maintenance task. "...t" copies the name, dueMs, repeatMs
      // and error from the config, then we add the fields that change during
      // the sim. (Only used in the preventive version.)
      tasks: CONFIG.maintenanceTasks.map(t => ({
        ...t,
        completed: false,
        completedAtMs: null,
        nextErrorAtMs: t.dueMs,   // when a missed task next queues an error
      })),
    };
  }

  // How many ms of real time have passed since the simulation started.
  // Used for maintenance deadlines. This runs on the wall clock, so it keeps
  // counting even during errors and maintenance. (The ternary "a ? b : c"
  // means: if a is true use b, otherwise use c.)
  const simElapsedMs = () => (state.startedAt === null ? 0 : Date.now() - state.startedAt);

  // Gives the next corrective error from a shuffled "deck". Every error is
  // used once before any repeats; when the deck is empty it is refilled and
  // reshuffled.
  function nextError() {
    if (state.errorDeck.length === 0) {
      // .slice() makes a copy so the original config list isn't reordered.
      state.errorDeck = shuffleInPlace(CONFIG.errors.slice());
    }
    return state.errorDeck.pop();   // removes and returns the last item
  }

  /* ========================================================================
   * 6. MODE SWITCHING AND THE ERROR QUEUE
   * ======================================================================== */

  // The ONE place where the mode changes. It:
  //   - records the new mode
  //   - starts/stops the right clock
  //   - updates the page background and the title/description text
  //   - shows or hides the mode-specific buttons
  function setMode(mode, title, description) {
    state.mode = mode;

    // Stop both clocks, then start only the one this mode needs.
    uptime.stop();
    downtime.stop();
    if (mode === "normal") uptime.start();
    if (mode === "error" || mode === "maintenance") downtime.start();

    // dataset.mode sets the attribute data-mode="..." on <body>. style.css has
    // a rule for each value that picks the background colour.
    document.body.dataset.mode = mode;
    els.modeTitle.textContent = title;
    els.modeDesc.textContent = description;

    // "hidden = true" hides a button. These buttons only make sense in one mode.
    els.fixBtn.hidden = mode !== "error";
    els.ticketBtn.hidden = mode !== "error";
    els.selectProgramBtn.hidden = mode !== "normal";   // can't start a program while the line is down
    // The maintenance button only exists in the preventive version.
    els.maintenanceBtn.hidden = !(mode === "normal" && settings.preventive);
    render();
  }

  // Switch to normal operations.
  function enterNormalMode() {
    setMode("normal", "Normal operations", "Systems are operating within expected parameters.");
  }

  // Switch to error mode. "scenario" is the { code, description } to show.
  // If none is given (corrective errors), the next one from the deck is used.
  function enterErrorMode(scenario) {
    // Never interrupt maintenance, and never run before/after the simulation.
    // ["a", "b"].includes(x) is true when x is one of the listed values.
    if (["idle", "ended", "maintenance"].includes(state.mode)) return;
    // Never pull the user out of the ticket form or its confirmation page.
    // ("||" means "or".)
    if (screens.ticket.classList.contains("active") ||
        screens.ticketConfirm.classList.contains("active")) return;

    const chosen = scenario || nextError();
    // Fill in the random cell position (if the description has one) NOW, so
    // it is different every time the error occurs.
    const shown = { ...chosen, description: fillPlaceholders(chosen.description) };
    state.currentError = shown;
    setMode("error", `Error: ${shown.code}`, shown.description);
    // This DOES pull the user off the program screen (as intended), but not
    // off the maintenance screen, because of the guard above.
    showScreen("sim");
  }

  // Add an error to the waiting list, then start it right away if the line is
  // in normal mode. Used by both the corrective timer and the preventive
  // deadline checker, so errors never overlap.
  //   entry = { taskName, error }
  //   taskName: the maintenance task that caused it (null for corrective errors)
  //   error:    { code, description } to show (null = take one from the deck)
  function queueError(entry) {
    state.pendingErrors.push(entry);
    startNextErrorIfNormal();
  }

  function startNextErrorIfNormal() {
    if (state.mode === "normal") enterNextQueuedError();
  }

  // Start the first waiting error, if any. Returns true if one was started.
  function enterNextQueuedError() {
    if (state.pendingErrors.length === 0) return false;
    const entry = state.pendingErrors.shift();   // removes the first item in the queue
    enterErrorMode(entry.error);
    return true;
  }

  /* ========================================================================
   * 7. PREVENTIVE MAINTENANCE (preventive version only)
   * ======================================================================== */

  // Open the maintenance screen. Only allowed in normal mode, and only in the
  // preventive version.
  function openMaintenance() {
    if (state.mode !== "normal" || !settings.preventive) return;
    // Switching to "maintenance" mode stops uptime and starts downtime.
    setMode("maintenance", "Preventive maintenance", "Production is paused while maintenance is performed.");
    renderMaintenanceTasks();
    showScreen("maintenance");
  }

  // Leave the maintenance screen. Any error that came due while the user was
  // away is waiting in the queue and starts now.
  function closeMaintenance() {
    showScreen("sim");
    // Leave "maintenance" mode FIRST: enterErrorMode() refuses to run while
    // the mode is "maintenance".
    enterNormalMode();
    enterNextQueuedError();   // starts a queued error if there is one
  }

  // Mark a task as done. Tasks are looked up by name.
  function completeTask(name) {
    // .find() returns the first item for which the function is true.
    const task = state.tasks.find(t => t.name === name);
    if (!task || task.completed) return;   // unknown task or already done
    task.completed = true;
    task.completedAtMs = simElapsedMs();   // remember when it was done
    // Remove any queued errors this task caused. .filter() keeps only the
    // items for which the function is true.
    state.pendingErrors = state.pendingErrors.filter(e => e.taskName !== name);
    renderMaintenanceTasks();
  }

  // Un-mark a task as done.
  function undoTask(name) {
    const task = state.tasks.find(t => t.name === name);
    if (!task) return;
    task.completed = false;
    task.completedAtMs = null;
    // Restart the error schedule from now. Without this, the old (past)
    // schedule would instantly queue a burst of errors.
    const elapsed = simElapsedMs();
    task.nextErrorAtMs = elapsed < task.dueMs ? task.dueMs : elapsed + task.repeatMs;
    renderMaintenanceTasks();
  }

  // Rebuilds the checklist on the maintenance screen from scratch.
  // document.createElement makes a new HTML element in memory; we fill it in
  // and then attach it to the page.
  function renderMaintenanceTasks() {
    const elapsed = simElapsedMs();
    els.taskList.innerHTML = "";   // empty the list first

    state.tasks.forEach(task => {
      // A task is overdue if it isn't done and its deadline has passed.
      const overdue = !task.completed && elapsed >= task.dueMs;

      // The row: green when completed, red when overdue.
      const row = document.createElement("div");
      row.className = "maintenanceTask";
      if (task.completed) row.classList.add("completed");
      else if (overdue) row.classList.add("overdue");

      const details = document.createElement("div");

      const name = document.createElement("div");
      name.className = "taskName";
      name.textContent = task.name;

      const deadline = document.createElement("div");
      deadline.className = "taskDeadline";
      deadline.textContent = `Required by ${formatDeadline(task.dueMs)} into the simulation`;

      // Status line: completed / overdue / time remaining.
      const status = document.createElement("div");
      status.className = "taskStatus";
      if (task.completed) {
        status.classList.add("taskCompleted");
        status.textContent = `Completed at ${formatDeadline(task.completedAtMs)}`;
      } else if (overdue) {
        status.classList.add("taskOverdue");
        status.textContent = "Overdue";
      } else {
        status.textContent = `Due in ${formatDeadline(task.dueMs - elapsed)}`;
      }

      // .append() puts the three pieces inside "details", in order.
      details.append(name, deadline, status);

      // The button on the right: "Undo" if done, "Mark Completed" if not.
      // The arrow function passed to addEventListener runs when it's clicked.
      const button = document.createElement("button");
      if (task.completed) {
        button.textContent = "Undo";
        button.className = "warn";
        button.addEventListener("click", () => undoTask(task.name));
      } else {
        button.textContent = "Mark Completed";
        button.className = "primary";
        button.addEventListener("click", () => completeTask(task.name));
      }

      row.append(details, button);
      els.taskList.appendChild(row);   // attach the finished row to the page
    });
  }

  // Runs once a second (see startSimulation) in the preventive version. For
  // every task that is overdue and not done, it queues that task's error each
  // time another repeat interval passes (until the task is completed).
  function checkMaintenanceDeadlines() {
    if (state.mode === "idle" || state.mode === "ended") return;
    const elapsed = simElapsedMs();

    state.tasks.forEach(task => {
      if (task.completed) return;   // done tasks never cause errors
      // "while" repeats as long as the condition is true. It's a loop (not an
      // "if") so that if the browser was busy and skipped a check, we still
      // queue every error that was due.
      while (elapsed >= task.nextErrorAtMs) {
        state.pendingErrors.push({ taskName: task.name, error: task.error });
        task.nextErrorAtMs += task.repeatMs;   // next one is due later
      }
    });

    // Start a waiting error if the line is running normally.
    startNextErrorIfNormal();
    // If the user is looking at the checklist, refresh it so statuses update.
    if (screens.maintenance.classList.contains("active")) renderMaintenanceTasks();
  }

  /* ========================================================================
   * 8. PROGRAM SELECTION
   * ======================================================================== */

  // Open the program screen and build one button per program.
  function openProgramScreen() {
    state.selectedProgram = null;                 // nothing chosen yet
    els.cyclerStartBtn.disabled = true;           // greyed out until a program is chosen
    els.programList.classList.remove("has-selection");
    els.programList.innerHTML = "";               // clear old buttons

    CONFIG.programs.forEach(name => {
      const btn = document.createElement("button");
      btn.textContent = name;
      btn.className = "secondary";
      // aria-pressed tells screen readers whether this button is "on".
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", () => {
        state.selectedProgram = name;
        // "has-selection" makes CSS dim the unselected buttons.
        els.programList.classList.add("has-selection");
        // Loop over every program button: highlight this one, un-highlight the rest.
        [...els.programList.children].forEach(b => {
          const isThis = b === btn;
          b.classList.toggle("selected", isThis);
          b.setAttribute("aria-pressed", String(isThis));
        });
        els.cyclerStartBtn.disabled = false;      // now Start Cycler can be pressed
      });
      els.programList.appendChild(btn);
    });

    showScreen("program");
  }

  // Start Cycler: record the run, and whether it was the correct program.
  // Then roll the dice for a corrective error.
  function startCycler() {
    if (!state.selectedProgram) return;   // safety net; the button is disabled anyway
    state.programsRun += 1;
    if (state.selectedProgram === CONFIG.correctProgram) state.programsCorrect += 1;
    showScreen("sim");
    maybeScheduleProgramError();
  }

  // With the instructor's chance (e.g. 50%), schedule an error to occur
  // errorDelayMs from now.
  function maybeScheduleProgramError() {
    // Quiet period: no random error may occur during the first quietPeriodMs
    // of the run. We check when the error WOULD happen (now + the delay). The
    // run time is wall-clock time since Start was pressed, so it keeps
    // counting during errors and maintenance.
    if (simElapsedMs() + CONFIG.errorDelayMs < settings.quietPeriodMs) {
      console.log("Within the quiet period; no error will occur.");
      return;
    }

    // Math.random() * 100 is a number from 0 up to (not including) 100. It is
    // below a 50% chance about half the time; at 0% never, at 100% always.
    const roll = Math.random() * 100;
    console.log(`Error chance ${settings.errorChancePercent}%, rolled ${roll.toFixed(1)}`);   // visible in the browser console (F12)
    if (roll >= settings.errorChancePercent) return;   // no error this time

    // setTimeout(fn, ms) runs fn once after ms. We remember its id so that it
    // can be cancelled if the simulation ends first.
    const id = setTimeout(() => {
      state.programErrorTimeouts = state.programErrorTimeouts.filter(t => t !== id);
      // taskName null = not caused by a maintenance task; error null = pick
      // from the corrective deck. If the user is on the maintenance screen or
      // another error is active, it waits in the queue.
      queueError({ taskName: null, error: null });
    }, CONFIG.errorDelayMs);
    state.programErrorTimeouts.push(id);
  }

  /* ========================================================================
   * 9. MAINTENANCE TICKETS
   * Tickets can only be raised during an error. The mode stays "error" while
   * the ticket windows are open, so downtime keeps counting. Only the NUMBER
   * of tickets is kept; the text is never stored.
   *
   * Flow: ticket form -> Submit -> "reviewed with team lead?" ->
   *         No  = back to the form (text kept)
   *         Yes = ticket counted, text discarded, back to the simulation
   * ======================================================================== */

  // Open a blank ticket form.
  function openTicket() {
    if (state.mode !== "error") return;   // only during an error
    els.ticketText.value = "";            // .value is what's typed in the box
    els.ticketStatus.textContent = "";    // clear any old warning message
    showScreen("ticket");
    els.ticketText.focus();               // put the cursor in the box
  }

  // Cancel: throw the text away and go back without counting a ticket.
  function cancelTicket() {
    els.ticketText.value = "";
    showScreen("sim");
  }

  // Submit: check something was written, then ask the confirmation question.
  function submitTicket() {
    // .trim() removes spaces, so a box with only spaces counts as empty.
    if (!els.ticketText.value.trim()) {
      els.ticketStatus.textContent = "Please describe the issue before submitting.";
      return;
    }
    els.ticketStatus.textContent = "";
    showScreen("ticketConfirm");
  }

  // "No" on the confirmation page: back to the form. The text is still there.
  function confirmNo() {
    showScreen("ticket");
    els.ticketText.focus();
  }

  // "Yes" on the confirmation page: count the ticket and discard the text.
  function confirmYes() {
    state.ticketsRaised += 1;
    els.ticketText.value = "";   // the text is discarded
    showScreen("sim");
  }

  /* ========================================================================
   * 10. INSTRUCTOR SETUP
   * ======================================================================== */

  // True once the instructor has typed their own percentage. Until then,
  // switching version updates the box to that version's default.
  let chanceEdited = false;

  // Which radio button is selected? Returns its value (the version key).
  // [...list] turns the radio list into a normal array so .find() works.
  function selectedVersionKey() {
    const chosen = [...els.versionOptions].find(r => r.checked);
    return chosen ? chosen.value : CONFIG.defaultVersion;
  }

  // Fill in the setup screen when the page loads: select the default version
  // and pre-fill its error chance.
  function initSetupScreen() {
    [...els.versionOptions].forEach(r => { r.checked = r.value === CONFIG.defaultVersion; });
    els.chanceInput.value = String(CONFIG.versions[selectedVersionKey()].default_error_chance_percent);
    els.quietInput.value = String(CONFIG.defaultQuietMinutes);
  }

  // When the version changes, show that version's default chance
  // (unless the instructor has already typed their own).
  function onVersionChange() {
    if (chanceEdited) return;
    els.chanceInput.value = String(CONFIG.versions[selectedVersionKey()].default_error_chance_percent);
  }

  // "Continue": check the chance is a number from 0 to 100 and the quiet
  // period is a number of minutes (0 or more), remember the choices, and show
  // the student home screen.
  function applySetup() {
    const chanceText = els.chanceInput.value.trim();
    const percent = Number(chanceText);   // "" or "abc" becomes 0 or NaN, caught below
    if (chanceText === "" || !Number.isFinite(percent) || percent < 0 || percent > 100) {
      els.setupStatus.textContent = "Please enter an error chance between 0 and 100.";
      return;
    }
    const quietText = els.quietInput.value.trim();
    const quietMinutes = Number(quietText);
    if (quietText === "" || !Number.isFinite(quietMinutes) || quietMinutes < 0) {
      els.setupStatus.textContent = "Please enter a quiet period of 0 minutes or more.";
      return;
    }
    const version = selectedVersionKey();
    settings = {
      version,
      preventive: Boolean(CONFIG.versions[version].preventive),
      errorChancePercent: percent,
      quietPeriodMs: minutes(quietMinutes),
    };
    els.setupStatus.textContent = "";
    showScreen("home");
  }

  /* ========================================================================
   * 11. START / END / RESET
   * ======================================================================== */

  // Stop every timer and clock. Used when ending or resetting.
  // It only STOPS the clocks; their values are kept so the summary screen can
  // still read them. Zeroing happens separately in resetAll().
  function stopEverything() {
    // Cancel any corrective errors still waiting to happen.
    state.programErrorTimeouts.forEach(id => clearTimeout(id));
    state.programErrorTimeouts = [];
    clearInterval(state.deadlineCheckId);
    state.deadlineCheckId = null;
    uptime.stop();
    downtime.stop();
  }

  // Called when the student presses Start on the home screen.
  function startSimulation() {
    state.startedAt = Date.now();   // Date.now() = the current time in ms
    showScreen("sim");
    enterNormalMode();              // starts the uptime clock
    // Preventive version only: check maintenance deadlines once every second.
    if (settings.preventive) {
      state.deadlineCheckId = setInterval(checkMaintenanceDeadlines, CONFIG.deadlineCheckMs);
    }
  }

  // Called by "End Simulation": stop everything and fill in the summary.
  function endSimulation() {
    if (state.mode === "idle") return;   // nothing to end
    stopEverything();
    state.mode = "ended";
    document.body.dataset.mode = "ended";   // dark background

    els.finalUptime.textContent = formatTime(uptime.elapsedMs);
    els.finalProduced.textContent = String(uptime.count);
    els.finalDowntime.textContent = formatTime(downtime.elapsedMs);
    els.finalLost.textContent = String(downtime.count);
    els.finalPrograms.textContent = `${state.programsCorrect} / ${state.programsRun}`;
    els.finalProblems.textContent = String(state.problemsSolved);
    els.finalTickets.textContent = String(state.ticketsRaised);
    showScreen("summary");
  }

  // Back to a clean start: stop timers, zero the clocks, make a fresh state,
  // and show the student home screen. The instructor's settings are kept.
  function resetAll() {
    if (state) stopEverything();   // on first load, state doesn't exist yet
    uptime.reset();                // zero both clocks and battery counts
    downtime.reset();
    state = freshState();
    document.body.dataset.mode = "idle";
    render();
    showScreen("home");
  }

  /* ========================================================================
   * 12. EVENT LISTENERS AND INIT
   * addEventListener("click", fn) means: when this element is clicked, run fn.
   * Passing a function name (like startSimulation) runs it directly; the
   * "() => { ... }" form is used when we need to do more than one thing.
   * ======================================================================== */

  // Instructor setup
  els.versionOptions.forEach(r => r.addEventListener("change", onVersionChange));
  els.chanceInput.addEventListener("input", () => { chanceEdited = true; });
  els.setupContinueBtn.addEventListener("click", applySetup);

  // Student home, end and restart
  els.startBtn.addEventListener("click", startSimulation);
  els.endBtn.addEventListener("click", endSimulation);
  els.restartBtn.addEventListener("click", resetAll);

  // "Error Fixed": count it, then either show the next waiting error or
  // return to normal operations.
  els.fixBtn.addEventListener("click", () => {
    if (state.mode !== "error") return;   // safety check
    state.problemsSolved += 1;
    showScreen("sim");
    // Another waiting error goes first; otherwise back to normal.
    if (!enterNextQueuedError()) enterNormalMode();
  });

  // Maintenance screen
  els.maintenanceBtn.addEventListener("click", openMaintenance);
  els.maintenanceReturnBtn.addEventListener("click", closeMaintenance);

  // Program screen (Back just returns to the sim screen)
  els.selectProgramBtn.addEventListener("click", openProgramScreen);
  els.programBackBtn.addEventListener("click", () => showScreen("sim"));
  els.cyclerStartBtn.addEventListener("click", startCycler);

  // Ticket screens. maxLength stops the browser accepting more characters
  // than the limit set in config.js.
  els.ticketText.maxLength = CONFIG.ticketMaxChars;
  els.ticketBtn.addEventListener("click", openTicket);
  els.ticketCancelBtn.addEventListener("click", cancelTicket);
  els.ticketSubmitBtn.addEventListener("click", submitTicket);
  els.ticketConfirmNoBtn.addEventListener("click", confirmNo);
  els.ticketConfirmYesBtn.addEventListener("click", confirmYes);

  // INIT: runs once when the page loads. Sets up a fresh state, fills in the
  // instructor setup screen, and shows it first.
  resetAll();
  initSetupScreen();
  showScreen("setup");
})();
