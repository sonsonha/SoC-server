/**
 * Approved default AI User Context for PERSONAL_OS_INITIAL_OWNER_EMAIL only.
 *
 * This is a fallback until the owner explicitly saves AI Context. Never use it
 * for another user and never scatter copies of this text through prompts or UI.
 */
export const INITIAL_OWNER_AI_CONTEXT_DEFAULT = `BACKGROUND

- Computer Engineering graduate from HCMUT.
- Software engineering experience across backend, mobile, IoT and robotics.
- Has worked with Go, Node.js, REST APIs, PostgreSQL, MongoDB, MQTT,
  Docker/Railway and related backend infrastructure.
- Has also worked on Android and applied robotics/perception projects.
- Wants to become a strong software engineer (backend-primary, but compatible
  generalist Software Engineer opportunities are welcome).

==================================================
CURRENT REAL PRIORITIES (FOCUS)
==================================================

The only genuinely active FOCUS Goals right now are:

1. Obtain a strong Software Engineer / Backend-focused job.
2. Achieve IELTS 7.0.

FOCUS must remain intentionally small.
Do NOT invent additional FOCUS Goals from current work, technical interests,
side projects, or curiosity.

### FOCUS — Software Engineering Career

Outcome direction:
Obtain a strong Software Engineer / Backend-focused position.

Backend is the primary direction, but compatible generalist Software Engineer
roles should not automatically be excluded.

Relevant workstreams under THIS Goal (as Projects / Processes / Tasks — not
separate Goals):
- job search
- candidate positioning
- technical interview preparation
- applications
- appropriate professional outreach

### FOCUS — IELTS 7.0

Outcome:
Achieve IELTS Overall Band 7.0.

English development related directly to IELTS belongs under this Goal.
Do NOT split Speaking, Writing, Reading, and Listening into separate Goals.
They may become Projects, Tasks, Processes, or Sessions when useful.

==================================================
WORK CONTEXT — NOT PERSONAL GOALS
==================================================

Landfill Rover and Drone / Remote ID are NOT personal Goals.

They are projects belonging to current professional employment / work.

Examples of Work Projects:
- Landfill Rover
- Drone / Remote ID

Their weekly deliverables are Work Tasks, not Goals.

Do NOT generate Goals such as:
- Improve Rover perception
- Complete Drone Remote ID
- Advance robotics project

unless the user explicitly chooses to turn something into a personal Goal.

Current work such as:
- Landfill Rover
- Drone / Remote ID
- robotics / perception work
- embedded / BLE / GNSS work

is useful background context only.

It may appear as:
- Work Projects
- Work Tasks
- Calendar commitments
- professional experience / context

but NOT as personal Goals by default.

==================================================
WORK-HOURS BOUNDARY
==================================================

Normal work hours:

Monday–Friday
10:00–18:00

Tasks belonging to current employment / work projects should preferentially be
planned inside these work hours.

Preferred rule:
Work Task → schedule during Mon–Fri 10:00–18:00.

Personal / off-hours should NOT automatically be consumed by work.

Only schedule work outside working hours when:
- the Task is genuinely urgent,
- it cannot reasonably be completed during working hours,
- and extra work is necessary to meet the commitment.

AI planning must protect this boundary.

Do NOT routinely sacrifice IELTS, career development, health, or personal time
for ordinary Rover / Drone Tasks.

Ordinary Work Tasks should not consume all personal capacity.
Work is protected primarily inside work hours.

==================================================
MAINTAIN
==================================================

MAINTAIN is for important areas that should stay healthy without competing
aggressively with the two FOCUS Goals.

Prefer broad, low-administration maintenance areas.

Current seeded MAINTAIN Goals:
- Maintain Good Health
- Continuous Learning & Intellectual Development
- Maintain Personal Financial Awareness & Control

### Health (Maintain Good Health)

Treat Health broadly. It includes:
- physical health
- exercise
- running / gym / basketball where relevant
- sleep
- sleep routine
- basic daily routine
- recovery

Do NOT unnecessarily create separate Goals such as:
- Fix sleep
- Go to gym
- Run regularly
- Improve health

when one broader Health maintenance Goal is sufficient.

Seeded Habit Projects under Health:
- Exercise & Movement — intended direction: 3 sessions/week
- Sleep Routine

Sleep targets:
- Current operational target (judge against this now): bedtime 22:30 / wake 06:00
- Official long-term target: bedtime 22:00 / wake 05:00

Future sleep tracking (NOT implemented yet) should use Session/checkpoint
completion timestamps and separately measure:
1. bedtime lateness trend
2. wake-up lateness trend
3. combined sleep-discipline trend

Do not collapse sleep into one opaque score.

### Continuous Learning & Intellectual Development

Maintain continuous intellectual and professional development beyond only
short-term interview preparation.

Includes when relevant:
- books / long-form reading
- software engineering fundamentals
- databases / systems / backend
- AI / robotics / applied engineering
- broader intellectual knowledge

Seeded Habit Projects:
- Reading
- Professional Learning

Do NOT turn every technology being studied into a Goal.
No separate News Project unless the user later asks for structured execution.

### Personal Finance (Maintain Personal Financial Awareness & Control)

Maintain basic personal financial awareness and discipline:
- record income / expenses
- weekly financial review
- monthly spending review
- allocation / budget review

Seeded Habit Project:
- Financial Tracking & Review

Income is typically recorded only ~1–2 times/month.
Spending is more frequent.
Do NOT require daily income entries.

Future Finance freshness heuristic (confirmed stale threshold: 5 days):
lastFinanceActivity = max(lastExpenseRecordedAt, lastFinanceReviewAt)
If older than 5 days → surface "Finance tracking may be stale — check Finance."
This is a reminder heuristic, not proof that spending was forgotten.

### General Awareness / News

Maintain reasonable awareness of technology, business/economics where relevant,
and important professional developments — lightweight and opportunistic for now.

==================================================
EDUCATION / SCHOLARSHIP OPPORTUNITIES
==================================================

The user remains interested in:
- scholarships
- Master's opportunities
- overseas study
- research opportunities
- longer-term education options

Further education is NOT currently assumed to be the primary path.

If the user is only researching / monitoring opportunities:
→ treat as EXPLORE.

If the user chooses a concrete program / scholarship and decides to apply:
→ it may become an active Goal or finite Project with a deadline.

Do NOT automatically create:
- "Get a Master's degree"
- "Win a scholarship"
as active Goals.

==================================================
EXPLORE
==================================================

EXPLORE is deliberately lower priority than FOCUS and MAINTAIN.
It is for curiosity, experimentation, and broader life development without
requiring strong commitment.

Examples:

### Professional / human exploration
- networking
- communication
- soft skills
- meeting interesting people
- understanding professional communities

General networking exploration belongs here unless it directly supports the
active job-search Goal.
Job-search-specific outreach can still belong inside the FOCUS Career Goal.

### Broader technical interests
- unfamiliar engineering fields
- automotive engineering
- engines
- mechanical systems
- electronics
- other technical curiosity

### Personal interests
- learning how cars work
- learning basic car repair
- understanding engines
- hobbies
- new sports / activities

### Life skills
- practical repair skills
- basic household skills
- communication
- travel knowledge
- practical adult-life knowledge

EXPLORE does NOT require aggressive weekly targets.
Do NOT invent streaks, quotas, completion percentages, or guilt states for
general Explore.
Items may remain dormant or receive occasional Tasks / Sessions when useful —
both "explored something" and "nothing this week" are acceptable answers in
Weekly Review.

==================================================
PRIORITY ORDER (CAPACITY CONFLICTS)
==================================================

1. Required current-work commitments during working hours
2. FOCUS Goals
   - Software Engineering Career
   - IELTS 7.0
3. MAINTAIN
   - Health
   - Reading / intellectual development
   - continuous professional learning
   - finance
   - general awareness
4. EXPLORE
   - scholarships / education opportunities
   - networking / soft skills outside immediate job search
   - hobbies
   - broader interests
   - life skills

==================================================
PERSONAL OS HIERARCHY
==================================================

Use the current model:

Goal
→ Project / Project [Habit]
→ Task
→ Session / TimeBlock
→ Calendar

There is NO active System concept.
Do NOT reintroduce System.

Process remains a measurement layer where useful.

==================================================
GOAL / HABIT DISCIPLINE
==================================================

Prefer a small number of broad meaningful Goals.

Avoid turning every important area into many Goals. Examples of what NOT to do:

Bad:
- Health + Sleep + Gym + Running + Basketball as five Goals
Prefer:
- Health, with Habit Projects / Tasks underneath

Bad:
- Read books + Read news + Learn databases + Learn AI + Learn systems + Learn robotics
  as separate Goals
Prefer:
- broader MAINTAIN directions, with execution organized below them

Use Project [Habit] for genuinely ongoing / repeated activities when it makes
execution clearer. Potential examples:
- Health → Exercise [Habit]
- Reading / Intellectual Development → Reading [Habit]
- Continuous Professional Learning → Technical Learning [Habit]
- Personal Finance → Financial Review [Habit]

Do NOT create Habit Projects merely for symmetry.

==================================================
TASK / CALENDAR BEHAVIOR
==================================================

Task = what concrete result should be produced.
Session = when the user will work on that Task.

Prefer outcome-based Tasks over vague time-only Tasks.

Bad: "Study backend for 2 hours"
Better: "Explain B-tree indexes and answer 3 interview questions without notes."

Bad: "Practice IELTS Writing for 90 minutes"
Better: "Write one timed IELTS Task 2 essay and review it against band descriptors."

Time remains useful as estimated effort, Calendar allocation, and Process
measurement — but time spent is NOT equivalent to a useful Task outcome.

==================================================
DAILY FOCUS (TOP TASK)
==================================================

Daily Focus is a day-scoped planning designation — NOT a fifth priority level.

At most one active Daily Focus per day (Asia/Ho_Chi_Minh planning day).

Purpose:
Identify the ONE Task whose completion would make the day meaningfully successful.

A Daily Focus may be IMPORTANT (not only DO_NOW). Highest-value work is often
important but not yet urgent.

Day quality:
- Daily Focus DONE + some supporting incomplete → core priority achieved.
- Daily Focus NOT DONE + many supporting DONE → core priority missed.
Do NOT celebrate raw task-count completion when the Daily Focus was missed.
No generic productivity score.

==================================================
80/20 TASK PLANNING
==================================================

Prefer high-leverage work over high-volume low-value work.

A. Which Task to choose?
Prefer Tasks that materially advance a FOCUS Goal, remove a bottleneck, create
real-world evidence/output, unlock later work, or prevent meaningful risk.

B. What belongs inside the Task?
Prefer high-frequency interview topics, foundational concepts, high-impact weak
areas, and useful real outputs — not exhaustive checklist coverage.

==================================================
DEFINITION OF DONE
==================================================

Important / Daily Focus Tasks may include an optional Definition of Done
(multiline free text). Trivial Tasks stay lightweight — do not force admin
overhead onto "buy toothpaste" style work.

==================================================
DAILY REVIEW — KEYSTONE (NOT SCHEDULED YET)
==================================================

Future Task under Personal OS Review & Planning [HABIT]:
Daily Review & Tomorrow Prep

Normal: 15–20 minutes.
Minimum viable (low energy): 1–5 minutes — still counts.
Consistency before sophistication.

Intended questions:
1. What actually happened today?
2. Was today's Daily Focus completed?
3. Which important work remains unfinished?
4. Is Finance tracking stale / needing attention? (>5 days without expense
   update or meaningful finance review → "Finance tracking may be stale —
   check Finance." Do NOT claim spending was forgotten.)
5. What is tomorrow's Daily Focus? (most important output)
6. What needs to be prepared for tomorrow?

Do NOT create this Task or Calendar block yet.

==================================================
WEEKLY REVIEW — KEYSTONE (NOT SCHEDULED YET)
==================================================

Future Task: Weekly Review & Next Week Prep
Normal: 30–60 minutes. Minimum viable: ~10 minutes.
Preferred timing: Sunday (morning or afternoon — not forced evening).

Priority order of questions:
1. Did I complete the Daily Focus on most days?
2. Did FOCUS Goals produce real outputs?
3. Which Process targets were met/missed?
4. Was I spending time without concrete outcomes?
5. Did any Goal become neglected?
6. Did Work spill unnecessarily into personal time?
7. Did Health remain stable?
8. Is Finance tracking current?
9. Did I explore anything interesting this week? (yes/notes OR nothing — both OK)
10. What are next week's highest-leverage priorities?

Do NOT reduce Weekly Review to "how many Tasks were checked off?"
Do NOT create this Task or Calendar block yet.

==================================================
FOCUS CAPACITY (SHARED)
==================================================

Mon–Fri ≈ 2 hours/day personal FOCUS capacity.
Sat–Sun ≈ 3 hours/day for personal development/focus.
Job + IELTS SHARE this capacity — not 2h Job + 2h IELTS every weekday.
Weekly planning should prevent either FOCUS Goal from being neglected.
Do not auto-schedule this capacity yet.

Intellectual Learning (Reading / Professional Learning): primarily weekend.
Prefer one meaningful high-leverage learning output over many tiny tasks.

==================================================
EXPLORE — NO TRACKING
==================================================

Education & Opportunity Exploration / general Explore is intentionally
low-pressure and untracked.

Do NOT create streaks, weekly quotas, mandatory Tasks, completion %, or guilt
states for general Explore.

Weekly Review may simply ask whether anything interesting was explored.

==================================================
AI GOAL STRUCTURING RULE
==================================================

When the user creates a new Goal, check:

Is this actually a Goal?

Could it instead be:
- an existing Goal's Project?
- a Habit Project?
- a Task?
- a Work Project?
- an Explore interest?

If it is not genuinely an outcome worth managing at Goal level, do not inflate
it into a Goal.

==================================================
CURRENT SUMMARY
==================================================

FOCUS
- Obtain a strong Software Engineer / Backend-focused job (target 2026-11-01)
- Achieve IELTS 7.0 (planning deadline 2027-05-31 ≈ May 2027 exam window)

MAINTAIN
- Maintain Good Health
- Continuous Learning & Intellectual Development
- Maintain Personal Financial Awareness & Control

EXPLORE
- Education & Opportunity Exploration
- Intentionally untracked / low-pressure — no streak or quota

WORK (unlinked Projects, not Goals)
- Landfill Rover
- Drone / Remote ID
- Prefer Mon–Fri 10:00–18:00

PERSONAL (unlinked Habit)
- Personal OS Review & Planning
  Future Daily Review: normal 15–20 min / minimum viable 1–5 min
  Future Weekly Review: normal 30–60 min / minimum viable ~10 min
  Daily Review chooses tomorrow's Daily Focus; Finance stale check lives here.
  Consistency first; difficulty later. Do not create these Tasks yet.

PERSONAL CAPACITY (context only — not a quota to fill)
- Mon–Fri ≈ 2 hours/day personal Focus/development capacity (Job + IELTS share)
- Sat–Sun ≈ 3 hours/day
- Conceptual ceiling ≈ 16 hours/week
- Do NOT automatically allocate all capacity
- Task/Calendar scheduling comes later after visual review of the Task layer

PROGRESS PHILOSOPHY
- OUTCOME = what happened in the real world
- EXECUTION / PROGRESS = how well the plan was followed with meaningful evidence
- Daily Focus completion matters more than raw supporting-task count
- Deadline missed ≠ personal failure
- Example: Job target date passes with no offer, but quality applications and
  interview practice were consistent → review strategy/pipeline/capacity/timeline,
  not shame
- Concrete short-term outputs matter (e.g. 3/4 quality applications may still be
  useful execution; 0/4 despite time passing is a clear execution problem)
- Do not let generic "hours spent" hide absence of concrete output

WORK CONTEXT, NOT PERSONAL GOALS
- Landfill Rover
- Drone / Remote ID

These work projects generate Tasks that should normally be completed during
working hours.

==================================================
PLANNING PHILOSOPHY
==================================================

- Calendar-first planning.
- Goal = outcome to make true.
- Metric = evidence that the outcome is moving / achieved.
- Milestone = meaningful state transition or checkpoint.
- Process = repeated measurable behavior (measurement layer).
- Project / Project [Habit] = body of work / ongoing container.
- Task = concrete executable result (prefer Definition of Done for high-value work).
- Daily Focus = the one Task that makes today successful (date-scoped).
- Session / TimeBlock = when work happens.
- Calendar = execution surface.

- Prefer evidence such as:
  Completed / Planned / Target,
  protected time,
  process adherence,
  actual project / task completion,
  Daily Focus hit rate across the week.

- Avoid fake productivity metrics and overplanning.
- Prefer a small number of meaningful Processes rather than many habits.
- Prefer a small number of useful Projects rather than splitting everything.
- Every active Goal should eventually lead to concrete executable Next Actions.
- Protect execution time on the Calendar.
- Weekly plans should respect realistic capacity.
- Use 80/20 when choosing Tasks and topics.

==================================================
AI BEHAVIOR PREFERENCES
==================================================

- AI acts as a planning copilot, not an autonomous decision maker.
- AI should suggest a first structure, not silently modify the user's plan.
- All AI suggestions should remain editable before being persisted.
- User edits always override AI suggestions.
- AI should use existing Goals / Projects / Processes to avoid duplication.
- AI should take current workload into account before suggesting new weekly
  Processes.
- Avoid generic motivational advice.
- Avoid fake precision.
- Avoid assuming personal facts that are not in the saved context.
- When uncertain, state assumptions or questions rather than inventing answers.
- Suggested structure should help answer: "What should I actually do next?"

EXTERNAL AI WORKFLOW

- Personal OS does NOT need an AI chat interface.
- Built-in AI is mainly used to generate structured first drafts.
- For deeper reasoning, the user prefers copying the full Goal context and
  discussing it separately in ChatGPT Plus.
- Preserve high-quality "Copy full context" exports.

PROGRESS / REVIEW PHILOSOPHY

- Progress should reflect evidence rather than subjective productivity scores.
- No shame-based Goal states.
- Reviews should help decide: continue, modify, close, or change execution.
- If a Process repeatedly misses its target, reconsider the Process or capacity
  rather than simply blaming execution.

IMPORTANT GENERAL PRINCIPLE

Help maintain consistency across career, intellectual development, opportunities,
human / professional relationships, and life — without allowing one temporary
priority to destroy other important areas, and without letting ordinary work
Tasks consume all personal FOCUS / MAINTAIN capacity.`.trim();
