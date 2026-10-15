/*
 * Everything you might want to tweak lives here, in human units
 * (seconds / minutes). No other JavaScript knowledge needed.
 *
 * Settings the INSTRUCTOR chooses on the setup screen (version and error
 * chance) are not all here; the values below are just the defaults shown on
 * that screen.
 *
 * After editing this file, bump CACHE_VERSION in sw.js (e.g. "zoneb-v2") so
 * installed copies of the app pick up the change.
 *
 * Field guide:
 *   battery_every_seconds         continuous seconds needed to produce/lose a battery
 *   error_delay_seconds           seconds after "Start Cycler" before a random error hits
 *   default_quiet_period_minutes  default minutes at start with no random errors
 *   cell_position_max             "{cell}" in an error text becomes a random 1..this number
 *   default_version               "corrective" or "preventive"
 *   versions.*.preventive         true = Maintenance / Quality Check screen is available
 *   versions.*.default_error_chance_percent  pre-filled on the instructor screen
 *   programs / correct_program    programs on the Select Program screen, and the right one
 *   ticket_max_chars              max length of a maintenance ticket
 *   errors                        corrective (random) errors
 *   maintenance_tasks             preventive tasks: due_minutes, repeat_minutes, error
 *                                 (error codes/descriptions are PLACEHOLDERS - edit them)
 */

window.SIM_CONFIG = {
  "battery_every_seconds": 7,
  "error_delay_seconds": 15,
  "default_quiet_period_minutes": 2,
  "cell_position_max": 5,
  "default_version": "corrective",
  "versions": {
    "corrective": {
      "label": "Corrective maintenance only",
      "preventive": false,
      "default_error_chance_percent": 50
    },
    "preventive": {
      "label": "Corrective and preventive maintenance",
      "preventive": true,
      "default_error_chance_percent": 20
    }
  },
  "programs": [
    "FMNTN2_CARCOMP_JUNE2026",
    "FMNTN1_CarComp_May2026",
    "FMNT1_SecondComp_May2024",
    "FMNT2_CarComp_Jan2025"
  ],
  "correct_program": "FMNTN1_CarComp_May2026",
  "ticket_max_chars": 2000,
  "errors": [
    {
      "code": "Erno1",
      "description": "Program interrupted during rest"
    },
    {
      "code": "Erno2",
      "description": "Program interrupted during discharge"
    },
    {
      "code": "Erno3",
      "description": "Program interrupted during charge"
    },
    {
      "code": "Erno4",
      "description": "Sudden voltage increase cell position #{cell}"
    },
    {
      "code": "Erno5",
      "description": "Cycler temperature out of spec"
    },
    {
      "code": "Erno6",
      "description": "Step skipped"
    }
  ],
  "maintenance_tasks": [
    {
      "name": "Clean lead connector",
      "due_minutes": 2,
      "repeat_minutes": 2,
      "error": {
        "code": "Erno7",
        "description": "Feedback from loom implausible"
      }
    },
    {
      "name": "Calibrate cycler",
      "due_minutes": 3,
      "repeat_minutes": 2,
      "error": {
        "code": "Erno5",
        "description": "Cycler temperature out of spec"
      }
    },
    {
      "name": "Check terminal connectors",
      "due_minutes": 4.5,
      "repeat_minutes": 2,
      "error": {
        "code": "Erno8",
        "description": "Insufficient terminal contact"
      }
    }
  ]
};
