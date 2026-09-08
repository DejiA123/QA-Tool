# QA Tool

A Chrome side-panel extension for the SOTI Support **QA team**. It reads cases out of
Salesforce, measures how they were handled, and writes the team's QA sheet and coaching
summary.

It is a **separate tool** from the SOTI AI Analyser — its own folder, its own extension, its
own storage. Install both and they sit side by side in the toolbar without touching each
other's settings, cases or reviews.

---

## What it does

Given a Salesforce case list, it goes through the ticked cases **one at a time**, opening each
in a background window and reading everything on it — emails, Chatter posts, internal notes,
call logs and replies, with their dates and times. Then, for each case:

**It measures** (arithmetic, in JavaScript, before any AI sees the case):

| Measurement | Rule |
| --- | --- |
| First response time | From the case opening to the first thing sent **to the customer**. Target **2 hours**. Internal notes and call logs are excluded — neither is a reply to anybody. |
| Silence gaps | Any stretch over **3 days** between posts, with the side that was holding the case named. |
| Still waiting on us | The newest message is the customer's and it has been over **2 days**. |
| Customer chasing | The customer wrote again with no reply from us in between. |
| Meeting notes | Every meeting or session found, and whether a call log or a written-up post followed it within **24 hours**. A call log is its own note. |
| Reply times | The median time from a customer message to our next reply. |
| 30/60/90 milestone | Derived from the case age. Never guessed. |

**Then it judges** (this is what the AI is for) — whether the answers were any good, whether
the resolution note is worth reading, what went well, what should change, and **which training
the agent needs**.

### Why the split matters

A model asked "was the first response inside two hours" has to parse forty timestamps — some
of them relative ("3h ago") — subtract two of them and compare against a threshold. It will
answer confidently either way. When the output ends up on somebody's coaching record, a
confident wrong number is worse than no number.

So every fact that **can** be computed **is** computed, the model is told those facts as
givens and forbidden to re-derive them, and what is left for it is the part that genuinely
needs someone to read the case.

On screen the two halves look different: the measured findings are a ticked/crossed list at
the top of every review card, the written judgement is prose below it.

---

## Installing it

1. Chrome → `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → choose this folder (`QA Tool v1.0.0`)
4. Pin the teal **QA** icon to the toolbar and click it to open the side panel

Then, once:

* **Settings → Grant site access** and allow the Microsoft 365 Copilot host when Chrome asks.
  Reviews are written through a Copilot tab the tool drives itself, so nothing leaves the
  browser for a service you are not already signed in to.
* **Settings → Test the relay** to confirm it works before starting a run.

---

## Using it

### 1. Get the cases in

Open the Salesforce case **list view** you review from (Cases → whichever queue) and press
**Sync case list**. The tool refreshes the list first — a Lightning list view is a snapshot of
when it loaded and does not re-query because time has passed — then scrolls it to the end and
reads every row.

After the first sync it remembers the list, so later syncs work from any tab: if the list is
open elsewhere it brings it to the front, and if it is closed it reopens it.

**Add by URL** puts a single case in from its link.

### 2. Pick what to review

Two ways, and they combine:

* **Tick the boxes** beside the cases you want.
* **Pick a case owner** from the dropdown and press **Select this owner's cases** — this ticks
  every case belonging to that agent across the whole queue, not just the ones the current
  search happens to be showing.

The chips narrow the list: **30-day / 60-day / 90-day**, **Needs 30/60/90** (everything at or
past its first milestone), **Not yet QA'd**, **Already QA'd**.

Every row that has reached a milestone carries a coloured flag — amber at 30, orange at 60,
red at 90 — so the cases due a management review are findable without reading a single age.

### 3. Run it

* **QA _n_ cases** — the full quality review, one row of the QA sheet per case.
* **30/60/90** — the management-review write-up for aging cases. It warns first if any of the
  ticked cases are under 30 days old.

The pill in the title bar shows progress from every tab and has a **Stop** button (the case
being read finishes first). The **Reviews** tab carries a run log saying what was opened, what
came back and what went wrong — so a run that quietly skipped four cases does not look like
one that read them all.

Reading and writing are different kinds of slow, so they run as a pipeline: while case three
is being written up, cases four and five are already loading. Reads run in parallel (set the
number in Settings; two is comfortable on a support laptop); the AI half is strictly one at a
time, because the relay is a single Copilot conversation and two prompts in one message box
would produce an answer belonging to neither case.

### 4. Ask about a case

Every case gets a **chat of its own** — the speech bubble at the end of its row, the **Ask
about this case** button on its review card, or the **Chat** tab.

A review answers the questions the sheet asks and then stops. The next question is always the
same one — *why?*, *show me where*, *what should they actually have done* — and that is what
this is for. The chat is grounded in exactly what the review was grounded in: the same case
facts, the same measured findings, the review itself, and the whole transcript oldest-first.
So you can say "justify that score against the case" and get an answer with dates in it, and
"the case does not say" is a real answer rather than a shrug.

Answers stream in as they are written. Suggested questions appear under a fresh chat and are
chosen from what was *measured* — a case with an undocumented meeting offers the meeting
question; a case without one does not.

Each conversation is kept per case, so coming back to a case days later finds it where you
left it. A strip at the top always says what the answers stand on and how old it is; a case
that has never been read says so plainly and offers to read it in one press.

### 5. The sheets

**QA Sheet** is the team's own spreadsheet, column for column and in its order:

> Case Number · Date Reviewed · Closure Check · Internal Resolution Note Quality ·
> Case Handling Notes · JIRA / Other Agent Follow-up · KB Articles · Positive(s) ·
> Improvement Point(s) · Final Comment

with three **additional** columns after them — **Agent**, **QA Score**, **Training Needed** —
so pasting into the existing spreadsheet lines up and the extras spill into the empty columns
to the right rather than pushing everything one across.

**Copy for Excel** puts it on the clipboard tab-separated; **Download CSV** writes a file.

**Coaching** is the summary template — Agent · Main Pattern Observed · Coaching Pointer /
SMART Goal · Due Date · Notes — with one row per agent on the team list. Press **Build from
reviews** and each agent's row is written from *their reviews*, not from their cases again, so
it can only ever say what the reviews said. Above the grid, a counted strip shows how many
cases each agent had, their average score and their most frequent training area — which is the
check on the written row beside it.

---

## Updates

The **↻ button beside the version number** in the title bar asks GitHub what has been
published and shows a dot when it is newer than the build you are running. Pressing it always
re-checks — a remembered answer is never passed off as a check.

It watches **[DejiA123/QA-Tool](https://github.com/DejiA123/QA-Tool)**, and it looks in three
places in this order: a published **release** (the only one that can carry notes saying what
changed), then a **tag**, then **`manifest.json` on `main`** — which works on a repository with
neither, and is the only one of the three that cannot be wrong, because the manifest is the
file actually being shipped.

**Permission.** The check needs Chrome's permission to reach `api.github.com`, which it asks
for the first time you press the button — never at start-up. That host is used for the version
check and nothing else, and it hands file contents back base64-encoded, so
`raw.githubusercontent.com` is never contacted and is not on the allow-list. The download
itself goes through Chrome's own downloads, not through the panel. After the permission
exists, an automatic check runs at most once every six hours.

**Nothing installs itself.** An extension cannot rewrite its own folder on disk — no API
exists for it and none should. So the button downloads a zip and the last step is yours:
unzip, copy over this folder, then **Reload** on `chrome://extensions`.

### Your reviews survive an update

`manifest.json` carries a `key`, which **pins the extension ID**. Without one, Chrome derives
the ID of an unpacked extension from its *folder path* — and this folder is named for its
version, so every release would rename it, change the ID, and hand the new build an empty
`chrome.storage`: every review, chat and setting gone, with nothing on screen saying why.

The private half of that key is `qa-tool-signing-key.pem`, kept **outside this folder** beside
the analyser's, and git-ignored in both places. It is only needed to publish a signed `.crx`;
losing it costs you that and nothing else — the ID comes from the public half, which is in the
manifest and is meant to be there.

**Back up anyway** before rebuilding a Chrome profile or moving to another machine: *Settings →
Back up my data*, or the same button in the update dialog. It writes every key the extension
holds to a JSON file, read with `null` rather than a named list — a backup that silently omits
the chats is worse than no backup, because it is trusted. Restoring is additive: it writes the
keys the file holds and leaves everything else alone.

---

## The repository

This folder **is** the repository — extension files at the root, so a zip of `main` unzips to
something you can copy straight over an install. It lives at
<https://github.com/DejiA123/QA-Tool>, which is the repository the update button watches.

### Cutting a release

```bash
# bump "version" in manifest.json first — that is the number Chrome reads
git add -A
git commit -m "QA Tool v1.1.0 — <what changed>"
git push
```

Pushing the bumped manifest is **on its own enough** for the update button to see the new
version: the third route in `update.js` reads `manifest.json` off `main`.

Two optional extras, in increasing order of effort and usefulness:

* `git tag v1.1.0 && git push --tags` — the dialog then links to the tag.
* Publish a **GitHub release** — the release body is what appears in the dialog as the notes
  saying what changed. This is the only route that can tell somebody *why* they should update,
  so it is worth the two minutes on anything more than a fix.

### Line endings

`.gitattributes` forces LF in the working tree as well as in the repository. Git for Windows
sets `core.autocrlf=true` at the system level, and without that file a clone rewrites every
source file to CRLF while the repository stores LF — which makes any whole-file touch produce
a 40,000-line diff that buries the two lines somebody meant.

---

## Which training the agent needs

The model picks from a **closed list**, never free text:

Troubleshooting methodology · Networking · Product knowledge · Log analysis ·
Customer communication · Case documentation · Meeting and call handling ·
Escalation and JIRA process · SLA and time management · Knowledge base usage ·
Closure process and CSAT

The list is closed on purpose. "Needs to improve troubleshooting", "troubleshooting
methodology" and "better fault-finding" are one gap in three phrasings, and three phrasings
cannot be counted — so the coaching summary could never say "four of Imran's six cases came
back with the same finding", which is the only thing that makes the summary worth writing.

Anything the model names that is not on the list is **kept** and marked with a dashed outline
rather than dropped: an uncategorised training need is still a training need.

---

## Settings

| Setting | Default | What it changes |
| --- | --- | --- |
| First response target | 2 hours | The FRT every case is measured against |
| Flag silence longer than | 3 days | Clears a weekend on purpose — a rule that flags every case is switched off within a week |
| Meeting written up within | 24 hours | The grace period before a meeting counts as undocumented |
| Flag "waiting on us" after | 2 days | How long the newest customer message may sit unanswered |
| Cases read at the same time | 2 | Every case being read is a whole Salesforce page in memory |
| The team | the nine names on the coaching sheet | Decides the sheet's order and who appears with no cases yet — **not** who may be reviewed |

An agent who turns up in the queue without being on the team list is still reviewed and still
gets a coaching row.

---

## What is in this folder

| File | What it is |
| --- | --- |
| `QA_Tool.html` | The side panel |
| `qa-panel.js` | The screen, the run, and the per-case chat |
| `qa-engine.js` | The measurement, the prompts, and reading the answers back. No DOM, no `chrome.*` — the rules are checkable without a browser |
| `case-reader.js` | The background reader window: one window, one tab per case |
| `content.js` | The Salesforce reader. **The SOTI AI Analyser's, carried over whole**, with a QA appendix at the end that returns the feed as records rather than as prose |
| `reader-wake.js` | Keeps an occluded reader tab rendering. The analyser's, unchanged |
| `ai-provider.js` | The Copilot relay. The analyser's, unchanged |
| `copilot-bridge.js` | Injected into the relay tab. The analyser's, unchanged |
| `styles.css` | The analyser's stylesheet, unchanged, so the two tools look like siblings |
| `qa-styles.css` | Only what QA adds - tick boxes, the run pill, the chat, the sheets |
| `background.js` | Opens the side panel, and keeps a clock running for the relay |
| `update.js` | The version check against this repository, the update dialog, and backup/restore |
| `icons/` | The toolbar mark: a teal "QA" badge, drawn so it is not mistaken for the analyser's indigo hexagon at 16px |

### Keeping it in step with the analyser

`content.js`, `reader-wake.js`, `ai-provider.js`, `copilot-bridge.js` and `styles.css` are
verbatim copies. When the analyser fixes something in one of them, replace the file here —
except `content.js`, where everything after the `QA TOOL — THE STRUCTURED FEED READ` banner is
this tool's and has to be re-appended.

The knowledge corpus and the OCR libraries are deliberately **not** copied: QA is about how a
case was handled, not about what the product does, so ~30 MB of product documentation would
cost transfer time on every request and answer no question this tool asks.

---

## Things worth knowing

**The reader window will sometimes come to the front.** A window Chrome considers fully
covered is not painted, and a Lightning record page that is not painted never finishes
mounting. There is no API for "composite this window without raising it". So for the few
seconds a stubborn case takes to load, the reader window is the front window, and the focus is
handed straight back afterwards. Most cases never trigger it.

**A case whose feed could not be read says so.** It is not reported as a clean case. The review
card carries the reason, and the timing findings are withheld rather than guessed — a case
whose posts could not be attributed to a side gets `first response: could not be measured`, not
`met`.

**A failed write-up still keeps the measurement.** The expensive half of a review is opening
the case and reading its feed to the end; if the relay fails afterwards, the findings are saved
with the error and re-running that one case is a tick and a button.

**A chat is only as current as the last read.** The material is captured when the case is read, not when you ask - so on a case that has moved on since, press *Read it again* in the chat before you trust an answer about what is happening now.

**Re-reviewing a case replaces its review.** Two reviews of one case would each claim to be the
QA record for it and the sheet would carry the case twice with different scores.

---

## One assumption to check

The third column of the QA sheet is headed **Closure Check** in this build. The sub-heading in
the original spreadsheet was not fully legible in the copy this was built from — if it reads
differently on the real sheet, the column name lives in one place, `SHEET_COLUMNS` at the top
of the sheet section in `qa-panel.js`, and the matching header in `buildQaPrompt` in
`qa-engine.js`. Both must be changed together: the prompt's headers *are* the schema the answer
is parsed back out of.
